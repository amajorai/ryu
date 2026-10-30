// The right-click menu on a sidebar chat row. It lists the same rows, in the
// same order, as the ⋯ dropdown in `sidebar-chat-row-menu.tsx`.

import {
	ArrowUpRight01Icon,
	Calendar04Icon,
	ClipboardIcon,
	Copy01Icon,
	Delete01Icon,
	Folder01Icon,
	FolderTreeIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	ImageAdd01Icon,
	LaptopIcon,
	LinkSquare02Icon,
	Mail01Icon,
	MailReply01Icon,
	MessageQuestionIcon,
	MoreHorizontalIcon,
	PencilEdit01Icon,
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { copyChatTranscriptAsMarkdown } from "@/src/lib/copy-chat-transcript.ts";
import { OpenInNewWindowContextMenuItem } from "./OpenInNewWindowMenuItem.tsx";
import type { ChatRowMenuModel } from "./sidebar-chat-row-menu-model.ts";
import { copyChatValue } from "./sidebar-chat-row-types.ts";

export function ChatRowContextMenuContent({
	model,
}: {
	model: ChatRowMenuModel;
}) {
	const tl = useLiteralMessages();
	const {
		archiveIcon,
		isArchived,
		autoRename,
		chatDeepLink,
		contributedMenuRows,
		conv,
		folderPath,
		handlers,
		isRetitling,
		isUnread,
		learningLabel,
		linkedPullRequests,
		movable,
		moveTargets,
		nextVisibility,
		openHandoff,
		pinIcon,
		isPinned,
		projectName,
		readLabel,
		runContributedRow,
		setConfirmDeleteOpen,
		setConversationPullRequestLinked,
		setIconDialogOpen,
		setPullRequestsDialogOpen,
		shared,
		startEditing,
		takeBack,
		toggleLearningExclusion,
		visibilityActionLabel,
		visibilityGroup,
		workingDirectory,
	} = model;
	const {
		loadMessages,
		onAddScheduledTask,
		onAutoRenameConversation,
		onForkConversation,
		onMarkRead,
		onMarkUnread,
		onMoveToProject,
		onOpenInNewTab,
		onOpenInNewWindow,
		onOpenNewSideChat,
		onOpenQuickReply,
		onRemoveFromProject,
		onToggleArchive,
		onTogglePin,
		pullRequestsEnabled = false,
		schedulingEnabled = true,
		sideChatsEnabled = true,
	} = handlers;
	return (
		<ContextMenuContent>
			<ContextMenuItem onClick={() => onTogglePin(conv.id)}>
				<HugeiconsIcon className="size-4" icon={pinIcon} />
				{isPinned ? tl("Unpin chat") : tl("Pin chat")}
			</ContextMenuItem>
			<ContextMenuItem onClick={startEditing}>
				<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
				Rename chat
			</ContextMenuItem>
			{onAutoRenameConversation && (
				<ContextMenuItem disabled={isRetitling} onClick={autoRename}>
					Auto-rename
				</ContextMenuItem>
			)}
			{moveTargets.length > 0 ? (
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<HugeiconsIcon className="size-4" icon={Folder01Icon} />
						{projectName ? "Move to another project" : "Move to project"}
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						{moveTargets.map((project) => (
							<ContextMenuItem
								key={project.path}
								onClick={() => onMoveToProject(conv.id, project.path)}
							>
								<HugeiconsIcon className="size-4" icon={Folder01Icon} />
								{project.name}
							</ContextMenuItem>
						))}
					</ContextMenuSubContent>
				</ContextMenuSub>
			) : null}
			{movable && folderPath && projectName ? (
				<ContextMenuItem onClick={() => onRemoveFromProject(conv.id)}>
					<HugeiconsIcon className="size-4" icon={Folder01Icon} />
					{tl("Remove from {projectName}", { projectName })}
				</ContextMenuItem>
			) : null}
			<ContextMenuItem onClick={() => onToggleArchive(conv.id)}>
				<HugeiconsIcon className="size-4" icon={archiveIcon} />
				{isArchived ? tl("Unarchive chat") : tl("Archive chat")}
			</ContextMenuItem>
			<ContextMenuItem onClick={() => onOpenQuickReply(conv.id)}>
				<HugeiconsIcon className="size-4" icon={MailReply01Icon} />
				Quick reply
			</ContextMenuItem>
			<ContextMenuSeparator />
			{sideChatsEnabled ? (
				<ContextMenuItem onClick={() => onOpenNewSideChat(conv.id)}>
					<HugeiconsIcon className="size-4" icon={MessageQuestionIcon} />
					Open side chat
				</ContextMenuItem>
			) : null}
			<ContextMenuSub>
				<ContextMenuSubTrigger>
					<HugeiconsIcon className="size-4" icon={Copy01Icon} />
					Copy
				</ContextMenuSubTrigger>
				<ContextMenuSubContent>
					<ContextMenuItem
						disabled={!workingDirectory}
						onClick={() => {
							if (workingDirectory) {
								void copyChatValue(
									workingDirectory,
									"Working directory copied"
								);
							}
						}}
					>
						<HugeiconsIcon className="size-4" icon={Folder01Icon} />
						Copy working directory
					</ContextMenuItem>
					<ContextMenuItem
						onClick={() => void copyChatValue(conv.id, "Session ID copied")}
					>
						<HugeiconsIcon className="size-4" icon={ClipboardIcon} />
						Copy session ID
					</ContextMenuItem>
					<ContextMenuItem
						onClick={() =>
							void copyChatValue(chatDeepLink, "Chat deeplink copied")
						}
					>
						<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
						Copy deeplink
					</ContextMenuItem>
					<ContextMenuItem onClick={openHandoff}>
						<HugeiconsIcon className="size-4" icon={LaptopIcon} />
						Continue on another node
					</ContextMenuItem>
					{conv.continuedOn ? (
						<ContextMenuItem onClick={takeBack}>
							<HugeiconsIcon className="size-4" icon={LaptopIcon} />
							Take back here
						</ContextMenuItem>
					) : null}
					<ContextMenuSeparator />
					<ContextMenuItem
						onClick={() =>
							void copyChatTranscriptAsMarkdown(() => loadMessages(conv.id), {
								title: conv.title,
							})
						}
					>
						<HugeiconsIcon className="size-4" icon={Copy01Icon} />
						Copy as Markdown
					</ContextMenuItem>
				</ContextMenuSubContent>
			</ContextMenuSub>
			<ContextMenuSub>
				<ContextMenuSubTrigger>
					<HugeiconsIcon className="size-4" icon={GitBranchIcon} />
					Fork…
				</ContextMenuSubTrigger>
				<ContextMenuSubContent>
					<ContextMenuItem
						onClick={() => onForkConversation(conv.id, "workspace")}
					>
						<HugeiconsIcon className="size-4" icon={LaptopIcon} />
						Fork in this workspace
					</ContextMenuItem>
					<ContextMenuItem
						onClick={() => onForkConversation(conv.id, "worktree")}
					>
						<HugeiconsIcon className="size-4" icon={FolderTreeIcon} />
						Fork in a new worktree
					</ContextMenuItem>
				</ContextMenuSubContent>
			</ContextMenuSub>
			{pullRequestsEnabled && setConversationPullRequestLinked ? (
				<ContextMenuItem onClick={() => setPullRequestsDialogOpen(true)}>
					<HugeiconsIcon className="size-4" icon={GitPullRequestIcon} />
					{linkedPullRequests.length > 0
						? tl("Linked pull requests ({count})…", {
								count: String(linkedPullRequests.length),
							})
						: "Link pull request…"}
				</ContextMenuItem>
			) : null}
			{schedulingEnabled ? (
				<ContextMenuItem onClick={() => onAddScheduledTask(conv.id)}>
					<HugeiconsIcon className="size-4" icon={Calendar04Icon} />
					Add scheduled task…
				</ContextMenuItem>
			) : null}
			<ContextMenuSeparator />
			<OpenInNewWindowContextMenuItem
				onClick={() => onOpenInNewWindow(conv.id)}
			/>
			<ContextMenuItem onClick={() => onOpenInNewTab(conv.id)}>
				<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
				Open in new tab
			</ContextMenuItem>
			<ContextMenuItem
				onClick={() => (isUnread ? onMarkRead(conv.id) : onMarkUnread(conv.id))}
			>
				<HugeiconsIcon className="size-4" icon={Mail01Icon} />
				{readLabel}
			</ContextMenuItem>
			<ContextMenuItem onClick={() => setIconDialogOpen(true)}>
				<HugeiconsIcon className="size-4" icon={ImageAdd01Icon} />
				Change icon…
			</ContextMenuItem>
			<ContextMenuItem
				disabled={shared && !handlers.canMakePrivate}
				onClick={() =>
					handlers.onRequestConversationVisibility({
						from: visibilityGroup,
						id: conv.id,
						name: conv.title,
						resourceType: "chat",
						to: nextVisibility === "private" ? "private" : "team",
					})
				}
			>
				<HugeiconsIcon
					className="size-4"
					icon={shared ? ViewOffSlashIcon : UserMultiple02Icon}
				/>
				{shared && !handlers.canMakePrivate
					? "Make private (admins only)"
					: visibilityActionLabel}
			</ContextMenuItem>
			<ContextMenuItem onClick={toggleLearningExclusion}>
				<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
				{learningLabel}
			</ContextMenuItem>
			{/* Same contributed rows the ⋯ dropdown renders, in the same slot and
			    order. Right-clicking a chat is the more discoverable gesture of the
			    two, so an app-registered row missing here read as the app simply
			    not contributing anything. */}
			{contributedMenuRows.length > 0 && <ContextMenuSeparator />}
			{contributedMenuRows.map((item) => (
				<ContextMenuItem key={item.id} onClick={() => runContributedRow(item)}>
					{item.icon ? (
						<Icon className="size-4" icon={item.icon} size={16} />
					) : (
						<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
					)}
					{item.label}
				</ContextMenuItem>
			))}
			<ContextMenuSeparator />
			<ContextMenuItem
				onClick={() => setConfirmDeleteOpen(true)}
				variant="destructive"
			>
				<HugeiconsIcon className="size-4" icon={Delete01Icon} />
				Delete
			</ContextMenuItem>
		</ContextMenuContent>
	);
}
