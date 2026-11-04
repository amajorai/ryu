import { describe, expect, test } from "bun:test";
import {
	formatLocaleNumberInput,
	localeSeparators,
	parseLocaleNumber,
} from "./parse-number.ts";

describe("parseLocaleNumber", () => {
	test("reads the locale's own decimal comma", () => {
		expect(parseLocaleNumber("12,50", "de")).toBe(12.5);
		expect(parseLocaleNumber("7,5", "de")).toBe(7.5);
		expect(parseLocaleNumber("25,50", "fr")).toBe(25.5);
		expect(parseLocaleNumber("0,99", "pt-BR")).toBe(0.99);
	});

	test("reads grouped numbers in both conventions", () => {
		expect(parseLocaleNumber("1,000.5", "en")).toBe(1000.5);
		expect(parseLocaleNumber("1.000,5", "de")).toBe(1000.5);
		expect(parseLocaleNumber("1 234,5", "fr")).toBe(1234.5);
		expect(parseLocaleNumber("1 234,5", "fr")).toBe(1234.5);
		expect(parseLocaleNumber("1 234,5", "ru")).toBe(1234.5);
		expect(parseLocaleNumber("1'234.5", "de-CH")).toBe(1234.5);
		expect(parseLocaleNumber("1’234.5", "de-CH")).toBe(1234.5);
		expect(parseLocaleNumber("12,34,567.5", "hi")).toBe(1_234_567.5);
		expect(parseLocaleNumber("1.000.000", "de")).toBe(1_000_000);
		expect(parseLocaleNumber("1,000,000", "en")).toBe(1_000_000);
	});

	test("also accepts '.' as the decimal in comma-decimal locales", () => {
		expect(parseLocaleNumber("7.5", "de")).toBe(7.5);
		expect(parseLocaleNumber("12.50", "de")).toBe(12.5);
		expect(parseLocaleNumber("12.50", "fr")).toBe(12.5);
		expect(parseLocaleNumber("1,000.5", "de")).toBe(1000.5);
	});

	test("'.' with exactly three digits after is a group where '.' groups", () => {
		expect(parseLocaleNumber("1.000", "de")).toBe(1000);
		// French groups with a space, so '.' stays a decimal there.
		expect(parseLocaleNumber("1.000", "fr")).toBe(1);
	});

	test("the locale's own decimal separator always wins", () => {
		expect(parseLocaleNumber("1,000", "de")).toBe(1);
		expect(parseLocaleNumber("1.000", "en")).toBe(1);
		expect(parseLocaleNumber("1,000", "en")).toBe(1000);
	});

	test("refuses malformed or ambiguous input instead of truncating", () => {
		expect(parseLocaleNumber("1,5", "en")).toBeNaN();
		expect(parseLocaleNumber("", "en")).toBeNaN();
		expect(parseLocaleNumber("  ", "de")).toBeNaN();
		expect(parseLocaleNumber(",", "de")).toBeNaN();
		expect(parseLocaleNumber("12abc", "en")).toBeNaN();
		expect(parseLocaleNumber("$12", "en")).toBeNaN();
		expect(parseLocaleNumber("1.2.3,4,5", "de")).toBeNaN();
		expect(parseLocaleNumber("1,2,5.5", "en")).toBeNaN();
		expect(parseLocaleNumber("1000.000", "de")).toBeNaN();
		expect(parseLocaleNumber("1 000", "en")).toBeNaN();
		expect(parseLocaleNumber("1.000,5", "en")).toBeNaN();
		expect(parseLocaleNumber("1,5,5", "de")).toBeNaN();
	});

	test("handles signs, bare fractions and native digits", () => {
		expect(parseLocaleNumber("-3,5", "de")).toBe(-3.5);
		expect(parseLocaleNumber("−3.5", "en")).toBe(-3.5);
		expect(parseLocaleNumber("+4", "en")).toBe(4);
		expect(parseLocaleNumber(",5", "de")).toBe(0.5);
		expect(parseLocaleNumber(" 42 ", "en")).toBe(42);
		expect(parseLocaleNumber("۱۲٫۵", "fa")).toBe(12.5);
		expect(parseLocaleNumber("１２．５", "ja")).toBe(12.5);
		expect(parseLocaleNumber("१२.५", "hi")).toBe(12.5);
	});

	test("reads Arabic and Japanese input", () => {
		expect(parseLocaleNumber("٧٫٥", "ar")).toBe(7.5);
		expect(parseLocaleNumber("١٬٢٣٤٫٥", "ar")).toBe(1234.5);
		expect(parseLocaleNumber("7.5", "ar")).toBe(7.5);
		expect(parseLocaleNumber("7,5", "ar")).toBeNaN();
		expect(parseLocaleNumber("1,234.5", "ja")).toBe(1234.5);
		expect(parseLocaleNumber("１，２３４．５", "ja")).toBe(1234.5);
		expect(parseLocaleNumber("12,5", "ja")).toBeNaN();
	});

	test("an unusable locale falls back to English", () => {
		expect(parseLocaleNumber("1,000.5", "not a locale")).toBe(1000.5);
	});
});

describe("localeSeparators", () => {
	test("reports the separators the locale formats with", () => {
		expect(localeSeparators("en")).toEqual({ decimal: ".", group: "," });
		expect(localeSeparators("de")).toEqual({ decimal: ",", group: "." });
		expect(localeSeparators("fr")).toEqual({ decimal: ",", group: " " });
	});
});

describe("formatLocaleNumberInput", () => {
	test("formats without grouping so the parser reads it back", () => {
		expect(formatLocaleNumberInput(1234.5, "de")).toBe("1234,5");
		expect(formatLocaleNumberInput(42.5, "en")).toBe("42.5");
		for (const locale of ["de", "fr", "en", "hi", "fa", "de-CH"]) {
			const text = formatLocaleNumberInput(1234.56, locale);
			expect(parseLocaleNumber(text, locale)).toBe(1234.56);
		}
	});
});
