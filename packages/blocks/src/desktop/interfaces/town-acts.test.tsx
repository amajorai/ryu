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
const { YOU_SLOTS } = await import("./game3d-acts.ts");
const { townPaths } = await import("./town-acts.tsx");
const { TownInterface } = await import("./town-interface.tsx");
const { actHappiness, buildTown } = await import("./town-model.ts");
const { ActClockProvider } = await import("./use-acts.ts");

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	await flush();
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

async function flush(ms = 40) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

const opened: string[] = [];
const port: InterfacePort = {
	closeThread: () => undefined,
	openThread: (id) => {
		opened.push(id);
	},
	startThread: () => undefined,
};

function town(snapshot: InterfaceSnapshot) {
	return (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			<TownInterface
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
const ADA =
	"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run.";
const buildingOf = (container: HTMLElement, agentId: string) =>
	container.querySelector<HTMLElement>(`button[data-act-agent='${agentId}']`);
const rowOf = (container: HTMLElement, agentId: string) =>
	buildingOf(container, agentId)?.closest("li") ?? undefined;
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

describe("town useful state", () => {
	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const view = await mount(town(fixture));
			await view.dispose();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("building buttons are named by the act: Cy's opens its card, Ada's answers", async () => {
		const view = await mount(town(fixture));
		expect(view.container.textContent).toContain("The 3D town needs WebGL");
		const cy = buildingOf(view.container, "cy");
		expect(cy?.getAttribute("aria-label")).toMatch(
			/^Cy is editing snapshot\.ts, .* Open its card\.$/
		);
		expect(cy?.hasAttribute("aria-pressed")).toBe(false);
		const ada = buildingOf(view.container, "ada");
		expect(ada?.getAttribute("aria-label")).toBe(`${ADA} Answer their ask.`);
		expect(ada?.hasAttribute("aria-pressed")).toBe(false);
		expect(
			document.getElementById(ada?.getAttribute("aria-describedby") ?? "")
				?.textContent
		).toBe(ADA);
		await click(ada);
		await flush();
		expect(card()?.textContent).toContain("Can I run shell.run now?");
		await closeCard();
		expect(
			view.container.querySelector(
				"[data-iso-target][tabindex='0'][data-act-agent]"
			)
		).toBeNull();
		await view.dispose();
	});

	test("the HUD sums the acts; the Queue lists Ha's suggestion", async () => {
		const view = await mount(town(fixture));
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
		const view = await mount(town(fixture));
		await click(buttonIn(rowOf(view.container, "ada"), "Answer")[0]);
		await flush();
		expect(card()?.textContent).toContain("Can I run shell.run now?");
		await closeCard();
		await click(buttonIn(rowOf(view.container, "gu"), "Open answer")[0]);
		await flush();
		expect(card()?.textContent).toContain("Edited 3 files");
		await closeCard();
		const details = buttonIn(rowOf(view.container, "di"), "Details");
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

	test("closing a card whose ask was answered elsewhere focuses the Town heading", async () => {
		const single = usefulStateFixture({ agents: ["ada"] });
		const adaOnly = {
			...single,
			asks: (single.asks ?? []).filter((ask) => ask.agentId === "ada"),
		};
		const view = await mount(town(adaOnly));
		await click(view.container.querySelector("[data-need-you]"));
		await flush();
		expect(card()?.textContent).toContain("Can I run shell.run now?");
		await view.rerender(town({ ...adaOnly, asks: [] }));
		await flush();
		expect(card()?.textContent).toContain("No longer waiting");
		await closeCard();
		expect(document.activeElement?.tagName).toBe("H1");
		expect(document.activeElement?.textContent).toBe("Town");
		await view.dispose();
	});

	test("without asks the directory and counters are today's", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		const view = await mount(town(oldHost));
		expect(view.container.querySelector("[data-act-status]")).toBeNull();
		expect(view.container.querySelector("[data-act-agent]")).toBeNull();
		expect(view.container.querySelector("[data-queue-button]")).toBeNull();
		expect(view.container.textContent).not.toContain("need you");
		await view.dispose();
	});

	test("every door reaches City Hall's steps and inbox", () => {
		const built = buildTown(fixture, FIXTURE_NOW);
		const paths = townPaths(built);
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
		for (const point of [...YOU_SLOTS, "you-tray"]) {
			expect(seen.has(point)).toBe(true);
		}
		for (const building of built.buildings) {
			expect(seen.has(`door-${building.agent.id}`)).toBe(true);
		}
	});

	test("happiness falls with each blocking ask, more the longer it waits", () => {
		expect(actHappiness([], FIXTURE_NOW)).toBe(100);
		const asks = fixture.asks ?? [];
		const happy = actHappiness(asks, FIXTURE_NOW);
		expect(happy).toBeLessThan(100);
		expect(actHappiness(asks, FIXTURE_NOW + 2 * 86_400_000)).toBeLessThan(
			happy
		);
		const suggestionsOnly = asks.filter((ask) => !ask.blocking);
		expect(actHappiness(suggestionsOnly, FIXTURE_NOW)).toBe(100);
	});
});
