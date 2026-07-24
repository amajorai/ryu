import { planLimit } from "@ryu/auth/lib/plans";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { readPersistedNumber } from "@/src/hooks/usePersistedNumber.ts";
import { readStartupBehavior } from "@/src/hooks/useStartupBehavior.ts";
import { readTabOpenBehavior } from "@/src/hooks/useTabOpenBehavior.ts";
import { hasBillingAuth } from "@/src/lib/api/billing.ts";
import { effectivePlan } from "@/src/lib/gating/planCapBridge.ts";
import { stampRecentFromPath } from "@/src/lib/library.ts";
import {
	appendLeaves,
	containsLeaf,
	directionOrientation,
	insertLeaf,
	leafOrder,
	makeBranch,
	makeLeaf,
	normalizeNode,
	pruneToMembers,
	removeLeaf,
	type SplitBranch,
	type SplitDirection,
	type SplitNode,
	type SplitOrientation,
	setSizesAt,
	swapLeaves,
} from "@/src/lib/splitTree.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export type {
	SplitBranch,
	SplitDirection,
	SplitNode,
	SplitOrientation,
} from "@/src/lib/splitTree.ts";

export interface Tab {
	conversationId?: string;
	/** Membership in a TabGroup (see `groups`); pinned tabs are never grouped. */
	groupId?: string;
	id: string;
	initialAgent?: string;
	/** One-shot image attachments staged on the launchpad composer, carried into
	    the fresh chat tab so files picked before a conversation exists aren't lost.
	    Runtime-only (blob data URLs) — never persisted across a session restart. */
	initialImages?: AttachedImage[];
	initialProject?: string;
	/** One-shot composer seeds for a chat tab opened from a `ryu://chat/new`
	    deep link. ChatPage consumes them once on mount: the prompt PRE-FILLS the
	    composer (never auto-sent), the agent/project pre-select. Harmless if they
	    linger on the tab object after consumption. */
	initialPrompt?: string;
	/** When true, the seeded `initialPrompt` (and any `initialImages`) is SENT
	    automatically once the chat is ready, rather than only pre-filling the
	    composer. Set ONLY for user-initiated sends (the launchpad composer) — the
	    `ryu://chat/new` deep link and Inbox suggestions leave this unset so their
	    attacker-/system-controllable text stays pre-fill-only. Runtime-only. */
	initialSubmit?: boolean;
	/** Bumped each time this tab is navigated in place ("open in current tab").
	    Folded into the pane's React key so a reused tab remounts its page — pages
	    like ChatPage seed state from props once on mount, so without a remount an
	    in-place navigation would keep showing the previous thread. Runtime-only;
	    never persisted. */
	navToken?: number;
	path: string;
	/** Pinned tabs sit in a compact block at the left and never auto-unload. */
	pinned?: boolean;
	/** Membership in a Split view (see `splits`). Mirrors `groupId`: the tab is
	    the source of truth for its split membership, so `normalize` keeps split
	    members contiguous and the strip can bracket them. A tab is never both
	    split and grouped, and split members are never pinned. */
	splitId?: string;
	title: string;
	/** When true the tab's React tree is unmounted to free memory; it remounts
	    (cold) the next time the tab is activated. */
	unloaded?: boolean;
}

/** A Chrome-style tab group: a named, colored bracket over contiguous tabs. */
export interface TabGroup {
	collapsed: boolean;
	color: TabGroupColor;
	id: string;
	name: string;
}

/** A Warp-style split view: two or more tabs tiled in the main content area.
    Membership lives on the tabs (`tab.splitId`) — that is what `normalize`
    and the strip brackets read — while `root` carries the visual arrangement:
    a tree of branches (columns = side-by-side, rows = stacked) whose leaves
    are the member tabs, supporting arbitrary nesting (e.g. one tall pane
    beside two stacked ones). The split is shown whenever the focused tab
    (`activeTabId`) is one of its members; its other members render alongside,
    all kept live. The tree's leaves and the members are kept in lockstep by
    `reconcileSplits`. */
export interface Split {
	id: string;
	root: SplitBranch;
}

/** The split the given tab belongs to (resolved via `tab.splitId`), or
    undefined. Pure so components can derive a tab's split from the tabs +
    splits they already subscribe to. */
export function findSplit(
	tabs: Tab[],
	splits: Split[],
	tabId: string | undefined
): Split | undefined {
	if (!tabId) {
		return undefined;
	}
	const splitId = tabs.find((t) => t.id === tabId)?.splitId;
	if (!splitId) {
		return undefined;
	}
	return splits.find((s) => s.id === splitId);
}

/** Members of a split, in strip (tab) order. */
export function splitMembers(tabs: Tab[], splitId: string): Tab[] {
	return tabs.filter((t) => t.splitId === splitId);
}

/** Members of a split in PANE order (the tree's depth-first leaf order) —
    the order the content area tiles them. */
export function splitPaneTabs(tabs: Tab[], split: Split): Tab[] {
	const byId = new Map(tabs.map((t) => [t.id, t]));
	return leafOrder(split.root)
		.map((id) => byId.get(id))
		.filter((t): t is Tab => !!t);
}

/** Reconcile the split trees against current tab membership: drop splits with
    fewer than two members, prune leaves whose tab left, and (as a safety net)
    re-attach members missing from the tree so a pane can never silently
    disappear. Pure — used inside setSplits updaters. */
function reconcileSplits(splits: Split[], tabs: Tab[]): Split[] {
	const out: Split[] = [];
	for (const s of splits) {
		const members = tabs.filter((t) => t.splitId === s.id).map((t) => t.id);
		if (members.length < 2) {
			continue;
		}
		const pruned = pruneToMembers(s.root, new Set(members));
		if (!pruned || pruned.type === "leaf") {
			// The tree degenerated but ≥2 members remain — rebuild flat.
			out.push({
				id: s.id,
				root: makeBranch("columns", members.map(makeLeaf)),
			});
			continue;
		}
		const present = new Set(leafOrder(pruned));
		const missing = members.filter((id) => !present.has(id));
		out.push({
			id: s.id,
			root: missing.length > 0 ? appendLeaves(pruned, missing) : pruned,
		});
	}
	return out;
}

export const TAB_GROUP_COLORS = [
	"grey",
	"blue",
	"red",
	"yellow",
	"green",
	"pink",
	"purple",
	"cyan",
	"orange",
] as const;
export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

/** Shared localStorage key for the "unload inactive tabs after N minutes"
    preference. 0 disables auto-unload. Read by the timer here and written by the
    settings dialog so both sides agree without prop-drilling. */
export const TAB_UNLOAD_MINUTES_KEY = "ryu_tab_unload_minutes";

interface ClosedTab {
	index: number;
	tab: Tab;
}

interface TabsContextValue {
	activateTab: (id: string) => void;
	activeTabId: string;
	addTabToGroup: (tabId: string, groupId: string) => void;
	/** Join `tabId` to an existing split as a new pane at the end of its root
	    run (drag a tab onto a split bracket, or the "Add … to split" menu). */
	addTabToSplit: (splitId: string, tabId: string) => void;
	canGoBack: boolean;
	canGoForward: boolean;
	closeGroup: (groupId: string) => void;
	closeTab: (id: string) => void;
	// Grouping
	createGroup: (tabId: string) => string;
	/** Make `id` the focused pane without recording a navigation (used when
	    clicking between panes of an open split). */
	focusTab: (id: string) => void;
	goBack: () => void;
	goForward: () => void;
	groups: TabGroup[];
	hasClosedTabs: boolean;
	// Reordering (drag-and-drop in the title bar)
	moveTab: (draggedId: string, targetId: string, before: boolean) => void;
	openTab: (
		path: string,
		opts?: {
			title?: string;
			conversationId?: string;
			forceNew?: boolean;
			initialPrompt?: string;
			initialSubmit?: boolean;
			initialImages?: AttachedImage[];
			initialAgent?: string;
			initialProject?: string;
		}
	) => string;
	/** Drop a single tab out of its split (dissolving the split if <2 remain).*/
	removeFromSplit: (tabId: string) => void;
	removeTabFromGroup: (tabId: string) => void;
	renameGroup: (groupId: string, name: string) => void;
	restoreTab: () => void;
	setGroupColor: (groupId: string, color: TabGroupColor) => void;
	setSplitOrientation: (splitId: string, orientation: SplitOrientation) => void;
	/** Replace the size fractions of the branch at `path` (child indexes from
	    the root; [] targets the root itself). */
	setSplitSizes: (splitId: string, path: number[], sizes: number[]) => void;
	/** Tile `sourceTabId` next to `targetTabId` on the given side, nesting the
	    layout as needed (the drag-a-tab-onto-a-pane-edge gesture). Creates a
	    split when the target isn't in one; moves the source pane when it is. */
	splitPane: (
		sourceTabId: string,
		targetTabId: string,
		direction: SplitDirection
	) => void;
	splits: Split[];
	// Split view
	/** Put `tabIds` (deduped, ≥2) into a new flat split, replacing any prior
	    split membership of those tabs; focuses the first. */
	splitTabs: (tabIds: string[], orientation?: SplitOrientation) => void;
	/** Swap the pane positions of two members of the same split. */
	swapSplitPanes: (aTabId: string, bTabId: string) => void;
	tabs: Tab[];
	toggleGroupCollapsed: (groupId: string) => void;
	// Pinning
	togglePin: (id: string) => void;
	ungroup: (groupId: string) => void;
	// Unloading
	unloadTab: (id: string) => void;
	/** Dissolve the entire split that `tabId` belongs to. */
	unsplit: (tabId: string) => void;
	updateTabTitle: (id: string, title: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);
const IsActiveTabContext = createContext<boolean>(true);

// The id of the tab a subtree is rendered under. Undefined when rendered
// outside any tab (e.g. the sidebar), so node-aware hooks fall back to the
// default node rather than a per-tab override.
const CurrentTabIdContext = createContext<string | undefined>(undefined);

export function CurrentTabIdProvider({
	tabId,
	children,
}: {
	tabId: string;
	children: ReactNode;
}) {
	return (
		<CurrentTabIdContext.Provider value={tabId}>
			{children}
		</CurrentTabIdContext.Provider>
	);
}

export function useCurrentTabId(): string | undefined {
	return useContext(CurrentTabIdContext);
}

export function IsActiveTabProvider({
	isActive,
	children,
}: {
	isActive: boolean;
	children: ReactNode;
}) {
	return (
		<IsActiveTabContext.Provider value={isActive}>
			{children}
		</IsActiveTabContext.Provider>
	);
}

export function useIsActiveTab(): boolean {
	return useContext(IsActiveTabContext);
}

export function useTabsContext(): TabsContextValue {
	const ctx = useContext(TabsContext);
	if (!ctx) {
		throw new Error("useTabsContext must be inside TabsProvider");
	}
	return ctx;
}

const PATH_TITLES: Record<string, string> = {
	"/home": "Home",
	"/chat": "New chat",
	"/agents": "Agents",
	"/library": "Library",
	// Library section tabs (Agents/Spaces/Workflows consolidated into the Library).
	"/library/agent": "Agents",
	"/library/space": "Spaces",
	"/library/workflow": "Workflows",
	"/library/chat": "Chats",
	"/library/memory": "Memory",
	"/engines": "Engines",
	"/store": "Customize",
	"/store/agents": "Customize",
	"/models": "Models",
	"/skills": "Skills",
	"/spaces": "Spaces",
	"/tools": "Tools",
	"/workflows": "Workflows",
	"/workflows/build": "Build a workflow",
	"/calendar": "Calendar",
	"/approvals": "Inbox",
	"/settings": "Settings",
	"/extensions": "Extensions",
	"/apps": "Plugins",
	"/fleet": "Installed",
};

function makeTabId(): string {
	return `tab-${crypto.randomUUID()}`;
}

function makeGroupId(): string {
	return `grp-${crypto.randomUUID()}`;
}

function makeSplitId(): string {
	return `split-${crypto.randomUUID()}`;
}

const AGENT_EDIT_TITLE_RE = /^\/agents\/.+\/edit$/;

function defaultTitle(path: string): string {
	const base = path.split("?")[0];
	// Handle agent edit paths like /agents/abc123/edit
	if (AGENT_EDIT_TITLE_RE.test(base)) {
		return base.includes("/new/") ? "New agent" : "Edit agent";
	}
	return PATH_TITLES[base] ?? base.split("/").filter(Boolean).at(-1) ?? "Page";
}

// /chat tabs can have multiple instances; all other paths are singletons
function isSingleton(path: string): boolean {
	const base = path.split("?")[0];
	return base !== "/chat";
}

// Pick the first group color not already in use, so new groups are visually
// distinct until the palette wraps around.
function nextGroupColor(groups: TabGroup[]): TabGroupColor {
	const used = new Set(groups.map((g) => g.color));
	return TAB_GROUP_COLORS.find((c) => !used.has(c)) ?? TAB_GROUP_COLORS[0];
}

// A tab's "cluster" for contiguity: its group, else its split, else none. A tab
// is never both (joining either detaches it from the other), so one key suffices
// to keep both groups and splits rendered as a single contiguous bracket.
function clusterKey(t: Tab): string | undefined {
	if (t.groupId) {
		return `g:${t.groupId}`;
	}
	if (t.splitId) {
		return `s:${t.splitId}`;
	}
	return undefined;
}

// Reorder so pinned tabs lead and clustered tabs (groups + splits) are
// contiguous. Pinned tabs keep their relative order at the front; each cluster
// is emitted as one block at the position of its first member; unclustered tabs
// hold their place. This is what lets the title bar render a group/split as a
// single bracket without drag-and-drop.
function normalize(tabs: Tab[]): Tab[] {
	const pinned = tabs.filter((t) => t.pinned);
	const unpinned = tabs.filter((t) => !t.pinned);
	const result: Tab[] = [];
	const emitted = new Set<string>();
	for (const t of unpinned) {
		const key = clusterKey(t);
		if (key) {
			if (emitted.has(key)) {
				continue;
			}
			emitted.add(key);
			for (const m of unpinned) {
				if (clusterKey(m) === key) {
					result.push(m);
				}
			}
		} else {
			result.push(t);
		}
	}
	return [...pinned, ...result];
}

/** A tab to open the window on instead of the default blank chat — used by the
    "open in new window" tear-off to seed the new window with one conversation. */
export interface InitialTab {
	conversationId?: string;
	/** Pin this window's seeded tab to a specific node (carried from the source
	    tab so a remote-targeted chat keeps targeting that node). */
	node?: string;
	path: string;
	title?: string;
}

/** localStorage key holding the previous session's open tabs, so the "restore
    previous tabs" startup behavior can reopen them. Written by the main window
    on every tab change; read once at launch. */
const SESSION_TABS_KEY = "ryu_session_tabs";

/** The serializable subset of a Tab persisted for session restore. Runtime-only
    fields (ids, one-shot composer seeds, unload flags, group membership) are
    intentionally dropped; split layouts ARE persisted (see
    `PersistedSession.splits`) so a tiled workspace survives a relaunch. */
interface PersistedTab {
	conversationId?: string;
	initialAgent?: string;
	initialProject?: string;
	path: string;
	pinned?: boolean;
	title: string;
}

/** A split tree serialized over tab INDEXES (ids are regenerated on restore):
    a leaf is `{ i }`, a branch is `{ o, s, c }`. */
type PersistedSplitNode =
	| { i: number }
	| { c: PersistedSplitNode[]; o: SplitOrientation; s: number[] };

interface PersistedSession {
	/** Index into `tabs` of the tab that was active, so restore can refocus it. */
	activeIndex: number;
	/** Root branch of each split, over tab indexes. */
	splits?: PersistedSplitNode[];
	tabs: PersistedTab[];
}

function persistSplitNode(
	node: SplitNode,
	indexOf: Map<string, number>
): PersistedSplitNode | null {
	if (node.type === "leaf") {
		const i = indexOf.get(node.tabId);
		return i === undefined ? null : { i };
	}
	const c: PersistedSplitNode[] = [];
	const s: number[] = [];
	node.children.forEach((child, j) => {
		const kept = persistSplitNode(child, indexOf);
		if (kept) {
			c.push(kept);
			s.push(node.sizes[j] ?? 0);
		}
	});
	if (c.length === 0) {
		return null;
	}
	if (c.length === 1) {
		return c[0];
	}
	return { o: node.orientation, s, c };
}

function reviveSplitNode(
	node: PersistedSplitNode,
	idAt: (i: number) => string | undefined
): SplitNode | null {
	if ("i" in node) {
		const id = idAt(node.i);
		return id ? makeLeaf(id) : null;
	}
	if (!(Array.isArray(node.c) && node.c.length > 0)) {
		return null;
	}
	const orientation: SplitOrientation = node.o === "rows" ? "rows" : "columns";
	const children: SplitNode[] = [];
	const sizes: number[] = [];
	node.c.forEach((child, j) => {
		const revived = reviveSplitNode(child, idAt);
		if (revived) {
			children.push(revived);
			sizes.push(
				typeof node.s?.[j] === "number" && node.s[j] > 0 ? node.s[j] : 0
			);
		}
	});
	if (children.length === 0) {
		return null;
	}
	const branch = makeBranch(
		orientation,
		children,
		sizes.every((v) => v > 0) ? sizes : undefined
	);
	return normalizeNode(branch);
}

function persistSession(tabs: Tab[], activeTabId: string, splits: Split[]) {
	try {
		if (tabs.length === 0) {
			localStorage.removeItem(SESSION_TABS_KEY);
			return;
		}
		const persisted: PersistedTab[] = tabs.map((t) => ({
			path: t.path,
			title: t.title,
			conversationId: t.conversationId,
			initialAgent: t.initialAgent,
			initialProject: t.initialProject,
			pinned: t.pinned,
		}));
		const activeIndex = Math.max(
			0,
			tabs.findIndex((t) => t.id === activeTabId)
		);
		const indexOf = new Map(tabs.map((t, i) => [t.id, i]));
		const persistedSplits = splits
			.map((s) => persistSplitNode(s.root, indexOf))
			.filter((n): n is PersistedSplitNode => !!n && "c" in n);
		const payload: PersistedSession = {
			tabs: persisted,
			activeIndex,
			splits: persistedSplits.length > 0 ? persistedSplits : undefined,
		};
		localStorage.setItem(SESSION_TABS_KEY, JSON.stringify(payload));
	} catch {
		// Persisting the session is best-effort; ignore storage/serialize failures.
	}
}

interface StartupState {
	activeId: string;
	splits: Split[];
	tabs: Tab[];
}

function restoreSession(): StartupState | null {
	try {
		const raw = localStorage.getItem(SESSION_TABS_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as PersistedSession;
		if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
			return null;
		}
		const mapped: Tab[] = parsed.tabs.map((t) => ({
			id: makeTabId(),
			path: t.path,
			title: t.title,
			conversationId: t.conversationId,
			initialAgent: t.initialAgent,
			initialProject: t.initialProject,
			pinned: t.pinned,
		}));
		// Revive split layouts over the fresh ids, then stamp membership onto the
		// member tabs (membership drives normalize + the strip brackets).
		const splits: Split[] = [];
		for (const node of parsed.splits ?? []) {
			const revived = reviveSplitNode(node, (i) => mapped[i]?.id);
			if (!revived || revived.type === "leaf") {
				continue;
			}
			const id = makeSplitId();
			const memberIds = new Set(leafOrder(revived));
			for (const t of mapped) {
				// A tab can only be in one split; pinned tabs never split.
				if (memberIds.has(t.id) && !(t.splitId || t.pinned)) {
					t.splitId = id;
				}
			}
			splits.push({ id, root: revived });
		}
		const reconciled = reconcileSplits(splits, mapped);
		const liveIds = new Set(reconciled.map((s) => s.id));
		for (const t of mapped) {
			if (t.splitId && !liveIds.has(t.splitId)) {
				t.splitId = undefined;
			}
		}
		const idx = Math.min(
			Math.max(0, parsed.activeIndex ?? 0),
			mapped.length - 1
		);
		// Focus id is resolved before normalize reorders (pinned-lead), so it
		// tracks the tab the user last viewed rather than a shifted position.
		const activeId = mapped[idx].id;
		return { tabs: normalize(mapped), activeId, splits: reconciled };
	} catch {
		return null;
	}
}

/** The tabs + focused tab a fresh main window opens with, per the user's
    "On startup" preference (see `useStartupBehavior`). Tear-off windows bypass
    this — they seed from their `InitialTab` instead. */
function computeStartupState(): StartupState {
	const behavior = readStartupBehavior();
	if (behavior === "restore") {
		return restoreSession() ?? { tabs: [], activeId: "", splits: [] };
	}
	if (behavior === "home") {
		const id = makeTabId();
		return {
			tabs: [{ id, path: "/home", title: "Home" }],
			activeId: id,
			splits: [],
		};
	}
	if (behavior === "chat") {
		const id = makeTabId();
		return {
			tabs: [{ id, path: "/chat", title: "New chat" }],
			activeId: id,
			splits: [],
		};
	}
	// "empty" (the default): open with no tabs — the launchpad home.
	return { tabs: [], activeId: "", splits: [] };
}

export function TabsProvider({
	children,
	initialTab,
}: {
	children: ReactNode;
	initialTab?: InitialTab;
}) {
	// The main window opens per the "On startup" preference; a tear-off window
	// (spawned with an `initialTab`) always seeds from that one conversation.
	const [initialState] = useState<StartupState>(() => {
		if (initialTab) {
			const id = makeTabId();
			return {
				tabs: [
					{
						id,
						path: initialTab.path.split("?")[0],
						title: initialTab.title ?? defaultTitle(initialTab.path),
						conversationId: initialTab.conversationId,
					},
				],
				activeId: id,
				splits: [],
			};
		}
		return computeStartupState();
	});
	const [tabs, setTabs] = useState<Tab[]>(initialState.tabs);

	// Carry the source tab's node binding into this window by registering it as a
	// per-tab override on the seeded tab (window-local; never touches nodes.json).
	const seededNode = initialTab?.node;
	useEffect(() => {
		if (seededNode) {
			useNodeStore.getState().setTabOverride(initialState.activeId, seededNode);
		}
	}, [seededNode, initialState.activeId]);
	const [groups, setGroups] = useState<TabGroup[]>([]);
	const [splits, setSplits] = useState<Split[]>(initialState.splits);
	const [activeTabId, setActiveTabId] = useState<string>(initialState.activeId);
	const [closedTabs, setClosedTabs] = useState<ClosedTab[]>([]);

	// Ref for synchronous reads inside callbacks without stale closure issues
	const tabsRef = useRef<Tab[]>(tabs);
	tabsRef.current = tabs;

	// Kept in sync with `splits` so callbacks (close/unload/timer) can read the
	// current split layout without a stale closure.
	const splitsRef = useRef<Split[]>(splits);
	splitsRef.current = splits;

	// Last time each tab was the active view, keyed by tab id. Held in a ref (not
	// tab state) so stamping it on every activation doesn't churn renders; the
	// auto-unload timer reads it directly.
	const lastActiveAtRef = useRef<Record<string, number>>({});
	const activeTabIdRef = useRef<string>(activeTabId);
	activeTabIdRef.current = activeTabId;

	// Managed-path numeric cap on OPEN TABS (free-tier gating). Held in refs so the
	// openTab callback reads the live limit + upgrade opener without re-creating on
	// every entitlement change. Off the managed path the limit is Infinity, so
	// self-host / local-Core-without-billing is never capped.
	const { verdict, requestUpgrade } = useEntitlementContext();
	const tabLimitRef = useRef<number>(Number.POSITIVE_INFINITY);
	tabLimitRef.current = hasBillingAuth()
		? planLimit(effectivePlan(verdict), "maxOpenTabs")
		: Number.POSITIVE_INFINITY;
	const requestUpgradeRef = useRef(requestUpgrade);
	requestUpgradeRef.current = requestUpgrade;

	// Global navigation history of activated views. Each tab is a single
	// immutable page, so the only meaningful back/forward is the sequence of
	// active tabs (browser-style). The pointer marks the current position;
	// organic navigations truncate any forward entries.
	const historyRef = useRef<string[]>(
		initialState.activeId ? [initialState.activeId] : []
	);
	const pointerRef = useRef(0);
	const [canGoBack, setCanGoBack] = useState(false);
	const [canGoForward, setCanGoForward] = useState(false);

	const syncNav = useCallback(() => {
		setCanGoBack(pointerRef.current > 0);
		setCanGoForward(pointerRef.current < historyRef.current.length - 1);
	}, []);

	// Record an organic navigation to `id`. Dedupes a no-op re-activation and
	// drops the forward stack so a new branch replaces redo history.
	const pushHistory = useCallback(
		(id: string) => {
			const hist = historyRef.current;
			if (hist[pointerRef.current] === id) {
				return;
			}
			const next = hist.slice(0, pointerRef.current + 1);
			next.push(id);
			historyRef.current = next;
			pointerRef.current = next.length - 1;
			syncNav();
		},
		[syncNav]
	);

	// Make `id` the active view: stamp its last-active time and clear any
	// unloaded flag (activating an unloaded tab remounts it). Centralizes the
	// state every entry point into a tab must keep consistent.
	const markActive = useCallback((id: string) => {
		// Stamp the outgoing tab with the moment it stops being viewed — that is
		// what the auto-unload timer measures idle time against. Stamp the
		// incoming tab too so every tab always has an entry.
		const previous = activeTabIdRef.current;
		if (previous && previous !== id) {
			lastActiveAtRef.current[previous] = Date.now();
		}
		lastActiveAtRef.current[id] = Date.now();
		// Keep the ref authoritative so the auto-unload timer and any synchronous
		// follow-up never read a stale active id.
		activeTabIdRef.current = id;
		setActiveTabId(id);
		setTabs((prev) => {
			// Activating a split member shows the whole split, so wake every pane in
			// it — not just the focused one — or a sibling pane would stay blank.
			const splitId = prev.find((t) => t.id === id)?.splitId;
			const toLoad = new Set(
				splitId
					? prev.filter((t) => t.splitId === splitId).map((t) => t.id)
					: [id]
			);
			if (!prev.some((t) => toLoad.has(t.id) && t.unloaded)) {
				return prev;
			}
			const next = prev.map((t) =>
				toLoad.has(t.id) && t.unloaded ? { ...t, unloaded: false } : t
			);
			tabsRef.current = next;
			return next;
		});
		// Activating a tab inside a collapsed group expands the group so the tab
		// is visible (Chrome behavior).
		setGroups((prev) => {
			const gid = tabsRef.current.find((t) => t.id === id)?.groupId;
			if (!gid) {
				return prev;
			}
			const g = prev.find((x) => x.id === gid);
			if (!g?.collapsed) {
				return prev;
			}
			return prev.map((x) => (x.id === gid ? { ...x, collapsed: false } : x));
		});
	}, []);

	const openTab = useCallback(
		(
			path: string,
			opts?: {
				title?: string;
				conversationId?: string;
				forceNew?: boolean;
				initialPrompt?: string;
				initialSubmit?: boolean;
				initialImages?: AttachedImage[];
				initialAgent?: string;
				initialProject?: string;
			}
			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
		): string => {
			const current = tabsRef.current;
			const base = path.split("?")[0];

			// Record the visit so the Library's Recents tab reflects navigation
			// from anywhere (sidebar, palette, Library). No-ops for routes that
			// carry no resolvable item.
			stampRecentFromPath(base, opts?.conversationId);

			// The unified Library is one tab that switches sections in place: any
			// `/library` or `/library/<section>` navigation reuses an existing
			// Library tab and swaps its section (bumping navToken to force a remount
			// so LibraryPage re-reads `initialSection`) rather than stacking a second
			// Library tab. Falls through to normal singleton creation when none is open.
			const isLibraryPath = base === "/library" || base.startsWith("/library/");
			if (isLibraryPath && !opts?.forceNew) {
				const existing = current.find(
					(t) => t.path === "/library" || t.path.startsWith("/library/")
				);
				if (existing) {
					if (existing.path !== base) {
						const reused: Tab = {
							...existing,
							path: base,
							title: opts?.title ?? defaultTitle(path),
							navToken: (existing.navToken ?? 0) + 1,
						};
						setTabs((prev) => {
							const next = normalize(
								prev.map((t) => (t.id === reused.id ? reused : t))
							);
							tabsRef.current = next;
							return next;
						});
					}
					markActive(existing.id);
					pushHistory(existing.id);
					return existing.id;
				}
			}

			if (isSingleton(base) && !opts?.forceNew) {
				const existing = current.find((t) => t.path === base);
				if (existing) {
					markActive(existing.id);
					pushHistory(existing.id);
					return existing.id;
				}
			}

			if (!opts?.forceNew && opts?.conversationId) {
				const existing = current.find(
					(t) => t.path === "/chat" && t.conversationId === opts.conversationId
				);
				if (existing) {
					markActive(existing.id);
					pushHistory(existing.id);
					return existing.id;
				}
			}

			// "Open in current tab" preference (default is a fresh tab, Chrome-style).
			// When on, navigation reuses the focused tab in place instead of stacking
			// a new one — unless the caller forces a new tab, or the focused tab is
			// pinned or a split member (both are "kept" and must not be replaced out
			// from under the user). Content is keyed by tab id and rendered from
			// `path`, so swapping the path re-renders the pane with the new page.
			const activeTab = current.find((t) => t.id === activeTabIdRef.current);
			if (
				readTabOpenBehavior() === "current" &&
				!opts?.forceNew &&
				activeTab &&
				!activeTab.pinned &&
				!activeTab.splitId
			) {
				const reused: Tab = {
					...activeTab,
					path: base,
					title: opts?.title ?? defaultTitle(path),
					conversationId: opts?.conversationId,
					initialPrompt: opts?.initialPrompt,
					initialSubmit: opts?.initialSubmit,
					initialImages: opts?.initialImages,
					initialAgent: opts?.initialAgent,
					initialProject: opts?.initialProject,
					// Force a fresh mount so the page re-seeds from the new props
					// (otherwise ChatPage keeps rendering the previous thread).
					navToken: (activeTab.navToken ?? 0) + 1,
					unloaded: false,
				};
				setTabs((prev) => {
					const next = normalize(
						prev.map((t) => (t.id === reused.id ? reused : t))
					);
					tabsRef.current = next;
					return next;
				});
				markActive(reused.id);
				pushHistory(reused.id);
				return reused.id;
			}

			// Only a genuinely-new tab counts against the cap; every reuse / singleton
			// / open-in-current branch above returns early and is never blocked, so
			// navigating to an already-open surface at the cap still works. When over
			// the cap, open the upgrade modal and keep the user on the active tab.
			if (tabsRef.current.length >= tabLimitRef.current) {
				requestUpgradeRef.current();
				return activeTabIdRef.current;
			}

			const newTab: Tab = {
				id: makeTabId(),
				path: base,
				title: opts?.title ?? defaultTitle(path),
				conversationId: opts?.conversationId,
				initialPrompt: opts?.initialPrompt,
				initialSubmit: opts?.initialSubmit,
				initialImages: opts?.initialImages,
				initialAgent: opts?.initialAgent,
				initialProject: opts?.initialProject,
			};
			setTabs((prev) => {
				const next = normalize([...prev, newTab]);
				tabsRef.current = next;
				return next;
			});
			markActive(newTab.id);
			pushHistory(newTab.id);
			return newTab.id;
		},
		[markActive, pushHistory]
	);

	const closeTab = useCallback(
		(id: string) => {
			// Drop any per-tab node override so the in-memory map doesn't keep stale
			// entries for tabs that no longer exist.
			useNodeStore.getState().clearTabOverride(id);
			delete lastActiveAtRef.current[id];
			// Prune the closed tab from nav history and clamp the pointer so
			// back/forward never lands on a dead view. Revealing a neighbor is not
			// itself a forward navigation, so we don't push it.
			const removedBeforePointer = historyRef.current
				.slice(0, pointerRef.current)
				.filter((h) => h === id).length;
			historyRef.current = historyRef.current.filter((h) => h !== id);
			pointerRef.current = Math.max(
				0,
				Math.min(
					historyRef.current.length - 1,
					pointerRef.current - removedBeforePointer
				)
			);
			syncNav();
			// Work off tabsRef (kept in sync with the tabs state) so the new active
			// tab and the trimmed list are computed together, without nesting one
			// state setter's side effects inside another's deferred updater.
			const prev = tabsRef.current;
			const idx = prev.findIndex((t) => t.id === id);
			if (idx === -1) {
				return;
			}
			setClosedTabs((stack) => [...stack, { tab: prev[idx], index: idx }]);
			// If the tab is part of a split, its surviving siblings stay together.
			// Prefer focusing one of them so the split remains visible after the
			// close, rather than jumping to an unrelated neighbor tab.
			const closingSplitId = prev[idx].splitId;
			const siblings = closingSplitId
				? prev
						.filter((t) => t.splitId === closingSplitId && t.id !== id)
						.map((t) => t.id)
				: [];
			// Allow the tab list to reach zero — closing the final tab leaves an empty
			// window (handled by Layout's empty state) rather than respawning a tab or
			// quitting the app. A new tab is one click away via the titlebar + button.
			let next = prev.filter((t) => t.id !== id);
			const wasActive = activeTabIdRef.current === id;
			let nextActive = activeTabIdRef.current;
			if (wasActive) {
				if (next.length === 0) {
					nextActive = "";
				} else {
					const fallback =
						siblings[0] ?? (next[Math.min(idx, next.length - 1)] ?? next[0]).id;
					lastActiveAtRef.current[fallback] = Date.now();
					// The revealed neighbor becomes active, so make sure it is loaded —
					// an unloaded tab must never be the visible one.
					next = next.map((t) =>
						t.id === fallback ? { ...t, unloaded: false } : t
					);
					nextActive = fallback;
				}
			}
			// The closed tab's split membership vanishes with it. If that leaves the
			// split with a single member, dissolve it (clear the lone member's
			// splitId); otherwise reconcile the tree — the closed pane's leaf is
			// pruned and its space flows back to its siblings.
			if (closingSplitId) {
				const remaining = next.filter((t) => t.splitId === closingSplitId);
				if (remaining.length < 2) {
					next = next.map((t) =>
						t.splitId === closingSplitId ? { ...t, splitId: undefined } : t
					);
				}
				setSplits((prevSplits) => reconcileSplits(prevSplits, next));
			}
			tabsRef.current = next;
			setTabs(next);
			if (wasActive) {
				activeTabIdRef.current = nextActive;
				setActiveTabId(nextActive);
			}
			// Drop now-empty groups so stale brackets don't linger, and expand the
			// group the revealed tab belongs to so its chip is actually visible.
			const fallbackGroupId = next.find((t) => t.id === nextActive)?.groupId;
			setGroups((groups2) =>
				groups2
					.filter((g) => next.some((t) => t.groupId === g.id))
					.map((g) =>
						g.id === fallbackGroupId ? { ...g, collapsed: false } : g
					)
			);
		},
		[syncNav]
	);

	const restoreTab = useCallback(() => {
		setClosedTabs((stack) => {
			if (stack.length === 0) {
				return stack;
			}
			const { tab, index } = stack.at(-1);
			// Drop any stale split membership — the split was almost certainly
			// dissolved when this tab closed, so restore it as a standalone tab.
			const restored: Tab = {
				...tab,
				id: makeTabId(),
				unloaded: false,
				splitId: undefined,
			};
			setTabs((prev) => {
				const next = [...prev];
				next.splice(Math.min(index, next.length), 0, restored);
				const normalized = normalize(next);
				tabsRef.current = normalized;
				return normalized;
			});
			markActive(restored.id);
			pushHistory(restored.id);
			return stack.slice(0, -1);
		});
	}, [markActive, pushHistory]);

	const activateTab = useCallback(
		(id: string) => {
			markActive(id);
			pushHistory(id);
		},
		[markActive, pushHistory]
	);

	// Focus a pane without recording navigation history — clicking between the
	// panes of an open split should not pollute back/forward with every shift.
	const focusTab = useCallback(
		(id: string) => {
			markActive(id);
		},
		[markActive]
	);

	// Move the history pointer and activate the view there. These do not push
	// new history — they walk the existing stack like a browser's back/forward.
	const goBack = useCallback(() => {
		if (pointerRef.current <= 0) {
			return;
		}
		pointerRef.current -= 1;
		markActive(historyRef.current[pointerRef.current]);
		syncNav();
	}, [markActive, syncNav]);

	const goForward = useCallback(() => {
		if (pointerRef.current >= historyRef.current.length - 1) {
			return;
		}
		pointerRef.current += 1;
		markActive(historyRef.current[pointerRef.current]);
		syncNav();
	}, [markActive, syncNav]);

	const updateTabTitle = useCallback((id: string, title: string) => {
		setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
	}, []);

	// --- Reordering ------------------------------------------------------------
	// Move `draggedId` to sit before/after `targetId` in the strip, then re-run
	// normalize so the pinned-lead and contiguous-group invariants always hold
	// (e.g. dropping a tab into the middle of a group keeps the group together).
	const moveTab = useCallback(
		(draggedId: string, targetId: string, before: boolean) => {
			if (draggedId === targetId) {
				return;
			}
			setTabs((prev) => {
				const dragged = prev.find((t) => t.id === draggedId);
				if (!dragged) {
					return prev;
				}
				const without = prev.filter((t) => t.id !== draggedId);
				const targetIdx = without.findIndex((t) => t.id === targetId);
				if (targetIdx === -1) {
					return prev;
				}
				const insertAt = before ? targetIdx : targetIdx + 1;
				const reordered = [
					...without.slice(0, insertAt),
					dragged,
					...without.slice(insertAt),
				];
				const next = normalize(reordered);
				tabsRef.current = next;
				return next;
			});
		},
		[]
	);

	// Reconcile the split trees against current tab membership (drop dissolved
	// splits, prune departed leaves). Reads tabsRef, so call it after the
	// setTabs that changed membership.
	const pruneSplits = useCallback(() => {
		setSplits((prev) => reconcileSplits(prev, tabsRef.current));
	}, []);

	// --- Pinning ---------------------------------------------------------------
	const togglePin = useCallback(
		(id: string) => {
			setTabs((prev) => {
				const target = prev.find((t) => t.id === id);
				if (!target) {
					return prev;
				}
				const pinning = !target.pinned;
				// Pinning detaches a tab from its group and split (Chrome behavior); a
				// pinned tab is icon-only and can't host a side-by-side pane.
				const detachedSplitId = pinning ? target.splitId : undefined;
				let mapped = prev.map((t) =>
					t.id === id
						? {
								...t,
								pinned: pinning,
								groupId: pinning ? undefined : t.groupId,
								splitId: pinning ? undefined : t.splitId,
							}
						: t
				);
				// If pulling this tab out left a split with a single member, dissolve it.
				if (
					detachedSplitId &&
					mapped.filter((t) => t.splitId === detachedSplitId).length < 2
				) {
					mapped = mapped.map((t) =>
						t.splitId === detachedSplitId ? { ...t, splitId: undefined } : t
					);
				}
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			// A pin may have emptied a group or split.
			setGroups((prev) =>
				prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
			);
			pruneSplits();
		},
		[pruneSplits]
	);

	// --- Unloading -------------------------------------------------------------
	const unloadTab = useCallback((id: string) => {
		// Never unload the tab the user is currently looking at.
		if (id === activeTabIdRef.current) {
			return;
		}
		// Never unload a pane that is currently visible as part of the active
		// split — it would blank a side-by-side view the user is still using.
		const activeSplitId = tabsRef.current.find(
			(t) => t.id === activeTabIdRef.current
		)?.splitId;
		const targetSplitId = tabsRef.current.find((t) => t.id === id)?.splitId;
		if (activeSplitId && targetSplitId === activeSplitId) {
			return;
		}
		setTabs((prev) => {
			const next = prev.map((t) =>
				t.id === id ? { ...t, unloaded: true } : t
			);
			tabsRef.current = next;
			return next;
		});
	}, []);

	// --- Grouping --------------------------------------------------------------
	const addTabToGroup = useCallback(
		(tabId: string, groupId: string) => {
			setTabs((prev) => {
				const target = prev.find((t) => t.id === tabId);
				const detachedSplitId = target?.splitId;
				// Joining a group unpins and leaves any split (a tab is never both).
				let mapped = prev.map((t) =>
					t.id === tabId
						? { ...t, groupId, pinned: false, splitId: undefined }
						: t
				);
				if (
					detachedSplitId &&
					mapped.filter((t) => t.splitId === detachedSplitId).length < 2
				) {
					mapped = mapped.map((t) =>
						t.splitId === detachedSplitId ? { ...t, splitId: undefined } : t
					);
				}
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			pruneSplits();
		},
		[pruneSplits]
	);

	const createGroup = useCallback(
		(tabId: string): string => {
			const id = makeGroupId();
			setGroups((prev) => [
				...prev,
				{ id, name: "Group", color: nextGroupColor(prev), collapsed: false },
			]);
			addTabToGroup(tabId, id);
			return id;
		},
		[addTabToGroup]
	);

	const removeTabFromGroup = useCallback((tabId: string) => {
		setTabs((prev) => {
			const next = normalize(
				prev.map((t) => (t.id === tabId ? { ...t, groupId: undefined } : t))
			);
			tabsRef.current = next;
			return next;
		});
		setGroups((prev) =>
			prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
		);
	}, []);

	const renameGroup = useCallback((groupId: string, name: string) => {
		setGroups((prev) =>
			prev.map((g) => (g.id === groupId ? { ...g, name } : g))
		);
	}, []);

	const setGroupColor = useCallback((groupId: string, color: TabGroupColor) => {
		setGroups((prev) =>
			prev.map((g) => (g.id === groupId ? { ...g, color } : g))
		);
	}, []);

	const toggleGroupCollapsed = useCallback((groupId: string) => {
		setGroups((prev) =>
			prev.map((g) =>
				g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
			)
		);
	}, []);

	const ungroup = useCallback((groupId: string) => {
		setTabs((prev) => {
			const next = normalize(
				prev.map((t) =>
					t.groupId === groupId ? { ...t, groupId: undefined } : t
				)
			);
			tabsRef.current = next;
			return next;
		});
		setGroups((prev) => prev.filter((g) => g.id !== groupId));
	}, []);

	const closeGroup = useCallback(
		(groupId: string) => {
			const members = tabsRef.current
				.filter((t) => t.groupId === groupId)
				.map((t) => t.id);
			for (const id of members) {
				closeTab(id);
			}
		},
		[closeTab]
	);

	// --- Split view ------------------------------------------------------------
	const splitTabs = useCallback(
		(tabIds: string[], orientation: SplitOrientation = "columns") => {
			const unique = [...new Set(tabIds)].filter((id) =>
				tabsRef.current.some((t) => t.id === id)
			);
			if (unique.length < 2) {
				return;
			}
			const id = makeSplitId();
			// Assign the new splitId to every member (detaching them from pin/group —
			// a tab is never both), and wake them here: markActive below only wakes
			// the focused pane and reads a splitsRef this tick hasn't refreshed, so an
			// already-unloaded sibling would otherwise render blank. normalize then
			// makes the members contiguous so the strip brackets them as one block.
			setTabs((prev) => {
				const next = normalize(
					prev.map((t) =>
						unique.includes(t.id)
							? {
									...t,
									splitId: id,
									pinned: false,
									groupId: undefined,
									unloaded: false,
								}
							: t
					)
				);
				tabsRef.current = next;
				return next;
			});
			setGroups((prev) =>
				prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
			);
			// Add the new split, then prune any prior split a member was pulled out of.
			setSplits((prev) => [
				...prev,
				{ id, root: makeBranch(orientation, unique.map(makeLeaf)) },
			]);
			pruneSplits();
			markActive(unique[0]);
		},
		[markActive, pruneSplits]
	);

	const removeFromSplit = useCallback(
		(tabId: string) => {
			setTabs((prev) => {
				const splitId = prev.find((t) => t.id === tabId)?.splitId;
				if (!splitId) {
					return prev;
				}
				let mapped = prev.map((t) =>
					t.id === tabId ? { ...t, splitId: undefined } : t
				);
				// Dissolve the split if removing this pane leaves a single member.
				if (mapped.filter((t) => t.splitId === splitId).length < 2) {
					mapped = mapped.map((t) =>
						t.splitId === splitId ? { ...t, splitId: undefined } : t
					);
				}
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			pruneSplits();
		},
		[pruneSplits]
	);

	const unsplit = useCallback(
		(tabId: string) => {
			setTabs((prev) => {
				const splitId = prev.find((t) => t.id === tabId)?.splitId;
				if (!splitId) {
					return prev;
				}
				const next = normalize(
					prev.map((t) =>
						t.splitId === splitId ? { ...t, splitId: undefined } : t
					)
				);
				tabsRef.current = next;
				return next;
			});
			pruneSplits();
		},
		[pruneSplits]
	);

	// Flips the ROOT branch's axis. For a flat (unnested) split this is the
	// whole layout; for a nested one it re-tilts the outermost run while inner
	// branches keep their own axes — then normalize merges any child branch
	// that now matches the new root orientation.
	const setSplitOrientation = useCallback(
		(splitId: string, orientation: SplitOrientation) => {
			setSplits((prev) =>
				prev.map((s) => {
					if (s.id !== splitId || s.root.orientation === orientation) {
						return s;
					}
					const flipped = normalizeNode({ ...s.root, orientation });
					return flipped && flipped.type === "branch"
						? { ...s, root: flipped }
						: s;
				})
			);
		},
		[]
	);

	const setSplitSizes = useCallback(
		(splitId: string, path: number[], sizes: number[]) => {
			setSplits((prev) =>
				prev.map((s) =>
					s.id === splitId
						? { ...s, root: setSizesAt(s.root, path, sizes) as SplitBranch }
						: s
				)
			);
		},
		[]
	);

	// Tile `sourceTabId` beside `targetTabId` on the given side — the engine
	// behind every drag-to-split gesture. The source joins the target's split
	// (creating one when the target is standalone), nesting or sibling-inserting
	// per Warp semantics; when the source is already a member it MOVES to the
	// new position instead.
	const splitPane = useCallback(
		(sourceTabId: string, targetTabId: string, direction: SplitDirection) => {
			if (sourceTabId === targetTabId) {
				return;
			}
			const current = tabsRef.current;
			const source = current.find((t) => t.id === sourceTabId);
			const target = current.find((t) => t.id === targetTabId);
			if (!(source && target)) {
				return;
			}
			const targetSplitId = target.splitId;
			const splitId = targetSplitId ?? makeSplitId();
			const oldSplitId = source.splitId;
			// Membership first: both endpoints join `splitId` (detached from
			// pin/group — a tab is never both), and every member is woken here since
			// markActive below reads a splitsRef this tick hasn't refreshed.
			setTabs((prev) => {
				let mapped = prev.map((t) => {
					if (t.id === sourceTabId || t.id === targetTabId) {
						return {
							...t,
							splitId,
							pinned: false,
							groupId: undefined,
							unloaded: false,
						};
					}
					return t.splitId === splitId ? { ...t, unloaded: false } : t;
				});
				// If pulling the source out of a different split left it with a single
				// member, dissolve that split (clear the lone survivor's splitId).
				if (
					oldSplitId &&
					oldSplitId !== splitId &&
					mapped.filter((t) => t.splitId === oldSplitId).length < 2
				) {
					mapped = mapped.map((t) =>
						t.splitId === oldSplitId ? { ...t, splitId: undefined } : t
					);
				}
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			setGroups((prev) =>
				prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
			);
			setSplits((prev) => {
				let list: Split[];
				if (targetSplitId) {
					list = prev.map((s) => {
						if (s.id !== targetSplitId) {
							return s;
						}
						// Moving within the same split: pull the source leaf out first so
						// the insert can't duplicate it.
						let root: SplitNode | null = containsLeaf(s.root, sourceTabId)
							? removeLeaf(s.root, sourceTabId)
							: s.root;
						if (!(root && containsLeaf(root, targetTabId))) {
							root = makeLeaf(targetTabId);
						}
						const inserted = insertLeaf(
							root,
							targetTabId,
							sourceTabId,
							direction
						);
						const branch =
							inserted.type === "branch"
								? inserted
								: makeBranch(directionOrientation(direction), [inserted]);
						return { ...s, root: branch };
					});
				} else {
					const root = insertLeaf(
						makeLeaf(targetTabId),
						targetTabId,
						sourceTabId,
						direction
					);
					if (root.type !== "branch") {
						return prev;
					}
					list = [...prev, { id: splitId, root }];
				}
				return reconcileSplits(list, tabsRef.current);
			});
			markActive(sourceTabId);
		},
		[markActive]
	);

	// Swap the pane positions of two members of the same split (center-drop on
	// a pane). Membership and sizes stay put — only the leaves trade places.
	const swapSplitPanes = useCallback((aTabId: string, bTabId: string) => {
		if (aTabId === bTabId) {
			return;
		}
		const a = tabsRef.current.find((t) => t.id === aTabId);
		const b = tabsRef.current.find((t) => t.id === bTabId);
		if (!(a?.splitId && a.splitId === b?.splitId)) {
			return;
		}
		const splitId = a.splitId;
		setSplits((prev) =>
			prev.map((s) =>
				s.id === splitId
					? { ...s, root: swapLeaves(s.root, aTabId, bTabId) as SplitBranch }
					: s
			)
		);
	}, []);

	// Join `tabId` to an existing split as a new pane at the end of its root
	// run (equal share of space).
	const addTabToSplit = useCallback(
		(splitId: string, tabId: string) => {
			const tab = tabsRef.current.find((t) => t.id === tabId);
			const split = splitsRef.current.find((s) => s.id === splitId);
			if (!(tab && split) || tab.splitId === splitId) {
				return;
			}
			const oldSplitId = tab.splitId;
			setTabs((prev) => {
				let mapped = prev.map((t) => {
					if (t.id === tabId) {
						return {
							...t,
							splitId,
							pinned: false,
							groupId: undefined,
							unloaded: false,
						};
					}
					return t.splitId === splitId ? { ...t, unloaded: false } : t;
				});
				if (
					oldSplitId &&
					mapped.filter((t) => t.splitId === oldSplitId).length < 2
				) {
					mapped = mapped.map((t) =>
						t.splitId === oldSplitId ? { ...t, splitId: undefined } : t
					);
				}
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			setGroups((prev) =>
				prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
			);
			setSplits((prev) =>
				reconcileSplits(
					prev.map((s) =>
						s.id === splitId ? { ...s, root: appendLeaves(s.root, [tabId]) } : s
					),
					tabsRef.current
				)
			);
			markActive(tabId);
		},
		[markActive]
	);

	// --- Auto-unload timer -----------------------------------------------------
	// Periodically unloads inactive tabs once they pass the user-configured
	// idle threshold. The active tab and pinned tabs are always exempt. Disabled
	// when the threshold is 0 ("Never").
	useEffect(() => {
		const tick = () => {
			const minutes = readPersistedNumber(TAB_UNLOAD_MINUTES_KEY, 0);
			if (minutes <= 0) {
				return;
			}
			const cutoff = Date.now() - minutes * 60_000;
			// Every pane of the currently-visible split is exempt — unloading one
			// would blank a side-by-side view in active use.
			const activeSplitId = tabsRef.current.find(
				(t) => t.id === activeTabIdRef.current
			)?.splitId;
			const protectedIds = new Set(
				activeSplitId
					? tabsRef.current
							.filter((t) => t.splitId === activeSplitId)
							.map((t) => t.id)
					: []
			);
			setTabs((prev) => {
				let changed = false;
				const next = prev.map((t) => {
					if (
						t.id === activeTabIdRef.current ||
						t.pinned ||
						t.unloaded ||
						protectedIds.has(t.id)
					) {
						return t;
					}
					const lastActive = lastActiveAtRef.current[t.id];
					if (lastActive !== undefined && lastActive < cutoff) {
						changed = true;
						return { ...t, unloaded: true };
					}
					return t;
				});
				if (!changed) {
					return prev;
				}
				tabsRef.current = next;
				return next;
			});
		};
		const interval = setInterval(tick, 30_000);
		return () => clearInterval(interval);
	}, []);

	// --- Session persistence ---------------------------------------------------
	// Snapshot the main window's open tabs on every change so the "restore
	// previous tabs" startup behavior can reopen them next launch. Tear-off
	// windows (which carry an `initialTab`) never own the session snapshot — they
	// share localStorage, so letting them write would clobber the main window's.
	useEffect(() => {
		if (initialTab) {
			return;
		}
		persistSession(tabs, activeTabId, splits);
	}, [tabs, activeTabId, splits, initialTab]);

	return (
		<TabsContext.Provider
			value={{
				tabs,
				groups,
				splits,
				activeTabId,
				openTab,
				closeTab,
				activateTab,
				focusTab,
				updateTabTitle,
				restoreTab,
				hasClosedTabs: closedTabs.length > 0,
				goBack,
				goForward,
				canGoBack,
				canGoForward,
				moveTab,
				togglePin,
				unloadTab,
				createGroup,
				addTabToGroup,
				removeTabFromGroup,
				renameGroup,
				setGroupColor,
				toggleGroupCollapsed,
				ungroup,
				closeGroup,
				splitTabs,
				splitPane,
				swapSplitPanes,
				addTabToSplit,
				removeFromSplit,
				unsplit,
				setSplitOrientation,
				setSplitSizes,
			}}
		>
			{children}
		</TabsContext.Provider>
	);
}
