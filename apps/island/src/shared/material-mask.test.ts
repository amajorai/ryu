import { expect, test } from "bun:test";
import {
	materialMaskBitmap,
	materialMaskRects,
	normalizeMaterialMask,
} from "./material-mask.ts";

const split = normalizeMaterialMask(144, 40, [
	{ x: 0, y: 0, width: 40, height: 40, radius: 20 },
	{ x: 48, y: 0, width: 96, height: 40, radius: 20 },
]);

test("native masks keep the left logo and detail separate", () => {
	expect(split).not.toBeNull();
	if (!split) {
		return;
	}
	const bitmap = materialMaskBitmap(split);
	const alphaAt = (x: number, y: number) =>
		bitmap[(y * split.width + x) * 4 + 3];
	expect(alphaAt(20, 20)).toBe(255);
	expect(alphaAt(96, 20)).toBe(255);
	expect(alphaAt(44, 20)).toBe(0);
	expect(alphaAt(0, 0)).toBe(0);
});

test("Windows region contains rounded shapes but not their gap", () => {
	expect(split).not.toBeNull();
	if (!split) {
		return;
	}
	const rects = materialMaskRects(split);
	const contains = (x: number, y: number) =>
		rects.some(
			(rect) =>
				x >= rect.x &&
				x < rect.x + rect.width &&
				y >= rect.y &&
				y < rect.y + rect.height
		);
	expect(contains(20, 20)).toBe(true);
	expect(contains(96, 20)).toBe(true);
	expect(contains(44, 20)).toBe(false);
	expect(contains(0, 0)).toBe(false);
	expect(rects.length).toBeLessThan(100);
});

test("native geometry rejects oversized and out-of-window masks", () => {
	expect(normalizeMaterialMask(5000, 40, split?.shapes ?? [])).toBeNull();
	expect(
		normalizeMaterialMask(40, 40, [
			{ x: 20, y: 0, width: 40, height: 40, radius: 20 },
		])
	).toBeNull();
});
