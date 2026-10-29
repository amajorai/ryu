import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { InterfacePort } from "@ryuhq/protocol/interfaces";
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
const { kitchenPaths } = await import("./kitchen-acts.tsx");
const { KitchenInterface } = await import("./kitchen-interface.tsx");
const {
	actTickets,
	askPatience,
	buildService,
	READY_PATIENCE_MS,
	STATIONS_PER_ROW,
} = await import("./kitchen-model.ts");
const { agentActs } = await import("@ryuhq/protocol/interfaces");
const { ActClockProvider } = await import("./use-acts.ts");

const MINUTE = 60_000;
const NOW = FIXTURE_NOW;

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

const port: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

function props(
	overrides: Partial<Parameters<typeof KitchenInterface>[0]> = {}
): Parameters<typeof KitchenInterface>[0] {
	return {
		activeThreadId: null,
		loading: false,
		params: {},
		port,
		snapshot: usefulStateFixture(),
		threadView: null,
		...overrides,
	};
}

describe("kitchen useful state", () => {
	const fixture = usefulStateFixture();
	const inClock = (element: ReactElement) => (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			{element}
		</ActClockProvider>
	);
	const line = (container: HTMLElement) =>
		container.querySelector<HTMLElement>("[aria-label='The line']");
	const rowOf = (container: HTMLElement, name: string) =>
		[...(line(container)?.querySelectorAll("li") ?? [])].find((row) =>
			row.querySelector("button")?.textContent?.includes(name)
		);
	const card = () => document.querySelector("[data-ask-card]");
	const flush = (ms = 40) =>
		act(async () => {
			await new Promise((resolve) => setTimeout(resolve, ms));
		});
	const open = async (element: Element | null | undefined) => {
		await click(element);
		await flush();
	};
	const closeCard = async () => {
		await click(
			[
				...document.querySelectorAll(
					"[data-ask-card] button, [data-blocker-card] button"
				),
			].find((button) => button.textContent === "Close")
		);
		await flush(80);
	};

	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const view = await mount(
				inClock(<KitchenInterface {...props({ snapshot: fixture })} />)
			);
			await view.dispose();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("agent rows are described by act.ariaLabel; the HUD sums the acts", async () => {
		const view = await mount(
			inClock(<KitchenInterface {...props({ snapshot: fixture })} />)
		);
		const ada = rowOf(view.container, "Ada")?.querySelector("button");
		const described = document.getElementById(
			ada?.getAttribute("aria-describedby") ?? ""
		);
		expect(described?.textContent).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		expect(view.container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		const queue = view.container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
		const suggestion = [
			...view.container.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].find((button) =>
			button.getAttribute("aria-label")?.startsWith("Ha suggests:")
		);
		expect(suggestion).toBeDefined();
		await view.dispose();
	});

	test("Ada's row Answer, Gu's Open answer and Di's second Details open their cards", async () => {
		const view = await mount(
			inClock(<KitchenInterface {...props({ snapshot: fixture })} />)
		);
		const adaRow = rowOf(view.container, "Ada");
		await open(
			[...(adaRow?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent === "Answer"
			)
		);
		expect(card()?.textContent).toContain("Can I run shell.run now?");
		await closeCard();
		const guRow = rowOf(view.container, "Gu");
		await open(
			[...(guRow?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent === "Open answer"
			)
		);
		expect(card()?.textContent).toContain("Edited 3 files");
		await closeCard();
		const details = [
			...(rowOf(view.container, "Di")?.querySelectorAll("button") ?? []),
		].filter((button) => button.textContent === "Details");
		expect(details).toHaveLength(2);
		expect(details[1]?.getAttribute("data-blocker-thread")).toBe(
			FIXTURE_THREAD_IDS.diNightly
		);
		await open(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup failed");
		await view.dispose();
	});

	test("without asks the rows and counters are today's", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		const view = await mount(
			inClock(<KitchenInterface {...props({ snapshot: oldHost })} />)
		);
		expect(view.container.querySelector("[data-act-status]")).toBeNull();
		expect(view.container.querySelector("[data-ask-queue]")).toBeNull();
		expect(view.container.querySelector("[data-queue-button]")).toBeNull();
		expect(view.container.textContent).not.toContain("need you");
		expect(view.container.textContent).toContain("Served today");
		expect(view.container.textContent).toContain("Ready");
		await view.dispose();
	});

	test("closing a card whose ask was answered elsewhere focuses the Orders heading", async () => {
		const single = usefulStateFixture({ agents: ["ada"] });
		const adaOnly = {
			...single,
			asks: (single.asks ?? []).filter((ask) => ask.agentId === "ada"),
		};
		const view = await mount(
			inClock(<KitchenInterface {...props({ snapshot: adaOnly })} />)
		);
		await open(view.container.querySelector("[data-need-you]"));
		expect(card()?.textContent).toContain("Can I run shell.run now?");
		await view.rerender(
			inClock(
				<KitchenInterface {...props({ snapshot: { ...adaOnly, asks: [] } })} />
			)
		);
		await flush();
		expect(card()?.textContent).toContain("No longer waiting");
		await closeCard();
		expect(document.activeElement?.textContent).toMatch(/^Orders/);
		await view.dispose();
	});

	test("the pass holds the you-spot: four slots, a tray, all reachable", () => {
		const service = buildService(fixture, FIXTURE_NOW, STATIONS_PER_ROW);
		const paths = kitchenPaths(service, 0, 0.16);
		for (const point of ["you", ...YOU_SLOTS, "you-tray"]) {
			expect(paths.points[point]).toBeDefined();
		}
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
		for (const station of service.stations) {
			expect(seen.has(`station-${station.index}`)).toBe(true);
		}
		expect(seen.has("you-tray")).toBe(true);
	});

	test("a ticket's patience drains from its ask, toward its deadline", () => {
		const since = new Date(NOW - 3 * MINUTE).toISOString();
		const base = {
			blocking: true,
			id: "q",
			kind: "question" as const,
			source: "messages" as const,
			text: "Which DB to use?",
			threadId: "t",
			agentId: "a",
		};
		expect(
			askPatience(
				{ ...base, expiresAt: new Date(NOW + 7 * MINUTE).toISOString(), since },
				NOW
			)
		).toBeCloseTo(0.7);
		expect(askPatience({ ...base, since }, NOW)).toBeCloseTo(
			1 - (3 * MINUTE) / READY_PATIENCE_MS
		);
		expect(askPatience({ ...base, since: null }, NOW)).toBeNull();
	});

	test("the rail comes from the acts: asks first in ask order, no last-update ages", async () => {
		const view = await mount(
			inClock(<KitchenInterface {...props({ snapshot: fixture })} />)
		);
		const tickets = [
			...view.container.querySelectorAll<HTMLElement>(
				"[aria-label='Tickets'] button"
			),
		].map((button) => button.getAttribute("aria-label") ?? "");
		expect(tickets[0]).toMatch(/: Needs you, Bo$/);
		expect(tickets[1]).toMatch(/: Needs you, Ada$/);
		// Ha is idle: no ticket; no ticket speaks a last-update age.
		expect(tickets.some((label) => label.includes(", Ha"))).toBe(false);
		expect(tickets.some((label) => /updated|ago/.test(label))).toBe(false);
		const cy = tickets.find((label) => label.includes(", Cy"));
		expect(cy).toMatch(/: Cooking, Cy, running 12m$/);
		const io = tickets.find((label) => label.includes(", Io"));
		expect(io).toMatch(/: Cooking, Io$/);
		expect(view.container.querySelector("p.sr-only")?.textContent).toBe(
			"Kitchen: 3 need you · 2 working · 1 failed · 1 limited."
		);
		await view.dispose();
	});
	test("stopped tickets survive a new snapshot with the same acts (matched by value)", () => {
		const acts = agentActs(fixture, NOW, FIXTURE_CLOCK);
		const next = structuredClone(fixture);
		const { views } = actTickets(next, acts, NOW);
		for (const id of ["t-di", "t-di-nightly", "t-ed"]) {
			expect(views.get(id)?.rank).toBe(1);
		}
		expect(views.get("t-di")?.state).toBe("burnt");
		expect(views.get("t-ed")?.label).toBe("Pulled");
	});

	test("a rate-limited ticket reads 86'd, never burnt", () => {
		const limited = usefulStateFixture();
		limited.threads = limited.threads.map((thread) =>
			thread.id === "t-di" && thread.blocker
				? {
						...thread,
						blocker: {
							...thread.blocker,
							clearsAt: new Date(NOW + 30 * MINUTE).toISOString(),
							kind: "rate-limited" as const,
							title: "Limit hit",
						},
					}
				: thread
		);
		const acts = agentActs(limited, NOW, FIXTURE_CLOCK);
		const view = actTickets(limited, acts, NOW).views.get("t-di");
		expect(view?.label).toBe("86'd");
		expect(view?.state).toBe("limited");
	});
});
