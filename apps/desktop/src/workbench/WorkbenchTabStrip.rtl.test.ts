import { describe, expect, test } from "bun:test";
import { tabIndexForKey } from "./workbench-tab-keys.ts";

describe("tabIndexForKey", () => {
	test("left-to-right: ArrowRight moves to the next tab", () => {
		expect(tabIndexForKey("ArrowRight", 0, 3)).toBe(1);
		expect(tabIndexForKey("ArrowLeft", 0, 3)).toBe(2);
	});

	test("right-to-left: ArrowLeft moves to the next tab", () => {
		expect(tabIndexForKey("ArrowLeft", 0, 3, "rtl")).toBe(1);
		expect(tabIndexForKey("ArrowRight", 0, 3, "rtl")).toBe(2);
	});

	test("Home and End ignore the reading direction", () => {
		expect(tabIndexForKey("Home", 2, 3, "rtl")).toBe(0);
		expect(tabIndexForKey("End", 0, 3, "rtl")).toBe(2);
		expect(tabIndexForKey("Enter", 0, 3, "rtl")).toBeUndefined();
	});
});
