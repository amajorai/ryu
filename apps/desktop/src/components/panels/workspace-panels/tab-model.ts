import {
	BrowserIcon,
	ComputerTerminal01Icon,
	DashboardSquare01Icon,
	File01Icon,
	FileCodeIcon,
	FolderOpenIcon,
	GitBranchIcon,
	Globe02Icon,
	MonitorDotFreeIcons,
	PieChartIcon,
	Radar01Icon,
	Robot01Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { createContext } from "react";
import {
	type BuiltinTabKind,
	type DockTabKind,
	dockTabKind,
	isDockableRoutePath,
	nativeDockPanelKey,
	restoreDockTabKind,
	routeTabKind,
	serializeRestoredDockTab,
} from "@/src/components/panels/dock-panels.ts";
import type { PluginDockPanel } from "@/src/lib/api/plugins.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import { pageRoute, SIDE_PANEL_PAGES } from "@/src/lib/page-routes.ts";
import type {
	PersistedDockTabKind,
	WorkspaceSessionDock,
	WorkspaceSessionTab,
} from "@/src/lib/workspace-session.ts";
import type { TerminalCommandRequest } from "@/src/store/useDockPanelRequestStore.ts";
import { NATIVE_DOCK_PANELS } from "./native-dock-panels.tsx";

// ── Multi-instance tab system ─────────────────────────────────────────────────

// A dock tab is either a SHELL-owned panel (terminal, code review, files, the
// cowork/subagent/artifact/inspector views of the current run — infrastructure,
// not apps) or an APP-CONTRIBUTED one, keyed `plugin:<pluginId>:<panelId>`. The
// union used to be closed, which meant shipping an app (Browser, Simulator)
// required editing this file; `contributes.dock_panels` inverts that — see
// `./dock-panels.ts` for the placement/order/resolution rules.
export type TabKind = DockTabKind | "unavailable";

/** True inside a page hosted BY a dock (see {@link DockRoutePage}). The one
 *  consumer is {@link WorkspacePanels} itself, which renders its children bare in
 *  that case — a page like `/chat` mounts a `WorkspacePanels` of its own, and a
 *  dock nested in a dock would recurse without end (and be unusable long before
 *  that). */
export const DockRouteHostContext = createContext(false);

export interface PanelTab {
	/** The artifact this artifact tab shows (only `kind === "artifact"`). Each
	 *  artifact gets its OWN tab — opening a second artifact never replaces the
	 *  first (the dock's artifact surface has no one-at-a-time limit). */
	artifact?: ArtifactView;
	/** One-shot command queued when an environment action opens a terminal tab. */
	initialCommand?: TerminalCommandRequest;
	initialCommandNonce?: number;
	kind: TabKind;
	label: string;
	persistedKind?: PersistedDockTabKind;
	persistedTab?: WorkspaceSessionTab;
	/** True when this tab is project-shared (visible in every chat for the folder). */
	pinned?: boolean;
	/**
	 * Content is hosted above ChatPage and portaled into a slot — used for all
	 * project-store tabs so pinning never remounts the live panel.
	 */
	projectHosted?: boolean;
	uid: string;
}

export interface TabTypeDef {
	/** Bundled glyph — every shell-owned type (built-in or `native`) has one, so
	 *  it renders offline and identically to before. */
	icon?: typeof ComputerTerminal01Icon;
	/** Contributed icon id (`hugeicons:globe-02`, `lucide:heart`, a URL) — the
	 *  fallback for a third-party panel with no registered shell component. */
	iconId?: string;
	kind: TabKind;
	label: string;
}

// The shell's own openable panels. Each dock's contributed panels are appended
// at render time (`bottomTabTypes` / `rightTabTypes` below), so these lists only
// ever grow with panels the SHELL itself implements.
export const BOTTOM_TAB_TYPES: TabTypeDef[] = [
	{ kind: "terminal", label: "Terminal", icon: ComputerTerminal01Icon },
	{ kind: "codereview", label: "Code Review", icon: FileCodeIcon },
];

export const RIGHT_TAB_TYPES: TabTypeDef[] = [
	{ kind: "terminal", label: "Terminal", icon: ComputerTerminal01Icon },
	{ kind: "files", label: "Files", icon: FolderOpenIcon },
	{ kind: "codereview", label: "Changes", icon: FileCodeIcon },
	{ kind: "gitgraph", label: "Git graph", icon: GitBranchIcon },
	// Offered in the menu as well as by clicking the composer ring, because the
	// ring is hidden until a turn reports usage — and usage is live-only, so a
	// RELOADED chat has no ring even when Core still holds a breakdown. Menu-only
	// reachability is what keeps the panel usable in that (common) case.
	{ kind: "context", label: "Context", icon: PieChartIcon },
	{ kind: "sources", label: "Sources", icon: Globe02Icon },
	{ kind: "subagents", label: "Subagents", icon: Robot01Icon },
	// This conversation's own Box screen (its session Box, or a sub-agent's).
	// Offered only while the Box rollout flag is on; see `rightTabTypes`.
	{ kind: "box-screen", label: "Box screen", icon: MonitorDotFreeIcons },
	{ kind: "agent-activity", label: "Agent activity", icon: Robot01Icon },
	// What this chat DID, grouped per turn with the agent's own rationale. Menu-
	// only: unlike the panels below it is not raised by a click anywhere in the
	// chat, so the "+" menu is its single entry point.
	{ kind: "mission", label: "Mission Control", icon: Radar01Icon },
];

export const NATIVE_SHELL_TAB_KINDS = new Set<TabKind>([
	"codereview",
	"files",
	"gitgraph",
	"terminal",
]);

/** The main-tab PAGES offered in the right dock's "+" menu, as tab types.
 *  Derived from the shared page-key allowlist so the dock can never offer a page
 *  that a `ryu://open/<page>` link could not also reach. Kept OUT of
 *  `RIGHT_TAB_TYPES`: the launchpad renders that list as cards, and fifteen page
 *  cards would bury the four panels the dock is actually for — the pages live in
 *  a submenu instead. */
export const PAGE_TAB_TYPES: TabTypeDef[] = SIDE_PANEL_PAGES.flatMap((p) => {
	const path = pageRoute(p.page);
	if (!(path && isDockableRoutePath(path))) {
		return [];
	}
	return [{ kind: routeTabKind(path), label: p.label, icon: File01Icon }];
});

/** The glyph of each shell-owned tab kind. The programmatic panels
 *  (cowork/subagent/artifact/inspector) are opened by the chat rather than the
 *  "+" menu, so they live here and not in the arrays above. */
export const BUILTIN_TAB_ICONS = {
	terminal: ComputerTerminal01Icon,
	codereview: FileCodeIcon,
	files: FolderOpenIcon,
	gitgraph: GitBranchIcon,
	cowork: DashboardSquare01Icon,
	sources: Globe02Icon,
	subagents: Robot01Icon,
	subagent: Robot01Icon,
	artifact: BrowserIcon,
	inspector: SourceCodeIcon,
	context: PieChartIcon,
	mission: Radar01Icon,
	"agent-activity": Robot01Icon,
	"box-screen": MonitorDotFreeIcons,
} satisfies Record<BuiltinTabKind, typeof ComputerTerminal01Icon>;

/** A contributed panel as a dock tab type. A `native` panel takes the glyph of
 *  its registered shell component (bundled, offline-safe); anything else falls
 *  back to the manifest's declared icon id. */
/** The icon id of the app a `/plugin/<id>` page belongs to, or `null`.
 *
 *  Layout registers one `/plugin/<id>` route per enabled companion, so an app
 *  opened as a PAGE is addressed by its own id — which is all this needs to find
 *  the app and read the mark its manifest declares. Anything that is not such a
 *  route (a settings page, the launchpad, …) returns null and keeps the generic
 *  page glyph. Exported for unit tests. */
export function routeAppIcon(
	path: string,
	apps: readonly { icon?: string | null; id: string }[]
): string | null {
	const PLUGIN_ROUTE = "/plugin/";
	if (!path.startsWith(PLUGIN_ROUTE)) {
		return null;
	}
	// The id may itself contain slashes (`@scope/name`), so take the whole
	// remainder rather than the first segment.
	const id = path.slice(PLUGIN_ROUTE.length);
	if (!id) {
		return null;
	}
	return apps.find((a) => a.id === id)?.icon ?? null;
}

export function contributedTabType(panel: PluginDockPanel): TabTypeDef {
	const native =
		panel.panel === "native"
			? NATIVE_DOCK_PANELS.get(nativeDockPanelKey(panel))
			: undefined;
	return {
		kind: dockTabKind(panel),
		label: panel.title,
		icon: native?.icon,
		iconId: native ? undefined : panel.icon,
	};
}

let tabCounter = 0;
export function makeTab(
	kind: TabKind,
	label: string,
	n?: number,
	artifact?: ArtifactView,
	uid?: string,
	initialCommand?: TerminalCommandRequest,
	initialCommandNonce?: number
): PanelTab {
	tabCounter += 1;
	const suppliedUidMatch = uid?.match(/^tab-(\d+)$/);
	if (suppliedUidMatch) {
		tabCounter = Math.max(tabCounter, Number(suppliedUidMatch[1]));
	}
	return {
		uid: uid ?? `tab-${tabCounter}`,
		kind,
		label: n == null ? label : `${label} ${n}`,
		artifact,
		...(initialCommand ? { initialCommand, initialCommandNonce } : undefined),
	};
}

export function restoreLocalPanelTabs(
	dock: WorkspaceSessionDock | undefined
): PanelTab[] {
	return (dock?.tabs ?? []).flatMap((tab) => {
		const restored = restoreDockTabKind(tab.kind);
		if (tab.project && restored.kind !== "unavailable") {
			return [];
		}
		const panel: PanelTab = {
			...makeTab(restored.kind, tab.label, undefined, undefined, tab.uid),
			...restored,
		};
		if (restored.kind === "unavailable") {
			panel.persistedTab = tab;
		}
		return [panel];
	});
}

export function serializeWorkspaceDock(
	tabs: PanelTab[],
	activeUid: string
): WorkspaceSessionDock {
	return {
		activeIndex: Math.max(
			0,
			tabs.findIndex((tab) => tab.uid === activeUid)
		),
		tabs: tabs.map(serializeRestoredDockTab),
	};
}

export function findRestoredTabUid(
	tabs: PanelTab[],
	tab: WorkspaceSessionTab | undefined
): string {
	if (!tab) {
		return tabs[0]?.uid ?? "";
	}
	const exact = tab.uid
		? tabs.find((candidate) => candidate.uid === tab.uid)
		: undefined;
	const matching =
		exact ??
		tabs.find(
			(candidate) =>
				(candidate.persistedKind ?? candidate.kind) === tab.kind &&
				candidate.label === tab.label &&
				Boolean(candidate.persistedTab?.project ?? candidate.projectHosted) ===
					Boolean(tab.project)
		);
	return matching?.uid ?? tabs[0]?.uid ?? "";
}
