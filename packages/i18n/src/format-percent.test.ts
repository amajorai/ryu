import { describe, expect, test } from "bun:test";
import { formatPercent } from "./format-percent.ts";

describe("formatPercent", () => {
	test("matches the English templates it replaces", () => {
		expect(formatPercent(0.42, 0, "en")).toBe("42%");
		expect(formatPercent(0.425, 1, "en")).toBe("42.5%");
		expect(formatPercent(0.4, 1, "en")).toBe("40.0%");
		expect(formatPercent(0, 0, "en")).toBe("0%");
	});

	test("uses the locale's separator and sign placement", () => {
		expect(formatPercent(0.425, 1, "de")).toMatch(/^42,5\s%$/u);
		expect(formatPercent(0.42, 0, "fr")).toMatch(/^42\s%$/u);
		expect(formatPercent(0.42, 0, "ja")).toBe("42%");
		expect(formatPercent(0.42, 0, "ar")).not.toBe("42%");
	});

	test("falls back to English for an unusable tag", () => {
		expect(formatPercent(0.5, 0, "not a locale")).toBe("50%");
	});
});
