import { describe, expect, it } from "bun:test";
import {
	computeZoneCells,
	crossDisplayPosition,
	fitVisibleIsland,
	nearestArea,
	nearestSnapZone,
	type PillRect,
	type Rect,
	type VisibleIsland,
	zoneAnchorPosition,
	zoneIndexForPoint,
	zoneWindowPosition,
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

describe("zoneWindowPosition", () => {
	const M = 12;
	// A small pill floating at the top-center of a 420x520 window: offsetX =
	// (420 - 120) / 2 = 150, offsetY = 8 (top inset).
	const PILL: PillRect = { offsetX: 150, offsetY: 8, width: 120, height: 36 };

	it("offsets the window so the pill (not the window) hugs the top-left", () => {
		const pos = zoneWindowPosition(AREA, 0, PILL, M);
		// Pill target = (margin, margin) = (12, 12); window = pill - offset.
		expect(pos).toEqual({ x: 12 - 150, y: 12 - 8 });
	});

	it("lands the pill flush in the top-right corner", () => {
		const pos = zoneWindowPosition(AREA, 2, PILL, M);
		// Pill left target = 1920 - 120 - 12 = 1788; window x = 1788 - 150.
		expect(pos.x).toBe(1788 - 150);
		expect(pos.y).toBe(12 - 8);
	});

	it("centers the pill for the center zone", () => {
		const pos = zoneWindowPosition(AREA, 4, PILL, M);
		const pillX = Math.round((1920 - 120) / 2);
		const pillY = Math.round((1080 - 36) / 2);
		expect(pos).toEqual({ x: pillX - 150, y: pillY - 8 });
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

describe("crossDisplayPosition", () => {
	// Two side-by-side 1920x1080 monitors, the primary at the origin and the
	// secondary to its right. The auto-jump feature moves the island between them
	// while keeping it in the same zone.
	const PRIMARY: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
	const SECONDARY: Rect = { x: 1920, y: 0, width: 1920, height: 1080 };
	// Resting translucent pill: 144 wide / 40 tall, centered in the 420 window,
	// 8px below the top.
	const PILL: PillRect = {
		offsetX: (420 - 144) / 2,
		offsetY: 8,
		width: 144,
		height: 40,
	};
	const M = 20;

	it("preserves the top-center zone across the seam", () => {
		// Island resting top-center of the primary: pill center near (960, 28).
		const center = { x: 960, y: 28 };
		const pos = crossDisplayPosition(PRIMARY, SECONDARY, center, PILL, M);
		// Same as snapping zone 1 (top-center) directly on the secondary display.
		expect(pos).toEqual(zoneWindowPosition(SECONDARY, 1, PILL, M));
		// And it lands on the secondary display (x shifted right by ~1920).
		expect(pos.x).toBeGreaterThanOrEqual(SECONDARY.x);
	});

	it("preserves a corner zone across the seam", () => {
		// Island center in the bottom-right zone of the primary.
		const center = { x: 1900, y: 1060 };
		const pos = crossDisplayPosition(PRIMARY, SECONDARY, center, PILL, M);
		expect(pos).toEqual(zoneWindowPosition(SECONDARY, 8, PILL, M));
	});

	it("jumps from the secondary back to the primary, same zone", () => {
		// Island center in the top-center zone of the secondary display.
		const center = { x: 1920 + 960, y: 28 };
		const pos = crossDisplayPosition(SECONDARY, PRIMARY, center, PILL, M);
		expect(pos).toEqual(zoneWindowPosition(PRIMARY, 1, PILL, M));
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

describe("fitVisibleIsland", () => {
	const LEFT: Rect = { x: -2560, y: 0, width: 2560, height: 1392 };
	const PRIMARY: Rect = { x: 0, y: 0, width: 2560, height: 1392 };
	const AREAS = [LEFT, PRIMARY];
	// The resting translucent island: 144 (+ 16 pad) wide, 40 tall, centered in
	// the 420px window, pinned 8px below the top.
	const RESTING: VisibleIsland = {
		windowWidth: 420,
		width: 144 + 16,
		height: 40,
		topInset: 8,
	};
	const TOP_MARGIN = 8;

	it("re-homes the reported seam-straddle position (x=-242)", () => {
		// The bug: window x=-242 puts the island center at -32, across the seam
		// between the left and primary displays -- a point test passes, but the
		// box straddles, so it must re-home. The island center (-32) sits on the
		// left display, so it re-homes to that display's top-center (fully
		// visible there), not stranded across the bezel gap.
		const pos = fitVisibleIsland({ x: -242, y: 4 }, RESTING, TOP_MARGIN, AREAS);
		expect(pos).toEqual({
			x: Math.round(LEFT.x + (LEFT.width - RESTING.windowWidth) / 2),
			y: TOP_MARGIN,
		});
	});

	it("keeps a position whose island sits wholly on one display", () => {
		// Window centered on the primary: island box is well inside it.
		const pos = fitVisibleIsland(
			{ x: 1000, y: 50 },
			RESTING,
			TOP_MARGIN,
			AREAS
		);
		expect(pos).toEqual({ x: 1000, y: 50 });
	});

	it("keeps an edge snap where only the transparent window overflows", () => {
		// Island hugging the left edge of the primary (inset ~12): the 420px
		// window overflows past x=0, but the 144px island box stays on-screen.
		const islandLeft = 12;
		const winX = islandLeft - (RESTING.windowWidth - RESTING.width) / 2;
		const pos = fitVisibleIsland({ x: winX, y: 8 }, RESTING, TOP_MARGIN, AREAS);
		expect(pos).toEqual({ x: Math.round(winX), y: 8 });
	});

	it("re-homes a window stranded entirely off every display", () => {
		const pos = fitVisibleIsland(
			{ x: 99_999, y: 99_999 },
			RESTING,
			TOP_MARGIN,
			AREAS
		);
		// Nearest display to the far point is the primary (its right/bottom edge).
		expect(pos).toEqual({
			x: Math.round((PRIMARY.width - RESTING.windowWidth) / 2),
			y: TOP_MARGIN,
		});
	});
});
