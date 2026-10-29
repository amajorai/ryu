import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM must exist before the dialog primitives load (they read it on import).
GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, useState } = await import("react");
const { actRouteShare, ridesActTrips, ridesLimitText, ridesYouSpot } =
	await import("./rides-acts.tsx");
const { createRoot } = await import("react-dom/client");
const { agentActs } = await import("@ryuhq/protocol/interfaces");
const { FIXTURE_CLOCK, FIXTURE_NOW, usefulStateFixture } = await import(
	"./game-acts-fixture.ts"
);
const { ActClockProvider } = await import("./use-acts.ts");
const { RidesInterface } = await import("./rides-interface.tsx");

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
	resetBody();
});

/**
 * Unmounts what a test left mounted and clears anything portalled to the
 * body (sheets, dialogs, the announcer) so no test sees another's DOM.
 */
function resetBody() {
	document.body.replaceChildren();
	document.body.removeAttribute("style");
	document.body.removeAttribute("data-scroll-locked");
}

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

function rides(snapshot: InterfaceSnapshot, acted = true) {
	const game = (
		<RidesInterface
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

/** A row age from `updatedAt` ("2m ago", "just now"). */
const AGE = /\b\d+[smhdw] ago\b|just now/;

/** The agent's row in the no-WebGL list: its car's list item. */
function rowOf(container: HTMLElement, name: string): Element {
	const row = container
		.querySelector(`[data-act-agent="${agentId(name)}"]`)
		?.closest("li");
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

describe("rides useful state (fallback rows)", () => {
	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			await mount(rides(fixture));
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("every agent's car is a per-agent row described by act.ariaLabel", async () => {
		const container = await mount(rides(fixture));
		for (const act of actsNow.values()) {
			const car = container.querySelector(`[data-act-agent="${act.agentId}"]`);
			expect(car).not.toBeNull();
			expect(described(car)).toBe(act.ariaLabel);
		}
	});

	test("a car without a trip is named for pressing it, never 'available'", async () => {
		const container = await mount(rides(fixture));
		for (const act of actsNow.values()) {
			const name =
				container
					.querySelector(`[data-act-agent="${act.agentId}"]`)
					?.getAttribute("aria-label") ?? "";
			expect(name).not.toContain("available");
			expect(name.startsWith(act.agentName)).toBe(true);
		}
	});

	test("Ada's row Answer button opens the ask card", async () => {
		const container = await mount(rides(fixture));
		await press(rowButtons(container, "Ada", "Answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Can I run shell.run now?");
	});

	test("Di's row has two Details buttons, the second opens Nightly backup", async () => {
		const container = await mount(rides(fixture));
		const details = rowButtons(container, "Di", "Details");
		expect(details).toHaveLength(2);
		await press(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent ?? ""
		).toContain("Nightly backup");
	});

	test("the summary, caption and Queue button", async () => {
		const container = await mount(rides(fixture));
		expect(container.querySelector("[data-act-summary]")?.textContent).toBe(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		expect(container.querySelector("[data-blind-spot]")).not.toBeNull();
		expect(container.querySelector("[data-queue-button]")?.textContent).toBe(
			"Queue · 9"
		);
		expect(container.querySelector("[data-act-announcer]")).not.toBeNull();
	});

	test("legacy counters and ages give way to the acts", async () => {
		// The sheet's clock is the wall clock: pin it to the fixture's now,
		// so the legacy rows would read "2m ago" and the check means something.
		const wallClock = Date.now;
		Date.now = () => FIXTURE_NOW;
		try {
			const { asks: _asks, ...oldHost } = fixture;
			const legacy = (await mount(rides(oldHost, false))).textContent ?? "";
			expect(legacy).toMatch(AGE);
			const text = (await mount(rides(fixture))).textContent ?? "";
			expect(text).not.toContain("under way");
			expect(text).not.toMatch(AGE);
			expect(text).toContain("working");
		} finally {
			Date.now = wallClock;
		}
	});

	test("without asks the map and its counters are unchanged", async () => {
		const { asks: _asks, ...oldHost } = fixture;
		const sansIds = (html: string) =>
			html.replace(/_r_\w+_/g, "_r_").replace(/opacity: [\d.]+/g, "opacity: _");
		const acted = await mount(rides(oldHost));
		const plain = await mount(rides(oldHost, false));
		expect(acted.querySelector("[data-act-status]")).toBeNull();
		expect(sansIds(acted.innerHTML)).toBe(sansIds(plain.innerHTML));
	});
});

describe("rides trips from the acts", () => {
	test("rows, stages and arrivals agree with the act counters", () => {
		const trips = ridesActTrips(fixture, actsNow);
		const of = (id: string) => trips.get(id);
		expect(of("t-ada")).toMatchObject({
			stage: "requested",
			tone: "you",
			word: "Waiting on you",
		});
		expect(of("t-ada")?.detail).toBe(
			"Ada is asking you: Can I run shell.run now?"
		);
		expect(of("t-bo")?.word).toBe("Waiting on you");
		expect(of("t-cy")?.stage).toBe("enroute");
		// Only counted failures need attention: Di's; Ed's interrupt is
		// pulled over and Ha's old failure is a dim word in the history.
		const attention = [...trips.entries()]
			.filter(([, trip]) => trip.stage === "cancelled")
			.map(([id]) => id);
		expect(attention.sort()).toEqual(["t-di", "t-di-nightly"]);
		expect(of("t-ed")).toMatchObject({ stage: "completed", tone: "plain" });
		expect(of("agentrun_ha1")).toMatchObject({
			stage: "completed",
			tone: "dim",
		});
		// The arrivals are exactly the reply asks' trips, as the Queue counts.
		const arrived = [...trips.entries()]
			.filter(([, trip]) => trip.stage === "arrived")
			.map(([id]) => id)
			.sort();
		expect(arrived).toEqual(["t-gu", "t-ju"]);
		const replies = (fixture.asks ?? []).filter((ask) => ask.kind === "reply");
		expect(arrived).toHaveLength(replies.length);
		// Fa's limit is on the agent: her trip is a red light, not Completed.
		expect(of("t-fa")?.word).toBe("Red light");
		expect(of("t-ed")?.done).toBe(false);
	});

	test("open trips say the act, never the legacy stage", async () => {
		for (const threadId of ["t-ada", "t-ed"]) {
			const container = await mount(
				<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
					<RidesInterface
						activeThreadId={threadId}
						loading={false}
						params={{}}
						port={port}
						snapshot={fixture}
						threadView={<div data-thread-view="" />}
					/>
				</ActClockProvider>
			);
			const text = container.textContent ?? "";
			expect(text).not.toMatch(/Requested|Completed|replied/);
		}
		const ada = await mount(
			<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
				<RidesInterface
					activeThreadId="t-ada"
					loading={false}
					params={{}}
					port={port}
					snapshot={fixture}
					threadView={<div />}
				/>
			</ActClockProvider>
		);
		expect(ada.textContent).toContain("Ada is asking you:");
	});

	test("a trip's sentence quotes the ask its driver's act shows", () => {
		const live = usefulStateFixture({ livePermission: true });
		const acts = agentActs(live, FIXTURE_NOW, FIXTURE_CLOCK);
		const ada = [...acts.values()].find((item) => item.agentName === "Ada");
		if (!(ada?.act === "asking" && ada.ask && ada.threadId)) {
			throw new Error("Ada asking on a thread");
		}
		const detail = ridesActTrips(live, acts).get(ada.threadId)?.detail ?? "";
		expect(detail).toContain(ada.ask.text.replace(/`/g, ""));
	});

	test("details never leak under redaction", async () => {
		const { FIXTURE_PRIVATE_STRINGS } = await import(
			"@ryuhq/protocol/interfaces-fixture"
		);
		const hidden = usefulStateFixture({ privacy: "redacted" });
		const acts = agentActs(hidden, FIXTURE_NOW, FIXTURE_CLOCK);
		const words = [...ridesActTrips(hidden, acts).values()]
			.flatMap((trip) => [trip.word, trip.detail])
			.join("\n");
		for (const secret of FIXTURE_PRIVATE_STRINGS) {
			expect(words).not.toContain(secret);
		}
	});

	test("a group thread's sentence names the member who asks", () => {
		const bo = fixture.agents.find((agent) => agent.id === agentId("Bo"));
		const ada = fixture.agents.find((agent) => agent.id === agentId("Ada"));
		if (!(bo && ada)) {
			throw new Error("Bo and Ada");
		}
		const group: InterfaceSnapshot = {
			...fixture,
			threads: fixture.threads.map((thread) =>
				thread.id === "t-ada"
					? { ...thread, agentIds: [bo.id, ada.id] }
					: thread
			),
		};
		const acts = agentActs(group, FIXTURE_NOW, FIXTURE_CLOCK);
		expect(ridesActTrips(group, acts).get("t-ada")?.detail).toStartWith(
			"Ada is asking you:"
		);
	});

	test("an old failed thread with unread is no arrival", () => {
		const unread: InterfaceSnapshot = {
			...fixture,
			threads: fixture.threads.map((thread) =>
				thread.id === "agentrun_ha1" ? { ...thread, unread: 1 } : thread
			),
		};
		const acts = agentActs(unread, FIXTURE_NOW, FIXTURE_CLOCK);
		const trip = ridesActTrips(unread, acts).get("agentrun_ha1");
		expect(trip?.stage).not.toBe("arrived");
		expect(trip?.word).not.toBe("Answer ready");
	});

	test("a limit on a trip is a red light, never a failure", () => {
		const limited: InterfaceSnapshot = {
			...fixture,
			threads: fixture.threads.map((thread) =>
				thread.id === "t-di" && thread.blocker
					? {
							...thread,
							blocker: {
								...thread.blocker,
								kind: "rate-limited",
								title: "Limit hit",
							},
						}
					: thread
			),
		};
		expect(
			limited.threads.find((thread) => thread.id === "t-di")?.blocker?.kind
		).toBe("rate-limited");
		const acts = agentActs(limited, FIXTURE_NOW, FIXTURE_CLOCK);
		const trip = ridesActTrips(limited, acts).get("t-di");
		expect(trip?.stage).not.toBe("cancelled");
		expect(trip?.tone).not.toBe("alert");
	});

	test("a working car's place on its route is its pips, or nothing", () => {
		const cy = [...actsNow.values()].find((item) => item.agentName === "Cy");
		// Cy's plan is 3 of 7 done.
		expect(actRouteShare(actsNow, cy?.threadId ?? "")).toBeCloseTo(3 / 7);
		expect(actRouteShare(actsNow, "no-such-thread")).toBeNull();
	});

	test("with acts no trip is staged or grouped by updatedAt", async () => {
		const { buildRides, finishedTrips, tripHistory } = await import(
			"./rides-model.ts"
		);
		const trips = ridesActTrips(fixture, actsNow);
		// Far past every PARKED_FOR and day boundary: the stages hold.
		const later = FIXTURE_NOW + 3 * 24 * 60 * 60 * 1000;
		const city = buildRides(fixture, later, {
			progressOf: (thread) => actRouteShare(actsNow, thread.id),
			stageOf: (thread) => trips.get(thread.id)?.stage ?? "completed",
		});
		for (const trip of city.trips) {
			const expected = trips.get(trip.id)?.stage;
			expect([expected, "unassigned"]).toContain(trip.stage);
		}
		const days = tripHistory(finishedTrips(city.trips), new Date(later), true);
		expect(days.map((day) => day.label)).toEqual(["Earlier"]);
	});
});

describe("rides return focus (13h)", () => {
	test("with the opener and every queue button gone, focus lands on the heading", async () => {
		const only = usefulStateFixture({ agents: ["ada"] });
		let setSnapshot: ((next: InterfaceSnapshot) => void) | null = null;
		function Host() {
			const [snapshot, set] = useState<InterfaceSnapshot>(only);
			setSnapshot = set;
			return rides(snapshot);
		}
		const container = await mount(<Host />);
		const needYou = container.querySelector<HTMLElement>("[data-need-you]");
		act(() => needYou?.focus());
		await press(needYou);
		expect(document.querySelector("[data-ask-card]")).not.toBeNull();
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
		expect(document.activeElement?.textContent).toBe("Rides");
	});
});

describe("rides kerb and words", () => {
	test("a limit is a red light; the phone kerb is one diagonal", () => {
		const fa = [...actsNow.values()].find((item) => item.agentName === "Fa");
		if (fa) {
			expect(ridesLimitText(fa, "15:10")).toBe("Red light till 15:10");
			expect(ridesLimitText(fa, null)).toBe("Red light");
		}
		const { layout } = ridesYouSpot([0, 0, 0], true);
		const screen = (["you-1", "you-2", "you-3", "you-4"] as const).map(
			(slot) => {
				const [x, , z] = layout.slots[slot];
				return { across: (x - z) * Math.SQRT1_2, out: (x + z) * Math.SQRT1_2 };
			}
		);
		for (let index = 1; index < screen.length; index++) {
			expect(
				(screen[index]?.across ?? 0) - (screen[index - 1]?.across ?? 0)
			).toBeGreaterThan(1);
			expect(
				(screen[index]?.out ?? 0) - (screen[index - 1]?.out ?? 0)
			).toBeGreaterThan(1);
		}
	});
});

describe("rides kerb on the city's roads", () => {
	test("every kerb place is on road and a car length from every car", async () => {
		const { buildRides, PICKUP } = await import("./rides-model.ts");
		const { buildCityPlan, carSpots, ridesFrame, toWorld } = await import(
			"./rides-scene.ts"
		);
		const { onRoad } = await import("./rides-acts.tsx");
		const city = buildRides(fixture);
		const frame = ridesFrame(city);
		const plan = buildCityPlan(frame);
		const homes = carSpots(frame, city).map((spot) => spot.at);
		for (const narrow of [false, true]) {
			const { layout } = ridesYouSpot(
				toWorld(frame, PICKUP, 0.02),
				narrow,
				plan,
				homes
			);
			for (const slot of ["you-1", "you-2", "you-3", "you-4"] as const) {
				const [x, , z] = layout.slots[slot];
				expect(onRoad(plan, x, z)).toBe(true);
				for (const home of homes) {
					expect(Math.hypot(home[0] - x, home[2] - z)).toBeGreaterThanOrEqual(
						1.6
					);
				}
			}
		}
	});
});

describe("rides queue rows (test 15)", () => {
	test("Gu's row Open answer opens the reply card", async () => {
		const container = await mount(rides(fixture));
		await press(rowButtons(container, "Gu", "Open answer")[0]);
		expect(
			document.querySelector("[data-ask-card]")?.textContent ?? ""
		).toContain("Edited 3 files");
	});

	test("AskQueueList lists Ha's heal_fix suggestion", async () => {
		const container = await mount(rides(fixture));
		const names = [
			...container.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].map((item) => item.getAttribute("aria-label"));
		expect(names).toContain(
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
	});
});
