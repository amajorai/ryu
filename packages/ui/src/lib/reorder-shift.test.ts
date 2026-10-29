import { describe, expect, test } from "bun:test";
import {
	computeReorderShifts,
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
