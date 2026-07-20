import { describe, expect, it } from "bun:test";
import {
	naturalFootprintRect,
	placeFootprint,
	topCenteredBounds,
} from "./zones.ts";

describe("topCenteredBounds", () => {
	it("keeps the top edge fixed while resizing", () => {
		const bounds = topCenteredBounds(100, 144, 50, 400, 480);
		expect(bounds.y).toBe(50);
		expect(bounds.height).toBe(480);
		expect(bounds.width).toBe(400);
	});

	it("grows symmetrically about the horizontal center", () => {
		// center of the old window: 100 + 144/2 = 172
		const bounds = topCenteredBounds(100, 144, 0, 400, 480);
		// new x so the new center is still 172: 172 - 400/2 = -28
		expect(bounds.x).toBe(-28);
		expect(bounds.x + bounds.width / 2).toBe(172);
	});

	it("shrinks about the same center", () => {
		// center: 100 + 400/2 = 300
		const bounds = topCenteredBounds(100, 400, 8, 144, 44);
		// new x: 300 - 144/2 = 228
		expect(bounds.x).toBe(228);
		expect(bounds.x + bounds.width / 2).toBe(300);
	});

	it("rounds fractional results to whole pixels", () => {
		const bounds = topCenteredBounds(0, 41, 0, 41, 41);
		expect(Number.isInteger(bounds.x)).toBe(true);
		expect(Number.isInteger(bounds.width)).toBe(true);
	});
});

describe("placeFootprint", () => {
	// A typical laptop work area (1920x1080 minus a 40px taskbar). The resting pill
	// is 144x44; the expanded panel is 400x480; a suggestion footprint is the chip
	// (300) plus the logo circle (40) and gap (8) = 348 wide.
	const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
	const PANEL = { width: 400, height: 480 };
	const SUGGESTION = { width: 348, height: 100 };
	const MARGIN = 8;

	it("matches a top-centered expand for an island resting at top-center", () => {
		// Resting pill centered horizontally, pinned near the top: this is the
		// common case and must be a no-op vs. the existing top-centered behavior.
		const pill = { x: 888, y: 8, width: 144, height: 44 };
		const rect = placeFootprint(pill, PANEL, AREA, MARGIN);
		const legacy = topCenteredBounds(
			pill.x,
			pill.width,
			pill.y,
			PANEL.width,
			PANEL.height
		);
		expect(rect).toEqual(legacy);
		expect(rect.x).toBe(760);
		expect(rect.y).toBe(8);
	});

	it("is a pixel-exact no-op when the footprint already fits", () => {
		// A suggestion that opens while the island rests at top-center has room on
		// both sides, so nothing should move — guards against jitter on every
		// active-app label or suggestion change for the (common) centered dock.
		const pill = { x: 888, y: 8, width: 144, height: 44 };
		const rect = placeFootprint(pill, SUGGESTION, AREA, MARGIN);
		expect(rect).toEqual(naturalFootprintRect(pill, SUGGESTION));
	});

	it("pulls a right-edge suggestion back on-screen", () => {
		// The long detail island splits rightward from a right-docked pill; its
		// footprint must be shifted left to stay visible.
		const pill = { x: 1768, y: 8, width: 144, height: 44 };
		const natural = naturalFootprintRect(pill, SUGGESTION);
		const rect = placeFootprint(pill, SUGGESTION, AREA, MARGIN);
		expect(natural.x + natural.width).toBeGreaterThan(AREA.x + AREA.width); // would overflow
		expect(rect.x).toBeLessThan(natural.x); // shifted left
		expect(rect.x + rect.width).toBeLessThanOrEqual(
			AREA.x + AREA.width - MARGIN
		);
	});

	it("grows upward when the island rests in the bottom half", () => {
		// Pill docked at the bottom edge: the panel is pulled up, not off-screen.
		const pill = { x: 888, y: 988, width: 144, height: 44 };
		const rect = placeFootprint(pill, PANEL, AREA, MARGIN);
		// Bottom of the panel aligns to the bottom inset (1040 - 480 - 8).
		expect(rect.y).toBe(552);
		expect(rect.y).toBeGreaterThanOrEqual(AREA.y + MARGIN);
		expect(rect.y + rect.height).toBeLessThanOrEqual(
			AREA.y + AREA.height - MARGIN
		);
	});

	it("clamps horizontally and pulls up at a bottom-right corner", () => {
		const pill = { x: 1768, y: 988, width: 144, height: 44 };
		const rect = placeFootprint(pill, PANEL, AREA, MARGIN);
		// x is pulled left so the panel's right edge stays inside the work area.
		expect(rect.x).toBe(1512);
		expect(rect.x + rect.width).toBeLessThanOrEqual(
			AREA.x + AREA.width - MARGIN
		);
		expect(rect.y).toBe(552);
	});

	it("clamps horizontally at the left edge without going negative", () => {
		const pill = { x: 8, y: 8, width: 144, height: 44 };
		const rect = placeFootprint(pill, PANEL, AREA, MARGIN);
		expect(rect.x).toBe(MARGIN);
		expect(rect.x).toBeGreaterThanOrEqual(AREA.x);
	});

	it("degrades gracefully when the panel is taller than the work area", () => {
		const shortArea = { x: 0, y: 0, width: 1920, height: 400 };
		const pill = { x: 888, y: 348, width: 144, height: 44 };
		const rect = placeFootprint(pill, PANEL, shortArea, MARGIN);
		// No negative origin; clamps to the top inset.
		expect(rect.y).toBe(MARGIN);
		expect(rect.x).toBeGreaterThanOrEqual(shortArea.x);
		expect(Number.isInteger(rect.x)).toBe(true);
		expect(Number.isInteger(rect.y)).toBe(true);
	});
});
