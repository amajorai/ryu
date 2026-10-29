import { afterAll, afterEach, expect, test } from "bun:test";

// The computer is on Honolulu time (UTC-10, no daylight saving) and every case
// picks a display zone that disagrees with it, so a helper that reads the
// computer's day cannot pass.
const machineZone = process.env.TZ;
process.env.TZ = "Pacific/Honolulu";
const { resetTimezone, setTimezonePreference } = await import(
	"@ryu/ui/lib/timezone.ts"
);
const { usagePresetRange, usageRangeDays, usageRangeFromDays } = await import(
	"./usage-range-days.ts"
);

afterEach(() => {
	resetTimezone();
	process.env.TZ = "Pacific/Honolulu";
});
afterAll(() => {
	if (machineZone === undefined) {
		Reflect.deleteProperty(process.env, "TZ");
	} else {
		process.env.TZ = machineZone;
	}
});

const iso = (range: { from: Date; to: Date }) => ({
	from: range.from.toISOString(),
	to: range.to.toISOString(),
});

// 2026-06-10T20:00Z is June 10 10:00 in Honolulu and June 11 05:00 in Tokyo.
const NOW = Date.parse("2026-06-10T20:00:00.000Z");

test("a preset ends at the midnight after the display zone's today", () => {
	setTimezonePreference("Asia/Tokyo");
	expect(iso(usagePresetRange(1, NOW))).toEqual({
		from: "2026-06-10T15:00:00.000Z",
		to: "2026-06-11T15:00:00.000Z",
	});
	expect(iso(usagePresetRange(7, NOW))).toEqual({
		from: "2026-06-04T15:00:00.000Z",
		to: "2026-06-11T15:00:00.000Z",
	});
});

test("a preset counts the display zone's calendar days across a clock change", () => {
	setTimezonePreference("America/New_York");
	// 2026-03-09T12:00Z is Monday March 9 08:00 in New York, the day after
	// clocks went forward on March 8. Seven days back is March 3 00:00 EST.
	expect(
		iso(usagePresetRange(7, Date.parse("2026-03-09T12:00:00.000Z")))
	).toEqual({
		from: "2026-03-03T05:00:00.000Z",
		to: "2026-03-10T04:00:00.000Z",
	});
});

test("a preset follows the computer's midnight when the display zone is its own", () => {
	setTimezonePreference("Pacific/Honolulu");
	expect(iso(usagePresetRange(7, NOW))).toEqual({
		from: "2026-06-04T10:00:00.000Z",
		to: "2026-06-11T10:00:00.000Z",
	});
	setTimezonePreference("system");
	expect(iso(usagePresetRange(7, NOW))).toEqual({
		from: "2026-06-04T10:00:00.000Z",
		to: "2026-06-11T10:00:00.000Z",
	});
});

test("a range names its first and last day in the display zone", () => {
	setTimezonePreference("Asia/Tokyo");
	const days = usageRangeDays({
		from: new Date("2026-06-04T15:00:00.000Z"),
		to: new Date("2026-06-11T15:00:00.000Z"),
	});
	// Day columns are local-midnight dates: Tokyo's June 5 and June 11.
	expect(
		[days.from, days.to].map((day) => [
			day.getFullYear(),
			day.getMonth() + 1,
			day.getDate(),
			day.getHours(),
		])
	).toEqual([
		[2026, 6, 5, 0],
		[2026, 6, 11, 0],
	]);
});

test("picked days become the display zone's midnights, the last one inclusive", () => {
	setTimezonePreference("Asia/Tokyo");
	expect(
		iso(usageRangeFromDays(new Date(2026, 5, 8), new Date(2026, 5, 10)))
	).toEqual({
		from: "2026-06-07T15:00:00.000Z",
		to: "2026-06-10T15:00:00.000Z",
	});
});

test("a lone picked day is a one day range", () => {
	setTimezonePreference("Asia/Tokyo");
	expect(iso(usageRangeFromDays(new Date(2026, 5, 8)))).toEqual({
		from: "2026-06-07T15:00:00.000Z",
		to: "2026-06-08T15:00:00.000Z",
	});
});

test("a day the display zone shortens is still one calendar day", () => {
	setTimezonePreference("America/New_York");
	// March 8, 2026 is 23 hours long in New York: 00:00 EST to 00:00 EDT.
	const march8 = new Date(2026, 2, 8);
	expect(iso(usageRangeFromDays(march8, march8))).toEqual({
		from: "2026-03-08T05:00:00.000Z",
		to: "2026-03-09T04:00:00.000Z",
	});
	const days = usageRangeDays(usageRangeFromDays(march8, march8));
	expect([days.from.getDate(), days.to.getDate()]).toEqual([8, 8]);
});

test("stepping days does not drift when the computer's own clock changes inside the range", () => {
	// The computer is New York, whose clocks went forward on March 8, while the
	// person's zone is Honolulu, which has no clock change. Stepping a day column
	// back by 24 hours would land on 23:00 of the day before.
	process.env.TZ = "America/New_York";
	setTimezonePreference("Pacific/Honolulu");
	// 2026-03-10T20:00Z is March 10 10:00 in Honolulu.
	expect(
		iso(usagePresetRange(7, Date.parse("2026-03-10T20:00:00.000Z")))
	).toEqual({
		from: "2026-03-04T10:00:00.000Z",
		to: "2026-03-11T10:00:00.000Z",
	});
});
