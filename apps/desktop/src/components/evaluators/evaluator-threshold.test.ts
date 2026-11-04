import { describe, expect, test } from "bun:test";
import {
	defaultThresholdInput,
	parseThresholdInput,
} from "./evaluator-threshold.ts";

describe("evaluator pass threshold input", () => {
	test("reads a comma decimal under de instead of truncating it to 0", () => {
		expect(parseThresholdInput("0,7", "de")).toBeCloseTo(0.7);
		expect(parseThresholdInput("0,25", "fr")).toBeCloseTo(0.25);
	});

	test("keeps English dot decimals unchanged", () => {
		expect(parseThresholdInput("0.7", "en")).toBeCloseTo(0.7);
		expect(parseThresholdInput("1", "en")).toBe(1);
	});

	test("rejects empty and malformed text", () => {
		expect(Number.isNaN(parseThresholdInput("", "en"))).toBe(true);
		expect(Number.isNaN(parseThresholdInput("abc", "de"))).toBe(true);
	});

	test("prefills the default in the locale's decimal separator", () => {
		expect(defaultThresholdInput("en")).toBe("0.7");
		expect(defaultThresholdInput("de")).toBe("0,7");
		expect(defaultThresholdInput("ja")).toBe("0.7");
	});

	test("round-trips Arabic-Indic digits under ar-EG", () => {
		const prefill = defaultThresholdInput("ar-EG");
		expect(parseThresholdInput(prefill, "ar-EG")).toBeCloseTo(0.7);
		expect(parseThresholdInput("٠٫٢٥", "ar-EG")).toBeCloseTo(0.25);
	});
});
