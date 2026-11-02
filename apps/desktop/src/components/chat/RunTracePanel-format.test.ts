import { expect, test } from "bun:test";
import { formatDuration, formatTokens } from "./RunTracePanel-format.ts";

test("English keeps the panel's compact durations and token counts", () => {
	expect(formatDuration(250, "en")).toBe("250ms");
	expect(formatDuration(1500, "en")).toBe("1.50s");
	expect(formatDuration(12_340, "en")).toBe("12.3s");
	expect(formatTokens(842, "en")).toBe("842");
	expect(formatTokens(1500, "en")).toBe("1.5k");
});

test("German uses a decimal comma and its own units", () => {
	expect(formatDuration(1500, "de")).toBe(
		new Intl.NumberFormat("de", {
			maximumFractionDigits: 2,
			minimumFractionDigits: 2,
			style: "unit",
			unit: "second",
			unitDisplay: "short",
		}).format(1.5)
	);
	expect(formatDuration(1500, "de")).toContain("1,50");
	expect(formatTokens(1500, "de")).not.toContain("k");
});

test("Japanese and Arabic seconds carry no English unit letters", () => {
	expect(formatDuration(1500, "ja")).toBe("1.50秒");
	expect(formatDuration(12_340, "ja")).toBe("12.3秒");
	expect(formatDuration(1500, "ar")).not.toMatch(/[a-z]/u);
	expect(formatDuration(1500, "ar")).toContain(
		new Intl.NumberFormat("ar", { minimumFractionDigits: 2 }).format(1.5)
	);
});

test("an open span reads 'in flight' in English", () => {
	expect(formatDuration(null, "en")).toBe("in flight");
});

test("token counts use the locale's compact notation", () => {
	expect(formatTokens(1500, "ja")).toBe(
		new Intl.NumberFormat("ja", {
			maximumFractionDigits: 1,
			notation: "compact",
		}).format(1500)
	);
	expect(formatTokens(1500, "ar")).not.toMatch(/[a-z]/u);
});
