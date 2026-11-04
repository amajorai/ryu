import { describe, expect, test } from "bun:test";
import {
	axisSlot,
	computeReorderShifts,
	physicalOffset,
	type ReorderSlot,
	reorderDestination,
} from "./reorder-shift.ts";

// Three rows: A is 20px tall, B 40px, C 20px, with a 4px gap between rows.
const slots: ReorderSlot[] = [
	{ id: "a", start: 0, end: 20 },
	{ id: "b", start: 24, end: 64 },
	{ id: "c", start: 68, end: 88 },
];

describe("reorderDestination", () => {
	test("take-the-slot lists land on the target index", () => {
		expect(reorderDestination(0, 2)).toBe(2);
		expect(reorderDestination(2, 0)).toBe(0);
	});

	test("before/after lists account for the removed source", () => {
		expect(reorderDestination(0, 2, true)).toBe(1);
		expect(reorderDestination(0, 2, false)).toBe(2);
		expect(reorderDestination(2, 0, false)).toBe(1);
		expect(reorderDestination(0, 1, true)).toBe(0);
	});
});

describe("computeReorderShifts", () => {
	test("no target or the source itself shifts nothing", () => {
		expect(computeReorderShifts(slots, "a", null).size).toBe(0);
		expect(computeReorderShifts(slots, "a", "a").size).toBe(0);
		expect(computeReorderShifts(slots, "a", "missing").size).toBe(0);
	});

	test("a drop that keeps the order shifts nothing", () => {
		expect(computeReorderShifts(slots, "a", "b", true).size).toBe(0);
	});

	test("dragging forward pulls the passed rows back by the source pitch", () => {
		const shifts = computeReorderShifts(slots, "a", "c");
		expect(shifts.get("b")).toBe(-24);
		expect(shifts.get("c")).toBe(-24);
		// A ends where C ended.
		expect(shifts.get("a")).toBe(68);
	});

	test("dragging back pushes the passed rows forward by the source pitch", () => {
		const shifts = computeReorderShifts(slots, "c", "a");
		expect(shifts.get("a")).toBe(24);
		expect(shifts.get("b")).toBe(24);
		// C starts where A started.
		expect(shifts.get("c")).toBe(-68);
	});

	test("mixed sizes keep the gap intact", () => {
		const shifts = computeReorderShifts(slots, "b", "c", false);
		// B (40px + 4px gap) moves past C: C steps back 44px to start at 24.
		expect(shifts.get("c")).toBe(-44);
		// B ends where C ended: 64 → 88.
		expect(shifts.get("b")).toBe(24);
		expect(shifts.has("a")).toBe(false);
	});
});

// The same three items as a right-to-left row: A is drawn rightmost (280-300),
// B at 236-276, C leftmost (212-232), with 4px gaps.
const rtlRects = {
	a: { bottom: 20, left: 280, right: 300, top: 0 },
	b: { bottom: 20, left: 236, right: 276, top: 0 },
	c: { bottom: 20, left: 212, right: 232, top: 0 },
};

function rtlSlots(): ReorderSlot[] {
	return Object.entries(rtlRects)
		.map(([id, rect]) => axisSlot(id, rect, "x", true))
		.sort((left, right) => left.start - right.start);
}

describe("axisSlot", () => {
	test("LTR and vertical slots keep their physical coordinates", () => {
		expect(axisSlot("a", rtlRects.a, "x", false)).toEqual({
			id: "a",
			start: 280,
			end: 300,
		});
		expect(axisSlot("a", rtlRects.a, "y", true)).toEqual({
			id: "a",
			start: 0,
			end: 20,
		});
	});

	test("RTL slots sort in reading (DOM) order", () => {
		expect(rtlSlots().map((slot) => slot.id)).toEqual(["a", "b", "c"]);
	});
});

describe("computeReorderShifts under RTL", () => {
	test("dropping A after C slides it leftwards into C's slot", () => {
		const shifts = computeReorderShifts(rtlSlots(), "a", "c", false);
		const screen = (id: string) =>
			physicalOffset(shifts.get(id) ?? 0, "x", true);
		// B and C step right by A's pitch (20px + 4px gap).
		expect(screen("b")).toBe(24);
		expect(screen("c")).toBe(24);
		// A moves from 280-300 to C's old slot at 212-232.
		expect(rtlRects.a.left + screen("a")).toBe(rtlRects.c.left);
	});

	test("dropping C before A slides it rightwards into A's slot", () => {
		const shifts = computeReorderShifts(rtlSlots(), "c", "a", true);
		const screen = (id: string) =>
			physicalOffset(shifts.get(id) ?? 0, "x", true);
		expect(screen("a")).toBe(-24);
		expect(screen("b")).toBe(-24);
		expect(rtlRects.c.right + screen("c")).toBe(rtlRects.a.right);
	});

	test("offsets are only mirrored for a right-to-left x axis", () => {
		expect(physicalOffset(10, "x", false)).toBe(10);
		expect(physicalOffset(10, "y", true)).toBe(10);
		expect(physicalOffset(10, "x", true)).toBe(-10);
	});
});
