import { jsonResponseDocumentSchema } from "@ryu/app-host/json-values";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BtwState } from "@/src/components/chat/BtwOverlay.tsx";
import { askBtw, type BtwEntry } from "@/src/lib/api/btw.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import { saveTemporaryChat } from "@/src/lib/api/temporary-chat.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import {
	buildVersions,
	extractAssistantText,
} from "@/src/lib/chat-message-selectors.ts";
import { buildSideChatContext } from "@/src/lib/plugin-chat-features.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatGoals } from "./ChatPage.goals.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatSideChatsInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatGoals>;

/** Workspace folder, fresh threads, temporary chat saving, and side chats. */
export function useChatSideChats({
	ghostChatActive,
	convIdRef,
	setConversationFolder,
	pendingWorkspaceMessage,
	chatFolder,
	setPendingWorkspaceMessage,
	handleSendRef,
	draftConvId,
	mergedSeeded,
	setConvId,
	setActiveConversationId,
	setMessages,
	ghostChatsPluginEnabled,
	setGhostMode,
	status,
	chatSession,
	chatFolderRef,
	folder,
	chatTarget,
	agentId,
	createConversation,
	seedTitleFromFirstMessage,
	loadMessagesResult,
	messageSentAtRef,
	setVersions,
	clearError,
	refresh,
	activeConversationId,
	sideChatsPluginEnabled,
	isActiveTab,
	chatTargetRef,
	effectiveModel,
}: UseChatSideChatsInput) {
	const handleWorkspaceFolderSelected = useCallback(
		(selectedFolder: string) => {
			if (ghostChatActive) {
				return;
			}
			const conversationId = convIdRef.current;
			if (conversationId) {
				setConversationFolder(conversationId, selectedFolder);
			}
		},
		[ghostChatActive, setConversationFolder]
	);

	// A folder selection made from the lightweight prompt resumes the exact turn
	// that was waiting. The ref avoids replaying a stale callback after the store
	// updates, and clearing the pending value first makes the hand-off idempotent.
	useEffect(() => {
		if (!(pendingWorkspaceMessage && chatFolder)) {
			return;
		}
		const pending = pendingWorkspaceMessage;
		setPendingWorkspaceMessage(null);
		handleSendRef.current(pending);
	}, [chatFolder, pendingWorkspaceMessage]);

	// Start a brand-new empty thread in THIS tab: rotate the draft id, clear the
	// active conversation and the on-screen messages. Used when the ghost toggle
	// flips so a temporary chat and a persisted chat never share a thread — a
	// persisted conversation must never receive a non-persisted turn, and a ghost
	// thread must not inherit a persisted one.
	const startFreshThread = useCallback(() => {
		draftConvId.current = `conv-${Date.now()}`;
		// An explicit "new thread" outranks the merged view's open-on-newest seed
		// for the rest of this tab's life — see the latch above.
		mergedSeeded.current = true;
		setConvId(null);
		setActiveConversationId(null);
		setMessages([]);
	}, [setActiveConversationId, setMessages]);

	const toggleGhostMode = useCallback(() => {
		if (!ghostChatsPluginEnabled) {
			return;
		}
		startFreshThread();
		setGhostMode((on) => !on);
	}, [ghostChatsPluginEnabled, startFreshThread]);

	const [savingTemporaryChat, setSavingTemporaryChat] = useState(false);
	const handleSaveTemporaryChat = useCallback(async () => {
		if (
			!ghostChatActive ||
			savingTemporaryChat ||
			status === "submitted" ||
			status === "streaming"
		) {
			return;
		}
		const conversationId = convIdRef.current ?? draftConvId.current;
		const snapshot = chatSession.getLiveMessages().flatMap((message) => {
			if (message.role !== "user" && message.role !== "assistant") {
				return [];
			}
			// SAFETY: The branch admits a non-null, non-array object; copied metadata slots remain unknown and are preserved without interpreting them.
			return [
				{
					content: extractAssistantText(message),
					metadata: jsonResponseDocumentSchema.safeParse(message.metadata)
						.success
						? jsonResponseDocumentSchema.parse(message.metadata)
						: undefined,
					parts: Array.isArray(message.parts) ? [...message.parts] : undefined,
					role: message.role,
				},
			];
		});
		if (snapshot.length === 0) {
			return;
		}

		setSavingTemporaryChat(true);
		try {
			const folderPath = chatFolderRef.current ?? folder ?? undefined;
			await saveTemporaryChat(chatTarget, conversationId, {
				agentId: agentId ?? undefined,
				folderPath,
				messages: snapshot,
			});
			createConversation(conversationId, {
				agentId: agentId ?? undefined,
				folderPath,
			});
			if (folderPath) {
				setConversationFolder(conversationId, folderPath);
			}
			const firstUserMessage = snapshot.find(
				(message) => message.role === "user"
			);
			if (firstUserMessage) {
				seedTitleFromFirstMessage(conversationId, firstUserMessage.content);
			}
			setConvId(conversationId);
			setGhostMode(false);
			setActiveConversationId(conversationId);

			const saved = await loadMessagesResult(conversationId);
			if (saved.status === "ok" && saved.messages.length > 0) {
				const now = Date.now();
				for (const message of saved.messages) {
					if (isNativeNumber(message.timestamp)) {
						messageSentAtRef.current.set(message.id, message.timestamp);
					}
				}
				setVersions(buildVersions(saved.messages));
				setMessages(
					saved.messages.map((message) => hydrateHistoryMessage(message, now))
				);
			}
			clearError();
			refresh();
			toast.success("Chat saved", {
				description: "This temporary chat is now in your history.",
			});
		} catch {
			toast.error("Couldn’t save temporary chat", {
				description: "The chat is still temporary. Try saving again.",
			});
		} finally {
			setSavingTemporaryChat(false);
		}
	}, [
		agentId,
		chatFolderRef,
		chatTarget,
		clearError,
		createConversation,
		folder,
		ghostChatActive,
		loadMessagesResult,
		chatSession,
		refresh,
		savingTemporaryChat,
		seedTitleFromFirstMessage,
		setConvId,
		setActiveConversationId,
		setConversationFolder,
		setMessages,
		status,
	]);

	// A managed cloud agent's reply (and a finish summary) is appended by Core,
	// not streamed; the cloud task panel calls this when a run or finish settles
	// so the transcript shows Core's persisted messages.
	const reloadCloudTaskMessages = useCallback(async () => {
		const conversationId = convIdRef.current;
		if (!conversationId) {
			return;
		}
		let saved: Awaited<ReturnType<typeof loadMessagesResult>>;
		try {
			saved = await loadMessagesResult(conversationId);
		} catch {
			// Keep the current transcript; the next settle or reopen reloads it.
			return;
		}
		if (saved.status !== "ok" || convIdRef.current !== conversationId) {
			return;
		}
		const now = Date.now();
		for (const message of saved.messages) {
			if (isNativeNumber(message.timestamp)) {
				messageSentAtRef.current.set(message.id, message.timestamp);
			}
		}
		setVersions(buildVersions(saved.messages));
		setMessages(
			saved.messages.map((message) => hydrateHistoryMessage(message, now))
		);
	}, [loadMessagesResult, setMessages]);

	// `/btw` side question: an ephemeral question about the current conversation
	// shown in a dismissible overlay and never added to the chat history (modeled
	// on Claude Code's interactive `/btw`). The side model sees the conversation
	// context but has no tools. `null` = overlay closed.
	const [btwState, setBtwState] = useState<BtwState | null>(null);
	const btwRequestRef = useRef(0);
	const btwAbortRef = useRef<AbortController | null>(null);
	const btwScope = JSON.stringify([
		activeConversationId,
		chatTarget.url,
		chatTarget.token,
		chatTarget.userJwt ?? null,
		sideChatsPluginEnabled,
		isActiveTab,
	]);
	const btwScopeRef = useRef(btwScope);
	btwScopeRef.current = btwScope;
	const invalidateSideChatRequest = useCallback(() => {
		btwRequestRef.current += 1;
		btwAbortRef.current?.abort();
		btwAbortRef.current = null;
	}, []);
	const dismissSideChat = useCallback(() => {
		invalidateSideChatRequest();
		setBtwState(null);
	}, [invalidateSideChatRequest]);
	const stopSideChat = useCallback(() => {
		invalidateSideChatRequest();
		setBtwState((state) =>
			state
				? {
						...state,
						loading: false,
						error: "Side question stopped. Ask again to retry.",
					}
				: null
		);
	}, [invalidateSideChatRequest]);
	useEffect(() => {
		// A result belongs only to the conversation, node and credentials that
		// started it. Scope changes also discard a previously displayed answer.
		dismissSideChat();
		return invalidateSideChatRequest;
	}, [btwScope, dismissSideChat, invalidateSideChatRequest]);
	// Bumped after each `/btw` resolves so the Context rail's Side-chats list
	// refetches the now-persisted aside without a full reload.
	const [sideChatsRefreshKey, setSideChatsRefreshKey] = useState(0);

	/** Run one side question from either `/btw` or a selection-toolbar action. */
	const askSideChatQuestion = useCallback(
		(question: string, includeConversationContext = true) => {
			const convId = activeConversationId;
			if (!convId) {
				setBtwState({
					question,
					loading: false,
					answer: null,
					model: null,
					error: "Ask something in this chat first, then try again.",
				});
				return;
			}
			invalidateSideChatRequest();
			const requestId = btwRequestRef.current;
			const scope = btwScopeRef.current;
			const controller = new AbortController();
			btwAbortRef.current = controller;
			setBtwState({
				question,
				loading: true,
				answer: null,
				model: null,
				error: null,
			});
			askBtw(
				chatTargetRef.current,
				convId,
				question,
				// Read the latest visible transcript only when a side question is sent.
				includeConversationContext
					? buildSideChatContext(chatSession.getLiveMessages())
					: [],
				controller.signal,
				effectiveModel ?? undefined
			)
				.then((result) => {
					if (
						btwRequestRef.current !== requestId ||
						btwScopeRef.current !== scope
					) {
						return;
					}
					setBtwState({
						question,
						loading: false,
						answer: result.answer,
						model: result.model,
						error: null,
					});
					btwAbortRef.current = null;
					setSideChatsRefreshKey((key) => key + 1);
				})
				.catch((error) => {
					if (
						btwRequestRef.current !== requestId ||
						btwScopeRef.current !== scope
					) {
						return;
					}
					btwAbortRef.current = null;
					setBtwState({
						question,
						loading: false,
						answer: null,
						model: null,
						error:
							error instanceof ApiError
								? (error.serverMessage ?? error.message)
								: error instanceof Error
									? error.message
									: "Side question failed",
					});
				});
		},
		[
			activeConversationId,
			effectiveModel,
			chatSession,
			invalidateSideChatRequest,
		]
	);

	// Reopen a persisted side chat (from the Context rail or the sidebar) in the
	// btw overlay.
	const handleOpenSideChat = useCallback(
		(entry: BtwEntry) => {
			invalidateSideChatRequest();
			setBtwState({
				question: entry.question,
				loading: false,
				answer: entry.answer,
				model: entry.model ?? null,
				error: null,
			});
		},
		[invalidateSideChatRequest]
	);
	const handleOpenSideChatRequest = useCallback(
		(entry?: BtwEntry) => {
			if (entry) {
				handleOpenSideChat(entry);
				return;
			}
			setBtwState({
				question: "",
				loading: false,
				answer: null,
				model: null,
				error: null,
			});
		},
		[handleOpenSideChat]
	);
	return {
		handleWorkspaceFolderSelected,
		startFreshThread,
		toggleGhostMode,
		savingTemporaryChat,
		handleSaveTemporaryChat,
		reloadCloudTaskMessages,
		btwState,
		setBtwState,
		btwRequestRef,
		dismissSideChat,
		stopSideChat,
		sideChatsRefreshKey,
		askSideChatQuestion,
		handleOpenSideChat,
		handleOpenSideChatRequest,
	} as const;
}
