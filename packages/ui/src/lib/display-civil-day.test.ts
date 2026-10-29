import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { displayCivilDay, displayDayStart } from "./display-civil-day.ts";
import { resetTimezone, setTimezonePreference } from "./timezone.ts";

// `displayCivilDay` and `displayDayStart` convert between an instant and the
// plain local-midnight `Date` a calendar control draws a day column with. The
// column's local year, month and day are the civil date in the DISPLAY zone;
// the machine's zone only decides which instant the column object holds.
//
// The machine's zone is set per case through `process.env.TZ` (Bun re-reads it
// on assignment). Every case that is not about equal zones picks a display zone
// that disagrees with the machine, so an implementation that reads the `Date`
// getters or the UTC fields cannot pass. Where the machine's own answer is the
// point of the case, a premise assertion states it first, which proves the two
// zones really do disagree on the host that runs the file. If an earlier file in
// the same process has already made `TZ` unusable, the last block of the file
// runs these same cases in a fresh process instead of failing on a stale zone.

const originalMachineZone = process.env.TZ;
const startingZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Bun stops honouring `process.env.TZ` assignments for the rest of the process
// once a variable that was assigned is then deleted, and several test files do
// that in their teardown. So a case never deletes it: it assigns the zone the
// process started in.
function restoreMachineZone(): void {
	process.env.TZ = originalMachineZone ?? startingZone;
}

function useZones(machine: string, display: string): void {
	process.env.TZ = machine;
	setTimezonePreference(display);
}

/** Whether this process still follows `process.env.TZ` (see above). */
function machineZoneIsSwitchable(): boolean {
	process.env.TZ = "Pacific/Kiritimati";
	const follows = new Date(Date.UTC(2026, 5, 10)).getTimezoneOffset() === -840;
	restoreMachineZone();
	return follows;
}

afterEach(() => {
	// Restore the machine first so the zone `resetTimezone` mirrors onto the
	// document is the process's own.
	restoreMachineZone();
	resetTimezone();
});
afterAll(restoreMachineZone);

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** The column's local civil date, `YYYY-MM-DD`. */
function localDate(day: Date): string {
	return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** The column's local date and time of day, to the millisecond. */
function localStamp(day: Date): string {
	return `${localDate(day)}T${pad(day.getHours())}:${pad(day.getMinutes())}:${pad(day.getSeconds())}.${pad(day.getMilliseconds(), 3)}`;
}

/** The civil date the display zone files an instant under. */
const civilDateAt = (iso: string) =>
	localDate(displayCivilDay(Date.parse(iso)));

/** The civil date the machine's own clock files an instant under. */
const machineDateAt = (iso: string) => localDate(new Date(Date.parse(iso)));

/** A day column built the way a calendar does: the machine's `y-m-d` midnight. */
const column = (year: number, month: number, day: number) =>
	new Date(year, month - 1, day);

/** First instant of a civil date in the display zone, as ISO text. */
const startOf = (year: number, month: number, day: number) =>
	displayDayStart(column(year, month, day)).toISOString();

// 2026-06-10T20:00Z: June 10 16:00 in New York, June 11 05:00 in Tokyo,
// June 10 10:00 in Honolulu and June 11 01:30 in Kolkata.
const NOON_ISH = "2026-06-10T20:00:00.000Z";

// A sweep over half-hour steps around every clock change and calendar rollover
// above. For each instant the display zone's own clock (read with `Intl`, which
// shares no code with the helpers) names the civil date; the helpers must agree
// that the day starts at its first instant and ends one millisecond before the
// next day starts.

interface Wall {
	date: number;
	day: number;
	month: number;
	year: number;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallAt(zone: string, at: number): Wall {
	let formatter = wallFormatters.get(zone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
		});
		wallFormatters.set(zone, formatter);
	}
	const parts = formatter.formatToParts(new Date(at));
	const read = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value);
	const year = read("year");
	const month = read("month");
	const day = read("day");
	return { year, month, day, date: year * 10_000 + month * 100 + day };
}

const HALF_HOUR_MS = 30 * 60_000;

const SWEEP_WINDOWS: readonly (readonly [string, string])[] = [
	["2026-03-06T00:00:00Z", "2026-03-11T00:00:00Z"],
	["2026-03-27T00:00:00Z", "2026-04-01T00:00:00Z"],
	["2026-04-03T00:00:00Z", "2026-04-08T00:00:00Z"],
	["2026-10-02T00:00:00Z", "2026-10-07T00:00:00Z"],
	["2026-10-23T00:00:00Z", "2026-10-28T00:00:00Z"],
	["2026-10-30T00:00:00Z", "2026-11-04T00:00:00Z"],
	["2026-12-30T00:00:00Z", "2027-01-03T00:00:00Z"],
	["2028-02-27T00:00:00Z", "2028-03-02T00:00:00Z"],
];

function sweepViolations(machine: string, display: string): string[] {
	useZones(machine, display);
	const zone = display === "system" ? machine : display;
	const ownZone = zone === machine;
	const violations: string[] = [];
	for (const [from, to] of SWEEP_WINDOWS) {
		for (let at = Date.parse(from); at < Date.parse(to); at += HALF_HOUR_MS) {
			const label = `${new Date(at).toISOString()} ${machine} machine, ${display} display`;
			const wall = wallAt(zone, at);
			const day = displayCivilDay(at);
			const expectedColumn = new Date(wall.year, wall.month - 1, wall.day);
			if (day.getTime() !== expectedColumn.getTime()) {
				violations.push(
					`${label}: column ${localStamp(day)}, expected ${localStamp(expectedColumn)}`
				);
				continue;
			}
			const start = displayDayStart(day).getTime();
			const nextStart = displayDayStart(
				new Date(wall.year, wall.month - 1, wall.day + 1)
			).getTime();
			if (!(start <= at && at < nextStart)) {
				violations.push(
					`${label}: not inside [${new Date(start).toISOString()}, ${new Date(nextStart).toISOString()})`
				);
			}
			if (wallAt(zone, start).date !== wall.date) {
				violations.push(
					`${label}: start ${new Date(start).toISOString()} is not on ${wall.date}`
				);
			}
			if (wallAt(zone, start - 1).date >= wall.date) {
				violations.push(
					`${label}: the millisecond before start is still on ${wall.date}`
				);
			}
			if (wallAt(zone, nextStart - 1).date !== wall.date) {
				violations.push(
					`${label}: the millisecond before the next start is not on ${wall.date}`
				);
			}
			if (ownZone && start !== day.getTime()) {
				violations.push(
					`${label}: in the machine's own zone the column ${day.toISOString()} is not its own start ${new Date(start).toISOString()}`
				);
			}
		}
	}
	return violations;
}

const FRESH_PROCESS = "RYU_DISPLAY_CIVIL_DAY_FRESH_PROCESS";

function registerCases(): void {
	describe("displayCivilDay across zones", () => {
		it("files an instant on the display zone's day when the machine is a day behind", () => {
			useZones("America/New_York", "Asia/Tokyo");
			expect(machineDateAt(NOON_ISH)).toBe("2026-06-10");
			expect(localStamp(displayCivilDay(Date.parse(NOON_ISH)))).toBe(
				"2026-06-11T00:00:00.000"
			);
		});

		it("files an instant on the display zone's day when the machine is a day ahead", () => {
			useZones("Asia/Tokyo", "Pacific/Honolulu");
			expect(machineDateAt(NOON_ISH)).toBe("2026-06-11");
			expect(localStamp(displayCivilDay(Date.parse(NOON_ISH)))).toBe(
				"2026-06-10T00:00:00.000"
			);
		});

		it("returns a local-midnight column whatever time of day the instant carries", () => {
			useZones("America/New_York", "Asia/Tokyo");
			expect(
				localStamp(displayCivilDay(Date.parse("2026-06-10T15:00:00.000Z")))
			).toBe("2026-06-11T00:00:00.000");
			expect(
				localStamp(displayCivilDay(Date.parse("2026-06-11T14:59:59.999Z")))
			).toBe("2026-06-11T00:00:00.000");
		});

		it("moves to the next day at the display zone's midnight in a half-hour zone", () => {
			useZones("America/New_York", "Asia/Kolkata");
			expect(machineDateAt("2026-06-10T18:30:00.000Z")).toBe("2026-06-10");
			expect(civilDateAt("2026-06-10T18:29:59.999Z")).toBe("2026-06-10");
			expect(civilDateAt("2026-06-10T18:30:00.000Z")).toBe("2026-06-11");
			expect(civilDateAt(NOON_ISH)).toBe("2026-06-11");
		});

		it("reads a Date and a millisecond count alike and leaves the Date untouched", () => {
			useZones("America/New_York", "Asia/Tokyo");
			const instant = new Date(NOON_ISH);
			const fromDate = displayCivilDay(instant);
			const fromNumber = displayCivilDay(instant.getTime());
			expect(localStamp(fromDate)).toBe("2026-06-11T00:00:00.000");
			expect(fromDate.getTime()).toBe(fromNumber.getTime());
			expect(instant.toISOString()).toBe(NOON_ISH);
			expect(fromDate).not.toBe(instant);
		});
	});

	describe("displayCivilDay month and year rollover", () => {
		// New York machine, Tokyo display: Tokyo's midnight is 15:00Z the day before.
		it.each([
			["the last second of January", "2026-01-31T14:59:59.999Z", "2026-01-31"],
			[
				"the first instant of February",
				"2026-01-31T15:00:00.000Z",
				"2026-02-01",
			],
			[
				"the last instant of a common February",
				"2026-02-28T14:59:59.999Z",
				"2026-02-28",
			],
			[
				"the first instant of March after a common February",
				"2026-02-28T15:00:00.000Z",
				"2026-03-01",
			],
			[
				"the first instant of a leap day",
				"2028-02-28T15:00:00.000Z",
				"2028-02-29",
			],
			[
				"the first instant of March after a leap day",
				"2028-02-29T15:00:00.000Z",
				"2028-03-01",
			],
			[
				"the first instant of May after a 30-day April",
				"2026-04-30T15:00:00.000Z",
				"2026-05-01",
			],
			[
				"the first instant of July after a 30-day June",
				"2026-06-30T15:00:00.000Z",
				"2026-07-01",
			],
			["the last instant of 2026", "2026-12-31T14:59:59.999Z", "2026-12-31"],
			["the first instant of 2027", "2026-12-31T15:00:00.000Z", "2027-01-01"],
		])("%s", (_label, iso, expected) => {
			useZones("America/New_York", "Asia/Tokyo");
			expect(civilDateAt(iso)).toBe(expected);
		});

		it("rolls the year back when the display zone is the one still in the old year", () => {
			// Tokyo machine, Honolulu display: Jan 1 14:00 in Tokyo is Dec 31 19:00 in Honolulu.
			useZones("Asia/Tokyo", "Pacific/Honolulu");
			expect(machineDateAt("2027-01-01T05:00:00.000Z")).toBe("2027-01-01");
			expect(civilDateAt("2027-01-01T05:00:00.000Z")).toBe("2026-12-31");
			expect(civilDateAt("2027-01-01T09:59:59.999Z")).toBe("2026-12-31");
			expect(civilDateAt("2027-01-01T10:00:00.000Z")).toBe("2027-01-01");
		});

		it("keeps December's month number when the machine is already in January", () => {
			useZones("Asia/Tokyo", "America/New_York");
			const december = displayCivilDay(Date.parse("2026-12-31T23:30:00.000Z"));
			expect(december.getMonth()).toBe(11);
			expect(december.getDate()).toBe(31);
			expect(december.getFullYear()).toBe(2026);
		});
	});

	describe("displayCivilDay across display-zone clock changes", () => {
		// Machine zones without a clock change, so only the display zone moves.
		it.each([
			[
				"the last instant before New York's spring-forward day",
				"2026-03-08T04:59:59.999Z",
				"2026-03-07",
			],
			[
				"New York's first instant of the 23-hour day",
				"2026-03-08T05:00:00.000Z",
				"2026-03-08",
			],
			[
				"the last instant before the clocks go forward",
				"2026-03-08T06:59:59.999Z",
				"2026-03-08",
			],
			[
				"the first instant after the clocks went forward",
				"2026-03-08T07:00:00.000Z",
				"2026-03-08",
			],
			[
				"the last instant of the 23-hour day",
				"2026-03-09T03:59:59.999Z",
				"2026-03-08",
			],
			[
				"the first instant of the day after",
				"2026-03-09T04:00:00.000Z",
				"2026-03-09",
			],
		])("New York spring forward: %s", (_label, iso, expected) => {
			useZones("Asia/Tokyo", "America/New_York");
			expect(civilDateAt(iso)).toBe(expected);
		});

		it.each([
			[
				"the last instant before New York's fall-back day",
				"2026-11-01T03:59:59.999Z",
				"2026-10-31",
			],
			[
				"New York's first instant of the 25-hour day",
				"2026-11-01T04:00:00.000Z",
				"2026-11-01",
			],
			[
				"the first 01:30 (daylight time)",
				"2026-11-01T05:30:00.000Z",
				"2026-11-01",
			],
			[
				"the second 01:30 (standard time)",
				"2026-11-01T06:30:00.000Z",
				"2026-11-01",
			],
			[
				"the last instant of the 25-hour day",
				"2026-11-02T04:59:59.999Z",
				"2026-11-01",
			],
			[
				"the first instant of the day after",
				"2026-11-02T05:00:00.000Z",
				"2026-11-02",
			],
		])("New York fall back: %s", (_label, iso, expected) => {
			useZones("Asia/Tokyo", "America/New_York");
			expect(civilDateAt(iso)).toBe(expected);
		});

		it.each([
			[
				"the last instant of Apr 4 before Sydney's 25-hour day",
				"2026-04-04T12:59:59.999Z",
				"2026-04-04",
			],
			[
				"the first instant of Sydney's 25-hour Apr 5",
				"2026-04-04T13:00:00.000Z",
				"2026-04-05",
			],
			["the last instant of Apr 5", "2026-04-05T13:59:59.999Z", "2026-04-05"],
			["the first instant of Apr 6", "2026-04-05T14:00:00.000Z", "2026-04-06"],
			[
				"the last instant of Oct 3 before Sydney's 23-hour day",
				"2026-10-03T13:59:59.999Z",
				"2026-10-03",
			],
			[
				"the first instant of Sydney's 23-hour Oct 4",
				"2026-10-03T14:00:00.000Z",
				"2026-10-04",
			],
			["the last instant of Oct 4", "2026-10-04T12:59:59.999Z", "2026-10-04"],
			["the first instant of Oct 5", "2026-10-04T13:00:00.000Z", "2026-10-05"],
		])("Sydney, a southern-hemisphere change in both directions: %s", (_label, iso, expected) => {
			useZones("America/New_York", "Australia/Sydney");
			expect(civilDateAt(iso)).toBe(expected);
		});

		it.each([
			[
				"the last instant of Oct 4 on Lord Howe's 23.5-hour day",
				"2026-10-04T12:59:59.999Z",
				"2026-10-04",
			],
			["the first instant of Oct 5", "2026-10-04T13:00:00.000Z", "2026-10-05"],
			[
				"the last instant of Apr 5 on Lord Howe's 24.5-hour day",
				"2026-04-05T13:29:59.999Z",
				"2026-04-05",
			],
			["the first instant of Apr 6", "2026-04-05T13:30:00.000Z", "2026-04-06"],
		])("Lord Howe, a half-hour clock change: %s", (_label, iso, expected) => {
			useZones("America/New_York", "Australia/Lord_Howe");
			expect(civilDateAt(iso)).toBe(expected);
		});

		it("builds the column on a machine day whose own clock changes", () => {
			// London goes forward on Mar 29 and back on Oct 25; both columns are still
			// the plain midnight of the display zone's date.
			useZones("Europe/London", "Asia/Tokyo");
			expect(
				localStamp(displayCivilDay(Date.parse("2026-03-28T15:00:00.000Z")))
			).toBe("2026-03-29T00:00:00.000");
			expect(
				localStamp(displayCivilDay(Date.parse("2026-10-24T15:00:00.000Z")))
			).toBe("2026-10-25T00:00:00.000");
		});
	});

	describe("displayDayStart across zones", () => {
		it("starts a day at the display zone's midnight, not the machine's", () => {
			useZones("America/New_York", "Asia/Tokyo");
			expect(startOf(2026, 6, 11)).toBe("2026-06-10T15:00:00.000Z");
			expect(column(2026, 6, 11).toISOString()).toBe(
				"2026-06-11T04:00:00.000Z"
			);
		});

		it("starts a day at the display zone's midnight when the machine is east of it", () => {
			useZones("Asia/Tokyo", "Pacific/Honolulu");
			expect(startOf(2026, 6, 10)).toBe("2026-06-10T10:00:00.000Z");
			expect(column(2026, 6, 10).toISOString()).toBe(
				"2026-06-09T15:00:00.000Z"
			);
		});

		it("starts a day on the half hour in a half-hour zone", () => {
			useZones("America/New_York", "Asia/Kolkata");
			expect(startOf(2026, 6, 11)).toBe("2026-06-10T18:30:00.000Z");
			expect(startOf(2026, 6, 10)).toBe("2026-06-09T18:30:00.000Z");
		});

		it("reads the column's local fields, not its UTC fields", () => {
			// A Tokyo midnight is the previous UTC day, and a New York one is the same
			// UTC day, so the date must come from the local getters in both.
			useZones("Asia/Tokyo", "America/New_York");
			expect(column(2027, 1, 1).getUTCFullYear()).toBe(2026);
			expect(startOf(2027, 1, 1)).toBe("2027-01-01T05:00:00.000Z");
			useZones("America/New_York", "Asia/Tokyo");
			expect(startOf(2027, 1, 1)).toBe("2026-12-31T15:00:00.000Z");
		});

		it("uses the column's civil date, not the instant the column holds", () => {
			useZones("America/New_York", "Asia/Tokyo");
			const sameDayEvening = new Date(2026, 5, 11, 23, 59, 59, 999);
			const sameDayMorning = new Date(2026, 5, 11, 0, 0, 0, 0);
			expect(displayDayStart(sameDayEvening).toISOString()).toBe(
				"2026-06-10T15:00:00.000Z"
			);
			expect(displayDayStart(sameDayMorning).toISOString()).toBe(
				"2026-06-10T15:00:00.000Z"
			);
		});

		it("does not change the column it is given", () => {
			useZones("America/New_York", "Asia/Tokyo");
			const day = column(2026, 6, 11);
			const before = day.getTime();
			displayDayStart(day);
			expect(day.getTime()).toBe(before);
		});
	});

	describe("displayDayStart month and year rollover", () => {
		// Tokyo display (UTC+9, no clock change): the day starts at 15:00Z the day before.
		it.each([
			["January 1", [2026, 1, 1], "2025-12-31T15:00:00.000Z"],
			["January 31", [2026, 1, 31], "2026-01-30T15:00:00.000Z"],
			["February 1", [2026, 2, 1], "2026-01-31T15:00:00.000Z"],
			[
				"March 1 after a common February",
				[2026, 3, 1],
				"2026-02-28T15:00:00.000Z",
			],
			["February 29 in a leap year", [2028, 2, 29], "2028-02-28T15:00:00.000Z"],
			[
				"March 1 after a leap February",
				[2028, 3, 1],
				"2028-02-29T15:00:00.000Z",
			],
			["May 1", [2026, 5, 1], "2026-04-30T15:00:00.000Z"],
			["July 1", [2026, 7, 1], "2026-06-30T15:00:00.000Z"],
			["December 25", [2026, 12, 25], "2026-12-24T15:00:00.000Z"],
			["December 31", [2026, 12, 31], "2026-12-30T15:00:00.000Z"],
			["January 1 of the next year", [2027, 1, 1], "2026-12-31T15:00:00.000Z"],
		] as const)("%s", (_label, [year, month, day], expected) => {
			useZones("America/New_York", "Asia/Tokyo");
			expect(startOf(year, month, day)).toBe(expected);
		});

		it("starts December 31 and January 1 in a zone behind the machine", () => {
			useZones("Asia/Tokyo", "Pacific/Honolulu");
			expect(startOf(2026, 12, 31)).toBe("2026-12-31T10:00:00.000Z");
			expect(startOf(2027, 1, 1)).toBe("2027-01-01T10:00:00.000Z");
		});
	});

	describe("displayDayStart across display-zone clock changes", () => {
		it("measures New York's spring-forward day as 23 hours", () => {
			useZones("Asia/Tokyo", "America/New_York");
			expect(startOf(2026, 3, 7)).toBe("2026-03-07T05:00:00.000Z");
			expect(startOf(2026, 3, 8)).toBe("2026-03-08T05:00:00.000Z");
			expect(startOf(2026, 3, 9)).toBe("2026-03-09T04:00:00.000Z");
		});

		it("measures New York's fall-back day as 25 hours", () => {
			useZones("Asia/Tokyo", "America/New_York");
			expect(startOf(2026, 10, 31)).toBe("2026-10-31T04:00:00.000Z");
			expect(startOf(2026, 11, 1)).toBe("2026-11-01T04:00:00.000Z");
			expect(startOf(2026, 11, 2)).toBe("2026-11-02T05:00:00.000Z");
		});

		it("moves London's midnight an hour at each change", () => {
			useZones("Asia/Tokyo", "Europe/London");
			expect(startOf(2026, 3, 29)).toBe("2026-03-29T00:00:00.000Z");
			expect(startOf(2026, 3, 30)).toBe("2026-03-29T23:00:00.000Z");
			expect(startOf(2026, 10, 25)).toBe("2026-10-24T23:00:00.000Z");
			expect(startOf(2026, 10, 26)).toBe("2026-10-26T00:00:00.000Z");
		});

		it("measures Sydney's 25-hour and 23-hour days in the southern hemisphere", () => {
			useZones("America/New_York", "Australia/Sydney");
			expect(startOf(2026, 4, 5)).toBe("2026-04-04T13:00:00.000Z");
			expect(startOf(2026, 4, 6)).toBe("2026-04-05T14:00:00.000Z");
			expect(startOf(2026, 10, 4)).toBe("2026-10-03T14:00:00.000Z");
			expect(startOf(2026, 10, 5)).toBe("2026-10-04T13:00:00.000Z");
		});

		it("measures Lord Howe's half-hour changes", () => {
			useZones("America/New_York", "Australia/Lord_Howe");
			expect(startOf(2026, 4, 5)).toBe("2026-04-04T13:00:00.000Z");
			expect(startOf(2026, 4, 6)).toBe("2026-04-05T13:30:00.000Z");
			expect(startOf(2026, 10, 4)).toBe("2026-10-03T13:30:00.000Z");
			expect(startOf(2026, 10, 5)).toBe("2026-10-04T13:00:00.000Z");
		});
	});

	describe("columns on a machine day whose own midnight is missing or repeated", () => {
		// The column's local midnight does not exist on these machine days, so the
		// column holds 01:00. The display zone is still addressed by its civil date.
		it("keeps the civil date when the machine skips midnight (Havana, March 8)", () => {
			useZones("America/Havana", "UTC");
			const day = displayCivilDay(Date.parse("2026-03-08T12:00:00.000Z"));
			expect(localDate(day)).toBe("2026-03-08");
			expect(day.getHours()).toBe(1);
			expect(displayDayStart(day).toISOString()).toBe(
				"2026-03-08T00:00:00.000Z"
			);
		});

		it("keeps the civil date when the machine skips midnight (Beirut, March 29)", () => {
			useZones("Asia/Beirut", "UTC");
			const day = displayCivilDay(Date.parse("2026-03-29T12:00:00.000Z"));
			expect(localDate(day)).toBe("2026-03-29");
			expect(day.getHours()).toBe(1);
			expect(displayDayStart(day).toISOString()).toBe(
				"2026-03-29T00:00:00.000Z"
			);
		});

		it("keeps the civil date when the machine repeats midnight (Havana, November 1)", () => {
			useZones("America/Havana", "UTC");
			const day = displayCivilDay(Date.parse("2026-11-01T12:00:00.000Z"));
			expect(localDate(day)).toBe("2026-11-01");
			expect(displayDayStart(day).toISOString()).toBe(
				"2026-11-01T00:00:00.000Z"
			);
		});

		it("starts a display-zone day that skips its own midnight at the first instant of that date", () => {
			// Havana's March 8 begins at 01:00 (05:00Z); the machine is elsewhere.
			useZones("Asia/Tokyo", "America/Havana");
			expect(startOf(2026, 3, 8)).toBe("2026-03-08T05:00:00.000Z");
			expect(startOf(2026, 3, 9)).toBe("2026-03-09T04:00:00.000Z");
			expect(civilDateAt("2026-03-08T04:59:59.999Z")).toBe("2026-03-07");
			expect(civilDateAt("2026-03-08T05:00:00.000Z")).toBe("2026-03-08");
		});
	});

	describe("when the display zone is the machine's own", () => {
		// New York machine; "system" and the explicit id must agree with each other
		// and with the machine's own `Date` constructor, across both clock changes.
		describe.each([
			"system",
			"America/New_York",
		])("display preference %s", (display) => {
			it("files an instant under the machine's own day", () => {
				useZones("America/New_York", display);
				expect(civilDateAt("2026-03-09T03:59:59.999Z")).toBe("2026-03-08");
				expect(civilDateAt("2026-03-09T04:00:00.000Z")).toBe("2026-03-09");
				expect(civilDateAt("2026-11-02T04:59:59.999Z")).toBe("2026-11-01");
				expect(civilDateAt("2026-11-02T05:00:00.000Z")).toBe("2026-11-02");
				expect(civilDateAt("2026-12-31T23:59:59.999Z")).toBe("2026-12-31");
				expect(civilDateAt("2027-01-01T05:00:00.000Z")).toBe("2027-01-01");
			});

			it("returns the machine's own midnight as the column", () => {
				useZones("America/New_York", display);
				expect(
					displayCivilDay(Date.parse("2026-06-10T20:00:00.000Z")).getTime()
				).toBe(new Date(2026, 5, 10).getTime());
				expect(
					localStamp(displayCivilDay(Date.parse("2026-06-10T20:00:00.000Z")))
				).toBe("2026-06-10T00:00:00.000");
			});

			it("starts a day at the machine's own midnight, including the 23-hour and 25-hour days", () => {
				useZones("America/New_York", display);
				expect(startOf(2026, 3, 8)).toBe("2026-03-08T05:00:00.000Z");
				expect(startOf(2026, 3, 9)).toBe("2026-03-09T04:00:00.000Z");
				expect(startOf(2026, 11, 1)).toBe("2026-11-01T04:00:00.000Z");
				expect(startOf(2026, 11, 2)).toBe("2026-11-02T05:00:00.000Z");
				expect(startOf(2026, 12, 31)).toBe(column(2026, 12, 31).toISOString());
				expect(startOf(2027, 1, 1)).toBe(column(2027, 1, 1).toISOString());
			});
		});

		it("reads a zone the runtime rejects as the machine's own", () => {
			useZones("Asia/Tokyo", "Not/AZone");
			expect(civilDateAt(NOON_ISH)).toBe("2026-06-11");
			expect(startOf(2026, 6, 11)).toBe("2026-06-10T15:00:00.000Z");
		});
	});

	describe("an invalid instant", () => {
		it("gives an invalid column instead of throwing or inventing a day", () => {
			useZones("America/New_York", "Asia/Tokyo");
			expect(Number.isNaN(displayCivilDay(Number.NaN).getTime())).toBe(true);
			expect(
				Number.isNaN(displayCivilDay(new Date("not a date")).getTime())
			).toBe(true);
		});

		it("gives an invalid start for an invalid column", () => {
			useZones("America/New_York", "Asia/Tokyo");
			expect(
				Number.isNaN(displayDayStart(new Date(Number.NaN)).getTime())
			).toBe(true);
		});
	});

	describe("half-hour sweep around every clock change and rollover", () => {
		it.each([
			["America/New_York", "Asia/Tokyo"],
			["Asia/Tokyo", "America/New_York"],
			["Pacific/Honolulu", "Australia/Sydney"],
			["Europe/London", "America/New_York"],
			["America/New_York", "Europe/London"],
			["America/New_York", "Australia/Lord_Howe"],
			["Asia/Tokyo", "Asia/Kolkata"],
			["America/Havana", "UTC"],
			["Asia/Beirut", "Australia/Sydney"],
			["Asia/Tokyo", "America/Havana"],
		] as const)("%s machine, %s display", (machine, display) => {
			expect(sweepViolations(machine, display)).toEqual([]);
		});

		it.each([
			["America/New_York", "system"],
			["America/New_York", "America/New_York"],
			["Europe/London", "system"],
			["Europe/London", "Europe/London"],
			["Australia/Sydney", "system"],
			["Australia/Sydney", "Australia/Sydney"],
			["Australia/Lord_Howe", "system"],
			["Australia/Lord_Howe", "Australia/Lord_Howe"],
			["America/Havana", "system"],
			["America/Havana", "America/Havana"],
			["Asia/Beirut", "system"],
			["Asia/Beirut", "Asia/Beirut"],
		] as const)("%s machine, %s display (its own zone)", (machine, display) => {
			expect(sweepViolations(machine, display)).toEqual([]);
		});
	});
}

if (!machineZoneIsSwitchable() && process.env[FRESH_PROCESS] !== "1") {
	// An earlier file in this process left `TZ` unusable, so the machine zone
	// cannot be varied here. Run the very same cases in a fresh process.
	it("runs every case in a fresh process because an earlier file left TZ unusable", () => {
		const child = Bun.spawnSync([process.execPath, "test", import.meta.path], {
			env: { ...process.env, [FRESH_PROCESS]: "1" },
			stderr: "pipe",
			stdout: "pipe",
		});
		const output = `${child.stdout.toString()}${child.stderr.toString()}`;
		if (child.exitCode !== 0) {
			throw new Error(output.slice(-4000));
		}
		expect(output).toMatch(/\d+ pass/);
		expect(output).toMatch(/ 0 fail/);
	});
} else {
	registerCases();
}
