import {
	type InterfaceAgent,
	type InterfaceAgentAct,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Workers: every agent is a cloud worker with its own computer. This module is
 * the pure view model: who is doing what, which conversation each monitor
 * shows, and where the desks stand in the office diorama. No React, so it is
 * tested directly.
 */

/**
 * One state per worker, most pressing first when several apply. "paused"
 * comes only from the act layer (an interrupted run).
 */
export type WorkerState =
	| "attention"
	| "idle"
	| "paused"
	| "working"
	| "your-turn";

export const WORKER_STATE_LABELS: Record<WorkerState, string> = {
	attention: "Needs attention",
	idle: "Idle",
	paused: "Paused",
	working: "Working",
	"your-turn": "Waiting on you",
};

/** The same lights, in the act layer's words (the HUD legend with acts). */
export const ACT_STATE_LABELS: Record<WorkerState, string> = {
	attention: "Failed",
	idle: "Idle",
	paused: "Paused",
	working: "Working",
	"your-turn": "Asks you",
};

/**
 * A worker's light and monitor from its act: amber while it asks you,
 * green while it works, red for a counted failure (not an interruption),
 * grey "paused" for an interrupted run, and the dim screensaver otherwise
 * (limited, delivering, waiting, idle).
 */
export function actWorkerState(act: InterfaceAgentAct): WorkerState {
	switch (act.act) {
		case "asking":
			return "your-turn";
		case "working":
			return "working";
		case "blocked":
			return act.blockers[0]?.kind === "interrupted" ? "paused" : "attention";
		default:
			return "idle";
	}
}

/**
 * The workers with their states (and the conversation each monitor shows)
 * taken from the acts, so lights, monitors and labels never contradict them.
 */
export function actWorkers(
	workers: readonly WorkerView[],
	acts: ReadonlyMap<string, InterfaceAgentAct>
): WorkerView[] {
	return workers.map((worker) => {
		const act = acts.get(worker.id);
		if (!act) {
			return worker;
		}
		return {
			...worker,
			current:
				worker.threads.find((thread) => thread.id === act.threadId) ??
				worker.current,
			state: actWorkerState(act),
		};
	});
}

export interface WorkerView {
	agent: InterfaceAgent;
	/** The conversation the computer shows: the live run, else the newest. */
	current: InterfaceThread | undefined;
	id: string;
	name: string;
	/** Conversations whose next move is yours (failed runs and replies). */
	needsYou: number;
	state: WorkerState;
	/** This worker's conversations: live runs first, then newest first. */
	threads: InterfaceThread[];
}

function byLiveThenRecent(a: InterfaceThread, b: InterfaceThread): number {
	return (
		Number(b.running) - Number(a.running) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

function needsYou(status: ThreadStatus): boolean {
	return status === "attention" || status === "your-turn";
}

/** A conversation's own mark, in the same four shapes a worker uses. */
export function threadWorkerState(thread: InterfaceThread): WorkerState {
	const status = threadStatus(thread);
	if (
		status === "working" ||
		status === "attention" ||
		status === "your-turn"
	) {
		return status;
	}
	return "idle";
}

function workerState(
	agent: InterfaceAgent,
	statuses: ThreadStatus[]
): WorkerState {
	if (agent.status === "working" || statuses.includes("working")) {
		return "working";
	}
	if (statuses.includes("attention")) {
		return "attention";
	}
	if (statuses.includes("your-turn")) {
		return "your-turn";
	}
	return "idle";
}

/** One view per agent, in the snapshot's agent order. */
export function buildWorkers(snapshot: InterfaceSnapshot): WorkerView[] {
	return snapshot.agents.map((agent) => {
		const threads = snapshot.threads
			.filter((thread) => thread.agentIds.includes(agent.id))
			.sort(byLiveThenRecent);
		const statuses = threads.map(threadStatus);
		const state = workerState(agent, statuses);
		return {
			agent,
			// The monitor shows the conversation behind the worker's state, so
			// its status light and its window always agree.
			current:
				threads.find((thread) => threadWorkerState(thread) === state) ??
				threads[0],
			id: agent.id,
			name: agent.name,
			needsYou: statuses.filter(needsYou).length,
			state,
			threads,
		};
	});
}

/**
 * Every count is of workers, by each worker's one state, so the buckets
 * partition the fleet: working, waiting on you, and (the rest) idle.
 */
export interface WorkerTotals {
	/** Workers whose state is a failed run or a reply that waits on you. */
	waitingOnYou: number;
	workers: number;
	working: number;
}

/** The worker's own next move is yours: a failed run or a reply. */
export function isWaitingOnYou(worker: WorkerView): boolean {
	return worker.state === "attention" || worker.state === "your-turn";
}

export function workerTotals(workers: WorkerView[]): WorkerTotals {
	return {
		waitingOnYou: workers.filter(isWaitingOnYou).length,
		workers: workers.length,
		working: workers.filter((worker) => worker.state === "working").length,
	};
}

/**
 * The workspace's name: the team when there is exactly one, else the one
 * project, else plain "Workers". A group names the page only when every
 * worker shown is one of its members; otherwise its name would title agents
 * that are not in it.
 */
export function workspaceName(
	groups: readonly InterfaceGroup[],
	agentIds: readonly string[]
): string {
	const covers = (group: InterfaceGroup) =>
		agentIds.length > 0 &&
		agentIds.every((id) => group.memberAgentIds.includes(id));
	const teams = groups.filter((group) => group.kind === "team");
	if (teams.length === 1 && teams[0]) {
		return covers(teams[0]) ? teams[0].name : "Workers";
	}
	const projects = groups.filter((group) => group.kind === "project");
	if (teams.length === 0 && projects.length === 1 && projects[0]) {
		return covers(projects[0]) ? projects[0].name : "Workers";
	}
	return "Workers";
}

/**
 * The worker that owns a thread. A shared thread keeps the worker whose desk
 * is already open when that worker is one of its participants.
 */
export function workerIndexForThread(
	workers: WorkerView[],
	threadId: string | null,
	preferIndex = -1
): number {
	if (!threadId) {
		return -1;
	}
	const preferred = workers[preferIndex];
	if (preferred?.threads.some((thread) => thread.id === threadId)) {
		return preferIndex;
	}
	return workers.findIndex((worker) =>
		worker.threads.some((thread) => thread.id === threadId)
	);
}

export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Where a conversation lives and how long it is: "Website Redesign · 5 messages". */
export function threadContext(
	thread: InterfaceThread,
	groups: readonly InterfaceGroup[]
): string {
	const parts: string[] = [];
	for (const groupId of [thread.projectId, thread.teamId]) {
		const name = groups.find((group) => group.id === groupId)?.name;
		if (name) {
			parts.push(name);
		}
	}
	parts.push(plural(thread.messageCount, "message"));
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// The office, in world units (the game kit's diorama frame: x right, z toward
// the viewer, y up; a villager is about one unit tall)
// ---------------------------------------------------------------------------

/** Desk to desk across a row, and row to row. */
const PITCH_X = 2.6;
const PITCH_Z = 3.1;
/** The coffee corner's strip beside the desks, against the window wall. */
const COFFEE_STRIP = 2.3;
/** Floor between the window wall and the back row of desks. */
const BACK_GAP = 1.1;
const FRONT_GAP = 1.2;
const SIDE_GAP = 0.9;
/** A desk's top is this deep; its worker's chair stands this far in front. */
export const DESK_DEPTH = 0.78;
export const CHAIR_OUT = 1.0;

export interface OfficeDesk {
	worker: WorkerView;
	/** The desk's centre on the floor. */
	x: number;
	z: number;
}

export interface OfficePlan {
	/** The coffee corner: a counter against the back wall, a bistro table. */
	coffee: { x: number; z: number };
	columns: number;
	desks: OfficeDesk[];
	/** The room's floor, centred on the origin. */
	halfDepth: number;
	halfWidth: number;
	rows: number;
	/** The rug under the desks: its centre and half extents. */
	rug: { halfDepth: number; halfWidth: number; x: number; z: number };
}

/** How many desks a row holds for `count` workers. */
export function officeColumns(count: number): number {
	if (count <= 3) {
		return Math.max(1, count);
	}
	if (count <= 8) {
		return Math.ceil(count / 2);
	}
	return Math.ceil(Math.sqrt(count * 1.4));
}

/**
 * How much farther apart desks stand when the act layer draws its props
 * (alarms, boards, openers) between them.
 */
export const ACT_SPREAD = 1.5;

/**
 * The open-plan office: one desk per worker in rows facing the window
 * wall, a rug under them, and a coffee corner beside the back row. The
 * room is centred on the origin; its back wall is at -halfDepth and its
 * left wall at -halfWidth.
 */
export function layoutOffice(
	workers: readonly WorkerView[],
	spread = 1
): OfficePlan {
	const columns = officeColumns(workers.length);
	const rows = Math.max(1, Math.ceil(workers.length / columns));
	const pitchX = PITCH_X * spread;
	const pitchZ = PITCH_Z * spread;
	const gridWidth = columns * pitchX;
	const gridDepth = rows * pitchZ;
	const width = SIDE_GAP + gridWidth + COFFEE_STRIP;
	const depth = BACK_GAP + gridDepth + FRONT_GAP;
	const halfWidth = width / 2;
	const halfDepth = depth / 2;
	const left = -halfWidth + SIDE_GAP;
	const back = -halfDepth + BACK_GAP;
	const desks = workers.map((worker, index) => {
		const column = index % columns;
		const row = Math.floor(index / columns);
		// A short last row is centred under the rows above it.
		const inRow = Math.min(columns, workers.length - row * columns);
		const shift = ((columns - inRow) * pitchX) / 2;
		return {
			worker,
			x: left + shift + (column + 0.5) * pitchX,
			z: back + row * pitchZ + DESK_DEPTH / 2 + 0.1,
		};
	});
	return {
		coffee: { x: halfWidth - COFFEE_STRIP / 2 + 0.1, z: -halfDepth + 0.55 },
		columns,
		desks,
		halfDepth,
		halfWidth,
		rows,
		rug: {
			halfDepth: gridDepth / 2 - 0.1,
			halfWidth: gridWidth / 2 - 0.05,
			x: left + gridWidth / 2,
			z: back + gridDepth / 2 - 0.15,
		},
	};
}
