import "./card-table-test-dom.ts";
// The DOM first, before React loads (the side-effect import above stays first).
import { describe, expect, test } from "bun:test";
import type {
	InterfaceAgent,
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	agentActs,
	resolveInterfaceParams,
	unownedAsks,
	waitLabel,
} from "@ryuhq/protocol/interfaces";
import { hasReducedMotionListener, prefersReducedMotion } from "motion/react";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { cardOverlays, seatFelt, seatLayout } from "./card-table-acts.tsx";
import {
	buildDecks,
	DOCK_NAMED_MIN,
	deckGrid,
	deckSummary,
	dockLayout,
	FAN_LIFT,
	FAN_MIN_EXPOSED_PX,
	FAN_TOTAL_DEGREES,
	fanLayout,
	fanPose,
	gridMove,
	MAX_FAN_CARDS,
	MAX_STACK_EDGES,
	pilePose,
	STACK_EDGE,
	tiltOverhang,
	UNASSIGNED_DECK,
} from "./card-table-decks.ts";
import { DRAWER_OVERLAY_BELOW, drawerWidth } from "./card-table-drawer.tsx";
import {
	CardFace,
	CardTableHand,
	HeldCardsList,
	messageLines,
} from "./card-table-hand.tsx";
import {
	CardTableInterface,
	cardTableSettings,
} from "./card-table-interface.tsx";
import {
	actCardVerdicts,
	actPotThreads,
	actSeatTone,
	boxAround,
	CARD_ORIGIN_Y,
	COMPACT_EMPTY_SEAT_HALF,
	COMPACT_PLATE_HALF,
	cardFaceMetrics,
	cardIndexRect,
	cardRank,
	dealHand,
	EMPTY_SEAT_HALF,
	emptyHandRect,
	emptyPanelRect,
	exposedWidth,
	fanOverhang,
	HOVER_LIFT,
	handLayout,
	handPose,
	handTop,
	LIFTED_TILT,
	MAX_HAND,
	MAX_SEATS,
	nextDeal,
	PLATE_HALF,
	poseBounds,
	potThreads,
	rectsOverlap,
	seatAgents,
	seatTone,
	stackChips,
	tableGeometry,
	unseatedThreads,
	untilLabel,
} from "./card-table-model.ts";
import {
	CARD_BACK,
	CARD_ROOM_3D,
	CHIP_COLORS,
	cardBackFor,
	cardRoomCloth,
	DECK_PRESETS,
	FELT_BACKGROUND,
	FELT_BACKGROUND_DARK,
	FELT_PRESETS,
	spreadFelt,
} from "./card-table-palette.ts";
import { timerLapSeconds } from "./card-table-pieces.tsx";
import { DealerButton } from "./card-table-pot.tsx";
import { CardTableRail, railLabel } from "./card-table-rail.tsx";
import { ROOM, roomSeats, TABLE } from "./card-table-room.ts";
import { threadReading } from "./card-table-rows.tsx";
import {
	EmptySeatMenuBody,
	SeatMenuBody,
	TableSeat,
} from "./card-table-seat.tsx";
import { cardTableDom } from "./card-table-test-dom.ts";
import {
	FIXTURE_AGENT_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW,
	FIXTURE_PRIVATE_STRINGS,
	FIXTURE_THREAD_IDS,
	usefulStateFixture,
} from "./game-acts-fixture.ts";
import { overlayBudget, stageAgents, youSpotSlots } from "./game3d-acts.ts";
import { ActClockProvider } from "./use-acts.ts";

cardTableDom();

const MINUTE = 60_000;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

function agent(
	id: string,
	name: string,
	status: InterfaceAgent["status"] = "idle"
): InterfaceAgent {
	return {
		avatarUrl: null,
		description: `${name} does things`,
		id,
		name,
		status,
	};
}

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

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		agent("agent-ada", "Ada"),
		agent("agent-grace", "Grace", "working"),
		agent("agent-linus", "Linus"),
	],
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
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
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			id: "thread-loose",
			lastMessageRole: "user",
			title: "Loose ends",
			updatedAt: ago(600),
		}),
	],
	version: 1,
};

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function table({
	activeThreadId = null,
	layout = "poker",
	loading = false,
	port,
	snapshot = SNAPSHOT,
	threadView = null,
}: {
	activeThreadId?: string | null;
	layout?: "poker" | "spread";
	loading?: boolean;
	port: InterfacePort;
	snapshot?: InterfaceSnapshot;
	threadView?: ReactNode;
}): ReactElement {
	return (
		<CardTableInterface
			activeThreadId={activeThreadId}
			loading={loading}
			params={{ layout }}
			port={port}
			snapshot={snapshot}
			threadView={threadView}
		/>
	);
}

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

async function press(target: EventTarget, key: string) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
		);
	});
}

function byLabel(root: ParentNode, label: string): HTMLElement | undefined {
	return [...root.querySelectorAll<HTMLElement>("[aria-label]")].find(
		(element) => element.getAttribute("aria-label") === label
	);
}

function buttonByText(root: ParentNode, text: string) {
	return [...root.querySelectorAll("button")].find(
		(candidate) => candidate.textContent?.trim() === text
	);
}

describe("card table model", () => {
	test("seats working agents first, then by latest activity", () => {
		const { rail, seated } = seatAgents(SNAPSHOT);
		expect(seated.map((seat) => seat.agent.name)).toEqual([
			"Grace",
			"Ada",
			"Linus",
		]);
		expect(rail).toEqual([]);
		const [grace, ada, linus] = seated;
		expect(grace && seatTone(grace)).toBe("working");
		expect(grace?.running.map((item) => item.id)).toEqual(["thread-triage"]);
		expect(grace?.attention).toBe(1);
		expect(ada?.yourTurn).toBe(1);
		expect(ada?.agentTurn).toBe(1);
		expect(ada && seatTone(ada)).toBe("your-turn");
		expect(linus && seatTone(linus)).toBe("idle");
		expect(linus?.threads).toEqual([]);
	});

	test("puts agents past the sixth chair on the rail", () => {
		const agents = Array.from({ length: 9 }, (_, index) =>
			agent(`agent-${index}`, `Agent ${index}`)
		);
		const threads = agents.map((item, index) =>
			thread({
				agentIds: [item.id],
				id: `thread-${index}`,
				updatedAt: ago(index + 1),
			})
		);
		const { rail, seated } = seatAgents({ ...SNAPSHOT, agents, threads });
		expect(seated).toHaveLength(MAX_SEATS);
		expect(rail.map((seat) => seat.agent.id)).toEqual([
			"agent-6",
			"agent-7",
			"agent-8",
		]);
	});

	test("deals failures first, then replies, newest first, capped", () => {
		expect(dealHand(SNAPSHOT).cards.map((item) => item.id)).toEqual([
			"thread-flaky",
			"thread-notes",
		]);
		const many = Array.from({ length: MAX_HAND + 3 }, (_, index) =>
			thread({ id: `reply-${index}`, updatedAt: ago(index) })
		);
		const hand = dealHand({ ...SNAPSHOT, threads: many });
		expect(hand.cards).toHaveLength(MAX_HAND);
		expect(hand.held).toBe(3);
		expect(hand.cards[0]?.id).toBe("reply-0");
	});

	test("the pot holds live runs; the rail keeps agentless threads", () => {
		expect(potThreads(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-triage",
		]);
		expect(unseatedThreads(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-loose",
		]);
	});

	test("names the next scheduled run and how far off it is", () => {
		const events: InterfaceEvent[] = [
			{
				agentId: null,
				id: "past",
				kind: "past",
				label: null,
				start: ago(30),
				title: "Earlier",
			},
			{
				agentId: null,
				id: "later",
				kind: "upcoming",
				label: null,
				start: ago(-600),
				title: "Later",
			},
			{
				agentId: null,
				id: "soon",
				kind: "upcoming",
				label: null,
				start: ago(-45),
				title: "Soon",
			},
		];
		expect(nextDeal(events, NOW)?.id).toBe("soon");
		expect(nextDeal(undefined, NOW)).toBeUndefined();
		expect(untilLabel(ago(-45), NOW)).toBe("in 45m");
		expect(untilLabel(ago(-180), NOW)).toBe("in 3h");
		expect(untilLabel(ago(-60 * 50), NOW)).toBe("in 2d");
	});

	test("ranks a card by its agent and stacks one chip per thread", () => {
		expect(cardRank("ada")).toBe("A");
		expect(cardRank(undefined)).toBe("–");
		expect(stackChips(0)).toBe(0);
		expect(stackChips(3)).toBe(3);
		expect(stackChips(40)).toBe(7);
	});

	test("keeps every seat and the whole hand on the stage", () => {
		for (const stage of [
			{ height: 820, width: 1440 },
			{ height: 820, width: 806 },
			{ height: 820, width: 516 },
			{ height: 760, width: 390 },
		]) {
			const geometry = tableGeometry(stage);
			for (const seat of geometry.seats) {
				const halfPlate = geometry.compact ? 34 : 100;
				expect(seat.x - halfPlate).toBeGreaterThanOrEqual(0);
				expect(seat.x + halfPlate).toBeLessThanOrEqual(stage.width);
				expect(seat.y).toBeGreaterThan(0);
			}
			const layout = handLayout(6, geometry, stage);
			// Every card, at rest and with each card lifted (which parts its
			// neighbours), stays whole on the stage once tilt and scale apply.
			const lifts: (number | null)[] = [null];
			for (let lifted = 0; lifted < layout.dealt; lifted += 1) {
				lifts.push(lifted);
			}
			for (const lifted of lifts) {
				for (let index = 0; index < layout.dealt; index += 1) {
					const pose = handPose({
						count: layout.dealt,
						geometry,
						index,
						lifted,
						spread: layout.spread,
						stage,
					});
					const bounds = poseBounds(pose, geometry.card);
					expect(bounds.x).toBeGreaterThanOrEqual(0);
					expect(bounds.x + bounds.width).toBeLessThanOrEqual(stage.width);
					if (lifted === null) {
						expect(pose.y + geometry.card.height).toBeLessThanOrEqual(
							stage.height
						);
					}
				}
			}
		}
	});

	test("budgets the tilted corners of a narrow fan", () => {
		const stage = { height: 844, width: 390 };
		const geometry = tableGeometry(stage);
		const layout = handLayout(6, geometry, stage);
		expect(layout.dealt).toBeGreaterThan(1);
		expect(fanOverhang(layout.dealt, geometry.card)).toBeGreaterThan(10);
		const pose = (index: number) =>
			handPose({
				count: layout.dealt,
				geometry,
				index,
				lifted: null,
				spread: layout.spread,
				stage,
			});
		const left = poseBounds(pose(0), geometry.card);
		const right = poseBounds(pose(layout.dealt - 1), geometry.card);
		// At rest the fan keeps its edge margin past the tilted corners.
		expect(left.x).toBeGreaterThanOrEqual(15);
		expect(stage.width - (right.x + right.width)).toBeGreaterThanOrEqual(15);
	});

	test("every dealt card shows enough face for its title", () => {
		for (const stage of [
			{ height: 820, width: 1440 },
			{ height: 820, width: 806 },
			{ height: 744, width: 900 },
			{ height: 760, width: 390 },
		]) {
			const geometry = tableGeometry(stage);
			for (const count of [2, 6, MAX_HAND]) {
				const layout = handLayout(count, geometry, stage);
				expect(layout.dealt).toBeGreaterThan(0);
				expect(layout.dealt).toBeLessThanOrEqual(count);
				for (let index = 0; index < layout.dealt; index += 1) {
					const exposed = exposedWidth(
						index,
						layout.dealt,
						layout,
						geometry.card.width
					);
					expect(exposed).toBeGreaterThanOrEqual(geometry.card.width * 0.79);
					expect(exposed).toBeLessThanOrEqual(geometry.card.width);
				}
			}
		}
		// A wide stage keeps the label beside the fan; the drawer-open stage
		// gives that room to the cards instead.
		const wide = { height: 820, width: 1440 };
		expect(handLayout(6, tableGeometry(wide), wide).labelBeside).toBe(true);
		const narrow = { height: 820, width: 806 };
		expect(handLayout(6, tableGeometry(narrow), narrow)).toMatchObject({
			dealt: 6,
			labelBeside: false,
		});
	});

	test("chips never wear a status color", () => {
		for (const color of CHIP_COLORS) {
			expect(color).not.toMatch(/--(destructive|success|info)\b/);
		}
	});

	test("a lifted card rises and its neighbours part", () => {
		const stage = { height: 820, width: 1440 };
		const geometry = tableGeometry(stage);
		const pose = (index: number, lifted: number | null) =>
			handPose({ count: 5, geometry, index, lifted, stage });
		expect(pose(2, 2).y).toBe(pose(2, null).y - HOVER_LIFT);
		expect(pose(2, 2).z).toBeGreaterThan(pose(1, 2).z);
		expect(pose(1, 2).x).toBeLessThan(pose(1, null).x);
		expect(pose(3, 2).x).toBeGreaterThan(pose(3, null).x);
		expect(pose(0, 2).x).toBeLessThan(pose(0, null).x);
	});

	test("a lifted card keeps part of its tilt, so the hand still fans", () => {
		const stage = { height: 820, width: 1440 };
		const geometry = tableGeometry(stage);
		const pose = (index: number, lifted: number | null) =>
			handPose({ count: 6, geometry, index, lifted, stage });
		const resting = pose(0, null).rotate;
		expect(resting).toBeLessThan(0);
		expect(pose(0, 0).rotate).toBeCloseTo(resting * LIFTED_TILT);
		expect(Math.abs(pose(0, 0).rotate)).toBeGreaterThan(
			Math.abs(resting) * 0.4
		);
		// Neighbours keep their own tilt while they part.
		expect(pose(1, 0).rotate).toBe(pose(1, null).rotate);
		expect(CARD_ORIGIN_Y).toBeGreaterThan(1);
	});

	test("chips and hole cards stay clear of their own seat plate", () => {
		// Hole cards (about 43px), a gap and a 32px stack: about 42px either side.
		const groupHalf = 42;
		for (const stage of [
			{ height: 844, width: 1440 },
			{ height: 844, width: 806 },
			{ height: 844, width: 900 },
		]) {
			const geometry = tableGeometry(stage);
			expect(geometry.compact).toBe(false);
			for (const [slot, seat] of geometry.seats.entries()) {
				const chip = geometry.chips[slot];
				if (!chip) {
					throw new Error("Every seat has a chip point");
				}
				const plate = boxAround(seat, {
					// The status line hangs under the plate.
					height: PLATE_HALF.height + 12,
					width: PLATE_HALF.width,
				});
				const group = boxAround(chip, { height: 30, width: groupHalf });
				expect(rectsOverlap(plate, group)).toBe(false);
				// A full plate keeps clear of the stage (and drawer) edge.
				expect(seat.x - PLATE_HALF.width).toBeGreaterThanOrEqual(24);
				expect(seat.x + PLATE_HALF.width).toBeLessThanOrEqual(stage.width - 24);
			}
		}
	});

	test("the empty table keeps its panel, open seats and empty hand apart", () => {
		for (const stage of [
			{ height: 844, width: 1440 },
			{ height: 844, width: 900 },
			{ height: 760, width: 390 },
		]) {
			const geometry = tableGeometry(stage);
			const panel = emptyPanelRect(geometry);
			const hand = emptyHandRect(geometry, stage);
			const half = geometry.compact ? COMPACT_EMPTY_SEAT_HALF : EMPTY_SEAT_HALF;
			const seats = geometry.seats.map((seat) => boxAround(seat, half));
			expect(panel.width).toBeGreaterThanOrEqual(200);
			expect(rectsOverlap(panel, hand)).toBe(false);
			for (const [index, seat] of seats.entries()) {
				expect(rectsOverlap(seat, panel)).toBe(false);
				expect(rectsOverlap(seat, hand)).toBe(false);
				for (const other of seats.slice(index + 1)) {
					expect(rectsOverlap(seat, other)).toBe(false);
				}
			}
			expect(hand.y + hand.height).toBeLessThanOrEqual(stage.height);
			expect(hand.x).toBeGreaterThanOrEqual(0);
		}
	});

	test("the action timer picks up the live run's lap", () => {
		const now = Date.parse("2026-01-01T00:00:30.000Z");
		expect(timerLapSeconds("2026-01-01T00:00:00.000Z", now)).toBe(2);
		expect(timerLapSeconds(undefined, now)).toBe(0);
		expect(timerLapSeconds("not a date", now)).toBe(0);
		expect(timerLapSeconds("2026-01-01T00:01:00.000Z", now)).toBe(0);
	});

	test("the corner index never runs into the title or the name beside it", () => {
		for (const width of [84, 90, 99, 100, 112, 124]) {
			const metrics = cardFaceMetrics(width);
			const index = cardIndexRect(metrics);
			expect(metrics.small).toBe(width < 100);
			// The title starts under the whole index (rank and suit)...
			expect(metrics.titleTop).toBeGreaterThanOrEqual(
				index.y + index.height + 2
			);
			// ...and the name and age rows start past its right edge.
			expect(metrics.gutter).toBeGreaterThanOrEqual(index.x + index.width + 2);
		}
	});

	test("the table and hand sit centred on a tall phone, high on a desktop", () => {
		const phone = { height: 765, width: 390 };
		const phoneGeometry = tableGeometry(phone);
		const phoneHand = handLayout(6, phoneGeometry, phone);
		let handBottom = 0;
		for (let index = 0; index < phoneHand.dealt; index += 1) {
			const bounds = poseBounds(
				handPose({
					count: phoneHand.dealt,
					geometry: phoneGeometry,
					index,
					lifted: null,
					spread: phoneHand.spread,
					stage: phone,
				}),
				phoneGeometry.card
			);
			handBottom = Math.max(handBottom, bounds.y + bounds.height);
		}
		const seatTop = Math.min(
			...phoneGeometry.seats.map((seat) => seat.y - COMPACT_PLATE_HALF.height)
		);
		expect(phoneGeometry.handLift).toBeGreaterThan(0);
		expect(Math.abs(seatTop - (phone.height - handBottom))).toBeLessThan(24);

		const desktop = { height: 821, width: 1440 };
		const desktopGeometry = tableGeometry(desktop);
		expect(desktopGeometry.felt.y).toBeLessThanOrEqual(56);
		const desktopHand = handLayout(6, desktopGeometry, desktop);
		for (let index = 0; index < desktopHand.dealt; index += 1) {
			const bounds = poseBounds(
				handPose({
					count: desktopHand.dealt,
					geometry: desktopGeometry,
					index,
					lifted: null,
					spread: desktopHand.spread,
					stage: desktop,
				}),
				desktopGeometry.card
			);
			expect(desktop.height - (bounds.y + bounds.height)).toBeGreaterThan(24);
		}
	});

	test("a compact table keeps its bottom chairs clear of the hand's caption", () => {
		const stages = [
			{ height: 765, width: 390 },
			{ height: 600, width: 390 },
			{ height: 721, width: 504 },
			{ height: 700, width: 600 },
			{ height: 600, width: 740 },
		];
		for (const stage of stages) {
			const geometry = tableGeometry(stage);
			expect(geometry.compact).toBe(true);
			const layout = handLayout(6, geometry, stage);
			// The caption over the fan: 28px tall, clear of a lifted middle card.
			const captionTop =
				handTop(layout.dealt, geometry, stage, layout.spread) -
				HOVER_LIFT -
				6 -
				28;
			for (const seat of geometry.seats.slice(4)) {
				expect(seat.y + COMPACT_PLATE_HALF.height).toBeLessThanOrEqual(
					captionTop
				);
			}
		}
	});

	test("names the folded rail by what it holds", () => {
		expect(railLabel(0, 2)).toEqual({ name: "Off the table", unit: "thread" });
		expect(railLabel(3, 0)).toEqual({ name: "On the rail", unit: "agent" });
		expect(railLabel(1, 1)).toEqual({ name: "Rail", unit: "item" });
	});
});

describe("CardTableInterface", () => {
	test("seats agents, deals the hand, and fills the pot", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(table({ port }));
		expect(markup).toContain('data-testid="interface-card-table"');
		expect(markup).toContain(
			"Grace, working: 2 threads, 1 running, 1 waiting on you. Seat menu"
		);
		expect(markup).toContain("Ada: 2 threads, 1 waiting on you. Seat menu");
		expect(markup).toContain("Linus: 0 threads. Seat menu");
		// Three agents leave three open chairs.
		expect(markup.split("Open seat. Seat menu").length - 1).toBe(3);
		expect(markup).toContain('aria-label="Your hand: 2 cards"');
		expect(markup).toContain(
			"Flaky test. Needs attention, Grace, 2h. Play card"
		);
		expect(markup).toContain("Release notes. Your turn, Ada, 30m. Play card");
		expect(markup).toContain("Pot: 1 thread running. Show them");
		// Below 1200px of stage the rail folds into a pill, so it never covers a seat.
		expect(markup).toContain('data-testid="card-table-rail"');
		expect(markup).toContain('aria-label="Off the table: 1 thread. Show them"');
		expect(markup).not.toContain('data-testid="card-table-drawer"');
	});

	test("the rail panel lists agentless threads and opens them", async () => {
		const { calls, port } = recordingPort();
		const actions = {
			activeThreadId: null,
			now: NOW,
			onDeal: (agentId: string) => port.startThread({ agentId }),
			onOpen: (threadId: string) => port.openThread(threadId),
			snapshot: SNAPSHOT,
		};
		const view = await mount(
			<CardTableRail
				actions={actions}
				collapsed={false}
				maxHeight={320}
				seats={[]}
				unseated={unseatedThreads(SNAPSHOT)}
			/>
		);
		expect(view.container.textContent).toContain("Loose ends");
		await click(
			view.container.querySelector('[data-thread-id="thread-loose"]')
		);
		expect(calls).toEqual(["open:thread-loose"]);
		await view.dispose();
	});

	test("shows a skeleton while loading and an empty table with no one", () => {
		const { port } = recordingPort();
		const loading = renderToStaticMarkup(table({ loading: true, port }));
		expect(loading).toContain('aria-busy="true"');
		expect(loading).toContain("Dealing…");
		expect(loading).not.toContain("Play card");
		expect(loading).not.toContain("Seat menu");

		const empty = renderToStaticMarkup(
			table({ port, snapshot: { ...SNAPSHOT, agents: [], threads: [] } })
		);
		expect(empty).toContain("Nobody is at the table yet");
		expect(empty).toContain('data-testid="card-table-empty-hand"');
		expect(empty.split("Open seat. Seat menu").length - 1).toBe(MAX_SEATS);
		expect(empty).not.toContain('data-testid="card-table-rail"');
	});

	test("shows the host's thread view in the drawer", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			table({
				activeThreadId: "thread-notes",
				port,
				threadView: <div data-testid="host-thread">real chat</div>,
			})
		);
		expect(markup).toContain('data-testid="card-table-drawer"');
		expect(markup).toContain('aria-label="Thread: Release notes"');
		expect(markup).toContain('data-testid="host-thread"');
		expect(markup).toContain('aria-current="true"');
		expect(markup).toContain("In play");
	});

	test("a compact card starts its title under the whole corner index", async () => {
		const notes = SNAPSHOT.threads.find((item) => item.id === "thread-notes");
		if (!notes) {
			throw new Error("Expected the notes thread");
		}
		for (const width of [84, 124]) {
			const metrics = cardFaceMetrics(width);
			const view = await mount(
				<CardFace
					active={false}
					exposed={width}
					height={Math.round(width * 1.4)}
					last
					now={NOW}
					snapshot={SNAPSHOT}
					thread={notes}
					width={width}
				/>
			);
			const title =
				view.container.querySelector<HTMLElement>("[data-card-title]");
			const body = title?.parentElement;
			const column = body?.parentElement;
			// No float beside the suit: the title is a clean block of its own.
			expect(view.container.querySelector(".float-left")).toBeNull();
			const titleTop =
				Number.parseFloat(column?.style.paddingTop ?? "0") +
				metrics.glyph * 2 +
				metrics.gap +
				Number.parseFloat(body?.style.paddingTop ?? "0");
			expect(titleTop).toBe(metrics.titleTop);
			const index = cardIndexRect(metrics);
			// Every title line is at or below the first, so all clear the index.
			expect(titleTop).toBeGreaterThan(index.y + index.height);
			await view.dispose();
		}
	});

	test("a plain card lets its suit speak; only failures and the card in play say so", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ port }));
		const footers = [
			...view.container.querySelectorAll<HTMLElement>("[data-card-footer]"),
		];
		const failed = dealHand(SNAPSHOT).cards.filter(
			(item) => item.runState === "failed"
		);
		expect(footers).toHaveLength(failed.length);
		for (const footer of footers) {
			expect(footer.textContent).toContain("Failed");
		}
		expect(
			view.container.querySelector('[data-testid="card-table-legend"]')
		).not.toBeNull();
		await view.dispose();
	});

	test("with no legend in view, every face in the Cards layout says its suit in words", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ layout: "spread", port }));
		expect(
			view.container.querySelector('[data-testid="card-table-legend"]')
		).toBeNull();
		const faces = [
			...view.container.querySelectorAll<HTMLElement>(
				"[data-spread-card] [data-card-title]"
			),
		];
		const footers = [
			...view.container.querySelectorAll<HTMLElement>(
				"[data-spread-card] [data-card-footer]"
			),
		];
		expect(faces.length).toBeGreaterThan(0);
		expect(footers).toHaveLength(faces.length);
		const words = footers.map((footer) => footer.textContent ?? "");
		expect(words).toContain("♠Your turn");
		expect(words).toContain("♣Working");
		expect(words).toContain("♦Failed run");
		await view.dispose();
	});

	test("the drawer covers a narrow table at full width, even after a wide start", async () => {
		const { port } = recordingPort();
		const observers: ResizeObserverCallback[] = [];
		const OriginalObserver = globalThis.ResizeObserver;
		const originalRect = HTMLElement.prototype.getBoundingClientRect;
		let rootWidth = 1440;
		globalThis.ResizeObserver = class {
			constructor(callback: ResizeObserverCallback) {
				observers.push(callback);
			}
			disconnect() {
				// Nothing to release in the fake.
			}
			observe() {
				// Measured on demand by the test.
			}
			unobserve() {
				// Nothing to release in the fake.
			}
		} as unknown as typeof ResizeObserver;
		HTMLElement.prototype.getBoundingClientRect = function rect(
			this: HTMLElement
		) {
			const width = this.matches('[data-testid="interface-card-table"]')
				? rootWidth
				: 0;
			return DOMRect.fromRect({ height: width > 0 ? 800 : 0, width });
		};
		const settle = () =>
			act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 60));
			});
		try {
			const view = await mount(
				table({
					activeThreadId: "thread-notes",
					port,
					threadView: <div>real chat</div>,
				})
			);
			await settle();
			const drawer = () =>
				view.container.querySelector<HTMLElement>("[data-card-table-drawer]");
			expect(drawer()?.style.width).toBe(`${drawerWidth(1440)}px`);
			expect(drawer()?.className).not.toContain("w-full");

			rootWidth = DRAWER_OVERLAY_BELOW - 378;
			await act(async () => {
				for (const callback of observers) {
					callback([], {} as ResizeObserver);
				}
			});
			await settle();
			expect(drawer()?.className).toContain("w-full");
			expect(drawer()?.style.width).toBe("100%");
			await view.dispose();

			// Loaded narrow with a thread open: full width from the start.
			const narrow = await mount(
				table({
					activeThreadId: "thread-notes",
					port,
					threadView: <div>real chat</div>,
				})
			);
			await settle();
			const narrowDrawer = narrow.container.querySelector<HTMLElement>(
				"[data-card-table-drawer]"
			);
			expect(narrowDrawer?.style.width).toBe("100%");
			expect(narrowDrawer?.style.width).not.toBe(`${drawerWidth(1440)}px`);
			await narrow.dispose();
		} finally {
			globalThis.ResizeObserver = OriginalObserver;
			HTMLElement.prototype.getBoundingClientRect = originalRect;
		}
	});

	test("playing a card opens its thread through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(table({ port }));
		await click(view.container.querySelector('[data-card="thread-notes"]'));
		expect(calls).toEqual(["open:thread-notes"]);
		await view.dispose();
	});

	test("arrow keys move along the hand and Home/End jump to its ends", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ port }));
		const first = view.container.querySelector<HTMLElement>(
			'[data-card="thread-flaky"]'
		);
		expect(first?.tabIndex).toBe(0);
		await act(async () => first?.focus());
		await press(first as HTMLElement, "ArrowRight");
		expect(document.activeElement?.getAttribute("data-card")).toBe(
			"thread-notes"
		);
		await press(document.activeElement as HTMLElement, "Home");
		expect(document.activeElement?.getAttribute("data-card")).toBe(
			"thread-flaky"
		);
		await press(document.activeElement as HTMLElement, "End");
		expect(document.activeElement?.getAttribute("data-card")).toBe(
			"thread-notes"
		);
		// Only the card under the cursor is a tab stop.
		expect(
			view.container.querySelector<HTMLElement>('[data-card="thread-flaky"]')
				?.tabIndex
		).toBe(-1);
		await view.dispose();
	});

	test("arrows with nothing focused pick up the hand", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ port }));
		await act(async () => (document.activeElement as HTMLElement)?.blur());
		await press(document.body, "ArrowRight");
		expect(document.activeElement?.getAttribute("data-card")).toBe(
			"thread-flaky"
		);
		await view.dispose();
	});

	test("open seats offer a deal, and the header deals, with no agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(table({ port }));
		const seat = byLabel(view.container, "Open seat. Seat menu");
		// An open seat is a menu, like an agent's seat: it offers the deal.
		expect(seat?.getAttribute("aria-haspopup")).toBe("dialog");
		await click(seat);
		await click(buttonByText(view.container, "Deal a thread"));
		expect(calls.filter((call) => call === "start:{}").length).toBe(1);
		await view.dispose();

		let closed = 0;
		const menu = await mount(
			<EmptySeatMenuBody
				onDeal={() => port.startThread({})}
				onDone={() => {
					closed += 1;
				}}
			/>
		);
		await click(buttonByText(menu.container, "Deal a thread"));
		expect(calls.filter((call) => call === "start:{}").length).toBe(2);
		expect(closed).toBe(1);
		await menu.dispose();
	});

	test("every chair is a menu trigger with a full accessible name", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ port }));
		const seats = [
			...view.container.querySelectorAll<HTMLElement>("[data-seat]"),
		];
		expect(seats.map((seat) => seat.dataset.seat)).toEqual([
			"agent-grace",
			"agent-ada",
			"agent-linus",
		]);
		for (const seat of seats) {
			expect(seat.getAttribute("aria-haspopup")).toBe("dialog");
			expect(seat.getAttribute("aria-label")).toEndWith(". Seat menu");
		}
		await view.dispose();
	});

	test("a seat's menu lists its threads and deals one with that agent", async () => {
		const { calls, port } = recordingPort();
		const seat = seatAgents(SNAPSHOT).seated.find(
			(item) => item.agent.id === "agent-ada"
		);
		if (!seat) {
			throw new Error("Ada should be seated");
		}
		let closed = 0;
		const view = await mount(
			<SeatMenuBody
				actions={{
					activeThreadId: null,
					now: NOW,
					onDeal: (agentId) => port.startThread({ agentId }),
					onOpen: port.openThread,
					snapshot: SNAPSHOT,
				}}
				onDone={() => {
					closed += 1;
				}}
				seat={seat}
			/>
		);
		const menu = view.container.querySelector('[aria-label="Ada\'s threads"]');
		expect(menu?.textContent).toContain("Release notes");
		expect(menu?.textContent).toContain("Intro edits");
		await click(
			view.container.querySelector('[data-thread-id="thread-notes"]')
		);
		await click(buttonByText(view.container, "Deal a thread"));
		expect(calls).toEqual([
			"open:thread-notes",
			'start:{"agentId":"agent-ada"}',
		]);
		expect(closed).toBe(2);
		await view.dispose();
	});

	test("the drawer closes from its button and from Escape", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			table({
				activeThreadId: "thread-notes",
				port,
				threadView: <div>real chat</div>,
			})
		);
		await click(byLabel(view.container, "Close thread"));
		const root = view.container.querySelector(
			'[data-testid="interface-card-table"]'
		);
		await press(root as HTMLElement, "Escape");
		expect(calls).toEqual(["close", "close"]);
		await view.dispose();
	});

	test("a working seat's timer arc shows, and holds still under reduced motion", async () => {
		const { port } = recordingPort();
		const arcOf = (root: ParentNode) =>
			root.querySelector<SVGCircleElement>(
				'[data-seat="agent-grace"] [data-timer-arc]'
			);
		const offsets = (arc: SVGCircleElement | null) => ({
			circumference: Number(arc?.getAttribute("stroke-dasharray")),
			offset: Number(arc?.getAttribute("stroke-dashoffset")),
		});

		const moving = await mount(table({ port }));
		const live = offsets(arcOf(moving.container));
		expect(live.circumference).toBeGreaterThan(0);
		// Crash triage moved 5 minutes ago: 300s into 14s laps is 6s in.
		expect(live.offset).toBeLessThan(live.circumference);
		await moving.dispose();

		// Motion reads the media query once (in a browser, at import); set the
		// state it keeps directly, then put it back.
		const saved = {
			listener: hasReducedMotionListener.current,
			prefers: prefersReducedMotion.current,
		};
		hasReducedMotionListener.current = true;
		prefersReducedMotion.current = true;
		try {
			const still = await mount(table({ port }));
			const held = offsets(arcOf(still.container));
			expect(held.offset).toBeGreaterThan(0);
			expect(held.offset).toBeLessThan(held.circumference);
			expect(held.offset).toBeCloseTo(held.circumference * 0.25);
			await still.dispose();
		} finally {
			hasReducedMotionListener.current = saved.listener;
			prefersReducedMotion.current = saved.prefers;
		}
	});

	test("the open thread marks its seat and the pot as in play", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			table({
				activeThreadId: "thread-triage",
				port,
				threadView: <div>real chat</div>,
			})
		);
		expect(markup).toContain(
			"Grace, working: 2 threads, 1 running, 1 waiting on you, thread open. Seat menu"
		);
		expect(markup.match(/data-in-play=""/g)).toHaveLength(1);
		expect(markup).toContain("Pot: 1 thread running, one open. Show them");
		const idle = renderToStaticMarkup(table({ port }));
		expect(idle).not.toContain("data-in-play");
		expect(idle).not.toContain("one open");
	});

	test("cards held back off the fan open from the hand's label", async () => {
		const { calls, port } = recordingPort();
		const threads = Array.from({ length: MAX_HAND + 2 }, (_, index) =>
			thread({
				agentIds: ["agent-ada"],
				id: `reply-${index}`,
				title: `Reply ${index}`,
				updatedAt: ago(index + 1),
			})
		);
		const view = await mount(
			table({ port, snapshot: { ...SNAPSHOT, threads } })
		);
		const held = view.container.querySelector<HTMLElement>(
			'[data-testid="card-table-held"]'
		);
		const dealt = view.container.querySelectorAll("[data-card]").length;
		const heldCount = MAX_HAND + 2 - dealt;
		expect(heldCount).toBeGreaterThanOrEqual(2);
		expect(held?.getAttribute("aria-label")).toBe(
			`${heldCount} cards held back. Show them`
		);
		expect(held?.getAttribute("aria-haspopup")).toBe("dialog");
		await view.dispose();

		// The menu's list: every held thread, each one a click from opening.
		const { cards } = dealHand({ ...SNAPSHOT, threads });
		const heldThreads = [
			...cards.slice(dealt),
			...dealHand({ ...SNAPSHOT, threads }).heldThreads,
		];
		expect(heldThreads).toHaveLength(heldCount);
		let closed = 0;
		const menu = await mount(
			<HeldCardsList
				actions={{
					activeThreadId: null,
					now: NOW,
					onDeal: (agentId) => port.startThread({ agentId }),
					onOpen: port.openThread,
					snapshot: { ...SNAPSHOT, threads },
				}}
				onDone={() => {
					closed += 1;
				}}
				threads={heldThreads}
			/>
		);
		const list = menu.container.querySelector('[aria-label="Held cards"]');
		expect(list?.querySelectorAll("[data-thread-id]")).toHaveLength(heldCount);
		await click(menu.container.querySelector('[data-thread-id="reply-9"]'));
		expect(calls).toEqual(["open:reply-9"]);
		expect(closed).toBe(1);
		await menu.dispose();
	});

	test("the empty table shows its welcome, six open seats and an empty hand", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			table({ port, snapshot: { ...SNAPSHOT, agents: [], threads: [] } })
		);
		const panel = view.container.querySelector<HTMLElement>(
			'[data-testid="card-table-empty-panel"]'
		);
		expect(panel?.textContent).toContain("Nobody is at the table yet");
		const openSeats = [
			...view.container.querySelectorAll<HTMLElement>(
				'[aria-label="Open seat. Seat menu"]'
			),
		];
		expect(openSeats).toHaveLength(MAX_SEATS);
		const hand = view.container.querySelector<HTMLElement>(
			'[data-testid="card-table-empty-hand"]'
		);
		expect(hand?.textContent).toContain("Nothing to play");
		expect(view.container.querySelector("[data-card]")).toBeNull();
		expect(
			view.container.querySelector('[data-testid="card-table-rail"]')
		).toBeNull();
		// Laid out at the default stage: the panel, the chairs and the empty
		// hand never cover each other.
		const stage = { height: 760, width: 1180 };
		const geometry = tableGeometry(stage);
		const handRect = emptyHandRect(geometry, stage);
		expect(hand?.style.top).toBe(`${handRect.y}px`);
		expect(panel?.style.width).toBe(`${emptyPanelRect(geometry).width}px`);
		const panelRect = emptyPanelRect(geometry);
		expect(rectsOverlap(panelRect, handRect)).toBe(false);
		for (const seat of geometry.seats) {
			const seatRect = boxAround(seat, EMPTY_SEAT_HALF);
			expect(rectsOverlap(seatRect, panelRect)).toBe(false);
			expect(rectsOverlap(seatRect, handRect)).toBe(false);
		}
		await click(buttonByText(panel as HTMLElement, "Deal a thread"));
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});

	test("the document key listener is added once, not on every render", async () => {
		const { port } = recordingPort();
		let added = 0;
		const original = document.addEventListener.bind(document);
		document.addEventListener = ((
			type: string,
			listener: EventListenerOrEventListenerObject,
			options?: AddEventListenerOptions | boolean
		) => {
			if (type === "keydown") {
				added += 1;
			}
			original(type, listener, options);
		}) as typeof document.addEventListener;
		try {
			const view = await mount(table({ port }));
			const before = added;
			await view.rerender(table({ activeThreadId: "thread-notes", port }));
			await view.rerender(table({ port }));
			expect(added).toBe(before);
			// It still reads the latest hand.
			await act(async () => (document.activeElement as HTMLElement)?.blur());
			await press(document.body, "ArrowLeft");
			expect(document.activeElement?.getAttribute("data-card")).toBe(
				"thread-notes"
			);
			await view.dispose();
		} finally {
			document.addEventListener = original;
		}
	});
});

/** A deck of `count` threads for one agent, for fan and pile geometry. */
function bigSnapshot(count: number): InterfaceSnapshot {
	return {
		...SNAPSHOT,
		agents: [agent("agent-ada", "Ada")],
		threads: Array.from({ length: count }, (_, index) =>
			thread({
				agentIds: ["agent-ada"],
				id: `thread-${index}`,
				title: `Thread ${index}`,
				updatedAt: ago(index + 1),
			})
		),
	};
}

describe("card table decks", () => {
	test("deals one deck per agent in seat order, then the Unassigned deck", () => {
		const decks = buildDecks(SNAPSHOT);
		expect(decks.map((deck) => deck.id)).toEqual([
			"agent-grace",
			"agent-ada",
			"agent-linus",
			UNASSIGNED_DECK,
		]);
		const [grace, ada, linus, unassigned] = decks;
		// The failure sits on top of the live run.
		expect(grace?.threads.map((item) => item.id)).toEqual([
			"thread-flaky",
			"thread-triage",
		]);
		expect(grace?.working).toBe(true);
		expect(grace && deckSummary(grace)).toBe("2 cards, 1 running, 1 failed");
		expect(ada && deckSummary(ada)).toBe("2 cards, 1 for you");
		expect(linus?.threads).toEqual([]);
		expect(unassigned?.name).toBe("Unassigned");
		expect(unassigned?.agent).toBeUndefined();
		expect(unassigned?.threads.map((item) => item.id)).toEqual([
			"thread-loose",
		]);
	});

	test("a thread with several agents is one card, in its lead agent's deck", () => {
		const decks = buildDecks({
			...SNAPSHOT,
			threads: [
				thread({ agentIds: ["agent-ada", "agent-linus"], id: "thread-pair" }),
				thread({ agentIds: ["agent-gone"], id: "thread-orphan" }),
			],
		});
		const holders = decks.filter((deck) =>
			deck.threads.some((item) => item.id === "thread-pair")
		);
		expect(holders.map((deck) => deck.id)).toEqual(["agent-ada"]);
		// An agent the snapshot no longer has leaves its thread unassigned.
		expect(
			decks
				.find((deck) => deck.id === UNASSIGNED_DECK)
				?.threads.map((item) => item.id)
		).toEqual(["thread-orphan"]);
		// No conversations without an agent: no Unassigned deck.
		expect(
			buildDecks({ ...SNAPSHOT, threads: [] }).some(
				(deck) => deck.id === UNASSIGNED_DECK
			)
		).toBe(false);
	});

	test("a pile shows one edge per card under the top one, up to a limit", () => {
		const pile = { height: 196, width: 140, x: 100, y: 50 };
		const top = pilePose({ count: 9, id: "a", index: 0, pile });
		expect(top).toMatchObject({ rotate: 0, visible: true, x: 100, y: 50 });
		const lifted = pilePose({
			count: 9,
			id: "a",
			index: 0,
			lifted: true,
			pile,
		});
		expect(lifted.y).toBeLessThan(top.y);
		for (let index = 1; index <= MAX_STACK_EDGES; index += 1) {
			const pose = pilePose({ count: 9, id: `c${index}`, index, pile });
			expect(pose.y).toBe(50 + index * STACK_EDGE);
			expect(pose.visible).toBe(true);
			expect(pose.z).toBeLessThan(top.z);
			expect(Math.abs(pose.rotate)).toBeLessThanOrEqual(1.6);
		}
		const hidden = pilePose({
			count: 9,
			id: "deep",
			index: MAX_STACK_EDGES + 1,
			pile,
		});
		expect(hidden.visible).toBe(false);
	});

	test("the resting grid fits every deck in balanced rows on the stage", () => {
		const stage = { height: 820, width: 1440 };
		const grid = deckGrid(7, stage);
		const rows = new Map<number, number>();
		for (const pile of grid.piles) {
			expect(pile.x).toBeGreaterThanOrEqual(0);
			expect(pile.x + pile.width).toBeLessThanOrEqual(stage.width);
			rows.set(pile.y, (rows.get(pile.y) ?? 0) + 1);
		}
		expect([...rows.values()]).toEqual([4, 3]);
		expect(grid.contentHeight).toBe(stage.height);
		// A phone scrolls instead of shrinking the cards past reading.
		const phone = deckGrid(7, { height: 700, width: 390 });
		expect(phone.card.width).toBeGreaterThanOrEqual(112);
		expect(phone.contentHeight).toBeGreaterThan(700);
	});

	test("a few cards fan out square, side by side, larger than at rest", () => {
		const stage = { height: 820, width: 1440 };
		const { card } = deckGrid(7, stage);
		const dock = dockLayout(7, stage);
		const fan = fanLayout({ card, count: 3, dockTop: dock.top, stage });
		expect(fan.overlapped).toBe(false);
		expect(fan.shown).toBe(3);
		expect(fan.more).toBe(0);
		expect(fan.card.width).toBeGreaterThan(card.width);
		expect(fan.rotations).toEqual([0, 0, 0]);
		const poses = [0, 1, 2].map((index) =>
			fanPose({ fan, index, lifted: null })
		);
		expect(new Set(poses.map((pose) => pose.y)).size).toBe(1);
		for (const [index, pose] of poses.entries()) {
			const next = poses[index + 1];
			if (next) {
				expect(next.x - pose.x).toBeGreaterThan(fan.card.width);
			}
			// Clear of the dock below.
			expect(pose.y + fan.card.height).toBeLessThan(dock.top);
		}
		// Centred on the stage.
		const first = poses[0];
		const last = poses[2];
		if (!(first && last)) {
			throw new Error("Expected three poses");
		}
		expect(
			Math.abs(first.x + last.x + fan.card.width - stage.width)
		).toBeLessThan(1);
	});

	test("many cards overlap like a hand, each still showing its face", () => {
		const stage = { height: 820, width: 900 };
		const { card } = deckGrid(3, stage);
		const dock = dockLayout(3, stage);
		const fan = fanLayout({ card, count: 30, dockTop: dock.top, stage });
		expect(fan.overlapped).toBe(true);
		expect(fan.shown + 1).toBeLessThanOrEqual(MAX_FAN_CARDS);
		expect(fan.shown + fan.more).toBe(30);
		// Enough face shows past each card for a title to wrap between words.
		expect(fan.exposed).toBeGreaterThanOrEqual(FAN_MIN_EXPOSED_PX);
		expect(fan.exposed).toBeGreaterThanOrEqual(fan.card.width * 0.5 - 1);
		const poses = fan.centers.map((_, index) =>
			fanPose({ fan, index, lifted: null })
		);
		// Even the tilted end cards' corners stay inside the page's gutter.
		for (const pose of poses) {
			const reach = tiltOverhang(fan.card.width, pose.rotate);
			expect(pose.x - reach).toBeGreaterThanOrEqual(32 - 0.5);
			expect(pose.x + fan.card.width + reach).toBeLessThanOrEqual(
				stage.width - 32 + 0.5
			);
			expect(Math.abs(pose.rotate)).toBeLessThanOrEqual(
				FAN_TOTAL_DEGREES / 2 + 0.01
			);
		}
		// The ends tilt away from each other, and droop a little.
		expect(poses[0]?.rotate).toBeLessThan(0);
		expect(poses.at(-1)?.rotate).toBeGreaterThan(0);
		expect(poses[0]?.y).toBeGreaterThan(
			poses[Math.floor(poses.length / 2)]?.y ?? 0
		);
	});

	test("a lifted fan card rises to the front and its neighbours part", () => {
		const stage = { height: 820, width: 900 };
		const { card } = deckGrid(3, stage);
		const fan = fanLayout({
			card,
			count: 9,
			dockTop: dockLayout(3, stage).top,
			stage,
		});
		const rest = fan.centers.map((_, index) =>
			fanPose({ fan, index, lifted: null })
		);
		const lifted = fan.centers.map((_, index) =>
			fanPose({ fan, index, lifted: 4 })
		);
		expect(lifted[4]?.y).toBe((rest[4]?.y ?? 0) - FAN_LIFT);
		expect(Math.abs(lifted[4]?.rotate ?? 0)).toBeLessThan(
			Math.abs(rest[4]?.rotate ?? 1) || 1
		);
		expect(lifted[4]?.z).toBeGreaterThan(
			Math.max(...lifted.filter((_, i) => i !== 4).map((pose) => pose.z))
		);
		expect(lifted[3]?.x).toBeLessThan(rest[3]?.x ?? 0);
		expect(lifted[5]?.x).toBeGreaterThan(rest[5]?.x ?? 0);
		expect(lifted[0]?.x).toBe(rest[0]?.x);
		// Nothing scales: a scaled card's text blurs.
		expect(lifted.every((pose) => pose.scale === 1)).toBe(true);
	});

	test("the dock keeps every deck on the stage and drops names when tight", () => {
		const wide = dockLayout(7, { height: 820, width: 1440 });
		expect(wide.named).toBe(true);
		const narrow = dockLayout(7, { height: 844, width: 390 });
		expect(narrow.slotWidth).toBeLessThan(DOCK_NAMED_MIN);
		expect(narrow.named).toBe(false);
		for (const center of narrow.centers) {
			expect(center.x - narrow.slotWidth / 2).toBeGreaterThanOrEqual(0);
			expect(center.x + narrow.slotWidth / 2).toBeLessThanOrEqual(390);
		}
	});

	test("arrow keys step along a row and keep the column between rows", () => {
		expect(gridMove("ArrowRight", 0, 7, 4)).toBe(1);
		expect(gridMove("ArrowLeft", 0, 7, 4)).toBe(0);
		expect(gridMove("ArrowDown", 1, 7, 4)).toBe(5);
		expect(gridMove("ArrowDown", 3, 7, 4)).toBe(3);
		expect(gridMove("ArrowUp", 5, 7, 4)).toBe(1);
		expect(gridMove("End", 2, 7, 4)).toBe(6);
		expect(gridMove("Home", 6, 7, 4)).toBe(0);
		expect(gridMove("Enter", 2, 7, 4)).toBeUndefined();
		expect(gridMove("ArrowRight", 0, 0, 4)).toBeUndefined();
	});

	test("a picked-up card reads larger and shows more of the message", () => {
		const regular = cardFaceMetrics(168);
		const large = cardFaceMetrics(218);
		expect(regular.large).toBe(false);
		expect(large.large).toBe(true);
		expect(large.glyph).toBeGreaterThan(regular.glyph);
		expect(
			messageLines({
				farIndex: true,
				footed: false,
				height: 305,
				large: true,
				titleTop: large.titleTop,
			})
		).toBeGreaterThan(
			messageLines({
				farIndex: true,
				footed: false,
				height: 235,
				titleTop: regular.titleTop,
			})
		);
		// The poker hand's cards never reach the large face.
		expect(cardFaceMetrics(124).large).toBe(false);
	});

	test("a card too short for a whole message line under its far index shows none", () => {
		const regular = cardFaceMetrics(110);
		expect(
			messageLines({
				farIndex: true,
				footed: false,
				height: 154,
				titleTop: regular.titleTop,
			})
		).toBe(0);
		// Without the far index in the way, the same card has room for a line.
		expect(
			messageLines({
				farIndex: false,
				footed: false,
				height: 154,
				titleTop: regular.titleTop,
			})
		).toBeGreaterThan(0);
	});
});

describe("CardTableInterface cards layout", () => {
	test("lays every agent out as a deck, urgent card face up", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(table({ layout: "spread", port }));
		expect(markup).toContain('data-testid="interface-card-table"');
		expect(markup).toContain('data-testid="card-table-spread"');
		expect(markup).not.toContain("Seat menu");
		expect(markup).toContain(
			'aria-label="Grace: 2 cards, 1 running, 1 failed. Fan out the deck"'
		);
		expect(markup).toContain(
			'aria-label="Ada: 2 cards, 1 for you. Fan out the deck"'
		);
		expect(markup).toContain(
			'aria-label="Unassigned: 1 card. Fan out the deck"'
		);
		// A deck with no cards deals instead.
		expect(markup).toContain('aria-label="Deal a thread with Linus"');
		// At rest the cards are scenery; only decks are buttons.
		expect(markup).toContain('data-card-place="deck"');
		expect(markup).not.toContain('data-card-place="fan"');
		expect(markup).toContain('aria-expanded="false"');
	});

	test("the header toggle switches between the table and the cards", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ port }));
		expect(
			view.container.querySelector('[data-testid="card-table-spread"]')
		).toBeNull();
		await click(buttonByText(view.container, "Cards"));
		expect(
			view.container.querySelector('[data-testid="card-table-spread"]')
		).not.toBeNull();
		await click(buttonByText(view.container, "Table"));
		expect(
			view.container.querySelector('[data-testid="card-table-spread"]')
		).toBeNull();
		expect(view.container.querySelector("[data-seat]")).not.toBeNull();
		await view.dispose();
	});

	test("a deck fans out, plays a card, and gathers on Escape", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(table({ layout: "spread", port }));
		const stage = () =>
			view.container.querySelector<HTMLElement>(
				'[data-testid="card-table-spread"]'
			);
		await click(view.container.querySelector('[data-deck="agent-grace"]'));
		expect(stage()?.dataset.fanned).toBe("agent-grace");
		const fanned = [
			...view.container.querySelectorAll<HTMLElement>(
				'[data-card-place="fan"]'
			),
		].map((item) => item.dataset.spreadCard);
		expect(fanned).toEqual(["thread-flaky", "thread-triage"]);
		expect(
			view.container.querySelector('[aria-label="Grace\'s cards"]')
		).not.toBeNull();
		// The other decks moved aside into the dock.
		expect(
			view.container.querySelectorAll('[data-deck-place="dock"]')
		).toHaveLength(4);
		await click(view.container.querySelector('[data-card="thread-triage"]'));
		expect(calls).toEqual(["open:thread-triage"]);
		await press(stage() as HTMLElement, "Escape");
		expect(stage()?.dataset.fanned).toBeUndefined();
		expect(
			view.container.querySelectorAll('[data-deck-place="rest"]')
		).toHaveLength(4);
		await view.dispose();
	});

	test("leaves body keys to the host's cover", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ layout: "spread", port }));
		const stage = () =>
			view.container.querySelector<HTMLElement>(
				'[data-testid="card-table-spread"]'
			);
		await click(view.container.querySelector('[data-deck="agent-grace"]'));
		expect(stage()?.dataset.fanned).toBe("agent-grace");
		await act(async () => (document.activeElement as HTMLElement)?.blur());
		// While the host covers the table it is inert: <body> keys pass it by.
		view.container.setAttribute("inert", "");
		await press(document.body, "ArrowRight");
		expect(document.activeElement).toBe(document.body);
		await press(document.body, "Escape");
		expect(stage()?.dataset.fanned).toBe("agent-grace");
		view.container.removeAttribute("inert");
		await press(document.body, "Escape");
		expect(stage()?.dataset.fanned).toBeUndefined();
		await view.dispose();
	});

	test("a click on the bare page gathers the open deck", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ layout: "spread", port }));
		await click(view.container.querySelector('[data-deck="agent-ada"]'));
		const surface = view.container.querySelector<HTMLElement>("[data-surface]");
		await click(surface);
		expect(
			view.container.querySelector<HTMLElement>(
				'[data-testid="card-table-spread"]'
			)?.dataset.fanned
		).toBeUndefined();
		await view.dispose();
	});

	test("a deck deals a thread with its agent; Unassigned deals with nobody", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(table({ layout: "spread", port }));
		await click(byLabel(view.container, "Deal a thread with Ada"));
		await click(byLabel(view.container, "Deal a thread with Linus"));
		await click(view.container.querySelector('[data-deck="unassigned"]'));
		const bar = view.container.querySelector<HTMLElement>(
			'[data-testid="card-table-fan-bar"]'
		);
		expect(bar?.textContent).toContain("Unassigned");
		await click(buttonByText(bar as HTMLElement, "Deal"));
		expect(calls).toEqual([
			'start:{"agentId":"agent-ada"}',
			'start:{"agentId":"agent-linus"}',
			"start:{}",
		]);
		await view.dispose();
	});

	test("arrows move between decks, Enter fans one, arrows move between its cards", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ layout: "spread", port }));
		const grace = view.container.querySelector<HTMLElement>(
			'[data-deck="agent-grace"]'
		);
		expect(grace?.tabIndex).toBe(0);
		await act(async () => grace?.focus());
		await press(grace as HTMLElement, "ArrowRight");
		expect(document.activeElement?.getAttribute("data-deck")).toBe("agent-ada");
		expect(grace?.tabIndex).toBe(-1);
		// A keyboard press of the deck (a click with no pointer) fans it and
		// takes focus to its top card.
		await click(document.activeElement);
		expect(document.activeElement?.getAttribute("data-card")).toBe(
			"thread-notes"
		);
		await press(document.activeElement as HTMLElement, "ArrowRight");
		expect(document.activeElement?.getAttribute("data-card")).toBe(
			"thread-question"
		);
		await press(document.activeElement as HTMLElement, "Home");
		expect(document.activeElement?.getAttribute("data-card")).toBe(
			"thread-notes"
		);
		// Escape gathers and focus goes back to the deck.
		await press(document.activeElement as HTMLElement, "Escape");
		expect(document.activeElement?.getAttribute("data-deck")).toBe("agent-ada");
		await view.dispose();
	});

	test("the open thread's deck starts fanned, with the host's view in the drawer", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			table({
				activeThreadId: "thread-question",
				layout: "spread",
				port,
				threadView: <div data-testid="host-thread">real chat</div>,
			})
		);
		expect(markup).toContain('data-fanned="agent-ada"');
		expect(markup).toContain('data-testid="host-thread"');
		expect(markup).toContain('aria-current="true"');
		expect(markup).toContain("In play");
	});

	test("working decks carry a live marker in the dock; failures stay marked", async () => {
		const { port } = recordingPort();
		const view = await mount(table({ layout: "spread", port }));
		await click(view.container.querySelector('[data-deck="agent-ada"]'));
		expect(
			view.container.querySelector(
				'[data-deck="agent-grace"] [data-live-marker]'
			)
		).not.toBeNull();
		expect(
			view.container.querySelector('[data-deck="agent-ada"] [data-live-marker]')
		).toBeNull();
		await view.dispose();
		const markup = renderToStaticMarkup(table({ layout: "spread", port }));
		// The failed run's card says so on its face.
		expect(markup).toContain("Failed run");
		expect(markup).toContain("1 failed");
	});

	test("a big deck counts the cards past the fan on a last face-down card", async () => {
		const { port } = recordingPort();
		const view = await mount(
			table({ layout: "spread", port, snapshot: bigSnapshot(20) })
		);
		await click(view.container.querySelector('[data-deck="agent-ada"]'));
		const more = view.container.querySelector<HTMLElement>(
			'[data-testid="card-table-fan-more"]'
		);
		const shown = view.container.querySelectorAll('[data-card-place="fan"]');
		expect(shown.length).toBeLessThan(20);
		expect(more?.getAttribute("aria-label")).toBe(
			`${20 - shown.length} more cards in Ada's deck. Show them`
		);
		await view.dispose();
	});

	test("shows a skeleton while loading and an empty state with no one", () => {
		const { port } = recordingPort();
		const loading = renderToStaticMarkup(
			table({ layout: "spread", loading: true, port })
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("data-deck=");
		const empty = renderToStaticMarkup(
			table({
				layout: "spread",
				port,
				snapshot: { ...SNAPSHOT, agents: [], threads: [] },
			})
		);
		expect(empty).toContain('data-testid="card-table-spread-empty"');
		expect(empty).toContain("No decks yet");
		expect(empty).not.toContain("data-deck=");
	});
});

describe("card room", () => {
	test("six chairs round the far side of the table, apart and off the felt", () => {
		const seats = roomSeats();
		expect(seats).toHaveLength(MAX_SEATS);
		for (const [index, seat] of seats.entries()) {
			const [x, z] = seat.at;
			// Outside the felt's oval, inside the room.
			const across = (x - z) * Math.SQRT1_2;
			const away = -(x + z) * Math.SQRT1_2;
			expect(
				(across / TABLE.across) ** 2 + (away / TABLE.deep) ** 2
			).toBeGreaterThan(1);
			expect(Math.abs(x)).toBeLessThan(ROOM.half);
			expect(Math.abs(z)).toBeLessThan(ROOM.half);
			// Every chair faces the middle of the table.
			const toward = Math.atan2(-x, -z);
			expect(Math.abs(Math.sin(seat.facing - toward))).toBeLessThan(1e-9);
			for (const other of seats.slice(index + 1)) {
				expect(Math.hypot(other.at[0] - x, other.at[1] - z)).toBeGreaterThan(1);
			}
		}
	});
});

describe("card table phone hand and 3D marks", () => {
	const phone = { height: 800, width: 390 };
	const geometry = tableGeometry(phone);
	const cards = dealHand(SNAPSHOT).cards.slice(0, 4);
	const fan = handLayout(cards.length, geometry, phone);

	function hand(tucked: number, onTuck: (open: boolean) => void) {
		const played: string[] = [];
		const element = (
			<CardTableHand
				activeThreadId={null}
				cardRefs={{ current: new Map() }}
				cards={cards}
				cursorId={null}
				geometry={geometry}
				held={0}
				layout={fan}
				now={NOW}
				onCursor={() => undefined}
				onPlay={(id) => played.push(id)}
				onTuck={onTuck}
				snapshot={SNAPSHOT}
				stage={phone}
				tucked={tucked}
			/>
		);
		return { element, played };
	}

	test("a tap on the tucked fan opens it instead of playing a card", async () => {
		const tucks: boolean[] = [];
		const tucked = hand(240, (open) => tucks.push(open));
		const view = await mount(tucked.element);
		const list = view.container.querySelector(
			"[data-testid='card-table-hand']"
		);
		expect(list?.hasAttribute("data-hand-tucked")).toBe(true);
		await click(view.container.querySelector(`[data-card="${cards[1]?.id}"]`));
		expect(tucks).toEqual([true]);
		expect(tucked.played).toEqual([]);
		await view.dispose();

		const open = hand(0, (value) => tucks.push(value));
		const openView = await mount(open.element);
		await click(
			openView.container.querySelector(`[data-card="${cards[1]?.id}"]`)
		);
		expect(open.played).toEqual([cards[1]?.id ?? ""]);
		// Escape tucks an open fan again.
		const list2 = openView.container.querySelector(
			"[data-testid='card-table-hand']"
		);
		if (list2) {
			await press(list2, "Escape");
		}
		expect(tucks.at(-1)).toBe(false);
		await openView.dispose();
	});

	test("every card face wears its status band and corner mark", () => {
		const failed = cards.find((item) => item.runState === "failed");
		expect(failed).toBeDefined();
		if (!failed) {
			return;
		}
		const markup = renderToStaticMarkup(
			<CardFace
				active={false}
				exposed={120}
				height={168}
				last
				now={NOW}
				snapshot={SNAPSHOT}
				thread={failed}
				width={120}
			/>
		);
		expect(markup).toContain("data-card-band");
		expect(markup).toContain('data-card-mark="attention"');
	});

	test("a working seat's 3D name plate carries the action timer chip", () => {
		const { seated } = seatAgents(SNAPSHOT);
		const working = seated.find(
			(seat) => seat !== null && seatTone(seat) === "working"
		);
		const idle = seated.find(
			(seat) => seat !== null && seatTone(seat) !== "working"
		);
		expect(working).toBeDefined();
		expect(idle).toBeDefined();
		if (!(working && idle)) {
			return;
		}
		const actions = {
			activeThreadId: null,
			now: NOW,
			onDeal: () => undefined,
			onOpen: () => undefined,
			snapshot: SNAPSHOT,
		};
		const plate = (seat: typeof working) =>
			renderToStaticMarkup(
				<TableSeat
					actions={actions}
					compact
					nameplate
					seat={seat}
					side="bottom"
				/>
			);
		expect(plate(working)).toContain("data-timer-chip");
		expect(plate(idle)).not.toContain("data-timer-chip");
	});
});

describe("Card Table useful state", () => {
	const fixturePort = () => {
		const calls: string[] = [];
		const port: InterfacePort = {
			answerAsk: async (askId, choiceId) => {
				calls.push(`answer:${askId}:${choiceId}`);
			},
			closeThread: () => calls.push("close"),
			openInbox: () => calls.push("inbox"),
			openThread: (id) => calls.push(`open:${id}`),
			startThread: () => calls.push("start"),
		};
		return { calls, port };
	};
	const onFixture = (
		snapshot: InterfaceSnapshot = usefulStateFixture(),
		port: InterfacePort = fixturePort().port
	) => (
		<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
			{table({ port, snapshot })}
		</ActClockProvider>
	);
	/** An agent's row in the text equivalent: its control's list item. */
	const agentRow = (container: HTMLElement, name: string) => {
		const id = Object.entries(FIXTURE_AGENT_IDS).find(
			([key]) => key === name.toLowerCase()
		)?.[1];
		return container
			.querySelector(
				`[data-testid="interface-card-table"] [data-act-agent="${id}"]`
			)
			?.closest("li");
	};
	const actButtons = (scope: Element | null | undefined, text: string) =>
		[...(scope?.querySelectorAll("button") ?? [])].filter(
			(candidate) => candidate.textContent === text
		);
	/** Clicks like a user: the card opens after the click has finished. */
	const pressAct = async (element: Element | null | undefined) => {
		if (!(element instanceof HTMLElement)) {
			throw new Error("Expected a clickable element");
		}
		act(() => element.click());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
		});
	};

	/**
	 * The rail's agent rows. The folded rail's list is a popover portalled
	 * to the document's body, outside the table's container.
	 */
	const railRows = () => [
		...document.body.querySelectorAll<HTMLElement>(
			'section[aria-label="On the rail"] [data-act-agent]'
		),
	];
	/** Opens the folded rail, so the off-table agents' rows are in the DOM. */
	const openRail = async (container: HTMLElement) => {
		const pill = container.querySelector<HTMLElement>(
			'[data-testid="card-table-rail"] button[aria-label^="On the rail"]'
		);
		if (pill) {
			await pressAct(pill);
		}
	};

	test("renders the fixture with no console errors", async () => {
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			const view = await mount(onFixture());
			await view.dispose();
		} finally {
			console.error = original;
		}
		expect(errors).toEqual([]);
	});

	test("agent rows (seats and the rail) are named by act.ariaLabel", async () => {
		const view = await mount(onFixture());
		await openRail(view.container);
		const ada = view.container.querySelector(
			`[data-testid="interface-card-table"] [data-act-agent="${FIXTURE_AGENT_IDS.ada}"]`
		);
		// Seats and rail rows are named by the act sentence plus their action.
		expect(ada?.getAttribute("aria-label")).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run. Answer their ask."
		);
		// Six seats in the table, four rail rows in the portalled popover.
		const seats = view.container.querySelectorAll(
			'[aria-label="Seats"] [data-seat][data-act-agent]'
		);
		expect(seats).toHaveLength(6);
		const rows = railRows();
		expect(rows.map((row) => row.getAttribute("data-act-agent"))).toEqual([
			FIXTURE_AGENT_IDS.io,
			FIXTURE_AGENT_IDS.gu,
			FIXTURE_AGENT_IDS.ha,
			FIXTURE_AGENT_IDS.ju,
		]);
		const acts = agentActs(usefulStateFixture(), FIXTURE_NOW, FIXTURE_CLOCK);
		for (const row of rows) {
			const act = acts.get(row.getAttribute("data-act-agent") ?? "");
			expect(row.getAttribute("aria-label")).toStartWith(
				act?.ariaLabel ?? "(none)"
			);
		}
		await view.dispose();
	});

	test("Ada's agent-row Answer button opens the ask card", async () => {
		const { calls, port } = fixturePort();
		const view = await mount(onFixture(usefulStateFixture(), port));
		await pressAct(actButtons(agentRow(view.container, "Ada"), "Answer")[0]);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		await view.dispose();
	});

	test("Di's agent row has two Details buttons, the second opens the BlockerCard for Nightly backup", async () => {
		const view = await mount(onFixture());
		const details = actButtons(agentRow(view.container, "Di"), "Details");
		expect(details).toHaveLength(2);
		await pressAct(details[1]);
		expect(
			document.querySelector("[data-blocker-card]")?.textContent
		).toContain("Nightly backup");
		await view.dispose();
	});

	test("Gu's agent-row Open answer button opens the reply ask card", async () => {
		const view = await mount(onFixture());
		await openRail(view.container);
		const gu = railRows().find(
			(row) => row.getAttribute("data-act-agent") === FIXTURE_AGENT_IDS.gu
		);
		await pressAct(actButtons(gu?.closest("li"), "Open answer")[0]);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Edited 3 files"
		);
		await view.dispose();
	});

	test("the HUD summary reads 3 need you · 2 working · 1 failed · 1 limited", async () => {
		const view = await mount(onFixture());
		expect(view.container.textContent).toContain(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		await view.dispose();
	});

	test("the Queue button reads Queue · 9 and is visible", async () => {
		const view = await mount(onFixture());
		const queue = view.container.querySelector("[data-queue-button]");
		expect(queue?.textContent).toBe("Queue · 9");
		expect(queue?.closest(".sr-only")).toBeNull();
		await view.dispose();
	});

	test("AskQueueList lists Ha's heal_fix suggestion", async () => {
		const view = await mount(onFixture());
		const items = [
			...view.container.querySelectorAll(
				"[data-ask-queue='reveal'] [data-ask-queue-item]"
			),
		].map((item) => item.getAttribute("aria-label"));
		expect(items).toContain(
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
		await view.dispose();
	});

	test("without asks the agent rows and counters are unchanged", () => {
		const { asks: _asks, ...old } = usefulStateFixture();
		const markup = renderToStaticMarkup(onFixture(old));
		expect(markup).not.toContain("data-act-agent");
		expect(markup).not.toContain("data-act-status");
		expect(markup).not.toContain("data-ask-queue");
		expect(markup).not.toContain("data-queue-button");
	});

	test("redacted: no fixture titles, routine names or targets", () => {
		const markup = renderToStaticMarkup(
			onFixture(usefulStateFixture({ privacy: "redacted" }))
		);
		for (const secret of FIXTURE_PRIVATE_STRINGS) {
			expect(markup).not.toContain(secret);
		}
	});

	test("in-scene cards and rows only open the ask card; Approve needs Confirm (13d)", async () => {
		const { calls, port } = fixturePort();
		const view = await mount(onFixture(usefulStateFixture(), port));
		// Ada's seat plate on the table (the fallback's in-scene card row).
		const seat = view.container.querySelector(
			`[data-seat="${FIXTURE_AGENT_IDS.ada}"]`
		);
		expect(seat?.getAttribute("aria-label")).toEndWith("Answer their ask.");
		expect(seat?.hasAttribute("aria-pressed")).toBe(false);
		await pressAct(seat);
		const card = () => document.querySelector("[data-ask-card]");
		expect(card()?.textContent).toContain("Can I run shell.run now?");
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		await pressAct(actButtons(card(), "Approve")[0]);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		await pressAct(
			[...(card()?.querySelectorAll("button") ?? [])].find((button) =>
				button.textContent?.startsWith("Confirm")
			)
		);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([
			"answer:approval:ada-shell:approve",
		]);
		// No Approve or Reject chips on the felt: only the card answers.
		expect(
			[...view.container.querySelectorAll("button")].filter(
				(button) =>
					button.closest("[data-ask-card]") === null &&
					/^(Approve|Reject)$/.test(button.textContent ?? "")
			)
		).toEqual([]);
		await view.dispose();
	});

	test("chairs go to the most urgent acts; a failure shows even while working", async () => {
		const snapshot = usefulStateFixture();
		const view = await mount(onFixture(snapshot));
		const seated = [
			...view.container.querySelectorAll('[aria-label="Seats"] [data-seat]'),
		].map((plate) => plate.getAttribute("data-seat"));
		const ids = FIXTURE_AGENT_IDS;
		expect(seated).toEqual([ids.bo, ids.ada, ids.di, ids.ed, ids.fa, ids.cy]);
		// Di (failed) keeps a chair; the failure is a Details opener on the seat.
		const di = agentRow(view.container, "Di");
		expect(actButtons(di, "Details")).toHaveLength(2);
		await view.dispose();
		// A running thread for Di no longer hides the failure (the seatTone fix).
		const running = {
			...snapshot,
			threads: [
				...snapshot.threads,
				{
					...(snapshot.threads.find((thread) =>
						thread.agentIds.includes(ids.di)
					) as InterfaceThread),
					blocker: null,
					id: "thread-di-live",
					running: true,
					runState: "running" as const,
					title: "Another go",
				},
			],
		};
		const again = await mount(onFixture(running));
		const live = agentRow(again.container, "Di");
		expect(actButtons(live, "Details").length).toBeGreaterThan(0);
		// The seat's own ring says it: red, not the working timer, because the
		// fallback's tone comes from Di's act, never from the running thread.
		const ring = again.container.querySelector(`[data-seat="${ids.di}"]`);
		expect(ring?.querySelector(".border-destructive")).not.toBeNull();
		expect(ring?.querySelector("[data-action-timer]")).toBeNull();
		const acts = agentActs(running, FIXTURE_NOW, FIXTURE_CLOCK);
		const diAct = acts.get(ids.di);
		expect(diAct && actSeatTone(diAct)).toBe("attention");
		// Cy works with no failure: the timer ring, with no lap from updatedAt.
		const cy = again.container.querySelector(`[data-seat="${ids.cy}"]`);
		expect(cy?.querySelector("[data-action-timer]")).not.toBeNull();
		expect(cy?.querySelector(".border-destructive")).toBeNull();
		await again.dispose();
	});

	test("seat plates: Ada's answers her ask; Cy's keeps the seat menu (15a)", async () => {
		const { calls, port } = fixturePort();
		const view = await mount(onFixture(usefulStateFixture(), port));
		const ids = FIXTURE_AGENT_IDS;
		const ada = view.container.querySelector<HTMLElement>(
			`[data-seat="${ids.ada}"][data-act-agent]`
		);
		// Ada's per-agent target answers: a Tab stop, no aria-pressed.
		expect(ada?.tabIndex).toBe(0);
		expect(ada?.hasAttribute("aria-pressed")).toBe(false);
		await pressAct(ada);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		await view.dispose();
		// Cy's keeps the game's own action: the seat menu with its threads.
		const again = await mount(onFixture());
		const cy = again.container.querySelector<HTMLElement>(
			`[data-seat="${ids.cy}"][data-act-agent]`
		);
		const cyAct = agentActs(
			usefulStateFixture(),
			FIXTURE_NOW,
			FIXTURE_CLOCK
		).get(ids.cy);
		expect(cy?.getAttribute("aria-label")).toBe(
			`${cyAct?.ariaLabel} Seat menu.`
		);
		await pressAct(cy);
		expect(
			document.querySelector('[aria-label="Cy\'s threads"]')
		).not.toBeNull();
		expect(document.querySelector("[data-ask-card]")).toBeNull();
		await again.dispose();
		// In the room the plate is a stage target (Tab and arrow order, plate
		// separation): data-iso-target as well as data-act-scene.
		const scene = renderToStaticMarkup(
			<TableSeat
				act={{
					answer: () => undefined,
					iconOnly: false,
					scene: true,
					sentence: "Ada asks: Run deploy.sh?",
					tone: "your-turn",
				}}
				actions={{
					activeThreadId: null,
					now: NOW,
					onDeal: () => undefined,
					onOpen: () => undefined,
					snapshot: SNAPSHOT,
				}}
				compact
				nameplate
				seat={seatAgents(SNAPSHOT).seated[0] as never}
				side="bottom"
			/>
		);
		expect(scene).toContain("data-iso-target");
		expect(scene).toContain("data-act-scene");
		expect(scene).not.toContain("aria-pressed");
		expect(scene).toContain("Answer their ask.");
		expect(scene).not.toContain("data-timer-chip");
	});

	test("overlay budget at the stage's width: exempt targets stay, the tally is a HUD button (21)", async () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const { offStage, onStage } = stageAgents(acts, MAX_SEATS);
		const slots = youSpotSlots(
			acts,
			unownedAsks(snapshot),
			onStage.map((act) => act.agentId)
		);
		// The room fills the game's section: the viewport's width at 1280 and
		// 390 (no drawer open), as useStageSize measures it.
		const items = cardOverlays(onStage, slots, offStage, false);
		const wide = overlayBudget(1280, { domTargets: true });
		const narrow = overlayBudget(390, { domTargets: true });
		const shownWide = wide.fill(items);
		const shownNarrow = narrow.fill(items);
		const ids = FIXTURE_AGENT_IDS;
		expect(shownWide.size).toBeLessThanOrEqual(16);
		expect(shownNarrow.size).toBeLessThanOrEqual(8);
		// Seated players never speak: no budget goes to a bubble.
		expect(
			[...shownWide].filter((id) => /^(ask|work|done|wait):/.test(id))
		).toEqual([]);
		for (const id of [
			"tally:off",
			`limit:${ids.fa}`,
			`progress:${ids.cy}`,
			`elapsed:${ids.cy}`,
			`next:${ids.cy}`,
		]) {
			expect(shownWide.has(id)).toBe(true);
			expect(shownNarrow.has(id)).toBe(true);
		}
		// Exempt targets stay focusable; on the phone they go icon-only.
		expect(wide.focusable && narrow.focusable).toBe(true);
		expect([wide.iconOnly, narrow.iconOnly]).toEqual([false, true]);
		// Wiring: the off-stage tally is a focusable, budgeted HUD button by
		// the queue (visible whether the rail is a panel or folded), and it
		// opens the queue sheet.
		const view = await mount(onFixture(snapshot));
		const tally =
			view.container.querySelector<HTMLElement>('[data-tally="off"]');
		expect(tally?.getAttribute("data-budgeted-overlay")).toBe("tally");
		expect(tally?.tabIndex).toBe(0);
		expect(tally?.getAttribute("aria-label")).toBe(
			"4 more agents. Open the queue"
		);
		expect(tally?.closest(".sr-only")).toBeNull();
		await view.dispose();
	});

	test("counters follow the acts: the hand, its cards, the pot", async () => {
		const snapshot = usefulStateFixture();
		const view = await mount(onFixture(snapshot));
		const root = view.container;
		const t = FIXTURE_THREAD_IDS;
		// The hand counts cards; "waiting on you" is the HUD's "3 need you".
		const label = root.querySelector('[data-testid="card-table-hand-label"]');
		expect(label?.textContent).not.toContain("waiting on you");
		const card = (id: string) =>
			root.querySelector(`[data-card="${id}"]`)?.getAttribute("aria-label");
		// Only a counted failed run reads "Failed run" (Di's two); Ed's is
		// interrupted; Ha's is too old to count and leaves the hand.
		expect(root.querySelectorAll("[data-card]").length).toBeGreaterThan(0);
		const footers = [...root.querySelectorAll("[data-card-footer]")].map(
			(footer) => footer.textContent
		);
		expect(footers.filter((text) => text?.includes("Failed run"))).toHaveLength(
			2
		);
		expect(card(t.ed)).toStartWith("Resume the migration. Interrupted, Ed");
		expect(card(t.haDigest)).toBeUndefined();
		// Ages come from the failure or the ask, never from updatedAt, and an
		// estimated one says so (waitLabel with approx): Ed's interruption
		// time is only known roughly.
		const ed = snapshot.threads.find((thread) => thread.id === t.ed);
		expect(ed?.blocker?.atApprox).toBe(true);
		expect(card(t.ed)).toBe(
			"Resume the migration. Interrupted, Ed, ~1h. Play card"
		);
		const bo = snapshot.asks?.find((ask) => ask.threadId === t.bo);
		expect(card(t.bo)).toEndWith(
			`, Bo, ${waitLabel(bo?.since ?? null, FIXTURE_NOW, { approx: bo?.sinceApprox })}. Play card`
		);
		// Ada's card says what her ask (act.ask) asks, not the last message.
		const adaCard = root.querySelector(`[data-card="${t.ada}"]`);
		expect(adaCard?.textContent).toContain("Run deploy.sh?");
		expect(adaCard?.textContent).not.toContain("I queued the deploy");
		// The pot holds the working agents' threads (Cy's and Io's).
		expect(
			actPotThreads(snapshot, agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK))
		).toHaveLength(2);
		const pot = root.querySelector('[aria-label^="Pot:"]');
		expect(pot?.getAttribute("aria-label")).toBe(
			"Pot: 2 threads working. Show them"
		);
		// The dealer button names the next deal by the act clock.
		expect(root.querySelector("[data-dealer]")?.textContent).toContain(
			"Next deal"
		);
		// Phones show the summary (the title plate is hidden there).
		const phone = root.querySelector(
			'[data-testid="card-table-summary-phone"]'
		);
		expect(phone?.textContent).toBe(
			"3 need you · 2 working · 1 failed · 1 limited"
		);
		expect(phone?.className).not.toContain("sr-only");
		await view.dispose();
	});

	test("rail rows carry the act status only: no repeat, no raw act name", async () => {
		const view = await mount(onFixture());
		await openRail(view.container);
		const rows = railRows().map((control) => control.closest("li"));
		expect(rows).toHaveLength(4);
		for (const row of rows) {
			const control = row?.querySelector("[data-act-agent]");
			// The row's control holds the face and the name; the status line
			// under it is the act's only words.
			expect(control?.textContent).not.toMatch(
				/idle|working|delivering|limited|asking|blocked|waiting/
			);
		}
		await view.dispose();
	});

	test("the Cards layout reads the acts: act names, status lines, Answer opens the ask", async () => {
		const { calls, port } = fixturePort();
		const view = await mount(
			<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
				{table({ layout: "spread", port, snapshot: usefulStateFixture() })}
			</ActClockProvider>
		);
		const acts = agentActs(usefulStateFixture(), FIXTURE_NOW, FIXTURE_CLOCK);
		const ids = FIXTURE_AGENT_IDS;
		const deck = view.container.querySelector(`[data-deck="${ids.ada}"]`);
		expect(deck?.getAttribute("aria-label")).toBe(
			`${acts.get(ids.ada)?.ariaLabel} Fan out the deck.`
		);
		expect(deck?.getAttribute("data-act-agent")).toBe(ids.ada);
		// No legacy deck counters ("1 failed", ages) under the names.
		const di = view.container.querySelector(`[data-deck="${ids.di}"]`);
		const title = di?.parentElement?.querySelector("h3");
		expect(title?.parentElement?.textContent).toBe("Di2");
		const status = deck?.parentElement?.querySelector("[data-act-status]");
		expect(status).not.toBeNull();
		await pressAct(actButtons(status, "Answer")[0]);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		await view.dispose();
	});

	test("on a tall stage the rail panel starts below the act HUD and stops above the seats once", async () => {
		// A roomy, tall stage: the rail is a panel, not a pill.
		const rect = HTMLElement.prototype.getBoundingClientRect;
		HTMLElement.prototype.getBoundingClientRect = () =>
			({
				bottom: 1600,
				height: 1600,
				left: 0,
				right: 1400,
				toJSON: () => ({}),
				top: 0,
				width: 1400,
				x: 0,
				y: 0,
			}) as DOMRect;
		const panel = async (snapshot: InterfaceSnapshot) => {
			const view = await mount(onFixture(snapshot));
			const nav = view.container.querySelector<HTMLElement>(
				'nav[data-testid="card-table-rail"]'
			);
			const read = {
				maxHeight: Number.parseFloat(nav?.style.maxHeight ?? ""),
				panel: nav?.className.includes("absolute") === true,
				top: nav?.style.top ? Number.parseFloat(nav.style.top) : 12,
			};
			await view.dispose();
			return read;
		};
		try {
			const withActs = await panel(usefulStateFixture());
			const { asks: _asks, ...old } = usefulStateFixture();
			const without = await panel(old);
			expect(withActs.panel && without.panel).toBe(true);
			// With acts the panel starts lower, under the act HUD...
			expect(withActs.top).toBeGreaterThan(without.top);
			// ...and still stops at the same line above the left-hand seats:
			// the HUD's room is taken off its height once, not twice.
			expect(withActs.top + withActs.maxHeight).toBe(
				without.top + without.maxHeight
			);
			expect(withActs.maxHeight).toBeGreaterThan(96);
		} finally {
			HTMLElement.prototype.getBoundingClientRect = rect;
		}
	});

	test("a quiet thread reads Done when it has messages, Not started when it has none", async () => {
		const snapshot = usefulStateFixture();
		const lead = FIXTURE_AGENT_IDS.ha;
		const quiet: InterfaceSnapshot = {
			...snapshot,
			threads: [
				...snapshot.threads,
				thread({
					agentIds: [lead],
					id: "t-finished",
					lastMessageRole: "assistant",
					messageCount: 6,
					title: "Finished work",
					updatedAt: new Date(FIXTURE_NOW - 3 * 60 * MINUTE).toISOString(),
				}),
				thread({
					agentIds: [lead],
					id: "t-fresh",
					lastMessageRole: null,
					messageCount: 0,
					title: "Fresh thread",
					updatedAt: new Date(FIXTURE_NOW - 2 * 60 * MINUTE).toISOString(),
				}),
			],
		};
		const acts = agentActs(quiet, FIXTURE_NOW, FIXTURE_CLOCK);
		const context = {
			nowMs: FIXTURE_NOW,
			verdicts: actCardVerdicts(quiet, acts),
		};
		const byId = (id: string) =>
			quiet.threads.find((item) => item.id === id) as InterfaceThread;
		expect(threadReading(byId("t-finished"), FIXTURE_NOW, context).label).toBe(
			"Done"
		);
		expect(threadReading(byId("t-fresh"), FIXTURE_NOW, context).label).toBe(
			"Not started"
		);
		// The Cards layout says it in words on each face's footer.
		const view = await mount(
			<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
				{table({ layout: "spread", port: fixturePort().port, snapshot: quiet })}
			</ActClockProvider>
		);
		await click(view.container.querySelector(`[data-deck="${lead}"]`));
		const footer = (id: string) =>
			view.container
				.querySelector(`[data-thread-id="${id}"], [data-card="${id}"]`)
				?.querySelector("[data-card-footer]")?.textContent;
		expect(footer("t-finished")).toEndWith("Done");
		expect(footer("t-fresh")).toEndWith("Not started");
		await view.dispose();
	});

	test("an asking deck's label opens the ask, and focus comes back to the pile", async () => {
		const { calls, port } = fixturePort();
		const view = await mount(
			<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
				{table({ layout: "spread", port, snapshot: usefulStateFixture() })}
			</ActClockProvider>
		);
		const ids = FIXTURE_AGENT_IDS;
		const label = view.container.querySelector<HTMLElement>(
			`[data-deck-answer="${ids.ada}"]`
		);
		expect(label?.tabIndex).toBe(-1);
		expect(label?.getAttribute("aria-label")).toEndWith("Answer their ask.");
		await pressAct(label);
		expect(document.querySelector("[data-ask-card]")?.textContent).toContain(
			"Can I run shell.run now?"
		);
		expect(calls.filter((call) => call.startsWith("answer"))).toEqual([]);
		// Only asking decks: Cy's label is plain.
		expect(
			view.container.querySelector(`[data-deck-answer="${ids.cy}"]`)
		).toBeNull();
		await view.dispose();
	});

	test("the seat menu and the drawer read the act: its sentence, its ring, no lap", async () => {
		const snapshot = usefulStateFixture();
		const acts = agentActs(snapshot, FIXTURE_NOW, FIXTURE_CLOCK);
		const ids = FIXTURE_AGENT_IDS;
		const view = await mount(onFixture(snapshot));
		await pressAct(
			view.container.querySelector(`[data-seat="${ids.cy}"][data-act-agent]`)
		);
		const menu = document.querySelector(
			'[aria-label="Cy\'s threads"]'
		)?.parentElement;
		expect(menu?.textContent).toContain(
			acts.get(ids.cy)?.ariaLabel ?? "(none)"
		);
		await view.dispose();
		// The drawer on Cy's thread: the ring from Cy's act, with no lap from
		// updatedAt; the status as Cy's card reads it.
		const drawer = (source: InterfaceSnapshot) => {
			const host = document.createElement("div");
			host.innerHTML = renderToStaticMarkup(
				<ActClockProvider clock={FIXTURE_CLOCK} nowMs={FIXTURE_NOW}>
					{table({
						activeThreadId: FIXTURE_THREAD_IDS.cy,
						port: fixturePort().port,
						snapshot: source,
						threadView: <p>thread</p>,
					})}
				</ActClockProvider>
			);
			return host.querySelector('[data-testid="card-table-drawer"]');
		};
		const withActs = drawer(snapshot);
		const arc = withActs?.querySelector("[data-timer-arc]");
		expect(arc).not.toBeNull();
		expect(Number(arc?.getAttribute("stroke-dashoffset"))).toBe(0);
		expect(withActs?.querySelector("header p")?.textContent).toContain(
			"Working"
		);
	});

	test("lap: with acts a working seat's timer starts at zero, never from updatedAt", () => {
		const snapshot = usefulStateFixture();
		const ids = FIXTURE_AGENT_IDS;
		const arcOf = (source: InterfaceSnapshot) => {
			const host = document.createElement("div");
			host.innerHTML = renderToStaticMarkup(onFixture(source));
			const arc = host.querySelector(
				`[data-seat="${ids.cy}"] [data-timer-arc]`
			);
			return {
				circumference: Number(arc?.getAttribute("stroke-dasharray")),
				offset: Number(arc?.getAttribute("stroke-dashoffset")),
			};
		};
		const acted = arcOf(snapshot);
		expect(acted.circumference).toBeGreaterThan(0);
		expect(acted.offset).toBe(0);
	});

	test("the dealer pill is shorter on a phone; its words stay whole for screen readers", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			<>
				<DealerButton compact={false} text="tomorrow 09:00" />
				<DealerButton compact text="tomorrow 09:00" />
			</>
		);
		const [wide, phone] = [...host.querySelectorAll("[data-dealer]")];
		const visible = (pill: Element | undefined) =>
			[...(pill?.querySelectorAll("span") ?? [])]
				.filter(
					(span) =>
						!span.classList.contains("sr-only") &&
						span.getAttribute("aria-hidden") !== "true" &&
						span.children.length === 0
				)
				.map((span) => span.textContent)
				.join("");
		expect(wide?.textContent).toBe("DNext deal tomorrow 09:00");
		expect(phone?.textContent).toBe("DNext deal tomorrow 09:00");
		expect(visible(wide)).toBe("Next deal ");
		expect(phone?.querySelector(".sr-only")?.textContent).toBe("Next deal ");
		expect(phone?.className).toContain("max-w-44");
	});

	test("folds lie on the outer side by the chair, with their reasons beside them", () => {
		type Point = readonly [number, number, number];
		const screenRight = (point: Point) => Math.SQRT1_2 * (point[0] - point[2]);
		const apart = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[2] - b[2]);
		for (const seat of roomSeats()) {
			const chips: Point = [seat.chips[0], 0, seat.chips[1]];
			const chair: Point = [seat.at[0], 0, seat.at[1]];
			const outer = Math.sign(screenRight(chair)) || 1;
			const felt = seatFelt(seat, 2);
			for (const index of [0, 1]) {
				const fold = felt.fold(index);
				// Past the chair on the seat's own side of the screen, never on
				// the felt toward the pot.
				expect(
					outer * (screenRight(fold) - screenRight(chair))
				).toBeGreaterThan(0);
				expect(apart(fold, chair)).toBeLessThan(1.5);
				expect(apart(fold, chips)).toBeGreaterThan(apart(chair, chips));
			}
			// The puck lies there too, for a limited player.
			expect(
				outer * (screenRight(felt.puck) - screenRight(chair))
			).toBeGreaterThan(0);
			// The reason (the alarm) stands just past the last fold, and its
			// plates hang outward, off the seat's own figure.
			const layout = seatLayout(seat, false, 2);
			const alarm = layout.alarms ?? [0, 0, 0];
			const reason: Point = [chips[0] + alarm[0], 0, chips[2] + alarm[2]];
			expect(apart(reason, felt.fold(1))).toBeLessThan(0.6);
			expect(layout.alarmSide).toBe(outer > 0 ? "right" : "left");
			// Phones keep the kit's stacking: no step of the game's own.
			expect(seatLayout(seat, true, 2).alarmStep).toBeUndefined();
		}
	});
});

describe("Card Table settings", () => {
	test("default to the poker table, classic felt and backs; junk falls back", () => {
		expect(resolveInterfaceParams("card-table", {})).toMatchObject({
			deck: "classic",
			felt: "classic",
			layout: "poker",
		});
		expect(
			resolveInterfaceParams("card-table", { deck: 3, felt: "plaid" })
		).toMatchObject({ deck: "classic", felt: "classic" });
	});

	test("classic is the stock look; presets repaint the felt and the backs", () => {
		expect(cardRoomCloth("classic", "classic")).toEqual({
			cardBack: CARD_ROOM_3D.cardBack,
			felt: CARD_ROOM_3D.felt,
			feltLine: CARD_ROOM_3D.feltLine,
		});
		expect(spreadFelt("classic")).toEqual({
			dark: FELT_BACKGROUND_DARK,
			light: FELT_BACKGROUND,
		});
		expect(cardBackFor("classic")).toBe(CARD_BACK);
		expect(cardRoomCloth("blue", "red")).toEqual({
			cardBack: DECK_PRESETS.red.room,
			felt: FELT_PRESETS.blue.room,
			feltLine: FELT_PRESETS.blue.roomLine,
		});
		expect(cardBackFor("black")).toBe(DECK_PRESETS.black.back);
	});

	test("the spread reads its felt and deck from params", async () => {
		const { port } = recordingPort();
		expect(
			cardTableSettings({ deck: "red", felt: "blue", layout: "spread" })
		).toMatchObject({ deck: "red", felt: "blue", layout: "spread" });
		const view = await mount(
			<CardTableInterface
				activeThreadId={null}
				loading={false}
				params={{ deck: "black", felt: "red", layout: "spread" }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const stage = view.container.querySelector<HTMLElement>(
			'[data-testid="card-table-spread"]'
		);
		expect(stage?.style.getPropertyValue("--ct-felt")).toBe(
			FELT_PRESETS.red.light
		);
		expect(stage?.style.getPropertyValue("--ct-felt-dark")).toBe(
			FELT_PRESETS.red.dark
		);
		await view.dispose();
	});

	test("the Table/Cards switch saves the layout, and Settings changes it live", async () => {
		const saved: Record<string, unknown>[] = [];
		const port: InterfacePort = {
			...recordingPort().port,
			updateSettings: (patch) => saved.push(patch),
		};
		const spread = () =>
			view.container.querySelector('[data-testid="card-table-spread"]');
		const view = await mount(table({ port }));
		await click(buttonByText(view.container, "Cards"));
		expect(saved).toEqual([{ layout: "spread" }]);
		expect(spread()).not.toBeNull();
		// A param from Settings replaces the local choice.
		await view.rerender(table({ layout: "spread", port }));
		await view.rerender(table({ layout: "poker", port }));
		expect(spread()).toBeNull();
		await view.dispose();
	});
});
