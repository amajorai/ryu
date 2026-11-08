import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { KeyboardEvent } from "react";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function key(name: string) {
	// SAFETY: getKeyboardResizeDelta reads only `key` and `shiftKey`.
	return { key: name, shiftKey: false } as KeyboardEvent<HTMLDivElement>;
}

describe("table resize under RTL", () => {
	test("reads the table's writing direction as an inline sign", async () => {
		const { getTableInlineSign } = await import("./table-node-resize-rtl.ts");
		const rtlTable = document.createElement("table");
		rtlTable.style.direction = "rtl";
		document.body.append(rtlTable);
		const ltrTable = document.createElement("table");
		document.body.append(ltrTable);

		expect(getTableInlineSign(rtlTable)).toBe(-1);
		expect(getTableInlineSign(ltrTable)).toBe(1);
		expect(getTableInlineSign(null)).toBe(1);

		rtlTable.remove();
		ltrTable.remove();
	});

	test("dragging the end handle 40px to the left grows the column by 40px", async () => {
		const { toInlineResizeDelta } = await import("./table-node-resize-rtl.ts");

		expect(toInlineResizeDelta(-40, "right", -1)).toBe(40);
		expect(toInlineResizeDelta(-40, "right", 1)).toBe(-40);
		// The start-margin handle follows the same inline axis.
		expect(toInlineResizeDelta(-24, "left", -1)).toBe(24);
		// Row heights are vertical and never mirror.
		expect(toInlineResizeDelta(-16, "bottom", -1)).toBe(-16);
	});

	test("ArrowLeft grows the column under RTL", async () => {
		const { getKeyboardResizeDelta } = await import(
			"./table-node-resize-context.ts"
		);
		const { toInlineResizeDelta } = await import("./table-node-resize-rtl.ts");
		const arrowLeft = getKeyboardResizeDelta(key("ArrowLeft"), "right") ?? 0;
		const arrowRight = getKeyboardResizeDelta(key("ArrowRight"), "right") ?? 0;

		expect(toInlineResizeDelta(arrowLeft, "right", -1)).toBeGreaterThan(0);
		expect(toInlineResizeDelta(arrowRight, "right", -1)).toBeLessThan(0);
		expect(toInlineResizeDelta(arrowRight, "right", 1)).toBeGreaterThan(0);
	});

	test("measures the hovered handle from the wrapper's inline start", async () => {
		const { getHandleInlineOffset } = await import(
			"./table-node-resize-rtl.ts"
		);
		const wrapperRect = { left: 100, right: 500 };
		const handleRect = { left: 296, right: 304, width: 8 };

		expect(getHandleInlineOffset(handleRect, wrapperRect, 1)).toBe(200);
		expect(getHandleInlineOffset(handleRect, wrapperRect, -1)).toBe(200);
		expect(
			getHandleInlineOffset(
				{ left: 396, right: 404, width: 8 },
				wrapperRect,
				-1
			)
		).toBe(100);
	});

	test("the boundary indicator is placed with inset-inline-start", async () => {
		const { hideIndicator, showIndicator } = await import(
			"./table-node-resize-helpers.ts"
		);
		const indicator = document.createElement("div");

		showIndicator(indicator, 128);

		expect(indicator.style.display).toBe("block");
		expect(indicator.style.getPropertyValue("inset-inline-start")).toBe(
			"128px"
		);
		expect(indicator.style.getPropertyValue("left")).toBe("");

		hideIndicator(indicator);

		expect(indicator.style.display).toBe("none");
		expect(indicator.style.getPropertyValue("inset-inline-start")).toBe("");
	});

	test("the controller flips pointer and keyboard deltas by the inline sign", async () => {
		const source = await Bun.file(
			new URL("./table-node-resize-controller.ts", import.meta.url)
		).text();

		expect(source).toContain("toInlineResizeDelta(");
		expect(
			source.match(/inlineSignRef\.current = getTableInlineSign\(/g)
		).toHaveLength(2);
	});

	test("the editor table pads its stored margin on the inline start", async () => {
		const css = await Bun.file(
			new URL("../editor-lint.module.css", import.meta.url)
		).text();
		const rule = css.match(/\.editortableNode1 \{[^}]*\}/)?.[0] ?? "";

		expect(rule).toContain("padding-inline-start:");
		expect(rule).not.toContain("padding-left:");
	});
});
