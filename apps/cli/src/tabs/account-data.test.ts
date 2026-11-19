import { expect, test } from "bun:test";
import { formatPlan } from "./account-data.ts";

function trial(interval: string) {
	return {
		lifetime: null,
		subscription: { interval, status: "trialing" },
	} as Parameters<typeof formatPlan>[0];
}

test("a trial's plan label is one whole phrase per billing interval", () => {
	expect(formatPlan(trial("month"))).toBe("Trial (monthly after trial)");
	expect(formatPlan(trial("year"))).toBe("Trial (annually after trial)");
	expect(formatPlan(trial(""))).toBe("Trial period");
});

test("the free and expired-lifetime plans are whole phrases", () => {
	expect(
		formatPlan({ lifetime: null, subscription: null } as Parameters<
			typeof formatPlan
		>[0])
	).toBe("Free plan");
	expect(
		formatPlan({
			lifetime: { expired: true },
			subscription: null,
		} as Parameters<typeof formatPlan>[0])
	).toBe("Lifetime (updates expired)");
});
