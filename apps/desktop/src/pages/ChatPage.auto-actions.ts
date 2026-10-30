import { formatAsyncQuestionAnswer } from "@ryu/blocks/desktop/agent-elements/question/async-question.ts";
import type { AgentChatProps } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNodeDefaultAgentId } from "@/src/hooks/useNodeDefaultAgent.ts";
import { respondQuestion } from "@/src/lib/api/acp.ts";
import { startProactiveOpening } from "@/src/lib/api/chat.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import {
	conversationTargetDecision,
	shouldAdoptNodeDefault,
} from "@/src/lib/composer-target.ts";
import { getAgentModel } from "@/src/lib/models.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatDraftsAndRewind } from "./ChatPage.drafts-rewind.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatQueueAndReplies } from "./ChatPage.queue-replies.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatAutoActionsInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatQueueAndReplies> &
	ReturnType<typeof useChatDraftsAndRewind>;

/** Agent UI answers, auto-submit, the proactive opening, and target hydration. */
export function useChatAutoActions({
	handleComposerSubmit,
	chatTargetRef,
	convIdRef,
	draftConvId,
	clearQueue,
	convId,
	composerBlocked,
	setBlockedMessages,
	cloudSelection,
	submitNow,
	initialSubmit,
	initialPrompt,
	initialImages,
	agentId,
	createConversation,
	setConvId,
	setActiveConversationId,
	chatTarget,
	loadMessagesPageResult,
	setMessages,
	seedTitleFromFirstMessage,
	initialProactiveOpening,
	botProduct,
	getConversation,
	setTeamId,
	agentIdRef,
	setAgentId,
	setModelSelectionCleared,
	setSelectedModel,
}: UseChatAutoActionsInput) {
	// Question cards. A blocking card answers the tool call that is waiting on
	// it. An async card, or one whose turn stopped waiting (timed out, or the
	// user went away), is answered with a normal user message instead, which
	// carries a hidden marker so the card stays closed after a reload.
	const questionTool = useMemo<NonNullable<AgentChatProps["questionTool"]>>(
		() => ({
			onAnswers: ({ answers, async: isAsync, questions, toolCallId }) => {
				const sendAsMessage = () => {
					handleComposerSubmit({
						role: "user",
						content: formatAsyncQuestionAnswer(
							toolCallId ?? "question",
							questions,
							answers
						),
					});
				};
				if (isAsync || !toolCallId) {
					sendAsMessage();
					return;
				}
				respondQuestion(
					chatTargetRef.current,
					convIdRef.current ?? draftConvId.current,
					toolCallId,
					answers
				)
					.then((result) => {
						if (!result.resolved) {
							sendAsMessage();
						}
					})
					.catch(sendAsMessage);
			},
		}),
		[handleComposerSubmit]
	);

	// Stable for the transcript: `handleComposerSubmit` changes with every
	// streamed chunk, and a new handler would re-render every settled turn.
	const composerSubmitRef = useRef(handleComposerSubmit);
	composerSubmitRef.current = handleComposerSubmit;
	const handleAgentUiSubmit = useCallback(
		(value: Parameters<NonNullable<AgentChatProps["onAgentUiSubmit"]>>[0]) => {
			const content = isNativeText(value)
				? value
				: (JSON.stringify(value) ?? String(value));
			return composerSubmitRef.current({ role: "user", content });
		},
		[]
	);

	// Queued messages belong to the conversation they were typed in. Switching
	// THIS TAB's conversation resets its useChat (status → "ready"), which would
	// otherwise drain stale items into the new thread — clear on every switch
	// (mirrors the blockedMessages reset below).
	// The tab-local `convId` is load-bearing. `clearQueue` is
	// `useCallback(() => setQueue([]), [])` — a permanently stable identity — so
	// on its own this effect runs once at mount and NEVER on a thread switch.
	// Never key this on the shared focused-tab `activeConversationId`: every chat
	// tab stays mounted, so focusing another tab would discard this background
	// tab's queued messages while its run is still streaming.
	useEffect(() => {
		clearQueue();
	}, [clearQueue, convId]);

	// Clear blocked messages when a new conversation starts or services recover.
	useEffect(() => {
		if (!composerBlocked) {
			setBlockedMessages([]);
		}
	}, [composerBlocked]);

	// A new thread in THIS TAB starts without the previous thread's blocked
	// messages. Keyed on the tab-local `convId`, never on the shared focused-tab
	// `activeConversationId`: that id is null whenever a new-chat tab is focused,
	// so keying on it discarded every background tab's blocked messages.
	// A null conversation is normal on mount. `useChat` captures
	// `draftConvId.current` as its instance id before this effect runs, so rotating
	// the ref here would make the request body target a different conversation than
	// the Chat instance receiving the stream. `startFreshThread` rotates it
	// synchronously before setting the local conversation state.
	useEffect(() => {
		if (!convId) {
			setBlockedMessages([]);
		}
	}, [convId]);

	// Launchpad auto-send: when this tab was opened from the home composer with a
	// user-typed prompt (`initialSubmit`), send it as soon as the composer would
	// accept it — rather than only pre-filling the draft. The prompt + any staged
	// images (already seeded into `attachedImages`) go through the normal submit
	// path, so they stream just as if typed here. Fires once; gated on the same
	// `!composerBlocked && status === "ready"` a manual send needs, so a message
	// is never dropped into a down gateway/Core. Deep-link/Inbox seeds leave
	// `initialSubmit` unset and stay pre-fill-only (attacker-/system-controllable).
	const autoSubmitFired = useRef(false);
	const cloudSelectionLoading = cloudSelection.mode === "loading";
	useEffect(() => {
		if (autoSubmitFired.current || !initialSubmit) {
			return;
		}
		const content = initialPrompt?.trim() ?? "";
		const hasImages = (initialImages?.length ?? 0) > 0;
		if (!(content || hasImages)) {
			autoSubmitFired.current = true;
			return;
		}
		// A new tab starts with its cloud binding unresolved: the scope is hashed
		// asynchronously, so the first commit always reads "loading". `handleSend`
		// answers that with a toast and returns, which would drop a Start prompt
		// (or a launchpad message) on every single launch. Wait for the binding to
		// settle; an error binding still reaches `handleSend` and says so.
		if (cloudSelectionLoading) {
			return;
		}
		autoSubmitFired.current = true;
		// Hand the seeded message to the SAME entry point a manual send uses.
		// `submitNow` already routes every state safely — it sends when
		// ready, ENQUEUES when the turn isn't ready yet (the queue drains on ready),
		// and records into `blockedMessages` (visible error state) when the
		// gateway/Core is down. The previous `if (composerBlocked || status !==
		// "ready") return` guard dropped the message in exactly those two cases:
		// the launchpad text is never placed in the composer (`seedDraft` is
		// suppressed for `initialSubmit`), so a bailed effect made the message
		// silently vanish after the redirect from the empty-tabs shell — the user
		// landed on an empty new chat with nothing sent.
		submitNow({ role: "user", content });
	}, [
		initialSubmit,
		initialPrompt,
		initialImages,
		submitNow,
		cloudSelectionLoading,
	]);

	// The first Ryu conversation is opened by Core as an assistant-only turn. No
	// synthetic user message is handed to useChat, and a not-ready local model is
	// retried until the same durable idempotency key completes.
	const proactiveOpeningStartedRef = useRef(false);
	const proactiveOpeningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);
	useEffect(() => {
		return () => {
			if (proactiveOpeningTimerRef.current) {
				clearTimeout(proactiveOpeningTimerRef.current);
			}
		};
	}, []);
	useEffect(() => {
		if (
			!initialProactiveOpening ||
			proactiveOpeningStartedRef.current ||
			agentId !== "ryu"
		) {
			return;
		}
		proactiveOpeningStartedRef.current = true;
		const conversationId = convIdRef.current ?? draftConvId.current;
		if (!convIdRef.current) {
			createConversation(conversationId, { agentId: "ryu" });
			setConvId(conversationId);
			setActiveConversationId(conversationId);
		}
		const idempotencyKey = `desktop:ryu-opening:v1:${conversationId}`;
		let cancelled = false;
		let attempt: () => Promise<void>;
		const scheduleRetry = () => {
			if (!cancelled) {
				proactiveOpeningTimerRef.current = setTimeout(attempt, 5000);
			}
		};
		attempt = async () => {
			if (cancelled) {
				return;
			}
			try {
				const result = await startProactiveOpening(
					chatTarget,
					conversationId,
					"ryu",
					idempotencyKey
				);
				if (cancelled) {
					return;
				}
				if (
					result.status !== "completed" &&
					result.status !== "already_completed"
				) {
					scheduleRetry();
					return;
				}
				const page = await loadMessagesPageResult(conversationId);
				if (cancelled) {
					return;
				}
				const now = Date.now();
				if (page.status === "ok" && page.messages.length > 0) {
					setMessages(
						page.messages.map((message) => hydrateHistoryMessage(message, now))
					);
				} else if (result.reply) {
					setMessages([
						{
							id: `proactive-opening-${conversationId}`,
							role: "assistant",
							parts: [{ type: "text", text: result.reply }],
						} satisfies UIMessage,
					]);
				}
				seedTitleFromFirstMessage(conversationId, "Getting started with Ryu");
			} catch (error) {
				if (cancelled) {
					return;
				}
				const message = error instanceof Error ? error.message : String(error);
				if (!/failed: (400|401|403|404)$/.test(message)) {
					scheduleRetry();
				}
			}
		};
		void attempt();
		return () => {
			cancelled = true;
			if (proactiveOpeningTimerRef.current) {
				clearTimeout(proactiveOpeningTimerRef.current);
			}
		};
	}, [
		agentId,
		chatTarget,
		createConversation,
		initialProactiveOpening,
		loadMessagesPageResult,
		seedTitleFromFirstMessage,
		setActiveConversationId,
		setMessages,
	]);

	// Adopt the composer target from the conversation THIS TAB is on — once per
	// conversation. Keyed on the tab-local `convId`, never on the shared
	// focused-tab `activeConversationId`: every chat tab stays mounted, so the
	// shared id made every background tab re-target itself onto the focused tab's
	// agent. That is the "set opencode in one pane and Claude in another and both
	// collapse onto whichever tab is active" bug, and — because the effect also
	// listed `agentId` as a dependency — the reason picking a different agent
	// inside an existing thread snapped straight back to the thread's stored one.
	// The pick is the user's; the conversation only seeds it.
	const hydratedTargetConvRef = useRef<string | null>(null);
	useEffect(() => {
		if (botProduct) {
			return;
		}
		const { hydrate, agentId: pinnedAgentId } = conversationTargetDecision({
			conversationId: convId,
			hydratedConversationId: hydratedTargetConvRef.current,
			conversationAgentId: convId ? getConversation(convId)?.agentId : null,
		});
		if (!(hydrate && pinnedAgentId)) {
			return;
		}
		hydratedTargetConvRef.current = convId;
		// An existing thread is agent-pinned (conversations carry an agentId, never
		// a team) — drop any persistent team pick so the composer target matches
		// the thread instead of silently fanning out to a group.
		setTeamId(null);
		if (pinnedAgentId !== agentIdRef.current) {
			setAgentId(pinnedAgentId);
			setModelSelectionCleared(false);
			// Keep the model picker in sync when the conversation pins its agent
			// back (each thread owns its agent; the model follows the agent).
			setSelectedModel(getAgentModel(pinnedAgentId));
		}
	}, [botProduct, convId, getConversation]);

	// Last link in the seed chain: the node-wide default agent
	// (`default-agent-selection`), which arrives asynchronously and so cannot sit
	// in the `agentId` initializer. It only ever FILLS A HOLE — a composer that
	// still has no agent at all — so a merged-view pin, a tab seed, the last-used
	// hint, a conversation's pinned agent, or the user picking one while the
	// preference was in flight all win over it.
	const nodeDefaultAgentId = useNodeDefaultAgentId();
	useEffect(() => {
		if (botProduct) {
			return;
		}
		if (shouldAdoptNodeDefault(agentIdRef.current, nodeDefaultAgentId)) {
			setAgentId(nodeDefaultAgentId);
			setModelSelectionCleared(false);
			setSelectedModel(getAgentModel(nodeDefaultAgentId));
		}
	}, [botProduct, nodeDefaultAgentId]);
	return { questionTool, handleAgentUiSubmit } as const;
}
