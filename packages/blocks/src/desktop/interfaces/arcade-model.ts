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

export {
	AISLE_VIEW,
	bankHeight,
	bankWidth,
	type FloorFit,
	floorFit,
	MAX_FLOOR_ZOOM,
	MIN_FLOOR_ZOOM,
	marqueeFontSize,
	ROW_GAP,
	SLOT_AISLE,
	SLOT_FOOTPRINT,
	SLOT_HEIGHT,
} from "./arcade-model-floor-fit.ts";
export {
	machineSummary,
	meterDigits,
	plural,
	reelLabel,
	type ScoreRow,
	scoreRows,
	wallCabinetLabel,
} from "./arcade-model-labels.ts";
export {
	marqueeBulbs,
	marqueePath,
	type Point,
} from "./arcade-model-marquee.ts";

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
