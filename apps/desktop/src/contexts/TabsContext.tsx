import { planLimit } from "@ryu/auth/lib/plans";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AttachedImage } from "@/components/agent-elements/input-bar.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import {
	bindConversation,
	findChatTab,
} from "@/src/contexts/tab-conversation.ts";
import { readPersistedNumber } from "@/src/hooks/usePersistedNumber.ts";
import { readStartupBehavior } from "@/src/hooks/useStartupBehavior.ts";
import { readTabOpenBehavior } from "@/src/hooks/useTabOpenBehavior.ts";
import { hasBillingAuth } from "@/src/lib/api/billing.ts";
import {
	DASHBOARD_DEFAULT_PATH,
	LEGACY_DASHBOARD_PATH,
} from "@/src/lib/dashboards/app.ts";
import { effectivePlan } from "@/src/lib/gating/planCapBridge.ts";
import { stampRecentFromPath } from "@/src/lib/library.ts";
import {
	buildPresetTree,
	PANE_CHOOSER_PATH,
	type PresetBranch,
	presetSlots,
} from "@/src/lib/splitPresets.ts";
import {
	appendLeaves,
	containsLeaf,
	directionOrientation,
	equalizeNode,
	insertLeaf,
	leafOrder,
	makeBranch,
	makeLeaf,
	normalizeNode,
	pruneToMembers,
	removeLeaf,
	replaceLeaf,
	type SplitBranch,
	type SplitDirection,
	type SplitNode,
	type SplitOrientation,
	setSizesAt,
	swapLeaves,
} from "@/src/lib/splitTree.ts";
import {
	listenForEntityActivation,
	registerWindowTabs,
	tabEntityKey,
} from "@/src/lib/window-routing.ts";
import {
	parseWorkspaceSessionState,
	sameWorkspaceSessionState,
	type WorkspaceSessionState,
} from "@/src/lib/workspace-session.ts";
import { useArtifactStore } from "@/src/store/useArtifactStore.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export type {
	SplitBranch,
	SplitDirection,
	SplitNode,
	SplitOrientation,
} from "@/src/lib/splitTree.ts";

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
	mountContext?: Record<string, unknown> | null;
	/** Bumped each time this tab is navigated in place ("open in current tab").
	    Folded into the pane's React key so a reused tab remounts its page — pages
	    like ChatPage seed state from props once on mount, so without a remount an
	    in-place navigation would keep showing the previous thread. Runtime-only;
	    never persisted. */
	navToken?: number;
	path: string;
	/** Pinned tabs sit in a compact block at the left and never auto-unload. */
	pinned?: boolean;
	/** One-shot message id to scroll into view once the chat tab hydrates.
	    Runtime-only; ChatPage clears it after consuming. */
	scrollToMessageId?: string;
	/** Membership in a Split view (see `splits`). Mirrors `groupId`: the tab is
	    the source of truth for its split membership, so `normalize` keeps split
	    members contiguous and the strip can bracket them. A tab is never both
	    split and grouped, and split members are never pinned. */
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
				...s,
				root: makeBranch("columns", members.map(makeLeaf)),
			});
			continue;
		}
		const present = new Set(leafOrder(pruned));
		const missing = members.filter((id) => !present.has(id));
		out.push({
			...s,
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
	closeTab: (id: string) => void;
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
			mountContext?: Record<string, unknown> | null;
			worktreeMode?: boolean;
			/** Entity glyph to show in the tab strip (mirrors the sidebar). */
			icon?: GlyphValue;
		}
	) => string;
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

/** Exported ONLY so the e2e harness can supply a stub value for a component under
 *  test; app code must go through {@link useTabsContext}, which fails loudly
 *  outside a real {@link TabsProvider}. */
export const TabsContext = createContext<TabsContextValue | null>(null);
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

/** Single-page routes and their tab titles. The Library and the Customize store
    are deliberately ABSENT: every one of their routes is the same multi-section
    shell, so their titles come from {@link shellRoute} instead — see the comment
    there. Do not re-add a per-section key here; it would be dead (shellRoute is
    consulted first) and would drift. */
const PATH_TITLES: Record<string, string> = {
	[DASHBOARD_DEFAULT_PATH]: "Home",
	"/chat": "New chat",
	[PANE_CHOOSER_PATH]: "Empty pane",
	"/identities/new": "New identity",
	"/workflows/build": "Build a workflow",
	"/calendar": "Calendar",
	"/meetings": "Meetings",
	"/quests": "Quests",
	"/timeline": "Timeline",
	"/activity": "Activity",
	"/review": "Weekly review",
	"/approvals": "Inbox",
	"/inbox": "Inbox",
	"/downloads": "Downloads",
	"/settings": "Settings",
};

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

function makeSplitId(): string {
	return `split-${crypto.randomUUID()}`;
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
	const mapped = PATH_TITLES[base];
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
	/** Serialized GlyphValue (or null). Omitted on older sessions. */
	icon?: GlyphValue;
	initialAgent?: string;
	initialProject?: string;
	path: string;
	pinned?: boolean;
	title: string;
	workspaceSession?: WorkspaceSessionState;
	worktreeMode?: boolean;
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
function dedupeShellFamilies(
	tabs: Tab[],
	activeId: string
): { activeId: string; tabs: Tab[] } {
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
		const raw = localStorage.getItem(SESSION_TABS_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as PersistedSession;
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
		const mapped: Tab[] = parsed.tabs.map((t) => {
			const path = migrateLegacyPath(t.path);
			return {
				id: makeTabId(),
				path,
				title: resolveTabTitle(path, t.title),
				conversationId: t.conversationId,
				initialAgent: t.initialAgent,
				initialProject: t.initialProject,
				pinned: t.pinned,
				icon: resolveTabGlyph(path, t.icon),
				workspaceSession: parseWorkspaceSessionState(t.workspaceSession),
				worktreeMode: t.worktreeMode,
			};
		});
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
			splits.push({
				id,
				root: revived,
				collapsed: false,
				name: "",
				color: nextClusterColor([], splits),
			});
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
		// One tab per shell family, the same invariant `openTab` holds. Runs after
		// split revival so the dedupe can see (and spare) split members, and the
		// splits themselves are untouched because no split member is ever dropped.
		const collapsed = dedupeShellFamilies(mapped, activeId);
		return {
			tabs: normalize(collapsed.tabs),
			activeId: collapsed.activeId,
			splits: reconciled,
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
						title: resolveTabTitle(initialTab.path, initialTab.title),
						conversationId: initialTab.conversationId,
						icon: initialTab.icon,
						initialAgent: initialTab.initialAgent,
						initialPrompt: initialTab.initialPrompt,
						initialSubmit: initialTab.initialSubmit,
						initialProactiveOpening: initialTab.initialProactiveOpening,
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

	// Kept in sync with `groups` so split-creation callbacks can pick a color
	// that is distinct from every open group without a stale closure.
	const groupsRef = useRef<TabGroup[]>(groups);
	groupsRef.current = groups;

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
		// The same for a collapsed split: activating any of its panes expands the
		// whole split so the tab is visible in the strip.
		setSplits((prev) => {
			const sid = tabsRef.current.find((t) => t.id === id)?.splitId;
			if (!sid) {
				return prev;
			}
			const s = prev.find((x) => x.id === sid);
			if (!s?.collapsed) {
				return prev;
			}
			return prev.map((x) => (x.id === sid ? { ...x, collapsed: false } : x));
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
				mountContext?: Record<string, unknown> | null;
				worktreeMode?: boolean;
				icon?: GlyphValue;
			}
			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
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
						(t) => !t.splitId && shellRoute(t.path)?.family === shell.family
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
								? {}
								: { mountContext: opts.mountContext }),
							...(opts?.initialStoreQuery === undefined
								? {}
								: { initialStoreQuery: opts.initialStoreQuery }),
							...(opts?.initialStoreItem === undefined
								? {}
								: { initialStoreItem: opts.initialStoreItem }),
							navToken:
								existing.path === base &&
								opts?.mountContext === undefined &&
								opts?.initialStoreQuery === undefined &&
								opts?.initialStoreItem === undefined
									? existing.navToken
									: (existing.navToken ?? 0) + 1,
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
					if (opts?.icon !== undefined || opts?.mountContext !== undefined) {
						const patched: Tab = {
							...patchIcon(existing),
							...(opts.mountContext === undefined
								? {}
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

			if (!opts?.forceNew && opts?.conversationId) {
				const existing = findChatTab(current, opts.conversationId);
				if (existing) {
					if (
						opts.icon !== undefined ||
						(opts.title !== undefined && opts.title !== existing.title)
					) {
						const patched: Tab = {
							...patchIcon(existing),
							...(opts.title === undefined ? {} : { title: opts.title }),
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
			// Same for a collapsed split: reveal the member the focus falls back to.
			const fallbackSplitId = next.find((t) => t.id === nextActive)?.splitId;
			setSplits((prev) =>
				prev.map((s) =>
					s.id === fallbackSplitId ? { ...s, collapsed: false } : s
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
			const last = stack.at(-1);
			if (!last) {
				return stack;
			}
			const { tab, index } = last;
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
			setTabs((prev) => {
				const next = bindConversation(prev, tabId, conversationId);
				if (next === prev) {
					return prev;
				}
				tabsRef.current = next;
				return next;
			});
		},
		[]
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
		setSplits((prev) =>
			prev.map((s) => (s.id === splitId ? { ...s, name } : s))
		);
	}, []);

	const setSplitColor = useCallback((splitId: string, color: TabGroupColor) => {
		setSplits((prev) =>
			prev.map((s) => (s.id === splitId ? { ...s, color } : s))
		);
	}, []);

	const toggleSplitCollapsed = useCallback((splitId: string) => {
		setSplits((prev) =>
			prev.map((s) =>
				s.id === splitId ? { ...s, collapsed: !s.collapsed } : s
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
			const color = nextClusterColor(groupsRef.current, splitsRef.current);
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
				{
					id,
					root: makeBranch(orientation, unique.map(makeLeaf)),
					collapsed: false,
					name: "",
					color,
				},
			]);
			pruneSplits();
			markActive(unique[0]);
		},
		[markActive, pruneSplits]
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
			const id = makeSplitId();
			const color = nextClusterColor(groupsRef.current, splitsRef.current);
			setTabs((prev) => {
				const next = normalize(
					prev.map((t) =>
						members.has(t.id)
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
			setSplits((prev) => [
				...prev,
				{ id, root: tree, collapsed: false, name: "", color },
			]);
			pruneSplits();
			markActive(unique[0]);
		},
		[markActive, pruneSplits]
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
			const id = makeSplitId();
			const color = nextClusterColor(groupsRef.current, splitsRef.current);
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
					splitId: id,
				};
			});
			const tree = buildPresetTree(
				root,
				created.map((t) => t.id)
			);
			if (!tree) {
				return;
			}
			setTabs((prev) => {
				const next = normalize([...prev, ...created]);
				tabsRef.current = next;
				return next;
			});
			setSplits((prev) => [
				...prev,
				{ id, root: tree, collapsed: false, name: "", color },
			]);
			pruneSplits();
			markActive(created[0].id);
			pushHistory(created[0].id);
		},
		[markActive, pruneSplits, pushHistory]
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

	// Even out the panes after the gutters have been dragged around. Sizes only:
	// membership is untouched, so no reconcile/prune is involved. Recursive by
	// design, unlike `setSplitOrientation` above — an inner branch left skewed
	// would make "equalize panes" look like it did nothing.
	const equalizeSplit = useCallback((splitId: string) => {
		setSplits((prev) =>
			prev.map((s) =>
				s.id === splitId
					? { ...s, root: equalizeNode(s.root) as SplitBranch }
					: s
			)
		);
	}, []);

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
					list = [
						...prev,
						{
							id: splitId,
							root,
							collapsed: false,
							name: "",
							color: nextClusterColor(groupsRef.current, splitsRef.current),
						},
					];
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
			setTabs((prev) => {
				const mapped = normalize(prev.map((t) => (t.id === tabId ? next : t)));
				tabsRef.current = mapped;
				return mapped;
			});
		},
		[]
	);

	// Hand a pane over to an already-open tab: the incoming tab takes the exact
	// leaf (and therefore the exact fractions) the pane occupied, and the pane's
	// own tab is dropped. Written as ONE primitive rather than
	// addTabToSplit + swapSplitPanes + closeTab because those three read
	// `tabsRef`/`splitsRef` between calls, and only the first setState updater in
	// a batch runs eagerly — the second would see stale membership and bail.
	const replacePaneTab = useCallback(
		(paneTabId: string, tabId: string) => {
			if (paneTabId === tabId) {
				return;
			}
			const current = tabsRef.current;
			const pane = current.find((t) => t.id === paneTabId);
			const incoming = current.find((t) => t.id === tabId);
			const splitId = pane?.splitId;
			if (!(splitId && incoming)) {
				return;
			}
			const oldSplitId = incoming.splitId;
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
				let mapped = prev
					.filter((t) => t.id !== paneTabId)
					.map((t) => {
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
				// Pulling the incoming tab out of a different split may leave that one
				// with a single member — dissolve it, same as every other move.
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
			setSplits((prev) =>
				reconcileSplits(
					prev.map((s) => {
						if (s.id !== splitId) {
							return s;
						}
						// When the incoming tab is ALREADY a pane of this split, lift its
						// old leaf out first or `replaceLeaf` would leave it in the tree
						// twice.
						const base = containsLeaf(s.root, tabId)
							? (removeLeaf(s.root, tabId) ?? s.root)
							: s.root;
						const swapped = replaceLeaf(base, paneTabId, tabId);
						return swapped.type === "branch" ? { ...s, root: swapped } : s;
					}),
					tabsRef.current
				)
			);
			markActive(tabId);
		},
		[markActive, syncNav]
	);

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

	// The native process owns cross-window entity routing, while each renderer
	// owns its tab layout. Register only stable entity keys (currently persisted
	// conversations); tab ids, groups, splits, and one-shot composer state remain
	// window-local. The fingerprint guard avoids sending an IPC snapshot for
	// runtime-only updates such as a streaming spinner or title shimmer.
	const entityRegistration = useMemo(() => {
		const entries: Array<{ active: boolean; key: string }> = [];
		const entryIndexes = new Map<string, number>();
		for (const tab of tabs) {
			const key = tabEntityKey(tab);
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
	}, [tabs, activeTabId]);
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
			const tab = tabsRef.current.find(
				(candidate) => tabEntityKey(candidate) === key
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
			}}
		>
			{children}
		</TabsContext.Provider>
	);
}
