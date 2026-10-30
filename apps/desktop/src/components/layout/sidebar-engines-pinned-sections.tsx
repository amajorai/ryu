import {
	ArrowUpRight01Icon,
	Image01Icon,
	LayerIcon,
	Mic01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { useMemo } from "react";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useVoiceEngines } from "@/src/hooks/useVoiceEngines.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import type { Conversation } from "@/types/chat.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { SectionLoadError } from "./sidebar-agents-section.tsx";
import {
	isExplicitChatGrouping,
	useFilteredChats,
} from "./sidebar-chat-grouping.tsx";
import { SidebarChatList } from "./sidebar-chat-list.tsx";
import { useSidebarChatSelection } from "./sidebar-chat-selection.tsx";
import { DEFAULT_CHAT_SECTION_VIEW } from "./sidebar-chat-view.ts";
import { ChatRowList } from "./sidebar-conversation-list.tsx";
import type { ChatRowHandlers } from "./sidebar-conversation-rows.tsx";
import { useNestedSections } from "./sidebar-nested-sections.ts";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	sortItems,
	useConversationSortAccessors,
	usePaged,
} from "./sidebar-sort-paging.ts";
import { SubSection } from "./sidebar-subsection.tsx";

/**
 * The run-alongside catalog categories this section lists beside the swappable
 * Chat runtimes. `provider` is deliberately absent: that is the mutually
 * exclusive chat slot and it arrives via `useEngines`, which filters to it.
 *
 * Same pair as the Engines page's own `RUN_ALONGSIDE_CATEGORIES`
 * (`store/EnginesCatalogSection.tsx`), and for the same reason — every row here
 * opens that page, so the two must list the same engines.
 */
const SIDEBAR_RUN_ALONGSIDE_CATEGORIES = ["media", "voice"] as const;

const ENGINE_SHELF_ORDER_KEY = "ryu:sidebar-engine-shelf-order";
const ENGINE_SHELF_COLLAPSED_KEY = "ryu:sidebar-engine-shelf-collapsed";

/**
 * The shelves this section groups its rows into, in display order — the Engines
 * page's own groups, by the page's own labels, because every row here opens that
 * page. `shelf` matches the catalog category for the run-alongside kinds; `text`
 * is the chat-provider slot, which the page also calls "Text and Embedding".
 *
 * That label is the destination page's heading, NOT a promise that an embedding
 * engine can appear under it — none can. No embedding engine is a catalog entry
 * (Core's registry is test-locked at `embedding.len() == 0`), and the two
 * llama.cpp-derived retrieval engines the node dropdown does show come off
 * `/api/sidecar/status`, not the catalog, so this section — which is catalog-fed
 * and whose rows all open the Engines page — has nothing to put there. Renaming
 * it to "Text" would only make the sidebar and the page it opens disagree.
 */
const ENGINE_SHELVES: { icon: IconSvgElement; key: string; label: string }[] = [
	{ key: "text", label: "Text and Embedding", icon: LayerIcon },
	{ key: "media", label: "Image", icon: Image01Icon },
	{ key: "voice", label: "Speech", icon: Mic01Icon },
];

/** One engine row in the sidebar, flattened out of whichever hook produced it. */
interface SidebarEngineRow {
	displayName: string;
	/** Resident (chat) or running (image/speech) — both mean "live" to a reader. */
	live: boolean;
	name: string;
	/** Which {@link ENGINE_SHELVES} entry this row belongs under. */
	shelf: string;
}

/**
 * Engines list in the sidebar — every chat, image and speech engine installed on
 * this node. Rows and the "+" open the Engines store page; the resident chat
 * engine and any running speech/image sidecar show a live dot. Hidden by
 * default.
 *
 * Not "every runtime": the embeddings server and the reranker are not catalog
 * entries (see {@link ENGINE_SHELVES}), so they cannot be listed here, and the
 * Engines page these rows open does not list them either.
 *
 * TWO data sources, not one. `useEngines` is the Engines *page*'s chat-slot hook
 * and filters the catalog to `category === "provider"`, so on a normal install it
 * yields llama.cpp and nothing else — which is why this section used to read as a
 * pointless one-row list no matter how much was installed. The rest of what the
 * node dropdown calls an engine (Whisper, Kokoro, an image model) lives in the
 * catalog's `voice` and `media` categories, which `useVoiceEngines` serves with a
 * real per-sidecar `running` flag.
 *
 * The fix is a second source rather than a wider filter: `useEngines().engines`
 * also backs `store/EnginesCatalogSection.tsx` and `pages/PreflightPage.tsx`,
 * where "engine" genuinely means the swappable chat runtime, and widening it
 * there would put a TTS voice in the Chat picker.
 *
 * Shelved rather than listed flat once more than one kind is installed, and
 * paged BEFORE it is shelved — the shape the Chats/Spaces date buckets already
 * use (`DateGroupedRows` takes `paged.visible`, and one `SectionPagingControls`
 * sits outside it). Paging each shelf on its own would let three shelves render
 * 3 × `pageSize` rows in a section whose page size exists to keep it short.
 * A single surviving shelf renders with no header at all: a lone "Text and
 * Embedding" divider inside a section already titled "Engines" is a nesting
 * level that names nothing new.
 */
export function EnginesSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const openTab = useTabSelector((state) => state.openTab);
	const { engines, loading, error, reload } = useEngines();
	const {
		engines: runAlongside,
		error: runAlongsideError,
		loading: runAlongsideLoading,
		reload: reloadRunAlongside,
	} = useVoiceEngines(SIDEBAR_RUN_ALONGSIDE_CATEGORIES);

	// Both hooks return catalog+state merged, so keep only what is actually
	// installed (plus the resident engine, which is installed by definition).
	const rows = useMemo<SidebarEngineRow[]>(
		() => [
			...engines
				.filter((e) => e.active || e.installState === "installed")
				.map((e) => ({
					name: e.name,
					displayName: e.displayName,
					live: e.active,
					shelf: "text",
				})),
			...runAlongside
				.filter((e) => e.installState === "installed")
				.map((e) => ({
					name: e.name,
					displayName: e.displayName,
					live: e.runningKnown && e.running,
					shelf: e.category,
				})),
		],
		[engines, runAlongside]
	);

	const paged = usePaged(
		sortItems(rows, sort, {
			created: () => null,
			name: (r) => r.displayName,
			updated: () => null,
		}),
		pageSize
	);

	// Shelves are derived from the VISIBLE slice, so "Show 3 more" can reveal a
	// whole new shelf — same as a date bucket appearing on page two.
	//
	// `count` is deliberately taken from ALL rows, not the page. Unlike the date
	// buckets this shape borrows from, the sort key (displayName) is orthogonal to
	// the shelf, so one page boundary cuts through every shelf at once — a
	// page-local count would tell someone with 3 speech engines installed that
	// they have 2. Headers therefore report what is installed and the rows under
	// them are the page; "Show N more" fills them in.
	const shelves = useMemo(
		() =>
			ENGINE_SHELVES.map((shelf) => ({
				...shelf,
				count: rows.filter((r) => r.shelf === shelf.key).length,
				rows: paged.visible.filter((r) => r.shelf === shelf.key),
			})).filter((shelf) => shelf.rows.length > 0),
		[paged.visible, rows]
	);
	const shelfKeys = useMemo(() => shelves.map((s) => s.key), [shelves]);
	// Default EXPANDED: the point of this change is that these engines were
	// invisible, so shipping them behind a closed shelf lands in the same place.
	const nested = useNestedSections(
		ENGINE_SHELF_ORDER_KEY,
		ENGINE_SHELF_COLLAPSED_KEY,
		shelfKeys,
		false
	);

	const openEngines = (forceNew = false) =>
		openTab("/engines", { title: "Engines", forceNew });

	const openEnginesInNewWindow = () =>
		void openEntityInNewWindow({ path: "/engines", title: "Engines" });

	const failed = error !== null || runAlongsideError !== null;
	const emptyMessage =
		loading || runAlongsideLoading ? "Loading…" : "No engines installed";

	const iconOf = (shelfKey: string) =>
		ENGINE_SHELVES.find((s) => s.key === shelfKey)?.icon ?? LayerIcon;

	const renderEngineRows = (list: SidebarEngineRow[]) =>
		list.map((engine) => (
			<SidebarMenuItem key={engine.name}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openEngines(true);
								}
							}}
							onClick={() => openEngines()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openEngines();
								}
							}}
							role="button"
							tabIndex={0}
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={iconOf(engine.shelf)}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={engine.displayName}
							/>
							{/* Resident Chat, or a running speech/image sidecar. */}
							{engine.live && (
								<span className="size-1.5 shrink-0 rounded-full bg-success" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openEngines(true)}>
							<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem onClick={openEnginesInNewWindow} />
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openEngines()} title="Add engine" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Engines"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="engines"
			sort={sort}
		>
			{/* Gated on "nothing loaded", not on "something failed": one of the two
			    sources going down should still show what the other returned. */}
			{failed && rows.length === 0 && (
				<SectionLoadError
					message="Couldn't load your engines."
					onRetry={() => {
						reload().catch(() => undefined);
						reloadRunAlongside().catch(() => undefined);
					}}
				/>
			)}
			{!failed && rows.length === 0 && (
				<p className="flex min-h-8 items-center px-2 text-detail text-muted-foreground">
					{emptyMessage}
				</p>
			)}
			{rows.length > 0 && (
				<>
					{shelves.length > 1 ? (
						nested.orderedKeys.map((key) => {
							const shelf = shelves.find((s) => s.key === key);
							if (!shelf) {
								return null;
							}
							return (
								<SubSection
									collapsed={nested.isCollapsed(key)}
									count={shelf.count}
									dnd={nested.dnd}
									icon={shelf.icon}
									key={key}
									label={shelf.label}
									onToggleCollapsed={nested.toggle}
									sectionKey={key}
								>
									<SidebarMenu>{renderEngineRows(shelf.rows)}</SidebarMenu>
								</SubSection>
							);
						})
					) : (
						<SidebarMenu>{renderEngineRows(paged.visible)}</SidebarMenu>
					)}
					<SectionPagingControls
						overflow={{
							getSearchText: (engine) => engine.displayName ?? "",
							items: paged.items,
							label: "engines",
							renderList: (list) => (
								<SidebarMenu>{renderEngineRows(list)}</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** Pinned chats — floats above the chat history. Hidden when empty. */
export function PinnedSection({
	chatView,
	collapsed,
	dnd,
	handlers,
	menu,
	onToggleCollapsed,
	pageSize,
	pinned,
	sort,
}: SectionProps & {
	handlers: ChatRowHandlers;
	pinned: Conversation[];
}) {
	const view = chatView ?? DEFAULT_CHAT_SECTION_VIEW;
	const filtered = useFilteredChats(pinned, view);
	const conversationSort = useConversationSortAccessors();
	const sorted = sortItems(filtered, sort, conversationSort);
	const paged = usePaged(sorted, pageSize);
	// Explicit groupings show every match in collapsible groups instead of pages.
	const grouped = isExplicitChatGrouping(view.groupBy);
	// An empty Pinned section is hidden, except while a chat is being dragged so
	// it can be dropped here to pin it.
	const chatDragActive = useSidebarChatSelection((state) => state.dragging);
	if (pinned.length === 0 && !(chatDragActive && handlers.bulk)) {
		return null;
	}
	return (
		<SidebarSection
			chatDrop={handlers.bulk?.dropTarget({ kind: "pinned" })}
			chatView={view}
			collapsed={collapsed}
			dnd={dnd}
			label="Pinned"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="pinned"
			sort={sort}
		>
			{pinned.length === 0 ? (
				<p className="flex min-h-8 items-center px-2 text-detail text-muted-foreground">
					Drop chats here to pin them
				</p>
			) : null}
			{pinned.length > 0 && filtered.length === 0 ? (
				<p className="flex min-h-8 items-center px-2 text-detail text-muted-foreground">
					No pinned chats match the filters
				</p>
			) : null}
			<SidebarChatList
				conversations={grouped ? sorted : paged.visible}
				groupBy={view.groupBy}
				handlers={handlers}
				scope="pinned"
			/>
			{grouped ? null : (
				<SectionPagingControls
					overflow={{
						getSearchText: (c) => c.title ?? "",
						items: paged.items,
						label: "pinned chats",
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
