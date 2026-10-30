import type { UseChatHelpers } from "@ai-sdk/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { UIMessage } from "ai";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type {
	AssistantBuilderSession,
	PageContextItem,
	useAssistantStore,
} from "@/src/store/useAssistantStore.ts";
import { contextBlock, resolveContext } from "./AssistantPanel-request.ts";
import { composeAssistantContext } from "./assistant-message-display.ts";
import type { ComposerSendFile } from "./useComposerSlot.tsx";

type ChatHistory = ReturnType<typeof useChatHistoryContext>;

/** The panel's send path: page context, builder ids, staged attachments. */
export function useAssistantSend({
	activeConvId,
	activeConvIdRef,
	builderRef,
	convId,
	convIdRef,
	createConversation,
	effectiveContextRef,
	genericRuntime,
	messages,
	seedTitleFromFirstMessage,
	sendMessage,
	setActiveConversationId,
	setConversationId,
	takeClipTextRef,
	takeImagesRef,
	targetIdRef,
}: {
	activeConvId: string;
	activeConvIdRef: RefObject<string>;
	builderRef: RefObject<AssistantBuilderSession | null>;
	convId: string;
	convIdRef: RefObject<string>;
	createConversation: ChatHistory["createConversation"];
	effectiveContextRef: RefObject<PageContextItem[]>;
	genericRuntime: { agentId: string };
	messages: UIMessage[];
	seedTitleFromFirstMessage: ChatHistory["seedTitleFromFirstMessage"];
	sendMessage: UseChatHelpers<UIMessage>["sendMessage"];
	setActiveConversationId: ChatHistory["setActiveConversationId"];
	setConversationId: ReturnType<
		typeof useAssistantStore.getState
	>["setConversationId"];
	takeClipTextRef: RefObject<() => string>;
	takeImagesRef: RefObject<() => ComposerSendFile[] | undefined>;
	targetIdRef: RefObject<string | null>;
}) {
	// The context block last sent on this thread. Context is re-injected whenever
	// it CHANGES, not only on the first turn: a live surface (dashboard, canvas)
	// looks different by turn three, and the old first-turn-only rule meant every
	// later question was answered against a stale board — or against nothing at
	// all if the user opened the panel after typing. Unchanged context is not
	// re-sent, so a static document still ships exactly once.
	const lastSentContextRef = useRef<string>("");
	// A new thread has been told nothing yet — re-arm so the next send carries the
	// full context again (New chat, or reopening on a different conversation).
	useEffect(() => {
		lastSentContextRef.current = "";
	}, [activeConvId]);

	// What an app-defined surface's thread was last told, keyed by that surface's
	// conversation so switching surfaces re-sends the full context.
	const surfaceContextSentRef = useRef<{ block: string; owner: string }>({
		block: "",
		owner: "",
	});

	// Resolves once the message was handed to the chat transport and rejects
	// when it could not be sent, so callers that must know (an in-chat consent
	// card waiting to tell the agent) can retry. `handleSend` keeps the
	// fire-and-forget behavior for the composer.
	const sendUserMessage = useCallback(
		(msg: { role: "user"; content: string }): Promise<void> => {
			const session = builderRef.current;
			if (session && session.kind !== "agent" && session.kind !== "workflow") {
				// App-defined surface: its preamble rides the transport, and the page
				// context the user can see (and remove) rides the turn — the same
				// change-only rule as generic chat.
				const clipText = takeClipTextRef.current();
				const files = takeImagesRef.current();
				// The thread this question was asked in. Resolving context or the id
				// may await; if the user switches topic or tab meanwhile, the question
				// must not land in the new thread under its preamble.
				const threadId = activeConvIdRef.current;
				return Promise.all([
					session.resolveId(),
					resolveContext(effectiveContextRef.current),
				]).then(([id, resolved]) => {
					if (!id) {
						throw new Error("This assistant surface isn't ready yet.");
					}
					if (activeConvIdRef.current !== threadId) {
						throw new Error("The assistant moved to another thread.");
					}
					targetIdRef.current = id;
					const block = contextBlock(resolved);
					const sent = surfaceContextSentRef.current;
					const changed = sent.owner !== threadId || sent.block !== block;
					const baseText = changed
						? composeAssistantContext(msg.content, block)
						: msg.content;
					if (changed) {
						surfaceContextSentRef.current = { block, owner: threadId };
					}
					const text = clipText ? `${clipText}\n\n${baseText}` : baseText;
					const metadata = { ryuUserText: msg.content };
					return sendMessage(
						files ? { text, files, metadata } : { text, metadata }
					);
				});
			}
			if (session) {
				// Ensure a record exists (creates a draft for brand-new agents/
				// workflows) before the transport builds the preamble referencing its id.
				return session.resolveId().then((id) => {
					if (!id) {
						throw new Error("This builder session isn't ready yet.");
					}
					targetIdRef.current = id;
					const files = takeImagesRef.current();
					const clipText = takeClipTextRef.current();
					const text = clipText ? `${clipText}\n\n${msg.content}` : msg.content;
					return sendMessage(files ? { text, files } : { text });
				});
			}
			if (!convIdRef.current || messages.length === 0) {
				// First turn of this thread: register the conversation locally and
				// mirror its id into the store + shared history selection.
				createConversation(convId, { agentId: genericRuntime.agentId });
				setConversationId(convId);
				setActiveConversationId(convId);
			}
			// Same default naming as the main chat: the thread is called what the
			// user asked from the moment they send, not after the reply lands. Seeded
			// from the raw message (never the resolved context block below, which is
			// machine text the user did not write).
			seedTitleFromFirstMessage(convId, msg.content);
			// Drain the composer's staged attachments SYNCHRONOUSLY, before the async
			// context resolve. A page's `getText` may genuinely await, and anything the
			// composer re-renders in that window would take the staged images/clip with
			// it — the turn would then send without the files the user attached.
			const clipText = takeClipTextRef.current();
			const files = takeImagesRef.current();
			// Resolving `getText` is async, so the send is too. The composer has
			// already cleared its input by now, so nothing user-visible waits on it.
			return resolveContext(effectiveContextRef.current).then((resolved) => {
				const block = contextBlock(resolved);
				const changed = block !== lastSentContextRef.current;
				const baseText = changed
					? composeAssistantContext(msg.content, block)
					: msg.content;
				if (changed) {
					lastSentContextRef.current = block;
				}
				const text = clipText ? `${clipText}\n\n${baseText}` : baseText;
				const metadata = { ryuUserText: msg.content };
				return sendMessage(
					files ? { text, files, metadata } : { text, metadata }
				);
			});
		},
		[
			convId,
			messages.length,
			genericRuntime.agentId,
			createConversation,
			seedTitleFromFirstMessage,
			setConversationId,
			setActiveConversationId,
			sendMessage,
		]
	);

	const handleSend = useCallback(
		(msg: { role: "user"; content: string }) => {
			sendUserMessage(msg).catch(() => undefined);
		},
		[sendUserMessage]
	);
	const handleAgentUiSubmit = useCallback(
		<TValue>(value: TValue) => {
			const content = isNativeText(value)
				? value
				: (JSON.stringify(value) ?? String(value));
			return sendUserMessage({ role: "user", content });
		},
		[sendUserMessage]
	);
	return { handleAgentUiSubmit, handleSend };
}
