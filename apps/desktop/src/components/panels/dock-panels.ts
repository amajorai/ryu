import { z } from "zod";
import type {
	PersistedDockTabKind,
	WorkspaceSessionTab,
} from "@/src/lib/workspace-session.ts";
// The data-driven half of the workspace docks: turning an enabled app's
// `contributes.dock_panels[]` entries into dock tabs.
//
// Historically the two docks welded every openable panel into a closed `TabKind`
// union (`"browser" | "simulator" | …`), so shipping an app meant editing the
// shell. `dock_panels` inverts that: an app DECLARES its tab (title, icon,
// placement, order) and the shell renders it, which also means disabling the app
// removes the tab with no shell change. The shell keeps owning the panels that
// are genuinely shell infrastructure (terminal, code review, files, cowork,
// subagent, artifact, inspector, mission) — those are not apps and have nothing
// to contribute from.
//
// Everything here is PURE (no React, no fetch) so the ordering/placement/
// resolution rules are unit-testable; the rendering half lives in
// `WorkspacePanels.tsx`, which owns the native component registry.

import { DOCK_PANEL_KINDS, type DockPanelKind } from "@ryu/app-host/views";
import type { WorkbenchRegion } from "@ryu/workbench/model";
import type { PluginDockPanel } from "@/src/lib/api/plugins.ts";

/** One of the two workspace docks a panel can be offered in. `"both"` is a
 *  PLACEMENT, never a dock — it fans out into these two. */
export type DockSide = "bottom" | "right";

/** Panels the SHELL owns. Not apps: they render shell infrastructure (a terminal,
 *  the diff of the open folder, the current run's cowork context …) and are
 *  always offered, contributions or not. */
const builtinDockTabKindSchema = z.enum([
	"terminal",
	"codereview",
	"files",
	"gitgraph",
	"cowork",
	"sources",
	"subagents",
	"subagent",
	"artifact",
	"inspector",
	"context",
	"mission",
	"agent-activity",
	"box-screen",
]);
export type BuiltinTabKind = z.infer<typeof builtinDockTabKindSchema>;

/** A contributed panel's tab kind: the `plugin:<pluginId>:<panelId>` key minted
 *  by {@link pluginDockPanelKey}. Kept as a template-literal type so a tab kind
 *  stays a closed shape (built-in member OR namespaced plugin key) rather than
 *  collapsing to bare `string`. */
export type PluginTabKind = `plugin:${string}`;

/**
 * A MAIN-TAB PAGE hosted in a dock: `route:<path>`, where the path is the same
 * one a window tab carries (`/library/space`, `/store`, `/chat`, …) and resolves
 * through the same contribution registry (`RouteOutlet`).
 *
 * The path rides INSIDE the kind rather than in a separate field for two
 * reasons. It keeps `PanelTab`/`ProjectDockTab` a single-discriminant shape, so
 * the persisted project-dock rows (which only carry `kind`/`label`/`side`)
 * restore a pinned page with no schema change; and it makes
 * `usePanelTabs.openTab`'s reuse-by-kind dedup per-PAGE for free — raising the
 * same page twice re-focuses its tab instead of stacking a second copy.
 */
export type RouteTabKind = `route:${string}`;

/** What a dock tab is: a shell-owned panel, an app-contributed one, or a page. */
export type DockTabKind = BuiltinTabKind | PluginTabKind | RouteTabKind;

const dockTabKindSchema = z.union([
	builtinDockTabKindSchema,
	z.templateLiteral(["plugin:", z.string()]),
	z.templateLiteral(["route:", z.string()]),
]);
export interface RestoredDockTabKind {
	kind: DockTabKind | "unavailable";
	persistedKind?: PersistedDockTabKind;
}
/** Keep unknown saved identifiers intact while using an unavailable renderer. */
export function restoreDockTabKind(
	persistedKind: PersistedDockTabKind
): RestoredDockTabKind {
	const parsed = dockTabKindSchema.safeParse(persistedKind);
	return parsed.success
		? { kind: parsed.data }
		: { kind: "unavailable", persistedKind };
}

/** True when the tab is an app-contributed panel rather than a built-in. */
export function isPluginTabKind(kind: DockTabKind): kind is PluginTabKind {
	return kind.startsWith("plugin:");
}

/** True when the tab hosts a main-tab page (see {@link RouteTabKind}). */
export function isRouteTabKind(kind: DockTabKind): kind is RouteTabKind {
	return kind.startsWith("route:");
}

/** The tab kind hosting `path` as a dock page. */
export function routeTabKind(path: string): RouteTabKind {
	return `route:${path}`;
}

/** The route path a page tab is showing (`""` for a non-page kind). */
export function routeTabPath(kind: DockTabKind): string {
	return isRouteTabKind(kind) ? kind.slice("route:".length) : "";
}

/** The empty-split-pane picker. Spelled out rather than imported from
 *  `lib/splitPresets.ts` to keep this module free of the split-tree graph — it is
 *  the pure, unit-tested half of the dock. `dock-panels.test.ts` asserts the two
 *  agree. */
const PANE_CHOOSER_ROUTE = "/pane";

/**
 * Whether `path` may be hosted in a dock.
 *
 * A page in the dock is mounted through the same `RouteOutlet` a window tab uses,
 * so the only genuinely unsafe input is a path that is not a route at all. Two
 * paths are refused: the empty-pane CHOOSER, whose whole job is to replace itself
 * with a window tab (it has no meaning inside a dock), and anything not rooted at
 * `/` — a relative or scheme-bearing string is never a tab route, and treating one
 * as a route would hand the registry's pattern matchers attacker-shaped input.
 *
 * `/chat` is deliberately ALLOWED: `WorkspacePanels` renders its docks only when
 * it is not itself inside one (see `DockRouteHost`), so a chat hosted in the panel
 * draws the conversation without a nested dock, and the mount cannot recurse.
 */
export function isDockableRoutePath(path: string): boolean {
	if (!path.startsWith("/") || path.startsWith("//")) {
		return false;
	}
	return path !== PANE_CHOOSER_ROUTE;
}

/**
 * Kinds that can be pinned and shared across chats in the same project folder.
 *
 * Workspace infrastructure (terminal, files, changes, app panels) belongs to the
 * project, not a single chat — pinning opts them into that shared strip. Chat-run
 * panels (cowork / subagent / artifact / inspector / context / mission) stay
 * conversation-local and are never pinnable: each describes ONE conversation's
 * run, so sharing the live instance across the folder's chats would show the
 * wrong thread's data — a context breakdown would show the wrong chat's numbers,
 * a turn digest the wrong chat's work.
 *
 * This is also why a conversation-local panel cannot be an app's
 * `contributes.dock_panels` entry, however much it looks like one: every plugin
 * kind IS pinnable (below), so `WorkspacePanels` hands it to the project dock
 * store on creation and `ProjectDockHost` mounts it OUTSIDE the chat, where the
 * per-chat props it would need do not exist. Mission Control's cross-chat half
 * is an app; its in-chat panel is shell infrastructure, for that reason.
 */
export function isPinnableDockTabKind(kind: DockTabKind): boolean {
	if (isPluginTabKind(kind)) {
		return true;
	}
	// A PAGE is workspace-level, not conversation-level — the Spaces library or
	// the Store shows the same thing in every chat of the folder — so it pins like
	// a terminal. The one page that carries per-chat state is `/chat`, and it
	// carries its OWN (its conversation id), not the host chat's, so sharing the
	// live instance across the folder is still correct. Agent activity is also
	// conversation-local because the selected chat agent supplies its contents.
	if (isRouteTabKind(kind)) {
		return true;
	}
	return (
		kind === "terminal" ||
		kind === "files" ||
		kind === "codereview" ||
		kind === "gitgraph"
	);
}

/**
 * The tab kind identifying a contributed panel: `plugin:<pluginId>:<panelId>`.
 *
 * This is the same key `pluginDockPanelKey` in `hooks/usePluginContributions.ts`
 * mints, spelled out here rather than imported so this module stays free of the
 * React/query graph — it is the pure, unit-tested half of the dock, and pulling a
 * hooks module (and the pages it registers routes for) in behind it would make
 * every test load the app. The format is asserted in `dock-panels.test.ts`; if it
 * ever changes, both definitions move together.
 */
export function dockTabKind(panel: {
	id: string;
	plugin: string;
}): PluginTabKind {
	return `plugin:${panel.plugin}:${panel.id}`;
}

/** The registry key a `panel: "native"` entry resolves its shell component by —
 *  `<plugin>/<id>`, as documented on the Rust `DockPanelContribution`. */
export function nativeDockPanelKey(panel: {
	id: string;
	plugin: string;
}): string {
	return `${panel.plugin}/${panel.id}`;
}

/** Whether `panel` names a render mode this build knows how to draw. An unknown
 *  member (a newer Core, a hand-written manifest) must degrade to a placeholder,
 *  never crash the dock — the same forward-compatibility rule the contract states. */
export function isKnownDockPanelKind(panel: string): panel is DockPanelKind {
	return z.enum(DOCK_PANEL_KINDS).safeParse(panel).success;
}

/** The workbench region where a contributed panel prefers to open. `"both"`
 *  retains its legacy bottom/right offering through {@link panelDocksIn}, so its
 *  deterministic single-region preference is bottom. Unknown wire values also
 *  fall back to bottom rather than making the panel unreachable. */
export function panelPreferredRegion(panel: PluginDockPanel): WorkbenchRegion {
	const placement: string = panel.placement;
	if (placement === "left" || placement === "center" || placement === "right") {
		return placement;
	}
	return "bottom";
}

/** Whether a contributed panel is offered in a legacy `side`. Mirrors the Rust
 *  `DockPanelPlacement::docks()` fan-out, and is LENIENT for the same reason its
 *  deserializer is: a placement this build has never heard of falls back to the
 *  bottom dock rather than making the panel unreachable.
 *
 * @deprecated Use {@link panelPreferredRegion} with the workbench source registry.
 */
export function panelDocksIn(panel: PluginDockPanel, side: DockSide): boolean {
	const placement: string = panel.placement;
	if (placement === "both") {
		return true;
	}
	if (placement === "right") {
		return side === "right";
	}
	// "bottom" and anything unknown.
	return side === "bottom";
}

/** Panels carrying no explicit `order` sort after the ordered ones, then
 *  alphabetically — a stable, declaration-order-independent result (Core
 *  concatenates contributions in manifest-load order, which is not meaningful). */
const UNORDERED = Number.MAX_SAFE_INTEGER;

function compareContributions(
	a: { id: string; order?: number; plugin: string; title: string },
	b: { id: string; order?: number; plugin: string; title: string }
): number {
	const byOrder = (a.order ?? UNORDERED) - (b.order ?? UNORDERED);
	if (byOrder !== 0) {
		return byOrder;
	}
	const byTitle = a.title.localeCompare(b.title);
	if (byTitle !== 0) {
		return byTitle;
	}
	return dockTabKind(a).localeCompare(dockTabKind(b));
}

/** The contributed panels offered in one dock, honouring `placement` (with
 *  `"both"` fanned out) and `order`. Entries missing the identity fields Core is
 *  supposed to tag (`plugin`) are dropped: without an owner there is no tab key,
 *  no native registry lookup and no capability owner. */
const dockPanelIdentitySchema = z.object({
	plugin: z.string().min(1),
	id: z.string().min(1),
});

export function dockPanelsFor(
	panels: PluginDockPanel[],
	side: DockSide
): PluginDockPanel[] {
	return panels
		.filter(
			(p) =>
				dockPanelIdentitySchema.safeParse(p).success && panelDocksIn(p, side)
		)
		.sort(compareContributions);
}

/** The contributed panel a plugin tab kind refers to, or undefined once the
 *  owning app is disabled/uninstalled (Core only serves ENABLED plugins'
 *  contributions, so the feed IS the enabled set). Callers render a placeholder
 *  in that case rather than closing the tab: the contributions query is a
 *  best-effort read (`retry: false`), so an empty feed can also mean "the node is
 *  briefly unreachable", and a blip must not destroy the user's open tabs. */
export function findDockPanel(
	panels: PluginDockPanel[],
	kind: DockTabKind
): PluginDockPanel | undefined {
	if (!isPluginTabKind(kind)) {
		return;
	}
	return panels.find((p) => p.plugin && p.id && dockTabKind(p) === kind);
}

export interface DockTabPersistence extends RestoredDockTabKind {
	label: string;
	persistedTab?: WorkspaceSessionTab;
	pinned?: boolean;
	projectHosted?: boolean;
	uid: string;
}
/** Save an unavailable tab without erasing its original kind or project metadata. */
export function serializeRestoredDockTab(
	tab: DockTabPersistence
): WorkspaceSessionTab {
	const descriptor: WorkspaceSessionTab = {
		...tab.persistedTab,
		kind: tab.persistedKind ?? tab.kind,
		label: tab.label,
		uid: tab.uid,
	};
	if (tab.projectHosted) {
		descriptor.project = true;
		if (tab.pinned) {
			descriptor.pinned = true;
		}
	}
	return descriptor;
}
