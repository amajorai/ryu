import { describe, expect, test } from "bun:test";

import {
	dateFormatter,
	formatCompactAge,
	formatDurationParts,
	formatDurationUnit,
	formatRelativeTime,
	numberFormatter,
	relativeTimeFormatter,
	relativeTimeParts,
	unitFormatter,
} from "./format-intl.ts";
import { I18nRuntime } from "./runtime.ts";

const NOW = Date.UTC(2026, 0, 31, 12);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Ages from "now" to years, one per compact unit. */
const AGES = [
	5 * SECOND,
	5 * MINUTE,
	2 * HOUR,
	3 * DAY,
	14 * DAY,
	60 * DAY,
	800 * DAY,
];

function compactAges(locale: string): string[] {
	return AGES.map((age) => formatCompactAge(locale, NOW - age, { now: NOW }));
}

describe("formatCompactAge", () => {
	test("keeps the existing English output exactly", () => {
		expect(compactAges("en")).toEqual([
			"now",
			"5m",
			"2h",
			"3d",
			"2w",
			"2mo",
			"2y",
		]);
		expect(compactAges("en-GB")).toEqual(compactAges("en"));
		expect(formatCompactAge("en", NOW + HOUR, { now: NOW })).toBe("now");
		expect(formatCompactAge("en", Number.NaN, { now: NOW })).toBe("");
	});

	test("uses the locale's own unit abbreviations", () => {
		expect(compactAges("ja")).toEqual([
			"今",
			"5分",
			"2時間",
			"3日",
			"2週間",
			"2か月",
			"2年",
		]);
		const russian = compactAges("ru");
		expect(russian[0]).toBe("сейчас");
		expect(russian[1]).toBe("5 мин");
		expect(russian[2]).toBe("2 ч");
		const arabic = compactAges("ar");
		expect(arabic[0]).toBe("الآن");
		for (const age of arabic.slice(1)) {
			expect(age).not.toMatch(/[a-z]/u);
		}
		// Every unit reads differently, so minutes and months never collide.
		for (const locale of ["ja", "ar", "ru", "de", "fr"]) {
			const ages = compactAges(locale);
			expect(new Set(ages).size).toBe(ages.length);
		}
	});

	test("falls back to English formats for an invalid locale", () => {
		expect(
			formatCompactAge("not a locale!", NOW - 5 * MINUTE, { now: NOW })
		).toBe("5m");
	});
});

describe("formatRelativeTime", () => {
	test("reads past and future times in each locale", () => {
		const at = (offset: number, locale: string) =>
			formatRelativeTime(locale, NOW + offset, { now: NOW });
		expect(at(-5 * SECOND, "en")).toBe("now");
		expect(at(-5 * MINUTE, "en")).toBe("5 minutes ago");
		expect(at(-DAY, "en")).toBe("yesterday");
		expect(at(2 * HOUR, "en")).toBe("in 2 hours");
		expect(at(-5 * MINUTE, "ja")).toBe("5 分前");
		expect(at(-DAY, "ja")).toBe("昨日");
		expect(at(-5 * MINUTE, "ru")).toBe("5 минут назад");
		expect(at(-DAY, "ar")).toBe("أمس");
		expect(
			formatRelativeTime("en", NOW - 5 * MINUTE, {
				now: NOW,
				numeric: "always",
				style: "narrow",
			})
		).toBe("5m ago");
		expect(formatRelativeTime("en", "not a date", { now: NOW })).toBe("");
	});

	test("picks the largest whole unit", () => {
		expect(relativeTimeParts(-90)).toEqual({ unit: "minute", value: -1 });
		expect(relativeTimeParts(3 * 3600)).toEqual({ unit: "hour", value: 3 });
		expect(relativeTimeParts(-10 * 86_400)).toEqual({
			unit: "week",
			value: -1,
		});
		expect(relativeTimeParts(400 * 86_400)).toEqual({ unit: "year", value: 1 });
	});
});

describe("cached formatters", () => {
	test("return the same instance for the same locale and options", () => {
		expect(dateFormatter("ja", { month: "short" })).toBe(
			dateFormatter("ja", { month: "short" })
		);
		expect(dateFormatter("ja", { month: "short" })).not.toBe(
			dateFormatter("ja", { month: "long" })
		);
		expect(numberFormatter("de")).toBe(numberFormatter("de"));
		expect(relativeTimeFormatter("ru", "short")).toBe(
			relativeTimeFormatter("ru", "short")
		);
		expect(unitFormatter("ar", "hour")).toBe(unitFormatter("ar", "hour"));
		expect(numberFormatter("??").resolvedOptions().locale).toBe("en");
	});

	test("back the runtime's formatting methods", () => {
		const runtime = new I18nRuntime([], {
			initialLocale: "ja",
			initialPackId: null,
		});
		expect(runtime.formatCompactAge(NOW - 5 * MINUTE, { now: NOW })).toBe(
			"5分"
		);
		expect(runtime.formatRelativeTime(NOW - DAY, { now: NOW })).toBe("昨日");
		expect(runtime.formatUnit(3, "hour", "short")).toBe("3 時間");
		expect(runtime.formatNumber(1234.5)).toBe("1,234.5");
		expect(runtime.formatDate(NOW, { timeZone: "UTC", year: "numeric" })).toBe(
			"2026年"
		);
	});
});

describe("compact durations", () => {
	const MINUTE_AND_SECONDS = [
		[1, "minute"],
		[23, "second"],
	] as const;

	test("keeps the hand-built English output exactly", () => {
		expect(formatDurationParts(MINUTE_AND_SECONDS, "en")).toBe("1m 23s");
		expect(formatDurationUnit(1.5, "second", 1, "en")).toBe("1.5s");
		expect(formatDurationUnit(420, "millisecond", 0, "en-GB")).toBe("420ms");
	});

	test("uses German short units and decimal comma", () => {
		expect(formatDurationParts(MINUTE_AND_SECONDS, "de")).toBe(
			"1 Min. 23 Sek."
		);
		expect(formatDurationUnit(1.5, "second", 1, "de")).toBe("1,5 Sek.");
	});

	test("drops the gap before Japanese units", () => {
		expect(formatDurationParts(MINUTE_AND_SECONDS, "ja")).toBe("1分 23秒");
		expect(formatDurationParts([[2, "hour"]], "ja")).toBe("2時間");
	});

	test("formats Arabic with the locale's own units", () => {
		const expected = ["minute", "second"]
			.map((unit, index) =>
				new Intl.NumberFormat("ar", {
					maximumFractionDigits: 0,
					minimumFractionDigits: 0,
					style: "unit",
					unit,
					unitDisplay: "short",
				}).format(MINUTE_AND_SECONDS[index]?.[0] ?? 0)
			)
			.join(" ");
		const formatted = formatDurationParts(MINUTE_AND_SECONDS, "ar");
		expect(formatted).toBe(expected);
		expect(formatted).not.toMatch(/[a-z]/u);
	});
});
