import { describe, expect, test } from "bun:test";
import { PRICING_COPY } from "./data/standalone-pricing.ts";
import { depositFeeAmounts } from "./pricing-deposit-fee-format.ts";

describe("depositFeeAmounts", () => {
	test("English matches the published copy exactly", () => {
		const amounts = depositFeeAmounts("en");
		for (const [key, value] of Object.entries(amounts)) {
			expect(value).toBe(PRICING_COPY[key as keyof typeof amounts]);
		}
	});

	test("other locales place symbols and separators their own way", () => {
		const amounts = depositFeeAmounts("de");
		expect(amounts.proDepositFee).toContain("26,5");
		expect(amounts.depositFeeMinimum).not.toBe(PRICING_COPY.depositFeeMinimum);
	});
});
