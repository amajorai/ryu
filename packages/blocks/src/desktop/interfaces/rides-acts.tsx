/* eslint-disable react/no-unknown-property */
import { useFrame, useThree } from "@react-three/fiber";
import {
	askKindWords,
	type ClockOptions,
	compareAsks,
	type InterfaceAgentAct,
	type InterfaceBlocker,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { useLayoutEffect, useRef } from "react";
import type { Group, MeshBasicMaterial } from "three";
import {
	ActStation,
	type LimitText,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actBubble,
	actorTarget,
	bubbleOverlayId,
	countedBlockerThreads,
	type OffStage,
	slotOf,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import type { LifePaths } from "./game3d-life.ts";
import { bubbleWords, LifeBubbleTag } from "./game3d-life.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { IsoMarker } from "./game3d-stage.tsx";
import { plainText } from "./interface-ask-card.tsx";
import { STAGE_LABELS, type TripStage } from "./rides-model.ts";
import { RIDES_ACT_3D } from "./rides-palette.ts";
import { inRiver, type RidesCityPlan } from "./rides-scene.ts";

/**
 * The rides act layer. Cars are the actors (`actorTarget`, not villagers):
 * an asking driver pulls up at the pickup kerb in front of you (the queue,
 * with a taxi-meter timer; notices for parked and unowned asks pin to posts
 * there), a delivering one drops its parcel at the kerb, and every other
 * car keeps to its own spot on the map (its route, its pin, or home). Each
 * car is an `ActStation` (hazard alarms, limit light, unread mark,
 * suggestion note, progress and its station board) with a roof sign for
 * the step it is on, and its name plate is its per-agent target. Words only
 * come from the act (`agentActs` on an already-redacted snapshot).
 */

/** What the rides scene needs to act out the snapshot. */
export interface RidesActView {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	/** Narrow stages: act props and plates collapse to glyphs. */
	iconOnly: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	/** Owner names of asks, for notice plates ("Ada asks: …"). */
	owners: ReadonlyMap<string, string>;
	privacy: "full" | "redacted";
	/** The overlay budget's chosen ids (actOverlays). */
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	/** Each trip's act word and stage (pins and labels say it). */
	trips?: ReadonlyMap<string, RidesActTrip>;
}

/** How a trip's row word reads: your move, a counted failure, or old news. */
export type RidesTripTone = "alert" | "dim" | "plain" | "you";

/** A trip as the act layer sees it: its sheet stage and its row word. */
export interface RidesActTrip {
	/** The open trip's sentence under its word, true to the act. */
	detail: string;
	/** A finished trip that ended well: the track fills. */
	done: boolean;
	stage: TripStage;
	tone: RidesTripTone;
	word: string;
}

/**
 * Every thread's trip state from the acts, so the sheet, the list, the
 * open trip and the map agree with the counters: a blocking ask is
 * "Waiting on you", a counted failure its title (the only "Needs
 * attention" trips), a running thread en route, a reply ask "Answer
 * ready" (the only arrivals, as the Queue counts them), a limit a red
 * light, and an interrupted run or an old, uncounted blocker a word in
 * the history (dim when old). `updatedAt` never stages a trip.
 */
export function ridesActTrips(
	snapshot: Pick<InterfaceSnapshot, "agents" | "asks" | "privacy" | "threads">,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, RidesActTrip> {
	const counted = countedBlockerThreads(snapshot, acts);
	const asks = snapshot.asks ?? [];
	const redacted = snapshot.privacy === "redacted";
	const limited = new Set(
		[...acts.values()]
			.filter((act) => act.act === "limited" && act.threadId)
			.map((act) => act.threadId)
	);
	// The act on each thread: whose run, or whose limit, it is.
	const actOn = new Map(
		[...acts.values()]
			.filter((act) => act.threadId)
			.map((act) => [act.threadId, act.agentName] as const)
	);
	const actAsks = new Set(
		[...acts.values()].flatMap((act) =>
			act.act === "asking" && act.ask ? [act.ask.id] : []
		)
	);
	const nameOf = (agentId: string | null | undefined) =>
		snapshot.agents.find((agent) => agent.id === agentId)?.name;
	const out = new Map<string, RidesActTrip>();
	for (const thread of snapshot.threads) {
		const own = asks.filter((ask) => ask.threadId === thread.id);
		// The ask the act shows (its bubble and card), else the first in
		// queue order: never whichever the array happens to list first.
		const blocking =
			own.find((ask) => ask.blocking && actAsks.has(ask.id)) ??
			own.filter((ask) => ask.blocking).sort(compareAsks)[0];
		out.set(
			thread.id,
			actTrip(thread, {
				asked: blocking
					? redacted
						? askKindWords(blocking)
						: plainText(blocking.text) || askKindWords(blocking)
					: null,
				counted: counted.get(thread.id)?.blocker,
				// Who the sentence is about: the asker, else whose act is on
				// this thread, else its first member.
				driver:
					(blocking ? nameOf(blocking.agentId) : undefined) ??
					actOn.get(thread.id) ??
					nameOf(thread.agentIds[0]) ??
					"Your driver",
				redacted,
				limited: limited.has(thread.id),
				replied: own.some((ask) => ask.kind === "reply"),
			})
		);
	}
	return out;
}

function actTrip(
	thread: InterfaceThread,
	state: {
		/** The blocking ask's words, when one waits on this thread. */
		asked: string | null;
		counted: InterfaceBlocker | undefined;
		driver: string;
		limited: boolean;
		redacted: boolean;
		replied: boolean;
	}
): RidesActTrip {
	const { asked, counted, driver } = state;
	if (asked !== null) {
		return {
			detail: `${driver} is asking you: ${asked}`,
			done: false,
			stage: "requested",
			tone: "you",
			word: "Waiting on you",
		};
	}
	if (
		counted &&
		counted.kind !== "interrupted" &&
		counted.kind !== "rate-limited"
	) {
		return {
			detail:
				(state.redacted || !counted.detail
					? null
					: plainText(counted.detail)) ??
				`${counted.title}. Send a message to try again.`,
			done: false,
			stage: "cancelled",
			tone: "alert",
			word: counted.title,
		};
	}
	if (thread.running) {
		return {
			detail: `${driver} is on it.`,
			done: false,
			stage: "enroute",
			tone: "plain",
			word: STAGE_LABELS.enroute,
		};
	}
	if (state.replied) {
		return {
			detail: `${driver} brought an answer.`,
			done: true,
			stage: "arrived",
			tone: "you",
			word: "Answer ready",
		};
	}
	// A limit is a red light, never "Completed": on the thread or the agent.
	// (A reply already waiting outranks it: the answer can be read now.)
	if (state.limited || counted?.kind === "rate-limited") {
		return {
			detail: `${driver} is waiting at a red light (a usage limit).`,
			done: false,
			stage: "completed",
			tone: "plain",
			word: "Red light",
		};
	}
	if (counted?.kind === "interrupted") {
		return {
			detail: "The run was interrupted. Send a message to try again.",
			done: false,
			stage: "completed",
			tone: "plain",
			word: counted.title,
		};
	}
	if (thread.blocker) {
		return {
			detail: `An older run: ${thread.blocker.title}.`,
			done: false,
			stage: "completed",
			tone: "dim",
			word: thread.blocker.title,
		};
	}
	const stage = threadStatus(thread) === "quiet" ? "unstarted" : "completed";
	return {
		detail: stage === "unstarted" ? "Nothing has been sent yet." : "Done.",
		done: stage === "completed",
		stage,
		tone: "plain",
		word: STAGE_LABELS[stage],
	};
}

/** Where an act's working car is along its route: its pips, or nothing. */
export function actRouteShare(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	threadId: string
): number | null {
	for (const act of acts.values()) {
		const progress = act.progress;
		if (act.threadId === threadId && progress && progress.total > 0) {
			return Math.min(1, Math.max(0, progress.done / progress.total));
		}
	}
	return null;
}

/** The rides' produce: a parcel. */
const PARCEL = { shape: "bag" as const };

/** A ground offset `across` the view (screen right) and `out` toward the camera. */
function offset(at: Vec3, across: number, out: number, lift = 0): Vec3 {
	const c = Math.SQRT1_2;
	return [at[0] + (across + out) * c, at[1] + lift, at[2] + (out - across) * c];
}

const ORIGIN: Vec3 = [0, 0, 0];

/** Whether a ground point is open road: inside the city, off the blocks and the river. */
export function onRoad(plan: RidesCityPlan, x: number, z: number): boolean {
	const { rect } = plan;
	if (x < rect.minX || x > rect.maxX || z < rect.minZ || z > rect.maxZ) {
		return false;
	}
	if (inRiver(plan.frame, x, z)) {
		return false;
	}
	const margin = 0.15;
	return !plan.blocks.some(
		({ rect: block }) =>
			x > block.minX - margin &&
			x < block.maxX + margin &&
			z > block.minZ - margin &&
			z < block.maxZ + margin
	);
}

/** How far a kerb place keeps from any car's own spot. */
const CAR_CLEAR = 1.6;

/**
 * Places along the pickup's own street, a `step` apart, on road and clear
 * of the cars' own spots: the street runs across the screen on a diagonal
 * (the city's grid is turned 45 degrees), so no two queue plates share a
 * screen row. Of the four ways along the streets from the pickup, the
 * one with room for four, furthest from the cars, wins.
 */
function kerbLine(
	pickup: Vec3,
	plan: RidesCityPlan,
	avoid: readonly Vec3[],
	step: number
): Vec3[] {
	const clear = (x: number, z: number) =>
		onRoad(plan, x, z) &&
		avoid.every((car) => Math.hypot(car[0] - x, car[2] - z) >= CAR_CLEAR);
	const room = (line: readonly Vec3[]) =>
		Math.min(
			...line.flatMap((point) =>
				avoid.map((car) => Math.hypot(car[0] - point[0], car[2] - point[2]))
			),
			Number.POSITIVE_INFINITY
		);
	let best: Vec3[] = [];
	for (const [dx, dz] of [
		[1, 0],
		[0, 1],
		[-1, 0],
		[0, -1],
	] as const) {
		const line: Vec3[] = [];
		for (let k = 1; k <= 14 && line.length < 4; k++) {
			const x = pickup[0] + dx * step * k;
			const z = pickup[2] + dz * step * k;
			if (!onRoad(plan, x, z)) {
				break;
			}
			if (clear(x, z)) {
				line.push([x, pickup[1], z]);
			}
		}
		// The fullest line, then the one furthest from the cars (their
		// plates, alarms and bubbles stand round them).
		if (
			line.length > best.length ||
			(line.length === best.length && room(line) > room(best))
		) {
			best = line;
		}
	}
	return best;
}

/** How far the parcel tray stands from you, away from the queue. */
const TRAY_REACH = 2.6;

/** Nudges round a fallback place, nearest first. */
const NUDGES: readonly (readonly [number, number])[] = [
	[0, 0],
	[0.8, 0],
	[-0.8, 0],
	[0, 0.8],
	[0, -0.8],
	[1.6, 0],
	[-1.6, 0],
	[0, 1.6],
	[0, -1.6],
];

/** The nearest nudge of `at` on open road, clear of the cars; else `at`. */
function nearestClear(
	at: Vec3,
	plan: RidesCityPlan,
	avoid: readonly Vec3[]
): Vec3 {
	for (const [dx, dz] of NUDGES) {
		const x = at[0] + dx;
		const z = at[2] + dz;
		if (
			onRoad(plan, x, z) &&
			avoid.every((car) => Math.hypot(car[0] - x, car[2] - z) >= CAR_CLEAR)
		) {
			return [x, at[1], z];
		}
	}
	return at;
}

/**
 * The pickup kerb round you: four queue slots along the pickup's street
 * (on road, clear of the river, the blocks and the cars; a phone's a
 * longer step apart), so each slot is a step along the screen diagonal
 * from the last and no plate shares a screen row; the parcel tray on your
 * other side; the "+N more" tally past the last slot. Without a city plan
 * (tests) the slots stand in a fixed staggered row.
 */
export function ridesYouSpot(
	pickup: Vec3,
	narrow: boolean,
	plan?: RidesCityPlan,
	avoid: readonly Vec3[] = []
): { layout: YouSpotLayout; points: Record<string, Vec3> } {
	const line = plan ? kerbLine(pickup, plan, avoid, narrow ? 3.4 : 2.6) : [];
	const fallback = (index: number): Vec3 => {
		const base = narrow
			? offset(pickup, -3.4 + index * 2.3, 2 + index * 2.4)
			: offset(pickup, (index - 1.5) * 2.6, 1.6 + (index % 2) * 0.8);
		// A short line runs out of street: the rest stand near their
		// staggered place, but on road and clear of the cars when they can.
		return plan ? nearestClear(base, plan, avoid) : base;
	};
	const slot = (index: number): Vec3 => line[index] ?? fallback(index);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((point, index) => [point, slot(index)])
	) as Record<YouSlot, Vec3>;
	// The parcel tray: on your other side, away from the queue.
	const first = slot(0);
	const reach =
		Math.hypot(first[0] - pickup[0], first[2] - pickup[2]) || Number.EPSILON;
	// Far enough that a delivering car's plate and bubble clear yours.
	const away: Vec3 = [
		pickup[0] - ((first[0] - pickup[0]) / reach) * TRAY_REACH,
		pickup[1],
		pickup[2] - ((first[2] - pickup[2]) / reach) * TRAY_REACH,
	];
	const tray =
		plan && onRoad(plan, away[0], away[2]) ? away : offset(pickup, -2.6, -1.6);
	return {
		layout: {
			offStage: offset(pickup, -2.6, -1.2, 0.6),
			slots,
			tally: offset(slot(3), 1.4, 0, 0.6),
			// The taxi meter stands at the car's right front.
			timer: offset(ORIGIN, 0.75, 0.2),
			tray,
			trayStep: offset(ORIGIN, 0.7, 0),
		},
		points: { ...slots, you: pickup, "you-tray": tray },
	};
}

/** Where each car goes for its act: its own spot, or the kerb. */
export function ridesCarTarget(
	act: InterfaceAgentAct,
	home: Vec3,
	you: Record<string, Vec3>,
	slots: readonly YouSpotSlot[],
	still: boolean
): Vec3 {
	const points: Record<string, Vec3> = { ...you, [`car:${act.agentId}`]: home };
	const paths: LifePaths = { links: [], points };
	const spots: ActSpots = {
		paths,
		slot: slotOf(slots, act.agentId),
		station: `car:${act.agentId}`,
	};
	const target = actorTarget(act, spots, still).position;
	return [target[0], home[1], target[2]];
}

/**
 * A car's name plate as its per-agent target: named by the act sentence,
 * plus "Answer their ask." (an asking driver's plate is its queue plate,
 * "Ada · 14m") or the map's own action.
 */
export function RidesCarPlate({
	act,
	at,
	label,
	onSelect,
	pressed,
	reduced = false,
	view,
}: {
	act: InterfaceAgentAct;
	at: Vec3;
	/** The map's own action for other acts ("Show the trip."). */
	label: string;
	onSelect: () => void;
	pressed: boolean;
	reduced?: boolean;
	view: RidesActView;
}) {
	const ask = act.act === "asking" ? act.ask : null;
	const queued = ask !== null && slotOf(view.slots.slots, act.agentId) !== null;
	// The driver's words ride its plate: the ask, the step (dashed when
	// only partly known), the answer it brings. A phone has no room for the
	// step; under reduced motion the parcel's count says the answer.
	const bubbleId = bubbleOverlayId(act);
	const bubble =
		bubbleId &&
		view.shown.has(bubbleId) &&
		!(view.iconOnly && act.act === "working") &&
		!(reduced && act.act === "delivering")
			? actBubble(act)
			: null;
	// A working car's step is its roof sign, on top of its plate, not a
	// bubble hanging off it onto its neighbours.
	const roofSign = act.act === "working" && bubble ? bubbleWords(bubble) : null;
	return (
		<IsoMarker
			actAgent={act.agentId}
			activate={ask ? () => view.onAsk(ask.id) : undefined}
			at={at}
			className={
				roofSign
					? "relative h-auto flex-col gap-0.5 rounded-xl px-2 py-1 text-[12px]"
					: "relative h-6 px-2 text-[12px]"
			}
			iconOnly={queued ? false : view.iconOnly}
			label={
				ask ? `${act.ariaLabel} Answer their ask.` : `${act.ariaLabel} ${label}`
			}
			onSelect={onSelect}
			pressed={pressed}
			youSpot={queued ? "slot" : undefined}
		>
			{bubble && !roofSign ? <LifeBubbleTag bubble={bubble} /> : null}
			{roofSign ? (
				<span
					aria-hidden="true"
					className="max-w-36 truncate rounded-sm bg-(--gk-warn) px-1 font-semibold text-(--gk-edge) text-[11px] leading-4"
					data-budgeted-overlay="work-bubble"
					data-roof-sign=""
				>
					{roofSign}
				</span>
			) : null}
			{ask
				? queuePlateText(
						act.agentName,
						{
							approx: ask.sinceApprox,
							since: ask.since,
							until: ask.expiresAt ?? null,
							untilApprox: ask.expiresApprox,
						},
						view.nowMs
					)
				: act.agentName}
		</IsoMarker>
	);
}

/**
 * Where a car's pieces sit round it (cars are about 1.2 long): the openers
 * (alarms, unread mark) at its right, the next sign and limit light at its
 * left, the station board up and to the right, clear of its name plate and
 * the cars round it.
 */
export const RIDES_STATION_LAYOUT: Partial<StationLayout> = {
	alarms: offset(ORIGIN, 1.6, 0.4),
	board: offset(ORIGIN, 1, -0.7, 0.1),
	cue: [0, 0.02, 0],
	limit: offset(ORIGIN, -0.7, 0.6),
	next: offset(ORIGIN, -0.8, -0.4),
	pips: offset(ORIGIN, 0, 0.75, 0.05),
	suggestion: offset(ORIGIN, -0.7, -0.9),
	unread: offset(ORIGIN, 0.7, -0.6),
};

/** Route pips: legs driven in the meter's yellow, legs ahead in road grey. */
export const RIDES_PIPS = {
	done: RIDES_ACT_3D.pipDone,
	estimate: RIDES_ACT_3D.pipEstimate,
	todo: RIDES_ACT_3D.pipTodo,
};

/** "Red light till 15:10": the rides' words for a usage limit (the kit adds "Likely"). */
export const ridesLimitText: LimitText = (_act, at) =>
	at ? `Red light till ${at}` : "Red light";

/**
 * A car broken down: its hazard lights at the four corners, blinking (lit
 * steady under reduced motion). An interrupted run is pulled over, not
 * broken: no hazards (its grey alarm says so).
 */
function Hazards({ at, reduced }: { at: Vec3; reduced: boolean }) {
	const lamps = useRef<(MeshBasicMaterial | null)[]>([]);
	const invalidate = useThree((state) => state.invalidate);
	// Reduced motion lights them steady, even if a blink left them off.
	useLayoutEffect(() => {
		if (!reduced) {
			return;
		}
		for (const lamp of lamps.current) {
			// Outside a canvas (tests) the ref is not a three.js material.
			lamp?.color?.set(RIDES_ACT_3D.hazard);
		}
		invalidate();
	}, [invalidate, reduced]);
	useFrame(({ clock }) => {
		if (reduced) {
			return;
		}
		const on = Math.floor(clock.elapsedTime * 2) % 2 === 0;
		for (const lamp of lamps.current) {
			lamp?.color.set(on ? RIDES_ACT_3D.hazard : RIDES_ACT_3D.hazardOff);
		}
	});
	const corners: [number, number][] = [
		[-0.32, -0.5],
		[0.32, -0.5],
		[-0.32, 0.5],
		[0.32, 0.5],
	];
	return (
		<group position={at}>
			{corners.map(([x, z], index) => (
				<mesh key={`${x}:${z}`} position={[x, 0.3, z]}>
					<sphereGeometry args={[0.07, 10, 8]} />
					<meshBasicMaterial
						color={RIDES_ACT_3D.hazard}
						ref={(material) => {
							lamps.current[index] = material;
						}}
						toneMapped={false}
					/>
				</mesh>
			))}
		</group>
	);
}

/** Ahead of a car and to its kerb side, along its heading: on the road. */
function byNose(at: Vec3, yaw: number): Vec3 {
	const side = 0.42;
	const ahead = 0.85;
	return [
		at[0] + side * Math.cos(yaw) + ahead * Math.sin(yaw),
		at[1],
		at[2] - side * Math.sin(yaw) + ahead * Math.cos(yaw),
	];
}

/**
 * A car pulled up at the kerb honks for you: sound arcs off its nose,
 * pulsing, or drawn still under reduced motion.
 */
function Honk({
	at,
	reduced,
	yaw,
}: {
	at: Vec3;
	reduced: boolean;
	yaw: number;
}) {
	const group = useRef<Group>(null);
	// Reduced motion draws the arcs still at their full size.
	useLayoutEffect(() => {
		if (reduced) {
			group.current?.scale?.setScalar(1);
		}
	}, [reduced]);
	useFrame(({ clock }) => {
		if (reduced || !group.current) {
			return;
		}
		const beat = (clock.elapsedTime * 1.6) % 1;
		group.current.scale.setScalar(0.8 + beat * 0.4);
	});
	return (
		<group position={at} ref={group} rotation={[0, yaw, 0]}>
			{[0.18, 0.32].map((radius) => (
				<mesh
					key={radius}
					position={[0, 0.55, 0]}
					rotation={[0, -Math.PI / 4, 0]}
				>
					<torusGeometry args={[radius, 0.025, 6, 12, Math.PI / 2]} />
					<meshBasicMaterial color={RIDES_ACT_3D.honk} toneMapped={false} />
				</mesh>
			))}
		</group>
	);
}

/** A working car's lit sign on its roof (its words ride the car's plate). */
function RoofSign({ at, yaw }: { at: Vec3; yaw: number }) {
	return (
		<mesh position={[at[0], at[1] + 0.95, at[2]]} rotation={[0, yaw, 0]}>
			<boxGeometry args={[0.46, 0.2, 0.12]} />
			<meshBasicMaterial color={RIDES_ACT_3D.roofSign} toneMapped={false} />
		</mesh>
	);
}

/** The red light a limited driver waits at, by its car's front. */
function RedLight({ at }: { at: Vec3 }) {
	return (
		<group position={at}>
			<mesh position={[0, 0.55, 0]}>
				<cylinderGeometry args={[0.03, 0.03, 1.1, 8]} />
				<meshBasicMaterial color={RIDES_ACT_3D.lightPost} />
			</mesh>
			<mesh position={[0, 1.25, 0]}>
				<boxGeometry args={[0.2, 0.5, 0.14]} />
				<meshBasicMaterial color={RIDES_ACT_3D.lightBox} />
			</mesh>
			{[0.14, -0.02, -0.18].map((y, index) => (
				<mesh key={y} position={[0, 1.25 + y, 0.075]}>
					<sphereGeometry args={[0.055, 10, 8]} />
					<meshBasicMaterial
						color={index === 0 ? RIDES_ACT_3D.redLight : RIDES_ACT_3D.lightOff}
						toneMapped={false}
					/>
				</mesh>
			))}
		</group>
	);
}

/** On a phone the city is small: the board stands well behind the car, up the screen, clear of its neighbours. */
const RIDES_STATION_LAYOUT_NARROW: Partial<StationLayout> = {
	...RIDES_STATION_LAYOUT,
	board: offset(ORIGIN, 0.3, -2, 0.1),
};

/**
 * On a phone a limited car's words ("Red light till 15:10") stand further
 * across than a working car's board, so the two never meet in the small
 * city.
 */
const RIDES_STATION_LAYOUT_NARROW_LIMIT: Partial<StationLayout> = {
	...RIDES_STATION_LAYOUT_NARROW,
	board: offset(ORIGIN, 1.3, -2, 0.1),
};

/** A station's layout: a phone's own (a limit's words apart), or the wide one. */
function ridesStationLayout(
	iconOnly: boolean,
	limited: boolean
): Partial<StationLayout> {
	if (!iconOnly) {
		return RIDES_STATION_LAYOUT;
	}
	return limited
		? RIDES_STATION_LAYOUT_NARROW_LIMIT
		: RIDES_STATION_LAYOUT_NARROW;
}

/** Where a car's station board (its words, a limit's included) stands. */
export function ridesBoardOffset(iconOnly: boolean, limited = false): Vec3 {
	return ridesStationLayout(iconOnly, limited).board ?? ORIGIN;
}

/**
 * The kerb (the kit's `YouSpots`: notices, taxi meters beside queued cars,
 * the tallies, parcels left for you) and every car's station, with a roof
 * sign for the step a working car is on.
 */
export function RidesActProps({
	cars,
	onStage,
	reduced,
	view,
	yaws,
	youLayout,
}: {
	/** Where each on-stage agent's car is now (its act's target). */
	cars: ReadonlyMap<string, Vec3>;
	onStage: readonly InterfaceAgentAct[];
	reduced: boolean;
	view: RidesActView;
	/** Each car's heading (its nose along +z), to set the red light by its front. */
	yaws?: ReadonlyMap<string, number>;
	youLayout: YouSpotLayout;
}) {
	return (
		<group>
			<YouSpots
				iconOnly={view.iconOnly}
				item={PARCEL}
				layout={youLayout}
				nowMs={view.nowMs}
				offStage={view.offStage}
				onAsk={view.onAsk}
				onOpenQueue={view.onQueue}
				onStage={onStage}
				owners={view.owners}
				privacy={view.privacy}
				reduced={reduced}
				shown={view.shown}
				slots={view.slots}
				snapshot={view.snapshot}
				timerSkin={{ color: RIDES_ACT_3D.meter }}
			/>
			{onStage.map((act) => {
				const at = cars.get(act.agentId);
				if (!at) {
					return null;
				}
				return (
					<group key={act.agentId}>
						{act.act === "blocked" &&
						act.blockers[0] &&
						act.blockers[0].kind !== "interrupted" ? (
							<Hazards at={at} reduced={reduced} />
						) : null}
						{act.act === "limited" ? (
							<RedLight at={byNose(at, yaws?.get(act.agentId) ?? 0)} />
						) : null}
						{act.act === "asking" ? (
							<Honk
								at={byNose(at, yaws?.get(act.agentId) ?? 0)}
								reduced={reduced}
								yaw={yaws?.get(act.agentId) ?? 0}
							/>
						) : null}
						{act.act === "working" ? (
							<RoofSign at={at} yaw={yaws?.get(act.agentId) ?? 0} />
						) : null}
						<ActStation
							act={act}
							at={at}
							clock={view.clock}
							iconOnly={view.iconOnly}
							layout={ridesStationLayout(view.iconOnly, act.act === "limited")}
							limitText={ridesLimitText}
							nowMs={view.nowMs}
							onAsk={view.onAsk}
							onBlocker={view.onBlocker}
							pipSkin={RIDES_PIPS}
							privacy={view.privacy}
							reduced={reduced}
							shown={view.shown}
							snapshot={view.snapshot}
						/>
					</group>
				);
			})}
		</group>
	);
}
