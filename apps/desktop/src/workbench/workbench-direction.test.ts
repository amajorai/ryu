import { describe, expect, test } from "bun:test";
import type { WorkbenchRegion } from "@ryu/workbench/model";
import {
	physicalSide,
	regionDeltaSign,
	regionPointerDelta,
} from "./workbench-direction.ts";

describe("regionDeltaSign", () => {
	test("grows Left when its separator moves toward the screen's right under LTR", () => {
		expect(regionDeltaSign("left", "ltr")).toBe(1);
		expect(regionDeltaSign("right", "ltr")).toBe(-1);
	});

	test("mirrors the side regions under RTL", () => {
		expect(regionDeltaSign("left", "rtl")).toBe(-1);
		expect(regionDeltaSign("right", "rtl")).toBe(1);
	});

	test("keeps Bottom growing upward in both directions", () => {
		expect(regionDeltaSign("bottom", "ltr")).toBe(-1);
		expect(regionDeltaSign("bottom", "rtl")).toBe(-1);
	});
});

describe("regionPointerDelta", () => {
	const start = { x: 100, y: 400 };
	const moved = { x: 150, y: 370 };

	test("reads the horizontal axis for side regions", () => {
		expect(regionPointerDelta("left", "ltr", start, moved)).toBe(50);
		expect(regionPointerDelta("right", "ltr", start, moved)).toBe(-50);
		expect(regionPointerDelta("left", "rtl", start, moved)).toBe(-50);
		expect(regionPointerDelta("right", "rtl", start, moved)).toBe(50);
	});

	test("reads the vertical axis for Bottom", () => {
		expect(regionPointerDelta("bottom", "ltr", start, moved)).toBe(30);
		expect(regionPointerDelta("bottom", "rtl", start, moved)).toBe(30);
	});
});

describe("physicalSide", () => {
	test("keeps ids unchanged under LTR", () => {
		expect(physicalSide("left", "ltr")).toBe("left");
		expect(physicalSide("right", "ltr")).toBe("right");
	});

	test("swaps left and right under RTL and keeps other sides", () => {
		// Widen the generic: a mirrored side is a different literal than its input.
		expect(physicalSide<WorkbenchRegion>("left", "rtl")).toBe("right");
		expect(physicalSide<WorkbenchRegion>("right", "rtl")).toBe("left");
		expect(physicalSide("bottom", "rtl")).toBe("bottom");
		expect(physicalSide("center", "rtl")).toBe("center");
		expect(physicalSide("full", "rtl")).toBe("full");
	});
});
