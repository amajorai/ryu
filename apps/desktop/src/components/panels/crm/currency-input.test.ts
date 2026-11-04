import { describe, expect, test } from "bun:test";
import { currencyInputValue, parseCurrencyCents } from "./currency-input.ts";

describe("parseCurrencyCents", () => {
	test("reads the locale's decimal comma", () => {
		expect(parseCurrencyCents("42,50", "de")).toBe(4250);
		expect(parseCurrencyCents("1.234,56", "de")).toBe(123_456);
	});

	test("keeps English input, signs and rounding", () => {
		expect(parseCurrencyCents("42.5", "en")).toBe(4250);
		expect(parseCurrencyCents("-3.25", "en")).toBe(-325);
		expect(parseCurrencyCents("42.005", "en")).toBe(4201);
	});

	test("refuses text that is not an amount", () => {
		expect(parseCurrencyCents("42,50", "en")).toBeNull();
		expect(parseCurrencyCents("abc", "de")).toBeNull();
		expect(parseCurrencyCents("1e400", "en")).toBeNull();
	});
});

describe("currencyInputValue", () => {
	test("pre-fills in the locale's decimal form and reads back", () => {
		expect(currencyInputValue(4250, "de")).toBe("42,5");
		expect(currencyInputValue(4250, "en")).toBe("42.5");
		expect(parseCurrencyCents(currencyInputValue(123_456, "de"), "de")).toBe(
			123_456
		);
	});
});
