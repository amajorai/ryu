import { describe, expect, test } from "bun:test";
import { dayStepForKey, pagerFor } from "./journal-interface-support.ts";

const actions = {
	atToday: false,
	onStep: () => undefined,
	onToday: () => undefined,
};

describe("dayStepForKey", () => {
	test("left-to-right: ArrowLeft goes back, ArrowRight goes forward", () => {
		expect(dayStepForKey("ArrowLeft", 1)).toBe(-1);
		expect(dayStepForKey("ArrowRight", 1)).toBe(1);
	});

	test("right-to-left swaps the arrows", () => {
		expect(dayStepForKey("ArrowLeft", -1)).toBe(1);
		expect(dayStepForKey("ArrowRight", -1)).toBe(-1);
	});

	test("other keys do not step", () => {
		expect(dayStepForKey("ArrowUp", 1)).toBe(0);
		expect(dayStepForKey("a", -1)).toBe(0);
	});
});

describe("pagerFor", () => {
	test("day pager key caps follow the reading direction", () => {
		const ltr = pagerFor("day", actions);
		expect(ltr?.nextKeys).toEqual(["⌥", "→"]);
		expect(ltr?.nextShortcut).toBe("Alt+ArrowRight");
		expect(ltr?.previousShortcut).toBe("Alt+ArrowLeft");

		const rtl = pagerFor("day", { ...actions, sign: -1 });
		expect(rtl?.nextKeys).toEqual(["⌥", "←"]);
		expect(rtl?.previousKeys).toEqual(["⌥", "→"]);
		expect(rtl?.nextShortcut).toBe("Alt+ArrowLeft");
		expect(rtl?.previousShortcut).toBe("Alt+ArrowRight");
		expect(rtl && "sign" in rtl).toBe(false);
	});

	test("month pager has no key caps and the stats page has no pager", () => {
		expect(pagerFor("calendar", { ...actions, sign: -1 })?.nextKeys).toBe(
			undefined
		);
		expect(pagerFor("stats", actions)).toBe(null);
	});
});
