import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { MotionGlobalConfig } from "motion/react";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberLooks } from "./game3d-villager.tsx";
import { QuizInterface } from "./quiz-interface.tsx";
import {
	buildContestants,
	buildQuizBoard,
	CLUE_LIMIT,
	clueText,
	isRevealed,
	moveOnBoard,
	parseRevealed,
	pruneRevealed,
	QUIZ_COLUMNS,
	QUIZ_PODIUMS,
	QUIZ_ROWS,
	REVEALED_STORAGE_KEY,
	rowValue,
} from "./quiz-model.ts";
import { AUDIENCE_IDS, HOST_ID, studioExtras } from "./quiz-studio.tsx";
import {
	categoryCentre,
	cellCentre,
	podiumSpots,
	STUDIO_BOUNDS,
	TOWARD,
	WALL,
} from "./quiz-world.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-12T12:00:00Z");
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

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
		updatedAt: ago(60),
		...input,
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
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Never messaged",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada"],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			messageCount: 6,
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			projectId: "project-site",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			messageCount: 9,
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			id: "thread-loose",
			lastMessage: "Who owns this?",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: ago(600),
		}),
	],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Overlays animate in and out; tests assert the settled state. The shared
// tile-to-clue layout animation cannot measure in happy-dom, so the tests run
// as a viewer who asked for reduced motion (the plain fade path).
MotionGlobalConfig.skipAnimations = true;
const prefersReducedMotion = (query: string) => ({
	addEventListener: () => undefined,
	addListener: () => undefined,
	dispatchEvent: () => false,
	matches: query.includes("prefers-reduced-motion"),
	media: query,
	onchange: null,
	removeEventListener: () => undefined,
	removeListener: () => undefined,
});
Reflect.set(globalThis, "matchMedia", prefersReducedMotion);
Reflect.set(window, "matchMedia", prefersReducedMotion);
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

async function press(target: Element | null | undefined, key: string) {
	if (!(target instanceof HTMLElement)) {
		throw new Error("Expected a key target");
	}
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

/** Let exit animations (instant under skipAnimations) finish their frame. */
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 40));
	});
}

function hasDialog(container: HTMLElement): boolean {
	return container.querySelector('[role="dialog"]') !== null;
}

function byLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find((candidate) =>
		candidate.getAttribute("aria-label")?.startsWith(label)
	);
}

function byText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim().startsWith(text) ?? false
	);
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function quiz(
	overrides: Partial<Parameters<typeof QuizInterface>[0]> = {}
): ReactElement {
	return (
		<QuizInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={recordingPort().port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

describe("quiz model", () => {
	test("files threads under project, then agent, then unassigned", () => {
		const board = buildQuizBoard(SNAPSHOT);
		const names = board.columns.map((column) => column?.name ?? null);
		expect(names).toEqual([
			"Website",
			"Grace",
			"Ada",
			"Unassigned",
			null,
			null,
		]);
		expect(board.columns[0]?.kind).toBe("project");
		expect(board.columns[3]?.kind).toBe("unassigned");
		expect(board.round).toBe("Round 1");
		expect(board.rows).toBe(5);
		expect(board.offBoard).toBe(0);
	});

	test("values follow the row and columns fill from the bottom", () => {
		expect(rowValue(0, false)).toBe(100);
		expect(rowValue(4, false)).toBe(500);
		expect(rowValue(4, true)).toBe(1000);
		const board = buildQuizBoard(SNAPSHOT);
		const grace = board.columns[1];
		// Working crash triage above the failed (attention) run, worth less.
		expect(grace?.tiles.map((tile) => tile.value)).toEqual([400, 500]);
		expect(grace?.tiles.map((tile) => tile.needsYou)).toEqual([false, true]);
		for (const column of board.columns) {
			const tiles = column?.tiles ?? [];
			// The most pressing conversation always lands on the bottom row.
			expect(tiles.map((tile) => tile.row)).toEqual(
				tiles.map((_, index) => board.rows - tiles.length + index)
			);
			for (const tile of tiles) {
				expect(tile.value).toBe(rowValue(tile.row, board.double));
			}
		}
		// A one-clue column sits on the bottom row; the slots above read as played.
		expect(board.columns[0]?.tiles.map((tile) => tile.row)).toEqual([4]);
	});

	test("caps the board at six columns of five and doubles a big round", () => {
		const threads = Array.from({ length: 24 }, (_, index) =>
			thread({
				agentIds: [`agent-${index % 8}`],
				id: `t-${index}`,
				updatedAt: ago(index),
			})
		);
		const agents = Array.from({ length: 8 }, (_, index) => ({
			avatarUrl: null,
			description: "",
			id: `agent-${index}`,
			name: `Agent ${index}`,
			status: "idle" as const,
		}));
		const board = buildQuizBoard({ ...SNAPSHOT, agents, groups: [], threads });
		expect(board.columns.every((column) => column !== null)).toBe(true);
		expect(board.double).toBe(true);
		expect(board.round).toBe("Double Round");
		expect(board.rows).toBe(5);
		const first = board.columns[0]?.tiles[0];
		expect(first?.row).toBe(2);
		expect(first?.value).toBe(600);
		expect(board.offBoard).toBe(24 - 6 * 3);
	});

	test("arrow keys walk filled columns and clamp to the rows they have", () => {
		const board = buildQuizBoard(SNAPSHOT);
		const at = (column: number, row: number) => ({ column, row });
		expect(moveOnBoard(board, at(1, 4), "ArrowRight")).toEqual(at(2, 4));
		expect(moveOnBoard(board, at(3, 4), "ArrowRight")).toEqual(at(3, 4));
		expect(moveOnBoard(board, at(1, 3), "ArrowDown")).toEqual(at(1, 4));
		expect(moveOnBoard(board, at(1, 4), "ArrowDown")).toEqual(at(1, 4));
		expect(moveOnBoard(board, at(1, 4), "ArrowUp")).toEqual(at(1, 3));
		expect(moveOnBoard(board, at(1, 3), "ArrowUp")).toEqual(at(1, 3));
		expect(moveOnBoard(board, at(2, 4), "End")).toEqual(at(3, 4));
		expect(moveOnBoard(board, at(2, 4), "Home")).toEqual(at(0, 4));
		// Home/End stay in the row: on row 3 only column 1 has a tile, so
		// neither key moves; Ctrl jumps to the board's corners.
		expect(moveOnBoard(board, at(1, 3), "Home")).toEqual(at(1, 3));
		expect(moveOnBoard(board, at(1, 3), "End")).toEqual(at(1, 3));
		expect(moveOnBoard(board, at(1, 3), "Home", true)).toEqual(at(0, 4));
		expect(moveOnBoard(board, at(0, 4), "End", true)).toEqual(at(3, 4));
		expect(moveOnBoard(board, at(1, 4), "PageUp")).toEqual(at(1, 3));
		expect(moveOnBoard(board, at(1, 3), "PageDown")).toEqual(at(1, 4));
	});

	test("clue text falls back to the title and cuts long messages", () => {
		expect(clueText(thread({ id: "a", title: "Plan" }))).toBe("Plan");
		const long = clueText(
			thread({ id: "b", lastMessage: "word ".repeat(100) })
		);
		expect(long.length).toBeLessThanOrEqual(CLUE_LIMIT + 1);
		expect(long.endsWith("…")).toBe(true);
	});

	test("contestants are ranked by messages, up to four", () => {
		const contestants = buildContestants(SNAPSHOT);
		expect(contestants.map((entry) => entry.agent.name)).toEqual([
			"Grace",
			"Ada",
			"Linus",
		]);
		expect(contestants[0]?.score).toBe(11);
		expect(contestants[0]?.working).toBe(true);
	});

	test("reveals parse defensively and expire when a thread moves on", () => {
		expect(parseRevealed(null)).toEqual({});
		expect(parseRevealed("not json")).toEqual({});
		expect(parseRevealed("[1,2]")).toEqual({});
		expect(parseRevealed('{"a":"t","b":4}')).toEqual({ a: "t" });
		const seen = thread({ id: "a", updatedAt: ago(5) });
		expect(isRevealed({ a: ago(5) }, seen)).toBe(true);
		expect(isRevealed({ a: ago(9) }, seen)).toBe(false);
		expect(pruneRevealed({ a: "x", gone: "y" }, [seen])).toEqual({ a: "x" });
	});
});

describe("quiz interface", () => {
	beforeEach(() => {
		globalThis.localStorage?.clear();
	});

	test("renders the board, podiums and HUD statically", () => {
		const html = renderToStaticMarkup(quiz());
		expect(html).toContain('data-testid="interface-quiz"');
		expect(html).toContain("Website");
		expect(html).toContain("Round 1");
		expect(html).toContain('aria-label="Contestants"');
		expect(html).toContain("Final question");
		expect(html).not.toContain("quiz-answer-booth");
	});

	test("shows a skeleton while loading and a start action when empty", async () => {
		const loading = renderToStaticMarkup(
			quiz({ loading: true, snapshot: { ...SNAPSHOT, threads: [] } })
		);
		expect(loading).toContain('aria-busy="true"');
		const { calls, port } = recordingPort();
		const view = await mount(
			quiz({ port, snapshot: { ...SNAPSHOT, agents: [], threads: [] } })
		);
		expect(view.container.textContent).toContain(
			"No contestants and no conversations yet"
		);
		await click(byText(view.container, "Start a conversation"));
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("picking a tile reveals the clue, Answer opens the thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(quiz({ port }));
		await click(byLabel(view.container, "Grace for 500"));
		const dialog = view.container.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("The run stopped.");
		expect(dialog?.textContent).toContain("Needs attention");
		expect(document.activeElement?.textContent).toContain("Answer");
		expect(
			parseRevealed(localStorage.getItem(REVEALED_STORAGE_KEY))
		).toHaveProperty("thread-flaky");
		await click(byText(view.container, "Answer"));
		await settle();
		expect(calls).toEqual(["open:thread-flaky"]);
		expect(hasDialog(view.container)).toBe(false);
		// The revealed tile is blank now and says so.
		expect(byLabel(view.container, "Grace, revealed")).toBeDefined();
		await view.dispose();
	});

	test("Back to board and Escape return focus to the tile", async () => {
		const view = await mount(quiz());
		await click(byLabel(view.container, "Ada for 500"));
		await press(document.activeElement, "Escape");
		await settle();
		expect(hasDialog(view.container)).toBe(false);
		expect(document.activeElement?.getAttribute("aria-label")).toStartWith(
			"Ada, revealed"
		);
		await view.dispose();
	});

	test("arrow keys move between tiles with one tab stop", async () => {
		const view = await mount(quiz());
		const tiles = [...view.container.querySelectorAll("[data-quiz-tile]")];
		expect(
			tiles.filter((tile) => tile.getAttribute("tabindex") === "0")
		).toHaveLength(1);
		const first = byLabel(view.container, "Website for 500");
		await act(async () => first?.focus());
		await press(first, "ArrowRight");
		expect(document.activeElement?.getAttribute("aria-label")).toStartWith(
			"Grace for 500"
		);
		await press(document.activeElement, "ArrowUp");
		expect(document.activeElement?.getAttribute("aria-label")).toStartWith(
			"Grace for 400"
		);
		await view.dispose();
	});

	test("New game clears every reveal", async () => {
		localStorage.setItem(
			REVEALED_STORAGE_KEY,
			JSON.stringify({ "thread-notes": ago(30) })
		);
		const view = await mount(quiz());
		expect(byLabel(view.container, "Ada, revealed")).toBeDefined();
		await click(byLabel(view.container, "New game"));
		expect(byLabel(view.container, "Ada for 500")).toBeDefined();
		expect(localStorage.getItem(REVEALED_STORAGE_KEY)).toBeNull();
		await view.dispose();
	});

	test("the final question sends only what the user typed", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(quiz({ port }));
		await click(byLabel(view.container, "Ask Ada the final question"));
		const field = view.container.querySelector("textarea");
		expect(document.activeElement).toBe(field);
		const submit = byText(view.container, "Send to Ada");
		expect(submit?.disabled).toBe(true);
		await act(async () => {
			if (!field) {
				return;
			}
			// React may watch keyup instead of input when it loaded before the DOM.
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			)?.set;
			setter?.call(field, "  Summarize the launch  ");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		await click(byText(view.container, "Send to Ada"));
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Summarize the launch" })}`,
		]);
		await view.dispose();
	});

	test("an open thread shows the host view in the answer booth", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			quiz({
				activeThreadId: "thread-triage",
				port,
				threadView: <div data-testid="host-view">host</div>,
			})
		);
		const booth = view.container.querySelector(
			'[data-testid="quiz-answer-booth"]'
		);
		expect(booth?.querySelector('[data-testid="host-view"]')).not.toBeNull();
		expect(booth?.textContent).toContain("Crash triage");
		expect(booth?.textContent).toContain("400");
		// The clue being answered is off the board: blank, with the in-play ring.
		expect(
			byLabel(view.container, "Grace, answering")?.getAttribute("aria-current")
		).toBe("true");
		await click(byLabel(view.container, "Close answer booth"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});
});

describe("quiz studio", () => {
	test("every board cell has its own place on the wall", () => {
		const seen = new Set<string>();
		for (let column = 0; column < QUIZ_COLUMNS; column++) {
			for (let row = 0; row < QUIZ_ROWS; row++) {
				const [x, y, z] = cellCentre(column, row);
				seen.add(`${x.toFixed(2)}:${y.toFixed(2)}:${z.toFixed(2)}`);
				// Row 0 (the 100s) is the top row.
				if (row > 0) {
					expect(y).toBeLessThan(cellCentre(column, row - 1)[1]);
				}
			}
			expect(categoryCentre(column)[1]).toBeGreaterThan(
				cellCentre(column, 0)[1]
			);
		}
		expect(seen.size).toBe(QUIZ_COLUMNS * QUIZ_ROWS);
	});

	test("the podiums stand apart on the floor, in front of the wall", () => {
		const spots = podiumSpots();
		expect(spots).toHaveLength(QUIZ_PODIUMS);
		for (const [index, [x, z]] of spots.entries()) {
			expect(x).toBeGreaterThan(STUDIO_BOUNDS.minX);
			expect(x).toBeLessThan(STUDIO_BOUNDS.maxX);
			// Out in front of the wall, toward the camera.
			const out =
				(x - WALL.centre[0]) * TOWARD[0] + (z - WALL.centre[1]) * TOWARD[1];
			expect(out).toBeGreaterThan(2);
			const next = spots[index + 1];
			if (next) {
				expect(Math.hypot(next[0] - x, next[1] - z)).toBeGreaterThan(2);
			}
		}
	});
});

describe("quiz settings", () => {
	test("the round doubles on a busy board by default, or is set", () => {
		expect(buildQuizBoard(SNAPSHOT).round).toBe("Round 1");
		expect(buildQuizBoard(SNAPSHOT, "double").round).toBe("Double Round");
		expect(buildQuizBoard(SNAPSHOT, "double").double).toBe(true);
		expect(buildQuizBoard(SNAPSHOT, "single").double).toBe(false);
	});

	test("the board follows the round setting live", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const label = () =>
			container
				.querySelector("[aria-label^='Game board']")
				?.getAttribute("aria-label") ?? container.textContent;
		await act(async () => root.render(quiz()));
		expect(label()).toContain("Round 1");
		await act(async () => root.render(quiz({ params: { round: "double" } })));
		expect(label()).toContain("Double Round");
		await act(async () => root.render(quiz({ params: { round: "single" } })));
		expect(label()).toContain("Round 1");
		await act(async () => root.unmount());
		container.remove();
	});

	test("the audience sits in the studio unless turned off; the host always stands", () => {
		const look = {} as MemberLooks;
		const looks = new Map<string, MemberLooks>([
			[HOST_ID, look],
			...AUDIENCE_IDS.map((id) => [id, look] as [string, MemberLooks]),
		]);
		const withAudience = studioExtras(looks, [0, 0]);
		expect(withAudience.some((extra) => extra.label === "Audience")).toBe(true);
		const without = studioExtras(looks, [0, 0], false);
		expect(without.map((extra) => extra.id)).toEqual([HOST_ID]);
	});
});
