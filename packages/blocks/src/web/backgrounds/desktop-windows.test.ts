import { describe, expect, test } from "bun:test";

import { FOCUSABLE, FRAMES } from "./desktop-windows.tsx";

describe("desktop windows backdrop", () => {
	test("every window starts inside the stage", () => {
		for (const frame of FRAMES) {
			expect(frame.x).toBeGreaterThanOrEqual(0);
			expect(frame.y).toBeGreaterThanOrEqual(0);
			expect(frame.x + frame.w).toBeLessThanOrEqual(1);
			expect(frame.y + frame.h).toBeLessThanOrEqual(1);
			expect(frame.depth).toBeGreaterThan(0);
			expect(frame.depth).toBeLessThanOrEqual(1);
		}
	});

	test("focus only passes between near windows, clear of the centred copy", () => {
		expect(FOCUSABLE.length).toBeGreaterThan(1);
		for (const index of FOCUSABLE) {
			const frame = FRAMES[index];
			if (!frame) {
				throw new Error(`missing frame ${index}`);
			}
			expect(frame.depth).toBeGreaterThanOrEqual(0.6);
			const leftOfCopy = frame.x + frame.w <= 0.3;
			const rightOfCopy = frame.x >= 0.7;
			expect(leftOfCopy || rightOfCopy).toBe(true);
		}
	});
});
