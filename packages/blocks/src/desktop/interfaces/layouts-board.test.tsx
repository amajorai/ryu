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

import { describe, expect, test } from "bun:test";
import { HotkeysProvider, useHotkey } from "@ryu/hotkeys/react";
import {
	EMPTY_BOARD_FILTER,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardFilterBar, toggleBoardFilter } from "./board-filter.tsx";
import { BoardInterface } from "./board-interface.tsx";
import {
	button,
	click,
	EMPTY,
	headings,
	missingTitles,
	mount,
	openProps,
	press,
	props,
	recordingPort,
	SNAPSHOT,
	useLayoutDom,
} from "./layouts-test-support.tsx";

useLayoutDom();

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
