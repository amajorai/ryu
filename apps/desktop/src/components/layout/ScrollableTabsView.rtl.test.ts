import { describe, expect, test } from "bun:test";
import { cardIndexForKey, inlineWheelDelta } from "./scrollable-tabs-keys.ts";

describe("ScrollableTabsView reading direction", () => {
	test("left-to-right: ArrowRight moves to the next card", () => {
		expect(cardIndexForKey("ArrowRight", 1)).toBe(2);
		expect(cardIndexForKey("ArrowLeft", 1)).toBe(0);
	});

	test("right-to-left: ArrowLeft moves to the next card", () => {
		expect(cardIndexForKey("ArrowLeft", 1, "rtl")).toBe(2);
		expect(cardIndexForKey("ArrowRight", 1, "rtl")).toBe(0);
		expect(cardIndexForKey("ArrowDown", 1, "rtl")).toBeUndefined();
	});

	test("the wheel scrolls toward the inline end in both directions", () => {
		expect(inlineWheelDelta(40)).toBe(40);
		// RTL scrollLeft runs from 0 toward negative values at the inline end.
		expect(inlineWheelDelta(40, "rtl")).toBe(-40);
	});
});
