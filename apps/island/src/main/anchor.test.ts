import { describe, expect, it } from "bun:test";
import {
	type IslandPlacement,
	placementForZone,
	TRANSLUCENT_WINDOW_INSET,
} from "../shared/placement.ts";
import {
	anchorForDrop,
	anchorOf,
	dockedAnchor,
	fitAnchor,
	groupRectInWindow,
	legacyAnchor,
	placeAtAnchor,
	RESTING_FOOTPRINT,
	rectAt,
	type Size,
	TRANSLUCENT_WINDOW_SIZE,
	windowOriginFor,
} from "./anchor.ts";
import type { Rect } from "./zones.ts";

// A typical laptop work area (1920x1080 minus a 40px taskbar).
const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
const MARGIN = 20;
const RESTING: Size = RESTING_FOOTPRINT;
const SUGGESTION: Size = { width: 348, height: 100 };
const PANEL: Size = { width: 400, height: 480 };

const right = (rect: Rect) => rect.x + rect.width;
const bottom = (rect: Rect) => rect.y + rect.height;

describe("anchorOf / rectAt", () => {
	it("are inverses for every placement", () => {
		const rect: Rect = { x: 300, y: 200, width: 144, height: 40 };
		for (let zone = 0; zone < 9; zone += 1) {
			const anchor = anchorOf(rect, placementForZone(zone));
			expect(rectAt(anchor, rect)).toEqual(rect);
		}
	});
});

describe("placeAtAnchor", () => {
	it("keeps a bottom-right dock's corner fixed while the island grows", () => {
		const anchor = dockedAnchor(AREA, placementForZone(8), RESTING, MARGIN);
		for (const size of [RESTING, SUGGESTION, PANEL]) {
			const rect = placeAtAnchor(anchor, size, AREA, MARGIN);
			expect(right(rect)).toBe(AREA.width - MARGIN);
			expect(bottom(rect)).toBe(AREA.height - MARGIN);
		}
	});

	it("grows a top-center dock symmetrically downward (classic island)", () => {
		const anchor = dockedAnchor(AREA, placementForZone(1), RESTING, MARGIN);
		const rest = placeAtAnchor(anchor, RESTING, AREA, MARGIN);
		const open = placeAtAnchor(anchor, PANEL, AREA, MARGIN);
		expect(open.y).toBe(rest.y);
		expect(open.x + open.width / 2).toBe(rest.x + rest.width / 2);
	});

	it("keeps a left-middle dock flush left and vertically centered", () => {
		const anchor = dockedAnchor(AREA, placementForZone(3), RESTING, MARGIN);
		const open = placeAtAnchor(anchor, PANEL, AREA, MARGIN);
		expect(open.x).toBe(MARGIN);
		expect(open.y + open.height / 2).toBe(AREA.height / 2);
	});

	it("shifts an overflowing footprint on-screen without moving the anchor", () => {
		// Free-placed near the right edge, pinned by its top-left corner.
		const anchor = anchorOf(
			{ x: 1700, y: 600, ...RESTING },
			placementForZone(0)
		);
		const open = placeAtAnchor(anchor, PANEL, AREA, MARGIN);
		expect(right(open)).toBe(AREA.width - MARGIN);
		expect(bottom(open)).toBe(AREA.height - MARGIN);
		// Shrinking back lands exactly where it started: no drift.
		expect(placeAtAnchor(anchor, RESTING, AREA, MARGIN)).toEqual({
			x: 1700,
			y: 600,
			...RESTING,
		});
	});

	it("returns to the exact dock after any chain of footprint changes", () => {
		for (let zone = 0; zone < 9; zone += 1) {
			const anchor = dockedAnchor(
				AREA,
				placementForZone(zone),
				RESTING,
				MARGIN
			);
			const before = placeAtAnchor(anchor, RESTING, AREA, MARGIN);
			for (const size of [SUGGESTION, PANEL, { width: 41, height: 41 }]) {
				placeAtAnchor(anchor, size, AREA, MARGIN);
			}
			expect(placeAtAnchor(anchor, RESTING, AREA, MARGIN)).toEqual(before);
		}
	});

	it("pins an oversized footprint to the top-left inset", () => {
		const tiny: Rect = { x: 0, y: 0, width: 300, height: 300 };
		const anchor = dockedAnchor(tiny, placementForZone(8), RESTING, MARGIN);
		const open = placeAtAnchor(anchor, PANEL, tiny, MARGIN);
		expect(open.x).toBe(MARGIN);
		expect(open.y).toBe(MARGIN);
	});
});

describe("anchorForDrop", () => {
	it("docks an expanded panel dropped on a corner so it collapses there", () => {
		const anchor = anchorForDrop(
			AREA,
			{ x: 1400, y: 500, ...PANEL },
			8,
			MARGIN
		);
		expect(anchor.placement).toEqual({ h: "end", v: "end" });
		const rest = placeAtAnchor(anchor, RESTING, AREA, MARGIN);
		expect(right(rest)).toBe(AREA.width - MARGIN);
		expect(bottom(rest)).toBe(AREA.height - MARGIN);
	});

	it("keeps a free drop in place and picks the placement from its zone", () => {
		const dropped: Rect = { x: 1500, y: 800, ...RESTING };
		const anchor = anchorForDrop(AREA, dropped, null, MARGIN);
		expect(anchor.placement).toEqual({ h: "end", v: "end" });
		expect(rectAt(anchor, RESTING)).toEqual(dropped);
		// The suggestion grows up and to the left, away from the corner.
		const grown = placeAtAnchor(anchor, SUGGESTION, AREA, MARGIN);
		expect(right(grown)).toBe(right(dropped));
		expect(bottom(grown)).toBe(bottom(dropped));
	});

	it("pulls a free drop hanging off the edge back onto the area", () => {
		const anchor = anchorForDrop(
			AREA,
			{ x: -60, y: 400, ...RESTING },
			null,
			MARGIN
		);
		expect(rectAt(anchor, RESTING).x).toBe(MARGIN);
		expect(anchor.placement.h).toBe("start");
	});
});

describe("translucent window alignment", () => {
	const inset = TRANSLUCENT_WINDOW_INSET;
	const windowSize = TRANSLUCENT_WINDOW_SIZE;

	it("round-trips window origin and group rect for every placement", () => {
		const rect: Rect = { x: 700, y: 300, ...SUGGESTION };
		for (let zone = 0; zone < 9; zone += 1) {
			const placement: IslandPlacement = placementForZone(zone);
			const origin = windowOriginFor(rect, placement, windowSize, inset);
			expect(
				groupRectInWindow(origin, windowSize, SUGGESTION, placement, inset)
			).toEqual(rect);
		}
	});

	it("keeps the window still while a docked footprint morphs", () => {
		const anchor = dockedAnchor(AREA, placementForZone(8), RESTING, MARGIN);
		const origins = [RESTING, SUGGESTION, PANEL].map((size) =>
			windowOriginFor(
				placeAtAnchor(anchor, size, AREA, MARGIN),
				anchor.placement,
				windowSize,
				inset
			)
		);
		expect(new Set(origins.map((o) => `${o.x},${o.y}`)).size).toBe(1);
	});

	it("never lifts a top-docked window above the work area", () => {
		const anchor = dockedAnchor(AREA, placementForZone(1), RESTING, 8);
		const origin = windowOriginFor(
			placeAtAnchor(anchor, PANEL, AREA, 8),
			anchor.placement,
			windowSize,
			inset
		);
		expect(origin.y).toBeGreaterThanOrEqual(AREA.y);
	});
});

describe("fitAnchor", () => {
	const LEFT: Rect = { x: -2560, y: 0, width: 2560, height: 1392 };
	const PRIMARY: Rect = { x: 0, y: 0, width: 2560, height: 1392 };
	const AREAS = [LEFT, PRIMARY];

	it("keeps an anchor whose resting island sits on a display", () => {
		const anchor = dockedAnchor(PRIMARY, placementForZone(8), RESTING, MARGIN);
		expect(fitAnchor(anchor, AREAS, MARGIN)).toBe(anchor);
	});

	it("re-docks an island straddling a monitor seam", () => {
		// Resting island centered on the seam at x=0, top row.
		const anchor = anchorOf({ x: -72, y: 8, ...RESTING }, placementForZone(1));
		const fitted = fitAnchor(anchor, AREAS, MARGIN);
		expect(fitted).not.toBe(anchor);
		const rest = rectAt(fitted, RESTING);
		const onOne = AREAS.some(
			(area) =>
				rest.x >= area.x &&
				right(rest) <= area.x + area.width &&
				rest.y >= area.y &&
				bottom(rest) <= area.y + area.height
		);
		expect(onOne).toBe(true);
		expect(fitted.placement).toEqual(anchor.placement);
	});

	it("re-docks to the same zone when its display is gone", () => {
		const anchor = dockedAnchor(
			{ x: 2560, y: 0, width: 2560, height: 1392 },
			placementForZone(2),
			RESTING,
			MARGIN
		);
		const fitted = fitAnchor(anchor, AREAS, MARGIN);
		expect(fitted).toEqual(
			dockedAnchor(PRIMARY, placementForZone(2), RESTING, MARGIN)
		);
	});
});

describe("legacyAnchor", () => {
	it("converts a stored translucent window origin at the bottom-right", () => {
		// Old builds centered the 144px island in the 600px window, 8px down.
		const islandX = AREA.width - MARGIN - RESTING.width;
		const islandY = AREA.height - MARGIN - RESTING.height;
		const anchor = legacyAnchor(
			{ x: islandX - (600 - 144) / 2, y: islandY - 8 },
			false,
			[AREA]
		);
		expect(anchor.placement).toEqual({ h: "end", v: "end" });
		expect(rectAt(anchor, RESTING)).toEqual({
			x: islandX,
			y: islandY,
			...RESTING,
		});
	});

	it("converts a stored material window origin", () => {
		const anchor = legacyAnchor({ x: 888, y: 20 }, true, [AREA]);
		expect(anchor.placement).toEqual({ h: "center", v: "start" });
		expect(rectAt(anchor, RESTING)).toEqual({ x: 888, y: 20, ...RESTING });
	});
});
