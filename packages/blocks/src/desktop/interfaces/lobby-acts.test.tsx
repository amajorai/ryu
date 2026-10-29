import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM must exist before the dialog primitives load (they read it on import).
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, useState } = await import("react");
const { PORTRAIT_PITCH } = await import("./game3d-stage.tsx");
const { createRoot } = await import("react-dom/client");
const { agentActs } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { stageAgents } = await import("./game3d-acts.ts");
const { offStageText } = await import("./game3d-signs.tsx");
const { ActClockProvider } = await import("./use-acts.ts");
const { LobbyInterface } = await import("./lobby-interface.tsx");
const { lobbyLimitText, lobbyMember, lobbyPaths, lobbyYouSpot } = await import(
	"./lobby-acts.tsx"
);
const {
	ANSWER_GRACE_MS,
	buildMembers,
	buildQuestBoard,
	settleAnswers,
	SQUAD_SIZE,
} = await import("./lobby-model.ts");
const { ANSWERED_KEY, useAnsweredToday } = await import("./lobby-answers.ts");
const { LobbyBust } = await import("./lobby-portrait.tsx");
const { figureColors } = await import("./lobby-palette.ts");

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

function lobby(snapshot: InterfaceSnapshot, acted = true) {
	const game = (
		<LobbyInterface
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

/** The agent's row: its squad status row, or its off-stage list row. */
function rowOf(container: HTMLElement, name: string): Element {
	const id = agentId(name);
	const row =
		container.querySelector(`[data-agent-status="${id}"]`) ??
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

describe("lobby useful state (fallback rows)", () => {
	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const container = await mount(lobby(fixture));
			expect(
				container.querySelector('[data-testid="interface-lobby"]')
			).not.toBeNull();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("the squad is the four most urgent agents; the rest are off stage", async () => {
		const container = await mount(lobby(fixture));
		const squad = [
			...container.querySelectorAll<HTMLElement>('[role="radio"]'),
		].map((radio) => radio.dataset.agentId);
		expect(squad).toEqual(["bo", "ada", "di", "ed"]);
		const { offStage } = stageAgents(actsNow, SQUAD_SIZE);
		expect(offStageText(offStage)).toBe(
			"+6: 1 limited, 2 working, 1 delivering, 2 idle"
		);
		// Off-stage agents keep a row with their status line.
		expect(
			container.querySelector(`[data-act-agent="${agentId("Gu")}"]`)
		).not.toBeNull();
	});

	test("agent rows are described by act.ariaLabel", async () => {
		const container = await mount(lobby(fixture));
		expect(
			described(container.querySelector('[role="radio"][data-agent-id="ada"]'))
		).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
	});

	test("Ada's agent-row Answer button opens the ask card", async () => {
		const container = await mount(lobby(fixture));
		await press(rowButtons(container, "Ada", "Answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Can I run shell.run now?");
	});

	test("Di's agent row has two Details buttons, the second opens the BlockerCard for Nightly backup", async () => {
		const container = await mount(lobby(fixture));
		const details = rowButtons(container, "Di", "Details");
		expect(details).toHaveLength(2);
		await press(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent ?? ""
		).toContain("Nightly backup");
	});

	test("Gu's agent-row Open answer button opens the reply ask card", async () => {
		const container = await mount(lobby(fixture));
		await press(rowButtons(container, "Gu", "Open answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Edited 3 files");
	});

	test("the HUD summary reads 3 need you · 2 working · 1 failed · 1 limited", async () => {
		const container = await mount(lobby(fixture));
		expect(container.querySelector("[data-act-summary]")?.textContent).toBe(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		expect(container.querySelector("[data-blind-spot]")?.textContent).toBe(
			"Some questions and prompts only show in their chat"
		);
		expect(container.querySelector("[data-act-announcer]")).not.toBeNull();
	});

	test("the Queue button reads Queue · 9 and is visible", async () => {
		const container = await mount(lobby(fixture));
		const queue = container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
	});

	test("AskQueueList lists Ha's heal_fix suggestion", async () => {
		const container = await mount(lobby(fixture));
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
		const acted = await mount(lobby(oldHost));
		const plain = await mount(lobby(oldHost, false));
		expect(acted.querySelector("[data-act-status]")).toBeNull();
		expect(acted.querySelector("[data-ask-queue]")).toBeNull();
		expect(sansIds(acted.innerHTML)).toBe(sansIds(plain.innerHTML));
	});
});

describe("lobby return focus (13h)", () => {
	test("with the opener and every queue button gone, focus lands on the heading", async () => {
		const only = usefulStateFixture({ agents: ["ada"] });
		let setSnapshot: ((next: InterfaceSnapshot) => void) | null = null;
		function Host() {
			const [snapshot, set] = useState<InterfaceSnapshot>(only);
			setSnapshot = set;
			return lobby(snapshot);
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
		expect(heading?.textContent).toBe("Lobby");
	});
});

describe("lobby squad plates (15a)", () => {
	const you = lobbyYouSpot(false);
	const stations = new Map(
		[...actsNow.keys()].map(
			(id, index) =>
				[id, [index * 2, 0.42, 0]] as [string, [number, number, number]]
		)
	);
	const paths = lobbyPaths(stations, 0.42, 3.2, you.points);
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
		const [spec] = lobbyMember({
			act,
			base: { id: act.agentId, position: [0, 0.42, 0] },
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

	test("Di's plate keeps the lobby's select action, named by her act alone", () => {
		const di = plate("Di");
		expect(di.activate).toBeUndefined();
		expect(di.label).toBe(actsNow.get(agentId("Di"))?.ariaLabel ?? "");
	});

	test("the wide and narrow pads keep every slot and the tray", () => {
		for (const narrow of [false, true]) {
			const { points } = lobbyYouSpot(narrow);
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
});

describe("lobby squad picks", () => {
	test("picking a benched agent never pushes a more urgent one off (test 16)", async () => {
		const container = await mount(lobby(fixture));
		const before = [
			...container.querySelectorAll<HTMLElement>('[role="radio"]'),
		].map((radio) => radio.dataset.agentId);
		// Ha (idle) from the Squad tab: the card says it stays on the bench.
		await press(
			[...container.querySelectorAll("[role='tab']")].find(
				(tab) => tab.textContent === "SQUAD" || tab.textContent === "Squad"
			)
		);
		const card = container.querySelector(
			`[aria-label="Squad roster"] [data-agent-id="${agentId("Ha")}"]`
		);
		expect(card?.getAttribute("aria-label")).toContain(
			"on the bench: more urgent agents are playing"
		);
		expect(card?.getAttribute("aria-label")).toContain(
			actsNow.get(agentId("Ha"))?.ariaLabel ?? "?"
		);
		expect(container.textContent).toContain("2 working");
		await press(card);
		const after = [
			...container.querySelectorAll<HTMLElement>('[role="radio"]'),
		].map((radio) => radio.dataset.agentId);
		expect(after).toEqual(before);
		// The benched pick is not in the squad, so the first radio is the
		// group's Tab stop.
		await press(
			[...container.querySelectorAll("[role='tab']")].find((tab) =>
				/lobby/i.test(tab.textContent ?? "")
			)
		);
		const radios = [
			...container.querySelectorAll<HTMLElement>('[role="radio"]'),
		];
		expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1]);
		// The benched pick still leads the next match.
		expect(
			container.querySelector('[aria-label="Next match"]')?.textContent
		).toContain("new thread with Ha");
	});

	test("the narrow pad's queue plates and you stand clear on screen", () => {
		const { points } = lobbyYouSpot(true);
		// The kit's portrait camera: yaw 45 degrees, pitched PORTRAIT_PITCH,
		// zoomed on the plates. The 390 shots measure about 19 px a unit;
		// 18 keeps a margin (a tighter fit only spreads the plates). A queue
		// plate is 24 px tall and about 80 px wide; you are about 40 px wide.
		const pitch = PORTRAIT_PITCH;
		const pxPerUnit = 18;
		const plateY = 1.6;
		const c = Math.SQRT1_2;
		const screen = ["you", "you-1", "you-2", "you-3", "you-4"].map((id) => {
			const [x, y, z] = points[id] ?? [0, 0, 0];
			const across = (x - z) * c;
			const out = (x + z) * c;
			return {
				id,
				width: id === "you" ? 40 : 80,
				x: across * pxPerUnit,
				y: (out * Math.sin(pitch) - (y + plateY) * Math.cos(pitch)) * pxPerUnit,
			};
		});
		for (let a = 0; a < screen.length; a++) {
			for (let b = a + 1; b < screen.length; b++) {
				const first = screen[a];
				const second = screen[b];
				if (!(first && second)) {
					continue;
				}
				const apartY = Math.abs(first.y - second.y);
				const apartX = Math.abs(first.x - second.x);
				// A plate height + 8 px apart, or clear side by side.
				const clear =
					apartY >= 32 || apartX >= (first.width + second.width) / 2;
				expect(`${first.id}/${second.id}:${clear}`).toBe(
					`${first.id}/${second.id}:true`
				);
			}
		}
	});
});

describe("lobby answers and faces", () => {
	function probe(port: InterfacePort) {
		const report = { answered: -1, pending: 0 };
		let answer: ((id: string) => Promise<void>) | undefined;
		let setAsks: ((asks: typeof fixture.asks) => void) | undefined;
		function Probe() {
			const [asks, set] = useState(fixture.asks);
			setAsks = set;
			const tally = useAnsweredToday({ asks }, port, FIXTURE_NOW);
			report.answered = tally.answered;
			report.pending = tally.pending.size;
			answer = (id) =>
				tally.answerPort.answerAsk?.(id, "ok") ?? Promise.resolve();
			return null;
		}
		return {
			answer: (id: string) => answer?.(id) ?? Promise.resolve(),
			Probe,
			report,
			setAsks: (asks: typeof fixture.asks) => setAsks?.(asks),
		};
	}

	test("an answered ask that leaves in time counts once; other windows count too", async () => {
		globalThis.localStorage?.removeItem(ANSWERED_KEY);
		const ask = (fixture.asks ?? []).find((item) => item.blocking);
		if (!ask) {
			throw new Error("a blocking ask");
		}
		const tally = probe({ ...port, answerAsk: () => Promise.resolve() });
		try {
			await mount(<tally.Probe />);
			await act(async () => {
				await tally.answer(ask.id);
			});
			act(() =>
				tally.setAsks((fixture.asks ?? []).filter((item) => item.id !== ask.id))
			);
			expect(tally.report).toEqual({ answered: 1, pending: 0 });
			// Another window answered one more today.
			const day = JSON.parse(
				globalThis.localStorage?.getItem(ANSWERED_KEY) ?? "{}"
			) as { day: string; ids: string[] };
			globalThis.localStorage?.setItem(
				ANSWERED_KEY,
				JSON.stringify({ day: day.day, ids: [...day.ids, "elsewhere"] })
			);
			act(() => {
				globalThis.dispatchEvent(
					new StorageEvent("storage", { key: ANSWERED_KEY })
				);
			});
			expect(tally.report.answered).toBe(2);
		} finally {
			globalThis.localStorage?.removeItem(ANSWERED_KEY);
		}
	});

	test("a pinned act clock judges expiry by its own time, not the wall's", async () => {
		globalThis.localStorage?.removeItem(ANSWERED_KEY);
		// An ask that expires minutes after the pinned clock: long gone by
		// the wall clock, still live on the countdown.
		const ask = (fixture.asks ?? []).find(
			(item) =>
				item.blocking &&
				item.expiresAt &&
				Date.parse(item.expiresAt) > FIXTURE_NOW &&
				Date.parse(item.expiresAt) < Date.now()
		);
		if (!ask) {
			throw new Error("a blocking ask expiring after the pinned clock");
		}
		const tally = probe({ ...port, answerAsk: () => Promise.resolve() });
		try {
			await mount(<tally.Probe />);
			await act(async () => {
				await tally.answer(ask.id);
			});
			expect(tally.report.pending).toBe(1);
			act(() =>
				tally.setAsks((fixture.asks ?? []).filter((item) => item.id !== ask.id))
			);
			expect(tally.report).toEqual({ answered: 1, pending: 0 });
		} finally {
			globalThis.localStorage?.removeItem(ANSWERED_KEY);
		}
	});

	test("a waiting member wears its own face", async () => {
		const agent = fixture.agents[0];
		if (!agent) {
			throw new Error("an agent");
		}
		const face = async (state: "ready" | "waiting") =>
			(
				await mount(
					<LobbyBust colors={figureColors(agent)} state={state} topper="fins" />
				)
			).innerHTML;
		expect(await face("waiting")).toContain('data-eyes="waiting"');
		expect(await face("ready")).not.toContain('data-eyes="waiting"');
	});
});

describe("lobby limit words", () => {
	test("Cooldown leads a known limit; lowercase after the kit's Likely", () => {
		const fa = [
			...agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK).values(),
		].find((item) => item.agentName === "Fa");
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
		expect(lobbyLimitText(known, "15:10")).toBe("Cooldown, back 15:10");
		expect(lobbyLimitText(likely, "15:10")).toBe("cooldown, back 15:10");
		expect(lobbyLimitText(known, null)).toBe("Cooldown");
	});
});

describe("lobby daily quests with acts", () => {
	test("the dailies count asks answered and runs finished today", () => {
		const members = buildMembers(fixture);
		const board = buildQuestBoard(
			fixture,
			members,
			{ answered: 2, firstThreadId: "t-ada", waiting: 3 },
			FIXTURE_NOW
		);
		const [answers] = board.daily;
		expect([answers?.progress, answers?.goal]).toEqual([2, 5]);
		expect(answers?.metric).toBe("2 / 5 answered");
		expect(answers?.action).toEqual({ kind: "open", threadId: "t-ada" });
		for (const quest of board.daily.slice(1)) {
			expect(quest.complete).toBe(true);
			expect(quest.updatedAt).not.toBeNull();
			// A failed run is not a quest to claim.
			expect(quest.metric).toBe("Finished today");
		}
		const quiet = buildQuestBoard(
			fixture,
			members,
			{ answered: 0, firstThreadId: null, waiting: 0 },
			FIXTURE_NOW
		);
		expect(quiet.daily[0]?.metric).toBe("Nothing waiting");
	});

	test("an answer counts only once its ask leaves, in time and unexpired", () => {
		const sent = (id: string, at: number, expiresAt: number | null = null) => ({
			at,
			expiresAt,
			id,
		});
		const wall = 1_000_000;
		const clock = FIXTURE_NOW;
		// Gone within the grace: answered. Still listed: still on its way.
		expect(
			settleAnswers(
				[sent("a", wall - 1000), sent("b", wall - 1000)],
				new Set(["b"]),
				wall,
				clock
			)
		).toEqual({ confirmed: ["a"], sent: [sent("b", wall - 1000)] });
		// Past the grace, or expired: dropped, waiting again, never answered.
		expect(
			settleAnswers(
				[
					sent("late", wall - ANSWER_GRACE_MS - 1),
					sent("old", wall, clock - 1),
				],
				new Set(["late"]),
				wall,
				clock
			)
		).toEqual({ confirmed: [], sent: [] });
	});

	test("an ask the host only opened stays waiting, then expires unanswered", async () => {
		const ask = (fixture.asks ?? []).find((item) => item.blocking);
		if (!ask) {
			throw new Error("a blocking ask");
		}
		let report = { answered: -1, pending: 0 };
		let answer: ((id: string) => Promise<void>) | undefined;
		let setAsks: ((asks: typeof fixture.asks) => void) | undefined;
		const opened: InterfacePort = {
			...port,
			// The host opened the thread instead of answering.
			answerAsk: () => Promise.resolve(),
		};
		function Probe() {
			const [asks, set] = useState(fixture.asks);
			setAsks = set;
			const tally = useAnsweredToday({ asks }, opened, FIXTURE_NOW);
			report = { answered: tally.answered, pending: tally.pending.size };
			answer = (id) =>
				tally.answerPort.answerAsk?.(id, "ok") ?? Promise.resolve();
			return null;
		}
		const wallClock = Date.now;
		globalThis.localStorage?.removeItem("ryu:lobby-answered");
		try {
			await mount(<Probe />);
			await act(async () => {
				await answer?.(ask.id);
			});
			expect(report).toEqual({ answered: 0, pending: 1 });
			// The ask stays past the grace: it is waiting again.
			const later = wallClock() + ANSWER_GRACE_MS + 1000;
			Date.now = () => later;
			act(() => setAsks?.([...(fixture.asks ?? [])]));
			expect(report).toEqual({ answered: 0, pending: 0 });
			// Then it expires and leaves: still not answered.
			act(() =>
				setAsks?.((fixture.asks ?? []).filter((item) => item.id !== ask.id))
			);
			expect(report.answered).toBe(0);
		} finally {
			Date.now = wallClock;
			globalThis.localStorage?.removeItem(ANSWERED_KEY);
		}
	});
});
