import { expect, test } from "bun:test";
import { viewSpecSchema as canonicalViewSpecSchema } from "../../../../packages/app-host/src/views.ts";
import {
	contributedViewsFromResponse,
	viewClaimingSurface,
} from "./contributions.ts";
import { type ViewSpec, viewSpecSchema } from "./views.ts";

test("CLI parsing mirrors all seven canonical view contracts and preserves metadata", () => {
	const specs = [
		{ view: "list-detail", items: [{ id: "one", title: "One" }] },
		{
			view: "data-table",
			columns: [{ id: "name", header: "Name" }],
			rows: [{ id: "one", cells: { name: "One" } }],
		},
		{
			view: "form",
			fields: [{ id: "count", label: "Count", type: "number", value: 3 }],
		},
		{ view: "action-panel", actions: [{ id: "run", label: "Run" }] },
		{
			view: "filter-bar",
			filters: [
				{
					id: "kind",
					label: "Kind",
					options: [{ value: "all", label: "All" }],
				},
			],
		},
		{ view: "empty-state", title: "Empty" },
		{
			view: "stat-card-row",
			stats: [{ id: "count", label: "Count", value: 3 }],
		},
	] satisfies ViewSpec[];
	for (const spec of specs) {
		const extended = { ...spec, future_metadata: { version: 2 } };
		expect(canonicalViewSpecSchema.parse(extended)).toEqual(
			viewSpecSchema.parse(extended)
		);
	}
});

test("malformed nested contracts keep the route envelope without entering typed renderer state", () => {
	const malformed = { view: "list-detail", items: [{ id: 42, title: "One" }] };
	expect(viewSpecSchema.safeParse(malformed).success).toBe(false);
	expect(canonicalViewSpecSchema.safeParse(malformed).success).toBe(false);
	const views = contributedViewsFromResponse({
		views: [{ id: "surface:tasks", plugin: "owner", spec: malformed }],
	});
	expect(views).toHaveLength(1);
	expect(views[0]?.view).toBe("list-detail");
	expect(views[0]?.spec).toBeDefined();
	expect(viewClaimingSurface(views, "tasks")).toBeUndefined();
});
