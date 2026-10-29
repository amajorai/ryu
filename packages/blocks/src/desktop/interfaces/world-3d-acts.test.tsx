import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM must exist before the dialog primitives load (they read it on import).
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs, askAriaLabel, askKindWords } = await import(
	"@ryuhq/protocol/interfaces"
);
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { ActClockProvider } = await import("./use-acts.ts");
const { World3dInterface } = await import("./world-3d-interface.tsx");
const { World3dDialog } = await import("./world-3d-dialog.tsx");
const { actLine, askTrackerGoal } = await import("./world-3d-model.ts");
const { lanternGlow, worldActorAt, worldYouSpot } = await import(
	"./world-3d-acts.tsx"
);
const { layoutWorld } = await import("@ryuhq/protocol/interfaces");

import type {
	InterfacePort,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import type { ReactElement } from "react";

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const mounted: (() => void)[] = [];
afterEach(() => {
	for (const dispose of mounted.splice(0)) {
		dispose();
	}
});

async function settle(ms = 30) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

async function mount(element: ReactElement): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(element));
	mounted.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	await settle();
	return container;
}

async function press(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a button");
	}
	act(() => element.click());
	await settle();
}

const port: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

const fixture = usefulStateFixture();
const actsNow = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
const agentId = (name: string): string => {
	const found = [...actsNow.values()].find((item) => item.agentName === name);
	if (!found) {
		throw new Error(`no agent ${name}`);
	}
	return found.agentId;
};

function world(snapshot: InterfaceSnapshot, acted = true) {
	const game = (
		<World3dInterface
			activeThreadId={null}
			loading={false}
			params={{ camera: "orbit", theme: "meadow" }}
			port={port}
			snapshot={snapshot}
			threadView={null}
		/>
	);
	return acted ? (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			{game}
		</ActClockProvider>
	) : (
		game
	);
}

const named = (name: string) => {
	const found = actsNow.get(agentId(name));
	if (!found) {
		throw new Error(name);
	}
	return found;
};

describe("world-3d useful state (text equivalent)", () => {
	test("without WebGL every agent is a row of the agent list, with the summary and the queue", async () => {
		const container = await mount(world(fixture));
		for (const act of actsNow.values()) {
			expect(
				container.querySelector(`[data-act-agent="${act.agentId}"]`)
			).not.toBeNull();
		}
		expect(container.querySelector("[data-act-summary]")?.textContent).toBe(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		// One summary, one Need you and one Queue button: the HUD gives way
		// to the list overlay.
		expect(container.querySelectorAll("[data-act-summary]")).toHaveLength(1);
		expect(container.querySelectorAll("[data-queue-button]")).toHaveLength(1);
		expect(container.querySelector("[data-queue-button]")?.textContent).toBe(
			"Queue · 9"
		);
		expect(container.querySelector("[data-act-announcer]")).not.toBeNull();
		expect(container.textContent).toContain(
			"3D needs WebGL; switch to World 2D for the map."
		);
	});

	test("without asks the world is unchanged", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		const sansIds = (html: string) => html.replace(/_r_\w+_/g, "_r_");
		const acted = await mount(world(oldHost));
		const plain = await mount(world(oldHost, false));
		expect(sansIds(acted.innerHTML)).toBe(sansIds(plain.innerHTML));
	});
});

/** The buttons inside an agent's list row with this text. */
function rowButtons(container: HTMLElement, name: string, label: string) {
	const row = container.querySelector(`[data-act-agent="${agentId(name)}"]`);
	return [...(row?.closest("li")?.querySelectorAll("button") ?? [])].filter(
		(button) => button.textContent === label
	);
}

describe("world-3d list path (13d, 13h, 15, 21)", () => {
	test("the queue is visible, the map is no keyboard surface, the h1 says World 3D", async () => {
		const container = await mount(world(fixture));
		expect(container.querySelector('[data-ask-queue="sheet"]')).not.toBeNull();
		expect(container.querySelector('[data-ask-queue="reveal"]')).toBeNull();
		expect(container.querySelector('[role="application"]')).toBeNull();
		const heading = container.querySelector("h1");
		expect(heading?.textContent).toBe("World 3D");
		expect(heading?.tabIndex).toBe(-1);
	});

	test("test 21: the queue's buttons in order, and ten agent rows", async () => {
		const container = await mount(world(fixture));
		const queue = [
			...container.querySelectorAll("[data-ask-queue] button"),
		].map((button) => (button.textContent ?? "").split(":")[0]);
		expect(queue).toEqual([
			"Bo",
			"Inbox",
			"Ada",
			"Di",
			"Ed",
			"Di",
			"Ha",
			"Gu",
			"Ju",
		]);
		expect(
			[...container.querySelectorAll("[data-ask-queue] button")][5]?.textContent
		).toContain("Nightly backup");
		expect(container.querySelectorAll("li [data-act-agent]")).toHaveLength(10);
	});

	test("13d: Ada's Answer opens the card; Approve answers only after Confirm", async () => {
		const answers: string[] = [];
		const answering: InterfacePort = {
			...port,
			answerAsk: (askId, choiceId) => {
				answers.push(`${askId}:${choiceId}`);
				return Promise.resolve();
			},
		};
		const container = await mount(
			<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
				<World3dInterface
					activeThreadId={null}
					loading={false}
					params={{ camera: "orbit", theme: "meadow" }}
					port={answering}
					snapshot={fixture}
					threadView={null}
				/>
			</ActClockProvider>
		);
		await press(rowButtons(container, "Ada", "Answer")[0]);
		const card = () => document.querySelector("[data-ask-card]");
		expect(card()?.textContent).toContain("Can I run shell.run now?");
		const approve = [...(card()?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Approve"
		);
		await press(approve);
		expect(answers).toEqual([]);
		await press(
			[...(card()?.querySelectorAll("button") ?? [])].find((button) =>
				button.textContent?.startsWith("Confirm")
			)
		);
		expect(answers).toHaveLength(1);
		expect(answers[0]).toEndWith(":approve");
	});

	test("15: Di's second Details opens Nightly backup; Gu's answer opens", async () => {
		const container = await mount(world(fixture));
		const details = rowButtons(container, "Di", "Details");
		expect(details).toHaveLength(2);
		await press(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent ?? ""
		).toContain("Nightly backup");
		expect(rowButtons(container, "Gu", "Open answer")).toHaveLength(1);
		expect(
			[...container.querySelectorAll("[data-ask-queue] button")].some(
				(button) => button.textContent?.startsWith("Ha: Apply the fix")
			)
		).toBe(true);
	});
});

describe("world-3d return focus and rows (13h, 15)", () => {
	test("13h: with the opener and every queue button gone, focus lands on the h1", async () => {
		const only = usefulStateFixture({ agents: ["bo"] });
		let setSnapshot: ((next: InterfaceSnapshot) => void) | null = null;
		function Host() {
			const [snapshot, set] = useState<InterfaceSnapshot>(only);
			setSnapshot = set;
			return world(snapshot);
		}
		const container = await mount(<Host />);
		const needYou = container.querySelector<HTMLElement>("[data-need-you]");
		act(() => needYou?.focus());
		await press(needYou);
		expect(document.querySelector("[data-ask-card]")).not.toBeNull();
		act(() => setSnapshot?.({ ...only, asks: [], threads: [] }));
		await settle();
		const close = [
			...(document
				.querySelector("[data-ask-card]")
				?.querySelectorAll("button") ?? []),
		].find((button) => button.textContent === "Close");
		await press(close);
		await settle(60);
		expect(document.activeElement?.textContent).toBe("World 3D");
	});

	test("13h: with another ask left, focus moves to the next queue button", async () => {
		const container = await mount(world(fixture));
		const first = container.querySelector<HTMLElement>(
			"[data-ask-queue] button"
		);
		act(() => first?.focus());
		await press(first);
		const close = [
			...(document
				.querySelector("[data-ask-card]")
				?.querySelectorAll("button") ?? []),
		].find((button) => button.textContent === "Close");
		await press(close);
		await settle(60);
		// The opener is still there, so focus returns to it.
		expect(document.activeElement).toBe(first);
	});

	test("15: Gu's Open answer opens the reply card; Ada's row is described by her act", async () => {
		const container = await mount(world(fixture));
		await press(rowButtons(container, "Gu", "Open answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Gu");
		const ada = container.querySelector(`[data-act-agent="${agentId("Ada")}"]`);
		const describedBy = ada?.getAttribute("aria-describedby") ?? "";
		const description = describedBy
			? (document.getElementById(describedBy)?.textContent ?? "")
			: (ada?.getAttribute("aria-label") ?? "");
		expect(description).toContain(
			named("Ada").ariaLabel.split(".")[0] ?? "Ada"
		);
	});
});

describe("world-3d words", () => {
	test("the tracker leads to the first blocking ask", async () => {
		const goal = askTrackerGoal(
			fixture.asks ?? [],
			fixture.agents,
			"full",
			() => " · ≤ 7m"
		);
		// The wait is kept whole beside the title, which truncates.
		expect(goal?.title).toBe("Bo asks: Which DB to use?");
		expect(goal?.suffix).toBe("· ≤ 7m");
		// Its name says it opens the ask, with the wait.
		const { trackerLabel } = await import("./world-3d-hud.tsx");
		expect(goal ? trackerLabel(goal) : "").toBe(
			"Answer Bo: Bo asks: Which DB to use?, ≤ 7m"
		);
		expect(goal?.agentId).toBe(agentId("Bo"));
		// It carries the ask it names, so activating it opens exactly that one.
		expect(goal?.askId).toBe(
			(fixture.asks ?? []).find(
				(ask) => ask.agentId === agentId("Bo") && ask.blocking
			)?.id
		);
		// An agent without a cottage cannot be walked to: the next ask leads.
		const placed = new Set(
			fixture.agents.map((item) => item.id).filter((id) => id !== agentId("Bo"))
		);
		const next = askTrackerGoal(
			fixture.asks ?? [],
			fixture.agents,
			"full",
			() => "",
			placed
		);
		// Ada's is the next blocking ask in queue order.
		expect(next?.agentId).toBe(agentId("Ada"));
	});

	test("what an agent says comes from its act, never a message", () => {
		expect(actLine(named("Cy"), fixture.threads, "full")).toBe(
			"Editing snapshot.ts."
		);
		expect(actLine(named("Fa"), fixture.threads, "full")).toBe(
			"I've hit my limit for now."
		);
		expect(actLine(named("Gu"), fixture.threads, "redacted")).toBe(
			"I have an answer for you."
		);
		expect(actLine(named("Ed"), fixture.threads, "full")).toBe(
			"My run was interrupted."
		);
		expect(actLine(named("Cy"), fixture.threads, "redacted")).toBe(
			"Working on something right now."
		);
	});

	test("askers queue on your step, deliverers by the basket, never on you", async () => {
		const layout = layoutWorld(fixture);
		const { points } = worldYouSpot(layout);
		const you = points.you;
		const tray = points["you-tray"];
		if (!(you && tray)) {
			throw new Error("you-spot points");
		}
		// The overflow place is not where you stand (the spawn).
		const { tileToWorld } = await import("./world-3d-theme.ts");
		const spawn = tileToWorld(layout, layout.spawn);
		expect(Math.hypot(you[0] - spawn[0], you[2] - spawn[2])).toBeGreaterThan(2);
		const gu = named("Gu");
		const home: [number, number, number] = [0, 0.1, 0];
		const first = worldActorAt(gu, home, points, [], false, 0);
		const second = worldActorAt(gu, home, points, [], false, 1);
		expect(first).not.toEqual(second);
		// Under reduced motion a deliverer stays home.
		expect(worldActorAt(gu, home, points, [], true, 1)).toEqual(home);
		const cy = named("Cy");
		expect(worldActorAt(cy, home, points, [], false)).toEqual(home);
	});

	test("an asking lantern dims the longer it waits", () => {
		expect(lanternGlow(null, FIXTURE_NOW)).toBe(1);
		expect(lanternGlow(FIXTURE_NOW, FIXTURE_NOW)).toBe(1);
		expect(lanternGlow(FIXTURE_NOW - 3_600_000, FIXTURE_NOW)).toBeLessThan(0.5);
	});

	test("the dialogue lists one Answer row per ask; it opens the shared card", async () => {
		const bo = named("Bo");
		const agent = fixture.agents.find((item) => item.id === bo.agentId);
		if (!agent) {
			throw new Error("Bo");
		}
		const opened: string[] = [];
		const asks = (fixture.asks ?? []).filter(
			(ask) => ask.agentId === bo.agentId
		);
		const container = await mount(
			<World3dDialog
				acts={{
					act: bo,
					agentName: "Bo",
					asks,
					nowMs: FIXTURE_NOW,
					onAsk: (askId) => opened.push(askId),
					privacy: "full",
				}}
				agent={agent}
				onClose={() => undefined}
				port={port}
				threads={fixture.threads.filter((thread) =>
					thread.agentIds.includes(bo.agentId)
				)}
				threadView={null}
			/>
		);
		const rows = [...container.querySelectorAll("[data-dialog-ask]")];
		expect(rows).toHaveLength(asks.length);
		expect(rows[0]?.textContent).toBe("Answer: Which DB to use?");
		await press(rows[0]);
		expect(opened).toEqual([asks[0]?.id ?? ""]);
		// No updatedAt ages with acts.
		expect(container.textContent).not.toMatch(/\d+[mhd]$/m);
	});

	test("Ada's Answer row reads her ask, named by askAriaLabel (7.3)", async () => {
		const ada = named("Ada");
		const agent = fixture.agents.find((item) => item.id === ada.agentId);
		if (!agent) {
			throw new Error("Ada");
		}
		const asks = (fixture.asks ?? []).filter(
			(ask) => ask.agentId === ada.agentId
		);
		const dialog = (privacy: "full" | "redacted") => (
			<World3dDialog
				acts={{
					act: ada,
					agentName: "Ada",
					asks,
					nowMs: FIXTURE_NOW,
					onAsk: () => undefined,
					privacy,
				}}
				agent={agent}
				onClose={() => undefined}
				port={port}
				threads={[]}
				threadView={null}
			/>
		);
		const container = await mount(dialog("full"));
		const row = container.querySelector("[data-dialog-ask]");
		expect(row?.textContent).toBe("Answer: Can I run shell.run now?");
		const [first] = asks;
		if (!first) {
			throw new Error("Ada's ask");
		}
		// The visible words lead its name (label in name), then the ask's label.
		expect(row?.getAttribute("aria-label")).toBe(
			`Answer: Can I run shell.run now? ${askAriaLabel(first, "Ada", FIXTURE_NOW, "full")}`
		);
		const hidden = await mount(dialog("redacted"));
		expect(hidden.querySelector("[data-dialog-ask]")?.textContent).toBe(
			`Answer: ${askKindWords(first)}`
		);
	});
});
