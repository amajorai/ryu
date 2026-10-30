import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { STATION_LAYOUT, type StationLayout } from "./game3d-act-stage.tsx";
import { type OffStage, stageAgents } from "./game3d-acts.ts";
import type { LifeBubbleSide } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { tileToWorld } from "./warehouse-diorama.tsx";
import { AISLE_COUNT, aisleY, type Picker } from "./warehouse-model.ts";

/** The floor's slab top, where everything stands. */
export const SLAB = 0.12;
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
export const KIND_SHIFT: Record<string, number> = {
	read: -0.6,
	run: 0.5,
	search: -0.6,
	tool: 0.5,
	web: -0.6,
};
/** The aisle mouths on the cross walkway (tiles). */
export const MOUTH_X = 9.75;

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

/** A point by a station: `along` its aisle and `across` it, in tiles. */
export function stationTile(
	station: PickerStation,
	along: number,
	across: number,
	up = SLAB
): Vec3 {
	return tileToWorld(station.tile.x + along, station.tile.y + across, up);
}

/** Where a limited picker rests: on the forklift parked in its aisle. */
export function forkliftAt(station: PickerStation): Vec3 {
	return stationTile(station, -1.15, 0);
}
