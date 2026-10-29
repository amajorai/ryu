import type { RyuJsonValue } from "@ryu/app-host/json-values";
import { asGlyphValue, type GlyphValue } from "@ryu/ui/components/glyph.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type {
	WorkbenchItem,
	WorkbenchSplitNode,
	WorkbenchState,
} from "@ryu/workbench/model";
import type { WorkbenchAction } from "@ryu/workbench/reducer";
import type { ReactNode } from "react";
import {
	createContext,
	use,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { TabNodeChatHistoryBoundary } from "@/src/contexts/TabNodeChatHistory.tsx";
import {
	bindConversation,
	findChatTab,
	findChatTabOnNode,
	tabNodeKey,
} from "@/src/contexts/tab-conversation.ts";
import { readPersistedNumber } from "@/src/hooks/usePersistedNumber.ts";
import { readStartupBehavior } from "@/src/hooks/useStartupBehavior.ts";
import { readTabOpenBehavior } from "@/src/hooks/useTabOpenBehavior.ts";
import { hasBillingAuth } from "@/src/lib/api/billing.ts";
import { sealedLocalStorage } from "@/src/lib/content-seal.ts";
import {
	DASHBOARD_DEFAULT_PATH,
	LEGACY_DASHBOARD_PATH,
} from "@/src/lib/dashboards/app.ts";
import { capLimit, effectivePlan } from "@/src/lib/gating/planCapBridge.ts";
import { stampRecentFromPath } from "@/src/lib/library.ts";
import {
	buildPresetTree,
	PANE_CHOOSER_PATH,
	type PresetBranch,
	type PresetNode,
	presetSlots,
} from "@/src/lib/splitPresets.ts";
import {
	leafOrder,
	makeLeaf,
	type SplitBranch,
	type SplitDirection,
	type SplitNode,
	type SplitOrientation,
} from "@/src/lib/splitTree.ts";
import {
	DEFAULT_TAB_UNLOAD_MINUTES,
	inactiveTabIds,
	initialTabActivity,
	TAB_UNLOAD_INTERVAL_MS,
	TAB_UNLOAD_MINUTES_KEY,
} from "@/src/lib/tab-memory-policy.ts";
import type { TabTransfer } from "@/src/lib/tab-transfer.ts";
import {
	listenForEntityActivation,
	registerWindowTabs,
	tabEntityKey,
} from "@/src/lib/window-routing.ts";
import {
	sameWorkspaceSessionState,
	type WorkspaceSessionState,
	workspaceSessionSchema,
} from "@/src/lib/workspace-session.ts";
import { useArtifactStore } from "@/src/store/useArtifactStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	DesktopWorkbenchProvider,
	useDesktopWorkbench,
	useOptionalDesktopWorkbench,
} from "@/src/workbench/DesktopWorkbenchContext.tsx";

export type {
	SplitBranch,
	SplitDirection,
	SplitNode,
	SplitOrientation,
} from "@/src/lib/splitTree.ts";

// Keep the historical import path available to desktop consumers while the
// preference's canonical owner lives with the pure tab-memory policy.
export { TAB_UNLOAD_MINUTES_KEY } from "@/src/lib/tab-memory-policy.ts";

export interface Tab {
	/** Live run in progress for this tab (streaming chat, etc.). Runtime-only —
	    drives the tab-strip spinner + title shimmer; never persisted. */
	busy?: boolean;
	busySpeed?: "slow" | "normal" | "fast";
	conversationId?: string;
	/** Membership in a TabGroup (see `groups`); pinned tabs are never grouped. */
	groupId?: string;
	/**
	 * Optional entity glyph (chat / space / page / agent / meeting / plugin row).
	 * When set, the title-bar tab strip renders it instead of the path Hugeicon —
	 * same value the sidebar shows. `null` / absent → path fallback.
	 */
	icon?: GlyphValue;
	id: string;
	initialAgent?: string;
	/** Open the chat already in temporary ("ghost") mode — the launchpad composer's
	    "+" offers the toggle before a thread exists, and the pick has to survive the
	    hop into the new tab or it would silently save the thread anyway.
	    Runtime-only. */
	initialGhost?: boolean;
	/** One-shot image attachments staged on the launchpad composer, carried into
	    the fresh chat tab so files picked before a conversation exists aren't lost.
	    Runtime-only (blob data URLs) — never persisted across a session restart. */
	initialImages?: AttachedImage[];
	/** One-shot model selection to carry into a newly opened focused reply thread. */
	initialModel?: string;
	/** One-shot composer flags carried from the new-chat launchpad. Runtime-only. */
	initialPluginFlags?: Record<string, boolean>;
	/** One-shot Core assistant opening. Unlike `initialSubmit`, this never adds
	    a synthetic user row and waits for model readiness. Runtime-only. */
	initialProactiveOpening?: boolean;
	initialProject?: string;
	/** One-shot composer seed for a chat tab opened from a `ryu://chat/new`
	    deep link. ChatPage consumes it once on mount: the prompt PRE-FILLS the
	    composer (never auto-sent), and the agent/project pre-select. */
	initialPrompt?: string;
	/** One-shot quote to carry into a newly opened focused reply thread. */
	initialQuote?: string;
	/** One-shot Marketplace listing to select after the Store shell mounts. */
	initialStoreItem?: { id: string; kind: string };
	/** One-shot Store search seed for a Marketplace result opened from Cmd+K. */
	initialStoreQuery?: string;
	/** When true, the seeded `initialPrompt` (and any `initialImages`) is SENT
	    automatically once the chat is ready, rather than only pre-filling the
	    composer. Set ONLY for user-initiated sends (the launchpad composer) — the
	    `ryu://chat/new` deep link and Inbox suggestions leave this unset so their
	    attacker-/system-controllable text stays pre-fill-only. Runtime-only. */
	initialSubmit?: boolean;
	/** One-shot team target carried from the new-chat launchpad. Runtime-only. */
	initialTeamId?: string;
	/** Context from an app-owned sidebar row, forwarded to that app's Companion. */
	mountContext?: Record<string, RyuJsonValue> | null;
	/** Bumped each time this tab is navigated in place ("open in current tab").
	    Folded into the pane's React key so a reused tab remounts its page — pages
	    like ChatPage seed state from props once on mount, so without a remount an
	    in-place navigation would keep showing the previous thread. Runtime-only;
	    never persisted. */
	navToken?: number;
	path: string;
	/** Pinned tabs sit in a compact block at the left and never auto-unload. */
	pinned?: boolean;
	/** The computer a restored tab was bound to. Read back from the persisted
	    session only to re-seed `useNodeStore().tabOverrides` at startup, then
	    dropped: the live binding is always the store's per-tab override. */
	restoredNode?: string;
	/** One-shot message id to scroll into view once the chat tab hydrates.
	    Runtime-only; ChatPage clears it after consuming. */
	scrollToMessageId?: string;
	/** Compatibility projection for callers that still render a Split bracket.
	    Workbench Center groups/tree own membership; TabsProvider derives this id
	    for the active route item in each visible Center leaf. */
	splitId?: string;
	title: string;
	/** When true the tab's React tree is unmounted to free memory; it remounts
	    (cold) the next time the tab is activated. */
	unloaded?: boolean;
	/** Bottom/right workspace dock state remembered with this chat tab. */
	workspaceSession?: WorkspaceSessionState;
	/** Per-tab run-mode override for forks, handoffs, and explicit picker changes. */
	worktreeMode?: boolean;
}

/** A Chrome-style tab group: a named, colored bracket over contiguous tabs. */
export interface TabGroup {
	collapsed: boolean;
	color: TabGroupColor;
	id: string;
	name: string;
}

/** Compatibility view of the shared Workbench Center tree. Its leaves are the
    active route item ids projected from Center group leaves. Name/color/collapse
    remain presentation metadata; callers never own geometry or membership. */
export interface Split {
	/** Collapsed in the tab strip: the member tabs hide behind the header pill
	    (the same interaction as a tab group), while the tiled panes keep
	    rendering. */
	collapsed: boolean;
	/** Chrome-style group color — painted as the header pill and the strip
	    underline that spans the whole split while expanded. */
	color: TabGroupColor;
	id: string;
	/** Optional display name for the strip pill; empty renders the grid glyph. */
	name: string;
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

/** Members of a split in PANE order (the tree's depth-first leaf order) —
    the order the content area tiles them. */
export function splitPaneTabs(tabs: Tab[], split: Split): Tab[] {
	const byId = new Map(tabs.map((t) => [t.id, t]));
	return leafOrder(split.root)
		.map((id) => byId.get(id))
		.filter((t): t is Tab => !!t);
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
	/** Tile `tabIds` into a NEW split whose tree is the preset's shape (pane
	    order = the preset's depth-first slot order). Extra ids are ignored;
	    fewer ids than slots is a no-op. The one primitive that can create a
	    NESTED split — `splitTabs` only ever builds one flat run. */
	applySplitPreset: (root: PresetBranch, tabIds: string[]) => void;
	/** Lay the preset out over brand-new tabs: one per slot, opening the slot's
	    remembered route or an empty pane the user then fills. Fails as a whole
	    (never half-applied) when the tab cap can't fit every pane. */
	applySplitPresetToNewTabs: (root: PresetBranch) => void;
	/** Bind (or unbind, with `undefined`) the conversation a chat tab is showing.
	    A tab opened as a blank "New chat" only learns its conversation id on the
	    first send, so ChatPage writes it back here. Without the write-back the tab
	    stays unbound forever: session restore reopens it EMPTY, `openTab`'s
	    conversation dedup can never match it (so a sidebar click stacks a second
	    tab on the same thread), and `requestScrollToMessage` can't find it.
	    Unbinding matters just as much — a tab that starts a fresh/ghost thread must
	    drop its old id or a later click on the OLD thread would land on it. */
	bindTabConversation: (
		tabId: string,
		conversationId: string | undefined
	) => void;
	canGoBack: boolean;
	canGoForward: boolean;
	/** Clear a tab's pending scroll-to-message after ChatPage consumes it. */
	clearScrollToMessage: (tabId: string) => void;
	closeGroup: (groupId: string) => void;
	closeTab: (id: string, options?: { transferred?: boolean }) => void;
	// Grouping
	createGroup: (tabId: string) => string;
	/** Reset every branch of a split to equal fractions, at every depth. Sizes
	    only — membership and arrangement are untouched. */
	equalizeSplit: (splitId: string) => void;
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
			initialQuote?: string;
			initialModel?: string;
			initialProactiveOpening?: boolean;
			initialSubmit?: boolean;
			initialImages?: AttachedImage[];
			initialAgent?: string;
			initialTeamId?: string;
			initialGhost?: boolean;
			initialPluginFlags?: Record<string, boolean>;
			initialProject?: string;
			initialStoreQuery?: string;
			initialStoreItem?: { id: string; kind: string };
			mountContext?: Record<string, RyuJsonValue> | null;
			worktreeMode?: boolean;
			/** Entity glyph to show in the tab strip (mirrors the sidebar). */
			icon?: GlyphValue;
			/** Bind the tab to this computer (a per-tab node override). Dedupe
			    then matches only a tab already on the same computer. */
			node?: string;
		}
	) => string;
	/** Clear route-only presentation metadata before a Workbench DnD split move. */
	prepareTabForWorkbenchSplit: (tabId: string) => void;
	/** Drop a single tab out of its split (dissolving the split if <2 remain).*/
	removeFromSplit: (tabId: string) => void;
	removeTabFromGroup: (tabId: string) => void;
	renameGroup: (groupId: string, name: string) => void;
	/** Name a split (its strip pill label; empty shows the grid glyph). */
	renameSplit: (splitId: string, name: string) => void;
	/** Hand a split pane over to an already-open tab: `tabId` takes the exact
	    position (and fractions) of `paneTabId`, which is then closed. This is
	    how an empty placeholder pane is filled from the open-tabs list. */
	replacePaneTab: (paneTabId: string, tabId: string) => void;
	/** Queue a one-shot scroll-to-message for a chat tab (consumed by ChatPage). */
	requestScrollToMessage: (conversationId: string, messageId: string) => void;
	restoreTab: () => void;
	setGroupColor: (groupId: string, color: TabGroupColor) => void;
	/** Recolor a split's pill + strip underline. */
	setSplitColor: (splitId: string, color: TabGroupColor) => void;
	setSplitOrientation: (splitId: string, orientation: SplitOrientation) => void;
	/** Replace the size fractions of the branch at `path` (child indexes from
	    the root; [] targets the root itself). */
	setSplitSizes: (splitId: string, path: number[], sizes: number[]) => void;
	/** Point an EXISTING tab at a new route in place, remounting its pane. The
	    one sanctioned way to change what a split pane shows — `openTab`'s
	    in-place reuse deliberately refuses to touch a split member, because that
	    path is reached by accident (a sidebar click) rather than on purpose. */
	setTabRoute: (
		tabId: string,
		path: string,
		opts?: { conversationId?: string; icon?: GlyphValue; title?: string }
	) => void;
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
	/** Collapse/expand a split in the strip, hiding its member tabs behind the
	    header pill the way a group does. */
	toggleSplitCollapsed: (splitId: string) => void;
	ungroup: (groupId: string) => void;
	// Unloading
	unloadTab: (id: string) => void;
	/** Dissolve the entire split that `tabId` belongs to. */
	unsplit: (tabId: string) => void;
	/** Toggle the runtime-only busy flag (spinner + shimmer on the tab chip). */
	updateTabBusy: (
		id: string,
		busy: boolean,
		speed?: "slow" | "normal" | "fast"
	) => void;
	/** Set or clear a tab's leading glyph (title bar + vertical tabs). */
	updateTabIcon: (id: string, icon: GlyphValue) => void;
	/**
	 * Patch `icon` on every open tab matching `match` — used when an entity's
	 * glyph changes so already-open tabs stay in sync with the sidebar.
	 */
	updateTabsIconWhere: (match: (tab: Tab) => boolean, icon: GlyphValue) => void;
	updateTabTitle: (id: string, title: string) => void;
	/** Save the workspace dock state belonging to one chat tab. */
	updateTabWorkspaceSession: (
		id: string,
		workspaceSession: WorkspaceSessionState
	) => void;
	/** Set or clear the per-tab worktree run-mode override. */
	updateTabWorktreeMode: (
		id: string,
		worktreeMode: boolean | undefined
	) => void;
}

export interface EmptyCenterTabOptions {
	conversationId?: string;
	title?: string;
}

/** Listeners told about every `openTab` request, see {@link subscribeTabOpenRequests}. */
const tabOpenRequestListeners = new Set<(tabId: string) => void>();

function notifyTabOpenRequest(tabId: string): void {
	for (const listener of tabOpenRequestListeners) {
		listener(tabId);
	}
}

/**
 * Subscribe to every `openTab` request with the id of the tab it opened or
 * activated. Reopening the tab that is already active changes no tab state
 * (same id, path, and navToken), so a surface that hides a tab until the user
 * navigates (the interface overview) needs this to see the navigation at all.
 */
export function subscribeTabOpenRequests(
	listener: (tabId: string) => void
): () => void {
	tabOpenRequestListeners.add(listener);
	return () => {
		tabOpenRequestListeners.delete(listener);
	};
}

export function openTabFromEmptyCenter(
	openTab: (
		path: string,
		opts?: EmptyCenterTabOptions & { forceNew?: boolean }
	) => string,
	path: string,
	opts?: EmptyCenterTabOptions
): string {
	return openTab(path, { ...opts, forceNew: true });
}

/** Exported ONLY so the e2e harness can supply a stub value for a component under
 *  test; app code must go through {@link useTabsContext}, which fails loudly
 *  outside a real {@link TabsProvider}. */
export const TabsContext = createContext<TabsContextValue | null>(null);

const TabsSelectionContext = createContext<StoreApi<TabsContextValue> | null>(
	null
);

/** Keep action-only and per-tab subscribers off unrelated navigation updates. */
export function TabsStateProvider({
	value,
	children,
}: {
	value: TabsContextValue;
	children: ReactNode;
}) {
	const [store] = useState(() => createStore<TabsContextValue>(() => value));
	useLayoutEffect(() => {
		store.setState(value, true);
	}, [store, value]);
	return (
		<TabsSelectionContext.Provider value={store}>
			<TabsContext.Provider value={value}>{children}</TabsContext.Provider>
		</TabsSelectionContext.Provider>
	);
}

const subscribeWithoutProvider = () => () => undefined;

/** Select an existing object, action, or primitive; do not allocate a snapshot. */
export function useTabSelector<T>(selector: (state: TabsContextValue) => T): T {
	const store = useContext(TabsSelectionContext);
	// Direct context providers remain supported by embedded hosts and stories.
	const fallback = store ? null : use(TabsContext);
	const getSnapshot = () => {
		const state = store?.getState() ?? fallback;
		if (!state) {
			throw new Error("useTabSelector must be inside TabsProvider");
		}
		return selector(state);
	};
	return useSyncExternalStore(
		store?.subscribe ?? subscribeWithoutProvider,
		getSnapshot,
		getSnapshot
	);
}

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
			<TabNodeChatHistoryBoundary tabId={tabId}>
				{children}
			</TabNodeChatHistoryBoundary>
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

/** Single-page routes and their tab titles. The Library and the Customize store
    are deliberately ABSENT: every one of their routes is the same multi-section
    shell, so their titles come from {@link shellRoute} instead — see the comment
    there. Do not re-add a per-section key here; it would be dead (shellRoute is
    consulted first) and would drift. */
const PATH_TITLES = new Map<string, string>([
	[DASHBOARD_DEFAULT_PATH, "Home"],
	["/chat", "New chat"],
	["/compute", "Compute"],
	[PANE_CHOOSER_PATH, "Empty pane"],
	["/identities/new", "New identity"],
	["/vault", "Vault"],
	["/workflows/build", "Build a workflow"],
	["/calendar", "Calendar"],
	["/meetings", "Meetings"],
	["/quests", "Quests"],
	["/timeline", "Timeline"],
	["/activity", "Activity"],
	["/review", "Weekly review"],
	["/approvals", "Inbox"],
	["/inbox", "Inbox"],
	["/downloads", "Downloads"],
	["/settings", "Settings"],
	["/share", "Share"],
]);

/** The two multi-section shells in the app: LibraryPage and StorePage. */
type ShellFamily = "library" | "store";

export interface ShellRoute {
	family: ShellFamily;
	title: string;
}

/** The store shell's product name. It is the word the sidebar's own header
    button carries (AppSidebar `CHROME_LABELS.store`), and TitleBar keys its
    glyph off the same decision — change all three together or the one page
    shows up as several different things. */
const STORE_SHELL_TITLE = "Customize";
const LIBRARY_SHELL_TITLE = "Library";

/** Bare legacy routes that mount LibraryPage on a section (see
    `contributions/builtins.ts`). Matched EXACTLY: `/channels/:id`,
    `/identities/new`, `/identities/profile/:id`, `/agents/:id/edit` and
    `/workflows/build` are genuinely different pages and must keep their own
    titles.

    `/agents` is one of them: `builtins.ts` mounts it as
    `LibraryPage initialSection: "agent"` — byte-for-byte the page
    `/library/agent` mounts — so keeping it out would leave one page with two
    names and two tabs that never reuse each other, which is the defect this
    whole seam exists to remove. Nothing in the app opens bare `/agents` any
    more (the sidebar, the palette and EmptyTabsState all target
    `/library/agent`); it survives as a deep link and in restored sessions.
    TitleBar's Ryu-ghost painting used to be the argument for excluding it, but
    that argues for a glyph, not a second name — `isAgentsTab` is now narrowed
    to the agent EDIT route so a Library tab never flickers logo↔book as its
    section changes. */
const LIBRARY_ALIAS_PATHS = new Set([
	"/agents",
	"/channels",
	"/identities",
	"/spaces",
	"/tools",
	"/workflows",
]);

/** Bare legacy routes that mount StorePage on a section. Exact matches only —
    `/skills/new` is the SKILL.md editor companion, not the store. */
const STORE_ALIAS_PATHS = new Set([
	"/apps",
	"/engines",
	"/extensions",
	"/fleet",
	"/models",
	"/skills",
]);

/**
 * The PAGE a route belongs to, for the two shells whose sections switch in
 * place (the Library and the Customize store). Returns undefined for every
 * other route.
 *
 * A section is not a page. `/tools`, `/library/agent` and `/library` are one
 * LibraryPage; `/apps`, `/models`, `/marketplace` and `/store/plugins` are one
 * StorePage. Previously each of those had its own row in `PATH_TITLES` naming
 * the SECTION ("Tools", "Models"), and — worse — the caller's title won over
 * the map (`opts?.title ?? defaultTitle(path)`), so a tab was named after
 * whichever sidebar row happened to open it and then never renamed when the
 * user switched section inside the page. Both halves are fixed by making these
 * routes authoritative: {@link resolveTabTitle} consults this FIRST, so a
 * caller-supplied label can no longer override a shell's own name. Entity
 * routes (a chat, an agent, a space) match nothing here and keep their
 * caller-supplied titles.
 */
export function shellRoute(path: string): ShellRoute | undefined {
	const base = path.split("?")[0];
	if (
		base === "/library" ||
		base.startsWith("/library/") ||
		LIBRARY_ALIAS_PATHS.has(base)
	) {
		return { family: "library", title: LIBRARY_SHELL_TITLE };
	}
	if (
		base === "/store" ||
		base.startsWith("/store/") ||
		base === "/marketplace" ||
		base.startsWith("/marketplace/") ||
		STORE_ALIAS_PATHS.has(base)
	) {
		return { family: "store", title: STORE_SHELL_TITLE };
	}
	return undefined;
}

function makeTabId(): string {
	return `tab-${crypto.randomUUID()}`;
}

function makeGroupId(): string {
	return `grp-${crypto.randomUUID()}`;
}

function routeWorkbenchItem(tab: Tab): WorkbenchItem {
	return {
		closable: true,
		duplicable: true,
		id: tab.id,
		pinned: tab.pinned === true,
		preferredRegion: "center",
		scope: tab.conversationId
			? { kind: "conversation", conversationId: tab.conversationId }
			: { kind: "window" },
		source: { kind: "route", path: tab.path },
		title: tab.title,
	};
}

const AGENT_EDIT_TITLE_RE = /^\/agents\/.+\/edit$/;
const CHANNEL_DETAIL_TITLE_RE = /^\/channels\/[^/]+$/;
const IDENTITY_PROFILE_TITLE_RE = /^\/identities\/profile\/[^/]+$/;
const ARTIFACT_TITLE_RE = /^\/artifact\/[^/]+$/;
const PROJECT_GRAPH_TITLE_RE = /^\/project\/graph\/[^/]+$/;

/** Title-case a path segment (`downloads` → `Downloads`, `weekly-review` → `Weekly Review`). */
function humanizePathSegment(segment: string): string {
	return segment
		.split(/[-_]/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function defaultTitle(path: string): string {
	const base = path.split("?")[0];
	// Handle agent edit paths like /agents/abc123/edit
	if (AGENT_EDIT_TITLE_RE.test(base)) {
		return base.includes("/new/") ? "New agent" : "Edit agent";
	}
	if (CHANNEL_DETAIL_TITLE_RE.test(base)) {
		return base.endsWith("/new") ? "New channel" : "Channel";
	}
	if (IDENTITY_PROFILE_TITLE_RE.test(base)) {
		return "Identities";
	}
	// A session-local artifact tab is named after its artifact (the store holds it
	// only while the session does; a restored tab falls back to "Artifact").
	if (ARTIFACT_TITLE_RE.test(base)) {
		const artifact = useArtifactStore.getState().get(base.split("/")[2]);
		return artifact ? artifact.title : "Artifact";
	}
	if (PROJECT_GRAPH_TITLE_RE.test(base)) {
		return "Git graph";
	}
	// After the entity regexes (so `/agents/:id/edit` stays "Edit agent") and
	// before the per-path map, which no longer carries the shells' routes.
	const shell = shellRoute(base);
	if (shell) {
		return shell.title;
	}
	const mapped = PATH_TITLES.get(base);
	if (mapped) {
		return mapped;
	}
	const segment = base.split("/").filter(Boolean).at(-1);
	return segment ? humanizePathSegment(segment) : "Page";
}

/**
 * The title a tab must carry for `path`, given whatever the caller asked for.
 *
 * The one seam every tab title flows through. A shell route WINS over
 * `callerTitle`: sidebar rows, the command palette and the empty-tabs state all
 * pass their own label ("Tools", "Plugins", "Customize"), and honouring it is
 * what left tabs named after the row that opened them. Everything else keeps
 * the caller's title — a chat, an agent or a space tab is named for its entity,
 * which no path map can know.
 */
function resolveTabTitle(path: string, callerTitle?: string): string {
	return shellRoute(path)?.title ?? callerTitle ?? defaultTitle(path);
}

/**
 * The entity glyph a tab on `path` may carry — the icon half of
 * {@link resolveTabTitle}, and the same rule: a shell OWNS its glyph, so a tab
 * sitting on one carries none and TitleBar paints the family's icon from the
 * path instead.
 *
 * Without this a stamped `icon` outlives the route it was stamped for: it wins
 * over the path icon in `TabGlyph`, it is persisted across relaunches, and both
 * the reuse branches here and `setTabRoute` carry it onto the next route. An
 * agent tab (its avatar) navigated in place to `/library/space` would keep the
 * avatar while reading "Library". Entity routes are untouched — a chat, a space
 * or an agent tab is exactly where a caller-supplied glyph belongs.
 */
function resolveTabGlyph(
	path: string,
	callerIcon?: GlyphValue
): GlyphValue | undefined {
	return shellRoute(path) ? undefined : callerIcon;
}

// /chat tabs can have multiple instances; all other paths are singletons.
// `/pane` joins it: a preset lays out several empty panes at once, and a
// singleton would collapse all of them onto one tab.
function isSingleton(path: string): boolean {
	const base = path.split("?")[0];
	return base !== "/chat" && base !== PANE_CHOOSER_PATH;
}

// Pick the first color not already used by a group or a split, so new clusters
// are visually distinct until the palette wraps around.
function nextClusterColor(groups: TabGroup[], splits: Split[]): TabGroupColor {
	const used = new Set([
		...groups.map((g) => g.color),
		...splits.map((s) => s.color),
	]);
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
	icon?: GlyphValue;
	initialAgent?: string;
	initialProactiveOpening?: boolean;
	initialPrompt?: string;
	initialSubmit?: boolean;
	/** Pin this window's seeded tab to a specific node (carried from the source
	    tab so a remote-targeted chat keeps targeting that node). */
	node?: string;
	path: string;
	title?: string;
	transfer?: TabTransfer;
}

/** localStorage key holding the previous session's open tabs, so the "restore
    previous tabs" startup behavior can reopen them. Written by the main window
    on every tab change; read once at launch. */
const SESSION_TABS_KEY = "ryu_session_tabs";

/** The serializable subset of a Tab persisted for session restore. The stable
    Workbench item id is retained so same-path chats cannot exchange runtime
    metadata. One-shot seeds, unload flags, and presentation groups are dropped. */
const restoredSessionSchema = z.object({
	activeIndex: z.number().int().optional(),
	tabs: z.array(
		z.object({
			path: z.string(),
			title: z.string(),
			id: z.string().optional(),
			conversationId: z.string().optional(),
			initialAgent: z.string().optional(),
			initialProject: z.string().optional(),
			// The tab's per-tab computer override. Omitted for the default
			// computer and in sessions written before tabs could be bound to one.
			node: z.string().optional().catch(undefined),
			pinned: z.boolean().optional(),
			worktreeMode: z.boolean().optional(),
			icon: z
				.unknown()
				.transform((input) => asGlyphValue(input))
				.optional(),
			workspaceSession: workspaceSessionSchema.optional().catch(undefined),
		})
	),
});

type PersistedTab = z.infer<typeof restoredSessionSchema>["tabs"][number];

/** Legacy compatibility split serialized over tab indexes. The Workbench v2
    snapshot is the authoritative geometry restored by DesktopWorkbenchProvider. */
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

function persistSession(
	tabs: Tab[],
	activeTabId: string,
	splits: Split[],
	overrides: Readonly<Record<string, string>>
) {
	try {
		if (tabs.length === 0) {
			sealedLocalStorage.removeItem(SESSION_TABS_KEY);
			return;
		}
		const persisted: PersistedTab[] = tabs.map((t) => ({
			id: t.id,
			path: t.path,
			title: t.title,
			conversationId: t.conversationId,
			initialAgent: t.initialAgent,
			initialProject: t.initialProject,
			node: overrides[t.id],
			pinned: t.pinned,
			icon: t.icon,
			workspaceSession: t.workspaceSession,
			worktreeMode: t.worktreeMode,
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
		sealedLocalStorage.setItem(SESSION_TABS_KEY, JSON.stringify(payload));
	} catch {
		// Persisting the session is best-effort; ignore storage/serialize failures.
	}
}

interface StartupState {
	activeId: string;
	splits: Split[];
	stableItemIds?: Set<string>;
	tabs: Tab[];
}

type WorkbenchRouteItem = WorkbenchItem & {
	source: Extract<WorkbenchItem["source"], { kind: "route" }>;
};

function isWorkbenchRouteItem(
	item: WorkbenchItem | undefined
): item is WorkbenchRouteItem {
	return item?.source.kind === "route";
}

/** Re-seed each restored tab's computer binding into the node store (by its
    FINAL id, after workbench reconciliation) and drop the carrier field. */
function seedRestoredTabNodes(startup: StartupState): StartupState {
	if (!startup.tabs.some((tab) => tab.restoredNode)) {
		return startup;
	}
	const { setTabOverride } = useNodeStore.getState();
	return {
		...startup,
		tabs: startup.tabs.map(({ restoredNode, ...tab }) => {
			if (restoredNode) {
				setTabOverride(tab.id, restoredNode);
			}
			return tab;
		}),
	};
}

function reconcileStartupWithWorkbench(
	state: WorkbenchState,
	startup: StartupState
): StartupState {
	const remainingTabs = [...startup.tabs];
	let migratedActiveId = "";
	const routeItems = state.groups.flatMap((group) =>
		group.itemIds.flatMap((itemId) => {
			const item = state.items.find((candidate) => candidate.id === itemId);
			return isWorkbenchRouteItem(item) ? [item] : [];
		})
	);
	const tabs = routeItems.map((item) => {
		const stableMatchIndex = remainingTabs.findIndex(
			(tab) => startup.stableItemIds?.has(tab.id) === true && tab.id === item.id
		);
		const semanticMatchIndex = remainingTabs.findIndex((tab) => {
			if (startup.stableItemIds?.has(tab.id) === true) {
				return false;
			}
			if (tab.path !== item.source.path) {
				return false;
			}
			return tab.conversationId
				? item.scope.kind === "conversation" &&
						item.scope.conversationId === tab.conversationId
				: item.scope.kind !== "conversation";
		});
		const matchIndex =
			stableMatchIndex >= 0 ? stableMatchIndex : semanticMatchIndex;
		const matched =
			matchIndex < 0 ? undefined : remainingTabs.splice(matchIndex, 1)[0];
		if (matched?.id === startup.activeId) {
			migratedActiveId = item.id;
		}
		return {
			...matched,
			id: item.id,
			path: matched?.path ?? item.source.path,
			pinned: item.pinned,
			title: matched?.title ?? item.title,
		};
	});
	const focusedItemId = state.groups.find(
		(group) => group.id === state.focusedGroupId
	)?.activeItemId;
	const focusedRouteId = routeItems.some((item) => item.id === focusedItemId)
		? (focusedItemId ?? "")
		: "";
	return {
		activeId: focusedRouteId || migratedActiveId || startup.activeId,
		splits: startup.splits,
		stableItemIds: startup.stableItemIds,
		tabs: [...tabs, ...remainingTabs],
	};
}

function projectTabsFromWorkbench(
	state: WorkbenchState,
	runtimeTabs: Tab[],
	splitMemberIds: ReadonlySet<string> = new Set()
): Tab[] {
	const runtimeById = new Map(runtimeTabs.map((tab) => [tab.id, tab]));
	const projected: Tab[] = [];
	const seen = new Set<string>();
	for (const group of state.groups) {
		for (const itemId of group.itemIds) {
			const item = state.items.find((candidate) => candidate.id === itemId);
			if (item?.source.kind !== "route" || seen.has(item.id)) {
				continue;
			}
			seen.add(item.id);
			const runtime = runtimeById.get(item.id);
			projected.push({
				...(runtime ?? {
					id: item.id,
					path: item.source.path,
					pinned: item.pinned,
					title: item.title,
				}),
				path: item.source.path,
				pinned: item.pinned,
				splitId: splitMemberIds.has(item.id)
					? WORKBENCH_CENTER_SPLIT_ID
					: undefined,
				title: item.title,
			});
		}
	}
	for (const tab of runtimeTabs) {
		if (!seen.has(tab.id)) {
			projected.push({ ...tab, splitId: undefined });
		}
	}
	return projected;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Value equality for projected tab fields: primitives by `Object.is`, arrays
    element-wise, plain records key-wise (an absent key equals `undefined`, as
    neither survives serialization), anything else by identity. */
function sameProjectedValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) {
		return true;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => sameProjectedValue(value, b[index]))
		);
	}
	if (!(isPlainRecord(a) && isPlainRecord(b))) {
		return false;
	}
	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (!sameProjectedValue(a[key], b[key])) {
			return false;
		}
	}
	return true;
}

/**
 * Structural sharing for the compatibility tab projection. Every Workbench
 * change (an `item/activate` on each tab switch included) re-projects all tabs
 * as fresh objects; RouteOutlet memoizes each page on its tab object, so fresh
 * objects re-render every retained page. A tab whose fields are all equal by
 * value keeps its previous object, and an unchanged list keeps its previous
 * array. Any real change to any field still yields a new object.
 */
export function reuseUnchangedTabs(previous: Tab[], next: Tab[]): Tab[] {
	const previousById = new Map(previous.map((tab) => [tab.id, tab]));
	let unchanged = previous.length === next.length;
	const shared = next.map((tab, index) => {
		const prior = previousById.get(tab.id);
		const reused = prior && sameProjectedValue(prior, tab) ? prior : tab;
		if (reused !== previous[index]) {
			unchanged = false;
		}
		return reused;
	});
	return unchanged ? previous : shared;
}

const WORKBENCH_CENTER_SPLIT_ID = "workbench:center";

interface SplitPresentation {
	collapsed: boolean;
	color: TabGroupColor;
	name: string;
}

function normalizedSizes(sizes: number[], count: number): number[] {
	const values = Array.from({ length: count }, (_, index) => {
		const value = sizes[index] ?? 1;
		return Number.isFinite(value) && value > 0 ? value : 1;
	});
	const total = values.reduce((sum, value) => sum + value, 0);
	return values.map((value) => value / total);
}

function projectCenterNode(
	node: WorkbenchState["centerTree"],
	state: WorkbenchState,
	routeIds: ReadonlySet<string>,
	members: Set<string>
): SplitNode | null {
	if (node.type === "leaf") {
		const activeItemId = state.groups.find(
			(group) => group.id === node.groupId
		)?.activeItemId;
		if (!(activeItemId && routeIds.has(activeItemId))) {
			return null;
		}
		members.add(activeItemId);
		return makeLeaf(activeItemId);
	}
	const projectedChildren: SplitNode[] = [];
	const projectedSizes: number[] = [];
	for (const [index, child] of node.children.entries()) {
		const projected = projectCenterNode(child, state, routeIds, members);
		if (projected) {
			projectedChildren.push(projected);
			projectedSizes.push(node.sizes[index] ?? 1);
		}
	}
	if (projectedChildren.length === 0) {
		return null;
	}
	if (projectedChildren.length === 1) {
		return projectedChildren[0] ?? null;
	}
	return {
		type: "branch",
		children: projectedChildren,
		orientation: node.orientation,
		sizes: normalizedSizes(projectedSizes, projectedChildren.length),
	};
}

function projectCenterSplit(
	state: WorkbenchState,
	runtimeTabs: Tab[],
	presentation: SplitPresentation
) {
	const routeIds = new Set(runtimeTabs.map((tab) => tab.id));
	const memberIds = new Set<string>();
	const root = projectCenterNode(state.centerTree, state, routeIds, memberIds);
	if (root?.type !== "branch") {
		return { memberIds: new Set<string>(), splits: [] };
	}
	return {
		memberIds,
		splits: [
			{
				id: WORKBENCH_CENTER_SPLIT_ID,
				root,
				...presentation,
			},
		],
	};
}

function centerBranchSizes(
	tree: WorkbenchState["centerTree"],
	path: number[] = []
): Array<{ path: number[]; sizes: number[] }> {
	if (tree.type === "leaf") {
		return [];
	}
	return [
		{
			path,
			sizes: Array.from(
				{ length: tree.children.length },
				() => 1 / tree.children.length
			),
		},
		...tree.children.flatMap((child, index) =>
			centerBranchSizes(child, [...path, index])
		),
	];
}

function collapseWorkbenchCenter(
	dispatch: (action: WorkbenchAction) => void,
	state: WorkbenchState,
	primaryGroupId: string
): void {
	for (const group of state.groups) {
		if (group.region !== "center" || group.id === primaryGroupId) {
			continue;
		}
		for (const itemId of group.itemIds) {
			dispatch({
				type: "item/move",
				itemId,
				toGroupId: primaryGroupId,
			});
		}
		dispatch({ type: "center/remove-group", groupId: group.id });
	}
}

export function workbenchActiveItemsProtectedFromUnload(
	state: WorkbenchState
): Set<string> {
	const ids = new Set<string>();
	for (const group of state.groups) {
		const visible =
			group.region === "center" || state.openRegions[group.region] === true;
		if (visible && group.activeItemId) {
			ids.add(group.activeItemId);
		}
	}
	return ids;
}

export function shouldAutoUnloadWorkbenchTab({
	cutoff,
	lastActive,
	state,
	tab,
}: {
	cutoff: number;
	lastActive: number | undefined;
	state: WorkbenchState;
	tab: Tab;
}): boolean {
	return (
		!(
			tab.pinned ||
			tab.unloaded ||
			workbenchActiveItemsProtectedFromUnload(state).has(tab.id)
		) &&
		lastActive !== undefined &&
		lastActive < cutoff
	);
}

function centerLeafGroupIds(tree: WorkbenchSplitNode): string[] {
	return tree.type === "leaf"
		? [tree.groupId]
		: tree.children.flatMap(centerLeafGroupIds);
}

function detachCenterItem({
	dispatch,
	itemId,
	state,
}: {
	dispatch: (action: WorkbenchAction) => void;
	itemId: string;
	state: WorkbenchState;
}): void {
	const sourceGroup = state.groups.find((group) =>
		group.itemIds.includes(itemId)
	);
	if (sourceGroup?.region !== "center") {
		return;
	}
	const targetGroup = state.groups.find(
		(group) => group.region === "center" && group.id !== sourceGroup.id
	);
	if (!targetGroup) {
		return;
	}
	dispatch({
		type: "item/move",
		activate: false,
		itemId,
		toGroupId: targetGroup.id,
	});
	if (sourceGroup.itemIds.length === 1) {
		dispatch({ type: "center/remove-group", groupId: sourceGroup.id });
	}
}

function placeTabsInCenter({
	dispatch,
	state,
	tabIds,
}: {
	dispatch: (action: WorkbenchAction) => void;
	state: WorkbenchState;
	tabIds: string[];
}): string[] {
	const primaryGroup = state.groups.find((group) => group.region === "center");
	if (!(primaryGroup && tabIds[0])) {
		return [];
	}
	collapseWorkbenchCenter(dispatch, state, primaryGroup.id);
	dispatch({
		type: "item/move",
		itemId: tabIds[0],
		toGroupId: primaryGroup.id,
	});
	dispatch({ type: "item/pin", itemId: tabIds[0], pinned: false });
	const groupIds = [primaryGroup.id];
	for (const itemId of tabIds.slice(1)) {
		const newGroupId = makeGroupId();
		dispatch({
			type: "center/split",
			direction: "right",
			newGroupId,
			targetGroupId: primaryGroup.id,
		});
		dispatch({ type: "item/move", itemId, toGroupId: newGroupId });
		dispatch({ type: "item/pin", itemId, pinned: false });
		groupIds.push(newGroupId);
	}
	return groupIds;
}

function presetCenterTree(
	node: PresetNode,
	groupIds: Iterator<string>
): WorkbenchSplitNode | null {
	if (node.type === "slot") {
		const group = groupIds.next();
		return group.done ? null : { type: "leaf", groupId: group.value };
	}
	const children = node.children.flatMap((child) => {
		const converted = presetCenterTree(child, groupIds);
		return converted ? [converted] : [];
	});
	return children.length === node.children.length
		? {
				type: "branch",
				children,
				orientation: node.orientation,
				sizes: normalizedSizes(node.sizes, children.length),
			}
		: null;
}

/** Rewrite a path that a previous version persisted but no route answers to any
 *  more. Only the Home dashboard so far: it moved off the shell's `/home` to the
 *  path `@ryu/dashboards` declares, so a restored session would otherwise revive a
 *  tab that resolves to "App not enabled". */
function migrateLegacyPath(path: string): string {
	return path === LEGACY_DASHBOARD_PATH ? DASHBOARD_DEFAULT_PATH : path;
}

/**
 * Collapse a restored session to ONE tab per shell family.
 *
 * `openTab` keeps a single Library / Customize tab, but nothing enforced that
 * on the way IN. A session that was written with `/tools`, `/models`, `/apps`
 * and `/skills` open revives as four tabs, three of them reading "Customize"
 * and one "Library" — indistinguishable in the strip, which is the reported
 * defect in a new shape — and the first member of each family then absorbs
 * every later navigation into it, stranding the others.
 *
 * Two kinds of member are never dropped, only ever collapsed AROUND:
 *
 * - Split members, matching `openTab`'s `!t.splitId` exclusion: a tiled pane
 *   holds its section deliberately.
 * - PINNED members, all of them. A pin is explicit user state and this function
 *   runs on data that cannot tell a deliberate second shell tab (middle-click /
 *   "open in new tab", which `forceNew` still allows) from a stale session — the
 *   persisted record is just a path — so it must not be the thing that deletes
 *   one. An unpinned extra IS dropped on that same reasoning inverted: nothing
 *   marks it as wanted, and leaving it produces the identically-named tabs this
 *   collapse exists to remove. The cost is that a middle-clicked second
 *   Customize tab does not survive a relaunch unless the user pins it.
 *
 * The survivor — the member that absorbs the family — is the first pinned one,
 * else the active one, else the first. It inherits the ACTIVE member's path when
 * that member is being dropped, so the user still lands on the section they
 * left, and `activeId` follows the survivor in that case. Overwriting a pinned
 * survivor's section is deliberate and matches `openTab`: pinning says "keep
 * this tab", not "keep this section".
 */
function dedupeShellFamilies(tabs: Tab[], activeId: string) {
	const families = new Map<ShellFamily, Tab[]>();
	for (const t of tabs) {
		const family = t.splitId ? undefined : shellRoute(t.path)?.family;
		if (!family) {
			continue;
		}
		const members = families.get(family);
		if (members) {
			members.push(t);
		} else {
			families.set(family, [t]);
		}
	}
	const dropped = new Set<string>();
	let survivingActiveId = activeId;
	for (const members of families.values()) {
		if (members.length < 2) {
			continue;
		}
		const active = members.find((t) => t.id === activeId);
		const survivor = members.find((t) => t.pinned) ?? active ?? members[0];
		// Only when the active member is one of the dropped ones: a pinned active
		// member keeps its own section, because it is not going anywhere.
		if (active && active !== survivor && !active.pinned) {
			survivor.path = active.path;
		}
		for (const t of members) {
			if (t !== survivor && !t.pinned) {
				dropped.add(t.id);
			}
		}
		if (dropped.has(survivingActiveId)) {
			survivingActiveId = survivor.id;
		}
	}
	if (dropped.size === 0) {
		return { tabs, activeId };
	}
	return {
		tabs: tabs.filter((t) => !dropped.has(t.id)),
		activeId: survivingActiveId,
	};
}

function restoreSession(): StartupState | null {
	try {
		const raw = sealedLocalStorage.getItem(SESSION_TABS_KEY);
		if (!raw) {
			return null;
		}
		const parsed = restoredSessionSchema.parse(JSON.parse(raw));
		if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) {
			return null;
		}
		// Titles and glyphs are persisted verbatim, so a session written by an
		// earlier build still carries the SIDEBAR's label on its shell tabs
		// ("Tools", "Plugins", "Customize") and whatever icon was stamped on them.
		// Re-resolving through `resolveTabTitle` / `resolveTabGlyph` on the way in
		// renames them once, at restore, rather than leaving the stale name to
		// survive every relaunch — a shell route's title and glyph are derived,
		// never user data, so there is nothing to preserve. Non-shell tabs keep
		// both (a chat tab's thread name and avatar are NOT derivable from its
		// path). Re-titling alone would leave several identically-named tabs in the
		// strip, so `dedupeShellFamilies` below collapses them too.
		const usedIds = new Set<string>();
		const stableItemIds = new Set<string>();
		const mapped: Tab[] = parsed.tabs.map((t) => {
			const path = migrateLegacyPath(t.path);
			const stableId =
				isNativeText(t.id) && t.id.length > 0 && !usedIds.has(t.id)
					? t.id
					: undefined;
			let id = stableId ?? makeTabId();
			while (usedIds.has(id)) {
				id = makeTabId();
			}
			usedIds.add(id);
			if (stableId) {
				stableItemIds.add(id);
			}
			return {
				id,
				path,
				title: resolveTabTitle(path, t.title),
				conversationId: t.conversationId,
				initialAgent: t.initialAgent,
				initialProject: t.initialProject,
				pinned: t.pinned,
				restoredNode:
					isNativeText(t.node) && t.node.length > 0 ? t.node : undefined,
				icon: resolveTabGlyph(path, t.icon),
				workspaceSession: t.workspaceSession,
				worktreeMode: t.worktreeMode,
			};
		});
		const idx = Math.min(
			Math.max(0, parsed.activeIndex ?? 0),
			mapped.length - 1
		);
		// Focus id is resolved before normalize reorders (pinned-lead), so it
		// tracks the tab the user last viewed rather than a shifted position.
		const activeId = mapped[idx].id;
		// One tab per shell family, the same invariant `openTab` holds. Runs after
		// split revival so the dedupe can see (and spare) split members, and the
		// splits themselves are untouched because no split member is ever dropped.
		const collapsed = dedupeShellFamilies(mapped, activeId);
		return {
			tabs: normalize(collapsed.tabs),
			activeId: collapsed.activeId,
			splits: [],
			stableItemIds,
		};
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
			tabs: [{ id, path: DASHBOARD_DEFAULT_PATH, title: "Home" }],
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

export function TabsProvider(props: {
	children: ReactNode;
	initialTab?: InitialTab;
}) {
	const workbench = useOptionalDesktopWorkbench();
	return workbench ? (
		<WorkbenchTabsProvider {...props} />
	) : (
		<DesktopWorkbenchProvider>
			<WorkbenchTabsProvider {...props} />
		</DesktopWorkbenchProvider>
	);
}

function WorkbenchTabsProvider({
	children,
	initialTab,
}: {
	children: ReactNode;
	initialTab?: InitialTab;
}) {
	const {
		dispatch: dispatchWorkbench,
		getState: getWorkbenchState,
		openItem: openWorkbenchItem,
		state: workbenchState,
	} = useDesktopWorkbench();
	// The main window opens per the "On startup" preference; a tear-off window
	// (spawned with an `initialTab`) always seeds from that one conversation.
	const [legacyInitialState] = useState<StartupState>(() => {
		if (initialTab) {
			const id = initialTab.transfer?.tab.id ?? makeTabId();
			if (initialTab.transfer?.artifact) {
				useArtifactStore.getState().put(initialTab.transfer.artifact);
			}
			if (initialTab.node) {
				useNodeStore.getState().setTabOverride(id, initialTab.node);
			}
			return {
				tabs: [
					{
						id,
						path: initialTab.path.split("?")[0],
						title: resolveTabTitle(initialTab.path, initialTab.title),
						conversationId: initialTab.conversationId,
						icon: initialTab.icon,
						initialAgent: initialTab.initialAgent,
						initialPrompt: initialTab.initialPrompt,
						initialSubmit: initialTab.initialSubmit,
						initialProactiveOpening: initialTab.initialProactiveOpening,
						...initialTab.transfer?.tab,
					},
				],
				activeId: id,
				splits: [],
			};
		}
		return computeStartupState();
	});
	const [initialState] = useState<StartupState>(() =>
		seedRestoredTabNodes(
			reconcileStartupWithWorkbench(workbenchState, legacyInitialState)
		)
	);
	const [tabs, setTabs] = useState<Tab[]>(initialState.tabs);
	// Per-tab computer bindings: persisted with the session and folded into the
	// cross-window entity keys, so a thread open on two computers stays two tabs.
	const tabOverrides = useNodeStore((s) => s.tabOverrides);
	const defaultNodeName = useNodeStore((s) => s.getActiveNode().name);
	const startupWorkbenchSyncRef = useRef(false);

	useEffect(() => {
		if (startupWorkbenchSyncRef.current) {
			return;
		}
		startupWorkbenchSyncRef.current = true;
		const liveItemIds = new Set(workbenchState.items.map((item) => item.id));
		for (const tab of tabs) {
			if (!liveItemIds.has(tab.id)) {
				openWorkbenchItem(routeWorkbenchItem(tab), { region: "center" });
			}
		}
	}, [openWorkbenchItem, tabs, workbenchState.items]);

	// Carry the source tab's node binding into this window by registering it as a
	// per-tab override on the seeded tab (window-local; never touches nodes.json).
	const seededNode = initialTab?.node;
	useEffect(() => {
		if (seededNode) {
			useNodeStore.getState().setTabOverride(initialState.activeId, seededNode);
		}
	}, [seededNode, initialState.activeId]);
	const [groups, setGroups] = useState<TabGroup[]>([]);
	const [splitPresentation, setSplitPresentation] = useState<SplitPresentation>(
		() => {
			const restored = initialState.splits[0];
			return restored
				? {
						collapsed: restored.collapsed,
						color: restored.color,
						name: restored.name,
					}
				: { collapsed: false, color: TAB_GROUP_COLORS[0], name: "" };
		}
	);
	const [activeTabId, setActiveTabId] = useState<string>(initialState.activeId);
	const [closedTabs, setClosedTabs] = useState<ClosedTab[]>([]);
	const centerSplitProjection = useMemo(
		() => projectCenterSplit(workbenchState, tabs, splitPresentation),
		[splitPresentation, tabs, workbenchState]
	);
	// The previous projection, so unchanged tabs keep their object identity
	// across Workbench changes (see `reuseUnchangedTabs`).
	const projectedTabsRef = useRef<Tab[]>([]);
	const compatibilityTabs = useMemo(
		() =>
			reuseUnchangedTabs(
				projectedTabsRef.current,
				projectTabsFromWorkbench(
					workbenchState,
					tabs,
					centerSplitProjection.memberIds
				)
			),
		[centerSplitProjection.memberIds, tabs, workbenchState]
	);
	projectedTabsRef.current = compatibilityTabs;
	const splits = centerSplitProjection.splits;

	// Ref for synchronous reads inside callbacks without stale closure issues
	const tabsRef = useRef<Tab[]>(tabs);
	tabsRef.current = tabs;

	// Compatibility-only projection for callers that still address the Center
	// layout as a legacy Split. Geometry and membership come from Workbench.
	const splitsRef = useRef<Split[]>(splits);
	splitsRef.current = splits;
	// Read by `openTab` so its identity does not follow every re-projection: the
	// projection builds a new Set on each Workbench change, including each tab
	// activation.
	const splitMemberIdsRef = useRef<ReadonlySet<string>>(
		centerSplitProjection.memberIds
	);
	splitMemberIdsRef.current = centerSplitProjection.memberIds;

	// Kept in sync with `groups` so split-creation callbacks can pick a color
	// that is distinct from every open group without a stale closure.
	const groupsRef = useRef<TabGroup[]>(groups);
	groupsRef.current = groups;

	// Last time each tab was the active view, keyed by tab id. Held in a ref (not
	// tab state) so stamping it on every activation doesn't churn renders; the
	// auto-unload timer reads it directly.
	const lastActiveAtRef = useRef<Record<string, number>>(
		initialTabActivity(initialState.tabs, Date.now())
	);
	const activeTabIdRef = useRef<string>(activeTabId);
	activeTabIdRef.current = activeTabId;
	const processedWorkbenchClosedIdsRef = useRef(new Set<string>());
	useEffect(() => {
		for (const item of workbenchState.items) {
			processedWorkbenchClosedIdsRef.current.delete(item.id);
		}
		const newlyClosedIds = new Set(
			workbenchState.closedItems.flatMap(({ item }) =>
				item.source.kind === "route" &&
				!processedWorkbenchClosedIdsRef.current.has(item.id)
					? [item.id]
					: []
			)
		);
		if (newlyClosedIds.size === 0) {
			return;
		}
		const current = tabsRef.current;
		const closed = current.flatMap((tab, index) =>
			newlyClosedIds.has(tab.id) ? [{ index, tab }] : []
		);
		for (const itemId of newlyClosedIds) {
			processedWorkbenchClosedIdsRef.current.add(itemId);
		}
		if (closed.length === 0) {
			return;
		}
		const next = current.filter((tab) => !newlyClosedIds.has(tab.id));
		tabsRef.current = next;
		setTabs(next);
		setClosedTabs((stack) => [...stack, ...closed]);
	}, [workbenchState.closedItems, workbenchState.items]);

	// Managed-path numeric cap on OPEN TABS (free-tier gating). Held in refs so the
	// openTab callback reads the live limit + upgrade opener without re-creating on
	// every entitlement change. Off the managed path the limit is Infinity, so
	// self-host / local-Core-without-billing is never capped.
	const { verdict, requestUpgrade, requestDesktopLicense } =
		useEntitlementContext();
	const tabLimitRef = useRef<number>(Number.POSITIVE_INFINITY);
	tabLimitRef.current = hasBillingAuth()
		? capLimit(effectivePlan(verdict), "maxOpenTabs")
		: Number.POSITIVE_INFINITY;
	const requestUpgradeRef = useRef(requestDesktopLicense ?? requestUpgrade);
	requestUpgradeRef.current = requestDesktopLicense ?? requestUpgrade;

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
	const markActive = useCallback(
		(id: string) => {
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
			dispatchWorkbench({ type: "item/activate", itemId: id });
			setTabs((prev) => {
				if (!prev.some((tab) => tab.id === id && tab.unloaded)) {
					return prev;
				}
				const next = prev.map((tab) =>
					tab.id === id ? { ...tab, unloaded: false } : tab
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
			setSplitPresentation((current) =>
				current.collapsed ? { ...current, collapsed: false } : current
			);
		},
		[dispatchWorkbench]
	);

	const openTabRoute = useCallback(
		(
			path: string,
			opts?: {
				title?: string;
				conversationId?: string;
				forceNew?: boolean;
				initialPrompt?: string;
				initialQuote?: string;
				initialModel?: string;
				initialProactiveOpening?: boolean;
				initialSubmit?: boolean;
				initialImages?: AttachedImage[];
				initialAgent?: string;
				initialTeamId?: string;
				initialGhost?: boolean;
				initialPluginFlags?: Record<string, boolean>;
				initialProject?: string;
				initialStoreQuery?: string;
				initialStoreItem?: { id: string; kind: string };
				mountContext?: Record<string, RyuJsonValue> | null;
				worktreeMode?: boolean;
				icon?: GlyphValue;
				node?: string;
			}
			// legacy component
		): string => {
			const current = tabsRef.current;
			const base = path.split("?")[0];

			// Record the visit so the Library's Recents tab reflects navigation
			// from anywhere (sidebar, palette, Library). No-ops for routes that
			// carry no resolvable item.
			stampRecentFromPath(base, opts?.conversationId);

			const patchIcon = <T extends Tab>(tab: T): T =>
				opts?.icon === undefined ? tab : { ...tab, icon: opts.icon };

			// Each multi-section shell (the Library, the Customize store) is ONE tab
			// that switches sections in place: any navigation into the family reuses
			// the open tab and swaps its section (bumping navToken to force a remount
			// so the page re-reads `initialSection`) rather than stacking a second
			// one. Falls through to normal singleton creation when none is open.
			// Family-wide, not `/library`-prefixed: now that every route in a family
			// shares one title, per-path singletons would leave the user staring at
			// several identically-named "Library" tabs — the same defect in a new
			// shape. `forceNew` (middle-click, "open in new tab") still opts out.
			//
			// Two tiers, and the ORDER is load-bearing. An exact-path match wins, so
			// this branch can never do less than the `isSingleton` guard below it
			// used to: navigating to a route that is already open activates THAT tab
			// (split members included, exactly as the singleton guard did) instead of
			// rewriting some other family member onto the same path — which would
			// leave two identically-pathed, identically-titled tabs, the second of
			// them unreachable by navigation for the rest of the session. Only when
			// no tab is on the route does the family fallback re-point one.
			//
			// The family tier skips split members (`!t.splitId`) — see `setTabRoute`'s
			// note: a sidebar click must never rewrite a pane the user deliberately
			// tiled. The old `/library`-only predicate had no such guard, but widening
			// the family from 9 Library routes to ~20 across both shells would
			// otherwise have made "click Plugins, lose the /models pane you were
			// reading" a routine accident. A PINNED shell tab is still reused:
			// pinning says "keep this tab", not "keep this section", and skipping it
			// would spawn a second tab with the very same name.
			const shell = shellRoute(base);
			if (shell && !opts?.forceNew) {
				const existing =
					current.find((t) => t.path === base) ??
					current.find(
						(t) =>
							!splitMemberIdsRef.current.has(t.id) &&
							shellRoute(t.path)?.family === shell.family
					);
				if (existing) {
					// `existing.title !== shell.title` heals a tab whose stale label was
					// written by an older build and is still open in THIS session (the
					// restore-time migration only catches it across a relaunch);
					// `existing.icon !== undefined` does the same for a stale glyph the
					// tab carried in from an entity route (see `resolveTabGlyph`).
					if (
						existing.path !== base ||
						existing.title !== shell.title ||
						existing.icon !== undefined ||
						opts?.mountContext !== undefined ||
						opts?.initialStoreQuery !== undefined ||
						opts?.initialStoreItem !== undefined
					) {
						const reused: Tab = {
							...existing,
							path: base,
							title: resolveTabTitle(path, opts?.title),
							icon: resolveTabGlyph(base, opts?.icon ?? existing.icon),
							...(opts?.mountContext === undefined
								? undefined
								: { mountContext: opts.mountContext }),
							...(opts?.initialStoreQuery === undefined
								? undefined
								: { initialStoreQuery: opts.initialStoreQuery }),
							...(opts?.initialStoreItem === undefined
								? undefined
								: { initialStoreItem: opts.initialStoreItem }),
							navToken:
								existing.path === base &&
								opts?.mountContext === undefined &&
								opts?.initialStoreQuery === undefined &&
								opts?.initialStoreItem === undefined
									? existing.navToken
									: (existing.navToken ?? 0) + 1,
						};
						dispatchWorkbench({
							type: "item/update",
							item: routeWorkbenchItem(reused),
						});
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
					if (opts?.icon !== undefined || opts?.mountContext !== undefined) {
						const patched: Tab = {
							...patchIcon(existing),
							...(opts.mountContext === undefined
								? undefined
								: {
										mountContext: opts.mountContext,
										navToken: (existing.navToken ?? 0) + 1,
									}),
						};
						setTabs((prev) => {
							const next = normalize(
								prev.map((t) => (t.id === patched.id ? patched : t))
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

			const nodeStore = useNodeStore.getState();
			const defaultName = nodeStore.getActiveNode().name;
			const requestedNode =
				opts?.node && opts.node !== defaultName ? opts.node : null;
			// Bind (or unbind) only a tab this call actually opened or focused. The
			// tab-cap early return below hands back the ACTIVE tab, which must never
			// be silently rebound to another computer.
			const bindNode = (tabId: string) => {
				if (requestedNode) {
					nodeStore.setTabOverride(tabId, requestedNode);
				} else if (useNodeStore.getState().tabOverrides[tabId]) {
					nodeStore.clearTabOverride(tabId);
				}
			};

			if (!opts?.forceNew && opts?.conversationId) {
				const normalizedOverrides: Record<string, string> = {};
				for (const tab of current) {
					const key = tabNodeKey(nodeStore.tabOverrides, tab.id, defaultName);
					if (key) {
						normalizedOverrides[tab.id] = key;
					}
				}
				const existing = findChatTabOnNode(
					current,
					opts.conversationId,
					requestedNode,
					normalizedOverrides
				);
				if (existing) {
					// An explicit per-tab run mode (a handoff opening a handed-off
					// worktree) applies to the focused tab too, not only a new one.
					const worktreeModeChanged =
						opts.worktreeMode !== undefined &&
						opts.worktreeMode !== existing.worktreeMode;
					if (
						opts.icon !== undefined ||
						(opts.title !== undefined && opts.title !== existing.title) ||
						worktreeModeChanged
					) {
						const patched: Tab = {
							...patchIcon(existing),
							...(opts.title === undefined ? undefined : { title: opts.title }),
							...(worktreeModeChanged
								? { worktreeMode: opts.worktreeMode }
								: undefined),
						};
						dispatchWorkbench({
							type: "item/update",
							item: routeWorkbenchItem(patched),
						});
						setTabs((prev) => {
							const next = normalize(
								prev.map((t) => (t.id === patched.id ? patched : t))
							);
							tabsRef.current = next;
							return next;
						});
					}
					if (requestedNode) {
						bindNode(existing.id);
					}
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
				!splitMemberIdsRef.current.has(activeTab.id)
			) {
				const reused: Tab = {
					...activeTab,
					path: base,
					title: resolveTabTitle(path, opts?.title),
					// The tab keeps the route's own glyph, not the one the previous
					// route left on it (see `resolveTabGlyph`).
					icon: resolveTabGlyph(base, opts?.icon ?? activeTab.icon),
					conversationId: opts?.conversationId,
					initialPrompt: opts?.initialPrompt,
					initialQuote: opts?.initialQuote,
					initialModel: opts?.initialModel,
					initialProactiveOpening: opts?.initialProactiveOpening,
					initialSubmit: opts?.initialSubmit,
					initialImages: opts?.initialImages,
					initialAgent: opts?.initialAgent,
					initialTeamId: opts?.initialTeamId,
					initialGhost: opts?.initialGhost,
					initialPluginFlags: opts?.initialPluginFlags,
					initialProject: opts?.initialProject,
					initialStoreQuery: opts?.initialStoreQuery,
					initialStoreItem: opts?.initialStoreItem,
					mountContext: opts?.mountContext,
					worktreeMode: opts?.worktreeMode,
					workspaceSession: undefined,
					// Force a fresh mount so the page re-seeds from the new props
					// (otherwise ChatPage keeps rendering the previous thread).
					navToken: (activeTab.navToken ?? 0) + 1,
					unloaded: false,
				};
				// The reused tab shows new content, so it takes the requested
				// computer, and a stale binding from its previous page is cleared.
				bindNode(reused.id);
				dispatchWorkbench({
					type: "item/update",
					item: routeWorkbenchItem(reused),
				});
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
				title: resolveTabTitle(path, opts?.title),
				icon: resolveTabGlyph(base, opts?.icon),
				conversationId: opts?.conversationId,
				initialPrompt: opts?.initialPrompt,
				initialQuote: opts?.initialQuote,
				initialModel: opts?.initialModel,
				initialProactiveOpening: opts?.initialProactiveOpening,
				initialSubmit: opts?.initialSubmit,
				initialImages: opts?.initialImages,
				initialAgent: opts?.initialAgent,
				initialTeamId: opts?.initialTeamId,
				initialGhost: opts?.initialGhost,
				initialPluginFlags: opts?.initialPluginFlags,
				initialProject: opts?.initialProject,
				initialStoreQuery: opts?.initialStoreQuery,
				initialStoreItem: opts?.initialStoreItem,
				mountContext: opts?.mountContext,
				worktreeMode: opts?.worktreeMode,
			};
			// Before the tab mounts, so its first render already reads the binding.
			if (requestedNode) {
				bindNode(newTab.id);
			}
			openWorkbenchItem(routeWorkbenchItem(newTab), { region: "center" });
			setTabs((prev) => {
				const next = normalize([...prev, newTab]);
				tabsRef.current = next;
				return next;
			});
			markActive(newTab.id);
			pushHistory(newTab.id);
			return newTab.id;
		},
		[dispatchWorkbench, markActive, openWorkbenchItem, pushHistory]
	);

	const openTab = useCallback<typeof openTabRoute>(
		(path, opts) => {
			const id = openTabRoute(path, opts);
			notifyTabOpenRequest(id);
			return id;
		},
		[openTabRoute]
	);

	const closeTab = useCallback(
		(id: string, options?: { transferred?: boolean }) => {
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
			const closingGroup = workbenchState.groups.find((group) =>
				group.itemIds.includes(id)
			);
			dispatchWorkbench({ type: "item/close", itemId: id });
			if (!options?.transferred) {
				setClosedTabs((stack) => [...stack, { tab: prev[idx], index: idx }]);
			}
			// If the tab is part of a split, its surviving siblings stay together.
			// Prefer focusing one of them so the split remains visible after the
			// close, rather than jumping to an unrelated neighbor tab.
			const siblings = centerSplitProjection.memberIds.has(id)
				? [...centerSplitProjection.memberIds].filter((itemId) => itemId !== id)
				: (closingGroup?.itemIds.filter(
						(itemId) => itemId !== id && prev.some((tab) => tab.id === itemId)
					) ?? []);
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
			tabsRef.current = next;
			setTabs(next);
			if (wasActive) {
				activeTabIdRef.current = nextActive;
				setActiveTabId(nextActive);
				if (nextActive) {
					dispatchWorkbench({ type: "item/activate", itemId: nextActive });
				}
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
			setSplitPresentation((current) =>
				current.collapsed ? { ...current, collapsed: false } : current
			);
		},
		[
			centerSplitProjection.memberIds,
			dispatchWorkbench,
			syncNav,
			workbenchState.groups,
		]
	);

	const restoreTab = useCallback(() => {
		const last = closedTabs.at(-1);
		if (!last) {
			return;
		}
		const { tab, index } = last;
		// Drop any stale split membership — the split was almost certainly
		// dissolved when this tab closed, so restore it as a standalone tab.
		const restored: Tab = {
			...tab,
			unloaded: false,
			splitId: undefined,
		};
		dispatchWorkbench({ type: "item/restore", itemId: restored.id });
		setTabs((prev) => {
			const next = [...prev];
			next.splice(Math.min(index, next.length), 0, restored);
			const normalized = normalize(next);
			tabsRef.current = normalized;
			return normalized;
		});
		markActive(restored.id);
		pushHistory(restored.id);
		setClosedTabs((stack) => stack.slice(0, -1));
	}, [closedTabs, dispatchWorkbench, markActive, pushHistory]);

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

	const updateTabTitle = useCallback(
		(id: string, title: string) => {
			// A page's title-bar effect re-runs whenever its tab is activated and
			// writes the title it already has. That must not commit a new Workbench
			// state, re-render the tab strip, or schedule a session snapshot. The
			// strip shows the Workbench item's title, and a restore can leave it
			// different from the runtime tab's, so skip only when both agree.
			if (
				tabsRef.current.find((tab) => tab.id === id)?.title === title &&
				getWorkbenchState().items.find((item) => item.id === id)?.title ===
					title
			) {
				return;
			}
			const next = tabsRef.current.map((tab) =>
				tab.id === id ? { ...tab, title } : tab
			);
			const updated = next.find((tab) => tab.id === id);
			if (!updated) {
				return;
			}
			tabsRef.current = next;
			setTabs(next);
			dispatchWorkbench({
				type: "item/update",
				item: routeWorkbenchItem(updated),
			});
		},
		[dispatchWorkbench, getWorkbenchState]
	);

	const updateTabWorkspaceSession = useCallback(
		(id: string, workspaceSession: WorkspaceSessionState) => {
			setTabs((prev) => {
				const current = prev.find((tab) => tab.id === id)?.workspaceSession;
				if (sameWorkspaceSessionState(current, workspaceSession)) {
					return prev;
				}
				const next = prev.map((tab) =>
					tab.id === id ? { ...tab, workspaceSession } : tab
				);
				tabsRef.current = next;
				return next;
			});
		},
		[]
	);

	const updateTabWorktreeMode = useCallback(
		(id: string, worktreeMode: boolean | undefined) => {
			setTabs((prev) => {
				const current = prev.find((tab) => tab.id === id);
				if (!current || current.worktreeMode === worktreeMode) {
					return prev;
				}
				const next = prev.map((tab) =>
					tab.id === id ? { ...tab, worktreeMode } : tab
				);
				tabsRef.current = next;
				return next;
			});
		},
		[]
	);

	// See the interface doc: this is the write-back that makes a chat tab's thread
	// durable. `bindConversation` returns the array unchanged when nothing moves,
	// so a repeat call from ChatPage's effect never re-snapshots the session.
	const bindTabConversation = useCallback(
		(tabId: string, conversationId: string | undefined) => {
			const current = tabsRef.current;
			const next = bindConversation(current, tabId, conversationId);
			if (next === current) {
				return;
			}
			tabsRef.current = next;
			setTabs(next);
			const updated = next.find((tab) => tab.id === tabId);
			if (updated) {
				dispatchWorkbench({
					type: "item/update",
					item: routeWorkbenchItem(updated),
				});
			}
		},
		[dispatchWorkbench]
	);

	const updateTabIcon = useCallback((id: string, icon: GlyphValue) => {
		setTabs((prev) => {
			const next = prev.map((t) => (t.id === id ? { ...t, icon } : t));
			tabsRef.current = next;
			return next;
		});
	}, []);

	const updateTabsIconWhere = useCallback(
		(match: (tab: Tab) => boolean, icon: GlyphValue) => {
			setTabs((prev) => {
				let changed = false;
				const next = prev.map((t) => {
					if (!match(t)) {
						return t;
					}
					changed = true;
					return { ...t, icon };
				});
				if (!changed) {
					return prev;
				}
				tabsRef.current = next;
				return next;
			});
		},
		[]
	);

	const updateTabBusy = useCallback(
		(id: string, busy: boolean, speed?: "slow" | "normal" | "fast") => {
			setTabs((prev) => {
				const target = prev.find((t) => t.id === id);
				const busySpeed = busy ? (speed ?? "normal") : undefined;
				if (
					!target ||
					(target.busy === busy && target.busySpeed === busySpeed)
				) {
					return prev;
				}
				return prev.map((t) => (t.id === id ? { ...t, busy, busySpeed } : t));
			});
		},
		[]
	);

	const requestScrollToMessage = useCallback(
		(conversationId: string, messageId: string) => {
			setTabs((prev) => {
				const target = findChatTab(prev, conversationId);
				if (!target) {
					return prev;
				}
				return prev.map((t) =>
					t.id === target.id ? { ...t, scrollToMessageId: messageId } : t
				);
			});
		},
		[]
	);

	const clearScrollToMessage = useCallback((tabId: string) => {
		setTabs((prev) => {
			const target = prev.find((t) => t.id === tabId);
			if (!target?.scrollToMessageId) {
				return prev;
			}
			return prev.map((t) =>
				t.id === tabId ? { ...t, scrollToMessageId: undefined } : t
			);
		});
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
			const targetGroup = workbenchState.groups.find((group) =>
				group.itemIds.includes(targetId)
			);
			if (targetGroup) {
				const draggedGroup = workbenchState.groups.find((group) =>
					group.itemIds.includes(draggedId)
				);
				if (draggedGroup?.id === targetGroup.id) {
					const withoutDragged = targetGroup.itemIds.filter(
						(itemId) => itemId !== draggedId
					);
					const targetIndex = withoutDragged.indexOf(targetId);
					dispatchWorkbench({
						type: "item/reorder",
						groupId: targetGroup.id,
						itemId: draggedId,
						toIndex: before ? targetIndex : targetIndex + 1,
					});
				} else {
					const targetIndex = targetGroup.itemIds.indexOf(targetId);
					dispatchWorkbench({
						type: "item/move",
						itemId: draggedId,
						toGroupId: targetGroup.id,
						index: before ? targetIndex : targetIndex + 1,
					});
				}
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
		[dispatchWorkbench, workbenchState.groups]
	);

	// --- Pinning ---------------------------------------------------------------
	const togglePin = useCallback(
		(id: string) => {
			const currentTarget = tabsRef.current.find((tab) => tab.id === id);
			if (!currentTarget) {
				return;
			}
			if (!currentTarget.pinned) {
				detachCenterItem({
					dispatch: dispatchWorkbench,
					itemId: id,
					state: workbenchState,
				});
			}
			dispatchWorkbench({
				type: "item/pin",
				itemId: id,
				pinned: !currentTarget.pinned,
			});
			setTabs((prev) => {
				const target = prev.find((t) => t.id === id);
				if (!target) {
					return prev;
				}
				const pinning = !target.pinned;
				// Pinning detaches a tab from its group and split (Chrome behavior); a
				// pinned tab is icon-only and can't host a side-by-side pane.
				const mapped = prev.map((t) =>
					t.id === id
						? {
								...t,
								pinned: pinning,
								groupId: pinning ? undefined : t.groupId,
								splitId: undefined,
							}
						: t
				);
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			// A pin may have emptied a presentation group.
			setGroups((prev) =>
				prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
			);
		},
		[dispatchWorkbench, workbenchState]
	);

	// --- Unloading -------------------------------------------------------------
	const unloadTab = useCallback(
		(id: string) => {
			if (
				id === activeTabIdRef.current ||
				tabsRef.current.find((tab) => tab.id === id)?.busy ||
				workbenchActiveItemsProtectedFromUnload(workbenchState).has(id)
			) {
				return;
			}
			setTabs((prev) => {
				const next = prev.map((t) =>
					t.id === id ? { ...t, unloaded: true } : t
				);
				tabsRef.current = next;
				return next;
			});
		},
		[workbenchState]
	);

	// --- Grouping --------------------------------------------------------------
	const addTabToGroup = useCallback(
		(tabId: string, groupId: string) => {
			detachCenterItem({
				dispatch: dispatchWorkbench,
				itemId: tabId,
				state: workbenchState,
			});
			dispatchWorkbench({ type: "item/pin", itemId: tabId, pinned: false });
			setTabs((prev) => {
				const mapped = prev.map((t) =>
					t.id === tabId
						? { ...t, groupId, pinned: false, splitId: undefined }
						: t
				);
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
		},
		[dispatchWorkbench, workbenchState]
	);

	const createGroup = useCallback(
		(tabId: string): string => {
			const id = makeGroupId();
			setGroups((prev) => [
				...prev,
				{
					id,
					name: "Group",
					color: nextClusterColor(prev, splitsRef.current),
					collapsed: false,
				},
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

	const renameSplit = useCallback((splitId: string, name: string) => {
		if (splitId === WORKBENCH_CENTER_SPLIT_ID) {
			setSplitPresentation((current) => ({ ...current, name }));
		}
	}, []);

	const setSplitColor = useCallback((splitId: string, color: TabGroupColor) => {
		if (splitId === WORKBENCH_CENTER_SPLIT_ID) {
			setSplitPresentation((current) => ({ ...current, color }));
		}
	}, []);

	const toggleSplitCollapsed = useCallback((splitId: string) => {
		if (splitId === WORKBENCH_CENTER_SPLIT_ID) {
			setSplitPresentation((current) => ({
				...current,
				collapsed: !current.collapsed,
			}));
		}
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
	const prepareTabForWorkbenchSplit = useCallback(
		(tabId: string) => {
			if (!tabsRef.current.some((tab) => tab.id === tabId)) {
				return;
			}
			dispatchWorkbench({ type: "item/pin", itemId: tabId, pinned: false });
			const next = normalize(
				tabsRef.current.map((tab) =>
					tab.id === tabId
						? {
								...tab,
								groupId: undefined,
								pinned: false,
								splitId: undefined,
								unloaded: false,
							}
						: tab
				)
			);
			tabsRef.current = next;
			setTabs(next);
			setGroups((current) =>
				current.filter((group) => next.some((tab) => tab.groupId === group.id))
			);
		},
		[dispatchWorkbench]
	);

	const splitTabs = useCallback(
		(tabIds: string[], orientation: SplitOrientation = "columns") => {
			const unique = [...new Set(tabIds)].filter((id) =>
				tabsRef.current.some((t) => t.id === id)
			);
			if (unique.length < 2) {
				return;
			}
			const groupIds = placeTabsInCenter({
				dispatch: dispatchWorkbench,
				state: workbenchState,
				tabIds: unique,
			});
			if (groupIds.length !== unique.length) {
				return;
			}
			dispatchWorkbench({
				type: "center/replace-tree",
				tree: {
					type: "branch",
					children: groupIds.map((groupId) => ({ type: "leaf", groupId })),
					orientation,
					sizes: Array.from(
						{ length: groupIds.length },
						() => 1 / groupIds.length
					),
				},
			});
			setSplitPresentation((current) => ({
				...current,
				collapsed: false,
				color: nextClusterColor(groupsRef.current, []),
				name: "",
			}));
			setTabs((prev) => {
				const next = normalize(
					prev.map((t) =>
						unique.includes(t.id)
							? {
									...t,
									splitId: undefined,
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
			markActive(unique[0]);
		},
		[dispatchWorkbench, markActive, workbenchState]
	);

	// Tile tabs into a split whose SHAPE comes from a saved preset. Deliberately
	// a sibling of `splitTabs` rather than an option on it: `splitTabs` builds
	// one flat equal-sized run, and nesting ("one tall pane beside two stacked")
	// is not expressible that way. The membership choreography below is copied
	// from `splitTabs` on purpose — the synchronous `tabsRef.current` write and
	// the `unloaded: false` wake are both load-bearing (see the comment there).
	const applySplitPreset = useCallback(
		(root: PresetBranch, tabIds: string[]) => {
			const unique = [...new Set(tabIds)].filter((id) =>
				tabsRef.current.some((t) => t.id === id)
			);
			// Validate the tree BEFORE touching membership: a preset that can't be
			// filled would leave `reconcileSplits` to rebuild it FLAT, silently
			// discarding the nesting the user picked the preset for.
			const tree = buildPresetTree(root, unique);
			if (!tree || unique.length < 2) {
				return;
			}
			const members = new Set(leafOrder(tree));
			const groupIds = placeTabsInCenter({
				dispatch: dispatchWorkbench,
				state: workbenchState,
				tabIds: leafOrder(tree),
			});
			const centerTree = presetCenterTree(root, groupIds.values());
			if (!centerTree) {
				return;
			}
			dispatchWorkbench({ type: "center/replace-tree", tree: centerTree });
			setSplitPresentation((current) => ({
				...current,
				collapsed: false,
				color: nextClusterColor(groupsRef.current, []),
				name: "",
			}));
			setTabs((prev) => {
				const next = normalize(
					prev.map((t) =>
						members.has(t.id)
							? {
									...t,
									splitId: undefined,
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
			markActive(unique[0]);
		},
		[dispatchWorkbench, markActive, workbenchState]
	);

	// "Apply a preset onto empty panes": open one real tab per slot — its
	// remembered route, or the pane chooser — and tile them into the preset's
	// shape. Placeholders are ordinary tabs, so nothing in `reconcileSplits`
	// needs a vacancy concept.
	const applySplitPresetToNewTabs = useCallback(
		(root: PresetBranch) => {
			const slots = presetSlots(root);
			if (slots.length < 2) {
				return;
			}
			// All-or-nothing against the tab cap: opening panes one at a time would
			// stop mid-preset and leave a half-applied split.
			if (tabsRef.current.length + slots.length > tabLimitRef.current) {
				requestUpgradeRef.current();
				return;
			}
			// Minted here rather than through N× `openTab` on purpose: `openTab`
			// publishes each new tab through its own `setTabs`, and only the FIRST
			// updater in a batch is evaluated eagerly — so the second call would
			// read a stale `tabsRef` and the split would come out short.
			const created: Tab[] = slots.map((slot) => {
				const base = (slot.path ?? PANE_CHOOSER_PATH).split("?")[0];
				return {
					id: makeTabId(),
					path: base,
					title: defaultTitle(base),
				};
			});
			const tree = buildPresetTree(
				root,
				created.map((t) => t.id)
			);
			if (!tree) {
				return;
			}
			for (const tab of created) {
				openWorkbenchItem(routeWorkbenchItem(tab), { region: "center" });
			}
			const groupIds = placeTabsInCenter({
				dispatch: dispatchWorkbench,
				state: workbenchState,
				tabIds: created.map((tab) => tab.id),
			});
			const centerTree = presetCenterTree(root, groupIds.values());
			if (!centerTree) {
				return;
			}
			dispatchWorkbench({ type: "center/replace-tree", tree: centerTree });
			setSplitPresentation((current) => ({
				...current,
				collapsed: false,
				color: nextClusterColor(groupsRef.current, []),
				name: "",
			}));
			setTabs((prev) => {
				const next = normalize([...prev, ...created]);
				tabsRef.current = next;
				return next;
			});
			markActive(created[0].id);
			pushHistory(created[0].id);
		},
		[
			dispatchWorkbench,
			markActive,
			openWorkbenchItem,
			pushHistory,
			workbenchState,
		]
	);

	const removeFromSplit = useCallback(
		(tabId: string) => {
			detachCenterItem({
				dispatch: dispatchWorkbench,
				itemId: tabId,
				state: workbenchState,
			});
			setTabs((prev) => {
				const mapped = prev.map((t) =>
					t.id === tabId ? { ...t, splitId: undefined } : t
				);
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
		},
		[dispatchWorkbench, workbenchState]
	);

	const unsplit = useCallback(
		(tabId: string) => {
			const centerGroups = workbenchState.groups.filter(
				(group) => group.region === "center"
			);
			const primaryGroup =
				centerGroups.find((group) => group.itemIds.includes(tabId)) ??
				centerGroups[0];
			if (primaryGroup) {
				for (const group of centerGroups) {
					if (group.id === primaryGroup.id) {
						continue;
					}
					for (const itemId of group.itemIds) {
						dispatchWorkbench({
							type: "item/move",
							itemId,
							toGroupId: primaryGroup.id,
						});
					}
					dispatchWorkbench({
						type: "center/remove-group",
						groupId: group.id,
					});
				}
			}
			setTabs((prev) => {
				const next = normalize(
					prev.map((tab) => ({ ...tab, splitId: undefined }))
				);
				tabsRef.current = next;
				return next;
			});
		},
		[dispatchWorkbench, workbenchState.groups]
	);

	// Flips the ROOT branch's axis. For a flat (unnested) split this is the
	// whole layout; for a nested one it re-tilts the outermost run while inner
	// branches keep their own axes — then normalize merges any child branch
	// that now matches the new root orientation.
	const setSplitOrientation = useCallback(
		(splitId: string, orientation: SplitOrientation) => {
			if (
				splitId !== WORKBENCH_CENTER_SPLIT_ID ||
				workbenchState.centerTree.type !== "branch" ||
				workbenchState.centerTree.orientation === orientation
			) {
				return;
			}
			dispatchWorkbench({
				type: "center/replace-tree",
				tree: { ...workbenchState.centerTree, orientation },
			});
		},
		[dispatchWorkbench, workbenchState]
	);

	// Even out the panes after the gutters have been dragged around. Sizes only:
	// membership is untouched, so no reconcile/prune is involved. Recursive by
	// design, unlike `setSplitOrientation` above — an inner branch left skewed
	// would make "equalize panes" look like it did nothing.
	const equalizeSplit = useCallback(
		(splitId: string) => {
			if (splitId !== WORKBENCH_CENTER_SPLIT_ID) {
				return;
			}
			for (const branch of centerBranchSizes(workbenchState.centerTree)) {
				dispatchWorkbench({
					type: "center/resize-branch",
					path: branch.path,
					sizes: branch.sizes,
				});
			}
		},
		[dispatchWorkbench, workbenchState.centerTree]
	);

	const setSplitSizes = useCallback(
		(splitId: string, path: number[], sizes: number[]) => {
			if (splitId !== WORKBENCH_CENTER_SPLIT_ID) {
				return;
			}
			dispatchWorkbench({ type: "center/resize-branch", path, sizes });
		},
		[dispatchWorkbench]
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
			const originalTargetGroup = workbenchState.groups.find((group) =>
				group.itemIds.includes(targetTabId)
			);
			const sourceGroup = workbenchState.groups.find((group) =>
				group.itemIds.includes(sourceTabId)
			);
			const centerTargetGroup =
				originalTargetGroup?.region === "center"
					? originalTargetGroup
					: workbenchState.groups.find((group) => group.region === "center");
			if (centerTargetGroup) {
				if (originalTargetGroup?.region !== "center") {
					dispatchWorkbench({
						type: "item/move",
						itemId: targetTabId,
						toGroupId: centerTargetGroup.id,
					});
				}
				const newGroupId = makeGroupId();
				dispatchWorkbench({
					type: "center/split",
					direction,
					newGroupId,
					targetGroupId: centerTargetGroup.id,
				});
				dispatchWorkbench({
					type: "item/move",
					itemId: sourceTabId,
					toGroupId: newGroupId,
				});
				dispatchWorkbench({
					type: "item/pin",
					itemId: sourceTabId,
					pinned: false,
				});
				dispatchWorkbench({
					type: "item/pin",
					itemId: targetTabId,
					pinned: false,
				});
				if (
					sourceGroup?.region === "center" &&
					sourceGroup.id !== centerTargetGroup.id &&
					sourceGroup.itemIds.length === 1
				) {
					dispatchWorkbench({
						type: "center/remove-group",
						groupId: sourceGroup.id,
					});
				}
			}
			setTabs((prev) => {
				const mapped = prev.map((t) => {
					if (t.id === sourceTabId || t.id === targetTabId) {
						return {
							...t,
							splitId: undefined,
							pinned: false,
							groupId: undefined,
							unloaded: false,
						};
					}
					return t;
				});
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			setGroups((prev) =>
				prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
			);
			markActive(sourceTabId);
		},
		[dispatchWorkbench, markActive, workbenchState.groups]
	);

	// Swap the pane positions of two members of the same split (center-drop on
	// a pane). Membership and sizes stay put — only the leaves trade places.
	const swapSplitPanes = useCallback(
		(aTabId: string, bTabId: string) => {
			if (aTabId === bTabId) {
				return;
			}
			const aGroup = workbenchState.groups.find((group) =>
				group.itemIds.includes(aTabId)
			);
			const bGroup = workbenchState.groups.find((group) =>
				group.itemIds.includes(bTabId)
			);
			if (
				aGroup?.region === "center" &&
				bGroup?.region === "center" &&
				aGroup.id !== bGroup.id
			) {
				dispatchWorkbench({
					type: "item/move",
					itemId: aTabId,
					toGroupId: bGroup.id,
				});
				dispatchWorkbench({
					type: "item/move",
					itemId: bTabId,
					toGroupId: aGroup.id,
				});
			}
		},
		[dispatchWorkbench, workbenchState.groups]
	);

	// Point an existing tab at a different route in place. Same body as
	// `openTab`'s "open in current tab" reuse, minus the `!tab.splitId` guard —
	// that guard protects split panes from being replaced BY ACCIDENT (a sidebar
	// click under the "open links in the current tab" preference), and this call
	// is the user explicitly saying "put this in this pane". Do NOT relax the
	// guard inside `openTab` itself.
	const setTabRoute = useCallback(
		(
			tabId: string,
			path: string,
			opts?: { conversationId?: string; icon?: GlyphValue; title?: string }
		) => {
			const base = path.split("?")[0];
			const target = tabsRef.current.find((t) => t.id === tabId);
			if (!target) {
				return;
			}
			stampRecentFromPath(base, opts?.conversationId);
			const next: Tab = {
				...target,
				path: base,
				title: resolveTabTitle(base, opts?.title),
				conversationId: opts?.conversationId,
				// A shell route owns its glyph, so the pane drops whatever the route
				// it is leaving stamped on it (see `resolveTabGlyph`).
				icon: resolveTabGlyph(base, opts?.icon ?? target.icon),
				// One-shot seeds belong to the route being left behind.
				initialPrompt: undefined,
				initialQuote: undefined,
				initialModel: undefined,
				initialProactiveOpening: undefined,
				initialSubmit: undefined,
				initialImages: undefined,
				initialGhost: undefined,
				initialTeamId: undefined,
				initialPluginFlags: undefined,
				scrollToMessageId: undefined,
				worktreeMode: undefined,
				workspaceSession: undefined,
				// Force a fresh mount so the page re-seeds from the new props
				// (otherwise ChatPage keeps rendering the previous thread).
				navToken: (target.navToken ?? 0) + 1,
				unloaded: false,
			};
			dispatchWorkbench({
				type: "item/update",
				item: routeWorkbenchItem(next),
			});
			setTabs((prev) => {
				const mapped = normalize(prev.map((t) => (t.id === tabId ? next : t)));
				tabsRef.current = mapped;
				return mapped;
			});
		},
		[dispatchWorkbench]
	);

	// Hand a pane over to an already-open tab: the incoming tab takes the exact
	// leaf (and therefore the exact fractions) the pane occupied, and the pane's
	// own tab is dropped. Written as one primitive so the placeholder never
	// enters the user-facing closed-tab stack.
	const replacePaneTab = useCallback(
		(paneTabId: string, tabId: string) => {
			if (paneTabId === tabId) {
				return;
			}
			const current = tabsRef.current;
			const incoming = current.find((t) => t.id === tabId);
			if (!incoming) {
				return;
			}
			const paneGroup = workbenchState.groups.find((group) =>
				group.itemIds.includes(paneTabId)
			);
			const incomingGroup = workbenchState.groups.find((group) =>
				group.itemIds.includes(tabId)
			);
			if (
				paneGroup?.region !== "center" ||
				paneGroup.activeItemId !== paneTabId
			) {
				return;
			}
			dispatchWorkbench({
				type: "item/move",
				itemId: tabId,
				toGroupId: paneGroup.id,
			});
			dispatchWorkbench({ type: "item/close", itemId: paneTabId });
			if (
				incomingGroup?.region === "center" &&
				incomingGroup.id !== paneGroup.id &&
				incomingGroup.itemIds.length === 1
			) {
				dispatchWorkbench({
					type: "center/remove-group",
					groupId: incomingGroup.id,
				});
			}
			// The placeholder is discarded, not closed: it never held anything the
			// user could want back, so it stays out of the reopen-closed-tab stack.
			// Its nav-history entries still have to go, or back/forward would land
			// on a tab that no longer exists.
			useNodeStore.getState().clearTabOverride(paneTabId);
			delete lastActiveAtRef.current[paneTabId];
			const removedBeforePointer = historyRef.current
				.slice(0, pointerRef.current)
				.filter((h) => h === paneTabId).length;
			historyRef.current = historyRef.current.filter((h) => h !== paneTabId);
			pointerRef.current = Math.max(
				0,
				Math.min(
					historyRef.current.length - 1,
					pointerRef.current - removedBeforePointer
				)
			);
			syncNav();
			setTabs((prev) => {
				const mapped = prev
					.filter((t) => t.id !== paneTabId)
					.map((t) => {
						if (t.id === tabId) {
							return {
								...t,
								splitId: undefined,
								pinned: false,
								groupId: undefined,
								unloaded: false,
							};
						}
						return t;
					});
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			setGroups((prev) =>
				prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
			);
			markActive(tabId);
		},
		[dispatchWorkbench, markActive, syncNav, workbenchState.groups]
	);

	// Join `tabId` to an existing split as a new pane at the end of its root
	// run (equal share of space).
	const addTabToSplit = useCallback(
		(splitId: string, tabId: string) => {
			const tab = tabsRef.current.find((t) => t.id === tabId);
			if (
				!tab ||
				splitId !== WORKBENCH_CENTER_SPLIT_ID ||
				centerSplitProjection.memberIds.has(tabId)
			) {
				return;
			}
			const targetGroupId = centerLeafGroupIds(workbenchState.centerTree).at(
				-1
			);
			if (!targetGroupId) {
				return;
			}
			const newGroupId = makeGroupId();
			dispatchWorkbench({
				type: "center/split",
				direction: "right",
				newGroupId,
				targetGroupId,
			});
			dispatchWorkbench({
				type: "item/move",
				itemId: tabId,
				toGroupId: newGroupId,
			});
			dispatchWorkbench({ type: "item/pin", itemId: tabId, pinned: false });
			const currentTree = workbenchState.centerTree;
			const children =
				currentTree.type === "branch"
					? [
							...currentTree.children,
							{ type: "leaf" as const, groupId: newGroupId },
						]
					: [currentTree, { type: "leaf" as const, groupId: newGroupId }];
			dispatchWorkbench({
				type: "center/replace-tree",
				tree: {
					type: "branch",
					children,
					orientation:
						currentTree.type === "branch" ? currentTree.orientation : "columns",
					sizes: Array.from(
						{ length: children.length },
						() => 1 / children.length
					),
				},
			});
			setTabs((prev) => {
				const mapped = prev.map((t) => {
					if (t.id === tabId) {
						return {
							...t,
							splitId: undefined,
							pinned: false,
							groupId: undefined,
							unloaded: false,
						};
					}
					return t;
				});
				const next = normalize(mapped);
				tabsRef.current = next;
				return next;
			});
			setGroups((prev) =>
				prev.filter((g) => tabsRef.current.some((t) => t.groupId === g.id))
			);
			markActive(tabId);
		},
		[
			centerSplitProjection.memberIds,
			dispatchWorkbench,
			markActive,
			workbenchState.centerTree,
		]
	);

	// --- Auto-unload timer -----------------------------------------------------
	// Periodically unloads inactive tabs once they pass the user-configured
	// idle threshold. The active tab and pinned tabs are always exempt. Disabled
	// when the threshold is 0 ("Never").
	useEffect(() => {
		const tick = () => {
			const minutes = readPersistedNumber(
				TAB_UNLOAD_MINUTES_KEY,
				DEFAULT_TAB_UNLOAD_MINUTES
			);
			const now = Date.now();
			setTabs((prev) => {
				const unloadIds = new Set(
					inactiveTabIds(
						prev,
						activeTabIdRef.current,
						lastActiveAtRef.current,
						now,
						minutes
					)
				);
				if (unloadIds.size === 0) {
					return prev;
				}
				let changed = false;
				const next = prev.map((t) => {
					if (
						!unloadIds.has(t.id) ||
						workbenchActiveItemsProtectedFromUnload(workbenchState).has(t.id)
					) {
						return t;
					}
					changed = true;
					return { ...t, unloaded: true };
				});
				if (!changed) {
					return prev;
				}
				tabsRef.current = next;
				return next;
			});
		};
		const interval = setInterval(tick, TAB_UNLOAD_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [workbenchState]);

	// The native process owns cross-window entity routing, while each renderer
	// owns its tab layout. Register only stable entity keys (currently persisted
	// conversations); tab ids, groups, splits, and one-shot composer state remain
	// window-local. The fingerprint guard avoids sending an IPC snapshot for
	// runtime-only updates such as a streaming spinner or title shimmer.
	const entityRegistration = useMemo(() => {
		const entries: Array<{ active: boolean; key: string }> = [];
		const entryIndexes = new Map<string, number>();
		for (const tab of tabs) {
			const key = tabEntityKey({
				conversationId: tab.conversationId,
				node: tabNodeKey(tabOverrides, tab.id, defaultNodeName) ?? undefined,
			});
			if (!key) {
				continue;
			}
			const existingIndex = entryIndexes.get(key);
			if (existingIndex !== undefined) {
				if (tab.id === activeTabId) {
					entries[existingIndex].active = true;
				}
				continue;
			}
			entryIndexes.set(key, entries.length);
			entries.push({ active: tab.id === activeTabId, key });
		}
		return {
			entries,
			fingerprint: JSON.stringify(entries),
		};
	}, [tabs, activeTabId, tabOverrides, defaultNodeName]);
	const entityRegistrationFingerprint = useRef<string | undefined>(undefined);
	const entityRegistrationRevision = useRef(0);
	const entityRegistrationRendererId = useRef(crypto.randomUUID());
	useEffect(() => {
		if (
			entityRegistrationFingerprint.current === entityRegistration.fingerprint
		) {
			return;
		}
		entityRegistrationFingerprint.current = entityRegistration.fingerprint;
		entityRegistrationRevision.current += 1;
		void registerWindowTabs(
			entityRegistrationRendererId.current,
			entityRegistrationRevision.current,
			entityRegistration.entries
		);
	}, [entityRegistration]);

	// A native route focuses the destination first, then emits this event into
	// that renderer. Using the live tab ref keeps the listener stable while tab
	// state changes, and makes a late event a harmless no-op if the tab closed.
	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void listenForEntityActivation(({ key, messageId }) => {
			const { tabOverrides: overrides, getActiveNode } =
				useNodeStore.getState();
			const defaultName = getActiveNode().name;
			const tab = tabsRef.current.find(
				(candidate) =>
					tabEntityKey({
						conversationId: candidate.conversationId,
						node: tabNodeKey(overrides, candidate.id, defaultName) ?? undefined,
					}) === key
			);
			if (tab) {
				activateTab(tab.id);
				if (tab.conversationId && messageId) {
					requestScrollToMessage(tab.conversationId, messageId);
					window.dispatchEvent(
						new CustomEvent("ryu:scroll-to-message", {
							detail: { messageId },
						})
					);
				}
			}
		})
			.then((cleanup) => {
				if (cancelled) {
					cleanup();
					return;
				}
				unlisten = cleanup;
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [activateTab, requestScrollToMessage]);

	// --- Session persistence ---------------------------------------------------
	// Snapshot the main window's open tabs on every change so the "restore
	// previous tabs" startup behavior can reopen them next launch. Tear-off
	// windows (which carry an `initialTab`) never own the session snapshot — they
	// share localStorage, so letting them write would clobber the main window's.
	const pendingSession = useRef<(() => void) | null>(null);
	const flushSession = useCallback(() => {
		pendingSession.current?.();
		pendingSession.current = null;
	}, []);
	useEffect(() => {
		if (initialTab) {
			return;
		}
		// Coalesce rapid navigation and let the selected page paint before
		// serializing the whole session into synchronous browser storage.
		pendingSession.current = () =>
			persistSession(tabs, activeTabId, splits, tabOverrides);
		const timer = window.setTimeout(flushSession, 150);
		return () => window.clearTimeout(timer);
	}, [tabs, activeTabId, splits, tabOverrides, initialTab, flushSession]);
	useEffect(() => {
		const onVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				flushSession();
			}
		};
		window.addEventListener("pagehide", flushSession);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			window.removeEventListener("pagehide", flushSession);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			flushSession();
		};
	}, [flushSession]);

	const focusedWorkbenchItemId = workbenchState.groups.find(
		(group) => group.id === workbenchState.focusedGroupId
	)?.activeItemId;
	const compatibilityActiveTabId = compatibilityTabs.some(
		(tab) => tab.id === focusedWorkbenchItemId
	)
		? (focusedWorkbenchItemId ?? "")
		: activeTabId;
	useEffect(() => {
		if (
			!compatibilityActiveTabId ||
			compatibilityActiveTabId === activeTabIdRef.current
		) {
			return;
		}
		const previous = activeTabIdRef.current;
		if (previous) {
			lastActiveAtRef.current[previous] = Date.now();
		}
		lastActiveAtRef.current[compatibilityActiveTabId] = Date.now();
		activeTabIdRef.current = compatibilityActiveTabId;
		setActiveTabId(compatibilityActiveTabId);
		setTabs((current) => {
			if (
				!current.some(
					(tab) => tab.id === compatibilityActiveTabId && tab.unloaded
				)
			) {
				return current;
			}
			const next = current.map((tab) =>
				tab.id === compatibilityActiveTabId ? { ...tab, unloaded: false } : tab
			);
			tabsRef.current = next;
			return next;
		});
	}, [compatibilityActiveTabId]);

	const value = useMemo<TabsContextValue>(
		() => ({
			tabs: compatibilityTabs,
			groups,
			splits,
			activeTabId: compatibilityActiveTabId,
			openTab,
			closeTab,
			activateTab,
			focusTab,
			updateTabTitle,
			updateTabIcon,
			updateTabsIconWhere,
			updateTabBusy,
			bindTabConversation,
			updateTabWorkspaceSession,
			updateTabWorktreeMode,
			requestScrollToMessage,
			clearScrollToMessage,
			restoreTab,
			hasClosedTabs: closedTabs.length > 0,
			goBack,
			goForward,
			canGoBack,
			canGoForward,
			moveTab,
			prepareTabForWorkbenchSplit,
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
			renameSplit,
			setSplitColor,
			toggleSplitCollapsed,
			splitTabs,
			splitPane,
			swapSplitPanes,
			addTabToSplit,
			removeFromSplit,
			replacePaneTab,
			unsplit,
			setSplitOrientation,
			setSplitSizes,
			setTabRoute,
			applySplitPreset,
			applySplitPresetToNewTabs,
			equalizeSplit,
		}),
		[
			compatibilityActiveTabId,
			activateTab,
			addTabToGroup,
			addTabToSplit,
			applySplitPreset,
			applySplitPresetToNewTabs,
			bindTabConversation,
			canGoBack,
			canGoForward,
			clearScrollToMessage,
			closeGroup,
			closeTab,
			createGroup,
			equalizeSplit,
			focusTab,
			goBack,
			goForward,
			groups,
			moveTab,
			prepareTabForWorkbenchSplit,
			openTab,
			removeFromSplit,
			removeTabFromGroup,
			renameGroup,
			renameSplit,
			requestScrollToMessage,
			restoreTab,
			setGroupColor,
			setSplitColor,
			setSplitOrientation,
			setSplitSizes,
			setTabRoute,
			splitPane,
			splitTabs,
			splits,
			swapSplitPanes,
			compatibilityTabs,
			toggleGroupCollapsed,
			togglePin,
			toggleSplitCollapsed,
			ungroup,
			unloadTab,
			updateTabBusy,
			updateTabIcon,
			updateTabTitle,
			updateTabWorkspaceSession,
			updateTabWorktreeMode,
			updateTabsIconWhere,
			closedTabs.length,
		]
	);

	return <TabsStateProvider value={value}>{children}</TabsStateProvider>;
}
