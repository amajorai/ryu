/* @jsxImportSource @opentui/react */
// WorkspaceContext - the tab/region model for the desktop-mirrored shell. It
// runs the same `@ryu/workbench` reducer as the Desktop app, so both surfaces
// share one model: Left (the sidebar's Navigation), Center (one or more split
// panes), Right, and Bottom, each holding tabs with one active tab, and one
// focused group across all regions.
//
// Surfaces keep the original API: `tabs` are the page tabs (route items) and
// `panes` are the Center panes in split order. Region-aware callers use
// `regionGroups`, `moveActiveTo`, `focusDirection`, and the show/hide verbs.
//
// TUI rules layered on the shared reducer:
//   - every path except /chat is a singleton (reopening focuses it);
//   - pinned tabs refuse Ctrl+W;
//   - the workspace is never blank: closing the last Center tab seeds a chat;
//   - splitActive toggles one extra Center pane seeded with the active page.

import {
	createDefaultWorkbench,
	type WorkbenchItem,
	type WorkbenchRegion,
	type WorkbenchState,
} from "@ryu/workbench/model";
import { reduceWorkbench, type WorkbenchAction } from "@ryu/workbench/reducer";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { resolveSurface } from "./router.ts";
import type { WorkbenchPersistence } from "./workbenchPersistence.ts";

export interface Tab {
	id: string;
	path: string;
	pinned: boolean;
	title: string;
}

export interface Pane {
	activeTabId: string | null;
	id: string;
	tabIds: string[];
}

export type SideRegion = Exclude<WorkbenchRegion, "center" | "left">;
export type FocusDirection = "down" | "left" | "right" | "up";

export interface OpenTabOptions {
	/** Force a brand-new tab even for a singleton path (default false). */
	forceNew?: boolean;
	/** Override the derived tab title. */
	title?: string;
}

interface WorkspaceContextValue {
	/** Make `tabId` the active tab of `paneId` and focus that pane. */
	activateTab: (paneId: string, tabId: string) => void;
	/** Close the focused group's active tab (Ctrl+W). */
	closeActiveTab: () => void;
	/** Close a tab; pushes it onto the restore stack. Never leaves Center blank. */
	closeTab: (id: string) => void;
	/** Cycle the focused group's active tab (+1 next, -1 previous). */
	cycleTab: (dir: 1 | -1) => void;
	/** Move keyboard focus to the nearest visible group in a direction. */
	focusDirection: (direction: FocusDirection) => void;
	/** The focused group id (owns the keyboard); any region's group. */
	focusedPaneId: string;
	/** The region of the focused group. */
	focusedRegion: WorkbenchRegion;
	/** Focus a pane without changing its active tab. */
	focusPane: (paneId: string) => void;
	/** Activate the focused group's tab at 0-based `index` (Alt+1..9); a no-op
	 * when that group has no tab there. */
	focusTabByIndex: (index: number) => void;
	/** Hide a side region; its tabs stay. */
	hideRegion: (region: SideRegion) => void;
	/** Move the focused tab to a region (showing that region). */
	moveActiveTo: (region: Exclude<WorkbenchRegion, "left">) => void;
	/** Open (or, for singleton paths, reveal) a tab. Returns the tab id. */
	openTab: (path: string, opts?: OpenTabOptions) => string;
	/** The Center panes, in split order. */
	panes: Pane[];
	/** Toggle pinned state of a tab. */
	pinTab: (id: string) => void;
	/** The Right/Bottom group as a pane, when it is open and has tabs. */
	regionGroups: Record<SideRegion, Pane | null>;
	/** Return every tab to its default region and drop extra Center panes. */
	resetLayout: () => void;
	/** Reopen the most recently closed tab in its original group. */
	restoreTab: () => void;
	/** Show a side region if it has tabs. */
	showRegion: (region: SideRegion) => void;
	/** Toggle the split: 1 Center pane -> 2 (duplicating the active path), or
	 * more -> 1 (merging the others' tabs back). */
	splitActive: () => void;
	/** The shared workbench state (read-only). */
	state: WorkbenchState;
	/** All open page tabs (flat). Membership/order lives on groups. */
	tabs: Tab[];
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const HOME_PATH = "/chat";

// Human titles for known paths. Falls back to a surface's title, then the last
// path segment. Keeps titles stable without every surface needing to be loaded.
const PATH_TITLES = new Map<string, string>(
	Object.entries({
		"/chat": "New chat",
		"/app-launcher": "App Launcher",
		"/home": "Home",
		"/agents": "Agents",
		"/teams": "Groups",
		"/engines": "Engines",
		"/models": "Models",
		"/skills": "Skills",
		"/spaces": "Spaces",
		"/tools": "Tools",
		"/workflows": "Workflows",
		"/calendar": "Calendar",
		"/timeline": "Timeline",
		"/monitors": "Monitors",
		"/tasks": "Tasks",
		"/inbox": "Inbox",
		"/downloads": "Downloads",
		"/meetings": "Meetings",
		"/library": "Library",
		"/store": "Customize",
		"/setup": "Setup",
	} satisfies Record<string, string>)
);

function makeId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

/** Every path except /chat is a singleton (reused rather than re-opened). */
function isSingleton(path: string): boolean {
	return path !== HOME_PATH;
}

function defaultTitle(path: string): string {
	const known = PATH_TITLES.get(path);
	if (known) {
		return known;
	}
	const surface = resolveSurface(path);
	if (surface) {
		return surface.title;
	}
	return path.split("/").filter(Boolean).at(-1) ?? "Page";
}

function pageItem(path: string, title?: string): WorkbenchItem {
	return {
		closable: true,
		duplicable: path === HOME_PATH,
		id: makeId("tab"),
		pinned: false,
		preferredRegion: "center",
		scope: { kind: "window" },
		source: { kind: "route", path },
		title: title ?? defaultTitle(path),
	};
}

function centerLeafIds(state: WorkbenchState): string[] {
	const walk = (node: WorkbenchState["centerTree"]): string[] =>
		node.type === "leaf" ? [node.groupId] : node.children.flatMap(walk);
	return walk(state.centerTree);
}

function groupById(state: WorkbenchState, groupId: string) {
	return state.groups.find((group) => group.id === groupId);
}

function groupOwning(state: WorkbenchState, itemId: string) {
	return state.groups.find((group) => group.itemIds.includes(itemId));
}

function routeItemIds(state: WorkbenchState): Set<string> {
	return new Set(
		state.items.flatMap((item) =>
			item.source.kind === "route" ? [item.id] : []
		)
	);
}

function asPane(state: WorkbenchState, groupId: string): Pane | null {
	const group = groupById(state, groupId);
	if (!group) {
		return null;
	}
	const pages = routeItemIds(state);
	const tabIds = group.itemIds.filter((itemId) => pages.has(itemId));
	return {
		activeTabId:
			group.activeItemId && pages.has(group.activeItemId)
				? group.activeItemId
				: (tabIds[0] ?? null),
		id: group.id,
		tabIds,
	};
}

function regionIsShown(state: WorkbenchState, region: SideRegion): boolean {
	return (
		state.openRegions[region] &&
		state.groups.some(
			(group) => group.region === region && group.itemIds.length > 0
		)
	);
}

/** The Center group new pages open in: the focused one, else the first. */
function targetCenterGroupId(state: WorkbenchState): string {
	const focused = groupById(state, state.focusedGroupId);
	return focused?.region === "center"
		? focused.id
		: (centerLeafIds(state)[0] ?? state.focusedGroupId);
}

/** Center never goes blank: seed a chat when no page tab is left in Center. */
function ensureCenterTab(state: WorkbenchState): WorkbenchState {
	const pages = routeItemIds(state);
	const centerHasPage = state.groups.some(
		(group) =>
			group.region === "center" &&
			group.itemIds.some((itemId) => pages.has(itemId))
	);
	if (centerHasPage) {
		return state;
	}
	return reduceWorkbench(state, {
		type: "item/open",
		groupId: targetCenterGroupId(state),
		item: pageItem(HOME_PATH),
	});
}

/** The initial workspace: Navigation in Left and one home chat in Center. */
export function initialWorkbench(): WorkbenchState {
	const state = createDefaultWorkbench({
		bottomGroupId: makeId("bottom"),
		centerGroupId: makeId("center"),
		leftGroupId: makeId("left"),
		navigationId: makeId("navigation"),
		rightGroupId: makeId("right"),
	});
	return ensureCenterTab(state);
}

/** Visible groups by position, for directional focus. */
function focusTarget(
	state: WorkbenchState,
	direction: FocusDirection
): string | undefined {
	const focused = groupById(state, state.focusedGroupId);
	const centers = centerLeafIds(state);
	const right = regionIsShown(state, "right")
		? state.groups.find((group) => group.region === "right")?.id
		: undefined;
	const bottom = regionIsShown(state, "bottom")
		? state.groups.find((group) => group.region === "bottom")?.id
		: undefined;
	const row = right ? [...centers, right] : centers;
	if (focused?.region === "bottom") {
		return direction === "up" ? centers[0] : undefined;
	}
	if (direction === "down") {
		return bottom;
	}
	if (direction === "up") {
		return;
	}
	const at = row.indexOf(state.focusedGroupId);
	if (at === -1) {
		return row[0];
	}
	return row[at + (direction === "left" ? -1 : 1)];
}

export function WorkspaceProvider({
	children,
	persistence,
}: {
	children: ReactNode;
	/** Load/save the layout. Omitted in tests so nothing touches a profile. */
	persistence?: WorkbenchPersistence;
}) {
	const [state, setState] = useState<WorkbenchState>(() => {
		const loaded = persistence?.load();
		return loaded ? ensureCenterTab(loaded) : initialWorkbench();
	});
	// Mirror for synchronous reads inside callbacks (fresh ids, singleton reuse).
	const stateRef = useRef(state);
	stateRef.current = state;

	useEffect(() => {
		if (!persistence) {
			return;
		}
		const timer = setTimeout(() => persistence.save(state), 200);
		return () => clearTimeout(timer);
	}, [persistence, state]);

	const apply = useCallback(
		(update: (current: WorkbenchState) => WorkbenchState): WorkbenchState => {
			const next = update(stateRef.current);
			stateRef.current = next;
			setState(next);
			return next;
		},
		[]
	);

	const dispatch = useCallback(
		(action: WorkbenchAction) =>
			apply((current) => reduceWorkbench(current, action)),
		[apply]
	);

	const openTab = useCallback(
		(path: string, opts?: OpenTabOptions): string => {
			const current = stateRef.current;
			const groupId = targetCenterGroupId(current);
			if (isSingleton(path) && !opts?.forceNew) {
				// Reuse the page in the target pane or in a side region; another
				// Center pane may intentionally show its own copy (a split).
				const existing = current.items.find((item) => {
					if (item.source.kind !== "route" || item.source.path !== path) {
						return false;
					}
					const owner = groupOwning(current, item.id);
					return owner?.id === groupId || owner?.region !== "center";
				});
				if (existing) {
					dispatch({ type: "item/activate", itemId: existing.id });
					return existing.id;
				}
			}
			const item = pageItem(path, opts?.title);
			dispatch({ type: "item/open", groupId, item });
			return item.id;
		},
		[dispatch]
	);

	const closeTab = useCallback(
		(id: string) => {
			apply((current) => {
				const item = current.items.find((candidate) => candidate.id === id);
				const owner = groupOwning(current, id);
				if (!(item && owner) || item.pinned) {
					return current;
				}
				let next = reduceWorkbench(current, { type: "item/close", itemId: id });
				const emptied = groupById(next, owner.id);
				if (
					emptied?.region === "center" &&
					emptied.itemIds.length === 0 &&
					centerLeafIds(next).length > 1
				) {
					next = reduceWorkbench(next, {
						type: "center/remove-group",
						groupId: owner.id,
					});
				}
				return ensureCenterTab(next);
			});
		},
		[apply]
	);

	const closeActiveTab = useCallback(() => {
		const current = stateRef.current;
		const activeItemId = groupById(
			current,
			current.focusedGroupId
		)?.activeItemId;
		if (activeItemId) {
			closeTab(activeItemId);
		}
	}, [closeTab]);

	const restoreTab = useCallback(() => {
		const last = stateRef.current.closedItems.at(-1);
		if (last) {
			dispatch({ type: "item/restore", itemId: last.item.id });
		}
	}, [dispatch]);

	const pinTab = useCallback(
		(id: string) => dispatch({ type: "item/pin", itemId: id }),
		[dispatch]
	);

	const splitActive = useCallback(() => {
		apply((current) => {
			const leaves = centerLeafIds(current);
			if (leaves.length > 1) {
				let next = current;
				for (const groupId of leaves.slice(1)) {
					next = reduceWorkbench(next, {
						type: "center/remove-group",
						groupId,
					});
				}
				return reduceWorkbench(next, {
					type: "group/focus",
					groupId: leaves[0] ?? next.focusedGroupId,
				});
			}
			const targetId = targetCenterGroupId(current);
			const activeId = groupById(current, targetId)?.activeItemId;
			const active = current.items.find((item) => item.id === activeId);
			const path =
				active?.source.kind === "route" ? active.source.path : HOME_PATH;
			const newGroupId = makeId("center");
			const split = reduceWorkbench(current, {
				type: "center/split",
				direction: "right",
				newGroupId,
				targetGroupId: targetId,
			});
			return reduceWorkbench(split, {
				type: "item/open",
				groupId: newGroupId,
				item: pageItem(path),
			});
		});
	}, [apply]);

	const focusPane = useCallback(
		(paneId: string) => dispatch({ type: "group/focus", groupId: paneId }),
		[dispatch]
	);

	const focusDirection = useCallback(
		(direction: FocusDirection) => {
			const target = focusTarget(stateRef.current, direction);
			if (target) {
				dispatch({ type: "group/focus", groupId: target });
			}
		},
		[dispatch]
	);

	const cycleTab = useCallback(
		(dir: 1 | -1) => {
			const current = stateRef.current;
			const group = groupById(current, current.focusedGroupId);
			if (!group?.activeItemId || group.itemIds.length < 2) {
				return;
			}
			const at = group.itemIds.indexOf(group.activeItemId);
			const nextId =
				group.itemIds[(at + dir + group.itemIds.length) % group.itemIds.length];
			if (nextId) {
				dispatch({ type: "item/activate", itemId: nextId });
			}
		},
		[dispatch]
	);

	const activateTab = useCallback(
		(_paneId: string, tabId: string) =>
			dispatch({ type: "item/activate", itemId: tabId }),
		[dispatch]
	);

	const focusTabByIndex = useCallback(
		(index: number) => {
			const current = stateRef.current;
			const itemId = groupById(current, current.focusedGroupId)?.itemIds[index];
			if (itemId) {
				dispatch({ type: "item/activate", itemId });
			}
		},
		[dispatch]
	);

	const moveActiveTo = useCallback(
		(region: Exclude<WorkbenchRegion, "left">) => {
			apply((current) => {
				const focused = groupById(current, current.focusedGroupId);
				const itemId = focused?.activeItemId;
				if (!(itemId && focused) || focused.region === region) {
					return current;
				}
				const targetId =
					region === "center"
						? centerLeafIds(current)[0]
						: current.groups.find((group) => group.region === region)?.id;
				if (!targetId) {
					return current;
				}
				const moved = reduceWorkbench(current, {
					type: "item/move",
					itemId,
					toGroupId: targetId,
				});
				return ensureCenterTab(moved);
			});
		},
		[apply]
	);

	const showRegion = useCallback(
		(region: SideRegion) => dispatch({ type: "region/show", region }),
		[dispatch]
	);
	const hideRegion = useCallback(
		(region: SideRegion) => dispatch({ type: "region/hide", region }),
		[dispatch]
	);
	const resetLayout = useCallback(
		() =>
			apply((current) =>
				ensureCenterTab(reduceWorkbench(current, { type: "layout/reset" }))
			),
		[apply]
	);

	const value = useMemo<WorkspaceContextValue>(() => {
		const tabs: Tab[] = state.items.flatMap((item) =>
			item.source.kind === "route"
				? [
						{
							id: item.id,
							path: item.source.path,
							pinned: item.pinned,
							title: item.title,
						},
					]
				: []
		);
		const panes = centerLeafIds(state).flatMap((groupId) => {
			const pane = asPane(state, groupId);
			return pane ? [pane] : [];
		});
		const sidePane = (region: SideRegion): Pane | null => {
			if (!regionIsShown(state, region)) {
				return null;
			}
			const group = state.groups.find(
				(candidate) => candidate.region === region
			);
			return group ? asPane(state, group.id) : null;
		};
		return {
			activateTab,
			closeActiveTab,
			closeTab,
			cycleTab,
			focusDirection,
			focusedPaneId: state.focusedGroupId,
			focusedRegion: groupById(state, state.focusedGroupId)?.region ?? "center",
			focusPane,
			focusTabByIndex,
			hideRegion,
			moveActiveTo,
			openTab,
			panes,
			pinTab,
			regionGroups: { bottom: sidePane("bottom"), right: sidePane("right") },
			resetLayout,
			restoreTab,
			showRegion,
			splitActive,
			state,
			tabs,
		};
	}, [
		activateTab,
		closeActiveTab,
		closeTab,
		cycleTab,
		focusDirection,
		focusPane,
		focusTabByIndex,
		hideRegion,
		moveActiveTo,
		openTab,
		pinTab,
		resetLayout,
		restoreTab,
		showRegion,
		splitActive,
		state,
	]);

	return (
		<WorkspaceContext.Provider value={value}>
			{children}
		</WorkspaceContext.Provider>
	);
}

/** Read the workspace. Throws outside WorkspaceProvider. */
export function useWorkspace(): WorkspaceContextValue {
	const ctx = useContext(WorkspaceContext);
	if (!ctx) {
		throw new Error("useWorkspace must be used within a WorkspaceProvider");
	}
	return ctx;
}
