import { describe, expect, test } from "bun:test";
import {
	formatByteSize,
	formatCompactNumber,
	formatDecimal,
	formatDurationParts,
	formatDurationUnit,
	formatList,
	formatPercentValue,
} from "./locale-format.ts";
import { formatStatsCount, formatStatsDuration } from "./stats-count-format.ts";

describe("English keeps the transcript's existing strings", () => {
	test("durations", () => {
		expect(formatDurationUnit(420, "millisecond", 0, "en")).toBe("420ms");
		expect(formatDurationUnit(3.25, "second", 1, "en")).toBe("3.3s");
		expect(
			formatDurationParts(
				[
					[1, "minute"],
					[23, "second"],
				],
				"en"
			)
		).toBe("1m 23s");
		expect(formatDurationParts([[2, "hour"]], "en-GB")).toBe("2h");
	});

	test("numbers, percentages and sizes", () => {
		expect(formatDecimal(12.5, 2, "en")).toBe("12.50");
		expect(formatPercentValue(42, 0, "en")).toBe("42%");
		expect(formatPercentValue(0.25, 1, "en")).toBe("0.3%");
		expect(formatByteSize(512, "en")).toBe("512 B");
		expect(formatByteSize(1536, "en")).toBe("1.5 KB");
		expect(formatByteSize(2 * 1024 * 1024, "en")).toBe("2.0 MB");
		expect(formatCompactNumber(12_400, "en")).toBe("12.4K");
	});

	test("stats footer counts and durations", () => {
		expect(formatStatsCount(842, "en")).toBe("842");
		expect(formatStatsCount(1234, "en")).toBe("1.2k");
		expect(formatStatsCount(12_345, "en")).toBe("12k");
		expect(formatStatsCount(1_500_000, "en")).toBe("1.5m");
		expect(formatStatsCount(undefined, "en")).toBeNull();
		expect(formatStatsDuration(42_000, "en")).toBe("42s");
		expect(formatStatsDuration(185_000, "en")).toBe("3m 5s");
	});
});

describe("other locales use their own digits and units", () => {
	test("Japanese durations drop the gap before the unit", () => {
		expect(
			formatDurationParts(
				[
					[1, "minute"],
					[23, "second"],
				],
				"ja"
			)
		).toBe("1分 23秒");
		expect(formatStatsDuration(42_000, "ja")).toBe("42秒");
	});

	test("German decimals and percentages", () => {
		expect(formatDecimal(12.5, 2, "de")).toBe("12,50");
		expect(formatPercentValue(42.5, 1, "de")).toMatch(/^42,5\s%$/u);
		expect(formatByteSize(1536, "de")).toMatch(/^1,5\skB$/u);
	});

	test("compact counts follow the locale", () => {
		expect(formatStatsCount(12_400, "ja")).toBe(
			new Intl.NumberFormat("ja", {
				maximumFractionDigits: 1,
				notation: "compact",
			}).format(12_400)
		);
		expect(formatStatsCount(842, "de")).toBe("842");
	});
});

describe("formatList", () => {
	test("keeps English separators and localizes the rest", () => {
		expect(formatList(["Ada", "Bea"], "unit", "en")).toBe("Ada, Bea");
		expect(formatList(["a", "b", "c"], "conjunction", "en")).toBe(
			"a, b, and c"
		);
		expect(formatList(["a", "b"], "conjunction", "de")).toBe("a und b");
		expect(formatList(["a", "b", "c"], "conjunction", "ja")).toBe("a、b、c");
	});
});
