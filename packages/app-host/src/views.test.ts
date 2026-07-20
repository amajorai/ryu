import { describe, expect, it } from "bun:test";
import {
	helloListDetail,
	helloListDetailContribution,
	isCoreApiPath,
	isKnownViewKind,
	renderActionHttp,
	renderTemplate,
	sourceItemsFromResponse,
	VIEW_KINDS,
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
		const cases: [ViewSpec["view"], Record<string, unknown>, string][] = [
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
		expect(isCoreApiPath("/etc/passwd")).toBe(false);
		expect(isCoreApiPath("https://evil.example/api/")).toBe(false);
		expect(isCoreApiPath("/api/../admin")).toBe(false);
		expect(() =>
			renderActionHttp(
				{ method: "GET", path: "{{item.url}}" },
				{ item: { url: "https://evil.example/" } }
			)
		).toThrow();
	});
});

describe("source-fetched items", () => {
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
});
