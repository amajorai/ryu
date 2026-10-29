import { expect, test } from "bun:test";
import {
	allocatePaneBudgets,
	formatTabLabel,
	tabRowWidth,
	visibleTabWindow,
} from "../workspace/tabStripLayout.ts";

test("formatTabLabel prefixes the jump index and keeps short titles whole", () => {
	expect(formatTabLabel(1, "Home")).toBe("1:Home");
	expect(formatTabLabel(3, "Agents", 20, true)).toBe("3:*Agents");
});

test("formatTabLabel cuts long titles to the column budget with an ellipsis", () => {
	const label = formatTabLabel(2, "A very long conversation title");
	expect(label).toBe("2:A very long conve…");
	expect(Bun.stringWidth(label)).toBe(20);
	// Wide glyphs count as two columns.
	const wide = formatTabLabel(4, "会話のタイトルがとても長いです", 12);
	expect(Bun.stringWidth(wide)).toBeLessThanOrEqual(12);
	expect(wide.endsWith("…")).toBe(true);
});

test("visibleTabWindow returns every chip when they fit", () => {
	expect(visibleTabWindow([8, 8, 8], 1, 40)).toEqual({ start: 0, end: 3 });
	expect(visibleTabWindow([], 0, 40)).toEqual({ start: 0, end: 0 });
});

test("visibleTabWindow keeps the active chip visible and centred", () => {
	const widths = new Array(10).fill(10);
	// Budget for three chips plus both markers ("‹ +N" and "+N ›").
	const middle = visibleTabWindow(widths, 5, 3 * 10 + 4 + 4 + 4);
	expect(middle.start).toBeLessThanOrEqual(5);
	expect(middle.end).toBeGreaterThan(5);
	expect(middle.end - middle.start).toBe(3);
	expect(middle).toEqual({ start: 4, end: 7 });

	const last = visibleTabWindow(widths, 9, 40);
	expect(last.end).toBe(10);
	expect(last.start).toBeGreaterThan(0);

	const firstTab = visibleTabWindow(widths, 0, 40);
	expect(firstTab.start).toBe(0);
	expect(firstTab.end).toBeLessThan(10);
});

test("visibleTabWindow always includes the active chip even when it alone overflows", () => {
	expect(visibleTabWindow([30, 30, 30], 1, 10)).toEqual({ start: 1, end: 2 });
});

test("tabRowWidth sums chips and gaps without overflow markers", () => {
	expect(tabRowWidth([8, 8, 8], 0)).toBe(24);
	expect(tabRowWidth([8, 8, 8], 1)).toBe(26);
	expect(tabRowWidth([], 0)).toBe(0);
});

test("allocatePaneBudgets lends a short pane's spare columns to a crowded one", () => {
	// Even split when both overflow.
	expect(allocatePaneBudgets([100, 100], 60)).toEqual([30, 30]);
	// The short right pane keeps what it needs; the left takes the rest.
	expect(allocatePaneBudgets([100, 14], 60)).toEqual([46, 14]);
	// Everything fits: each pane gets exactly its need.
	expect(allocatePaneBudgets([10, 14], 60)).toEqual([10, 14]);
	expect(allocatePaneBudgets([100], 60)).toEqual([60]);
	// Never hands a pane zero columns.
	expect(allocatePaneBudgets([100, 100], 0)).toEqual([1, 1]);
});
