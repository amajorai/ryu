import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	byRecency,
	firstSentence,
	lowerFirst,
	threadAgents,
	threadCounterpart,
	trimSentence,
} from "./panels-model-threads.ts";

// ---------------------------------------------------------------------------
// Action cards: one-tap suggestions where the verb is the button
// ---------------------------------------------------------------------------

export type PanelsActionKind = "ask" | "follow-up" | "reply" | "retry";

/** What tapping an action does: open a thread, or start one with an agent. */
export type PanelsTarget =
	| { agentId: string; kind: "start" }
	| { kind: "open"; threadId: string };

export interface PanelsAction {
	agentId: string | null;
	/** Supporting line under the sentence: the newest message or a role. */
	detail: string | null;
	id: string;
	kind: PanelsActionKind;
	/** The words after the verb, before the subject ("to Atlas about"). */
	rest: string;
	/** The full sentence, used as the button's accessible name. */
	sentence: string;
	status: ThreadStatus | null;
	/** Emphasised object of the sentence, usually the thread title. */
	subject: string | null;
	target: PanelsTarget;
	/** RFC 3339 time the suggestion is about, for an age stamp. */
	updatedAt: string | null;
	verb: string;
}

const ACTION_LIMIT = 4;

/**
 * How many suggestions each status may contribute, most urgent first. Live
 * runs are left out: the Working now panel right below already lists them.
 * Threads waiting on an agent come last, after asks: the user has nothing to
 * do there, so they only fill a row that would otherwise stay short.
 */
const ACTION_QUOTA: [ThreadStatus, number][] = [
	["attention", 2],
	["your-turn", 2],
];
const WAITING_QUOTA = 1;

function possessive(name: string): string {
	return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

function threadAction(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	status: ThreadStatus
): PanelsAction | null {
	const who = threadCounterpart(snapshot, thread);
	const lead = threadAgents(snapshot, thread)[0];
	let verb: string;
	let rest: string;
	let kind: PanelsActionKind;
	if (status === "attention") {
		kind = "retry";
		verb = "Retry";
		rest = who ? `${possessive(who)} failed run on` : "the failed run on";
	} else if (status === "your-turn") {
		kind = "reply";
		verb = "Reply";
		rest = who ? `to ${who} about` : "about";
	} else if (status === "waiting") {
		if (!who) {
			return null;
		}
		kind = "follow-up";
		verb = "Follow up";
		rest = `with ${who} on`;
	} else {
		return null;
	}
	const subject = trimSentence(thread.title);
	return {
		agentId: lead?.id ?? null,
		detail: thread.lastMessage
			? firstSentence(thread.lastMessage) || null
			: null,
		id: `thread:${thread.id}`,
		kind,
		rest,
		sentence: `${verb} ${rest} ${subject}`,
		status,
		subject,
		target: { kind: "open", threadId: thread.id },
		updatedAt: thread.updatedAt,
		verb,
	};
}

function askAction(agent: InterfaceAgent): PanelsAction {
	const topic = trimSentence(agent.description);
	const rest = topic ? `${agent.name} about ${lowerFirst(topic)}` : agent.name;
	return {
		agentId: agent.id,
		detail: null,
		id: `agent:${agent.id}`,
		kind: "ask",
		rest,
		sentence: `Ask ${rest}`,
		status: null,
		subject: null,
		target: { agentId: agent.id, kind: "start" },
		updatedAt: null,
		verb: "Ask",
	};
}

function takeThreadActions(
	snapshot: InterfaceSnapshot,
	sorted: InterfaceThread[],
	status: ThreadStatus,
	quota: number,
	actions: PanelsAction[],
	limit: number
): void {
	let taken = 0;
	for (const thread of sorted) {
		if (taken >= quota || actions.length >= limit) {
			return;
		}
		if (threadStatus(thread) !== status) {
			continue;
		}
		const action = threadAction(snapshot, thread, status);
		if (action) {
			actions.push(action);
			taken += 1;
		}
	}
}

/**
 * Up to four suggestions, most urgent first: retry failures, reply where an
 * agent answered, start a thread with an idle agent you have not talked to
 * yet, then check on an ask the agent has not answered.
 */
export function buildPanelsActions(
	snapshot: InterfaceSnapshot,
	limit: number = ACTION_LIMIT
): PanelsAction[] {
	const sorted = [...snapshot.threads].sort(
		(a, b) => Number(b.pinned) - Number(a.pinned) || byRecency(a, b)
	);
	const actions: PanelsAction[] = [];
	for (const [status, quota] of ACTION_QUOTA) {
		takeThreadActions(snapshot, sorted, status, quota, actions, limit);
	}
	const talkedTo = new Set(
		snapshot.threads.flatMap((thread) => thread.agentIds)
	);
	for (const agent of snapshot.agents) {
		if (actions.length >= limit) {
			break;
		}
		if (!talkedTo.has(agent.id) && agent.status === "idle") {
			actions.push(askAction(agent));
		}
	}
	takeThreadActions(snapshot, sorted, "waiting", WAITING_QUOTA, actions, limit);
	return actions.slice(0, limit);
}
