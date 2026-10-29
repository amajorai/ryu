import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";

// Register the DOM before React and the UI load: portals (the ask card's
// dialog) only mount when the DOM exists at import time.
const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (!("getAnimations" in Element.prototype)) {
	Reflect.set(Element.prototype, "getAnimations", () => []);
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { FIXTURE_CLOCK, FIXTURE_NOW, FIXTURE_THREAD_IDS, usefulStateFixture } =
	await import("./game-acts-fixture.ts");
const { agentActs, THREAD_STATUS_LABELS } = await import(
	"@ryuhq/protocol/interfaces"
);
const { overripeReplies } = await import("./farm-acts.tsx");
const { YOU_SLOTS } = await import("./game3d-acts.ts");
const { farmPaths, growFocusCrops } = await import("./farm-acts.tsx");
const { FarmInterface } = await import("./farm-interface.tsx");
const { buildFarm, cropHeight, GROWING_SCALE, layoutDiorama, PLANT_HEIGHT } =
	await import("./farm-model.ts");
const { ActClockProvider } = await import("./use-acts.ts");

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

const flush = (ms = 40) =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});

const port: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

function farm(snapshot: InterfaceSnapshot) {
	return (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			<FarmInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={snapshot}
				threadView={null}
			/>
		</ActClockProvider>
	);
}

const fixture = usefulStateFixture();
const list = (container: HTMLElement) =>
	container.querySelector<HTMLElement>("[data-testid='farm-list']");
const rowOf = (container: HTMLElement, name: string) =>
	[...(list(container)?.querySelectorAll("li") ?? [])].find(
		(row) =>
			row.querySelector("[data-testid='farm-plot']")?.textContent === name
	);
const buttonIn = (row: Element | undefined, text: string) =>
	[...(row?.querySelectorAll("button") ?? [])].filter(
		(button) => button.textContent === text
	);
const card = () => document.querySelector("[data-ask-card]");
async function closeCard() {
	await click(
		[
			...document.querySelectorAll(
				"[data-ask-card] button, [data-blocker-card] button"
			),
		].find((button) => button.textContent === "Close")
	);
	await flush(80);
}

describe("farm useful state", () => {
	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const view = await mount(farm(fixture));
			await view.dispose();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("plot rows are described by act.ariaLabel; the HUD sums the acts", async () => {
		const view = await mount(farm(fixture));
		const ada = rowOf(view.container, "Ada")?.querySelector(
			"[data-testid='farm-plot']"
		);
		expect(
			document.getElementById(ada?.getAttribute("aria-describedby") ?? "")
				?.textContent
		).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		expect(view.container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		const queue = view.container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
		expect(
			[
				...view.container.querySelectorAll(
					"[data-ask-queue='reveal'] [data-ask-queue-item]"
				),
			].some((button) =>
				button.getAttribute("aria-label")?.startsWith("Ha suggests:")
			)
		).toBe(true);
		await view.dispose();
	});

	test("Ada's Answer, Gu's Open answer and Di's second Details open their cards", async () => {
		const view = await mount(farm(fixture));
		await click(buttonIn(rowOf(view.container, "Ada"), "Answer")[0]);
		await flush();
		expect(card()?.textContent).toContain("Can I run shell.run now?");
		await closeCard();
		await click(buttonIn(rowOf(view.container, "Gu"), "Open answer")[0]);
		await flush();
		expect(card()?.textContent).toContain("Edited 3 files");
		await closeCard();
		const details = buttonIn(rowOf(view.container, "Di"), "Details");
		expect(details).toHaveLength(2);
		expect(details[1]?.getAttribute("data-blocker-thread")).toBe(
			FIXTURE_THREAD_IDS.diNightly
		);
		await click(details[1]);
		await flush();
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup failed");
		await closeCard();
		await view.dispose();
	});

	test("Escape in the ask card closes only the card; the plot panel stays", async () => {
		const view = await mount(farm(fixture));
		await click(
			rowOf(view.container, "Cy")?.querySelector("[data-testid='farm-plot']")
		);
		const panel = () =>
			view.container.querySelector('[data-testid="farm-panel"]');
		expect(panel()?.getAttribute("data-view")).toBe("plot");
		await click(view.container.querySelector("[data-need-you]"));
		await flush();
		const inCard = card()?.querySelector("button");
		if (!(inCard instanceof HTMLElement)) {
			throw new Error("No card button");
		}
		await act(async () => {
			inCard.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		await flush(120);
		expect(card()).toBeNull();
		expect(panel()?.getAttribute("data-view")).toBe("plot");
		await view.dispose();
	});

	test("a new ripe crop still speaks in the farm's region; acts speak in the announcer", async () => {
		const view = await mount(farm(fixture));
		const gu = fixture.threads.find(
			(thread) => thread.id === FIXTURE_THREAD_IDS.gu
		);
		if (!gu) {
			throw new Error("No Gu thread");
		}
		await view.rerender(
			farm({
				...fixture,
				threads: [...fixture.threads, { ...gu, id: "t-gu-2" }],
			})
		);
		await flush();
		const regions = [
			...view.container.querySelectorAll("[aria-live='polite']"),
		];
		const announcer = view.container.querySelector("[data-act-announcer]");
		expect(announcer).not.toBeNull();
		const farmRegion = regions.find((region) => region !== announcer);
		expect(farmRegion?.textContent).toContain("ready to harvest");
		expect(announcer?.textContent ?? "").not.toContain("ready to harvest");
		await view.dispose();
	});

	test("the barn drops the legacy status headings: it groups by plot", async () => {
		const view = await mount(farm(fixture));
		await click(
			[...view.container.querySelectorAll("button")].find((button) =>
				button.getAttribute("aria-label")?.startsWith("Barn")
			)
		);
		await flush();
		const headings = [
			...document.querySelectorAll<HTMLElement>("h3[id^='farm-barn-']"),
		].map((heading) => heading.firstChild?.textContent ?? "");
		expect(headings.length).toBeGreaterThan(0);
		const legacy = new Set<string>(Object.values(THREAD_STATUS_LABELS));
		for (const heading of headings) {
			expect(legacy.has(heading)).toBe(false);
		}
		await view.dispose();
	});

	test("without asks the plots and counters are today's", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		const view = await mount(farm(oldHost));
		expect(view.container.querySelector("[data-act-status]")).toBeNull();
		expect(view.container.querySelector("[data-ask-queue]")).toBeNull();
		expect(view.container.querySelector("[data-queue-button]")).toBeNull();
		expect(view.container.textContent).not.toContain("need you");
		// Today's words: the day and harvest status, crop counters, crop sentence.
		expect(view.container.textContent).toMatch(/Day \d+/);
		const counters = view.container.querySelector(
			"[aria-label='Farm counters']"
		);
		expect(counters?.textContent).toContain("growing");
		expect(counters?.textContent).not.toContain("working");
		expect(
			[...view.container.querySelectorAll("p.sr-only")].some((p) =>
				/^Farm: \d+ plots?, \d+ ready to harvest/.test(p.textContent ?? "")
			)
		).toBe(true);
		await view.dispose();
	});

	test("asks with no farmers yet still open the act layer (the gate's queue)", async () => {
		const empty = { ...fixture, agents: [], threads: [] };
		const view = await mount(farm(empty));
		expect(view.container.querySelector("[data-queue-button]")).not.toBeNull();
		expect(view.container.textContent).toContain("need you");
		await view.dispose();
	});

	test("an unread answer over-ripens its crop by how long it waited", () => {
		const fallen = overripeReplies(fixture.asks, FIXTURE_NOW);
		// Gu's and Ju's replies are waiting: their crops drop fruit; none else.
		expect([...fallen.keys()].sort()).toEqual(
			[FIXTURE_THREAD_IDS.gu, FIXTURE_THREAD_IDS.ju].sort()
		);
		const later = overripeReplies(fixture.asks, FIXTURE_NOW + 3 * 3_600_000);
		for (const [id, count] of fallen) {
			expect(later.get(id) ?? 0).toBeGreaterThanOrEqual(count);
		}
		expect(Math.max(...later.values())).toBeGreaterThan(0);
	});

	test("the gate holds four slots and the tray; every farmer reaches them", () => {
		const diorama = layoutDiorama(buildFarm(fixture).fields);
		const paths = farmPaths(diorama);
		const neighbours = new Map<string, string[]>();
		for (const [a, b] of paths.links) {
			neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
			neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
		}
		const seen = new Set(["you"]);
		const queue = ["you"];
		while (queue.length > 0) {
			for (const next of neighbours.get(queue.shift() ?? "") ?? []) {
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
			}
		}
		for (const point of [
			...YOU_SLOTS,
			"you-tray",
			"bench-0",
			"bench-1",
			"bench-2",
		]) {
			expect(seen.has(point)).toBe(true);
		}
		for (const placed of diorama.beds) {
			if (placed.plot.agent) {
				expect(seen.has(`farmer-${placed.plot.agent.id}`)).toBe(true);
			}
		}
	});

	test("the focus crop grows to its plan's steps (or the estimate); others keep their size", () => {
		const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
		const fields = growFocusCrops(buildFarm(fixture).fields, acts);
		const crops = fields.flatMap((field) =>
			field.plots.flatMap((plot) => plot.crops)
		);
		const cy = crops.find((crop) => crop.thread.id === FIXTURE_THREAD_IDS.cy);
		expect(cy?.growth).toBeCloseTo(3 / 7);
		// Io's run has only an estimate: the guess still grows its crop.
		const io = crops.find((crop) => crop.thread.id === FIXTURE_THREAD_IDS.io);
		const ioAct = acts.get("io");
		expect(ioAct?.progress?.kind).toBe("estimate");
		expect(io?.growth).toBeCloseTo(
			(ioAct?.progress?.done ?? 0) / (ioAct?.progress?.total ?? 1),
			1
		);
		const quiet = crops.find(
			(crop) => crop.thread.id === FIXTURE_THREAD_IDS.ha
		);
		expect(quiet?.growth).toBeUndefined();
		if (cy) {
			const full = PLANT_HEIGHT[cy.fruit];
			expect(cropHeight({ ...cy, stage: "growing" })).toBeLessThan(
				full * GROWING_SCALE
			);
			expect(
				cropHeight({ ...cy, growth: 1, stage: "growing" })
			).toBeGreaterThan(full * GROWING_SCALE);
		}
	});
});
