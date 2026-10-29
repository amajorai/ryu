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
import type {
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { chefPoseOf } from "./kitchen-diorama.tsx";
import { DishGlyph, dishFood, dishKind } from "./kitchen-dish.tsx";
import { hudDensity, hudInsets, ServiceScore } from "./kitchen-hud.tsx";
import { KitchenInterface } from "./kitchen-interface.tsx";
import {
	buildService,
	chefOrders,
	compareTickets,
	cookProgress,
	cycleIndex,
	DEFAULT_RUN_MS,
	kitchenFloor,
	median,
	PASS_SLOTS,
	READY_PATIENCE_MS,
	readyPatience,
	STATIONS_PER_ROW,
	spokenAge,
	stationSpots,
	ticketLabel,
	ticketTimer,
	typicalRunMs,
} from "./kitchen-model.ts";
import {
	brigadeColors,
	chefColors,
	cssRgb,
	EMPTY_THEME,
	hashId,
	kitchenPalette,
	pickById,
	statusColors,
} from "./kitchen-palette.ts";

const MINUTE = 60_000;
// servedToday buckets by local calendar day, so a fixture built from the live
// clock loses threads to yesterday just after midnight. Every test runs at one
// fixed local mid-day instant instead.
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();
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

const EVENTS: InterfaceEvent[] = [
	{
		agentId: "agent-grace",
		end: new Date(NOW - 100 * MINUTE).toISOString(),
		id: "run-1",
		kind: "past",
		label: "Daily",
		outcome: "success",
		start: new Date(NOW - 110 * MINUTE).toISOString(),
		title: "Triage",
	},
	{
		agentId: "agent-grace",
		end: new Date(NOW - 50 * MINUTE).toISOString(),
		id: "run-2",
		kind: "past",
		label: "Daily",
		outcome: "success",
		start: new Date(NOW - 56 * MINUTE).toISOString(),
		title: "Triage",
	},
	{
		agentId: "agent-grace",
		id: "run-next",
		kind: "upcoming",
		label: "Daily",
		start: new Date(NOW + 60 * MINUTE).toISOString(),
		title: "Triage",
	},
];

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
	events: EVENTS,
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			running: true,
			title: "Flaky test",
			updatedAt: ago(2),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-crash",
			runState: "failed",
			title: "Crash triage",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(10),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-older",
			title: "Older reply",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-asked",
			lastMessageRole: "user",
			title: "Question for Linus",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-quiet",
			lastMessageRole: null,
			title: "Old notes",
			updatedAt: ago(60 * 24 * 3),
		}),
	],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// happy-dom has no Web Animations; the panel's scroll area asks for them.
if (!("getAnimations" in Element.prototype)) {
	Reflect.set(Element.prototype, "getAnimations", () => []);
}
beforeEach(() => {
	setSystemTime(new Date(NOW));
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

function buttonNamed(container: HTMLElement, name: string | RegExp) {
	return [...container.querySelectorAll("button")].find((candidate) => {
		const label =
			candidate.getAttribute("aria-label") ??
			candidate.textContent?.trim() ??
			"";
		return typeof name === "string" ? label === name : name.test(label);
	});
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

function props(
	overrides: Partial<Parameters<typeof KitchenInterface>[0]> = {}
) {
	return {
		activeThreadId: null,
		loading: false,
		params: {},
		port: recordingPort().port,
		snapshot: SNAPSHOT,
		threadView: null,
		...overrides,
	};
}

describe("kitchen model", () => {
	test("threads become tickets: ready, then burnt, then cooking, then waiting", () => {
		const service = buildService(SNAPSHOT, NOW);
		expect(service.rail.map((ticket) => [ticket.id, ticket.state])).toEqual([
			// Oldest first within a state, like a ticket rail.
			["thread-older", "ready"],
			["thread-notes", "ready"],
			["thread-crash", "burnt"],
			["thread-flaky", "cooking"],
			["thread-asked", "queued"],
		]);
		// Quiet threads are served: off the rail, still in the chef's history.
		expect(service.rail.some((ticket) => ticket.id === "thread-quiet")).toBe(
			false
		);
		expect(service.totals).toEqual({
			burnt: 1,
			cooking: 1,
			queued: 1,
			ready: 2,
			servedToday: 2,
		});
		const [first, second] = service.rail;
		if (first && second) {
			expect(compareTickets(first, second)).toBeLessThan(0);
		}
	});

	test("each agent is a chef at a station; a running thread starts their clock", () => {
		const service = buildService(SNAPSHOT, NOW);
		const grace = service.stations.find(
			(station) => station.agent.id === "agent-grace"
		);
		expect(grace?.working).toBe(true);
		expect(grace?.burnt).toBe(true);
		expect(grace?.runStartedAt).toBe(Date.parse(ago(2)));
		expect(grace?.typicalFromHistory).toBe(true);
		const ada = service.stations.find(
			(station) => station.agent.id === "agent-ada"
		);
		expect(ada?.working).toBe(false);
		expect(ada?.orders.map((order) => order.id)).toEqual([
			"thread-older",
			"thread-notes",
		]);
		expect(service.stations.map((station) => station.kind)).toEqual([
			"stove",
			"board",
			"grill",
		]);
		// Ready orders are dishes on the pass.
		expect(service.dishes.map((dish) => dish.ticket.id)).toEqual([
			"thread-older",
			"thread-notes",
		]);
		expect(service.dishOverflow).toBe(0);
	});

	test("the usual run time is the median of finished runs, else a default", () => {
		expect(median([])).toBeNull();
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		const grace = typicalRunMs("agent-grace", EVENTS);
		expect(grace).toEqual({ fromHistory: true, ms: 8 * MINUTE });
		expect(typicalRunMs("agent-ada", EVENTS)).toEqual({
			fromHistory: false,
			ms: DEFAULT_RUN_MS,
		});
		expect(typicalRunMs("agent-ada", undefined).ms).toBe(DEFAULT_RUN_MS);
	});

	test("cooking progress is time since the run started over the usual time", () => {
		expect(cookProgress(null, MINUTE, NOW)).toEqual({
			fraction: 0,
			over: false,
		});
		expect(cookProgress(NOW - MINUTE, 4 * MINUTE, NOW)).toEqual({
			fraction: 0.25,
			over: false,
		});
		expect(cookProgress(NOW - 9 * MINUTE, 4 * MINUTE, NOW)).toEqual({
			fraction: 1,
			over: true,
		});
	});

	test("cooking tickets run a live timer; the rest show a compact age", () => {
		expect(ticketTimer(NOW - 65_000, NOW, true)).toBe("1:05");
		expect(ticketTimer(NOW - 59 * MINUTE, NOW, true)).toBe("59:00");
		expect(ticketTimer(NOW - 62 * MINUTE - 5000, NOW, true)).toBe("1:02:05");
		expect(ticketTimer(NOW - 20_000, NOW)).toBe("now");
		expect(ticketTimer(NOW - 42 * MINUTE, NOW)).toBe("42m");
		expect(ticketTimer(NOW - 3 * 60 * MINUTE, NOW)).toBe("3h");
		expect(ticketTimer(NOW - 2 * 24 * 60 * MINUTE, NOW)).toBe("2d");
		expect(ticketTimer(NOW - 15 * 24 * 60 * MINUTE, NOW)).toBe("2w");
		expect(ticketTimer(0, NOW)).toBe("");
		expect(spokenAge(NOW - 3 * MINUTE, NOW)).toBe("updated 3 minutes ago");
		const ticket = buildService(SNAPSHOT, NOW).rail.find(
			(item) => item.id === "thread-crash"
		);
		if (ticket) {
			expect(ticketLabel(ticket, NOW)).toBe(
				"Crash triage: Burnt, Grace, updated 30 minutes ago"
			);
		}
	});

	test("stations fill counter lines of four, centred, back line first", () => {
		const spots = stationSpots(6);
		expect(spots.filter((spot) => spot.row === 0)).toHaveLength(
			STATIONS_PER_ROW
		);
		expect(spots.filter((spot) => spot.row === 1)).toHaveLength(2);
		const back = spots.filter((spot) => spot.row === 0);
		expect((back[0]?.x ?? 0) + (back.at(-1)?.x ?? 0)).toBeCloseTo(0, 5);
		expect(spots[4]?.z ?? 0).toBeGreaterThan(spots[0]?.z ?? 0);
		const floor = kitchenFloor(6);
		// The pass sits in front of the front line.
		expect(floor.pass.z).toBeGreaterThan(spots[5]?.z ?? 0);
		expect(floor.pass.length).toBeLessThan(floor.width);
	});

	test("a phone-shaped stage gets shorter lines and a taller room", () => {
		const wide = kitchenFloor(6);
		const tall = kitchenFloor(6, 2);
		expect(wide.width).toBeGreaterThan(wide.depth);
		expect(tall.depth).toBeGreaterThan(tall.width);
		const spots = stationSpots(6, 2);
		expect(new Set(spots.map((spot) => spot.row)).size).toBe(3);
		const service = buildService(SNAPSHOT, NOW, 2);
		expect(service.floor).toEqual(kitchenFloor(SNAPSHOT.agents.length, 2));
		// Every dish still fits on the shorter pass.
		for (const dish of service.dishes) {
			expect(Math.abs(dish.x)).toBeLessThan(tall.pass.length / 2);
		}
	});

	test("a ticket and its plate pick the same dish", () => {
		const palette = kitchenPalette(EMPTY_THEME);
		const kinds = new Set(
			["a", "b", "c", "d", "e", "f", "g"].map((id) => dishKind(id))
		);
		expect(kinds.size).toBeGreaterThan(1);
		expect(dishKind("thread-hero")).toBe(dishKind("thread-hero"));
		expect(dishFood(palette, "thread-hero")).toBe(
			dishFood(palette, "thread-hero")
		);
		const glyph = renderToStaticMarkup(
			<DishGlyph id="thread-hero" palette={palette} />
		);
		expect(glyph).toContain("stroke-success");
		expect(glyph).toContain(dishFood(palette, "thread-hero"));
	});

	test("more ready orders than the pass holds overflow into a count", () => {
		const many = Array.from({ length: PASS_SLOTS + 3 }, (_, index) =>
			thread({
				agentIds: ["agent-ada"],
				id: `ready-${index}`,
				updatedAt: ago(index),
			})
		);
		const service = buildService({ ...SNAPSHOT, threads: many }, NOW);
		expect(service.dishes).toHaveLength(PASS_SLOTS);
		expect(service.dishOverflow).toBe(3);
	});

	test("a chef's tickets list open orders first, then served by recency", () => {
		expect(
			chefOrders(SNAPSHOT, "agent-ada").map((ticket) => ticket.id)
		).toEqual(["thread-older", "thread-notes", "thread-quiet"]);
		expect(cycleIndex(3, 2, 1)).toBe(0);
		expect(cycleIndex(3, 0, -1)).toBe(2);
		expect(cycleIndex(0, 0, 1)).toBe(-1);
	});

	test("palette and looks follow the theme and the id alone", () => {
		expect(kitchenPalette(EMPTY_THEME).mode).toBe("light");
		const evening = kitchenPalette({ ...EMPTY_THEME, darkClass: true });
		expect(evening.mode).toBe("dark");
		expect(evening.lampIntensity).toBeGreaterThan(0);
		const themed = kitchenPalette({
			...EMPTY_THEME,
			background: [16, 16, 20],
			success: [10, 180, 90],
		});
		expect(themed.mode).toBe("dark");
		expect(themed.status.ready).toBe(cssRgb([10, 180, 90]));
		expect(evening.smoke).not.toBe(kitchenPalette(EMPTY_THEME).smoke);
		expect(hashId("agent-ada")).toBe(hashId("agent-ada"));
		expect(pickById(["a", "b", "c"], "agent-ada")).toBe(
			pickById(["a", "b", "c"], "agent-ada")
		);
		expect(pickById([], "agent-ada")).toBeUndefined();
	});

	test("status colours stay distinct even when the theme's collide", () => {
		const status = statusColors({
			...EMPTY_THEME,
			destructive: [220, 60, 60],
			success: [40, 170, 90],
			warning: [44, 172, 92],
		});
		expect(status.ready).toEqual([40, 170, 90]);
		expect(status.cooking).not.toEqual(status.ready);
		const fallback = statusColors(EMPTY_THEME);
		expect(new Set(Object.values(fallback).map(String)).size).toBe(3);
	});

	test("every chef in a brigade wears a different jacket", () => {
		const ids = ["atlas", "brook", "cipher", "delta", "echo", "forge"];
		const slots = brigadeColors(ids);
		expect(new Set(slots.values()).size).toBe(ids.length);
		expect(brigadeColors(ids)).toEqual(slots);
		expect(chefColors(slots.get("atlas") ?? 0)).toBe(
			chefColors(slots.get("atlas") ?? 0)
		);
	});

	test("a chef's pose follows their station: cooking, burnt, ready, waiting", () => {
		const service = buildService(SNAPSHOT, NOW);
		expect(service.stations.length).toBeGreaterThan(0);
		for (const station of service.stations) {
			const pose = chefPoseOf(station);
			if (station.burnt) {
				expect(pose).toBe("failed");
			} else if (station.working) {
				expect(pose).toBe("working");
			} else if (station.orders.some((order) => order.state === "ready")) {
				expect(pose).toBe("needs-you");
			} else {
				expect(["idle", "waiting"]).toContain(pose);
			}
		}
	});
});

describe("kitchen hud insets", () => {
	test("a narrow stage budgets the title's wrapped act summary", () => {
		const plain = hudInsets("narrow");
		const withActs = hudInsets("narrow", true);
		// Two status lines instead of one: 61px against 46.08px.
		expect(withActs.top - plain.top).toBeCloseTo(61 - 46.08);
		expect(hudInsets("wide", true)).toEqual(hudInsets("wide"));
	});
});

describe("kitchen interface", () => {
	test("the service clock setting: on by default, off when set, live from Settings", async () => {
		const clock = (container: HTMLElement) =>
			container.querySelector('[aria-label="Service clock"]');
		const view = await mount(<KitchenInterface {...props()} />);
		expect(clock(view.container)).not.toBeNull();
		await view.rerender(
			<KitchenInterface {...props({ params: { serviceClock: false } })} />
		);
		expect(clock(view.container)).toBeNull();
		await view.rerender(
			<KitchenInterface {...props({ params: { serviceClock: true } })} />
		);
		expect(clock(view.container)).not.toBeNull();
		await view.dispose();
	});

	test("renders the rail, the score and the clock without a 3D context", () => {
		const markup = renderToStaticMarkup(<KitchenInterface {...props()} />);
		expect(markup).toContain('data-testid="interface-kitchen"');
		expect(markup).toContain('aria-label="Order rail"');
		expect(markup).toContain("Crash triage");
		expect(markup).toContain("Ready to serve");
		expect(markup).toContain("Served today");
		expect(markup).toContain("Service clock");
		expect(markup).toContain("New order");
		// The estimate note lives on the Cooking label, not after the number.
		expect(markup).not.toContain("rings are estimates");
		expect(markup).toContain("Rings estimate each run");
		// State words are foreground (AA on a light card); colour is the mark's.
		expect(markup).not.toContain("text-success");
		// A ready ticket shows its dish, matching its plate on the pass.
		expect(markup).toMatch(/data-state="ready"[\s\S]*?stroke-success/);
		expect(markup).toContain('aria-label="Tickets"');
	});

	test("the HUD switches with the room it has, not the viewport", () => {
		expect(hudDensity(390)).toBe("narrow");
		expect(hudDensity(639)).toBe("narrow");
		expect(hudDensity(640)).toBe("medium");
		expect(hudDensity(1099)).toBe("medium");
		expect(hudDensity(1100)).toBe("wide");
		const narrow = renderToStaticMarkup(
			<ServiceScore density="narrow" service={buildService(SNAPSHOT, NOW)} />
		);
		expect(narrow).toContain(">Served<");
		expect(narrow).not.toContain("Served today");
		const medium = renderToStaticMarkup(
			<ServiceScore density="medium" service={buildService(SNAPSHOT, NOW)} />
		);
		expect(medium).toContain("Served today");
		expect(medium).toContain("Rings estimate each run");
		expect(medium).not.toContain("est.");
	});

	test("a ready ticket's patience drains while it waits on you", () => {
		expect(readyPatience(NOW, NOW)).toBe(1);
		expect(readyPatience(NOW - READY_PATIENCE_MS / 2, NOW)).toBeCloseTo(0.5);
		expect(readyPatience(NOW - READY_PATIENCE_MS * 2, NOW)).toBe(0);
		expect(readyPatience(0, NOW)).toBe(0);
	});

	test("loading shows skeleton tickets; an empty kitchen invites a first conversation", () => {
		const loading = renderToStaticMarkup(
			<KitchenInterface {...props({ loading: true })} />
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain("Setting up the kitchen");
		expect(loading).not.toContain("Crash triage");
		const empty = renderToStaticMarkup(
			<KitchenInterface
				{...props({ snapshot: { ...SNAPSHOT, agents: [], threads: [] } })}
			/>
		);
		expect(empty).toContain("No chefs on the line");
		expect(empty).not.toContain("No open orders");
		expect(empty).toContain("Add an agent to staff a station");
		expect(empty).not.toContain("Served today");
		const unstaffed = renderToStaticMarkup(
			<KitchenInterface {...props({ snapshot: { ...SNAPSHOT, agents: [] } })} />
		);
		expect(unstaffed).toContain("These orders have no agent to cook them");
	});

	test("serving a ticket opens the thread; the host view shows in the panel", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<KitchenInterface {...props({ port })} />);
		await click(buttonNamed(view.container, /^Release notes: Ready/));
		expect(calls).toEqual(["open:thread-notes"]);
		await view.rerender(
			<KitchenInterface
				{...props({
					activeThreadId: "thread-notes",
					port,
					threadView: <div data-testid="host-thread">Host chat</div>,
				})}
			/>
		);
		const panel = view.container.querySelector("[data-kitchen-panel]");
		expect(panel?.querySelector("[data-testid='host-thread']")).not.toBeNull();
		expect(panel?.querySelector("h2")?.textContent).toBe("Release notes");
		expect(
			view.container
				.querySelector("[aria-current='true']")
				?.getAttribute("aria-label")
		).toMatch(/^Release notes/);
		// Opened from the rail: Close only, no back arrow.
		expect(buttonNamed(view.container, "Back to Ada")).toBeUndefined();
		await click(buttonNamed(view.container, "Close order"));
		expect(calls).toEqual(["open:thread-notes", "close"]);
		await view.dispose();
	});

	test("a ticket opened from a chef's pane leads back to that chef", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<KitchenInterface {...props({ port })} />);
		const line = view.container.querySelector("[aria-label='The line']");
		await click(
			[...(line?.querySelectorAll("button") ?? [])].find((candidate) =>
				candidate.textContent?.includes("Ada")
			)
		);
		const chefPanel = view.container.querySelector("[data-kitchen-panel]");
		if (!(chefPanel instanceof HTMLElement)) {
			throw new Error("Expected the chef panel");
		}
		await click(buttonNamed(chefPanel, /^Release notes: Ready/));
		await view.rerender(
			<KitchenInterface
				{...props({
					activeThreadId: "thread-notes",
					port,
					threadView: <div data-testid="host-thread">Host chat</div>,
				})}
			/>
		);
		await click(buttonNamed(view.container, "Back to Ada"));
		expect(calls).toEqual(["open:thread-notes", "close"]);
		await view.dispose();
	});

	test("without WebGL the line lists chefs; a chef opens their tickets and takes orders", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<KitchenInterface {...props({ port })} />);
		const line = view.container.querySelector("[aria-label='The line']");
		expect(line?.textContent).toContain("Grace");
		expect(line?.textContent).toContain("estimate");
		await click(
			[...(line?.querySelectorAll("button") ?? [])].find((candidate) =>
				candidate.textContent?.includes("Ada")
			)
		);
		const panel = view.container.querySelector("[data-kitchen-panel]");
		expect(panel?.getAttribute("aria-label")).toBe("Chef Ada");
		expect(document.activeElement?.textContent).toBe("Ada");
		expect(panel?.textContent).toContain("Open orders2");
		expect(panel?.textContent).toContain("Served1");
		const field = panel?.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("Expected the composer");
		}
		await typeInto(field, "   ");
		await press(field, "Enter");
		await typeInto(field, "  Write the 2.5 notes ");
		await press(field, "Enter");
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Write the 2.5 notes" })}`,
		]);
		await view.dispose();
	});

	test("New order picks a chef first; Escape closes the panel", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(<KitchenInterface {...props({ port })} />);
		await click(buttonNamed(view.container, "New order"));
		const panel = view.container.querySelector("[data-kitchen-panel]");
		expect(panel?.getAttribute("aria-label")).toBe("New order");
		// The line is the picker: one pressed chef, no second dropdown.
		expect(panel?.querySelector("select")).toBeNull();
		const rows = [...(panel?.querySelectorAll("button[aria-pressed]") ?? [])];
		expect(rows.length).toBe(3);
		expect(
			rows.filter((row) => row.getAttribute("aria-pressed") === "true").length
		).toBe(1);
		await click(rows.find((row) => row.textContent?.includes("Linus")));
		expect(
			panel?.querySelector("button[aria-pressed='true']")?.textContent
		).toContain("Linus");
		expect(panel?.querySelector("textarea")?.getAttribute("placeholder")).toBe(
			"Describe a task for Linus"
		);
		// Nothing is sent until the user types and submits.
		expect(calls).toEqual([]);
		const field = panel?.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("Expected the composer");
		}
		await typeInto(field, "Check the queue");
		await press(field, "Enter");
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-linus", prompt: "Check the queue" })}`,
		]);
		// Placing the order shows that chef's sheet; Escape closes it.
		const heading = view.container.querySelector("[data-kitchen-panel] h2");
		if (!(heading instanceof HTMLElement)) {
			throw new Error("Expected the panel heading");
		}
		await press(heading, "Escape");
		expect(view.container.querySelector("[data-kitchen-panel]")).toBeNull();
		await view.dispose();
	});

	test("a host page over the kitchen keeps its Escape", async () => {
		const view = await mount(<KitchenInterface {...props()} />);
		await click(buttonNamed(view.container, "New order"));
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the kitchen it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "Escape");
		expect(view.container.querySelector("[data-kitchen-panel]")).not.toBeNull();
		view.container.removeAttribute("inert");
		await press(document.body, "Escape");
		expect(view.container.querySelector("[data-kitchen-panel]")).toBeNull();
		await view.dispose();
	});

	test("arrow keys move along the rail", async () => {
		const view = await mount(<KitchenInterface {...props()} />);
		const rail = view.container.querySelector("[aria-label='Order rail'] ol");
		const tickets = [...(rail?.querySelectorAll("button") ?? [])];
		const first = tickets[0];
		if (!first) {
			throw new Error("Expected tickets");
		}
		await act(async () => first.focus());
		await press(first, "ArrowRight");
		expect(document.activeElement).toBe(tickets[1] ?? null);
		await press(tickets[1] ?? first, "End");
		expect(document.activeElement).toBe(tickets.at(-1) ?? null);
		await press(tickets.at(-1) ?? first, "Home");
		expect(document.activeElement).toBe(first);
		await view.dispose();
	});
});
