import { describe, expect, test } from "bun:test";
import { dollarsToCents } from "./ugc-dollars.ts";

describe("UGC dollar amounts", () => {
	test("reads a comma decimal under de", () => {
		expect(dollarsToCents("$12,50", "de")).toBe(1250);
		expect(dollarsToCents("12,5", "de")).toBe(1250);
		expect(dollarsToCents("0,99", "fr")).toBe(99);
	});

	test("reads native digits and the Arabic decimal mark", () => {
		expect(dollarsToCents("١٢٫٥٠", "ar-EG")).toBe(1250);
		expect(dollarsToCents("12٫5", "ar-EG")).toBe(1250);
		expect(dollarsToCents("１２.５", "ja")).toBe(1250);
		expect(dollarsToCents("12.50", "ar")).toBe(1250);
	});

	test("keeps English amounts unchanged", () => {
		expect(dollarsToCents("12", "en")).toBe(1200);
		expect(dollarsToCents("12.5", "en")).toBe(1250);
		expect(dollarsToCents(" $ 12.50 ", "en")).toBe(1250);
		expect(dollarsToCents("12.50", "de")).toBe(1250);
	});

	test("refuses grouping, extra decimals and a comma where it groups", () => {
		expect(dollarsToCents("12,50", "en")).toBeNull();
		expect(dollarsToCents("1.200", "de")).toBeNull();
		expect(dollarsToCents("12.505", "en")).toBeNull();
		expect(dollarsToCents("-5", "en")).toBeNull();
		expect(dollarsToCents("", "en")).toBeNull();
	});
});
