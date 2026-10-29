import {
	Add01Icon,
	ArrowUpRight01Icon,
	Delete01Icon,
	DeliverySecure01Icon,
	FolderOpenIcon,
	GitBranchIcon,
	ImageAdd01Icon,
	PencilEdit01Icon,
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useMemo, useState } from "react";
import { GitHistoryDialog } from "@/src/components/chat/GitHistoryDialog.tsx";
import { EntityIconDialog } from "@/src/components/layout/EntityIconDialog.tsx";
import { OpenInNewWindowDropdownMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { ProjectIconDialog } from "@/src/components/layout/ProjectIconDialog.tsx";
import { ProjectSettingsDialog } from "@/src/components/layout/ProjectSettingsDialog.tsx";
import { RenameSpaceDialog } from "@/src/components/spaces/RenameSpaceDialog.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { Space } from "@/src/lib/api/spaces.ts";
import {
	resourceVisibilityGroup,
	type VisibilityChangeRequest,
} from "@/src/lib/resource-visibility.ts";
import { toEpoch } from "@/src/lib/sidebar/date-buckets.ts";
import { isExplicitChatGrouping } from "./sidebar-chat-grouping.tsx";
import { SidebarChatList } from "./sidebar-chat-list.tsx";
import type { ChatGroupBy } from "./sidebar-chat-view.ts";
import {
	ChatRowList,
	type ProjectBucket,
} from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import { ALL_SELECTION, ScopeMenu } from "./sidebar-scope-picker.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	type SortKey,
	sortItems,
	useConversationSortAccessors,
	usePaged,
} from "./sidebar-sort-paging.ts";
import { type EntityRow, EntityRowGlyph } from "./tab-entity-menu.tsx";

/**
 * The selected project's verbs, for the picker model.
 *
 * Every item here used to live on {@link ProjectRow}'s context menu. "Set as active
 * project" in particular is not a convenience — it is what the composer's project
 * picker and a run's cwd follow — so the picker model could not simply drop it and
 * call itself a decluttering. Only rendered when a single project is selected: none
 * of these verbs mean anything applied to "all".
 */
export function ProjectScopeMenu({
	label,
	onNewChat,
	onOpenGraph,
	onRemove,
	onSetActive,
	path,
}: {
	label: string;
	onNewChat: (path: string) => void;
	onOpenGraph: (path: string) => void;
	onRemove: (path: string) => void;
	onSetActive: (path: string) => void;
	path: string;
}) {
	const tl = useLiteralMessages();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const activeNode = useActiveNode();
	const { refresh } = useChatHistoryContext();
	const openTab = useTabSelector((state) => state.openTab);
	const target = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);
	return (
		<>
			<ScopeMenu label={tl("{label} options", { label })}>
				<DropdownMenuItem onClick={() => onNewChat(path)}>
					<HugeiconsIcon className="mr-2 size-4" icon={Add01Icon} />
					New chat in this folder
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onOpenGraph(path)}>
					<HugeiconsIcon className="mr-2 size-4" icon={GitBranchIcon} />
					Open Git graph
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setHistoryOpen(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={GitBranchIcon} />
					Conversation history
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onSetActive(path)}>
					<HugeiconsIcon className="mr-2 size-4" icon={FolderOpenIcon} />
					Set as active project
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setSettingsOpen(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
					Edit project…
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => setIconDialogOpen(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
					Change icon…
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => onRemove(path)} variant="destructive">
					<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
					Remove from app
				</DropdownMenuItem>
			</ScopeMenu>
			{/* Outside the menu so they survive it closing on select. */}
			<GitHistoryDialog
				cwd={path}
				onImported={(conversationId) => {
					refresh();
					openTab("/chat", { conversationId });
				}}
				onOpenChange={setHistoryOpen}
				open={historyOpen}
				target={target}
			/>
			<ProjectSettingsDialog
				onOpenChange={setSettingsOpen}
				open={settingsOpen}
				path={path}
			/>
			<ProjectIconDialog
				name={label}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				path={path}
			/>
		</>
	);
}

/**
 * The selected space's verbs, for the picker model — the {@link SpaceSidebarRow}
 * context menu and its hover `+`, rehoused.
 *
 * "Add files" matters most: `AddToSpaceDialog` is the sidebar's only path for
 * uploading into a space, and it needs a target, so without this the picker model
 * would have removed the feature rather than tidied it. The system-space branch on
 * delete is preserved verbatim in intent — Core refuses to delete one, so the item
 * is disabled with the reason rather than hidden.
 */
export function SpaceScopeMenu({
	canDelete,
	canMakePrivate,
	contributedRows,
	onAdd,
	onOpen,
	onOpenInNewTab,
	onOpenInNewWindow,
	onRequestDelete,
	onRename,
	onRequestVisibilityChange,
	setSpaceIcon,
	space,
}: {
	canDelete: boolean;
	canMakePrivate: boolean;
	contributedRows: EntityRow[];
	onAdd: () => void;
	onOpen: () => void;
	onOpenInNewTab: () => void;
	onOpenInNewWindow: () => void;
	onRequestDelete: () => void;
	onRename: (name: string) => Promise<void>;
	onRequestVisibilityChange: (request: VisibilityChangeRequest) => void;
	setSpaceIcon: (id: string, icon: GlyphValue) => Promise<void>;
	space: Space;
}) {
	const tl = useLiteralMessages();
	const updateTabsIconWhere = useTabSelector(
		(state) => state.updateTabsIconWhere
	);
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [renameOpen, setRenameOpen] = useState(false);
	return (
		<>
			<ScopeMenu label={tl("{name} options", { name: space.name })}>
				<DropdownMenuItem onClick={onAdd}>
					<HugeiconsIcon className="mr-2 size-4" icon={Add01Icon} />
					Add files to this space…
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onOpen}>
					<HugeiconsIcon className="mr-2 size-4" icon={DeliverySecure01Icon} />
					Open space page
				</DropdownMenuItem>
				<DropdownMenuItem onClick={onOpenInNewTab}>
					<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
					Open in new tab
				</DropdownMenuItem>
				<OpenInNewWindowDropdownMenuItem onClick={onOpenInNewWindow} />
				<DropdownMenuItem onClick={() => setIconDialogOpen(true)}>
					<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
					Change icon…
				</DropdownMenuItem>
				{space.system ? null : (
					<DropdownMenuItem onClick={() => setRenameOpen(true)}>
						<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
						Rename space
					</DropdownMenuItem>
				)}
				{space.system ? null : (
					<DropdownMenuItem
						disabled={
							resourceVisibilityGroup(space.visibility) === "team" &&
							!canMakePrivate
						}
						onClick={() =>
							onRequestVisibilityChange({
								from: resourceVisibilityGroup(space.visibility),
								id: space.id,
								name: space.name,
								resourceType: "space",
								to:
									resourceVisibilityGroup(space.visibility) === "team"
										? "private"
										: "team",
							})
						}
					>
						<HugeiconsIcon
							className="mr-2 size-4"
							icon={
								resourceVisibilityGroup(space.visibility) === "team"
									? ViewOffSlashIcon
									: UserMultiple02Icon
							}
						/>
						{resourceVisibilityGroup(space.visibility) === "team"
							? canMakePrivate
								? "Make private"
								: "Make private (admins only)"
							: "Share with team"}
					</DropdownMenuItem>
				)}
				{contributedRows.map((row) => (
					<DropdownMenuItem key={row.id} onClick={row.onSelect}>
						<span className="mr-2 inline-flex">
							<EntityRowGlyph row={row} />
						</span>
						{row.label}
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				{space.system || !canDelete ? (
					<Tooltip>
						<TooltipTrigger render={<span className="block" />}>
							<DropdownMenuItem disabled variant="destructive">
								<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
								Delete space
							</DropdownMenuItem>
						</TooltipTrigger>
						<TooltipContent className="max-w-56">
							{space.system
								? "System spaces can't be deleted — Ryu creates and maintains this one."
								: "Only organization members with Space delete permission can delete Spaces."}
						</TooltipContent>
					</Tooltip>
				) : (
					<DropdownMenuItem onClick={onRequestDelete} variant="destructive">
						<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
						Delete space
					</DropdownMenuItem>
				)}
			</ScopeMenu>
			<EntityIconDialog
				description={space.name}
				onChange={(next) => {
					updateTabsIconWhere((t) => t.path === `/spaces/${space.id}`, next);
					void setSpaceIcon(space.id, next).catch(() => {
						toast.error("Couldn't update space icon");
					});
				}}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				title="Space icon"
				value={space.icon}
			/>
			<RenameSpaceDialog
				onClose={() => setRenameOpen(false)}
				onRename={onRename}
				open={renameOpen}
				space={space}
			/>
		</>
	);
}

/**
 * A project's chats under the picker, paged.
 *
 * Unlike the Chats section — which buckets every loose chat and leaves paging to its
 * flat body — the picker's "All projects" list is the union of EVERY project's chats,
 * so it is paged in both models. Bucketing an unbounded union would put an unbounded
 * number of rows in the sidebar the moment the setting is on.
 */
export function ProjectsPickerBody({
	groupBy,
	handlers,
	pageSize,
	projects,
	scope,
	sort,
}: {
	groupBy: ChatGroupBy;
	handlers: ChatRowHandlers;
	pageSize: number;
	/** The chats to show: one project's, or every project's. */
	projects: ProjectBucket[];
	/** Namespaces the date-bucket collapse state for this selection. */
	scope: string;
	sort: SortKey;
}) {
	// Newest-first across the union, so "All projects" reads chronologically rather
	// than project-by-project. `sort` then re-orders it if the user picked one.
	const conversations = useMemo(() => {
		const all = projects.flatMap((p) => p.conversations);
		return all.sort((a, b) => toEpoch(b.updatedAt) - toEpoch(a.updatedAt));
	}, [projects]);
	const conversationSort = useConversationSortAccessors();
	const sorted = sortItems(conversations, sort, conversationSort);
	const paged = usePaged(sorted, pageSize);
	const grouped = isExplicitChatGrouping(groupBy);

	if (conversations.length === 0) {
		return (
			<p className="px-2 py-2 text-muted-foreground text-xs">
				{scope === ALL_SELECTION
					? "No chats in your projects yet"
					: "No chats in this project yet"}
			</p>
		);
	}

	return (
		<>
			<SidebarChatList
				conversations={grouped ? sorted : paged.visible}
				groupBy={groupBy}
				handlers={handlers}
				scope={scope}
			/>
			{grouped ? null : (
				<SectionPagingControls
					overflow={{
						getSearchText: (c) => c.title ?? "",
						items: paged.items,
						label: "chats",
						renderList: (list) => (
							<ChatRowList conversations={list} handlers={handlers} />
						),
					}}
					paged={paged}
				/>
			)}
		</>
	);
}
