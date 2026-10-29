// The DOM first, before React loads (a side-effect import stays first).
import "./warehouse-test-dom.ts";
import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	InterfaceAgentAct,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	agentActs,
	resolveInterfaceParams,
	unownedAsks,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode, useState } from "react";
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
import { ActClockProvider } from "./use-acts.ts";
import {
	actPickers,
	CAGE_REASON_ID,
	cageReason,
	dispatchLayout,
	floorAgents,
	forkliftLimit,
	orderActs,
	PICKER_STATIONS,
	pickerStations,
	shelfLabels,
	warehouseActPaths,
} from "./warehouse-acts.tsx";
import { boxSpot, floorZones, pickerPose, TILE } from "./warehouse-diorama.tsx";
import {
	WarehouseInterface,
	warehouseNight,
	warehouseSettings,
} from "./warehouse-interface.tsx";
import {
	AISLE_COUNT,
	aisleY,
	buildOrders,
	buildPickers,
	FLOOR,
	filterOrders,
	floorStats,
	inTab,
	orderNumber,
	orderNumbers,
	orderStage,
	pickerRoute,
	placeOrders,
	RACK,
	READY_SLOTS,
	rackRowY,
	tabCounts,
} from "./warehouse-model.ts";

const MINUTE = 60_000;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

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
			description: "Research",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Deploys",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Frontend",
			id: "agent-linus",
			name: "Linus",
			status: "working",
		},
	],
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-grace"],
			id: "thread-deploy",
			lastMessage: "Canary at 25%.",
			running: true,
			title: "Roll out the gateway",
			updatedAt: ago(10),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-hero",
			lastMessage: "Swapping the type scale.",
			running: true,
			title: "Rebuild the hero",
			updatedAt: ago(0.5),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-audit",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Audit advisories",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you add latency numbers?",
			lastMessageRole: "user",
			title: "Survey papers",
			updatedAt: ago(120),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-runbook",
			lastMessage: "Runbook updated.",
			title: "Update the runbook",
			updatedAt: ago(60 * 50),
		}),
	],
	version: 1,
};

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

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
}

async function press(target: Element, key: string) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

/** A tiny host: the port really opens and closes threads, like the desktop. */
function Host({
	calls,
	initialThreadId = null,
	snapshot = SNAPSHOT,
}: {
	calls: string[];
	initialThreadId?: string | null;
	snapshot?: InterfaceSnapshot;
}) {
	const [activeThreadId, setActiveThreadId] = useState<string | null>(
		initialThreadId
	);
	const port: InterfacePort = {
		closeThread: () => {
			calls.push("close");
			setActiveThreadId(null);
		},
		openThread: (id) => {
			calls.push(`open:${id}`);
			setActiveThreadId(id);
		},
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	const threadView: ReactNode = activeThreadId ? (
		<section data-testid="host-thread">Host thread {activeThreadId}</section>
	) : null;
	return (
		<WarehouseInterface
			activeThreadId={activeThreadId}
			loading={false}
			params={{}}
			port={port}
			snapshot={snapshot}
			threadView={threadView}
		/>
	);
}

describe("warehouse model", () => {
	test("each conversation status maps to one fulfillment stage", () => {
		const stage = (id: string) => {
			const found = SNAPSHOT.threads.find((item) => item.id === id);
			if (!found) {
				throw new Error(`missing ${id}`);
			}
			return orderStage(found, NOW);
		};
		expect(stage("thread-deploy")).toBe("picking");
		expect(stage("thread-hero")).toBe("packing");
		expect(stage("thread-notes")).toBe("ready");
		expect(stage("thread-audit")).toBe("exception");
		expect(stage("thread-question")).toBe("received");
		// An old reply has left on the truck.
		expect(stage("thread-runbook")).toBe("shipped");
		// Nothing said yet counts as shipped (quiet), not as waiting on anyone.
		expect(
			orderStage(thread({ id: "quiet", lastMessageRole: null }), NOW)
		).toBe("shipped");
	});

	test("order numbers are stable and shaped like #R-1042", () => {
		expect(orderNumber("thread-hero")).toBe(orderNumber("thread-hero"));
		expect(orderNumber("thread-hero")).toMatch(/^#R-\d{4}$/);
		expect(orderNumber("thread-hero")).not.toBe(orderNumber("thread-notes"));
	});

	test("order numbers never repeat, even when two ids hash alike", () => {
		// These two ids share a bare hash slot.
		expect(orderNumber("thread-479")).toBe(orderNumber("thread-534"));
		const pair = orderNumbers(["thread-534", "thread-479"]);
		expect(pair.get("thread-479")).toBe(orderNumber("thread-479"));
		expect(pair.get("thread-534")).not.toBe(pair.get("thread-479"));

		const ids = Array.from({ length: 1000 }, (_, index) => `thread-${index}`);
		expect(new Set(ids.map(orderNumber)).size).toBeLessThan(ids.length);
		const numbers = orderNumbers(ids);
		expect(new Set(numbers.values()).size).toBe(ids.length);
		for (const value of numbers.values()) {
			expect(value).toMatch(/^#R-\d{4}$/);
		}
		// Recency does not reshuffle them: the input order is irrelevant.
		expect([...orderNumbers([...ids].reverse())].sort()).toEqual(
			[...numbers].sort()
		);
		const orders = buildOrders(
			{ ...SNAPSHOT, threads: ids.map((id) => thread({ id })) },
			NOW
		);
		expect(new Set(orders.map((order) => order.number)).size).toBe(ids.length);
	});

	test("orders read newest first and tabs count the right stages", () => {
		const orders = buildOrders(SNAPSHOT, NOW);
		expect(orders.map((order) => order.id)).toEqual([
			"thread-hero",
			"thread-deploy",
			"thread-notes",
			"thread-audit",
			"thread-question",
			"thread-runbook",
		]);
		expect(tabCounts(orders, null)).toEqual({
			all: 6,
			exceptions: 1,
			ready: 1,
			unfulfilled: 3,
		});
		expect(tabCounts(orders, "agent-ada")).toEqual({
			all: 3,
			exceptions: 1,
			ready: 1,
			unfulfilled: 1,
		});
		expect(
			filterOrders(orders, "unfulfilled", null).map((order) => order.stage)
		).toEqual(["packing", "picking", "received"]);
		const stats = floorStats(orders, NOW);
		expect(stats.unfulfilled).toBe(3);
		expect(stats.ready).toBe(1);
		expect(stats.exceptions).toBe(1);
	});

	test("pickers work one aisle each: picking walks, packing stands at the station", () => {
		const orders = buildOrders(SNAPSHOT, NOW);
		const pickers = buildPickers(SNAPSHOT.agents, orders);
		expect(pickers.map((picker) => picker.aisle)).toEqual([0, 1, 2]);
		const [ada, grace, linus] = pickers;
		expect(ada?.pose).toBe("idle");
		expect(grace?.pose).toBe("picking");
		expect(grace?.carrying.map((order) => order.id)).toEqual(["thread-deploy"]);
		expect(linus?.pose).toBe("packing");
		// A seventh agent shares aisle A.
		const crowd = Array.from({ length: AISLE_COUNT + 1 }, (_, index) => ({
			avatarUrl: null,
			description: "",
			id: `agent-${index}`,
			name: `Agent ${index}`,
			status: "idle" as const,
		}));
		expect(buildPickers(crowd, []).at(-1)?.aisle).toBe(0);
	});

	test("a picker's route is stable and stays between the shelves", () => {
		const route = pickerRoute("agent-grace");
		expect(pickerRoute("agent-grace")).toEqual(route);
		expect(route.xs.length).toBe(route.times.length);
		expect(route.times[0]).toBe(0);
		expect(route.times.at(-1)).toBe(1);
		for (const x of route.xs) {
			expect(x).toBeGreaterThanOrEqual(RACK.x0);
			expect(x).toBeLessThanOrEqual(RACK.x1);
		}
		// Aisles sit between rows, clear of the shelving.
		expect(aisleY(0)).toBeGreaterThan(rackRowY(0) + RACK.depth);
		expect(aisleY(0)).toBeLessThan(rackRowY(1));
	});

	test("boxes land in their stage's zone, overflow is counted", () => {
		const many = Array.from({ length: READY_SLOTS.length + 2 }, (_, index) =>
			thread({ id: `ready-${index}`, updatedAt: ago(5) })
		);
		const placement = placeOrders(
			buildOrders({ ...SNAPSHOT, threads: many }, NOW)
		);
		expect(placement.ready).toHaveLength(READY_SLOTS.length);
		expect(placement.overflow.ready).toBe(2);
	});

	test("the diorama's zones count their orders and boxes sit in them", () => {
		const orders = buildOrders(SNAPSHOT, NOW);
		const pickers = buildPickers(SNAPSHOT.agents, orders);
		const placement = placeOrders(orders);
		const zones = floorZones(placement, orders);
		const total = zones
			.filter((zone) => zone.id !== "packing")
			.reduce((sum, zone) => sum + zone.count, 0);
		expect(total + placement.packing.length).toBe(
			orders.filter((order) => order.stage !== "picking").length
		);
		for (const order of orders) {
			expect(boxSpot(order.id, placement, pickers)).not.toBe(null);
		}
		const [ada, grace, linus] = pickers;
		expect(ada && pickerPose(ada, orders)).not.toBe("working");
		expect(grace && pickerPose(grace, orders)).toBe("working");
		expect(linus && pickerPose(linus, orders)).toBe("working");
	});
});

describe("warehouse renderer", () => {
	test("renders the floor, stats and an order row per thread", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			<WarehouseInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain('data-testid="interface-warehouse"');
		expect(html).toContain("Floor stats");
		expect(html.match(/data-order-row=/g)).toHaveLength(6);
		expect(html).toContain(orderNumber("thread-audit"));
		expect(html.match(/data-picker-tag=/g)).toHaveLength(3);
	});

	test("loading shows skeleton rows and no orders", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			<WarehouseInterface
				activeThreadId={null}
				loading={true}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(html).toContain("Loading orders");
		expect(html).not.toContain("data-order-row=");
		expect(html).toContain('aria-busy="true"');
	});

	test("an empty workspace explains orders and offers to create one", () => {
		const { port } = recordingPort();
		const html = renderToStaticMarkup(
			<WarehouseInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(html).toContain("No orders yet");
		expect(html).toContain("No pickers on shift");
	});

	test("tabs filter the list and announce their counts", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const tab = [...view.container.querySelectorAll('[role="tab"]')].find(
			(item) => item.textContent?.startsWith("Exceptions")
		);
		await click(tab);
		expect(tab?.getAttribute("aria-selected")).toBe("true");
		const rows = view.container.querySelectorAll("[data-order-row]");
		expect([...rows].map((row) => row.getAttribute("data-order-row"))).toEqual([
			"thread-audit",
		]);
		await view.dispose();
	});

	test("selecting an order opens its details; Fulfil opens the host thread", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(
			view.container.querySelector('[data-order-row="thread-notes"]')
		);
		const aside = view.container.querySelector("aside");
		expect(aside?.getAttribute("data-view")).toBe("detail");
		expect(aside?.textContent).toContain("Release notes");
		expect(aside?.textContent).toContain("Ready to ship");
		// The floor marks the selected box.
		expect(
			view.container
				.querySelector('[data-order-box="thread-notes"]')
				?.getAttribute("aria-current")
		).toBe("true");

		await click(button(view.container, "Fulfil"));
		expect(calls).toEqual(["open:thread-notes"]);
		expect(aside?.getAttribute("data-view")).toBe("thread");
		expect(
			view.container.querySelector('[data-testid="host-thread"]')?.textContent
		).toBe("Host thread thread-notes");

		// Escape steps back to the order, then to the list.
		await press(view.container.querySelector("h2") ?? document.body, "Escape");
		expect(calls).toEqual(["open:thread-notes", "close"]);
		expect(aside?.getAttribute("data-view")).toBe("detail");
		await press(view.container.querySelector("h2") ?? document.body, "Escape");
		expect(aside?.getAttribute("data-view")).toBe("list");
		// Focus lands back on the order's row, so the keyboard carries on.
		expect(document.activeElement?.getAttribute("data-order-row")).toBe(
			"thread-notes"
		);
		await view.dispose();
	});

	test("closing Create order returns focus to the Create order button", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(button(view.container, "Create order"));
		const heading = view.container.querySelector("h2");
		expect(document.activeElement).toBe(heading);
		await press(heading ?? document.body, "Escape");
		expect(
			view.container.querySelector("aside")?.getAttribute("data-view")
		).toBe("list");
		expect(document.activeElement?.getAttribute("aria-label")).toBe(
			"Create order"
		);
		expect(calls).toEqual([]);
		await view.dispose();
	});

	test("Create order sends only what the user typed, to the picked fulfiller", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(button(view.container, "Create order"));
		expect(
			view.container.querySelector("aside")?.getAttribute("data-view")
		).toBe("create");
		expect(calls).toEqual([]);
		const grace = [
			...view.container.querySelectorAll<HTMLInputElement>(
				'input[type="radio"]'
			),
		].find((input) => input.value === "agent-grace");
		await click(grace);
		const field = view.container.querySelector("textarea");
		if (!field) {
			throw new Error("Expected the order composer");
		}
		await typeInto(field, "  Ship the changelog  ");
		await press(field, "Enter");
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-grace", prompt: "Ship the changelog" })}`,
		]);
		await view.dispose();
	});

	test("clicking a picker filters orders to their fulfilment", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const tag = view.container.querySelector('[data-picker-tag="agent-ada"]');
		await click(tag);
		expect(tag?.getAttribute("aria-pressed")).toBe("true");
		const rows = [...view.container.querySelectorAll("[data-order-row]")].map(
			(row) => row.getAttribute("data-order-row")
		);
		expect(rows).toEqual(["thread-notes", "thread-audit", "thread-question"]);
		await click(button(view.container, "Clear fulfiller filter Ada"));
		expect(view.container.querySelectorAll("[data-order-row]")).toHaveLength(6);
		await view.dispose();
	});

	test("the fulfiller filter keeps the total and fades other boxes on the floor", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(view.container.querySelector('[data-picker-tag="agent-ada"]'));
		expect(view.container.querySelector("aside header")?.textContent).toContain(
			"3 of 6"
		);
		const faded = (id: string) => {
			const box = view.container.querySelector(`[data-order-box="${id}"]`);
			return Boolean(
				box?.matches(".opacity-30") || box?.querySelector(".opacity-30")
			);
		};
		expect(faded("thread-audit")).toBe(false);
		expect(faded("thread-hero")).toBe(true);
		await view.dispose();
	});

	test("the fulfiller picked for a new order is marked on the floor", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(button(view.container, "Create order"));
		const grace = [
			...view.container.querySelectorAll<HTMLInputElement>(
				'input[type="radio"]'
			),
		].find((input) => input.value === "agent-grace");
		await click(grace);
		expect(
			view.container
				.querySelector('[data-picker-tag="agent-grace"]')
				?.getAttribute("aria-pressed")
		).toBe("true");
		expect(
			view.container
				.querySelector('[data-picker-tag="agent-ada"]')
				?.getAttribute("aria-pressed")
		).toBe("false");
		await view.dispose();
	});

	test("the selected order is marked on the floor", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		for (const threadId of ["thread-hero", "thread-audit"]) {
			await click(
				view.container.querySelector(`[data-order-row="${threadId}"]`)
			);
			expect(
				view.container
					.querySelector(`[data-order-box="${threadId}"]`)
					?.getAttribute("aria-current")
			).toBe("true");
			await press(
				view.container.querySelector("h2") ?? document.body,
				"Escape"
			);
		}
		await view.dispose();
	});
	test("tabs and their panel are wired for assistive tech", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const panel = view.container.querySelector('[role="tabpanel"]');
		const labelledBy = panel?.getAttribute("aria-labelledby") ?? "";
		const tab = document.getElementById(labelledBy);
		expect(tab?.getAttribute("role")).toBe("tab");
		expect(tab?.getAttribute("aria-controls")).toBe(panel?.id ?? "missing");
		await view.dispose();
	});

	test("an already open thread shows inside the order panel", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-audit" />
		);
		const aside = view.container.querySelector("aside");
		expect(aside?.getAttribute("data-view")).toBe("thread");
		expect(aside?.textContent).toContain(orderNumber("thread-audit"));
		// The order's facts stay beside the conversation.
		const summary = aside?.querySelector('[aria-label="Order summary"]');
		expect(summary?.textContent).toContain("Fulfiller");
		expect(summary?.textContent).toContain("Updated");
		expect(aside?.textContent).toContain("Exception");
		// One way out: back to the order (the X is gone).
		expect(view.container.querySelector('[aria-label="Close order"]')).toBe(
			null
		);
		await click(
			button(view.container, `Back to order ${orderNumber("thread-audit")}`)
		);
		expect(calls).toEqual(["close"]);
		expect(aside?.getAttribute("data-view")).toBe("detail");
		// The failed step keeps its real name.
		expect(aside?.textContent).toContain("Picking · failed");
		await view.dispose();
	});
	test("each stat opens the tab that lists the same orders", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const stats = view.container.querySelector('[aria-label="Floor stats"]');
		// No tab lists only today's orders, so that figure is not a shortcut.
		expect(stats?.textContent).toContain("Updated today");
		const cells = [...(stats?.querySelectorAll("li") ?? [])];
		expect(cells.length).toBe(4);
		const today = cells.find((cell) =>
			cell.textContent?.startsWith("Updated today")
		);
		expect(today?.querySelector("button")).toBeNull();
		const shortcuts = [...(stats?.querySelectorAll("button") ?? [])];
		expect(shortcuts.map((item) => item.firstChild?.textContent)).toEqual([
			"Unfulfilled",
			"Ready to ship",
			"Exceptions",
		]);
		for (const shortcut of shortcuts) {
			const label = shortcut.firstChild?.textContent ?? "";
			const figure = shortcut.textContent?.replace(label, "");
			await click(shortcut);
			expect(shortcut.getAttribute("aria-pressed")).toBe("true");
			const rows = view.container.querySelectorAll("[data-order-row]");
			expect(`${label} ${rows.length}`).toBe(`${label} ${figure}`);
		}
		await view.dispose();
	});

	test("the floor pauses from the HUD", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const pause = button(view.container, "Pause");
		await click(pause);
		expect(button(view.container, "Resume")).toBeDefined();
		await view.dispose();
	});
	test("Home and End jump to the first and last order tab", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const tabs = () => [...view.container.querySelectorAll('[role="tab"]')];
		const selected = () =>
			tabs()
				.find((item) => item.getAttribute("aria-selected") === "true")
				?.textContent?.replace(/\d+$/, "");
		const tablist = view.container.querySelector('[role="tablist"]');
		if (!tablist) {
			throw new Error("Expected the order tabs");
		}
		await press(tabs()[0] ?? tablist, "End");
		expect(selected()).toBe("Exceptions");
		expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
		await press(tabs()[3] ?? tablist, "Home");
		expect(selected()).toBe("All");
		await press(tabs()[0] ?? tablist, "ArrowLeft");
		expect(selected()).toBe("Exceptions");
		await view.dispose();
	});

	test("the order timeline opens the conversation for earlier messages", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(
			view.container.querySelector('[data-order-row="thread-notes"]')
		);
		const aside = view.container.querySelector("aside");
		expect(aside?.textContent).toContain("Timeline");
		expect(aside?.textContent).toContain("Draft is ready for review.");
		await click(button(view.container, "Show 1 earlier message"));
		expect(calls).toEqual(["open:thread-notes"]);
		await view.dispose();
	});

	test("the stat for the open tab is marked pressed", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const stat = (label: string) =>
			[
				...(view.container.querySelectorAll(
					'[aria-label="Floor stats"] button'
				) ?? []),
			].find((item) => item.textContent?.startsWith(label));
		expect(stat("Exceptions")?.getAttribute("aria-pressed")).toBe("false");
		await click(stat("Exceptions"));
		expect(stat("Exceptions")?.getAttribute("aria-pressed")).toBe("true");
		// The today count has no tab of its own, so it is never a button.
		expect(stat("Updated today")).toBeUndefined();
		await view.dispose();
	});
});

describe("Warehouse useful state", () => {
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
		port: InterfacePort = fixturePort().port
	) => (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			{
				<WarehouseInterface
					activeThreadId={null}
					loading={false}
					params={{}}
					port={port}
					snapshot={snapshot}
					threadView={null}
				/>
			}
		</ActClockProvider>
	);
	/** An agent's row in the text equivalent: its control's list item. */
	const agentRow = (container: HTMLElement, name: string) => {
		const id = Object.entries(FIXTURE_AGENT_IDS).find(
			([key]) => key === name.toLowerCase()
		)?.[1];
		return container
			.querySelector(`[data-testid="warehouse-list"] [data-act-agent="${id}"]`)
			?.closest("li");
	};
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

	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const view = await mount(onFixture());
			await view.dispose();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("agent rows are described by act.ariaLabel", async () => {
		const view = await mount(onFixture());
		const ada = view.container.querySelector(
			`[data-testid="warehouse-list"] [data-act-agent="${FIXTURE_AGENT_IDS.ada}"]`
		);
		const describedBy = ada?.getAttribute("aria-describedby") ?? "";
		expect(document.getElementById(describedBy)?.textContent).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		expect(
			view.container.querySelectorAll(
				`[data-testid="warehouse-list"] [data-act-agent]`
			)
		).toHaveLength(10);
		await view.dispose();
	});

	test("Ada's agent-row Answer button opens the ask card", async () => {
		const { calls, port } = fixturePort();
		const view = await mount(onFixture(usefulStateFixture(), port));
		await pressAct(actButtons(agentRow(view.container, "Ada"), "Answer")[0]);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		await view.dispose();
	});

	test("Di's agent row has two Details buttons, the second opens the BlockerCard for Nightly backup", async () => {
		const view = await mount(onFixture());
		const details = actButtons(agentRow(view.container, "Di"), "Details");
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
			actButtons(agentRow(view.container, "Gu"), "Open answer")[0]
		);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Edited 3 files"
		);
		await view.dispose();
	});

	test("the HUD summary reads 3 need you · 2 working · 1 failed · 1 limited", async () => {
		const view = await mount(onFixture());
		expect(view.container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		await view.dispose();
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

	test("without asks the agent rows and counters are unchanged", () => {
		// The legacy renderer ages rows by the wall clock; pin it to when
		// the golden was rendered so the bytes do not drift by day.
		setSystemTime(new Date("2026-10-19T08:44:32Z"));
		try {
			const { asks: _asks, ...old } = usefulStateFixture();
			const markup = renderToStaticMarkup(onFixture(old));
			expect(markup).not.toContain("data-act-agent");
			expect(markup).not.toContain("data-act-status");
			expect(markup).not.toContain("data-ask-queue");
			expect(markup).not.toContain("data-queue-button");
			expect(markup).toContain("Day shift");
			// Today's words and counters: the legacy picker names and stages.
			expect(markup).toContain("Ada, idle, aisle A. Show their orders");
			// The stats strip's Exceptions cell still counts by the clock (4).
			// (The label leads in the DOM; the icon tile, then the figure, follow.)
			expect(
				markup.match(
					/>Exceptions<\/span><span aria-hidden="true"[^>]*>[\s\S]*?<\/span><span[^>]*>(\d+)</
				)?.[1]
			).toBe("4");
			expect(markup).not.toContain("Stopped");
			// Byte for byte the renderer as it was before the act layer
			// (warehouse-legacy.golden.html, rendered from the commit before it on
			// this snapshot). Ids and the kit's own stage attributes (data-iso-*,
			// e.g. its fit state) are normalised away in both.
			const kitFree = (html: string) =>
				html
					.replace(/_[rR]_[0-9a-zA-Z]+_/g, "ID")
					.replace(/ data-iso-[a-z-]+="[^"]*"/g, "");
			expect(kitFree(markup)).toBe(
				kitFree(
					readFileSync(
						join(import.meta.dir, "warehouse-legacy.golden.html"),
						"utf8"
					)
				)
			);
		} finally {
			setSystemTime();
		}
	});

	test("redacted: no fixture titles, routine names or targets", () => {
		const markup = renderToStaticMarkup(
			onFixture(usefulStateFixture({ privacy: "redacted" }))
		);
		for (const secret of FIXTURE_PRIVATE_STRINGS) {
			expect(markup).not.toContain(secret);
		}
	});

	test("stages follow the acts: only a read reply ships; stops count like the queue", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const orders = buildOrders(
			snapshot,
			FIXTURE_NOW,
			orderActs(snapshot, acts)
		);
		const stageOf = (id: string) =>
			orders.find((order) => order.thread.id === id)?.stage;
		const t = FIXTURE_THREAD_IDS;
		// Gu's unread answer waits at the dock; Ha's read one has shipped.
		expect(stageOf(t.gu)).toBe("ready");
		// Ada's approval and Bo's question are your turn, whether or not the
		// run is live; Fa sits out her limit; Cy and Io are at work.
		expect(
			[t.ada, t.bo, t.fa, t.cy, t.io].map((id) => [id, stageOf(id)])
		).toEqual([
			[t.ada, "ready"],
			[t.bo, "ready"],
			[t.fa, "parked"],
			[t.cy, "picking"],
			[t.io, "picking"],
		]);
		// The clipboard's Unfulfilled count is the HUD's 2 working + 1 limited.
		expect(orders.filter((order) => inTab(order, "unfulfilled")).length).toBe(
			3
		);
		// Stopped runs are the counted blockers ("3 runs stopped"); Ha's 30 h
		// old failure is a muted old failure, not an exception.
		expect(
			orders.filter((order) => order.stage === "exception").map((o) => o.id)
		).toEqual(expect.arrayContaining([t.di, t.diNightly, t.ed]));
		expect(orders.filter((order) => order.stage === "exception")).toHaveLength(
			3
		);
		expect(stageOf(t.haDigest)).toBe("stale");
		// A live run is picking, with no 2-minute packing guess.
		expect(orders.some((order) => order.stage === "packing")).toBe(false);
		// Without acts the clock still decides (back-compat).
		expect(
			buildOrders(snapshot, FIXTURE_NOW).filter(
				(order) => order.stage === "exception"
			)
		).toHaveLength(4);
	});

	test("pickers have stations, up to two an aisle; the rest are tallied", () => {
		const snapshot = usefulStateFixture();
		const pickers = buildPickers(snapshot.agents, []);
		const stations = pickerStations(pickers);
		expect(stations).toHaveLength(10);
		expect(new Set(stations.map((station) => station.id)).size).toBe(10);
		const paths = warehouseActPaths(stations);
		for (const point of [
			"you",
			"you-1",
			"you-2",
			"you-3",
			"you-4",
			"you-tray",
		]) {
			expect(paths.points[point]).toBeDefined();
		}
		// Every station walks to the dispatch queue and its desk.
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
		for (const id of [...stations.map((station) => station.id), "you-tray"]) {
			expect(reached.has(id)).toBe(true);
		}
		// A working picker's target labels its own rack, unless its work
		// bubble already says it.
		const fixtureActs = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const bare = shelfLabels(
			stations,
			fixtureActs,
			snapshot.threads,
			new Set()
		);
		expect(bare.map((label) => label.id)).toContain(
			`picker:${FIXTURE_AGENT_IDS.cy}`
		);
		expect(
			shelfLabels(
				stations,
				fixtureActs,
				snapshot.threads,
				new Set([...fixtureActs.keys()].map((agentId) => `work:${agentId}`))
			)
		).toEqual([]);
		// An 11th picker on gets no station: it is counted on the off-floor tally.
		const many = Array.from({ length: 13 }, (_, index) => ({
			...(snapshot.agents[0] as InterfaceSnapshot["agents"][number]),
			id: `agent-${index}`,
			name: `Agent ${index}`,
		}));
		expect(pickerStations(buildPickers(many, []))).toHaveLength(
			PICKER_STATIONS
		);
		const acts = agentActs(
			{ ...snapshot, agents: many, asks: [], threads: [] },
			FIXTURE_NOW,
			FIXTURE_CLOCK
		);
		const floor = floorAgents(
			acts,
			many.map((agent) => agent.id)
		);
		expect(PICKER_STATIONS).toBe(10);
		expect([floor.onStage.length, floor.offStage.count]).toEqual([10, 3]);
	});

	test("picker specs: Ada's answers her ask; Cy's keeps the order filter (15a)", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const stations = pickerStations(buildPickers(snapshot.agents, []));
		const opened: string[] = [];
		const cast = actPickers({
			acts,
			looks: new Map(
				Object.values(FIXTURE_AGENT_IDS).map((id) => [id, {} as never])
			),
			nowMs: FIXTURE_NOW,
			onAsk: (askId) => opened.push(askId),
			paths: warehouseActPaths(stations),
			reduced: true,
			shown: new Set(),
			slots: youSpotSlots(acts, unownedAsks(snapshot)).slots,
			stations,
		});
		const ada = cast.find((spec) => spec.actAgent === FIXTURE_AGENT_IDS.ada);
		expect(ada?.label).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run. Answer their ask."
		);
		// `activate` replaces onSelect for an asking picker (the kit drops
		// aria-pressed for it; the browser check S17 walks the Tab stops).
		ada?.activate?.();
		expect(opened).toEqual([FIXTURE_ASK_IDS.adaToolCall]);
		expect(ada?.youSpot).toBe("slot");
		const cy = cast.find((spec) => spec.actAgent === FIXTURE_AGENT_IDS.cy);
		expect(cy?.activate).toBeUndefined();
		expect(cy?.label).toBe(
			`${acts.get(FIXTURE_AGENT_IDS.cy)?.ariaLabel} Show their orders.`
		);
		// The rendered plates are clicked in warehouse-plates.test.tsx.
	});

	test("neighbouring aisles' pickers never share a screen column", () => {
		const snapshot = usefulStateFixture();
		const stations = pickerStations(buildPickers(snapshot.agents, []));
		// The isometric screen column is x − y (tiles); a name plate is about
		// 1.7 tiles wide on the 1280 stage.
		const column = (tile: { x: number; y: number }) => tile.x - tile.y;
		const shared: string[] = [];
		for (const a of stations) {
			for (const b of stations) {
				if (
					b.aisle === a.aisle + 1 &&
					Math.abs(column(a.tile) - column(b.tile)) < 1.45
				) {
					shared.push(`${a.agentId}/${b.agentId}`);
				}
			}
		}
		expect(shared).toEqual([]);
		// The two pickers of an aisle stand well apart along it.
		for (const a of stations) {
			const mate = stations.find(
				(b) => b.aisle === a.aisle && b.agentId !== a.agentId
			);
			if (mate) {
				expect(Math.abs(mate.tile.x - a.tile.x)).toBeGreaterThan(2);
			}
		}
	});

	test("the cage's reason tag reads like the alarm, within the budget", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const shown = new Set([CAGE_REASON_ID]);
		const wide = { iconOnly: false, shown };
		const reason = cageReason(snapshot, acts, wide);
		expect(reason).toBeTruthy();
		// A phone stage, or a budget that left it out, shows no tag.
		expect(cageReason(snapshot, acts, { iconOnly: true, shown })).toBeNull();
		expect(
			cageReason(snapshot, acts, { iconOnly: false, shown: new Set() })
		).toBeNull();
		const estimated = (base: InterfaceSnapshot): InterfaceSnapshot => ({
			...base,
			threads: base.threads.map((thread) =>
				thread.blocker
					? {
							...thread,
							blocker: { ...thread.blocker, source: "estimate" as const },
						}
					: thread
			),
		});
		const redacted = usefulStateFixture({ privacy: "redacted" });
		const words = (base: InterfaceSnapshot) =>
			cageReason(base, agentActs(base, FIXTURE_NOW, FIXTURE_CLOCK), wide);
		const redactedReason = words(redacted);
		expect(redactedReason).toBe("Failed");
		for (const secret of FIXTURE_PRIVATE_STRINGS) {
			expect(redactedReason ?? "").not.toContain(secret);
		}
		// An estimated stop reads "Likely …", as its alarm plate does, in
		// the kind's word when redacted.
		expect(words(estimated(snapshot))).toBe(`Likely ${reason}`);
		expect(words(estimated(redacted))).toBe("Likely Failed");
	});

	test("the off-stage tally stands on the open yard, clear of the truck", () => {
		const toTile = ([x, , z]: readonly number[]) => ({
			x: (x ?? 0) / TILE + FLOOR.width / 2,
			y: (z ?? 0) / TILE + FLOOR.depth / 2,
		});
		for (const narrow of [false, true]) {
			const layout = dispatchLayout(narrow);
			for (const at of [layout.offStage, layout.tally]) {
				const tile = toTile(at);
				// Not on the trailer or cab (tiles x 17.5–22.2, y 8.6–10.4).
				const onTruck =
					tile.x > 17.4 && tile.x < 22.3 && tile.y > 8.5 && tile.y < 10.5;
				expect(onTruck).toBe(false);
			}
		}
	});

	test("overlay budget: exempt targets stay focusable, icon-only when narrow (21)", () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const { offStage, onStage } = floorAgents(
			acts,
			snapshot.agents.map((agent) => agent.id)
		);
		const slots = youSpotSlots(
			acts,
			unownedAsks(snapshot),
			onStage.map((act) => act.agentId)
		);
		// As the interface weighs them: the floor's own width (at 1280 the
		// clipboard covers 561 px) and the first working picker featured.
		const items = actOverlays(
			onStage,
			slots,
			offStage,
			onStage.find((act) => act.act === "working")?.agentId ?? null
		);
		const wide = overlayBudget(1280 - 561, { domTargets: true });
		const narrow = overlayBudget(390, { domTargets: true });
		const wideShown = wide.fill(items);
		const shown = narrow.fill(items);
		// A phone keeps Fa's limit and the station words of both workers; the
		// floor at 1280 also keeps both work bubbles and the queue's bubbles.
		const ids = FIXTURE_AGENT_IDS;
		expect(
			[`limit:${ids.fa}`, `progress:${ids.cy}`, `progress:${ids.io}`].filter(
				(id) => !shown.has(id)
			)
		).toEqual([]);
		expect(
			[
				`work:${ids.cy}`,
				`work:${ids.io}`,
				`next:${ids.cy}`,
				`elapsed:${ids.cy}`,
			].filter((id) => !wideShown.has(id))
		).toEqual([]);
		// The kit's caps: 16 overlays on a wide floor, 8 on a phone, and no
		// queue bubbles on a phone (its queue plates carry the asks).
		expect(wideShown.size).toBeLessThanOrEqual(16);
		expect(shown.size).toBeLessThanOrEqual(8);
		expect([...shown].some((id) => id.startsWith("ask:"))).toBe(false);
		// Exempt targets stay focusable, and go icon-only on the phone.
		expect(wide.focusable && narrow.focusable).toBe(true);
		expect([wide.iconOnly, narrow.iconOnly]).toEqual([false, true]);
	});

	test("the limit reads in the warehouse's words", () => {
		const acts = agentActs(usefulStateFixture(), FIXTURE_NOW, FIXTURE_CLOCK);
		const fa = acts.get(FIXTURE_AGENT_IDS.fa);
		const words = (act: typeof fa) =>
			act &&
			limitWords(act, {
				clock: FIXTURE_CLOCK,
				limitText: forkliftLimit,
				nowMs: FIXTURE_NOW,
			});
		expect(words(fa)).toBe("Back 15:10");
		// An inferred limit with no reset time: the kit's "Likely " reads on.
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
		expect(words(guessed)).toBe("Likely parked for now");
	});

	test("the clipboard reads the acts: Stopped, no ages", async () => {
		const view = await mount(onFixture());
		const text = view.container.textContent ?? "";
		expect(text).toContain("Stopped");
		expect(text).not.toContain("Exceptions");
		expect(
			view.container.querySelector("th")?.parentElement?.textContent
		).not.toContain("Age");
		await view.dispose();
	});
});

describe("Warehouse settings", () => {
	test("default to the theme's shift and a running floor; junk falls back", () => {
		expect(resolveInterfaceParams("warehouse", {})).toMatchObject({
			paused: false,
			shift: "theme",
		});
		expect(
			resolveInterfaceParams("warehouse", { paused: "yes", shift: "dusk" })
		).toMatchObject({ paused: false, shift: "theme" });
	});

	test("the shift follows the theme, or holds day or night", () => {
		expect(warehouseSettings({ shift: "night" }).shift).toBe("night");
		expect(warehouseNight("theme", true)).toBe(true);
		expect(warehouseNight("theme", false)).toBe(false);
		expect(warehouseNight("day", true)).toBe(false);
		expect(warehouseNight("night", false)).toBe(true);
	});

	test("pause is a setting: from params, saved from the HUD, live from Settings", async () => {
		const saved: Record<string, unknown>[] = [];
		const port: InterfacePort = {
			...recordingPort().port,
			updateSettings: (patch) => saved.push(patch),
		};
		const element = (params: { paused?: boolean }) => (
			<WarehouseInterface
				activeThreadId={null}
				loading={false}
				params={params}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(element({})));
		await click(button(container, "Pause"));
		expect(saved).toEqual([{ paused: true }]);
		expect(button(container, "Resume")).toBeDefined();
		// Settings turning it back off resumes the floor.
		await act(async () => root.render(element({ paused: false })));
		await act(async () => root.render(element({ paused: true })));
		expect(button(container, "Resume")).toBeDefined();
		await act(async () => root.render(element({ paused: false })));
		expect(button(container, "Pause")).toBeDefined();
		await act(async () => root.unmount());
		container.remove();
	});
});
