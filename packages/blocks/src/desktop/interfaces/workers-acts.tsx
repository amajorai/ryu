/* eslint-disable react/no-unknown-property */
import type {
	ClockOptions,
	InterfaceActivityKind,
	InterfaceAgentAct,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	ActStation,
	type LimitText,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	actBubble,
	actLife,
	type OffStage,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import type { LifeBubble, LifePaths, LifeScript } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { VillagerTool } from "./game3d-villager.tsx";
import type { OfficePlan } from "./workers-model.ts";
import { WORKERS_FOLDER } from "./workers-palette.ts";

/**
 * The office's act layer (spec §5 workers row): each worker acts out its
 * agent's act on the kit (`actLife`). An asking worker carries its laptop
 * to your office door and waits in the queue there; a delivering worker
 * drops a folder in your inbox tray by the door and goes back; a limited
 * worker (or one with nothing to do) waits in the coffee corner, its mug
 * saying when it is back. Each desk is the kit's `ActStation` (plan pips
 * as the bar under the monitor, the step's words on one board, alarms,
 * unread answers, suggestions, interns) and the door is the kit's
 * `YouSpots`. Typing, the terminal and the filing cabinet are the desk's
 * own (workers-diorama.tsx); everything here reads the act only.
 */

/**
 * Workers' tools per step kind. Typing (edit, write), the terminal (run)
 * and the filing cabinet (read, search) are the desk's, so only planning
 * puts something in a worker's hands.
 */
export const WORKER_TOOLS: Partial<
	Record<InterfaceActivityKind, VillagerTool>
> = {
	plan: "clipboard",
};

/** What a working worker's desk shows for its step. */
export type DeskActivity = "cabinet" | "terminal" | "typing" | null;

/** The desk's own activity for an act: typing, the terminal or the cabinet. */
export function deskActivity(act: InterfaceAgentAct): DeskActivity {
	if (act.act !== "working" || act.stalled) {
		return null;
	}
	switch (act.carry) {
		case "edit":
		case "write":
			return "typing";
		case "run":
			return "terminal";
		case "read":
		case "search":
			return "cabinet";
		default:
			return null;
	}
}

/** A folder is the office's deliverable. */
export const WORKERS_SKIN: ActSkin = {
	deliverable: { ...WORKERS_FOLDER, shape: "tablet" },
};

/** Room on the floor between rows: the lane a worker walks along. */
const LANE_Z = 1.5;
const COFFEE_SPOTS = 4;
/**
 * The door's queue runs along the front of the room and steps toward you,
 * so on screen each plate sits right of and lower than the one before (a
 * plate's speech bubble hangs up and right of it, clear of the next).
 */
const QUEUE_BACK = 1.75;
const SLOT_GAP = 1.7;
/** Small enough that the last slot (and the door) stay inside the room. */
const SLOT_STEP = 0.4;
/**
 * The door and the tray stand nearer the front than the queue, clear of
 * the front desk row's plates (the wall clock over the door shows).
 */
const DOOR_BACK = 0.95;
/** The tray and the door, past the last slot. */
const TRAY_OUT = 1.7;
const DOOR_OUT = 3.2;
/** Room kept between the queue's ends and the room's side walls. */
const QUEUE_LEFT = 1.2;
const DOOR_MARGIN = 0.9;
/** How far in front of your door the walkers' line passes. */
const DOOR_FRONT = 0.6;

/**
 * The door's queue slots, the inbox tray and the you-spot (the door), in
 * the world. A small room squeezes the queue's spacing so the door stays
 * inside its side wall.
 */
export function doorSpots(
	plan: OfficePlan,
	slab: number
): { slots: Vec3[]; tray: Vec3; you: Vec3 } {
	const z = plan.halfDepth - QUEUE_BACK;
	const left = -plan.halfWidth + QUEUE_LEFT;
	const room = 2 * plan.halfWidth - QUEUE_LEFT - DOOR_MARGIN;
	const fit = Math.min(1, room / (3 * SLOT_GAP + DOOR_OUT));
	const slots: Vec3[] = [0, 1, 2, 3].map((index) => [
		left + index * SLOT_GAP * fit,
		slab,
		z + index * SLOT_STEP,
	]);
	const last = slots[3] ?? [left, slab, z];
	const front = plan.halfDepth - DOOR_BACK;
	return {
		slots,
		tray: [last[0] + TRAY_OUT * fit, slab, front],
		you: [last[0] + DOOR_OUT * fit, slab, front],
	};
}

/** The coffee corner's standing spots (limited and idle workers). */
export function coffeeSpots(plan: OfficePlan, slab: number): Vec3[] {
	// In front of the counter's left end, clear of the room's right edge.
	return Array.from({ length: COFFEE_SPOTS }, (_, index) => [
		plan.coffee.x - 1.4 + index * 0.45,
		slab,
		plan.coffee.z + 0.9 + (index % 2) * 0.35,
	]);
}

/**
 * The workers' waypoints: each chair, a lane in front of its row, the
 * lanes joined by an aisle down the coffee strip (from the coffee corner
 * to the front), and the front to the door's queue and the inbox tray.
 */
export function officePaths(
	plan: OfficePlan,
	chairs: ReadonlyMap<string, Vec3>,
	slab: number
): LifePaths {
	const points: Record<string, Vec3> = {};
	const links: [string, string][] = [];
	const aisleX = plan.coffee.x;
	const rows = new Map<number, { id: string; chair: Vec3; z: number }[]>();
	for (const desk of plan.desks) {
		const chair = chairs.get(desk.worker.id);
		if (!chair) {
			continue;
		}
		const key = Math.round(desk.z * 100);
		rows.set(key, [
			...(rows.get(key) ?? []),
			{ chair, id: desk.worker.id, z: desk.z },
		]);
	}
	const rowKeys = [...rows.keys()].sort((a, b) => a - b);
	const coffee = coffeeSpots(plan, slab);
	points["aisle-top"] = [aisleX, slab, (coffee[0]?.[2] ?? 0) + 0.2];
	for (const [index, spot] of coffee.entries()) {
		points[`coffee-${index}`] = spot;
		links.push([`coffee-${index}`, "aisle-top"]);
	}
	let previousAisle = "aisle-top";
	for (const key of rowKeys) {
		const line = (rows.get(key) ?? []).sort((a, b) => a.chair[0] - b.chair[0]);
		const laneZ = (line[0]?.z ?? 0) + LANE_Z;
		const aisle = `aisle-${key}`;
		points[aisle] = [aisleX, slab, laneZ];
		links.push([previousAisle, aisle]);
		previousAisle = aisle;
		let previous: string | null = null;
		for (const desk of line) {
			const station = `desk-${desk.id}`;
			const lane = `lane-${desk.id}`;
			points[station] = desk.chair;
			points[lane] = [desk.chair[0], slab, laneZ];
			links.push([station, lane]);
			if (previous) {
				links.push([previous, lane]);
			}
			previous = lane;
		}
		if (previous) {
			links.push([previous, aisle]);
		}
	}
	const door = doorSpots(plan, slab);
	points.you = door.you;
	points["you-tray"] = door.tray;
	// Walkers pass in front of your door, never through it.
	points["aisle-front"] = [aisleX, slab, door.you[2] + DOOR_FRONT];
	points["door-front"] = [door.you[0], slab, door.you[2] + DOOR_FRONT];
	for (const [index, slot] of door.slots.entries()) {
		points[`you-${index + 1}`] = slot;
	}
	links.push(
		[previousAisle, "aisle-front"],
		["aisle-front", "door-front"],
		["door-front", "you"],
		["door-front", "you-tray"],
		["you-tray", "you-4"],
		["you-4", "you-3"],
		["you-3", "you-2"],
		["you-2", "you-1"]
	);
	return { links, points };
}

/**
 * Where a worker rests: the coffee corner when limited, or when idle with
 * nothing at all (no thread, nothing waiting); else its own chair.
 */
export function restsAtCoffee(act: InterfaceAgentAct): boolean {
	if (act.act === "limited") {
		return true;
	}
	const pending = act.pending;
	return (
		act.act === "idle" &&
		act.threadId === null &&
		pending.asks + pending.blocked + pending.old + pending.unread === 0 &&
		pending.suggestions === 0
	);
}

/** Which coffee-corner spot (a waypoint id) each resting worker takes. */
export function coffeeOf(
	plan: OfficePlan,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, string> {
	const coffee = new Map<string, string>();
	for (const desk of plan.desks) {
		const act = acts.get(desk.worker.id);
		if (act && restsAtCoffee(act) && coffee.size < COFFEE_SPOTS) {
			coffee.set(desk.worker.id, `coffee-${coffee.size}`);
		}
	}
	return coffee;
}

/**
 * An asking worker carries its laptop to the door, whatever it asks (an
 * approval keeps its seal colour on the lid).
 */
function withLaptop(act: InterfaceAgentAct, script: LifeScript): LifeScript {
	if (act.act !== "asking") {
		return script;
	}
	return {
		...script,
		steps: script.steps.map((step) =>
			step.do === "carry" && step.item
				? { ...step, item: { accent: step.item.accent, shape: "laptop" } }
				: step
		),
	};
}

/** A worker's life script for its act, in the office's places. */
export function workerLife(
	act: InterfaceAgentAct,
	{
		coffee,
		facing,
		paths,
		reduced,
		slot,
	}: {
		coffee: string | null;
		/** Facing at its desk while it works (its monitor). */
		facing: number;
		paths: LifePaths;
		reduced: boolean;
		slot: YouSpotSlot["point"] | null;
	}
): LifeScript {
	const station = coffee ?? `desk-${act.agentId}`;
	return withLaptop(
		act,
		actLife(
			act,
			{
				paths,
				rest: coffee ?? undefined,
				slot,
				station,
				stationFacing: act.act === "working" && !coffee ? facing : undefined,
			},
			WORKERS_SKIN,
			{ reduced }
		)
	);
}

/** The bubble a worker's name plate carries (asks, answers, waiting). */
export function plateBubble(act: InterfaceAgentAct): LifeBubble | null {
	if (
		act.act === "asking" ||
		act.act === "delivering" ||
		act.act === "waiting"
	) {
		return actBubble(act);
	}
	return null;
}

/**
 * What a worker's screen plate says: its step while it works ("Editing
 * snapshot.ts"), the reason it stopped, else what its screen is waiting
 * for (its name plate's bubble carries the ask or the answer itself).
 * Under redaction the act's own words are already kind words.
 */
export function screenActivity(act: InterfaceAgentAct): string {
	if (act.stalled) {
		return act.stalledFor ? `Stalled? ${act.stalledFor}` : "Stalled?";
	}
	switch (act.act) {
		case "working":
		case "blocked":
			return act.bubble?.text ?? "Working";
		case "asking":
			return "Asks you";
		case "delivering":
			return "Answer ready";
		case "limited":
			return "Usage limit hit";
		case "waiting":
			return "Waiting for a reply";
		default:
			return "Idle";
	}
}

/**
 * The office's words for a limit, on the coffee mug and the desk board:
 * "Back 15:10" (the kit adds "Likely " for an inferred limit), "On a
 * break" with no reset time.
 */
export const workerLimitText: LimitText = (_act, at) =>
	at ? `Back ${at}` : "On a break";

/** What the act props need to answer and open cards. */
export interface WorkersActHandlers {
	clock?: ClockOptions;
	iconOnly: boolean;
	nowMs: number;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	privacy: "full" | "redacted";
	reduced: boolean;
	shown: ReadonlySet<string>;
	snapshot: InterfaceSnapshot;
}

/** One desk's act props: the kit's ActStation, laid out in the desk's frame. */
export function WorkerDeskActs({
	act,
	at,
	handlers,
	layout,
}: {
	act: InterfaceAgentAct;
	/** The desk's centre on the floor. */
	at: Vec3;
	handlers: WorkersActHandlers;
	layout: Partial<StationLayout>;
}) {
	return (
		<ActStation
			act={act}
			at={at}
			clock={handlers.clock}
			iconOnly={handlers.iconOnly}
			layout={layout}
			limitText={workerLimitText}
			nowMs={handlers.nowMs}
			onAsk={handlers.onAsk}
			onBlocker={handlers.onBlocker}
			privacy={handlers.privacy}
			reduced={handlers.reduced}
			shown={handlers.shown}
			snapshot={handlers.snapshot}
		/>
	);
}

/** Folders in one row of the inbox tray; further rows pile on top. */
const INBOX_ROW = 3;

/** The door's you-spot layout: notices in the queue, folders in the tray. */
export function doorLayout(
	plan: OfficePlan,
	slab: number,
	trayTop: number
): YouSpotLayout {
	const door = doorSpots(plan, slab);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((slot, index) => [slot, door.slots[index] ?? door.you])
	) as Record<YouSlot, Vec3>;
	return {
		// Either side of the door, clear of the wall clock over it (inside
		// the side wall in a small room).
		offStage: [
			Math.min(door.you[0] + 1.0, plan.halfWidth - 0.4),
			slab + 2.2,
			door.you[2],
		],
		slots,
		tally: [door.you[0] - 0.95, slab + 2.2, door.you[2]],
		tray: [door.tray[0] - 0.2, trayTop, door.tray[2]],
		trayMax: INBOX_ROW,
		trayRowStep: [0, 0.1, 0],
		trayStep: [0.2, 0.03, 0],
	};
}

/**
 * The door's act props: the kit's YouSpots (a notice for each unowned or
 * parked ask, an hourglass beside each queued worker, the tallies, and a
 * folder in the inbox tray per unread answer, piling up in rows of three).
 */
export function WorkersDoorActs({
	handlers,
	layout,
	offStage,
	onStage,
	owners,
	slots,
}: {
	handlers: WorkersActHandlers;
	layout: YouSpotLayout;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
}) {
	return (
		<YouSpots
			iconOnly={handlers.iconOnly}
			item={WORKERS_SKIN.deliverable}
			layout={layout}
			nowMs={handlers.nowMs}
			offStage={offStage}
			onAsk={handlers.onAsk}
			onOpenQueue={handlers.onQueue}
			onStage={onStage}
			owners={owners}
			privacy={handlers.privacy}
			reduced={handlers.reduced}
			shown={handlers.shown}
			slots={slots}
			snapshot={handlers.snapshot}
		/>
	);
}
