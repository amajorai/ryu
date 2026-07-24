// Unit tests for the shared money-layer formatter. formatPrice converts a
// minor-unit (cents) integer into a localized currency string; the fraction digits
// are pinned to 2 and the currency code is upper-cased regardless of caller casing.

import { describe, expect, test } from "bun:test";
import { formatPrice } from "./types.ts";

describe("formatPrice", () => {
	test("converts cents to a 2-decimal amount", () => {
		expect(formatPrice(1099)).toContain("10.99");
	});

	test("always shows two fraction digits", () => {
		expect(formatPrice(500)).toContain("5.00");
	});

	test("zero renders as 0.00", () => {
		expect(formatPrice(0)).toContain("0.00");
	});

	test("returns a non-empty string for a non-usd currency code", () => {
		const eur = formatPrice(2000, "eur");
		expect(typeof eur).toBe("string");
		expect(eur).toContain("20.00");
	});

	test("currency casing does not change the numeric portion", () => {
		expect(formatPrice(1234, "USD")).toContain("12.34");
		expect(formatPrice(1234, "usd")).toContain("12.34");
	});
});
