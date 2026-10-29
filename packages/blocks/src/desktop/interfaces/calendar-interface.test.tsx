import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { resetTimezone, setTimezonePreference } from "@ryu/ui/lib/timezone.ts";
import {
	type InterfaceEvent,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarInterface } from "./calendar-interface.tsx";
import {
	addMonths,
	type CalendarItem,
	calendarItemsByDay,
	cellCapacity,
	cellItems,
	compactTime,
	displayWallDate,
	initialScrollMinute,
	layoutDay,
	MIN_BLOCK_MINUTES,
	MIN_TEXT_PX,
	monthGridDays,
	moveDayKey,
	offscreenItems,
	rangeTitle,
	shiftDay,
	upcomingRuns,
} from "./calendar-model.ts";
import { RunDetails } from "./calendar-parts.tsx";

/** Today at a local clock time. */
function todayAt(hour: number, minute = 0): string {
	const date = new Date();
	date.setHours(hour, minute, 0, 0);
	return date.toISOString();
}

function daysFromToday(days: number, hour: number): string {
	const date = new Date();
	date.setDate(date.getDate() + days);
	date.setHours(hour, 0, 0, 0);
	return date.toISOString();
}

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: ["agent-ada"],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: todayAt(9),
		...input,
	};
}

const EVENTS: InterfaceEvent[] = [
	{
		agentId: "agent-ada",
		end: daysFromToday(-1, 6),
		id: "backup",
		kind: "past",
		label: "Daily at 6 AM",
		outcome: "failure",
		start: daysFromToday(-1, 6),
		title: "Nightly backup",
	},
	{
		agentId: "agent-grace",
		count: 24,
		id: "sweep",
		kind: "upcoming",
		label: "Every hour",
		start: daysFromToday(1, 10),
		title: "Inbox sweep",
	},
	{
		agentId: null,
		id: "report",
		kind: "upcoming",
		label: "First of the month",
		start: daysFromToday(2, 9),
		title: "Usage report",
	},
];

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
	],
	events: EVENTS,
	groups: [],
	threads: [
		thread({
			id: "thread-notes",
			title: "Release notes",
			updatedAt: todayAt(9),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			running: true,
			title: "Crash triage",
			updatedAt: todayAt(10, 30),
		}),
		thread({
			id: "thread-flaky",
			runState: "failed",
			title: "Flaky test",
			updatedAt: daysFromToday(-1, 15),
		}),
	],
	version: 1,
};

function item(
	id: string,
	hour: number,
	minute: number,
	status: ThreadStatus = "your-turn"
): CalendarItem {
	return {
		key: `thread:${id}`,
		kind: "thread",
		start: new Date(2026, 9, 13, hour, minute),
		status,
		thread: thread({ id }),
	};
}

describe("calendar model", () => {
	test("a month is six full weeks starting on Sunday", () => {
		const days = monthGridDays(new Date(2026, 9, 13));
		expect(days).toHaveLength(42);
		expect(localDayKey(days[0] ?? new Date())).toBe("2026-09-27");
		expect(days.every((day, index) => day.getDay() === index % 7)).toBe(true);
	});

	test("paging keeps the day, clamped to the month", () => {
		expect(localDayKey(addMonths(new Date(2026, 0, 31), 1))).toBe("2026-02-28");
		expect(shiftDay("month", "2026-10-13", -1)).toBe("2026-09-13");
		expect(shiftDay("week", "2026-10-13", 1)).toBe("2026-10-20");
	});

	test("labels a straddling week with both months", () => {
		expect(rangeTitle("week", new Date(2026, 9, 1))).toMatch(/Sep.*Oct.*2026/);
		expect(rangeTitle("month", new Date(2026, 9, 1))).toMatch(/October.*2026/);
		// A week inside one month is named by its month, at every width.
		expect(rangeTitle("week", new Date(2026, 9, 13))).toMatch(/October.*2026/);
	});

	test("compact times read like a calendar", () => {
		expect(compactTime(new Date(2026, 9, 13, 9, 0))).toBe("9am");
		expect(compactTime(new Date(2026, 9, 13, 21, 5))).toBe("9:05pm");
		expect(compactTime(new Date(2026, 9, 13, 0, 30))).toBe("12:30am");
	});

	test("groups threads and runs by local day, aggregates first", () => {
		const days = calendarItemsByDay(SNAPSHOT);
		const today = days.get(localDayKey(new Date())) ?? [];
		expect(today.map((entry) => entry.key)).toEqual([
			"thread:thread-notes",
			"thread:thread-triage",
		]);
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		expect(days.get(localDayKey(tomorrow))?.[0]?.key).toBe("run:sweep");
		const hidden = calendarItemsByDay(SNAPSHOT, new Set(["runs", "working"]));
		const keys = [...hidden.values()].flat().map((entry) => entry.key);
		expect(keys).not.toContain("run:sweep");
		expect(keys).not.toContain("thread:thread-triage");
	});

	test("upcoming runs are soonest first, and absent events mean none", () => {
		const runs = upcomingRuns(EVENTS, new Date());
		expect(runs.map((run) => run.event.id)).toEqual(["sweep", "report"]);
		expect(upcomingRuns(undefined, new Date())).toEqual([]);
		const withoutEvents = calendarItemsByDay({
			...SNAPSHOT,
			events: undefined,
		});
		expect(
			[...withoutEvents.values()]
				.flat()
				.every((entry) => entry.kind === "thread")
		).toBe(true);
	});

	test("every block is at least half an hour; a run is as long as it took", () => {
		const longRun: CalendarItem = {
			end: new Date(2026, 9, 13, 10, 30),
			event: {
				agentId: null,
				id: "sync",
				kind: "past",
				label: null,
				start: new Date(2026, 9, 13, 9, 0).toISOString(),
				title: "Sync",
			},
			key: "run:sync",
			kind: "run",
			start: new Date(2026, 9, 13, 9, 0),
		};
		const placed = layoutDay([item("a", 14, 0), longRun]).blocks;
		expect(placed.map((entry) => entry.endMinute - entry.topMinute)).toEqual([
			90,
			MIN_BLOCK_MINUTES,
		]);
		expect(MIN_BLOCK_MINUTES).toBe(30);
	});

	test("items that start together share their row side by side", () => {
		const { blocks } = layoutDay([item("a", 13, 0), item("b", 13, 5)], 160);
		expect(
			blocks.map((entry) => [entry.lane, entry.lanes, entry.left, entry.width])
		).toEqual([
			[0, 2, 0, 80],
			[1, 2, 80, 80],
		]);
		// Back to back is not an overlap: the next block takes the full width.
		const chained = layoutDay([item("a", 9, 0), item("b", 9, 30)], 160);
		expect(chained.blocks.map((entry) => [entry.left, entry.width])).toEqual([
			[0, 160],
			[0, 160],
		]);
	});

	test("a later overlapping item cascades over the earlier one", () => {
		const { blocks, folds } = layoutDay(
			[item("a", 17, 20), item("b", 17, 44)],
			160
		);
		expect(folds).toEqual([]);
		// Stepped in by one cascade step, the rest of the width its own.
		expect(blocks.map((entry) => [entry.left, entry.width])).toEqual([
			[0, 160],
			[12, 148],
		]);
	});

	test("a crowded row folds what does not fit into +N, never slivers", () => {
		// Four items inside one quarter hour, in a 120px column.
		const items = [0, 3, 6, 9].map((minute, index) =>
			item(`b${index}`, 16, minute)
		);
		const { blocks, folds } = layoutDay(items, 120);
		expect(blocks).toHaveLength(1);
		expect(folds).toHaveLength(1);
		expect(folds[0]?.items).toHaveLength(3);
		for (const entry of blocks) {
			expect(entry.width).toBeGreaterThanOrEqual(MIN_TEXT_PX);
			expect(entry.text).toBe(true);
		}
		// The open thread stays in view, whichever it is.
		const kept = layoutDay(items, 120, "thread:b3");
		expect(kept.blocks.map((entry) => entry.item.key)).toEqual(["thread:b3"]);
		// A wide column shows two of them, side by side.
		const wide = layoutDay(items, 180);
		expect(wide.blocks).toHaveLength(2);
		expect(wide.folds[0]?.items).toHaveLength(2);
	});

	test("the fixture's busy evening stays readable at every width", () => {
		const evening = [
			item("palette", 17, 20),
			item("launch", 17, 44),
			item("rollout", 17, 59, "working"),
			item("hero", 18, 1, "working"),
		];
		for (const width of [108, 140, 160]) {
			const { blocks, folds } = layoutDay(evening, width);
			const shown =
				blocks.length + folds.reduce((sum, fold) => sum + fold.items.length, 0);
			expect(shown).toBe(4);
			for (const entry of blocks) {
				expect(entry.text).toBe(true);
				expect(entry.width).toBeGreaterThanOrEqual(MIN_TEXT_PX);
			}
		}
		// A column too narrow for words draws bare tints.
		const narrow = layoutDay([item("a", 9, 0)], 40);
		expect(narrow.blocks[0]?.text).toBe(false);
	});

	test("arrow keys step days and weeks; Home and End reach the week's ends", () => {
		expect(moveDayKey("2026-10-13", "ArrowRight", "month")).toBe("2026-10-14");
		expect(moveDayKey("2026-10-13", "ArrowUp", "month")).toBe("2026-10-06");
		expect(moveDayKey("2026-10-13", "Home", "week")).toBe("2026-10-11");
		expect(moveDayKey("2026-10-13", "End", "week")).toBe("2026-10-17");
		expect(moveDayKey("2026-10-13", "PageDown", "month")).toBe("2026-11-13");
		expect(moveDayKey("2026-10-13", "x", "month")).toBe(null);
	});

	test("the week opens about two hours above now, else above its first item", () => {
		const items = [2 * 60 + 43, 9 * 60];
		// Earlier items are left to the column's "earlier" hint.
		expect(initialScrollMinute(items, 13 * 60 + 16)).toBe(11 * 60);
		expect(initialScrollMinute([8 * 60 + 40, 13 * 30], 15 * 60 + 40)).toBe(
			13 * 60
		);
		// A block right on that hour line would sit under the "earlier" hint.
		expect(initialScrollMinute([8 * 60 + 40, 13 * 60], 15 * 60 + 40)).toBe(
			12 * 60
		);
		expect(initialScrollMinute(items, 1 * 60)).toBe(0);
		// Never an hour line that would cut a block in half.
		expect(initialScrollMinute([10 * 60 + 56], 13 * 60 + 16)).toBe(10 * 60);
		expect(initialScrollMinute(items, null)).toBe(2 * 60);
		expect(initialScrollMinute([], null)).toBe(8 * 60);
		expect(initialScrollMinute([10], null)).toBe(0);
	});

	test("hidden blocks above and below the scrolled hours are counted", () => {
		const placed = layoutDay([
			item("early", 6, 0),
			item("seen", 10, 0),
			item("late", 20, 0),
		]).blocks;
		const { above, below } = offscreenItems(placed, 8 * 60, 18 * 60);
		expect(above.map((entry) => entry.item.key)).toEqual(["thread:early"]);
		expect(below.map((entry) => entry.item.key)).toEqual(["thread:late"]);
	});

	test("a month cell's rows follow its height", () => {
		expect(cellCapacity(131)).toBe(5);
		expect(cellCapacity(104)).toBe(3);
		expect(cellCapacity(40)).toBe(1);
	});

	test("a full cell keeps the open thread visible", () => {
		const items = ["a", "b", "c", "d", "e"].map((id, index) =>
			item(id, 9, index)
		);
		const plain = cellItems(items, 3, null);
		expect(plain.shown.map((entry) => entry.key)).toEqual([
			"thread:a",
			"thread:b",
		]);
		expect(plain.hidden).toBe(3);
		const pinned = cellItems(items, 3, "thread:e");
		expect(pinned.shown.map((entry) => entry.key)).toEqual([
			"thread:a",
			"thread:e",
		]);
	});

	test("a full cell never collapses what needs the user", () => {
		const quiet = ["a", "b", "c", "d"].map((id, index) =>
			item(id, 9, index, "waiting")
		);
		const failed = item("late", 18, 0, "attention");
		const { hidden, shown } = cellItems([...quiet, failed], 3, null);
		expect(hidden).toBe(3);
		// Shown in the day's own order, the failure kept in view.
		expect(shown.map((entry) => entry.key)).toEqual([
			"thread:a",
			"thread:late",
		]);
	});
});

describe("calendar display timezone", () => {
	// 12:00 UTC is the next morning on Kiritimati (UTC+14) and the small hours
	// of the same date in Pago Pago (UTC-11), whatever the machine's zone.
	const NOON_UTC = "2026-10-13T12:00:00.000Z";
	const atNoon: InterfaceSnapshot = {
		...SNAPSHOT,
		events: [],
		threads: [thread({ id: "noon", updatedAt: NOON_UTC })],
	};

	test("buckets and clocks follow the display-timezone preference", () => {
		try {
			setTimezonePreference("Pacific/Kiritimati");
			const ahead = displayWallDate(Date.parse(NOON_UTC));
			expect(localDayKey(ahead)).toBe("2026-10-14");
			expect(ahead.getHours()).toBe(2);
			expect([...calendarItemsByDay(atNoon).keys()]).toEqual(["2026-10-14"]);

			setTimezonePreference("Pacific/Pago_Pago");
			const behind = displayWallDate(Date.parse(NOON_UTC));
			expect(localDayKey(behind)).toBe("2026-10-13");
			expect(behind.getHours()).toBe(1);
			expect([...calendarItemsByDay(atNoon).keys()]).toEqual(["2026-10-13"]);
		} finally {
			resetTimezone();
		}
	});

	test("the system preference keeps the instant as it is", () => {
		resetTimezone();
		const instant = Date.parse(NOON_UTC);
		expect(displayWallDate(instant).getTime()).toBe(instant);
	});
});

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

function byLabel(label: string | RegExp): HTMLElement {
	const match = [
		...document.querySelectorAll<HTMLElement>("[aria-label]"),
	].find((element) => {
		const value = element.getAttribute("aria-label") ?? "";
		return typeof label === "string" ? value === label : label.test(value);
	});
	if (!match) {
		throw new Error(`No element labelled ${String(label)}`);
	}
	return match;
}

async function press(key: string, target: EventTarget = document.body) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

function selectedDay(container: HTMLElement): string | null {
	return (
		container
			.querySelector('[role="gridcell"][aria-selected="true"]')
			?.getAttribute("data-day-key") ?? null
	);
}

describe("CalendarInterface", () => {
	test("renders a loading skeleton and an empty state", () => {
		const { port } = recordingPort();
		const empty = { ...SNAPSHOT, agents: [], events: undefined, threads: [] };
		const loading = renderToStaticMarkup(
			<CalendarInterface
				activeThreadId={null}
				loading
				params={{ rail: true, scale: "month" }}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(loading).toContain('data-testid="interface-calendar"');
		expect(loading).toContain('aria-busy="true"');
		const idle = renderToStaticMarkup(
			<CalendarInterface
				activeThreadId={null}
				loading={false}
				params={{ rail: true, scale: "month" }}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(idle).toContain("Nothing on the calendar yet");
		expect(idle).toContain("Add an agent");
		// With no agent there is nothing to start a thread with.
		expect(idle).not.toContain("New thread");
		const withAgents = renderToStaticMarkup(
			<CalendarInterface
				activeThreadId={null}
				loading={false}
				params={{ rail: true, scale: "month" }}
				port={port}
				snapshot={{ ...empty, agents: SNAPSHOT.agents }}
				threadView={null}
			/>
		);
		expect(withAgents).toContain("New thread");
	});

	test("shows threads without events, and the host view in a side panel", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<CalendarInterface
				activeThreadId="thread-triage"
				loading={false}
				params={{ rail: true, scale: "month" }}
				port={port}
				snapshot={{ ...SNAPSHOT, events: undefined }}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(markup).toContain('data-testid="calendar-month"');
		expect(markup).toContain("Release notes");
		expect(markup).toContain("No schedules on this host.");
		expect(markup).toContain('data-testid="calendar-thread-panel"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Thread: Crash triage"');
	});

	test("the week scale draws an hour axis and an all-day row", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<CalendarInterface
				activeThreadId={null}
				loading={false}
				params={{ rail: true, scale: "week" }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(markup).toContain('data-testid="calendar-week"');
		expect(markup).toContain("data-calendar-now");
		expect(markup).toContain("Crash triage");
	});

	test("chips, runs, and the keyboard act through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<CalendarInterface
				activeThreadId={null}
				loading={false}
				params={{ rail: true, scale: "month" }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const todayKey = localDayKey(new Date());
		expect(selectedDay(view.container)).toBe(todayKey);

		await act(async () => byLabel(/^Release notes,/).click());
		expect(calls).toEqual(["open:thread-notes"]);

		// A run is a popover trigger, not a thread link.
		const runChip = byLabel(/^Scheduled run: Nightly backup/);
		expect(runChip.getAttribute("aria-haspopup")).toBe("dialog");
		expect(calls).toEqual(["open:thread-notes"]);

		await press("ArrowLeft");
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		expect(selectedDay(view.container)).toBe(localDayKey(yesterday));
		await press("ArrowDown");
		await press("t");
		expect(selectedDay(view.container)).toBe(todayKey);
		await press("Enter");
		expect(calls.at(-1)).toBe("open:thread-notes");
		await view.dispose();
	});

	test("run details name the run and message its agent", async () => {
		const messaged: string[] = [];
		const [run] = upcomingRuns(EVENTS, new Date());
		if (!run) {
			throw new Error("Expected an upcoming run");
		}
		const view = await mount(
			<RunDetails
				item={run}
				onMessage={(agentId) => messaged.push(agentId)}
				snapshot={SNAPSHOT}
			/>
		);
		expect(view.container.textContent).toContain("Inbox sweep");
		expect(view.container.textContent).toContain("Every hour");
		expect(view.container.textContent).toContain("24 runs scheduled");
		expect(view.container.textContent).toContain("Scheduled");
		const message = [...view.container.querySelectorAll("button")].find(
			(button) => button.textContent === "Message Grace"
		);
		await act(async () => message?.click());
		expect(messaged).toEqual(["agent-grace"]);
		await view.dispose();

		const report = upcomingRuns(EVENTS, new Date())[1];
		if (!report) {
			throw new Error("Expected a second run");
		}
		const agentless = renderToStaticMarkup(
			<RunDetails
				item={report}
				onMessage={() => undefined}
				snapshot={SNAPSHOT}
			/>
		);
		expect(agentless).toContain("No agent");
		expect(agentless).not.toContain("Message ");
	});

	test("Escape closes the open thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<CalendarInterface
				activeThreadId="thread-notes"
				loading={false}
				params={{ rail: true, scale: "week" }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div>Host</div>}
			/>
		);
		await press("Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});
});
