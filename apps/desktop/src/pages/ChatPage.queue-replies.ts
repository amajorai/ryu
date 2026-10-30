import { shouldSuggestReplyThread } from "@ryu/blocks/desktop/agent-elements/reply-thread.ts";
import type {
	ContributedSelectionAction,
	MessageReply,
	SelectionActionContext,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { isMergedHistoryId } from "@/src/hooks/useMergedAgentThreads.ts";
import { useMessageQueue } from "@/src/hooks/useMessageQueue.ts";
import { useQueueDrainMode } from "@/src/hooks/useQueueDrainMode.ts";
import { pluginHostInvoke } from "@/src/lib/api/plugins.ts";
import {
	buildSideChatSelectionQuestion,
	SIDE_CHAT_SELECTION_DISPATCH,
	SIDE_CHATS_PLUGIN_ID,
	type SideChatSelectionIntent,
} from "@/src/lib/plugin-chat-features.ts";
import type { useChatAnswerNow } from "./ChatPage.answer-now.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPanelRequests } from "./ChatPage.panel-requests.ts";
import type { useChatSend } from "./ChatPage.send.ts";
import type { useChatSideChats } from "./ChatPage.side-chats.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatQueueAndRepliesInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatAnswerNow> &
	ReturnType<typeof useChatSend> &
	ReturnType<typeof useChatSideChats> &
	ReturnType<typeof useChatPanelRequests>;

/** The message queue, contributed selection actions, quotes and replies. */
export function useChatQueueAndReplies({
	effectiveStatus,
	handleSend,
	handleStop,
	composerBlocked,
	sideChatsPluginEnabled,
	askSideChatQuestion,
	convIdRef,
	activeConversationId,
	chatTarget,
	effectiveModel,
	initialQuote,
	convId,
	clipsDraftInsertionSequence,
	setClipsDraftInsertion,
}: UseChatQueueAndRepliesInput) {
	// Client-side message queue (Codex/Claude-app style). While a run streams,
	// submitted messages are stashed and auto-drained one per turn; the queue bar
	// exposes per-message "send now" and a "send all" combine. `handleSend` is the
	// real dispatch path so queued turns get the same conversation/mention/memory
	// handling as a normal send.
	const {
		queue: queuedMessages,
		enqueue: enqueueMessage,
		edit: editQueued,
		remove: removeQueued,
		clear: clearQueue,
		sendNow: sendQueuedNow,
		sendAll: sendQueuedAll,
		reorder: reorderQueued,
	} = useMessageQueue({
		status: effectiveStatus,
		send: handleSend,
		// `handleStop`, not useChat's bare `stop`: the queue's force-send path
		// interrupts the run and waits for the status to return to "ready". Raw
		// `stop()` leaves a resumed reader attached, so `effectiveStatus` would
		// stay "streaming" and the forced item would never drain.
		stop: handleStop,
		blocked: composerBlocked,
	});
	const queueDrainMode = useQueueDrainMode();

	// Intercept the `/btw` slash command: ask an ephemeral side question about the
	// current conversation. Returns true when the input was a `/btw` command (and
	// should not be sent as a normal message). The question/answer never enter the
	// chat history — they live only in the overlay. Available even while a turn is
	// streaming (the side question is independent of the main run).
	const maybeHandleBtwCommand = useCallback(
		(raw: string) => {
			const text = raw.trim();
			if (
				!(
					sideChatsPluginEnabled &&
					(text === "/btw" || text.startsWith("/btw "))
				)
			) {
				return false;
			}
			const question = text.slice("/btw".length).trim();
			if (!question) {
				// `/btw` alone is a no-op (nothing to ask) — but still swallow it so it
				// isn't sent to the agent as a literal message.
				return true;
			}
			askSideChatQuestion(question);
			return true;
		},
		[askSideChatQuestion, sideChatsPluginEnabled]
	);

	const handleContributedSelectionAction = useCallback(
		(action: ContributedSelectionAction, context: SelectionActionContext) => {
			const dispatch = action.args?.dispatch;
			if (
				action.plugin === SIDE_CHATS_PLUGIN_ID &&
				dispatch === SIDE_CHAT_SELECTION_DISPATCH
			) {
				const intent: SideChatSelectionIntent =
					action.args?.intent === "explain"
						? "explain"
						: action.args?.intent === "proofread"
							? "proofread"
							: "ask";
				askSideChatQuestion(
					buildSideChatSelectionQuestion(intent, context.text, context.note),
					intent !== "proofread"
				);
				return;
			}

			const capability = action.capability?.trim();
			if (!(action.plugin && capability)) {
				return;
			}
			const conversationId = convIdRef.current ?? activeConversationId;
			void pluginHostInvoke(chatTarget, action.plugin, capability, {
				...action.args,
				selection_text: context.text,
				...(context.note ? { selection_note: context.note } : undefined),
				...(conversationId ? { conversation_id: conversationId } : undefined),
				...(effectiveModel ? { model: effectiveModel } : undefined),
			});
		},
		[activeConversationId, askSideChatQuestion, chatTarget, effectiveModel]
	);

	// Route composer submits: when busy, enqueue; when idle, send straight
	// through. The blocked path keeps the existing behaviour (records the message
	// in blockedMessages so it is never silently dropped).
	// Pending quote (ChatGPT-style): text the user selected in a message and chose
	// to quote. Shown above the composer and prepended to the next message as a
	// markdown blockquote on send. A reply action also keeps the source identity
	// long enough to offer a focused fork for older, longer chains.
	const [quote, setQuote] = useState<string | null>(initialQuote ?? null);
	const [replyContext, setReplyContext] = useState<MessageReply | null>(null);
	const [creatingReplyThread, setCreatingReplyThread] = useState(false);
	const quoteConversationRef = useRef(convId);
	useEffect(() => {
		if (quoteConversationRef.current === convId) {
			return;
		}
		quoteConversationRef.current = convId;
		setQuote(null);
		setReplyContext(null);
	}, [convId]);

	const handleQuote = useCallback((text: string, note?: string) => {
		setQuote(text);
		setReplyContext(null);
		// A note typed into the selection's annotate box becomes the reply draft,
		// through the same composer insertion seam Clips quick-attach uses.
		if (note?.trim()) {
			clipsDraftInsertionSequence.current += 1;
			setClipsDraftInsertion({
				id: clipsDraftInsertionSequence.current,
				text: note,
			});
		}
	}, []);
	const handleReply = useCallback(
		(reply: MessageReply) => {
			setQuote(reply.text);
			setReplyContext(
				convId &&
					!isMergedHistoryId(reply.messageId) &&
					shouldSuggestReplyThread(reply.chainLength)
					? reply
					: null
			);
		},
		[convId]
	);
	const clearReply = useCallback(() => {
		setQuote(null);
		setReplyContext(null);
	}, []);
	return {
		queuedMessages,
		enqueueMessage,
		editQueued,
		removeQueued,
		clearQueue,
		sendQueuedNow,
		sendQueuedAll,
		reorderQueued,
		queueDrainMode,
		maybeHandleBtwCommand,
		handleContributedSelectionAction,
		quote,
		setQuote,
		replyContext,
		setReplyContext,
		creatingReplyThread,
		setCreatingReplyThread,
		handleQuote,
		handleReply,
		clearReply,
	} as const;
}
