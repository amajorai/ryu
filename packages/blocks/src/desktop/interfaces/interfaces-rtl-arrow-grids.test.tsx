// Calendar, Arena and Notebook lay out with CSS grids and inline padding that
// mirror under dir="rtl", so their arrow keys follow the reading direction:
// ArrowLeft moves toward the inline end (forward / expand) in RTL.
import "./board-test-dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ARENA_NAV_ATTRIBUTE } from "./arena-card.tsx";
import { moveFocus } from "./arena-interface-navigation.ts";
import { CalendarInterface } from "./calendar-interface.tsx";
import { NotebookInterface } from "./notebook-interface.tsx";

type Direction = "ltr" | "rtl";

let mounted: { container: HTMLElement; root: Root } | null = null;

afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => root.unmount());
		container.remove();
		mounted = null;
	}
});

function directed(direction: Direction): HTMLElement {
	const container = document.createElement("div");
	container.setAttribute("dir", direction);
	container.style.direction = direction;
	document.body.append(container);
	return container;
}

async function mount(element: ReactElement, direction: Direction) {
	const container = directed(direction);
	const root = createRoot(container);
	await act(async () => root.render(element));
	mounted = { container, root };
	return container;
}

async function press(target: EventTarget, key: string) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

const PORT: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: ["agent-grace"],
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

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "idle",
		},
	],
	events: [],
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
			id: "thread-triage",
			projectId: "project-site",
			title: "Crash triage",
		}),
	],
	version: 1,
};

function dayFromToday(days: number): string {
	const date = new Date();
	date.setDate(date.getDate() + days);
	return localDayKey(date);
}

async function calendarDayAfter(direction: Direction, key: string) {
	const container = await mount(
		<CalendarInterface
			activeThreadId={null}
			loading={false}
			params={{ rail: true, scale: "month" }}
			port={PORT}
			snapshot={SNAPSHOT}
			threadView={null}
		/>,
		direction
	);
	await press(document.body, key);
	return (
		container
			.querySelector('[role="gridcell"][aria-selected="true"]')
			?.getAttribute("data-day-key") ?? null
	);
}

describe("calendar arrow keys", () => {
	test("ArrowRight moves to the next day in LTR", async () => {
		expect(await calendarDayAfter("ltr", "ArrowRight")).toBe(dayFromToday(1));
	});

	test("ArrowLeft moves to the next day in RTL", async () => {
		expect(await calendarDayAfter("rtl", "ArrowLeft")).toBe(dayFromToday(1));
	});

	test("ArrowRight moves to the previous day in RTL", async () => {
		expect(await calendarDayAfter("rtl", "ArrowRight")).toBe(dayFromToday(-1));
	});
});

/** A two-column card wall with three cards, focus on the middle one. */
function arenaGrid(direction: Direction) {
	const grid = directed(direction);
	grid.style.display = "grid";
	grid.style.gridTemplateColumns = "1fr 1fr";
	const buttons = ["a", "b", "c"].map((id) => {
		const card = document.createElement("article");
		card.setAttribute("data-agent-id", id);
		const action = document.createElement("button");
		action.setAttribute(ARENA_NAV_ATTRIBUTE, "");
		action.textContent = id;
		card.append(action);
		grid.append(card);
		return action;
	});
	const [first, middle, last] = buttons;
	if (!(first && middle && last)) {
		throw new Error("arena grid did not build");
	}
	middle.focus();
	return { first, grid, last, middle };
}

describe("arena card wall arrow keys", () => {
	test("ArrowRight focuses the next card in LTR", () => {
		const { grid, last, middle } = arenaGrid("ltr");
		expect(moveFocus(grid, middle, "ArrowRight")).toBe(true);
		expect(document.activeElement).toBe(last);
		grid.remove();
	});

	test("ArrowLeft focuses the next card in RTL", () => {
		const { grid, last, middle } = arenaGrid("rtl");
		expect(moveFocus(grid, middle, "ArrowLeft")).toBe(true);
		expect(document.activeElement).toBe(last);
		grid.remove();
	});

	test("ArrowRight focuses the previous card in RTL", () => {
		const { first, grid, middle } = arenaGrid("rtl");
		expect(moveFocus(grid, middle, "ArrowRight")).toBe(true);
		expect(document.activeElement).toBe(first);
		grid.remove();
	});
});

function treeItem(container: HTMLElement, label: string): HTMLElement {
	const match = [
		...container.querySelectorAll<HTMLElement>('[role="treeitem"]'),
	].find((candidate) =>
		candidate.getAttribute("aria-label")?.startsWith(label)
	);
	if (!match) {
		throw new Error(`No tree item labelled ${label}`);
	}
	return match;
}

async function notebookSite(direction: Direction) {
	const container = await mount(
		<NotebookInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={PORT}
			snapshot={SNAPSHOT}
			threadView={null}
		/>,
		direction
	);
	const projects = treeItem(container, "Projects");
	await act(async () => projects.focus());
	await press(projects, "ArrowDown");
	return treeItem(container, "Site");
}

describe("notebook tree arrow keys", () => {
	test("ArrowLeft collapses an open row in LTR", async () => {
		const site = await notebookSite("ltr");
		expect(document.activeElement).toBe(site);
		expect(site.getAttribute("aria-expanded")).toBe("true");
		await press(site, "ArrowLeft");
		expect(site.getAttribute("aria-expanded")).toBe("false");
	});

	test("ArrowRight collapses an open row in RTL", async () => {
		const site = await notebookSite("rtl");
		expect(site.getAttribute("aria-expanded")).toBe("true");
		await press(site, "ArrowRight");
		expect(site.getAttribute("aria-expanded")).toBe("false");
	});

	test("ArrowLeft expands, then enters, a row in RTL", async () => {
		const site = await notebookSite("rtl");
		await press(site, "ArrowRight");
		await press(site, "ArrowLeft");
		expect(site.getAttribute("aria-expanded")).toBe("true");
		await press(site, "ArrowLeft");
		expect(document.activeElement?.getAttribute("aria-label")).toStartWith(
			"Crash triage"
		);
	});
});
