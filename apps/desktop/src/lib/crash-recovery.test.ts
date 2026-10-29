// Tests for the CrashBoundary retry policy.
//
// The budget is the whole safety property here — an unbounded retry against a
// render loop spins forever — so these tests are written against the failure
// modes, not the happy path: budget exhaustion, the dev kill switch, and the two
// ways an episode can be wrongly refunded.

import { describe, expect, test } from "bun:test";
import {
	episodeDidRecover,
	MAX_AUTO_RETRIES,
	planRecovery,
	RETRY_BACKOFF_MS,
	type RecoveryEpisode,
	recordManualRetry,
	resetKeysChanged,
	STABLE_RENDER_MS,
} from "./crash-recovery.ts";

interface PlanOptions {
	autoRetryEnabled: boolean;
	routeKey: string | null;
}

const ROUTE = "/chat";
const ENABLED: PlanOptions = { autoRetryEnabled: true, routeKey: ROUTE };

/** Drive `count` consecutive crashes through the planner, as the boundary does. */
function crashRepeatedly(count: number, options: PlanOptions = ENABLED) {
	let episode: RecoveryEpisode | null = null;
	const plans: ReturnType<typeof planRecovery>[] = [];
	for (let i = 0; i < count; i++) {
		const plan = planRecovery(episode, options);
		plans.push(plan);
		episode = plan.episode;
	}
	return { episode, plans };
}

describe("planRecovery budget", () => {
	test("retries up to MAX_AUTO_RETRIES then goes terminal", () => {
		const { plans } = crashRepeatedly(MAX_AUTO_RETRIES + 1);

		for (let i = 0; i < MAX_AUTO_RETRIES; i++) {
			expect(plans[i]?.decision).toEqual({
				kind: "retry",
				attempt: i + 1,
				delayMs: RETRY_BACKOFF_MS[i],
			});
		}
		expect(plans.at(-1)?.decision).toEqual({
			kind: "terminal",
			reason: "budget-exhausted",
		});
	});

	test("stays terminal forever once exhausted — never re-arms itself", () => {
		const { episode } = crashRepeatedly(MAX_AUTO_RETRIES);
		// Ten more crashes on the same route must not produce a single retry.
		let current = episode;
		for (let i = 0; i < 10; i++) {
			const plan = planRecovery(current, ENABLED);
			expect(plan.decision.kind).toBe("terminal");
			current = plan.episode;
		}
		expect(current?.autoRetries).toBe(MAX_AUTO_RETRIES);
	});

	test("backoff grows across attempts and stays short overall", () => {
		expect(RETRY_BACKOFF_MS.length).toBe(MAX_AUTO_RETRIES);
		const total = RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0);
		// The worst case (all retries spent, then the terminal screen) must feel
		// like a hitch, not a hang.
		expect(total).toBeLessThanOrEqual(3000);
		for (let i = 1; i < RETRY_BACKOFF_MS.length; i++) {
			expect(RETRY_BACKOFF_MS[i]).toBeGreaterThan(RETRY_BACKOFF_MS[i - 1]);
		}
	});
});

describe("planRecovery gates", () => {
	test("auto-retry disabled goes straight to terminal without spending budget", () => {
		const plan = planRecovery(null, {
			autoRetryEnabled: false,
			routeKey: ROUTE,
		});
		expect(plan.decision).toEqual({
			kind: "terminal",
			reason: "auto-retry-disabled",
		});
		expect(plan.episode.autoRetries).toBe(0);
	});

	test("a crash on a different route gets a fresh budget", () => {
		const { episode } = crashRepeatedly(MAX_AUTO_RETRIES);
		expect(planRecovery(episode, ENABLED).decision.kind).toBe("terminal");

		const elsewhere = planRecovery(episode, {
			autoRetryEnabled: true,
			routeKey: "/settings",
		});
		expect(elsewhere.decision).toEqual({
			kind: "retry",
			attempt: 1,
			delayMs: RETRY_BACKOFF_MS[0],
		});
		expect(elsewhere.episode.routeKey).toBe("/settings");
	});

	test("a null route is a route: it still accumulates its own budget", () => {
		const options = { autoRetryEnabled: true, routeKey: null };
		const { plans } = crashRepeatedly(MAX_AUTO_RETRIES + 1, options);
		expect(plans[0]?.decision.kind).toBe("retry");
		expect(plans.at(-1)?.decision.kind).toBe("terminal");
	});
});

describe("recordManualRetry", () => {
	test("refunds the auto budget but is still counted", () => {
		const { episode } = crashRepeatedly(MAX_AUTO_RETRIES);
		const manual = recordManualRetry(episode, ROUTE);

		expect(manual.autoRetries).toBe(0);
		expect(manual.manualRetries).toBe(1);
		// Refunded, so the next crash may auto-retry again.
		expect(planRecovery(manual, ENABLED).decision.kind).toBe("retry");
	});

	test("accumulates across repeated manual retries", () => {
		let episode = recordManualRetry(null, ROUTE);
		episode = recordManualRetry(episode, ROUTE);
		episode = recordManualRetry(episode, ROUTE);
		expect(episode.manualRetries).toBe(3);
	});

	test("a manual retry after moving route starts a fresh episode", () => {
		const { episode } = crashRepeatedly(MAX_AUTO_RETRIES);
		const manual = recordManualRetry(episode, "/settings");
		expect(manual.manualRetries).toBe(1);
		expect(manual.routeKey).toBe("/settings");
	});
});

describe("episodeDidRecover", () => {
	test("is false for no episode and for an untouched one", () => {
		expect(episodeDidRecover(null)).toBe(false);
		expect(
			episodeDidRecover({ autoRetries: 0, manualRetries: 0, routeKey: ROUTE })
		).toBe(false);
	});

	test("is true once any retry was spent", () => {
		expect(
			episodeDidRecover({ autoRetries: 1, manualRetries: 0, routeKey: ROUTE })
		).toBe(true);
		expect(
			episodeDidRecover({ autoRetries: 0, manualRetries: 1, routeKey: ROUTE })
		).toBe(true);
	});
});

describe("resetKeysChanged", () => {
	test("undefined on both sides is unchanged", () => {
		expect(resetKeysChanged(undefined, undefined)).toBe(false);
	});

	test("appearing or disappearing counts as changed", () => {
		expect(resetKeysChanged(undefined, [])).toBe(true);
		expect(resetKeysChanged([], undefined)).toBe(true);
	});

	test("same values are unchanged, different values are changed", () => {
		expect(resetKeysChanged(["a", 1], ["a", 1])).toBe(false);
		expect(resetKeysChanged(["a", 1], ["a", 2])).toBe(true);
		expect(resetKeysChanged(["a"], ["a", 1])).toBe(true);
	});

	test("uses Object.is, so NaN does not read as a change", () => {
		expect(resetKeysChanged([Number.NaN], [Number.NaN])).toBe(false);
	});
});

describe("policy constants", () => {
	test("the stable window cannot be cleared by a render loop", () => {
		// A loop re-throws within a frame or two; the refund window must be orders
		// of magnitude longer than that, or a loop would refund its own budget.
		expect(STABLE_RENDER_MS).toBeGreaterThanOrEqual(5000);
	});

	test("the budget stays small on purpose", () => {
		expect(MAX_AUTO_RETRIES).toBeGreaterThan(0);
		expect(MAX_AUTO_RETRIES).toBeLessThanOrEqual(3);
	});
});
