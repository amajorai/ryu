// The week grid's hidden-day count and scroll targets in both text directions.
// The sticky hour gutter sits on the start edge, so in a right-to-left UI the
// oldest days hide behind it on the right and "newest" is a negative scrollLeft.

import { describe, expect, test } from "bun:test";
import { countHiddenDays, scrollWeekTo } from "./timeline-week-reveal.tsx";

interface Box {
	left: number;
	right: number;
}

function fakeScroller(
	direction: "ltr" | "rtl",
	days: readonly Box[]
): HTMLElement & { scrollLeft: number } {
	const headings = days.map((box) => ({ getBoundingClientRect: () => box }));
	const scroller = {
		clientLeft: 0,
		clientWidth: 400,
		getBoundingClientRect: () => ({ left: 100, right: 500 }),
		ownerDocument: {
			defaultView: { getComputedStyle: () => ({ direction }) },
		},
		querySelectorAll: () => headings,
		scrollLeft: 0,
		scrollWidth: 900,
	};
	return scroller as unknown as HTMLElement & { scrollLeft: number };
}

// Viewport content box is x 100..500; the gutter is 60px wide.
const GUTTER = 60;

describe("countHiddenDays", () => {
	test("left to right: the oldest days hide behind the gutter on the left", () => {
		const scroller = fakeScroller("ltr", [
			{ left: 20, right: 120 },
			{ left: 120, right: 220 },
			{ left: 160, right: 260 },
			{ left: 400, right: 500 },
			{ left: 480, right: 580 },
		]);
		expect(countHiddenDays(scroller, GUTTER)).toEqual({ after: 1, before: 2 });
	});

	test("right to left: the oldest days hide behind the gutter on the right", () => {
		const scroller = fakeScroller("rtl", [
			{ left: 480, right: 580 },
			{ left: 380, right: 480 },
			{ left: 340, right: 440 },
			{ left: 100, right: 200 },
			{ left: 20, right: 120 },
		]);
		expect(countHiddenDays(scroller, GUTTER)).toEqual({ after: 1, before: 2 });
	});
});

describe("scrollWeekTo", () => {
	test("left to right scrolls to 0 and the full width", () => {
		const scroller = fakeScroller("ltr", []);
		scrollWeekTo(scroller, "after");
		expect(scroller.scrollLeft).toBe(900);
		scrollWeekTo(scroller, "before");
		expect(scroller.scrollLeft).toBe(0);
	});

	test("right to left scrolls to 0 and a negative full width", () => {
		const scroller = fakeScroller("rtl", []);
		scrollWeekTo(scroller, "after");
		expect(scroller.scrollLeft).toBe(-900);
		scrollWeekTo(scroller, "before");
		expect(scroller.scrollLeft).toBe(0);
	});
});
