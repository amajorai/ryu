import { describe, expect, test } from "bun:test";
import { formatLatencyMs } from "./agent-latency-format.ts";

describe("formatLatencyMs", () => {
	test("keeps the compact English readout", () => {
		expect(formatLatencyMs(420.4, "en")).toBe("420ms");
	});

	test("uses the Arabic number format and unit", () => {
		const readout = formatLatencyMs(420, "ar");
		const digits = new Intl.NumberFormat("ar").format(420);
		expect(readout).toContain(digits);
		expect(readout).toMatch(/[\u0600-\u06ff]/u);
		expect(readout).not.toContain("ms");
	});

	test("uses the German unit spacing", () => {
		expect(formatLatencyMs(1234, "de").replace(/\s/gu, " ")).toBe("1.234 ms");
	});

	test("uses the Japanese unit without an English suffix glued on", () => {
		const expected = new Intl.NumberFormat("ja", {
			style: "unit",
			unit: "millisecond",
			unitDisplay: "short",
		}).format(420);
		expect(formatLatencyMs(420, "ja")).toBe(expected);
		expect(formatLatencyMs(420, "ja")).not.toBe("420ms");
	});

	test("reads missing values as an em dash", () => {
		expect(formatLatencyMs(null, "ar")).toBe("—");
		expect(formatLatencyMs(undefined)).toBe("—");
		expect(formatLatencyMs(Number.NaN, "de")).toBe("—");
	});
});
