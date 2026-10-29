import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useMemo, useState } from "react";
import { NodeFolderBrowser } from "@/src/components/chat/NodeFolderBrowser.tsx";
import {
	CloneFolderDialog,
	CreateFolderDialog,
	ProjectCommandDialog,
} from "@/src/components/chat/ProjectPicker.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useSidebarGroupedNav } from "@/src/hooks/useSidebarGroupedNav.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { DeleteAllChatsMenu } from "./sidebar-bot-chat-sections.tsx";
import {
	isExplicitChatGrouping,
	PROJECT_CHAT_GROUP_BY,
	useChatGrouping,
	useFilteredChats,
} from "./sidebar-chat-grouping.tsx";
import {
	PROJECT_EXPANDED_KEY,
	projectSortAccessors,
	SidebarChatList,
} from "./sidebar-chat-list.tsx";
import { useSidebarChatSelection } from "./sidebar-chat-selection.tsx";
import {
	activeChatFilterCount,
	type ChatGroupBy,
	DEFAULT_CHAT_SECTION_VIEW,
	filterChats,
} from "./sidebar-chat-view.ts";
import {
	ChatRowList,
	type ProjectBucket,
} from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import {
	PROJECT_ORDER_KEY,
	useNestedSections,
} from "./sidebar-nested-sections.ts";
import { ProjectRow } from "./sidebar-project-row.tsx";
import {
	ProjectScopeMenu,
	ProjectsPickerBody,
} from "./sidebar-scope-menus.tsx";
import {
	ALL_SELECTION,
	PROJECT_SELECTION_KEY,
	SidebarScopePicker,
	usePickerSelection,
} from "./sidebar-scope-picker.tsx";
import { type SectionProps, SidebarSection } from "./sidebar-section.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import { SECTION_ICONS } from "./sidebar-sections.ts";
import {
	type SortKey,
	sortItems,
	useConversationSortAccessors,
	usePaged,
} from "./sidebar-sort-paging.ts";

/** Every project as its own expandable row — the original model, kept behind the
 *  "Projects & Spaces as pickers" setting. */
function ProjectsListBody({
	groupBy,
	handlers,
	onNewChat,
	onRemove,
	onSetActive,
	pageSize,
	projects,
	sort,
}: {
	groupBy: ChatGroupBy;
	handlers: ChatRowHandlers;
	onNewChat: (path: string) => void;
	onRemove: (path: string) => void;
	onSetActive: (path: string) => void;
	pageSize: number;
	projects: ProjectBucket[];
	sort: SortKey;
}) {
	// Folders default collapsed; the section's Sort-by seeds their order, and the
	// user can drag to override it (persisted per folder path). Each folder's
	// chats follow the same Sort-by.
	const conversationSort = useConversationSortAccessors();
	const projectSort = useMemo(
		() => projectSortAccessors(conversationSort),
		[conversationSort]
	);
	const sortedProjects = sortItems(projects, sort, projectSort);
	const projectByPath = useMemo(
		() => new Map(sortedProjects.map((p) => [p.path, p])),
		[sortedProjects]
	);
	const projectPaths = useMemo(
		() => sortedProjects.map((p) => p.path),
		[sortedProjects]
	);
	const nested = useNestedSections(
		PROJECT_ORDER_KEY,
		PROJECT_EXPANDED_KEY,
		projectPaths,
		true
	);
	const paged = usePaged(nested.orderedKeys, pageSize);

	const renderProjectRows = (list: typeof nested.orderedKeys) =>
		list.map((path) => {
			const bucket = projectByPath.get(path);
			if (!bucket) {
				return null;
			}
			return (
				<ProjectRow
					bucket={bucket}
					collapsed={nested.isCollapsed(path)}
					dnd={nested.dnd}
					groupBy={groupBy}
					handlers={handlers}
					key={path}
					onNewChat={onNewChat}
					onRemove={onRemove}
					onSetActive={onSetActive}
					onToggleCollapsed={nested.toggle}
					sort={sort}
				/>
			);
		});

	// No `ml-2` here, unlike the Chats date buckets. Those buckets are dividers
	// INSIDE a section, so the indent says "these belong to Chats"; a project folder
	// is a top-level entity like a chat or a space, and indenting it left a gap on
	// the left edge that nothing else in the sidebar has.
	return (
		<>
			<div className="space-y-0.5">{renderProjectRows(paged.visible)}</div>
			<SectionPagingControls
				overflow={{
					getSearchText: (path) => path,
					items: paged.items,
					label: "projects",
					renderList: (list) => (
						<div className="space-y-0.5">{renderProjectRows(list)}</div>
					),
				}}
				paged={paged}
			/>
		</>
	);
}

/** All workspace projects under one section. The list is the union of the composer's
 *  recent folders and the folders of existing conversations (minus any the user
 *  removed) — the same synced store the project picker reads, so importing or
 *  removing in either surface reflects in both.
 *
 *  Two presentations, chosen by the "Projects & Spaces as pickers" setting: a picker
 *  whose default option ("All projects") lists every chat across every project, or
 *  the original row-per-project list where folders with no chats still show with a
 *  "No chats" hint. */
export function ProjectsSection({
	chatView,
	collapsed,
	dnd,
	handlers,
	menu,
	onToggleCollapsed,
	pageSize,
	projects: allProjects,
	sort,
}: SectionProps & {
	handlers: ChatRowHandlers;
	projects: ProjectBucket[];
}) {
	const tl = useLiteralMessages();
	const view = chatView ?? DEFAULT_CHAT_SECTION_VIEW;
	const { classify } = useChatGrouping();
	// Filters narrow each project's chats; while any is on, projects with no
	// matching chats drop out so the section reads as search results.
	const projects = useMemo(() => {
		if (activeChatFilterCount(view.filters) === 0) {
			return allProjects;
		}
		return allProjects
			.map((project) => ({
				...project,
				conversations: filterChats(
					project.conversations,
					view.filters,
					classify
				),
			}))
			.filter((project) => project.conversations.length > 0);
	}, [allProjects, view.filters, classify]);
	const { setFolder, removeProject } = useWorkspaceStore();
	const openTab = useTabSelector((state) => state.openTab);
	const [groupedNav] = useSidebarGroupedNav();
	const projectNames = useWorkspaceStore((state) => state.projectNames);
	const options = useMemo(
		() =>
			allProjects.map((p) => ({
				label: projectNames[p.path]?.trim() || p.name,
				value: p.path,
			})),
		[allProjects, projectNames]
	);
	const [selection, setSelection] = usePickerSelection(
		PROJECT_SELECTION_KEY,
		options
	);
	// What the picker is currently showing — the one selected project, or all of
	// them. Also the scope of the header's "Delete all chats": a header action that
	// reached past the visible list would be a destructive scope mismatch.
	const shown = useMemo(
		() =>
			selection === ALL_SELECTION
				? projects
				: projects.filter((p) => p.path === selection),
		[projects, selection]
	);
	const headerScope = groupedNav ? shown : projects;

	// The `+` opens the SAME command dialog as the composer's folder picker —
	// recent folders, "New project" (the node-aware NodeFolderBrowser), "Clone
	// from Git", and "Start from scratch" — via ProjectCommandDialog. The
	// create/browse/clone dialogs live OUTSIDE it so they survive it closing.
	const [menuOpen, setMenuOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [cloneOpen, setCloneOpen] = useState(false);
	const handleSelectBrowsed = (selected: string) => {
		// no-op on failure: never drop the folder here (removal is explicit only).
		setFolder(selected).catch(() => {
			// no-op
		});
	};

	// Activating a folder must NOT remove it on failure — removal is the row's
	// explicit remove action only. A transient failure leaves the row in place.
	const handleSetActive = (path: string) => {
		setFolder(path).catch(() => {
			// no-op
		});
	};

	// Start a fresh chat rooted in a folder: activate it (so the composer's
	// project picker and the run's cwd point at it), then open a new chat tab.
	// Awaiting `setFolder` first guarantees the new chat's first message runs
	// against this folder, not whatever was previously active. A failed activation
	// still opens the chat and never removes the folder.
	const handleNewChatInFolder = async (path: string) => {
		const shouldContinue = await setFolder(path).catch(() => true);
		if (!shouldContinue) {
			return;
		}
		openTab("/chat", { forceNew: true });
	};
	const handleOpenGraph = (path: string) => {
		const project = projects.find((item) => item.path === path);
		const label = projectNames[path]?.trim() || project?.name || path;
		openTab(`/project/graph/${encodeURIComponent(path)}`, {
			title: tl("Git graph · {label}", { label }),
		});
	};

	return (
		<>
			<SidebarSection
				action={
					<span className="mr-1">
						<button
							aria-haspopup="dialog"
							aria-label="Add project"
							className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/section:opacity-100 data-[popup-open]:opacity-100"
							data-popup-open={menuOpen ? "" : undefined}
							onClick={() => setMenuOpen(true)}
							type="button"
						>
							<HugeiconsIcon icon={Add01Icon} size={14} />
						</button>
						<ProjectCommandDialog
							onBrowse={() => setBrowseOpen(true)}
							onClone={() => setCloneOpen(true)}
							onOpenChange={setMenuOpen}
							onStartFromScratch={() => setCreateOpen(true)}
							open={menuOpen}
						/>
					</span>
				}
				chatDrop={
					groupedNav && selection !== ALL_SELECTION
						? handlers.bulk?.dropTarget({
								folderPath: selection,
								kind: "project",
								sourceFolders:
									allProjects.find((p) => p.path === selection)
										?.sourceFolders ?? [],
							})
						: undefined
				}
				// Already split by project; every other grouping applies inside each.
				chatGroupByOptions={PROJECT_CHAT_GROUP_BY}
				chatView={view}
				collapsed={collapsed}
				dnd={dnd}
				label="Projects"
				menu={menu}
				onToggleCollapsed={onToggleCollapsed}
				pageSize={pageSize}
				sectionKey="projects"
				sort={sort}
				wrapHeader={(header) => (
					<DeleteAllChatsMenu
						conversationIds={headerScope.flatMap((p) =>
							p.conversations.map((c) => c.id)
						)}
						groupLabel="Projects"
						onDelete={handlers.onDeleteConversation}
						scope="all"
					>
						{header}
					</DeleteAllChatsMenu>
				)}
			>
				{allProjects.length === 0 ? (
					<p className="px-2 py-2 text-muted-foreground text-xs">
						No projects yet. Click + to import a folder.
					</p>
				) : projects.length === 0 ? (
					<p className="px-2 py-2 text-muted-foreground text-xs">
						No project chats match the filters
					</p>
				) : groupedNav ? (
					<>
						<SidebarScopePicker
							actions={
								selection === ALL_SELECTION ? undefined : (
									<ProjectScopeMenu
										label={
											options.find((o) => o.value === selection)?.label ??
											selection
										}
										onNewChat={handleNewChatInFolder}
										onOpenGraph={handleOpenGraph}
										onRemove={removeProject}
										onSetActive={handleSetActive}
										path={selection}
									/>
								)
							}
							allLabel="All projects"
							icon={SECTION_ICONS.projects}
							onValueChange={setSelection}
							options={options}
							value={selection}
						/>
						<ProjectsPickerBody
							groupBy={view.groupBy}
							handlers={handlers}
							pageSize={pageSize}
							projects={shown}
							scope={selection}
							sort={sort}
						/>
					</>
				) : (
					<ProjectsListBody
						groupBy={view.groupBy}
						handlers={handlers}
						onNewChat={handleNewChatInFolder}
						onRemove={removeProject}
						onSetActive={handleSetActive}
						pageSize={pageSize}
						projects={projects}
						sort={sort}
					/>
				)}
			</SidebarSection>
			<CreateFolderDialog onOpenChange={setCreateOpen} open={createOpen} />
			<CloneFolderDialog onOpenChange={setCloneOpen} open={cloneOpen} />
			<NodeFolderBrowser
				onOpenChange={setBrowseOpen}
				onSelect={handleSelectBrowsed}
				open={browseOpen}
			/>
		</>
	);
}

/** Archived chats — a top-level section, consistent with the others. Hidden
 *  when empty; starts collapsed so it stays out of the way until needed. */
export function ArchivedSection({
	chatView,
	archived,
	collapsed,
	dnd,
	handlers,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps & {
	archived: Conversation[];
	handlers: ChatRowHandlers;
}) {
	const view = chatView ?? DEFAULT_CHAT_SECTION_VIEW;
	const filtered = useFilteredChats(archived, view);
	const conversationSort = useConversationSortAccessors();
	const sorted = sortItems(filtered, sort, conversationSort);
	const paged = usePaged(sorted, pageSize);
	// Explicit groupings show every match in collapsible groups instead of pages.
	const grouped = isExplicitChatGrouping(view.groupBy);
	// Hidden when empty, except mid-drag so a chat can be dropped in to archive it.
	const chatDragActive = useSidebarChatSelection((state) => state.dragging);
	if (archived.length === 0 && !(chatDragActive && handlers.bulk)) {
		return null;
	}
	return (
		<SidebarSection
			chatDrop={handlers.bulk?.dropTarget({ kind: "archived" })}
			chatView={view}
			collapsed={collapsed}
			dnd={dnd}
			label="Archived"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="archived"
			sort={sort}
		>
			{archived.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					Drop chats here to archive them
				</p>
			) : null}
			{archived.length > 0 && filtered.length === 0 ? (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					No archived chats match the filters
				</p>
			) : null}
			<SidebarChatList
				conversations={grouped ? sorted : paged.visible}
				groupBy={view.groupBy}
				handlers={handlers}
				scope="archived"
			/>
			{grouped ? null : (
				<SectionPagingControls
					overflow={{
						getSearchText: (c) => c.title ?? "",
						items: paged.items,
						label: "archived chats",
						renderList: (list) => (
							<ChatRowList conversations={list} handlers={handlers} />
						),
					}}
					paged={paged}
				/>
			)}
		</SidebarSection>
	);
}
