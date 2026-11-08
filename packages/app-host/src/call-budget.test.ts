import { describe, expect, test } from "bun:test";
import { createCallBudget, MAX_IN_FLIGHT_CALLS } from "./call-budget.ts";

describe("createCallBudget", () => {
	test("refuses calls past the limit until one is released", () => {
		const budget = createCallBudget(2);
		expect(budget.tryAcquireCall()).toBe(true);
		expect(budget.tryAcquireCall()).toBe(true);
		expect(budget.tryAcquireCall()).toBe(false);
		budget.releaseCall();
		expect(budget.tryAcquireCall()).toBe(true);
	});

	test("an extra release never raises the limit", () => {
		const budget = createCallBudget(1);
		budget.releaseCall();
		budget.releaseCall();
		expect(budget.tryAcquireCall()).toBe(true);
		expect(budget.tryAcquireCall()).toBe(false);
	});

	test("defaults to the shared per-frame budget", () => {
		const budget = createCallBudget();
		let granted = 0;
		while (budget.tryAcquireCall()) {
			granted += 1;
		}
		expect(granted).toBe(MAX_IN_FLIGHT_CALLS);
	});
});
