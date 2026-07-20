import { describe, expect, it } from "bun:test";
import {
	clampFootprint,
	EDGE_MARGIN_PX,
	nearestSnapZone,
	type Pill,
	type Rect,
	SNAP_THRESHOLD_PX,
	zoneAnchorPosition,
} from "./island-snap.ts";

// A 1280x800 viewport at the origin.
const AREA: Rect = { x: 0, y: 0, width: 1280, height: 800 };
// The resting island footprint: logo(40) + gap(8) + idle pill(96) = 144 wide, 40 tall.
const PILL: Pill = { width: 144, height: 40 };
const M = EDGE_MARGIN_PX;

describe("zoneAnchorPosition", () => {
	it("hugs the corners inset by the margin", () => {
		// 0 = top-left
		expect(zoneAnchorPosition(AREA, 0, PILL.width, PILL.height, M)).toEqual({
			x: M,
			y: M,
		});
		// 2 = top-right
		expect(zoneAnchorPosition(AREA, 2, PILL.width, PILL.height, M)).toEqual({
			x: AREA.width - PILL.width - M,
			y: M,
		});
		// 8 = bottom-right
		expect(zoneAnchorPosition(AREA, 8, PILL.width, PILL.height, M)).toEqual({
			x: AREA.width - PILL.width - M,
			y: AREA.height - PILL.height - M,
		});
	});

	it("centers the edge and center zones", () => {
		// 4 = center
		expect(zoneAnchorPosition(AREA, 4, PILL.width, PILL.height, M)).toEqual({
			x: Math.round((AREA.width - PILL.width) / 2),
			y: Math.round((AREA.height - PILL.height) / 2),
		});
		// 1 = top-center: centered on x, hugging the top on y
		const top = zoneAnchorPosition(AREA, 1, PILL.width, PILL.height, M);
		expect(top.x).toBe(Math.round((AREA.width - PILL.width) / 2));
		expect(top.y).toBe(M);
	});
});

describe("nearestSnapZone", () => {
	it("snaps to the top-left zone when dropped near it", () => {
		const result = nearestSnapZone(
			AREA,
			{ x: 60, y: 50 },
			PILL,
			M,
			SNAP_THRESHOLD_PX
		);
		expect(result.index).toBe(0);
		expect(result.withinRange).toBe(true);
	});

	it("picks the center zone for a center drop", () => {
		const result = nearestSnapZone(
			AREA,
			{ x: AREA.width / 2, y: AREA.height / 2 },
			PILL,
			M,
			SNAP_THRESHOLD_PX
		);
		expect(result.index).toBe(4);
		expect(result.withinRange).toBe(true);
	});

	it("stays free (out of range) when dropped between zones", () => {
		// A point far from every anchor center (mid-way on x, well below top row,
		// well above the bottom/center rows).
		const result = nearestSnapZone(
			AREA,
			{ x: 360, y: 240 },
			PILL,
			M,
			SNAP_THRESHOLD_PX
		);
		expect(result.withinRange).toBe(false);
	});

	it("returns a valid 0-8 index for any drop", () => {
		for (let i = 0; i < 9; i++) {
			const anchor = zoneAnchorPosition(AREA, i, PILL.width, PILL.height, M);
			const center = {
				x: anchor.x + PILL.width / 2,
				y: anchor.y + PILL.height / 2,
			};
			const result = nearestSnapZone(AREA, center, PILL, M, SNAP_THRESHOLD_PX);
			expect(result.index).toBe(i);
			expect(result.distance).toBeCloseTo(0);
		}
	});
});

describe("clampFootprint", () => {
	it("pulls an expanded panel inward from the right/bottom edge", () => {
		const content: Pill = { width: 448, height: 480 };
		// Dropped hard against the bottom-right corner.
		const placed = clampFootprint(
			{ x: AREA.width - 10, y: AREA.height - 10 },
			content,
			AREA,
			M
		);
		expect(placed.x).toBe(AREA.width - content.width - M);
		expect(placed.y).toBe(AREA.height - content.height - M);
	});

	it("leaves an on-screen footprint untouched", () => {
		const content: Pill = { width: 200, height: 120 };
		const placed = clampFootprint({ x: 400, y: 300 }, content, AREA, M);
		expect(placed).toEqual({ x: 400, y: 300 });
	});
});
