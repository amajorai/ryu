import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

// The machine clock is New York. Every case below picks a display zone whose
// civil days differ from New York's, so a day filed, windowed or labelled with
// the machine's `Date` getters cannot pass.
const machineZone = process.env.TZ;
process.env.TZ = "America/New_York";
beforeAll(() => {
	process.env.TZ = "America/New_York";
});
afterAll(() => {
	if (machineZone === undefined) {
		Reflect.deleteProperty(process.env, "TZ");
	} else {
		process.env.TZ = machineZone;
	}
});

const {
	displayWallClock,
	resetTimezone,
	setTimezonePreference,
	startOfDisplayCivilDayMs,
} = await import("@ryu/ui/lib/timezone.ts");
const {
	civilDayKey,
	displayCivilDay,
	displayDayBounds,
	displayDayKey,
	displayMidday,
	displayToday,
	eventClock,
	isDisplayToday,
	minutesIntoDisplayDay,
} = await import("@/src/lib/calendar/display-days.ts");
const { buildCalendarEvents, eventDayKey, groupEventsByDay } = await import(
	"@/src/lib/calendar/events.ts"
);
const { viewDays, viewRange } = await import("@/src/lib/calendar/views.ts");
type ScheduledJob = import("@/src/lib/api/schedules.ts").ScheduledJob;

afterEach(() => {
	resetTimezone();
});

const iso = (ms: number) => new Date(ms).toISOString();

function job(
	overrides: Partial<ScheduledJob> & Pick<ScheduledJob, "schedule">
): ScheduledJob {
	return {
		appId: null,
		createdAt: "2026-06-01T00:00:00.000Z",
		enabled: true,
		history: [],
		id: "job",
		lastOutcome: null,
		lastRunAt: null,
		name: "Job",
		ownerApp: null,
		requireApproval: false,
		system: false,
		target: { type: "agent", agentId: "agent", prompt: "go" },
		updatedAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

// New York 18:30 on June 10 is already June 11 07:30 in Tokyo.
const LATE_RUN = Date.parse("2026-06-10T22:30:00.000Z");

test("an instant is filed under the display zone's civil day, in Tokyo, Los Angeles and the machine's own zone", () => {
	setTimezonePreference("Asia/Tokyo");
	expect(eventDayKey(new Date(LATE_RUN))).toBe("2026-5-11");
	expect(displayDayKey(LATE_RUN)).toBe("2026-5-11");
	setTimezonePreference("America/Los_Angeles");
	expect(eventDayKey(new Date(LATE_RUN))).toBe("2026-5-10");
	resetTimezone();
	// Left on "system" the day is New York's, where it is June 10.
	expect(eventDayKey(new Date(LATE_RUN))).toBe("2026-5-10");
});

test("left on system the shared helpers read the machine's own New York clock and midnights", () => {
	// 22:30Z is 18:30 in New York on June 10 (EDT, UTC-4).
	expect(displayWallClock(LATE_RUN)).toEqual({
		year: 2026,
		month: 6,
		day: 10,
		hour: 18,
		minute: 30,
		second: 0,
	});
	expect(iso(startOfDisplayCivilDayMs(2026, 6, 11))).toBe(
		"2026-06-11T04:00:00.000Z"
	);
	// New York's spring-forward day starts at 05:00Z and the next one at 04:00Z.
	expect(iso(startOfDisplayCivilDayMs(2026, 3, 8))).toBe(
		"2026-03-08T05:00:00.000Z"
	);
	expect(iso(startOfDisplayCivilDayMs(2026, 3, 9))).toBe(
		"2026-03-09T04:00:00.000Z"
	);
});

test("a day column keys by its own civil date and matches the instants filed on it", () => {
	setTimezonePreference("Asia/Tokyo");
	const column = displayCivilDay(LATE_RUN);
	expect([column.getFullYear(), column.getMonth(), column.getDate()]).toEqual([
		2026, 5, 11,
	]);
	// A column is a local-midnight Date, so date-fns can step and label it.
	expect(column.getHours()).toBe(0);
	expect(civilDayKey(column)).toBe(displayDayKey(LATE_RUN));
	expect(civilDayKey(new Date(2026, 5, 11))).toBe("2026-5-11");
});

test("today is the display zone's today, and a column is today only on that date", () => {
	// 2026-06-10T20:00Z: Wednesday 16:00 in New York, Thursday 05:00 in Tokyo.
	const now = Date.parse("2026-06-10T20:00:00.000Z");
	setTimezonePreference("Asia/Tokyo");
	expect(civilDayKey(displayToday(now))).toBe("2026-5-11");
	expect(isDisplayToday(new Date(2026, 5, 11), now)).toBe(true);
	expect(isDisplayToday(new Date(2026, 5, 10), now)).toBe(false);
	resetTimezone();
	expect(isDisplayToday(new Date(2026, 5, 10), now)).toBe(true);
	expect(isDisplayToday(new Date(2026, 5, 11), now)).toBe(false);
});

test("a column's bounds are the display zone's midnights, 23 hours long on Berlin's spring-forward day", () => {
	setTimezonePreference("Asia/Tokyo");
	const tokyo = displayDayBounds(new Date(2026, 5, 11));
	expect([iso(tokyo.start.getTime()), iso(tokyo.end.getTime())]).toEqual([
		"2026-06-10T15:00:00.000Z",
		"2026-06-11T15:00:00.000Z",
	]);
	setTimezonePreference("Europe/Berlin");
	const spring = displayDayBounds(new Date(2026, 2, 29));
	expect([iso(spring.start.getTime()), iso(spring.end.getTime())]).toEqual([
		"2026-03-28T23:00:00.000Z",
		"2026-03-29T22:00:00.000Z",
	]);
});

test("a collapsed run count sits mid-day on the display zone's civil day, on Tokyo and on a 23-hour day", () => {
	setTimezonePreference("Asia/Tokyo");
	expect(iso(displayMidday(LATE_RUN).getTime())).toBe(
		"2026-06-11T03:00:00.000Z"
	);
	setTimezonePreference("Europe/Berlin");
	const midday = displayMidday(Date.parse("2026-03-29T09:00:00.000Z"));
	expect(iso(midday.getTime())).toBe("2026-03-29T10:30:00.000Z");
	expect(displayDayKey(midday)).toBe("2026-2-29");
});

test("a run is placed by the display zone's clock, through Berlin's spring-forward hour", () => {
	setTimezonePreference("Asia/Tokyo");
	expect(minutesIntoDisplayDay(LATE_RUN)).toBe(7 * 60 + 30);
	expect(eventClock(new Date(LATE_RUN))).toBe("07:30");
	// Midnight reads 00, never 24, and the hour is always two digits.
	expect(eventClock(new Date("2026-06-10T15:05:00.000Z"))).toBe("00:05");
	setTimezonePreference("Europe/Berlin");
	// 01:30Z on the spring-forward day is 03:30 CEST, after the skipped hour.
	const afterJump = new Date("2026-03-29T01:30:00.000Z");
	expect(minutesIntoDisplayDay(afterJump)).toBe(3 * 60 + 30);
	expect(eventClock(afterJump)).toBe("03:30");
});

test("recorded runs are bucketed by the display zone's day, not the machine's", () => {
	setTimezonePreference("Asia/Tokyo");
	const early = "2026-06-10T10:00:00.000Z";
	const late = "2026-06-10T22:30:00.000Z";
	const history = [early, late].map((startedAt) => ({
		error: null,
		finishedAt: iso(Date.parse(startedAt) + 60_000),
		outcome: "success" as const,
		runId: null,
		startedAt,
	}));
	const events = buildCalendarEvents(
		[
			job({
				enabled: false,
				history,
				schedule: { kind: "every", interval: "1d" },
			}),
		],
		new Date("2026-06-09T00:00:00.000Z"),
		new Date("2026-06-13T00:00:00.000Z")
	);
	const byDay = groupEventsByDay(events);
	// 10:00Z is Tokyo 19:00 on June 10; 22:30Z is Tokyo 07:30 on June 11.
	expect(
		[...byDay].map(([key, day]) => [
			key,
			day.map((e) => iso(e.start.getTime())),
		])
	).toEqual([
		["2026-5-10", [early]],
		["2026-5-11", [late]],
	]);
});

test("a fetch window is the display zone's midnights of the days a view shows", () => {
	setTimezonePreference("Asia/Tokyo");
	const cursor = new Date(2026, 5, 11);
	const bounds = (view: "month" | "week" | "day" | "agenda") => {
		const range = viewRange(view, cursor);
		return [iso(range.start.getTime()), iso(range.end.getTime())];
	};
	// June 2026's grid runs Sunday May 31 to Saturday July 4.
	expect(bounds("month")).toEqual([
		"2026-05-30T15:00:00.000Z",
		"2026-07-04T15:00:00.000Z",
	]);
	expect(bounds("week")).toEqual([
		"2026-06-06T15:00:00.000Z",
		"2026-06-13T15:00:00.000Z",
	]);
	expect(bounds("day")).toEqual([
		"2026-06-10T15:00:00.000Z",
		"2026-06-11T15:00:00.000Z",
	]);
	expect(bounds("agenda")).toEqual([
		"2026-06-10T15:00:00.000Z",
		"2026-07-10T15:00:00.000Z",
	]);
	// The columns themselves are civil dates, whatever the zone.
	const month = viewDays("month", cursor);
	expect(month).toHaveLength(35);
	expect(civilDayKey(month[0] as Date)).toBe("2026-4-31");
	expect(civilDayKey(month.at(-1) as Date)).toBe("2026-6-4");
});

test("a sub-hourly interval collapses to one count per display-zone day, with the day's own length", () => {
	setTimezonePreference("Asia/Tokyo");
	const every30 = job({ schedule: { kind: "every", interval: "30m" } });
	// Tokyo's June 11 and 12 begin at 15:00Z.
	const start = new Date("2026-06-10T15:00:00.000Z");
	const end = new Date("2026-06-12T15:00:00.000Z");
	const events = buildCalendarEvents([every30], start, end);
	expect(events.map((e) => e.aggregateCount)).toEqual([48, 48]);
	expect(events.map((e) => iso(e.start.getTime()))).toEqual([
		"2026-06-11T03:00:00.000Z",
		"2026-06-12T03:00:00.000Z",
	]);
	expect([...groupEventsByDay(events).keys()]).toEqual([
		"2026-5-11",
		"2026-5-12",
	]);

	// Berlin's spring-forward day is 23 hours long: 46 half-hour runs.
	setTimezonePreference("Europe/Berlin");
	const spring = buildCalendarEvents(
		[
			job({
				createdAt: "2026-03-01T00:00:00.000Z",
				schedule: { kind: "every", interval: "30m" },
			}),
		],
		new Date("2026-03-28T23:00:00.000Z"),
		new Date("2026-03-29T22:00:00.000Z")
	);
	expect(spring.map((e) => e.aggregateCount)).toEqual([46]);
	expect(displayDayKey(spring[0]?.start as Date)).toBe("2026-2-29");
});

test("a busy cron collapses to one count per display-zone day too", () => {
	setTimezonePreference("Asia/Tokyo");
	// Every second UTC hour: 12 fires in each 24-hour Tokyo day.
	const busy = job({ schedule: { kind: "cron", expr: "0 */2 * * *" } });
	const events = buildCalendarEvents(
		[busy],
		new Date("2026-06-10T15:00:00.000Z"),
		new Date("2026-06-12T15:00:00.000Z")
	);
	expect(events.map((e) => e.aggregateCount)).toEqual([12, 12]);
	expect([...groupEventsByDay(events).keys()]).toEqual([
		"2026-5-11",
		"2026-5-12",
	]);
	expect(events.map((e) => iso(e.start.getTime()))).toEqual([
		"2026-06-11T03:00:00.000Z",
		"2026-06-12T03:00:00.000Z",
	]);
});
