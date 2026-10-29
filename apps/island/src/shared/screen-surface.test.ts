import { describe, expect, test } from "bun:test";
import {
	SURFACE_MAX_WIDTH,
	screenSurfaceBounds,
	surfaceAnchor,
} from "./screen-surface.ts";

const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const topIsland = { x: 530, y: 30, width: 380, height: 48 };
const bottomIsland = { x: 530, y: 840, width: 380, height: 48 };

describe("screen surface placement", () => {
	test("sits below an Island docked at the top, centred on the display", () => {
		const bounds = screenSurfaceBounds(workArea, topIsland);
		expect(bounds.y).toBeGreaterThanOrEqual(topIsland.y + topIsland.height);
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(
			workArea.y + workArea.height
		);
		expect(bounds.x + bounds.width / 2).toBe(workArea.width / 2);
		expect(bounds.width).toBeGreaterThan(SURFACE_MAX_WIDTH);
		expect(surfaceAnchor(workArea, topIsland)).toBe("top");
	});

	test("sits above an Island docked at the bottom", () => {
		const bounds = screenSurfaceBounds(workArea, bottomIsland);
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(bottomIsland.y);
		expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
		expect(surfaceAnchor(workArea, bottomIsland)).toBe("bottom");
	});

	test("stays inside a small display instead of overflowing it", () => {
		const small = { x: 1440, y: 0, width: 500, height: 400 };
		const island = { x: 1500, y: 150, width: 380, height: 100 };
		const bounds = screenSurfaceBounds(small, island);
		expect(bounds.x).toBeGreaterThanOrEqual(small.x);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(small.x + small.width);
		expect(bounds.y).toBeGreaterThanOrEqual(small.y);
		expect(bounds.y + bounds.height).toBeLessThanOrEqual(
			small.y + small.height
		);
		expect(bounds.height).toBeGreaterThan(0);
	});
});
