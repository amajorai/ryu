// Cross-layout contract tests for the eight layout interfaces — Board, Inbox,
// Graph, Timeline, Messenger, Terminal, Arena and Desk. Every renderer gets
// the same small fixture that covers each thread status (working, needs
// attention, your turn, waiting on the agent, not started), a team, a
// project and an unassigned thread. Each layout is checked for its key
// content, loading and empty states, the host's thread view, and at least
// one real interaction that reaches the port.
//
// Static markup (react-dom/server) covers what a renderer prints; happy-dom
// with createRoot covers interactions, so clicks and keys run real React
// state and real handlers.

import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { HotkeysProvider, useHotkey } from "@ryu/hotkeys/react";
import {
	EMPTY_BOARD_FILTER,
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
import { ArenaInterface } from "./arena-interface.tsx";
import { BoardFilterBar, toggleBoardFilter } from "./board-filter.tsx";
import { BoardInterface } from "./board-interface.tsx";
import { DeskInterface } from "./desk-interface.tsx";
import { GraphInterface } from "./graph-interface.tsx";
import { InboxInterface } from "./inbox-interface.tsx";
import { MessengerInterface } from "./messenger-interface.tsx";
import { TerminalInterface } from "./terminal-interface.tsx";
import { listThreads } from "./terminal-model.ts";
import { TimelineInterface } from "./timeline-interface.tsx";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const NOW = Date.now();
const START_OF_TODAY = new Date(NOW).setHours(0, 0, 0, 0);

/**
 * A time `minutes` ago that never crosses midnight, so "today" threads stay
 * on today's timeline whenever the suite runs. Ordering is preserved: fewer
 * minutes is always newer.
 */
function todayAgo(minutes: number): string {
	return new Date(
		Math.max(NOW - minutes * MINUTE, START_OF_TODAY + (1000 - minutes) * 1000)
	).toISOString();
}

/** Noon, `days` calendar days ago, in local time. */
function daysAgoAtNoon(days: number): string {
	const date = new Date(NOW);
	date.setDate(date.getDate() - days);
	date.setHours(12, 0, 0, 0);
	return date.toISOString();
}

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
		updatedAt: todayAgo(60),
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
			description: "Audits dependencies",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "team-design",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Design Review",
		},
		{
			id: "project-docs",
			kind: "project",
			memberAgentIds: ["agent-ada", "agent-linus"],
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
			updatedAt: todayAgo(5),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-audit",
			lastMessage: "Two advisories need a patch release.",
			runState: "failed",
			title: "Audit dependencies",
			updatedAt: todayAgo(30),
		}),
		thread({
			agentIds: ["agent-ada", "agent-grace"],
			id: "thread-sync",
			lastMessage: "Agenda is posted for the design sync.",
			messageCount: 12,
			pinned: true,
			teamId: "team-design",
			title: "Weekly design sync",
			updatedAt: todayAgo(60),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			projectId: "project-docs",
			title: "Release notes",
			updatedAt: todayAgo(120),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-intro",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: daysAgoAtNoon(1),
		}),
		thread({
			id: "thread-office",
			lastMessageRole: null,
			messageCount: 0,
			title: "Office closed Friday",
			updatedAt: daysAgoAtNoon(3),
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

const THREAD_TITLES = SNAPSHOT.threads.map((item) => item.title);

const HOST_VIEW = (
	<div data-testid="host-thread-view">
		Host chat surface for the open thread
	</div>
);

// ---------------------------------------------------------------------------
// DOM + helpers
// ---------------------------------------------------------------------------

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Base UI's ScrollArea waits on animations, which happy-dom does not model.
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

interface PortCalls {
	calls: string[];
	port: InterfacePort;
}

/** A port that records every call as `open:<id>`, `start:<json>`, `close`. */
function recordingPort(): PortCalls {
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

interface CommonProps {
	activeThreadId: string | null;
	loading: boolean;
	port: InterfacePort;
	snapshot: InterfaceSnapshot;
	threadView: ReactNode | null;
}

function props(overrides: Partial<CommonProps> = {}): CommonProps {
	return {
		activeThreadId: null,
		loading: false,
		port: recordingPort().port,
		snapshot: SNAPSHOT,
		threadView: null,
		...overrides,
	};
}

/** Props with `threadId` open and the host's view passed in. */
function openProps(threadId: string, port?: InterfacePort): CommonProps {
	return props({
		activeThreadId: threadId,
		port: port ?? recordingPort().port,
		threadView: HOST_VIEW,
	});
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

async function press(element: Element | null | undefined, key: string) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected an element to send keys to");
	}
	await act(async () => {
		element.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

/**
 * Type into a controlled input the way React's onChange observes it. React
 * may have been evaluated before the DOM was registered, in which case it
 * watches the focused field's keyup instead of `input`, so send both.
 */
async function typeInto(input: Element | null | undefined, value: string) {
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("Expected a text input");
	}
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		input.focus();
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

async function submit(form: Element | null | undefined) {
	if (!(form instanceof HTMLFormElement)) {
		throw new Error("Expected a form");
	}
	await act(async () => {
		form.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
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

function headings(container: ParentNode, selector = "h2"): string[] {
	return [...container.querySelectorAll(selector)].map(
		(heading) => heading.textContent?.trim() ?? ""
	);
}

/** Fixture thread titles that `html` does not mention. */
function missingTitles(html: string): string[] {
	return THREAD_TITLES.filter((title) => !html.includes(title));
}

// The fixture really covers every status the layouts group by.
test("fixture covers every thread status", () => {
	const statuses = new Set(SNAPSHOT.threads.map(threadStatus));
	expect([...statuses].sort()).toEqual([...THREAD_STATUS_ORDER].sort());
});

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/** The desktop binds Mod+K to its own command palette through @ryu/hotkeys. */
const APP_PALETTE_HOTKEYS = [
	{
		category: "General",
		defaultBinding: "Mod+K",
		id: "command-palette.toggle",
		label: "Toggle Command Palette",
	},
];

/** Stands in for the desktop's palette: counts each Mod+K it receives. */
function AppPaletteProbe({ onToggle }: { onToggle: () => void }) {
	useHotkey("command-palette.toggle", onToggle);
	return null;
}

describe("Board layout", () => {
	test("renders a status lane per status with every card", () => {
		const html = renderToStaticMarkup(
			<BoardInterface
				{...props()}
				params={{ groupBy: "status", view: "board" }}
			/>
		);
		expect(html).toContain('data-testid="interface-board"');
		expect(html).toContain('aria-label="Threads by status"');
		for (const label of Object.values(THREAD_STATUS_LABELS)) {
			expect(html).toContain(label);
		}
		expect(missingTitles(html)).toEqual([]);
		expect(html).toContain("6 threads · 1 working");
	});

	test("shows loading skeletons and an empty state", () => {
		const loading = renderToStaticMarkup(
			<BoardInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{ groupBy: "status", view: "board" }}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("No threads yet");
		const empty = renderToStaticMarkup(
			<BoardInterface
				{...props({ snapshot: EMPTY })}
				params={{ groupBy: "status", view: "board" }}
			/>
		);
		expect(empty).toContain("No threads yet");
	});

	test("shows the host thread view in its panel", () => {
		const html = renderToStaticMarkup(
			<BoardInterface
				{...openProps("thread-notes")}
				params={{ groupBy: "status", view: "board" }}
			/>
		);
		expect(html).toContain('data-testid="board-thread-panel"');
		expect(html).toContain('data-testid="host-thread-view"');
		expect(html).toContain('aria-label="Thread: Release notes"');
	});

	test("agent lanes start threads in place and cards open threads", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<BoardInterface
				{...props({ port })}
				params={{ groupBy: "agent", view: "board" }}
			/>
		);
		const region = view.container.querySelector(
			"[role='region'][aria-label^='Threads by']"
		);
		expect(region?.getAttribute("aria-label")).toBe("Threads by agent");
		const lanes = headings(view.container).map((text) =>
			text.replace(/,.*$/, "")
		);
		expect(lanes).toEqual(["Ada", "Grace", "Linus", "Unassigned"]);

		await click(button(view.container, "New thread with Linus"));
		expect(calls.at(-1)).toBe('start:{"agentId":"agent-linus"}');

		await click(button(view.container, /Crash triage/));
		expect(calls.at(-1)).toBe("open:thread-triage");
		// Grouping and layout live behind the header's Display menu.
		expect(
			button(view.container, "Display")?.getAttribute("aria-haspopup")
		).toBe("dialog");
		await view.dispose();
	});
});

describe("Board list view", () => {
	test("lists every thread in grouped sections, leaving empty groups out", () => {
		const html = renderToStaticMarkup(
			<BoardInterface
				{...props()}
				params={{ groupBy: "agent", view: "list" }}
			/>
		);
		expect(missingTitles(html)).toEqual([]);
		expect(html).toContain('aria-label="Threads by agent"');
		expect(html).toContain('data-board-row=""');
		expect(html).not.toContain('data-board-lane=""');
	});

	test("groups by project with a No project section and starts in a project", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<BoardInterface
				{...props({ port })}
				params={{ groupBy: "project", view: "list" }}
			/>
		);
		expect(headings(view.container)).toEqual(["Docs Site", "No project"]);
		await click(button(view.container, "New thread in Docs Site"));
		expect(calls.at(-1)).toBe('start:{"projectId":"project-docs"}');
		await view.dispose();
	});

	test("rows move with J/K and arrows, open with a click, and sections collapse", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<BoardInterface
				{...props({ port })}
				params={{ groupBy: "status", view: "list" }}
			/>
		);
		const rows = () => [
			...view.container.querySelectorAll<HTMLElement>("[data-board-row]"),
		];
		const first = rows()[0];
		await act(async () => first?.focus());
		await press(first, "j");
		expect(document.activeElement).toBe(rows()[1] ?? null);
		await press(rows()[1], "ArrowUp");
		expect(document.activeElement).toBe(first ?? null);
		await press(first, "End");
		expect(document.activeElement).toBe(rows().at(-1) ?? null);

		await click(button(view.container, /Crash triage/));
		expect(calls.at(-1)).toBe("open:thread-triage");

		const before = rows().length;
		const toggle = view.container.querySelector<HTMLElement>(
			"section header button[aria-expanded='true']"
		);
		await click(toggle);
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(rows().length).toBeLessThan(before);
		await view.dispose();
	});

	test("C starts a thread from a card", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<BoardInterface
				{...props({ port })}
				params={{ groupBy: "status", view: "board" }}
			/>
		);
		expect(view.container.querySelector("[data-board-row]")).toBeNull();
		expect(view.container.querySelector("[data-board-lane]")).not.toBeNull();
		await press(view.container.querySelector("[data-board-card]"), "c");
		expect(calls.at(-1)).toBe("start:{}");
		await view.dispose();
	});

	test("Mod+Shift+K opens the command menu, but not from the open thread, and Mod+K stays the app's palette", async () => {
		let appPaletteToggles = 0;
		const view = await mount(
			<HotkeysProvider registry={APP_PALETTE_HOTKEYS}>
				<AppPaletteProbe
					onToggle={() => {
						appPaletteToggles += 1;
					}}
				/>
				<BoardInterface
					{...openProps("thread-notes")}
					params={{ groupBy: "status", view: "list" }}
				/>
			</HotkeysProvider>
		);
		const chord = (target: Element | null, shiftKey: boolean) =>
			act(async () => {
				target?.dispatchEvent(
					new KeyboardEvent("keydown", {
						bubbles: true,
						cancelable: true,
						key: shiftKey ? "K" : "k",
						metaKey: true,
						shiftKey,
					})
				);
			});
		const paletteTitle = () =>
			document.querySelector("[data-slot='dialog-title']")?.textContent;
		expect(
			button(view.container, "Commands")?.getAttribute("aria-keyshortcuts")
		).toBe("Control+Shift+K Meta+Shift+K");
		const row = view.container.querySelector("[data-board-row]");
		// Mod+K on the board reaches the desktop's palette, not the Board's menu.
		await chord(row, false);
		expect(appPaletteToggles).toBe(1);
		expect(paletteTitle()).toBeUndefined();
		await chord(
			view.container.querySelector("[data-testid='host-thread-view']"),
			true
		);
		expect(paletteTitle()).toBeUndefined();
		await chord(row, true);
		expect(paletteTitle()).toBe("Board commands");
		expect(appPaletteToggles).toBe(1);
		await view.dispose();
	});

	test("filters narrow the list and show as removable chips", () => {
		const filter = toggleBoardFilter(
			toggleBoardFilter(EMPTY_BOARD_FILTER, "statuses", "working"),
			"statuses",
			"your-turn"
		);
		expect(filter.statuses).toEqual(["working", "your-turn"]);
		expect(toggleBoardFilter(filter, "statuses", "working").statuses).toEqual([
			"your-turn",
		]);
		const html = renderToStaticMarkup(
			<BoardFilterBar
				filter={{ ...filter, agentIds: ["agent-grace"] }}
				onClear={() => undefined}
				onRemoveField={() => undefined}
				snapshot={SNAPSHOT}
			/>
		);
		expect(html).toContain("Status is any of");
		expect(html).toContain("Working, Your turn");
		expect(html).toContain("Agent is");
		expect(html).toContain("Grace");
		expect(html).toContain('aria-label="Remove status filter"');
		expect(
			renderToStaticMarkup(
				<BoardFilterBar
					filter={EMPTY_BOARD_FILTER}
					onClear={() => undefined}
					onRemoveField={() => undefined}
					snapshot={SNAPSHOT}
				/>
			)
		).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

describe("Inbox layout", () => {
	test("groups every thread into urgency sections", () => {
		const html = renderToStaticMarkup(
			<InboxInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-inbox"');
		expect(html).toContain('role="listbox"');
		for (const section of ["attention", "your-turn", "working", "waiting"]) {
			expect(html).toContain(`data-section="${section}"`);
		}
		for (const item of SNAPSHOT.threads) {
			expect(html).toContain(`data-testid="inbox-row-${item.id}"`);
		}
		// Needs attention and your turn are the threads that need you.
		expect(html).toContain("3 need you");
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<InboxInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain("Loading inbox");
		expect(loading).not.toContain("No threads yet. Start one");
		const empty = renderToStaticMarkup(
			<InboxInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No threads yet. Start one with any agent.");
	});

	test("shows the host thread view in the detail pane", () => {
		const html = renderToStaticMarkup(
			<InboxInterface {...openProps("thread-audit")} params={{}} />
		);
		expect(html).toContain('data-testid="inbox-detail"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("J/K move the cursor and Enter opens the row", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<InboxInterface {...props({ port })} params={{}} />
		);
		const order = [
			...view.container.querySelectorAll<HTMLElement>("[data-inbox-row]"),
		].map((row) => row.dataset.inboxRow ?? "");
		expect(order).toHaveLength(SNAPSHOT.threads.length);
		// Most urgent first: the failed audit leads the list.
		expect(order[0]).toBe("thread-audit");
		const row = (id: string | undefined) =>
			view.container.querySelector(`[data-inbox-row="${id}"]`);

		expect(row(order[0])?.getAttribute("tabindex")).toBe("0");
		await press(row(order[0]), "j");
		expect(document.activeElement).toBe(row(order[1]));
		await press(row(order[1]), "j");
		expect(document.activeElement).toBe(row(order[2]));
		await press(row(order[2]), "k");
		expect(document.activeElement).toBe(row(order[1]));
		await press(row(order[1]), "Enter");
		expect(calls).toEqual([`open:${order[1]}`]);

		// C starts a new thread from the list.
		await press(row(order[1]), "c");
		expect(calls.at(-1)).toBe("start:{}");
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

describe("Graph layout", () => {
	test("puts you, every agent, the team and the project on the map", async () => {
		const view = await mount(<GraphInterface {...props()} params={{}} />);
		expect(
			view.container.querySelector("[data-testid='interface-graph']")
		).not.toBeNull();
		const nodes = [
			...view.container.querySelectorAll<HTMLElement>("[data-graph-node]"),
		].map((node) => node.dataset.graphNode);
		expect(nodes).toEqual(
			expect.arrayContaining([
				"you",
				"agent:agent-ada",
				"agent:agent-grace",
				"agent:agent-linus",
			])
		);
		expect(nodes.some((id) => id?.includes("team-design"))).toBe(true);
		expect(nodes.some((id) => id?.includes("project-docs"))).toBe(true);
		await view.dispose();
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<GraphInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain('aria-label="Loading the map"');
		expect(loading).toContain('aria-busy="true"');
		const empty = renderToStaticMarkup(
			<GraphInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No one on the map yet");
	});

	test("shows the host thread view in the thread panel", async () => {
		const view = await mount(
			<GraphInterface {...openProps("thread-triage")} params={{}} />
		);
		const panel = view.container.querySelector(
			"[data-testid='graph-thread-panel']"
		);
		expect(panel?.getAttribute("aria-label")).toBe("Thread: Crash triage");
		expect(
			panel?.querySelector("[data-testid='host-thread-view']")
		).not.toBeNull();
		await view.dispose();
	});

	test("clicking a node opens its side panel, which opens threads", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<GraphInterface {...props({ port })} params={{}} />
		);
		expect(
			view.container.querySelector("[data-testid='graph-node-panel']")
		).toBeNull();
		await click(
			view.container.querySelector("[data-graph-node='agent:agent-grace']")
		);
		const panel = view.container.querySelector(
			"[data-testid='graph-node-panel']"
		);
		expect(panel?.getAttribute("aria-label")).toBe("Grace details");
		expect(panel?.textContent).toContain("Triages bugs");
		expect(panel?.textContent).toContain("Crash triage");
		expect(panel?.textContent).toContain("Weekly design sync");
		expect(panel?.textContent).not.toContain("Audit dependencies");

		await click(button(panel, /Crash triage/));
		expect(calls).toEqual(["open:thread-triage"]);

		await click(button(panel, "Close details"));
		expect(
			view.container.querySelector("[data-testid='graph-node-panel']")
		).toBeNull();
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

describe("Timeline layout", () => {
	test("renders one section per active day, newest first", () => {
		const html = renderToStaticMarkup(
			<TimelineInterface {...props()} params={{ scale: "day" }} />
		);
		expect(html).toContain('data-testid="interface-timeline"');
		expect(html).toContain('aria-label="Threads by day"');
		expect(html).toContain('aria-label="Threads, Today"');
		expect(html).toContain('aria-label="Threads, Yesterday"');
		expect(html.match(/data-day-key="/g)).toHaveLength(3);
		expect(html.indexOf("Threads, Today")).toBeLessThan(
			html.indexOf("Threads, Yesterday")
		);
		expect(missingTitles(html)).toEqual([]);
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<TimelineInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{ scale: "day" }}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("No threads yet");
		const empty = renderToStaticMarkup(
			<TimelineInterface
				{...props({ snapshot: EMPTY })}
				params={{ scale: "day" }}
			/>
		);
		expect(empty).toContain("No threads yet");
	});

	test("shows the host thread view in its panel", () => {
		const html = renderToStaticMarkup(
			<TimelineInterface
				{...openProps("thread-intro")}
				params={{ scale: "week" }}
			/>
		);
		expect(html).toContain('data-testid="timeline-thread-panel"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("the Day/Week toggle switches scale and events open threads", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<TimelineInterface {...props({ port })} params={{ scale: "day" }} />
		);
		const region = () =>
			view.container.querySelector("[role='region'][aria-label^='Threads ']");
		expect(region()?.getAttribute("aria-label")).toBe("Threads by day");
		const scale = view.container.querySelector("[aria-label='Timeline scale']");
		await click(button(scale, "Week"));
		expect(region()?.getAttribute("aria-label")).toBe("Threads this week");
		// The week grid labels today's column.
		expect(
			[...view.container.querySelectorAll("[aria-label^='Today, ']")].length
		).toBeGreaterThan(0);

		await click(button(view.container, /^Release notes, Ada/));
		expect(calls).toEqual(["open:thread-notes"]);

		await click(button(scale, "Day"));
		expect(region()?.getAttribute("aria-label")).toBe("Threads by day");
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Messenger
// ---------------------------------------------------------------------------

describe("Messenger layout", () => {
	test("lists agents and the team as contacts", () => {
		const html = renderToStaticMarkup(
			<MessengerInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-messenger"');
		expect(html).toContain('aria-label="Contacts"');
		for (const key of [
			"agent:agent-ada",
			"agent:agent-grace",
			"agent:agent-linus",
			"team:team-design",
		]) {
			expect(html).toContain(`data-messenger-contact="${key}"`);
		}
		expect(html).toContain("No conversation selected");
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<MessengerInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain("Loading conversations…");
		const empty = renderToStaticMarkup(
			<MessengerInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No contacts yet.");
		expect(empty).toContain("Create an agent to start messaging");
	});

	test("shows the host thread view in the conversation", () => {
		const html = renderToStaticMarkup(
			<MessengerInterface {...openProps("thread-notes")} params={{}} />
		);
		expect(html).toContain('data-testid="messenger-thread"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("clicking a contact opens its latest thread; search filters", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MessengerInterface {...props({ port })} params={{}} />
		);
		const contact = (key: string) =>
			view.container.querySelector(`[data-messenger-contact="${key}"]`);
		await click(contact("agent:agent-grace"));
		// Grace's most recent thread is the live crash triage.
		expect(calls).toEqual(["open:thread-triage"]);

		const search = view.container.querySelector("input[type='search']");
		await typeInto(search, "advisories");
		expect(contact("agent:agent-linus")).not.toBeNull();
		expect(contact("agent:agent-ada")).toBeNull();
		expect(contact("agent:agent-grace")).toBeNull();

		await typeInto(search, "zzz-no-match");
		expect(view.container.textContent).toContain("No contacts match");

		await typeInto(search, "");
		expect(contact("agent:agent-ada")).not.toBeNull();
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

describe("Terminal layout", () => {
	test("prints the banner with live counts and a labelled prompt", () => {
		const html = renderToStaticMarkup(
			<TerminalInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-terminal"');
		expect(html).toContain('role="log"');
		expect(html).toContain("Terminal command");
		expect(html).toContain("1 working");
		expect(html).toContain("3 agents");
		expect(html).toContain("6 threads");
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<TerminalInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain("loading agents and threads");
		const empty = renderToStaticMarkup(
			<TerminalInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("0 agents");
		expect(empty).toContain("0 threads");
	});

	test("shows the host thread view beside the scrollback", () => {
		const html = renderToStaticMarkup(
			<TerminalInterface {...openProps("thread-sync")} params={{}} />
		);
		expect(html).toContain('aria-label="Thread: Weekly design sync"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("ls, open, @agent, unknown commands and history all work", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<TerminalInterface {...props({ port })} params={{}} />
		);
		const input = view.container.querySelector("input[type='text']");
		const form = view.container.querySelector("form");
		const log = () =>
			view.container.querySelector("[role='log']")?.textContent ?? "";
		const run = async (command: string) => {
			await typeInto(input, command);
			await submit(form);
		};

		await run("ls");
		const listed = listThreads(SNAPSHOT, "all");
		for (const row of listed) {
			expect(log()).toContain(row.title);
		}
		await run("open 1");
		expect(calls).toEqual([`open:${listed[0]?.threadId}`]);
		expect(log()).toContain(`opened #1 ${listed[0]?.title}`);

		await run("@ada hi");
		expect(calls.at(-1)).toBe('start:{"agentId":"agent-ada","prompt":"hi"}');

		await run("frobnicate");
		expect(log()).toContain("ryu: command not found: frobnicate");
		expect(calls).toHaveLength(2);

		expect((input as HTMLInputElement).value).toBe("");
		await press(input, "ArrowUp");
		expect((input as HTMLInputElement).value).toBe("frobnicate");
		await press(input, "ArrowUp");
		expect((input as HTMLInputElement).value).toBe("@ada hi");
		await press(input, "ArrowDown");
		expect((input as HTMLInputElement).value).toBe("frobnicate");
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------

describe("Arena layout", () => {
	test("puts a card on the wall for every agent", () => {
		const html = renderToStaticMarkup(
			<ArenaInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-arena"');
		expect(html).toContain('aria-label="All agents"');
		for (const name of ["Ada", "Grace", "Linus"]) {
			expect(html).toContain(`aria-label="Message ${name}"`);
		}
		// The thread with no agent is listed apart from the agent cards.
		expect(html).toContain("Office closed Friday");
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<ArenaInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("No agents on the wall yet");
		const empty = renderToStaticMarkup(
			<ArenaInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No agents on the wall yet");
	});

	test("shows the host thread view in its panel", () => {
		const html = renderToStaticMarkup(
			<ArenaInterface {...openProps("thread-audit")} params={{}} />
		);
		expect(html).toContain('data-testid="arena-thread-panel"');
		expect(html).toContain('data-testid="host-thread-view"');
	});

	test("filter chips narrow the wall and Message starts a thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<ArenaInterface {...props({ port })} params={{}} />
		);
		const cards = () =>
			[...view.container.querySelectorAll("article h2, article h3")].map(
				(heading) => heading.textContent?.trim()
			);
		const messageButtons = () =>
			[...view.container.querySelectorAll("button")]
				.map((candidate) => candidate.getAttribute("aria-label") ?? "")
				.filter((label) => label.startsWith("Message "));
		expect(messageButtons()).toHaveLength(3);

		await click(button(view.container, /^Working \(/));
		expect(
			view.container.querySelector("ul[aria-label='Working agents']")
		).not.toBeNull();
		expect(messageButtons()).toEqual(["Message Grace"]);

		await click(button(view.container, /^Idle \(/));
		expect(messageButtons()).not.toContain("Message Grace");

		await click(button(view.container, /^All \(/));
		expect(messageButtons()).toHaveLength(3);
		expect(cards().length).toBeGreaterThan(0);

		await click(button(view.container, "Message Linus"));
		expect(calls).toEqual(['start:{"agentId":"agent-linus"}']);
		await view.dispose();
	});
});

// ---------------------------------------------------------------------------
// Desk
// ---------------------------------------------------------------------------

describe("Desk layout", () => {
	test("renders the views rail and the conversation list", () => {
		const html = renderToStaticMarkup(
			<DeskInterface {...props()} params={{}} />
		);
		expect(html).toContain('data-testid="interface-desk"');
		expect(html).toContain('aria-label="Desk views"');
		for (const view of ["needs-you", "working", "all"]) {
			expect(html).toContain(`data-testid="desk-view-${view}"`);
		}
		for (const agent of SNAPSHOT.agents) {
			expect(html).toContain(`data-testid="desk-view-agent:${agent.id}"`);
		}
		expect(html).toContain('data-testid="desk-no-selection"');
	});

	test("shows loading and empty states", () => {
		const loading = renderToStaticMarkup(
			<DeskInterface
				{...props({ loading: true, snapshot: EMPTY })}
				params={{}}
			/>
		);
		expect(loading).toContain('aria-busy="true"');
		const empty = renderToStaticMarkup(
			<DeskInterface {...props({ snapshot: EMPTY })} params={{}} />
		);
		expect(empty).toContain("No conversations yet");
	});

	test("shows the host thread view in the conversation pane", () => {
		const html = renderToStaticMarkup(
			<DeskInterface {...openProps("thread-sync")} params={{}} />
		);
		expect(html).toContain('data-testid="host-thread-view"');
		expect(html).toContain('aria-label="Conversation: Weekly design sync"');
	});

	test("views filter the list and Enter opens the focused row", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<DeskInterface {...props({ port })} params={{}} />
		);
		const rows = () =>
			[...view.container.querySelectorAll("[data-testid^='desk-row-']")].map(
				(row) => row.getAttribute("data-testid")?.replace("desk-row-", "")
			);
		await click(view.container.querySelector("[data-testid='desk-view-all']"));
		expect(rows()).toHaveLength(SNAPSHOT.threads.length);

		await click(
			view.container.querySelector("[data-testid='desk-view-working']")
		);
		expect(rows()).toEqual(["thread-triage"]);

		await click(
			view.container.querySelector(
				"[data-testid='desk-view-agent:agent-linus']"
			)
		);
		expect(rows()).toEqual(["thread-audit"]);

		await press(
			view.container.querySelector("[data-testid='desk-row-thread-audit']"),
			"Enter"
		);
		expect(calls).toEqual(["open:thread-audit"]);
		await view.dispose();
	});

	test("the details toggle shows the agents on the conversation", async () => {
		const view = await mount(
			<DeskInterface {...openProps("thread-sync")} params={{}} />
		);
		const details = () =>
			view.container.querySelector("[data-testid='desk-details']");
		const toggle = () =>
			view.container.querySelector("[data-testid='desk-details-toggle']");
		if (details()) {
			await click(toggle());
			expect(details()).toBeNull();
		}
		expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
		await click(toggle());
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		const panel = details();
		expect(panel?.textContent).toContain("Agents");
		expect(button(panel, "Open Ada's inbox")).toBeDefined();
		expect(button(panel, "Open Grace's inbox")).toBeDefined();
		expect(button(panel, "Open Linus's inbox")).toBeUndefined();
		expect(panel?.textContent).toContain("Design Review");
		await view.dispose();
	});
});
