// Board renderer tests. Static markup (react-dom/server) covers what the board
// prints; happy-dom with createRoot covers interactions, so clicks and keys
// run real React state and real handlers. The DOM is registered before React
// loads (board-test-dom.ts). Portalled popups only mount when this file runs
// first, so no test here depends on them: popup bodies are rendered directly.

import "./board-test-dom.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type BoardParams,
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardDisplayOptions } from "./board-display.tsx";
import { BoardEmptyState } from "./board-empty.tsx";
import { BoardInterface } from "./board-interface.tsx";
import { boardBodyState } from "./board-model.ts";
import { BOARD_STATUS_EMPTY } from "./board-status.tsx";
import { registeredBoardDom } from "./board-test-dom.ts";

const MINUTE = 60_000;
const noop = () => undefined;
const BASE = Date.now();
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id" | "title">
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
			id: "project-docs",
			kind: "project",
			memberAgentIds: ["agent-ada"],
			name: "Docs Site",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-audit",
			lastMessage: "Two advisories need a patch release.",
			runState: "failed",
			title: "Audit dependencies",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			pinned: true,
			projectId: "project-docs",
			title: "Release notes",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(200),
		}),
		thread({
			id: "thread-office",
			lastMessageRole: null,
			messageCount: 0,
			title: "Office closed Friday",
			updatedAt: ago(4000),
		}),
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: INTERFACE_PROTOCOL_VERSION,
};

const TITLES = SNAPSHOT.threads.map((item) => item.title);

const HOST_VIEW: ReactNode = (
	<div data-testid="host-thread-view">Host chat surface</div>
);

const BOARD: BoardParams = { groupBy: "status", view: "board" };
const LIST: BoardParams = { groupBy: "status", view: "list" };

afterAll(async () => {
	if (registeredBoardDom) {
		await GlobalRegistrator.unregister();
	}
});

/** A port that records every call as `open:<id>`, `start:<json>`, `close`. */
function recordingPort(): { calls: string[]; port: InterfacePort } {
	const calls: string[] = [];
	return {
		calls,
		port: {
			closeThread: () => calls.push("close"),
			openThread: (id) => calls.push(`open:${id}`),
			startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
		},
	};
}

function board(
	overrides: Partial<{
		activeThreadId: string | null;
		loading: boolean;
		params: BoardParams;
		port: InterfacePort;
		snapshot: InterfaceSnapshot;
		threadView: ReactNode | null;
	}> = {}
): ReactElement {
	return (
		<BoardInterface
			activeThreadId={overrides.activeThreadId ?? null}
			loading={overrides.loading ?? false}
			params={overrides.params ?? BOARD}
			port={overrides.port ?? recordingPort().port}
			snapshot={overrides.snapshot ?? SNAPSHOT}
			threadView={overrides.threadView ?? null}
		/>
	);
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

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

async function press(
	element: Element | null | undefined,
	key: string,
	init: KeyboardEventInit = {}
) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to send keys to");
	}
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				key,
				...init,
			})
		);
	});
}

/** The first button whose accessible name or text matches `name`. */
function button(
	scope: ParentNode | null | undefined,
	name: string | RegExp
): HTMLButtonElement | undefined {
	const matches = (value: string | null | undefined) =>
		typeof name === "string" ? value?.trim() === name : name.test(value ?? "");
	return [...(scope?.querySelectorAll("button") ?? [])].find(
		(candidate) =>
			matches(candidate.getAttribute("aria-label")) ||
			matches(candidate.textContent)
	);
}

function laneNames(container: ParentNode): string[] {
	return [...container.querySelectorAll("[data-board-lane] h2")].map(
		(heading) => heading.textContent?.replace(/,.*$/, "").trim() ?? ""
	);
}

describe("Board lanes", () => {
	test("one lane per status, most urgent first, with every card", () => {
		const html = renderToStaticMarkup(board());
		expect(html).toContain('data-testid="interface-board"');
		expect(html).toContain('aria-label="Threads by status"');
		for (const title of TITLES) {
			expect(html).toContain(title);
		}
		expect(html).toContain("5 threads · 1 working");
		expect(html).toContain("Last run failed");
	});

	test("lane order follows the status order and empty lanes say so plainly", async () => {
		const view = await mount(
			board({
				snapshot: {
					...SNAPSHOT,
					threads: SNAPSHOT.threads.filter(
						(item) => threadStatus(item) !== "waiting"
					),
				},
			})
		);
		expect(laneNames(view.container)).toEqual(
			THREAD_STATUS_ORDER.map((status) => THREAD_STATUS_LABELS[status])
		);
		expect(view.container.textContent).toContain(BOARD_STATUS_EMPTY.waiting);
		await view.dispose();
	});

	test("a card click opens its thread through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(board({ port }));
		await click(button(view.container, "Crash triage"));
		expect(calls).toEqual(["open:thread-triage"]);
		await view.dispose();
	});

	test("New thread and C start a thread with no prompt", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(board({ port }));
		await click(button(view.container, "New thread"));
		await press(view.container.querySelector("[data-board-card]"), "c");
		expect(calls).toEqual(["start:{}", "start:{}"]);
		await view.dispose();
	});

	test("agent lanes start a thread with that agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			board({ params: { groupBy: "agent", view: "board" }, port })
		);
		expect(laneNames(view.container)).toEqual([
			"Ada",
			"Grace",
			"Linus",
			"Unassigned",
		]);
		await click(button(view.container, "New thread with Linus"));
		expect(calls).toEqual(['start:{"agentId":"agent-linus"}']);
		await view.dispose();
	});

	test("arrow keys move between cards across lanes", async () => {
		const view = await mount(board());
		const cards = () => [
			...view.container.querySelectorAll<HTMLElement>("[data-board-card]"),
		];
		const first = cards()[0];
		expect(first?.tabIndex).toBe(0);
		expect(cards().filter((card) => card.tabIndex === 0)).toHaveLength(1);
		await act(async () => first?.focus());
		await press(first, "ArrowRight");
		expect(document.activeElement?.textContent).toBe("Release notes");
		await press(document.activeElement, "ArrowLeft");
		expect(document.activeElement).toBe(first ?? null);
		await view.dispose();
	});
});

describe("Board states", () => {
	test("loading shows a busy skeleton, not the empty state", () => {
		const html = renderToStaticMarkup(
			board({ loading: true, snapshot: EMPTY })
		);
		expect(html).toContain('aria-busy="true"');
		expect(html).not.toContain("No threads yet");
	});

	test("no threads shows the empty state with one way forward", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(board({ port, snapshot: EMPTY }));
		expect(view.container.textContent).toContain("No threads yet");
		const buttons = [...view.container.querySelectorAll("button")].filter(
			(item) => item.textContent?.trim() === "New thread"
		);
		await click(buttons.at(-1));
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("the body state picks loading, empty, no matches, or the board", () => {
		const base = {
			agentCount: 3,
			filtered: false,
			groupBy: "status" as const,
			loading: false,
			shownCount: 5,
			threadCount: 5,
		};
		expect(boardBodyState({ ...base, loading: true })).toBe("loading");
		expect(boardBodyState({ ...base, shownCount: 0, threadCount: 0 })).toBe(
			"empty"
		);
		// Agent lanes still show (and can start threads) with no threads yet.
		expect(
			boardBodyState({
				...base,
				groupBy: "agent",
				shownCount: 0,
				threadCount: 0,
			})
		).toBe("board");
		expect(boardBodyState({ ...base, filtered: true, shownCount: 0 })).toBe(
			"no-matches"
		);
		expect(boardBodyState({ ...base, filtered: true, shownCount: 2 })).toBe(
			"board"
		);
	});

	test("a filter that matches nothing says so and offers to clear", async () => {
		const actions: string[] = [];
		const view = await mount(
			<BoardEmptyState
				kind="no-matches"
				onClearFilters={() => actions.push("clear")}
				onStart={() => actions.push("start")}
			/>
		);
		expect(view.container.textContent).toContain("No threads match");
		expect(button(view.container, "New thread")).toBeUndefined();
		await click(button(view.container, "Clear filters"));
		expect(actions).toEqual(["clear"]);
		await view.dispose();
	});

	test("the empty state is a titled region with one action and no artwork", () => {
		const html = renderToStaticMarkup(
			<BoardEmptyState kind="empty" onClearFilters={noop} onStart={noop} />
		);
		expect(html).toContain('aria-labelledby="board-empty-title"');
		expect(html).toContain('id="board-empty-title"');
		expect(html.match(/<button/g)?.length).toBe(1);
		// Only the button's own plus icon; no illustration tile.
		expect(html.match(/<svg/g)?.length).toBe(1);
	});
});

describe("Board list and display", () => {
	test("the list view shows rows in sections and no lanes", () => {
		const html = renderToStaticMarkup(board({ params: LIST }));
		for (const title of TITLES) {
			expect(html).toContain(title);
		}
		expect(html).toContain('data-board-row=""');
		expect(html).not.toContain('data-board-lane=""');
	});

	test("layout and grouping sit behind one Display menu", () => {
		const html = renderToStaticMarkup(board());
		expect(html).toContain('aria-label="Display"');
		expect(html).toContain('aria-haspopup="dialog"');
		expect(html).not.toContain('aria-label="Group board by"');
	});

	test("the Display options report each choice", async () => {
		const picks: string[] = [];
		const view = await mount(
			<BoardDisplayOptions
				groupBy="status"
				onGroupByChange={(value) => picks.push(`group:${value}`)}
				onViewChange={(value) => picks.push(`view:${value}`)}
				view="board"
			/>
		);
		await click(button(view.container, "List"));
		await click(button(view.container, "Project"));
		expect(picks).toEqual(["view:list", "group:project"]);
		await view.dispose();
	});
});

describe("Board thread panel", () => {
	test("shows the host's thread view beside the board", () => {
		const html = renderToStaticMarkup(
			board({ activeThreadId: "thread-notes", threadView: HOST_VIEW })
		);
		expect(html).toContain('data-testid="board-thread-panel"');
		expect(html).toContain('data-testid="host-thread-view"');
		expect(html).toContain('aria-label="Thread: Release notes"');
		expect(html).toContain('aria-current="true"');
	});

	test("Escape closes the thread, returns focus, and arrows work at once", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			board({ activeThreadId: "thread-notes", port, threadView: HOST_VIEW })
		);
		const selected = view.container.querySelector<HTMLElement>(
			"[data-board-card][aria-current='true']"
		);
		await act(async () => selected?.focus());
		await press(selected, "Escape");
		expect(calls).toEqual(["close"]);
		expect(document.activeElement).toBe(selected ?? null);
		await press(selected, "ArrowLeft");
		const moved = document.activeElement;
		expect(moved).not.toBe(selected ?? null);
		// The deferred re-reveal after closing must not pull focus back.
		await act(
			async () =>
				await new Promise<void>((resolve) => {
					requestAnimationFrame(() => resolve());
				})
		);
		expect(document.activeElement).toBe(moved);
		await view.dispose();
	});
});
