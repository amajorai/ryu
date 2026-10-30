import { jsonResponseDocumentSchema } from "@ryu/app-host/json-values";
import { useModelContextStore } from "@ryu/app-host/model-context";
import type {
	WidgetHostServices,
	WidgetHostValue,
} from "@ryu/blocks/desktop/agent-elements/widget-host-context.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	clearGoal,
	getGoal,
	pauseGoal,
	resumeGoal,
	setGoal,
} from "@ryuhq/core-client/goals.ts";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { AppWidget } from "@/src/contributions/host/AppWidget.tsx";
import { toastActionError } from "@/src/lib/action-error.ts";
import {
	submitWidgetFollowUp,
	widgetCallTool,
	widgetSetState,
} from "@/src/lib/api/widgets.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatGoalsInput = ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport>;

/** Stream status follow-up, goal messages, and the widget host. */
export function useChatGoals({
	status,
	ghostModeRef,
	pendingModelSelectionRef,
	modelSelectionScopeRef,
	persistModelSelection,
	modelSelectionMountedRef,
	convIdRef,
	setMessages,
	clearError,
	skipNextUserAppendRef,
	regenerate,
	chatTarget,
	setGoalState,
	messages,
	setGoalCompletionMessageId,
	convId,
	setGoalDraftOpen,
	draftConvId,
	sendMessage,
	turnInFlightRef,
}: UseChatGoalsInput) {
	// The AI SDK adds a normal user message optimistically before Core has
	// acknowledged the turn. Mark only the message that belongs to a settled,
	// non-temporary Core request so the shared transcript can show its single
	// delivery tick without granting one to client-only browser/image/goal rows.
	const previousChatStatusRef = useRef(status);
	useEffect(() => {
		const previousStatus = previousChatStatusRef.current;
		previousChatStatusRef.current = status;
		const wasBusy =
			previousStatus === "streaming" || previousStatus === "submitted";
		const settled = status === "ready" || status === "error";
		if (ghostModeRef.current) {
			return;
		}
		const pendingModelSelection = pendingModelSelectionRef.current;
		if (
			pendingModelSelection?.scope === modelSelectionScopeRef.current &&
			pendingModelSelection.conversationId &&
			(status === "streaming" || (wasBusy && settled))
		) {
			void persistModelSelection(
				pendingModelSelection.conversationId,
				pendingModelSelection,
				pendingModelSelection.scope
			).catch((writeError: unknown) => {
				if (
					!modelSelectionMountedRef.current ||
					modelSelectionScopeRef.current !== pendingModelSelection.scope ||
					convIdRef.current !== pendingModelSelection.conversationId
				) {
					return;
				}
				toast.error(
					writeError instanceof Error
						? writeError.message
						: "Could not share this model choice."
				);
			});
		}
		if (!(wasBusy && settled)) {
			return;
		}
		setMessages((current) => {
			for (let index = current.length - 1; index >= 0; index -= 1) {
				const message = current[index];
				if (message?.role !== "user") {
					continue;
				}
				const candidate =
					/* SAFETY: The message is already a UIMessage; this read-only view admits only the two optional local persistence marker slots. */ message as UIMessage & {
						metadata?: unknown;
						persisted?: unknown;
					};
				// SAFETY: The preceding check admits a non-null object; its marker slot stays unknown and is compared only with true.
				const decodedMetadata = jsonResponseDocumentSchema.safeParse(
					candidate.metadata
				);
				const metadata = decodedMetadata.success ? decodedMetadata.data : {};
				if (candidate.persisted === true || metadata.ryuPersisted === true) {
					return current;
				}
				const next = [...current];
				next[index] =
					/* SAFETY: This spreads the original UIMessage unchanged and adds only the local ryuPersisted metadata and persisted markers. */ {
						...message,
						metadata: { ...metadata, ryuPersisted: true },
						persisted: true,
					} as (typeof current)[number];
				return next;
			}
			return current;
		});
	}, [persistModelSelection, setMessages, status]);

	// A failed model call already persisted the user turn. Clear the AI SDK's
	// terminal error, mark this as a re-run (so Core does not append that user row
	// twice), and let the transport resend the same turn.
	const handleRetryError = useCallback(async () => {
		clearError();
		skipNextUserAppendRef.current = true;
		await regenerate();
	}, [clearError, regenerate]);

	// The goal hook evaluates after the assistant turn finishes. Refresh the
	// durable state at that boundary so the completion status lands on the turn
	// that actually achieved it rather than waiting for a tab reload.
	const goalWasStreamingRef = useRef(false);
	useEffect(() => {
		const streaming = status !== "ready";
		if (goalWasStreamingRef.current && !streaming && convIdRef.current) {
			const targetConversationId = convIdRef.current;
			void getGoal(chatTarget, targetConversationId)
				.then((next) => {
					if (convIdRef.current !== targetConversationId) {
						return;
					}
					setGoalState(next.goal ? next : null);
					if (next.status === "achieved") {
						const lastAssistantMessage = [...messages]
							.reverse()
							.find((message) => message.role === "assistant");
						setGoalCompletionMessageId(lastAssistantMessage?.id ?? null);
					} else {
						setGoalCompletionMessageId(null);
					}
				})
				// Background refresh after a turn; the goal chip keeps its last state.
				.catch(() => undefined);
		}
		goalWasStreamingRef.current = streaming;
	}, [chatTarget, messages, status]);

	// Goal-setting is a UI action rather than a model turn, but it still belongs in
	// the transcript as a user-authored message. Metadata keeps the annotation out
	// of the text sent to the agent while the shared UserMessage renders it beside
	// the normal copy toolbar.
	const goalMessageSequenceRef = useRef(0);
	const appendGoalMessage = useCallback(
		(text: string) => {
			const id = `goal-${Date.now()}-${goalMessageSequenceRef.current}`;
			goalMessageSequenceRef.current += 1;
			setMessages((prev) => [
				...prev,
				{
					id,
					metadata: { goal: true },
					parts: [{ text, type: "text" as const }],
					role: "user" as const,
				} satisfies UIMessage,
			]);
		},
		[setMessages]
	);
	const handleGoalSubmit = useCallback(
		(text: string) => {
			const targetConversationId = convId;
			if (!targetConversationId) {
				setGoalDraftOpen(false);
				return;
			}
			void setGoal(chatTarget, targetConversationId, text)
				.then((next) => {
					if (convIdRef.current !== targetConversationId) {
						return;
					}
					setGoalState(next);
					setGoalCompletionMessageId(null);
					setGoalDraftOpen(false);
					appendGoalMessage(text);
				})
				.catch((error: unknown) => {
					toastActionError("Couldn't set goal", error);
				});
		},
		[appendGoalMessage, chatTarget, convId]
	);
	const handleGoalClear = useCallback(() => {
		if (!convId) {
			setGoalState(null);
			setGoalCompletionMessageId(null);
			setGoalDraftOpen(false);
			return;
		}
		void clearGoal(chatTarget, convId)
			.then(() => {
				setGoalState(null);
				setGoalCompletionMessageId(null);
				setGoalDraftOpen(false);
			})
			.catch((error: unknown) => {
				toastActionError("Couldn't clear goal", error);
			});
	}, [chatTarget, convId]);
	const handleGoalPause = useCallback(() => {
		if (!convId) {
			return;
		}
		void pauseGoal(chatTarget, convId)
			.then((next) => {
				setGoalState(next);
				setGoalCompletionMessageId(null);
			})
			.catch((error: unknown) => {
				toastActionError("Couldn't pause goal", error);
			});
	}, [chatTarget, convId]);
	const handleGoalResume = useCallback(() => {
		if (!convId) {
			return;
		}
		void resumeGoal(chatTarget, convId)
			.then((next) => {
				setGoalState(next);
				setGoalCompletionMessageId(null);
			})
			.catch((error: unknown) => {
				toastActionError("Couldn't resume goal", error);
			});
	}, [chatTarget, convId]);

	// Ryu Apps widget host (U7). The desktop is the TRUSTED side: it holds the Core
	// token and performs the Gateway-governed round-trips on a widget's behalf. The
	// follow-up is first gated by Core, then its returned prompt is submitted via
	// this same useChat handle so the normal transport supplies the live
	// conversation and agent context.
	const widgetHostValue = useMemo<WidgetHostValue>(() => {
		const services: WidgetHostServices = {
			clearModelContext: (owner) =>
				useModelContextStore.getState().clear(owner),
			updateModelContext: async ({ owner, input }) =>
				useModelContextStore
					.getState()
					.update(
						`${chatTarget.url}:${convIdRef.current ?? draftConvId.current}`,
						owner,
						input
					),
			getModelContext: (owner) =>
				useModelContextStore
					.getState()
					.get(
						`${chatTarget.url}:${convIdRef.current ?? draftConvId.current}`,
						owner
					),
			callTool: (input) => widgetCallTool(chatTarget, input),
			sendFollowUpMessage: (input) =>
				submitWidgetFollowUp(chatTarget, input, (message, options) =>
					sendMessage(message, options)
				),
			setWidgetState: (input) => widgetSetState(chatTarget, input),
		};
		return {
			// The two shell facts the shared renderer can't derive: how this app
			// opens a real browser, and which node origin proxies widget assets.
			env: {
				openExternal: (href: string) => openExternal(href),
				proxyOrigin: chatTarget.url,
			},
			Renderer: AppWidget,
			services,
		};
	}, [chatTarget, sendMessage]);
	const hasAppContext = useModelContextStore((store) =>
		Object.values(store.entries).some(
			(entry) =>
				entry.scope === `${chatTarget.url}:${convId ?? draftConvId.current}` &&
				(entry.state.content?.length || entry.state.structuredContent)
		)
	);

	// Feeds the session-control pick notice above, which is defined before this
	// hook (it is passed into the composer's ACP sections) and so cannot read
	// `status` directly.
	turnInFlightRef.current = status === "streaming" || status === "submitted";

	// Per-message send time (ms), keyed by message id. Persisted history seeds this
	// with Core's server-stamped `created_at`; live turns (which arrive over the SSE
	// stream without a timestamp) get a client stamp the first time they're seen.
	// Kept out of useChat's own message state so nothing extra is POSTed back to Core
	// on the next turn — `processedMessages` reads from here to render the toolbar.
	const messageSentAtRef = useRef<Map<string, number>>(new Map());
	return {
		handleRetryError,
		handleGoalSubmit,
		handleGoalClear,
		handleGoalPause,
		handleGoalResume,
		widgetHostValue,
		hasAppContext,
		messageSentAtRef,
	} as const;
}
