import { describe, expect, it } from "bun:test";
import {
	contributionSourceRequest,
	groupStoreItems,
	helloListDetail,
	helloListDetailContribution,
	isCoreApiPath,
	isCoreReadPath,
	isKnownLibraryViewKind,
	isKnownViewKind,
	isViewSourceHttpMethod,
	LIBRARY_VIEW_KINDS,
	LIBRARY_VIEW_REGISTRY,
	libraryViewDefinition,
	normalizeViewRefreshMs,
	renderActionHttp,
	renderContributionActionHttp,
	renderTemplate,
	type SidebarSectionSpec,
	type StoreDetailGraphSpec,
	type StoreTabSpec,
	sourceItemsFromResponse,
	sourceTotalFromResponse,
	storeDetailObject,
	storeGraphFromResponse,
	storeItemHaystack,
	storeItemsFromResponse,
	storeTotalFromResponse,
	VIEW_KINDS,
	VIEW_SOURCE_LIMITS,
	type ViewSource,
	type ViewSpec,
	validateView,
} from "./views.ts";

describe("declarative view vocabulary", () => {
	it("exposes exactly the seven standardized kinds", () => {
		expect([...VIEW_KINDS]).toEqual([
			"list-detail",
			"data-table",
			"form",
			"action-panel",
			"filter-bar",
			"empty-state",
			"stat-card-row",
		]);
	});

	it("recognizes known kinds and rejects unknown ones", () => {
		for (const kind of VIEW_KINDS) {
			expect(isKnownViewKind(kind)).toBe(true);
		}
		expect(isKnownViewKind("gantt-chart")).toBe(false);
		expect(isKnownViewKind(42)).toBe(false);
	});

	it("validates the hello list-detail example spec", () => {
		const result = validateView(helloListDetail);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("carries the example as a wire ViewContribution", () => {
		expect(helloListDetailContribution.id).toBe("hello");
		expect(helloListDetailContribution.view).toBe("list-detail");
		expect(helloListDetailContribution.spec).toBe(helloListDetail);
		// The example is non-trivial: three rows, one with a success badge.
		expect(helloListDetail.items).toHaveLength(3);
		expect(helloListDetail.items[0]?.badges?.[0]?.tone).toBe("success");
	});

	it("flags an unknown view kind instead of throwing", () => {
		const result = validateView({ view: "hologram", items: [] });
		expect(result.ok).toBe(false);
		expect(result.errors[0]).toContain("unknown view kind");
	});

	it("requires the collection each kind depends on", () => {
		const cases: [ViewSpec["view"], Record<string, string[]>, string][] = [
			["list-detail", {}, "items"],
			["data-table", { columns: [] }, "rows"],
			["form", {}, "fields"],
			["action-panel", {}, "actions"],
			["filter-bar", {}, "filters"],
			["stat-card-row", {}, "stats"],
		];
		for (const [view, extra, missing] of cases) {
			const result = validateView({ view, ...extra });
			expect(result.ok).toBe(false);
			expect(result.errors.join(" ")).toContain(missing);
		}
	});

	it("requires a title for empty-state", () => {
		expect(validateView({ view: "empty-state", title: "Nothing" }).ok).toBe(
			true
		);
		expect(validateView({ view: "empty-state" }).ok).toBe(false);
	});

	it("rejects non-object specs", () => {
		expect(validateView(null).ok).toBe(false);
		expect(validateView("list-detail").ok).toBe(false);
	});

	it("stays backward-shallow: unknown fields and new action fields pass", () => {
		const result = validateView({
			view: "list-detail",
			items: [],
			source: { http: { path: "/api/quests" }, items: "quests" },
			itemActions: [
				{
					id: "complete",
					label: "Complete",
					confirm: "Sure?",
					payload: { reason: "manual" },
					http: { method: "POST", path: "/api/quests/{{item.id}}/complete" },
				},
			],
			someFutureField: { anything: true },
		});
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe("library view registry", () => {
	it("keeps the forward-compatible wire vocabulary and aliases pure", () => {
		expect([...LIBRARY_VIEW_KINDS]).toEqual([
			"board",
			"kanban",
			"data-table",
			"database",
			"calendar",
			"map",
			"feed",
			"timeline",
			"list",
			"gallery",
			"table",
			"card",
			"custom",
		]);
		for (const kind of LIBRARY_VIEW_KINDS) {
			expect(isKnownLibraryViewKind(kind)).toBe(true);
			expect(libraryViewDefinition(kind)?.kind).toBe(kind);
		}
		expect(libraryViewDefinition("kanban")?.renderer).toBe("board");
		expect(libraryViewDefinition("database")?.renderer).toBe("table");
		expect(isKnownLibraryViewKind("future-layout")).toBe(false);
		expect(libraryViewDefinition("future-layout")).toBeUndefined();
		expect(LIBRARY_VIEW_REGISTRY).toHaveLength(LIBRARY_VIEW_KINDS.length);
	});
});

describe("sidebar section vocabulary", () => {
	it("supports an app-owned navigation target for the create affordance", () => {
		const spec = {
			create: {
				label: "New workflow",
				target: "/workflows/new",
			},
			entity: { anchor: "workflow", idKey: "workflow_id" },
			itemTarget: "/workflows/{{item.id}}",
		} satisfies SidebarSectionSpec;

		expect(spec.create.target).toBe("/workflows/new");
		expect(spec.entity).toEqual({
			anchor: "workflow",
			idKey: "workflow_id",
		});
	});

	it("keeps authenticated HTTP create-and-open backward compatible", () => {
		const spec = {
			create: {
				http: { method: "POST", path: "/api/documents" },
				targetFrom: "id",
			},
			itemTarget: "/documents/{{item.id}}",
		} satisfies SidebarSectionSpec;

		expect(spec.create.http.path).toBe("/api/documents");
		expect(spec.create.targetFrom).toBe("id");
	});
});

describe("action templating", () => {
	it("interpolates form values and item keys", () => {
		const ctx = {
			values: { name: "Ada", count: 2 },
			item: { id: "q-1", status: "open" },
		};
		expect(renderTemplate("hello {{name}} x{{count}}", ctx)).toBe(
			"hello Ada x2"
		);
		expect(renderTemplate("/api/quests/{{item.id}}/complete", ctx)).toBe(
			"/api/quests/q-1/complete"
		);
		expect(renderTemplate("{{missing}}", ctx)).toBe("");
	});

	it("uri-encodes substituted path segments", () => {
		expect(
			renderTemplate(
				"/api/quests/{{item.id}}",
				{ item: { id: "a/b c" } },
				{ uriEncode: true }
			)
		).toBe("/api/quests/a%2Fb%20c");
	});

	it("renders a declarative http action with a type-preserving body", () => {
		const rendered = renderActionHttp(
			{
				method: "POST",
				path: "/api/quests/{{item.id}}/complete",
				body: {
					title: "{{title}}",
					done: "{{done}}",
					note: "quest {{item.id}}",
				},
			},
			{
				values: { title: "Ship it", done: true },
				item: { id: "q-9" },
			}
		);
		expect(rendered.method).toBe("POST");
		expect(rendered.path).toBe("/api/quests/q-9/complete");
		expect(rendered.body).toEqual({
			title: "Ship it",
			done: true,
			note: "quest q-9",
		});
	});

	it("refuses non-core paths (including templated escapes)", () => {
		expect(isCoreApiPath("/api/quests")).toBe(true);
		expect(isCoreApiPath("/workflows")).toBe(true);
		expect(isCoreApiPath("/workflows/wf-1")).toBe(true);
		expect(isCoreApiPath("/etc/passwd")).toBe(false);
		expect(isCoreApiPath("https://evil.example/api/")).toBe(false);
		expect(isCoreApiPath("/api/../admin")).toBe(false);
		expect(isCoreApiPath("/api/%2e%2e/admin")).toBe(false);
		expect(isCoreApiPath("/api/x%2f..%2fadmin")).toBe(false);
		expect(isCoreApiPath("/api/x%5c..%5cadmin")).toBe(false);
		expect(isCoreApiPath("/workflows/../admin")).toBe(false);
		expect(isCoreApiPath("/workflows/%2e%2e/admin")).toBe(false);
		expect(isCoreApiPath("/workflowsprefix")).toBe(false);
		expect(() =>
			renderActionHttp(
				{ method: "GET", path: "{{item.url}}" },
				{ item: { url: "https://evil.example/" } }
			)
		).toThrow();
	});

	it("confines community sources and actions to the owning ext mount", () => {
		const authority = { http_policy: "owner", plugin: "@acme/notes" };
		expect(
			contributionSourceRequest(authority, {
				http: { path: "/api/ext/@acme/notes/items" },
			})
		).toEqual({ method: "GET", path: "/api/ext/@acme/notes/items" });
		expect(
			contributionSourceRequest(authority, {
				http: { path: "/api/ext/@acme/other/items" },
			})
		).toBeNull();
		expect(
			contributionSourceRequest(authority, {
				http: { path: "/api/preferences" },
			})
		).toBeNull();
		expect(() =>
			renderContributionActionHttp(
				authority,
				{ method: "DELETE", path: "/api/spaces/{{item.id}}" },
				{ item: { id: "victim" } }
			)
		).toThrow("outside the owning app authority");
	});

	it("allows only GET automatic sources, even for trusted Core contributions", () => {
		const authority = { http_policy: "core", plugin: "@ryu/workflows" };
		const invalidSource: ViewSource = {
			http: { path: "/api/workflows/catalog" },
		};
		Reflect.set(invalidSource.http, "method", "DELETE");
		expect(contributionSourceRequest(authority, invalidSource)).toBeNull();
		expect(
			contributionSourceRequest(authority, {
				http: { method: "GET", path: "/api/workflows/catalog" },
			})
		).toEqual({ method: "GET", path: "/api/workflows/catalog" });
		expect(
			renderContributionActionHttp(
				authority,
				{ method: "POST", path: "/api/workflows/catalog/install" },
				{}
			)
		).toEqual({ method: "POST", path: "/api/workflows/catalog/install" });
	});

	it("fails closed for missing policy and rejects encoded owner-mount traversal", () => {
		const authority = { plugin: "@acme/notes" };
		expect(
			contributionSourceRequest(authority, {
				http: { path: "/api/ext/@acme/notes/%2e%2e/other" },
			})
		).toBeNull();
		expect(
			contributionSourceRequest(authority, {
				http: { path: "/api/ext/@acme/notes/items" },
			})
		).toEqual({ method: "GET", path: "/api/ext/@acme/notes/items" });
	});
	it("allows established node-relative read routes without widening actions", () => {
		expect(isCoreReadPath("/workflows")).toBe(true);
		expect(isCoreReadPath("/api/workflows?limit=20")).toBe(true);
		for (const path of [
			"//evil.example/steal",
			"/%2f%2fevil.example/steal",
			"/api/../admin",
			"/api/%2e%2e/admin",
			"/api/%252e%252e/admin",
			"/api\\workflows",
			"/https://evil.example/steal",
			"/user@example.test/private",
			"/api/workflows\u0000",
			"/api/%zz",
			"/api/%3f/../../admin",
			"/api/%25252e%25252e/admin",
		]) {
			expect(isCoreReadPath(path)).toBe(false);
		}
		// Workflow routes are an explicit action allowlist entry from the platform
		// surface work already on main. Read sources still use the narrower GET-only
		// contract above.
		expect(isCoreApiPath("/workflows")).toBe(true);
		expect(isCoreApiPath("/api/%2e%2e/admin")).toBe(false);
		expect(isCoreApiPath("/api/%252e%252e/admin")).toBe(false);
		expect(isCoreApiPath("/api\\admin")).toBe(false);
		expect(isViewSourceHttpMethod("GET")).toBe(true);
		expect(isViewSourceHttpMethod("HEAD")).toBe(false);
		expect(isViewSourceHttpMethod("POST")).toBe(false);
		expect(normalizeViewRefreshMs(-1)).toBeNull();
		expect(normalizeViewRefreshMs(10)).toBe(1000);
		expect(normalizeViewRefreshMs(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647);
	});
});

describe("source-fetched items", () => {
	it("validates only the selected envelope and bounded row slice", () => {
		const rows = [{ id: "visible", title: "Visible" }];
		Object.defineProperty(rows, VIEW_SOURCE_LIMITS.maxScanRows, {
			get() {
				throw new Error("Row outside the scan bound was read");
			},
		});
		const payload = { rows };
		Object.defineProperty(payload, "unused", {
			enumerable: true,
			get() {
				throw new Error("Unselected response property was read");
			},
		});
		const source: ViewSource = {
			http: { path: "/api/x" },
			items: "rows",
			limit: 1,
		};
		expect(
			sourceItemsFromResponse(source, payload).map(({ item }) => item.id)
		).toEqual(["visible"]);
		expect(
			sourceTotalFromResponse({ ...source, limit: undefined }, payload)
		).toBe(rows.length);
	});

	const source: ViewSource = {
		http: { path: "/api/quests" },
		items: "quests",
		map: { subtitle: "detail", accessory: "status" },
	};

	it("maps response rows to items and keeps the raw row", () => {
		const items = sourceItemsFromResponse(source, {
			quests: [
				{ id: "q-1", title: "Write docs", detail: "for views", status: "open" },
				{ id: "q-2", title: "Ship it", status: "open" },
			],
		});
		expect(items).toHaveLength(2);
		expect(items[0]?.item).toEqual({
			id: "q-1",
			title: "Write docs",
			subtitle: "for views",
			detail: undefined,
			accessory: "open",
		});
		expect(items[0]?.raw.status).toBe("open");
		expect(items[1]?.item.subtitle).toBeUndefined();
	});

	// The avatar/icon pair is what lets a contributed section draw the avatar-led
	// roster row the shell's own Agents section draws, instead of approximating it.
	it("maps an avatar and a glyph, defaulting the glyph to the `icon` key", () => {
		const items = sourceItemsFromResponse(
			{
				http: { path: "/api/bots" },
				items: "bots",
				map: { avatar: "avatar_url", subtitle: "last_message" },
			},
			{
				bots: [
					{
						id: "b-1",
						title: "Researcher",
						avatar_url: "data:image/png;base64,AAA",
						last_message: "on it",
					},
					// No avatar: the row still maps, and the renderer falls back to the
					// section glyph rather than dropping the row or changing its shape.
					{ id: "b-2", title: "Editor", icon: "lucide:pencil" },
				],
			}
		);
		expect(items[0]?.item.avatar).toBe("data:image/png;base64,AAA");
		expect(items[0]?.item.icon).toBeUndefined();
		expect(items[1]?.item.avatar).toBeUndefined();
		// Unmapped `icon` still reads the raw row's `icon`, which is what every
		// section written before the field existed relies on.
		expect(items[1]?.item.icon).toBe("lucide:pencil");
	});

	it("reads the glyph from a declared key instead of the default", () => {
		const items = sourceItemsFromResponse(
			{
				http: { path: "/api/bots" },
				items: "bots",
				map: { icon: "glyph" },
			},
			{ bots: [{ id: "b-1", title: "Researcher", glyph: "lucide:bot" }] }
		);
		expect(items[0]?.item.icon).toBe("lucide:bot");
	});

	it("degrades bad payloads and rows to empty/skipped, never throws", () => {
		expect(sourceItemsFromResponse(source, null)).toEqual([]);
		expect(sourceItemsFromResponse(source, { quests: "nope" })).toEqual([]);
		expect(
			sourceItemsFromResponse(source, { quests: [{ title: "no id" }, 42] })
		).toEqual([]);
		// Bare-array payload + default id/title map.
		expect(
			sourceItemsFromResponse({ http: { path: "/api/x" } }, [
				{ id: 1, title: "One" },
			])
		).toHaveLength(1);
	});

	it("fails closed for a malformed runtime filter shape", () => {
		const source: ViewSource = { http: { path: "/api/items" } };
		Reflect.set(source, "filter", "not-an-array");
		expect(
			sourceItemsFromResponse(source, [{ id: "1", title: "One" }])
		).toEqual([]);
	});

	// One endpoint, several sections: `/api/runs` takes no query parameters, so a
	// status slice has to happen client-side or Working and Done show the same rows.
	const runs = {
		runs: [
			{ id: "r-1", title: "A", run_status: "running", folder_path: "/w/alpha" },
			{
				id: "r-2",
				title: "B",
				run_status: "completed",
				folder_path: "/w/beta",
			},
			{ id: "r-3", title: "C", run_status: "failed", folder_path: "/w/beta/" },
			{ id: "r-4", title: "D" },
		],
	};

	it("filters rows by equals / in / notIn, ANDing every predicate", () => {
		const slice = (filter: ViewSource["filter"]) =>
			sourceItemsFromResponse(
				{ http: { path: "/api/runs" }, items: "runs", filter },
				runs
			).map((entry) => entry.item.id);

		expect(slice([{ key: "run_status", equals: "running" }])).toEqual(["r-1"]);
		expect(slice([{ key: "run_status", in: ["completed", "failed"] }])).toEqual(
			["r-2", "r-3"]
		);
		expect(slice([{ key: "run_status", notIn: ["running"] }])).toEqual([
			"r-2",
			"r-3",
		]);
		expect(
			slice([
				{ key: "run_status", notIn: ["running"] },
				{ key: "folder_path", equals: "/w/beta" },
			])
		).toEqual(["r-2"]);
		// A key the row lacks never matches — r-4 has no run_status.
		expect(slice([{ key: "run_status" }])).toEqual(["r-1", "r-2", "r-3"]);
	});

	it("caps rows at `limit`, counting only rows that survived the filter", () => {
		expect(
			sourceItemsFromResponse(
				{
					http: { path: "/api/runs" },
					items: "runs",
					filter: [{ key: "run_status", notIn: ["running"] }],
					limit: 1,
				},
				runs
			).map((entry) => entry.item.id)
		).toEqual(["r-2"]);
	});

	it("uses an authoritative total instead of a paginated row length", () => {
		const paged = {
			items: [{ id: "q-1", title: "One" }],
			total_count: 27,
			next_cursor: "next",
		};
		const sourceWithLimit: ViewSource = {
			http: { path: "/api/quests" },
			items: "items",
			limit: 1,
		};
		expect(sourceTotalFromResponse(sourceWithLimit, paged)).toBe(27);
		expect(
			sourceTotalFromResponse(
				{ ...sourceWithLimit, total: "grand_total" },
				{ ...paged, grand_total: 42 }
			)
		).toBe(42);
		expect(
			sourceTotalFromResponse(sourceWithLimit, {
				items: paged.items,
				next_cursor: "next",
			})
		).toBe(null);
		expect(
			sourceTotalFromResponse(
				{ http: { path: "/api/quests" }, items: "items" },
				{ items: [{ id: "q-1", title: "One" }] }
			)
		).toBe(1);
	});

	it("shares the same total rule with contributed Store tabs", () => {
		const spec: StoreTabSpec = {
			source: {
				http: { path: "/api/templates" },
				items: "items",
				limit: 20,
			},
		};
		expect(
			storeTotalFromResponse(spec, {
				items: [{ id: "t-1", name: "One" }],
				next_cursor: "next",
				total: 86,
			})
		).toBe(86);
		expect(
			storeTotalFromResponse(spec, {
				items: Array.from({ length: 20 }, (_, index) => ({
					id: `t-${index}`,
					name: `Template ${index}`,
				})),
				next_cursor: "next",
			})
		).toBe(null);
	});

	it("transforms a subtitle to its basename and falls back for a missing title", () => {
		const items = sourceItemsFromResponse(
			{
				http: { path: "/api/runs" },
				items: "runs",
				map: {
					subtitle: "folder_path",
					subtitleTransform: "basename",
					titleFallback: "Untitled run",
				},
			},
			{
				runs: [
					{ id: "r-1", title: "A", folder_path: "/w/alpha" },
					// A trailing separator must not yield an empty second line.
					{ id: "r-2", title: "B", folder_path: "C:\\work\\beta\\" },
					// A run Core has not titled yet stays listed, under the fallback.
					{ id: "r-3", folder_path: "/w/gamma" },
					// No folder at all = no second line (the row stays single-line).
					{ id: "r-4", title: "D" },
				],
			}
		);
		expect(items.map((entry) => entry.item.subtitle)).toEqual([
			"alpha",
			"beta",
			"gamma",
			undefined,
		]);
		expect(items[2]?.item.title).toBe("Untitled run");
	});
});

// ── Store-tab catalog primitives (contributes.store_tabs) ────────────────────

describe("storeItemsFromResponse", () => {
	const spec: StoreTabSpec = {
		source: { http: { path: "/api/meetings/templates" }, items: "templates" },
		map: { tags: "tags", installed: "active", icon: "icon" },
		groupBy: "category",
	};

	it("maps catalog rows, defaulting title to `name`", () => {
		const items = storeItemsFromResponse(spec, {
			templates: [
				{
					id: "standup",
					name: "Daily standup",
					description: "Per-person progress",
					category: "recurring",
					icon: "lucide:repeat",
					tags: ["standup", "scrum"],
					active: true,
				},
			],
		});
		expect(items).toHaveLength(1);
		expect(items[0]?.title).toBe("Daily standup");
		expect(items[0]?.installed).toBe(true);
		expect(items[0]?.group).toBe("recurring");
		expect(items[0]?.tags).toEqual(["standup", "scrum"]);
		// The RAW row is preserved as the `{{item.<key>}}` templating base.
		expect(items[0]?.raw.category).toBe("recurring");
	});

	it("treats a row as not-installed when the spec maps no such flag", () => {
		const items = storeItemsFromResponse(
			{ source: { http: { path: "/api/x" } } },
			[{ id: "a", name: "A", active: true }]
		);
		expect(items[0]?.installed).toBe(false);
	});

	it("degrades a bad payload to empty and skips unusable rows", () => {
		expect(storeItemsFromResponse(spec, null)).toEqual([]);
		expect(storeItemsFromResponse(spec, { templates: "nope" })).toEqual([]);
		expect(
			storeItemsFromResponse(spec, { templates: [{ name: "no id" }, 42] })
		).toEqual([]);
	});
});

describe("store badge transform", () => {
	it("humanizes a wire token only when the tab asks for it", () => {
		const rows = [{ id: "a", name: "A", pattern: "evaluator-optimizer" }];
		const raw = storeItemsFromResponse(
			{ source: { http: { path: "/api/x" } }, map: { badge: "pattern" } },
			rows
		);
		expect(raw[0]?.badge).toBe("evaluator-optimizer");

		const humanized = storeItemsFromResponse(
			{
				source: { http: { path: "/api/x" } },
				map: { badge: "pattern", badgeTransform: "humanize" },
			},
			rows
		);
		expect(humanized[0]?.badge).toBe("Evaluator Optimizer");
	});
});

describe("storeDetailObject", () => {
	it("unwraps the declared envelope key, else returns the payload", () => {
		expect(
			storeDetailObject({ item: "template" }, { template: { id: "a" } })
		).toEqual({ id: "a" });
		expect(storeDetailObject({}, { id: "a" })).toEqual({ id: "a" });
		expect(storeDetailObject({ item: "template" }, null)).toBeUndefined();
	});
});

describe("storeGraphFromResponse", () => {
	const spec: StoreDetailGraphSpec = {
		nodes: "nodes",
		edges: "edges",
		nodeId: "id",
		edgeSource: "from",
		edgeTarget: "to",
		edgeLabel: "branch",
	};

	it("maps nodes and edges through the declared keys", () => {
		const graph = storeGraphFromResponse(spec, {
			nodes: [{ id: "draft" }, { id: "review" }],
			edges: [{ from: "draft", to: "review", branch: "true" }],
		});
		expect(graph.nodes).toEqual([
			{ id: "draft", label: "draft" },
			{ id: "review", label: "review" },
		]);
		expect(graph.edges).toEqual([
			{ label: "true", source: "draft", target: "review" },
		]);
	});

	it("drops edges that point at nodes the payload never declared", () => {
		const graph = storeGraphFromResponse(spec, {
			nodes: [{ id: "draft" }],
			edges: [{ from: "draft", to: "ghost" }],
		});
		expect(graph.edges).toEqual([]);
	});

	it("degrades a payload it cannot parse to an empty graph", () => {
		expect(storeGraphFromResponse(spec, null)).toEqual({
			edges: [],
			nodes: [],
		});
		expect(storeGraphFromResponse(spec, { nodes: "nope" })).toEqual({
			edges: [],
			nodes: [],
		});
	});
});

describe("groupStoreItems", () => {
	const spec: StoreTabSpec = {
		groupBy: "category",
		groups: [
			{ value: "recurring", label: "Team rituals" },
			{ value: "revenue", label: "Sales & customers" },
		],
	};
	const rows = (...categories: string[]) =>
		storeItemsFromResponse(
			{ ...spec, source: { http: { path: "/api/x" } } },
			categories.map((category, i) => ({
				id: `id-${i}`,
				name: `Row ${i}`,
				category,
			}))
		);

	it("orders groups as declared and drops empty ones", () => {
		const groups = groupStoreItems(spec, rows("revenue", "recurring"));
		expect(groups.map((g) => g.label)).toEqual([
			"Team rituals",
			"Sales & customers",
		]);
	});

	it("never drops a row whose category the manifest forgot to label", () => {
		const groups = groupStoreItems(spec, rows("recurring", "hiring"));
		expect(groups.map((g) => g.value)).toEqual(["recurring", "hiring"]);
		// The undeclared one is titled by its raw value rather than vanishing.
		expect(groups[1]?.label).toBe("hiring");
	});

	it("yields a single unlabelled group when the tab is ungrouped", () => {
		const ungrouped: StoreTabSpec = { source: { http: { path: "/api/x" } } };
		const items = storeItemsFromResponse(ungrouped, [{ id: "a", name: "A" }]);
		expect(groupStoreItems(ungrouped, items)).toEqual([
			{ items, label: "", value: "" },
		]);
		expect(groupStoreItems(ungrouped, [])).toEqual([]);
	});
});

describe("storeItemHaystack", () => {
	it("folds title, description, badge, tags and extra searchFields", () => {
		const spec: StoreTabSpec = {
			source: { http: { path: "/api/x" } },
			map: { badge: "pattern", tags: "tags" },
			searchFields: ["author"],
		};
		const [item] = storeItemsFromResponse(spec, [
			{
				id: "a",
				name: "Evaluator Optimizer",
				description: "Draft then critique",
				pattern: "evaluator-optimizer",
				tags: ["quality"],
				author: "Anthropic",
			},
		]);
		if (!item) {
			throw new Error("Expected mapped catalog item");
		}
		const hay = storeItemHaystack(spec, item);
		for (const needle of [
			"evaluator optimizer",
			"draft then critique",
			"evaluator-optimizer",
			"quality",
			"anthropic",
		]) {
			expect(hay).toContain(needle);
		}
	});
});
