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
const { agentActs, threadStatus } = await import("@ryuhq/protocol/interfaces");
const { YOU_SLOTS } = await import("./game3d-acts.ts");
const { coffeeSpots, doorSpots, officePaths, restsAtCoffee, screenActivity } =
	await import("./workers-acts.tsx");
const { ACT_SPREAD } = await import("./workers-model.ts");
const { WorkersInterface } = await import("./workers-interface.tsx");
const { buildWorkers, layoutOffice } = await import("./workers-model.ts");
const { ActClockProvider } = await import("./use-acts.ts");
const { actScreenWords } = await import("./workers-diorama.tsx");
const { resolveInterfaceParams } = await import("@ryuhq/protocol/interfaces");

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

function office(snapshot: InterfaceSnapshot) {
	return (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			<WorkersInterface
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
const desks = (container: HTMLElement) =>
	container.querySelector<HTMLElement>("[aria-label='Desks']");
const rowOf = (container: HTMLElement, name: string) =>
	[...(desks(container)?.querySelectorAll("li") ?? [])].find(
		(row) =>
			row.querySelector("[data-testid='workers-desk']")?.textContent === name
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

describe("workers useful state", () => {
	test("the screen plates setting: the step by default, the task's title when set", () => {
		expect(resolveInterfaceParams("workers", {})).toMatchObject({
			screenWords: "step",
		});
		expect(
			resolveInterfaceParams("workers", { screenWords: "title" })
		).toMatchObject({ screenWords: "title" });
		const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
		const worker = buildWorkers(fixture).find(
			(candidate) =>
				candidate.current !== null && acts.get(candidate.id)?.act === "working"
		);
		const act = worker ? acts.get(worker.id) : undefined;
		if (!(worker && act)) {
			throw new Error("Expected a working worker with a task");
		}
		expect(actScreenWords(worker, act)).toBe(screenActivity(act));
		expect(actScreenWords(worker, act, "title")).not.toBe(screenActivity(act));
		expect(actScreenWords(worker, act, "title")).toBe(
			actScreenWords(worker, { ...act, act: "idle", stalled: false })
		);
	});

	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const view = await mount(office(fixture));
			await view.dispose();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("desk rows are described by act.ariaLabel; the HUD counts come from the acts", async () => {
		const view = await mount(office(fixture));
		const ada = rowOf(view.container, "Ada")?.querySelector(
			"[data-testid='workers-desk']"
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
		const counters = view.container.querySelector(
			"[aria-label='Worker counters']"
		);
		expect(counters?.textContent).toBe("need you3working2failed1");
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
		const view = await mount(office(fixture));
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

	test("13c: an old host announces newly waiting workers; once acts arrive that is cleared for the act announcer", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		// Fewer workers waiting first: keep only running and quiet threads.
		const calmer = {
			...oldHost,
			threads: oldHost.threads.filter((thread) =>
				["quiet", "working"].includes(threadStatus(thread))
			),
		};
		const polite = (container: HTMLElement) =>
			[
				...container.querySelectorAll(
					"[aria-live='polite']:not([data-act-announcer])"
				),
			].map((region) => region.textContent ?? "");
		const view = await mount(office(calmer));
		await view.rerender(office(oldHost));
		await flush(120);
		// The old host's own announcement fires (so this test can fail).
		expect(
			polite(view.container).some((text) =>
				/\d+ workers? waiting on you/.test(text)
			)
		).toBe(true);
		await view.rerender(office(fixture));
		await flush(120);
		expect(
			polite(view.container).some((text) => /waiting on you/.test(text))
		).toBe(false);
		const announcer = view.container.querySelector("[data-act-announcer]");
		expect(announcer).not.toBeNull();
		await view.dispose();
	});

	test("without asks the desks and counters are today's", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		const view = await mount(office(oldHost));
		expect(view.container.querySelector("[data-act-status]")).toBeNull();
		expect(view.container.querySelector("[data-ask-queue]")).toBeNull();
		expect(view.container.querySelector("[data-queue-button]")).toBeNull();
		expect(view.container.textContent).not.toContain("need you");
		const ada = rowOf(view.container, "Ada")?.querySelector(
			"[data-testid='workers-desk']"
		);
		expect(ada?.getAttribute("aria-describedby")).toBeNull();
		await view.dispose();
	});

	test("each row says its activity at most once, with no state word against the act", async () => {
		const view = await mount(office(fixture));
		const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
		for (const id of acts.keys()) {
			const act = acts.get(id);
			const row = view.container
				.querySelector(`[data-testid='workers-desk'][data-worker-id='${id}']`)
				?.closest("li");
			expect(row).toBeTruthy();
			// What the row shows (its sr-only act description aside).
			const shown = row?.cloneNode(true) as HTMLElement | undefined;
			for (const hidden of shown?.querySelectorAll(".sr-only, [hidden]") ??
				[]) {
				hidden.remove();
			}
			const text = shown?.textContent ?? "";
			const activity = act ? screenActivity(act) : "missing";
			// The act line says it (at most once); the screen names the task.
			expect(text.split(activity).length - 1).toBeLessThanOrEqual(1);
			expect(row?.querySelector("[data-act-status]")).not.toBeNull();
			// The screen button's name holds what it shows.
			const screen = row?.querySelector<HTMLElement>(
				"[data-testid='workers-screen']"
			);
			if (screen) {
				expect(screen.getAttribute("aria-label") ?? "").toContain(
					screen.textContent ?? "missing"
				);
			}
			expect(text).not.toContain("Idle");
		}
		await view.dispose();
	});

	test("the door holds four queue slots and the tray; every desk reaches them", () => {
		const plan = layoutOffice(buildWorkers(fixture));
		const chairs = new Map(
			plan.desks.map((desk) => [
				desk.worker.id,
				[desk.x, 0.4, desk.z + 0.5] as [number, number, number],
			])
		);
		const paths = officePaths(plan, chairs, 0.16);
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
		for (const point of [...YOU_SLOTS, "you-tray", "coffee-0"]) {
			expect(seen.has(point)).toBe(true);
		}
		for (const desk of plan.desks) {
			expect(seen.has(`desk-${desk.worker.id}`)).toBe(true);
		}
		expect(coffeeSpots(plan, 0)).toHaveLength(4);
	});

	test("a limited worker rests in the coffee corner; a busy one does not", () => {
		const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
		expect(restsAtCoffee(acts.get("fa") as never)).toBe(true);
		expect(restsAtCoffee(acts.get("cy") as never)).toBe(false);
		expect(restsAtCoffee(acts.get("ju") as never)).toBe(false);
	});
});

describe("workers door queue", () => {
	for (const count of [1, 2, 4, 10]) {
		test(`with ${count} worker(s) the slots, tray, door and door-front stay inside the room`, () => {
			const workers = buildWorkers(fixture).slice(0, count);
			const plan = layoutOffice(workers, ACT_SPREAD);
			const door = doorSpots(plan, 0.16);
			const paths = officePaths(plan, new Map(), 0.16);
			const margin = 0.3;
			const points = [
				...door.slots,
				door.tray,
				door.you,
				paths.points["door-front"],
			];
			for (const point of points) {
				expect(point).toBeDefined();
				const [x, , z] = point ?? [0, 0, 0];
				expect(Math.abs(x)).toBeLessThanOrEqual(plan.halfWidth - margin);
				expect(Math.abs(z)).toBeLessThanOrEqual(plan.halfDepth - margin);
			}
		});
	}
});
