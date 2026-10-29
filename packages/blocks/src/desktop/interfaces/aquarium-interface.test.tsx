import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { resolveInterfaceParams } from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { planReef } from "./aquarium-diorama.tsx";
import { AquariumInterface } from "./aquarium-interface.tsx";
import {
	layoutTank,
	swimAt,
	TANK_FLOOR,
	TANK_SURFACE,
} from "./aquarium-layout.ts";
import {
	agentThreadSections,
	buildCreatures,
	CREATURE_KINDS,
	type Creature,
	creatureDescription,
	creatureKind,
	creatureOrder,
	hashId,
	tankSummary,
	unassignedThreads,
} from "./aquarium-model.ts";
import {
	cssColor,
	linear,
	resolveCssColor,
	roomFittings,
	TANK_FITTINGS,
	tankPalette,
	WALLPAPERS,
} from "./aquarium-palette.ts";

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

function roster(count: number, working: (index: number) => boolean) {
	return {
		...SNAPSHOT,
		agents: Array.from({ length: count }, (_, index) => ({
			avatarUrl: null,
			description: "",
			id: `agent-${index}`,
			name: `Agent ${index}`,
			status: working(index) ? ("working" as const) : ("idle" as const),
		})),
		threads: [],
	};
}

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

function creatureButton(container: HTMLElement, agentId: string) {
	return container.querySelector(`button[data-agent-id="${agentId}"]`);
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

function creature(creatures: Creature[], id: string): Creature {
	const found = creatures.find((item) => item.id === id);
	if (!found) {
		throw new Error(`Missing creature ${id}`);
	}
	return found;
}

/** Everything wrong with a mesh (an empty list for a valid one). */
describe("aquarium model", () => {
	test("each agent becomes a stable creature; species spread before repeating", () => {
		expect(hashId("agent-ada")).toBe(hashId("agent-ada"));
		expect(hashId("agent-ada")).not.toBe(hashId("agent-grace"));
		expect(CREATURE_KINDS).toContain(creatureKind("agent-ada"));

		const six = buildCreatures(
			roster(6, () => false),
			8
		);
		const kinds = six.map((item) => item.kind);
		// Every species appears once before any appears twice.
		expect(new Set(kinds).size).toBe(CREATURE_KINDS.length);
		// Colors stay distinct while the palette has room.
		expect(new Set(six.map((item) => item.colorIndex)).size).toBe(6);
		// Rebuilding gives the same creatures.
		expect(
			buildCreatures(
				roster(6, () => false),
				8
			).map((item) => item.kind)
		).toEqual(kinds);

		const twelve = buildCreatures(
			roster(12, () => false),
			8
		);
		const counts = new Map<string, number>();
		for (const item of twelve) {
			counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
		}
		expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
	});

	test("working agents swim, agents with failed runs carry a pearl", () => {
		const creatures = buildCreatures(SNAPSHOT, 8);
		const grace = creature(creatures, "agent-grace");
		const ada = creature(creatures, "agent-ada");
		expect(grace.working).toBe(true);
		expect(grace.pearl).toBe(true);
		expect(grace.counts.working).toBe(1);
		expect(ada.working).toBe(false);
		expect(ada.pearl).toBe(false);
		expect(ada.threadCount).toBe(2);
	});

	test("keyboard order puts who needs you first, then who is working", () => {
		const order = creatureOrder(buildCreatures(SNAPSHOT, 8)).map(
			(item) => item.id
		);
		// Grace has a failed run, Ada a message waiting on you, Linus nothing.
		expect(order).toEqual(["agent-grace", "agent-ada", "agent-linus"]);
	});

	test("panel lists and summary", () => {
		expect(
			agentThreadSections(SNAPSHOT, "agent-grace").map((section) => [
				section.status,
				section.threads.map((item) => item.id),
			])
		).toEqual([
			["attention", ["thread-flaky"]],
			["working", ["thread-triage"]],
		]);
		expect(unassignedThreads(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-loose",
		]);
		expect(tankSummary(SNAPSHOT)).toEqual({
			agents: 3,
			attention: 1,
			unassigned: 1,
			working: 1,
			yourTurn: 1,
		});
		const grace = creature(buildCreatures(SNAPSHOT, 8), "agent-grace");
		const description = creatureDescription(grace);
		expect(description.startsWith("Grace, ")).toBe(true);
		expect(description).toContain("working");
		expect(description).toContain("1 needs attention");
	});
});

describe("aquarium palette", () => {
	test("the wallpaper setting papers the room: cream by default, each choice its own walls", () => {
		expect(resolveInterfaceParams("aquarium", {})).toMatchObject({
			wallpaper: "cream",
		});
		expect(
			resolveInterfaceParams("aquarium", { wallpaper: "sage" })
		).toMatchObject({ wallpaper: "sage" });
		for (const mode of ["dark", "light"] as const) {
			// The default is the room's own paper; the rest of the room stays.
			expect(roomFittings(mode)).toEqual(TANK_FITTINGS[mode]);
			for (const choice of ["blue", "sage"] as const) {
				const room = roomFittings(mode, choice);
				expect(room.wall).toBe(WALLPAPERS[choice][mode].wall);
				expect(room.wall).not.toBe(TANK_FITTINGS[mode].wall);
				expect(room.floor).toBe(TANK_FITTINGS[mode].floor);
			}
		}
	});

	test("the tank follows the theme: night for dark backgrounds", () => {
		expect(
			tankPalette({
				background: [20, 20, 30],
				darkClass: false,
				primary: null,
				ring: null,
			}).mode
		).toBe("dark");
		expect(
			tankPalette({
				background: [250, 250, 250],
				darkClass: true,
				primary: [40, 120, 220],
				ring: [1, 2, 3],
			}).mode
		).toBe("light");
		// Unknown background: fall back to the document's dark class.
		expect(
			tankPalette({
				background: null,
				darkClass: true,
				primary: null,
				ring: null,
			}).mode
		).toBe("dark");
		expect(resolveCssColor(null, "var(--primary)")).toBe(null);
		expect(linear([255, 255, 255])).toEqual([1, 1, 1]);
		// Opacity is clamped to 0..1.
		expect(cssColor([1, 2, 3], 2)).toBe(cssColor([1, 2, 3], 1));
		expect(cssColor([1, 2, 3], 1)).toContain("1 2 3 / 1");
	});
});

describe("aquarium diorama", () => {
	test("each creature gets its own spot in the tank, high swimmers at the back", () => {
		for (const count of [1, 3, 6, 8, 11]) {
			const creatures = buildCreatures(
				roster(count, (index) => index % 3 === 0),
				8
			);
			const layout = layoutTank(creatures);
			expect(layout.swims.size).toBe(count);
			const homes = creatures.map((item) => {
				const swim = layout.swims.get(item.id);
				if (!swim) {
					throw new Error(`No swim for ${item.id}`);
				}
				return swim;
			});
			for (const { home, radiusX, radiusZ } of homes) {
				expect(Math.abs(home[0]) + radiusX).toBeLessThan(layout.halfWidth);
				expect(Math.abs(home[2]) + radiusZ).toBeLessThan(layout.halfDepth);
				expect(home[1]).toBeGreaterThan(TANK_FLOOR + 0.5);
				expect(home[1]).toBeLessThan(TANK_SURFACE - 0.8);
			}
			const back = homes.filter((swim) => swim.home[2] < 0);
			const front = homes.filter((swim) => swim.home[2] > 0);
			const lowestBack = Math.min(...back.map((swim) => swim.home[1]));
			for (const swim of front) {
				expect(swim.home[1]).toBeLessThanOrEqual(lowestBack);
			}
			// Seen from the isometric camera, no two home spots (and so no
			// two name plates) land on top of each other.
			const screen = homes.map(({ home: [x, y, z] }) => [
				(x - z) / Math.SQRT2,
				y * Math.cos(0.56) - ((x + z) / Math.SQRT2) * Math.sin(0.56),
			]);
			for (const [index, a] of screen.entries()) {
				for (const b of screen.slice(index + 1)) {
					expect(
						Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0))
					).toBeGreaterThan(0.75);
				}
			}
		}
	});

	test("a creature swims a small loop around its spot, heading along it", () => {
		const creatures = buildCreatures(SNAPSHOT, 8);
		const swim = layoutTank(creatures).swims.get("agent-grace");
		if (!swim) {
			throw new Error("No swim for Grace");
		}
		const now = { heading: 0, x: 0, y: 0, z: 0 };
		const next = { heading: 0, x: 0, y: 0, z: 0 };
		for (let time = 0; time < 30; time += 0.7) {
			swimAt(swim, time, now);
			expect(Math.abs(now.x - swim.home[0])).toBeLessThanOrEqual(
				swim.radiusX + 1e-9
			);
			expect(Math.abs(now.y - swim.home[1])).toBeLessThan(0.11);
			swimAt(swim, time + 0.01, next);
			// The heading points the way it is moving (models face +x).
			const dx = next.x - now.x;
			const dz = next.z - now.z;
			const along = Math.cos(now.heading) * dx - Math.sin(now.heading) * dz;
			expect(along).toBeGreaterThan(0);
		}
	});

	test("the reef stays inside the tank", () => {
		const { halfDepth, halfWidth } = layoutTank(
			buildCreatures(
				roster(8, () => true),
				8
			)
		);
		const plan = planReef(halfWidth, halfDepth);
		const pieces = [
			...plan.brains,
			...plan.branches,
			...plan.fans,
			...plan.kelp,
			...plan.rocks,
			...plan.stars,
			...plan.tubes,
		];
		expect(plan.kelp.length).toBeGreaterThan(8);
		for (const { at } of pieces) {
			expect(Math.abs(at[0])).toBeLessThan(halfWidth);
			expect(Math.abs(at[2])).toBeLessThan(halfDepth);
			expect(at[1]).toBeGreaterThanOrEqual(TANK_FLOOR);
		}
	});
});

describe("AquariumInterface", () => {
	test("renders loading and empty states", () => {
		const { port } = recordingPort();
		const empty = { ...SNAPSHOT, agents: [], threads: [] };
		const loadingMarkup = renderToStaticMarkup(
			<AquariumInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(loadingMarkup).toContain('data-testid="interface-aquarium"');
		expect(loadingMarkup).toContain('aria-busy="true"');
		expect(loadingMarkup).toContain("Filling the tank");
		const emptyMarkup = renderToStaticMarkup(
			<AquariumInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={empty}
				threadView={null}
			/>
		);
		expect(emptyMarkup).toContain("The tank is empty");
		expect(emptyMarkup).toContain("Start a thread");
	});

	test("lists every creature for keyboard users, after the toolbar", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<AquariumInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(markup).toContain('aria-label="Agents in the tank"');
		expect(markup).toContain('role="img"');
		const order = [...markup.matchAll(/data-agent-id="([^"]+)"/g)].map(
			(match) => match[1]
		);
		expect(order).toEqual(["agent-grace", "agent-ada", "agent-linus"]);
		// The toolbar comes first in the tab order.
		expect(markup.indexOf("New thread")).toBeLessThan(
			markup.indexOf('data-agent-id="agent-grace"')
		);
		expect(markup.replaceAll(/<[^>]+>/g, "")).toContain(
			"3 agents · 1 working · 1 needs attention · 1 waiting on you"
		);
		// A narrow tank keeps the live counts and drops the rest.
		expect(markup).toContain(
			'<span class="@max-[620px]:hidden">3 agents</span>'
		);
		expect(markup).toContain("1 unassigned thread");
		expect(markup).toContain("Drag to pan");
	});

	test("shows the host thread view in the panel beside the tank", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<AquariumInterface
				activeThreadId="thread-triage"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(markup).toContain('data-testid="aquarium-panel"');
		expect(markup).toContain('data-view="thread"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Thread: Crash triage"');
		expect(markup).toContain('aria-label="Back to Grace"');
	});

	test("without WebGL the creatures become a visible list, and still open", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<AquariumInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(view.container.textContent).toContain("needs WebGL");
		const list = view.container.querySelector(
			'[aria-label="Agents in the tank"]'
		);
		expect(list?.className).not.toContain("sr-only");
		// No 3D view, so the legend never offers to drag one.
		expect(view.container.textContent).not.toContain("Drag to pan");
		await view.dispose();
	});

	test("a creature opens its card; threads and the composer act through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<AquariumInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(creatureButton(view.container, "agent-grace"));
		const panel = view.container.querySelector(
			'[data-testid="aquarium-panel"]'
		);
		expect(panel?.getAttribute("data-view")).toBe("agent");
		expect(panel?.textContent).toContain("Grace");
		expect(panel?.textContent).toContain("Triages bugs");
		expect(
			panel?.querySelector('[data-testid="aquarium-agent-counts"]')?.textContent
		).toBe("2 threads·1 needs you·1 live");
		expect(
			creatureButton(view.container, "agent-grace")?.getAttribute(
				"aria-expanded"
			)
		).toBe("true");

		await click(button(view.container, "Open Flaky test"));
		const field = panel?.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("No composer field");
		}
		await typeInto(field, "  Retry the flaky test  ");
		await press(field, "Enter");
		await click(button(view.container, "New thread"));
		expect(calls).toEqual([
			"open:thread-flaky",
			'start:{"agentId":"agent-grace","prompt":"Retry the flaky test"}',
			"start:{}",
		]);

		// Escape (outside a text field) closes the card.
		await press(panel?.querySelector("h2") ?? view.container, "Escape");
		expect(view.container.querySelector('[data-testid="aquarium-panel"]')).toBe(
			null
		);
		await view.dispose();
	});

	test("arrow keys move between creatures in the list", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<AquariumInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const first = creatureButton(view.container, "agent-grace");
		if (!(first instanceof HTMLElement)) {
			throw new Error("No creature button");
		}
		await act(async () => first.focus());
		await press(first, "ArrowDown");
		expect(document.activeElement?.getAttribute("data-agent-id")).toBe(
			"agent-ada"
		);
		await press(document.activeElement ?? first, "End");
		expect(document.activeElement?.getAttribute("data-agent-id")).toBe(
			"agent-linus"
		);
		await press(document.activeElement ?? first, "ArrowDown");
		expect(document.activeElement?.getAttribute("data-agent-id")).toBe(
			"agent-grace"
		);
		await view.dispose();
	});

	test("an empty composer never sends, and unassigned threads have a home", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<AquariumInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(creatureButton(view.container, "agent-linus"));
		expect(view.container.textContent).toContain("No threads with Linus yet");
		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("No composer field");
		}
		await typeInto(field, "   ");
		await press(field, "Enter");
		expect(calls).toEqual([]);

		// Escape in a composer with a draft belongs to the draft…
		await typeInto(field, "Half a thought");
		await press(field, "Escape");
		expect(
			view.container.querySelector('[data-testid="aquarium-panel"]')
		).not.toBe(null);
		// …and in an empty one it closes the panel, as the Esc hint says.
		await typeInto(field, "");
		await press(field, "Escape");
		expect(view.container.querySelector('[data-testid="aquarium-panel"]')).toBe(
			null
		);
		expect(calls).toEqual([]);

		await click(button(view.container, "1 unassigned thread"));
		const panel = view.container.querySelector(
			'[data-testid="aquarium-panel"]'
		);
		expect(panel?.getAttribute("data-view")).toBe("unassigned");
		await click(button(view.container, "Open Loose ends"));
		expect(calls).toEqual(["open:thread-loose"]);
		await view.dispose();
	});

	test("back leaves the thread for the agent's card, close leaves both", async () => {
		const calls: string[] = [];
		function Host() {
			const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
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
			return (
				<AquariumInterface
					activeThreadId={activeThreadId}
					loading={false}
					params={{}}
					port={port}
					snapshot={SNAPSHOT}
					threadView={
						activeThreadId ? <div data-testid="host-view">Host</div> : null
					}
				/>
			);
		}
		const view = await mount(<Host />);
		await click(creatureButton(view.container, "agent-ada"));
		await click(button(view.container, "Open Release notes"));
		const panel = () =>
			view.container.querySelector('[data-testid="aquarium-panel"]');
		expect(panel()?.getAttribute("data-view")).toBe("thread");
		expect(view.container.querySelector('[data-testid="host-view"]')).not.toBe(
			null
		);

		await click(button(view.container, "Back to Ada"));
		expect(panel()?.getAttribute("data-view")).toBe("agent");
		expect(panel()?.textContent).toContain("Ada");

		await click(button(view.container, "Open Intro edits"));
		// Picking another creature while a thread is open closes the thread.
		await click(creatureButton(view.container, "agent-grace"));
		expect(panel()?.getAttribute("data-view")).toBe("agent");
		expect(panel()?.textContent).toContain("Grace");

		await click(button(view.container, "Close panel"));
		expect(panel()).toBe(null);
		expect(calls).toEqual([
			"open:thread-notes",
			"close",
			"open:thread-question",
			"close",
		]);
		await view.dispose();
	});
});
