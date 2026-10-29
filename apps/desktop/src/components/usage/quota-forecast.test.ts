import { describe, expect, test } from "bun:test";
import type { SubscriptionUsageAccount } from "@/src/hooks/useSubscriptionUsage.ts";
import type { UsageWindow } from "@/src/lib/api/usage.ts";
import {
	forecastAccountQuota,
	forecastQuotaPool,
	formatTimeUntil,
	projectWindow,
} from "./quota-forecast.ts";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12);

/** A 10-hour window that started `elapsedHours` ago. */
function window(usedPercent: number, elapsedHours: number): UsageWindow {
	return {
		label: "Session",
		model: null,
		resetsAt: new Date(NOW + (10 - elapsedHours) * HOUR_MS).toISOString(),
		usedPercent,
		windowSeconds: 10 * 3600,
	};
}

function account(
	accountId: string,
	windows: UsageWindow[],
	available = true
): SubscriptionUsageAccount {
	return {
		accountId,
		accountLabel: accountId,
		active: false,
		category: "Claude",
		error: null,
		gatewayActive: false,
		kind: "oauth",
		loading: false,
		providerId: "anthropic",
		providerLabel: "Anthropic",
		snapshot: {
			agentId: "claude",
			available,
			engine: "claude",
			extraUsageUsd: null,
			meters: [],
			plan: "Max",
			reason: null,
			retryAfterSeconds: null,
			windows,
		},
	};
}

describe("projectWindow", () => {
	test("projects remaining headroom at reset from the window's average pace", () => {
		// 20% in 5h → 40% by the 10h reset → 60% left.
		const projection = projectWindow(window(20, 5), NOW);
		expect(projection.estimate.kind).toBe("reset-first");
		expect(projection.remainingAtReset).toBeCloseTo(60, 5);
	});

	test("reports no headroom when the pace exhausts the window early", () => {
		const projection = projectWindow(window(80, 5), NOW);
		expect(projection.estimate.kind).toBe("before-reset");
		expect(projection.remainingAtReset).toBe(0);
	});

	test("keeps windows without timing data out of the projection", () => {
		expect(
			projectWindow({ ...window(30, 5), windowSeconds: null }, NOW)
				.remainingAtReset
		).toBeNull();
	});
});

describe("forecastAccountQuota", () => {
	test("uses the tightest window and the earliest limit", () => {
		const forecast = forecastAccountQuota(
			account("a", [window(20, 5), window(80, 5)]),
			NOW
		);
		expect(forecast?.remainingAtReset).toBe(0);
		expect(forecast?.remainingNow).toBe(20);
		// 80% in 5h → 16%/h → the last 20% in 1h15m.
		expect(forecast?.limitAt).toBe(NOW + 1.25 * HOUR_MS);
		expect(forecast?.atLimit).toBe(false);
	});

	test("returns null for unavailable or unforecastable accounts", () => {
		expect(
			forecastAccountQuota(account("a", [window(20, 5)], false))
		).toBeNull();
		expect(forecastAccountQuota(account("a", []))).toBeNull();
	});
});

describe("forecastQuotaPool", () => {
	test("averages headroom across accounts and counts accounts at risk", () => {
		const pool = forecastQuotaPool(
			[
				account("light", [window(20, 5)]),
				account("heavy", [window(80, 5)]),
				account("done", [window(100, 5)]),
				account("offline", [window(10, 5)], false),
			],
			NOW
		);
		expect(pool.forecastable).toBe(3);
		expect(pool.atRisk).toBe(2);
		expect(pool.remainingNow).toBeCloseTo((80 + 20 + 0) / 3, 5);
		expect(pool.remainingAtReset).toBeCloseTo(60 / 3, 5);
	});

	test("has no headroom figures without forecastable accounts", () => {
		expect(forecastQuotaPool([], NOW)).toEqual({
			atRisk: 0,
			forecastable: 0,
			remainingAtReset: null,
			remainingNow: null,
		});
	});
});

test("formats the time until a projected limit", () => {
	expect(formatTimeUntil(NOW + 45 * 60_000, NOW)).toBe("45m");
	expect(formatTimeUntil(NOW + 1.25 * HOUR_MS, NOW)).toBe("1h 15m");
	expect(formatTimeUntil(NOW + 3 * HOUR_MS, NOW)).toBe("3h");
	expect(formatTimeUntil(NOW + 52 * HOUR_MS, NOW)).toBe("2d 4h");
	expect(formatTimeUntil(NOW - HOUR_MS, NOW)).toBe("1m");
});
