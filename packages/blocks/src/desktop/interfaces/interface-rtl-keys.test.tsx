// Arrow keys in interface tab rows and grids follow the reading direction:
// under dir="rtl" the row lays out right to left, so ArrowLeft moves forward.
import "./board-test-dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SortBar } from "./community-feed-sort-bar.tsx";
import { LiveTabs } from "./live-browse.tsx";
import { QaTabs } from "./qa-header.tsx";
import { SheetInterface } from "./sheet-interface.tsx";
import { moveInWeek } from "./timeline-interface-navigation.ts";
import { TIMELINE_EVENT_ATTRIBUTE } from "./timeline-parts.tsx";

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(() => {
	if (mounted) {
		const { container, root } = mounted;
		act(() => root.unmount());
		container.remove();
		mounted = null;
	}
});

function mount(element: ReactElement, direction: "ltr" | "rtl") {
	const container = document.createElement("div");
	container.setAttribute("dir", direction);
	container.style.direction = direction;
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(element));
	mounted = { container, root };
	return container;
}

function press(target: Element, key: string) {
	act(() => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

const TABS = [
	{ id: "a", label: "A" },
	{ id: "b", label: "B" },
	{ id: "c", label: "C" },
] as const;

function liveTabsChoice(direction: "ltr" | "rtl", key: string) {
	const picked: string[] = [];
	const container = mount(
		<LiveTabs
			label="Tabs"
			onChange={(id) => picked.push(id)}
			tabs={TABS}
			value="b"
		/>,
		direction
	);
	const selected = container.querySelector("[aria-selected='true']");
	if (!selected) {
		throw new Error("no selected tab");
	}
	press(selected, key);
	return picked;
}

describe("interface tab rows under RTL", () => {
	test("live tabs: ArrowRight moves forward in LTR", () => {
		expect(liveTabsChoice("ltr", "ArrowRight")).toEqual(["c"]);
	});

	test("live tabs: ArrowLeft moves forward in RTL", () => {
		expect(liveTabsChoice("rtl", "ArrowLeft")).toEqual(["c"]);
	});

	test("live tabs: ArrowRight moves back in RTL", () => {
		expect(liveTabsChoice("rtl", "ArrowRight")).toEqual(["a"]);
	});

	test("Q&A filter: ArrowLeft selects the next segment in RTL", () => {
		const picked: string[] = [];
		const container = mount(
			<QaTabs
				counts={{ answered: 0, attention: 0, top: 0, unanswered: 0 }}
				idFor={(tab) => `qa-${tab}`}
				onSelect={(tab) => picked.push(tab)}
				panelId="qa-panel"
				tab="top"
			/>,
			"rtl"
		);
		const tablist = container.querySelector("[role='tablist']");
		if (!tablist) {
			throw new Error("no tablist");
		}
		press(tablist, "ArrowLeft");
		expect(picked).toEqual(["unanswered"]);
	});

	test("community sort bar: ArrowLeft selects the next sort in RTL", () => {
		const picked: string[] = [];
		const container = mount(
			<SortBar
				mode="card"
				onMode={() => undefined}
				onSort={(sort) => picked.push(sort)}
				panelId="feed"
				sort="hot"
				tabId={(sort) => `sort-${sort}`}
			/>,
			"rtl"
		);
		const tab = container.querySelector("#sort-hot");
		if (!tab) {
			throw new Error("no sort tab");
		}
		press(tab, "ArrowLeft");
		expect(picked).toEqual(["new"]);
	});
});

const SHEET_SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [
		{
			agentIds: [],
			id: "thread-a",
			lastMessage: "Hello",
			lastMessageRole: "assistant",
			messageCount: 2,
			pinned: false,
			projectId: null,
			running: false,
			teamId: null,
			title: "Thread A",
			updatedAt: "2026-10-12T12:00:00Z",
		},
	],
	version: 1,
};

function sheetColumnAfter(direction: "ltr" | "rtl", keys: string[]) {
	const container = mount(
		<SheetInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={{
				closeThread: () => undefined,
				openThread: () => undefined,
				startThread: () => undefined,
			}}
			snapshot={SHEET_SNAPSHOT}
			threadView={null}
		/>,
		direction
	);
	const start = container.querySelector<HTMLElement>("tbody [tabindex='0']");
	if (!start) {
		throw new Error("no focusable cell");
	}
	act(() => start.focus());
	for (const key of keys) {
		const active = document.activeElement;
		if (!(active instanceof HTMLElement)) {
			throw new Error("no focused cell");
		}
		press(active, key);
	}
	const active = document.activeElement;
	return active instanceof HTMLElement ? active.dataset.sheetCol : undefined;
}

describe("sheet grid under RTL", () => {
	test("ArrowRight moves to the next column in LTR", () => {
		expect(sheetColumnAfter("ltr", ["ArrowRight"])).toBe("1");
	});

	test("ArrowLeft moves to the next column in RTL", () => {
		expect(sheetColumnAfter("rtl", ["ArrowLeft"])).toBe("1");
	});

	test("ArrowRight moves back toward the first column in RTL", () => {
		expect(
			sheetColumnAfter("rtl", ["ArrowLeft", "ArrowLeft", "ArrowRight"])
		).toBe("1");
	});
});

function weekGrid(direction: "ltr" | "rtl") {
	const root = document.createElement("div");
	root.setAttribute("dir", direction);
	root.style.direction = direction;
	for (const column of [2, 3, 4]) {
		const chip = document.createElement("button");
		chip.setAttribute(TIMELINE_EVENT_ATTRIBUTE, "");
		chip.dataset.column = String(column);
		chip.dataset.row = "0";
		root.append(chip);
	}
	document.body.append(root);
	return root;
}

function weekColumnAfter(direction: "ltr" | "rtl", key: string) {
	const root = weekGrid(direction);
	try {
		const from = root.querySelector<HTMLElement>("[data-column='3']");
		if (!from) {
			throw new Error("no chip");
		}
		from.focus();
		moveInWeek(root, from, key);
		const active = document.activeElement;
		return active instanceof HTMLElement ? active.dataset.column : undefined;
	} finally {
		root.remove();
	}
}

describe("timeline week grid under RTL", () => {
	test("ArrowRight moves to the next day in LTR", () => {
		expect(weekColumnAfter("ltr", "ArrowRight")).toBe("4");
	});

	test("ArrowLeft moves to the next day in RTL", () => {
		expect(weekColumnAfter("rtl", "ArrowLeft")).toBe("4");
	});

	test("ArrowRight moves to the previous day in RTL", () => {
		expect(weekColumnAfter("rtl", "ArrowRight")).toBe("2");
	});
});
