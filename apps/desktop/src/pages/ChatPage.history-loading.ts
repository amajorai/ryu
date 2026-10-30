import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { ActivePermission } from "@/src/components/chat/PermissionPrompt.tsx";
import type { PluginChatWidgetTemplate } from "@/src/lib/api/plugins.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import { buildVersions } from "@/src/lib/chat-message-selectors.ts";
import type { SlashCommand } from "@/src/lib/slash-commands.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatGoals } from "./ChatPage.goals.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPermissionsAndLinks } from "./ChatPage.permissions-links.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatHistoryLoadingInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatGoals> &
	ReturnType<typeof useChatPermissionsAndLinks>;

/** Plugin notes, permission and command refs, and older-history loading. */
export function useChatHistoryLoading({
	messages,
	dismissedPluginNotes,
	respondToPermission,
	composerCommands,
	pluginContributions,
	convIdRef,
	olderMessagesCursorRef,
	hasOlderMessagesRef,
	olderMessagesRequestRef,
	setLoadingOlderMessages,
	loadMessagesPageResult,
	isTranscriptCurrent,
	messageSentAtRef,
	setVersions,
	setMessages,
	setHasOlderMessages,
	setHistoryFailed,
	setHistoryReloadKey,
	connectionPhase,
	historyFailed,
	convId,
	setHistoryLoading,
	historyReloadKey,
}: UseChatHistoryLoadingInput) {
	// The latest plugin note (e.g. the double-check review) streamed as a
	// `data-plugin_note` part and not yet dismissed. Surfaced in a dismissible
	// banner above the composer; it never enters chat history.
	// legacy component
	const activePluginNote = useMemo<{
		id: string;
		question: string | null;
		text: string;
	} | null>(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "assistant" || !m.parts) {
				continue;
			}
			for (let j = m.parts.length - 1; j >= 0; j--) {
				const part = m.parts[j];
				if (part?.type !== "data-plugin_note") {
					continue;
				}
				const data =
					/* SAFETY: Core plugin_note_frame_with_question serializes text from &str and an optional nonempty &str question under these keys. */ part.data as
						| { question?: string; text?: string }
						| undefined;
				const text = data?.text?.trim();
				if (!text) {
					continue;
				}
				const id = `${m.id}:${j}`;
				if (dismissedPluginNotes.has(id)) {
					return null;
				}
				return {
					id,
					question: data?.question?.trim() || null,
					text,
				};
			}
		}
		return null;
	}, [messages, dismissedPluginNotes]);

	const handleRespondPermission = useCallback(
		(permission: ActivePermission, optionId: string | null) => {
			respondToPermission(permission.requestId, optionId);
		},
		[respondToPermission]
	);

	const permissionRef = useRef<{
		permission: ActivePermission | null;
		onRespond: (permission: ActivePermission, optionId: string | null) => void;
	}>({ permission: null, onRespond: handleRespondPermission });

	// Slash-command list held in a ref so the memoized InputBar slot stays stable
	// (same pattern as permission/agents above — avoids textarea focus loss).
	const commandsRef = useRef<SlashCommand[]>(composerCommands);
	commandsRef.current = composerCommands;
	const chatWidgetTemplatesRef = useRef<PluginChatWidgetTemplate[]>([]);
	chatWidgetTemplatesRef.current = (
		pluginContributions.chat_widget_templates ?? []
	).filter(
		(template) =>
			template.availability === "available" &&
			Boolean(template.backing.tool_id ?? template.backing.view_id) &&
			(template.examples.length > 0 || template.triggers.length > 0)
	);

	// Whether anything is on screen right now, read inside the async hydration
	// without making it a dependency: the point is what is true when the fetch
	// RESOLVES, and depending on `messages` would re-run the fetch on every token.
	const hasMessagesRef = useRef(false);
	hasMessagesRef.current = messages.length > 0;

	const loadOlderMessages = useCallback(async () => {
		const conversationId = convIdRef.current;
		const before = olderMessagesCursorRef.current;
		if (
			!(conversationId && before && hasOlderMessagesRef.current) ||
			olderMessagesRequestRef.current
		) {
			return;
		}
		olderMessagesRequestRef.current = true;
		setLoadingOlderMessages(true);
		try {
			const result = await loadMessagesPageResult(conversationId, before);
			if (
				!isTranscriptCurrent() ||
				convIdRef.current !== conversationId ||
				result.status === "error"
			) {
				return;
			}
			const now = Date.now();
			for (const message of result.messages) {
				if (isNativeNumber(message.timestamp)) {
					messageSentAtRef.current.set(message.id, message.timestamp);
				}
			}
			setVersions((current) => ({
				...current,
				...buildVersions(result.messages),
			}));
			setMessages((current) => {
				const existingIds = new Set(current.map((message) => message.id));
				const older = result.messages.filter(
					(message) => !existingIds.has(message.id)
				);
				if (older.length === 0) {
					return current;
				}
				return [
					...older.map((message) => hydrateHistoryMessage(message, now)),
					...current,
				];
			});
			const nextCursor = result.olderMessagesCursor ?? null;
			olderMessagesCursorRef.current = nextCursor;
			setHasOlderMessages(
				result.hasOlderMessages === true && nextCursor !== null
			);
		} finally {
			if (isTranscriptCurrent()) {
				olderMessagesRequestRef.current = false;
				setLoadingOlderMessages(false);
			}
		}
	}, [isTranscriptCurrent, loadMessagesPageResult, setMessages]);

	const retryHistoryLoad = useCallback(() => {
		setHistoryFailed(false);
		olderMessagesCursorRef.current = null;
		setHasOlderMessages(false);
		setHistoryReloadKey((n) => n + 1);
	}, []);

	// A history request can lose the race with the shared status probe: the chat
	// marks itself unavailable first, then the node comes back. Retry that one
	// restored conversation automatically so the tab does not leave a manual
	// error card behind after the shell has already reconnected.
	const previousConnectionPhaseRef = useRef(connectionPhase);
	useEffect(() => {
		const previousPhase = previousConnectionPhaseRef.current;
		previousConnectionPhaseRef.current = connectionPhase;
		if (
			connectionPhase === "online" &&
			previousPhase !== "online" &&
			historyFailed &&
			convId
		) {
			retryHistoryLoad();
		}
	}, [connectionPhase, convId, historyFailed, retryHistoryLoad]);

	// Hydrate the visible thread from Core's server-side store when switching
	// conversations, so history survives restarts and is shared across clients.
	// Changing the conversation or authenticated authority changes the SDK id,
	// which makes useChat
	// recreate its Chat with an empty message list (a fresh new/deleted/selected
	// thread starts blank). We then overlay any persisted history on top.
	//
	// The `history.length === 0` early-return is load-bearing: this effect also
	// fires during the first send (handleSend sets activeConversationId *before*
	// the message is persisted), when Core has nothing yet. Calling setMessages([])
	// on that empty result would wipe the just-sent user message and the streaming
	// reply, so we must leave useChat's own state untouched when there is no
	// server-side history.
	useEffect(() => {
		olderMessagesCursorRef.current = null;
		olderMessagesRequestRef.current = false;
		setHasOlderMessages(false);
		setLoadingOlderMessages(false);
		if (!convId) {
			// A brand-new chat has nothing to wait for — the greeting is correct here.
			setHistoryLoading(false);
			setHistoryFailed(false);
			return;
		}
		let cancelled = false;
		// Only claim "loading" when there is nothing on screen. This effect also
		// fires the moment the FIRST send adopts a conversation id, and blanking
		// the just-sent message behind a skeleton would be worse than the bug.
		if (!hasMessagesRef.current) {
			setHistoryLoading(true);
		}
		loadMessagesPageResult(convId).then(
			({
				status,
				messages: history,
				hasOlderMessages: pageHasOlderMessages,
				olderMessagesCursor,
			}) => {
				if (cancelled || !isTranscriptCurrent()) {
					return;
				}
				setHistoryLoading(false);
				// A transport/HTTP failure is NOT an empty conversation. Leaving
				// useChat's state alone and flagging the failure is what keeps a chat
				// opened while Core is still booting from rendering as a new chat.
				if (status === "error") {
					setHistoryFailed(true);
					return;
				}
				setHistoryFailed(false);
				const nextCursor = olderMessagesCursor ?? null;
				olderMessagesCursorRef.current = nextCursor;
				setHasOlderMessages(
					pageHasOlderMessages === true && nextCursor !== null
				);
				if (history.length === 0) {
					return;
				}
				// The user typed while the fetch was in flight (first send adopting this
				// id). Their message and its live reply outrank stale server history.
				if (hasMessagesRef.current) {
					return;
				}
				const now = Date.now();
				// Seed the send-time map with each persisted message's server timestamp so
				// the toolbar can render "when it was sent" on reload. Live turns fall back
				// to a client stamp in `processedMessages`.
				for (const h of history) {
					if (isNativeNumber(h.timestamp)) {
						messageSentAtRef.current.set(h.id, h.timestamp);
					}
				}
				setVersions(buildVersions(history));
				setMessages(history.map((m) => hydrateHistoryMessage(m, now)));
			}
		);
		return () => {
			cancelled = true;
		};
	}, [
		convId,
		isTranscriptCurrent,
		loadMessagesPageResult,
		setMessages,
		historyReloadKey,
	]);
	return {
		activePluginNote,
		handleRespondPermission,
		permissionRef,
		commandsRef,
		chatWidgetTemplatesRef,
		loadOlderMessages,
		retryHistoryLoad,
	} as const;
}
