import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NoticeboardInterface } from "./noticeboard-interface.tsx";
import {
	CELL_WIDTH,
	MAX_COORDINATE,
	MAX_TILT,
	moveNote,
	NOTE_SIZES,
	NOTICEBOARD_POSITIONS_KEY,
	noteAccessibleName,
	noteLook,
	noticeboardAreas,
	noticeboardColumns,
	noticeboardLayout,
	noticeboardSummary,
	nudgedPoint,
	parseNotePositions,
	prunePositions,
	readNotePositions,
	summaryText,
	writeNotePositions,
} from "./noticeboard-model.ts";

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
	],
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
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
			pinned: true,
			title: "Loose ends",
			updatedAt: ago(600),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-old",
			lastMessage: "Done.",
			title: "Old answer",
			updatedAt: ago(3000),
		}),
	],
	version: 1,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

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
beforeEach(() => {
	try {
		localStorage.removeItem(NOTICEBOARD_POSITIONS_KEY);
	} catch {
		// Storage-less runs still exercise the renderer.
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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function buttonByLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
}

function note(container: HTMLElement, threadId: string): HTMLElement {
	const element = container.querySelector<HTMLElement>(
		`[data-noticeboard-note="${threadId}"]`
	);
	if (!element) {
		throw new Error(`No note for ${threadId}`);
	}
	return element;
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

async function key(element: HTMLElement, name: string, shiftKey = false) {
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: name, shiftKey })
		);
	});
}

/**
 * Type into a controlled field the way React's onChange observes it. React
 * may have been evaluated before the DOM was registered, in which case it
 * watches the focused field's keyup instead of `input`, so send both.
 */
async function typeInto(field: HTMLTextAreaElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function board(
	overrides: Partial<Parameters<typeof NoticeboardInterface>[0]> = {}
) {
	const { calls, port } = recordingPort();
	const element = (
		<NoticeboardInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
	return { calls, element, port };
}

describe("noticeboard model", () => {
	test("each thread keeps one look, tilted within two degrees", () => {
		expect(noteLook("thread-notes")).toEqual(noteLook("thread-notes"));
		const kinds = new Set<string>();
		const fasteners = new Set<string>();
		for (let index = 0; index < 120; index += 1) {
			const look = noteLook(`t-${index}`);
			kinds.add(look.kind);
			fasteners.add(look.fastener);
			expect(Math.abs(look.rotation)).toBeLessThanOrEqual(MAX_TILT);
			expect(look.rotation).not.toBe(0);
			expect(look.fastener === "tape" ? look.kind : "card").toBe("card");
		}
		expect([...kinds].sort()).toEqual(["card", "memo", "note"]);
		expect([...fasteners].sort()).toEqual(["pin", "tape"]);
	});

	test("areas follow the status order and skip empty ones", () => {
		const areas = noticeboardAreas(SNAPSHOT);
		expect(areas.map((area) => area.status)).toEqual([
			"attention",
			"your-turn",
			"working",
			"waiting",
		]);
		expect(areas.map((area) => area.label)).toEqual([
			"Needs attention",
			"Your turn",
			"Working",
			"Waiting on agent",
		]);
		const yourTurn = areas[1]?.notes.map((item) => item.thread.id);
		expect(yourTurn).toEqual(["thread-notes", "thread-old"]);
		// Pinned threads lead their area.
		expect(areas[3]?.notes[0]?.thread.id).toBe("thread-loose");
	});

	test("the tidy layout keeps every note once, inside the board", () => {
		const areas = noticeboardAreas(SNAPSHOT);
		for (const width of [390, 900, 1440]) {
			const layout = noticeboardLayout(areas, {}, width);
			expect(layout.notes).toHaveLength(SNAPSHOT.threads.length);
			expect(
				new Set(layout.notes.map((item) => item.note.thread.id)).size
			).toBe(SNAPSHOT.threads.length);
			expect(layout.width).toBe(width);
			for (const item of layout.notes) {
				expect(item.x).toBeGreaterThanOrEqual(0);
				expect(item.x + item.note.size.width).toBeLessThanOrEqual(width);
				expect(item.y + item.note.size.height).toBeLessThanOrEqual(
					layout.height
				);
			}
		}
	});

	test("tidy notes never overlap one another", () => {
		const layout = noticeboardLayout(noticeboardAreas(SNAPSHOT), {}, 1200);
		const boxes = layout.notes.map((item) => ({
			bottom: item.y + item.note.size.height,
			left: item.x,
			right: item.x + item.note.size.width,
			top: item.y,
		}));
		for (const [index, box] of boxes.entries()) {
			for (const other of boxes.slice(index + 1)) {
				const overlaps =
					box.left < other.right &&
					other.left < box.right &&
					box.top < other.bottom &&
					other.top < box.bottom;
				expect(overlaps).toBe(false);
			}
		}
	});

	test("wider boards use more columns and get shorter", () => {
		expect(noticeboardColumns(CELL_WIDTH)).toBe(1);
		expect(noticeboardColumns(0)).toBe(1);
		expect(noticeboardColumns(1392)).toBe(5);
		const areas = noticeboardAreas(SNAPSHOT);
		const narrow = noticeboardLayout(areas, {}, 390);
		const wide = noticeboardLayout(areas, {}, 1440);
		expect(wide.height).toBeLessThan(narrow.height);
		// One column: the paper centers in the full width.
		const first = narrow.notes[0];
		expect(first).toBeDefined();
		if (first) {
			const center = first.x + first.note.size.width / 2;
			expect(Math.abs(center - 195)).toBeLessThanOrEqual(8);
		}
	});

	test("moved notes stay where the viewer left them", () => {
		const areas = noticeboardAreas(SNAPSHOT);
		const positions = moveNote({}, "thread-flaky", { x: 900.4, y: 1300 });
		const layout = noticeboardLayout(areas, positions, 800);
		const moved = layout.notes.find(
			(item) => item.note.thread.id === "thread-flaky"
		);
		expect(moved).toMatchObject({ placed: true, x: 900, y: 1300 });
		// The board grows to hold it, and nothing else moves.
		expect(layout.width).toBeGreaterThanOrEqual(
			900 + NOTE_SIZES[moved?.note.look.kind ?? "note"].width
		);
		expect(layout.height).toBeGreaterThan(1300);
		const tidy = noticeboardLayout(areas, {}, 800);
		const others = (items: typeof layout.notes) =>
			items
				.filter((item) => item.note.thread.id !== "thread-flaky")
				.map((item) => [item.note.thread.id, item.x, item.y]);
		expect(others(layout.notes)).toEqual(others(tidy.notes));
		expect(layout.areas).toEqual(tidy.areas);
	});

	test("stored positions are validated, clamped, and pruned", () => {
		expect(parseNotePositions(null)).toEqual({});
		expect(parseNotePositions([1, 2])).toEqual({});
		expect(
			parseNotePositions({
				a: { x: 10.6, y: -4 },
				b: { x: "1", y: 2 },
				c: { x: Number.NaN, y: 1 },
				d: { x: 1e9, y: 5 },
				e: "nope",
			})
		).toEqual({ a: { x: 11, y: 0 }, d: { x: MAX_COORDINATE, y: 5 } });
		const positions = { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } };
		expect(prunePositions(positions, new Set(["a", "b"]))).toBe(positions);
		expect(prunePositions(positions, new Set(["a"]))).toEqual({
			a: { x: 1, y: 1 },
		});
	});

	test("positions round-trip through storage and survive bad data", () => {
		writeNotePositions({ "thread-notes": { x: 40, y: 80 } });
		expect(readNotePositions()).toEqual({ "thread-notes": { x: 40, y: 80 } });
		localStorage.setItem(NOTICEBOARD_POSITIONS_KEY, "{not json");
		expect(readNotePositions()).toEqual({});
		writeNotePositions({});
		expect(localStorage.getItem(NOTICEBOARD_POSITIONS_KEY)).toBeNull();
	});

	test("arrow keys nudge by a small or large step", () => {
		expect(nudgedPoint({ x: 40, y: 40 }, "ArrowRight", false)).toEqual({
			x: 48,
			y: 40,
		});
		expect(nudgedPoint({ x: 40, y: 40 }, "ArrowUp", true)).toEqual({
			x: 40,
			y: 0,
		});
		expect(nudgedPoint({ x: 40, y: 40 }, "Enter", false)).toBeNull();
	});

	test("names and summaries read in the user's terms", () => {
		const areas = noticeboardAreas(SNAPSHOT);
		const loose = areas[3]?.notes[0];
		expect(loose).toBeDefined();
		if (loose) {
			expect(noteAccessibleName(loose, "10h")).toBe(
				"Loose ends. Waiting on agent. No agent. updated 10h ago. pinned"
			);
			expect(noteAccessibleName(loose, "now")).toContain("updated just now");
		}
		expect(summaryText(noticeboardSummary(SNAPSHOT))).toBe(
			"6 notes · 1 need attention · 2 your turn · 1 working"
		);
		expect(summaryText(noticeboardSummary(EMPTY))).toBe("0 notes");
	});
});

describe("noticeboard renderer", () => {
	test("pins every thread as a named note under its area", () => {
		const html = renderToStaticMarkup(board().element);
		expect(html).toContain('data-testid="interface-noticeboard"');
		for (const label of [
			"Needs attention",
			"Your turn",
			"Working",
			"Waiting on agent",
		]) {
			expect(html).toContain(label);
		}
		for (const item of SNAPSHOT.threads) {
			expect(html).toContain(`data-noticeboard-note="${item.id}"`);
		}
		expect(html).toContain('aria-label="Flaky test. Needs attention. Grace.');
		expect(html).toContain("Run failed");
		expect(html).not.toContain("Not started");
	});

	test("shows a skeleton while loading and a pinned card when empty", () => {
		const loading = renderToStaticMarkup(
			board({ loading: true, snapshot: EMPTY }).element
		);
		expect(loading).toContain('data-testid="noticeboard-skeleton"');
		expect(loading).not.toContain("Nothing pinned yet");

		const empty = renderToStaticMarkup(board({ snapshot: EMPTY }).element);
		expect(empty).toContain("Nothing pinned yet");
		expect(empty).toContain("Add an agent");
		const emptyWithAgents = renderToStaticMarkup(
			board({ snapshot: { ...SNAPSHOT, threads: [] } }).element
		);
		expect(emptyWithAgents).toContain("Pin one to ask an agent");
	});

	test("clicking a note opens its thread; the panel shows the host view", async () => {
		const { calls, element } = board();
		const view = await mount(element);
		await click(note(view.container, "thread-triage"));
		expect(calls).toEqual(["open:thread-triage"]);
		await view.dispose();

		const open = board({
			activeThreadId: "thread-triage",
			threadView: <p data-testid="host-view">Host chat</p>,
		});
		const opened = await mount(open.element);
		const panel = opened.container.querySelector(
			"[data-testid='noticeboard-panel']"
		);
		expect(panel?.querySelector("[data-testid='host-view']")).not.toBeNull();
		expect(panel?.textContent).toContain("Crash triage");
		expect(panel?.textContent).toContain("Working");
		expect(
			note(opened.container, "thread-triage").getAttribute("aria-current")
		).toBe("true");
		await click(buttonByLabel(opened.container, "Close conversation"));
		expect(open.calls).toEqual(["close"]);
		await opened.dispose();
	});

	test("Escape closes the open thread unless the chat owns the key", async () => {
		const { calls, element } = board({
			activeThreadId: "thread-notes",
			threadView: <textarea aria-label="Reply" />,
		});
		const view = await mount(element);
		const reply = view.container.querySelector("textarea");
		if (!reply) {
			throw new Error("Expected the host view");
		}
		await act(async () => reply.focus());
		await key(reply, "Escape");
		expect(calls).toEqual([]);
		await key(document.body, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("pinning a note starts a thread only with what the user wrote", async () => {
		const { calls, element } = board();
		const view = await mount(element);
		await click(buttonByLabel(view.container, "Pin a note"));
		const composer = view.container.querySelector(
			"[data-testid='noticeboard-composer']"
		);
		expect(composer).not.toBeNull();
		const submit = buttonByLabel(view.container, "Pin note");
		expect(submit?.hasAttribute("disabled")).toBe(true);
		await click(buttonByLabel(view.container, "Grace"));
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("Expected the note field");
		}
		await typeInto(field, "  Check the flaky test  ");
		expect(calls).toEqual([]);
		await key(field, "Enter");
		expect(calls).toEqual([
			'start:{"agentId":"agent-grace","prompt":"Check the flaky test"}',
		]);
		expect(
			view.container.querySelector("[data-testid='noticeboard-composer']")
		).toBeNull();
		await view.dispose();
	});

	test("Escape puts the blank note away and returns focus", async () => {
		const { calls, element } = board();
		const view = await mount(element);
		const trigger = buttonByLabel(view.container, "Pin a note");
		await click(trigger);
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("Expected the note field");
		}
		await key(field, "Escape");
		expect(
			view.container.querySelector("[data-testid='noticeboard-composer']")
		).toBeNull();
		expect(document.activeElement).toBe(trigger ?? null);
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("arrow keys move a note, remember it, and Tidy up resets", async () => {
		const { calls, element } = board();
		const view = await mount(element);
		const paper = note(view.container, "thread-notes");
		const startLeft = Number.parseFloat(paper.style.left);
		expect(buttonByLabel(view.container, "Tidy up")).toBeUndefined();
		await key(paper, "ArrowRight", true);
		const moved = note(view.container, "thread-notes");
		expect(Number.parseFloat(moved.style.left)).toBe(startLeft + 48);
		expect(readNotePositions()["thread-notes"]?.x).toBe(startLeft + 48);
		expect(calls).toEqual([]);

		await click(buttonByLabel(view.container, "Tidy up"));
		expect(readNotePositions()).toEqual({});
		expect(
			Number.parseFloat(note(view.container, "thread-notes").style.left)
		).toBe(startLeft);
		await view.dispose();
	});

	test("a saved arrangement is restored on the next visit", async () => {
		writeNotePositions({ "thread-loose": { x: 640, y: 720 } });
		const view = await mount(board().element);
		const paper = note(view.container, "thread-loose");
		expect(paper.style.left).toBe("640px");
		expect(paper.style.top).toBe("720px");
		await view.dispose();
	});

	test("no hard-coded colors leak into the markup", () => {
		const html = renderToStaticMarkup(
			board({
				activeThreadId: "thread-notes",
				threadView: <p>Host chat</p>,
			}).element
		);
		expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(/);
	});
});
