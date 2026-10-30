import type { AgentChatProps } from "@ryu/blocks/desktop/agent-elements/types.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { formatQuotePrefix } from "@/components/agent-elements/quote.tsx";
import type { RewindPreselect } from "@/src/components/chat/RewindDialog.tsx";
import { useAppShellPath } from "@/src/contributions/app-shell-routes.ts";
import { useComposerAutoQueue } from "@/src/hooks/useComposerAutoQueue.ts";
import {
	useComposerDraftAutosave,
	useComposerDraftRestore,
} from "@/src/hooks/useComposerDraftAutosave.ts";
import {
	invalidateGitStatus,
	invalidateWorktreeDiff,
	invalidateWorktreeStatus,
} from "@/src/hooks/useGitStatus.ts";
import type {
	CheckpointRestoreMode,
	CheckpointRestoreResult,
} from "@/src/lib/api/chat-checkpoints.ts";
import {
	DRAFTS_BUTTON_ID,
	DRAFTS_PLUGIN_ID,
	saveDraft,
} from "@/src/lib/api/drafts.ts";
import { hydrateHistoryMessage } from "@/src/lib/chat-history-hydrate.ts";
import { buildVersions } from "@/src/lib/chat-message-selectors.ts";
import { mentionSearchQuery } from "@/src/lib/mentions/mcp-resources.ts";
import {
	registerTabSnapshot,
	TabTransferBlockedError,
} from "@/src/lib/tab-transfer.ts";
import { useQuickReplyStore } from "@/src/store/useQuickReplyStore.ts";
import type { useChatAnswerNow } from "./ChatPage.answer-now.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatForkAndVersions } from "./ChatPage.fork-versions.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatQueueAndReplies } from "./ChatPage.queue-replies.ts";
import type { useChatSend } from "./ChatPage.send.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatDraftsAndRewindInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatAnswerNow> &
	ReturnType<typeof useChatSend> &
	ReturnType<typeof useChatForkAndVersions> &
	ReturnType<typeof useChatQueueAndReplies>;

/** Drafts, focused reply threads, rewind, and composer submit. */
export function useChatDraftsAndRewind({
	convId,
	agentId,
	effectiveModel,
	chatFolder,
	ghostChatActive,
	chatTarget,
	refreshProjectDrafts,
	openTab,
	tabBoundNodeName,
	setRemoteMentionQuery,
	initialSubmit,
	initialPrompt,
	currentTabId,
	messages,
	attachedImages,
	pluginFlags,
	teamId,
	quote,
	replyContext,
	creatingReplyThread,
	setCreatingReplyThread,
	forkConversation,
	clearReply,
	setRewindPreselect,
	setRewindDialogOpen,
	pendingRewindEditRef,
	convIdRef,
	activeConversationId,
	loadMessages,
	setMessages,
	setVersions,
	clipsDraftInsertionSequence,
	setClipsDraftInsertion,
	effectiveStatus,
	handleEditMessage,
	maybeHandleBtwCommand,
	setQuote,
	setReplyContext,
	composerBlocked,
	handleSend,
	queueDrainMode,
	clearError,
	attachmentRef,
	enqueueMessage,
	setAttachedImages,
}: UseChatDraftsAndRewindInput) {
	const tl = useLiteralMessages();
	// `tl` is a fresh function on every render; memos and callbacks read it
	// through this ref so their identities stay stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	// Mirror unsent composer text into the `@ryu/drafts` outbox so closing the tab
	// does not destroy it. A no-op unless that app is enabled, and a blank composer
	// deletes the draft — which is also how a SEND clears it, since submitting
	// empties the text.
	// Keyed on THIS tab's conversation: the draft and the auto-queue belong to the
	// thread whose composer holds the text, not to whichever tab has focus.
	const draftContext = useMemo(
		() => ({
			conversationId: convId ?? undefined,
			agentId: agentId ?? undefined,
			model: effectiveModel ?? undefined,
			folderPath: chatFolder ?? undefined,
			persist: !ghostChatActive,
		}),
		[convId, agentId, effectiveModel, chatFolder, ghostChatActive]
	);
	const autosaveDraft = useComposerDraftAutosave(draftContext);

	// Suggested next task (`tasks.suggest`): Start opens the agent's proposed task
	// as a NEW chat in this chat's project and agent, never this thread, so the
	// follow-up does not widen the current conversation. Save to Drafts is offered
	// only when the Drafts app is on and this chat is not temporary.
	const draftsAvailable =
		useAppShellPath(DRAFTS_PLUGIN_ID, DRAFTS_BUTTON_ID) !== null;
	const taskSuggestionActions = useMemo<AgentChatProps["taskSuggestions"]>(
		() => ({
			canStartInWorktree: Boolean(chatFolder),
			onSaveDraft:
				draftsAvailable && !ghostChatActive
					? async (task) => {
							await saveDraft(chatTarget, {
								agent_id: agentId ?? undefined,
								folder_path: chatFolder ?? undefined,
								source: "manual",
								text: task.prompt,
							});
							await refreshProjectDrafts();
							toast.success("Saved to Drafts");
						}
					: undefined,
			onStart: (task, mode) => {
				openTab("/chat", {
					forceNew: true,
					initialAgent: agentId ?? undefined,
					initialProject: chatFolder ?? undefined,
					initialPrompt: task.prompt,
					// The user clicked Start on a card that shows the full prompt.
					initialSubmit: true,
					node: tabBoundNodeName,
					title: task.title,
					worktreeMode: mode === "worktree" ? true : undefined,
				});
			},
		}),
		[
			agentId,
			chatFolder,
			chatTarget,
			draftsAvailable,
			ghostChatActive,
			openTab,
			refreshProjectDrafts,
			tabBoundNodeName,
		]
	);
	const restoredDraft = useComposerDraftRestore(draftContext);
	const maybeAutoQueue = useComposerAutoQueue(draftContext);
	const composerDraftRef = useRef("");
	const handleDraftChange = useCallback(
		(draft: string) => {
			setRemoteMentionQuery(mentionSearchQuery(draft));
			composerDraftRef.current = draft;
			autosaveDraft(draft);
		},
		[autosaveDraft]
	);
	const composerSeed = initialSubmit
		? undefined
		: (initialPrompt ?? restoredDraft);
	useEffect(() => {
		if (!currentTabId) {
			return;
		}
		return registerTabSnapshot(currentTabId, () => {
			// Temporary history exists only in this renderer; keep its owner until
			// the temporary-chat runtime can resume it in another renderer.
			if (ghostChatActive && messages.length > 0) {
				throw new TabTransferBlockedError(
					"Save this temporary chat before moving it to another window."
				);
			}
			return {
				initialPrompt: composerDraftRef.current,
				initialImages: attachedImages,
				initialAgent: agentId ?? undefined,
				initialModel: effectiveModel ?? undefined,
				initialProject: chatFolder ?? undefined,
				initialGhost: ghostChatActive,
				initialPluginFlags: pluginFlags,
				initialTeamId: teamId ?? undefined,
				initialQuote: quote ?? undefined,
			};
		});
	}, [
		currentTabId,
		attachedImages,
		agentId,
		effectiveModel,
		chatFolder,
		ghostChatActive,
		pluginFlags,
		teamId,
		quote,
		messages.length,
	]);
	const handleCreateFocusedThread = useCallback(async () => {
		const pending = replyContext;
		if (!(pending && convId) || creatingReplyThread) {
			return;
		}
		setCreatingReplyThread(true);
		try {
			const newConversationId = await forkConversation(
				convId,
				pending.messageId
			);
			if (!newConversationId) {
				toast.error("Could not create a focused thread.");
				return;
			}
			const draft = composerDraftRef.current.trim();
			openTab("/chat", {
				conversationId: newConversationId,
				forceNew: true,
				initialModel: effectiveModel ?? undefined,
				initialPrompt: draft || undefined,
				initialQuote: pending.text,
				node: tabBoundNodeName,
				title: "Focused thread",
			});
			clearReply();
		} catch {
			toast.error("Could not create a focused thread.");
		} finally {
			setCreatingReplyThread(false);
		}
	}, [
		clearReply,
		convId,
		creatingReplyThread,
		forkConversation,
		effectiveModel,
		openTab,
		replyContext,
		tabBoundNodeName,
	]);

	const openRewind = useCallback((preselect: RewindPreselect | null) => {
		setRewindPreselect(preselect);
		setRewindDialogOpen(true);
	}, []);
	const handleRewindMessage = useCallback(
		(messageId: string, text: string) => {
			openRewind({ messageId, text });
		},
		[openRewind]
	);
	// `/rewind` is a client-side command: it opens the checkpoint picker.
	const maybeHandleRewindCommand = useCallback(
		(raw: string) => {
			if (raw.trim() !== "/rewind") {
				return false;
			}
			openRewind(null);
			return true;
		},
		[openRewind]
	);
	useEffect(() => {
		pendingRewindEditRef.current = null;
	}, [convId]);
	const handleRewindRestored = useCallback(
		async (result: CheckpointRestoreResult, mode: CheckpointRestoreMode) => {
			const conv = convIdRef.current ?? activeConversationId;
			if (result.files) {
				invalidateGitStatus();
				if (conv) {
					invalidateWorktreeStatus(conv);
					invalidateWorktreeDiff(conv);
				}
			}
			const rewound = result.conversation;
			if (rewound && conv) {
				const history = await loadMessages(conv);
				const now = Date.now();
				if (rewound.resendAsEdit) {
					pendingRewindEditRef.current = rewound.rewoundMessageId;
					setMessages([]);
				} else {
					pendingRewindEditRef.current = null;
					setMessages(history.map((m) => hydrateHistoryMessage(m, now)));
				}
				setVersions(buildVersions(history));
				if (rewound.rewoundText.trim()) {
					clipsDraftInsertionSequence.current += 1;
					setClipsDraftInsertion({
						id: clipsDraftInsertionSequence.current,
						text: rewound.rewoundText,
					});
				}
			}
			const skippedCount = result.files?.skipped.length ?? 0;
			if (skippedCount > 0) {
				// The dialog stays open and lists each protected file.
				toast.warning(
					tlRef.current(
						"Rewind left {skippedCount} {count, plural, one {file} other {files}} unchanged to protect unsaved work",
						{ count: skippedCount, skippedCount: String(skippedCount) }
					)
				);
				return;
			}
			const fileCount =
				(result.files?.restored.length ?? 0) +
				(result.files?.removed.length ?? 0);
			const filesNote =
				fileCount === 1
					? "1 file restored"
					: tlRef.current("{fileCount} files restored", {
							fileCount: String(fileCount),
						});
			toast.success(
				mode === "conversation"
					? "Conversation rewound"
					: mode === "code"
						? tlRef.current("Code rewound · {filesNote}", { filesNote })
						: tlRef.current("Code and conversation rewound · {filesNote}", {
								filesNote,
							})
			);
		},
		[activeConversationId, loadMessages, setMessages]
	);

	const submitNow = useCallback(
		(message: { role: "user"; content: string }) => {
			if (maybeHandleRewindCommand(message.content)) {
				return;
			}
			const rewindEditId = pendingRewindEditRef.current;
			if (
				rewindEditId &&
				message.content.trim() &&
				(effectiveStatus === "ready" || effectiveStatus === "error")
			) {
				pendingRewindEditRef.current = null;
				void handleEditMessage(rewindEditId, message.content);
				return;
			}
			// `/btw …` is a client-side command. `/goal …` is now handled
			// server-side by the io.ryu.goal plugin, so it is sent as a normal
			// message (the plugin parses it from the turn).
			if (maybeHandleBtwCommand(message.content)) {
				return;
			}
			// Bake any pending quote into the outgoing text as a leading markdown
			// blockquote, then clear it — the model sees the quoted context and the
			// sent user bubble re-renders it as a styled quote block.
			const outgoing = quote
				? {
						...message,
						content: `${formatQuotePrefix(quote)}${message.content}`,
					}
				: message;
			if (quote) {
				setQuote(null);
				setReplyContext(null);
			}
			if (composerBlocked) {
				handleSend(outgoing);
				return;
			}
			if (
				effectiveStatus === "ready" ||
				effectiveStatus === "error" ||
				queueDrainMode === "off"
			) {
				if (effectiveStatus === "error") {
					clearError();
				}
				handleSend(outgoing);
			} else {
				const attachments = attachmentRef.current.attachedImages;
				enqueueMessage(outgoing.content, attachments);
				setAttachedImages([]);
			}
		},
		[
			composerBlocked,
			effectiveStatus,
			queueDrainMode,
			clearError,
			handleSend,
			enqueueMessage,
			handleEditMessage,
			maybeHandleBtwCommand,
			maybeHandleRewindCommand,
			quote,
		]
	);

	// The auto-queue gate sits IN FRONT of the send, not inside it: when the node is
	// already at its concurrency ceiling and the user has asked for queueing, the
	// message becomes an armed draft and no turn starts. Only MANUAL sends pass
	// through here — the launchpad/dispatcher auto-submit path below calls
	// `submitNow` directly, because a draft the dispatcher just released for having
	// a free slot must not be re-queued by a reading taken a moment later.
	const handleComposerSubmit = useCallback(
		async (message: { role: "user"; content: string }) => {
			if (await maybeAutoQueue(message.content)) {
				return;
			}
			submitNow(message);
		},
		[maybeAutoQueue, submitNow]
	);

	// Sidebar quick replies use the same submit path as the visible composer. Keep
	// the callback in a ref so the tab registers once per conversation instead of
	// rebuilding its cross-component bridge on every composer render.
	const registerQuickReplyHandler = useQuickReplyStore(
		(state) => state.registerHandler
	);
	const quickReplySubmitRef = useRef(handleComposerSubmit);
	quickReplySubmitRef.current = handleComposerSubmit;
	useEffect(() => {
		if (!convId) {
			return;
		}
		return registerQuickReplyHandler(chatTarget.url, convId, (content) => {
			void quickReplySubmitRef.current({ role: "user", content });
		});
	}, [chatTarget.url, convId, registerQuickReplyHandler]);
	return {
		taskSuggestionActions,
		handleDraftChange,
		composerSeed,
		handleCreateFocusedThread,
		handleRewindMessage,
		handleRewindRestored,
		submitNow,
		handleComposerSubmit,
	} as const;
}
