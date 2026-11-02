import { describe, expect, it } from "bun:test";
import {
	boundedLoginDetail,
	daysSinceLastActive,
	isStaleAccountLogin,
	STALE_ACCOUNT_DAYS,
} from "./stale-account.ts";

const now = new Date("2026-08-21T12:00:00.000Z");

describe("stale-account login policy", () => {
	it("alerts at the dormant-account threshold but not before it", () => {
		const justBefore = new Date(
			now.getTime() - STALE_ACCOUNT_DAYS * 24 * 60 * 60 * 1000 + 1
		);
		const atThreshold = new Date(
			now.getTime() - STALE_ACCOUNT_DAYS * 24 * 60 * 60 * 1000
		);

		expect(isStaleAccountLogin(justBefore, now)).toBe(false);
		expect(isStaleAccountLogin(atThreshold, now)).toBe(true);
		expect(isStaleAccountLogin(undefined, now)).toBe(false);
	});

	it("reports whole inactive days without under-reporting the threshold", () => {
		const lastLogin = new Date("2026-04-23T00:00:00.000Z");

		expect(daysSinceLastActive(lastLogin, now)).toBe(120);
		expect(
			daysSinceLastActive(
				new Date(
					now.getTime() - (STALE_ACCOUNT_DAYS - 1) * 24 * 60 * 60 * 1000
				),
				now
			)
		).toBe(STALE_ACCOUNT_DAYS);
	});

	it("bounds request-derived sign-in details", () => {
		expect(boundedLoginDetail("  Chrome on macOS  ")).toBe("Chrome on macOS");
		expect(boundedLoginDetail("x".repeat(250))).toHaveLength(200);
		expect(boundedLoginDetail("   ")).toBeUndefined();
	});
});
