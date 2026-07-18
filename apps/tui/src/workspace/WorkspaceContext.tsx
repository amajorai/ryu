/* @jsxImportSource @opentui/react */
// WorkspaceContext - the tab/pane model for the desktop-mirrored shell (the
// apps/desktop TabsContext analog, trimmed to what the TUI needs).
//
// Model:
//   - Tabs are flat { id, path, title, pinned }. Each tab lives in exactly one
//     pane (pane.tabIds owns the ordering + membership).
//   - Panes support ONE split: 1 pane normally, 2 panes side by side after
//     splitActive(). Each pane has its own active tab; one pane is focused.
//   - A closed-tab stack backs restoreTab() (Ctrl+Shift+T).
//
// All mutations go through a single WorkspaceState object updated with pure
// helpers so tabs + panes never drift. A mirror ref lets action callbacks read
// the current state synchronously (to return a fresh tab id, decide singleton
// reuse) without stale-closure bugs.

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import { resolveSurface } from "./router.ts";

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

interface ClosedTab {
	index: number;
	paneId: string;
	tab: Tab;
}

interface WorkspaceState {
	closed: ClosedTab[];
	focusedPaneId: string;
	panes: Pane[];
	tabs: Tab[];
}

export interface OpenTabOptions {
	/** Force a brand-new tab even for a singleton path (default false). */
	forceNew?: boolean;
	/** Override the derived tab title. */
	title?: string;
}

interface WorkspaceContextValue {
	/** Make `tabId` the active tab of `paneId` and focus that pane. */
	activateTab: (paneId: string, tabId: string) => void;
	/** Close a tab; pushes it onto the restore stack. Never leaves a pane empty. */
	closeTab: (id: string) => void;
	/** Cycle the focused pane's active tab (+1 next, -1 previous). */
	cycleTab: (dir: 1 | -1) => void;
	/** The currently focused pane id (owns the keyboard). */
	focusedPaneId: string;
	/** Focus a pane without changing its active tab. */
	focusPane: (paneId: string) => void;
	/** Open (or, for singleton paths, reveal) a tab in the focused pane. Returns
	 * the tab id. */
	openTab: (path: string, opts?: OpenTabOptions) => string;
	/** The panes, in render order (1 or 2). */
	panes: Pane[];
	/** Toggle pinned state of a tab. */
	pinTab: (id: string) => void;
	/** Reopen the most recently closed tab in its original pane. */
	restoreTab: () => void;
	/** Toggle the split: 1 pane -> 2 panes (duplicating the active path), or
	 * 2 panes -> 1 (merging the second pane's tabs back). */
	splitActive: () => void;
	/** All open tabs (flat). Membership/order lives on panes. */
	tabs: Tab[];
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const HOME_PATH = "/chat";

// Human titles for known paths. Falls back to a surface's title, then the last
// path segment. Keeps titles stable without every surface needing to be loaded.
const PATH_TITLES: Record<string, string> = {
	"/chat": "New chat",
	"/home": "Home",
	"/agents": "Agents",
	"/teams": "Teams",
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
};

function makeTabId(): string {
	return `tab-${crypto.randomUUID()}`;
}

function makePaneId(): string {
	return `pane-${crypto.randomUUID()}`;
}

/** Every path except /chat is a singleton (reused rather than re-opened). */
function isSingleton(path: string): boolean {
	return path !== HOME_PATH;
}

function defaultTitle(path: string): string {
	const known = PATH_TITLES[path];
	if (known) {
		return known;
	}
	const surface = resolveSurface(path);
	if (surface) {
		return surface.title;
	}
	return path.split("/").filter(Boolean).at(-1) ?? "Page";
}

/** The initial single-pane / single-tab workspace (home chat). */
function initialState(): WorkspaceState {
	const tab: Tab = {
		id: makeTabId(),
		path: HOME_PATH,
		title: defaultTitle(HOME_PATH),
		pinned: false,
	};
	const pane: Pane = {
		id: makePaneId(),
		tabIds: [tab.id],
		activeTabId: tab.id,
	};
	return {
		tabs: [tab],
		panes: [pane],
		focusedPaneId: pane.id,
		closed: [],
	};
}

function paneById(state: WorkspaceState, paneId: string): Pane | undefined {
	return state.panes.find((pane) => pane.id === paneId);
}

function focusedPane(state: WorkspaceState): Pane {
	return paneById(state, state.focusedPaneId) ?? state.panes[0];
}

/** Replace one pane in the panes array (returns a new array). */
function withPane(panes: Pane[], next: Pane): Pane[] {
	return panes.map((pane) => (pane.id === next.id ? next : pane));
}

/** The pane that owns a tab id. */
function paneOwning(state: WorkspaceState, tabId: string): Pane | undefined {
	return state.panes.find((pane) => pane.tabIds.includes(tabId));
}

function activateInPane(
	state: WorkspaceState,
	paneId: string,
	tabId: string
): WorkspaceState {
	const pane = paneById(state, paneId);
	if (!pane) {
		return state;
	}
	return {
		...state,
		panes: withPane(state.panes, { ...pane, activeTabId: tabId }),
		focusedPaneId: paneId,
	};
}

function addTab(
	state: WorkspaceState,
	paneId: string,
	tab: Tab
): WorkspaceState {
	const pane = paneById(state, paneId);
	if (!pane) {
		return state;
	}
	const nextPane: Pane = {
		...pane,
		tabIds: [...pane.tabIds, tab.id],
		activeTabId: tab.id,
	};
	return {
		...state,
		tabs: [...state.tabs, tab],
		panes: withPane(state.panes, nextPane),
		focusedPaneId: paneId,
	};
}

// Remove a tab from its pane. If that empties the pane and a second pane exists,
// the pane is dropped (its - already empty - slot removed). If it empties the
// only pane, a fresh home tab is seeded so the workspace is never blank.
function removeTab(state: WorkspaceState, tabId: string): WorkspaceState {
	const owner = paneOwning(state, tabId);
	if (!owner) {
		return state;
	}
	const remainingIds = owner.tabIds.filter((id) => id !== tabId);
	const tabs = state.tabs.filter((tab) => tab.id !== tabId);

	if (remainingIds.length === 0) {
		return collapseEmptyPane(state, owner, tabs);
	}

	const removedIndex = owner.tabIds.indexOf(tabId);
	const nextActive =
		owner.activeTabId === tabId
			? (remainingIds[Math.min(removedIndex, remainingIds.length - 1)] ?? null)
			: owner.activeTabId;
	const nextPane: Pane = {
		...owner,
		tabIds: remainingIds,
		activeTabId: nextActive,
	};
	return { ...state, tabs, panes: withPane(state.panes, nextPane) };
}

function collapseEmptyPane(
	state: WorkspaceState,
	owner: Pane,
	tabs: Tab[]
): WorkspaceState {
	if (state.panes.length > 1) {
		const panes = state.panes.filter((pane) => pane.id !== owner.id);
		const focusedPaneId =
			state.focusedPaneId === owner.id ? panes[0].id : state.focusedPaneId;
		return { ...state, tabs, panes, focusedPaneId };
	}
	// Last pane emptied: seed a fresh home tab so the shell always has content.
	const seed: Tab = {
		id: makeTabId(),
		path: HOME_PATH,
		title: defaultTitle(HOME_PATH),
		pinned: false,
	};
	const pane: Pane = { ...owner, tabIds: [seed.id], activeTabId: seed.id };
	return {
		...state,
		tabs: [...tabs, seed],
		panes: withPane(state.panes, pane),
	};
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<WorkspaceState>(initialState);
	// Mirror for synchronous reads inside callbacks (fresh ids, singleton reuse).
	const stateRef = useRef(state);
	stateRef.current = state;

	const openTab = useCallback((path: string, opts?: OpenTabOptions): string => {
		const current = stateRef.current;
		const pane = focusedPane(current);
		if (isSingleton(path) && !opts?.forceNew) {
			const existing = current.tabs.find(
				(tab) => pane.tabIds.includes(tab.id) && tab.path === path
			);
			if (existing) {
				setState((prev) => activateInPane(prev, pane.id, existing.id));
				return existing.id;
			}
		}
		const tab: Tab = {
			id: makeTabId(),
			path,
			title: opts?.title ?? defaultTitle(path),
			pinned: false,
		};
		setState((prev) => addTab(prev, pane.id, tab));
		return tab.id;
	}, []);

	const closeTab = useCallback((id: string) => {
		setState((prev) => {
			const owner = paneOwning(prev, id);
			const tab = prev.tabs.find((candidate) => candidate.id === id);
			if (!(owner && tab) || tab.pinned) {
				return prev;
			}
			const index = owner.tabIds.indexOf(id);
			const closed: ClosedTab = { tab, paneId: owner.id, index };
			const next = removeTab(prev, id);
			return { ...next, closed: [...prev.closed, closed].slice(-20) };
		});
	}, []);

	const restoreTab = useCallback(() => {
		setState((prev) => {
			const entry = prev.closed.at(-1);
			if (!entry) {
				return prev;
			}
			const closed = prev.closed.slice(0, -1);
			const pane = paneById(prev, entry.paneId) ?? prev.panes[0];
			const tabIds = [...pane.tabIds];
			tabIds.splice(Math.min(entry.index, tabIds.length), 0, entry.tab.id);
			const nextPane: Pane = {
				...pane,
				tabIds,
				activeTabId: entry.tab.id,
			};
			return {
				...prev,
				closed,
				tabs: [...prev.tabs, entry.tab],
				panes: withPane(prev.panes, nextPane),
				focusedPaneId: pane.id,
			};
		});
	}, []);

	const pinTab = useCallback((id: string) => {
		setState((prev) => ({
			...prev,
			tabs: prev.tabs.map((tab) =>
				tab.id === id ? { ...tab, pinned: !tab.pinned } : tab
			),
		}));
	}, []);

	const splitActive = useCallback(() => {
		setState((prev) => {
			if (prev.panes.length > 1) {
				return mergeSplit(prev);
			}
			return openSplit(prev);
		});
	}, []);

	const focusPane = useCallback((paneId: string) => {
		setState((prev) =>
			paneById(prev, paneId) ? { ...prev, focusedPaneId: paneId } : prev
		);
	}, []);

	const cycleTab = useCallback((dir: 1 | -1) => {
		setState((prev) => {
			const pane = focusedPane(prev);
			if (pane.tabIds.length < 2 || !pane.activeTabId) {
				return prev;
			}
			const at = pane.tabIds.indexOf(pane.activeTabId);
			const nextId =
				pane.tabIds[(at + dir + pane.tabIds.length) % pane.tabIds.length];
			return activateInPane(prev, pane.id, nextId);
		});
	}, []);

	const activateTab = useCallback((paneId: string, tabId: string) => {
		setState((prev) => activateInPane(prev, paneId, tabId));
	}, []);

	const value = useMemo<WorkspaceContextValue>(
		() => ({
			tabs: state.tabs,
			panes: state.panes,
			focusedPaneId: state.focusedPaneId,
			openTab,
			closeTab,
			restoreTab,
			pinTab,
			splitActive,
			focusPane,
			cycleTab,
			activateTab,
		}),
		[
			state,
			openTab,
			closeTab,
			restoreTab,
			pinTab,
			splitActive,
			focusPane,
			cycleTab,
			activateTab,
		]
	);

	return (
		<WorkspaceContext.Provider value={value}>
			{children}
		</WorkspaceContext.Provider>
	);
}

// Split the focused pane: create a second pane seeded with a copy of the focused
// pane's active path (or a fresh home tab), and focus it.
function openSplit(state: WorkspaceState): WorkspaceState {
	const pane = focusedPane(state);
	const activeTab = state.tabs.find((tab) => tab.id === pane.activeTabId);
	const path = activeTab?.path ?? HOME_PATH;
	const seed: Tab = {
		id: makeTabId(),
		path,
		title: defaultTitle(path),
		pinned: false,
	};
	const newPane: Pane = {
		id: makePaneId(),
		tabIds: [seed.id],
		activeTabId: seed.id,
	};
	return {
		...state,
		tabs: [...state.tabs, seed],
		panes: [...state.panes, newPane],
		focusedPaneId: newPane.id,
	};
}

// Merge the split back to one pane: fold every non-first pane's tabs into the
// first pane, then keep only the first pane and focus it.
function mergeSplit(state: WorkspaceState): WorkspaceState {
	const [first, ...rest] = state.panes;
	const foldedIds = rest.flatMap((pane) => pane.tabIds);
	const merged: Pane = {
		...first,
		tabIds: [...first.tabIds, ...foldedIds],
		activeTabId: first.activeTabId ?? first.tabIds[0] ?? null,
	};
	return {
		...state,
		panes: [merged],
		focusedPaneId: merged.id,
	};
}

/** Read the workspace. Throws outside WorkspaceProvider. */
export function useWorkspace(): WorkspaceContextValue {
	const ctx = useContext(WorkspaceContext);
	if (!ctx) {
		throw new Error("useWorkspace must be used within a WorkspaceProvider");
	}
	return ctx;
}
