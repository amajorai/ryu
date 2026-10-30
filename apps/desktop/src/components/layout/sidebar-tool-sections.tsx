import {
	ArrowUpRight01Icon,
	ServerStack01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useMcp } from "@/src/hooks/useMcp.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { SectionLoadError } from "./sidebar-agents-section.tsx";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	NAMED_SORT_ACCESSORS,
	sortItems,
	usePaged,
} from "./sidebar-sort-paging.ts";

/** MCP servers list in the sidebar — the servers registered on this node. Rows
 *  and the "+" open the Tools page, where MCP servers are managed. Keyed by
 *  `name` (McpServer has no id). Hidden by default. */
export function McpSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const openTab = useTabSelector((state) => state.openTab);
	const { servers, loading, error, reload } = useMcp();
	const paged = usePaged(
		sortItems(servers, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openTools = (forceNew = false) =>
		openTab("/tools", { title: "Tools", forceNew });
	const openToolsInNewWindow = () =>
		void openEntityInNewWindow({ path: "/tools", title: "Tools" });

	const emptyMessage = loading ? "Loading…" : "No MCP servers";

	const renderServerRows = (list: typeof servers) =>
		list.map((server) => (
			<SidebarMenuItem key={server.name}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openTools(true);
								}
							}}
							onClick={() => openTools()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openTools();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={ServerStack01Icon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={server.name}
							/>
							{!server.enabled && (
								<span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openTools(true)}>
							<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem onClick={openToolsInNewWindow} />
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openTools()} title="Add MCP server" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="MCP"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="mcp"
			sort={sort}
		>
			{error && servers.length === 0 && (
				<SectionLoadError
					message="Couldn't load your MCP servers."
					onRetry={() => {
						reload().catch(() => undefined);
					}}
				/>
			)}
			{!error && servers.length === 0 && (
				<p className="flex min-h-8 items-center px-2 text-detail text-muted-foreground">
					{emptyMessage}
				</p>
			)}
			{servers.length > 0 && (
				<>
					<SidebarMenu>{renderServerRows(paged.visible)}</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (server) => server.name ?? "",
							items: paged.items,
							label: "MCP servers",
							renderList: (list) => (
								<SidebarMenu>{renderServerRows(list)}</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** Individual tools available across the installed MCP servers, listed like
 *  Skills/MCP. Rows and the "+" open the Tools page. Sourced from the same
 *  useMcp() feed as the MCP section, but lists the tools rather than servers. */
export function ToolsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const openTab = useTabSelector((state) => state.openTab);
	const { tools, loading, error, reload } = useMcp();
	const paged = usePaged(
		sortItems(tools, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openTools = (forceNew = false) =>
		openTab("/tools", { title: "Tools", forceNew });

	const openToolsInNewWindow = () =>
		void openEntityInNewWindow({ path: "/tools", title: "Tools" });

	const emptyMessage = loading ? "Loading…" : "No tools";

	const renderToolRows = (list: typeof tools) =>
		list.map((tool) => (
			<SidebarMenuItem key={tool.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openTools(true);
								}
							}}
							onClick={() => openTools()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openTools();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={Wrench01Icon}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={tool.name}
							/>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openTools(true)}>
							<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem onClick={openToolsInNewWindow} />
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openTools()} title="Browse tools" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Tools"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="tools"
			sort={sort}
		>
			{error && tools.length === 0 && (
				<SectionLoadError
					message="Couldn't load your tools."
					onRetry={() => {
						reload().catch(() => undefined);
					}}
				/>
			)}
			{!error && tools.length === 0 && (
				<p className="flex min-h-8 items-center px-2 text-detail text-muted-foreground">
					{emptyMessage}
				</p>
			)}
			{tools.length > 0 && (
				<>
					<SidebarMenu>{renderToolRows(paged.visible)}</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (tool) => tool.name ?? "",
							items: paged.items,
							label: "tools",
							renderList: (list) => (
								<SidebarMenu>{renderToolRows(list)}</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}
