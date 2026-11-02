import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceAgentAct,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export {
	COLUMN_BODY_SCALE,
	COLUMN_SIDE,
	type ColumnFrame,
	columnFrame,
	columnRoom,
	columnSystem,
	cyclePlanet,
	holdOrbits,
	type OverviewSketch,
	overviewSketch,
} from "./planets-model-columns.ts";

export {
	type FocusFrame,
	focusFrame,
	freeRegions,
	type OverviewFrame,
	overviewElevation,
	overviewFrame,
} from "./planets-model-frame.ts";

export {
	type Box,
	EMPTY_HUD,
	FIT_SAMPLES,
	HUD_GAP,
	type HudLayout,
	type Insets,
	OVERVIEW_ELEVATION,
	PLATE_PAD,
	sidePad,
} from "./planets-model-hud.ts";

export {
	MOON_TILTS,
	moonOffset,
	moonSpeed,
	orbitAngle,
	orbitPoint,
	overviewReach,
} from "./planets-model-orbit.ts";

export {
	overlapArea,
	planetDescription,
	planetKindLabel,
	sectionThreads,
	type ThreadSection,
	threadsWaitingOnYou,
} from "./planets-model-words.ts";

/**
 * Planets view model: pure, so it can be tested without WebGL. You are the
 * star at the centre; every agent is a planet on its own orbit and every
 * thread is a moon of the agent it belongs to. Threads no agent is on orbit
 * the star itself. Units are scene units (the star is `SUN_RADIUS` across).
 */

export const PLANET_KINDS = ["rocky", "gas", "ice", "ocean", "ringed"] as const;
export type PlanetKind = (typeof PLANET_KINDS)[number];

export const PLANET_KIND_LABELS: Record<PlanetKind, string> = {
	get gas() {
		return tr("Gas giant");
	},
	get ice() {
		return tr("Ice world");
	},
	get ocean() {
		return tr("Ocean world");
	},
	get ringed() {
		return tr("Ringed giant");
	},
	get rocky() {
		return tr("Rocky world");
	},
};

/** Moons drawn around one planet; the rest are counted as "+N". */
export const MAX_MOONS = 8;
export const SUN_RADIUS = 2.8;
/** The camera's vertical field of view, degrees. */
export const FOV = 40;
/** The overview camera's side of the star (radians around from +z). */
export const OVERVIEW_AZIMUTH = 0.42;
/** A portrait column is seen nearly top-down, so the stack reads tall. */
export const COLUMN_ELEVATION = 1.22;
/**
 * In the overview, bodies are drawn this much larger than their orbits allow
 * (as orrery apps do), so planets and their moons read at a glance. Visiting
 * a body eases it back to true scale.
 */
export const OVERVIEW_BODY_SCALE = 2.4;
/** The intro starts this much farther out than the overview, and settles in. */
export const OVERVIEW_INTRO_SCALE = 1.15;
/** Clear space around the star (its glow and your own threads). */
export const SUN_CLEARANCE = 8.2;
/** Empty space between the outer edge of one planet's moons and the next. */
const ORBIT_GAP = 0.6;
/**
 * Orbits are spread wider than the bodies' true reach, so the overview's
 * swollen bodies (and the little worlds on top) keep clear of each other.
 */
const ORBIT_SPREAD = 1.15;
const MIN_PLANET_RADIUS = 1.2;
const PLANET_GROWTH = 1;
/** Thread counts past this stop growing the planet. */
const SIZE_CAP_THREADS = 25;
/** Moons sit on two shells, alternating, so neighbours never touch. */
const MOON_SHELLS = [0.74, 1.18] as const;
const MOON_RADIUS = 0.36;
const RING_OUTER = 2.15;
const GOLDEN_ANGLE = 2.399_963;
/** Angular speed at unit radius; farther planets are slower. */
const ORBIT_SPEED = 0.55;

/**
 * The orbit speed setting's pace: how fast planets travel their orbits and
 * moons circle them, as a share of the stock speed (`still` holds them).
 */
export const ORBIT_PACE = { normal: 1, slow: 0.35, still: 0 } as const;
const SPIN_IDLE = 0.12;
const SPIN_WORKING = 0.55;

/** FNV-1a: a small, stable 32-bit hash for picking looks from an id. */
export function hashId(id: string): number {
	let hash = 2_166_136_261;
	for (const char of id) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/** The planet type for an agent, from its id alone (stable across renames). */
export function planetKind(agentId: string): PlanetKind {
	return (
		PLANET_KINDS[hashId(`${agentId}:planet`) % PLANET_KINDS.length] ?? "rocky"
	);
}

/** Which color variant of its kind a planet takes, from its id. */
export function planetVariant(agentId: string, variants: number): number {
	if (variants <= 0) {
		return 0;
	}
	return Math.floor(hashId(`${agentId}:look`) / 7) % variants;
}

/** Planet radius from its thread count: more threads, a bigger world. */
export function planetRadius(threadCount: number): number {
	const count = Math.max(0, Math.min(threadCount, SIZE_CAP_THREADS));
	return MIN_PLANET_RADIUS + PLANET_GROWTH * Math.sqrt(count);
}

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** Most urgent first (the status order), then pinned, then most recent. */
export function byUrgency(a: InterfaceThread, b: InterfaceThread): number {
	return (
		THREAD_STATUS_ORDER.indexOf(threadStatus(a)) -
			THREAD_STATUS_ORDER.indexOf(threadStatus(b)) ||
		Number(b.pinned) - Number(a.pinned) ||
		byRecency(a, b)
	);
}

export type StatusCounts = Record<ThreadStatus, number>;

export function emptyCounts(): StatusCounts {
	return { attention: 0, quiet: 0, waiting: 0, working: 0, "your-turn": 0 };
}

export function statusCounts(
	threads: readonly InterfaceThread[]
): StatusCounts {
	const counts = emptyCounts();
	for (const thread of threads) {
		counts[threadStatus(thread)] += 1;
	}
	return counts;
}

export interface Moon {
	/** Distance from the planet's centre. */
	orbit: number;
	/** Starting angle on its shell, radians. */
	phase: number;
	radius: number;
	/** 0 (inner) or 1 (outer) shell. */
	shell: number;
	status: ThreadStatus;
	threadId: string;
	title: string;
}

export interface Planet {
	agent: InterfaceAgent;
	/** Axial tilt in radians, from the id. */
	axialTilt: number;
	counts: StatusCounts;
	/** How far moons (and rings) reach from the centre. */
	extent: number;
	id: string;
	/** 0 is the innermost orbit. */
	index: number;
	kind: PlanetKind;
	moons: Moon[];
	name: string;
	/** Distance from the star. */
	orbitRadius: number;
	/** Radians per second around the star. */
	orbitSpeed: number;
	/** Threads past `MAX_MOONS` that are not drawn. */
	overflow: number;
	/** Starting angle around the star, radians. */
	phase: number;
	radius: number;
	/** Radians per second around its own axis. */
	spin: number;
	/** Team the planet's orbit is tinted for (first team it belongs to). */
	teamId: string | null;
	threadCount: number;
	threads: InterfaceThread[];
	working: boolean;
}

export interface Team {
	/** Position in the art palette's team colors. */
	colorIndex: number;
	id: string;
	memberIds: string[];
	name: string;
}

export interface SystemSummary {
	agents: number;
	attention: number;
	threads: number;
	unassigned: number;
	/** Threads where the next move is yours: failed runs plus replies. */
	waitingOnYou: number;
	/** Agents with a live run. */
	working: number;
	yourTurn: number;
}

export interface PlanetSystem {
	/**
	 * Laid out for a portrait screen: every planet holds still in a column
	 * below the star (see `columnSystem`), framed top-down by `columnFrame`.
	 */
	column?: boolean;
	planets: Planet[];
	/** Threads with no (known) agent: they orbit the star, as your own. */
	starMoons: Moon[];
	starOverflow: number;
	summary: SystemSummary;
	/** Radius that holds every orbit and its moons. */
	systemRadius: number;
	teams: Team[];
	unassigned: InterfaceThread[];
}

/** Agent ids a thread belongs to, keeping only agents that exist. */
function threadsByAgent(
	snapshot: InterfaceSnapshot
): Map<string, InterfaceThread[]> {
	const known = new Set(snapshot.agents.map((agent) => agent.id));
	const map = new Map<string, InterfaceThread[]>();
	for (const agent of snapshot.agents) {
		map.set(agent.id, []);
	}
	for (const thread of snapshot.threads) {
		for (const agentId of new Set(thread.agentIds)) {
			if (known.has(agentId)) {
				map.get(agentId)?.push(thread);
			}
		}
	}
	return map;
}

/**
 * Orbit order: agents with more threads orbit closer; ties go by name, then
 * id, so the order never shuffles between renders.
 */
export function orbitOrder(
	agents: readonly InterfaceAgent[],
	threadCounts: ReadonlyMap<string, number>
): InterfaceAgent[] {
	return [...agents].sort(
		(a, b) =>
			(threadCounts.get(b.id) ?? 0) - (threadCounts.get(a.id) ?? 0) ||
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
			a.id.localeCompare(b.id)
	);
}

/**
 * Moons for a set of threads: the most urgent first, capped at `MAX_MOONS`.
 * With `rank` (the act layer's priority, lower first) that order comes
 * before urgency.
 */
export function moonsFor(
	threads: readonly InterfaceThread[],
	bodyRadius: number,
	seed: string,
	rank?: (thread: InterfaceThread) => number
): { moons: Moon[]; overflow: number } {
	const sorted = [...threads].sort(
		(a, b) => (rank ? rank(a) - rank(b) : 0) || byUrgency(a, b)
	);
	const shown = sorted.slice(0, MAX_MOONS);
	const offset = (hashId(`${seed}:moons`) % 628) / 100;
	const perShell = [
		Math.ceil(shown.length / 2),
		Math.floor(shown.length / 2),
	] as const;
	const moons = shown.map((thread, index) => {
		const shell = index % 2;
		const slot = Math.floor(index / 2);
		const slots = Math.max(1, perShell[shell] ?? 1);
		return {
			orbit: bodyRadius + (MOON_SHELLS[shell] ?? MOON_SHELLS[0]),
			phase: offset + shell * 0.9 + (slot / slots) * Math.PI * 2,
			radius: MOON_RADIUS,
			shell,
			status: threadStatus(thread),
			threadId: thread.id,
			title: thread.title.trim() || tr("Untitled thread"),
		};
	});
	return { moons, overflow: sorted.length - shown.length };
}

/** How far a planet's moons and rings reach from its centre. */
export function planetExtent(
	radius: number,
	kind: PlanetKind,
	moonCount: number
): number {
	const moonReach =
		moonCount > 0
			? radius + (MOON_SHELLS[moonCount > 1 ? 1 : 0] ?? 0) + MOON_RADIUS
			: radius;
	const ringReach = kind === "ringed" ? radius * RING_OUTER : radius;
	return Math.max(moonReach, ringReach) + 0.15;
}

export function teamsOf(groups: readonly InterfaceGroup[]): Team[] {
	return groups
		.filter((group) => group.kind === "team")
		.map((group, index) => ({
			colorIndex: index,
			id: group.id,
			memberIds: [...group.memberAgentIds],
			name: group.name,
		}));
}

export function systemSummary(snapshot: InterfaceSnapshot): SystemSummary {
	const counts = statusCounts(snapshot.threads);
	const known = new Set(snapshot.agents.map((agent) => agent.id));
	return {
		agents: snapshot.agents.length,
		attention: counts.attention,
		threads: snapshot.threads.length,
		unassigned: snapshot.threads.filter(
			(thread) => !thread.agentIds.some((agentId) => known.has(agentId))
		).length,
		waitingOnYou: counts.attention + counts["your-turn"],
		working: snapshot.agents.filter((agent) => agent.status === "working")
			.length,
		yourTurn: counts["your-turn"],
	};
}

/**
 * A thread's act priority on its agent's planet: the act's own thread (the
 * focus moon) first, then threads with the agent's asks or suggestions,
 * then the rest (by urgency).
 */
export function actMoonRank(
	act: InterfaceAgentAct | undefined
): ((thread: InterfaceThread) => number) | undefined {
	if (!act) {
		return undefined;
	}
	const asked = new Set(
		[act.ask, ...act.parkedAsks, ...act.suggestions].map(
			(ask) => ask?.threadId ?? null
		)
	);
	return (thread) => {
		if (thread.id === act.threadId) {
			return 0;
		}
		return asked.has(thread.id) ? 1 : 2;
	};
}

/**
 * The whole system for a snapshot: planets on their orbits, moons, teams.
 * With the act layer's `acts`, each planet's moons go by act priority.
 */
export function buildSystem(
	snapshot: InterfaceSnapshot,
	acts?: ReadonlyMap<string, InterfaceAgentAct>
): PlanetSystem {
	const byAgent = threadsByAgent(snapshot);
	const counts = new Map(
		[...byAgent].map(([agentId, threads]) => [agentId, threads.length])
	);
	const teams = teamsOf(snapshot.groups);
	const planets: Planet[] = [];
	let reach = SUN_CLEARANCE;
	for (const [index, agent] of orbitOrder(snapshot.agents, counts).entries()) {
		const threads = byAgent.get(agent.id) ?? [];
		const kind = planetKind(agent.id);
		const radius = planetRadius(threads.length);
		const { moons, overflow } = moonsFor(
			threads,
			radius,
			agent.id,
			actMoonRank(acts?.get(agent.id))
		);
		const extent = planetExtent(radius, kind, moons.length);
		const orbitRadius = reach + extent * ORBIT_SPREAD;
		reach = orbitRadius + extent * ORBIT_SPREAD + ORBIT_GAP;
		const hash = hashId(agent.id);
		const working =
			agent.status === "working" || threads.some((thread) => thread.running);
		planets.push({
			agent,
			axialTilt: 0.12 + ((hash >>> 4) % 100) / 300,
			counts: statusCounts(threads),
			extent,
			id: agent.id,
			index,
			kind,
			moons,
			name: agent.name,
			orbitRadius,
			orbitSpeed: ORBIT_SPEED / orbitRadius,
			overflow,
			phase: index * GOLDEN_ANGLE + ((hash >>> 12) % 100) / 160,
			radius,
			spin: working ? SPIN_WORKING : SPIN_IDLE,
			teamId:
				teams.find((team) => team.memberIds.includes(agent.id))?.id ?? null,
			threadCount: threads.length,
			threads,
			working,
		});
	}
	const known = new Set(snapshot.agents.map((agent) => agent.id));
	const unassigned = snapshot.threads.filter(
		(thread) => !thread.agentIds.some((agentId) => known.has(agentId))
	);
	const star = moonsFor(unassigned, SUN_RADIUS + 1.1, "you");
	return {
		planets,
		starMoons: star.moons,
		starOverflow: star.overflow,
		summary: systemSummary(snapshot),
		systemRadius: Math.max(reach - ORBIT_GAP, SUN_CLEARANCE + 2),
		teams,
		unassigned,
	};
}
