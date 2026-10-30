import {
	blockerKindWord,
	type InterfaceActivityKind,
	type InterfaceAgentAct,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	type ActSpots,
	actLife,
	blockerEntries,
	bubbleOverlayId,
	slotOf,
	toolForActivity,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import {
	LIFE_FACE_CAMERA,
	type LifeBubbleSide,
	type LifePaths,
} from "./game3d-life.ts";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import { SKIN } from "./warehouse-acts-props.tsx";
import { QUEUE_BUBBLE, youPoints } from "./warehouse-acts-queue.ts";
import {
	forkliftAt,
	KIND_SHIFT,
	MOUTH_X,
	type PickerStation,
	SLAB,
	stationTile,
} from "./warehouse-acts-stations.ts";
import { tileToWorld } from "./warehouse-diorama.tsx";
import {
	AISLE_COUNT,
	aisleY,
	type OrderActs,
	RACK,
	rackRowY,
} from "./warehouse-model.ts";

export {
	dispatchLayout,
	forkliftLimit,
	WarehouseActProps,
	type WarehouseActPropsInput,
} from "./warehouse-acts-props.tsx";
export {
	DISPATCH_DESK,
	youPoints,
	youTiles,
} from "./warehouse-acts-queue.ts";
export {
	floorAgents,
	PICKER_STATIONS,
	type PickerStation,
	pickerStations,
	stationTile,
} from "./warehouse-acts-stations.ts";

/**
 * The Warehouse's act layer (spec §5, warehouse row): each picker has a
 * station in its aisle and walks to the shelves its step needs (reads at
 * the far shelves, runs by the aisle mouth: a route chosen by the step's
 * kind, never a hashed one); asks are carried on a clipboard to the
 * dispatch desk by the outbound dock and wait there in a queue; answers are
 * set down as labelled parcels on the desk, which ship once they are read.
 * A picker whose message is not picked up yet waits at intake.
 */

/**
 * Where a shelf label hangs (tiles along the aisle, world units up), off
 * the rack behind the station: where the picker's work bubble would hang,
 * on the station's open side, above its plate and clear of its figure.
 */
const SHELF_LIFT: Record<LifeBubbleSide, readonly [number, number]> = {
	auto: [2.05, 3.1],
	left: [-3.55, 1.1],
	right: [2.05, 3.1],
	up: [-0.75, 2.65],
};

/** A working picker's shelf label: what it is at, on the rack behind it. */
export interface ShelfLabel {
	at: Vec3;
	id: string;
	target: string;
}

/**
 * The shelf labels: each working (not stalled) picker's `activity.target`,
 * on the rack just behind its own station, so a label never reads as the
 * other picker's in a shared aisle. A picker whose work bubble is up
 * (`shown`) already says it there, so its shelf stays bare.
 */
export function shelfLabels(
	stations: readonly PickerStation[],
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	threads: InterfaceSnapshot["threads"],
	shown: ReadonlySet<string>
): ShelfLabel[] {
	const labels: ShelfLabel[] = [];
	for (const station of stations) {
		const act = acts.get(station.agentId);
		if (
			act?.act !== "working" ||
			act.stalled ||
			shown.has(`work:${act.agentId}`)
		) {
			continue;
		}
		const target = threads.find((thread) => thread.id === act.threadId)
			?.activity?.target;
		if (!target) {
			continue;
		}
		const rack = rackRowY(station.aisle) + RACK.depth / 2;
		const [along, up] = SHELF_LIFT[station.bubble];
		labels.push({
			at: stationTile(station, along, rack - station.tile.y, up),
			id: station.id,
			target,
		});
	}
	return labels;
}

/** The overlay budget's id for the returns cage's reason tag. */
export const CAGE_REASON_ID = "cage:reason";

/**
 * The reason tag by the returns cage's red light: the newest stop's words
 * as its alarm plate words them (the kind's word when redacted, "Likely …"
 * for an estimate), or null with no stop, and when the overlay budget left
 * it out (`shown` lacks `CAGE_REASON_ID`) or plates are icons
 * (`iconOnly`, a phone stage).
 */
export function cageReason(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	{ iconOnly, shown }: { iconOnly: boolean; shown: ReadonlySet<string> }
): string | null {
	const blocker = blockerEntries(snapshot, acts)[0]?.blocker;
	if (!blocker || iconOnly || !shown.has(CAGE_REASON_ID)) {
		return null;
	}
	const words =
		snapshot.privacy === "redacted"
			? blockerKindWord(blocker.kind)
			: blocker.title;
	return blocker.source === "estimate" ? `Likely ${words}` : words;
}

/** What the act layer says about each thread, for its order's stage. */
export function orderActs(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): OrderActs {
	const asked = new Set<string>();
	const held = new Set<string>();
	const limited = new Set<string>();
	for (const act of acts.values()) {
		if (!act.threadId || act.act === "idle" || act.act === "delivering") {
			continue;
		}
		if (act.act === "asking") {
			asked.add(act.threadId);
		} else if (act.act === "limited") {
			limited.add(act.threadId);
		} else {
			held.add(act.threadId);
		}
	}
	// Only what waits on you: a blocking ask (an unread reply is "ready"
	// by its own unread count); suggestions and async questions are not.
	for (const ask of snapshot.asks ?? []) {
		if (ask.threadId && ask.blocking) {
			asked.add(ask.threadId);
		}
	}
	return {
		asked,
		held,
		limited,
		stopped: new Set(
			blockerEntries(snapshot, acts).map((entry) => entry.threadId)
		),
	};
}

/** Where intake is: a picker whose message is not picked up waits here. */
function intakeTile(index: number): { x: number; y: number } {
	// Two rows of six, one spot per station, so waiting pickers never stack.
	return { x: 10.4 + (index % 6) * 0.75, y: 2.3 + Math.floor(index / 6) * 0.8 };
}

export function warehouseActPaths(
	stations: readonly PickerStation[],
	/** A phone stage: the queue's narrow places. */
	narrow = false
): LifePaths {
	const points: Record<string, Vec3> = { ...youPoints(narrow) };
	const links: [string, string][] = [
		["you", "you-1"],
		["you", "you-2"],
		["you", "you-3"],
		["you", "you-4"],
		["you", "you-tray"],
		["walk", "dock"],
		["dock", "you"],
	];
	for (let aisle = 0; aisle < AISLE_COUNT; aisle++) {
		points[`mouth-${aisle}`] = tileToWorld(MOUTH_X, aisleY(aisle), SLAB);
		if (aisle > 0) {
			links.push([`mouth-${aisle - 1}`, `mouth-${aisle}`]);
		}
	}
	links.push(["mouth-3", "walk"], ["mouth-2", "walk"], ["mouth-0", "intake"]);
	points.intake = tileToWorld(MOUTH_X + 0.6, 2.5, SLAB);
	for (const [index, station] of stations.entries()) {
		points[station.id] = station.at;
		links.push([station.id, `mouth-${station.aisle}`]);
		for (const [kind, shift] of Object.entries(KIND_SHIFT)) {
			const spot = `${station.id}:${kind}`;
			points[spot] = stationTile(station, shift, 0);
			links.push([station.id, spot]);
		}
		const forklift = `${station.id}:forklift`;
		points[forklift] = forkliftAt(station);
		links.push([station.id, forklift]);
		const intake = `${station.id}:intake`;
		const tile = intakeTile(index);
		points[intake] = tileToWorld(tile.x, tile.y, SLAB);
		links.push(["intake", intake]);
	}
	return { links, points };
}

/** Where a picker's act plays out: its kind's shelf, intake, or its station. */
function placeFor(act: InterfaceAgentAct, station: PickerStation): string {
	if (act.act === "waiting") {
		return `${station.id}:intake`;
	}
	if (act.act === "limited") {
		return `${station.id}:forklift`;
	}
	if (act.act === "working" && !act.stalled && act.carry) {
		return act.carry in KIND_SHIFT ? `${station.id}:${act.carry}` : station.id;
	}
	return station.id;
}

/**
 * What a picker holds for its step: a basket for picking (reading and
 * searching the shelves), a clipboard for planning and handing work on,
 * a quill to write up, a wrench to run the machines.
 */
export const WAREHOUSE_TOOLS: Partial<
	Record<InterfaceActivityKind, VillagerTool>
> = {
	delegate: "clipboard",
	edit: "quill",
	plan: "clipboard",
	read: "basket",
	run: "wrench",
	search: "basket",
	think: "clipboard",
	tool: "wrench",
	web: "globe",
	write: "quill",
};

/** The pickers as act villagers (plus their helpers). */
export function actPickers({
	acts,
	looks,
	nowMs,
	onAsk,
	paths,
	reduced,
	shown,
	slots,
	stations,
}: {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	looks: ReadonlyMap<string, MemberLooks>;
	nowMs: number;
	onAsk: (askId: string) => void;
	paths: LifePaths;
	reduced: boolean;
	shown: ReadonlySet<string>;
	slots: readonly YouSpotSlot[];
	stations: readonly PickerStation[];
}): VillagerSpec[] {
	const cast: VillagerSpec[] = [];
	for (const station of stations) {
		const act = acts.get(station.agentId);
		const look = looks.get(station.agentId);
		if (!(act && look)) {
			continue;
		}
		const spots: ActSpots = {
			paths,
			slot: slotOf(slots, act.agentId),
			station: placeFor(act, station),
			stationFacing: LIFE_FACE_CAMERA,
		};
		const asking = act.act === "asking" && act.ask ? act.ask : null;
		const bubbleId = bubbleOverlayId(act);
		cast.push({
			actAgent: act.agentId,
			activate: asking ? () => onAsk(asking.id) : undefined,
			bubble: bubbleId ? shown.has(bubbleId) : true,
			// Queued, its ask hangs back toward the dock, clear of the places
			// behind it; on the floor, on its station's open side.
			// Queued, its ask hangs by its place (`QUEUE_BUBBLE`); on the
			// floor, on its station's open side.
			bubbleSide:
				asking && spots.slot ? QUEUE_BUBBLE[spots.slot] : station.bubble,
			iconOnly: asking && spots.slot ? false : undefined,
			id: act.agentId,
			label: asking
				? `${act.ariaLabel} Answer their ask.`
				: `${act.ariaLabel} Show their orders.`,
			life: actLife(act, spots, SKIN, { reduced }),
			looks: {
				...look,
				accessory: "cap",
				tool:
					act.act === "working"
						? toolForActivity(act.carry, WAREHOUSE_TOOLS)
						: undefined,
			},
			name: asking
				? queuePlateText(
						act.agentName,
						{
							approx: asking.sinceApprox,
							since: asking.since,
							until: asking.expiresAt ?? null,
							untilApprox: asking.expiresApprox,
						},
						nowMs
					)
				: act.agentName,
			pose: "idle",
			position: station.at,
			youSpot: asking && spots.slot ? "slot" : undefined,
		});
		cast.push(
			...apprenticeSpecs({
				agentId: act.agentId,
				helpers: act.helpers,
				looks: { ...look, accessory: "cap" },
				station: station.at,
			})
		);
	}
	return cast;
}
