import { describe, expect, test } from "bun:test";
import {
	dockHideTransform,
	dockResizeDelta,
} from "./workspace-dock-direction.ts";

describe("dockHideTransform", () => {
	test("slides past the physical right under LTR", () => {
		expect(dockHideTransform("ltr")).toBe("translateX(100%)");
	});

	test("slides past the physical left under RTL", () => {
		expect(dockHideTransform("rtl")).toBe("translateX(-100%)");
	});
});

describe("dockResizeDelta", () => {
	test("dragging left widens the LTR dock", () => {
		expect(dockResizeDelta("horizontal", "ltr", 500, 440)).toBe(60);
	});

	test("dragging to the physical left narrows the RTL dock", () => {
		expect(dockResizeDelta("horizontal", "rtl", 500, 440)).toBe(-60);
	});

	test("dragging to the physical right widens the RTL dock", () => {
		expect(dockResizeDelta("horizontal", "rtl", 300, 360)).toBe(60);
	});

	test("vertical drags ignore reading direction", () => {
		expect(dockResizeDelta("vertical", "rtl", 600, 550)).toBe(50);
		expect(dockResizeDelta("vertical", "ltr", 600, 550)).toBe(50);
	});
});
