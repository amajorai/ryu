import {
	Activity01Icon,
	Add01Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowShrinkIcon,
	ArrowTurnBackwardIcon,
	AudioWave01Icon,
	Calendar04Icon,
	Cancel01Icon,
	CheckmarkBadge02Icon,
	Copy01Icon,
	CpuIcon,
	Delete02Icon,
	DeliverySecure01Icon,
	GridIcon,
	Home01Icon,
	InboxIcon,
	LibraryIcon,
	LinkSquare02Icon,
	Message01Icon,
	Mortarboard01Icon,
	Package01Icon,
	PackageIcon,
	PencilEdit01Icon,
	PieChartIcon,
	PinIcon,
	PinOffIcon,
	Pulse01Icon,
	PuzzleIcon,
	RowDeleteIcon,
	ServerStack01Icon,
	Settings01Icon,
	SidebarLeftIcon,
	SidebarTopIcon,
	Square01Icon,
	Store01Icon,
	Tag01Icon,
	Target01Icon,
	UnfoldMoreIcon,
	WorkflowCircle06Icon,
	Wrench01Icon,
	ZzzIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useHotkey } from "@ryu/hotkeys/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { ProgressiveBlur } from "@ryu/ui/components/progressive-blur";
import { useSidebar } from "@ryu/ui/components/sidebar";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import {
	createContext,
	type DragEvent,
	useContext,
	useEffect,
	useRef,
	useState,
	type WheelEvent,
} from "react";
import { openTabWindow } from "@/lib/tauri-bridge.ts";
import type {
	Split,
	SplitOrientation,
	Tab,
	TabGroup,
	TabGroupColor,
} from "@/src/contexts/TabsContext.tsx";
import {
	findSplit,
	TAB_GROUP_COLORS,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useTitleBarContext } from "@/src/contexts/TitleBarContext.tsx";
import { useNodeTabOverride } from "@/src/hooks/useNodeDisplayMode.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { setTabSizing, useTabSizing } from "@/src/hooks/useTabSizing.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { pathScrollsUnderTitlebar } from "./titlebarScroll.ts";

// Sidebar toggle moved to the window's fixed top-left (see Layout), so its
// icons are no longer imported here.
const isMac = navigator.userAgent.includes("Mac");

// Radio value used for the "follow the default node" choice in the per-tab node
// picker, distinct from any real node name.
const DEFAULT_NODE_VALUE = "__default__";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Drag-to-reorder state, shared by every tab chip in the strip. `draggingId` is
// the tab being dragged; `overId`/`dropBefore` mark which tab is hovered and on
// which side the drop indicator should draw. `canDrop` gates drops to tabs of
// the same pinned-state (pinned tabs reorder within their block, unpinned within
// theirs) since `normalize` would otherwise snap a cross-block drop back anyway.
interface TabDnd {
	canDrop: (targetId: string) => boolean;
	draggingId: string | null;
	dropBefore: boolean;
	onDrop: (id: string) => void;
	onEnd: () => void;
	onOver: (id: string, before: boolean) => void;
	onStart: (id: string) => void;
	overId: string | null;
}

const TabDndContext = createContext<TabDnd | null>(null);

function useTabDnd(): TabDnd {
	const ctx = useContext(TabDndContext);
	if (!ctx) {
		throw new Error("useTabDnd must be used inside the TitleBar tab strip");
	}
	return ctx;
}

// Owns the drag-to-reorder state for the whole strip and returns the value put
// on TabDndContext. Kept out of the TitleBar body so that component stays simple.
function useTabReorder(
	tabs: Tab[],
	moveTab: (draggedId: string, targetId: string, before: boolean) => void
): TabDnd {
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [overId, setOverId] = useState<string | null>(null);
	const [dropBefore, setDropBefore] = useState(true);

	const canDrop = (targetId: string): boolean => {
		if (!draggingId || draggingId === targetId) {
			return false;
		}
		const dragged = tabs.find((t) => t.id === draggingId);
		const target = tabs.find((t) => t.id === targetId);
		// Keep pinned tabs reordering within the pinned block and unpinned within
		// theirs — a cross-block drop would just be snapped back by normalize.
		return (
			!!dragged &&
			!!target &&
			Boolean(dragged.pinned) === Boolean(target.pinned)
		);
	};

	const reset = () => {
		setDraggingId(null);
		setOverId(null);
	};

	return {
		draggingId,
		overId,
		dropBefore,
		onStart: setDraggingId,
		onEnd: reset,
		onOver: (id, before) => {
			setOverId((prev) => (prev === id ? prev : id));
			setDropBefore((prev) => (prev === before ? prev : before));
		},
		onDrop: (id) => {
			if (draggingId && canDrop(id)) {
				moveTab(draggingId, id, dropBefore);
			}
			reset();
		},
		canDrop,
	};
}

// The vertical bar drawn in the gap beside the hovered tab to preview where the
// dragged tab will land. The host element must be `relative`.
function DropIndicator({ side }: { side: "left" | "right" }) {
	return (
		<span
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-y-1 z-20 w-0.5 rounded-full bg-primary",
				side === "left" ? "-left-1" : "-right-1"
			)}
		/>
	);
}

// Shared drag handlers + indicator flags for a single draggable tab chip. Keeps
// the dragstart/dragover/drop wiring in one place so PinnedTab and RegularTab
// stay in sync.
function useTabDragProps(tabId: string) {
	const dnd = useTabDnd();
	const isDragging = dnd.draggingId === tabId;
	const isOver = dnd.overId === tabId && dnd.draggingId !== tabId;
	return {
		isDragging,
		showBefore: isOver && dnd.dropBefore,
		showAfter: isOver && !dnd.dropBefore,
		dragHandlers: {
			draggable: true,
			onDragStart: (e: DragEvent) => {
				e.dataTransfer.effectAllowed = "move";
				e.dataTransfer.setData("text/plain", tabId);
				dnd.onStart(tabId);
			},
			onDragEnd: () => dnd.onEnd(),
			onDragOver: (e: DragEvent) => {
				if (
					!dnd.draggingId ||
					dnd.draggingId === tabId ||
					!dnd.canDrop(tabId)
				) {
					return;
				}
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				const rect = e.currentTarget.getBoundingClientRect();
				dnd.onOver(tabId, e.clientX < rect.left + rect.width / 2);
			},
			onDrop: (e: DragEvent) => {
				if (!dnd.draggingId) {
					return;
				}
				e.preventDefault();
				dnd.onDrop(tabId);
			},
		},
	};
}

// Static Tailwind classes per group color. Kept literal (not interpolated) so
// the compiler actually emits these utilities.
const GROUP_COLOR_CLASSES: Record<
	TabGroupColor,
	{ dot: string; pill: string; container: string }
> = {
	grey: {
		dot: "bg-slate-500",
		pill: "bg-slate-500/20 text-slate-700 dark:text-slate-200",
		container: "bg-slate-500/10 ring-slate-500/25",
	},
	blue: {
		dot: "bg-info",
		pill: "bg-info/20 text-info dark:text-info",
		container: "bg-info/10 ring-info/25",
	},
	red: {
		dot: "bg-destructive",
		pill: "bg-destructive/20 text-destructive dark:text-destructive",
		container: "bg-destructive/10 ring-destructive/25",
	},
	yellow: {
		dot: "bg-warning",
		pill: "bg-warning/20 text-warning dark:text-warning",
		container: "bg-warning/10 ring-warning/25",
	},
	green: {
		dot: "bg-success",
		pill: "bg-success/20 text-success dark:text-success",
		container: "bg-success/10 ring-success/25",
	},
	pink: {
		dot: "bg-pink-500",
		pill: "bg-pink-500/20 text-pink-700 dark:text-pink-200",
		container: "bg-pink-500/10 ring-pink-500/25",
	},
	purple: {
		dot: "bg-purple-500",
		pill: "bg-purple-500/20 text-purple-700 dark:text-purple-200",
		container: "bg-purple-500/10 ring-purple-500/25",
	},
	cyan: {
		dot: "bg-cyan-500",
		pill: "bg-cyan-500/20 text-cyan-700 dark:text-cyan-200",
		container: "bg-cyan-500/10 ring-cyan-500/25",
	},
	orange: {
		dot: "bg-orange-500",
		pill: "bg-orange-500/20 text-orange-700 dark:text-orange-200",
		container: "bg-orange-500/10 ring-orange-500/25",
	},
};

const COLOR_LABELS: Record<TabGroupColor, string> = {
	grey: "Grey",
	blue: "Blue",
	red: "Red",
	yellow: "Yellow",
	green: "Green",
	pink: "Pink",
	purple: "Purple",
	cyan: "Cyan",
	orange: "Orange",
};

// Single source of truth for tab icons, keyed by the same paths as PATH_TITLES
// in TabsContext. Keep both maps in sync so a new route always gets its own
// icon instead of silently falling back to the chat icon. Each glyph mirrors
// the matching sidebar entry (AppSidebar's SECTION_ICONS + the NavTabButton
// chrome) so a page's tab and its sidebar row read as the same thing.
const PATH_ICONS: Record<string, IconSvgElement> = {
	"/home": Home01Icon,
	"/chat": Message01Icon,
	"/agents": Target01Icon,
	"/engines": CpuIcon,
	"/store": PackageIcon,
	"/store/agents": PackageIcon,
	"/marketplace": Store01Icon,
	"/models": Package01Icon,
	"/skills": Mortarboard01Icon,
	"/spaces": DeliverySecure01Icon,
	"/meetings": AudioWave01Icon,
	"/tools": Wrench01Icon,
	"/workflows": WorkflowCircle06Icon,
	"/library": LibraryIcon,
	"/quests": CheckmarkBadge02Icon,
	"/timeline": Activity01Icon,
	"/review": PieChartIcon,
	"/activity": Pulse01Icon,
	"/calendar": Calendar04Icon,
	"/inbox": InboxIcon,
	"/approvals": InboxIcon,
	"/settings": Settings01Icon,
	"/extensions": PuzzleIcon,
	"/apps": Square01Icon,
	"/fleet": ServerStack01Icon,
};

const AGENT_EDIT_PATH_RE = /^\/agents\/.+\/edit$/;

function pathIcon(path: string): IconSvgElement {
	const base = path.split("?")[0];
	// Agent edit paths (/agents/:id/edit) share the agents icon.
	if (AGENT_EDIT_PATH_RE.test(base)) {
		return PATH_ICONS["/agents"];
	}
	// Exact route wins; otherwise fall back to the leading path segment so
	// detail subpaths (e.g. /spaces/:id, /workflows/:id) keep their page icon
	// instead of silently dropping to the chat fallback.
	const exact = PATH_ICONS[base];
	if (exact) {
		return exact;
	}
	const root = base.split("/").filter(Boolean)[0];
	return (root ? PATH_ICONS[`/${root}`] : undefined) ?? Message01Icon;
}

// The agents tab uses the static Ryu ghost logo instead of a HugeIcons glyph;
// every other tab keeps its path icon. Unloaded tabs always show Zzz regardless.
function isAgentsTab(path: string): boolean {
	const base = path.split("?")[0];
	return base === "/agents" || AGENT_EDIT_PATH_RE.test(base);
}

// Renders a tab's leading glyph: the static logo for agents tabs, otherwise the
// path's HugeIcons icon (or Zzz when unloaded). `className` carries each call
// site's sizing/color/hover-morph classes onto whichever element is rendered.
// Exported so the vertical-tabs sidebar list renders identical glyphs.
export function TabGlyph({
	path,
	unloaded,
	className,
	logoSize,
}: {
	path: string;
	unloaded?: boolean;
	className?: string;
	logoSize: string;
}) {
	if (!unloaded && isAgentsTab(path)) {
		return (
			<RyuLogo className={className} size={logoSize} variant="outline-static" />
		);
	}
	return (
		<HugeiconsIcon
			className={className}
			icon={unloaded ? ZzzIcon : pathIcon(path)}
		/>
	);
}

// Per-tab "Connect to node" submenu, shared by pinned and regular tabs.
function NodeSubmenu({ tabId }: { tabId: string }) {
	const nodes = useNodeStore((s) => s.nodes);
	const defaultNode = useNodeStore((s) => s.defaultNode);
	const overrideName = useNodeStore((s) => s.tabOverrides[tabId]);
	const setTabOverride = useNodeStore((s) => s.setTabOverride);
	const clearTabOverride = useNodeStore((s) => s.clearTabOverride);

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={ServerStack01Icon} />
				Connect to node
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				<ContextMenuRadioGroup
					onValueChange={(value) => {
						if (value === DEFAULT_NODE_VALUE) {
							clearTabOverride(tabId);
						} else {
							setTabOverride(tabId, value);
						}
					}}
					value={overrideName ?? DEFAULT_NODE_VALUE}
				>
					<ContextMenuRadioItem value={DEFAULT_NODE_VALUE}>
						Default ({capitalize(defaultNode)})
					</ContextMenuRadioItem>
					{nodes.map((node) => (
						<ContextMenuRadioItem key={node.name} value={node.name}>
							{capitalize(node.name)}
						</ContextMenuRadioItem>
					))}
				</ContextMenuRadioGroup>
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

// Shared "Add to group" submenu used by regular tabs.
function GroupSubmenu({ tab }: { tab: Tab }) {
	const { groups, createGroup, addTabToGroup, removeTabFromGroup } =
		useTabsContext();

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={Tag01Icon} />
				Add to group
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				<ContextMenuItem onClick={() => createGroup(tab.id)}>
					<HugeiconsIcon className="size-4" icon={Add01Icon} />
					New group
				</ContextMenuItem>
				{groups.length > 0 && <ContextMenuSeparator />}
				{groups.map((g) => (
					<ContextMenuItem
						key={g.id}
						onClick={() => addTabToGroup(tab.id, g.id)}
					>
						<span
							aria-hidden
							className={cn(
								"size-2 shrink-0 rounded-full",
								GROUP_COLOR_CLASSES[g.color].dot
							)}
						/>
						{g.name || "Group"}
					</ContextMenuItem>
				))}
				{tab.groupId && (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem onClick={() => removeTabFromGroup(tab.id)}>
							<HugeiconsIcon className="size-4" icon={RowDeleteIcon} />
							Remove from group
						</ContextMenuItem>
					</>
				)}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

// Per-tab "Split view" submenu: start a split (with a fresh chat or another open
// tab), or — when the tab is already split — flip orientation, drop this pane, or
// dissolve the whole split. Pinned tabs are excluded as split partners.
function SplitSubmenu({ tab }: { tab: Tab }) {
	const {
		tabs,
		splits,
		openTab,
		splitTabs,
		removeFromSplit,
		unsplit,
		setSplitOrientation,
	} = useTabsContext();
	const split = findSplit(tabs, splits, tab.id);
	// Tabs that can join a split: not this tab, not pinned, not already split.
	const candidates = tabs.filter(
		(t) => t.id !== tab.id && !t.pinned && !t.splitId
	);
	// Current members of this tab's split, used to grow it to 3+ panes.
	const members = split
		? tabs.filter((t) => t.splitId === split.id).map((t) => t.id)
		: [];

	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={GridIcon} />
				Split view
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				{split ? (
					<>
						<ContextMenuRadioGroup
							onValueChange={(value) =>
								setSplitOrientation(split.id, value as SplitOrientation)
							}
							value={split.orientation}
						>
							<ContextMenuRadioItem value="columns">
								Side by side
							</ContextMenuRadioItem>
							<ContextMenuRadioItem value="rows">Stacked</ContextMenuRadioItem>
						</ContextMenuRadioGroup>
						<ContextMenuSeparator />
						{/* Grow the split to 3+ panes: re-split with the existing members
						    plus a new one (splitTabs rebuilds membership). */}
						<ContextMenuItem
							onClick={() => {
								const id = openTab("/chat", { forceNew: true });
								splitTabs([...members, id], split.orientation);
							}}
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							Add new chat to split
						</ContextMenuItem>
						{candidates.length > 0 && (
							<ContextMenuSub>
								<ContextMenuSubTrigger>
									<HugeiconsIcon className="size-4" icon={GridIcon} />
									Add tab to split
								</ContextMenuSubTrigger>
								<ContextMenuSubContent>
									{candidates.map((c) => (
										<ContextMenuItem
											key={c.id}
											onClick={() =>
												splitTabs([...members, c.id], split.orientation)
											}
										>
											<span className="max-w-[160px] truncate">{c.title}</span>
										</ContextMenuItem>
									))}
								</ContextMenuSubContent>
							</ContextMenuSub>
						)}
						<ContextMenuSeparator />
						<ContextMenuItem onClick={() => removeFromSplit(tab.id)}>
							<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
							Remove from split
						</ContextMenuItem>
						<ContextMenuItem onClick={() => unsplit(tab.id)}>
							<HugeiconsIcon className="size-4" icon={ArrowShrinkIcon} />
							Unsplit
						</ContextMenuItem>
					</>
				) : (
					<>
						<ContextMenuItem
							onClick={() => {
								const id = openTab("/chat", { forceNew: true });
								splitTabs([tab.id, id]);
							}}
						>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							Split with new chat
						</ContextMenuItem>
						{candidates.length > 0 && <ContextMenuSeparator />}
						{candidates.map((c) => (
							<ContextMenuItem
								key={c.id}
								onClick={() => splitTabs([tab.id, c.id])}
							>
								<span className="max-w-[160px] truncate">
									Split with {c.title}
								</span>
							</ContextMenuItem>
						))}
					</>
				)}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

// Bulk-close helpers exclude pinned tabs — pinned tabs survive "close
// others/left/right" the way they do in Chrome.
function bulkCloseItems(tab: Tab, tabs: Tab[], closeTab: (id: string) => void) {
	const idx = tabs.findIndex((t) => t.id === tab.id);
	const others = tabs.filter((t) => t.id !== tab.id && !t.pinned);
	const toLeft = tabs.slice(0, idx).filter((t) => !t.pinned);
	const toRight = tabs.slice(idx + 1).filter((t) => !t.pinned);
	return (
		<>
			<ContextMenuItem
				disabled={others.length === 0}
				onClick={() => {
					for (const t of others) {
						closeTab(t.id);
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={Delete02Icon} />
				Close other tabs
			</ContextMenuItem>
			<ContextMenuItem
				disabled={toLeft.length === 0}
				onClick={() => {
					for (const t of toLeft) {
						closeTab(t.id);
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				Close tabs to the left
			</ContextMenuItem>
			<ContextMenuItem
				disabled={toRight.length === 0}
				onClick={() => {
					for (const t of toRight) {
						closeTab(t.id);
					}
				}}
			>
				<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
				Close tabs to the right
			</ContextMenuItem>
		</>
	);
}

// Move a tab into its own OS window (browser-style "Move tab to new window").
// The conversation lives server-side, so the spawned window re-fetches it by id;
// we carry the tab's node binding so a remote-targeted chat keeps its node. Move
// semantics (close the source) match Chrome — a mid-stream reply not yet
// persisted is the one thing lost, so the menu item is omitted while streaming is
// not something we can detect here; the trade-off is documented in CLAUDE notes.
async function moveTabToNewWindow(tab: Tab, closeTab: (id: string) => void) {
	const overrideName = useNodeStore.getState().tabOverrides[tab.id];
	try {
		await openTabWindow({
			path: tab.path,
			conversationId: tab.conversationId,
			node: overrideName,
			title: tab.title,
		});
		closeTab(tab.id);
	} catch {
		// Window creation failed — leave the tab in place rather than losing it.
	}
}

// Compact, icon-only chip for a pinned tab (Chrome-style — no title, no X).
function PinnedTab({ tab, isActive }: { tab: Tab; isActive: boolean }) {
	const { activateTab, closeTab, togglePin, openTab, tabs, unloadTab } =
		useTabsContext();
	const { isDragging, showBefore, showAfter, dragHandlers } = useTabDragProps(
		tab.id
	);
	return (
		<ContextMenu>
			<Tooltip>
				<ContextMenuTrigger
					render={
						<TooltipTrigger
							render={
								<button
									className={cn(
										"group/tab relative flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
										isActive ? "bg-muted" : "hover:bg-muted/50",
										tab.unloaded && "opacity-50",
										isDragging && "opacity-40"
									)}
									data-active={isActive}
									onClick={() => activateTab(tab.id)}
									onMouseDown={(e) => {
										if (e.button === 1) {
											e.preventDefault();
											closeTab(tab.id);
										}
									}}
									type="button"
									{...dragHandlers}
								>
									{showBefore && <DropIndicator side="left" />}
									{showAfter && <DropIndicator side="right" />}
									<TabGlyph
										className={cn(
											"size-3.5",
											isActive ? "text-foreground" : "text-muted-foreground"
										)}
										logoSize="14px"
										path={tab.path}
										unloaded={tab.unloaded}
									/>
								</button>
							}
						/>
					}
				/>
				<TooltipContent>{tab.title}</TooltipContent>
			</Tooltip>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => togglePin(tab.id)}>
					<HugeiconsIcon className="size-4" icon={PinOffIcon} />
					Unpin tab
				</ContextMenuItem>
				<ContextMenuItem
					disabled={isActive || tab.unloaded}
					onClick={() => unloadTab(tab.id)}
				>
					<HugeiconsIcon className="size-4" icon={ZzzIcon} />
					Unload tab
				</ContextMenuItem>
				<ContextMenuItem onClick={() => openTab(tab.path, { forceNew: true })}>
					<HugeiconsIcon className="size-4" icon={Copy01Icon} />
					Duplicate tab
				</ContextMenuItem>
				<ContextMenuItem onClick={() => moveTabToNewWindow(tab, closeTab)}>
					<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
					Open in new window
				</ContextMenuItem>
				<ContextMenuSeparator />
				<NodeSubmenu tabId={tab.id} />
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => closeTab(tab.id)}>
					<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					Close tab
				</ContextMenuItem>
				{bulkCloseItems(tab, tabs, closeTab)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

// Full chip for an unpinned tab (with title + hover-to-close), used both
// standalone and inside a group bracket.
function RegularTab({
	tab,
	isActive,
	inGroup,
}: {
	tab: Tab;
	isActive: boolean;
	inGroup: boolean;
}) {
	const {
		tabs,
		splits,
		activeTabId,
		activateTab,
		closeTab,
		openTab,
		restoreTab,
		hasClosedTabs,
		togglePin,
		unloadTab,
	} = useTabsContext();
	const { isDragging, showBefore, showAfter, dragHandlers } = useTabDragProps(
		tab.id
	);
	// A pane in the currently-visible split must not be unloadable — it's on
	// screen — so the Unload item is disabled for it.
	const activeSplit = findSplit(tabs, splits, activeTabId);
	const inActiveSplit = !!tab.splitId && tab.splitId === activeSplit?.id;
	const tabLayout = useTabLayout();
	const tabSizing = useTabSizing();
	const tabOverrideEnabled = useNodeTabOverride();
	const defaultNode = useNodeStore((s) => s.defaultNode);
	const overrideName = useNodeStore((s) => s.tabOverrides[tab.id]);
	// Only flag tabs pinned to a node other than the current default — a pin
	// matching the default is a no-op.
	const hasNodeOverride =
		tabOverrideEnabled && !!overrideName && overrideName !== defaultNode;
	// Active tabs inside a group use a lighter fill so they read against the
	// group's tinted bracket instead of clashing with it.
	const activeBg = inGroup ? "bg-background/70" : "bg-muted";

	return (
		<ContextMenu>
			{/* The sizing classes must live on the Trigger itself, since that's the
			    direct flex child of the strip; the inner pill just fills it (w-full).
			    "fit" = tabs hug their text (basis auto, no stretch, so no empty space
			    after short titles) but shrink to fit when crowded, floored at min-w so
			    they keep an icon before the strip scrolls. "fixed" = each tab keeps a
			    fixed width and the strip scrolls on overflow. */}
			<ContextMenuTrigger
				className={cn(
					"flex h-8 items-center",
					tabSizing === "fit"
						? "min-w-[2.5rem] max-w-[180px] shrink"
						: "max-w-[180px] shrink-0"
				)}
			>
				{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: custom drag/resize interaction */}
				<div
					className={cn(
						"group/tab relative flex h-8 w-full min-w-0 items-center rounded-full transition-colors",
						isActive ? activeBg : "hover:bg-muted/50",
						tab.unloaded && "opacity-60",
						isDragging && "opacity-40"
					)}
					data-active={isActive}
					onMouseDown={(e) => {
						if (e.button === 1) {
							e.preventDefault();
							closeTab(tab.id);
						}
					}}
					{...dragHandlers}
				>
					{showBefore && <DropIndicator side="left" />}
					{showAfter && <DropIndicator side="right" />}
					{/* Icon zone — page icon morphs to close X on tab hover */}
					<button
						aria-label={`Close ${tab.title}`}
						className={cn(
							"relative ml-2 flex size-4 shrink-0 items-center justify-center rounded-full",
							isActive ? "text-foreground/60" : "text-muted-foreground/50"
						)}
						onClick={() => closeTab(tab.id)}
						type="button"
					>
						<TabGlyph
							className="absolute size-3 transition-all duration-150 group-hover/tab:scale-50 group-hover/tab:opacity-0"
							logoSize="12px"
							path={tab.path}
							unloaded={tab.unloaded}
						/>
						<HugeiconsIcon
							className="absolute size-3 scale-50 opacity-0 transition-all duration-150 group-hover/tab:scale-100 group-hover/tab:opacity-100"
							icon={Cancel01Icon}
						/>
					</button>

					{/* Title — activates the tab (and reloads it if unloaded) */}
					<button
						className={cn(
							"flex h-full min-w-0 flex-1 items-center overflow-hidden pr-3 pl-1.5",
							isActive ? "text-foreground" : "text-muted-foreground"
						)}
						onClick={() => activateTab(tab.id)}
						type="button"
					>
						{hasNodeOverride && (
							<Tooltip>
								<TooltipTrigger
									render={
										<span
											aria-hidden
											className="mr-1.5 size-1.5 shrink-0 rounded-full bg-success"
										/>
									}
								/>
								<TooltipContent>
									Connected to {capitalize(overrideName)}
								</TooltipContent>
							</Tooltip>
						)}
						<OverflowTooltip
							className={cn(
								"min-w-0 overflow-hidden whitespace-nowrap font-medium text-xs leading-none",
								tab.unloaded && "italic"
							)}
							fade
							forceShow={tab.unloaded}
							text={tab.title}
							tooltip={
								tab.unloaded
									? `${tab.title} (unloaded — click to reload)`
									: undefined
							}
						/>
					</button>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem onClick={() => togglePin(tab.id)}>
					<HugeiconsIcon className="size-4" icon={PinIcon} />
					Pin tab
				</ContextMenuItem>
				<ContextMenuItem
					disabled={isActive || tab.unloaded || inActiveSplit}
					onClick={() => unloadTab(tab.id)}
				>
					<HugeiconsIcon className="size-4" icon={ZzzIcon} />
					Unload tab
				</ContextMenuItem>
				<GroupSubmenu tab={tab} />
				<SplitSubmenu tab={tab} />
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => openTab(tab.path, { forceNew: true })}>
					<HugeiconsIcon className="size-4" icon={Copy01Icon} />
					Duplicate tab
				</ContextMenuItem>
				<ContextMenuItem onClick={() => moveTabToNewWindow(tab, closeTab)}>
					<HugeiconsIcon className="size-4" icon={LinkSquare02Icon} />
					Open in new window
				</ContextMenuItem>
				<ContextMenuItem disabled={!hasClosedTabs} onClick={restoreTab}>
					<HugeiconsIcon className="size-4" icon={ArrowTurnBackwardIcon} />
					Restore closed tab
				</ContextMenuItem>
				{tabOverrideEnabled && (
					<>
						<ContextMenuSeparator />
						<NodeSubmenu tabId={tab.id} />
					</>
				)}
				<ContextMenuSeparator />
				<ContextMenuItem
					onClick={() =>
						setTabLayout(tabLayout === "vertical" ? "horizontal" : "vertical")
					}
				>
					<HugeiconsIcon
						className="size-4"
						icon={tabLayout === "vertical" ? SidebarTopIcon : SidebarLeftIcon}
					/>
					{tabLayout === "vertical"
						? "Use horizontal tabs"
						: "Use vertical tabs"}
				</ContextMenuItem>
				<ContextMenuItem onClick={() => closeTab(tab.id)}>
					<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					Close tab
				</ContextMenuItem>
				{bulkCloseItems(tab, tabs, closeTab)}
			</ContextMenuContent>
		</ContextMenu>
	);
}

// The colored pill that brackets a group — click to collapse/expand, right-click
// for rename/color/ungroup/close.
function GroupHeaderPill({ group }: { group: TabGroup }) {
	const {
		tabs,
		toggleGroupCollapsed,
		renameGroup,
		setGroupColor,
		ungroup,
		closeGroup,
	} = useTabsContext();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(group.name);
	const memberCount = tabs.filter((t) => t.groupId === group.id).length;
	const colors = GROUP_COLOR_CLASSES[group.color];

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next && next !== group.name) {
			renameGroup(group.id, next);
		} else {
			setDraft(group.name);
		}
	};

	if (editing) {
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: rename is an explicit user action
				autoFocus
				className={cn(
					"h-6 w-24 rounded-full px-2 font-medium text-xs outline-none ring-1",
					colors.pill,
					colors.container
				)}
				onBlur={commit}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						commit();
					} else if (e.key === "Escape") {
						setDraft(group.name);
						setEditing(false);
					}
				}}
				value={draft}
			/>
		);
	}

	return (
		<ContextMenu>
			<Tooltip>
				<ContextMenuTrigger
					render={
						<TooltipTrigger
							render={
								<button
									className={cn(
										"flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-medium text-xs transition-colors",
										colors.pill
									)}
									onClick={() => toggleGroupCollapsed(group.id)}
									type="button"
								>
									{group.name ? (
										<span className="max-w-[120px] truncate">{group.name}</span>
									) : (
										<span
											aria-hidden
											className={cn("size-2 rounded-full", colors.dot)}
										/>
									)}
									{group.collapsed && (
										<span className="opacity-70">{memberCount}</span>
									)}
								</button>
							}
						/>
					}
				/>
				<TooltipContent>
					{group.collapsed ? "Expand group" : "Collapse group"}
				</TooltipContent>
			</Tooltip>
			<ContextMenuContent>
				<ContextMenuItem
					onClick={() => {
						setDraft(group.name);
						setEditing(true);
					}}
				>
					<HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />
					Rename group
				</ContextMenuItem>
				<ContextMenuItem onClick={() => toggleGroupCollapsed(group.id)}>
					<HugeiconsIcon className="size-4" icon={UnfoldMoreIcon} />
					{group.collapsed ? "Expand group" : "Collapse group"}
				</ContextMenuItem>
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<span className="flex size-4 items-center justify-center">
							<span
								aria-hidden
								className={cn("size-2.5 rounded-full", colors.dot)}
							/>
						</span>
						Color
					</ContextMenuSubTrigger>
					<ContextMenuSubContent>
						<ContextMenuRadioGroup
							onValueChange={(value) =>
								setGroupColor(group.id, value as TabGroupColor)
							}
							value={group.color}
						>
							{TAB_GROUP_COLORS.map((c) => (
								<ContextMenuRadioItem key={c} value={c}>
									<span
										aria-hidden
										className={cn(
											"size-2.5 rounded-full",
											GROUP_COLOR_CLASSES[c].dot
										)}
									/>
									{COLOR_LABELS[c]}
								</ContextMenuRadioItem>
							))}
						</ContextMenuRadioGroup>
					</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => ungroup(group.id)}>
					<HugeiconsIcon className="size-4" icon={RowDeleteIcon} />
					Ungroup
				</ContextMenuItem>
				<ContextMenuItem onClick={() => closeGroup(group.id)}>
					<HugeiconsIcon className="size-4" icon={Cancel01Icon} />
					Close group
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

// The leading chip of a split bracket: a split glyph that opens a context menu to
// flip orientation or dissolve the split. `anyMemberId` is any tab in the split
// (unsplit/orientation resolve the split from it).
function SplitBracketHeader({
	split,
	anyMemberId,
}: {
	split: Split;
	anyMemberId: string;
}) {
	const { setSplitOrientation, unsplit } = useTabsContext();
	return (
		<ContextMenu>
			<Tooltip>
				<ContextMenuTrigger
					render={
						<TooltipTrigger
							render={
								<button
									className="flex h-6 shrink-0 items-center justify-center rounded-full px-1.5 text-primary/70 transition-colors hover:text-primary"
									type="button"
								>
									<HugeiconsIcon className="size-3.5" icon={GridIcon} />
								</button>
							}
						/>
					}
				/>
				<TooltipContent>Split view</TooltipContent>
			</Tooltip>
			<ContextMenuContent>
				<ContextMenuRadioGroup
					onValueChange={(value) =>
						setSplitOrientation(split.id, value as SplitOrientation)
					}
					value={split.orientation}
				>
					<ContextMenuRadioItem value="columns">
						Side by side
					</ContextMenuRadioItem>
					<ContextMenuRadioItem value="rows">Stacked</ContextMenuRadioItem>
				</ContextMenuRadioGroup>
				<ContextMenuSeparator />
				<ContextMenuItem onClick={() => unsplit(anyMemberId)}>
					<HugeiconsIcon className="size-4" icon={ArrowShrinkIcon} />
					Unsplit
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

// A contiguous run of unpinned tabs: a single ungrouped tab, a group bracket, or
// a split bracket — each with its members.
type Segment =
	| { type: "tab"; tab: Tab }
	| { type: "group"; group: TabGroup; members: Tab[] }
	| { type: "split"; split: Split; members: Tab[] };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
function buildSegments(
	unpinned: Tab[],
	groups: TabGroup[],
	splits: Split[]
): Segment[] {
	const segments: Segment[] = [];
	let i = 0;
	while (i < unpinned.length) {
		const tab = unpinned[i];
		if (tab.groupId) {
			const group = groups.find((g) => g.id === tab.groupId);
			const members: Tab[] = [];
			while (i < unpinned.length && unpinned[i].groupId === tab.groupId) {
				members.push(unpinned[i]);
				i += 1;
			}
			if (group) {
				segments.push({ type: "group", group, members });
			} else {
				for (const m of members) {
					segments.push({ type: "tab", tab: m });
				}
			}
		} else if (tab.splitId) {
			const split = splits.find((s) => s.id === tab.splitId);
			const members: Tab[] = [];
			while (i < unpinned.length && unpinned[i].splitId === tab.splitId) {
				members.push(unpinned[i]);
				i += 1;
			}
			if (split) {
				segments.push({ type: "split", split, members });
			} else {
				for (const m of members) {
					segments.push({ type: "tab", tab: m });
				}
			}
		} else {
			segments.push({ type: "tab", tab });
			i += 1;
		}
	}
	return segments;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
export function TitleBar() {
	const { open } = useSidebar();
	const { actions } = useTitleBarContext();
	const {
		tabs,
		groups,
		activeTabId,
		openTab,
		closeTab,
		restoreTab,
		hasClosedTabs,
		goBack,
		goForward,
		moveTab,
		splits,
		splitTabs,
		unsplit,
	} = useTabsContext();
	const scrollRef = useRef<HTMLDivElement>(null);
	// In vertical-tabs mode the open tabs live in the sidebar, so the horizontal
	// strip is hidden and a drag-region spacer takes its place.
	const tabLayout = useTabLayout();
	const tabSizing = useTabSizing();
	const [sidebarVariant] = useSidebarVariant();
	const floatingChromeOffset = sidebarVariant === "floating";

	const pinnedTabs = tabs.filter((t) => t.pinned);
	const unpinnedTabs = tabs.filter((t) => !t.pinned);
	const segments = buildSegments(unpinnedTabs, groups, splits);

	// The frosted scroll-under titlebar is used by the chat page, the empty
	// no-tab launchpad, and the store / marketplace family — all let their
	// content sit UNDER a continuous glass bar; every other page gets a solid bar
	// (see the blur/solid branch in the render below).
	const activePath = tabs.find((t) => t.id === activeTabId)?.path ?? "";
	const isChatActive =
		tabs.length === 0 || pathScrollsUnderTitlebar(activePath);

	// Drag-to-reorder state for the strip (provided to every tab chip below).
	const tabDnd = useTabReorder(tabs, moveTab);

	// The Tauri decorum titlebar fix lives in App.tsx now — it runs permanently
	// (a MutationObserver + window focus/resize) from the always-mounted root, so
	// decorum can never re-assert a full-width bar over this titlebar. The old
	// copy here was a 5s interval that left the titlebar dead after any later
	// revert; it was removed to keep a single source of truth.

	// Scroll newly-activated tab into view
	useEffect(() => {
		if (!scrollRef.current) {
			return;
		}
		const activeEl = scrollRef.current.querySelector(
			"[data-active='true']"
		) as HTMLElement | null;
		activeEl?.scrollIntoView({
			block: "nearest",
			inline: "nearest",
			behavior: "smooth",
		});
	}, []);

	// Translate vertical wheel into horizontal scroll for the tab strip, since
	// its scrollbar is hidden to keep the tabs aligned with the rest of the
	// titlebar. Trackpad horizontal gestures (deltaX) pass through untouched.
	const handleTabStripWheel = (e: WheelEvent<HTMLDivElement>) => {
		const el = scrollRef.current;
		if (!el || el.scrollWidth <= el.clientWidth) {
			return;
		}
		if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
			el.scrollLeft += e.deltaY;
		}
	};

	const handleNewTab = () => {
		openTab("/chat", { forceNew: true });
	};

	// Toggle a split on the active tab: if it's already split, collapse the split;
	// otherwise open a fresh chat beside it. Shared by the shortcut + strip menu.
	const toggleSplitActive = () => {
		if (!activeTabId) {
			return;
		}
		if (findSplit(tabs, splits, activeTabId)) {
			unsplit(activeTabId);
			return;
		}
		const id = openTab("/chat", { forceNew: true });
		splitTabs([activeTabId, id]);
	};

	// Tab, window, and navigation shortcuts route through the unified hotkey
	// system, so they are customizable in Settings → Keyboard Shortcuts and share
	// one dispatch listener with every other surface.
	useHotkey("tab.close", () => {
		if (activeTabId) {
			closeTab(activeTabId);
		}
	});
	useHotkey("tab.new", handleNewTab);
	useHotkey("tab.restore", restoreTab);
	useHotkey("tab.split-toggle", toggleSplitActive);
	useHotkey("nav.back", goBack);
	useHotkey("nav.forward", goForward);

	// Mouse buttons 3 (back) and 4 (forward) aren't keyboard chords, so they stay
	// a direct listener rather than going through the hotkey registry.
	useEffect(() => {
		const onMouseUp = (e: MouseEvent) => {
			if (e.button === 3) {
				e.preventDefault();
				goBack();
			} else if (e.button === 4) {
				e.preventDefault();
				goForward();
			}
		};
		window.addEventListener("mouseup", onMouseUp);
		return () => {
			window.removeEventListener("mouseup", onMouseUp);
		};
	}, [goBack, goForward]);

	return (
		<TabDndContext.Provider value={tabDnd}>
			<div
				// The bar lives inside the SidebarInset main area (m-2), so its
				// items naturally center at mt-2 + h-12/2 ≈ 30.7px from the window
				// top in inset mode. Floating mode has no SidebarInset margin, so add
				// the same 8px top offset to keep the tab row aligned with the sidebar
				// node selector and the fixed nav cluster (see Layout).
				className={cn(
					"absolute left-0 z-10 flex h-12 w-full items-center px-2",
					floatingChromeOffset ? "top-2" : "top-0"
				)}
				data-tauri-drag-region
			>
				{/* On the chat page the content scrolls UNDER the titlebar, so it gets
				    the frosted "liquid glass" gradient that blurs + fades whatever
				    scrolls beneath it. Every other page sits cleanly below the bar, so
				    it gets a plain solid background instead (no pointless blur over the
				    reserved gap). Both sit behind the z-10 controls.

				    The wrapper is pushed down by `top-2` in floating mode to align the
				    tab row, but the background layer must NOT move with it — it has to
				    keep starting at the true window top or an unblurred gap shows above
				    it. So in floating mode we cancel the wrapper's 8px offset (pull the
				    layer back up by 8px) and grow its height by the same 8px, keeping the
				    blur anchored at the window top with its fade ending where it did. */}
				{isChatActive ? (
					<ProgressiveBlur
						backgroundColor="var(--background)"
						blurAmount="12px"
						className={floatingChromeOffset ? "-top-2!" : ""}
						height={floatingChromeOffset ? "80px" : "72px"}
						position="top"
					/>
				) : (
					<div
						aria-hidden
						className={cn(
							"pointer-events-none absolute left-0 w-full bg-background",
							floatingChromeOffset ? "-top-2 h-14" : "top-0 h-12"
						)}
					/>
				)}
				<div
					className="relative z-10 flex w-full flex-row items-center gap-2"
					data-tauri-drag-region
				>
					{/* Back/forward + the sidebar toggle are pinned at the window's
					    top-left (fixed, in Layout) so the whole nav cluster survives
					    sidebar collapse and never eats tab-strip space. When the sidebar
					    is docked the cluster floats over the sidebar and the strip needs
					    no offset. When collapsed the titlebar spans the full window, so
					    reserve room on the left for the cluster (and, on macOS, the
					    traffic lights). */}
					{!open && (
						<div
							aria-hidden
							className={cn("shrink-0", isMac ? "w-48" : "w-40")}
							data-tauri-drag-region
						/>
					)}

					{/* Tab strip — scrollable, fills remaining space. Hidden in
					    vertical-tabs mode, where the sidebar's Tabs section owns it. */}
					{tabLayout === "vertical" ? (
						<div className="min-w-0 flex-1" data-tauri-drag-region />
					) : (
						<ContextMenu>
							<ContextMenuTrigger
								className="flex min-w-0 flex-1 items-center"
								data-tauri-drag-region
							>
								{/* Wrapper sizes to content but is capped at the available width
								    (max-w 100%). So the + button follows the last tab while they
								    fit, and once the tabs' total content would exceed the bar the
								    wrapper caps at 100% — in "fit" mode the shrinkable tabs then
								    trim to fit, in "fixed" mode they keep size and the strip
								    scrolls. */}
								<div
									className="flex min-w-0 items-center"
									style={{ flex: "0 1 max-content", maxWidth: "100%" }}
								>
									{/* Fixed h-8 clip wrapper: the inner strip is allowed to grow
								    taller than h-8 (via pb-8) so the horizontal scrollbar renders
								    in the bottom padding band, BELOW the 32px visible row, and is
								    then clipped away by this overflow-hidden box. That keeps the
								    scrollbar from ever reserving space inside the tab row and
								    squashing the tabs (a WebView2 quirk hiding alone didn't fully
								    cure). items-start so the inner box isn't stretched, so its
								    align-items:center then centers the tabs in the unpadded 32px
								    content box, leaving the padding band (and its scrollbar) below.
								    Overflow is also reached via the wheel handler + scrollIntoView. */}
									<div className="flex h-8 min-w-0 flex-1 items-start overflow-hidden">
										<div
											className="group/tabstrip flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden pb-8 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
											data-tauri-drag-region={false}
											onWheel={handleTabStripWheel}
											ref={scrollRef}
										>
											{/* Pinned tabs lead, as compact icon-only chips */}
											{pinnedTabs.map((tab) => (
												<PinnedTab
													isActive={tab.id === activeTabId}
													key={tab.id}
													tab={tab}
												/>
											))}

											{/* Then ungrouped tabs, group brackets, and split brackets */}
											{segments.map((seg) => {
												if (seg.type === "tab") {
													return (
														<RegularTab
															inGroup={false}
															isActive={seg.tab.id === activeTabId}
															key={seg.tab.id}
															tab={seg.tab}
														/>
													);
												}
												if (seg.type === "split") {
													return (
														<div
															className="flex shrink-0 items-center gap-1 rounded-2xl bg-primary/5 px-1 py-0.5 ring-1 ring-primary/30"
															key={seg.split.id}
														>
															<SplitBracketHeader
																anyMemberId={seg.members[0]?.id ?? ""}
																split={seg.split}
															/>
															{seg.members.map((tab) => (
																<RegularTab
																	inGroup
																	isActive={tab.id === activeTabId}
																	key={tab.id}
																	tab={tab}
																/>
															))}
														</div>
													);
												}
												const colors = GROUP_COLOR_CLASSES[seg.group.color];
												return (
													<div
														className={cn(
															"flex shrink-0 items-center gap-1 rounded-2xl px-1 py-0.5 ring-1",
															colors.container
														)}
														key={seg.group.id}
													>
														<GroupHeaderPill group={seg.group} />
														{!seg.group.collapsed &&
															seg.members.map((tab) => (
																<RegularTab
																	inGroup
																	isActive={tab.id === activeTabId}
																	key={tab.id}
																	tab={tab}
																/>
															))}
													</div>
												);
											})}
										</div>
									</div>

									{/* New tab button — outside the scroll container, always visible */}
									<button
										aria-label="New chat tab"
										className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground/50 transition-colors hover:bg-background/50 hover:text-muted-foreground"
										data-tauri-drag-region={false}
										onClick={handleNewTab}
										type="button"
									>
										<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
									</button>
								</div>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem onClick={handleNewTab}>
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
									New tab
								</ContextMenuItem>
								<ContextMenuItem disabled={!hasClosedTabs} onClick={restoreTab}>
									<HugeiconsIcon
										className="size-4"
										icon={ArrowTurnBackwardIcon}
									/>
									Restore closed tab
								</ContextMenuItem>
								<ContextMenuSeparator />
								<ContextMenuItem
									disabled={!activeTabId}
									onClick={toggleSplitActive}
								>
									<HugeiconsIcon className="size-4" icon={GridIcon} />
									{activeTabId && findSplit(tabs, splits, activeTabId)
										? "Unsplit active tab"
										: "Split active tab"}
								</ContextMenuItem>
								<ContextMenuItem
									onClick={() =>
										setTabSizing(tabSizing === "fit" ? "fixed" : "fit")
									}
								>
									<HugeiconsIcon
										className="size-4"
										icon={
											tabSizing === "fit" ? UnfoldMoreIcon : ArrowShrinkIcon
										}
									/>
									{tabSizing === "fit"
										? "Use fixed-width tabs"
										: "Fit tabs to width"}
								</ContextMenuItem>
								{/* The strip only renders in horizontal mode, so this always
							    switches to vertical. */}
								<ContextMenuItem onClick={() => setTabLayout("vertical")}>
									<HugeiconsIcon className="size-4" icon={SidebarLeftIcon} />
									Use vertical tabs
								</ContextMenuItem>
								<ContextMenuSeparator />
								<ContextMenuItem
									disabled={tabs.findIndex((t) => t.id === activeTabId) === 0}
									onClick={() => {
										const idx = tabs.findIndex((t) => t.id === activeTabId);
										for (const t of tabs.slice(0, idx)) {
											if (!t.pinned) {
												closeTab(t.id);
											}
										}
									}}
								>
									<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
									Close tabs to the left
								</ContextMenuItem>
								<ContextMenuItem
									disabled={
										tabs.findIndex((t) => t.id === activeTabId) ===
										tabs.length - 1
									}
									onClick={() => {
										const idx = tabs.findIndex((t) => t.id === activeTabId);
										for (const t of tabs.slice(idx + 1)) {
											if (!t.pinned) {
												closeTab(t.id);
											}
										}
									}}
								>
									<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
									Close tabs to the right
								</ContextMenuItem>
								<ContextMenuSeparator />
								<ContextMenuItem
									disabled={tabs.length === 0}
									onClick={() => {
										for (const t of [...tabs]) {
											closeTab(t.id);
										}
									}}
								>
									<HugeiconsIcon className="size-4" icon={Delete02Icon} />
									Close all tabs
								</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					)}

					{/* Spacer so actions hug the right edge */}
					<div
						className="flex-shrink-0 flex-grow-0"
						data-tauri-drag-region
						style={{ minWidth: 0 }}
					/>

					{/* Right-side page actions — offset clears Windows titlebar buttons */}
					{actions && (
						<div
							className={cn(
								"ryu-chrome-shadow relative inset-shadow-sm z-50 flex shrink-0 flex-row items-center gap-1 rounded-2xl bg-background/50 px-1 shadow-lg ring-1 ring-black/5 dark:ring-white/10",
								// Windows caption buttons (min/max/close) sit at the top-right;
								// give the page actions wide clearance so they never crowd them.
								// macOS keeps its controls on the left, so only a small inset.
								isMac ? "mr-2" : "mr-48"
							)}
							data-tauri-drag-region={false}
						>
							{actions}
						</div>
					)}
				</div>
			</div>
		</TabDndContext.Provider>
	);
}
