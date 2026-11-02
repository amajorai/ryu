// apps/desktop/src/lib/time.test.ts
//
// Tests for the compact relative-age formatter used by the sidebar/recents.
// Every branch is a boundary (59s vs 60s, 6d vs 7d, 29d vs 30d, 364d vs 365d),
// so the clock must be pinned — a racing internal Date.now() would otherwise
// flip a boundary a few ms after the value we pass in. We freeze time with
// setSystemTime and restore it in afterEach so no frozen clock leaks into
// sibling test files sharing this bun process.

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { compactAge, compactAgo, presenceAgo } from "./time.ts";

const NOW = new Date("2026-01-15T12:00:00.000Z").getTime();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ago = (ms: number) => compactAge(NOW - ms);

beforeEach(() => {
	setSystemTime(NOW);
});

afterEach(() => {
	setSystemTime(); // un-freeze — otherwise other files inherit a stuck clock
});

describe("compactAge", () => {
	it("reports 'now' under a minute (including the 59s edge)", () => {
		expect(ago(0)).toBe("now");
		expect(ago(59 * SEC)).toBe("now");
	});

	it("switches to minutes exactly at 60s", () => {
		expect(ago(MIN)).toBe("1m");
		expect(ago(59 * MIN)).toBe("59m");
	});

	it("switches to hours exactly at 60m", () => {
		expect(ago(HOUR)).toBe("1h");
		expect(ago(23 * HOUR)).toBe("23h");
	});

	it("switches to days exactly at 24h", () => {
		expect(ago(DAY)).toBe("1d");
		expect(ago(6 * DAY)).toBe("6d");
	});

	it("switches to weeks at 7d and stays weeks below 30d", () => {
		expect(ago(7 * DAY)).toBe("1w");
		expect(ago(29 * DAY)).toBe("4w");
	});

	it("switches to months at 30d and stays months below a year", () => {
		expect(ago(30 * DAY)).toBe("1mo");
		expect(ago(364 * DAY)).toBe("12mo");
	});

	it("switches to years at 365d", () => {
		expect(ago(365 * DAY)).toBe("1y");
		expect(ago(2 * 365 * DAY)).toBe("2y");
	});
});

describe("compactAge in other UI languages", () => {
	it("uses the locale's own units instead of Latin suffixes", () => {
		expect(compactAge(NOW - 5 * MIN, "ja")).toBe("5分");
		expect(compactAge(NOW - 3 * HOUR, "ja")).toBe("3時間");
		expect(compactAge(NOW - 5 * MIN, "ru")).toBe("5 мин");
		expect(compactAge(NOW - 5 * MIN, "ar")).not.toMatch(/[a-z]/u);
	});

	it("says the locale's word for now, not the English literal", () => {
		expect(compactAge(NOW, "ja")).toBe("今");
		expect(compactAge(NOW, "ru")).toBe("сейчас");
		expect(compactAge(NOW, "ar")).toBe("الآن");
	});
});

describe("compactAgo", () => {
	it("keeps the English compact phrase", () => {
		expect(compactAgo(NOW, "en")).toBe("just now");
		expect(compactAgo(NOW - 5 * MIN, "en")).toBe("5m ago");
		expect(compactAgo(NOW - 30 * DAY, "en")).toBe("1mo ago");
	});

	it("uses the locale's relative phrase elsewhere", () => {
		expect(compactAgo(NOW - 5 * MIN, "ja")).toBe("5 分前");
		expect(compactAgo(NOW - 5 * MIN, "ru")).toBe("5 мин. назад");
		expect(compactAgo(NOW - 3 * HOUR, "ar")).toBe("قبل 3 ساعات");
		expect(compactAgo(NOW, "ja")).toBe("今");
	});
});

describe("presenceAgo", () => {
	it("counts seconds before falling back to compactAgo", () => {
		expect(presenceAgo(NOW - 5 * SEC, "en")).toBe("now");
		expect(presenceAgo(NOW - 12 * SEC, "en")).toBe("12s ago");
		expect(presenceAgo(NOW - 5 * MIN, "en")).toBe("5m ago");
		expect(presenceAgo(NOW - 12 * SEC, "ja")).toBe("12 秒前");
		expect(presenceAgo(NOW - 5 * SEC, "ja")).toBe("今");
	});
});
