import {
	Activity01Icon,
	Add01Icon,
	ArrowLeft01Icon,
	ArrowRight01Icon,
	ArrowShrink02Icon,
	ArrowShrinkIcon,
	ArrowTurnBackwardIcon,
	AudioWave01Icon,
	Calendar04Icon,
	Cancel01Icon,
	Chat01Icon,
	CheckmarkBadge02Icon,
	Copy01Icon,
	Delete02Icon,
	DeliverySecure01Icon,
	Download01Icon,
	FingerPrintIcon,
	Folder01Icon,
	FullScreenIcon,
	GitBranchIcon,
	GridIcon,
	InboxIcon,
	LibraryIcon,
	Message01Icon,
	PackageIcon,
	PencilEdit01Icon,
	PieChartIcon,
	PinIcon,
	PinOffIcon,
	PotionIcon,
	Pulse01Icon,
	RowDeleteIcon,
	ServerStack01Icon,
	Settings01Icon,
	ShieldKeyIcon,
	SidebarRightIcon,
	SidebarTopIcon,
	Tag01Icon,
	Target01Icon,
	Tv01Icon,
	UnfoldMoreIcon,
	WorkflowCircle06Icon,
	ZzzIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useHotkey } from "@ryu/hotkeys/react";
import {
	ContextMenu,
	ContextMenuCheckboxItem,
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
import { EdgeScrollChevrons } from "@ryu/ui/components/edge-scroller.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { ProgressiveBlur } from "@ryu/ui/components/progressive-blur";
import { useSidebar } from "@ryu/ui/components/sidebar";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils";
import {
	type DragEvent,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type WheelEvent,
} from "react";
import { openTabWindow } from "@/lib/tauri-bridge.ts";
import {
	TabBarAppearanceMenuItems,
	TabLayoutMenuItems,
} from "@/src/components/layout/appearance-context-menu.tsx";
import { MorphingTabSurface } from "@/src/components/layout/MorphingTabSurface.tsx";
import { TabDropdown } from "@/src/components/layout/tab-dropdown.tsx";
import { TabSearchDialog } from "@/src/components/layout/tab-search-dialog.tsx";
import { isDockableRoutePath } from "@/src/components/panels/dock-panels.ts";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type {
	ShellRoute,
	Split,
	SplitOrientation,
	Tab,
	TabGroup,
	TabGroupColor,
} from "@/src/contexts/TabsContext.tsx";
import {
	findSplit,
	shellRoute,
	TAB_GROUP_COLORS,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useTitleBarContext } from "@/src/contexts/TitleBarContext.tsx";
import {
	resolveTabIcon,
	subscribeTabIcons,
} from "@/src/contributions/tab-icon-registry.ts";
import { useAutoHideTitleBar } from "@/src/hooks/useAutoHideTitleBar.ts";
import { useFloatingTabs } from "@/src/hooks/useFloatingTabs.ts";
import { useMouseNavigationButtons } from "@/src/hooks/useMouseNavigationButtons.ts";
import { useNodeTabOverride } from "@/src/hooks/useNodeDisplayMode.ts";
import { useActiveSeason } from "@/src/hooks/useSeasonalEffects.ts";
import { useSidebarVariant } from "@/src/hooks/useSidebarVariant.ts";
import { useTabCycleHotkeys } from "@/src/hooks/useTabCycleHotkeys.ts";
import { useTabDropdown } from "@/src/hooks/useTabDropdown.ts";
import { setTabLayout, useTabLayout } from "@/src/hooks/useTabLayout.ts";
import { useTabSearchButton } from "@/src/hooks/useTabSearchButton.ts";
import { setTabSizing, useTabSizing } from "@/src/hooks/useTabSizing.ts";
import { setTitlebarHidden } from "@/src/lib/decorumTitlebar.ts";
import { toggleFullscreen, useFullscreen } from "@/src/lib/fullscreen.ts";
import { conversationEntityKey } from "@/src/lib/window-routing.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { useSidePanelRouteStore } from "@/src/store/useSidePanelRouteStore.ts";
import { OpenInNewWindowContextMenuItem } from "./OpenInNewWindowMenuItem.tsx";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { SeasonalParticles } from "./SeasonalEffects.tsx";
import { SplitPresetMenuItems } from "./SplitPresetMenu.tsx";
import { TabEntityMenuSection } from "./tab-entity-menu.tsx";
import { TabRenameInput, useTabRename } from "./tab-rename.tsx";
import { useTabDnd, useTabDragProps } from "./tabDnd.tsx";
import { pathScrollsUnderTitlebar } from "./titlebarScroll.ts";

// Radio value used for the "follow the default node" choice in the per-tab node
// picker, distinct from any real node name.
const DEFAULT_NODE_VALUE = "__default__";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The vertical bar drawn in the gap beside the hovered tab to preview where the
// dragged tab will land. The host element must be `relative`.
function DropIndicator({ side }: { side: "left" | "right" }) {
	return (
		<span
			aria-hidden
			className={cn(
				"reorder-drop-indicator pointer-events-none absolute inset-y-1 z-20 w-0.5 bg-primary",
				side === "left" ? "-left-1" : "-right-1"
			)}
		/>
	);
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

// Tab icons for the routes that are their own page — the glyph half of
// `PATH_TITLES` in TabsContext. The two multi-section shells (the Library and
// the Customize store) do NOT take their glyph from here: every route in a
// shell is one page, so `pathIcon` answers all of them from `SHELL_ICONS` below
// before this map is consulted. A per-section key added back would be dead for
// that route and would re-state the mistake it encodes — the shell's one name
// under a section's icon, the "keeps the sidebar entry's icon" half of the bug
// this seam closes.
//
// Some keys below are bare routes that are THEMSELVES shell routes. They are
// unreachable for their own path (the family branch answers first) and stay
// only for their DETAIL subpaths — separate pages that reach a glyph through
// `pathIcon`'s leading-segment fallback, so deleting the alias would silently
// drop every one of them to the chat icon. Exactly six such subpath families
// exist (`/agents/:id/edit`, `/channels/:id`, `/identities/profile/:id`,
// `/skills/:id/edit`, `/spaces/:id` + its doc/db/wb/app variants,
// `/workflows/:id`), so exactly six aliases are kept. The rest — `/apps`,
// `/engines`, `/extensions`, `/fleet`, `/models`, `/tools` — have no subpath
// route in `builtins.ts` and were deleted rather than left as rows nothing can
// read; re-add one only together with the route that reaches it.
// Each glyph mirrors the matching sidebar entry (AppSidebar's SECTION_ICONS +
// the NavTabButton chrome) so a page's tab and its sidebar row read as the same
// thing.
const PATH_ICONS: Record<string, IconSvgElement> = {
	// No Home/dashboard entry: that page's path is declared by `@ryu/dashboards`
	// (`contributes.sidebar_buttons[].target`), and its tab icon comes from the same
	// contribution via `usePluginContributionTabIcons` — which `resolveTabIcon`
	// consults before this map. A path key here would go stale the moment the app
	// moved itself.
	"/chat": Chat01Icon,
	// Bare `/agents` is a Library route now (TabsContext's `LIBRARY_ALIAS_PATHS`),
	// so this row is read only for the agent routes UNDER it: the explicit
	// agent-edit branch in `pathIcon`, plus any other `/agents/*` deep link that
	// lands on the leading-segment fallback.
	"/agents": Target01Icon,
	"/channels": Tv01Icon,
	"/identities": FingerPrintIcon,
	"/identities/new": FingerPrintIcon,
	"/skills": PotionIcon,
	"/spaces": DeliverySecure01Icon,
	"/meetings": AudioWave01Icon,
	"/workflows": WorkflowCircle06Icon,
	"/workflows/build": WorkflowCircle06Icon,
	"/quests": CheckmarkBadge02Icon,
	"/timeline": Activity01Icon,
	"/review": PieChartIcon,
	"/activity": Pulse01Icon,
	"/calendar": Calendar04Icon,
	"/inbox": InboxIcon,
	"/approvals": InboxIcon,
	"/downloads": Download01Icon,
	"/project": GitBranchIcon,
	"/settings": Settings01Icon,
	"/vault": ShieldKeyIcon,
};

/** One glyph per multi-section shell, the exact counterpart of the one title
    `shellRoute` hands back. The Library book is the sidebar's own Library
    chrome; `PackageIcon` is the `store` NavTabButton's Customize glyph. Keyed
    off the SHELL, never the section, because a tab that names the page must not
    change its icon when the user switches section inside it. */
const SHELL_ICONS: Record<ShellRoute["family"], IconSvgElement> = {
	library: LibraryIcon,
	store: PackageIcon,
};

const AGENT_EDIT_PATH_RE = /^\/agents\/.+\/edit$/;

function pathIcon(path: string): IconSvgElement {
	const base = path.split("?")[0];
	// Agent edit paths (/agents/:id/edit) share the agents icon.
	if (AGENT_EDIT_PATH_RE.test(base)) {
		return PATH_ICONS["/agents"];
	}
	// A shell route takes its family's glyph, before any per-path lookup: every
	// section of the Library / the Customize store is the same page under the
	// same name, so it must also be the same icon. Keying the glyph on the
	// section instead is what let one tab read "Library" under a wrench, and —
	// since the tab now switches its own path as the user moves through the
	// family — made a single tab's glyph mutate while its name stood still.
	const shell = shellRoute(base);
	if (shell) {
		return SHELL_ICONS[shell.family];
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

// The agent editor uses the static Ryu ghost logo instead of a HugeIcons glyph;
// every other tab keeps its path icon. Unloaded tabs always show Zzz regardless.
//
// Bare `/agents` is NOT one of them any more: it mounts the same LibraryPage
// section as `/library/agent`, so it is a Library route (TabsContext's
// `LIBRARY_ALIAS_PATHS`) and one tab now carries the whole family. Painting the
// ghost on it would make that single tab flicker logo↔book as the user switched
// section, under a name ("Library") that never changed.
function isAgentsTab(path: string): boolean {
	return AGENT_EDIT_PATH_RE.test(path.split("?")[0]);
}

// Renders a tab's leading glyph: spinner while busy; an entity GlyphValue when
// set (chat / space / page / agent / meeting / plugin — same as the sidebar);
// else an app-registered Iconify/Hugeicons id from the tab-icon registry
// (manifest contributions + `shell.registerTabIcon`), UNLESS the tab sits on a
// shell route; else the static Ryu logo for the agent editor; else the path's
// Hugeicons icon (or Zzz when unloaded).
export function TabGlyph({
	path,
	icon,
	unloaded,
	busy,
	busySpeed,
	className,
	logoSize,
}: {
	path: string;
	icon?: GlyphValue;
	unloaded?: boolean;
	busy?: boolean;
	busySpeed?: "slow" | "normal" | "fast";
	className?: string;
	logoSize: string;
}) {
	// Re-render when apps register/unregister default path icons.
	useSyncExternalStore(
		subscribeTabIcons,
		() => resolveTabIcon(path) ?? "",
		() => ""
	);
	// A registered rule may NOT repaint a shell route: `resolveTabIcon` matches by
	// path PREFIX, and Core's own `builtin:spaces` rule (`pathPrefix: "/spaces"`)
	// therefore covers bare `/spaces` — a Library alias. Without this guard the
	// one Library tab would still swap its glyph book↔vault as the user moved
	// between the Spaces section and any other, under a name that never changes:
	// the section-keyed icon this seam removes, re-entering through the registry.
	// Only the exact shell routes are exempt; the DETAIL pages underneath
	// (`/spaces/:id`, a companion's own path) are separate pages and keep theirs.
	const registeredIcon = shellRoute(path) ? undefined : resolveTabIcon(path);

	if (busy && !unloaded) {
		return (
			<Spinner
				aria-label="In progress"
				className={className}
				speed={busySpeed}
			/>
		);
	}
	if (!unloaded && icon) {
		const parsed = Number.parseInt(logoSize, 10);
		const px = Number.isNaN(parsed) ? 14 : parsed;
		return (
			<span
				className={cn(
					"inline-flex shrink-0 items-center justify-center",
					className
				)}
			>
				<GlyphDisplay fallback={null} size={px} value={icon} />
			</span>
		);
	}
	if (!unloaded && registeredIcon) {
		const parsed = Number.parseInt(logoSize, 10);
		const px = Number.isNaN(parsed) ? 14 : parsed;
		return (
			<span
				className={cn(
					"inline-flex shrink-0 items-center justify-center",
					className
				)}
			>
				<Icon className="size-full" icon={registeredIcon} size={px} />
			</span>
		);
	}
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

/** True when a chat tab should show the in-progress spinner/shimmer. */
export function useTabBusy(tab: Tab): boolean {
	const { getConversation } = useChatHistoryContext();
	if (tab.busy) {
		return true;
	}
	if (!(tab.path === "/chat" && tab.conversationId)) {
		return false;
	}
	return getConversation(tab.conversationId)?.runStatus === "running";
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
		addTabToSplit,
		removeFromSplit,
		unsplit,
		setSplitOrientation,
	} = useTabsContext();
	const split = findSplit(tabs, splits, tab.id);
	// Tabs that can join a split: not this tab, not pinned, not already split.
	const candidates = tabs.filter(
		(t) => t.id !== tab.id && !t.pinned && !t.splitId
	);

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
							value={split.root.orientation}
						>
							<ContextMenuRadioItem value="columns">
								Side by side
							</ContextMenuRadioItem>
							<ContextMenuRadioItem value="rows">Stacked</ContextMenuRadioItem>
						</ContextMenuRadioGroup>
						<ContextMenuSeparator />
						<SplitPresetMenuItems split={split} />
						<ContextMenuSeparator />
						{/* Grow the split to 3+ panes: the new pane joins at the end of
						    the root run, keeping any nested arrangement intact. */}
						<ContextMenuItem
							onClick={() => {
								const id = openTab("/chat", { forceNew: true });
								addTabToSplit(split.id, id);
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
											onClick={() => addTabToSplit(split.id, c.id)}
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
						<ContextMenuSeparator />
						{/* Applying a preset from an unsplit tab lays the shape out over
						    fresh panes; there is no layout here yet to save. */}
						<SplitPresetMenuItems split={null} />
					</>
				)}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

/**
 * "Open in side panel" — show what this tab is showing in the workspace's right
 * dock instead of (or as well as) a window tab.
 *
 * The dock lives inside the chat surface, so the page lands in the focused chat's
 * right panel; when the current tab is not a chat, the request is held until a
 * chat tab is next focused rather than being dropped.
 *
 * This is the USER-initiated half of the seam and so passes a raw path
 * (`openPath`); the system-/agent-facing half selects a page KEY from the shared
 * allowlist instead — see `useSidePanelRouteStore`.
 */
function OpenInSidePanelItem({ tab }: { tab: Tab }) {
	const openPath = useSidePanelRouteStore((s) => s.openPath);
	const { tabs, activeTabId } = useTabsContext();
	if (!isDockableRoutePath(tab.path)) {
		return null;
	}
	// The dock lives inside the chat surface, so a request raised from a non-chat
	// tab is HELD until a chat tab is next focused. Held is the right behaviour
	// (better than dropping it), but silently held is not: the click would look
	// dead now and produce a page appearing from nowhere later. Say where it went.
	const focused = tabs.find((t) => t.id === activeTabId);
	const dockIsLive = focused?.path.startsWith("/chat") ?? false;
	return (
		<ContextMenuItem
			onClick={() => {
				openPath(tab.path, tab.title);
				if (!dockIsLive) {
					toast.info("Queued for the side panel", {
						description: "It opens when you switch to a chat tab.",
					});
				}
			}}
		>
			<HugeiconsIcon className="size-4" icon={SidebarRightIcon} />
			Open in side panel
		</ContextMenuItem>
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

// Open a tab in its own OS window. The conversation lives server-side, so the
// spawned window re-fetches it by id; we carry the tab's node binding so a
// remote-targeted chat keeps its node. This is intentionally a non-destructive
// copy: a native window can be constructed before its renderer is ready, so a
// true move must wait for a destination-ready handshake (the future drag-out
// path) before closing the source tab.
async function openTabInNewWindow(tab: Tab) {
	const overrideName = useNodeStore.getState().tabOverrides[tab.id];
	try {
		await openTabWindow({
			entityKey: tab.conversationId
				? conversationEntityKey(tab.conversationId)
				: undefined,
			path: tab.path,
			conversationId: tab.conversationId,
			node: overrideName,
			title: tab.title,
		});
	} catch {
		// Window creation failed — the source tab remains the owner.
	}
}

// Compact, icon-only chip for a pinned tab (Chrome-style — no title, no X).
function PinnedTab({ tab, isActive }: { tab: Tab; isActive: boolean }) {
	const { activateTab, closeTab, togglePin, openTab, tabs, unloadTab } =
		useTabsContext();
	const [floatingTabs] = useFloatingTabs();
	const tabLayout = useTabLayout();
	const { isDragging, showBefore, showAfter, dragHandlers } = useTabDragProps(
		tab.id
	);
	const busy = useTabBusy(tab);
	return (
		<ContextMenu>
			<Tooltip>
				<ContextMenuTrigger
					render={
						<TooltipTrigger
							render={
								<button
									className={cn(
										"group/tab relative isolate flex size-8 shrink-0 items-center justify-center transition-colors",
										floatingTabs
											? cn(
													"rounded-full",
													isActive ? "bg-muted" : "hover:bg-muted/50"
												)
											: cn(
													"rounded-t-[12px]",
													isActive
														? "text-foreground"
														: "hover:bg-background/40"
												),
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
									<MorphingTabSurface
										floatingTabs={floatingTabs}
										isActive={isActive}
									/>
									{showBefore && <DropIndicator side="left" />}
									{showAfter && <DropIndicator side="right" />}
									<TabGlyph
										busy={busy}
										busySpeed={tab.busySpeed}
										className={cn(
											"relative z-10 size-3.5",
											isActive ? "text-foreground" : "text-muted-foreground"
										)}
										icon={tab.icon}
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
				{/* Same entity section the regular pill gets — a pinned tab is still
				    showing a chat/space/agent, so the verbs for it belong here too. */}
				<TabEntityMenuSection tab={tab} />
				<ContextMenuSeparator />
				<ContextMenuItem
					onClick={() =>
						openTab(tab.path, {
							conversationId: tab.conversationId,
							forceNew: true,
							icon: tab.icon,
							title: tab.title,
						})
					}
				>
					<HugeiconsIcon className="size-4" icon={Copy01Icon} />
					Duplicate tab
				</ContextMenuItem>
				<OpenInNewWindowContextMenuItem
					iconClassName="size-4"
					onClick={() => openTabInNewWindow(tab)}
				/>
				<OpenInSidePanelItem tab={tab} />
				<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
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
	const [floatingTabs] = useFloatingTabs();
	const { isDragging, showBefore, showAfter, dragHandlers } = useTabDragProps(
		tab.id
	);
	const busy = useTabBusy(tab);
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
	const {
		isEditing,
		canRename,
		startEditing,
		commitEditing,
		cancelEditing,
		draft,
		setDraft,
	} = useTabRename(tab);
	const titleContent = (
		<>
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
			{/* One label in both states: a streaming title shimmers on the
			    SAME clipped line, so an over-long busy title dissolves at the
			    edge exactly like a resting one instead of losing the fade. */}
			<OverflowTooltip
				className={cn(
					"min-w-0 overflow-hidden whitespace-nowrap font-medium text-xs leading-none",
					tab.unloaded && "italic"
				)}
				fade
				forceShow={tab.unloaded}
				shimmer={busy && !tab.unloaded}
				text={tab.title}
				tooltip={
					tab.unloaded ? `${tab.title} (unloaded — click to reload)` : undefined
				}
			/>
		</>
	);

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
						"group/tab relative flex h-8 w-full min-w-0 items-center transition-colors",
						floatingTabs
							? cn("rounded-full", isActive ? activeBg : "hover:bg-muted/50")
							: cn(
									"rounded-t-[12px]",
									isActive ? "text-foreground" : "hover:bg-background/40"
								),
						tab.unloaded && "opacity-60",
						isDragging && "opacity-40"
					)}
					data-active={isActive}
					data-tab-appearance={floatingTabs ? "floating" : "morphing"}
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
					<MorphingTabSurface floatingTabs={floatingTabs} isActive={isActive} />
					{/* Icon zone — page icon morphs to close X on tab hover */}
					<button
						aria-label={`Close ${tab.title}`}
						className={cn(
							"relative z-10 ml-2 flex size-4 shrink-0 items-center justify-center rounded-full",
							isActive ? "text-foreground/60" : "text-muted-foreground/50"
						)}
						onClick={() => closeTab(tab.id)}
						type="button"
					>
						<TabGlyph
							busy={busy}
							busySpeed={tab.busySpeed}
							className="absolute size-3 transition-all duration-150 group-hover/tab:scale-50 group-hover/tab:opacity-0"
							icon={tab.icon}
							logoSize="12px"
							path={tab.path}
							unloaded={tab.unloaded}
						/>
						<HugeiconsIcon
							className="absolute size-3 scale-50 opacity-0 transition-all duration-150 group-hover/tab:scale-100 group-hover/tab:opacity-100"
							icon={Cancel01Icon}
						/>
					</button>

					{/* Title — activates the tab (and reloads it if unloaded); a
					    double-click starts an inline rename for a renamable tab. The
					    editor is a sibling of the activation button so the input is
					    never nested in a native interactive element. */}
					{isEditing ? (
						<div
							className={cn(
								"relative z-10 flex h-full min-w-0 flex-1 items-center overflow-hidden pr-3 pl-1.5",
								isActive ? "text-foreground" : "text-muted-foreground"
							)}
						>
							<TabRenameInput
								className="text-xs leading-none"
								onCancel={cancelEditing}
								onChange={setDraft}
								onCommit={commitEditing}
								value={draft}
							/>
						</div>
					) : (
						<button
							className={cn(
								"relative z-10 flex h-full min-w-0 flex-1 items-center overflow-hidden pr-3 pl-1.5",
								isActive ? "text-foreground" : "text-muted-foreground"
							)}
							onClick={() => activateTab(tab.id)}
							onDoubleClick={canRename ? startEditing : undefined}
							type="button"
						>
							{titleContent}
						</button>
					)}
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
				{/* Verbs for the thing the tab is SHOWING (the chat, the space, …) —
				    shell flags plus whatever apps anchor to it. Copy transcript lives
				    there now rather than being a hardcoded chat-only row here. */}
				<TabEntityMenuSection tab={tab} />
				<ContextMenuSeparator />
				<ContextMenuItem
					onClick={() =>
						openTab(tab.path, {
							conversationId: tab.conversationId,
							forceNew: true,
							icon: tab.icon,
							title: tab.title,
						})
					}
				>
					<HugeiconsIcon className="size-4" icon={Copy01Icon} />
					Duplicate tab
				</ContextMenuItem>
				<OpenInNewWindowContextMenuItem
					iconClassName="size-4"
					onClick={() => openTabInNewWindow(tab)}
				/>
				<OpenInSidePanelItem tab={tab} />
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
				<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
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

// The leading chip of a split bracket: a split glyph that opens a context menu
// to flip orientation or dissolve the split, and a drop target — dragging any
// other tab onto it joins that tab to the split as a new pane. `anyMemberId`
// is any tab in the split (unsplit/orientation resolve the split from it).
function SplitBracketHeader({
	split,
	anyMemberId,
}: {
	split: Split;
	anyMemberId: string;
}) {
	const { tabs, setSplitOrientation, unsplit, addTabToSplit } =
		useTabsContext();
	const dnd = useTabDnd();
	const [joinHover, setJoinHover] = useState(false);
	// Any dragged tab that isn't already a member can join by dropping here.
	const canJoin =
		!!dnd.draggingId &&
		tabs.find((t) => t.id === dnd.draggingId)?.splitId !== split.id;
	return (
		<ContextMenu>
			<Tooltip>
				<ContextMenuTrigger
					render={
						<TooltipTrigger
							render={
								<button
									className={cn(
										"flex h-6 shrink-0 items-center justify-center rounded-full px-1.5 text-muted-foreground/70 transition-colors hover:text-muted-foreground",
										joinHover && "bg-muted/50 text-muted-foreground"
									)}
									onDragLeave={() => setJoinHover(false)}
									onDragOver={(e: DragEvent) => {
										if (!canJoin) {
											return;
										}
										e.preventDefault();
										e.stopPropagation();
										e.dataTransfer.dropEffect = "move";
										setJoinHover(true);
									}}
									onDrop={(e: DragEvent) => {
										setJoinHover(false);
										if (!(canJoin && dnd.draggingId)) {
											return;
										}
										e.preventDefault();
										e.stopPropagation();
										addTabToSplit(split.id, dnd.draggingId);
										dnd.onEnd();
									}}
									type="button"
								>
									<HugeiconsIcon className="size-3.5" icon={Folder01Icon} />
								</button>
							}
						/>
					}
				/>
				<TooltipContent>
					{canJoin ? "Drop to add to split" : "Split view"}
				</TooltipContent>
			</Tooltip>
			<ContextMenuContent>
				<ContextMenuRadioGroup
					onValueChange={(value) =>
						setSplitOrientation(split.id, value as SplitOrientation)
					}
					value={split.root.orientation}
				>
					<ContextMenuRadioItem value="columns">
						Side by side
					</ContextMenuRadioItem>
					<ContextMenuRadioItem value="rows">Stacked</ContextMenuRadioItem>
				</ContextMenuRadioGroup>
				<ContextMenuSeparator />
				<SplitPresetMenuItems split={split} />
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
interface TitleBarProps {
	navClusterReserve: string;
	pageActionsMargin: string;
}

export function TitleBar({
	navClusterReserve,
	pageActionsMargin,
}: TitleBarProps) {
	const { open } = useSidebar();
	const activeSeason = useActiveSeason();
	// At phone widths the sidebar is never docked, so the strip always has to
	// leave room for the fixed nav cluster (see Layout) — but only for the two
	// buttons it keeps there, not the full desktop four-button + traffic-light
	// reservation.
	const isMobile = useIsMobile();
	const { actions } = useTitleBarContext();
	const {
		activateTab,
		tabs,
		groups,
		activeTabId,
		openTab,
		closeTab,
		restoreTab,
		hasClosedTabs,
		goBack,
		goForward,
		splits,
		splitTabs,
		unsplit,
	} = useTabsContext();
	const scrollRef = useRef<HTMLDivElement>(null);
	// Only the compact horizontal mode owns a title-bar tab strip. Vertical tabs
	// move the list into the sidebar; scroll and canvas modes own the live center
	// surface and leave a drag-region spacer here.
	const tabLayout = useTabLayout();
	const tabSizing = useTabSizing();
	const [tabDropdownEnabled, setTabDropdownEnabled] = useTabDropdown();
	const [floatingTabs, setFloatingTabs] = useFloatingTabs();
	const [tabSearchButtonVisible, setTabSearchButtonVisible] =
		useTabSearchButton();
	const [sidebarVariant] = useSidebarVariant();
	const floatingChromeOffset = sidebarVariant === "floating";
	// Auto-hide slides the bar away until the cursor nears the top edge. Forced
	// off on mobile — there's no hover-peek equivalent and the Sheet already
	// owns navigation chrome.
	const [autoHideTitleBar, setAutoHideTitleBar] = useAutoHideTitleBar();
	// Fullscreen forces the same reveal-on-hover behaviour without touching the
	// saved preference, so an Electron-style fullscreen actually clears the chrome
	// instead of leaving a fake titlebar painted across the top of the display.
	// Hover still peeks it, so tabs stay reachable.
	const isFullscreen = useFullscreen();
	const effectiveAutoHide = (autoHideTitleBar || isFullscreen) && !isMobile;
	const handleToggleFullscreen = () => {
		toggleFullscreen().catch(() => {
			toast.error("Couldn't toggle full screen in this window.");
		});
	};
	const [titleBarPeeked, setTitleBarPeeked] = useState(false);
	const [titleBarMenuOpen, setTitleBarMenuOpen] = useState(false);
	const titleBarMenuOpenRef = useRef(false);
	const titleBarHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!effectiveAutoHide) {
			if (titleBarHideTimer.current) {
				clearTimeout(titleBarHideTimer.current);
				titleBarHideTimer.current = null;
			}
			setTitleBarPeeked(false);
			setTitleBarMenuOpen(false);
			titleBarMenuOpenRef.current = false;
		}
	}, [effectiveAutoHide]);

	useEffect(() => {
		return () => {
			if (titleBarHideTimer.current) {
				clearTimeout(titleBarHideTimer.current);
			}
		};
	}, []);

	const showTitleBarPeek = () => {
		if (titleBarHideTimer.current) {
			clearTimeout(titleBarHideTimer.current);
			titleBarHideTimer.current = null;
		}
		setTitleBarPeeked(true);
	};

	const scheduleTitleBarHide = () => {
		// Keep the bar up while a strip context menu is open — otherwise the
		// leave-to-menu path hides the trigger and the menu loses its anchor.
		if (titleBarMenuOpenRef.current) {
			return;
		}
		if (titleBarHideTimer.current) {
			clearTimeout(titleBarHideTimer.current);
		}
		titleBarHideTimer.current = setTimeout(() => setTitleBarPeeked(false), 200);
	};

	const onTitleBarMenuOpenChange = (open: boolean) => {
		titleBarMenuOpenRef.current = open;
		setTitleBarMenuOpen(open);
		if (open) {
			showTitleBarPeek();
		} else {
			scheduleTitleBarHide();
		}
	};

	const titleBarVisible =
		!effectiveAutoHide || titleBarPeeked || titleBarMenuOpen;

	// Mirror tuck onto Decorum's Windows/Linux caption buttons (separate DOM
	// overlay). Cleared on unmount so a remount never leaves them stuck hidden.
	useEffect(() => {
		setTitlebarHidden(effectiveAutoHide && !titleBarVisible);
	}, [effectiveAutoHide, titleBarVisible]);

	useEffect(() => {
		return () => {
			setTitlebarHidden(false);
		};
	}, []);

	// Caption buttons live outside the React title bar; keep the peek up while
	// the cursor is over them so min/max/close stay reachable after a peek.
	const showTitleBarPeekRef = useRef(showTitleBarPeek);
	const scheduleTitleBarHideRef = useRef(scheduleTitleBarHide);
	showTitleBarPeekRef.current = showTitleBarPeek;
	scheduleTitleBarHideRef.current = scheduleTitleBarHide;

	useEffect(() => {
		if (!effectiveAutoHide) {
			return;
		}
		const container = document.querySelector(
			"[data-tauri-decorum-tb]"
		) as HTMLElement | null;
		if (!container) {
			return;
		}
		// Container itself is pointer-events:none; listen for bubbled events from
		// the caption buttons so moving onto min/max/close keeps the peek up.
		const onOver = () => {
			showTitleBarPeekRef.current();
		};
		const onOut = (e: MouseEvent) => {
			const next = e.relatedTarget;
			if (next instanceof Node && container.contains(next)) {
				return;
			}
			scheduleTitleBarHideRef.current();
		};
		container.addEventListener("mouseover", onOver);
		container.addEventListener("mouseout", onOut);
		return () => {
			container.removeEventListener("mouseover", onOver);
			container.removeEventListener("mouseout", onOut);
		};
	}, [effectiveAutoHide]);

	const pinnedTabs = tabs.filter((t) => t.pinned);
	const unpinnedTabs = tabs.filter((t) => !t.pinned);
	const segments = buildSegments(unpinnedTabs, groups, splits);

	// Hide the special actions bar when the active tab is in a split — each
	// focused pane shows those actions beside its title pill instead.
	const activeInSplit = activeTabId
		? !!findSplit(tabs, splits, activeTabId)
		: false;

	// The frosted scroll-under titlebar is used by the chat page, the empty
	// no-tab launchpad, and the store / marketplace family — all let their
	// content sit UNDER a continuous glass bar; every other page gets a solid bar
	// (see the blur/solid branch in the render below).
	const activeTab = tabs.find((t) => t.id === activeTabId);
	const activePath = activeTab?.path ?? "";
	const isChatActive =
		tabs.length === 0 || pathScrollsUnderTitlebar(activePath);

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
		// `activeTabId` is load-bearing — it is the "newly-activated" half. Without
		// it this runs once at mount and a newly activated tab is never scrolled
		// into view.
	}, [activeTabId]);

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
	useTabCycleHotkeys();
	useHotkey("nav.back", goBack);
	useHotkey("nav.forward", goForward);
	useMouseNavigationButtons(goBack, goForward);

	return (
		<>
			{/* Top-edge hover zone — catches the cursor when the bar is tucked away
			    so it can slide back in. Always mounted while auto-hide is on; the
			    bar itself takes over once peeked (pointer-events resume). */}
			{effectiveAutoHide && (
				<div
					aria-hidden
					className="absolute top-0 left-0 z-10 h-4 w-full"
					onMouseEnter={showTitleBarPeek}
					onMouseLeave={scheduleTitleBarHide}
					style={{ pointerEvents: titleBarVisible ? "none" : "auto" }}
				/>
			)}
			<div
				// The bar lives inside the SidebarInset main area (m-2), so its
				// items naturally center at mt-2 + h-12/2 ≈ 30.7px from the window
				// top in inset mode. Floating mode has no SidebarInset margin, so add
				// the same 8px top offset to keep the tab row aligned with the sidebar
				// node selector and the fixed nav cluster (see Layout).
				//
				// That offset is PADDING, not a `top`, and the difference is the whole
				// point: `data-tauri-drag-region` lives on this element, so anything
				// above its box is not draggable. With `top-2` the topmost 8px band of
				// the window — the strip the blur layer reaches up into — was dead
				// space: it looked like titlebar and dragged nothing. `h-14 pt-2`
				// centres the row at exactly the same 32px from the window top while
				// keeping the band inside the drag region.
				className={cn(
					"absolute top-0 left-0 z-10 flex w-full items-center px-2",
					floatingChromeOffset ? "h-14 pt-2" : "h-12"
				)}
				data-tab-appearance={floatingTabs ? "floating" : "morphing"}
				data-tauri-drag-region
				onMouseEnter={effectiveAutoHide ? showTitleBarPeek : undefined}
				onMouseLeave={effectiveAutoHide ? scheduleTitleBarHide : undefined}
				style={
					effectiveAutoHide
						? {
								transform: titleBarVisible
									? "translateY(0)"
									: "translateY(calc(-100% - 12px))",
								opacity: titleBarVisible ? 1 : 0,
								pointerEvents: titleBarVisible ? "auto" : "none",
								transition:
									"transform 280ms cubic-bezier(0.34,1.2,0.64,1), opacity 240ms ease-out",
							}
						: undefined
				}
			>
				{/* On the chat page the content scrolls UNDER the titlebar, so it gets
				    the frosted "liquid glass" gradient that blurs + fades whatever
				    scrolls beneath it. Every other page sits cleanly below the bar, so
				    it gets a plain solid background instead (no pointless blur over the
				    reserved gap). Both sit behind the z-10 controls.

				    The wrapper now starts at the true window top in BOTH modes (floating
				    mode pads instead of offsetting, so the drag region covers the top
				    band), so neither layer needs to be pulled back up any more — they
				    only grow by the same 8px in floating mode so the fade still ends
				    where it did. */}
				{isChatActive ? (
					<ProgressiveBlur
						backgroundColor="var(--background)"
						blurAmount="12px"
						height={floatingChromeOffset ? "80px" : "72px"}
						position="top"
					/>
				) : (
					<div
						aria-hidden
						className={cn(
							"pointer-events-none absolute top-0 left-0 w-full bg-background",
							floatingChromeOffset ? "h-14" : "h-12"
						)}
					/>
				)}
				{/* Seasonal particles drift down the bar on holidays. They sit ABOVE
				    the background layer and BELOW the z-10 controls row, so they never
				    cover a tab label, and they fade out towards the bottom edge so the
				    bar does not end in a hard line of emoji. */}
				{activeSeason && (
					<SeasonalParticles
						color={activeSeason.color}
						count={30}
						emoji={activeSeason.emoji}
						fadeBottom
						maxOpacity={1}
						maxSize={activeSeason.maxSize ?? 30}
						minOpacity={0}
						minSize={activeSeason.minSize ?? 1}
						zIndex={1}
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
					{(isMobile || !open) && (
						<div
							aria-hidden
							className={cn("shrink-0", navClusterReserve)}
							data-tauri-drag-region
						/>
					)}

					{/* Tab strip — scrollable, fills remaining space. Hidden whenever a
					    different tab view owns the tabs. */}
					{tabLayout === "horizontal" ? (
						<ContextMenu onOpenChange={onTitleBarMenuOpenChange}>
							<div className="flex min-w-0 flex-1 items-center">
								{tabDropdownEnabled ? (
									<ContextMenuTrigger
										className="flex min-w-0 flex-1 items-center"
										data-tauri-drag-region
									>
										<div
											className="flex min-w-0 flex-1 items-center gap-1"
											data-tauri-drag-region
										>
											<TabDropdown
												activateTab={activateTab}
												activeIcon={
													activeTab ? (
														<TabGlyph
															busy={activeTab.busy}
															busySpeed={activeTab.busySpeed}
															className="size-4"
															icon={activeTab.icon}
															logoSize="16px"
															path={activeTab.path}
															unloaded={activeTab.unloaded}
														/>
													) : undefined
												}
												activeTabId={activeTabId}
												closeTab={closeTab}
												tabs={tabs}
											/>
											<button
												aria-label="New chat tab"
												className={cn(
													"ml-0.5 flex size-7 shrink-0 items-center justify-center text-muted-foreground/50 transition-colors hover:bg-background/50 hover:text-muted-foreground",
													floatingTabs ? "rounded-full" : "rounded-t-[10px]"
												)}
												data-tauri-drag-region={false}
												onClick={handleNewTab}
												type="button"
											>
												<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
											</button>
											<div
												aria-hidden
												className="min-w-0 flex-1"
												data-tauri-drag-region
											/>
										</div>
									</ContextMenuTrigger>
								) : (
									<>
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
								    Overflow is also reached via the wheel handler + scrollIntoView,
								    and by the hover-revealed edge chevrons (`EdgeScrollChevrons`) —
								    the same affordance the Store/Library section strips wear, which
								    is why the group is named `edge-scroller` here too. */}
												<div className="group/edge-scroller relative flex h-8 min-w-0 flex-1 items-start overflow-hidden">
													<EdgeScrollChevrons scrollRef={scrollRef} />
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
																		className="flex shrink-0 items-center gap-1 rounded-2xl px-1 py-0.5 ring-1 ring-border/40"
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
															const colors =
																GROUP_COLOR_CLASSES[seg.group.color];
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
													className={cn(
														"ml-0.5 flex size-7 shrink-0 items-center justify-center text-muted-foreground/50 transition-colors hover:bg-background/50 hover:text-muted-foreground",
														floatingTabs ? "rounded-full" : "rounded-t-[10px]"
													)}
													data-tauri-drag-region={false}
													onClick={handleNewTab}
													type="button"
												>
													<HugeiconsIcon
														className="size-3.5"
														icon={Add01Icon}
													/>
												</button>
											</div>
										</ContextMenuTrigger>
										{tabSearchButtonVisible && (
											<TabSearchDialog
												activateTab={activateTab}
												activeTabId={activeTabId}
												closeTab={closeTab}
												floatingTabs={floatingTabs}
												onHide={() => setTabSearchButtonVisible(false)}
												tabs={tabs}
											/>
										)}
									</>
								)}
							</div>
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
								<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
								<TabBarAppearanceMenuItems
									floatingTabs={floatingTabs}
									setFloatingTabs={setFloatingTabs}
									setTabDropdownEnabled={setTabDropdownEnabled}
									setTabSearchButtonVisible={setTabSearchButtonVisible}
									tabDropdownEnabled={tabDropdownEnabled}
									tabSearchButtonVisible={tabSearchButtonVisible}
								/>
								<ContextMenuCheckboxItem
									checked={autoHideTitleBar}
									onCheckedChange={setAutoHideTitleBar}
								>
									<HugeiconsIcon className="size-4" icon={SidebarTopIcon} />
									Auto-hide title bar
								</ContextMenuCheckboxItem>
								<ContextMenuItem onClick={handleToggleFullscreen}>
									<HugeiconsIcon
										className="size-4"
										icon={isFullscreen ? ArrowShrink02Icon : FullScreenIcon}
									/>
									{isFullscreen ? "Exit full screen" : "Enter full screen"}
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
					) : (
						<ContextMenu onOpenChange={onTitleBarMenuOpenChange}>
							<ContextMenuTrigger
								className="min-w-0 flex-1"
								data-tauri-drag-region
							>
								<div className="min-w-0 flex-1" data-tauri-drag-region />
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuCheckboxItem
									checked={autoHideTitleBar}
									onCheckedChange={setAutoHideTitleBar}
								>
									<HugeiconsIcon className="size-4" icon={SidebarTopIcon} />
									Auto-hide title bar
								</ContextMenuCheckboxItem>
								<ContextMenuItem onClick={handleToggleFullscreen}>
									<HugeiconsIcon
										className="size-4"
										icon={isFullscreen ? ArrowShrink02Icon : FullScreenIcon}
									/>
									{isFullscreen ? "Exit full screen" : "Enter full screen"}
								</ContextMenuItem>
								<TabLayoutMenuItems onChange={setTabLayout} value={tabLayout} />
							</ContextMenuContent>
						</ContextMenu>
					)}

					{/* Spacer so actions hug the right edge */}
					<div
						className="flex-shrink-0 flex-grow-0"
						data-tauri-drag-region
						style={{ minWidth: 0 }}
					/>

					{/* Right-side page actions — offset clears Windows titlebar buttons.
				    Hidden when the active tab is in a split: the focused pane shows
				    those actions beside its title pill instead. */}
					{actions && !activeInSplit && (
						<div
							className={cn(
								"relative z-50 flex shrink-0 flex-row items-center gap-1 rounded-2xl bg-background/50 px-1",
								// Windows caption buttons (min/max/close) sit at the top-right;
								// give the page actions wide clearance so they never crowd them.
								// macOS keeps its controls on the left, so only a small inset.
								// A phone width is always the browser build — no caption
								// buttons to clear, and 12rem of dead margin would push the
								// actions off screen.
								pageActionsMargin
							)}
							data-tauri-drag-region={false}
						>
							{actions}
						</div>
					)}
				</div>
			</div>
		</>
	);
}
