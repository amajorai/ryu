import { afterAll, beforeAll, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Marketing MDX `date` values are calendar days (`2026-03-15`). The block
 * components must show that calendar day to every reader. `new Date("2026-03-15")`
 * is UTC midnight, so a reader west of UTC who formats it in their own zone sees
 * the previous day. Each case below runs in a zone whose local date for UTC
 * midnight differs from the release's date, and a probe asserts the zone really
 * took effect, so a Bun that ignored `TZ` would fail instead of passing vacuously.
 */
const machineZone = process.env.TZ;
process.env.TZ = "America/Los_Angeles";
const { ChangelogCard, ChangelogEntry, ChangelogTimelineSearch } = await import(
	"./changelog.tsx"
);
const { BlogPostCard } = await import("./blog.tsx");
const { RecentUpdates } = await import("./recent-updates.tsx");

beforeAll(() => {
	process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
	if (machineZone === undefined) {
		Reflect.deleteProperty(process.env, "TZ");
	} else {
		process.env.TZ = machineZone;
	}
});

/** Zones west of UTC (each shows the previous day for UTC midnight), plus UTC and east. */
const ZONES = [
	{ zone: "Pacific/Honolulu", previousDay: true },
	{ zone: "America/Los_Angeles", previousDay: true },
	{ zone: "America/New_York", previousDay: true },
	{ zone: "UTC", previousDay: false },
	{ zone: "Asia/Tokyo", previousDay: false },
	{ zone: "Pacific/Kiritimati", previousDay: false },
] as const;

/** Switches the machine zone and returns the local day of UTC midnight, 15 March 2026. */
function enterZone(zone: string): string {
	process.env.TZ = zone;
	return new Date("2026-03-15").toLocaleDateString("en-US", { day: "numeric" });
}

/** The local day a live zone shows for UTC midnight; a Bun that ignored `TZ` fails here. */
function expectedLocalDay(previousDay: boolean): string {
	return previousDay ? "14" : "15";
}

interface RenderedTime {
	dateTime: string;
	text: string;
}

function timesIn(html: string): RenderedTime[] {
	return [...html.matchAll(/<time dateTime="([^"]*)">([^<]*)<\/time>/gu)].map(
		(match) => ({ dateTime: match[1] ?? "", text: match[2] ?? "" })
	);
}

function entryData(date: string, slug = "release") {
	return {
		content: "Notes",
		date,
		id: slug,
		slug,
		title: `Release ${slug}`,
		type: "feature",
		version: "1.2.3",
	};
}

function postData(date: string, slug = "post") {
	return {
		content: "Body",
		date,
		id: slug,
		slug,
		title: `Post ${slug}`,
	};
}

// Boundaries a reader's zone offset can push across: a month start, a year
// start and both US daylight-saving changes.
const CALENDAR_DAYS = [
	{ date: "2026-03-15", long: "March 15, 2026", short: "Mar 15, 2026" },
	{ date: "2026-01-01", long: "January 1, 2026", short: "Jan 1, 2026" },
	{ date: "2026-03-01", long: "March 1, 2026", short: "Mar 1, 2026" },
	{ date: "2026-03-08", long: "March 8, 2026", short: "Mar 8, 2026" },
	{ date: "2026-11-01", long: "November 1, 2026", short: "Nov 1, 2026" },
	{ date: "2026-12-31", long: "December 31, 2026", short: "Dec 31, 2026" },
] as const;

for (const { zone, previousDay } of ZONES) {
	test(`ChangelogEntry shows the release's calendar day in ${zone}`, () => {
		expect(enterZone(zone)).toBe(expectedLocalDay(previousDay));
		for (const day of CALENDAR_DAYS) {
			const html = renderToStaticMarkup(
				<ChangelogEntry entry={entryData(day.date)} />
			);
			expect(timesIn(html)).toEqual([{ dateTime: day.date, text: day.long }]);
		}
	});

	test(`ChangelogCard shows the release's calendar day in ${zone}`, () => {
		expect(enterZone(zone)).toBe(expectedLocalDay(previousDay));
		for (const day of CALENDAR_DAYS) {
			const html = renderToStaticMarkup(
				<ChangelogCard entry={entryData(day.date)} />
			);
			expect(timesIn(html)).toEqual([{ dateTime: day.date, text: day.short }]);
		}
	});

	test(`BlogPostCard shows the post's calendar day in ${zone}`, () => {
		expect(enterZone(zone)).toBe(expectedLocalDay(previousDay));
		for (const day of CALENDAR_DAYS) {
			const html = renderToStaticMarkup(
				<BlogPostCard post={postData(day.date)} />
			);
			expect(timesIn(html)).toEqual([{ dateTime: day.date, text: day.short }]);
		}
	});
}

test("the timeline lists every release on its own calendar day for a reader west of UTC", () => {
	expect(enterZone("America/Los_Angeles")).toBe(expectedLocalDay(true));
	const entries = CALENDAR_DAYS.map((day, index) =>
		entryData(day.date, `release-${index}`)
	);
	const html = renderToStaticMarkup(
		<ChangelogTimelineSearch entries={entries} />
	);

	expect(timesIn(html)).toEqual(
		CALENDAR_DAYS.map((day) => ({ dateTime: day.date, text: day.long }))
	);
});

test("the home-page updates feed shows blog and changelog days as written for a reader west of UTC", () => {
	expect(enterZone("Pacific/Honolulu")).toBe(expectedLocalDay(true));
	const html = renderToStaticMarkup(
		<RecentUpdates
			entries={[entryData("2026-03-15", "release")]}
			posts={[postData("2026-03-14", "post")]}
		/>
	);

	// Newest first: the release, then the post a day earlier.
	expect(timesIn(html)).toEqual([
		{ dateTime: "2026-03-15", text: "Mar 15, 2026" },
		{ dateTime: "2026-03-14", text: "Mar 14, 2026" },
	]);
});

test("a dated timestamp is still an instant shown in the reader's zone", () => {
	// `2026-04-01T09:00:00-08:00` is 17:00 UTC. Only calendar days are pinned to
	// UTC; an instant keeps the reader's own zone, as before.
	const expectedByZone: Record<string, string> = {
		"America/Los_Angeles": "April 1, 2026",
		UTC: "April 1, 2026",
		"Pacific/Kiritimati": "April 2, 2026",
	};
	for (const [zone, expected] of Object.entries(expectedByZone)) {
		process.env.TZ = zone;
		const html = renderToStaticMarkup(
			<ChangelogEntry entry={entryData("2026-04-01T09:00:00-08:00")} />
		);
		expect(timesIn(html)).toEqual([
			{ dateTime: "2026-04-01T09:00:00-08:00", text: expected },
		]);
	}
});
