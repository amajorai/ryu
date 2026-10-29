// The DOM must exist before the dialog primitives load (they read it on import).
import "./rides-test-dom.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { RidesInterface } from "./rides-interface.tsx";
import {
	arrivedTrips,
	BLOCK,
	bridgeSpans,
	buildCity,
	buildRides,
	carPose,
	DEFAULT_TRIP_MINUTES,
	drawnRoute,
	driverOptions,
	finishedTrips,
	laneRoute,
	mapTrips,
	nowTrips,
	PARK_GAP,
	PICKUP,
	parkedShift,
	pointAlong,
	RIVER_HALF_WIDTH,
	riverCenter,
	routeAhead,
	routeLanes,
	routeTo,
	tripEta,
	tripHeadline,
	tripHistory,
	tripProgress,
	typicalMinutes,
} from "./rides-model.ts";
import {
	buildCityPlan,
	carSpots,
	inRiver,
	ridesFrame,
	stackPlates,
	toMap,
	toWorld,
} from "./rides-scene.ts";
import { registeredDom } from "./rides-test-dom.ts";
import { TripPreview } from "./rides-trip.tsx";

const MINUTE = 60_000;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: ago(60),
		...input,
	};
}

const EVENTS: InterfaceEvent[] = [
	{
		agentId: "agent-grace",
		end: ago(54),
		id: "run-1",
		kind: "past",
		label: "Hourly",
		outcome: "success",
		start: ago(60),
		title: "Sweep",
	},
	{
		agentId: "agent-grace",
		end: ago(110),
		id: "run-2",
		kind: "past",
		label: "Hourly",
		outcome: "success",
		start: ago(120),
		title: "Sweep",
	},
	{
		agentId: "agent-grace",
		end: ago(172),
		id: "run-3",
		kind: "past",
		label: "Hourly",
		outcome: "success",
		start: ago(180),
		title: "Sweep",
	},
];

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Never messaged",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	events: EVENTS,
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			running: true,
			title: "Crash triage",
			updatedAt: ago(2),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-old",
			title: "Old answer",
			updatedAt: ago(60 * 30),
		}),
		thread({
			id: "thread-memo",
			lastMessageRole: "user",
			title: "Office memo",
			updatedAt: ago(60 * 24 * 3),
		}),
	],
	version: 1,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

interface PortLog {
	calls: string[];
	port: InterfacePort;
	started: Parameters<InterfacePort["startThread"]>[0][];
}

function recordingPort(): PortLog {
	const calls: string[] = [];
	const started: Parameters<InterfacePort["startThread"]>[0][] = [];
	return {
		calls,
		port: {
			closeThread: () => calls.push("close"),
			openThread: (threadId) => calls.push(`open:${threadId}`),
			startThread: (input) => {
				calls.push("start");
				started.push(input);
			},
		},
		started,
	};
}

function view({
	activeThreadId = null,
	loading = false,
	params = {},
	port = recordingPort().port,
	snapshot = SNAPSHOT,
	threadView = null,
}: {
	activeThreadId?: string | null;
	loading?: boolean;
	params?: Parameters<typeof RidesInterface>[0]["params"];
	port?: InterfacePort;
	snapshot?: InterfaceSnapshot;
	threadView?: ReactNode | null;
} = {}) {
	return (
		<RidesInterface
			activeThreadId={activeThreadId}
			loading={loading}
			params={params}
			port={port}
			snapshot={snapshot}
			threadView={threadView}
		/>
	);
}

const mounted = new Set<() => Promise<void>>();
afterEach(async () => {
	for (const dispose of [...mounted]) {
		await dispose();
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

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	const dispose = async () => {
		if (!mounted.delete(dispose)) {
			return;
		}
		await act(async () => root.unmount());
		container.remove();
	};
	mounted.add(dispose);
	return {
		container,
		dispose,
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

async function typeInto(field: HTMLTextAreaElement, value: string) {
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

function buttonNamed(container: HTMLElement, name: string | RegExp) {
	return [...container.querySelectorAll("button")].find((button) => {
		const label = button.getAttribute("aria-label") ?? button.textContent;
		return typeof name === "string"
			? label?.trim() === name
			: name.test(label ?? "");
	});
}

describe("Rides model", () => {
	test("maps each thread status to a trip stage", () => {
		const { trips } = buildRides(SNAPSHOT, NOW);
		const stage = (id: string) => trips.find((trip) => trip.id === id)?.stage;
		expect(stage("thread-triage")).toBe("enroute");
		expect(stage("thread-notes")).toBe("arrived");
		expect(stage("thread-question")).toBe("requested");
		expect(stage("thread-flaky")).toBe("cancelled");
		// Replied 30 hours ago: the trip is over and lives in the history.
		expect(stage("thread-old")).toBe("completed");
		// Nobody can drive a conversation without an agent.
		expect(stage("thread-memo")).toBe("unassigned");
	});

	test("lays the city out deterministically", () => {
		const first = buildRides(SNAPSHOT, NOW);
		const second = buildRides(
			{ ...SNAPSHOT, threads: [...SNAPSHOT.threads].reverse() },
			NOW
		);
		for (const trip of first.trips) {
			const again = second.trips.find((item) => item.id === trip.id);
			expect(again?.destination).toEqual(trip.destination);
		}
		for (const car of first.cars) {
			const again = second.cars.find((item) => item.agent.id === car.agent.id);
			expect(again?.home).toEqual(car.home);
		}
	});

	test("keeps destinations and homes apart", () => {
		const { cars, trips } = buildRides(SNAPSHOT, NOW);
		const homes = new Map(cars.map((car) => [car.agent.id, car.home]));
		const points = [
			...homes.values(),
			...trips.map((trip) => trip.destination),
		];
		for (const [index, point] of points.entries()) {
			for (const other of points.slice(index + 1)) {
				const blocks =
					Math.max(Math.abs(point.x - other.x), Math.abs(point.y - other.y)) /
					BLOCK;
				expect(blocks).toBeGreaterThanOrEqual(2);
			}
		}
	});

	test("drives working agents, parks replied ones, and leaves the rest home", () => {
		const { cars, trips } = buildRides(SNAPSHOT, NOW);
		const grace = cars.find((car) => car.agent.id === "agent-grace");
		const ada = cars.find((car) => car.agent.id === "agent-ada");
		const linus = cars.find((car) => car.agent.id === "agent-linus");
		expect(grace?.state).toBe("driving");
		expect(grace?.tripId).toBe("thread-triage");
		expect(ada?.state).toBe("arrived");
		expect(ada?.tripId).toBe("thread-notes");
		// Linus replied 30 hours ago: the car has gone home.
		expect(linus?.state).toBe("idle");
		if (!(ada && linus)) {
			throw new Error("missing cars");
		}
		const notes = trips.find((trip) => trip.id === "thread-notes");
		expect(carPose(ada, trips)).toMatchObject(notes?.destination ?? {});
		expect(carPose(linus, trips)).toMatchObject(linus.home);
	});

	test("estimates trips from the agent's typical reply time", () => {
		expect(typicalMinutes("agent-grace", EVENTS)).toBe(8);
		expect(typicalMinutes("agent-ada", EVENTS)).toBe(DEFAULT_TRIP_MINUTES);
		const { trips } = buildRides(SNAPSHOT, NOW);
		const triage = trips.find((trip) => trip.id === "thread-triage");
		expect(triage?.typical).toBe(8);
		expect(triage?.etaMinutes).toBe(6);
		expect(tripEta(triage ?? trips[0]!)).toBe("6 min");
		expect(tripHeadline(triage ?? trips[0]!).status).toBe("En route");
	});

	test("never puts a live car at the pin before the agent replies", () => {
		const late = tripProgress(ago(90), 4, NOW);
		expect(late.progress).toBeLessThan(1);
		expect(late.etaMinutes).toBe(0);
		const early = tripProgress(ago(1), 4, NOW);
		expect(early.progress).toBeGreaterThan(0);
		expect(early.etaMinutes).toBe(3);
	});

	test("routes run along streets and cross the river on a bridge", () => {
		const across = routeTo({ col: 13, row: 11 });
		expect(across[0]).toEqual(PICKUP);
		for (let index = 1; index < across.length; index += 1) {
			const from = across[index - 1];
			const to = across[index];
			expect(from?.x === to?.x || from?.y === to?.y).toBe(true);
		}
		// The crossing runs down an avenue column (Station Road at col 14).
		expect(across.some((point) => point.x === 14 * BLOCK)).toBe(true);
		const near = routeTo({ col: 12, row: 4 });
		expect(near).toHaveLength(3);
		expect(near.at(-1)).toEqual({ x: 12 * BLOCK, y: 4 * BLOCK });
	});

	test("walks a route by progress and keeps what is ahead", () => {
		const route = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
		];
		expect(pointAlong(route, 0.25)).toEqual({ heading: 0, x: 50, y: 0 });
		expect(pointAlong(route, 0.75)).toEqual({ heading: 90, x: 100, y: 50 });
		expect(routeAhead(route, 0.25)).toEqual([
			{ x: 50, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
		]);
		expect(routeAhead(route, 0.75)).toEqual([
			{ x: 100, y: 50 },
			{ x: 100, y: 100 },
		]);
	});

	test("sorts the sheet's lists", () => {
		const { trips } = buildRides(SNAPSHOT, NOW);
		// Live trips first; the cancelled one waits under "Needs attention".
		expect(nowTrips(trips).map((trip) => trip.id)).toEqual([
			"thread-triage",
			"thread-question",
			"thread-flaky",
		]);
		expect(arrivedTrips(trips).map((trip) => trip.id)).toEqual([
			"thread-notes",
		]);
		const history = tripHistory(finishedTrips(trips), new Date(NOW));
		expect(history.flatMap((day) => day.trips.map((trip) => trip.id))).toEqual([
			"thread-old",
			"thread-memo",
		]);
	});

	test("puts every trip in exactly one tab", () => {
		const { trips } = buildRides(SNAPSHOT, NOW);
		const tabs = [nowTrips(trips), arrivedTrips(trips), finishedTrips(trips)];
		const seen = tabs.flat().map((trip) => trip.id);
		expect(new Set(seen).size).toBe(seen.length);
		expect(seen.length).toBe(trips.length);
	});

	test("starts a booked car clear of the pickup", () => {
		const { cars, trips } = buildRides(
			{
				...SNAPSHOT,
				threads: [
					thread({
						agentIds: ["agent-grace"],
						id: "thread-new",
						running: true,
						updatedAt: new Date(NOW).toISOString(),
					}),
				],
			},
			NOW
		);
		const grace = cars.find((car) => car.agent.id === "agent-grace");
		if (!grace) {
			throw new Error("missing car");
		}
		const pose = carPose(grace, trips);
		expect(Math.hypot(pose.x - PICKUP.x, pose.y - PICKUP.y)).toBeGreaterThan(
			60
		);
	});

	test("puts each driver on the map exactly once", () => {
		const rides = buildRides(SNAPSHOT, NOW);
		expect(rides.cars.map((car) => car.id).sort()).toEqual(
			SNAPSHOT.agents.map((agent) => agent.id).sort()
		);
		// Ada is parked at her arrival; her requested trip is drawn without a
		// car, never as a second Ada.
		const ada = rides.cars.filter((car) => car.agent.id === "agent-ada");
		expect(ada.map((car) => [car.state, car.tripId])).toEqual([
			["arrived", "thread-notes"],
		]);
		const question = rides.trips.find((trip) => trip.id === "thread-question");
		expect(question?.carless).toBe(true);
		for (const trip of mapTrips(rides)) {
			const cars = rides.cars.filter((car) => car.tripId === trip.id);
			expect(cars).toHaveLength(
				trip.stage === "cancelled" || trip.carless ? 0 : 1
			);
		}
	});

	test("keeps a busy driver on the first trip when a second is booked", () => {
		const running = (id: string, minutes: number) =>
			thread({
				agentIds: ["agent-grace"],
				id,
				running: true,
				updatedAt: ago(minutes),
			});
		const before = buildRides(
			{ ...SNAPSHOT, threads: [running("thread-first", 2)] },
			NOW
		);
		const after = buildRides(
			{
				...SNAPSHOT,
				threads: [running("thread-first", 2), running("thread-second", 0)],
			},
			NOW
		);
		const first = before.cars.find((car) => car.id === "agent-grace");
		const kept = after.cars.filter((car) => car.agent.id === "agent-grace");
		expect(first?.tripId).toBe("thread-first");
		expect(kept.map((car) => car.tripId)).toEqual(["thread-first"]);
		const second = after.trips.find((trip) => trip.id === "thread-second");
		expect(second?.carless).toBe(true);
		expect(second ? tripEta(second) : "missing").toBeNull();
	});

	test("splits routes that share a street into side-by-side lanes", () => {
		const running = ["one", "two", "three", "four", "five"].map((id) =>
			thread({
				agentIds: ["agent-grace"],
				id: `thread-${id}`,
				running: true,
				updatedAt: ago(1),
			})
		);
		const trips = mapTrips(buildRides({ ...SNAPSHOT, threads: running }, NOW));
		const lanes = routeLanes(trips);
		const shared = new Map<string, string[]>();
		for (const trip of trips) {
			const [from, to] = trip.route;
			if (from && to && from.y === to.y) {
				const key = `${Math.sign(to.x - from.x)}`;
				shared.set(key, [...(shared.get(key) ?? []), trip.id]);
			}
		}
		const groups = [...shared.values()].filter((ids) => ids.length > 1);
		expect(groups.length).toBeGreaterThan(0);
		for (const ids of groups) {
			const firstLanes = ids.map((id) => lanes.get(id)?.[0]);
			expect(new Set(firstLanes).size).toBe(ids.length);
			expect(firstLanes.reduce((sum = 0, lane = 0) => sum + lane, 0)).toBe(0);
		}
		const route = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 },
		];
		expect(laneRoute(route, [0.5, -0.5], 10)).toEqual([
			{ x: 0, y: 5 },
			{ x: 95, y: 5 },
			{ x: 95, y: 100 },
		]);
	});

	test("draws only live trips and parked arrivals", () => {
		const rides = buildRides(SNAPSHOT, NOW);
		expect(
			mapTrips(rides)
				.map((trip) => trip.id)
				.sort()
		).toEqual([
			"thread-flaky",
			"thread-notes",
			"thread-question",
			"thread-triage",
		]);
	});

	test("offers available drivers first", () => {
		const { trips } = buildRides(SNAPSHOT, NOW);
		const options = driverOptions(SNAPSHOT, trips);
		expect(options.map((option) => option.agent.name)).toEqual([
			"Ada",
			"Linus",
			"Grace",
		]);
		expect(options[2]?.available).toBe(false);
		expect(options[2]?.waitMinutes).toBe(6);
	});

	test("keeps the river inside the city", () => {
		const y = riverCenter(BLOCK * 8);
		expect(y).toBeGreaterThan(BLOCK * 7);
		expect(y).toBeLessThan(BLOCK * 10);
	});

	test("finds a bridge wherever a road crosses the river", () => {
		const city = buildCity();
		const central = city.avenues.find((road) => road.id === "col-10");
		if (!central) {
			throw new Error("missing avenue");
		}
		const spans = bridgeSpans(central);
		expect(spans).toHaveLength(1);
		const river = riverCenter(central.from.x);
		expect(spans[0]?.from.y ?? 0).toBeLessThan(river - 58);
		expect(spans[0]?.to.y ?? 0).toBeGreaterThan(river + 58);
		for (const diagonal of city.diagonals) {
			expect(bridgeSpans(diagonal).length).toBeGreaterThan(0);
		}
	});

	test("keeps every block on dry land, clear of the river banks", () => {
		const blocks = buildCity().blocks;
		for (const block of blocks) {
			for (let step = 0; step <= 8; step += 1) {
				const x = block.x + (block.w * step) / 8;
				const center = riverCenter(x);
				const wet =
					block.y < center + RIVER_HALF_WIDTH &&
					block.y + block.h > center - RIVER_HALF_WIDTH;
				expect(wet).toBe(false);
			}
		}
	});

	test("folds the city to the streets the trips use, river included", () => {
		const rides = buildRides(SNAPSHOT, NOW);
		const frame = ridesFrame(rides);
		expect(frame.cols).toEqual([...frame.cols].sort((a, b) => a - b));
		for (const row of [7, 8, 9, 10]) {
			expect(frame.rows).toContain(row);
		}
		// Every car and pin stands on a kept street, inside the city.
		const plan = buildCityPlan(frame);
		for (const point of [
			PICKUP,
			...mapTrips(rides).map((trip) => trip.destination),
		]) {
			const [x, , z] = toWorld(frame, point);
			expect(x).toBeGreaterThanOrEqual(plan.rect.minX);
			expect(x).toBeLessThanOrEqual(plan.rect.maxX);
			expect(z).toBeGreaterThanOrEqual(plan.rect.minZ);
			expect(z).toBeLessThanOrEqual(plan.rect.maxZ);
			const back = toMap(frame, x, z);
			expect(back.x).toBeCloseTo(point.x, 5);
			expect(back.y).toBeCloseTo(point.y, 5);
		}
		// The diorama is centred on the origin.
		expect(plan.rect.minX + plan.rect.maxX).toBeCloseTo(0, 5);
		expect(plan.rect.minZ + plan.rect.maxZ).toBeCloseTo(0, 5);
	});

	test("keeps diorama blocks off the water and cars on the road", () => {
		const rides = buildRides(SNAPSHOT, NOW);
		const frame = ridesFrame(rides);
		const plan = buildCityPlan(frame);
		expect(plan.blocks.length).toBeGreaterThan(0);
		for (const { rect } of plan.blocks) {
			for (const x of [rect.minX, (rect.minX + rect.maxX) / 2, rect.maxX]) {
				expect(inRiver(frame, x, rect.minZ)).toBe(false);
				expect(inRiver(frame, x, rect.maxZ)).toBe(false);
			}
		}
		const spots = carSpots(frame, rides);
		expect(spots.map((spot) => spot.car.id).sort()).toEqual(
			rides.cars.map((car) => car.id).sort()
		);
		for (const spot of spots) {
			const onBlock = plan.blocks.some(
				({ rect }) =>
					spot.at[0] > rect.minX + 0.05 &&
					spot.at[0] < rect.maxX - 0.05 &&
					spot.at[2] > rect.minZ + 0.05 &&
					spot.at[2] < rect.maxZ - 0.05
			);
			expect(onBlock).toBe(false);
		}
	});

	test("lifts a plate that would cover another", () => {
		const heights = stackPlates([
			{ at: [0, 1.3, 0], chars: 8, id: "pin" },
			{ at: [0.1, 1.3, 0.1], chars: 5, id: "car" },
			{ at: [6, 1, -6], chars: 5, id: "far" },
		]);
		expect(heights.get("pin")).toBe(1.3);
		expect(heights.get("car") ?? 0).toBeGreaterThan(1.3);
		expect(heights.get("far")).toBe(1);
	});

	test("parks an arrived car just short of its pin", () => {
		expect(parkedShift(0)).toEqual({ x: -PARK_GAP, y: 0 });
		expect(parkedShift(90)).toEqual({ x: 0, y: -PARK_GAP });
		expect(parkedShift(-90)).toEqual({ x: 0, y: PARK_GAP });
	});

	test("drops the road already driven unless the trip is selected", () => {
		const rides = buildRides(SNAPSHOT, NOW);
		const live = rides.trips.find(
			(trip) => trip.stage === "enroute" && !trip.carless
		);
		const cancelled = rides.trips.find((trip) => trip.stage === "cancelled");
		const parked = rides.trips.find(
			(trip) => trip.stage === "arrived" && !trip.carless
		);
		if (!(live && cancelled && parked)) {
			throw new Error("missing fixture trips");
		}
		const car = pointAlong(live.route, live.progress);
		const ahead = drawnRoute(live, false);
		expect(ahead[0]?.x).toBeCloseTo(car.x);
		expect(ahead[0]?.y).toBeCloseTo(car.y);
		expect(drawnRoute(live, true)).toEqual(live.route);
		expect(drawnRoute(cancelled, false)).toEqual(cancelled.route.slice(-2));
		expect(drawnRoute(parked, false)).toEqual([]);
	});
});

describe("Rides interface", () => {
	test("renders the sheet and the map statically", () => {
		const markup = renderToStaticMarkup(view());
		expect(markup).toContain('data-testid="interface-rides"');
		expect(markup).toContain("Get a ride");
		expect(markup).toContain("Where to?");
		expect(markup).toContain('role="tablist"');
		expect(markup).toContain("Crash triage");
		expect(markup).toContain('data-testid="iso-stage"');
		expect(markup).toContain('data-testid="rides-list"');
	});

	test("shows skeleton rows while loading", () => {
		const markup = renderToStaticMarkup(view({ loading: true }));
		expect(markup).toContain('aria-label="Loading trips"');
		expect(markup).not.toContain("Crash triage");
	});

	test("explains an empty workspace", () => {
		const markup = renderToStaticMarkup(view({ snapshot: EMPTY }));
		expect(markup).toContain("No drivers yet");
		expect(markup).toContain("No trips under way");
	});

	test("books the typed destination with the chosen driver", async () => {
		const log = recordingPort();
		const mounted = await mount(view({ port: log.port }));
		const field = mounted.container.querySelector("textarea");
		if (!field) {
			throw new Error("missing field");
		}
		expect(mounted.container.textContent).not.toContain("Choose a driver");
		await typeInto(field, "  Summarise the crash logs  ");
		expect(mounted.container.textContent).toContain("Choose a driver");
		const linus = mounted.container.querySelector<HTMLInputElement>(
			'input[type="radio"][value="agent-linus"]'
		);
		await click(linus);
		await click(buttonNamed(mounted.container, "Book Linus"));
		expect(log.started).toEqual([
			{ agentId: "agent-linus", prompt: "Summarise the crash logs" },
		]);
		expect(field.value).toBe("");
		await mounted.dispose();
	});

	test("does not book an empty destination", async () => {
		const log = recordingPort();
		const mounted = await mount(view({ port: log.port }));
		const field = mounted.container.querySelector("textarea");
		if (!field) {
			throw new Error("missing field");
		}
		await typeInto(field, "   ");
		await act(async () => {
			field.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
			);
		});
		expect(log.started).toHaveLength(0);
		expect(buttonNamed(mounted.container, /^Book /)).toBeUndefined();
		await mounted.dispose();
	});

	test("opens a trip from its row", async () => {
		const log = recordingPort();
		const mounted = await mount(view({ port: log.port }));
		const row = mounted.container.querySelector(
			'[data-trip-id="thread-triage"]'
		);
		await click(row);
		expect(log.calls).toContain("open:thread-triage");
		await mounted.dispose();
	});

	test("switches between Now, Arrived, and Trips", async () => {
		const mounted = await mount(view());
		const tabs = [
			...mounted.container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
		];
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Now3",
			"Arrived1",
			"Trips2",
		]);
		await click(tabs[1]);
		const panel = mounted.container.querySelector('[role="tabpanel"]');
		expect(panel?.textContent).toContain("Release notes");
		expect(panel?.textContent).not.toContain("Crash triage");
		await act(async () => {
			tabs[1]?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
			);
		});
		expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
		const history = mounted.container.querySelector('[role="tabpanel"]');
		expect(history?.textContent).toContain("Old answer");
		expect(history?.textContent).toContain("No driver assigned");
		expect(history?.textContent).not.toContain("Release notes");
		await mounted.dispose();
	});

	test("shows the host's thread view as the open trip and closes it", async () => {
		const log = recordingPort();
		const mounted = await mount(
			view({
				activeThreadId: "thread-triage",
				port: log.port,
				threadView: <div data-testid="host-thread">Host chat</div>,
			})
		);
		const host = mounted.container.querySelector('[data-testid="host-thread"]');
		expect(host).not.toBeNull();
		expect(mounted.container.textContent).toContain("Arriving in");
		expect(mounted.container.textContent).toContain("Crash triage");
		expect(mounted.container.querySelector("textarea")).toBeNull();
		await click(buttonNamed(mounted.container, "Back to trips"));
		expect(log.calls).toContain("close");
		await act(async () => {
			host?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(log.calls.filter((call) => call === "close")).toHaveLength(2);
		await mounted.dispose();
	});

	test("lists drivers nearby only while nothing is under way", async () => {
		const busy = renderToStaticMarkup(view());
		expect(busy).not.toContain("Drivers nearby");
		const idle = {
			...SNAPSHOT,
			threads: SNAPSHOT.threads.filter(
				(item) => item.id === "thread-old" || item.id === "thread-memo"
			),
		};
		const mounted = await mount(view({ snapshot: idle }));
		expect(mounted.container.textContent).toContain("Drivers nearby");
		await click(buttonNamed(mounted.container, /^Choose Linus/));
		const field = mounted.container.querySelector("textarea");
		expect(document.activeElement).toBe(field);
		if (!field) {
			throw new Error("missing field");
		}
		await typeInto(field, "Check the old answer");
		expect(buttonNamed(mounted.container, "Book Linus")).toBeDefined();
		await mounted.dispose();
	});

	test("lets the phone sheet be pulled open from its handle", async () => {
		const mounted = await mount(view());
		const handle = buttonNamed(mounted.container, "Expand trips");
		expect(handle?.getAttribute("aria-expanded")).toBe("false");
		await click(handle);
		expect(
			buttonNamed(mounted.container, "Collapse trips")?.getAttribute(
				"aria-expanded"
			)
		).toBe("true");
		await mounted.dispose();
	});

	test("labels each parked car once, on its Arrived chip", () => {
		const markup = renderToStaticMarkup(view());
		// The first trip under way is shown by default, so chips the frame
		// cuts may fold away; a parked driver is never named twice.
		// The selected pin's name leads with its visible words.
		expect(markup).toContain("Crash triage, En route. Open the trip");
		const adaNames = markup.match(/>Ada</g) ?? [];
		expect(adaNames.length).toBeLessThanOrEqual(1);
		// The Arrived chip is the same plain chip as an ETA, with no edge mark.
		expect(markup).not.toContain("border-l-2");
	});

	test("picks an available driver from their car on the map", async () => {
		const mounted = await mount(view());
		await click(buttonNamed(mounted.container, /^Linus, available/));
		const field = mounted.container.querySelector("textarea");
		if (!field) {
			throw new Error("missing field");
		}
		expect(document.activeElement).toBe(field);
		await typeInto(field, "Look at the old answer");
		expect(buttonNamed(mounted.container, "Book Linus")).toBeDefined();
		await mounted.dispose();
	});
});

describe("Rides trip preview", () => {
	test("shows the driver, both stops and the estimate, and opens the trip", async () => {
		const rides = buildRides(SNAPSHOT, NOW);
		const trip = rides.trips.find(
			(item) => item.stage === "enroute" && !item.carless
		);
		if (!trip) {
			throw new Error("Expected a trip under way");
		}
		const opened: string[] = [];
		const mounted = await mount(
			<TripPreview now={NOW} onOpen={() => opened.push(trip.id)} trip={trip} />
		);
		const text = mounted.container.textContent ?? "";
		expect(text).toContain(trip.driver?.name ?? "");
		expect(text).toContain("You");
		expect(text).toContain(trip.thread.title);
		expect(text).toContain("est.");
		await click(buttonNamed(mounted.container, "Open trip"));
		expect(opened).toEqual([trip.id]);
		await mounted.dispose();
	});
});

describe("rides settings", () => {
	const time = (container: HTMLElement) =>
		container.querySelector<HTMLElement>("[data-rides-time]")?.dataset
			.ridesTime;

	test("time of day follows the color theme by default; day or night override it, live", async () => {
		const mount1 = await mount(view());
		expect(time(mount1.container)).toBe("day");
		await mount1.rerender(view({ params: { timeOfDay: "night" } }));
		expect(time(mount1.container)).toBe("night");
		await mount1.rerender(view({ params: { timeOfDay: "day" } }));
		expect(time(mount1.container)).toBe("day");
		// The theme's dark mode is night while the setting follows it.
		document.documentElement.classList.add("dark");
		await mount1.rerender(view({ params: { timeOfDay: "theme" } }));
		expect(time(mount1.container)).toBe("night");
		await mount1.rerender(view({ params: { timeOfDay: "day" } }));
		expect(time(mount1.container)).toBe("day");
		document.documentElement.classList.remove("dark");
		await mount1.dispose();
	});
});
