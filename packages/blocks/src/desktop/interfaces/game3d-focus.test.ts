import { describe, expect, test } from "bun:test";
import {
	type FocusPlate,
	nextFocus,
	readingOrder,
	readingRows,
} from "./game3d-focus.ts";

// Two loose rows (y about 100 and 200) with a little vertical jitter, as
// plates billboarded over an isometric scene land.
const PAGE: FocusPlate[] = [
	{ x: 300, y: 104 }, // 0: row 1, right
	{ x: 100, y: 96 }, // 1: row 1, left
	{ x: 200, y: 110 }, // 2: row 1, middle
	{ x: 120, y: 205 }, // 3: row 2, left
	{ x: 280, y: 195 }, // 4: row 2, right
];

describe("reading order", () => {
	test("groups plates into rows top to bottom, left to right", () => {
		expect(readingRows(PAGE)).toEqual([
			[1, 2, 0],
			[3, 4],
		]);
		expect(readingOrder(PAGE)).toEqual([1, 2, 0, 3, 4]);
	});

	test("a row starts at its first plate, so a slope does not chain", () => {
		const slope: FocusPlate[] = [
			{ x: 0, y: 0 },
			{ x: 10, y: 15 },
			{ x: 20, y: 30 },
		];
		expect(readingRows(slope)).toEqual([[0, 1], [2]]);
	});
});

describe("nextFocus", () => {
	test("left and right step through the reading order", () => {
		expect(nextFocus(PAGE, 1, "ArrowRight")).toBe(2);
		expect(nextFocus(PAGE, 2, "ArrowRight")).toBe(0);
		// The end of a row continues on the next row, like reading.
		expect(nextFocus(PAGE, 0, "ArrowRight")).toBe(3);
		expect(nextFocus(PAGE, 3, "ArrowLeft")).toBe(0);
	});

	test("up and down move to the nearest plate in the next row", () => {
		expect(nextFocus(PAGE, 0, "ArrowDown")).toBe(4);
		expect(nextFocus(PAGE, 1, "ArrowDown")).toBe(3);
		expect(nextFocus(PAGE, 4, "ArrowUp")).toBe(0);
	});

	test("stays put at either end instead of wrapping", () => {
		expect(nextFocus(PAGE, 1, "ArrowLeft")).toBe(1);
		expect(nextFocus(PAGE, 1, "ArrowUp")).toBe(1);
		expect(nextFocus(PAGE, 4, "ArrowRight")).toBe(4);
		expect(nextFocus(PAGE, 3, "ArrowDown")).toBe(3);
	});

	test("nothing focused starts at the first plate", () => {
		expect(nextFocus(PAGE, -1, "ArrowDown")).toBe(1);
		expect(nextFocus([], -1, "ArrowDown")).toBe(-1);
	});

	test("ordered plates follow the game's order, not the screen", () => {
		// Advent doors scattered over a house front: 3 sits top left.
		const doors: FocusPlate[] = [
			{ order: 2, x: 400, y: 300 },
			{ order: 3, x: 50, y: 50 },
			{ order: 1, x: 200, y: 400 },
			{ x: 10, y: 10 }, // a villager plate, no order
		];
		expect(nextFocus(doors, -1, "ArrowRight")).toBe(2);
		expect(nextFocus(doors, 2, "ArrowRight")).toBe(0);
		expect(nextFocus(doors, 0, "ArrowDown")).toBe(1);
		expect(nextFocus(doors, 1, "ArrowUp")).toBe(0);
		expect(nextFocus(doors, 0, "ArrowLeft")).toBe(2);
		expect(nextFocus(doors, 1, "ArrowRight")).toBe(1);
		// From the unordered villager, the page order still reaches doors.
		expect(nextFocus(doors, 3, "ArrowRight")).toBe(1);
	});
});
