import {
	type InterfaceEvent,
	type InterfaceGroup,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { compactAge } from "./interface-renderer.ts";
import { byRecency, statusRank } from "./persona-model-order.ts";
import { dayLabel } from "./persona-model-time.ts";

export interface PersonaGoal {
	/** Threads the agent has answered: replied, nothing running or failing. */
	answered: number;
	group: InterfaceGroup;
	/** True when the persona is a member or has a thread in the goal. */
	includesPersona: boolean;
	/** Threads not finished yet: running, queued, stopped or not started. */
	open: number;
	threads: InterfaceThread[];
	total: number;
}

/**
 * A thread counts as answered once the agent has replied and nothing is
 * running, queued or failed (the ball is with the user). Everything else in a
 * goal is still open on the agent's side.
 */
export function isThreadAnswered(thread: InterfaceThread): boolean {
	return threadStatus(thread) === "your-turn";
}

/** Projects and teams as goals, with answered vs open threads. */
export function personaGoals(
	snapshot: InterfaceSnapshot,
	agentId: string | null
): { projects: PersonaGoal[]; teams: PersonaGoal[] } {
	const goals = snapshot.groups.map((group): PersonaGoal => {
		const threads = snapshot.threads
			.filter((thread) =>
				group.kind === "project"
					? thread.projectId === group.id
					: thread.teamId === group.id
			)
			.sort(
				(a, b) =>
					Number(isThreadAnswered(a)) - Number(isThreadAnswered(b)) ||
					statusRank(a) - statusRank(b) ||
					byRecency(a, b)
			);
		const answered = threads.filter(isThreadAnswered).length;
		const includesPersona = agentId
			? group.memberAgentIds.includes(agentId) ||
				threads.some((thread) => thread.agentIds.includes(agentId))
			: false;
		return {
			answered,
			group,
			includesPersona,
			open: threads.length - answered,
			threads,
			total: threads.length,
		};
	});
	const order = (a: PersonaGoal, b: PersonaGoal) =>
		Number(b.includesPersona) - Number(a.includesPersona) ||
		a.group.name.localeCompare(b.group.name);
	return {
		projects: goals.filter((goal) => goal.group.kind === "project").sort(order),
		teams: goals.filter((goal) => goal.group.kind === "team").sort(order),
	};
}

export type ActivityEntry =
	| {
			at: string;
			id: string;
			kind: "thread";
			status: ThreadStatus;
			thread: InterfaceThread;
	  }
	| { at: string; event: InterfaceEvent; id: string; kind: "run" };

export interface ActivityDay {
	entries: ActivityEntry[];
	key: string;
	label: string;
}

export interface PersonaActivity {
	/** Thread updates and past scheduled runs, newest first, by day. */
	log: ActivityDay[];
	/** Threads whose last run failed or stopped: they need you. */
	stopped: InterfaceThread[];
	/** Projected scheduled runs, soonest first. */
	upcoming: InterfaceEvent[];
}

const LOG_LIMIT = 40;

export function personaActivity(
	snapshot: InterfaceSnapshot,
	now: number = Date.now()
): PersonaActivity {
	const events = snapshot.events ?? [];
	const entries: ActivityEntry[] = [
		...snapshot.threads.map(
			(thread): ActivityEntry => ({
				at: thread.updatedAt,
				id: `thread:${thread.id}`,
				kind: "thread",
				status: threadStatus(thread),
				thread,
			})
		),
		...events
			.filter((event) => event.kind === "past")
			.map(
				(event): ActivityEntry => ({
					at: event.end ?? event.start,
					event,
					id: `run:${event.id}`,
					kind: "run",
				})
			),
	]
		.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
		.slice(0, LOG_LIMIT);
	const log: ActivityDay[] = [];
	for (const entry of entries) {
		const key = localDayKey(new Date(entry.at));
		const last = log.at(-1);
		if (last?.key === key) {
			last.entries.push(entry);
		} else {
			log.push({ entries: [entry], key, label: dayLabel(entry.at, now) });
		}
	}
	return {
		log,
		stopped: snapshot.threads
			.filter((thread) => threadStatus(thread) === "attention")
			.sort(byRecency),
		upcoming: events
			.filter((event) => event.kind === "upcoming")
			.sort((a, b) => a.start.localeCompare(b.start)),
	};
}

/** "in 45m", "in 3h", "in 2d" for an upcoming run. */
export function untilLabel(iso: string, now: number = Date.now()): string {
	const minutes = Math.round((Date.parse(iso) - now) / 60_000);
	if (Number.isNaN(minutes)) {
		return "";
	}
	if (minutes < 1) {
		return "now";
	}
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `in ${hours}h`;
	}
	return `in ${Math.round(hours / 24)}d`;
}

/** "just now", "5m ago", "3h ago". */
export function agoLabel(iso: string, now: number = Date.now()): string {
	const age = compactAge(iso, now);
	if (!age) {
		return "";
	}
	return age === "now" ? "just now" : `${age} ago`;
}

/** Singular/plural count ("1 message", "4 messages"). */
export function countLabel(count: number, noun: string): string {
	return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
