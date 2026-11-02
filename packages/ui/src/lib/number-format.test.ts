import { describe, expect, test } from "bun:test";
import {
	formatCount,
	formatCurrency,
	formatMicroUsd,
	formatMinorCurrency,
	formatNumber,
} from "./number-format.ts";

describe("formatCount", () => {
	test("keeps thousands readable with separators", () => {
		expect(formatCount(1234)).toBe("1,234");
		expect(formatCount(999_999)).toBe("999,999");
	});

	test("uses a lowercase m for million-scale counts", () => {
		expect(formatCount(1_234_567)).toBe("1.2m");
		expect(formatCount(2_000_000)).toBe("2m");
	});

	test("handles missing and non-finite values", () => {
		expect(formatCount(null)).toBeNull();
		expect(formatCount(Number.NaN)).toBeNull();
		expect(formatNumber(null)).toBe("—");
	});
});

describe("currency formatting", () => {
	test("keeps normal currency amounts precise and separated", () => {
		expect(formatCurrency(1234.5)).toBe("$1,234.50");
		expect(formatMinorCurrency(123_456)).toBe("$1,234.56");
	});

	test("uses lowercase m for large currency amounts", () => {
		expect(formatCurrency(1_234_567)).toBe("$1.2m");
		expect(formatMicroUsd(1_234_567_000_000)).toBe("$1.2m");
	});

	test("keeps minor-unit prices precise until the million-dollar boundary", () => {
		expect(formatMinorCurrency(100_000_000)).toBe("$1m");
	});
});

describe("locale-aware formatting", () => {
	test("keeps every English variant on the English policy", () => {
		expect(formatCount(1234, "en-GB")).toBe("1,234");
		expect(formatCount(1_234_567, "en-GB")).toBe("1.2m");
		expect(formatCurrency(1234.5, "USD", {}, "en-GB")).toBe("$1,234.50");
		expect(formatCurrency(1_234_567, "USD", {}, "en")).toBe("$1.2m");
	});

	test("groups and abbreviates in the requested locale", () => {
		const expectations: [string, number][] = [
			["de", 1234.5],
			["fr", 1234],
			["ja", 1_234_567],
			["ar", 1234],
		];
		for (const [locale, value] of expectations) {
			const expected =
				Math.abs(value) >= 1_000_000
					? new Intl.NumberFormat(locale, {
							compactDisplay: "short",
							maximumFractionDigits: 1,
							minimumFractionDigits: 0,
							notation: "compact",
						}).format(value)
					: new Intl.NumberFormat(locale, {
							maximumFractionDigits: Number.isInteger(value) ? 0 : 3,
						}).format(value);
			expect(formatCount(value, locale)).toBe(expected);
		}
		expect(formatCount(1234.5, "de")).toBe("1.234,5");
		expect(formatCount(1_234_567, "ja")).not.toContain("m");
	});

	test("formats currency in the requested locale", () => {
		expect(formatCurrency(1234.5, "USD", {}, "de")).toBe(
			new Intl.NumberFormat("de", {
				currency: "USD",
				style: "currency",
			}).format(1234.5)
		);
		expect(formatCurrency(1_234_567, "EUR", {}, "fr")).toBe(
			new Intl.NumberFormat("fr", {
				compactDisplay: "short",
				currency: "EUR",
				maximumFractionDigits: 1,
				minimumFractionDigits: 0,
				notation: "compact",
				style: "currency",
			}).format(1_234_567)
		);
		expect(formatMinorCurrency(123_456, "USD", undefined, "ja")).toBe(
			new Intl.NumberFormat("ja", {
				currency: "USD",
				maximumFractionDigits: 2,
				minimumFractionDigits: 2,
				style: "currency",
			}).format(1234.56)
		);
	});
});
