import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM must exist before the dialog primitives load (they read it on import).
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { stageAgents } = await import("./game3d-acts.ts");
const { offStageText } = await import("./game3d-signs.tsx");
const { ActClockProvider } = await import("./use-acts.ts");
const { QuizInterface } = await import("./quiz-interface.tsx");
const { quizContestant, quizPaths, quizYouSpot } = await import(
	"./quiz-acts.tsx"
);
const { QUIZ_PODIUMS, REVEALED_STORAGE_KEY, buildQuizBoard, boardTiles } =
	await import("./quiz-model.ts");
const { tileLabel } = await import("./quiz-board.tsx");

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

function quiz(snapshot: InterfaceSnapshot, acted = true) {
	const game = (
		<QuizInterface
			activeThreadId={null}
			loading={false}
			params={{}}
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

/** A contestant's button in the fallback row of podiums. */
function contestantOf(container: HTMLElement, name: string): Element | null {
	return (
		[
			...container.querySelectorAll('section[aria-label="Contestants"] button'),
		].find((button) =>
			button.getAttribute("aria-label")?.startsWith(`Ask ${name} `)
		) ?? null
	);
}

/** The agent's row: its podium's row, or its off-stage list row. */
function rowOf(container: HTMLElement, name: string): Element {
	const id = agentId(name);
	const row =
		contestantOf(container, name)?.closest("li") ??
		container.querySelector(`[data-act-agent="${id}"]`)?.closest("li");
	if (!row) {
		throw new Error(`no row for ${name}`);
	}
	return row;
}

function rowButtons(container: HTMLElement, name: string, text: string) {
	return [...rowOf(container, name).querySelectorAll("button")].filter(
		(button) => button.textContent === text
	);
}

function described(element: Element | null): string {
	return (element?.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent ?? "")
		.join(" ");
}

describe("quiz useful state (fallback rows)", () => {
	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const container = await mount(quiz(fixture));
			expect(
				container.querySelector('[data-testid="interface-quiz"]')
			).not.toBeNull();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("the podiums go to the four most urgent agents; the rest are off stage", async () => {
		const container = await mount(quiz(fixture));
		const podiums = [
			...container.querySelectorAll('section[aria-label="Contestants"] button'),
		]
			.map((button) => button.getAttribute("aria-label") ?? "")
			.filter((label) => label.startsWith("Ask "))
			.map((label) => label.split(" ")[1]);
		expect(podiums).toEqual(["Bo", "Ada", "Di", "Ed"]);
		const { offStage } = stageAgents(actsNow, QUIZ_PODIUMS);
		expect(offStageText(offStage)).toBe(
			"+6: 1 limited, 2 working, 1 delivering, 2 idle"
		);
		// Off-stage agents keep a row with their status line.
		expect(
			container.querySelector(`[data-act-agent="${agentId("Gu")}"]`)
		).not.toBeNull();
	});

	test("agent rows are described by act.ariaLabel", async () => {
		const container = await mount(quiz(fixture));
		expect(described(contestantOf(container, "Ada"))).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
	});

	test("Ada's agent-row Answer button opens the ask card", async () => {
		const container = await mount(quiz(fixture));
		await press(rowButtons(container, "Ada", "Answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Can I run shell.run now?");
	});

	test("Di's agent row has two Details buttons, the second opens the BlockerCard for Nightly backup", async () => {
		const container = await mount(quiz(fixture));
		const details = rowButtons(container, "Di", "Details");
		expect(details).toHaveLength(2);
		await press(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent ?? ""
		).toContain("Nightly backup");
	});

	test("Gu's agent-row Open answer button opens the reply ask card", async () => {
		const container = await mount(quiz(fixture));
		await press(rowButtons(container, "Gu", "Open answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Edited 3 files");
	});

	test("the HUD summary reads 3 need you · 2 working · 1 failed · 1 limited", async () => {
		const container = await mount(quiz(fixture));
		expect(container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		expect(container.querySelector("[data-blind-spot]")?.textContent).toBe(
			"Some questions and prompts only show in their chat"
		);
		expect(container.querySelector("[data-act-announcer]")).not.toBeNull();
	});

	test("the Queue button reads Queue · 9 and is visible", async () => {
		const container = await mount(quiz(fixture));
		const queue = container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
	});

	test("AskQueueList lists Ha's heal_fix suggestion", async () => {
		const container = await mount(quiz(fixture));
		const names = [
			...container.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].map((item) => item.getAttribute("aria-label"));
		expect(names).toContain(
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
	});

	test("without asks the agent rows and counters are unchanged", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		// Ids from useId and the tab's fade-in opacity differ between mounts.
		const sansIds = (html: string) =>
			html.replace(/_r_\w+_/g, "_r_").replace(/opacity: [\d.]+/g, "opacity: _");
		const acted = await mount(quiz(oldHost));
		const plain = await mount(quiz(oldHost, false));
		expect(acted.querySelector("[data-act-status]")).toBeNull();
		expect(acted.querySelector("[data-ask-queue]")).toBeNull();
		expect(sansIds(acted.innerHTML)).toBe(sansIds(plain.innerHTML));
	});
});

describe("quiz return focus (13h)", () => {
	test("with the opener and every queue button gone, focus lands on the heading", async () => {
		const only = usefulStateFixture({ agents: ["ada"] });
		let setSnapshot: ((next: InterfaceSnapshot) => void) | null = null;
		function Host() {
			const [snapshot, set] = useState<InterfaceSnapshot>(only);
			setSnapshot = set;
			return quiz(snapshot);
		}
		const container = await mount(<Host />);
		const needYou = container.querySelector<HTMLElement>("[data-need-you]");
		act(() => needYou?.focus());
		await press(needYou);
		expect(document.querySelector("[data-ask-card]")).not.toBeNull();
		// Answered elsewhere: the ask, the need-you button and the queue go.
		act(() =>
			setSnapshot?.({ ...only, asks: [], threads: [], agents: only.agents })
		);
		await settle();
		const close = [
			...(document
				.querySelector("[data-ask-card]")
				?.querySelectorAll("button") ?? []),
		].find((button) => button.textContent === "Close");
		await press(close);
		await settle(60);
		const heading = document.activeElement;
		expect(heading?.tagName).toBe("H1");
		expect(heading?.textContent).toBe("Quiz Show");
	});
});

describe("quiz podium plates (15a)", () => {
	const you = quizYouSpot(false).points;
	const stations = new Map(
		[...actsNow.keys()].map(
			(id, index) =>
				[id, [index * 2, 0.42, 0]] as [string, [number, number, number]]
		)
	);
	const paths = quizPaths(stations, you);
	const opened: string[] = [];
	const view = {
		acts: actsNow,
		iconOnly: false,
		nowMs: FIXTURE_NOW,
		offStage: { asks: 0, byAct: {}, count: 0 },
		onAsk: (askId: string) => opened.push(askId),
		onBlocker: () => undefined,
		onQueue: () => undefined,
		owners: new Map<string, string>(),
		privacy: "full" as const,
		shown: new Set<string>(),
		slots: { overflow: 0, slots: [] },
		snapshot: fixture,
	};
	const plate = (name: string) => {
		const act = actsNow.get(agentId(name));
		if (!act) {
			throw new Error(name);
		}
		const [spec] = quizContestant({
			act,
			base: { id: act.agentId, position: [0, 0.42, 0] },
			label: "Ask the final question.",
			looks: {} as never,
			paths,
			reduced: true,
			view,
		});
		if (!spec) {
			throw new Error(name);
		}
		return spec;
	};

	test("Ada's plate answers her ask, named by her act sentence", () => {
		const ada = plate("Ada");
		expect(ada.label).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run. Answer their ask."
		);
		ada.activate?.();
		expect(opened).toEqual([actsNow.get(agentId("Ada"))?.ask?.id ?? ""]);
	});

	test("Di's plate keeps the quiz's final-question action", () => {
		const di = plate("Di");
		expect(di.activate).toBeUndefined();
		expect(di.label).toBe(
			`${actsNow.get(agentId("Di"))?.ariaLabel} Ask the final question.`
		);
	});

	test("the wide and narrow queues keep every slot and the tray", () => {
		for (const narrow of [false, true]) {
			const { points } = quizYouSpot(narrow);
			for (const point of [
				"you",
				"you-1",
				"you-2",
				"you-3",
				"you-4",
				"you-tray",
			]) {
				expect(points[point]).toBeDefined();
			}
		}
	});
	test("on a wide stage queue plates clear the host and every podium screen", async () => {
		const { ISO_ANGLE } = await import("./game3d-stage.tsx");
		const { hostSpot, podiumSpots, TOWARD } = await import("./quiz-world.ts");
		// The isometric view: screen right along (1, 0, -1), up tilted by
		// the pitch; one unit is about 44 px on a 1280-wide stage.
		const c = Math.SQRT1_2;
		const screen = (x: number, y: number, z: number) => ({
			right: (x - z) * c,
			up:
				y * Math.cos(ISO_ANGLE.pitch) - (x + z) * c * Math.sin(ISO_ANGLE.pitch),
		});
		interface Box {
			bottom: number;
			left: number;
			right: number;
			top: number;
		}
		const box = (
			at: { right: number; up: number },
			halfWidth: number,
			halfHeight: number
		): Box => ({
			bottom: at.up - halfHeight,
			left: at.right - halfWidth,
			right: at.right + halfWidth,
			top: at.up + halfHeight,
		});
		const meets = (a: Box, b: Box) =>
			a.left < b.right &&
			b.left < a.right &&
			a.bottom < b.top &&
			b.bottom < a.top;
		// A queue plate ("Ada · ≤ 3m", about 80 x 22 px) plus 8 px all round,
		// riding 1.62 over the feet.
		const plates = Object.values(quizYouSpot(false).layout.slots).map(
			([x, y, z]) => box(screen(x, y + 1.62, z), 1.1, 0.45)
		);
		const stage = 0.2;
		const [hostX, hostZ] = hostSpot();
		// The host's head and shoulders behind the lectern.
		const host = box(screen(hostX, stage + 1.2, hostZ), 0.45, 0.45);
		const screens = podiumSpots().map(([x, z]) =>
			box(
				screen(x + TOWARD[0] * 0.4, stage + 0.5, z + TOWARD[1] * 0.4),
				0.64,
				0.32
			)
		);
		// Every slot stands on the island (off its shore) and its plate
		// inside the studio's framed bounds.
		const { islandFor } = await import("./game3d-ground.tsx");
		const { onIsland } = await import("./game3d-island.ts");
		const { STUDIO_BOUNDS } = await import("./quiz-world.ts");
		const island = islandFor(
			STUDIO_BOUNDS.maxX - STUDIO_BOUNDS.minX,
			STUDIO_BOUNDS.maxZ - STUDIO_BOUNDS.minZ,
			2.2
		);
		const leftEdge = (STUDIO_BOUNDS.minX - STUDIO_BOUNDS.maxZ) * c;
		for (const [slot, [x, , z]] of Object.entries(
			quizYouSpot(false).layout.slots
		)) {
			expect(`${slot} on island: ${onIsland(island, x, z, 0.6)}`).toBe(
				`${slot} on island: true`
			);
			expect((x - z) * c - 1.1).toBeGreaterThan(leftEdge);
		}
		for (const [index, plate] of plates.entries()) {
			expect(`you-${index + 1} meets host: ${meets(plate, host)}`).toBe(
				`you-${index + 1} meets host: false`
			);
			for (const [podium, face] of screens.entries()) {
				expect(
					`you-${index + 1} meets screen ${podium}: ${meets(plate, face)}`
				).toBe(`you-${index + 1} meets screen ${podium}: false`);
			}
		}
	});
});

describe("quiz board with acts", () => {
	test("a limited agent's clue sits out, unplayed; an interrupt is paused", async () => {
		// Fa is limited on the agent (her thread has no blocker).
		const few = usefulStateFixture({ agents: ["cy", "ed", "fa", "gu"] });
		const container = await mount(quiz(few));
		const labelOf = (threadId: string) =>
			container
				.querySelector(`[data-thread-id="${threadId}"]`)
				?.getAttribute("aria-label") ?? "";
		expect(labelOf("t-fa")).toMatch(/^\d+ clue, /);
		expect(labelOf("t-fa")).toContain("Sitting out");
		expect(labelOf("t-ed")).toContain("Paused");
	});

	test("a limited agent's other, finished clues stay played", async () => {
		const few = usefulStateFixture({ agents: ["cy", "ed", "fa", "gu"] });
		const fa = few.threads.find((thread) => thread.id === "t-fa");
		if (!fa) {
			throw new Error("t-fa");
		}
		// An older, read conversation of Fa's, nothing left on it.
		const old = {
			...fa,
			blocker: null,
			id: "t-fa-old",
			running: false,
			title: "Old launch notes",
			unread: 0,
		};
		const container = await mount(
			quiz({ ...few, threads: [...few.threads, old] })
		);
		const label =
			container
				.querySelector('[data-thread-id="t-fa-old"]')
				?.getAttribute("aria-label") ?? "";
		expect(label).toStartWith("Clue revealed");
		expect(label).not.toContain("Sitting out");
	});

	test("a clue is played only once its answer is read and nothing is left on it", async () => {
		const container = await mount(quiz(fixture));
		const tiles = boardTiles(buildQuizBoard(fixture));
		const unread = tiles.find((tile) => (tile.thread.unread ?? 0) > 0);
		if (!unread) {
			throw new Error("expected an unread tile");
		}
		const open = tileLabel(unread, "open", true);
		expect(open.startsWith(`${unread.value} clue, `)).toBe(true);
		const labels = [...container.querySelectorAll("button")].map((button) =>
			button.getAttribute("aria-label")
		);
		// Bo's question, Ada's approval, Cy's and Io's runs and Di's stop keep
		// their clues up; a clue with nothing left on it is played.
		const labelOf = (threadId: string | null) =>
			container
				.querySelector(`[data-thread-id="${threadId ?? ""}"]`)
				?.getAttribute("aria-label") ?? "";
		for (const name of ["Bo", "Ada", "Cy", "Io", "Di"]) {
			const threadId = actsNow.get(agentId(name))?.threadId ?? null;
			expect(labelOf(threadId)).toMatch(/^\d+ clue, /);
		}
		expect(labelOf(actsNow.get(agentId("Bo"))?.threadId ?? null)).toContain(
			"Needs you."
		);
		// A delivered answer's flipped tile says the headline in its name.
		const gu = actsNow.get(agentId("Gu"));
		const headline = fixture.threads.find(
			(thread) => thread.id === gu?.threadId
		)?.outcome?.headline;
		expect(headline).toBeTruthy();
		expect(labelOf(gu?.threadId ?? null)).toContain(
			`Answer ready: ${headline}.`
		);
		expect(
			labels.filter((label) => label?.startsWith("Clue revealed")).length
		).toBeGreaterThan(0);
		// Picking a clue stores nothing with acts.
		const before =
			globalThis.localStorage?.getItem(REVEALED_STORAGE_KEY) ?? null;
		await press(
			container.querySelector(
				`[data-thread-id="${actsNow.get(agentId("Cy"))?.threadId ?? ""}"]`
			)
		);
		expect(globalThis.localStorage?.getItem(REVEALED_STORAGE_KEY) ?? null).toBe(
			before
		);
	});
});

describe("quiz podium words", () => {
	test("a podium screen says what its contestant is on", async () => {
		const { podiumWords, quizLimitText } = await import("./quiz-acts.tsx");
		const words = (name: string) => {
			const act = actsNow.get(agentId(name));
			if (!act) {
				throw new Error(name);
			}
			return podiumWords(act);
		};
		// One short word each: the reasons ride the alarm plates.
		expect(words("Bo")).toBe("Buzzed");
		expect(words("Di")).toBe("X");
		expect(words("Ed")).toBe("Paused");
		expect(words("Fa")).toBe("Out");
		expect(words("Gu")).toBe("Answer");
		expect(words("Cy")).toBe("Editing");
		for (const act of actsNow.values()) {
			expect(podiumWords(act).length).toBeLessThanOrEqual(8);
		}
		const fa = actsNow.get(agentId("Fa"));
		if (!fa) {
			throw new Error("Fa");
		}
		const limit = {
			at: null,
			kind: "rate-limited" as const,
			title: "Limit hit",
		};
		const known = { ...fa, blockers: [{ ...limit, source: "usage" as const }] };
		const likely = {
			...fa,
			blockers: [{ ...limit, source: "estimate" as const }],
		};
		expect(quizLimitText(known, "15:10")).toBe("Sitting out, back 15:10");
		expect(quizLimitText(known, null)).toBe("Sitting out");
		// Lower case after the kit's "Likely ": "Likely sitting out…".
		expect(quizLimitText(likely, "15:10")).toBe("sitting out, back 15:10");
	});

	test("New game is gone and picking a clue stores nothing with acts", async () => {
		const container = await mount(quiz(fixture));
		expect(
			[...container.querySelectorAll("button")].some(
				(button) => button.getAttribute("aria-label") === "New game"
			)
		).toBe(false);
	});
});
