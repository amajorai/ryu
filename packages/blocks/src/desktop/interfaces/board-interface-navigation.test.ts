// Lane snapping under dir="rtl": the board's lanes overflow to the physical
// left and scrollLeft runs from 0 down to negative values.
import "./board-test-dom.ts";
import { describe, expect, test } from "bun:test";
import { BOARD_LANE_ATTRIBUTE } from "./board-column.tsx";
import {
	laneOverflow,
	revealCard,
	stepLanes,
} from "./board-interface-navigation.ts";

const LANE = 250;

function rect(left: number, right: number): DOMRect {
	return {
		bottom: 100,
		height: 100,
		left,
		right,
		toJSON: () => ({}),
		top: 0,
		width: right - left,
		x: left,
		y: 0,
	};
}

/**
 * A 300px board over four 250px lanes. `scrolled` is the logical offset from
 * the inline start; lanes are laid out from the right edge under RTL.
 */
function board(direction: "ltr" | "rtl", scrolled: number) {
	const sign = direction === "rtl" ? -1 : 1;
	const element = document.createElement("div");
	element.style.direction = direction;
	const calls: ScrollToOptions[] = [];
	Object.defineProperties(element, {
		clientWidth: { configurable: true, value: 300 },
		scrollLeft: { configurable: true, value: scrolled * sign },
		scrollWidth: { configurable: true, value: 1000 },
	});
	element.getBoundingClientRect = () => rect(0, 300);
	element.scrollTo = ((options: ScrollToOptions) => {
		calls.push(options);
	}) as typeof element.scrollTo;
	const lanes = [0, 1, 2, 3].map((index) => {
		const lane = document.createElement("section");
		lane.setAttribute(BOARD_LANE_ATTRIBUTE, "");
		const start = index * LANE - scrolled;
		lane.getBoundingClientRect = () =>
			sign === 1
				? rect(start, start + LANE)
				: rect(300 - start - LANE, 300 - start);
		element.append(lane);
		return lane;
	});
	document.body.append(element);
	return { calls, element, lanes };
}

describe("board lanes", () => {
	test("LTR steps to the next lane boundary", () => {
		const { calls, element } = board("ltr", 0);
		expect(laneOverflow(element)).toEqual({ end: 3, start: 0 });
		stepLanes(element, true);
		expect(calls).toEqual([{ left: 234 }]);
	});

	test("RTL counts the hidden lanes on the inline end and steps toward them", () => {
		const { calls, element } = board("rtl", 0);
		expect(laneOverflow(element)).toEqual({ end: 3, start: 0 });
		stepLanes(element, true);
		expect(calls).toEqual([{ left: -234 }]);
	});

	test("RTL steps back toward the inline start", () => {
		const { calls, element } = board("rtl", 484);
		expect(laneOverflow(element).start).toBeGreaterThan(0);
		stepLanes(element, false);
		expect(calls).toEqual([{ left: -234 }]);
	});

	test("RTL reveals a lane past the inline end", () => {
		const { calls, element, lanes } = board("rtl", 0);
		const card = document.createElement("div");
		lanes[2]?.append(card);
		card.getBoundingClientRect = () => rect(-450, -200);
		revealCard(element, card);
		expect(calls).toEqual([{ left: -484 }]);
	});
});
