// apps/desktop/src/components/panels/dock-panels.test.ts
//
// Tests for the app-contributed dock tabs. The load-bearing behaviours are the
// ones that decide whether a user's workspace still works after the shell stopped
// welding apps into its `TabKind` union:
//   - a contributed panel lands in the dock(s) its `placement` names (`both` fans
//     out) and in `order`;
//   - the shell's OWN panels resolve regardless of what any app contributes (a
//     saved workspace full of terminal/files/codereview tabs is untouched by the
//     contributions feed, empty or not);
//   - a tab whose panel left the feed (app disabled, node briefly unreachable)
//     resolves to "no panel" so the renderer shows a placeholder — it must never
//     throw, and it must never be mistaken for a built-in;
//   - an unknown `panel` discriminant is reported as unknown rather than assumed
//     renderable, which is what keeps a newer manifest from breaking an older shell.

import { describe, expect, test } from "bun:test";
import type { PluginDockPanel } from "@/src/lib/api/plugins.ts";
import { PAGE_ROUTES, pageRoute } from "@/src/lib/page-routes.ts";
import { PANE_CHOOSER_PATH } from "@/src/lib/splitPresets.ts";
import {
	type BuiltinTabKind,
	type DockTabKind,
	dockPanelsFor,
	dockTabKind,
	findDockPanel,
	isDockableRoutePath,
	isKnownDockPanelKind,
	isPinnableDockTabKind,
	isPluginTabKind,
	isRouteTabKind,
	nativeDockPanelKey,
	panelPreferredRegion,
	restoreDockTabKind,
	routeTabKind,
	routeTabPath,
	serializeRestoredDockTab,
} from "./dock-panels.ts";

function panel(over: Partial<PluginDockPanel> = {}): PluginDockPanel {
	return {
		id: "browser",
		plugin: "@ryu/browser",
		title: "Browser",
		panel: "native",
		placement: "both",
		...over,
	};
}

/** The shell's own tab kinds — these must survive any contributions state. */
const BUILTIN_KINDS: BuiltinTabKind[] = [
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
];

describe("tab kinds", () => {
	test("a contributed panel's kind is namespaced by its owning plugin", () => {
		expect(dockTabKind(panel())).toBe("plugin:@ryu/browser:browser");
		// Two apps may reuse a panel id without colliding.
		expect(dockTabKind({ plugin: "com.acme.tools", id: "browser" })).toBe(
			"plugin:com.acme.tools:browser"
		);
	});

	test("no built-in kind is ever mistaken for a contributed one", () => {
		for (const kind of BUILTIN_KINDS) {
			expect(isPluginTabKind(kind)).toBe(false);
		}
		expect(isPluginTabKind(dockTabKind(panel()))).toBe(true);
	});

	test("the native registry key is <plugin>/<id>", () => {
		expect(nativeDockPanelKey(panel())).toBe("@ryu/browser/browser");
	});
});

describe("placement", () => {
	test("maps every known placement to its preferred workbench region", () => {
		expect(panelPreferredRegion(panel({ placement: "bottom" }))).toBe("bottom");
		expect(panelPreferredRegion(panel({ placement: "right" }))).toBe("right");
		expect(panelPreferredRegion(panel({ placement: "left" }))).toBe("left");
		expect(panelPreferredRegion(panel({ placement: "center" }))).toBe("center");
		expect(panelPreferredRegion(panel({ placement: "both" }))).toBe("bottom");
	});

	test("an unknown placement prefers the bottom region", () => {
		// SAFETY: Deliberately emulate an unknown future wire placement to verify compatibility fallback.
		const rogue = panel({
			placement: "top" as PluginDockPanel["placement"],
		});
		expect(panelPreferredRegion(rogue)).toBe("bottom");
	});

	test('"both" offers the panel in each dock', () => {
		const p = panel({ placement: "both" });
		expect(dockPanelsFor([p], "bottom")).toContain(p);
		expect(dockPanelsFor([p], "right")).toContain(p);
	});

	test("a single-dock placement is honoured", () => {
		expect(
			dockPanelsFor([panel({ placement: "right" })], "right")
		).toHaveLength(1);
		expect(
			dockPanelsFor([panel({ placement: "right" })], "bottom")
		).toHaveLength(0);
		expect(
			dockPanelsFor([panel({ placement: "bottom" })], "bottom")
		).toHaveLength(1);
		expect(
			dockPanelsFor([panel({ placement: "bottom" })], "right")
		).toHaveLength(0);
	});

	test("an unknown placement falls back to the bottom dock, never nowhere", () => {
		// Mirrors the Rust lenient deserializer: a placement from a newer manifest
		// must leave the panel reachable rather than silently unopenable.
		// SAFETY: Deliberately emulate an unknown future wire placement to verify compatibility fallback.
		const rogue = panel({
			placement: "floating" as PluginDockPanel["placement"],
		});
		expect(dockPanelsFor([rogue], "bottom")).toContain(rogue);
		expect(dockPanelsFor([rogue], "right")).toHaveLength(0);
	});
});

describe("dockPanelsFor", () => {
	test("filters by dock and sorts by order, then title", () => {
		const panels = [
			panel({ id: "z", plugin: "p", title: "Zed", placement: "bottom" }),
			panel({ id: "a", plugin: "p", title: "Alpha", placement: "bottom" }),
			panel({
				id: "first",
				plugin: "p",
				title: "Ordered",
				placement: "bottom",
				order: 1,
			}),
			panel({ id: "r", plugin: "p", title: "RightOnly", placement: "right" }),
		];
		expect(dockPanelsFor(panels, "bottom").map((p) => p.title)).toEqual([
			// Explicit order leads; the rest fall back to alphabetical.
			"Ordered",
			"Alpha",
			"Zed",
		]);
		expect(dockPanelsFor(panels, "right").map((p) => p.title)).toEqual([
			"RightOnly",
		]);
	});

	test("drops entries with no owning plugin or id", () => {
		const panels = [
			panel({ plugin: "" }),
			panel({ id: "", plugin: "@ryu/simulator" }),
			panel(),
		];
		expect(dockPanelsFor(panels, "bottom")).toHaveLength(1);
	});

	test("does not mutate the (query-cached) contributions array", () => {
		const panels = [
			panel({ id: "b", plugin: "p", title: "B" }),
			panel({ id: "a", plugin: "p", title: "A" }),
		];
		dockPanelsFor(panels, "bottom");
		expect(panels.map((p) => p.title)).toEqual(["B", "A"]);
	});
});

describe("findDockPanel", () => {
	const panels = [
		panel(),
		panel({ id: "simulator", plugin: "@ryu/simulator", title: "Simulator" }),
	];

	test("resolves an open tab back to its contributed panel", () => {
		const found = findDockPanel(panels, "plugin:@ryu/simulator:simulator");
		expect(found?.title).toBe("Simulator");
	});

	test("a built-in kind never resolves to a contributed panel", () => {
		for (const kind of BUILTIN_KINDS) {
			expect(findDockPanel(panels, kind)).toBeUndefined();
		}
	});

	test("a disabled app's tab degrades to undefined instead of throwing", () => {
		// The user's workspace still holds the tab; the feed no longer offers it
		// (Core serves only ENABLED plugins' contributions). The renderer shows a
		// placeholder — it does not crash, and the tab is not silently repurposed.
		const kind: DockTabKind = "plugin:@ryu/browser:browser";
		expect(findDockPanel([], kind)).toBeUndefined();
		expect(() => findDockPanel([], kind)).not.toThrow();
	});
});

describe("panel render modes", () => {
	test("the documented vocabulary is recognised", () => {
		expect(isKnownDockPanelKind("native")).toBe(true);
		expect(isKnownDockPanelKind("companion")).toBe(true);
		expect(isKnownDockPanelKind("view")).toBe(true);
	});

	test("a newer render mode is reported unknown, not assumed renderable", () => {
		expect(isKnownDockPanelKind("hologram")).toBe(false);
		expect(isKnownDockPanelKind("")).toBe(false);
	});
});

describe("isPinnableDockTabKind", () => {
	test("workspace infrastructure and app panels are pinnable", () => {
		expect(isPinnableDockTabKind("terminal")).toBe(true);
		expect(isPinnableDockTabKind("files")).toBe(true);
		expect(isPinnableDockTabKind("codereview")).toBe(true);
		expect(isPinnableDockTabKind("gitgraph")).toBe(true);
		expect(isPinnableDockTabKind("plugin:@ryu/browser:browser")).toBe(true);
	});

	test("chat-run panels stay conversation-local", () => {
		expect(isPinnableDockTabKind("cowork")).toBe(false);
		expect(isPinnableDockTabKind("subagent")).toBe(false);
		expect(isPinnableDockTabKind("artifact")).toBe(false);
		expect(isPinnableDockTabKind("inspector")).toBe(false);
		expect(isPinnableDockTabKind("context")).toBe(false);
	});
});

describe("page tabs (route: kinds)", () => {
	test("the path rides inside the kind and round-trips", () => {
		expect(routeTabKind("/library/space")).toBe("route:/library/space");
		expect(routeTabPath(routeTabKind("/library/space"))).toBe("/library/space");
		// Paths with their own colons/segments survive — only the FIRST prefix is
		// stripped, so a route is never truncated at an inner separator.
		expect(routeTabPath(routeTabKind("/store/mcp/q/a:b"))).toBe(
			"/store/mcp/q/a:b"
		);
	});

	test("page kinds are distinct from plugin and built-in kinds", () => {
		expect(isRouteTabKind("route:/store")).toBe(true);
		expect(isRouteTabKind("plugin:@ryu/browser:browser")).toBe(false);
		expect(isRouteTabKind("terminal")).toBe(false);
		// The two namespaced families must not be mistaken for each other: a page
		// tab resolved as a plugin tab would look for a contribution that cannot
		// exist and render the "app no longer enabled" placeholder forever.
		expect(isPluginTabKind("route:/store")).toBe(false);
		expect(findDockPanel([], "route:/store")).toBeUndefined();
	});

	test("a page is workspace-level, so it pins like a terminal", () => {
		expect(isPinnableDockTabKind("route:/library/space")).toBe(true);
		expect(isPinnableDockTabKind("route:/chat")).toBe(true);
	});

	test("only real tab routes are dockable", () => {
		expect(isDockableRoutePath("/store")).toBe(true);
		// `/chat` IS allowed — WorkspacePanels renders bare inside a dock-hosted
		// page, so a chat in the panel cannot mount a dock inside the dock.
		expect(isDockableRoutePath("/chat")).toBe(true);
		// The empty-pane chooser exists to replace itself with a window tab.
		expect(isDockableRoutePath(PANE_CHOOSER_PATH)).toBe(false);
		// Anything that is not rooted at `/` is not a tab route at all.
		expect(isDockableRoutePath("")).toBe(false);
		expect(isDockableRoutePath("store")).toBe(false);
		expect(isDockableRoutePath("https://evil.example")).toBe(false);
		expect(isDockableRoutePath("//evil.example")).toBe(false);
	});

	test("a prototype key is not a page", () => {
		// `PAGE_ROUTES` is an object literal, so a bare index lookup resolves these
		// up the prototype chain to a truthy FUNCTION — which TypeScript types as
		// `string`, so nothing catches it at build time. This is the allowlist an
		// agent-chosen key is checked against, so the own-property check is the job.
		expect(pageRoute("toString")).toBeUndefined();
		expect(pageRoute("constructor")).toBeUndefined();
		expect(pageRoute("__proto__")).toBeUndefined();
		expect(pageRoute("nope")).toBeUndefined();
		expect(pageRoute("spaces")).toBe("/library/space");
	});

	test("every deep-linkable page is dockable", () => {
		// The two allowlists are one list on purpose: a page an agent may name via
		// `ryu://open/<page>` is exactly a page it may raise in the side panel.
		for (const path of Object.values(PAGE_ROUTES)) {
			expect(isDockableRoutePath(path)).toBe(true);
		}
	});
});

describe("restoring persisted dock tab kinds", () => {
	test("keeps every current renderer kind", () => {
		for (const kind of [
			"terminal",
			"files",
			"plugin:@ryu/browser:browser",
			"route:/library/space",
		] as const) {
			expect(restoreDockTabKind(kind)).toEqual({ kind });
		}
	});
	test("preserves distinct historical and future identifiers on unavailable tabs", () => {
		expect(restoreDockTabKind("browser")).toEqual({
			kind: "unavailable",
			persistedKind: "browser",
		});
		expect(restoreDockTabKind("future-panel")).toEqual({
			kind: "unavailable",
			persistedKind: "future-panel",
		});
	});
});

test("unavailable project tabs retain their kind, identity and pinned metadata on save", () => {
	const original = {
		kind: "future-panel",
		label: "Future",
		uid: "tab-19",
		project: true,
		pinned: true,
	};
	const restored = {
		...restoreDockTabKind(original.kind),
		label: original.label,
		uid: original.uid,
		persistedTab: original,
	};
	expect(serializeRestoredDockTab(restored)).toEqual(original);
});
test("known project tabs keep the existing persistence contract", () => {
	expect(
		serializeRestoredDockTab({
			kind: "terminal",
			label: "Terminal",
			uid: "tab-7",
			projectHosted: true,
			pinned: true,
		})
	).toEqual({
		kind: "terminal",
		label: "Terminal",
		uid: "tab-7",
		project: true,
		pinned: true,
	});
});
