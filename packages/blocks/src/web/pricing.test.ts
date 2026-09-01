import { describe, expect, it } from "bun:test";
import {
	businessIncludedCreditUsd,
	businessMonthlyPriceUsd,
} from "./business-pricing.ts";
import { annualTotalPrice, effectiveMonthlyPrice } from "./pricing.tsx";

describe("Business public pricing helpers", () => {
	it("quotes the $300 floor and $50 marginal seats", () => {
		expect(businessMonthlyPriceUsd(5)).toBe(300);
		expect(businessMonthlyPriceUsd(6)).toBe(350);
		expect(businessMonthlyPriceUsd(25)).toBe(1300);
	});

	it("uses completed five-seat bundles for the Business pool", () => {
		expect(businessIncludedCreditUsd(5)).toBe(100);
		expect(businessIncludedCreditUsd(6)).toBe(100);
		expect(businessIncludedCreditUsd(10)).toBe(200);
		expect(businessIncludedCreditUsd(15)).toBe(300);
		expect(businessIncludedCreditUsd(25)).toBe(500);
	});

	it("keeps the yearly per-seat equivalent mathematically exact", () => {
		expect(effectiveMonthlyPrice(50, true)).toBeCloseTo(41.6667, 4);
		expect(annualTotalPrice(50) * 5).toBe(2500);
	});
});
