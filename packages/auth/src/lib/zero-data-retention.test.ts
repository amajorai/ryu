import { describe, expect, test } from "bun:test";
import { canUseZeroDataRetention } from "./zero-data-retention.ts";

describe("standard ZDR availability", () => {
	test("every plan qualifies independently of Enterprise status", () => {
		for (const plan of [
			null,
			undefined,
			"none",
			"pro",
			"max",
			"teams",
			"business",
		]) {
			expect(canUseZeroDataRetention({ plan })).toBe(true);
			expect(
				canUseZeroDataRetention({
					plan,
					enterpriseStatus: "expired",
					enterpriseExpiresAt: new Date("2000-01-01"),
				})
			).toBe(true);
		}
	});
});
