// The DOM first, before React loads (seasonal-test-dom.ts).
import "./seasonal-test-dom.ts";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import type {
	InterfaceAgentAct,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
	SeasonalParams,
} from "@ryuhq/protocol/interfaces";
import {
	agentActs,
	resolveInterfaceParams,
	unownedAsks,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	FIXTURE_AGENT_IDS,
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	FIXTURE_PRIVATE_STRINGS,
	FIXTURE_THREAD_IDS,
	usefulStateFixture,
} from "./game-acts-fixture.ts";
import { limitWords } from "./game3d-act-stage.tsx";
import { actOverlays, overlayBudget, youSpotSlots } from "./game3d-acts.ts";
import { islandFor } from "./game3d-ground.tsx";
import { onIsland } from "./game3d-island.ts";
import {
	actVillagers,
	boardAgents,
	doorActs,
	SEASON_ACT_WORDS,
	seasonActPaths,
	seasonLimit,
	seasonStations,
	youPoints,
} from "./seasonal-acts.tsx";
import { GRID_SLOTS } from "./seasonal-grid.tsx";
import {
	localDateChanged,
	SeasonalInterface,
	seasonalSettings,
} from "./seasonal-interface.tsx";
import {
	boardSummary,
	buildBoard,
	DOOR_COUNT,
	doorInDirection,
	doorLabel,
	doorOrder,
	isOpened,
	latestLine,
	OPENED_KEY,
	parseOpened,
	resolveSeason,
	SEASON_COPY,
	seasonForDate,
	serializeOpened,
	todayDoor,
} from "./seasonal-model.ts";
import { seasonalDom } from "./seasonal-test-dom.ts";
import { layoutSeasonWorld } from "./seasonal-world.ts";
import { ActClockProvider } from "./use-acts.ts";

// Again here: another Seasonal test file may have taken the DOM down.
seasonalDom();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

function snapshotAt(now: number): InterfaceSnapshot {
	const at = (offset: number) => new Date(now - offset).toISOString();
	return {
		agents: [
			{
				avatarUrl: null,
				description: "Digs through papers",
				id: "agent-atlas",
				name: "Atlas",
				status: "idle",
			},
			{
				avatarUrl: null,
				description: "Ships the site",
				id: "agent-forge",
				name: "Forge",
				status: "working",
			},
		],
		groups: [],
		threads: [
			thread({
				agentIds: ["agent-forge"],
				id: "thread-hero",
				lastMessage: "Swapping the hero type scale now.",
				running: true,
				title: "Rebuild the landing hero",
				updatedAt: at(MINUTE),
			}),
			thread({
				agentIds: ["agent-atlas", "agent-forge"],
				id: "thread-plan",
				lastMessage: "Plan locked for launch week.",
				title: "Launch week plan",
				updatedAt: at(2 * HOUR),
			}),
			thread({
				agentIds: ["agent-atlas"],
				id: "thread-research",
				lastMessage: "Can you add the Medusa results?",
				lastMessageRole: "user",
				title: "Survey speculative decoding papers",
				updatedAt: at(3 * HOUR),
			}),
			thread({
				agentIds: ["agent-atlas"],
				id: "thread-audit",
				runState: "failed",
				title: "Audit lockfile advisories",
				updatedAt: at(4 * HOUR),
			}),
			thread({
				id: "thread-general",
				lastMessageRole: null,
				title: "Office closed Friday",
				updatedAt: at(9 * HOUR),
			}),
		],
		version: 1,
	};
}

// Pin the clock so "auto" season, today's door, and relative dates never
// depend on when (or how slowly) the suite runs.
const FIXED_NOW = new Date(2026, 10, 28, 12, 0, 0);
beforeEach(() => {
	setSystemTime(FIXED_NOW);
	window.localStorage.clear();
});
afterEach(() => {
	setSystemTime();
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

function button(container: HTMLElement, label: string | RegExp) {
	return [...container.querySelectorAll("button")].find((candidate) => {
		const name =
			candidate.getAttribute("aria-label") ?? candidate.textContent?.trim();
		return typeof label === "string" ? name === label : label.test(name ?? "");
	});
}

function door(container: HTMLElement, number: number) {
	return container.querySelector<HTMLButtonElement>(`[data-door="${number}"]`);
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

function seasonal(
	overrides: Partial<{
		activeThreadId: string | null;
		loading: boolean;
		port: InterfacePort;
		season: SeasonalParams["season"];
		snapshot: InterfaceSnapshot;
		threadView: ReactElement | null;
	}> = {}
) {
	return (
		<SeasonalInterface
			activeThreadId={overrides.activeThreadId ?? null}
			loading={overrides.loading ?? false}
			params={{ season: overrides.season ?? "advent" }}
			port={overrides.port ?? recordingPort().port}
			snapshot={overrides.snapshot ?? snapshotAt(Date.now())}
			threadView={overrides.threadView ?? null}
		/>
	);
}

describe("seasonal model", () => {
	test("auto picks the season from the date", () => {
		expect(seasonForDate(new Date(2026, 9, 14))).toBe("halloween");
		expect(seasonForDate(new Date(2026, 10, 5))).toBe("advent");
		expect(seasonForDate(new Date(2026, 10, 24))).toBe("advent");
		expect(seasonForDate(new Date(2026, 11, 20))).toBe("advent");
		expect(seasonForDate(new Date(2027, 0, 5))).toBe("advent");
		expect(seasonForDate(new Date(2027, 0, 20))).toBe("lunar-new-year");
		expect(seasonForDate(new Date(2027, 1, 10))).toBe("lunar-new-year");
		expect(seasonForDate(new Date(2027, 5, 1))).toBe("advent");
		expect(resolveSeason("auto", new Date(2026, 9, 1))).toBe("halloween");
		expect(resolveSeason("lunar-new-year", new Date(2026, 9, 1))).toBe(
			"lunar-new-year"
		);
		expect(todayDoor(new Date(2026, 11, 24), "advent")).toBe(24);
		expect(todayDoor(new Date(2026, 11, 25), "advent")).toBeNull();
	});

	test("today's door only shows in the season's own month", () => {
		expect(todayDoor(new Date(2026, 10, 20), "advent")).toBeNull();
		expect(todayDoor(new Date(2026, 9, 20), "advent")).toBeNull();
		expect(todayDoor(new Date(2026, 9, 20), "halloween")).toBe(20);
		expect(todayDoor(new Date(2026, 11, 20), "halloween")).toBeNull();
		expect(todayDoor(new Date(2027, 1, 3), "lunar-new-year")).toBe(3);
		expect(todayDoor(new Date(2026, 10, 20), "lunar-new-year")).toBeNull();
	});

	test("today is marked only in each board's own month", () => {
		expect(todayDoor(new Date(2026, 11, 1), "advent")).toBe(1);
		// The 14th of October is not a day on an Advent calendar.
		expect(todayDoor(new Date(2026, 9, 14), "advent")).toBeNull();
		expect(todayDoor(new Date(2026, 11, 14), "halloween")).toBeNull();
		expect(todayDoor(new Date(2026, 11, 14), "lunar-new-year")).toBeNull();
		// The pumpkin patch counts through October, the lanterns through
		// January and February; days past the 24th have no door.
		expect(todayDoor(new Date(2026, 9, 15), "halloween")).toBe(15);
		expect(todayDoor(new Date(2026, 9, 31), "halloween")).toBeNull();
		expect(todayDoor(new Date(2027, 0, 20), "lunar-new-year")).toBe(20);
		expect(todayDoor(new Date(2027, 1, 3), "lunar-new-year")).toBe(3);
		expect(todayDoor(new Date(2027, 1, 26), "lunar-new-year")).toBeNull();
		expect(todayDoor(new Date(2027, 2, 3), "lunar-new-year")).toBeNull();
		expect(doorOrder(null).slice(0, 3)).toEqual([1, 2, 3]);
		expect(doorOrder(10).slice(0, 3)).toEqual([10, 1, 2]);
		expect(doorOrder(10)).toHaveLength(DOOR_COUNT);
	});

	test("the most urgent conversation sits behind today's door", () => {
		const board = buildBoard(snapshotAt(Date.now()), {}, 10);
		expect(board.doors[9]?.thread?.id).toBe("thread-audit");
		expect(board.doors[9]?.number).toBe(10);
		expect(board.doors[0]?.thread?.id).toBe("thread-plan");
		expect(board.doors.map((item) => item.number)).toEqual(
			Array.from({ length: DOOR_COUNT }, (_, index) => index + 1)
		);
	});

	test("numbers doors most urgent first and leaves the rest empty", () => {
		const board = buildBoard(snapshotAt(Date.now()), {});
		expect(board.doors).toHaveLength(DOOR_COUNT);
		expect(board.doors.slice(0, 5).map((item) => item.thread?.id)).toEqual([
			"thread-audit",
			"thread-plan",
			"thread-hero",
			"thread-research",
			"thread-general",
		]);
		expect(board.doors.slice(0, 5).map((item) => item.mark)).toEqual([
			"needs-you",
			"needs-you",
			"working",
			null,
			null,
		]);
		expect(board.doors[5]?.thread).toBeNull();
		expect(board.overflow).toEqual([]);
		expect(board.totals).toEqual({ needsYou: 2, threads: 5, working: 1 });
		expect(boardSummary(board, SEASON_COPY.advent)).toBe(
			"5 doors · 2 need you · 1 working"
		);
	});

	test("an opened door loses its ribbon until a newer reply arrives", () => {
		const now = Date.now();
		const snapshot = snapshotAt(now);
		const plan = snapshot.threads[1];
		if (!plan) {
			throw new Error("fixture");
		}
		const opened = { [plan.id]: plan.updatedAt };
		expect(isOpened(plan, opened)).toBe(true);
		const board = buildBoard(snapshot, opened);
		expect(board.doors[1]?.opened).toBe(true);
		expect(board.doors[1]?.mark).toBeNull();
		const newer = { ...plan, updatedAt: new Date(now).toISOString() };
		expect(isOpened(newer, opened)).toBe(false);
		// Working threads keep moving; their door stays open.
		const hero = {
			...snapshot.threads[0],
			id: "thread-hero",
		} as InterfaceThread;
		expect(isOpened(hero, { "thread-hero": "2000-01-01T00:00:00.000Z" })).toBe(
			true
		);
	});

	test("past the 24th door, conversations go to the overflow list", () => {
		const now = Date.now();
		const snapshot = snapshotAt(now);
		snapshot.threads = Array.from({ length: 30 }, (_, index) =>
			thread({
				id: `thread-${index}`,
				updatedAt: new Date(now - index * MINUTE).toISOString(),
			})
		);
		const board = buildBoard(snapshot, {});
		expect(board.doors.every((item) => item.thread !== null)).toBe(true);
		expect(board.overflow.map((item) => item.id)).toEqual([
			"thread-24",
			"thread-25",
			"thread-26",
			"thread-27",
			"thread-28",
			"thread-29",
		]);
	});

	test("opened doors survive malformed storage", () => {
		expect(parseOpened(null)).toEqual({});
		expect(parseOpened("not json")).toEqual({});
		expect(parseOpened("[1,2]")).toEqual({});
		expect(parseOpened('{"a":"2026-01-01","b":3}')).toEqual({
			a: "2026-01-01",
		});
		const many = Object.fromEntries(
			Array.from({ length: 500 }, (_, index) => [
				`t${index}`,
				new Date(index * MINUTE).toISOString(),
			])
		);
		const kept = parseOpened(serializeOpened(many));
		expect(Object.keys(kept)).toHaveLength(400);
		expect(kept.t499).toBeDefined();
		expect(kept.t0).toBeUndefined();
	});

	test("labels and latest lines read in the user's terms", () => {
		const board = buildBoard(snapshotAt(Date.now()), {});
		const first = board.doors[0];
		const empty = board.doors[23];
		if (!(first && empty)) {
			throw new Error("fixture");
		}
		expect(doorLabel(first, SEASON_COPY.advent)).toBe(
			"Door 1, Audit lockfile advisories, needs attention"
		);
		expect(doorLabel(empty, SEASON_COPY.halloween)).toBe(
			"Pumpkin 24, empty. Add a pumpkin"
		);
		// Today and opened come straight after the number, before the title.
		expect(
			doorLabel({ ...first, opened: true }, SEASON_COPY.advent, true)
		).toBe("Door 1, today, opened, Audit lockfile advisories, needs attention");
		expect(doorLabel(empty, SEASON_COPY.advent, true)).toBe(
			"Door 24, today, empty. Add a door"
		);
		expect(
			latestLine(
				thread({
					id: "a",
					lastMessage: " hi\n  there ",
					lastMessageRole: "user",
				})
			)
		).toBe("You: hi there");
		expect(latestLine(thread({ id: "b" }))).toBeNull();
	});

	test("up and down move to the nearest door above or below", () => {
		const slots = GRID_SLOTS;
		// The plain board is a six-wide grid: 11 sits under 5, in the same column.
		expect(doorInDirection(slots, 11, "up")).toBe(5);
		expect(doorInDirection(slots, 5, "down")).toBe(11);
		// The top row has nothing above it, the bottom row nothing below.
		expect(doorInDirection(slots, 1, "up")).toBeNull();
		expect(doorInDirection(slots, 19, "down")).toBeNull();
		expect(doorInDirection(slots, 24, "up")).toBe(18);
	});
});

/** Where a world point lands on screen, in world units (camera at 45°). */
function onScreen([x, y, z]: readonly [number, number, number]) {
	const pitch = 0.56;
	return [
		(x - z) * Math.SQRT1_2,
		y * Math.cos(pitch) - (x + z) * Math.SQRT1_2 * Math.sin(pitch),
	] as const;
}

describe("seasonal worlds", () => {
	for (const season of ["advent", "halloween", "lunar-new-year"] as const) {
		test(`${season} places doors 1 to 24 once each, apart, on the island`, () => {
			const world = layoutSeasonWorld(season);
			const numbers = world.doors
				.map((door) => door.number)
				.sort((a, b) => a - b);
			expect(numbers).toEqual(
				Array.from({ length: DOOR_COUNT }, (_, index) => index + 1)
			);
			for (const door of world.doors) {
				expect(door.at[0]).toBeGreaterThan(world.bounds.minX);
				expect(door.at[0]).toBeLessThan(world.bounds.maxX);
				expect(door.at[2]).toBeGreaterThan(world.bounds.minZ);
				expect(door.at[2]).toBeLessThan(world.bounds.maxZ);
				expect(door.plate[1]).toBeLessThan(world.top);
			}
			// No two number plates land on top of each other on screen.
			for (const [index, door] of world.doors.entries()) {
				const [ax, ay] = onScreen(door.plate);
				for (const other of world.doors.slice(index + 1)) {
					const [bx, by] = onScreen(other.plate);
					expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(0.7);
				}
			}
		});
	}
});

describe("SeasonalInterface", () => {
	test("renders the advent board with 24 numbered doors", () => {
		const markup = renderToStaticMarkup(seasonal());
		expect(markup).toContain('data-testid="interface-seasonal"');
		expect(markup).toContain('data-season="advent"');
		expect(markup).toContain("Advent calendar");
		expect(markup.match(/data-door="/g)).toHaveLength(DOOR_COUNT);
		expect(markup).toContain(
			'aria-label="Door 1, Audit lockfile advisories, needs attention"'
		);
		expect(markup).toContain('aria-label="Door 6, empty. Add a door"');
		// The title plate counts the doors and what needs you.
		expect(markup).toContain("5 doors · 2 need you · 1 working");
	});

	test("each season dresses the same conversations differently", () => {
		const halloween = renderToStaticMarkup(seasonal({ season: "halloween" }));
		expect(halloween).toContain('data-season="halloween"');
		expect(halloween).toContain("Pumpkin patch");
		expect(halloween).toContain(
			'aria-label="Pumpkin 1, Audit lockfile advisories'
		);
		const lunar = renderToStaticMarkup(seasonal({ season: "lunar-new-year" }));
		expect(lunar).toContain("Lantern festival");
		expect(lunar).toContain(
			'aria-label="Lantern 2, Launch week plan, your turn"'
		);
	});

	test("shows a skeleton while loading and a note when there is nothing yet", () => {
		const loading = renderToStaticMarkup(seasonal({ loading: true }));
		expect(loading).toContain("data-seasonal-loading");
		expect(loading).not.toContain("data-door=");
		const snapshot = snapshotAt(Date.now());
		snapshot.threads = [];
		snapshot.agents = [];
		const empty = renderToStaticMarkup(seasonal({ snapshot }));
		expect(empty).toContain("No conversations yet");
		expect(empty).toContain('aria-label="Door 1, empty. Add a door"');
	});

	test("opening a door reveals its gift card and remembers it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(seasonal({ port }));
		const first = door(view.container, 2);
		expect(first?.getAttribute("data-state")).toBe("closed");
		await click(first);
		expect(first?.getAttribute("data-state")).toBe("open");
		const card = view.container.querySelector('[role="dialog"]');
		const titleId = card?.getAttribute("aria-labelledby") ?? "";
		expect(document.getElementById(titleId)?.textContent).toBe(
			"Door 2: Launch week plan"
		);
		// The door says it controls the card it has expanded.
		expect(first?.getAttribute("aria-expanded")).toBe("true");
		expect(first?.getAttribute("aria-controls")).toBe(card?.id ?? "missing");
		expect(first?.getAttribute("aria-label")).toBe(
			"Door 2, opened, Launch week plan, your turn"
		);
		expect(card?.textContent).toContain("Plan locked for launch week.");
		expect(card?.textContent).toContain("Atlas, Forge");
		expect(parseOpened(window.localStorage.getItem(OPENED_KEY))).toHaveProperty(
			"thread-plan"
		);
		expect(calls.opened).toEqual([]);
		await click(button(view.container, "Open conversation"));
		expect(calls.opened).toEqual(["thread-plan"]);
		expect(view.container.querySelector('[role="dialog"]')).toBeNull();
		await view.dispose();
	});

	test("closing the gift card hands focus back to its door", async () => {
		const view = await mount(seasonal());
		const second = door(view.container, 2);
		await click(second);
		expect(second?.getAttribute("aria-expanded")).toBe("true");
		await click(button(view.container, "Close"));
		expect(view.container.querySelector('[role="dialog"]')).toBeNull();
		expect(second?.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(second);
		await view.dispose();
	});

	test("today's door is marked, and empty places are quiet closed doors", () => {
		setSystemTime(new Date(2026, 11, 2, 12));
		const markup = renderToStaticMarkup(seasonal());
		// The most urgent conversation sits behind today's door, which carries
		// the word as well as the ring.
		expect(markup).toContain(
			'aria-label="Door 2, today, Audit lockfile advisories, needs attention"'
		);
		expect(markup.match(/data-today-word/g)).toHaveLength(1);
		// Five conversations, so 19 doors stay shut with nothing behind them,
		// door 24 among them.
		expect(markup.match(/data-empty-door/g)).toHaveLength(DOOR_COUNT - 5);
		expect(markup).toContain('aria-label="Door 24, empty. Add a door"');
		// Later in December the mark moves to that day's door.
		setSystemTime(new Date(2026, 11, 8, 12));
		const later = renderToStaticMarkup(seasonal());
		expect(later).toContain('aria-label="Door 8, today, Audit lockfile');
		expect(later.match(/data-today-word/g)).toHaveLength(1);
		// The pumpkin patch marks today in October.
		setSystemTime(new Date(2026, 9, 15, 12));
		const patch = renderToStaticMarkup(seasonal({ season: "auto" }));
		expect(patch).toContain('data-season="halloween"');
		expect(patch).toContain('aria-label="Pumpkin 15, today, Audit lockfile');
	});

	test("a door can be marked unopened again", async () => {
		const view = await mount(seasonal());
		await click(door(view.container, 1));
		await click(button(view.container, "Mark unopened"));
		expect(door(view.container, 1)?.getAttribute("data-state")).toBe("closed");
		expect(parseOpened(window.localStorage.getItem(OPENED_KEY))).toEqual({});
		await view.dispose();
	});

	test("opened doors come back from storage", async () => {
		const snapshot = snapshotAt(Date.now());
		const plan = snapshot.threads[1];
		window.localStorage.setItem(
			OPENED_KEY,
			JSON.stringify({ [plan?.id ?? ""]: plan?.updatedAt })
		);
		const view = await mount(seasonal({ snapshot }));
		expect(door(view.container, 2)?.getAttribute("data-state")).toBe("open");
		expect(door(view.container, 1)?.getAttribute("data-state")).toBe("closed");
		await view.dispose();
	});

	test("an empty door opens the composer, and only a typed prompt is sent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(seasonal({ port }));
		await click(door(view.container, 9));
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("Expected the composer");
		}
		expect(calls.started).toEqual([]);
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			)?.set;
			field.focus();
			setter?.call(field, "  Plan the holiday rota  ");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		await click(button(view.container, "Start"));
		expect(calls.started).toEqual([
			{ agentId: "agent-atlas", prompt: "Plan the holiday rota" },
		]);
		await view.dispose();
	});

	test("the open conversation hangs beside the board on a gift tag", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			seasonal({
				activeThreadId: "thread-plan",
				port,
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const panel = view.container.querySelector("[data-seasonal-panel]");
		expect(panel?.querySelector('[data-testid="host-thread"]')).not.toBeNull();
		expect(panel?.textContent).toContain("Launch week plan");
		expect(door(view.container, 2)?.getAttribute("data-state")).toBe("open");
		await click(button(view.container, "Close conversation"));
		expect(calls.closed).toBe(1);
		await view.dispose();
	});

	test("the season switcher starts from the param and redresses the board", async () => {
		const view = await mount(seasonal({ season: "lunar-new-year" }));
		const root = view.container.querySelector(
			'[data-testid="interface-seasonal"]'
		);
		expect(root?.getAttribute("data-season")).toBe("lunar-new-year");
		await click(button(view.container, "Halloween"));
		expect(root?.getAttribute("data-season")).toBe("halloween");
		expect(view.container.textContent).toContain("Pumpkin patch");
		await view.rerender(seasonal({ season: "advent" }));
		expect(root?.getAttribute("data-season")).toBe("advent");
		await view.dispose();
	});

	test("arrow keys move between doors in number order", async () => {
		const view = await mount(seasonal());
		const first = door(view.container, 1);
		first?.focus();
		await act(async () => {
			first?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
		expect(document.activeElement).toBe(door(view.container, 2));
		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "End" })
			);
		});
		expect(document.activeElement).toBe(door(view.container, 24));
		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })
			);
		});
		// Door 24 ends the grid; above it is door 18.
		expect(document.activeElement?.getAttribute("data-door")).toBe("18");
		await view.dispose();
	});

	test("more than 24 conversations offer a More gifts list", async () => {
		const now = Date.now();
		const snapshot = snapshotAt(now);
		snapshot.threads = Array.from({ length: 27 }, (_, index) =>
			thread({
				id: `thread-${index}`,
				title: `Conversation ${index}`,
				updatedAt: new Date(now - index * MINUTE).toISOString(),
			})
		);
		const { calls, port } = recordingPort();
		const view = await mount(seasonal({ port, snapshot }));
		await click(button(view.container, /^More gifts/));
		const panel = view.container.querySelector("[data-seasonal-panel]");
		expect(panel?.querySelectorAll("li")).toHaveLength(3);
		await click(button(view.container, "Conversation 25"));
		expect(calls.opened).toEqual(["thread-25"]);
		await view.dispose();
	});
});

describe("Seasonal useful state", () => {
	const SEASON_LIST = ["advent", "halloween", "lunar-new-year"] as const;
	const fixturePort = () => {
		const calls: string[] = [];
		const port: InterfacePort = {
			answerAsk: async (askId, choiceId) => {
				calls.push(`answer:${askId}:${choiceId}`);
			},
			closeThread: () => calls.push("close"),
			openInbox: () => calls.push("inbox"),
			openThread: (id) => calls.push(`open:${id}`),
			startThread: () => calls.push("start"),
		};
		return { calls, port };
	};
	const onFixture = (
		snapshot: InterfaceSnapshot = usefulStateFixture(),
		port: InterfacePort = fixturePort().port,
		season: SeasonalParams["season"] = "advent"
	) => (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			<SeasonalInterface
				activeThreadId={null}
				loading={false}
				params={{ season }}
				port={port}
				snapshot={snapshot}
				threadView={null}
			/>
		</ActClockProvider>
	);
	const fixtureActs = () =>
		agentActs(usefulStateFixture(), FIXTURE_NOW, FIXTURE_CLOCK);
	/** An agent's row in the text equivalent (the fallback's agent list). */
	const agentRow = (container: HTMLElement, id: string) =>
		container
			.querySelector(`[data-act-agent-list] [data-act-agent="${id}"]`)
			?.closest("li");
	const actButtons = (scope: Element | null | undefined, text: string) =>
		[...(scope?.querySelectorAll("button") ?? [])].filter(
			(candidate) => candidate.textContent === text
		);
	/** Clicks like a user: the card opens after the click has finished. */
	const pressAct = async (element: Element | null | undefined) => {
		if (!(element instanceof HTMLElement)) {
			throw new Error("Expected a clickable element");
		}
		act(() => element.click());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});
	};
	/** The board's doors and its stations, as the interface builds them. */
	const stage = (season: (typeof SEASON_LIST)[number]) => {
		const snapshot = usefulStateFixture();
		const acts = fixtureActs();
		const board = buildBoard(snapshot, {}, null, doorActs(snapshot, acts));
		// As the interface lays it out with acts (the patch's checkerboard).
		const world = layoutSeasonWorld(season, true);
		const stations = seasonStations(season, world, board.doors, acts);
		return { acts, board, snapshot, stations, world };
	};

	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			for (const season of SEASON_LIST) {
				const view = await mount(
					onFixture(usefulStateFixture(), fixturePort().port, season)
				);
				await view.dispose();
			}
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("agent rows are described by act.ariaLabel", async () => {
		const view = await mount(onFixture());
		const ada = view.container.querySelector(
			`[data-act-agent-list] [data-act-agent="${FIXTURE_AGENT_IDS.ada}"]`
		);
		const describedBy = ada?.getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(describedBy)?.textContent).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		expect(
			view.container.querySelectorAll("[data-act-agent-list] [data-act-agent]")
		).toHaveLength(10);
		await view.dispose();
	});

	test("Ada's agent-row Answer button opens the ask card", async () => {
		const { calls, port } = fixturePort();
		const view = await mount(onFixture(usefulStateFixture(), port));
		await pressAct(
			actButtons(agentRow(view.container, FIXTURE_AGENT_IDS.ada), "Answer")[0]
		);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		await view.dispose();
	});

	test("Di's agent row has two Details buttons, the second opens the BlockerCard for Nightly backup", async () => {
		const view = await mount(onFixture());
		const details = actButtons(
			agentRow(view.container, FIXTURE_AGENT_IDS.di),
			"Details"
		);
		expect(details).toHaveLength(2);
		await pressAct(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup");
		await view.dispose();
	});

	test("Gu's agent-row Open answer button opens the reply ask card", async () => {
		const view = await mount(onFixture());
		await pressAct(
			actButtons(
				agentRow(view.container, FIXTURE_AGENT_IDS.gu),
				"Open answer"
			)[0]
		);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Edited 3 files"
		);
		await view.dispose();
	});

	test("the HUD summary reads 3 need you · 2 working · 1 failed · 1 limited", async () => {
		for (const season of SEASON_LIST) {
			const view = await mount(
				onFixture(usefulStateFixture(), fixturePort().port, season)
			);
			expect(view.container.textContent).toContain(
				"3 need you · 2 working · 1 failed · 1 limited"
			);
			// The legacy count line ("9 need you") is gone with acts.
			expect(view.container.textContent).not.toContain("9 need you");
			await view.dispose();
		}
	});

	test("the Queue button reads Queue · 9 and is visible", async () => {
		const view = await mount(onFixture());
		const queue = view.container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
		await view.dispose();
	});

	test("AskQueueList lists Ha's heal_fix suggestion", async () => {
		const view = await mount(onFixture());
		const items = [
			...view.container.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].map((item) => item.getAttribute("aria-label"));
		expect(items).toContain(
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
		await view.dispose();
	});

	test("the fallback heading takes focus only with acts", () => {
		const markup = renderToStaticMarkup(onFixture());
		expect(markup).toMatch(
			/<h1 class="sr-only" tabindex="-1">Advent calendar<\/h1>/
		);
		const { asks: _asks, ...old } = usefulStateFixture();
		expect(renderToStaticMarkup(onFixture(old))).toContain(
			'<h1 class="sr-only">Advent calendar</h1>'
		);
	});

	test("without asks the doors, counters and storage are today's", async () => {
		const { asks: _asks, ...old } = usefulStateFixture();
		const markup = renderToStaticMarkup(onFixture(old));
		expect(markup).not.toContain("data-act-agent");
		expect(markup).not.toContain("data-act-status");
		expect(markup).not.toContain("data-ask-queue");
		expect(markup).not.toContain("data-queue-button");
		// Today's count line: every your-turn or failed thread needs you.
		expect(markup).toContain("12 doors · 9 need you · 3 working");
		// Opening a door is still remembered in this browser.
		const view = await mount(onFixture(old));
		await click(door(view.container, 1));
		expect(
			view.container.querySelector('[aria-label="Mark unopened"]')
		).not.toBeNull();
		expect(window.localStorage.getItem(OPENED_KEY)).not.toBeNull();
		await view.dispose();
	});

	test("redacted: no fixture titles, routine names or targets", () => {
		for (const season of SEASON_LIST) {
			const markup = renderToStaticMarkup(
				onFixture(
					usefulStateFixture({ privacy: "redacted" }),
					fixturePort().port,
					season
				)
			);
			for (const secret of FIXTURE_PRIVATE_STRINGS) {
				expect(markup).not.toContain(secret);
			}
		}
	});

	test("opened state comes from thread.unread, never from storage", async () => {
		const view = await mount(onFixture());
		const t = FIXTURE_THREAD_IDS;
		const doorOf = (threadId: string) =>
			[
				...view.container.querySelectorAll<HTMLButtonElement>("[data-door]"),
			].find((item) =>
				item
					.getAttribute("aria-label")
					?.includes(
						usefulStateFixture().threads.find(
							(thread) => thread.id === threadId
						)?.title ?? "?"
					)
			);
		// Gu's and Ju's answers are unread: their doors stay shut; the rest
		// (read) are open.
		expect(doorOf(t.gu)?.dataset.state).toBe("closed");
		expect(doorOf(t.ju)?.dataset.state).toBe("closed");
		expect(doorOf(t.ha)?.dataset.state).toBe("open");
		// Opening a door shows its card but writes nothing to storage, and
		// a stored "opened" never opens an unread door.
		await click(doorOf(t.gu));
		expect(view.container.querySelector("[data-seasonal-gift]")).not.toBeNull();
		expect(
			view.container.querySelector('[aria-label="Mark unopened"]')
		).toBeNull();
		expect(window.localStorage.getItem(OPENED_KEY)).toBeNull();
		await view.dispose();
		window.localStorage.setItem(
			OPENED_KEY,
			JSON.stringify({ [t.gu]: "2099-01-01T00:00:00.000Z" })
		);
		const again = await mount(onFixture());
		const gu = [
			...again.container.querySelectorAll<HTMLButtonElement>("[data-door]"),
		].find((item) =>
			item.getAttribute("aria-label")?.includes("Update the configs")
		);
		expect(gu?.dataset.state).toBe("closed");
		await again.dispose();
	});

	test("door marks follow the acts: asks need you, counted stops frost shut", () => {
		const snapshot = usefulStateFixture();
		const marks = doorActs(snapshot, fixtureActs());
		const t = FIXTURE_THREAD_IDS;
		// Only blocking asks carry the needs-you mark (S2).
		expect([...marks.needsYou].sort()).toEqual([t.ada, t.bo].sort());
		expect([...marks.stopped].sort()).toEqual([t.di, t.diNightly, t.ed].sort());
		expect([...marks.working].sort()).toEqual([t.cy, t.io].sort());
		const board = buildBoard(snapshot, {}, null, marks);
		const mark = (id: string) =>
			board.doors.find((item) => item.thread?.id === id)?.mark;
		expect([mark(t.di), mark(t.diNightly), mark(t.ed)]).toEqual([
			"stopped",
			"stopped",
			"stopped",
		]);
		// Fa sits out her limit and Ha's old failure no longer counts.
		expect([mark(t.fa), mark(t.haDigest), mark(t.gu)]).toEqual([
			null,
			null,
			null,
		]);
	});

	test("the legend reads in the HUD summary's terms with acts", async () => {
		const view = await mount(onFixture());
		const legend = view.container.ownerDocument.querySelector(
			'[aria-label="Legend"]'
		);
		expect(legend?.textContent).toContain("Needs you");
		expect(legend?.textContent).toContain("Working");
		expect(legend?.textContent).toContain("Failed or stopped");
		expect(legend?.textContent).not.toContain("Agent working");
		await view.dispose();
	});

	test("door words, the gift card and the rows come from the acts (S1)", async () => {
		const snapshot = usefulStateFixture();
		const t = FIXTURE_THREAD_IDS;
		const marks = doorActs(snapshot, fixtureActs());
		const board = buildBoard(snapshot, {}, null, marks);
		const doorOf = (id: string) => {
			const found = board.doors.find((item) => item.thread?.id === id);
			if (!found) {
				throw new Error(`no door for ${id}`);
			}
			return found;
		};
		const copy = SEASON_COPY.advent;
		expect(doorLabel(doorOf(t.bo), copy)).toEndWith(", needs you");
		expect(doorLabel(doorOf(t.di), copy)).toEndWith(", stopped: Tests failed");
		expect(doorLabel(doorOf(t.cy), copy)).toEndWith(", working");
		expect(doorLabel(doorOf(t.gu), copy)).toEndWith(", answer ready");
		// The thread-status words ("needs attention", "your turn") are gone.
		for (const door of board.doors) {
			if (door.thread) {
				expect(doorLabel(door, copy)).not.toMatch(
					/needs attention|your turn|waiting on agent|not started/
				);
			}
		}
		const view = await mount(onFixture());
		const diDoor = view.container.querySelector<HTMLButtonElement>(
			`[data-door="${doorOf(t.di).number}"]`
		);
		expect(diDoor?.getAttribute("aria-label")).toEndWith(
			", stopped: Tests failed"
		);
		await click(diDoor);
		const card = view.container.querySelector("[data-seasonal-gift]");
		expect(card?.querySelector("[data-act-words]")?.textContent).toBe(
			"stopped: Tests failed"
		);
		expect(card?.textContent).not.toMatch(/Needs attention|Your turn/);
		// The text equivalent's rows say the same.
		const rows = [
			...view.container.querySelectorAll<HTMLButtonElement>(
				'section[aria-labelledby$="-list"] li > button[aria-label]'
			),
		].filter((row) => row.getAttribute("aria-label")?.includes("Tests failed"));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows[0]?.textContent).toContain("stopped: Tests failed");
		await view.dispose();
	});

	test("each villager stands at its focus thread's door, in every season", () => {
		for (const season of SEASON_LIST) {
			const { acts, board, stations, world } = stage(season);
			expect(stations).toHaveLength(10);
			for (const station of stations) {
				const focus = acts.get(station.agentId)?.threadId ?? undefined;
				expect(board.doors[station.number - 1]?.thread?.id).toBe(focus);
			}
			// Di stands at its focus run's door, not the first of its two.
			const di = stations.find((item) => item.agentId === FIXTURE_AGENT_IDS.di);
			expect(board.doors[(di?.number ?? 0) - 1]?.thread?.id).toBe(
				FIXTURE_THREAD_IDS.di
			);
			// Stations stand apart, and the you-spot is on the island.
			for (const [index, a] of stations.entries()) {
				for (const b of stations.slice(index + 1)) {
					expect(
						Math.hypot(a.at[0] - b.at[0], a.at[2] - b.at[2])
					).toBeGreaterThan(1);
				}
			}
			const shape = islandFor(
				world.bounds.maxX - world.bounds.minX,
				world.bounds.maxZ - world.bounds.minZ,
				2.4
			);
			const points = youPoints(season);
			for (const id of [
				"you",
				"you-1",
				"you-2",
				"you-3",
				"you-4",
				"you-tray",
			]) {
				const point = points[id];
				expect(point).toBeDefined();
				expect(onIsland(shape, point?.[0] ?? 99, point?.[2] ?? 99, 0.3)).toBe(
					true
				);
			}
			// Every station walks to the you-spot and its tray.
			const paths = seasonActPaths(season, stations);
			const reached = new Set(["you"]);
			for (let grown = true; grown; ) {
				grown = false;
				for (const [from, to] of paths.links) {
					if (reached.has(from) !== reached.has(to)) {
						reached.add(from).add(to);
						grown = true;
					}
				}
			}
			for (const id of [...stations.map((item) => item.id), "you-tray"]) {
				expect(reached.has(id)).toBe(true);
			}
		}
	});

	test("with acts the patch's busy pumpkins never stand side by side (S6)", () => {
		for (const today of [null, 16, 3]) {
			const world = layoutSeasonWorld("halloween", true, today);
			const plain = layoutSeasonWorld("halloween");
			// The same 24 places, numbered differently.
			const key = (door: (typeof world.doors)[number]) =>
				`${door.at[0].toFixed(2)},${door.at[2].toFixed(2)}`;
			expect(world.doors.map(key).sort()).toEqual(plain.doors.map(key).sort());
			expect(world.doors.map((door) => door.number)).toEqual(
				plain.doors.map((door) => door.number)
			);
			// Today's door and the lowest numbers fill first: none of the
			// twelve is a grid neighbour of another.
			const busy = new Set(doorOrder(today).slice(0, 12));
			const cells = world.doors
				.filter((door) => busy.has(door.number))
				.map((door) => [
					Math.round(door.at[0] / 2.2 + 2.5),
					Math.round(1.5 - door.at[2] / 2.2),
				]);
			for (const [index, [x, z]] of cells.entries()) {
				for (const [ox, oz] of cells.slice(index + 1)) {
					expect(
						Math.abs((x ?? 0) - (ox ?? 0)) + Math.abs((z ?? 0) - (oz ?? 0))
					).not.toBe(1);
				}
			}
		}
	});

	test("the you-slots run one way down the screen, well apart (s9)", () => {
		// The iso camera looks from +x, +z: screen right follows x - z and
		// screen down follows x + z. Each slot sits further right-or-level
		// and further down than the one before, so the queue reads in order
		// and its plates never stack; 3.5 units down a step keeps them more
		// than 8 px apart at a phone's zoom (the browser check measures it).
		for (const season of SEASON_LIST) {
			const points = youPoints(season);
			const slots = ["you-1", "you-2", "you-3", "you-4"].map(
				(id): [number, number, number] => points[id] ?? [0, 0, 0]
			);
			for (const [index, slot] of slots.entries()) {
				const before = slots[index - 1];
				if (!before) {
					continue;
				}
				const right = slot[0] - slot[2] - (before[0] - before[2]);
				const down = slot[0] + slot[2] - (before[0] + before[2]);
				expect(right).toBeGreaterThanOrEqual(0);
				expect(down).toBeGreaterThanOrEqual(3.5);
			}
		}
	});

	test("villager plates: Ada's answers her ask; Cy's keeps openFirst (15a)", () => {
		const snapshot = usefulStateFixture();
		const { acts, stations } = stage("halloween");
		const opened: string[] = [];
		const cast = actVillagers({
			acts,
			looks: new Map(
				Object.values(FIXTURE_AGENT_IDS).map((id) => [id, {} as never])
			),
			nowMs: FIXTURE_NOW,
			onAsk: (askId) => opened.push(askId),
			paths: seasonActPaths("halloween", stations),
			reduced: true,
			season: "halloween",
			shown: new Set(),
			slots: youSpotSlots(acts, unownedAsks(snapshot)).slots,
			stations,
		});
		const ada = cast.find((spec) => spec.actAgent === FIXTURE_AGENT_IDS.ada);
		expect(ada?.label).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run. Answer their ask."
		);
		ada?.activate?.();
		expect(opened).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
		expect(ada?.youSpot).toBe("slot");
		const cy = cast.find((spec) => spec.actAgent === FIXTURE_AGENT_IDS.cy);
		expect(cy?.activate).toBeUndefined();
		expect(cy?.label).toBe(
			`${acts.get(FIXTURE_AGENT_IDS.cy)?.ariaLabel} ${SEASON_ACT_WORDS.halloween.open}`
		);
		// The rendered plates and their clicks: seasonal-scene.test.tsx.
	});

	test("overlay budget: exempt targets stay focusable, icon-only when narrow (21)", () => {
		const snapshot = usefulStateFixture();
		const { acts, stations } = stage("halloween");
		const { offStage, onStage } = boardAgents(acts, stations);
		const slots = youSpotSlots(
			acts,
			unownedAsks(snapshot),
			onStage.map((item) => item.agentId)
		);
		// As the interface weighs them: the whole stage's width (no sheet
		// open), the first working villager featured.
		const items = actOverlays(
			onStage,
			slots,
			offStage,
			onStage.find((item) => item.act === "working")?.agentId ?? null
		);
		const wide = overlayBudget(1280, { domTargets: true });
		const narrow = overlayBudget(390, { domTargets: true });
		const wideShown = wide.fill(items);
		const shown = narrow.fill(items);
		const ids = FIXTURE_AGENT_IDS;
		expect(shown.has(`limit:${ids.fa}`)).toBe(true);
		expect(
			[`work:${ids.cy}`, `limit:${ids.fa}`, `progress:${ids.cy}`].filter(
				(id) => !wideShown.has(id)
			)
		).toEqual([]);
		expect(wideShown.size).toBeLessThanOrEqual(16);
		expect(shown.size).toBeLessThanOrEqual(8);
		expect([...shown].some((id) => id.startsWith("ask:"))).toBe(false);
		expect(wide.focusable && narrow.focusable).toBe(true);
		expect([wide.iconOnly, narrow.iconOnly]).toEqual([false, true]);
	});

	test("the limit reads in each season's words", () => {
		const fa = fixtureActs().get(FIXTURE_AGENT_IDS.fa);
		const words = (
			act: InterfaceAgentAct | undefined,
			season: (typeof SEASON_LIST)[number]
		) =>
			act &&
			limitWords(act, {
				clock: FIXTURE_CLOCK,
				limitText: seasonLimit(season),
				nowMs: FIXTURE_NOW,
			});
		expect(SEASON_LIST.map((season) => words(fa, season))).toEqual([
			"Snowed in, back 15:10",
			"Fogged in, back 15:10",
			"Stall shut, back 15:10",
		]);
		const guessed = fa && {
			...fa,
			blockers: [
				{
					kind: "rate-limited",
					source: "estimate",
				} as InterfaceAgentAct["blockers"][number],
			],
			timer: null,
		};
		expect(words(guessed, "advent")).toBe("Likely snowed in for now");
	});

	test("no last-activity ages with acts", async () => {
		const view = await mount(onFixture());
		await click(door(view.container, 1));
		const card = view.container.querySelector("[data-seasonal-gift]");
		expect(card?.textContent).not.toMatch(/\d+[mhd]\b/);
		await view.dispose();
	});
});

describe("Seasonal settings", () => {
	test("default to today's season with weather on; junk falls back", () => {
		expect(resolveInterfaceParams("seasonal", {})).toMatchObject({
			season: "auto",
			weather: true,
		});
		expect(
			resolveInterfaceParams("seasonal", { season: "summer", weather: 0 })
		).toMatchObject({ season: "auto", weather: true });
		expect(
			seasonalSettings({ season: "advent", weather: false })
		).toMatchObject({ season: "advent", weather: false });
	});

	test("the season menu saves its pick, and Settings changes it live", async () => {
		const saved: Record<string, unknown>[] = [];
		const port: InterfacePort = {
			...recordingPort().port,
			updateSettings: (patch) => saved.push(patch),
		};
		const view = await mount(seasonal({ port, season: "advent" }));
		const root = () =>
			view.container
				.querySelector('[data-testid="interface-seasonal"]')
				?.getAttribute("data-season");
		await click(button(view.container, "Halloween"));
		expect(saved).toEqual([{ season: "halloween" }]);
		expect(root()).toBe("halloween");
		// A new param from Settings replaces the pick.
		await view.rerender(seasonal({ port, season: "lunar-new-year" }));
		expect(root()).toBe("lunar-new-year");
		await view.dispose();
	});

	test("the season switcher can go back to the date", async () => {
		const saved: Record<string, unknown>[] = [];
		const port: InterfacePort = {
			...recordingPort().port,
			updateSettings: (patch) => saved.push(patch),
		};
		const view = await mount(seasonal({ port, season: "advent" }));
		const pressed = (name: string) =>
			button(view.container, name)?.getAttribute("aria-pressed");
		expect(pressed("Advent")).toBe("true");
		expect(pressed("From today's date")).toBe("false");
		await click(button(view.container, "Halloween"));
		await click(button(view.container, "From today's date"));
		expect(saved).toEqual([{ season: "halloween" }, { season: "auto" }]);
		// Following the date is shown as such, not as one fixed season.
		expect(pressed("From today's date")).toBe("true");
		expect(pressed("Halloween")).toBe("false");
		await view.dispose();
	});
});

describe("localDateChanged", () => {
	test("advances the board's clock only across a local date boundary", () => {
		const lateEvening = new Date(2026, 11, 3, 23, 59).getTime();
		expect(
			localDateChanged(lateEvening, new Date(2026, 11, 3, 23, 59, 50).getTime())
		).toBe(false);
		expect(
			localDateChanged(lateEvening, new Date(2026, 11, 4, 0, 1).getTime())
		).toBe(true);
	});
});
