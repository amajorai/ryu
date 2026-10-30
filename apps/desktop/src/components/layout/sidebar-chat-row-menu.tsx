// The ⋯ dropdown menu on a sidebar chat row. Its right-click twin lives in
// `sidebar-chat-row-context-menu.tsx`; both read `ChatRowMenuModel`.

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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { copyChatTranscriptAsMarkdown } from "@/src/lib/copy-chat-transcript.ts";
import { OpenInNewWindowDropdownMenuItem } from "./OpenInNewWindowMenuItem.tsx";
import type { ChatRowMenuModel } from "./sidebar-chat-row-menu-model.ts";
import { copyChatValue } from "./sidebar-chat-row-types.ts";

export function ChatRowDropdownMenu({ model }: { model: ChatRowMenuModel }) {
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
		<DropdownMenu onOpenChange={(open) => model.onMenuOpenChange?.(open)}>
			{/* data-[popup-open] keeps the trigger visible while the menu is
			    open. Without it, moving onto the menu drops group-hover, the
			    trigger goes display:none, and Base UI loses its anchor (the menu
			    jumps to the top-left). Base UI sets data-popup-open, not
			    data-state, on the trigger. */}
			<DropdownMenuTrigger
				aria-label="Chat options"
				onClick={(e) => e.stopPropagation()}
				variant="conversation-options"
			>
				<HugeiconsIcon icon={MoreHorizontalIcon} size={14} />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						onTogglePin(conv.id);
					}}
				>
					<HugeiconsIcon className="size-4" icon={pinIcon} />
					{isPinned ? tl("Unpin chat") : tl("Pin chat")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						startEditing();
					}}
				>
					<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
					Rename chat
				</DropdownMenuItem>
				{onAutoRenameConversation && (
					<DropdownMenuItem disabled={isRetitling} onClick={autoRename}>
						Auto-rename
					</DropdownMenuItem>
				)}

				{moveTargets.length > 0 ? (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<HugeiconsIcon className="size-4" icon={Folder01Icon} />
							{projectName ? "Move to another project" : "Move to project"}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							{moveTargets.map((project) => (
								<DropdownMenuItem
									key={project.path}
									onClick={(e) => {
										e.stopPropagation();
										onMoveToProject(conv.id, project.path);
									}}
								>
									<HugeiconsIcon className="size-4" icon={Folder01Icon} />
									{project.name}
								</DropdownMenuItem>
							))}
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				) : null}
				{movable && folderPath && projectName ? (
					<DropdownMenuItem
						onClick={(e) => {
							e.stopPropagation();
							onRemoveFromProject(conv.id);
						}}
					>
						<HugeiconsIcon className="size-4" icon={Folder01Icon} />
						{tl("Remove from {projectName}", { projectName })}
					</DropdownMenuItem>
				) : null}
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						onToggleArchive(conv.id);
					}}
				>
					<HugeiconsIcon className="size-4" icon={archiveIcon} />
					{isArchived ? tl("Unarchive chat") : tl("Archive chat")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						onOpenQuickReply(conv.id);
					}}
				>
					<HugeiconsIcon className="size-4" icon={MailReply01Icon} />
					Quick reply
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				{sideChatsEnabled ? (
					<DropdownMenuItem
						onClick={(e) => {
							e.stopPropagation();
							onOpenNewSideChat(conv.id);
						}}
					>
						<HugeiconsIcon className="size-4" icon={MessageQuestionIcon} />
						Open side chat
					</DropdownMenuItem>
				) : null}
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<HugeiconsIcon className="size-4" icon={Copy01Icon} />
						Copy
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuItem
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
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => void copyChatValue(conv.id, "Session ID copied")}
						>
							<HugeiconsIcon className="size-4" icon={ClipboardIcon} />
							Copy session ID
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() =>
								void copyChatValue(chatDeepLink, "Chat deeplink copied")
							}
						>
							<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
							Copy deeplink
						</DropdownMenuItem>
						<DropdownMenuItem onClick={openHandoff}>
							<HugeiconsIcon className="size-4" icon={LaptopIcon} />
							Continue on another node
						</DropdownMenuItem>
						{conv.continuedOn ? (
							<DropdownMenuItem onClick={takeBack}>
								<HugeiconsIcon className="size-4" icon={LaptopIcon} />
								Take back here
							</DropdownMenuItem>
						) : null}
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={() =>
								void copyChatTranscriptAsMarkdown(() => loadMessages(conv.id), {
									title: conv.title,
								})
							}
						>
							<HugeiconsIcon className="size-4" icon={Copy01Icon} />
							Copy as Markdown
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<HugeiconsIcon className="size-4" icon={GitBranchIcon} />
						Fork…
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuItem
							onClick={() => onForkConversation(conv.id, "workspace")}
						>
							<HugeiconsIcon className="size-4" icon={LaptopIcon} />
							Fork in this workspace
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => onForkConversation(conv.id, "worktree")}
						>
							<HugeiconsIcon className="size-4" icon={FolderTreeIcon} />
							Fork in a new worktree
						</DropdownMenuItem>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				{pullRequestsEnabled && setConversationPullRequestLinked ? (
					<DropdownMenuItem
						onClick={(e) => {
							e.stopPropagation();
							setPullRequestsDialogOpen(true);
						}}
					>
						<HugeiconsIcon className="size-4" icon={GitPullRequestIcon} />
						{linkedPullRequests.length > 0
							? tl("Linked pull requests ({count})…", {
									count: String(linkedPullRequests.length),
								})
							: "Link pull request…"}
					</DropdownMenuItem>
				) : null}
				{schedulingEnabled ? (
					<DropdownMenuItem onClick={() => onAddScheduledTask(conv.id)}>
						<HugeiconsIcon className="size-4" icon={Calendar04Icon} />
						Add scheduled task…
					</DropdownMenuItem>
				) : null}
				<DropdownMenuSeparator />
				<OpenInNewWindowDropdownMenuItem
					iconClassName="size-4"
					onClick={() => onOpenInNewWindow(conv.id)}
				/>
				<DropdownMenuItem onClick={() => onOpenInNewTab(conv.id)}>
					<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
					Open in new tab
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() =>
						isUnread ? onMarkRead(conv.id) : onMarkUnread(conv.id)
					}
				>
					<HugeiconsIcon className="size-4" icon={Mail01Icon} />
					{readLabel}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						setIconDialogOpen(true);
					}}
				>
					<HugeiconsIcon className="size-4" icon={ImageAdd01Icon} />
					Change icon…
				</DropdownMenuItem>
				<DropdownMenuItem
					disabled={shared && !handlers.canMakePrivate}
					onClick={(e) => {
						e.stopPropagation();
						handlers.onRequestConversationVisibility({
							from: visibilityGroup,
							id: conv.id,
							name: conv.title,
							resourceType: "chat",
							to: nextVisibility === "private" ? "private" : "team",
						});
					}}
				>
					<HugeiconsIcon
						className="size-4"
						icon={shared ? ViewOffSlashIcon : UserMultiple02Icon}
					/>
					{shared && !handlers.canMakePrivate
						? "Make private (admins only)"
						: visibilityActionLabel}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						toggleLearningExclusion();
					}}
				>
					<HugeiconsIcon className="size-4" icon={ViewOffSlashIcon} />
					{learningLabel}
				</DropdownMenuItem>
				{contributedMenuRows.length > 0 && <DropdownMenuSeparator />}
				{contributedMenuRows.map((item) => (
					<DropdownMenuItem
						key={item.id}
						onClick={(e) => {
							e.stopPropagation();
							runContributedRow(item);
						}}
					>
						{item.icon ? (
							<Icon className="size-4" icon={item.icon} />
						) : (
							<HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
						)}
						{item.label}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onClick={(e) => {
						e.stopPropagation();
						setConfirmDeleteOpen(true);
					}}
					tone="destructive"
				>
					<HugeiconsIcon className="size-4" icon={Delete01Icon} />
					Delete
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
