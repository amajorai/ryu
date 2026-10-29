import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JournalInterface } from "./journal-interface.tsx";
import {
	agentNames,
	buildJournalEntries,
	currentStreak,
	entriesByDay,
	entryExcerpt,
	entryNeighbors,
	eventsOnDay,
	filterJournalEntries,
	groupJournalMonths,
	HEATMAP_WEEKS,
	journalStats,
	longestStreak,
	monthWeeks,
	onThisDay,
	shiftDayKey,
	shiftMonthKey,
	yearHeatmap,
} from "./journal-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Local mid-day, far from midnight in any time zone. */
const FIXED_NOW = new Date(2026, 9, 14, 12, 0, 0);
const DAY = 24 * HOUR;

/** Local noon, so day keys never straddle midnight in any time zone. */
function localNoon(year: number, month: number, day: number): Date {
	return new Date(year, month - 1, day, 12);
}

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: new Date().toISOString(),
		...input,
	};
}

function snapshotAt(now: Date): InterfaceSnapshot {
	const at = (offset: number) => new Date(now.getTime() - offset).toISOString();
	return {
		agents: [
			{
				avatarUrl: null,
				description: "Writes",
				id: "agent-ada",
				name: "Ada",
				status: "idle",
			},
			{
				avatarUrl: null,
				description: "Ships",
				id: "agent-grace",
				name: "Grace",
				status: "working",
			},
		],
		events: [
			{
				agentId: "agent-ada",
				id: "event-digest",
				kind: "past",
				label: "Daily",
				outcome: "success",
				start: at(HOUR),
				title: "Morning digest",
			},
		],
		groups: [
			{
				id: "project-site",
				kind: "project",
				memberAgentIds: ["agent-grace"],
				name: "Site",
			},
		],
		threads: [
			thread({
				agentIds: ["agent-grace"],
				id: "thread-hero",
				lastMessage: "Swapping the hero now.",
				messageCount: 9,
				projectId: "project-site",
				running: true,
				title: "Rebuild the hero",
				updatedAt: at(2 * MINUTE),
			}),
			thread({
				agentIds: ["agent-ada"],
				id: "thread-notes",
				lastMessage: "Here are the notes.",
				messageCount: 4,
				title: "Release notes",
				updatedAt: at(30 * MINUTE),
			}),
			thread({
				agentIds: ["agent-ada", "agent-grace"],
				id: "thread-week",
				lastMessage: "Plan locked.",
				lastMessageRole: "user",
				messageCount: 12,
				title: "Last week plan",
				updatedAt: at(7 * DAY),
			}),
		],
		version: 1,
	};
}

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Day grouping (Today, held, travel days) is local-calendar based, so a fixture
// built from the live clock flips sections when the run straddles midnight.
// Every test runs at one fixed local mid-day instant instead.
beforeEach(() => {
	setSystemTime(FIXED_NOW);
});
afterEach(() => {
	setSystemTime();
});
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

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
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
}

interface PortCalls {
	closed: number;
	opened: string[];
	started: Parameters<InterfacePort["startThread"]>[0][];
}

function recordingPort(): { calls: PortCalls; port: InterfacePort } {
	const calls: PortCalls = { closed: 0, opened: [], started: [] };
	return {
		calls,
		port: {
			closeThread: () => {
				calls.closed += 1;
			},
			openThread: (id) => {
				calls.opened.push(id);
			},
			startThread: (input) => {
				calls.started.push(input);
			},
		},
	};
}

describe("journal model", () => {
	test("files each thread on the local day of its latest activity", () => {
		const now = localNoon(2026, 10, 14);
		const entries = buildJournalEntries(snapshotAt(now));
		expect(entries.map((entry) => entry.thread.id)).toEqual([
			"thread-hero",
			"thread-notes",
			"thread-week",
		]);
		expect(entries[0]?.day).toBe("2026-10-14");
		expect(entries[0]?.place).toBe("Site");
		expect(entries[0]?.status).toBe("working");
		expect(entries[2]?.day).toBe("2026-10-07");
		const months = groupJournalMonths(entries);
		expect(months).toHaveLength(1);
		expect(months[0]?.days.map((day) => day.key)).toEqual([
			"2026-10-14",
			"2026-10-07",
		]);
	});

	test("skips threads with an unreadable timestamp", () => {
		const snapshot = snapshotAt(localNoon(2026, 10, 14));
		snapshot.threads.push(thread({ id: "thread-bad", updatedAt: "nope" }));
		expect(
			buildJournalEntries(snapshot).some(
				(entry) => entry.thread.id === "thread-bad"
			)
		).toBe(false);
	});

	test("search matches titles, messages, agents, and places", () => {
		const entries = buildJournalEntries(snapshotAt(localNoon(2026, 10, 14)));
		const ids = (query: string) =>
			filterJournalEntries(entries, query).map((entry) => entry.thread.id);
		expect(ids("notes")).toEqual(["thread-notes"]);
		expect(ids("GRACE")).toEqual(["thread-hero", "thread-week"]);
		expect(ids("site")).toEqual(["thread-hero"]);
		expect(ids("  ")).toHaveLength(3);
		expect(ids("nothing like this")).toEqual([]);
	});

	test("a streak survives a blank today and breaks on a gap", () => {
		const today = localNoon(2026, 10, 14);
		const days = new Set(["2026-10-13", "2026-10-12", "2026-10-10"]);
		expect(currentStreak(days, today)).toBe(2);
		days.add("2026-10-14");
		expect(currentStreak(days, today)).toBe(3);
		expect(currentStreak(new Set(["2026-10-11"]), today)).toBe(0);
		expect(longestStreak(days)).toBe(3);
		expect(longestStreak(new Set())).toBe(0);
	});

	test("month shifts clamp to the end of shorter months", () => {
		expect(shiftMonthKey("2026-03-31", -1)).toBe("2026-02-28");
		expect(shiftMonthKey("2026-01-15", -1)).toBe("2025-12-15");
		expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
	});

	test("on this day looks back by weeks, months, and years", () => {
		const entries = buildJournalEntries({
			...snapshotAt(localNoon(2026, 10, 14)),
			threads: [
				thread({ id: "a", updatedAt: localNoon(2026, 10, 7).toISOString() }),
				thread({ id: "b", updatedAt: localNoon(2026, 9, 14).toISOString() }),
				thread({ id: "c", updatedAt: localNoon(2025, 10, 14).toISOString() }),
				thread({ id: "d", updatedAt: localNoon(2026, 10, 13).toISOString() }),
			],
		});
		const groups = onThisDay(entriesByDay(entries), "2026-10-14");
		expect(groups.map((group) => [group.key, group.label])).toEqual([
			["2026-10-07", "1 week ago"],
			["2026-09-14", "1 month ago"],
			["2025-10-14", "1 year ago"],
		]);
	});

	test("a clamped month is not the same date", () => {
		const entries = buildJournalEntries({
			...snapshotAt(localNoon(2026, 3, 31)),
			threads: [
				thread({ id: "a", updatedAt: localNoon(2026, 2, 28).toISOString() }),
			],
		});
		expect(onThisDay(entriesByDay(entries), "2026-03-31")).toEqual([]);
	});

	test("month grids cover whole weeks", () => {
		const weeks = monthWeeks("2026-10-14");
		expect(weeks.length).toBeGreaterThanOrEqual(4);
		expect(weeks.length).toBeLessThanOrEqual(6);
		for (const week of weeks) {
			expect(week).toHaveLength(7);
			expect(week[0]?.getDay()).toBe(0);
		}
		expect(localDayKey(weeks[0]?.[0] ?? new Date())).toBe("2026-09-27");
	});

	test("the heatmap spans a year and scales levels to the busiest day", () => {
		const today = localNoon(2026, 10, 14);
		const entries = buildJournalEntries(snapshotAt(today));
		const columns = yearHeatmap(entriesByDay(entries), today);
		expect(columns).toHaveLength(HEATMAP_WEEKS);
		const cells = columns.flatMap((column) => column.cells);
		const todayCell = cells.find((cell) => cell.key === "2026-10-14");
		expect(todayCell?.count).toBe(2);
		expect(todayCell?.level).toBe(4);
		expect(cells.find((cell) => cell.key === "2026-10-07")?.level).toBe(2);
		expect(cells.filter((cell) => cell.future).length).toBe(3);
	});

	test("stats count entries, messages, days, and agents", () => {
		const today = localNoon(2026, 10, 14);
		const stats = journalStats(buildJournalEntries(snapshotAt(today)), today);
		expect(stats.entries).toBe(3);
		expect(stats.messages).toBe(25);
		expect(stats.daysJournaled).toBe(2);
		expect(stats.currentStreak).toBe(1);
		// Tied on entries, so the busier agent leads.
		expect(stats.agents.map((share) => share.agent.name)).toEqual([
			"Grace",
			"Ada",
		]);
		expect(stats.agents[0]?.messages).toBe(21);
	});

	test("neighbors walk the timeline newest first", () => {
		const entries = buildJournalEntries(snapshotAt(localNoon(2026, 10, 14)));
		const middle = entryNeighbors(entries, "thread-notes");
		expect(middle.previous?.thread.id).toBe("thread-hero");
		expect(middle.next?.thread.id).toBe("thread-week");
		expect(middle.position).toBe(2);
		expect(entryNeighbors(entries, null).position).toBe(0);
	});

	test("copy helpers attribute and summarize", () => {
		const entries = buildJournalEntries(snapshotAt(localNoon(2026, 10, 14)));
		expect(entryExcerpt(entries[2]?.thread ?? thread({ id: "x" }))).toBe(
			"You: Plan locked."
		);
		expect(entryExcerpt(thread({ id: "empty" }))).toBe("No messages yet.");
		expect(agentNames([])).toBe("No agent");
		expect(agentNames(entries[2]?.agents ?? [])).toBe("Ada and Grace");
		const snapshot = snapshotAt(localNoon(2026, 10, 14));
		expect(eventsOnDay(snapshot.events, "2026-10-14")).toHaveLength(1);
		expect(eventsOnDay(undefined, "2026-10-14")).toEqual([]);
	});
});

describe("journal interface", () => {
	// The renderer reads the wall clock for "today"; the file-wide pin holds it
	// at local noon so entries an hour or two old never cross midnight.
	const NOW = FIXED_NOW;

	test("renders the day page, timeline, and strip for today", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<JournalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOW)}
				threadView={null}
			/>
		);
		const root = view.container.querySelector(
			'[data-testid="interface-journal"]'
		);
		expect(root).not.toBeNull();
		expect(root?.querySelector('nav[aria-label="Entries"]')).not.toBeNull();
		expect(root?.textContent).toContain("Rebuild the hero");
		expect(root?.textContent).toContain("1 day streak");
		expect(root?.textContent).toContain("Morning digest");
		// Today's strip cell is marked as the current date.
		expect(root?.querySelector('[aria-current="date"]')).not.toBeNull();
		await view.dispose();
	});

	test("opening an entry goes through the port and shows the host view", async () => {
		const { calls, port } = recordingPort();
		const snapshot = snapshotAt(NOW);
		const view = await mount(
			<JournalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshot}
				threadView={null}
			/>
		);
		const row = view.container.querySelector(
			'nav[aria-label="Entries"] [data-thread-id="thread-notes"]'
		);
		await click(row);
		expect(calls.opened).toEqual(["thread-notes"]);

		await view.rerender(
			<JournalInterface
				activeThreadId="thread-notes"
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshot}
				threadView={<div data-testid="host-thread">chat</div>}
			/>
		);
		const body = view.container.querySelector(
			'[data-slot="journal-entry-body"]'
		);
		expect(body?.querySelector('[data-testid="host-thread"]')).not.toBeNull();
		const titles = [...view.container.querySelectorAll("h1")];
		expect(titles.map((title) => title.textContent)).toEqual(["Release notes"]);
		expect(
			view.container.querySelector('article[aria-label="Release notes"] h1')
				?.textContent
		).toBe("Release notes");
		expect(view.container.textContent).toContain("2 of 3");

		await click(button(view.container, "Newer entry"));
		expect(calls.opened).toEqual(["thread-notes", "thread-hero"]);
		await click(button(view.container, "Older entry"));
		expect(calls.opened.at(-1)).toBe("thread-week");
		await view.dispose();
	});

	test("a new entry starts only with the prompt the user submitted", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<JournalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOW)}
				threadView={null}
			/>
		);
		await click(button(view.container, "New entry"));
		const form = view.container.querySelector('form[aria-label="New entry"]');
		expect(form).not.toBeNull();
		expect(calls.started).toEqual([]);

		const field = form?.querySelector("textarea");
		const select = form?.querySelector("select");
		if (!(field && select)) {
			throw new Error("Expected the composer fields");
		}
		await act(async () => {
			select.value = "agent-grace";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			)?.set;
			field.focus();
			setter?.call(field, "  Plan the launch  ");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		await click(button(view.container, "Start entry"));
		expect(calls.started).toEqual([
			{ agentId: "agent-grace", prompt: "Plan the launch" },
		]);
		await view.dispose();
	});

	test("calendar and stats views select days back into the day page", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<JournalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOW)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Calendar"));
		expect(view.container.querySelector('[role="grid"]')).not.toBeNull();
		await click(button(view.container, "Stats"));
		expect(view.container.textContent).toContain("Longest streak");
		expect(view.container.textContent).toContain("Activity");
		const weekAgo = localDayKey(new Date(Date.now() - 7 * DAY));
		const cell = [
			...view.container.querySelectorAll("button[aria-label]"),
		].find((candidate) =>
			candidate.getAttribute("aria-label")?.endsWith("1 entry")
		);
		expect(cell).toBeDefined();
		await click(cell);
		expect(view.container.querySelector('[role="grid"]')).toBeNull();
		expect(
			view.container.querySelector('section[aria-label="Entries"]')
		).not.toBeNull();
		expect(weekAgo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		await view.dispose();
	});

	test("the year heatmap is one tab stop that arrows move through", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<JournalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOW)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Stats"));
		const heatmap = view.container.querySelector(
			'[aria-roledescription="heatmap"]'
		);
		const days = [...(heatmap?.querySelectorAll("button") ?? [])];
		expect(days.length).toBeGreaterThan(300);
		const stops = days.filter((day) => day.tabIndex === 0);
		expect(stops.map((day) => day.dataset.day)).toEqual(["2026-10-14"]);
		await act(async () => {
			stops[0]?.focus();
			stops[0]?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
			);
		});
		const moved = days.filter((day) => day.tabIndex === 0);
		expect(moved.map((day) => day.dataset.day)).toEqual(["2026-10-07"]);
		expect(document.activeElement?.getAttribute("data-day")).toBe("2026-10-07");
		await view.dispose();
	});

	test("entry shortcuts work from anywhere outside text fields", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<JournalInterface
				activeThreadId="thread-notes"
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOW)}
				threadView={<div data-testid="host-thread">chat</div>}
			/>
		);
		await act(async () => {
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", {
					altKey: true,
					bubbles: true,
					key: "ArrowDown",
				})
			);
		});
		expect(calls.opened).toEqual(["thread-week"]);
		const field = document.createElement("input");
		document.body.append(field);
		await act(async () => {
			field.dispatchEvent(
				new KeyboardEvent("keydown", {
					altKey: true,
					bubbles: true,
					key: "ArrowUp",
				})
			);
		});
		expect(calls.opened).toEqual(["thread-week"]);
		field.remove();
		// The host's own chrome keeps its keys.
		const chrome = document.createElement("button");
		document.body.append(chrome);
		await act(async () => {
			chrome.dispatchEvent(
				new KeyboardEvent("keydown", {
					altKey: true,
					bubbles: true,
					key: "ArrowDown",
				})
			);
		});
		expect(calls.opened).toEqual(["thread-week"]);
		chrome.remove();
		// While the host covers the journal it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await act(async () => {
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", {
					altKey: true,
					bubbles: true,
					key: "ArrowDown",
				})
			);
		});
		expect(calls.opened).toEqual(["thread-week"]);
		view.container.removeAttribute("inert");
		await view.dispose();
	});

	test("the calendar month is one tab stop that arrows move through", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<JournalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOW)}
				threadView={null}
			/>
		);
		await click(button(view.container, "Calendar"));
		const grid = view.container.querySelector('[role="grid"]');
		const days = [...(grid?.querySelectorAll("button") ?? [])];
		expect(days.length % 7).toBe(0);
		const stops = days.filter((day) => day.tabIndex === 0);
		expect(stops.map((day) => day.dataset.day)).toEqual(["2026-10-14"]);
		await act(async () => {
			stops[0]?.focus();
			stops[0]?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })
			);
		});
		const moved = days.filter((day) => day.tabIndex === 0);
		expect(moved.map((day) => day.dataset.day)).toEqual(["2026-10-07"]);
		expect(document.activeElement?.getAttribute("data-day")).toBe("2026-10-07");
		await view.dispose();
	});

	test("searching narrows the timeline and says when nothing matches", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<JournalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshotAt(NOW)}
				threadView={null}
			/>
		);
		const input = view.container.querySelector('input[type="search"]');
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Expected the search field");
		}
		const type = async (value: string) => {
			await act(async () => {
				const setter = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value"
				)?.set;
				input.focus();
				setter?.call(input, value);
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
			});
		};
		await type("notes");
		const rows = view.container.querySelectorAll(
			'nav[aria-label="Entries"] [data-thread-id]'
		);
		expect(rows).toHaveLength(1);
		await type("zzz");
		expect(view.container.textContent).toContain('No entries match "zzz"');
		await view.dispose();
	});

	test("loading and empty journals have their own states", () => {
		const { port } = recordingPort();
		const loading = renderToStaticMarkup(
			<JournalInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={{ agents: [], groups: [], threads: [], version: 1 }}
				threadView={null}
			/>
		);
		expect(loading).toContain('aria-label="Loading entries"');
		expect(loading).toContain('aria-label="Loading day"');

		const empty = renderToStaticMarkup(
			<JournalInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ agents: [], groups: [], threads: [], version: 1 }}
				threadView={null}
			/>
		);
		expect(empty).toContain("No entries yet");
		expect(empty).toContain("Nothing written today");
		expect(empty).toContain('data-testid="interface-journal"');
	});
});
