import {
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	buildingFloors,
	buildingKind,
	byUrgency,
	districtTints,
	EMPTY_COUNTS,
	homeDistrict,
	LOT,
	OLD_TOWN_ID,
	OLD_TOWN_NAME,
	ROAD,
	SIDEWALK,
	type Town,
	type TownBuilding,
	type TownDistrict,
	type TownFiller,
	type TownGrid,
	type TownLot,
	type TownPetition,
	townParks,
} from "./town-model.ts";
import {
	ACTIVITY_FULL,
	activityWeight,
	happiness,
	heatLevels,
	needsLevel,
} from "./town-model-mood.ts";
import { hashId } from "./town-palette.ts";

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
export function blockLots(
	lots: number,
	centreX: number,
	centreZ: number
): TownLot[] {
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
