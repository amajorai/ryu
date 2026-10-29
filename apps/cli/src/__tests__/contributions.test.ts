// Contract tests for the terminal's half of the declarative-view seam:
//
//   1. the projection of `GET /api/plugins/contributions` -> ContributedView[]
//      (malformed entries skipped, `spec` kept only when its own discriminant is a
//      known kind, the owning plugin remembered),
//   2. the route helpers the generic surface + palette mint paths with,
//   3. the surface-claim rule that lets a contributed view retire a built-in screen,
//   4. DRIFT GUARD — src/core/views.ts is a local mirror of the vocabulary owned by
//      `packages/app-host/src/views.ts`. These tests import the source-of-truth
//      helpers directly and assert the mirror agrees with them, so a change upstream
//      breaks here instead of silently rendering the wrong thing in the terminal.

import { expect, test } from "bun:test";
// The source of truth for the vocabulary, imported by path: apps/tui declares only
// `@ryuhq/core-client` as a workspace dependency (it ships as a bun-run CLI), so the
// package is referenced here — in tests only — purely to pin the mirror.
import {
	VIEW_KINDS as UPSTREAM_VIEW_KINDS,
	isCoreApiPath as upstreamIsCoreApiPath,
	renderActionHttp as upstreamRenderActionHttp,
	renderTemplate as upstreamRenderTemplate,
	sourceItemsFromResponse as upstreamSourceItems,
	validateView as upstreamValidateView,
} from "../../../../packages/app-host/src/views.ts";
import {
	contributedViewsFromResponse,
	parsePluginViewPath,
	pluginViewPath,
	surfaceClaimToken,
	viewClaimingSurface,
} from "../core/contributions.ts";
import {
	isCoreApiPath,
	renderActionHttp,
	renderTemplate,
	sourceItemsFromResponse,
	VIEW_KINDS,
	type ViewSource,
	validateView,
} from "../core/views.ts";

// ── projection ───────────────────────────────────────────────────────────────

test("the contributions payload projects to the views the terminal renders", () => {
	const views = contributedViewsFromResponse({
		views: [
			{
				id: "quest-board",
				plugin: "com.example.quests",
				title: "Quest Board",
				view: "list-detail",
				spec: { view: "list-detail", items: [] },
			},
		],
	});
	expect(views).toHaveLength(1);
	expect(views[0]?.id).toBe("quest-board");
	expect(views[0]?.plugin).toBe("com.example.quests");
	expect(views[0]?.spec?.view).toBe("list-detail");
});

test("malformed entries are skipped rather than blanking the feed", () => {
	const views = contributedViewsFromResponse({
		views: [
			{ plugin: "com.example.app", view: "list-detail" }, // no id
			"not-an-object",
			{ id: "ok", plugin: "com.example.app", view: "data-table" },
		],
	});
	expect(views.map((view) => view.id)).toEqual(["ok"]);
});

test("a spec whose kind the shell does not know is dropped, the envelope is kept", () => {
	// Core forwards unknown kinds verbatim so a newer app can target an older shell.
	// The envelope still lists the view (it is navigable, and the renderer prints a
	// readable "unsupported view kind" line); the unreadable spec is not trusted.
	const views = contributedViewsFromResponse({
		views: [
			{
				id: "future",
				plugin: "com.example.app",
				view: "kanban-board",
				spec: { view: "kanban-board", lanes: [] },
			},
		],
	});
	expect(views).toHaveLength(1);
	expect(views[0]?.view).toBe("kanban-board");
	expect(views[0]?.spec).toBeUndefined();
});

test("a payload without a views array yields no views", () => {
	expect(contributedViewsFromResponse({})).toEqual([]);
	expect(contributedViewsFromResponse(null)).toEqual([]);
	expect(contributedViewsFromResponse({ views: "nope" })).toEqual([]);
});

// ── routes ───────────────────────────────────────────────────────────────────

test("a contributed view's route round-trips through its path", () => {
	const path = pluginViewPath("com.example.app", "board/one");
	expect(parsePluginViewPath(path)).toEqual({
		plugin: "com.example.app",
		view: "board/one",
	});
});

test("a non-plugin-view path parses to null", () => {
	expect(parsePluginViewPath("/calendar")).toBeNull();
	expect(parsePluginViewPath("/plugin-view/com.example.app")).toBeNull();
});

// ── the surface-claim rule ───────────────────────────────────────────────────

test("the reserved surface:<id> token claims a built-in surface; a bare id does not", () => {
	const views = contributedViewsFromResponse({
		views: [
			{
				id: "surface:calendar",
				plugin: "com.example.calendar",
				view: "list-detail",
				spec: { view: "list-detail", items: [] },
			},
			{
				id: "quest-board",
				plugin: "com.example.quests",
				view: "list-detail",
				spec: { view: "list-detail", items: [] },
			},
			// A third-party app that happens to name a view "tasks" must NOT hijack
			// the built-in Tasks screen — the claim token is namespaced on purpose.
			{
				id: "tasks",
				plugin: "com.example.unrelated",
				view: "list-detail",
				spec: { view: "list-detail", items: [] },
			},
		],
	});
	expect(surfaceClaimToken("calendar")).toBe("surface:calendar");
	expect(viewClaimingSurface(views, "calendar")?.plugin).toBe(
		"com.example.calendar"
	);
	expect(viewClaimingSurface(views, "tasks")).toBeUndefined();
	expect(viewClaimingSurface(views, "monitors")).toBeUndefined();
});

test("a title-only contribution never claims a surface (it would blank the screen)", () => {
	const views = contributedViewsFromResponse({
		views: [
			{ id: "surface:monitors", plugin: "com.example.monitors", view: "form" },
		],
	});
	expect(views).toHaveLength(1);
	expect(viewClaimingSurface(views, "monitors")).toBeUndefined();
});

test("a claim whose spec cannot draw is refused, leaving the built-in screen up", () => {
	// The discriminant is a known kind, so the projection keeps the spec — but a
	// `list-detail` with no `items` renders the "unsupported view" line. Handing a
	// screen full of real monitors over to that line is worse than not handing it
	// over at all, so the claim does not count.
	const views = contributedViewsFromResponse({
		views: [
			{
				id: "surface:monitors",
				plugin: "com.example.monitors",
				view: "list-detail",
				spec: { view: "list-detail" },
			},
		],
	});
	expect(views).toHaveLength(1);
	expect(views[0]?.spec).toBeDefined();
	expect(viewClaimingSurface(views, "monitors")).toBeUndefined();
});

// ── drift guard against @ryu/app-host/views ──────────────────────────────────

test("the mirrored vocabulary lists the same kinds as the source of truth", () => {
	expect([...VIEW_KINDS]).toEqual([...UPSTREAM_VIEW_KINDS]);
});

test("structural validation matches the source of truth", () => {
	// The gate that stands between an opaque manifest `spec` and a renderer that
	// dereferences its collections — it has to say exactly what upstream says, or a
	// spec the desktop draws would refuse to draw here (or worse, the reverse).
	const cases: unknown[] = [
		null,
		"list-detail",
		{ view: "kanban-board", lanes: [] },
		{ view: "list-detail" },
		{ view: "list-detail", items: [] },
		{ view: "data-table", columns: [] },
		{ view: "data-table", columns: [], rows: [] },
		{ view: "form" },
		{ view: "form", fields: [] },
		{ view: "action-panel" },
		{ view: "filter-bar" },
		{ view: "stat-card-row" },
		{ view: "empty-state" },
		{ view: "empty-state", title: "Nothing" },
	];
	for (const value of cases) {
		expect(validateView(value)).toEqual(upstreamValidateView(value));
	}
});

test("templating matches the source of truth", () => {
	const ctx = {
		item: { id: "a b", nested: { deep: 1 } },
		values: { name: "Ada" },
	};
	for (const template of [
		"/api/quests/{{item.id}}/complete",
		"hello {{name}}",
		"{{missing}}",
		"{{item.nested}}",
	]) {
		expect(renderTemplate(template, ctx)).toBe(
			upstreamRenderTemplate(template, ctx)
		);
		expect(renderTemplate(template, ctx, { uriEncode: true })).toBe(
			upstreamRenderTemplate(template, ctx, { uriEncode: true })
		);
	}
});

test("the /api/ path guard matches the source of truth", () => {
	for (const path of [
		"/api/quests",
		"/api/../secrets",
		"https://evil.example/api/x",
		"/notapi",
	]) {
		expect(isCoreApiPath(path)).toBe(upstreamIsCoreApiPath(path));
	}
});

test("action rendering matches the source of truth, and refuses a non-Core path", () => {
	const http = {
		method: "POST" as const,
		path: "/api/quests/{{item.id}}/complete",
		body: { note: "{{name}}", raw: "{{item.count}}" },
	};
	const ctx = { item: { id: "q 1", count: 3 }, values: { name: "Ada" } };
	expect(renderActionHttp(http, ctx)).toEqual(
		upstreamRenderActionHttp(http, ctx)
	);
	// A `{{token}}`-only string leaf substitutes the RAW value, type-preserving.
	expect(renderActionHttp(http, ctx).body).toEqual({ note: "Ada", raw: 3 });
	expect(() =>
		renderActionHttp({ method: "GET", path: "/secrets" }, {})
	).toThrow();
});

test("source mapping matches the source of truth", () => {
	const source: ViewSource = {
		http: { path: "/api/quests" },
		items: "quests",
		map: { subtitle: "detail", accessory: "status" },
	};
	const payload = {
		quests: [
			{ id: "1", title: "One", detail: "first", status: "todo" },
			{ title: "no id" },
			"garbage",
		],
	};
	expect(upstreamSourceItems(source, payload)).toEqual(
		sourceItemsFromResponse(source, payload)
	);
	expect(sourceItemsFromResponse(source, payload)).toHaveLength(1);
	expect(sourceItemsFromResponse(source, { quests: "nope" })).toEqual([]);
});
