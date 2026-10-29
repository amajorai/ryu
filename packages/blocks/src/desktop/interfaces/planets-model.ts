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

/**
 * Planets view model: pure, so it can be tested without WebGL. You are the
 * star at the centre; every agent is a planet on its own orbit and every
 * thread is a moon of the agent it belongs to. Threads no agent is on orbit
 * the star itself. Units are scene units (the star is `SUN_RADIUS` across).
 */

export const PLANET_KINDS = ["rocky", "gas", "ice", "ocean", "ringed"] as const;
export type PlanetKind = (typeof PLANET_KINDS)[number];

export const PLANET_KIND_LABELS: Record<PlanetKind, string> = {
	gas: "Gas giant",
	ice: "Ice world",
	ocean: "Ocean world",
	ringed: "Ringed giant",
	rocky: "Rocky world",
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
const SUN_CLEARANCE = 8.2;
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

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
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
			title: thread.title.trim() || "Untitled thread",
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

/**
 * The radius the overview has to hold: the outermost planet's orbit plus its
 * body, drawn at `bodyScale`. Moons and rings may brush the frame's margin
 * (the name plates' padding leaves room for them) rather than shrinking the
 * whole system for a moment when one swings outwards.
 */
export function overviewReach(
	system: Pick<PlanetSystem, "planets" | "systemRadius">,
	bodyScale = OVERVIEW_BODY_SCALE
): number {
	let reach = SUN_CLEARANCE + 2;
	for (const planet of system.planets) {
		reach = Math.max(reach, planet.orbitRadius + planet.radius * bodyScale);
	}
	return system.planets.length > 0 ? reach : system.systemRadius;
}

/** Angle around the star at `elapsed` seconds of orbit time. */
export function orbitAngle(
	planet: Pick<Planet, "orbitSpeed" | "phase">,
	elapsed: number
): number {
	return planet.phase + planet.orbitSpeed * elapsed;
}

/** Position on the orbital plane (y up) for an orbit radius and angle. */
export function orbitPoint(
	radius: number,
	angle: number
): [number, number, number] {
	return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
}

/** Moon angular speed on its shell (inner moons are quicker). */
export function moonSpeed(moon: Pick<Moon, "shell">): number {
	return moon.shell === 0 ? 0.24 : 0.17;
}

/** Shell inclinations, so moons trace tilted rings rather than one plane. */
export const MOON_TILTS = [0.32, -0.22] as const;

/** A moon's offset from its body at `elapsed` seconds. */
export function moonOffset(
	moon: Pick<Moon, "orbit" | "phase" | "shell">,
	elapsed: number
): [number, number, number] {
	const angle = moon.phase + moonSpeed(moon) * elapsed;
	const tilt = MOON_TILTS[moon.shell === 0 ? 0 : 1];
	const x = Math.cos(angle) * moon.orbit;
	const flat = Math.sin(angle) * moon.orbit;
	return [x, flat * Math.sin(tilt), flat * Math.cos(tilt)];
}

const FIT_SAMPLES = 72;

/** A rectangle in scene pixels (from the scene's top-left corner). */
export interface Box {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** Where the HUD's floating pieces sit over the scene, measured live. */
export interface HudLayout {
	card: Box | null;
	controls: Box | null;
	legend: Box | null;
}

export const EMPTY_HUD: HudLayout = {
	card: null,
	controls: null,
	legend: null,
};

/** Insets (px) that leave a free region of the scene for the picture. */
export interface Insets {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** Breathing room between the HUD and the picture. */
const HUD_GAP = 12;
/**
 * Room name plates need around the outermost bodies: they hang below a body
 * and reach about half their width to each side.
 */
const PLATE_PAD = { bottom: 22, side: 46, top: 8 } as const;

/** Side padding for plates: less on a narrow screen, where they slide in. */
function sidePad(width: number): number {
	return Math.min(PLATE_PAD.side, Math.max(14, width * 0.035));
}

const OVERVIEW_ELEVATION = 0.68;
const PORTRAIT_ELEVATION = 1.18;

/**
 * How steeply the overview looks down: an angled view on a wide screen, and
 * closer to top-down on a tall, narrow one, so the system fills the height
 * instead of becoming a thin ellipse.
 */
export function overviewElevation(width: number, height: number): number {
	const aspect = width / Math.max(1, height);
	const t = Math.min(1, Math.max(0, (1.1 - aspect) / 0.6));
	return OVERVIEW_ELEVATION + (PORTRAIT_ELEVATION - OVERVIEW_ELEVATION) * t;
}

/**
 * The regions of the scene the HUD leaves free: beside the system card (when
 * it shows its list) or below it (when it is folded), always between the
 * controls on top and the legend at the bottom. Framing tries each and keeps
 * whichever shows the picture largest.
 */
export function freeRegions(
	layout: HudLayout,
	viewport: { height: number; width: number }
): Insets[] {
	const { card, controls, legend } = layout;
	const top = controls ? controls.bottom + HUD_GAP : HUD_GAP;
	const bottom = legend
		? Math.max(HUD_GAP, viewport.height - legend.top + HUD_GAP)
		: HUD_GAP;
	const beside: Insets = {
		bottom,
		left: card ? card.right + HUD_GAP : HUD_GAP,
		right: HUD_GAP,
		top,
	};
	if (!card) {
		return [beside];
	}
	const below: Insets = {
		bottom,
		left: HUD_GAP,
		right: HUD_GAP,
		top: Math.max(top, card.bottom + HUD_GAP),
	};
	return [beside, below];
}

/** Projected extent of a ring on the orbital plane, in normalized units. */
interface RingExtent {
	maxX: number;
	maxY: number;
	minY: number;
}

/**
 * Where a ring of `radius` on the orbital plane lands in the frame from a
 * camera `distance` away, looking down at `elevation`. Perspective makes the
 * near side of the ring wider and lower, so every sample is projected.
 */
function ringExtent(
	radius: number,
	distance: number,
	half: number,
	aspect: number,
	elevation: number
): RingExtent | null {
	const cosE = Math.cos(elevation);
	const sinE = Math.sin(elevation);
	// Camera at (0, sinE, cosE) * distance looking at the origin; forward is
	// (0, -sinE, -cosE), up is (0, cosE, -sinE), right is +x.
	const camY = sinE * distance;
	const camZ = cosE * distance;
	const extent: RingExtent = { maxX: 0, maxY: -1, minY: 1 };
	for (let index = 0; index < FIT_SAMPLES; index += 1) {
		const angle = (index / FIT_SAMPLES) * Math.PI * 2;
		const x = Math.cos(angle) * radius;
		const dz = Math.sin(angle) * radius - camZ;
		const depth = camY * sinE - dz * cosE;
		if (depth <= 0.1) {
			return null;
		}
		const up = -camY * cosE - dz * sinE;
		extent.maxX = Math.max(extent.maxX, Math.abs(x / (depth * half * aspect)));
		const y = up / (depth * half);
		extent.maxY = Math.max(extent.maxY, y);
		extent.minY = Math.min(extent.minY, y);
	}
	return extent;
}

export interface OverviewFrame {
	distance: number;
	/** The free region the picture was fitted into. */
	region: Insets;
	/** Pixels to slide the picture right (clear of the HUD) and down. */
	shiftX: number;
	shiftY: number;
}

const FULL_REGION: Insets = {
	bottom: HUD_GAP,
	left: HUD_GAP,
	right: HUD_GAP,
	top: HUD_GAP,
};

/** Usable size of a region once the plates' padding is taken off. */
function regionSize(
	region: Insets,
	viewport: { height: number; width: number },
	padded: boolean
): { height: number; width: number } {
	const side = padded ? sidePad(viewport.width) * 2 : 0;
	const vertical = padded ? PLATE_PAD.top + PLATE_PAD.bottom : 0;
	return {
		height: viewport.height - region.top - region.bottom - vertical,
		width: viewport.width - region.left - region.right - side,
	};
}

/** The candidate regions worth trying, with the whole view as a last resort. */
function usableRegions(
	layout: HudLayout,
	viewport: { height: number; width: number },
	padded: boolean
): Insets[] {
	const regions = freeRegions(layout, viewport).filter((region) => {
		const size = regionSize(region, viewport, padded);
		return size.width >= 120 && size.height >= 120;
	});
	return regions.length > 0 ? regions : [FULL_REGION];
}

/** Fits a ring of `radius` around the target into one free region. */
function fitRing(
	radius: number,
	viewport: { height: number; width: number },
	half: number,
	elevation: number,
	region: Insets
): OverviewFrame {
	const { height, width } = viewport;
	const aspect = width / height;
	const room = regionSize(region, viewport, true);
	const roomWidth = Math.max(40, room.width);
	const roomHeight = Math.max(40, room.height);
	const fits = (distance: number) => {
		const extent = ringExtent(radius, distance, half, aspect, elevation);
		return (
			extent !== null &&
			extent.maxX * width <= roomWidth &&
			((extent.maxY - extent.minY) * height) / 2 <= roomHeight
		);
	};
	let low = radius * 0.3;
	let high = radius * 60;
	for (let step = 0; step < 40; step += 1) {
		const middle = (low + high) / 2;
		if (fits(middle)) {
			high = middle;
		} else {
			low = middle;
		}
	}
	const extent = ringExtent(radius, high, half, aspect, elevation);
	const centre = extent ? (extent.maxY + extent.minY) / 2 : 0;
	const top = region.top + PLATE_PAD.top;
	const bottom = region.bottom + PLATE_PAD.bottom;
	return {
		distance: high,
		region,
		shiftX: (region.left - region.right) / 2,
		shiftY: centre * (height / 2) + (top - bottom) / 2,
	};
}

/**
 * The framing that keeps the system inside one free region (beside or below
 * the card), as a starting point and fallback for the closer fit.
 */
function regionFrame(
	radius: number,
	size: { height: number; width: number },
	half: number,
	elevation: number,
	layout: HudLayout
): OverviewFrame {
	let best: OverviewFrame | null = null;
	for (const region of usableRegions(layout, size, true)) {
		const frame = fitRing(radius, size, half, elevation, region);
		if (!best || frame.distance < best.distance) {
			best = frame;
		}
	}
	return best ?? fitRing(radius, size, half, elevation, FULL_REGION);
}

/** Fractions of the reach sampled for the closer fit (outer orbit inwards). */
const SHAPE_RINGS = [1, 0.78, 0.55, 0.3] as const;
const SHAPE_SAMPLES = 48;
/** Finest grid step (px) when searching for a shift that clears the HUD. */
const SHIFT_STEP = 8;
/** At most this many grid steps per axis, so the search stays cheap. */
const SHIFT_CELLS = 28;
const SHAPE_STEPS = 18;

/**
 * Screen boxes (px, before any shift) around sampled points of the system's
 * rings, padded for the name plates; null when the camera is inside it.
 */
function shapeBoxes(
	radius: number,
	distance: number,
	viewport: { height: number; width: number },
	half: number,
	elevation: number
): Box[] | null {
	const { height, width } = viewport;
	const cosE = Math.cos(elevation);
	const sinE = Math.sin(elevation);
	const camY = sinE * distance;
	const camZ = cosE * distance;
	const side = sidePad(width);
	const boxes: Box[] = [];
	const push = (x: number, z: number) => {
		const dz = z - camZ;
		const depth = camY * sinE - dz * cosE;
		if (depth <= 0.1) {
			return false;
		}
		const up = -camY * cosE - dz * sinE;
		const px = width / 2 + (x / (depth * half)) * (height / 2);
		const py = height / 2 - (up / (depth * half)) * (height / 2);
		boxes.push({
			bottom: py + PLATE_PAD.bottom,
			left: px - side,
			right: px + side,
			top: py - PLATE_PAD.top,
		});
		return true;
	};
	if (!push(0, 0)) {
		return null;
	}
	for (const fraction of SHAPE_RINGS) {
		for (let index = 0; index < SHAPE_SAMPLES; index += 1) {
			const angle = (index / SHAPE_SAMPLES) * Math.PI * 2;
			const ring = radius * fraction;
			if (!push(Math.cos(angle) * ring, Math.sin(angle) * ring)) {
				return null;
			}
		}
	}
	return boxes;
}

function boxesTouch(a: Box, b: Box, dx: number, dy: number): boolean {
	return (
		a.left + dx < b.right &&
		a.right + dx > b.left &&
		a.top + dy < b.bottom &&
		a.bottom + dy > b.top
	);
}

/**
 * A shift (px) that keeps every sampled box on screen and clear of the HUD,
 * as close to `preferred` as the search grid allows; null when none does.
 */
function clearShift(
	boxes: readonly Box[],
	viewport: { height: number; width: number },
	obstacles: readonly Box[],
	preferred: { x: number; y: number }
): { x: number; y: number } | null {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const box of boxes) {
		minX = Math.min(minX, box.left);
		maxX = Math.max(maxX, box.right);
		minY = Math.min(minY, box.top);
		maxY = Math.max(maxY, box.bottom);
	}
	const range = {
		x0: HUD_GAP - minX,
		x1: viewport.width - HUD_GAP - maxX,
		y0: HUD_GAP - minY,
		y1: viewport.height - HUD_GAP - maxY,
	};
	if (range.x0 > range.x1 || range.y0 > range.y1) {
		return null;
	}
	const clamp = (value: number, low: number, high: number) =>
		Math.min(high, Math.max(low, value));
	const steps = (low: number, high: number, wanted: number) => {
		const values = [clamp(wanted, low, high), high];
		const step = Math.max(SHIFT_STEP, (high - low) / SHIFT_CELLS);
		for (let value = low; value < high; value += step) {
			values.push(value);
		}
		return values;
	};
	const xs = steps(range.x0, range.x1, preferred.x);
	const ys = steps(range.y0, range.y1, preferred.y);
	const candidates: { x: number; y: number }[] = [];
	for (const x of xs) {
		for (const y of ys) {
			candidates.push({ x, y });
		}
	}
	const away = (point: { x: number; y: number }) =>
		Math.hypot(point.x - preferred.x, point.y - preferred.y);
	candidates.sort((a, b) => away(a) - away(b));
	for (const shift of candidates) {
		const clear = boxes.every((box) =>
			obstacles.every(
				(obstacle) => !boxesTouch(box, obstacle, shift.x, shift.y)
			)
		);
		if (clear) {
			return shift;
		}
	}
	return null;
}

/**
 * The overview framing: the camera distance that fits a ring of `radius`
 * (the outermost orbit and its planet, or just the inner system), and the
 * shift that places it on screen. The system is an ellipse, so it may tuck
 * its empty corners beside the HUD's cards: every sampled orbit point (with
 * room for its name plate) stays on screen and clear of the HUD, and the
 * camera comes as close as that allows. Perspective otherwise leaves the
 * near side of the system low in frame.
 */
export function overviewFrame(
	radius: number,
	viewport: { height: number; width: number },
	fov: number,
	elevation: number,
	layout: HudLayout = EMPTY_HUD
): OverviewFrame {
	const size = {
		height: Math.max(1, viewport.height),
		width: Math.max(1, viewport.width),
	};
	const half = Math.tan((fov * Math.PI) / 360);
	const start = regionFrame(radius, size, half, elevation, layout);
	const obstacles = [layout.card, layout.controls, layout.legend]
		.filter((box): box is Box => box !== null)
		.map((box) => ({
			bottom: box.bottom + HUD_GAP,
			left: box.left - HUD_GAP,
			right: box.right + HUD_GAP,
			top: box.top - HUD_GAP,
		}));
	const preferred = { x: start.shiftX, y: start.shiftY };
	const attempt = (distance: number) => {
		const boxes = shapeBoxes(radius, distance, size, half, elevation);
		return boxes ? clearShift(boxes, size, obstacles, preferred) : null;
	};
	let high = start.distance;
	let fit = attempt(high);
	if (!fit) {
		return start;
	}
	let low = high * 0.5;
	for (let step = 0; step < SHAPE_STEPS; step += 1) {
		const middle = (low + high) / 2;
		const shift = attempt(middle);
		if (shift) {
			high = middle;
			fit = shift;
		} else {
			low = middle;
		}
	}
	return { distance: high, region: start.region, shiftX: fit.x, shiftY: fit.y };
}

export interface FocusFrame {
	distance: number;
	region: Insets;
	shiftX: number;
	shiftY: number;
}

/**
 * How far to stand from a visited body so it and its moons (with room for
 * their labels) fill the free region, and the shift that centres it there.
 */
export function focusFrame(
	extent: number,
	viewport: { height: number; width: number },
	fov: number,
	layout: HudLayout,
	limits: { margin: number; minDistance: number; minExtents: number }
): FocusFrame {
	const size = {
		height: Math.max(1, viewport.height),
		width: Math.max(1, viewport.width),
	};
	const half = Math.tan((fov * Math.PI) / 360);
	const reach = extent * limits.margin;
	let best: FocusFrame | null = null;
	for (const region of usableRegions(layout, size, false)) {
		const room = regionSize(region, size, false);
		const distance = Math.max(
			limits.minDistance,
			extent * limits.minExtents,
			(reach * size.height) / (half * Math.max(40, room.width)),
			(reach * size.height) / (half * Math.max(40, room.height))
		);
		if (!best || distance < best.distance) {
			best = {
				distance,
				region,
				shiftX: (region.left - region.right) / 2,
				shiftY: (region.top - region.bottom) / 2,
			};
		}
	}
	return (
		best ?? {
			distance: limits.minDistance,
			region: FULL_REGION,
			shiftX: 0,
			shiftY: 0,
		}
	);
}

/** Overlap area of two boxes, in square pixels. */
export function overlapArea(a: Box, b: Box): number {
	const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	return width > 0 && height > 0 ? width * height : 0;
}

export interface ThreadSection {
	status: ThreadStatus;
	threads: InterfaceThread[];
}

/** Threads grouped by status, in the status order, most recent first. */
export function sectionThreads(
	threads: readonly InterfaceThread[]
): ThreadSection[] {
	return THREAD_STATUS_ORDER.map((status) => ({
		status,
		threads: threads
			.filter((thread) => threadStatus(thread) === status)
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || byRecency(a, b)),
	})).filter((section) => section.threads.length > 0);
}

/** Threads where the next move is yours, across the whole system. */
export function threadsWaitingOnYou(
	snapshot: InterfaceSnapshot
): InterfaceThread[] {
	return snapshot.threads
		.filter((thread) => {
			const status = threadStatus(thread);
			return status === "attention" || status === "your-turn";
		})
		.sort(byUrgency);
}

/** One sentence describing a planet, for its accessible name. */
export function planetDescription(planet: Planet): string {
	const parts = [planet.name, plural(planet.threadCount, "thread")];
	if (planet.working) {
		parts.push("working");
	}
	const needsYou = planet.counts.attention + planet.counts["your-turn"];
	if (needsYou > 0) {
		parts.push(`${needsYou} waiting on you`);
	}
	return parts.join(", ");
}

/** The next or previous planet id in orbit order, wrapping around. */
export function cyclePlanet(
	planets: readonly Pick<Planet, "id">[],
	currentId: string | null,
	step: 1 | -1
): string | null {
	if (planets.length === 0) {
		return null;
	}
	const index = planets.findIndex((planet) => planet.id === currentId);
	if (index === -1) {
		return (step === 1 ? planets[0] : planets.at(-1))?.id ?? null;
	}
	const next = (index + step + planets.length) % planets.length;
	return planets[next]?.id ?? null;
}

/** Orbits a loading sketch draws before there is a system to show. */
const SKETCH_ORBITS = [11, 18, 25, 32] as const;

export interface OverviewSketch {
	/** Where the star sits in the scene, px from its top-left corner. */
	centre: { x: number; y: number };
	/** Each orbit as an SVG path in scene px, projected as the camera sees it. */
	orbits: string[];
	/** The star's radius, px. */
	sunRadius: number;
}

const SKETCH_SAMPLES = 96;

/**
 * Where the overview will put the star and its orbits, in px, so a loading
 * placeholder can sit exactly where the scene will draw: the same framing,
 * projected through the same perspective camera.
 */
export function overviewSketch(
	system: Pick<PlanetSystem, "planets" | "systemRadius">,
	viewport: { height: number; width: number },
	layout: HudLayout = EMPTY_HUD,
	/** How much farther out than the overview the camera stands (the intro). */
	distanceScale = 1
): OverviewSketch {
	const width = Math.max(1, viewport.width);
	const height = Math.max(1, viewport.height);
	const empty = system.planets.length === 0;
	const reach = empty
		? (SKETCH_ORBITS.at(-1) ?? 32) + 2
		: overviewReach(system);
	const elevation = overviewElevation(width, height);
	const frame = overviewFrame(reach, { height, width }, FOV, elevation, layout);
	const half = Math.tan((FOV * Math.PI) / 360);
	const cosE = Math.cos(elevation);
	const sinE = Math.sin(elevation);
	const distance = frame.distance * distanceScale;
	const camY = sinE * distance;
	const camZ = cosE * distance;
	// The camera looks at the star from (0, camY, camZ); orbits are circles
	// about the star, so the overview's azimuth does not change their shape.
	const project = (x: number, z: number) => {
		const dz = z - camZ;
		const depth = Math.max(0.1, camY * sinE - dz * cosE);
		const up = -camY * cosE - dz * sinE;
		return {
			x: width / 2 + frame.shiftX + (x / (depth * half)) * (height / 2),
			y: height / 2 + frame.shiftY - (up / (depth * half)) * (height / 2),
		};
	};
	const radii = empty
		? [...SKETCH_ORBITS]
		: system.planets.map((planet) => planet.orbitRadius);
	const orbits = radii.map((radius) => {
		const points: string[] = [];
		for (let index = 0; index < SKETCH_SAMPLES; index += 1) {
			const angle = (index / SKETCH_SAMPLES) * Math.PI * 2;
			const point = project(Math.cos(angle) * radius, Math.sin(angle) * radius);
			points.push(`${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
		}
		return `M${points.join("L")}Z`;
	});
	const centre = project(0, 0);
	const unit = height / 2 / (distance * half);
	return {
		centre,
		orbits,
		sunRadius: SUN_RADIUS * unit,
	};
}

/** How far a column planet sits to the side of the star's line (world units). */
export const COLUMN_SIDE = 2.8;
/** Column bodies swell less than the overview's, so stacked worlds never touch. */
export const COLUMN_BODY_SCALE = 1.75;

/**
 * The system laid out for a portrait screen: each planet stops orbiting and
 * holds still on its own orbit straight down the screen from the star,
 * alternating a little left and right, so the worlds stack in a column with
 * the star at the top. `toward` is the camera's azimuth (its side of the
 * star), so "down the screen" is toward it.
 */
export function columnSystem(
	system: PlanetSystem,
	toward: number
): PlanetSystem {
	const down = Math.PI / 2 - toward;
	return {
		...system,
		column: true,
		planets: system.planets.map((planet, index) => {
			const side = index % 2 === 0 ? -1 : 1;
			const swing = Math.asin(
				Math.min(0.9, COLUMN_SIDE / Math.max(planet.orbitRadius, 0.1))
			);
			return { ...planet, orbitSpeed: 0, phase: down + side * swing };
		}),
	};
}

/**
 * The system with every planet holding its place on its orbit (the act
 * layer: the station's plates and each world's signs stay readable).
 */
export function holdOrbits(system: PlanetSystem): PlanetSystem {
	return {
		...system,
		planets: system.planets.map((planet) => ({ ...planet, orbitSpeed: 0 })),
	};
}

/** A camera framing: where it looks, how far back, and the view offset (px). */
export interface ColumnFrame {
	distance: number;
	shift: [number, number];
	/** The look-at point on the orbital plane, toward the camera from the star. */
	toward: number;
}

/**
 * Frames a column system top-down: the star near the top of the free room
 * between `top` and `bottom` (px) and the outermost world near its bottom,
 * as wide as the screen allows. `toward` (world units) is how far the look-at
 * point sits from the star toward the camera.
 */
export function columnFrame(
	system: Pick<PlanetSystem, "planets">,
	viewport: { height: number; width: number },
	fov: number,
	elevation: number,
	room: { bottom: number; top: number },
	bodyScale = COLUMN_BODY_SCALE
): ColumnFrame {
	let far = SUN_RADIUS * 3;
	let wide = SUN_RADIUS * 2;
	for (const planet of system.planets) {
		const body = planet.radius * bodyScale;
		far = Math.max(far, planet.orbitRadius + body);
		wide = Math.max(wide, COLUMN_SIDE + body + planet.extent * 0.6);
	}
	const near = SUN_RADIUS * 2.2;
	// Depth on the plane reads foreshortened; bodies stand up out of it.
	const tall = (far + near) * Math.sin(elevation) + 4.5;
	const across = wide * 2 + 3;
	const freeHeight = Math.max(80, viewport.height - room.top - room.bottom);
	const half = Math.tan((fov * Math.PI) / 360);
	const aspect = viewport.width / Math.max(1, viewport.height);
	// Distance so `tall` fills the free height and `across` the width.
	const byHeight = (tall / 2 / half) * (viewport.height / freeHeight);
	const byWidth = across / 2 / (half * aspect);
	return {
		distance: Math.max(byHeight, byWidth),
		shift: [0, (room.top - room.bottom) / 2],
		toward: (far - near) / 2,
	};
}

/**
 * The free room (px from the top and the bottom) a column frame keeps clear
 * of the HUD: below whatever sits in the upper half, above whatever sits in
 * the lower half (a bottom sheet, the legend).
 */
export function columnRoom(
	layout: HudLayout,
	height: number
): { bottom: number; top: number } {
	let top = HUD_GAP;
	let bottom = HUD_GAP;
	for (const box of [layout.card, layout.controls, layout.legend]) {
		if (!box) {
			continue;
		}
		if ((box.top + box.bottom) / 2 < height / 2) {
			top = Math.max(top, box.bottom + HUD_GAP);
		} else {
			bottom = Math.max(bottom, height - box.top + HUD_GAP);
		}
	}
	return { bottom, top };
}
