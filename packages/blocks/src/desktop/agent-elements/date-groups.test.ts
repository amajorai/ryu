import { requireTestValue } from "../test-required.ts";
// packages/blocks/src/desktop/agent-elements/date-groups.test.ts
//
// The grouper decides where a separator is DRAWN, so its edge cases are all
// "what does the user see" questions: an undated transcript must show no
// separators at all (never "Invalid Date"), a merged non-monotonic transcript
// must keep its order even at the cost of repeating a date, and the day
// boundary must be midnight in the DISPLAY zone rather than the machine's.
//
// The zone is driven through the real store (`@ryu/ui/lib/timezone.ts`), the
// same one Appearance → "Date & time" writes, so these assertions cover the
// path the product actually takes.

import { afterEach, describe, expect, it } from "bun:test";
import {
	resetTimezone,
	setTimezonePreference,
	startOfTodayMs,
} from "@ryu/ui/lib/timezone.ts";
import {
	type DayGroupableTurn,
	dayKeyAtTurnIndex,
	dayKeyOf,
	dayLabel,
	groupTurnsByDay,
	separatorKeyByTurnIndex,
} from "./date-groups.ts";

afterEach(() => {
	resetTimezone();
});

const MS_PER_DAY = 86_400_000;

/** A turn whose user message carries `createdAt` — the ChatPage shape. */
function turnAt(iso: string): DayGroupableTurn {
	return { userMsg: { createdAt: new Date(iso) }, assistantMsgs: [] };
}

/** A turn with no timestamp anywhere — the subagent / fixture / Council shape. */
function undatedTurn(): DayGroupableTurn {
	return { userMsg: {}, assistantMsgs: [{}] };
}

describe("dayKeyOf", () => {
	it("falls back to the first assistant message when the user turn is undated", () => {
		setTimezonePreference("UTC");
		const key = dayKeyOf({
			userMsg: {},
			assistantMsgs: [{}, { createdAt: "2026-03-04T10:00:00.000Z" }],
		});
		expect(key).toBe(String(Date.parse("2026-03-04T00:00:00.000Z")));
	});

	it("is null for a missing stamp and for an unparseable one", () => {
		expect(dayKeyOf(undatedTurn())).toBeNull();
		expect(dayKeyOf({ userMsg: { createdAt: "not a date" } })).toBeNull();
		expect(dayKeyOf({ userMsg: { createdAt: Number.NaN } })).toBeNull();
	});

	it("files an instant by midnight in the DISPLAY zone, not the machine's", () => {
		// 2026-01-15T23:30Z is already the 16th in Tokyo and still the 15th in LA.
		const at = "2026-01-15T23:30:00.000Z";
		setTimezonePreference("Asia/Tokyo");
		expect(dayKeyOf(turnAt(at))).toBe(
			String(Date.parse("2026-01-15T15:00:00.000Z"))
		);
		setTimezonePreference("America/Los_Angeles");
		expect(dayKeyOf(turnAt(at))).toBe(
			String(Date.parse("2026-01-15T08:00:00.000Z"))
		);
	});
});

describe("groupTurnsByDay", () => {
	it("returns no groups for an empty transcript", () => {
		expect(groupTurnsByDay([])).toEqual([]);
	});

	it("makes one group for a single message — no special case", () => {
		setTimezonePreference("UTC");
		const groups = groupTurnsByDay([turnAt("2026-03-04T10:00:00.000Z")]);
		expect(groups).toHaveLength(1);
		expect(requireTestValue(groups[0], "day group 0").startIndex).toBe(0);
		expect(requireTestValue(groups[0], "day group 0").dayKey).not.toBeNull();
	});

	it("opens a group at each day change and only there", () => {
		setTimezonePreference("UTC");
		const groups = groupTurnsByDay([
			turnAt("2026-03-04T09:00:00.000Z"),
			turnAt("2026-03-04T23:59:00.000Z"),
			turnAt("2026-03-05T00:01:00.000Z"),
			turnAt("2026-03-06T12:00:00.000Z"),
		]);
		expect(groups.map((g) => g.startIndex)).toEqual([0, 2, 3]);
	});

	it("moves a boundary when the display zone moves", () => {
		// Two instants 40 minutes apart that straddle midnight in Tokyo but sit
		// comfortably inside one LA day.
		const turns = [
			turnAt("2026-01-15T14:40:00.000Z"),
			turnAt("2026-01-15T15:20:00.000Z"),
		];
		setTimezonePreference("Asia/Tokyo");
		expect(groupTurnsByDay(turns)).toHaveLength(2);
		setTimezonePreference("America/Los_Angeles");
		expect(groupTurnsByDay(turns)).toHaveLength(1);
	});

	it("gives a wholly undated transcript one null group and no separators", () => {
		// This is the storyboard / e2e-fixture / CoworkContextPanel path:
		// `buildHistory` in e2e/harness/chat-scroll-story.tsx and the subagent
		// transcript in CoworkContextPanel both emit `{id, role, parts}` with no
		// `createdAt`, so chat-scroll-story.spec.ts and chat-message-align.spec.ts
		// must see exactly the DOM they saw before date grouping existed.
		const groups = groupTurnsByDay([
			undatedTurn(),
			undatedTurn(),
			undatedTurn(),
		]);
		expect(groups).toEqual([{ dayKey: null, startIndex: 0 }]);
		expect(separatorKeyByTurnIndex(groups).size).toBe(0);
	});

	it("lets leading undated turns form a head group, then dates the rest", () => {
		setTimezonePreference("UTC");
		const groups = groupTurnsByDay([
			undatedTurn(),
			turnAt("2026-03-04T10:00:00.000Z"),
		]);
		expect(groups.map((g) => g.startIndex)).toEqual([0, 1]);
		expect(requireTestValue(groups[0], "day group 0").dayKey).toBeNull();
		expect(requireTestValue(groups[1], "day group 1").dayKey).not.toBeNull();
		expect([...separatorKeyByTurnIndex(groups).keys()]).toEqual([1]);
	});

	it("lets an undated turn inherit the run it lands in rather than break it", () => {
		setTimezonePreference("UTC");
		const groups = groupTurnsByDay([
			turnAt("2026-03-04T10:00:00.000Z"),
			undatedTurn(),
			turnAt("2026-03-04T18:00:00.000Z"),
		]);
		expect(groups).toHaveLength(1);
		expect(dayKeyAtTurnIndex(groups, 1)).toBe(
			requireTestValue(groups[0], "day group 0").dayKey
		);
	});

	it("keeps a non-monotonic merged transcript in order, repeating a date", () => {
		// useMergedAgentThreads stacks older threads ABOVE the live one, so the
		// stamps are not guaranteed to ascend. Showing 4 March twice is honest;
		// sorting would scramble what actually happened.
		setTimezonePreference("UTC");
		const groups = groupTurnsByDay([
			turnAt("2026-03-04T10:00:00.000Z"),
			turnAt("2026-03-05T10:00:00.000Z"),
			turnAt("2026-03-04T11:00:00.000Z"),
		]);
		expect(groups.map((g) => g.startIndex)).toEqual([0, 1, 2]);
		expect(requireTestValue(groups[2], "day group 2").dayKey).toBe(
			requireTestValue(groups[0], "day group 0").dayKey
		);
	});

	it("keeps a whole imported ACP thread in one group", () => {
		// native_history.rs carries no per-message time, so the shell stamps the
		// import; every turn then shares that day. Known and acceptable.
		setTimezonePreference("UTC");
		const importedAt = "2026-03-04T09:00:00.000Z";
		const groups = groupTurnsByDay([
			turnAt(importedAt),
			turnAt(importedAt),
			turnAt(importedAt),
		]);
		expect(groups).toHaveLength(1);
	});
});

describe("dayLabel", () => {
	// A fixed "now" so the relative labels are deterministic. UTC keeps the
	// arithmetic below exact.
	const NOW = Date.parse("2026-03-10T12:00:00.000Z");

	function labelForDaysAgo(days: number): string {
		setTimezonePreference("UTC");
		const startOfToday = startOfTodayMs(NOW);
		const dayStart = startOfTodayMs(startOfToday - days * MS_PER_DAY);
		return dayLabel(String(dayStart), startOfToday);
	}

	it("names today and yesterday", () => {
		expect(labelForDaysAgo(0)).toBe("Today");
		expect(labelForDaysAgo(1)).toBe("Yesterday");
	});

	it("uses a weekday name inside the last week", () => {
		// 2026-03-10 is a Tuesday, so two days back is Sunday.
		expect(labelForDaysAgo(2)).toBe("Sunday");
		expect(labelForDaysAgo(6)).toBe("Wednesday");
	});

	it("switches to an explicit date once a weekday name would repeat", () => {
		const seven = labelForDaysAgo(7);
		expect(seven).not.toBe("Tuesday");
		expect(seven).toContain("2026");
		expect(seven).toContain("3");
	});

	it("returns an empty string rather than 'Invalid Date' for a junk key", () => {
		expect(dayLabel("not a key", NOW)).toBe("");
	});

	it("does not label a spring-forward week's day seven with today's weekday", () => {
		// The regression a `startOfToday - 7 * MS_PER_DAY` boundary produces.
		// New York springs forward on 2026-03-08, so the seven days ending Friday
		// 2026-03-13 are only 167 hours long: subtracting seven whole days lands
		// an hour INSIDE Thursday the 5th, which puts Friday the 6th — the same
		// weekday as "today" — inside the weekday-name window and prints it as a
		// bare "Friday".
		setTimezonePreference("America/New_York");
		const friday13th = Date.parse("2026-03-13T18:00:00.000Z");
		const startOfToday = startOfTodayMs(friday13th);
		const friday6th = String(
			startOfTodayMs(Date.parse("2026-03-06T18:00:00.000Z"))
		);

		expect(dayLabel(String(startOfToday), startOfToday)).toBe("Today");
		expect(dayLabel(friday6th, startOfToday)).not.toBe("Friday");
		expect(dayLabel(friday6th, startOfToday)).toContain("2026");
		// The days that ARE inside the window still read as weekday names, across
		// the same transition.
		expect(
			dayLabel(
				String(startOfTodayMs(Date.parse("2026-03-07T18:00:00.000Z"))),
				startOfToday
			)
		).toBe("Saturday");
	});
});

describe("dayKeyAtTurnIndex", () => {
	it("resolves the CONTAINING group, not the nearest start", () => {
		const groups = [
			{ dayKey: "1000", startIndex: 0 },
			{ dayKey: "2000", startIndex: 3 },
		];
		expect(dayKeyAtTurnIndex(groups, 0)).toBe("1000");
		expect(dayKeyAtTurnIndex(groups, 2)).toBe("1000");
		expect(dayKeyAtTurnIndex(groups, 3)).toBe("2000");
		expect(dayKeyAtTurnIndex(groups, 9)).toBe("2000");
	});

	it("is null inside an undated head group and for an empty transcript", () => {
		expect(dayKeyAtTurnIndex([{ dayKey: null, startIndex: 0 }], 4)).toBeNull();
		expect(dayKeyAtTurnIndex([], 0)).toBeNull();
	});
});

describe("transition-day transcript separators", () => {
	for (const day of [
		{
			name: "spring",
			before: "2026-03-08T06:30:00Z",
			after: "2026-03-08T16:00:00Z",
			start: "2026-03-08T05:00:00Z",
		},
		{
			name: "autumn",
			before: "2026-11-01T04:30:00Z",
			after: "2026-11-01T17:00:00Z",
			start: "2026-11-01T04:00:00Z",
		},
	]) {
		it(`keeps New York's ${day.name} transition-day turns under one separator`, () => {
			setTimezonePreference("America/New_York");
			const beforeTransition = turnAt(day.before);
			const afterTransition = turnAt(day.after);
			expect(dayKeyOf(beforeTransition)).toBe(String(Date.parse(day.start)));
			expect(dayKeyOf(afterTransition)).toBe(String(Date.parse(day.start)));
			expect(groupTurnsByDay([beforeTransition, afterTransition])).toEqual([
				{ dayKey: String(Date.parse(day.start)), startIndex: 0 },
			]);
		});
	}
});
