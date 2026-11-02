import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export {
	outcomeAt,
	type PathDay,
	type PathLeader,
	type PathStats,
	pathLeaderboard,
	pathStats,
	pathStreak,
	repliedToday,
} from "./path-model-stats.ts";

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

export function pathUnitKindLabel(kind: PathUnitKind): string {
	switch (kind) {
		case "agent":
			return tr("Agent");
		case "project":
			return tr("Project");
		case "team":
			return tr("Team");
		default:
			return tr("Unassigned");
	}
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
		return tr("No threads yet");
	}
	const total = tr("{count, plural, one {# thread} other {# threads}}", {
		count: stops.length,
	});
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
		return tr(
			"{total} · {count, plural, one {# needs you} other {# need you}}",
			{ count: needsYou, total }
		);
	}
	if (working > 0) {
		return tr("{total} · {count} running", { count: working, total });
	}
	return done === stops.length ? tr("{total} · all done", { total }) : total;
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
			title: tr("Without an agent"),
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
