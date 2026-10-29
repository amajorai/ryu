import { describe, expect, it } from "bun:test";
import { goalGradient } from "./goal-gradient.ts";

describe("goalGradient", () => {
	it("finds the next goal and keeps progress moving toward it", () => {
		expect(goalGradient(2, [1, 3, 5])).toEqual({
			complete: false,
			current: 2,
			nearGoal: true,
			progressPercent: 67,
			remaining: 1,
			target: 3,
		});
	});

	it("handles unsorted goals without changing the result", () => {
		expect(goalGradient(4, [10, 3, 5])).toMatchObject({
			current: 4,
			progressPercent: 80,
			remaining: 1,
			target: 5,
		});
	});

	it("marks the ladder complete after the final goal", () => {
		expect(goalGradient(10, [1, 3, 5, 10])).toEqual({
			complete: true,
			current: 10,
			nearGoal: false,
			progressPercent: 100,
			remaining: 0,
			target: null,
		});
	});

	it("clamps invalid counts before calculating progress", () => {
		expect(goalGradient(Number.NaN, [1, 3])).toMatchObject({
			current: 0,
			progressPercent: 0,
			remaining: 1,
			target: 1,
		});
		expect(goalGradient(-2.5, [1, 3]).current).toBe(0);
	});
});
