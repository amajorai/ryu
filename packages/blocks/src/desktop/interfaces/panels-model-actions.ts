import { translate as tr } from "@ryu/i18n/lite";
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
	/** What an ask is about: the agent's role, lower-cased. */
	topic: string | null;
	/** RFC 3339 time the suggestion is about, for an age stamp. */
	updatedAt: string | null;
	verb: string;
	/** Who the sentence names: the counterpart agent, or the agent to ask. */
	who: string | null;
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

function threadAction(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread,
	status: ThreadStatus
): PanelsAction | null {
	const who = threadCounterpart(snapshot, thread);
	const lead = threadAgents(snapshot, thread)[0];
	let kind: PanelsActionKind;
	if (status === "attention") {
		kind = "retry";
	} else if (status === "your-turn") {
		kind = "reply";
	} else if (status === "waiting" && who) {
		kind = "follow-up";
	} else {
		return null;
	}
	const subject = trimSentence(thread.title);
	const words = actionWords(kind, who, subject, null);
	return {
		agentId: lead?.id ?? null,
		detail: thread.lastMessage
			? firstSentence(thread.lastMessage) || null
			: null,
		id: `thread:${thread.id}`,
		kind,
		rest: words.rest,
		sentence: words.sentence,
		status,
		subject,
		target: { kind: "open", threadId: thread.id },
		topic: null,
		updatedAt: thread.updatedAt,
		verb: words.verb,
		who,
	};
}

/** An action's verb, the words after it, and the whole sentence, in the UI language. */
function actionWords(
	kind: PanelsActionKind,
	who: string | null,
	subject: string,
	topic: string | null
): { rest: string; sentence: string; verb: string } {
	const values = { subject, topic: topic ?? "", who: who ?? "" };
	switch (kind) {
		case "retry":
			return {
				rest: who
					? tr("{who}'s failed run on", values)
					: tr("the failed run on"),
				sentence: who
					? tr("Retry {who}'s failed run on {subject}", values)
					: tr("Retry the failed run on {subject}", values),
				verb: tr("Retry"),
			};
		case "reply":
			return {
				rest: who ? tr("to {who} about", values) : tr("about"),
				sentence: who
					? tr("Reply to {who} about {subject}", values)
					: tr("Reply about {subject}", values),
				verb: tr("Reply"),
			};
		case "follow-up":
			return {
				rest: tr("with {who} on", values),
				sentence: tr("Follow up with {who} on {subject}", values),
				verb: tr("Follow up"),
			};
		default:
			return {
				rest: topic ? tr("{who} about {topic}", values) : (who ?? ""),
				sentence: topic
					? tr("Ask {who} about {topic}", values)
					: tr("Ask {who}", values),
				verb: tr("Ask"),
			};
	}
}

function askAction(agent: InterfaceAgent): PanelsAction {
	const description = trimSentence(agent.description);
	const topic = description ? lowerFirst(description) : null;
	const words = actionWords("ask", agent.name, "", topic);
	return {
		agentId: agent.id,
		detail: null,
		id: `agent:${agent.id}`,
		kind: "ask",
		rest: words.rest,
		sentence: words.sentence,
		status: null,
		subject: null,
		target: { agentId: agent.id, kind: "start" },
		topic,
		updatedAt: null,
		verb: words.verb,
		who: agent.name,
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
