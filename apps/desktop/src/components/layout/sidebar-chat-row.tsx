// A single sidebar chat row. AppSidebar owns the conversation state and
// callbacks; this module composes the row from its sibling parts (leading
// disclosure, title, trailing cluster, the two menus, and dialogs).

import { GitBranchIcon, PinIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { memo, useCallback, useState } from "react";
import {
	quickReplyModifierMatches,
	readQuickReplyModifier,
} from "@/src/hooks/useQuickReplyModifier.ts";
import { isForkedConversation } from "@/src/lib/agent-conversation-groups.ts";
import type { Conversation } from "@/types/chat.ts";
import { ResourceVisibilityIndicator } from "./ResourceVisibilityIndicator.tsx";
import { SidebarTodoProgress } from "./SidebarTodoProgress.tsx";
import { useChatRowActions } from "./sidebar-chat-row-actions.ts";
import { ChatRowContextMenuContent } from "./sidebar-chat-row-context-menu.tsx";
import { ChatRowDialogs } from "./sidebar-chat-row-dialogs.tsx";
import { ChatRowDisclosureButton } from "./sidebar-chat-row-leading.tsx";
import { ChatRowDropdownMenu } from "./sidebar-chat-row-menu.tsx";
import type { ChatRowMenuModel } from "./sidebar-chat-row-menu-model.ts";
import { chatRowPreviewContent } from "./sidebar-chat-row-preview.tsx";
import { useChatRowState } from "./sidebar-chat-row-state.ts";
import { ChatRowTitle } from "./sidebar-chat-row-title.tsx";
import { ChatRowTrailing } from "./sidebar-chat-row-trailing.tsx";
import type { ChatRowHandlers } from "./sidebar-chat-row-types.ts";
import {
	applySidebarChatArrowKey,
	applySidebarChatSelectionClick,
	clearSidebarChatSelection,
	endSidebarChatDrag,
	SidebarChatBulkContextMenuContent,
	sidebarChatRowAttributes,
	startSidebarChatDrag,
	useSidebarChatSelection,
} from "./sidebar-chat-selection.tsx";
import { sidebarUnreadRowAttributes } from "./sidebar-more-unreads.tsx";

/** A single-line chat row, Codex style: title only, actions on hover.
 *
 *  Exported for `e2e/harness/chat-row-menus-story.tsx`, which mounts the real row
 *  to prove its ⋯ dropdown and its right-click menu list the SAME app-contributed
 *  rows — a fact no type-check can see, and one the two menus had already lost. */
export function ChatRow({
	conv,
	handlers,
}: {
	conv: Conversation;
	handlers: ChatRowHandlers;
}) {
	// The sidebar hands every row one stable handler facade
	// (`useStableChatRowHandlers`), so these derived values are the row's memo
	// keys: a tab switch, a title change elsewhere or another chat's pin toggle
	// re-renders only the rows it touches.
	const isSelected = useSidebarChatSelection((s) => s.selectedIds.has(conv.id));
	const folderPath = conv.folderPath || null;
	return (
		<MemoChatRow
			active={handlers.activeConversationId === conv.id}
			agents={handlers.agents}
			archived={handlers.archivedIds.has(conv.id)}
			canMakePrivate={handlers.canMakePrivate}
			conv={conv}
			handlers={handlers}
			hasBulk={Boolean(handlers.bulk)}
			pinned={handlers.pinnedIds.has(conv.id)}
			projectName={
				folderPath ? handlers.projectNameForFolder(folderPath) : null
			}
			pullRequestsEnabled={handlers.pullRequestsEnabled}
			schedulingEnabled={handlers.schedulingEnabled}
			// A selected row's bulk menu counts every set, so only selected rows
			// follow the whole sets.
			selectedArchivedIds={isSelected ? handlers.archivedIds : null}
			selectedPinnedIds={isSelected ? handlers.pinnedIds : null}
			selectedUnreadIds={isSelected ? handlers.unreadIds : null}
			sideChatsEnabled={handlers.sideChatsEnabled}
			targetToken={handlers.target.token}
			targetUrl={handlers.target.url}
			targetUserJwt={handlers.target.userJwt}
			unread={handlers.unreadIds.has(conv.id)}
		/>
	);
}

/** Memo keys only: the row reads everything from `conv` and `handlers`. */
interface ChatRowMemoKeys {
	active: boolean;
	agents: ChatRowHandlers["agents"];
	archived: boolean;
	canMakePrivate: boolean;
	hasBulk: boolean;
	pinned: boolean;
	projectName: string | null;
	pullRequestsEnabled: boolean | undefined;
	schedulingEnabled: boolean | undefined;
	selectedArchivedIds: ReadonlySet<string> | null;
	selectedPinnedIds: ReadonlySet<string> | null;
	selectedUnreadIds: ReadonlySet<string> | null;
	sideChatsEnabled: boolean | undefined;
	targetToken: string | null;
	targetUrl: string;
	targetUserJwt: string | null | undefined;
	unread: boolean;
}

const MemoChatRow = memo(function ChatRowView({
	conv,
	handlers,
}: {
	conv: Conversation;
	handlers: ChatRowHandlers;
} & ChatRowMemoKeys) {
	const state = useChatRowState(conv, handlers);
	const {
		activeConversationId,
		agents,
		archivedIds,
		loadMessages,
		onOpenInNewTab,
		onOpenQuickReply,
		onSelectConversation,
		onToggleArchive,
		pinnedIds,
		pullRequestsEnabled = false,
		target,
		unreadIds,
	} = handlers;
	const {
		bulk,
		cancelPrefetch,
		chatHistory,
		folderPath,
		handleVisibilityDragStart,
		isActive,
		isPinned,
		isSelected,
		isUnread,
		prefetchConversation,
		quickPreviewHold,
		runStatus,
		schedulePrefetch,
		showBulkMenu,
		showSidebarChatPreview,
	} = state;
	const [menuOpened, setMenuOpened] = useState(false);
	// Opening a menu re-renders the memoized row, so the menus read the latest
	// project targets and bulk projects from the handler facade.
	const [, setMenuOpen] = useState(false);
	const onMenuOpenChange = useCallback((open: boolean) => {
		setMenuOpen(open);
		if (open) {
			setMenuOpened(true);
		}
	}, []);
	const actions = useChatRowActions(conv, handlers, chatHistory, menuOpened);
	const forked = isForkedConversation(conv);
	const menuModel: ChatRowMenuModel = {
		onMenuOpenChange,
		archiveIcon: state.archiveIcon,
		archiveLabel: state.archiveLabel,
		autoRename: actions.autoRename,
		chatDeepLink: state.chatDeepLink,
		contributedMenuRows: actions.contributedMenuRows,
		conv,
		folderPath,
		handlers,
		isArchived: state.isArchived,
		isPinned: state.isPinned,
		isRetitling: actions.isRetitling,
		isUnread,
		learningLabel: actions.learningLabel,
		linkedPullRequests: state.linkedPullRequests,
		movable: state.movable,
		moveTargets: state.moveTargets,
		nextVisibility: state.nextVisibility,
		openHandoff: actions.openHandoff,
		pinIcon: state.pinIcon,
		pinLabel: state.pinLabel,
		projectName: state.projectName,
		readLabel: state.readLabel,
		runContributedRow: actions.runContributedRow,
		setConfirmDeleteOpen: state.setConfirmDeleteOpen,
		setConversationPullRequestLinked: state.setConversationPullRequestLinked,
		setIconDialogOpen: state.setIconDialogOpen,
		setPullRequestsDialogOpen: state.setPullRequestsDialogOpen,
		shared: state.shared,
		startEditing: state.startEditing,
		takeBack: actions.takeBack,
		toggleLearningExclusion: actions.toggleLearningExclusion,
		visibilityActionLabel: state.visibilityActionLabel,
		visibilityGroup: state.visibilityGroup,
		workingDirectory: state.workingDirectory,
	};
	const previewContent = chatRowPreviewContent({
		agents,
		conv,
		folderPath,
		runStatus,
		target,
	});

	return (
		<SidebarMenuItem>
			<ContextMenu onOpenChange={onMenuOpenChange}>
				<ContextMenuTrigger>
					{/* sidebar row combines nested controls with drag/middle-click */}
					<div
						className={`group/row relative flex cursor-grab items-center gap-2 overflow-hidden rounded-lg px-2 text-sm transition-colors duration-150 hover:duration-0 active:cursor-grabbing ${showSidebarChatPreview ? "py-1.5" : "h-8"} ${isSelected ? "bg-accent" : isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"}`}
						data-testid={`sidebar-chat-row-${conv.id}`}
						{...sidebarChatRowAttributes(conv.id, isSelected)}
						{...sidebarUnreadRowAttributes(isUnread)}
						draggable
						onAuxClick={(e) => {
							// Middle-click opens the chat in a new tab.
							if (e.button === 1) {
								e.preventDefault();
								onOpenInNewTab(conv.id);
							}
						}}
						onClick={(event) => {
							if (quickPreviewHold.consumeTriggered()) {
								event.preventDefault();
								return;
							}
							if (quickReplyModifierMatches(event, readQuickReplyModifier())) {
								event.preventDefault();
								onOpenQuickReply(conv.id);
								return;
							}
							if (
								bulk &&
								applySidebarChatSelectionClick(
									event,
									conv.id,
									activeConversationId
								)
							) {
								event.preventDefault();
								return;
							}
							onSelectConversation(conv.id);
						}}
						onContextMenu={() => {
							// Right-clicking outside the selection targets just this row.
							if (!isSelected) {
								clearSidebarChatSelection();
							}
						}}
						onDragEnd={endSidebarChatDrag}
						onDragStart={(event) => {
							handleVisibilityDragStart(event);
							startSidebarChatDrag(event, conv.id);
						}}
						onFocus={() => {
							if (!isActive) {
								prefetchConversation?.(conv.id);
							}
						}}
						onKeyDown={(e) => {
							// The row also contains real controls (pin/archive/menu). Let their
							// native Enter/Space handlers run without selecting the parent row.
							if (e.target !== e.currentTarget) {
								return;
							}
							if (bulk && applySidebarChatArrowKey(e, conv.id)) {
								return;
							}
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onSelectConversation(conv.id);
							}
						}}
						onPointerCancel={quickPreviewHold.onPointerCancel}
						onPointerDown={quickPreviewHold.onPointerDown}
						onPointerEnter={schedulePrefetch}
						onPointerLeave={cancelPrefetch}
						onPointerUp={quickPreviewHold.onPointerUp}
						role="button"
						tabIndex={0}
					>
						<SidebarTodoProgress
							celebrate={isUnread}
							conversation={conv}
							loadMessages={loadMessages}
							nodeUrl={target.url}
						/>
						<ChatRowDisclosureButton
							agents={agents}
							conv={conv}
							dotRingClass={state.dotRingClass}
							groupConversation={state.groupConversation}
							latestAgent={state.latestAgent}
							rowExpanded={state.rowExpanded}
							runStatus={runStatus}
							setRowExpanded={state.setRowExpanded}
						/>
						{conv.icon ? (
							<span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
								<GlyphDisplay fallback={null} size={16} value={conv.icon} />
							</span>
						) : null}
						<ResourceVisibilityIndicator visibility={conv.visibility} />
						<ChatRowTitle
							cancelEditing={state.cancelEditing}
							commitEditing={state.commitEditing}
							conv={conv}
							draftTitle={state.draftTitle}
							folderPath={folderPath}
							inputRef={state.inputRef}
							interfaceLevel={state.interfaceLevel}
							isEditing={state.isEditing}
							isRunning={state.isRunning}
							isUnread={isUnread}
							linkedPullRequests={state.linkedPullRequests}
							previewContent={previewContent}
							pullRequestsEnabled={pullRequestsEnabled}
							setDraftTitle={state.setDraftTitle}
							showSidebarChatPreview={showSidebarChatPreview}
							sidebarPreviewStates={state.sidebarPreviewStates}
							startEditing={state.startEditing}
							target={target}
						/>
						{/* One quiet trailing glyph: pinned wins over forked. It gives way to
						    the hover actions, which include the pin toggle. */}
						{isPinned || forked ? (
							<HugeiconsIcon
								aria-label={isPinned ? "Pinned" : "Forked thread"}
								className="size-3.5 shrink-0 text-muted-foreground/70 group-focus-within/row:hidden group-hover/row:hidden"
								icon={isPinned ? PinIcon : GitBranchIcon}
							/>
						) : null}
						<ChatRowTrailing
							animationsEnabled={state.animationsEnabled}
							archiveIcon={state.archiveIcon}
							archiveLabel={state.archiveLabel}
							codeSession={state.codeSession}
							conv={conv}
							folderPath={folderPath}
							interfaceLevel={state.interfaceLevel}
							isArchived={state.isArchived}
							isRunning={state.isRunning}
							linkedPullRequests={state.linkedPullRequests}
							onToggleArchive={onToggleArchive}
							pullRequestsEnabled={pullRequestsEnabled}
							runStatus={runStatus}
							target={target}
							unreadMessageCount={state.unreadMessageCount}
						/>
						<ChatRowDropdownMenu model={menuModel} />
					</div>
				</ContextMenuTrigger>
				{showBulkMenu && bulk ? (
					<SidebarChatBulkContextMenuContent
						actions={bulk}
						archivedIds={archivedIds}
						pinnedIds={pinnedIds}
						unreadIds={unreadIds}
					/>
				) : (
					<ChatRowContextMenuContent model={menuModel} />
				)}
			</ContextMenu>
			<ChatRowDialogs
				confirmDeleteOpen={state.confirmDeleteOpen}
				conv={conv}
				handlers={handlers}
				handoff={actions.handoff}
				iconDialogOpen={state.iconDialogOpen}
				linkedPullRequests={state.linkedPullRequests}
				messagesExpanded={state.messagesExpanded}
				openTab={state.openTab}
				pullRequestsDialogOpen={state.pullRequestsDialogOpen}
				resolveConfiguredNodes={state.resolveConfiguredNodes}
				rowExpanded={state.rowExpanded}
				setConfirmDeleteOpen={state.setConfirmDeleteOpen}
				setConversationPullRequestLinked={
					state.setConversationPullRequestLinked
				}
				setHandoff={actions.setHandoff}
				setIconDialogOpen={state.setIconDialogOpen}
				setMessagesExpanded={state.setMessagesExpanded}
				setPullRequestsDialogOpen={state.setPullRequestsDialogOpen}
				setSideChatsExpanded={state.setSideChatsExpanded}
				sideChatsExpanded={state.sideChatsExpanded}
			/>
		</SidebarMenuItem>
	);
});
