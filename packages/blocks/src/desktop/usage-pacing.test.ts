import { describe, expect, test } from "bun:test";
import type { UsageWindowTarget } from "./monitor-types.ts";
import { estimateUsagePacing } from "./usage-pacing.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 25, 0, 0, 0);

function weeklyWindow(usedPercent: number): UsageWindowTarget {
	const resetsAt = NOW + 5 * DAY_MS;
	return {
		label: "Weekly",
		remainingPercent: 100 - usedPercent,
		resetsAt: new Date(resetsAt).toISOString(),
		scope: "account",
		targetId: "window:Weekly::604800",
		usedPercent,
		window: "7d",
		windowSeconds: (7 * DAY_MS) / 1000,
	};
}

describe("estimateUsagePacing", () => {
	test("projects quota exhaustion before the reset at the current average pace", () => {
		const estimate = estimateUsagePacing(weeklyWindow(51), NOW);

		expect(estimate.kind).toBe("before-reset");
		if (estimate.kind !== "before-reset") {
			return;
		}
		expect(estimate.resetsAt).toBe(NOW + 5 * DAY_MS);
		expect(
			Math.abs(estimate.limitAt - (NOW + (49 / 25.5) * DAY_MS))
		).toBeLessThan(1000);
	});

	test("projects the usage expected by reset when the limit should last", () => {
		const estimate = estimateUsagePacing(weeklyWindow(10), NOW);

		expect(estimate).toEqual({
			kind: "reset-first",
			projectedUseAtReset: 35,
			resetsAt: NOW + 5 * DAY_MS,
		});
	});

	test("does not invent a pace for an unused or newly started window", () => {
		expect(estimateUsagePacing(weeklyWindow(0), NOW)).toEqual({
			kind: "no-usage",
		});

		const justStarted = {
			...weeklyWindow(10),
			resetsAt: new Date(NOW + 7 * DAY_MS - 2 * 60 * 1000).toISOString(),
		};
		expect(estimateUsagePacing(justStarted, NOW)).toEqual({
			kind: "warming-up",
		});
	});

	test("requires a valid reported duration and future reset", () => {
		expect(
			estimateUsagePacing({ ...weeklyWindow(20), windowSeconds: null }, NOW)
		).toEqual({ kind: "unavailable" });
		expect(
			estimateUsagePacing({ ...weeklyWindow(20), resetsAt: null }, NOW)
		).toEqual({ kind: "unavailable" });
		expect(
			estimateUsagePacing(
				{ ...weeklyWindow(20), resetsAt: new Date(NOW).toISOString() },
				NOW
			)
		).toEqual({ kind: "unavailable" });
	});

	test("reports a full quota without extrapolating", () => {
		expect(estimateUsagePacing(weeklyWindow(100), NOW)).toEqual({
			kind: "at-limit",
		});
	});
});
