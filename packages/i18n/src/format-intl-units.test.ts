import { describe, expect, test } from "bun:test";

import {
	formatByteSize,
	formatPerPeriod,
	weekStartForLocale,
} from "./format-intl.ts";

const KIB = 1024;
const MIB = KIB * KIB;
const GIB = MIB * KIB;

describe("formatByteSize", () => {
	test("keeps the hand-built English output exactly", () => {
		expect(formatByteSize(512, "en")).toBe("512 B");
		expect(formatByteSize(1536, "en")).toBe("1.5 KB");
		expect(formatByteSize(2 * MIB, "en")).toBe("2.0 MB");
		expect(formatByteSize(4.7 * GIB, "en-GB")).toBe("4.7 GB");
		expect(formatByteSize(3 * GIB * KIB, "en")).toBe("3.0 TB");
		expect(formatByteSize(Number.NaN, "en")).toBe("0 B");
	});

	test("takes the options the existing formatters need", () => {
		// DownloadRow: one decimal below 10, none above.
		const downloads = {
			fractionDigits: (value: number) => (value < 10 ? 1 : 0),
		};
		expect(formatByteSize(12 * GIB, "en", downloads)).toBe("12 GB");
		expect(formatByteSize(1.5 * GIB, "en", downloads)).toBe("1.5 GB");
		// Space uploads: trailing zeros dropped.
		expect(formatByteSize(200 * MIB, "en", { trimZeros: true })).toBe("200 MB");
		// Decimal gigabytes, never past GB.
		expect(
			formatByteSize(4_700_000_000, "en", { base: 1000, maxUnit: "gigabyte" })
		).toBe("4.7 GB");
		expect(formatByteSize(512, "en", { minUnit: "kilobyte" })).toBe("0.5 KB");
		expect(formatByteSize(1.5 * MIB, "en", { perSecond: true })).toBe(
			"1.5 MB/s"
		);
	});

	test("uses the locale's separators and unit names elsewhere", () => {
		expect(formatByteSize(4.7 * GIB, "de")).toMatch(/^4,7\sGB$/u);
		expect(formatByteSize(4.7 * GIB, "fr")).toMatch(/^4,7\sGo$/u);
		expect(formatByteSize(1.5 * MIB, "de", { perSecond: true })).toContain(
			"1,5"
		);
		expect(formatByteSize(4.7 * GIB, "ja")).toContain("4.7");
	});
});

describe("formatPerPeriod", () => {
	test("keeps the English price suffixes", () => {
		expect(formatPerPeriod("$12", "month")).toBe("$12/mo");
		expect(formatPerPeriod("$120", "year")).toBe("$120/yr");
	});
});

describe("weekStartForLocale", () => {
	test("reads the locale's first weekday", () => {
		const supported =
			typeof Reflect.get(new Intl.Locale("de"), "getWeekInfo") === "function" ||
			Reflect.get(new Intl.Locale("de"), "weekInfo");
		if (!supported) {
			expect(weekStartForLocale("de")).toBeUndefined();
			return;
		}
		expect(weekStartForLocale("de")).toBe(1);
		expect(weekStartForLocale("en-US")).toBe(0);
		expect(weekStartForLocale("ar")).toBe(6);
	});

	test("answers undefined for an unusable tag", () => {
		expect(weekStartForLocale("")).toBeUndefined();
		expect(weekStartForLocale(null)).toBeUndefined();
		expect(weekStartForLocale("not a locale!")).toBeUndefined();
	});
});
