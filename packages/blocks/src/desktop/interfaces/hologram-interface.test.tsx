import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { HologramInterface } from "./hologram-interface.tsx";
import {
	agentThreads,
	briefing,
	buildHologram,
	corePulse,
	countdown,
	elapsedClock,
	greeting,
	normalizeAngle,
	parseCommand,
	polar,
	radialMenuLayout,
	ringSlots,
	shortCadence,
} from "./hologram-model.ts";
import { labelKeepOut, orbitGeometry } from "./hologram-orbit.tsx";
import { HOLO_MODE, HOLO_TOKEN_NAMES, HOLO_VARS } from "./hologram-palette.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The deck reads the real clock, so the fixture is anchored to it. */
const BASE = Math.floor(Date.now() / MINUTE) * MINUTE;
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();
const ahead = (hours: number) => new Date(BASE + hours * HOUR).toISOString();

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
	events: [
		{
			agentId: "agent-ada",
			end: ago(200),
			id: "event-past",
			kind: "past",
			label: "Daily at 9 AM",
			outcome: "success",
			start: ago(210),
			title: "Morning digest",
		},
		{
			agentId: "agent-grace",
			count: 24,
			id: "event-sweep",
			kind: "upcoming",
			label: "Every hour",
			start: ahead(1),
			title: "Inbox sweep",
		},
		{
			agentId: "agent-ada",
			id: "event-weekly",
			kind: "upcoming",
			label: "Fridays at 5 PM",
			start: ahead(72),
			title: "Weekly digest",
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
			title: "Loose ends",
			updatedAt: ago(600),
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

async function press(target: Element | Document, key: string) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
}

async function typeInto(field: HTMLInputElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

async function submit(form: HTMLFormElement | null) {
	if (!form) {
		throw new Error("Expected the command form");
	}
	await act(async () => {
		form.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
	});
}

function byLabel(container: HTMLElement, label: string) {
	return container.querySelector(`[aria-label="${label}"]`);
}

function menuItem(container: HTMLElement, label: string) {
	return [...container.querySelectorAll('[role="menuitem"]')].find(
		(item) => item.textContent === label
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

/** The orbit only places nodes once it has measured a box; give it one. */
function sizedBoxes() {
	const width = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"clientWidth"
	);
	const height = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"clientHeight"
	);
	Object.defineProperty(HTMLElement.prototype, "clientWidth", {
		configurable: true,
		get: () => 900,
	});
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => 700,
	});
	return () => {
		if (width) {
			Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
		}
		if (height) {
			Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
		}
	};
}

function hologram(
	port: InterfacePort,
	options: {
		activeThreadId?: string | null;
		loading?: boolean;
		snapshot?: InterfaceSnapshot;
		threadView?: ReactElement | null;
	} = {}
) {
	return (
		<HologramInterface
			activeThreadId={options.activeThreadId ?? null}
			loading={options.loading ?? false}
			params={{}}
			port={port}
			snapshot={options.snapshot ?? SNAPSHOT}
			threadView={options.threadView ?? null}
		/>
	);
}

describe("hologram model", () => {
	test("counts statuses, working agents and runs in the next day", () => {
		const view = buildHologram(SNAPSHOT, BASE);
		expect(view.totals).toEqual({
			agents: 3,
			attention: 1,
			quiet: 0,
			threads: 5,
			upcoming24h: 24,
			waiting: 2,
			working: 1,
			workingAgents: 1,
			yourTurn: 1,
		});
		expect(view.schedule.map((event) => event.id)).toEqual([
			"event-sweep",
			"event-weekly",
		]);
	});

	test("puts failed runs before replies, and live runs in operations", () => {
		const view = buildHologram(SNAPSHOT, BASE);
		expect(view.priority.map((item) => item.id)).toEqual([
			"thread-flaky",
			"thread-notes",
		]);
		expect(view.working.map((item) => item.id)).toEqual(["thread-triage"]);
	});

	test("summarises each agent for its node", () => {
		const view = buildHologram(SNAPSHOT, BASE);
		const grace = view.agents.find((agent) => agent.id === "agent-grace");
		expect(grace).toMatchObject({
			failed: 1,
			initials: "G",
			latestThreadId: "thread-triage",
			needsYou: 1,
			threadCount: 2,
			workingThreads: 1,
		});
		const linus = view.agents.find((agent) => agent.id === "agent-linus");
		expect(linus?.latestThreadId).toBeNull();
		expect(view.maxThreads).toBe(2);
	});

	test("lists one agent's threads by priority", () => {
		expect(
			agentThreads(SNAPSHOT, "agent-grace").map((item) => item.id)
		).toEqual(["thread-flaky", "thread-triage"]);
	});

	test("writes the briefing from real counts and the hour", () => {
		const { totals } = buildHologram(SNAPSHOT, BASE);
		expect(briefing(totals, 19)).toBe(
			"Good evening. 1 agent working, 2 items need your attention."
		);
		expect(
			briefing({ ...totals, attention: 0, workingAgents: 0, yourTurn: 0 }, 8)
		).toBe("Good morning. No agents working, nothing needs your attention.");
		expect(briefing({ ...totals, attention: 1, yourTurn: 0 }, 13)).toBe(
			"Good afternoon. 1 agent working, 1 item needs your attention."
		);
		expect(briefing(buildHologram(EMPTY, BASE).totals, 2)).toBe(
			"Working late. No agents are set up yet."
		);
		expect(greeting(5)).toBe("Good morning");
		expect(greeting(12)).toBe("Good afternoon");
		expect(greeting(17)).toBe("Good evening");
		expect(greeting(23)).toBe("Good evening");
		expect(greeting(4)).toBe("Working late");
		expect(greeting(0)).toBe("Working late");
	});

	test("pulses faster and brighter as more agents work", () => {
		const idle = corePulse(0, 4);
		const some = corePulse(1, 4);
		const all = corePulse(4, 4);
		expect(some.period).toBeLessThan(idle.period);
		expect(all.period).toBeLessThan(some.period);
		expect(all.intensity).toBeGreaterThan(some.intensity);
		expect(some.intensity).toBeGreaterThan(idle.intensity);
	});

	test("reads a leading @handle as the target agent", () => {
		expect(parseCommand(SNAPSHOT, "@grace check the logs")).toEqual({
			agentId: "agent-grace",
			prompt: "check the logs",
		});
		expect(parseCommand(SNAPSHOT, "  ship it  ")).toEqual({
			agentId: null,
			prompt: "ship it",
		});
		expect(parseCommand(SNAPSHOT, "@nobody hello")).toEqual({
			agentId: null,
			prompt: "@nobody hello",
		});
	});

	test("spreads agents over one ring, or two when crowded", () => {
		const few = ringSlots(["a", "b", "c", "d"]);
		expect(few.map((slot) => slot.angle)).toEqual([0, 90, 180, 270]);
		expect(new Set(few.map((slot) => slot.ring))).toEqual(new Set([0]));
		const many = ringSlots(Array.from({ length: 12 }, (_, i) => `a${i}`));
		expect(many.filter((slot) => slot.ring === 0).length).toBe(5);
		expect(many.filter((slot) => slot.ring === 1).length).toBe(7);
	});

	test("fans the radial menu around the node, clear of the box edge and the label", () => {
		const box = { height: 640, width: 720 };
		const items = [
			{ height: 24, width: 72 },
			{ height: 24, width: 100 },
			{ height: 24, width: 108 },
		];
		const keepOut = { bottom: 70, left: -44, right: 44, top: 32 };
		for (const angle of [0, 45, 90, 135, 180, 225, 270, 315]) {
			// The ring keeps 76px between a node and the box's top and bottom.
			const node = polar(angle, 244);
			const nodeX = box.width / 2 + node.x;
			const nodeY = box.height / 2 + node.y;
			const placements = radialMenuLayout({
				box,
				items,
				keepOut,
				nodeX,
				nodeY,
				outward: angle,
				radius: 42,
			});
			expect(placements).toHaveLength(items.length);
			// Every item hangs off the same arc, at equal angular steps.
			expect(new Set(placements.map((place) => place.reach))).toEqual(
				new Set([42])
			);
			const angles = placements
				.map((place) => place.angle)
				.sort((a, b) => a - b);
			const spread = angles.map((value) =>
				Math.round(normalizeAngle(value - (angles[0] ?? 0) + 180) - 180)
			);
			const sorted = [...spread].sort((a, b) => a - b);
			const steps = sorted
				.slice(1)
				.map((value, index) => value - (sorted[index] ?? 0));
			expect(new Set(steps).size).toBe(1);
			const rects = placements.map((place, index) => {
				const size = items[index] ?? { height: 0, width: 0 };
				return {
					bottom: place.top + size.height,
					left: place.left,
					right: place.left + size.width,
					top: place.top,
				};
			});
			for (const [index, rect] of rects.entries()) {
				expect(nodeX + rect.left).toBeGreaterThanOrEqual(0);
				expect(nodeY + rect.top).toBeGreaterThanOrEqual(0);
				expect(nodeX + rect.right).toBeLessThanOrEqual(box.width);
				expect(nodeY + rect.bottom).toBeLessThanOrEqual(box.height);
				const hitsLabel =
					rect.left < keepOut.right &&
					keepOut.left < rect.right &&
					rect.top < keepOut.bottom &&
					keepOut.top < rect.bottom;
				expect(hitsLabel).toBe(false);
				for (const other of rects.slice(index + 1)) {
					const apart =
						rect.right <= other.left ||
						other.right <= rect.left ||
						rect.bottom <= other.top ||
						other.bottom <= rect.top;
					expect(apart).toBe(true);
				}
			}
		}
	});

	test("opens the fan toward the core and anchors items at their arc points", () => {
		const items = [
			{ height: 24, width: 80 },
			{ height: 24, width: 80 },
			{ height: 24, width: 80 },
		];
		const open = (nodeX: number, nodeY: number, outward: number) =>
			radialMenuLayout({
				box: { height: 800, width: 800 },
				items,
				nodeX,
				nodeY,
				outward,
				radius: 42,
			});
		// A node left of the core opens to the right, read top to bottom.
		const right = open(200, 400, 270);
		expect(right.map((place) => place.angle)).toEqual([46, 90, 134]);
		// Straight out to the right, the item starts at the arc point.
		expect(right[1]?.left).toBe(42);
		expect(right[1]?.top).toBe(-12);
		// A node above the core opens downward, read left to right; the middle
		// item is centred under its arc point.
		const below = open(400, 200, 0);
		const lefts = below.map((place) => place.left);
		expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
		expect(below[1]?.angle).toBe(180);
		expect(below[1]?.left).toBe(-40);
		expect(below[1]?.top).toBe(42);
		// No room toward the core: the fan turns away from the box edge.
		const edge = open(20, 400, 90);
		for (const [index, place] of edge.entries()) {
			expect(20 + place.left).toBeGreaterThanOrEqual(0);
			expect(20 + place.left + (items[index]?.width ?? 0)).toBeLessThanOrEqual(
				800
			);
		}
	});

	test("keeps the menu off the selected node's name", () => {
		const short = labelKeepOut("Echo");
		const long = labelKeepOut("A very long agent name that truncates");
		expect(short.right).toBeLessThan(long.right);
		expect(long.right).toBe(72);
		expect(short.left).toBe(-short.right);
		// The count line stays under the name while the menu is open.
		const withMeta = labelKeepOut("Echo", "3 threads");
		expect(withMeta.bottom).toBeGreaterThan(short.bottom);
		expect(withMeta.right).toBeGreaterThanOrEqual(short.right);
	});

	test("shortens a routine's cadence and counts a live run's elapsed time", () => {
		expect(shortCadence("Every Monday at 9 AM")).toBe("Every Monday 9 AM");
		expect(shortCadence("Every hour")).toBe("Every hour");
		expect(elapsedClock(ago(3), BASE)).toBe("03:00");
		expect(elapsedClock(ago(62), BASE)).toBe("1:02:00");
	});

	test("fits the rings and the core to the box", () => {
		const wide = orbitGeometry(800, 700, 1);
		expect(wide.compact).toBe(false);
		expect(wide.coreDiameter).toBeLessThanOrEqual(248);
		const phone = orbitGeometry(358, 440, 1);
		expect(phone.compact).toBe(true);
		expect(phone.coreDiameter).toBeLessThan(phone.radii[0] * 2 - 96);
		const two = orbitGeometry(800, 700, 2);
		expect(two.radii[0]).toBeLessThan(two.radii[1]);
	});

	test("counts down to upcoming runs", () => {
		expect(countdown(ahead(0.5), BASE)).toBe("in 30m");
		expect(countdown(ahead(3), BASE)).toBe("in 3h");
		expect(countdown(ahead(72), BASE)).toBe("in 3d");
		expect(countdown(ago(1), BASE)).toBe("now");
	});

	test("the mode string assigns every palette token in both modes", () => {
		for (const name of HOLO_TOKEN_NAMES) {
			expect(HOLO_MODE).toContain(`[--holo-${name}:var(--holo-${name}-l)]`);
			expect(HOLO_MODE).toContain(
				`dark:[--holo-${name}:var(--holo-${name}-d)]`
			);
			expect(Object.keys(HOLO_VARS)).toContain(`--holo-${name}-l`);
			expect(Object.keys(HOLO_VARS)).toContain(`--holo-${name}-d`);
		}
	});
});

describe("HologramInterface", () => {
	test("renders the deck, panels and briefing on the server", () => {
		const html = renderToStaticMarkup(hologram(recordingPort().port));
		expect(html).toContain('data-testid="interface-hologram"');
		for (const label of [
			"Priority",
			"Active operations",
			"Schedule",
			"System",
		]) {
			expect(html).toContain(label);
		}
		expect(html).toContain("1 agent working, 2 items need your attention.");
		expect(html).toContain("Flaky test");
		expect(html).toContain("Inbox sweep");
		// A routine leads with its countdown; its cadence already gives the time.
		// BASE is floored to the minute, so render time may land a minute later.
		expect(html).toMatch(/>in (1h|59m)</);
		expect(html).toContain('placeholder="Ask or command…"');
		// With no agent picked, the command bar goes to the host's default.
		expect(html).toContain("Any agent");
	});

	test("opens a thread from a panel through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(hologram(port));
		await click(
			view.container.querySelector('[data-thread-id="thread-flaky"]')
		);
		expect(calls).toEqual(["open:thread-flaky"]);
		await view.dispose();
	});

	test("selecting an agent opens its radial menu", async () => {
		const restore = sizedBoxes();
		const { calls, port } = recordingPort();
		const view = await mount(hologram(port));
		const node = view.container.querySelector('[data-agent-id="agent-grace"]');
		expect(node?.getAttribute("aria-label")).toBe(
			"Grace, working, 2 threads, 1 failed, 1 needs you"
		);
		// The core and its status ring name themselves.
		expect(
			view.container
				.querySelector("[data-holo-core]")
				?.getAttribute("aria-label")
		).toMatch(/^1 of 3 agents working\. Status ring, threads by status: /);
		await click(node);
		// The node keeps its count line while its menu is open.
		expect(node?.textContent).toContain("2 threads");
		expect(node?.getAttribute("aria-expanded")).toBe("true");
		const menu = view.container.querySelector('[role="menu"]');
		expect(menu?.getAttribute("aria-label")).toBe("Grace actions");
		expect(
			[...view.container.querySelectorAll('[role="menuitem"]')].map(
				(item) => item.textContent
			)
		).toEqual(["Message", "Open latest", "Show threads"]);
		await click(menuItem(view.container, "Open latest"));
		expect(calls).toEqual(["open:thread-triage"]);
		expect(view.container.querySelector('[role="menu"]')).toBeNull();
		await view.dispose();
		restore();
	});

	test("the ring is one Tab stop and arrow keys move round it", async () => {
		const restore = sizedBoxes();
		const view = await mount(hologram(recordingPort().port));
		const nodes = [
			...view.container.querySelectorAll<HTMLButtonElement>("[data-agent-id]"),
		];
		expect(nodes.length).toBe(3);
		expect(nodes.filter((node) => node.tabIndex === 0).length).toBe(1);
		const list = view.container.querySelector('ul[aria-label="Agents"]');
		expect(list?.getAttribute("aria-describedby")).toBeTruthy();
		const first = nodes.find((node) => node.tabIndex === 0);
		if (!first) {
			throw new Error("Expected a tabbable node");
		}
		await act(async () => {
			first.focus();
		});
		await press(first, "ArrowRight");
		const moved = document.activeElement;
		expect(moved).not.toBe(first);
		expect(moved?.hasAttribute("data-agent-id")).toBe(true);
		// The roving stop follows focus.
		expect((moved as HTMLButtonElement | null)?.tabIndex).toBe(0);
		expect(first.tabIndex).toBe(-1);
		await view.dispose();
		restore();
	});

	test("Open latest is disabled for an agent with no threads", async () => {
		const restore = sizedBoxes();
		const view = await mount(hologram(recordingPort().port));
		await click(view.container.querySelector('[data-agent-id="agent-linus"]'));
		const open = menuItem(view.container, "Open latest");
		expect(open?.hasAttribute("disabled")).toBe(true);
		await view.dispose();
		restore();
	});

	test("Escape closes the radial menu without closing anything else", async () => {
		const restore = sizedBoxes();
		const { calls, port } = recordingPort();
		const view = await mount(hologram(port));
		await click(view.container.querySelector('[data-agent-id="agent-ada"]'));
		const menu = view.container.querySelector('[role="menu"]');
		if (!menu) {
			throw new Error("Expected the radial menu");
		}
		await press(menu, "Escape");
		expect(view.container.querySelector('[role="menu"]')).toBeNull();
		expect(calls).toEqual([]);
		await view.dispose();
		restore();
	});

	test("Show threads swaps Priority for that agent's threads", async () => {
		const restore = sizedBoxes();
		const view = await mount(hologram(recordingPort().port));
		await click(view.container.querySelector('[data-agent-id="agent-ada"]'));
		await click(menuItem(view.container, "Show threads"));
		const panel = view.container.querySelector(
			'[data-holo-panel="agent-threads"]'
		);
		expect(panel?.textContent).toContain("Ada · Threads");
		expect(panel?.textContent).toContain("Release notes");
		expect(panel?.textContent).toContain("Intro edits");
		await click(byLabel(view.container, "Close Ada's threads"));
		expect(
			view.container.querySelector('[data-holo-panel="priority"]')
		).not.toBeNull();
		await view.dispose();
		restore();
	});

	test("Message targets the agent and Enter starts a thread with the typed prompt", async () => {
		const restore = sizedBoxes();
		const { calls, port } = recordingPort();
		const view = await mount(hologram(port));
		await click(view.container.querySelector('[data-agent-id="agent-ada"]'));
		await click(menuItem(view.container, "Message"));
		const input = view.container.querySelector("input");
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Expected the command input");
		}
		expect(input.getAttribute("aria-label")).toBe("Ask or command Ada");
		// The targeted node stays marked on the ring.
		const ada = view.container.querySelector('[data-agent-id="agent-ada"]');
		expect(ada?.hasAttribute("data-targeted")).toBe(true);
		expect(view.container.querySelectorAll("[data-targeted]").length).toBe(1);
		await submit(view.container.querySelector("form"));
		expect(calls).toEqual([]);
		await typeInto(input, "Tighten the intro");
		await submit(view.container.querySelector("form"));
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-ada", prompt: "Tighten the intro" })}`,
		]);
		expect(input.value).toBe("");
		expect(input.getAttribute("aria-label")).toBe("Ask or command");
		expect(view.container.querySelector("[data-targeted]")).toBeNull();
		await view.dispose();
		restore();
	});

	test("an @handle in the command bar picks the agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(hologram(port));
		const input = view.container.querySelector("input");
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Expected the command input");
		}
		await typeInto(input, "@grace rerun the flaky test");
		expect(input.getAttribute("aria-label")).toBe("Ask or command Grace");
		await submit(view.container.querySelector("form"));
		await typeInto(input, "What is next?");
		await submit(view.container.querySelector("form"));
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-grace", prompt: "rerun the flaky test" })}`,
			`start:${JSON.stringify({ prompt: "What is next?" })}`,
		]);
		await view.dispose();
	});

	test("shows the host's thread view in a frame and Escape closes it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			hologram(port, {
				activeThreadId: "thread-triage",
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const frame = view.container.querySelector(
			'[data-testid="hologram-thread-frame"]'
		);
		expect(frame?.getAttribute("role")).toBe("dialog");
		expect(frame?.getAttribute("aria-modal")).toBe("true");
		const labelId = frame?.getAttribute("aria-labelledby") ?? "";
		expect(document.getElementById(labelId)?.textContent).toBe("Crash triage");
		expect(frame?.querySelector('[data-testid="host-thread"]')).not.toBeNull();
		expect(frame?.textContent).toContain("Running");
		expect(document.activeElement?.textContent).toBe("Crash triage");
		// One "Close thread" control: the pointer-only scrim stays out of the tree.
		const closers = [
			...view.container.querySelectorAll('[aria-label="Close thread"]'),
		];
		expect(closers).toHaveLength(1);
		// The header carries one control; the Esc shortcut is in its tooltip.
		expect(frame?.querySelectorAll("header button")).toHaveLength(1);
		expect(frame?.querySelector("kbd")).toBeNull();
		expect(closers[0]?.getAttribute("title")).toBe("Close thread (Esc)");
		await press(document, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});

	test("leaves Escape and slash to a host page covering the deck", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			hologram(port, {
				activeThreadId: "thread-triage",
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		// While the host covers the deck it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		const escapeKey = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "Escape",
		});
		await act(async () => {
			document.body.dispatchEvent(escapeKey);
		});
		expect(calls).toEqual([]);
		expect(escapeKey.defaultPrevented).toBe(false);
		view.container.removeAttribute("inert");
		await press(document, "Escape");
		expect(calls).toEqual(["close"]);
		await view.dispose();

		const deck = await mount(hologram(port));
		deck.container.setAttribute("inert", "");
		const slash = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "/",
		});
		await act(async () => {
			document.body.dispatchEvent(slash);
		});
		expect(slash.defaultPrevented).toBe(false);
		deck.container.removeAttribute("inert");
		const open = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: "/",
		});
		await act(async () => {
			document.body.dispatchEvent(open);
		});
		expect(open.defaultPrevented).toBe(true);
		await deck.dispose();
	});

	test("starts an empty deck with a call to action", async () => {
		const { calls, port } = recordingPort();
		const restore = sizedBoxes();
		const view = await mount(hologram(port, { snapshot: EMPTY }));
		expect(view.container.textContent).toContain("No agents are set up yet.");
		expect(view.container.textContent).toContain(
			"Nothing needs you right now."
		);
		const start = [...view.container.querySelectorAll("button")].find(
			(button) => button.textContent === "Start a thread"
		);
		await click(start);
		expect(calls).toEqual([`start:${JSON.stringify({})}`]);
		await view.dispose();
		restore();
	});

	test("loading marks the deck busy and holds back nodes and input", async () => {
		const restore = sizedBoxes();
		const view = await mount(hologram(recordingPort().port, { loading: true }));
		const root = view.container.querySelector(
			'[data-testid="interface-hologram"]'
		);
		expect(root?.getAttribute("aria-busy")).toBe("true");
		expect(view.container.querySelector("[data-agent-id]")).toBeNull();
		expect(view.container.querySelector("input")?.disabled).toBe(true);
		await view.dispose();
		restore();
	});
});
