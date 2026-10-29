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
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { agentActs } = await import("@ryuhq/protocol/interfaces");
const { AquariumInterface } = await import("./aquarium-interface.tsx");
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

function tank(snapshot: InterfaceSnapshot) {
	return (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			<AquariumInterface
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
const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
const ADA =
	"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run.";
const rows = (container: HTMLElement) => [
	...container.querySelectorAll<HTMLButtonElement>(
		"[aria-label='Agents in the tank'] [data-act-agent]"
	),
];

describe("aquarium useful state", () => {
	test("15c: Ada's tank button is named by her act and answers her ask", async () => {
		const view = await mount(tank(fixture));
		const ada = rows(view.container).find(
			(row) => row.dataset.actAgent === "ada"
		);
		expect(ada?.getAttribute("aria-label")).toBe(`${ADA} Answer their ask.`);
		expect(ada?.hasAttribute("aria-expanded")).toBe(false);
		expect(ada?.hasAttribute("aria-controls")).toBe(false);
		await click(ada);
		await flush();
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		await view.dispose();
	});

	test("21: the DOM holds the queue's buttons and one named row per agent", async () => {
		const view = await mount(tank(fixture));
		const listed = rows(view.container);
		expect(listed.map((row) => row.dataset.actAgent).sort()).toEqual(
			[...acts.keys()].sort()
		);
		for (const row of listed) {
			const act = acts.get(row.dataset.actAgent ?? "");
			expect(row.getAttribute("aria-label")).toStartWith(
				act?.ariaLabel ?? "missing"
			);
			expect(row.tabIndex).toBe(0);
		}
		const queue = [
			...view.container.querySelectorAll<HTMLElement>(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].map((item) => item.getAttribute("aria-label") ?? "");
		for (const start of [
			"Bo asks",
			"Ada asks",
			"Di stopped: Tests failed",
			"Ed stopped",
			"Di stopped: Nightly backup failed",
			"Ha suggests",
		]) {
			expect(queue.some((label) => label.startsWith(start))).toBe(true);
		}
		// The unowned gate and both unread answers are reachable too.
		const items = [
			...view.container.querySelectorAll<HTMLElement>(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		];
		expect(items).toHaveLength(9);
		for (const name of ["Gu", "Ju"]) {
			expect(
				items.some((item) =>
					(item.getAttribute("aria-label") ?? "").startsWith(name)
				)
			).toBe(true);
		}
		expect(view.container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		expect(
			view.container.querySelector("[data-queue-button]")?.textContent
		).toBe("Queue · 9");
		// Starting a thread stays one tap away with acts on.
		expect(
			[...view.container.querySelectorAll("button")].some(
				(button) =>
					button.getAttribute("aria-label") === "New thread" ||
					button.textContent === "New thread"
			)
		).toBe(true);
		await view.dispose();
	});

	test("rows are described by the act; their buttons open the cards", async () => {
		const view = await mount(tank(fixture));
		const row = (id: string) =>
			rows(view.container).find((item) => item.dataset.actAgent === id);
		const ada = row("ada");
		expect(
			document.getElementById(ada?.getAttribute("aria-describedby") ?? "")
				?.textContent
		).toBe(ADA);
		const buttonsOf = (id: string, text: string) =>
			[...(row(id)?.closest("li")?.querySelectorAll("button") ?? [])].filter(
				(button) => button.textContent === text
			);
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
		await click(buttonsOf("ada", "Answer")[0]);
		await flush();
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		await closeCard();
		await click(buttonsOf("gu", "Open answer")[0]);
		await flush();
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Edited 3 files"
		);
		await closeCard();
		const details = buttonsOf("di", "Details");
		expect(details).toHaveLength(2);
		await click(details[1]);
		await flush();
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup failed");
		await closeCard();
		const queue = view.container.querySelector("[data-queue-button]");
		expect(queue?.closest(".sr-only")).toBeNull();
		await view.dispose();
	});

	test("without asks the creatures, summary and counters are today's", async () => {
		const { asks: _asks, ...legacy } = fixture;
		const view = await mount(tank(legacy));
		expect(view.container.querySelector("[data-act-agent]")).toBeNull();
		expect(view.container.querySelector("[data-agent-list]")).toBeNull();
		// Today's rows: named by the creature, with no act description.
		const legacyRow = view.container.querySelector<HTMLElement>(
			"[aria-label='Agents in the tank'] button[data-agent-id='ada']"
		);
		expect(legacyRow?.hasAttribute("aria-describedby")).toBe(false);
		expect(legacyRow?.getAttribute("aria-expanded")).toBe("false");
		// Today's summary and counters.
		expect(
			view.container.querySelector("[data-testid='aquarium-summary']")
				?.textContent
		).toMatch(/^10 agents · \d+ working/);
		expect(view.container.textContent).toContain("waiting on you");
		expect(view.container.querySelector("[data-queue-button]")).toBeNull();
		expect(
			view.container.querySelector("[aria-label='New thread']") ??
				[...view.container.querySelectorAll("button")].find(
					(button) => button.textContent === "New thread"
				)
		).toBeTruthy();
		await view.dispose();
	});
});
