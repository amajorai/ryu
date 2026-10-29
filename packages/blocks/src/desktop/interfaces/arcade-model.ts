import {
	type InterfaceAgent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { SKIN_COUNT } from "./arcade-palette.ts";

/**
 * Arcade view model: every agent is a slot machine; its three most recent
 * conversations are the reels; replies waiting on you are the payout; a
 * failed run tilts the machine. Projects and teams are the arcade cabinets
 * on the back wall, and picking one filters the floor to its machines.
 * Pure, so the floor can be tested without rendering.
 */

export type ReelSymbol =
	| "bar"
	| "bell"
	| "blank"
	| "cherry"
	| "flame"
	| "seven";

/** The paytable: which symbol a conversation's status lands on. */
export const STATUS_SYMBOL: Record<ThreadStatus, ReelSymbol> = {
	attention: "flame",
	quiet: "cherry",
	waiting: "bar",
	working: "seven",
	"your-turn": "bell",
};

export const SYMBOL_NAMES: Record<ReelSymbol, string> = {
	bar: "Bar",
	bell: "Bell",
	blank: "Blank",
	cherry: "Cherry",
	flame: "Flame",
	seven: "Seven",
};

/** The order the strip runs past the window while a reel spins. */
export const SPIN_STRIP: readonly ReelSymbol[] = [
	"seven",
	"cherry",
	"bell",
	"bar",
	"flame",
	"cherry",
];

export const REEL_COUNT = 3;

export interface Reel {
	status: ThreadStatus | null;
	symbol: ReelSymbol;
	thread: InterfaceThread | null;
}

export type MarqueeShape = "arch" | "crown" | "flat";
const MARQUEE_SHAPES: readonly MarqueeShape[] = ["arch", "crown", "flat"];

/**
 * Any reply waiting on you lights the JACKPOT topper. It chases only while
 * the reply is fresh and on the machine's pay line (its newest
 * conversation); older replies hold the topper on a steady lamp.
 */
export const HOT_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface Machine {
	agent: InterfaceAgent;
	/**
	 * Messages in the conversations this machine leads. A conversation with
	 * several agents pays out on its first agent's machine only, so the
	 * machines' credits add up to the floor's.
	 */
	credits: number;
	/** The topper chases: the newest conversation is a fresh reply waiting on you. */
	hot: boolean;
	id: string;
	/**
	 * Replies waiting on you on this machine, newest first: the payout
	 * tray. A shared conversation drops a ticket in every member's tray, so
	 * every bell on a reel has a ticket to collect; the HUD counts each
	 * reply once.
	 */
	jackpots: InterfaceThread[];
	marquee: MarqueeShape;
	name: string;
	reels: Reel[];
	/** A run is live on this machine. */
	running: boolean;
	skin: number;
	/** Every conversation on this machine (led or shared), newest first. */
	threads: InterfaceThread[];
	/** The newest failed or interrupted run, when one needs attention. */
	tilt: InterfaceThread | null;
}

export interface WallCabinet {
	group: InterfaceGroup;
	jackpots: number;
	machines: number;
	running: number;
}

export interface ArcadeTotals {
	credits: number;
	jackpots: number;
	machines: number;
	running: number;
	tilts: number;
}

export interface ArcadeFloor {
	filter: InterfaceGroup | null;
	machines: Machine[];
	/**
	 * Every conversation in view, once each: the machines' plus those with
	 * no agent (which have no machine, but still count and can be collected).
	 */
	threads: InterfaceThread[];
	totals: ArcadeTotals;
	wall: WallCabinet[];
}

/** Small stable hash, so a machine keeps its finish and marquee across renders. */
export function hashId(id: string): number {
	let hash = 2_166_136_261;
	for (const char of id) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

function blankReel(): Reel {
	return { status: null, symbol: "blank", thread: null };
}

export function reelFor(thread: InterfaceThread | undefined): Reel {
	if (!thread) {
		return blankReel();
	}
	const status = threadStatus(thread);
	return { status, symbol: STATUS_SYMBOL[status], thread };
}

function buildMachine(
	agent: InterfaceAgent,
	threads: InterfaceThread[],
	leads: (thread: InterfaceThread) => boolean,
	now: number
): Machine {
	const sorted = [...threads].sort(byRecency);
	const reels: Reel[] = [];
	for (let index = 0; index < REEL_COUNT; index += 1) {
		reels.push(reelFor(sorted[index]));
	}
	const led = sorted.filter(leads);
	let credits = 0;
	for (const thread of led) {
		credits += thread.messageCount;
	}
	const hash = hashId(agent.id);
	const newest = sorted[0];
	const running =
		agent.status === "working" ||
		sorted.some((thread) => threadStatus(thread) === "working");
	return {
		agent,
		credits,
		hot:
			newest !== undefined &&
			threadStatus(newest) === "your-turn" &&
			now - Date.parse(newest.updatedAt) < HOT_WINDOW_MS,
		id: agent.id,
		jackpots: sorted.filter((thread) => threadStatus(thread) === "your-turn"),
		marquee: MARQUEE_SHAPES[(hash >>> 4) % MARQUEE_SHAPES.length] ?? "flat",
		name: agent.name,
		reels,
		running,
		skin: hash % SKIN_COUNT,
		threads: sorted,
		tilt: sorted.find((thread) => threadStatus(thread) === "attention") ?? null,
	};
}

/**
 * The floor's clock: the host's `observedAt` when it sends one, else the
 * newest conversation's time, so what is "fresh" depends on the snapshot
 * alone (stable proofs, no wall-clock flakes).
 */
export function snapshotNow(snapshot: InterfaceSnapshot): number {
	const observed = snapshot.observedAt
		? Date.parse(snapshot.observedAt)
		: Number.NaN;
	if (Number.isFinite(observed)) {
		return observed;
	}
	let newest = Number.NEGATIVE_INFINITY;
	for (const thread of snapshot.threads) {
		const time = Date.parse(thread.updatedAt);
		if (time > newest) {
			newest = time;
		}
	}
	return Number.isFinite(newest) ? newest : 0;
}

function inGroup(thread: InterfaceThread, groupId: string): boolean {
	return thread.projectId === groupId || thread.teamId === groupId;
}

function countTotals(
	machines: Machine[],
	threads: InterfaceThread[]
): ArcadeTotals {
	let credits = 0;
	let jackpots = 0;
	let tilts = 0;
	for (const thread of threads) {
		credits += thread.messageCount;
		const status = threadStatus(thread);
		if (status === "your-turn") {
			jackpots += 1;
		} else if (status === "attention") {
			tilts += 1;
		}
	}
	return {
		credits,
		jackpots,
		machines: machines.length,
		running: machines.filter((machine) => machine.running).length,
		tilts,
	};
}

function wallCabinet(
	group: InterfaceGroup,
	snapshot: InterfaceSnapshot
): WallCabinet {
	const members = new Set(group.memberAgentIds);
	const threads = snapshot.threads.filter((thread) =>
		inGroup(thread, group.id)
	);
	return {
		group,
		jackpots: threads.filter((thread) => threadStatus(thread) === "your-turn")
			.length,
		machines: snapshot.agents.filter((agent) => members.has(agent.id)).length,
		running: threads.filter((thread) => threadStatus(thread) === "working")
			.length,
	};
}

/**
 * The floor for a snapshot: one machine per agent (in the host's order),
 * narrowed to a project or team's agents when `groupId` names one.
 * Conversations with no agent get no machine (there is nobody to pull the
 * lever for), but they still count on the meters and can be collected.
 */
export function buildFloor(
	snapshot: InterfaceSnapshot,
	groupId: string | null,
	now: number = snapshotNow(snapshot)
): ArcadeFloor {
	const filter = groupId
		? (snapshot.groups.find((group) => group.id === groupId) ?? null)
		: null;
	const members = filter ? new Set(filter.memberAgentIds) : null;
	const byAgent = new Map<string, InterfaceThread[]>();
	const unassigned: InterfaceThread[] = [];
	for (const thread of snapshot.threads) {
		if (thread.agentIds.length === 0) {
			unassigned.push(thread);
			continue;
		}
		for (const agentId of thread.agentIds) {
			const list = byAgent.get(agentId) ?? [];
			list.push(thread);
			byAgent.set(agentId, list);
		}
	}
	const onFloor = snapshot.agents.filter(
		(agent) => !members || members.has(agent.id)
	);
	const floorIds = new Set(onFloor.map((agent) => agent.id));
	const machines: Machine[] = [];
	const inView = new Map<string, InterfaceThread>();
	for (const agent of onFloor) {
		const leads = (thread: InterfaceThread) =>
			thread.agentIds.find((agentId) => floorIds.has(agentId)) === agent.id;
		const machine = buildMachine(
			agent,
			byAgent.get(agent.id) ?? [],
			leads,
			now
		);
		machines.push(machine);
		for (const thread of machine.threads) {
			inView.set(thread.id, thread);
		}
	}
	for (const thread of unassigned) {
		if (!filter || inGroup(thread, filter.id)) {
			inView.set(thread.id, thread);
		}
	}
	const threads = [...inView.values()].sort(byRecency);
	return {
		filter,
		machines,
		threads,
		totals: countTotals(machines, threads),
		wall: snapshot.groups.map((group) => wallCabinet(group, snapshot)),
	};
}

/**
 * Which reels run: those on a conversation that is working, every reel
 * while a message has just gone in, or the first reel of a running machine
 * whose reels show nothing working. The rest stay settled on their symbols.
 */
export function spinningReels(machine: Machine, feedback: boolean): boolean[] {
	if (feedback) {
		return machine.reels.map(() => true);
	}
	const working = machine.reels.map((reel) => reel.status === "working");
	if (machine.running && !working.includes(true)) {
		working[0] = true;
	}
	return working;
}

/** Other agents on a shared conversation, for a ticket's label. */
export function sharedWith(
	thread: InterfaceThread,
	machine: Machine,
	agents: readonly InterfaceAgent[]
): string[] {
	const names: string[] = [];
	for (const agentId of thread.agentIds) {
		if (agentId === machine.id) {
			continue;
		}
		const agent = agents.find((item) => item.id === agentId);
		if (agent) {
			names.push(agent.name);
		}
	}
	return names;
}

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Credits on the LED meter: four digits, zero padded, the way meters read. */
export function meterDigits(value: number, width = 4): string {
	const whole = Math.max(0, Math.floor(value));
	return String(whole).padStart(width, "0");
}

export function reelLabel(reel: Reel): string {
	if (!(reel.thread && reel.status)) {
		return "Empty reel";
	}
	const title = reel.thread.title.trim() || "Untitled conversation";
	return `${title}: ${THREAD_STATUS_LABELS[reel.status]}`;
}

/** One sentence for screen readers that sums up a machine. */
export function machineSummary(machine: Machine): string {
	const parts = [
		`${machine.name}`,
		machine.running ? "running" : "idle",
		plural(machine.credits, "credit"),
	];
	if (machine.jackpots.length > 0) {
		parts.push(`${plural(machine.jackpots.length, "reply")} waiting on you`);
	}
	if (machine.tilt) {
		parts.push("a run needs attention");
	}
	return parts.join(", ");
}

export interface ScoreRow {
	key: "jackpots" | "machines" | "running";
	label: string;
	value: number;
}

/** The high-score table a wall cabinet shows in attract mode. */
export function scoreRows(cabinet: WallCabinet): ScoreRow[] {
	return [
		{ key: "machines", label: "MACHINES", value: cabinet.machines },
		{ key: "jackpots", label: "JACKPOTS", value: cabinet.jackpots },
		{ key: "running", label: "RUNNING", value: cabinet.running },
	];
}

/** Screen-reader name for a wall cabinet button. */
export function wallCabinetLabel(
	cabinet: WallCabinet,
	active: boolean,
	/** With the act layer the jackpot count (legacy statuses) is left out. */
	acted = false
): string {
	const kind = cabinet.group.kind === "team" ? "team" : "project";
	const counts = [
		plural(cabinet.machines, "machine"),
		acted ? null : `${cabinet.jackpots} waiting on you`,
		`${cabinet.running} running`,
	]
		.filter(Boolean)
		.join(", ");
	return active
		? `Show every machine (now showing ${kind} ${cabinet.group.name}: ${counts})`
		: `Show ${kind} ${cabinet.group.name}: ${counts}`;
}

/** The reply that has waited longest on the floor: what "Collect" opens next. */
export function nextJackpot(floor: ArcadeFloor): InterfaceThread | undefined {
	let oldest: InterfaceThread | undefined;
	for (const thread of floor.threads) {
		if (threadStatus(thread) !== "your-turn") {
			continue;
		}
		if (!oldest || thread.updatedAt < oldest.updatedAt) {
			oldest = thread;
		}
	}
	return oldest;
}

export interface ComposeInput {
	agentId?: string;
	projectId?: string;
	prompt: string;
	teamId?: string;
}

/**
 * What a pulled lever sends: the machine's agent, filed under the cabinet
 * the floor is filtered to, with the prompt the user typed.
 */
export function composeInput(
	machine: Machine,
	filter: InterfaceGroup | null,
	prompt: string
): ComposeInput {
	const input: ComposeInput = { agentId: machine.agent.id, prompt };
	if (filter?.kind === "project") {
		input.projectId = filter.id;
	} else if (filter?.kind === "team") {
		input.teamId = filter.id;
	}
	return input;
}

export function threadTitle(thread: InterfaceThread | undefined): string {
	return thread?.title.trim() || "Untitled conversation";
}

export interface Point {
	x: number;
	y: number;
}

/** Marquee outline in a `width` x `height` box, as an SVG path. */
export function marqueePath(
	shape: MarqueeShape,
	width: number,
	height: number
): string {
	const w = width;
	const h = height;
	if (shape === "arch") {
		return `M0 ${h} V26 C0 8 ${w * 0.22} 0 ${w / 2} 0 C${w * 0.78} 0 ${w} 8 ${w} 26 V${h} Z`;
	}
	if (shape === "crown") {
		return `M0 ${h} V18 H${w * 0.2} V8 H${w * 0.34} V0 H${w * 0.66} V8 H${w * 0.8} V18 H${w} V${h} Z`;
	}
	return `M8 0 H${w - 8} Q${w} 0 ${w} 8 V${h} H0 V8 Q0 0 8 0 Z`;
}

function cubicPoint(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	t: number
): Point {
	const u = 1 - t;
	return {
		x:
			u * u * u * p0.x +
			3 * u * u * t * p1.x +
			3 * u * t * t * p2.x +
			t ** 3 * p3.x,
		y:
			u * u * u * p0.y +
			3 * u * u * t * p1.y +
			3 * u * t * t * p2.y +
			t ** 3 * p3.y,
	};
}

/** The closed loop the bulbs sit on, `inset` inside the marquee outline. */
function bulbLoop(
	shape: MarqueeShape,
	width: number,
	height: number,
	inset: number
): Point[] {
	const left = inset;
	const right = width - inset;
	const bottom = height - inset;
	if (shape === "arch") {
		const points: Point[] = [{ x: left, y: bottom }];
		const start = { x: left, y: 26 };
		const mid = { x: width / 2, y: inset };
		const end = { x: right, y: 26 };
		for (let step = 0; step <= 12; step += 1) {
			points.push(
				cubicPoint(
					start,
					{ x: left, y: 10 + inset / 2 },
					{ x: width * 0.22, y: inset },
					mid,
					step / 12
				)
			);
		}
		for (let step = 1; step <= 12; step += 1) {
			points.push(
				cubicPoint(
					mid,
					{ x: width * 0.78, y: inset },
					{ x: right, y: 10 + inset / 2 },
					end,
					step / 12
				)
			);
		}
		points.push({ x: right, y: bottom });
		return points;
	}
	if (shape === "crown") {
		const step1 = 18 + inset;
		const step2 = 8 + inset;
		const top = inset;
		return [
			{ x: left, y: bottom },
			{ x: left, y: step1 },
			{ x: width * 0.2 + inset, y: step1 },
			{ x: width * 0.2 + inset, y: step2 },
			{ x: width * 0.34 + inset, y: step2 },
			{ x: width * 0.34 + inset, y: top },
			{ x: width * 0.66 - inset, y: top },
			{ x: width * 0.66 - inset, y: step2 },
			{ x: width * 0.8 - inset, y: step2 },
			{ x: width * 0.8 - inset, y: step1 },
			{ x: right, y: step1 },
			{ x: right, y: bottom },
		];
	}
	return [
		{ x: left, y: bottom },
		{ x: left, y: inset },
		{ x: right, y: inset },
		{ x: right, y: bottom },
	];
}

/**
 * `count` evenly spaced bulb centres around the marquee (up the left side,
 * over the top, down the right, and back along the bottom).
 */
export function marqueeBulbs(
	shape: MarqueeShape,
	width: number,
	height: number,
	count: number,
	inset = 6
): Point[] {
	const loop = bulbLoop(shape, width, height, inset);
	const first = loop[0];
	if (!first || count <= 0) {
		return [];
	}
	const closed = [...loop, first];
	const lengths: number[] = [0];
	for (let index = 1; index < closed.length; index += 1) {
		const a = closed[index - 1] ?? first;
		const b = closed[index] ?? first;
		lengths.push((lengths[index - 1] ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
	}
	const total = lengths.at(-1) ?? 0;
	const bulbs: Point[] = [];
	let segment = 1;
	for (let bulb = 0; bulb < count; bulb += 1) {
		const target = (bulb / count) * total;
		while (segment < closed.length - 1 && (lengths[segment] ?? 0) < target) {
			segment += 1;
		}
		const a = closed[segment - 1] ?? first;
		const b = closed[segment] ?? first;
		const from = lengths[segment - 1] ?? 0;
		const span = (lengths[segment] ?? 0) - from || 1;
		const t = (target - from) / span;
		bulbs.push({
			x: Math.round((a.x + (b.x - a.x) * t) * 10) / 10,
			y: Math.round((a.y + (b.y - a.y) * t) * 10) / 10,
		});
	}
	return bulbs;
}

/**
 * The machine an open conversation was cashed from: `preferredId` when that
 * machine holds it, otherwise its first agent's machine on the floor.
 */
export function machineForThread(
	floor: ArcadeFloor,
	thread: InterfaceThread | undefined,
	preferredId: string | null = null
): Machine | undefined {
	if (!thread) {
		return undefined;
	}
	if (preferredId && thread.agentIds.includes(preferredId)) {
		const preferred = floor.machines.find((item) => item.id === preferredId);
		if (preferred) {
			return preferred;
		}
	}
	for (const agentId of thread.agentIds) {
		const machine = floor.machines.find((item) => item.id === agentId);
		if (machine) {
			return machine;
		}
	}
	return undefined;
}

/** A machine's footprint at full size: cabinet plus lever, and the aisle between. */
export const SLOT_FOOTPRINT = 228;
export const SLOT_AISLE = 24;
/** A machine's height at full size, topper slot to plinth. */
export const SLOT_HEIGHT = 356;
export const ROW_GAP = 40;
/** The smallest zoom a machine is drawn at (a short floor shrinks them). */
export const MIN_FLOOR_ZOOM = 0.8;
export const MAX_FLOOR_ZOOM = 1.5;
/**
 * At most this many machines stand in view at once; the rest line the
 * aisle, which scrolls sideways. Fewer, bigger machines read as a casino
 * floor, with legible reels and meters, instead of a wall of thumbnails.
 */
export const AISLE_VIEW = 4;
/** Machines in view are at least this big when the floor allows. */
const COMFORT_ZOOM = 1.15;

export interface FloorFit {
	/** Every machine stands in one row along the aisle. */
	columns: number;
	/** More machines than fit in view: the aisle scrolls sideways. */
	overflow: boolean;
	rows: number;
	/** How many machines are in view at once. */
	view: number;
	zoom: number;
}

/** The bank's width in unzoomed pixels for `columns` machines. */
export function bankWidth(columns: number): number {
	return columns * (SLOT_FOOTPRINT + SLOT_AISLE) - SLOT_AISLE;
}

/** The bank's height in unzoomed pixels for `rows` rows. */
export function bankHeight(rows: number): number {
	return rows * (SLOT_HEIGHT + ROW_GAP) - ROW_GAP;
}

function roundDown(value: number): number {
	return Math.floor(value * 100) / 100;
}

/**
 * How the machines fill a floor `width` x `height` pixels: one row along
 * the aisle with up to AISLE_VIEW machines in view, as large as the floor
 * allows (up to MAX_FLOOR_ZOOM). Fewer machines stand in view when the
 * width would shrink them below a comfortable size; a phone shows one at a
 * time.
 */
export function floorFit(
	count: number,
	width: number,
	height: number = Number.POSITIVE_INFINITY
): FloorFit {
	if (count <= 0 || width <= 0 || !Number.isFinite(width)) {
		const columns = Math.max(1, count);
		return { columns, overflow: false, rows: 1, view: columns, zoom: 1 };
	}
	// As many as stand in view at a comfortable size, up to AISLE_VIEW.
	const comfortable = Math.floor(
		(width / COMFORT_ZOOM + SLOT_AISLE) / (SLOT_FOOTPRINT + SLOT_AISLE)
	);
	const view = Math.max(1, Math.min(count, AISLE_VIEW, comfortable));
	const byWidth = width / bankWidth(view);
	const byHeight =
		height > 0 ? height / bankHeight(1) : Number.POSITIVE_INFINITY;
	return {
		columns: count,
		overflow: count > view,
		rows: 1,
		view,
		// A very short floor keeps the machines legible and scrolls instead.
		zoom: roundDown(
			Math.max(
				Math.min(MIN_FLOOR_ZOOM, byWidth),
				Math.min(byWidth, byHeight, MAX_FLOOR_ZOOM)
			)
		),
	};
}

/** Marquee lettering size that keeps `name` inside `room` pixels of the sign. */
export function marqueeFontSize(
	name: string,
	room: number,
	largest: number,
	smallest: number
): number {
	// Uppercase heading glyphs with 0.08em tracking run about 0.78em wide.
	const fit = room / (Math.max(1, name.trim().length) * 0.78);
	return Math.max(smallest, Math.min(largest, Math.floor(fit)));
}

export interface PaytableLine {
	count: number;
	label: string;
	status: ThreadStatus;
	symbol: ReelSymbol;
}

/** The paytable under the bank: each symbol, what it means, and how many are out. */
export function paytable(floor: ArcadeFloor): PaytableLine[] {
	const counts = new Map<ThreadStatus, number>();
	for (const thread of floor.threads) {
		const status = threadStatus(thread);
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	return THREAD_STATUS_ORDER.map((status) => ({
		count: counts.get(status) ?? 0,
		label: THREAD_STATUS_LABELS[status],
		status,
		symbol: STATUS_SYMBOL[status],
	}));
}
