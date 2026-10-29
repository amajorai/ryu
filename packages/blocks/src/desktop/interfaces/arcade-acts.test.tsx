import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM must exist before the dialog primitives load (they read it on import).
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { agentActs } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { ActClockProvider } = await import("./use-acts.ts");
const { ArcadeInterface } = await import("./arcade-interface.tsx");
const {
	arcadePaths,
	arcadePlayer,
	arcadeYouSpot,
	ARCADE_STATION_LAYOUT,
	ARCADE_STATION_LAYOUT_BACK,
	ARCADE_STATION_LAYOUT_MID,
	ARCADE_STATION_LAYOUT_MID_NARROW,
	cabinetWords,
	insertCoinText,
	stationLayoutFor,
} = await import("./arcade-acts.tsx");
const { layoutHall, playerPose, playerSpot } = await import(
	"./arcade-diorama.tsx"
);
const { buildFloor, snapshotNow } = await import("./arcade-model.ts");

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

function arcade(snapshot: InterfaceSnapshot, acted = true) {
	const game = (
		<ArcadeInterface
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

function machineOf(container: HTMLElement, name: string): Element {
	const machine = container.querySelector(
		`[data-arcade-machine="${agentId(name)}"]`
	);
	if (!machine) {
		throw new Error(`no machine for ${name}`);
	}
	return machine;
}

function rowButtons(container: HTMLElement, name: string, text: string) {
	const row = machineOf(container, name).closest("li");
	return [...(row?.querySelectorAll("button") ?? [])].filter(
		(button) => button.textContent === text
	);
}

function described(element: Element): string {
	return (element.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent ?? "")
		.join(" ");
}

describe("arcade useful state (fallback rows)", () => {
	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const container = await mount(arcade(fixture));
			expect(container.querySelector("[data-arcade-floor]")).not.toBeNull();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("agent rows are described by act.ariaLabel", async () => {
		const container = await mount(arcade(fixture));
		// The description sits on the cabinet's tab stop, its lever.
		const lever = machineOf(container, "Ada").querySelector(
			'[data-arcade-stop="lever"]'
		);
		expect(lever?.getAttribute("tabindex")).toBe("0");
		expect(described(lever as Element)).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
	});

	test("cabinets are named by their act and drop the legacy jackpot counters", async () => {
		const container = await mount(arcade(fixture));
		const ada = machineOf(container, "Ada");
		expect(ada.getAttribute("aria-label")).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		expect(
			container.querySelector("[data-arcade-machine][data-jackpot]")
		).toBeNull();
		expect(container.querySelector('[data-arcade-stop="collect"]')).toBeNull();
		expect(container.textContent).not.toContain("JACKPOT");
		expect(container.innerHTML).not.toContain("waiting on you");
	});

	test("Ada's agent-row Answer button opens the ask card", async () => {
		const container = await mount(arcade(fixture));
		await press(rowButtons(container, "Ada", "Answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Can I run shell.run now?");
	});

	test("Di's agent row has two Details buttons, the second opens the BlockerCard for Nightly backup", async () => {
		const container = await mount(arcade(fixture));
		const details = rowButtons(container, "Di", "Details");
		expect(details).toHaveLength(2);
		await press(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent ?? ""
		).toContain("Nightly backup");
	});

	test("Gu's agent-row Open answer button opens the reply ask card", async () => {
		const container = await mount(arcade(fixture));
		await press(rowButtons(container, "Gu", "Open answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Edited 3 files");
	});

	test("the HUD summary reads 3 need you · 2 working · 1 failed · 1 limited", async () => {
		const container = await mount(arcade(fixture));
		expect(container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		expect(container.querySelector("[data-need-you]")?.textContent).toBe(
			"3 need you"
		);
		expect(container.querySelector("[data-blind-spot]")?.textContent).toBe(
			"Some questions and prompts only show in their chat"
		);
		expect(container.querySelector("[data-act-announcer]")).not.toBeNull();
	});

	test("the Queue button reads Queue · 9 and is visible", async () => {
		const container = await mount(arcade(fixture));
		const queue = container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
	});

	test("AskQueueList lists Ha's heal_fix suggestion", async () => {
		const container = await mount(arcade(fixture));
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
		// Ids from useId and the spinning reels' offsets differ between mounts.
		const sansIds = (html: string) =>
			html
				.replace(/_r_\w+_/g, "_r_")
				.replace(/translateY\([^)]*\)/g, "translateY()");
		const acted = await mount(arcade(oldHost));
		const plain = await mount(arcade(oldHost, false));
		expect(acted.querySelector("[data-act-status]")).toBeNull();
		expect(acted.querySelector("[data-ask-queue]")).toBeNull();
		expect(sansIds(acted.innerHTML)).toBe(sansIds(plain.innerHTML));
	});
});

describe("arcade players (plate activation, 15a)", () => {
	const you = arcadeYouSpot([0, 6], 0.16, false).points;
	const stations = new Map(
		[...actsNow.keys()].map(
			(id, index) =>
				[id, [index * 2, 0.16, 0]] as [string, [number, number, number]]
		)
	);
	const paths = arcadePaths(stations, you, 0.16);
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
	const player = (name: string) => {
		const act = actsNow.get(agentId(name));
		if (!act) {
			throw new Error(name);
		}
		const [spec] = arcadePlayer({
			act,
			base: { id: act.agentId, position: [0, 0.16, 0] },
			label: "Open the machine.",
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
		const ada = player("Ada");
		expect(ada.label).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run. Answer their ask."
		);
		ada.activate?.();
		expect(opened).toEqual([actsNow.get(agentId("Ada"))?.ask?.id ?? ""]);
		expect(ada.actAgent).toBe(agentId("Ada"));
	});

	test("Cy's plate keeps the machine's own action", () => {
		const cy = player("Cy");
		expect(cy.activate).toBeUndefined();
		expect(cy.label).toBe(
			`${actsNow.get(agentId("Cy"))?.ariaLabel} Open the machine.`
		);
	});

	test("every station and the you-spot are on the paths", () => {
		for (const id of stations.keys()) {
			expect(paths.points[`station:${id}`]).toBeDefined();
		}
		for (const point of [
			"you",
			"you-1",
			"you-2",
			"you-3",
			"you-4",
			"you-tray",
		]) {
			expect(paths.points[point]).toBeDefined();
		}
	});
});

describe("arcade fixes", () => {
	const base = {
		agentIds: ["a"],
		lastMessage: null,
		messageCount: 2,
		pinned: false,
		projectId: null,
		teamId: null,
		title: "t",
		updatedAt: "2026-10-16T09:00:00Z",
	};
	const snapshot = (role: "user" | null): InterfaceSnapshot => ({
		agents: [
			{ avatarUrl: null, description: "", id: "a", name: "A", status: "idle" },
		],
		groups: [],
		threads: [{ ...base, id: "t1", lastMessageRole: role, running: false }],
		version: 1,
	});

	test("'waiting' only when the user spoke last", () => {
		const pose = (role: "user" | null) => {
			const machine = buildFloor(snapshot(role), null).machines[0];
			if (!machine) {
				throw new Error("no machine");
			}
			return playerPose(machine);
		};
		expect(pose("user")).toBe("waiting");
		// A machine that merely has conversations is idle, not waiting.
		expect(pose(null)).toBe("idle");
	});

	test("the floor's clock is the host's observedAt when it sends one", () => {
		const observedAt = "2026-10-16T10:00:00.000Z";
		expect(snapshotNow({ ...snapshot("user"), observedAt })).toBe(
			Date.parse(observedAt)
		);
		expect(snapshotNow(snapshot("user"))).toBe(
			Date.parse("2026-10-16T09:00:00Z")
		);
	});
});

describe("arcade words", () => {
	const fixture = usefulStateFixture();
	const acts = agentActs(fixture, FIXTURE_NOW, FIXTURE_CLOCK);
	const named = (name: string) => {
		const found = [...acts.values()].find((act) => act.agentName === name);
		if (!found) {
			throw new Error(`no agent ${name}`);
		}
		return found;
	};
	const words = (name: string) =>
		cabinetWords(named(name), fixture, FIXTURE_NOW, FIXTURE_CLOCK);

	test("a limit reads INSERT COIN with its reset time, Likely when estimated", () => {
		const fa = named("Fa");
		expect(insertCoinText(fa, FIXTURE_NOW, FIXTURE_CLOCK)).toBe(
			"INSERT COIN 15:10"
		);
		const [focus] = fa.blockers;
		if (focus) {
			const estimated = {
				...fa,
				blockers: [{ ...focus, source: "estimate" as const }],
			};
			expect(insertCoinText(estimated, FIXTURE_NOW, FIXTURE_CLOCK)).toBe(
				"Likely INSERT COIN 15:10"
			);
		}
		expect(words("Fa")).toMatchObject({
			marquee: "INSERT COIN · 15:10",
			tone: "limit",
		});
	});

	test("a failure tilts with its reason; an interruption only pauses", () => {
		expect(words("Di")).toMatchObject({
			marquee: "TILT · Tests failed",
			tone: "tilt",
		});
		expect(words("Ed")).toMatchObject({
			marquee: "PAUSED · Interrupted",
			tone: "paused",
		});
	});

	test("a working cabinet's reels are its step's kind and at most two before it", () => {
		const cy = words("Cy");
		const thread = fixture.threads.find(
			(item) => item.id === named("Cy").threadId
		);
		expect(cy.tone).toBe("ink");
		expect(cy.reels.length).toBeGreaterThan(0);
		expect(cy.reels.length).toBeLessThanOrEqual(3);
		expect<string | undefined>(cy.reels[0]).toBe(thread?.activity?.kind);
		// Nobody else is working a step, so their reels stay blank.
		expect(words("Ha").reels).toEqual([]);
	});
});

describe("arcade hall with the you-spot", () => {
	const machines = buildFloor(usefulStateFixture(), null).machines;
	const screen = ([x, , z]: [number, number, number]) => ({
		across: (x - z) * Math.SQRT1_2,
		out: (x + z) * Math.SQRT1_2,
	});

	for (const portrait of [false, true]) {
		test(`queue slots step toward the camera, one plate apart (${portrait ? "portrait" : "wide"})`, () => {
			const hall = layoutHall(machines, portrait, true);
			const slots = hall.you?.layout.slots;
			if (!slots) {
				throw new Error("no you-spot");
			}
			const points = (["you-1", "you-2", "you-3", "you-4"] as const).map((id) =>
				screen(slots[id])
			);
			for (let index = 1; index < points.length; index++) {
				const step = (points[index]?.out ?? 0) - (points[index - 1]?.out ?? 0);
				expect(step).toBeGreaterThanOrEqual(1.1);
			}
		});
	}

	test("the act hall is centred on what it holds; old hosts keep a square hall", () => {
		const old = layoutHall(machines, false, false);
		expect(old.halfWidth).toBe(old.halfDepth);
		expect(old.you).toBeNull();
		const hall = layoutHall(machines, false, true);
		const inside = (x: number, z: number) =>
			Math.abs(x) <= hall.halfWidth && Math.abs(z) <= hall.halfDepth;
		for (const cabinet of hall.cabinets) {
			expect(inside(cabinet.x, cabinet.z)).toBe(true);
		}
		for (const [x, , z] of Object.values(hall.you?.points ?? {})) {
			expect(inside(x, z)).toBe(true);
		}
	});
});

describe("arcade station layouts by row", () => {
	const machines = buildFloor(usefulStateFixture(), null).machines;
	for (const portrait of [false, true]) {
		test(`front row low, back row up, middle rows beside (${portrait ? "portrait" : "wide"})`, () => {
			const hall = layoutHall(machines, portrait, true);
			const stations = new Map(
				hall.cabinets.map((cabinet) => {
					const [x, z] = playerSpot(cabinet);
					return [cabinet.machine.id, [x, 0.16, z]] as [
						string,
						[number, number, number],
					];
				})
			);
			const layoutOf = stationLayoutFor(stations);
			const outs = [...stations.values()].map(
				([x, , z]) => (x + z) * Math.SQRT1_2
			);
			const front = Math.max(...outs);
			const back = Math.min(...outs);
			const oneRow = front - back < 1;
			for (const at of stations.values()) {
				const out = (at[0] + at[2]) * Math.SQRT1_2;
				if (oneRow) {
					expect(layoutOf(at)).toBe(ARCADE_STATION_LAYOUT_BACK);
					continue;
				}
				let expected = ARCADE_STATION_LAYOUT_MID;
				if (out > front - 1) {
					expected = ARCADE_STATION_LAYOUT;
				} else if (out < back + 1) {
					expected = ARCADE_STATION_LAYOUT_BACK;
				}
				expect(layoutOf(at)).toBe(expected);
			}
			const rows = new Set(outs.map((out) => Math.round(out * 10)));
			if (rows.size > 2) {
				expect(
					[...stations.values()].some(
						(at) => layoutOf(at) === ARCADE_STATION_LAYOUT_MID
					)
				).toBe(true);
				// On a phone the same middle rows take the aisle layout.
				const narrowOf = stationLayoutFor(stations, true);
				for (const at of stations.values()) {
					if (layoutOf(at) === ARCADE_STATION_LAYOUT_MID) {
						expect(narrowOf(at)).toBe(ARCADE_STATION_LAYOUT_MID_NARROW);
					} else {
						expect(narrowOf(at)).toBe(layoutOf(at));
					}
				}
			}
		});
	}
});

describe("arcade one-row hall", () => {
	test("a filtered hall of one row puts its words up over its cabinets", () => {
		const machines = buildFloor(
			usefulStateFixture({ agents: ["cy", "fa", "gu", "ha"] }),
			null
		).machines;
		const hall = layoutHall(machines, false, true);
		const stations = new Map(
			hall.cabinets.map((cabinet) => {
				const [x, z] = playerSpot(cabinet);
				return [cabinet.machine.id, [x, 0.16, z]] as [
					string,
					[number, number, number],
				];
			})
		);
		const layoutOf = stationLayoutFor(stations);
		for (const at of stations.values()) {
			expect(layoutOf(at)).toBe(ARCADE_STATION_LAYOUT_BACK);
		}
	});

	test("reels show icons, and a kind the arcade does not know is a dot", async () => {
		const { reelIcon } = await import("./arcade-diorama.tsx");
		expect(reelIcon("edit")).not.toBe(reelIcon("run"));
		expect(reelIcon("not-a-kind")).toBe("\u2022");
		// Names on every object's prototype are not kinds either.
		expect(reelIcon("constructor")).toBe("\u2022");
		expect(reelIcon("toString")).toBe("\u2022");
	});
});
