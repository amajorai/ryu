import { expect, test } from "bun:test";
import { paletteWindow } from "../palette/window.ts";

const GROUPS = [
	"Suggested",
	"Navigation",
	"Navigation",
	"Navigation",
	"Actions",
	"Actions",
	"Actions",
	"Plugins",
];

test("a flat list shows up to maxRows rows from the top", () => {
	expect(paletteWindow(30, 0, 40, 10)).toEqual({ end: 10, start: 0 });
});

test("a flat list scrolls so the selection is the last visible row", () => {
	expect(paletteWindow(30, 14, 40, 10)).toEqual({ end: 15, start: 5 });
});

test("the line budget caps a flat list below maxRows", () => {
	expect(paletteWindow(30, 0, 4, 10)).toEqual({ end: 4, start: 0 });
});

test("group headers and spacers count against the line budget", () => {
	// Suggested header + row (2), spacer + Navigation header + row (3), then two
	// more Navigation rows (2) = 7 lines; the next row opens Actions (3 more).
	expect(paletteWindow(GROUPS.length, 0, 7, 10, GROUPS)).toEqual({
		end: 4,
		start: 0,
	});
	expect(paletteWindow(GROUPS.length, 0, 10, 10, GROUPS)).toEqual({
		end: 5,
		start: 0,
	});
});

test("scrolling past a group boundary keeps the selection inside the budget", () => {
	const window = paletteWindow(GROUPS.length, 7, 7, 10, GROUPS);
	expect(window.end).toBe(8);
	// Actions header + 3 rows (4), spacer + Plugins header + row (3) = 7.
	expect(window.start).toBe(4);
});

test("the selection stays visible even when the budget is too small", () => {
	expect(paletteWindow(GROUPS.length, 5, 1, 10, GROUPS)).toEqual({
		end: 6,
		start: 5,
	});
});

test("an empty list yields an empty window", () => {
	expect(paletteWindow(0, 0, 10, 10)).toEqual({ end: 0, start: 0 });
});
