import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Aquarium view model: which creature each agent becomes (species, colour,
 * markings, state) and what the side panel lists. Everything here is a pure
 * function of the snapshot; where each creature swims in the tank is the
 * diorama's layout (`layoutTank` in aquarium-diorama.tsx).
 */

export const CREATURE_KINDS = [
	"fish",
	"angelfish",
	"jellyfish",
	"turtle",
	"manta",
] as const;
export type CreatureKind = (typeof CREATURE_KINDS)[number];

export const CREATURE_LABELS: Record<CreatureKind, string> = {
	angelfish: "Angelfish",
	fish: "Reef fish",
	jellyfish: "Jellyfish",
	manta: "Manta ray",
	turtle: "Sea turtle",
};

/** FNV-1a: a stable 32-bit hash, so an id always becomes the same creature. */
export function hashId(id: string): number {
	let hash = 0x81_1c_9d_c5;
	for (const char of id) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return hash >>> 0;
}

/** A stable pseudo-random number in [0, 1) for a seed and a salt. */
export function unit(seed: number, salt: number): number {
	let value = (seed ^ Math.imul(salt + 1, 0x9e_37_79_b9)) >>> 0;
	value = Math.imul(value ^ (value >>> 16), 0x85_eb_ca_6b);
	value = Math.imul(value ^ (value >>> 13), 0xc2_b2_ae_35);
	return ((value ^ (value >>> 16)) >>> 0) / 4_294_967_296;
}

/** The species an agent prefers, from its id alone. */
export function creatureKind(agentId: string): CreatureKind {
	return (
		CREATURE_KINDS[(hashId(agentId) >>> 3) % CREATURE_KINDS.length] ?? "fish"
	);
}

export function emptyCounts(): Record<ThreadStatus, number> {
	return { attention: 0, quiet: 0, waiting: 0, working: 0, "your-turn": 0 };
}

export interface Creature {
	agent: InterfaceAgent;
	/** Index into the art palette's creature hues. */
	colorIndex: number;
	counts: Record<ThreadStatus, number>;
	id: string;
	kind: CreatureKind;
	/** Slot among creatures in the same zone, and how many share the zone. */
	lane: number;
	lanes: number;
	name: string;
	/** Markings variant (bands, stripe, spots), from the id. */
	pattern: number;
	/** A thread of this agent's failed or was interrupted. */
	pearl: boolean;
	seed: number;
	threadCount: number;
	working: boolean;
}

function threadsByAgent(
	snapshot: InterfaceSnapshot
): Map<string, InterfaceThread[]> {
	const map = new Map<string, InterfaceThread[]>();
	for (const thread of snapshot.threads) {
		for (const agentId of thread.agentIds) {
			const list = map.get(agentId);
			if (list) {
				list.push(thread);
			} else {
				map.set(agentId, [thread]);
			}
		}
	}
	return map;
}

/** First choice from `preferred`, stepping on while `full` says it is taken. */
function probe(
	preferred: number,
	count: number,
	full: (candidate: number) => boolean
): number {
	for (let step = 0; step < count; step += 1) {
		const candidate = (preferred + step) % count;
		if (!full(candidate)) {
			return candidate;
		}
	}
	return preferred % count;
}

/**
 * One creature per agent. Species and color come from the id; so the tank
 * reads as a varied reef rather than a school, an agent whose species is
 * already more common than the rarest one passes on to the next species, and
 * a taken color to the next free one. Agents are visited in id order, so the
 * result is deterministic for a given roster (and every species appears once
 * before any appears twice).
 */
export function buildCreatures(
	snapshot: InterfaceSnapshot,
	hueCount: number
): Creature[] {
	const byAgent = threadsByAgent(snapshot);
	const ordered = [...snapshot.agents].sort((a, b) => a.id.localeCompare(b.id));
	const kindCounts = CREATURE_KINDS.map(() => 0);
	const hues = Math.max(1, hueCount);
	const colorCounts = Array.from({ length: hues }, () => 0);
	const creatures: Creature[] = [];
	for (const agent of ordered) {
		const seed = hashId(agent.id);
		const rarestKind = Math.min(...kindCounts);
		const kindIndex = probe(
			CREATURE_KINDS.indexOf(creatureKind(agent.id)),
			CREATURE_KINDS.length,
			(index) => (kindCounts[index] ?? 0) > rarestKind
		);
		kindCounts[kindIndex] = (kindCounts[kindIndex] ?? 0) + 1;
		const kind = CREATURE_KINDS[kindIndex] ?? "fish";
		const rarestColor = Math.min(...colorCounts);
		const colorIndex = probe(
			seed % hues,
			hues,
			(index) => (colorCounts[index] ?? 0) > rarestColor
		);
		colorCounts[colorIndex] = (colorCounts[colorIndex] ?? 0) + 1;
		const threads = byAgent.get(agent.id) ?? [];
		const counts = emptyCounts();
		for (const thread of threads) {
			counts[threadStatus(thread)] += 1;
		}
		creatures.push({
			agent,
			colorIndex,
			counts,
			id: agent.id,
			kind,
			lane: 0,
			lanes: 1,
			name: agent.name,
			pattern: (seed >>> 11) % 3,
			pearl: counts.attention > 0,
			seed,
			threadCount: threads.length,
			working: agent.status === "working" || counts.working > 0,
		});
	}
	assignLanes(creatures.filter((creature) => creature.working));
	assignLanes(creatures.filter((creature) => !creature.working));
	return creatures;
}

/** Spread a zone's creatures across its lanes in a stable, shuffled order. */
function assignLanes(zone: Creature[]): void {
	const shuffled = [...zone].sort(
		(a, b) => unit(a.seed, 3) - unit(b.seed, 3) || a.id.localeCompare(b.id)
	);
	for (const [index, creature] of shuffled.entries()) {
		creature.lane = index;
		creature.lanes = shuffled.length;
	}
}

/**
 * Keyboard and screen-reader order: who needs you first, then who is
 * working, then everyone else, by name.
 */
export function creatureOrder(creatures: readonly Creature[]): Creature[] {
	const rank = (creature: Creature) => {
		if (creature.pearl) {
			return 0;
		}
		if (creature.counts["your-turn"] > 0) {
			return 1;
		}
		return creature.working ? 2 : 3;
	};
	return [...creatures].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			a.name.localeCompare(b.name) ||
			a.id.localeCompare(b.id)
	);
}

// ---------------------------------------------------------------------------
// Panel and chrome
// ---------------------------------------------------------------------------

function pinnedThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return (
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

export interface ThreadSection {
	status: ThreadStatus;
	threads: InterfaceThread[];
}

/** An agent's threads grouped by status, most urgent first. */
export function agentThreadSections(
	snapshot: InterfaceSnapshot,
	agentId: string
): ThreadSection[] {
	return sectionThreads(
		snapshot.threads.filter((thread) => thread.agentIds.includes(agentId))
	);
}

/** Threads no agent is on. */
export function unassignedThreads(
	snapshot: InterfaceSnapshot
): InterfaceThread[] {
	return snapshot.threads
		.filter((thread) => thread.agentIds.length === 0)
		.sort(pinnedThenRecent);
}

export function sectionThreads(threads: InterfaceThread[]): ThreadSection[] {
	const sections: ThreadSection[] = [];
	for (const status of THREAD_STATUS_ORDER) {
		const matching = threads
			.filter((thread) => threadStatus(thread) === status)
			.sort(pinnedThenRecent);
		if (matching.length > 0) {
			sections.push({ status, threads: matching });
		}
	}
	return sections;
}

export interface TankSummary {
	agents: number;
	attention: number;
	unassigned: number;
	working: number;
	yourTurn: number;
}

export function tankSummary(snapshot: InterfaceSnapshot): TankSummary {
	const summary: TankSummary = {
		agents: snapshot.agents.length,
		attention: 0,
		unassigned: 0,
		working: 0,
		yourTurn: 0,
	};
	const working = new Set<string>();
	for (const agent of snapshot.agents) {
		if (agent.status === "working") {
			working.add(agent.id);
		}
	}
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (status === "attention") {
			summary.attention += 1;
		} else if (status === "your-turn") {
			summary.yourTurn += 1;
		} else if (status === "working") {
			for (const agentId of thread.agentIds) {
				working.add(agentId);
			}
		}
		if (thread.agentIds.length === 0) {
			summary.unassigned += 1;
		}
	}
	summary.working = [...working].filter((id) =>
		snapshot.agents.some((agent) => agent.id === id)
	).length;
	return summary;
}

export function plural(count: number, noun: string, many = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : many}`;
}

/** How a creature reads to a screen reader. */
export function creatureDescription(creature: Creature): string {
	const parts = [
		creature.name,
		CREATURE_LABELS[creature.kind].toLowerCase(),
		creature.working ? "working" : "idle",
		plural(creature.threadCount, "thread"),
	];
	if (creature.counts.attention > 0) {
		const count = creature.counts.attention;
		parts.push(`${count} need${count === 1 ? "s" : ""} attention`);
	}
	if (creature.counts["your-turn"] > 0) {
		parts.push(`${creature.counts["your-turn"]} waiting on you`);
	}
	return parts.join(", ");
}
