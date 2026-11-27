import { describe, expect, test } from "bun:test";
import {
	fitUsageRings,
	MAX_RING_PLACES,
	RAIL_MIN_FREE,
	railFreeHeight,
	ringPlaces,
	SIDEBAR_MIN_LIST_HEIGHT,
	sidebarUsagePlacement,
} from "./usage-rail-fit.ts";

/** One place of the narrow rail: a 40px ring button and its 4px gap. */
const SLOT = 44;

function rings(count: number) {
	// The later a ring comes, the less it has left: ring 0 has 100, the last 0.
	return Array.from({ length: count }, (_, index) => ({
		id: `s${index}`,
		leftPercent: count === 1 ? 50 : 100 - (index * 100) / (count - 1),
	}));
}

function ids(list: readonly { id: string }[]) {
	return list.map((ring) => ring.id);
}

/** The layout a rail of `height` free pixels gives `count` sources. */
function layoutFor(count: number, height: number) {
	return fitUsageRings(rings(count), ringPlaces(height, SLOT));
}

describe("ring places from the free height", () => {
	test("one place at least, also with no height, a negative one or no slot", () => {
		expect(ringPlaces(0, SLOT)).toBe(1);
		expect(ringPlaces(-200, SLOT)).toBe(1);
		expect(ringPlaces(43, SLOT)).toBe(1);
		expect(ringPlaces(500, 0)).toBe(1);
		expect(ringPlaces(Number.NaN, SLOT)).toBe(1);
	});

	test("one place per whole slot, up to five", () => {
		expect(ringPlaces(44, SLOT)).toBe(1);
		expect(ringPlaces(88, SLOT)).toBe(2);
		expect(ringPlaces(131, SLOT)).toBe(2);
		expect(ringPlaces(132, SLOT)).toBe(3);
		expect(ringPlaces(220, SLOT)).toBe(5);
		expect(ringPlaces(4000, SLOT)).toBe(MAX_RING_PLACES);
		expect(ringPlaces(4000, SLOT, 3)).toBe(3);
	});

	test("the rail gives the roster its minimum and the free gap first", () => {
		// 400px of roster with no ring yet, a minimum roster of 160px.
		const free = railFreeHeight({
			minRoster: 160,
			renderedPlaces: 0,
			rosterHeight: 400,
			slot: SLOT,
		});
		expect(free).toBe(400 - 160 - RAIL_MIN_FREE);
		expect(ringPlaces(free, SLOT)).toBe(5);
		// The same rail after five rings took their height: the answer stays five.
		const settled = railFreeHeight({
			minRoster: 160,
			renderedPlaces: 5,
			rosterHeight: 400 - 5 * SLOT,
			slot: SLOT,
		});
		expect(settled).toBe(free);
	});
});

describe("which rings show and which go behind +N", () => {
	test("no source: nothing shows at any height", () => {
		for (const height of [0, 60, 150, 300, 2000]) {
			expect(layoutFor(0, height)).toEqual({ shown: [], more: [] });
		}
	});

	test("one source: its own ring at every height, never a +1 ring", () => {
		for (const height of [0, 60, 150, 300, 2000]) {
			const layout = layoutFor(1, height);
			expect(ids(layout.shown)).toEqual(["s0"]);
			expect(layout.more).toEqual([]);
		}
	});

	test("five sources: all in a tall rail, the fullest behind +N as it shrinks", () => {
		expect(ids(layoutFor(5, 2000).shown)).toEqual([
			"s0",
			"s1",
			"s2",
			"s3",
			"s4",
		]);
		expect(layoutFor(5, 2000).more).toEqual([]);
		// Four places: the three with the least left and a "+2" ring.
		const four = layoutFor(5, 4 * SLOT);
		expect(ids(four.shown)).toEqual(["s2", "s3", "s4"]);
		expect(ids(four.more)).toEqual(["s0", "s1"]);
		// Two places: the one with the least left and a "+4" ring.
		const two = layoutFor(5, 2 * SLOT);
		expect(ids(two.shown)).toEqual(["s4"]);
		expect(ids(two.more)).toEqual(["s0", "s1", "s2", "s3"]);
		// One place, or no height at all: the "+5" ring holds every source.
		for (const height of [SLOT, 10, 0]) {
			const one = layoutFor(5, height);
			expect(one.shown).toEqual([]);
			expect(ids(one.more)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
		}
	});

	test("six sources: four rings and +2 in a tall rail", () => {
		const tall = layoutFor(6, 2000);
		expect(ids(tall.shown)).toEqual(["s2", "s3", "s4", "s5"]);
		expect(ids(tall.more)).toEqual(["s0", "s1"]);
		const three = layoutFor(6, 3 * SLOT);
		expect(ids(three.shown)).toEqual(["s4", "s5"]);
		expect(ids(three.more)).toEqual(["s0", "s1", "s2", "s3"]);
		const one = layoutFor(6, 20);
		expect(one.shown).toEqual([]);
		expect(one.more).toHaveLength(6);
	});

	test("twelve sources: four rings and +8 at most, +12 in the shortest rail", () => {
		const tall = layoutFor(12, 2000);
		expect(ids(tall.shown)).toEqual(["s8", "s9", "s10", "s11"]);
		expect(tall.more).toHaveLength(8);
		const two = layoutFor(12, 2 * SLOT);
		expect(ids(two.shown)).toEqual(["s11"]);
		expect(two.more).toHaveLength(11);
		const one = layoutFor(12, 0);
		expect(one.shown).toEqual([]);
		expect(one.more).toHaveLength(12);
	});

	test("the +N ring never stands for one ring alone", () => {
		for (const count of [0, 1, 2, 5, 6, 12]) {
			for (let places = 0; places <= 6; places++) {
				const layout = fitUsageRings(rings(count), places);
				expect(layout.more.length).not.toBe(1);
				expect(layout.shown.length + layout.more.length).toBe(count);
				const taken = layout.shown.length + (layout.more.length > 0 ? 1 : 0);
				expect(taken).toBeLessThanOrEqual(Math.max(1, places));
			}
		}
	});

	test("kept rings stay in their order, and a ring with no number counts as full", () => {
		const mixed = [
			{ id: "a", leftPercent: 5 },
			{ id: "b", leftPercent: null },
			{ id: "c", leftPercent: 40 },
			{ id: "d", leftPercent: 5 },
		];
		const layout = fitUsageRings(mixed, 3);
		expect(ids(layout.shown)).toEqual(["a", "d"]);
		expect(ids(layout.more)).toEqual(["b", "c"]);
	});
});

describe("the full sidebar: a row, or one ring beside the account button", () => {
	const ROW = 44;

	test("a tall sidebar keeps the row", () => {
		expect(
			sidebarUsagePlacement({ listHeight: 600, rowHeight: ROW, rowShown: true })
		).toBe("row");
		expect(
			sidebarUsagePlacement({
				listHeight: 644,
				rowHeight: ROW,
				rowShown: false,
			})
		).toBe("row");
	});

	test("a short sidebar moves the rings to the footer", () => {
		expect(
			sidebarUsagePlacement({ listHeight: 200, rowHeight: ROW, rowShown: true })
		).toBe("footer");
		expect(
			sidebarUsagePlacement({
				listHeight: 244,
				rowHeight: ROW,
				rowShown: false,
			})
		).toBe("footer");
	});

	test("the answer is the same whichever of the two shows now", () => {
		for (let height = 150; height <= 400; height += 7) {
			const withRow = sidebarUsagePlacement({
				listHeight: height,
				rowHeight: ROW,
				rowShown: true,
			});
			const withoutRow = sidebarUsagePlacement({
				listHeight: height + ROW,
				rowHeight: ROW,
				rowShown: false,
			});
			expect(withRow).toBe(withoutRow);
		}
	});

	test("the row shows from exactly the minimum list height", () => {
		expect(
			sidebarUsagePlacement({
				listHeight: SIDEBAR_MIN_LIST_HEIGHT,
				rowHeight: ROW,
				rowShown: true,
			})
		).toBe("row");
		expect(
			sidebarUsagePlacement({
				listHeight: SIDEBAR_MIN_LIST_HEIGHT - 1,
				rowHeight: ROW,
				rowShown: true,
			})
		).toBe("footer");
	});
});
