import { describe, expect, test } from "bun:test";
import { resetTimezone, setTimezonePreference } from "@ryu/ui/lib/timezone.ts";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	projectTimeline,
} from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineInterface } from "./timeline-interface.tsx";
import {
	dayHeading,
	displayWallSnapshot,
	hourRangeLabel,
	WEEK_CHIP_PX,
	WEEK_HOUR_PX,
	weekColumnTracks,
	weekLayout,
} from "./timeline-model.ts";

const NOOP_PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

function at(hour: number, minute: number): string {
	const date = new Date();
	date.setHours(hour, minute, 0, 0);
	return date.toISOString();
}

function thread(id: string, updatedAt: string): InterfaceThread {
	return {
		agentIds: ["agent-ada"],
		id,
		lastMessage: `Latest from ${id}`,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: `Thread ${id}`,
		updatedAt,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	groups: [],
	threads: [thread("a", at(9, 0)), thread("b", at(9, 10))],
	version: INTERFACE_PROTOCOL_VERSION,
};

describe("timeline model", () => {
	test("names today and yesterday, and dates older days", () => {
		const now = new Date(2026, 9, 12, 15, 0);
		expect(dayHeading("2026-10-12", now)).toBe("Today");
		expect(dayHeading("2026-10-11", now)).toBe("Yesterday");
		expect(dayHeading("2026-10-09", now)).not.toMatch(/Today|Yesterday/);
	});

	test("fits the hours to the data and folds only runs of empty hours", () => {
		const now = new Date();
		now.setHours(12, 0, 0, 0);
		const layout = weekLayout(
			[[thread("early", at(5, 40))], [], [thread("late", at(21, 0))]],
			now,
			2
		);
		expect(layout.startHour).toBe(5);
		expect(layout.endHour).toBe(22);
		expect(
			layout.rows
				.filter((row) => row.quiet)
				.map((row) => [row.fromHour, row.toHour])
		).toStrictEqual([
			[6, 12],
			[13, 21],
		]);
		// Rows tile the grid exactly: it ends on an hour line.
		let top = 0;
		for (const row of layout.rows) {
			expect(row.top).toBe(top);
			top += row.height;
		}
		expect(layout.height).toBe(top);
	});

	test("stacks threads in the same hour full width, in time order", () => {
		const now = new Date();
		now.setHours(18, 0, 0, 0);
		const threads = [
			thread("c", at(17, 23)),
			thread("a", at(17, 6)),
			thread("b", at(17, 21)),
		];
		const layout = weekLayout([threads, [thread("x", at(17, 50))]], now, 1);
		const [day = []] = layout.chips;
		expect(day.map((chip) => chip.thread.id)).toStrictEqual(["a", "b", "c"]);
		const tops = day.map((chip) => chip.top);
		expect(tops[1]! - tops[0]!).toBe(WEEK_CHIP_PX);
		expect(tops[2]! - tops[1]!).toBe(WEEK_CHIP_PX);
		// The busy hour grows to hold its stack; the other day's chip sits at the same hour line.
		const busy = layout.rows.find((row) => row.fromHour === 17);
		expect(busy?.height).toBeGreaterThan(WEEK_HOUR_PX);
		expect((busy?.top ?? 0) + (busy?.height ?? 0)).toBeGreaterThanOrEqual(
			tops[2]! + WEEK_CHIP_PX
		);
		expect(layout.chips[1]?.[0]?.top).toBe(tops[0]);
	});

	test("puts the now line after today's chips, never through one", () => {
		const now = new Date();
		now.setHours(17, 10, 0, 0);
		const threads = [
			thread("a", at(17, 2)),
			thread("b", at(17, 5)),
			thread("c", at(17, 8)),
		];
		const layout = weekLayout([threads], now, 0);
		const last = layout.chips[0]?.at(-1);
		expect(layout.nowTop).not.toBeNull();
		expect(layout.nowTop ?? 0).toBeGreaterThan(
			(last?.top ?? 0) + WEEK_CHIP_PX - 2
		);
	});

	test("adds empty hours until the grid fills the view", () => {
		const now = new Date();
		now.setHours(9, 0, 0, 0);
		const layout = weekLayout([[]], now, 0, 900);
		expect(layout.endHour).toBe(24);
		expect(layout.rows.at(-1)?.quiet).toBe(false);
		for (const row of layout.rows) {
			expect(row.height).toBeLessThanOrEqual(WEEK_HOUR_PX + 16);
		}
	});

	test("never opens or closes on a folded run, and fills the view exactly", () => {
		const now = new Date();
		now.setHours(22, 30, 0, 0);
		const layout = weekLayout(
			[[thread("a", at(15, 10)), thread("b", at(20, 5))]],
			now,
			0,
			760
		);
		expect(layout.rows[0]?.quiet).toBe(false);
		expect(layout.rows.at(-1)?.quiet).toBe(false);
		// Late in the day there is no room below, so earlier hours fill the view.
		expect(layout.startHour).toBeLessThan(15);
		expect(layout.endHour).toBe(24);
		expect(layout.height).toBe(760);
	});

	test("names a folded run of hours compactly", () => {
		expect(hourRangeLabel(8, 10)).toMatch(/8.*10/);
		expect(hourRangeLabel(8, 10)).not.toBe("");
	});

	test("gives days with threads the width and keeps empty days narrow", () => {
		const tracks = weekColumnTracks([0, 0, 0, 0, 1, 1, 7]);
		expect(tracks.template).toBe(
			"4.5rem minmax(2.75rem,0.4fr) minmax(2.75rem,0.4fr) minmax(2.75rem,0.4fr) minmax(2.75rem,0.4fr) minmax(8rem,1fr) minmax(8rem,1fr) minmax(8rem,1fr)"
		);
		expect(tracks.minWidthRem).toBeCloseTo(4.5 + 4 * 2.75 + 3 * 8);
		const compact = weekColumnTracks([0, 0, 0, 0, 1, 1, 4], true);
		expect(compact.minWidthRem).toBeCloseTo(4.5 + 4 * 1.5 + 3 * 8);
	});
});

describe("timeline display time zone", () => {
	const NOON_UTC = "2026-10-13T12:00:00.000Z";
	const atNoon: InterfaceSnapshot = {
		...SNAPSHOT,
		threads: [thread("noon", NOON_UTC)],
	};
	const dayOf = () =>
		projectTimeline(
			displayWallSnapshot(atNoon),
			{ scale: "day" },
			new Date(NOON_UTC)
		).days.map((day) => day.key);

	test("days follow the display-timezone preference", () => {
		try {
			setTimezonePreference("Pacific/Kiritimati");
			expect(dayOf()).toEqual(["2026-10-14"]);
			setTimezonePreference("Pacific/Pago_Pago");
			expect(dayOf()).toEqual(["2026-10-13"]);
		} finally {
			resetTimezone();
		}
	});

	test("the system preference keeps every thread's time as it is", () => {
		resetTimezone();
		expect(displayWallSnapshot(atNoon).threads[0]?.updatedAt).toBe(NOON_UTC);
	});
});

describe("TimelineInterface", () => {
	test("renders the day scale with a scale toggle and a Today jump", () => {
		const html = renderToStaticMarkup(
			<TimelineInterface
				activeThreadId={null}
				loading={false}
				params={{ scale: "day" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain('data-testid="interface-timeline"');
		expect(html).toContain('aria-label="Timeline scale"');
		expect(html).toContain(">Today<");
		expect(html).toContain("Thread a");
		expect(html).toContain("Latest from b");
	});

	test("renders the week grid with today's column", () => {
		const html = renderToStaticMarkup(
			<TimelineInterface
				activeThreadId="a"
				loading={false}
				params={{ scale: "week" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={<p>host chat</p>}
			/>
		);
		expect(html).toContain('aria-label="Threads this week"');
		expect(html).toContain("Today, ");
		expect(html).toContain("host chat");
		expect(html).toContain('aria-label="Close thread"');
	});

	test("shows an empty state that can start a thread", () => {
		const html = renderToStaticMarkup(
			<TimelineInterface
				activeThreadId={null}
				loading={false}
				params={{ scale: "day" }}
				port={NOOP_PORT}
				snapshot={{ ...SNAPSHOT, threads: [] }}
				threadView={null}
			/>
		);
		expect(html).toContain("No threads yet");
		expect(html).toContain("New thread");
	});

	test("marks the region busy while loading", () => {
		const html = renderToStaticMarkup(
			<TimelineInterface
				activeThreadId={null}
				loading
				params={{ scale: "day" }}
				port={NOOP_PORT}
				snapshot={{ ...SNAPSHOT, threads: [] }}
				threadView={null}
			/>
		);
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("No threads yet");
	});
});
