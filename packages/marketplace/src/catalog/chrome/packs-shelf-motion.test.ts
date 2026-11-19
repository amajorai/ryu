import { describe, expect, test } from "bun:test";
import { packStackTransform, packStepForKey } from "./packs-shelf-motion.ts";

describe("packStepForKey", () => {
	test("left-to-right: ArrowRight and ArrowDown move forward", () => {
		expect(packStepForKey("ArrowRight", 1)).toBe(1);
		expect(packStepForKey("ArrowDown", 1)).toBe(1);
		expect(packStepForKey("ArrowLeft", 1)).toBe(-1);
		expect(packStepForKey("ArrowUp", 1)).toBe(-1);
	});

	test("right-to-left swaps the horizontal arrows only", () => {
		expect(packStepForKey("ArrowLeft", -1)).toBe(1);
		expect(packStepForKey("ArrowRight", -1)).toBe(-1);
		expect(packStepForKey("ArrowDown", -1)).toBe(1);
		expect(packStepForKey("ArrowUp", -1)).toBe(-1);
	});

	test("other keys do not move", () => {
		expect(packStepForKey("Home", -1)).toBe(0);
		expect(packStepForKey("Enter", 1)).toBe(0);
	});
});

describe("packStackTransform", () => {
	const base = { activeIndex: 0, count: 3, index: 2, isExpanded: true };

	test("left-to-right fans the stack toward the physical right", () => {
		expect(packStackTransform({ ...base, sign: 1 })).toBe(
			"translateX(7rem) rotate(10.5deg) scale(1)"
		);
	});

	test("right-to-left mirrors the translate and rotate", () => {
		expect(packStackTransform({ ...base, sign: -1 })).toBe(
			"translateX(-7rem) rotate(-10.5deg) scale(1)"
		);
	});

	test("collapsed stack keeps the resting tilt, mirrored under rtl", () => {
		expect(
			packStackTransform({ ...base, index: 0, isExpanded: false, sign: -1 })
		).toBe("translateX(0rem) rotate(2.5deg) scale(1)");
	});
});
