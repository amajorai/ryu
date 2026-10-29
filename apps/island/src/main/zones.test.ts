import { describe, expect, it } from "bun:test";
import {
	computeZoneCells,
	nearestArea,
	nearestSnapZone,
	type Rect,
	zoneAnchorPosition,
	zoneIndexForPoint,
} from "./zones.ts";

// A 1920x1080 work area at the origin: each cell is 640x360.
const AREA: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

describe("computeZoneCells", () => {
	it("returns nine row-major cells tiling the area", () => {
		const cells = computeZoneCells(AREA);
		expect(cells).toHaveLength(9);
		expect(cells[0]).toEqual({ x: 0, y: 0, width: 640, height: 360 });
		// center
		expect(cells[4]).toEqual({ x: 640, y: 360, width: 640, height: 360 });
		// bottom-right
		expect(cells[8]).toEqual({ x: 1280, y: 720, width: 640, height: 360 });
	});

	it("offsets by the area origin (multi-display aware)", () => {
		const cells = computeZoneCells({
			x: 1920,
			y: 0,
			width: 1920,
			height: 1080,
		});
		expect(cells[0].x).toBe(1920);
	});
});

describe("zoneIndexForPoint", () => {
	it("maps points to their containing zone", () => {
		expect(zoneIndexForPoint(AREA, { x: 10, y: 10 })).toBe(0); // top-left
		expect(zoneIndexForPoint(AREA, { x: 960, y: 540 })).toBe(4); // center
		expect(zoneIndexForPoint(AREA, { x: 1900, y: 1070 })).toBe(8); // bottom-right
		expect(zoneIndexForPoint(AREA, { x: 960, y: 10 })).toBe(1); // top-center
	});

	it("clamps out-of-bounds points to the nearest edge zone", () => {
		expect(zoneIndexForPoint(AREA, { x: -500, y: -500 })).toBe(0);
		expect(zoneIndexForPoint(AREA, { x: 5000, y: 5000 })).toBe(8);
	});
});

describe("zoneAnchorPosition", () => {
	const W = 420;
	const H = 520;
	const M = 8;

	it("hugs corners inset by the margin", () => {
		expect(zoneAnchorPosition(AREA, 0, W, H, M)).toEqual({ x: 8, y: 8 });
		expect(zoneAnchorPosition(AREA, 8, W, H, M)).toEqual({
			x: 1920 - W - M,
			y: 1080 - H - M,
		});
	});

	it("centers edge and center zones along the free axis", () => {
		const topCenter = zoneAnchorPosition(AREA, 1, W, H, M);
		expect(topCenter).toEqual({ x: Math.round((1920 - W) / 2), y: 8 });

		const center = zoneAnchorPosition(AREA, 4, W, H, M);
		expect(center).toEqual({
			x: Math.round((1920 - W) / 2),
			y: Math.round((1080 - H) / 2),
		});
	});

	it("clamps so the window never lands offscreen on tiny displays", () => {
		const tiny: Rect = { x: 0, y: 0, width: 300, height: 300 };
		const pos = zoneAnchorPosition(tiny, 8, W, H, M);
		expect(pos.x).toBe(0);
		expect(pos.y).toBe(0);
	});
});

describe("nearestSnapZone", () => {
	// Pill 120x36, margin 8. Top-center (zone 1) anchor = (900, 8); its center is
	// (960, 26). Center (zone 4) anchor center is (960, 540).
	const PILL = { width: 120, height: 36 };
	const M = 8;
	const THRESHOLD = 140;

	it("snaps when the island center sits on a zone anchor", () => {
		const result = nearestSnapZone(AREA, { x: 960, y: 26 }, PILL, M, THRESHOLD);
		expect(result.index).toBe(1);
		expect(result.distance).toBeCloseTo(0, 5);
		expect(result.withinRange).toBe(true);
	});

	it("snaps just inside the threshold and is free just outside", () => {
		// 139px below the top-center anchor: inside the 140px radius.
		const inside = nearestSnapZone(
			AREA,
			{ x: 960, y: 26 + 139 },
			PILL,
			M,
			THRESHOLD
		);
		expect(inside.index).toBe(1);
		expect(inside.withinRange).toBe(true);

		// 200px below: nearest is still zone 1, but out of range -> free placement.
		const outside = nearestSnapZone(
			AREA,
			{ x: 960, y: 26 + 200 },
			PILL,
			M,
			THRESHOLD
		);
		expect(outside.index).toBe(1);
		expect(outside.withinRange).toBe(false);
	});

	it("leaves the dead center of the screen free (between all anchors)", () => {
		// Screen center (960, 540) is zone 4's anchor center, so that one snaps...
		const onCenter = nearestSnapZone(
			AREA,
			{ x: 960, y: 540 },
			PILL,
			M,
			THRESHOLD
		);
		expect(onCenter.index).toBe(4);
		expect(onCenter.withinRange).toBe(true);
		// ...but a point far from every anchor is free.
		const between = nearestSnapZone(
			AREA,
			{ x: 480, y: 300 },
			PILL,
			M,
			THRESHOLD
		);
		expect(between.withinRange).toBe(false);
	});
});

describe("nearestArea", () => {
	// The reported three-monitor layout: left, primary, right (each 2560 wide).
	const LEFT: Rect = { x: -2560, y: 0, width: 2560, height: 1392 };
	const PRIMARY: Rect = { x: 0, y: 0, width: 2560, height: 1392 };
	const RIGHT: Rect = { x: 2560, y: 0, width: 2560, height: 1392 };

	it("returns the area containing the point", () => {
		expect(nearestArea({ x: 100, y: 100 }, [LEFT, PRIMARY, RIGHT])).toBe(
			PRIMARY
		);
		expect(nearestArea({ x: -100, y: 100 }, [LEFT, PRIMARY, RIGHT])).toBe(LEFT);
	});

	it("falls back to the closest area for a point off all displays", () => {
		// Far above the primary: nearest by edge distance is the primary.
		expect(nearestArea({ x: 1280, y: -9999 }, [LEFT, PRIMARY, RIGHT])).toBe(
			PRIMARY
		);
	});
});
