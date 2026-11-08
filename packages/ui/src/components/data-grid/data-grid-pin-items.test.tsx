import { describe, expect, test } from "bun:test";
import type { GridColumnMetrics } from "@ryu/ui/lib/data-grid.ts";
import { getColumnPinningStyle } from "@ryu/ui/lib/data-grid.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { DataGridPinLabel, physicalPinEdge } from "./data-grid-pin-items.tsx";

function label(
	side: "left" | "right",
	dir: "ltr" | "rtl",
	pinned = false
): string {
	return renderToStaticMarkup(
		<DataGridPinLabel dir={dir} pinned={pinned} side={side} />
	);
}

/** A column pinned to `side` at offset 0, enough for the pinning style. */
function pinnedColumn(side: "left" | "right") {
	return {
		getAfter: () => 0,
		getIsFirstColumn: () => true,
		getIsLastColumn: () => true,
		getIsPinned: () => side,
		getSize: () => 120,
		getStart: () => 0,
	} as unknown as GridColumnMetrics<unknown>;
}

/** The physical edge the pinning style actually sticks a column to. */
function styledEdge(side: "left" | "right", dir: "ltr" | "rtl") {
	const style = getColumnPinningStyle({ column: pinnedColumn(side), dir });
	return style["--data-grid-pin-left"] === undefined ? "right" : "left";
}

describe("DataGridPinLabel", () => {
	test("keeps the physical labels left-to-right", () => {
		expect(label("left", "ltr")).toContain("Pin to left");
		expect(label("right", "ltr")).toContain("Pin to right");
		expect(label("left", "ltr", true)).toContain("Unpin from left");
		expect(label("right", "ltr", true)).toContain("Unpin from right");
	});

	test("names the mirrored edge right-to-left", () => {
		expect(label("left", "rtl")).toContain("Pin to right");
		expect(label("left", "rtl")).not.toContain("Pin to left");
		expect(label("right", "rtl")).toContain("Pin to left");
		expect(label("left", "rtl", true)).toContain("Unpin from right");
		expect(label("right", "rtl", true)).toContain("Unpin from left");
	});

	test("the label matches the edge the column moves to in both directions", () => {
		for (const dir of ["ltr", "rtl"] as const) {
			for (const side of ["left", "right"] as const) {
				const edge = styledEdge(side, dir);
				expect(physicalPinEdge(side, dir)).toBe(edge);
				expect(label(side, dir)).toContain(`Pin to ${edge}`);
			}
		}
	});
});
