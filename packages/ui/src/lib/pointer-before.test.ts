import { describe, expect, test } from "bun:test";
import {
	pointerBefore,
	pointerBeforeOnAxis,
	readingDirectionOf,
} from "./pointer-before.ts";

// A tab drawn from x=100 to x=200 (middle at 150), y=10 to y=40.
const rect = { height: 30, left: 100, top: 10, width: 100 };

describe("pointerBefore", () => {
	test("LTR: the left half is before, the right half after", () => {
		expect(pointerBefore(120, rect, "ltr")).toBe(true);
		expect(pointerBefore(180, rect, "ltr")).toBe(false);
	});

	test("RTL: the right half is before, the left half after", () => {
		expect(pointerBefore(180, rect, "rtl")).toBe(true);
		expect(pointerBefore(120, rect, "rtl")).toBe(false);
	});

	test("the exact middle drops after in both directions", () => {
		expect(pointerBefore(150, rect, "ltr")).toBe(false);
		expect(pointerBefore(150, rect, "rtl")).toBe(false);
	});
});

describe("pointerBeforeOnAxis", () => {
	test("the x axis follows the reading direction", () => {
		expect(pointerBeforeOnAxis(180, 0, rect, "x", "rtl")).toBe(true);
		expect(pointerBeforeOnAxis(180, 0, rect, "x", "ltr")).toBe(false);
	});

	test("the y axis uses the top half regardless of direction", () => {
		expect(pointerBeforeOnAxis(180, 15, rect, "y", "rtl")).toBe(true);
		expect(pointerBeforeOnAxis(120, 35, rect, "y", "ltr")).toBe(false);
	});
});

describe("readingDirectionOf", () => {
	test("falls back to LTR without an element", () => {
		expect(readingDirectionOf(null)).toBe("ltr");
		expect(readingDirectionOf(undefined)).toBe("ltr");
	});
});
