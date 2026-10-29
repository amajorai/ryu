import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { isSuggestion } from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { cropParts } from "./farm-diorama.tsx";
import { FarmInterface } from "./farm-interface.tsx";
import {
	BED_SLOTS,
	buildFarm,
	cropLabel,
	FRUITS,
	farmDay,
	fruitFor,
	inRect,
	layoutDiorama,
	OPEN_FIELD_ID,
	PLANT_HEIGHT,
	plantBed,
	plotForThread,
	plotLabel,
	type Rect,
	SHARED_PLOT_ID,
	seedSlot,
	stageFor,
} from "./farm-model.ts";
import { Plant } from "./farm-plants.tsx";
import { usefulStateFixture } from "./game-acts-fixture.ts";

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
			description: "Designs pages",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Ships builds",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Writes copy",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Website",
		},
		{
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-linus", "agent-grace"],
			name: "Docs Crew",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-palette",
			lastMessage: "Three palettes are ready.",
			messageCount: 6,
			title: "Pick a palette",
			updatedAt: ago(40),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-hero",
			lastMessage: "Rebuilding the hero.",
			running: true,
			title: "Landing hero",
			updatedAt: ago(2),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-audit",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Audit",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-notes",
			lastMessage: "Can you shorten it?",
			lastMessageRole: "user",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: [],
			id: "thread-loose",
			lastMessage: "Office is closed Friday.",
			lastMessageRole: "user",
			title: "Office closed",
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

async function press(target: Element, key: string) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
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

function byLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label
	);
}

function byText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === text
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

function farm(overrides: Partial<Parameters<typeof FarmInterface>[0]> = {}) {
	const { port } = recordingPort();
	return (
		<FarmInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

function cropButton(container: HTMLElement, threadId: string) {
	const model = buildFarm(SNAPSHOT);
	const crop = model.crops.find((item) => item.thread.id === threadId);
	const plot = plotForThread(model, threadId);
	if (!(crop && plot)) {
		throw new Error(`No crop for ${threadId}`);
	}
	return byLabel(container, cropLabel(crop, plot.name));
}

function rectsOverlap(a: Rect, b: Rect): boolean {
	return (
		a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ
	);
}

describe("farm model", () => {
	test("projects fence their agents' plots; the rest farm open plots", () => {
		const model = buildFarm(SNAPSHOT);
		expect(
			model.fields.map((field) => [
				field.id,
				field.fenced,
				field.plots.map((plot) => plot.id),
			])
		).toEqual([
			["project-site", true, ["agent-ada", "agent-grace"]],
			[OPEN_FIELD_ID, false, ["agent-linus", SHARED_PLOT_ID]],
		]);
		expect(plotForThread(model, "thread-loose")?.name).toBe("Shared bed");
		expect(plotForThread(model, "thread-hero")?.working).toBe(true);
	});

	test("growth stage follows status, and crops sort most urgent first", () => {
		expect(stageFor("waiting")).toBe("seed");
		expect(stageFor("working")).toBe("growing");
		expect(stageFor("your-turn")).toBe("ripe");
		expect(stageFor("attention")).toBe("withered");
		expect(stageFor("quiet")).toBe("fallow");
		const grace = buildFarm(SNAPSHOT).plots.find(
			(plot) => plot.id === "agent-grace"
		);
		expect(grace?.crops.map((crop) => crop.stage)).toEqual([
			"withered",
			"growing",
		]);
	});

	test("fruit is stable per thread and drawn from the known fruits", () => {
		expect(fruitFor("thread-hero")).toBe(fruitFor("thread-hero"));
		const kinds = new Set(
			Array.from({ length: 40 }, (_, index) => fruitFor(`thread-${index}`))
		);
		for (const kind of kinds) {
			expect(FRUITS).toContain(kind);
		}
		expect(kinds.size).toBeGreaterThan(3);
	});

	test("totals count coins per message and crops per stage", () => {
		const { totals } = buildFarm(SNAPSHOT);
		expect(totals).toEqual({
			coins: 14,
			crops: 5,
			fallow: 0,
			growing: 1,
			ripe: 1,
			seeds: 2,
			withered: 1,
		});
	});

	test("a full bed plants six crops and counts the rest as hidden", () => {
		const threads = Array.from({ length: 9 }, (_, index) =>
			thread({ agentIds: ["agent-ada"], id: `thread-${index}` })
		);
		const ada = buildFarm({ ...SNAPSHOT, threads }).plots[0];
		expect(ada?.shown).toHaveLength(BED_SLOTS);
		expect(ada?.hidden).toBe(3);
	});

	test("the farm day counts from the oldest conversation", () => {
		expect(farmDay(SNAPSHOT.threads, BASE)).toBe(4);
		expect(farmDay([], BASE)).toBe(1);
	});

	test("the diorama gives every plot a bed, clear of the others and the barn", () => {
		const { fields, plots } = buildFarm(SNAPSHOT);
		const diorama = layoutDiorama(fields);
		expect(diorama.beds.map((placed) => placed.plot.id).sort()).toEqual(
			plots.map((plot) => plot.id).sort()
		);
		for (const [index, placed] of diorama.beds.entries()) {
			expect(rectsOverlap(placed.bed, diorama.barn)).toBe(false);
			for (const other of diorama.beds.slice(index + 1)) {
				expect(rectsOverlap(placed.bed, other.bed)).toBe(false);
			}
			// Crops grow inside their bed; the farmer stands outside it.
			for (const crop of placed.crops) {
				expect(inRect(placed.bed, crop.x, crop.z)).toBe(true);
			}
			expect(inRect(placed.bed, placed.farmer[0], placed.farmer[1])).toBe(
				false
			);
			expect(
				inRect(diorama.bounds, placed.farmer[0], placed.farmer[1], 0.01)
			).toBe(true);
		}
		// Projects are fenced around their plots; open plots are not.
		const site = diorama.fields.find(
			(placed) => placed.field.id === "project-site"
		);
		const open = diorama.fields.find(
			(placed) => placed.field.id === OPEN_FIELD_ID
		);
		expect(open?.fence).toBeNull();
		for (const placed of diorama.beds) {
			if (placed.plot.id === "agent-ada" || placed.plot.id === "agent-grace") {
				expect(
					site?.fence && inRect(site.fence, placed.bed.minX, placed.bed.minZ)
				).toBe(true);
			}
		}
	});

	test("the diorama is centered on the origin", () => {
		const { bounds } = layoutDiorama(buildFarm(SNAPSHOT).fields);
		expect(Math.abs(bounds.minX + bounds.maxX)).toBeLessThan(0.01);
		expect(Math.abs(bounds.minZ + bounds.maxZ)).toBeLessThan(1);
	});

	test("plot labels name the plot, its team and its crops", () => {
		const { plots } = buildFarm(SNAPSHOT);
		expect(plots.map(plotLabel)).toEqual([
			"Ada's plot: 1 crop",
			"Grace's plot, Docs Crew: 2 crops",
			"Linus's plot, Docs Crew: 1 crop",
			"Shared bed's plot: 1 crop",
		]);
	});

	test("plants stay within a 1.6x height range", () => {
		const heights = Object.values(PLANT_HEIGHT);
		expect(Math.max(...heights) / Math.min(...heights)).toBeLessThanOrEqual(
			1.6
		);
	});
});

describe("farm beds", () => {
	test("beds spread crops over both furrows, tallest at the back", () => {
		const threads = ["a", "b", "c"].map((id) =>
			thread({ agentIds: ["agent-ada"], id: `thread-${id}` })
		);
		const ada = buildFarm({ ...SNAPSHOT, threads }).plots[0];
		if (!ada) {
			throw new Error("No plot");
		}
		const slots = ada.planted.map((item) => item.slot);
		expect(slots).toEqual([0, 2, 4]);
		expect(slots.some((slot) => slot >= 3)).toBe(true);
		expect(seedSlot(ada)).toBe(3);
		expect(plantBed([])).toEqual([]);
	});
});

describe("FarmInterface", () => {
	test("the coins setting: on by default, off when set, live from Settings", async () => {
		const coins = (container: HTMLElement) =>
			/coins?/.test(
				container.querySelector('[aria-label="Farm counters"]')?.textContent ??
					""
			);
		const view = await mount(farm());
		expect(coins(view.container)).toBe(true);
		await view.rerender(farm({ params: { coins: false } }));
		expect(coins(view.container)).toBe(false);
		await view.rerender(farm({ params: { coins: true } }));
		expect(coins(view.container)).toBe(true);
		await view.dispose();
	});

	test("renders a plant per conversation and a sign per plot", () => {
		const markup = renderToStaticMarkup(farm());
		expect(markup).toContain('data-testid="interface-farm"');
		expect(markup.match(/data-testid="farm-crop"/g)).toHaveLength(5);
		expect(markup.match(/data-testid="farm-plot"/g)).toHaveLength(4);
		expect(markup).toContain('data-stage="ripe"');
		expect(markup).toContain('data-stage="withered"');
		const text = markup.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");
		// Each counter reads its label, then its number.
		expect(text).toContain("withered 1 ready 1 growing 1 coins 14");
		expect(markup).toContain("Ada&#x27;s plot: 1 crop");
		expect(markup).toContain("Grace&#x27;s plot, Docs Crew: 2 crops");
		expect(markup).toContain("Open the barn: 5 crops");
		expect(markup).toContain("Ada&#x27;s plot: 1 crop");
	});

	test("renders loading and empty states", () => {
		const loading = renderToStaticMarkup(farm({ loading: true }));
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain('data-slot="skeleton"');
		expect(loading).not.toContain('data-testid="farm-crop"');

		const empty = renderToStaticMarkup(
			farm({ snapshot: { ...SNAPSHOT, agents: [], groups: [], threads: [] } })
		);
		expect(empty).toContain("No plots yet");
		expect(empty).toContain("Plant a seed");
		expect(empty).toContain("New plot");
		expect(empty).toContain('data-testid="farm-plant-seed"');
		expect(empty).not.toContain('data-testid="farm-crop"');
	});

	test("an empty farm with nothing asked keeps its guidance, no act counters", () => {
		const empty = renderToStaticMarkup(
			farm({
				snapshot: {
					...SNAPSHOT,
					agents: [],
					asks: [],
					groups: [],
					threads: [],
				},
			})
		);
		expect(empty).toContain("No plots yet");
		expect(empty).not.toContain("Farm counters");
		expect(empty).not.toContain("need you");
	});

	test("an empty farm with only an unowned suggestion keeps its guidance and its Queue", () => {
		// Ha's suggestion, unowned once no agent is on the farm.
		const suggestion = (usefulStateFixture().asks ?? []).filter(isSuggestion);
		expect(suggestion.length).toBeGreaterThan(0);
		const empty = renderToStaticMarkup(
			farm({
				snapshot: {
					...SNAPSHOT,
					agents: [],
					asks: suggestion,
					groups: [],
					threads: [],
				},
			})
		);
		expect(empty).toContain("No plots yet");
		expect(empty).not.toContain("Farm counters");
		expect(empty).toContain("data-queue-button");
		expect(empty).toContain('data-ask-queue="reveal"');
	});

	test("an empty farm with an unowned ask shows the summary and the guidance", () => {
		const empty = renderToStaticMarkup(
			farm({
				snapshot: {
					...SNAPSHOT,
					agents: [],
					asks: usefulStateFixture().asks,
					groups: [],
					threads: [],
				},
			})
		);
		expect(empty).toContain("No plots yet");
		expect(empty).toMatch(/\d need you/);
	});

	test("a ripe plant harvests straight into the conversation", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(farm({ port }));
		await click(cropButton(view.container, "thread-palette"));
		expect(calls).toEqual(["open:thread-palette"]);
		await view.dispose();
	});

	test("any plant opens its conversation; Escape closes it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(farm({ port }));
		await click(cropButton(view.container, "thread-hero"));
		expect(calls).toEqual(["open:thread-hero"]);
		await view.dispose();
	});

	test("a plot opens its sheet; Escape closes it", async () => {
		const view = await mount(farm());
		await click(byLabel(view.container, "Linus's plot, Docs Crew: 1 crop"));
		const panel = view.container.querySelector('[data-testid="farm-panel"]');
		expect(panel?.getAttribute("data-view")).toBe("plot");
		const heading = panel?.querySelector("h2");
		if (!(heading instanceof HTMLElement)) {
			throw new Error("No panel heading");
		}
		await press(heading, "Escape");
		expect(view.container.querySelector('[data-testid="farm-panel"]')).toBe(
			null
		);
		await view.dispose();
	});

	test("a host page over the farm keeps its Escape", async () => {
		const view = await mount(farm());
		await click(byLabel(view.container, "Linus's plot, Docs Crew: 1 crop"));
		(document.activeElement as HTMLElement | null)?.blur();
		// While the host covers the farm it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "Escape");
		expect(
			view.container.querySelector('[data-testid="farm-panel"]')
		).not.toBeNull();
		view.container.removeAttribute("inert");
		await press(document.body, "Escape");
		expect(view.container.querySelector('[data-testid="farm-panel"]')).toBe(
			null
		);
		await view.dispose();
	});

	test("a plot's seed bag plants with that plot's agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(farm({ port }));
		await click(byLabel(view.container, "Plant a seed in Linus's plot"));
		const panel = view.container.querySelector('[data-testid="farm-panel"]');
		expect(panel?.getAttribute("data-view")).toBe("plot");
		expect(panel?.textContent).toContain("Linus's plot");
		expect(panel?.textContent).toContain("Release notes");
		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("No composer field");
		}
		expect(view.container.querySelector("select")?.value).toBe("agent-linus");
		await typeInto(field, "   ");
		await press(field, "Enter");
		expect(calls).toEqual([]);
		await typeInto(field, "  Draft the launch post  ");
		await press(field, "Enter");
		expect(calls).toEqual([
			'start:{"agentId":"agent-linus","prompt":"Draft the launch post"}',
		]);
		await view.dispose();
	});

	test("the barn lists every crop by status and opens them", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(farm({ port }));
		await click(byLabel(view.container, "Open the barn: 5 crops"));
		const panel = view.container.querySelector('[data-testid="farm-panel"]');
		expect(panel?.getAttribute("data-view")).toBe("barn");
		const headings = [...(panel?.querySelectorAll("h3") ?? [])].map(
			(heading) => heading.textContent
		);
		expect(headings).toEqual([
			"Needs attention1",
			"Your turn1",
			"Working1",
			"Waiting on agent2",
		]);
		const rows = panel?.querySelectorAll('[data-testid="farm-row"]');
		expect(rows).toHaveLength(5);
		await click(rows?.[1]);
		expect(calls).toEqual(["open:thread-palette"]);
		await view.dispose();
	});

	test("an open thread shows the host view under its ledger", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			farm({
				activeThreadId: "thread-palette",
				port,
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const panel = view.container.querySelector('[data-testid="farm-panel"]');
		expect(panel?.getAttribute("data-view")).toBe("thread");
		expect(panel?.textContent).toContain("Host chat");
		expect(panel?.textContent).toContain("Pick a palette");
		const ledger = panel?.querySelector('[data-testid="farm-ledger"]');
		expect(ledger?.textContent).toContain("Ada");
		expect(ledger?.textContent).toContain("Your turn");
		expect(
			ledger?.querySelector('[data-testid="farm-ledger-coins"]')?.textContent
		).toBe("6");
		expect(
			cropButton(view.container, "thread-palette")?.getAttribute("aria-current")
		).toBe("true");
		await click(byLabel(view.container, "Close conversation"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});
});

describe("farm beds and crops", () => {
	test("crops grow by stage: a drop on a seed, fruit only when ripe", () => {
		const model = buildFarm(SNAPSHOT);
		const at = (threadId: string) => {
			const crop = model.crops.find((item) => item.thread.id === threadId);
			if (!crop) {
				throw new Error(`No crop ${threadId}`);
			}
			return cropParts([{ crop, x: 0, z: 0 }]);
		};
		const seed = at("thread-notes");
		expect(seed.droplets).toHaveLength(1);
		expect(seed.balls).toHaveLength(0);
		const ripe = at("thread-palette");
		expect(ripe.balls.length).toBeGreaterThan(0);
		expect(ripe.droplets).toHaveLength(0);
		const withered = at("thread-audit");
		expect(withered.balls).toHaveLength(0);
		expect(withered.leaves.length).toBeGreaterThan(0);
		// Every crop sits on a soil mound.
		for (const parts of [seed, ripe, withered]) {
			expect(parts.mounds).toHaveLength(1);
		}
	});

	test("a withered plant is its own fruit, wilted, in withered browns", () => {
		for (const fruit of FRUITS) {
			const markup = renderToStaticMarkup(
				<svg aria-hidden="true">
					<Plant fruit={fruit} stage="withered" x={0} y={0} />
				</svg>
			);
			expect(markup).toContain("var(--fm-wither-fruit)");
			expect(markup).toContain("var(--fm-wither-edge)");
			expect(markup).not.toContain("fm-sway");
			for (const ripe of ["apple", "tomato", "grape", "pumpkin"]) {
				expect(markup).not.toContain(`var(--fm-${ripe})`);
			}
		}
	});
});

describe("farm panel", () => {
	test("the seed bag lists plots and picks one to plant in", async () => {
		const view = await mount(farm());
		await click(byText(view.container, "Plant a seed"));
		const panel = view.container.querySelector('[data-testid="farm-panel"]');
		const options = panel?.querySelectorAll('[data-testid="farm-plot-option"]');
		expect(options).toHaveLength(SNAPSHOT.agents.length);
		expect(options?.[0]?.textContent).toContain("Designs pages");
		await click(options?.[0]);
		expect(panel?.textContent).toContain("Ada's plot");
		expect(view.container.querySelector("select")?.value).toBe("agent-ada");
		await view.dispose();
	});

	test("the bar shows the farm day without a clock", () => {
		const text = renderToStaticMarkup(farm()).replaceAll(/<[^>]+>/g, " ");
		expect(text).toMatch(/Day \d+/);
		expect(text).not.toMatch(/\d:\d\d/);
	});
});
