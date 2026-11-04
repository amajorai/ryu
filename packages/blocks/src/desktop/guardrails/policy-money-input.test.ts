import { describe, expect, test } from "bun:test";
import { microFromUsd, usdFromMicro } from "./policy-model.ts";
import {
	formatUsdMicroInput,
	parseUsdMicroInput,
} from "./policy-money-input.ts";

describe("policy money input", () => {
	test("reads a German comma decimal as dollars", () => {
		expect(parseUsdMicroInput("100,50", "de")).toBe(100_500_000);
		expect(parseUsdMicroInput("1.000,25", "de")).toBe(1_000_250_000);
	});

	test("reads an English period decimal and grouped thousands", () => {
		expect(parseUsdMicroInput("12.5", "en")).toBe(12_500_000);
		expect(parseUsdMicroInput("1,000.5", "en")).toBe(1_000_500_000);
	});

	test("refuses empty, negative and unreadable amounts", () => {
		expect(parseUsdMicroInput("  ", "de")).toBeNull();
		expect(parseUsdMicroInput("-1", "de")).toBeNull();
		expect(parseUsdMicroInput("zehn", "de")).toBeNull();
	});

	test("prefills a saved cap in the locale without grouping", () => {
		expect(formatUsdMicroInput(100_500_000, "de")).toBe("100,5");
		expect(formatUsdMicroInput(1_234_000_000, "de")).toBe("1234");
		expect(formatUsdMicroInput(12_345_678, "en")).toBe("12.345678");
	});

	test("the model helpers keep reading English input outside a provider", () => {
		expect(microFromUsd("12.5")).toBe(12_500_000);
		expect(usdFromMicro(30_000_000)).toBe("30");
	});
});
