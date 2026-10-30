import { replyThreadDescription } from "@ryu/blocks/desktop/agent-elements/reply-thread.ts";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type {
	GhostControls,
	PluginComposerControlRow,
} from "@/components/agent-elements/input/goal-plus-button.tsx";
import type {
	InputBarInfoBar,
	InputBarProps,
	TemporaryChatSaveControls,
} from "@/components/agent-elements/input-bar.tsx";
import type { QueueBarProps } from "@/components/agent-elements/queue/queue-bar.tsx";
import {
	setChatLaunchpadEnabled,
	useChatLaunchpadEnabled,
} from "@/src/components/chat/launchpad-preference.ts";
import { MergedThreadPicker } from "@/src/components/chat/MergedThreadPicker.tsx";
import { SessionsPopover } from "@/src/components/chat/SessionsPopover.tsx";
import { WorkspaceBar } from "@/src/components/chat/WorkspaceBar.tsx";
import { setQueueDrainMode } from "@/src/hooks/useQueueDrainMode.ts";
import { getConversationModelSelection } from "@/src/lib/api/conversation-model-selection.ts";
import { TEMPORARY_CONTEXT_FLAG } from "@/src/lib/api/temporary-chat.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerControls } from "./ChatPage.composer-controls.tsx";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatDraftsAndRewind } from "./ChatPage.drafts-rewind.ts";
import type { useChatForkAndVersions } from "./ChatPage.fork-versions.ts";
import type { useChatGoals } from "./ChatPage.goals.ts";
import { mergeContextHandoffs } from "./ChatPage.helpers.ts";
import type { useChatMessagePipeline } from "./ChatPage.message-pipeline.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatQueueAndReplies } from "./ChatPage.queue-replies.ts";
import type { useChatSideChats } from "./ChatPage.side-chats.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";
import type { ChatPageBaseScope } from "./ChatPage.types.ts";

export type UseChatComposerRefsInput = ChatPageBaseScope &
	ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatGoals> &
	ReturnType<typeof useChatSideChats> &
	ReturnType<typeof useChatForkAndVersions> &
	ReturnType<typeof useChatQueueAndReplies> &
	ReturnType<typeof useChatDraftsAndRewind> &
	ReturnType<typeof useChatMessagePipeline> &
	ReturnType<typeof useChatComposerControls>;

/** Context handoffs and the refs that feed the composer chrome. */
export function useChatComposerRefs({
	convIdRef,
	conversationModelChangesRef,
	contextHandoffsRef,
	chatTargetRef,
	setContextHandoffs,
	status,
	refreshRoutingAdvice,
	replyContext,
	convId,
	creatingReplyThread,
	handleCreateFocusedThread,
	clearReply,
	botProduct,
	interfaceLevel,
	chatTarget,
	composerInfoBar,
	startFreshThread,
	setConvId,
	merged,
	composerLeft,
	pluginComposerBar,
	composerRight,
	goalState,
	goalDraftOpen,
	setGoalDraftOpen,
	handleGoalClear,
	handleGoalPause,
	handleGoalResume,
	handleGoalSubmit,
	mergedAgentId,
	composerSections,
	cloudSelection,
	processedMessages,
	cloudBlockReason,
	cloudScope,
	activeConversationId,
	draftConvId,
	chatFolder,
	retryCloudSelection,
	reloadCloudTaskMessages,
	handleWorktreeModeChange,
	tabWorktreeMode,
	editQueued,
	sendQueuedNow,
	removeQueued,
	sendQueuedAll,
	reorderQueued,
	clearQueue,
	queueDrainMode,
	queuedMessages,
	partitionedComposerControls,
	ghostChatActive,
	pluginFlags,
	setPluginFlags,
	expandedComposerPluginEnabled,
	ghostChatsPluginEnabled,
	toggleGhostMode,
	messages,
	handleSaveTemporaryChat,
	savingTemporaryChat,
}: UseChatComposerRefsInput) {
	// The "check my balance every time I send" half of the threshold fallback.
	// Bound to the turn LIFECYCLE rather than the submit handler: a send can land
	// through three paths here (direct, queued, blocked-retry), and the spend a
	// rule tests only exists once the turn has actually run — so re-asking as the
	// stream settles back to `ready` is both simpler and more accurate than
	// firing at keystroke time. Cache-backed in Core, so this is not a vendor
	// round-trip per message.
	const wasStreamingRef = useRef(false);
	// Model changes whose handoff outcome was already fetched after a turn, so a
	// change that needed no handoff is asked about once rather than every turn.
	const handoffCheckedRef = useRef(new Set<string>());
	const refreshContextHandoffs = useCallback(() => {
		const conversationId = convIdRef.current;
		const latest = conversationModelChangesRef.current.at(-1);
		if (
			!conversationId ||
			latest?.kind !== "change" ||
			handoffCheckedRef.current.has(latest.id) ||
			contextHandoffsRef.current.some(
				(handoff) => handoff.modelChangeId === latest.id
			)
		) {
			return;
		}
		handoffCheckedRef.current.add(latest.id);
		getConversationModelSelection(chatTargetRef.current, conversationId)
			.then((selection) => {
				if (convIdRef.current !== conversationId) {
					return;
				}
				const handoffs = mergeContextHandoffs(
					contextHandoffsRef.current,
					selection.handoffs
				);
				contextHandoffsRef.current = handoffs;
				setContextHandoffs(handoffs);
			})
			.catch(() => {
				// Display-only: the marker appears on the next load instead.
			});
	}, []);
	useEffect(() => {
		const streaming = status !== "ready";
		if (wasStreamingRef.current && !streaming) {
			refreshRoutingAdvice();
			refreshContextHandoffs();
		}
		wasStreamingRef.current = streaming;
	}, [status, refreshContextHandoffs, refreshRoutingAdvice]);

	const composerControlsRef = useRef<{
		infoBar: InputBarInfoBar | undefined;
		left: ReactNode;
		right: ReactNode;
		goalBar: InputBarProps["goalBar"];
		goalControls: InputBarProps["goalControls"];
	}>({
		infoBar: undefined,
		left: null,
		right: null,
		goalBar: undefined,
		goalControls: undefined,
	});
	const replyThreadInfoBar: InputBarInfoBar | undefined =
		replyContext && convId
			? {
					action: {
						label: creatingReplyThread ? "Creating…" : "Create thread",
						onClick: handleCreateFocusedThread,
					},
					description: replyThreadDescription(replyContext.chainLength),
					onClose: clearReply,
					title: "Long reply chain",
				}
			: undefined;
	// Runs on this conversation plus its cost/latency rollup. Advanced surface:
	// hidden in the simple interface and in the managed bot product.
	const sessionsControl =
		botProduct || interfaceLevel === "simple" ? null : (
			<SessionsPopover conversationId={convId} target={chatTarget} />
		);
	composerControlsRef.current = {
		// The threshold-fallback notice ("running this turn on X because Y is
		// low"). Rides the same ref as the other composer controls so the memoized
		// InputBar picks it up without re-rendering on every advice refetch.
		infoBar: replyThreadInfoBar ?? composerInfoBar,
		// In the merged agent view the composer must say which thread a send joins
		// — the transcript above it spans several. Sits ahead of the shared
		// agent/model controls so it reads as the destination, not a setting.
		left: mergedAgentId ? (
			<>
				<MergedThreadPicker
					activeConversationId={convId}
					onNewThread={startFreshThread}
					onSelectThread={setConvId}
					threads={merged.threads}
				/>
				{composerLeft}
				{sessionsControl}
			</>
		) : (
			<>
				{composerLeft}
				{sessionsControl}
			</>
		),
		// Contributed bar controls sit after the shell's own right-hand controls,
		// in the one slot the memoized InputBar reads from this ref.
		right: pluginComposerBar ? (
			<>
				{composerRight}
				{pluginComposerBar}
			</>
		) : (
			composerRight
		),
		goalBar:
			goalState?.goal || goalDraftOpen
				? {
						achieved: goalState?.status === "achieved",
						achievedAt: goalState?.achieved_at,
						paused: goalState?.status === "paused",
						onCancelDraft: () => setGoalDraftOpen(false),
						onClear: handleGoalClear,
						onPause: handleGoalPause,
						onResume: handleGoalResume,
						onSubmit: handleGoalSubmit,
						reason: goalState?.last_reason,
						startedAt: goalState?.started_at,
						startInEdit: goalDraftOpen,
						text: goalState?.goal ?? "",
						turns: goalState?.turns,
					}
				: undefined,
		goalControls: {
			active: Boolean(goalState?.goal),
			onPursueToggle: () => {
				if (goalState?.goal) {
					void handleGoalClear();
				} else {
					setGoalDraftOpen(true);
				}
			},
			onRemove: handleGoalClear,
		},
	};
	// `composerSections` already carries the plugin-contributed select sections:
	// they are fed to the factory as `extraSections` above, so they render inside
	// the composer's own settings dropdown (and its universal-picker body) exactly
	// like the ACP approval/config sections do.
	//
	// This ref feeds the composer's KEYBOARD SHORTCUTS, so it must stay the full
	// list — `firstExtraConfigSection` cycles the first non-agent/model/approval
	// section, and handing it the trigger-narrowed list would repoint that shortcut
	// at a different setting than the one the popover shows.
	const composerSectionsRef =
		useRef<ComposerSettingsSection[]>(composerSections);
	composerSectionsRef.current = composerSections;

	// Workspace strip (project ▸ branch ▸ worktree) rendered above the textarea.
	// Held in a ref like composerControlsRef so the memoized InputBar slot stays
	// stable; WorkspaceBar itself reads the workspace store reactively. The
	// conversation id is the worktree store key, so the draft id is used until a
	// conversation is created.
	// Ryu Work mode starts with no project picker; an explicit local-project request
	// opens the contextual chooser instead. Once a conversation has a thread, the
	// project ▸ branch ▸ worktree strip moves
	// out of the composer and into the floating Pinned summary card (top-right), so
	// the composer footer stays clean during a chat. In Code, a
	// fresh draft keeps the strip in the composer — the natural place to pick a
	// project first.
	const workspaceBarRef = useRef<ReactNode>(null);
	workspaceBarRef.current =
		cloudSelection.mode === "local" &&
		(interfaceLevel === "simple" || processedMessages.length > 0) ? null : (
			<WorkspaceBar
				cloudBlockReason={cloudBlockReason}
				cloudScope={cloudScope}
				cloudSelection={cloudSelection}
				cloudTaskConversationId={convId ?? null}
				conversationId={activeConversationId ?? draftConvId.current}
				folderOverride={chatFolder}
				onCloudRetry={retryCloudSelection}
				onCloudRunSettled={reloadCloudTaskMessages}
				onWorktreeModeChange={handleWorktreeModeChange}
				target={chatTarget}
				worktreeModeOverride={tabWorktreeMode}
			/>
		);

	// Live queue state for the InputBar's queue bar. Held in a ref (assigned every
	// render) so the slot component identity stays stable — see the note on
	// composerControlsRef above.
	const queueBarRef = useRef<QueueBarProps>({
		items: [],
		onEdit: editQueued,
		onSendNow: sendQueuedNow,
		onRemove: removeQueued,
		onSendAll: sendQueuedAll,
		onReorder: reorderQueued,
		onClear: clearQueue,
		onQueueModeChange: (mode) => setQueueDrainMode(mode),
		queueMode: queueDrainMode === "off" ? "off" : "auto",
	});
	queueBarRef.current = {
		items: queuedMessages,
		onEdit: editQueued,
		onSendNow: sendQueuedNow,
		onRemove: removeQueued,
		onSendAll: sendQueuedAll,
		onReorder: reorderQueued,
		onClear: clearQueue,
		onQueueModeChange: (mode) => setQueueDrainMode(mode),
		queueMode: queueDrainMode === "off" ? "off" : "auto",
	};

	// Goal affordances for the composer, held in refs so the memoized InputBar slot
	// stays stable (see composerControlsRef/queueBarRef above). The "+" dropdown
	// chip uses `active` (goal set and not yet achieved); the bar shows whenever a
	// goal exists (including the achieved state) or a draft is open.
	// Generic plugin-contributed composer toggles, mapped to the "+" dropdown rows.
	// Every `toggle` composer control (double-check included — it is now a plain
	// plugin contribution, no special-case) renders through this one generic loop
	// and merges into `plugin_flags` uniformly. Held in a ref (read by the memoized
	// InputBar slot) so a toggle re-renders the composer without rebuilding the slot.
	// The start page's app row is off by default (D5); the "+" menu carries its
	// toggle on a new chat only, so the apps stay one click away. It is a local
	// display preference, never a plugin flag sent with the turn.
	const launchpadEnabled = useChatLaunchpadEnabled();
	const offerLaunchpadToggle = !botProduct && processedMessages.length === 0;
	const pluginComposerControls = useMemo<PluginComposerControlRow[]>(() => {
		const rows: PluginComposerControlRow[] = partitionedComposerControls.toggles
			.filter((c) => c.flag !== TEMPORARY_CONTEXT_FLAG || ghostChatActive)
			.map((c) => ({
				id: c.id,
				flag: c.flag,
				label: c.label,
				description: c.description,
				enabled: Boolean(pluginFlags[c.flag]),
				onToggle: (flag: string, next: boolean) =>
					setPluginFlags((m) => ({ ...m, [flag]: next })),
			}));
		if (offerLaunchpadToggle) {
			rows.push({
				id: "ryu.start-page-apps",
				flag: "ryu.start-page-apps",
				label: "Apps on start page",
				description: "Show a row of your apps under the composer",
				enabled: launchpadEnabled,
				onToggle: (_flag: string, next: boolean) =>
					setChatLaunchpadEnabled(next),
			});
		}
		return rows;
	}, [
		ghostChatActive,
		launchpadEnabled,
		offerLaunchpadToggle,
		partitionedComposerControls.toggles,
		pluginFlags,
	]);
	const pluginComposerControlsRef = useRef<PluginComposerControlRow[]>([]);
	pluginComposerControlsRef.current = pluginComposerControls;
	const expandedComposerPluginEnabledRef = useRef(false);
	expandedComposerPluginEnabledRef.current = expandedComposerPluginEnabled;

	// Temporary chat toggle, now a row in the composer "+" dropdown rather
	// than a standalone toolbar button. Held in a ref (assigned every render) so
	// the memoized InputBar slot stays stable. Only offered on the new-chat surface
	// (no rendered messages) — an existing conversation can't retroactively become
	// temporary — but it stays available during an active temporary chat so the user
	// can see and exit the temporary state. `undefined` hides the row entirely.
	const ghostControlsRef = useRef<GhostControls | undefined>(undefined);
	ghostControlsRef.current =
		ghostChatsPluginEnabled &&
		(processedMessages.length === 0 || ghostChatActive)
			? { active: ghostChatActive, onToggle: toggleGhostMode }
			: undefined;
	const temporaryChatSaveControlsRef = useRef<
		TemporaryChatSaveControls | undefined
	>(undefined);
	temporaryChatSaveControlsRef.current =
		ghostChatActive && messages.length > 0
			? {
					disabled: status === "submitted" || status === "streaming",
					onSave: () => {
						void handleSaveTemporaryChat();
					},
					saving: savingTemporaryChat,
				}
			: undefined;
	return {
		composerControlsRef,
		composerSectionsRef,
		workspaceBarRef,
		queueBarRef,
		pluginComposerControlsRef,
		expandedComposerPluginEnabledRef,
		ghostControlsRef,
		temporaryChatSaveControlsRef,
	} as const;
}
