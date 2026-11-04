import { describe, expect, test } from "bun:test";
import {
	formatThresholdDraft,
	parseThresholdDraft,
} from "./threshold-draft.ts";

describe("fallback rule threshold draft", () => {
	test("reads a comma-decimal USD amount under de", () => {
		expect(parseThresholdDraft("0,50", "de")).toBe(0.5);
		expect(parseThresholdDraft("12,50", "de")).toBe(12.5);
	});

	test("keeps English input unchanged", () => {
		expect(parseThresholdDraft("12.50", "en")).toBe(12.5);
		expect(parseThresholdDraft("80", "en")).toBe(80);
	});

	test("blank or malformed text is NaN so the commit is refused", () => {
		expect(Number.isNaN(parseThresholdDraft("", "de"))).toBe(true);
		expect(Number.isNaN(parseThresholdDraft("abc", "en"))).toBe(true);
	});

	test("shows a committed value with the locale separator", () => {
		expect(formatThresholdDraft(0.5, "de")).toBe("0,5");
		expect(formatThresholdDraft(0.005, "en")).toBe("0.005");
		expect(formatThresholdDraft(80, "de")).toBe("80");
	});
});
