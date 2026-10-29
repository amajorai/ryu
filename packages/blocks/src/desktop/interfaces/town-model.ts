import {
	type InterfaceAgent,
	type InterfaceAsk,
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
	waitBand,
} from "@ryuhq/protocol/interfaces";
import { compactAge } from "./interface-renderer.ts";
import { hashId } from "./town-palette.ts";

/**
 * Town view model (pure): the snapshot laid out as a small city. Districts
 * are projects and teams (agents in neither live in Old Town); every agent
 * is one building in its district, sized by how much it has to do; the
 * conversations waiting on you are petitions at City Hall in the centre.
 * Everything here is deterministic for a snapshot and a clock, so the
 * scene, the DOM layer and the tests agree on where things are.
 */

export const OLD_TOWN_ID = "old-town";
export const OLD_TOWN_NAME = "Old Town";

/** World units: one lot, the sidewalk ring around a block, the road. */
export const LOT = 2.3;
export const SIDEWALK = 0.55;
export const ROAD = 1.5;
/** Height of one storey. */
export const FLOOR_HEIGHT = 0.5;

export type BuildingKind = "cottage" | "shop" | "tower";

export const BUILDING_NAMES: Record<BuildingKind, string> = {
	cottage: "Cottage",
	shop: "Shop",
	tower: "Office tower",
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

export function plural(count: number, word: string, many = `${word}s`): string {
	return `${count} ${count === 1 ? word : many}`;
}

const EMPTY_COUNTS = (): Record<ThreadStatus, number> => ({
	attention: 0,
	quiet: 0,
	waiting: 0,
	working: 0,
	"your-turn": 0,
});

function byUrgency(a: InterfaceThread, b: InterfaceThread): number {
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

/** Activity (summed weights) at which a district reads as fully busy. */
export const ACTIVITY_FULL = 3;

/** Steps of the activity view, like a city builder's data-view bins. */
export const HEAT_STEPS = 4;

/**
 * Heat for each district: spread over the min to max of the districts on
 * the map in `HEAT_STEPS` bins, so a busier district always reads warmer,
 * and capped by how busy the busiest one is against `full` so a sleepy
 * town never glows. Near-equal districts keep their absolute level, and a
 * district with no activity is always zero.
 */
export function heatLevels(values: number[], full: number): number[] {
	if (values.length === 0) {
		return [];
	}
	const max = Math.max(...values);
	const min = Math.min(...values);
	const absolute = values.map((value) =>
		Math.min(1, Math.max(0, value) / full)
	);
	if (max - min < full * 0.05) {
		return absolute;
	}
	const top = Math.min(1, max / full);
	return values.map((value) => {
		// A district with no activity stays cold however busy its neighbours.
		if (value <= 0) {
			return 0;
		}
		const step =
			Math.round(((value - min) / (max - min)) * HEAT_STEPS) / HEAT_STEPS;
		return top * (0.12 + 0.88 * step);
	});
}

/** The lowest "needs you" level a district with anything waiting shows. */
export const NEEDS_FLOOR = 0.4;

/**
 * "Needs you" for a district against the one with most waiting: zero when
 * settled, and never fainter than `NEEDS_FLOOR` once anything is waiting,
 * so one petition always reads apart from none.
 */
export function needsLevel(value: number, max: number): number {
	if (value <= 0 || max <= 0) {
		return 0;
	}
	return NEEDS_FLOOR + (1 - NEEDS_FLOOR) * (value / max);
}

/** How fresh a conversation is, for the activity view: a live run counts most. */
export function activityWeight(thread: InterfaceThread, now: number): number {
	if (thread.running) {
		return 2;
	}
	const age = now - Date.parse(thread.updatedAt);
	if (Number.isNaN(age)) {
		return 0;
	}
	const hour = 3_600_000;
	if (age < hour) {
		return 0.8;
	}
	if (age < 24 * hour) {
		return 0.5;
	}
	if (age < 7 * 24 * hour) {
		return 0.2;
	}
	return 0.05;
}

/** Happiness: 100 with nothing waiting, falling with backlog and failures. */
export function happiness(
	population: number,
	yourTurn: number,
	attention: number
): number {
	if (population === 0) {
		return 100;
	}
	const load = (yourTurn + attention * 2) / (population + 4);
	return Math.round(100 * Math.min(1, Math.max(0, 1 - load)));
}

/** How much one blocking ask weighs on the town, by how long it has waited. */
const ASK_WEIGHT: Record<ReturnType<typeof waitBand>, number> = {
	expiring: 12,
	fresh: 3,
	long: 10,
	stale: 15,
	unknown: 5,
	waiting: 6,
};

/**
 * Happiness with the act layer: 100 with nothing blocking, falling with
 * every blocking ask, more the longer it has waited (its wait band).
 */
export function actHappiness(
	asks: readonly InterfaceAsk[] | undefined,
	nowMs: number
): number {
	let load = 0;
	for (const ask of asks ?? []) {
		if (!ask.blocking) {
			continue;
		}
		const band = waitBand(
			ask.since ? Date.parse(ask.since) : null,
			nowMs,
			ask.expiresAt ? Date.parse(ask.expiresAt) : null
		);
		load += ASK_WEIGHT[band];
	}
	return Math.max(0, 100 - load);
}

/**
 * Block cells around City Hall, front of the view first (the camera looks
 * from +x, +z), so the busiest districts face the mayor.
 */
export function blockCells(blocks: number): { col: number; row: number }[] {
	const half = Math.floor(blocks / 2);
	const cells: { col: number; row: number }[] = [];
	for (let row = -half; row <= half; row += 1) {
		for (let col = -half; col <= half; col += 1) {
			if (col !== 0 || row !== 0) {
				cells.push({ col, row });
			}
		}
	}
	const ring = (cell: { col: number; row: number }) =>
		Math.max(Math.abs(cell.col), Math.abs(cell.row));
	const corner = (cell: { col: number; row: number }) =>
		Math.abs(cell.col) === Math.abs(cell.row) ? 1 : 0;
	return cells.sort(
		(a, b) =>
			ring(a) - ring(b) ||
			corner(a) - corner(b) ||
			b.col + b.row - (a.col + a.row) ||
			b.col - a.col
	);
}

/** Lots of one block, back of the view first (tallest buildings go there). */
function blockLots(lots: number, centreX: number, centreZ: number): TownLot[] {
	const start = -((lots - 1) * LOT) / 2;
	const list: TownLot[] = [];
	for (let row = 0; row < lots; row += 1) {
		for (let col = 0; col < lots; col += 1) {
			list.push({
				col,
				row,
				x: centreX + start + col * LOT,
				z: centreZ + start + row * LOT,
			});
		}
	}
	return list.sort((a, b) => a.col + a.row - (b.col + b.row) || a.row - b.row);
}

interface DistrictSeed {
	id: string;
	kind: TownDistrict["kind"];
	name: string;
}

/** Which district a conversation belongs to. */
function threadDistrict(
	thread: InterfaceThread,
	known: Set<string>,
	homes: Map<string, string>
): string {
	if (thread.projectId && known.has(thread.projectId)) {
		return thread.projectId;
	}
	if (thread.teamId && known.has(thread.teamId)) {
		return thread.teamId;
	}
	const first = thread.agentIds[0];
	return (first ? homes.get(first) : undefined) ?? OLD_TOWN_ID;
}

export const MAX_DISTRICTS = 24;

/** The whole town for a snapshot at `now`. */
export function buildTown(snapshot: InterfaceSnapshot, now: number): Town {
	const { agents, threads } = snapshot;
	const groups = snapshot.groups.slice(0, MAX_DISTRICTS - 1);
	const homes = new Map<string, string>();
	for (const agent of agents) {
		homes.set(agent.id, homeDistrict(agent.id, groups, threads));
	}
	const known = new Set(groups.map((group) => group.id));
	const threadsByDistrict = new Map<string, InterfaceThread[]>();
	for (const thread of threads) {
		const id = threadDistrict(thread, known, homes);
		const list = threadsByDistrict.get(id) ?? [];
		list.push(thread);
		threadsByDistrict.set(id, list);
	}

	const seeds: DistrictSeed[] = groups.map((group) => ({
		id: group.id,
		kind: group.kind,
		name: group.name.trim() || (group.kind === "team" ? "Team" : "Project"),
	}));
	const needsOldTown =
		[...homes.values()].includes(OLD_TOWN_ID) ||
		threadsByDistrict.has(OLD_TOWN_ID);
	if (needsOldTown) {
		seeds.push({ id: OLD_TOWN_ID, kind: "old-town", name: OLD_TOWN_NAME });
	}
	seeds.sort(
		(a, b) =>
			(threadsByDistrict.get(b.id)?.length ?? 0) -
				(threadsByDistrict.get(a.id)?.length ?? 0) ||
			a.name.localeCompare(b.name)
	);

	let mostResidents = 0;
	for (const seed of seeds) {
		let residents = 0;
		for (const home of homes.values()) {
			if (home === seed.id) {
				residents += 1;
			}
		}
		mostResidents = Math.max(mostResidents, residents);
	}
	const lots = Math.max(3, Math.ceil(Math.sqrt(mostResidents)));
	const inner = lots * LOT;
	const pitch = inner + SIDEWALK * 2 + ROAD;
	const blocks = seeds.length <= 8 ? 3 : 5;
	const reach = (blocks * pitch) / 2;
	const cells = blockCells(blocks);

	const tints = districtTints(seeds.map((seed) => seed.id));
	const buildings: TownBuilding[] = [];
	const districts: TownDistrict[] = seeds.map((seed, index) => {
		const cell = cells[index] ?? { col: 0, row: 0 };
		const x = cell.col * pitch;
		const z = cell.row * pitch;
		const districtThreads = (threadsByDistrict.get(seed.id) ?? []).sort(
			byUrgency
		);
		const residents = agents
			.filter((agent) => homes.get(agent.id) === seed.id)
			.map((agent) => {
				const own = threads
					.filter((thread) => thread.agentIds.includes(agent.id))
					.sort(byUrgency);
				const counts = EMPTY_COUNTS();
				let messages = 0;
				for (const thread of own) {
					counts[threadStatus(thread)] += 1;
					messages += thread.messageCount;
				}
				const kind = buildingKind(own.length);
				return {
					agent,
					alert: counts.attention > 0,
					counts,
					districtId: seed.id,
					floors: buildingFloors(kind, messages),
					kind,
					messages,
					replied: counts["your-turn"] > 0,
					threads: own,
					working: agent.status === "working" || counts.working > 0,
				};
			})
			.sort(
				(a, b) =>
					b.floors - a.floors || a.agent.name.localeCompare(b.agent.name)
			);
		const lotList = blockLots(lots, x, z);
		const placed: TownBuilding[] = residents.map((resident, slot) => ({
			...resident,
			lot: lotList[slot] ?? { col: 0, row: 0, x, z },
		}));
		buildings.push(...placed);
		const free = lotList.slice(placed.length);
		const growth = Math.min(free.length, districtThreads.length);
		const districtMessages = districtThreads.reduce(
			(total, thread) => total + thread.messageCount,
			0
		);
		const tallest = 1 + Math.min(3, Math.floor(districtMessages / 12));
		const fillers: TownFiller[] = free.slice(0, growth).map((lot, slot) => {
			const id = `${seed.id}:${slot}`;
			const hash = hashId(id);
			return {
				floors: 1 + (hash % tallest),
				id,
				kind: hash % 3 === 0 ? "terrace" : "house",
				lot,
			};
		});
		let petitions = 0;
		let attention = 0;
		let activity = 0;
		for (const thread of districtThreads) {
			const status = threadStatus(thread);
			if (status === "attention") {
				attention += 1;
				petitions += 1;
			} else if (status === "your-turn") {
				petitions += 1;
			}
			activity += activityWeight(thread, now);
		}
		return {
			activity,
			attention,
			buildings: placed,
			cell,
			emptyLots: free.slice(growth),
			fillers,
			id: seed.id,
			kind: seed.kind,
			name: seed.name,
			needs: petitions + attention,
			petitions,
			tint: tints.get(seed.id) ?? 0,
			threads: districtThreads,
			working: placed.filter((building) => building.working).length,
			x,
			z,
		};
	});
	const maxNeeds = Math.max(0, ...districts.map((item) => item.needs));
	const heat = heatLevels(
		districts.map((item) => item.activity),
		ACTIVITY_FULL
	);
	for (const [index, district] of districts.entries()) {
		district.activity = heat[index] ?? 0;
		district.needs = needsLevel(district.needs, maxNeeds);
	}

	const parks = townParks(cells.slice(districts.length), pitch, lots);

	const names = new Map(districts.map((item) => [item.id, item.name]));
	const petitions: TownPetition[] = [];
	let yourTurn = 0;
	let attentionTotal = 0;
	let messages = 0;
	for (const thread of threads) {
		messages += thread.messageCount;
		const status = threadStatus(thread);
		if (status !== "attention" && status !== "your-turn") {
			continue;
		}
		if (status === "attention") {
			attentionTotal += 1;
		} else {
			yourTurn += 1;
		}
		const districtId = threadDistrict(thread, known, homes);
		const firstAgent = thread.agentIds[0];
		petitions.push({
			agent: firstAgent
				? agents.find((agent) => agent.id === firstAgent)
				: undefined,
			districtId,
			districtName: names.get(districtId) ?? OLD_TOWN_NAME,
			status,
			thread,
		});
	}
	petitions.sort(
		(a, b) =>
			Number(b.status === "attention") - Number(a.status === "attention") ||
			b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
			a.thread.id.localeCompare(b.thread.id)
	);
	const working = buildings.filter((building) => building.working).length;
	return {
		buildings,
		cars: Math.min(18, working * 4),
		districts,
		grid: { blocks, inner, lots, pitch, reach },
		parks,
		petitions,
		stats: {
			attention: attentionTotal,
			happiness: happiness(threads.length, yourTurn, attentionTotal),
			messages,
			population: threads.length,
			working,
			yourTurn,
		},
	};
}

/** Lines of the road grid: every block edge, including the ring road. */
export function roadLines(grid: TownGrid): number[] {
	const lines: number[] = [];
	for (let index = 0; index <= grid.blocks; index += 1) {
		lines.push(-grid.reach + index * grid.pitch);
	}
	return lines;
}

/** The building for an agent, if it has one. */
export function buildingFor(
	town: Town,
	agentId: string | null | undefined
): TownBuilding | undefined {
	return agentId
		? town.buildings.find((building) => building.agent.id === agentId)
		: undefined;
}

/** The scheduled runs that target an agent: next ones first, then recent. */
export function agentSchedule(
	events: InterfaceEvent[] | undefined,
	agentId: string
): { recent: InterfaceEvent[]; upcoming: InterfaceEvent[] } {
	const own = (events ?? []).filter((event) => event.agentId === agentId);
	return {
		recent: own
			.filter((event) => event.kind === "past")
			.sort((a, b) => b.start.localeCompare(a.start))
			.slice(0, 3),
		upcoming: own
			.filter((event) => event.kind === "upcoming")
			.sort((a, b) => a.start.localeCompare(b.start))
			.slice(0, 3),
	};
}

/** When a scheduled run happens ("in 45m") or happened ("2h ago"). */
export function eventWhen(event: InterfaceEvent, now: number): string {
	const start = Date.parse(event.start);
	if (Number.isNaN(start)) {
		return "";
	}
	if (event.kind === "upcoming") {
		const minutes = Math.max(0, Math.round((start - now) / 60_000));
		if (minutes < 60) {
			return `in ${minutes}m`;
		}
		const hours = Math.round(minutes / 60);
		return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
	}
	return `${compactAge(event.start, now)} ago`;
}

/** The next scheduled runs across the town, soonest first. */
export function upcomingRuns(
	events: InterfaceEvent[] | undefined,
	limit = 4
): InterfaceEvent[] {
	return (events ?? [])
		.filter((event) => event.kind === "upcoming")
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
		.slice(0, limit);
}

/** What a building is, in words, for its accessible name. */
export function buildingLabel(
	building: TownBuilding,
	districtName: string
): string {
	const parts = [
		`${building.agent.name}'s ${BUILDING_NAMES[building.kind].toLowerCase()}`,
		districtName,
		plural(building.threads.length, "conversation"),
	];
	if (building.working) {
		parts.push("under construction");
	}
	if (building.alert) {
		parts.push(plural(building.counts.attention, "failed run"));
	}
	if (building.replied) {
		parts.push(`${building.counts["your-turn"]} waiting on you`);
	}
	return parts.join(", ");
}

/** Spoken age for screen readers ("5 minutes ago"). */
export function spokenAge(iso: string, now: number): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const minutes = Math.max(0, Math.round((now - then) / 60_000));
	if (minutes < 1) {
		return "just now";
	}
	if (minutes < 60) {
		return `${plural(minutes, "minute")} ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${plural(hours, "hour")} ago`;
	}
	return `${plural(Math.round(hours / 24), "day")} ago`;
}

/** Funds from the usage account, when the host has one. */
export function formatFunds(snapshot: InterfaceSnapshot): string | null {
	const balance = snapshot.account?.balance;
	if (balance === null || balance === undefined) {
		return null;
	}
	try {
		return new Intl.NumberFormat(undefined, {
			currency: snapshot.account?.currency.toUpperCase() ?? "USD",
			maximumFractionDigits: 2,
			minimumFractionDigits: 2,
			style: "currency",
		}).format(balance / 1_000_000);
	} catch {
		return (balance / 1_000_000).toFixed(2);
	}
}

/** Grass between the ring road and the edge of the island. */
export const ISLAND_MARGIN = 2.2;

/**
 * What the camera frames at first. On a roomy stage, the whole island
 * (grass beyond the ring road included), so the diorama sits inside the
 * stage with a margin. On a phone-width stage, only City Hall and the
 * district blocks, so they stay legible and the parks bleed off the sides.
 */
export function townFrame(
	town: Town,
	extent: "districts" | "island" = "island"
): {
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
} {
	if (extent === "island") {
		const half = town.grid.reach + ISLAND_MARGIN;
		return { maxX: half, maxZ: half, minX: -half, minZ: -half };
	}
	const { pitch } = town.grid;
	let minCol = 0;
	let maxCol = 0;
	let minRow = 0;
	let maxRow = 0;
	for (const district of town.districts) {
		minCol = Math.min(minCol, district.cell.col);
		maxCol = Math.max(maxCol, district.cell.col);
		minRow = Math.min(minRow, district.cell.row);
		maxRow = Math.max(maxRow, district.cell.row);
	}
	const edge = pitch / 2;
	return {
		maxX: maxCol * pitch + edge,
		maxZ: maxRow * pitch + edge,
		minX: minCol * pitch - edge,
		minZ: minRow * pitch - edge,
	};
}
