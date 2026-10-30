import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ForkDestination } from "@/src/components/chat/ForkDialog.tsx";
import { isMergedHistoryId } from "@/src/hooks/useMergedAgentThreads.ts";
import { getConversationModelSelection } from "@/src/lib/api/conversation-model-selection.ts";
import { getConversationFeedback } from "@/src/lib/api/message-feedback.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import { buildVersions } from "@/src/lib/chat-message-selectors.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatSideChats } from "./ChatPage.side-chats.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatForkAndVersionsInput = ReturnType<
	typeof useChatComposerResources
> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatSideChats>;

/** Fork and hand-off, message versions, and edit and regenerate. */
export function useChatForkAndVersions({
	activeConversationId,
	forkConversation,
	openTab,
	tabBoundNodeName,
	currentTabId,
	updateTabWorktreeMode,
	convId,
	setFeedback,
	chatTargetRef,
	loadMessages,
	setVersions,
	convIdRef,
	editMessage,
	setMessages,
	skipNextUserAppendRef,
	regenerate,
	regenerateMessage,
	selectVersion,
	contextHandoffsRef,
	setContextHandoffs,
	btwRequestRef,
	setBtwState,
	setDismissedPluginNotes,
}: UseChatForkAndVersionsInput) {
	const tl = useLiteralMessages();
	// `tl` is a fresh function on every render; memos and callbacks read it
	// through this ref so their identities stay stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	// Branch ("fork into new chat"): ask where the copy should run before calling
	// Core. The request keeps the source conversation id with the message so a tab
	// switch while the dialog is open cannot fork the wrong thread.
	const [forkRequest, setForkRequest] = useState<{
		conversationId: string;
		messageId: string;
	} | null>(null);

	const handleBranch = useCallback(
		(messageId: string) => {
			// Prepended history from another thread in the merged agent view: every
			// action below writes into the LIVE conversation, so a foreign id must
			// bounce rather than branch the wrong thread.
			if (isMergedHistoryId(messageId)) {
				return;
			}
			if (!activeConversationId) {
				return;
			}
			setForkRequest({
				conversationId: activeConversationId,
				messageId,
			});
		},
		[activeConversationId]
	);

	const handleForkDestination = useCallback(
		(destination: ForkDestination) => {
			if (!forkRequest) {
				return;
			}
			const request = forkRequest;
			setForkRequest(null);
			void forkConversation(request.conversationId, request.messageId)
				.then((newId) => {
					if (!newId) {
						toast.error("Could not fork this chat.");
						return;
					}
					openTab("/chat", {
						conversationId: newId,
						forceNew: true,
						node: tabBoundNodeName,
						worktreeMode: destination === "worktree",
					});
				})
				.catch(() => {
					toast.error("Could not fork this chat.");
				});
		},
		[forkConversation, forkRequest, openTab, tabBoundNodeName]
	);

	const handleHandOffToWorktree = useCallback(
		(branchName: string) => {
			if (currentTabId) {
				updateTabWorktreeMode(currentTabId, true);
			}
			toast.success("Chat handed off to worktree", {
				description: tlRef.current(
					"The next response will continue on {branchName}.",
					{ branchName }
				),
			});
		},
		[currentTabId, updateTabWorktreeMode]
	);
	const handleWorktreeModeChange = useCallback(
		(enabled: boolean) => {
			if (currentTabId) {
				updateTabWorktreeMode(currentTabId, enabled);
			}
		},
		[currentTabId, updateTabWorktreeMode]
	);

	// Load the persisted thumbs state when THIS tab's conversation changes, so a
	// reloaded transcript restores its lit thumbs. Best-effort (empty on failure).
	// Keyed on the tab-local `convId`, never the shared focused-tab
	// `activeConversationId`: every chat tab stays mounted, so focusing another
	// tab would make each background tab clear its thumbs or load the focused
	// conversation's instead of its own.
	useEffect(() => {
		if (!convId) {
			setFeedback({});
			return;
		}
		let cancelled = false;
		getConversationFeedback(chatTargetRef.current, convId).then((map) => {
			if (!cancelled) {
				setFeedback(map);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [convId]);

	// After an edit/regenerate stream settles, re-read the active path so the
	// version pager counts (and any server-side title/ordering) reflect the new
	// branch. Cheap: one GET, keyed to the conversation being edited.
	const refreshVersions = useCallback(
		async (conv: string) => {
			const history = await loadMessages(conv);
			setVersions(buildVersions(history));
		},
		[loadMessages]
	);

	// Edit a previously-sent user message (ChatGPT/Claude-style). Core creates a
	// new sibling version carrying the new text and switches the active branch to
	// it; the client truncates the thread to the edit point, then streams a fresh
	// reply (skip_user_append: the sibling is already persisted).
	const handleEditMessage = useCallback(
		async (messageId: string, newText: string) => {
			if (isMergedHistoryId(messageId)) {
				return;
			}
			const conv = convIdRef.current ?? activeConversationId;
			if (!(conv && newText.trim())) {
				return;
			}
			const newId = await editMessage(conv, messageId, newText.trim());
			if (!newId) {
				return;
			}
			// Rebuild the local thread: keep everything before the edited message,
			// then the edited user turn (under its new id). Drop the rest — the new
			// reply will stream in beneath it.
			setMessages((prev) => {
				const idx = prev.findIndex((m) => m.id === messageId);
				const head = idx >= 0 ? prev.slice(0, idx) : prev;
				return [
					...head,
					{
						id: newId,
						role: "user" as const,
						parts: [{ type: "text" as const, text: newText.trim() }],
					},
				];
			});
			skipNextUserAppendRef.current = true;
			try {
				await regenerate();
			} finally {
				await refreshVersions(conv);
			}
		},
		[
			activeConversationId,
			editMessage,
			setMessages,
			regenerate,
			refreshVersions,
		]
	);

	// Regenerate an assistant reply: Core points the active branch at the user
	// turn above it; the client drops that assistant message (and anything after)
	// and streams a fresh sibling reply.
	const handleRegenerateMessage = useCallback(
		async (messageId: string) => {
			if (isMergedHistoryId(messageId)) {
				return;
			}
			const conv = convIdRef.current ?? activeConversationId;
			if (!conv) {
				return;
			}
			const ok = await regenerateMessage(conv, messageId);
			if (!ok) {
				return;
			}
			setMessages((prev) => {
				const idx = prev.findIndex((m) => m.id === messageId);
				return idx >= 0 ? prev.slice(0, idx) : prev;
			});
			skipNextUserAppendRef.current = true;
			try {
				await regenerate();
			} finally {
				await refreshVersions(conv);
			}
		},
		[
			activeConversationId,
			regenerateMessage,
			setMessages,
			regenerate,
			refreshVersions,
		]
	);

	// Page between versions at a branch point: Core switches the active leaf to
	// the chosen sibling and descends to its leaf; the client reloads the active
	// path to re-render the selected branch (no generation).
	const handleSelectVersion = useCallback(
		async (versionId: string) => {
			if (isMergedHistoryId(versionId)) {
				return;
			}
			const conv = convIdRef.current ?? activeConversationId;
			if (!conv) {
				return;
			}
			const ok = await selectVersion(conv, versionId);
			if (!ok) {
				return;
			}
			const history = await loadMessages(conv);
			setVersions(buildVersions(history));
			const now = Date.now();
			setMessages(history.map((m) => hydrateHistoryMessage(m, now)));
			// Handoff markers follow the branch: Core returns the ones recorded
			// for the thread now selected, so replace rather than merge.
			getConversationModelSelection(chatTargetRef.current, conv)
				.then((selection) => {
					if (convIdRef.current !== conv) {
						return;
					}
					contextHandoffsRef.current = selection.handoffs;
					setContextHandoffs(selection.handoffs);
				})
				.catch(() => {
					// Display-only: the markers refresh on the next load instead.
				});
		},
		[activeConversationId, selectVersion, loadMessages, setMessages]
	);

	// Reset per-thread ephemeral overlay state when switching conversations: a
	// `/btw` side question belongs to the thread it was asked in, and dismissed
	// plugin notes (e.g. double-check reviews) are per-thread too. Keyed on
	// `convId` so switching threads within the same tab clears a leftover answer
	// or dismissed note instead of carrying it across conversations.
	// convId is the reset trigger, not read in the body.
	useEffect(() => {
		btwRequestRef.current += 1;
		setBtwState(null);
		setDismissedPluginNotes(new Set());
	}, [convId]);
	return {
		forkRequest,
		setForkRequest,
		handleBranch,
		handleForkDestination,
		handleHandOffToWorktree,
		handleWorktreeModeChange,
		handleEditMessage,
		handleRegenerateMessage,
		handleSelectVersion,
	} as const;
}
