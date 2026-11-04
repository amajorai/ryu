import { describe, expect, test } from "bun:test";
import {
	formatThresholdInput,
	parseThresholdInput,
} from "./monitors-threshold-input.ts";

describe("price monitor threshold input", () => {
	test("reads comma decimals under de instead of dropping the threshold", () => {
		expect(parseThresholdInput("12,50", "de")).toBe(12.5);
		expect(parseThresholdInput("0,7", "de")).toBeCloseTo(0.7);
		expect(parseThresholdInput("1.299,99", "de")).toBeCloseTo(1299.99);
	});

	test("keeps English input unchanged", () => {
		expect(parseThresholdInput("12.50", "en")).toBe(12.5);
		expect(parseThresholdInput("5", "en")).toBe(5);
	});

	test("blank and unreadable text mean no threshold", () => {
		expect(parseThresholdInput("  ", "de")).toBeNull();
		expect(parseThresholdInput("abc", "en")).toBeNull();
	});

	test("prefills a stored threshold with the locale separator", () => {
		expect(formatThresholdInput(12.5, "de")).toBe("12,5");
		expect(formatThresholdInput(12.5, "en")).toBe("12.5");
		expect(formatThresholdInput(null, "de")).toBe("");
	});

	test("round-trips native digits under ar-EG and dot decimals under ja", () => {
		expect(
			parseThresholdInput(formatThresholdInput(12.5, "ar-EG"), "ar-EG")
		).toBe(12.5);
		expect(parseThresholdInput("12.5", "ja")).toBe(12.5);
	});
});
