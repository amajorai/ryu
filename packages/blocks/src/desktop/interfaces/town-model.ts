import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { blockLots } from "./town-model-build.ts";
import { hashId } from "./town-palette.ts";

export {
	agentSchedule,
	blockCells,
	buildingFor,
	buildTown,
	MAX_DISTRICTS,
	roadLines,
} from "./town-model-build.ts";

export {
	ACTIVITY_FULL,
	actHappiness,
	activityWeight,
	HEAT_STEPS,
	happiness,
	heatLevels,
	NEEDS_FLOOR,
	needsLevel,
} from "./town-model-mood.ts";
export {
	buildingLabel,
	buildingName,
	buildingWord,
	districtSummary,
	eventWhen,
	formatFunds,
	ISLAND_MARGIN,
	spokenAge,
	townFrame,
	upcomingRuns,
} from "./town-model-words.ts";

/**
 * Town view model (pure): the snapshot laid out as a small city. Districts
 * are projects and teams (agents in neither live in Old Town); every agent
 * is one building in its district, sized by how much it has to do; the
 * conversations waiting on you are petitions at City Hall in the centre.
 * Everything here is deterministic for a snapshot and a clock, so the
 * scene, the DOM layer and the tests agree on where things are.
 */

export const OLD_TOWN_ID = "old-town";
/** The display name of the district for agents in no project or team. */
export function oldTownName(): string {
	return tr("Old Town");
}

/** World units: one lot, the sidewalk ring around a block, the road. */
export const LOT = 2.3;
export const SIDEWALK = 0.55;
export const ROAD = 1.5;
/** Height of one storey. */
export const FLOOR_HEIGHT = 0.5;

export type BuildingKind = "cottage" | "shop" | "tower";

export const BUILDING_NAMES: Record<BuildingKind, string> = {
	get cottage() {
		return tr("Cottage");
	},
	get shop() {
		return tr("Shop");
	},
	get tower() {
		return tr("Office tower");
	},
};

export interface TownLot {
	/** Lot column and row inside its block. */
	col: number;
	row: number;
	x: number;
	z: number;
}

export interface TownBuilding {
	agent: InterfaceAgent;
	/**
	 * With acts, the beacon's tone for the focus counted blocker: red (lamp
	 * and smoke), a crossed calendar (a schedule failed) or grey bunting
	 * (interrupted). Without it a lit `alert` is today's red beacon.
	 */
	alarm?: "calendar" | "grey" | "red";
	/** A failed or interrupted run is waiting: beacon and smoke. */
	alert: boolean;
	/** With acts, one of its counted blockers is a failed schedule. */
	calendar?: boolean;
	counts: Record<ThreadStatus, number>;
	districtId: string;
	floors: number;
	kind: BuildingKind;
	lot: TownLot;
	messages: number;
	/** The agent replied and the conversation waits on you: a bubble. */
	replied: boolean;
	/** The agent's conversations, most urgent first. */
	threads: InterfaceThread[];
	/** A run is live: crane, lit windows, traffic. */
	working: boolean;
}

/** A house that fills a lot as its district grows (not an agent). */
export interface TownFiller {
	floors: number;
	id: string;
	kind: "house" | "terrace";
	lot: TownLot;
}

export interface TownDistrict {
	/**
	 * 0 to 1: recent and live conversations, stepped across the visible
	 * districts (see `heatLevels`) so the activity view separates them.
	 */
	activity: number;
	attention: number;
	buildings: TownBuilding[];
	cell: { col: number; row: number };
	emptyLots: TownLot[];
	fillers: TownFiller[];
	id: string;
	kind: "old-town" | "project" | "team";
	name: string;
	/** 0 to 1 against the district with most waiting on you. */
	needs: number;
	petitions: number;
	threads: InterfaceThread[];
	/** Index into the palette's district tints, unique among the districts. */
	tint: number;
	working: number;
	x: number;
	z: number;
}

/**
 * An unused block: a park with a pond, a grove of trees, or a few homes,
 * turned by its place on the map so no two neighbours look alike.
 */
export interface TownPark {
	homes: TownFiller[];
	id: string;
	/** The pond's centre, when the park has one. */
	pond: { x: number; z: number } | null;
	variant: "grove" | "homes" | "pond";
	x: number;
	z: number;
}

/** Ground tints a palette offers for districts (see `districtTints`). */
export const DISTRICT_TINT_COUNT = 6;
/** Old Town always keeps the warm tint. */
export const OLD_TOWN_TINT = 1;
/** The order the other districts take tints in, most distinct first. */
const TINT_ORDER = [2, 3, 4, 0, 5] as const;

/**
 * A tint for every district: Old Town keeps its own, the others take the
 * rest in order of id, so the same snapshot always paints the same way and
 * no two districts share a colour until the tints run out.
 */
export function districtTints(ids: string[]): Map<string, number> {
	const tints = new Map<string, number>();
	const others = ids.filter((id) => id !== OLD_TOWN_ID).sort();
	for (const [index, id] of others.entries()) {
		tints.set(id, TINT_ORDER[index % TINT_ORDER.length] ?? 0);
	}
	if (ids.includes(OLD_TOWN_ID)) {
		tints.set(OLD_TOWN_ID, OLD_TOWN_TINT);
	}
	return tints;
}

const PARK_VARIANTS: TownPark["variant"][] = ["homes", "pond", "grove"];
/** Where a pond sits in its park: a different corner each time. */
const POND_CORNERS = [
	[-1, 1],
	[1, -1],
	[1, 1],
	[-1, -1],
] as const;

/** The parks on the blocks no district uses, varied by their place. */
export function townParks(
	cells: { col: number; row: number }[],
	pitch: number,
	lots: number
): TownPark[] {
	const inner = lots * LOT;
	return cells.map((cell, index) => {
		const id = `park:${cell.col}:${cell.row}`;
		const x = cell.col * pitch;
		const z = cell.row * pitch;
		const variant = PARK_VARIANTS[index % PARK_VARIANTS.length] ?? "grove";
		let pond: TownPark["pond"] = null;
		if (variant === "pond") {
			const corner =
				POND_CORNERS[Math.floor(index / PARK_VARIANTS.length) % 4] ??
				POND_CORNERS[0];
			const reach = inner / 2 - 1.35;
			pond = { x: x + corner[0] * reach, z: z + corner[1] * reach };
		}
		const homes: TownFiller[] = [];
		if (variant === "homes") {
			for (const [slot, lot] of blockLots(lots, x, z).entries()) {
				const homeId = `${id}:${slot}`;
				const hash = hashId(homeId);
				if (hash % 5 >= 3) {
					continue;
				}
				homes.push({
					floors: 1 + (hash % 2),
					id: homeId,
					kind: hash % 4 === 0 ? "terrace" : "house",
					lot,
				});
			}
		}
		return { homes, id, pond, variant, x, z };
	});
}

export interface TownPetition {
	agent: InterfaceAgent | undefined;
	districtId: string;
	districtName: string;
	status: "attention" | "your-turn";
	thread: InterfaceThread;
}

export interface TownStats {
	attention: number;
	/** 0 to 100: falls as conversations wait on you and runs fail. */
	happiness: number;
	messages: number;
	population: number;
	/** Agents with a live run. */
	working: number;
	yourTurn: number;
}

export interface TownGrid {
	/** Blocks per side (3 or 5). */
	blocks: number;
	/** Inner size of a block (lots only). */
	inner: number;
	/** Lots per block side. */
	lots: number;
	/** Distance between block centres. */
	pitch: number;
	/** Outer edge of the roads, from the centre. */
	reach: number;
}

export interface Town {
	buildings: TownBuilding[];
	/** Cars on the roads: more agents at work, more traffic. */
	cars: number;
	districts: TownDistrict[];
	grid: TownGrid;
	parks: TownPark[];
	petitions: TownPetition[];
	stats: TownStats;
}

export const EMPTY_COUNTS = (): Record<ThreadStatus, number> => ({
	attention: 0,
	quiet: 0,
	waiting: 0,
	working: 0,
	"your-turn": 0,
});

export function byUrgency(a: InterfaceThread, b: InterfaceThread): number {
	return (
		THREAD_STATUS_ORDER.indexOf(threadStatus(a)) -
			THREAD_STATUS_ORDER.indexOf(threadStatus(b)) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

/** Building type from how many conversations the agent has. */
export function buildingKind(threadCount: number): BuildingKind {
	if (threadCount >= 3) {
		return "tower";
	}
	if (threadCount === 2) {
		return "shop";
	}
	return "cottage";
}

/** Storeys from the type and how much has been said. */
export function buildingFloors(kind: BuildingKind, messages: number): number {
	if (kind === "tower") {
		return 4 + Math.min(4, Math.floor(messages / 10));
	}
	if (kind === "shop") {
		return messages >= 15 ? 3 : 2;
	}
	return messages >= 6 ? 2 : 1;
}

/**
 * The district an agent lives in: the project or team where most of its
 * conversations are, projects before teams on a tie; Old Town otherwise.
 */
export function homeDistrict(
	agentId: string,
	groups: InterfaceGroup[],
	threads: InterfaceThread[]
): string {
	let best: { count: number; id: string; rank: number } | null = null;
	for (const [index, group] of groups.entries()) {
		if (!group.memberAgentIds.includes(agentId)) {
			continue;
		}
		const count = threads.filter(
			(thread) =>
				thread.agentIds.includes(agentId) &&
				(thread.projectId === group.id || thread.teamId === group.id)
		).length;
		const rank = (group.kind === "project" ? 0 : 1000) + index;
		if (
			!best ||
			count > best.count ||
			(count === best.count && rank < best.rank)
		) {
			best = { count, id: group.id, rank };
		}
	}
	return best?.id ?? OLD_TOWN_ID;
}
