import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Path view model: the snapshot as a learning path. Units are projects, then
 * teams, then each agent's unfiled conversations, then conversations with no
 * agent. Every conversation is one stop on the path.
 */

/** Threads a day you reply to before the daily goal ring closes. */
export const PATH_DAILY_GOAL = 3;

/**
 * A unit earns a milestone at its end once it holds this many stops and at
 * least one of them is finished.
 */
export const PATH_MILESTONE_MIN_STOPS = 2;

/**
 * Unit colors cycle through theme roles (never a fixed hue): the primary, the
 * warning role, a berry (primary turned toward the destructive hue), and a
 * teal (the success and info roles mixed, toward the foreground). Each
 * neighbor differs in hue from the last, so no two adjacent units match in
 * light or dark themes, and repeats sit four units apart.
 */
export type PathTone = "berry" | "primary" | "teal" | "warning";
const TONE_CYCLE: readonly PathTone[] = ["primary", "warning", "berry", "teal"];

/**
 * How a stop reads on the path:
 * - `done`: closed out: the agent's run completed, its reply has sat for a
 *   day, and you have not pinned the thread open (a check). Any other
 *   unanswered reply stays `reply`, however old;
 * - `current`: the one stop to do next (raised, with a callout);
 * - `reply`: the agent answered recently and it is your turn;
 * - `attention`: a run failed or stopped;
 * - `working`: a run is live (progress ring);
 * - `waiting`: you wrote and the agent has not started (dimmed);
 * - `fresh`: nothing has been said yet.
 */
export type PathStopState =
	| "attention"
	| "current"
	| "done"
	| "fresh"
	| "reply"
	| "waiting"
	| "working";

export interface PathStop {
	agents: InterfaceAgent[];
	state: PathStopState;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export type PathUnitKind = "agent" | "project" | "team" | "unfiled";

/** What the unit's `+` passes to `port.startThread`. */
export interface PathStartTarget {
	agentId?: string;
	projectId?: string;
	teamId?: string;
}

export interface PathUnit {
	/** One line under the unit title. */
	description: string;
	/** Finished stops (checks), for the milestone at the unit's end. */
	doneCount: number;
	id: string;
	/** 1-based position on the path. */
	index: number;
	kind: PathUnitKind;
	members: InterfaceAgent[];
	/**
	 * Units with a finished stop and at least `PATH_MILESTONE_MIN_STOPS` stops
	 * end in a milestone: a trophy once every stop is done, a chest while some
	 * are still open.
	 */
	milestone: "chest" | "trophy" | null;
	start: PathStartTarget;
	stops: PathStop[];
	title: string;
	tone: PathTone;
}

export interface PathModel {
	/** The stop the path is pointing at, if any thread needs you. */
	currentThreadId: string | null;
	/** Finished stops across the whole path. */
	doneCount: number;
	/** Every stop on the path. */
	stopCount: number;
	units: PathUnit[];
}

const KIND_LABEL = {
	agent: "Agent",
	project: "Project",
	team: "Team",
	unfiled: "Unassigned",
} as const satisfies Record<PathUnitKind, string>;

export function pathUnitKindLabel(kind: PathUnitKind): string {
	return KIND_LABEL[kind];
}

function byOldest(a: InterfaceThread, b: InterfaceThread): number {
	return a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id);
}

function byNewest(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** A reply left this long without an answer can count as closed out. */
export const PATH_REPLY_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * A your-turn thread is closed out only when the agent's run completed, the
 * reply has sat for a day, the timestamp is real (not missing or the epoch
 * fallback), and the thread is not pinned open.
 */
export function pathReplyClosedOut(
	thread: InterfaceThread,
	now: number
): boolean {
	if (threadStatus(thread) !== "your-turn") {
		return false;
	}
	if (thread.pinned || thread.runState !== "completed") {
		return false;
	}
	const time = Date.parse(thread.updatedAt);
	if (Number.isNaN(time) || time <= 0) {
		return false;
	}
	return now - time >= PATH_REPLY_STALE_MS;
}

/**
 * The single stop the path points at: the newest failed run, else the newest
 * reply waiting on you that is not closed out. Pinned threads win ties
 * within a status.
 */
export function pathCurrentThread(
	threads: readonly InterfaceThread[],
	now: number = Date.now()
): InterfaceThread | undefined {
	for (const wanted of ["attention", "your-turn"] as const) {
		const matches = threads
			.filter(
				(thread) =>
					threadStatus(thread) === wanted && !pathReplyClosedOut(thread, now)
			)
			.sort((a, b) => Number(b.pinned) - Number(a.pinned) || byNewest(a, b));
		if (matches[0]) {
			return matches[0];
		}
	}
	return undefined;
}

const STATUS_STATE = {
	attention: "attention",
	quiet: "fresh",
	waiting: "waiting",
	working: "working",
	"your-turn": "reply",
} as const satisfies Record<ThreadStatus, PathStopState>;

/** Path order inside a unit: finished stops first, the open ones after. */
const STATE_RANK = {
	attention: 2,
	current: 1,
	done: 0,
	fresh: 6,
	reply: 3,
	waiting: 5,
	working: 4,
} as const satisfies Record<PathStopState, number>;

function stopState(
	thread: InterfaceThread,
	status: ThreadStatus,
	currentId: string | null,
	now: number
): PathStopState {
	if (thread.id === currentId) {
		return "current";
	}
	if (pathReplyClosedOut(thread, now)) {
		return "done";
	}
	return STATUS_STATE[status];
}

function toStops(
	snapshot: InterfaceSnapshot,
	threads: readonly InterfaceThread[],
	currentId: string | null,
	now: number
): PathStop[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	return [...threads]
		.sort(byOldest)
		.map((thread) => {
			const status = threadStatus(thread);
			const state = stopState(thread, status, currentId, now);
			const threadAgents: InterfaceAgent[] = [];
			for (const agentId of thread.agentIds) {
				const agent = agents.get(agentId);
				if (agent) {
					threadAgents.push(agent);
				}
			}
			return { agents: threadAgents, state, status, thread };
		})
		.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
}

function countLabel(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

const NEEDS_YOU: ReadonlySet<PathStopState> = new Set([
	"attention",
	"current",
	"reply",
]);

/**
 * A unit's goal line when it has no description of its own: how many threads
 * it holds and the one thing worth knowing about them.
 */
export function pathUnitSummary(stops: readonly PathStop[]): string {
	if (stops.length === 0) {
		return "No threads yet";
	}
	const total = countLabel(stops.length, "thread", "threads");
	let needsYou = 0;
	let working = 0;
	let done = 0;
	for (const stop of stops) {
		if (NEEDS_YOU.has(stop.state)) {
			needsYou += 1;
		} else if (stop.state === "working") {
			working += 1;
		} else if (stop.state === "done") {
			done += 1;
		}
	}
	if (needsYou > 0) {
		return `${total} · ${needsYou} ${needsYou === 1 ? "needs" : "need"} you`;
	}
	if (working > 0) {
		return `${total} · ${working} running`;
	}
	return done === stops.length ? `${total} · all done` : total;
}

interface UnitDraft {
	/** The unit's own description, when it has one. */
	description: string | null;
	id: string;
	kind: PathUnitKind;
	members: InterfaceAgent[];
	start: PathStartTarget;
	threads: InterfaceThread[];
	title: string;
}

function unitDrafts(snapshot: InterfaceSnapshot): UnitDraft[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const membersOf = (ids: readonly string[]) => {
		const members: InterfaceAgent[] = [];
		for (const id of ids) {
			const agent = agents.get(id);
			if (agent) {
				members.push(agent);
			}
		}
		return members;
	};
	const drafts: UnitDraft[] = [];
	const filed = new Set<string>();
	for (const kind of ["project", "team"] as const) {
		for (const group of snapshot.groups) {
			if (group.kind !== kind) {
				continue;
			}
			const threads = snapshot.threads.filter((thread) =>
				kind === "project"
					? thread.projectId === group.id
					: thread.teamId === group.id && !filed.has(thread.id)
			);
			for (const thread of threads) {
				filed.add(thread.id);
			}
			drafts.push({
				description: null,
				id: group.id,
				kind,
				members: membersOf(group.memberAgentIds),
				start:
					kind === "project" ? { projectId: group.id } : { teamId: group.id },
				threads,
				title: group.name,
			});
		}
	}
	const loose = snapshot.threads.filter((thread) => !filed.has(thread.id));
	for (const agent of snapshot.agents) {
		const threads = loose.filter((thread) => thread.agentIds[0] === agent.id);
		if (threads.length === 0) {
			continue;
		}
		drafts.push({
			description: agent.description.trim() || null,
			id: `agent:${agent.id}`,
			kind: "agent",
			members: [agent],
			start: { agentId: agent.id },
			threads,
			title: agent.name,
		});
	}
	const orphans = loose.filter(
		(thread) => !(thread.agentIds[0] && agents.has(thread.agentIds[0]))
	);
	if (orphans.length > 0) {
		drafts.push({
			description: "Threads with no agent yet",
			id: "unfiled",
			kind: "unfiled",
			members: [],
			start: {},
			threads: orphans,
			title: "Without an agent",
		});
	}
	return drafts;
}

export function buildPath(
	snapshot: InterfaceSnapshot,
	now: number = Date.now()
): PathModel {
	const currentId = pathCurrentThread(snapshot.threads, now)?.id ?? null;
	const units = unitDrafts(snapshot).map((draft, position): PathUnit => {
		const stops = toStops(snapshot, draft.threads, currentId, now);
		const doneCount = stops.filter((stop) => stop.state === "done").length;
		let milestone: PathUnit["milestone"] = null;
		if (stops.length >= PATH_MILESTONE_MIN_STOPS && doneCount > 0) {
			milestone = doneCount === stops.length ? "trophy" : "chest";
		}
		return {
			description: draft.description ?? pathUnitSummary(stops),
			doneCount,
			id: draft.id,
			index: position + 1,
			kind: draft.kind,
			members: draft.members,
			milestone,
			start: draft.start,
			stops,
			title: draft.title,
			tone: TONE_CYCLE[position % TONE_CYCLE.length] ?? "primary",
		};
	});
	let doneCount = 0;
	let stopCount = 0;
	for (const unit of units) {
		doneCount += unit.doneCount;
		stopCount += unit.stops.length;
	}
	return { currentThreadId: currentId, doneCount, stopCount, units };
}

/**
 * Horizontal swing for the n-th item on the whole path, in path steps: a
 * sine-like curve that peaks at 1.6 steps either side. The phase runs on
 * across unit banners, so the path keeps winding instead of restarting at
 * the center under every banner.
 */
const SWING: readonly number[] = [0, -1, -1.6, -1, 0, 1, 1.6, 1];

export function pathSwing(pathIndex: number): number {
	return SWING[pathIndex % SWING.length] ?? 0;
}

/** Items a unit puts on the path: its stops, its milestone, and its `+`. */
export function pathUnitItemCount(unit: PathUnit): number {
	return unit.stops.length + (unit.milestone ? 1 : 0) + 1;
}

// ---------------------------------------------------------------------------
// Top bar and rail
// ---------------------------------------------------------------------------

export interface PathDay {
	/** Some thread's last turn finished with an outcome that day. */
	active: boolean;
	key: string;
	/** Narrow weekday label ("M", "T", ...). */
	label: string;
	today: boolean;
}

export interface PathStats {
	/** Threads you replied to today, capped at nothing (the ring caps). */
	repliedToday: number;
	/** Consecutive days with an outcome, ending today (or yesterday). */
	streakDays: number;
	/** The last seven days, oldest first. */
	week: PathDay[];
	/** Every message in every thread. */
	xp: number;
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

/**
 * When a thread's last turn finished with an outcome: it is not running,
 * the agent spoke last and the run neither failed nor was interrupted. The
 * time is the outcome's `finishedAt`, else `runEndedAt`, else the thread's
 * last update (the answer's last word). Null when there is no outcome.
 */
export function outcomeAt(thread: InterfaceThread): number | null {
	if (
		thread.running ||
		thread.lastMessageRole !== "assistant" ||
		thread.runState === "failed" ||
		thread.runState === "interrupted"
	) {
		return null;
	}
	const time = Date.parse(
		thread.outcome?.finishedAt ?? thread.runEndedAt ?? thread.updatedAt
	);
	return Number.isNaN(time) ? null : time;
}

/** The local days on which some thread's last turn finished with an outcome. */
function outcomeDayKeys(threads: readonly InterfaceThread[]): Set<string> {
	const keys = new Set<string>();
	for (const thread of threads) {
		const time = outcomeAt(thread);
		if (time !== null) {
			keys.add(localDayKey(new Date(time)));
		}
	}
	return keys;
}

/**
 * Days in a row with an outcome (a finished answer, not just messages); a
 * streak survives until today ends.
 */
export function pathStreak(
	threads: readonly InterfaceThread[],
	now: Date
): number {
	const days = outcomeDayKeys(threads);
	let cursor = days.has(localDayKey(now)) ? now : addDays(now, -1);
	let streak = 0;
	while (days.has(localDayKey(cursor))) {
		streak += 1;
		cursor = addDays(cursor, -1);
	}
	return streak;
}

/**
 * A thread counts toward today's goal when it moved today and the last word
 * was yours, or your message started the run that is live now.
 */
export function repliedToday(
	threads: readonly InterfaceThread[],
	now: Date
): number {
	const today = localDayKey(now);
	let count = 0;
	for (const thread of threads) {
		const time = Date.parse(thread.updatedAt);
		if (Number.isNaN(time) || localDayKey(new Date(time)) !== today) {
			continue;
		}
		if (thread.lastMessageRole === "user" || thread.running) {
			count += 1;
		}
	}
	return count;
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "narrow" });

export function pathStats(
	snapshot: InterfaceSnapshot,
	now: Date = new Date()
): PathStats {
	const days = outcomeDayKeys(snapshot.threads);
	const todayKey = localDayKey(now);
	const week: PathDay[] = [];
	for (let offset = -6; offset <= 0; offset += 1) {
		const date = addDays(now, offset);
		const key = localDayKey(date);
		week.push({
			active: days.has(key),
			key,
			label: WEEKDAY.format(date),
			today: key === todayKey,
		});
	}
	let xp = 0;
	for (const thread of snapshot.threads) {
		xp += Math.max(0, thread.messageCount);
	}
	return {
		repliedToday: repliedToday(snapshot.threads, now),
		streakDays: pathStreak(snapshot.threads, now),
		week,
		xp,
	};
}

export interface PathLeader {
	agent: InterfaceAgent;
	rank: number;
	threads: number;
	xp: number;
}

/** Agents ranked by messages across the threads they are in. */
export function pathLeaderboard(snapshot: InterfaceSnapshot): PathLeader[] {
	const rows = snapshot.agents.map((agent) => {
		let xp = 0;
		let threads = 0;
		for (const thread of snapshot.threads) {
			if (thread.agentIds.includes(agent.id)) {
				xp += Math.max(0, thread.messageCount);
				threads += 1;
			}
		}
		return { agent, threads, xp };
	});
	rows.sort((a, b) => b.xp - a.xp || a.agent.name.localeCompare(b.agent.name));
	return rows.map((row, position) => ({ ...row, rank: position + 1 }));
}
