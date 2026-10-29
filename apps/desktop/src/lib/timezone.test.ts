// apps/desktop/src/lib/timezone.test.ts
//
// The display time zone only earns its keep if the formatters actually shift
// with it and day buckets move too — a 09:00 Tokyo stamp filed under the
// machine's midnight would read "Yesterday". These pin both.
//
// bun's test runtime has no localStorage, which is exactly the "persistence
// unavailable" path the module already guards; the preference still lives in
// the module-level cache, so every assertion below is about behaviour, not
// storage.

import { afterEach, describe, expect, it } from "bun:test";
import * as timezoneModule from "./timezone.ts";
import {
	DEFAULT_TIMEZONE,
	displayWallClock,
	effectiveTimeZone,
	formatDate,
	formatDateTime,
	formatTime,
	getTimezonePreference,
	resetTimezone,
	resolveTimeZone,
	setTimezonePreference,
	startOfDisplayCivilDayMs,
	startOfTodayMs,
	timezoneLabel,
	timezoneOptions,
	zoneOffsetLabel,
} from "./timezone.ts";

// 2026-01-15T23:30Z — deliberately late enough in the UTC day that Tokyo
// (+09:00) is already on the 16th and Los Angeles (-08:00) is still on the 15th.
const NOW = new Date("2026-01-15T23:30:00.000Z").getTime();

afterEach(() => {
	resetTimezone();
});

describe("timezone preference", () => {
	it("defaults to the system sentinel and resolves to no explicit zone", () => {
		expect(getTimezonePreference()).toBe(DEFAULT_TIMEZONE);
		expect(resolveTimeZone()).toBeUndefined();
	});

	it("resolves an explicit zone once set", () => {
		setTimezonePreference("Asia/Tokyo");
		expect(getTimezonePreference()).toBe("Asia/Tokyo");
		expect(resolveTimeZone()).toBe("Asia/Tokyo");
		expect(effectiveTimeZone()).toBe("Asia/Tokyo");
	});

	it("reset returns to the system sentinel", () => {
		setTimezonePreference("Asia/Tokyo");
		resetTimezone();
		expect(getTimezonePreference()).toBe(DEFAULT_TIMEZONE);
	});
});

describe("formatters", () => {
	it("renders the same instant differently per zone", () => {
		setTimezonePreference("Asia/Tokyo");
		const tokyo = formatTime(NOW, {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		setTimezonePreference("America/Los_Angeles");
		const la = formatTime(NOW, {
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});

		expect(tokyo).toBe("08:30");
		expect(la).toBe("15:30");
	});

	it("crosses the date line for the date part too", () => {
		setTimezonePreference("Asia/Tokyo");
		expect(
			formatDate(NOW, { year: "numeric", month: "2-digit", day: "2-digit" })
		).toContain("16");
		setTimezonePreference("America/Los_Angeles");
		expect(
			formatDate(NOW, { year: "numeric", month: "2-digit", day: "2-digit" })
		).toContain("15");
	});

	it("keeps date-only values on their calendar day in every display zone", () => {
		setTimezonePreference("America/Los_Angeles");
		expect(
			formatDate("2026-01-15", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			})
		).toContain("15");
	});

	it("returns an empty string for an unparseable value instead of 'Invalid Date'", () => {
		expect(formatDateTime("not a date")).toBe("");
		expect(formatDate(Number.NaN)).toBe("");
	});

	it("falls back rather than throwing on an unsupported zone id", () => {
		setTimezonePreference("Mars/Olympus_Mons");
		expect(formatDateTime(NOW)).not.toBe("");
	});
});

describe("startOfTodayMs", () => {
	it("is midnight in the selected zone, not the machine's", () => {
		setTimezonePreference("Asia/Tokyo");
		// 2026-01-16T00:00 Tokyo == 2026-01-15T15:00Z
		expect(startOfTodayMs(NOW)).toBe(Date.parse("2026-01-15T15:00:00.000Z"));

		setTimezonePreference("America/Los_Angeles");
		// 2026-01-15T00:00 LA == 2026-01-15T08:00Z
		expect(startOfTodayMs(NOW)).toBe(Date.parse("2026-01-15T08:00:00.000Z"));
	});

	it("handles a zone on a half-hour offset", () => {
		setTimezonePreference("Asia/Kolkata");
		// 2026-01-16T00:00 +05:30 == 2026-01-15T18:30Z
		expect(startOfTodayMs(NOW)).toBe(Date.parse("2026-01-15T18:30:00.000Z"));
	});

	it("lands exactly on midnight when the instant already is midnight there", () => {
		setTimezonePreference("UTC");
		const midnight = Date.parse("2026-01-15T00:00:00.000Z");
		expect(startOfTodayMs(midnight)).toBe(midnight);
	});
});

describe("the option list", () => {
	it("pins System first and sorts the rest west to east", () => {
		const options = timezoneOptions();
		expect(options[0].value).toBe("system");
		expect(options[0].label).toStartWith("System (");

		const rest = options.slice(1);
		expect(rest.length).toBeGreaterThan(10);
		for (let i = 1; i < rest.length; i++) {
			expect(rest[i].offsetMinutes).toBeGreaterThanOrEqual(
				rest[i - 1].offsetMinutes
			);
		}
	});

	it("labels each zone with a padded offset and a readable name", () => {
		const london = timezoneOptions().find((o) => o.value === "Europe/London");
		expect(london?.label).toMatch(/^\(GMT[+-]\d{2}:\d{2}\) Europe\/London$/);

		const newYork = timezoneOptions().find(
			(o) => o.value === "America/New_York"
		);
		expect(newYork?.label).toContain("America/New York");
	});

	it("reads a zone's current offset", () => {
		expect(zoneOffsetLabel("UTC", new Date(NOW))).toBe("GMT+00:00");
		expect(zoneOffsetLabel("Asia/Tokyo", new Date(NOW))).toBe("GMT+09:00");
		expect(zoneOffsetLabel("Asia/Kolkata", new Date(NOW))).toBe("GMT+05:30");
		expect(zoneOffsetLabel("America/Los_Angeles", new Date(NOW))).toBe(
			"GMT-08:00"
		);
	});

	it("echoes an unknown stored value back as its own label", () => {
		expect(timezoneLabel("Mars/Olympus_Mons")).toBe("Mars/Olympus_Mons");
	});

	it("reuses the list within a minute and refreshes the next minute", () => {
		const same = timezoneOptions(NOW);
		expect(timezoneOptions(NOW + 30_000)).toBe(same);
		expect(timezoneOptions(NOW + 60_000)).not.toBe(same);
	});

	for (const transition of [
		{
			name: "spring",
			before: "2026-03-08T06:59:30Z",
			after: "2026-03-08T07:00:30Z",
			previous: -300,
			next: -240,
		},
		{
			name: "autumn",
			before: "2026-11-01T05:59:30Z",
			after: "2026-11-01T06:00:30Z",
			previous: -240,
			next: -300,
		},
	]) {
		it(`refreshes New York's ${transition.name} offset and ordering within one UTC day`, () => {
			const before = new Date(transition.before).getTime();
			const after = new Date(transition.after).getTime();
			expect(Math.floor(before / 86_400_000)).toBe(
				Math.floor(after / 86_400_000)
			);
			const priorOptions = timezoneOptions(before);
			const previous = priorOptions.find(
				(option) => option.value === "America/New_York"
			);
			expect(previous?.offsetMinutes).toBe(transition.previous);
			const current = timezoneOptions(after);
			expect(current.map((option) => option.value).sort()).toEqual(
				priorOptions.map((option) => option.value).sort()
			);
			const newYork = current.find(
				(option) => option.value === "America/New_York"
			);
			expect(newYork?.offsetMinutes).toBe(transition.next);
			expect(newYork?.label).toBe(
				`(${zoneOffsetLabel("America/New_York", new Date(after))}) America/New York`
			);
			for (let index = 2; index < current.length; index++) {
				expect(current[index].offsetMinutes).toBeGreaterThanOrEqual(
					current[index - 1].offsetMinutes
				);
			}
		});
	}
});

describe("display-zone civil day boundaries", () => {
	for (const day of [
		{
			name: "New York spring",
			zone: "America/New_York",
			before: "2026-03-08T06:30:00Z",
			after: "2026-03-08T16:00:00Z",
			start: "2026-03-08T05:00:00Z",
		},
		{
			name: "New York autumn",
			zone: "America/New_York",
			before: "2026-11-01T04:30:00Z",
			after: "2026-11-01T17:00:00Z",
			start: "2026-11-01T04:00:00Z",
		},
		{
			name: "Sao Paulo missing midnight",
			zone: "America/Sao_Paulo",
			before: "2018-11-04T03:00:00Z",
			after: "2018-11-04T15:00:00Z",
			start: "2018-11-04T03:00:00Z",
		},
		{
			name: "Havana repeated midnight",
			zone: "America/Havana",
			before: "2026-11-01T04:30:00Z",
			after: "2026-11-01T17:00:00Z",
			start: "2026-11-01T04:00:00Z",
		},
		{
			name: "Lord Howe half-hour spring",
			zone: "Australia/Lord_Howe",
			before: "2026-10-03T14:00:00Z",
			after: "2026-10-04T01:00:00Z",
			start: "2026-10-03T13:30:00Z",
		},
	]) {
		it(`keeps ${day.name} in one civil day with its earliest valid start`, () => {
			setTimezonePreference(day.zone);
			const start = Date.parse(day.start);
			// Query after the transition first, before this zone/date can be cached.
			expect(startOfTodayMs(Date.parse(day.after))).toBe(start);
			expect(startOfTodayMs(Date.parse(day.before))).toBe(start);
			expect(startOfTodayMs(start)).toBe(start);
			expect(startOfTodayMs(start - 1)).toBeLessThan(start);
		});
	}
});

describe("historical civil midnight identity", () => {
	it("selects Anchorage's first midnight across its 1867 midday date-line rollback", () => {
		setTimezonePreference("America/Anchorage");
		const first = Date.parse("1867-10-18T09:59:36Z");
		// The rollback occurrence is the cold query, not a warmed cache hit.
		expect(startOfTodayMs(Date.parse("1867-10-19T12:00:00Z"))).toBe(first);
		expect(startOfTodayMs(Date.parse("1867-10-18T12:00:00Z"))).toBe(first);
	});
	it("keeps BC and AD civil dates distinct in the day cache", () => {
		setTimezonePreference("UTC");
		const bc = Date.parse("0000-01-15T12:00:00Z");
		const ad = Date.parse("0001-01-15T12:00:00Z");
		expect(startOfTodayMs(bc)).toBe(Date.parse("0000-01-15T00:00:00Z"));
		expect(startOfTodayMs(ad)).toBe(Date.parse("0001-01-15T00:00:00Z"));
		expect(startOfTodayMs(bc)).not.toBe(startOfTodayMs(ad));
	});
});

describe("previous display civil day", () => {
	it("uses calendar Yesterday across New York's spring and autumn transitions", () => {
		const helper = (
			timezoneModule as unknown as {
				startOfDisplayDayMs: (now: number, daysBefore: number) => number;
			}
		).startOfDisplayDayMs;
		expect(helper).toBeFunction();
		setTimezonePreference("America/New_York");
		expect(helper(Date.parse("2026-03-09T16:00:00Z"), 1)).toBe(
			Date.parse("2026-03-08T05:00:00Z")
		);
		expect(helper(Date.parse("2026-11-02T17:00:00Z"), 1)).toBe(
			Date.parse("2026-11-01T04:00:00Z")
		);
	});
	it("collapses Apia's skipped civil date to the next valid day's start", () => {
		const helper = (
			timezoneModule as unknown as {
				startOfDisplayDayMs: (now: number, daysBefore: number) => number;
			}
		).startOfDisplayDayMs;
		expect(helper).toBeFunction();
		setTimezonePreference("Pacific/Apia");
		const now = Date.parse("2011-12-30T22:00:00Z");
		expect(helper(now, 0)).toBe(Date.parse("2011-12-30T10:00:00Z"));
		expect(helper(now, 1)).toBe(helper(now, 0));
	});
});

describe("next display civil day", () => {
	for (const [name, zone, now, expected] of [
		[
			"spring 23-hour day",
			"America/New_York",
			"2026-03-08T05:00:00Z",
			"2026-03-09T04:00:00Z",
		],
		[
			"autumn 25-hour day",
			"America/New_York",
			"2026-11-01T04:00:00Z",
			"2026-11-02T05:00:00Z",
		],
		[
			"skipped Apia date",
			"Pacific/Apia",
			"2011-12-29T10:00:00Z",
			"2011-12-30T10:00:00Z",
		],
		[
			"Havana repeated midnight",
			"America/Havana",
			"2026-11-01T04:30:00Z",
			"2026-11-02T05:00:00Z",
		],
	] as const) {
		it(`schedules ${name} at the next valid civil date`, () => {
			setTimezonePreference(zone);
			expect(timezoneModule.nextDisplayDayBoundaryMs(Date.parse(now))).toBe(
				Date.parse(expected)
			);
		});
	}
});

describe("display-zone wall clock", () => {
	// 2026-06-10T22:30Z: Wednesday 15:30 in Los Angeles, Thursday 07:30 in Tokyo.
	const instant = Date.parse("2026-06-10T22:30:00.000Z");

	it("reads an instant's civil date and clock in the display zone", () => {
		setTimezonePreference("Asia/Tokyo");
		expect(displayWallClock(instant)).toEqual({
			year: 2026,
			month: 6,
			day: 11,
			hour: 7,
			minute: 30,
			second: 0,
		});
		setTimezonePreference("America/Los_Angeles");
		expect(displayWallClock(new Date(instant))).toEqual({
			year: 2026,
			month: 6,
			day: 10,
			hour: 15,
			minute: 30,
			second: 0,
		});
	});

	it("reads a half-hour zone's minutes and a date-line zone's date", () => {
		setTimezonePreference("Asia/Kolkata");
		expect(displayWallClock(instant)).toMatchObject({
			day: 11,
			hour: 4,
			minute: 0,
		});
		setTimezonePreference("Pacific/Kiritimati");
		expect(displayWallClock(instant)).toMatchObject({
			day: 11,
			hour: 12,
			minute: 30,
		});
	});

	it("follows the machine's own clock while the preference is system", () => {
		const local = new Date(instant);
		expect(displayWallClock(instant)).toEqual({
			year: local.getFullYear(),
			month: local.getMonth() + 1,
			day: local.getDate(),
			hour: local.getHours(),
			minute: local.getMinutes(),
			second: local.getSeconds(),
		});
	});

	it("reads midnight as hour 0, never 24", () => {
		setTimezonePreference("UTC");
		expect(
			displayWallClock(Date.parse("2026-06-11T00:05:00.000Z"))
		).toMatchObject({
			day: 11,
			hour: 0,
			minute: 5,
		});
	});
});

describe("start of a display civil day", () => {
	for (const [name, zone, civil, expected] of [
		["Tokyo", "Asia/Tokyo", [2026, 6, 11], "2026-06-10T15:00:00Z"],
		[
			"Los Angeles",
			"America/Los_Angeles",
			[2026, 6, 10],
			"2026-06-10T07:00:00Z",
		],
		[
			"a New York spring-forward day",
			"America/New_York",
			[2026, 3, 8],
			"2026-03-08T05:00:00Z",
		],
		[
			"the New York day after it",
			"America/New_York",
			[2026, 3, 9],
			"2026-03-09T04:00:00Z",
		],
		[
			"a New York fall-back day",
			"America/New_York",
			[2026, 11, 1],
			"2026-11-01T04:00:00Z",
		],
		[
			"Lord Howe's half-hour spring",
			"Australia/Lord_Howe",
			[2026, 10, 4],
			"2026-10-03T13:30:00Z",
		],
		[
			"Apia's skipped date, filed under the next valid day",
			"Pacific/Apia",
			[2011, 12, 30],
			"2011-12-30T10:00:00Z",
		],
	] as const) {
		it(`is the first instant of ${name}`, () => {
			setTimezonePreference(zone);
			const [year, month, day] = civil;
			expect(startOfDisplayCivilDayMs(year, month, day)).toBe(
				Date.parse(expected)
			);
		});
	}

	it("agrees with the start of the day that an instant's own civil date names", () => {
		setTimezonePreference("Asia/Tokyo");
		const instant = Date.parse("2026-06-10T22:30:00.000Z");
		const { year, month, day } = displayWallClock(instant);
		expect(startOfDisplayCivilDayMs(year, month, day)).toBe(
			timezoneModule.startOfDisplayDayMs(instant)
		);
	});

	it("is the machine's own local midnight while the preference is system", () => {
		const local = new Date(2026, 5, 11);
		expect(startOfDisplayCivilDayMs(2026, 6, 11)).toBe(local.getTime());
	});
});
