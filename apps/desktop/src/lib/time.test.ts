// apps/desktop/src/lib/time.test.ts
//
// Tests for the compact relative-age formatter used by the sidebar/recents.
// Every branch is a boundary (59s vs 60s, 6d vs 7d, 29d vs 30d, 364d vs 365d),
// so the clock must be pinned — a racing internal Date.now() would otherwise
// flip a boundary a few ms after the value we pass in. We freeze time with
// setSystemTime and restore it in afterEach so no frozen clock leaks into
// sibling test files sharing this bun process.

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { compactAge } from "./time.ts";

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
