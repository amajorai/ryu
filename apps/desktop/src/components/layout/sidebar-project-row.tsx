import {
	Add01Icon,
	Delete01Icon,
	FileCodeIcon,
	Folder01Icon,
	Folder03Icon,
	FolderOpenIcon,
	GitBranchIcon,
	ImageAdd01Icon,
	PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { useMemo, useState } from "react";
import { GitHistoryDialog } from "@/src/components/chat/GitHistoryDialog.tsx";
import {
	ProjectGlyph,
	ProjectIconDialog,
} from "@/src/components/layout/ProjectIconDialog.tsx";
import { ProjectSettingsDialog } from "@/src/components/layout/ProjectSettingsDialog.tsx";
import { RemoteProjectStatus } from "@/src/components/layout/remote-project-status.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { SidebarChatList } from "./sidebar-chat-list.tsx";
import type { ChatGroupBy } from "./sidebar-chat-view.ts";
import type { ProjectBucket } from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import type { SubSectionDnd } from "./sidebar-nested-sections.ts";
import { SubSectionActionButton } from "./sidebar-section.tsx";
import {
	type SortKey,
	sortItems,
	useConversationSortAccessors,
} from "./sidebar-sort-paging.ts";
import { SubSection } from "./sidebar-subsection.tsx";

/** One nested folder inside the Projects section, rendered with the shared
 *  sub-section header (collapsible + drag-reorderable), expanding to its chats
 *  (or a "No chats" hint), with set-active / remove in the context menu. */
export function ProjectRow({
	bucket,
	collapsed,
	dnd,
	groupBy = "default",
	handlers,
	onNewChat,
	onRemove,
	onSetActive,
	onToggleCollapsed,
	sort = "default",
}: {
	bucket: ProjectBucket;
	collapsed: boolean;
	dnd: SubSectionDnd;
	/** The Projects section's Group by, applied to this project's chats. */
	groupBy?: ChatGroupBy;
	handlers: ChatRowHandlers;
	/** Start a fresh chat rooted in this folder (activates the folder first). */
	onNewChat: (path: string) => void;
	onRemove: (path: string) => void;
	onSetActive: (path: string) => void;
	onToggleCollapsed: (key: string) => void;
	/** The Projects section's Sort by, applied to this project's chats. */
	sort?: SortKey;
}) {
	const count = bucket.conversations.length;
	const conversationSort = useConversationSortAccessors();
	const conversations = sortItems(bucket.conversations, sort, conversationSort);
	const activeNode = useActiveNode();
	const activeNodeOnline = useNodeStore((state) => state.activeNodeOnline);
	const remote = !isLocalNode(activeNode);
	const customIcon = useWorkspaceStore(
		(state) => state.projectIcons[bucket.path]
	);
	const customName = useWorkspaceStore(
		(state) => state.projectNames[bucket.path]
	);
	const label = customName?.trim() || bucket.name;
	const tl = useLiteralMessages();
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
	const openTab = useTabSelector((state) => state.openTab);
	const { refresh } = useChatHistoryContext();
	const historyTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	const openProjectView = (kind: "diff" | "files" | "graph") => {
		const path = `/project/${kind}/${encodeURIComponent(bucket.path)}`;
		const title =
			kind === "diff" ? "Changes" : kind === "files" ? "Files" : "Git graph";
		openTab(path, {
			title: `${title} · ${label}`,
		});
	};
	const countText = String(count);
	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger>
					<SubSection
						action={
							<div className="flex items-center gap-0.5">
								<SubSectionActionButton
									icon={Add01Icon}
									onClick={() => onNewChat(bucket.path)}
									title="New chat in this folder"
								/>
								<SubSectionActionButton
									icon={FileCodeIcon}
									onClick={() => openProjectView("diff")}
									title="Open project changes"
								/>
								<SubSectionActionButton
									icon={FolderOpenIcon}
									onClick={() => openProjectView("files")}
									title="Browse project files"
								/>
								<SubSectionActionButton
									icon={GitBranchIcon}
									onClick={() => openProjectView("graph")}
									title="Open Git graph"
								/>
							</div>
						}
						chatDrop={handlers.bulk?.dropTarget({
							folderPath: bucket.path,
							kind: "project",
							sourceFolders: bucket.sourceFolders,
						})}
						collapsed={collapsed}
						count={count}
						dnd={dnd}
						icon={collapsed ? Folder01Icon : Folder03Icon}
						iconNode={
							customIcon ? (
								<ProjectGlyph fallback={null} icon={customIcon} />
							) : undefined
						}
						label={label}
						onToggleCollapsed={onToggleCollapsed}
						sectionKey={bucket.path}
						size="md"
						trailing={
							remote ? (
								<RemoteProjectStatus
									nodeName={activeNode.name}
									online={activeNodeOnline}
								/>
							) : undefined
						}
					>
						{bucket.sourceFolders.length > 1 && (
							<div className="type-compact mb-1 space-y-0.5 px-2 text-muted-foreground">
								<div className="font-medium uppercase tracking-wide">
									Sources
								</div>
								{bucket.sourceFolders.map((source) => (
									<div
										className="truncate font-mono"
										key={source}
										title={source}
									>
										{source}
									</div>
								))}
							</div>
						)}
						{count === 0 ? (
							<p className="px-2 py-1 text-muted-foreground/70 text-xs">
								No chats
							</p>
						) : (
							<SidebarChatList
								conversations={conversations}
								groupBy={groupBy}
								handlers={handlers}
								scope={bucket.path}
							/>
						)}
					</SubSection>
				</ContextMenuTrigger>
				<ContextMenuContent>
					<ContextMenuItem onClick={() => setSettingsOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
						Edit project…
					</ContextMenuItem>
					<ContextMenuItem onClick={() => onSetActive(bucket.path)}>
						<HugeiconsIcon className="mr-2 size-4" icon={FolderOpenIcon} />
						Set as active project
					</ContextMenuItem>
					<ContextMenuItem onClick={() => setIconDialogOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
						Change icon…
					</ContextMenuItem>
					<ContextMenuItem onClick={() => openProjectView("graph")}>
						<HugeiconsIcon className="mr-2 size-4" icon={GitBranchIcon} />
						Open Git graph
					</ContextMenuItem>
					<ContextMenuItem onClick={() => setHistoryOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={GitBranchIcon} />
						Conversation history
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						disabled={count === 0}
						onClick={() => setConfirmDeleteOpen(true)}
						variant="destructive"
					>
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						Delete all chats
						{count > 0 && (
							<span className="ml-auto pl-2 text-muted-foreground/70">
								{count}
							</span>
						)}
					</ContextMenuItem>
					<ContextMenuItem
						onClick={() => onRemove(bucket.path)}
						variant="destructive"
					>
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						Remove from app
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			<ProjectSettingsDialog
				onOpenChange={setSettingsOpen}
				open={settingsOpen}
				path={bucket.path}
			/>
			<GitHistoryDialog
				cwd={bucket.path}
				onImported={(conversationId) => {
					refresh();
					openTab("/chat", { conversationId });
				}}
				onOpenChange={setHistoryOpen}
				open={historyOpen}
				target={historyTarget}
			/>
			<ProjectIconDialog
				name={label}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				path={bucket.path}
			/>
			<AlertDialog onOpenChange={setConfirmDeleteOpen} open={confirmDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{tl(
								"Delete all {count, plural, one {{countText} chat} other {{countText} chats}} in {label}?",
								{ count, countText, label }
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{tl(
								'This permanently deletes {count, plural, one {{countText} chat} other {{countText} chats}} in the "{label}" project. The project folder itself is untouched. This cannot be undone.',
								{ count, countText, label }
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								for (const conv of bucket.conversations) {
									handlers.onDeleteConversation(conv.id);
								}
								setConfirmDeleteOpen(false);
							}}
							variant="destructive"
						>
							{tl(
								"Delete {count, plural, one {{countText} chat} other {{countText} chats}}",
								{ count, countText }
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
