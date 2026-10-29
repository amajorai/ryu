/* eslint-disable react/no-unknown-property */
import {
	blockerKindWord,
	type ClockOptions,
	type InterfaceActivityKind,
	type InterfaceAgentAct,
	type InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	ActStation,
	type LimitText,
	limitIsLikely,
	STATION_LAYOUT,
	type StationLayout,
	type YouSpotLayout,
	YouSpots,
} from "./game3d-act-stage.tsx";
import {
	type ActSkin,
	type ActSpots,
	actLife,
	blockerEntries,
	bubbleOverlayId,
	type OffStage,
	slotOf,
	stageAgents,
	toolForActivity,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import { apprenticeSpecs } from "./game3d-apprentice.tsx";
import {
	LIFE_FACE_CAMERA,
	type LifeBubbleSide,
	type LifePaths,
} from "./game3d-life.ts";
import { ToonMesh } from "./game3d-materials.tsx";
import { queuePlateText } from "./game3d-meters.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type {
	MemberLooks,
	VillagerSpec,
	VillagerTool,
} from "./game3d-villager.tsx";
import { tileToWorld } from "./warehouse-diorama.tsx";
import {
	AISLE_COUNT,
	aisleY,
	type OrderActs,
	type Picker,
	RACK,
	rackRowY,
} from "./warehouse-model.ts";
import { WAREHOUSE_ACT_ART } from "./warehouse-palette.ts";

/**
 * The Warehouse's act layer (spec §5, warehouse row): each picker has a
 * station in its aisle and walks to the shelves its step needs (reads at
 * the far shelves, runs by the aisle mouth: a route chosen by the step's
 * kind, never a hashed one); asks are carried on a clipboard to the
 * dispatch desk by the outbound dock and wait there in a queue; answers are
 * set down as labelled parcels on the desk, which ship once they are read.
 * A picker whose message is not picked up yet waits at intake.
 */

/** The floor's slab top, where everything stands. */
const SLAB = 0.12;
/**
 * A station's pieces by default (the kit's, with the progress pips, next
 * sign and limit clock kept in the picker's own stretch of the aisle); each
 * station's plan moves the words to its own open side.
 */
const PICKER_LAYOUT: StationLayout = {
	...STATION_LAYOUT,
	cue: [0, 0.02, 0],
	limit: [-0.9, 0, -0.25],
	next: [0.85, 0, -0.45],
	pips: [0.7, 0.05, 0.1],
};

/**
 * How one station is set out: its place along its aisle (tiles), the side
 * its picker's work bubble hangs, and where its pieces sit (world offsets
 * from the station, over `PICKER_LAYOUT`).
 */
interface StationPlan {
	bubble: LifeBubbleSide;
	layout?: Partial<StationLayout>;
	/** Over `layout` on a phone stage, where plates are icons and the zoom halves. */
	narrowLayout?: Partial<StationLayout>;
	x: number;
}

/**
 * The stations, by lane (two pickers share an aisle) and aisle. Each was
 * placed against its neighbours' plates, figures and words, measured on the
 * 1280 and 390 stages: no two pickers in neighbouring aisles share a screen
 * column, the two in an aisle stand at its opposite ends, and every
 * picker's bubble, board, alarms and tags hang on its own open side, where
 * no other picker stands (a bubble to the right climbs over the aisles
 * behind, so the pickers there stand toward the wall). Alarm plates hang
 * beside the figure on an explicit side, never over it and never past the
 * stage's left edge.
 */
const STATION_PLANS: readonly (readonly StationPlan[])[] = [
	[
		// The aisles' far (mouth) ends: these pickers are often queued at
		// dispatch, and the next two aisles' pickers stand toward the wall.
		{ bubble: "up", x: 8.3 },
		{ bubble: "up", x: 8.3 },
		{
			bubble: "right",
			// The words hang along the aisle on the open (mouth) side, clear of
			// the pickers in the aisles behind and in front.
			layout: { board: [3, -0.1, 0] },
			// On a phone, up beside its plate, clear of the dock's queue.
			narrowLayout: { board: [4.6, 3.55, 0] },
			x: 8.3,
		},
		{
			bubble: "right",
			// On the walkway in front, the plates dropping below its feet: the
			// pickers to either side keep their own columns.
			layout: {
				alarmRows: -1,
				alarmSide: "center",
				alarms: [1.2, 0, 2.45],
			},
			// On a phone the icons step a little further left of its figure.
			narrowLayout: { alarms: [0.9, 0, 2.8] },
			x: 6,
		},
		{
			bubble: "right",
			// On the rack behind, so its plate hangs over the picker's own
			// plate, apart from the next aisle's alarms.
			layout: { alarmSide: "center", alarms: [-1.9, 0, -1.4] },
			// On a phone the icon would sit on the figure: higher, over its own
			// plate, away from the next aisle's alarms.
			narrowLayout: { alarmSide: "center", alarms: [-2.3, 0, -2.1] },
			x: 3.5,
		},
		{
			bubble: "right",
			// Clear of the stage's left edge, even on a phone; the board to the
			// forklift's right.
			layout: { board: [0.3, 0, 0.6] },
			x: 4,
		},
	],
	[
		{ bubble: "right", x: 3.3 },
		{
			bubble: "left",
			layout: { suggestion: [0, 1.8, 0] },
			// On a phone its note hangs beside its figure, not on its plate.
			narrowLayout: { suggestion: [0.9, 0.6, -0.9] },
			x: 2.6,
		},
		{
			bubble: "up",
			// The words (an estimate's "~") beside its figure, toward its aisle.
			layout: { board: [1.06, 1.2, 0] },
			// On a phone its words stay under its feet, clear of its plate (its
			// bubble stays up: on the left it would push the plate on stage).
			narrowLayout: { board: [0.8, 0, 0.8] },
			x: 1.9,
		},
		// The unread mark over its own plate, in its own column.
		{ bubble: "right", layout: { unread: [0, 1.8, 0] }, x: 8.3 },
		// The front two aisles hold one picker each: their second places
		// would stand in the next aisle's alarm stack, so a crowd's 11th
		// picker on waits on the off-floor tally instead.
	],
];

function stationPlan(lane: number, aisle: number): StationPlan {
	return STATION_PLANS[lane]?.[aisle] ?? { bubble: "auto", x: 6.6 };
}

/**
 * Stations on the floor: two lanes in the back four aisles, one in the
 * front two (in `buildPickers` order, the first `PICKER_STATIONS` pickers
 * each get one). More pickers are tallied.
 */
export const PICKER_STATIONS = STATION_PLANS.reduce(
	(sum, lane) => sum + lane.length,
	0
);
/** Where in its aisle a working picker stands, by its step's kind (tiles). */
const KIND_SHIFT: Record<string, number> = {
	read: -0.6,
	run: 0.5,
	search: -0.6,
	tool: 0.5,
	web: -0.6,
};
/** The aisle mouths on the cross walkway (tiles). */
const MOUTH_X = 9.75;

/** Where a picker works: its aisle and lane. */
export interface PickerStation {
	agentId: string;
	aisle: number;
	at: Vec3;
	/** The side its picker's work bubble hangs. */
	bubble: LifeBubbleSide;
	id: string;
	/** Where its pieces sit, over `PICKER_LAYOUT`. */
	layout: StationLayout;
	/** Where they sit on a phone stage. */
	narrowLayout: StationLayout;
	/** The tile point of the station. */
	tile: { x: number; y: number };
}

/**
 * One station per picker, in the aisle `buildPickers` gave it, for the
 * first `PICKER_STATIONS` pickers (the rest are off the floor, tallied).
 */
export function pickerStations(pickers: readonly Picker[]): PickerStation[] {
	return pickers.slice(0, PICKER_STATIONS).map((picker, index) => {
		const lane = Math.floor(index / AISLE_COUNT);
		const plan = stationPlan(lane, picker.aisle);
		const x = plan.x;
		const y = aisleY(picker.aisle);
		return {
			agentId: picker.agent.id,
			aisle: picker.aisle,
			at: tileToWorld(x, y, SLAB),
			bubble: plan.bubble,
			id: `picker:${picker.agent.id}`,
			layout: { ...PICKER_LAYOUT, ...plan.layout },
			narrowLayout: {
				...PICKER_LAYOUT,
				...plan.layout,
				...plan.narrowLayout,
			},
			tile: { x, y },
		};
	});
}

/**
 * Who is on the floor: the agents with a station (the first
 * `PICKER_STATIONS`, as `buildPickers` assigns aisles), and a tally of the
 * rest (their acts and blocking asks), which the off-stage plate opens.
 */
export function floorAgents(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	agentIds: readonly string[]
): { offStage: OffStage; onStage: InterfaceAgentAct[] } {
	const floor = new Set(agentIds.slice(0, PICKER_STATIONS));
	const onStage: InterfaceAgentAct[] = [];
	const offStage: OffStage = { asks: 0, byAct: {}, count: 0 };
	for (const act of acts.values()) {
		if (floor.has(act.agentId)) {
			onStage.push(act);
			continue;
		}
		offStage.count += 1;
		offStage.byAct[act.act] = (offStage.byAct[act.act] ?? 0) + 1;
		offStage.asks += (act.ask?.blocking ? 1 : 0) + act.parkedAsks.length;
	}
	// The floor's pickers most urgent first (the kit's stage order), so the
	// overlay budget keeps their words before the calmer pickers'.
	const ordered = stageAgents(
		new Map(onStage.map((act) => [act.agentId, act])),
		onStage.length
	).onStage;
	return { offStage, onStage: ordered };
}

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

/** A point by a station: `along` its aisle and `across` it, in tiles. */
export function stationTile(
	station: PickerStation,
	along: number,
	across: number,
	up = SLAB
): Vec3 {
	return tileToWorld(station.tile.x + along, station.tile.y + across, up);
}

/**
 * The dispatch queue out on the yard by the outbound dock, in slot order
 * from the front: "you-1" by the dock wall, clear above the trailer, "you-2"
 * and "you-3" a plate's width and more to its right along the same row, and
 * "you-4" a row behind, so no two places share a screen column and each
 * queued picker's ask (`QUEUE_BUBBLE`) clears the plates beside it.
 */
const QUEUE_TILES = [
	{ x: 16.3, y: 5.7 },
	{ x: 17.8, y: 3.5 },
	{ x: 20.8, y: 0 },
	{ x: 17.1, y: -1.9 },
] as const;

/**
 * The queue on a phone, where a plate is several tiles wide and the yard
 * alone would stack the places in one column: from the front, "you-1" on
 * the apron before the dock, "you-2" in the dock door, "you-3" up the yard
 * above the trailer, "you-4" on the apron before the truck: each in its own
 * screen column (at least 1.7 tiles of x − y apart), "you-4" off "you-2"'s
 * row, every figure clear of the trailer.
 */
const NARROW_QUEUE_TILES = [
	{ x: 18.2, y: 13.4 },
	{ x: 15.3, y: 8.7 },
	{ x: 18.4, y: 3.6 },
	{ x: 21.2, y: 12.6 },
] as const;

/**
 * Where a queued picker's ask hangs, measured with every place filled (a
 * notice's pallets stand under its plate): straight up, between the plates
 * of the places behind and the asks in front, clear of the floor's pickers
 * (to the side, the front ask would read as theirs, or hang across the
 * pallets of the place behind).
 */
const QUEUE_BUBBLE: Record<YouSlot, LifeBubbleSide> = {
	"you-1": "up",
	"you-2": "up",
	"you-3": "up",
	"you-4": "up",
};

function queueTile(index: number, narrow: boolean): { x: number; y: number } {
	const tiles = narrow ? NARROW_QUEUE_TILES : QUEUE_TILES;
	return tiles[index] ?? tiles[0];
}

/**
 * The you-spot at the dispatch desk: "you" by the dock, the queue
 * "you-1".."you-4" on the yard, and "you-tray" at the dispatch desk.
 */
export function youTiles(
	narrow = false
): Record<string, { x: number; y: number }> {
	return {
		dock: { x: 15.6, y: 7.6 },
		walk: { x: 11.5, y: 7.6 },
		you: { x: 16.2, y: 7.4 },
		"you-1": queueTile(0, narrow),
		"you-2": queueTile(1, narrow),
		"you-3": queueTile(2, narrow),
		"you-4": queueTile(3, narrow),
		"you-tray": { x: 20.4, y: 7.9 },
	};
}

/** The dispatch desk the tray sits on (tiles). */
export const DISPATCH_DESK = { x: 21, y: 7.1 } as const;

export function youPoints(narrow = false): Record<string, Vec3> {
	return Object.fromEntries(
		Object.entries(youTiles(narrow)).map(([id, tile]) => [
			id,
			tileToWorld(tile.x, tile.y, SLAB),
		])
	);
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

const SKIN: ActSkin = {
	deliverable: {
		accent: WAREHOUSE_ACT_ART.parcelTape,
		color: WAREHOUSE_ACT_ART.parcel,
		shape: "box",
	},
};

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

/**
 * The limit in the warehouse's words, on the forklift's board: "Back 15:10",
 * "Parked for now" with no reset time. An inferred limit reads "Likely back
 * 15:10" (the kit adds "Likely ").
 */
export const forkliftLimit: LimitText = (act, clearsAt) => {
	const words = clearsAt ? `back ${clearsAt}` : "parked for now";
	return limitIsLikely(act)
		? words
		: `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** The basket's items as progress pips: picked, still to pick, a guess. */
const BASKET_PIPS = {
	done: WAREHOUSE_ACT_ART.pipDone,
	estimate: WAREHOUSE_ACT_ART.pipEstimate,
	todo: WAREHOUSE_ACT_ART.pipTodo,
} as const;

/** Where a limited picker rests: on the forklift parked in its aisle. */
function forkliftAt(station: PickerStation): Vec3 {
	return stationTile(station, -1.15, 0);
}

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

/** The dispatch desk by the dock, where answers are set down. */
function DispatchDesk() {
	const at = tileToWorld(DISPATCH_DESK.x, DISPATCH_DESK.y, SLAB);
	return (
		<group position={at}>
			<ToonMesh
				castShadow
				color={WAREHOUSE_ACT_ART.desk}
				ink={0.02}
				position={[0, 0.3, 0]}
				scale={[1.2, 0.6, 0.5]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={WAREHOUSE_ACT_ART.deskTop}
				ink={0.015}
				position={[0, 0.63, 0]}
				scale={[1.3, 0.06, 0.6]}
			>
				<boxGeometry />
			</ToonMesh>
		</group>
	);
}

/** A small forklift, where a limited picker sits out its limit. */
function Forklift({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, Math.PI / 2, 0]}>
			<ToonMesh
				castShadow
				color={WAREHOUSE_ACT_ART.forklift}
				ink={0.02}
				position={[0, 0.2, 0]}
				scale={[0.5, 0.26, 0.7]}
			>
				<boxGeometry />
			</ToonMesh>
			<ToonMesh
				color={WAREHOUSE_ACT_ART.forkliftMast}
				ink={0.015}
				position={[0, 0.55, 0.36]}
				scale={[0.42, 0.7, 0.05]}
			>
				<boxGeometry />
			</ToonMesh>
			{[-0.12, 0.12].map((x) => (
				<ToonMesh
					color={WAREHOUSE_ACT_ART.forkliftMast}
					key={x}
					position={[x, 0.06, 0.6]}
					scale={[0.06, 0.03, 0.42]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
		</group>
	);
}

/** How high a notice's pallet stack stands (world units). */
const NOTICE_LIFT = 0.8;

function lifted([x, y, z]: Vec3): Vec3 {
	return [x, y + NOTICE_LIFT, z];
}

/** The pallets a queue notice stands on, `NOTICE_LIFT` tall. */
function NoticePallets({ at }: { at: Vec3 }) {
	const [x, y, z] = at;
	return (
		<group position={[x, y, z]}>
			{[0, 1, 2].map((level) => (
				<ToonMesh
					castShadow={level === 0}
					color={
						level % 2 === 0
							? WAREHOUSE_ACT_ART.pallet
							: WAREHOUSE_ACT_ART.parcel
					}
					ink={0.015}
					key={level}
					position={[0, NOTICE_LIFT * ((level + 0.5) / 3), 0]}
					scale={[0.7, NOTICE_LIFT / 3, 0.6]}
				>
					<boxGeometry />
				</ToonMesh>
			))}
		</group>
	);
}

export function dispatchLayout(narrow = false): YouSpotLayout {
	const points = youPoints(narrow);
	const at = (id: string) => points[id] ?? [0, 0, 0];
	const desk = tileToWorld(DISPATCH_DESK.x, DISPATCH_DESK.y, SLAB);
	return {
		// Out on the yard beside the dispatch desk, clear of the tray, the
		// queue and the truck; on a phone, where the queue fills the dock,
		// outside the floor's open front, in a column of its own.
		offStage: narrow ? tileToWorld(11.5, 14.8, 0.7) : tileToWorld(21, 4.6, 0.7),
		// A notice is pinned on a pallet stack, so its plate rides at a
		// queued picker's head height and the rows keep apart.
		slots: {
			"you-1": lifted(at("you-1")),
			"you-2": lifted(at("you-2")),
			"you-3": lifted(at("you-3")),
			"you-4": lifted(at("you-4")),
		},
		// Past the queue's back places.
		tally: narrow ? tileToWorld(18.2, 1.2, 0.7) : tileToWorld(20.6, 2.4, 0.7),
		timer: [0.45, 0, 0.2],
		tray: [desk[0] - 0.3, desk[1] + 0.66, desk[2]],
		trayStep: [0.5, 0, 0],
	};
}

export interface WarehouseActPropsInput {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	clock?: ClockOptions;
	iconOnly: boolean;
	/** A phone stage: the queue's narrow places. */
	narrow: boolean;
	nowMs: number;
	offStage: OffStage;
	onAsk: (askId: string) => void;
	onBlocker: (threadId: string, agentName: string) => void;
	onQueue: () => void;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	reduced: boolean;
	shown: ReadonlySet<string>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	snapshot: InterfaceSnapshot;
	stations: readonly PickerStation[];
}

/** The act props: the dispatch queue and desk, and each station's cues. */
export function WarehouseActProps({
	acts,
	clock,
	iconOnly,
	narrow,
	nowMs,
	offStage,
	onAsk,
	onBlocker,
	onQueue,
	onStage,
	owners,
	reduced,
	shown,
	slots,
	snapshot,
	stations,
}: WarehouseActPropsInput) {
	const privacy = snapshot.privacy ?? "full";
	return (
		<group>
			<DispatchDesk />
			{slots.slots
				.filter((slot) => slot.carrier === "notice")
				.map((slot) => {
					const at = youPoints(narrow)[slot.point];
					return at ? <NoticePallets at={at} key={slot.ask.id} /> : null;
				})}
			<YouSpots
				iconOnly={iconOnly}
				item={SKIN.deliverable}
				layout={dispatchLayout(narrow)}
				nowMs={nowMs}
				offStage={offStage}
				onAsk={onAsk}
				onOpenQueue={onQueue}
				onStage={onStage}
				owners={owners}
				privacy={privacy}
				reduced={reduced}
				shown={shown}
				slots={slots}
				snapshot={snapshot}
				timerSkin={{ color: WAREHOUSE_ACT_ART.timer }}
			/>
			{stations.map((station) => {
				const act = acts.get(station.agentId);
				if (!act) {
					return null;
				}
				return (
					<group key={station.id}>
						{act.act === "limited" ? (
							<Forklift at={forkliftAt(station)} />
						) : null}
						<ActStation
							act={act}
							at={station.at}
							clock={clock}
							iconOnly={iconOnly}
							layout={narrow ? station.narrowLayout : station.layout}
							limitText={forkliftLimit}
							nowMs={nowMs}
							onAsk={onAsk}
							onBlocker={onBlocker}
							pipSkin={BASKET_PIPS}
							privacy={privacy}
							reduced={reduced}
							shown={shown}
							snapshot={snapshot}
						/>
					</group>
				);
			})}
		</group>
	);
}
