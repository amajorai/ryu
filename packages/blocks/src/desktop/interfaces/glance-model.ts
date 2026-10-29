import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { agentHue } from "./interface-renderer.ts";

// ---------------------------------------------------------------------------
// Faces, distance, and views
// ---------------------------------------------------------------------------

export type GlanceFace = "agents" | "clock" | "flow";

export const GLANCE_FACES: readonly GlanceFace[] = ["clock", "agents", "flow"];

export const GLANCE_FACE_LABELS: Record<GlanceFace, string> = {
	agents: "Agents",
	clock: "Clock",
	flow: "Flow",
};

/** How far the viewer is: Far shows a few large facts, Near adds detail. */
export type GlanceDistance = "far" | "near";

/** What the Distance control holds: a fixed distance, or a slow demo cycle. */
export type GlanceDistanceMode = GlanceDistance | "auto";

export const GLANCE_DISTANCE_MODES: readonly {
	label: string;
	value: GlanceDistanceMode;
}[] = [
	{ label: "Far", value: "far" },
	{ label: "Near", value: "near" },
	{ label: "Auto", value: "auto" },
];

export function isGlanceDistanceMode(
	value: unknown
): value is GlanceDistanceMode {
	return value === "far" || value === "near" || value === "auto";
}

/** How long Auto holds each distance before stepping to the other. */
export const GLANCE_AUTO_INTERVAL_MS = 9000;

/** The face `delta` steps away, wrapping like a carousel of faces. */
export function stepGlanceFace(face: GlanceFace, delta: number): GlanceFace {
	const count = GLANCE_FACES.length;
	const index = GLANCE_FACES.indexOf(face);
	const next = (((index + delta) % count) + count) % count;
	return GLANCE_FACES[next] ?? "clock";
}

export type GlanceKeyAction = "close" | "next" | "previous";

/** The page-level keys Glance answers to. */
export function glanceKeyAction(event: {
	altKey: boolean;
	ctrlKey: boolean;
	key: string;
	metaKey: boolean;
}): GlanceKeyAction | null {
	if (event.altKey || event.ctrlKey || event.metaKey) {
		return null;
	}
	switch (event.key) {
		case "ArrowRight":
			return "next";
		case "ArrowLeft":
			return "previous";
		case "Escape":
			return "close";
		default:
			return null;
	}
}

/** True while typing, so arrow keys stay with the text field. */
export function isGlanceTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) {
		return false;
	}
	return (
		target.closest(
			"input, textarea, select, [contenteditable=''], [contenteditable='true']"
		) !== null
	);
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const STATUS_RANK = new Map<ThreadStatus, number>(
	THREAD_STATUS_ORDER.map((status, index) => [status, index])
);

function newestFirst(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Most urgent status first, newest first within a status. */
export function byGlanceUrgency(
	a: InterfaceThread,
	b: InterfaceThread
): number {
	const rank =
		(STATUS_RANK.get(threadStatus(a)) ?? 0) -
		(STATUS_RANK.get(threadStatus(b)) ?? 0);
	return rank || newestFirst(a, b);
}

/** Threads whose next move is yours: failed runs first, then replies. */
export function glanceWaitingOnYou(
	snapshot: InterfaceSnapshot
): InterfaceThread[] {
	return snapshot.threads
		.filter((thread) => {
			const status = threadStatus(thread);
			return status === "attention" || status === "your-turn";
		})
		.sort(byGlanceUrgency);
}

/** Threads with a live run, newest first. */
export function glanceWorking(snapshot: InterfaceSnapshot): InterfaceThread[] {
	return snapshot.threads.filter((thread) => thread.running).sort(newestFirst);
}

/** Threads where you wrote last and the agent has not started. */
export function glanceWaitingOnAgent(
	snapshot: InterfaceSnapshot
): InterfaceThread[] {
	return snapshot.threads
		.filter((thread) => threadStatus(thread) === "waiting")
		.sort(newestFirst);
}

/**
 * The one name for the set whose next move is yours (failed runs and
 * replies alike). Every face and widget titles that set with it; each row
 * keeps its own status mark.
 */
export const GLANCE_NEEDS_YOU_LABEL = "Needs you";

/** The one line the clock face carries. */
export function glanceWaitingLine(count: number): string {
	if (count <= 0) {
		return "Nothing needs you";
	}
	return count === 1 ? "1 thread needs you" : `${count} threads need you`;
}

/**
 * How many rows a list shows when it holds `capacity` at most: everything
 * when it all fits, otherwise one row fewer so a "N more" line takes the
 * last slot.
 */
export function glanceListWindow(
	total: number,
	capacity: number
): { hidden: number; shown: number } {
	if (total <= capacity) {
		return { hidden: 0, shown: total };
	}
	const shown = Math.max(capacity - 1, 0);
	return { hidden: total - shown, shown };
}

/** A thread's title, falling back to its opening words. */
export function glanceThreadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || "Untitled thread";
}

/**
 * The team or project a shared thread lives in, so two agents' tiles that
 * show the same thread read as one conversation, not a repeat. Null for a
 * one-agent thread or one outside any group.
 */
export function glanceSharedGroup(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string | null {
	if (thread.agentIds.length < 2) {
		return null;
	}
	const groupId = thread.teamId ?? thread.projectId;
	if (!groupId) {
		return null;
	}
	return snapshot.groups.find((group) => group.id === groupId)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Agents (the modular tiles)
// ---------------------------------------------------------------------------

/** An agent tile's state, most pressing first. */
export type GlanceAgentState =
	| "attention"
	| "idle"
	| "waiting"
	| "working"
	| "your-turn";

export const GLANCE_AGENT_STATE_LABELS: Record<GlanceAgentState, string> = {
	attention: "Needs attention",
	idle: "Idle",
	waiting: "Waiting",
	working: "Working",
	"your-turn": "Your turn",
};

export interface GlanceAgentTile {
	/** "On" tiles (working or needing you) render bright, like Home's lit accessories. */
	active: boolean;
	agent: InterfaceAgent;
	state: GlanceAgentState;
	/** The thread a tap opens: the live one, else the most urgent, else the newest. */
	thread: InterfaceThread | null;
	threadCount: number;
}

function agentState(
	agent: InterfaceAgent,
	thread: InterfaceThread | null
): GlanceAgentState {
	if (agent.status === "working") {
		return "working";
	}
	if (!thread) {
		return "idle";
	}
	const status = threadStatus(thread);
	if (status === "quiet") {
		return "idle";
	}
	return status;
}

/** One tile per agent, in the snapshot's order so tiles never jump around. */
export function buildGlanceAgents(
	snapshot: InterfaceSnapshot
): GlanceAgentTile[] {
	return snapshot.agents.map((agent) => {
		const threads = snapshot.threads
			.filter((thread) => thread.agentIds.includes(agent.id))
			.sort(byGlanceUrgency);
		// A working agent's tile shows the run it is on, not an older reply.
		const thread =
			threads.find((candidate) => candidate.running) ?? threads[0] ?? null;
		const state = agentState(agent, thread);
		return {
			active:
				state === "working" || state === "attention" || state === "your-turn",
			agent,
			state,
			thread,
			threadCount: threads.length,
		};
	});
}

/** How many tiles a face shows before folding the rest into "+N". */
export const GLANCE_TILE_LIMIT = 9;

/**
 * Column count for the modular grid: two wide columns up to six tiles (so
 * each reads like one of Home's accessory tiles), three beyond that.
 */
export function glanceTileColumns(count: number): 2 | 3 {
	return count <= 6 ? 2 : 3;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export interface GlanceClock {
	/** "Tuesday, October 13" */
	date: string;
	/** "AM"/"PM" in 12-hour locales, null in 24-hour ones. */
	period: string | null;
	/** "9:41" */
	time: string;
}

export function glanceClock(now: Date, locale?: string): GlanceClock {
	const parts = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).formatToParts(now);
	let time = "";
	let period: string | null = null;
	for (const part of parts) {
		if (part.type === "dayPeriod") {
			period = part.value.trim();
		} else if (part.type !== "literal" || time !== "") {
			time += part.value;
		}
	}
	return {
		date: new Intl.DateTimeFormat(locale, {
			day: "numeric",
			month: "long",
			weekday: "long",
		}).format(now),
		period,
		time: time.trim(),
	};
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function startOfDay(date: Date): number {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate()
	).getTime();
}

/** When an upcoming run starts, phrased for a glance in the same units as thread ages: "in 40m", "Tomorrow 9 AM". */
export function glanceRunWhen(
	iso: string,
	now: number,
	locale?: string
): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const until = start - now;
	if (until < MINUTE_MS) {
		return "Now";
	}
	const minutes = Math.round(until / MINUTE_MS);
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const date = new Date(start);
	const days = Math.round(
		(startOfDay(date) - startOfDay(new Date(now))) / DAY_MS
	);
	const time = new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: date.getMinutes() === 0 ? undefined : "2-digit",
	}).format(date);
	if (days <= 0) {
		return until < 6 * HOUR_MS
			? `in ${Math.round(until / HOUR_MS)}h`
			: `Today ${time}`;
	}
	if (days === 1) {
		return `Tomorrow ${time}`;
	}
	if (days < 7) {
		const weekday = new Intl.DateTimeFormat(locale, {
			weekday: "short",
		}).format(date);
		return `${weekday} ${time}`;
	}
	return new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
	}).format(date);
}

/** Scheduled runs still ahead, soonest first. */
export function glanceUpcoming(
	snapshot: InterfaceSnapshot,
	now: number
): InterfaceEvent[] {
	return (snapshot.events ?? [])
		.filter((event) => {
			if (event.kind !== "upcoming") {
				return false;
			}
			const start = Date.parse(event.start);
			return !Number.isNaN(start) && start >= now - MINUTE_MS;
		})
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Flow art
// ---------------------------------------------------------------------------

/** Theme tokens the flow art paints with; never fixed colors. */
export type GlanceFlowTone =
	| "destructive"
	| "muted-foreground"
	| "primary"
	| "success";

export interface GlanceFlowBlob {
	/** Seconds per drift cycle; working agents move faster. */
	duration: number;
	id: string;
	/** Drift reach as a fraction of the stage. */
	reach: number;
	/** Diameter as a fraction of the stage. */
	size: number;
	/** Peak opacity of the blob's centre, 0..1. */
	strength: number;
	tone: GlanceFlowTone;
	working: boolean;
	/** Resting centre, 0..1 of the stage. */
	x: number;
	y: number;
}

const FLOW_TONE: Record<GlanceAgentState, GlanceFlowTone> = {
	attention: "destructive",
	idle: "muted-foreground",
	waiting: "muted-foreground",
	working: "success",
	"your-turn": "primary",
};

const FLOW_AGENT_LIMIT = 8;

function unit(seed: number): number {
	const value = Math.sin(seed * 12.9898) * 43_758.5453;
	return value - Math.floor(value);
}

/**
 * The flow face's composition: a calm primary field, then one soft light per
 * agent placed by its id. Working agents glow larger and drift faster, so the
 * art speeds up as more work is live.
 */
export function buildGlanceFlow(snapshot: InterfaceSnapshot): GlanceFlowBlob[] {
	const tiles = buildGlanceAgents(snapshot).slice(0, FLOW_AGENT_LIMIT);
	const working = tiles.filter((tile) => tile.state === "working").length;
	const pace = 1 + working * 0.35;
	const blobs: GlanceFlowBlob[] = [
		{
			duration: 48 / pace,
			id: "field-a",
			reach: 0.06,
			size: 1.3,
			strength: 0.3,
			tone: "primary",
			working: false,
			x: 0.22,
			y: 0.78,
		},
		{
			duration: 56 / pace,
			id: "field-b",
			reach: 0.05,
			size: 1.1,
			strength: 0.16,
			tone: "primary",
			working: false,
			x: 0.86,
			y: 0.2,
		},
	];
	for (const tile of tiles) {
		const hue = agentHue(tile.agent.id);
		const isWorking = tile.state === "working";
		blobs.push({
			duration: isWorking ? 14 + unit(hue + 3) * 6 : 36 + unit(hue + 4) * 12,
			id: tile.agent.id,
			reach: isWorking ? 0.14 : 0.05,
			size: isWorking ? 0.84 + unit(hue + 5) * 0.16 : 0.56,
			strength: isWorking ? 0.42 : 0.26,
			tone: FLOW_TONE[tile.state],
			working: isWorking,
			x: 0.12 + unit(hue + 1) * 0.76,
			y: 0.12 + unit(hue + 2) * 0.76,
		});
	}
	return blobs;
}

/** "2 agents working", the flow face's caption. */
export function glanceWorkingLine(count: number): string {
	if (count <= 0) {
		return "No agents working";
	}
	return count === 1 ? "1 agent working" : `${count} agents working`;
}
