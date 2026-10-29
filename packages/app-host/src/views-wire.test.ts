import { describe, expect, test } from "bun:test";
import {
	helloListDetail,
	type RawViewContribution,
	rawViewContributionSchema,
	type ViewSpec,
	validateView,
	viewSpecSchema,
} from "./views.ts";

const action = {
	id: "save",
	label: "Save",
	http: { method: "POST", path: "/api/save", body: { nested: [null, true] } },
	payload: { selected: 1 },
} as const;
const specs = [
	helloListDetail,
	{
		view: "list-detail",
		items: [
			{
				id: "row",
				title: "Row",
				actions: [action],
				badges: [{ label: "OK", tone: "success" }],
			},
		],
		source: {
			http: { path: "/api/rows" },
			filter: [
				{ key: "status", equals: "ready", in: ["ready"], notIn: ["done"] },
			],
			map: { title: "label", subtitleTransform: "basename", avatar: "image" },
			limit: 0,
			refreshMs: 0,
		},
	},
	{
		view: "data-table",
		columns: [{ id: "a", header: "A", align: "right" }],
		rows: [{ id: "row", cells: { a: 42, b: "Text" }, actions: [action] }],
	},
	{
		view: "form",
		fields: [
			{ id: "enabled", label: "Enabled", type: "switch", value: false },
			{ id: "count", label: "Count", type: "number", value: 0 },
			{
				id: "option",
				label: "Option",
				type: "select",
				options: [{ label: "One", value: "one" }],
			},
		],
		submit: action,
	},
	{ view: "action-panel", title: "Actions", actions: [action] },
	{
		view: "filter-bar",
		filters: [
			{
				id: "f",
				label: "Filter",
				options: [{ label: "One", value: "one" }],
				value: "one",
			},
		],
	},
	{ view: "empty-state", title: "", description: "Nothing yet", action },
	{
		view: "stat-card-row",
		stats: [{ id: "s", label: "Count", value: 0, delta: "+1", tone: "info" }],
	},
] satisfies ViewSpec[];

describe("declarative view wire contracts", () => {
	test("preserves all valid owner branches and additional public metadata", () => {
		for (const spec of specs) {
			const extended = { ...spec, customMetadata: { revision: 2 } };
			expect<ViewSpec>(viewSpecSchema.parse(extended)).toEqual(extended);
		}
	});
	test("rejects malformed nested fields even when the shallow renderer check passes", () => {
		for (const invalid of [
			{ view: "list-detail", items: [{ id: "row", title: 5 }] },
			{ view: "list-detail", items: [], source: { http: { path: 5 } } },
			{
				view: "data-table",
				columns: [],
				rows: [{ id: "row", cells: { column: false } }],
			},
			{ view: "form", fields: [{ id: "f", label: "Field", type: "future" }] },
			{
				view: "action-panel",
				actions: [
					{ id: "a", label: "A", http: { method: "TRACE", path: "/api/a" } },
				],
			},
			{ view: "filter-bar", filters: [{ id: "f", label: "F", options: null }] },
			{
				view: "stat-card-row",
				stats: [{ id: "s", label: "S", value: { nested: 1 } }],
			},
		]) {
			expect(validateView(invalid).ok).toBe(true);
			expect(viewSpecSchema.safeParse(invalid).success).toBe(false);
		}
	});
	test("forwards malformed and unknown JSON specs intact for renderer fallback", () => {
		const malformedSpecs: RawViewContribution["spec"][] = [
			null,
			"future",
			42,
			{ view: "future", custom: { a: true } },
			{ view: "list-detail" },
		];
		for (const spec of malformedSpecs) {
			const raw = { id: "v", view: "list-detail", spec };
			expect(rawViewContributionSchema.parse(raw)).toEqual(raw);
			expect(validateView(spec).ok).toBe(false);
		}
		expect(
			rawViewContributionSchema.safeParse({
				id: "v",
				view: "list-detail",
				spec: () => {},
			}).success
		).toBe(false);
	});
});
