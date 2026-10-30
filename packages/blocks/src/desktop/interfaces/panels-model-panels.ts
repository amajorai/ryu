import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { agentById } from "./interface-renderer.ts";
import type { PanelsTarget } from "./panels-model-actions.ts";
import {
	byRecency,
	latestThreadFor,
	threadAgents,
	threadCounterpart,
	trimSentence,
} from "./panels-model-threads.ts";

// ---------------------------------------------------------------------------
// Panels: working now, upcoming runs, agents, recent activity
// ---------------------------------------------------------------------------

export function workingThreads(snapshot: InterfaceSnapshot): InterfaceThread[] {
	return snapshot.threads.filter((thread) => thread.running).sort(byRecency);
}

export function upcomingRuns(
	snapshot: InterfaceSnapshot,
	now: number,
	limit = 4
): InterfaceEvent[] {
	return (snapshot.events ?? [])
		.filter(
			(event) => event.kind === "upcoming" && Date.parse(event.start) >= now
		)
		.sort((a, b) => a.start.localeCompare(b.start))
		.slice(0, limit);
}

export function lastRun(
	snapshot: InterfaceSnapshot,
	now: number
): InterfaceEvent | undefined {
	return (snapshot.events ?? [])
		.filter((event) => event.kind === "past" && Date.parse(event.start) <= now)
		.sort((a, b) => b.start.localeCompare(a.start))[0];
}

export interface PanelsAgentRow {
	agent: InterfaceAgent;
	/** What the row says beside the name: the agent's role. */
	line: string;
	/** The agent's state as the row shows it. */
	status: ThreadStatus | null;
	target: PanelsTarget;
	thread: InterfaceThread | undefined;
}

function agentRank(row: PanelsAgentRow): number {
	if (row.status === "working") {
		return 0;
	}
	return row.status === "attention" || row.status === "your-turn" ? 1 : 2;
}

/**
 * Working agents first (so a live run is never the row a short list drops),
 * then agents waiting on you, then by their latest conversation. Each row names the agent's role rather than a thread title,
 * since the panels around it already list the conversations.
 */
export function buildAgentRows(snapshot: InterfaceSnapshot): PanelsAgentRow[] {
	const live = workingThreads(snapshot);
	const rows = snapshot.agents.map((agent): PanelsAgentRow => {
		const working = live.find((thread) => thread.agentIds.includes(agent.id));
		const thread = working ?? latestThreadFor(snapshot, agent.id);
		let status: ThreadStatus | null = thread ? threadStatus(thread) : null;
		if (agent.status === "working") {
			status = "working";
		}
		return {
			agent,
			line: trimSentence(agent.description) || "No role set",
			status,
			target: thread
				? { kind: "open", threadId: thread.id }
				: { agentId: agent.id, kind: "start" },
			thread,
		};
	});
	return rows.sort((a, b) => {
		const rank = agentRank(a) - agentRank(b);
		if (rank !== 0) {
			return rank;
		}
		const aTime = a.thread?.updatedAt ?? "";
		const bTime = b.thread?.updatedAt ?? "";
		return (
			bTime.localeCompare(aTime) || a.agent.name.localeCompare(b.agent.name)
		);
	});
}

// ---------------------------------------------------------------------------
// Recent activity: what happened, as events rather than a thread list
// ---------------------------------------------------------------------------

export type PanelsActivityKind = "failed" | "finished" | "replied" | "wrote";

export interface PanelsActivity {
	/** Who or what acted, emphasised at the start of the line. */
	actor: string;
	agent: InterfaceAgent | undefined;
	/** RFC 3339 time it happened. */
	at: string;
	/** What it was about: the conversation or the run's agent. */
	context: string | null;
	id: string;
	kind: PanelsActivityKind;
	target: PanelsTarget | null;
	verb: string;
}

function threadActivity(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): PanelsActivity {
	const who = threadCounterpart(snapshot, thread);
	const fromYou = thread.lastMessageRole === "user";
	return {
		actor: fromYou ? "You" : (who ?? "An agent"),
		agent: threadAgents(snapshot, thread)[0],
		at: thread.updatedAt,
		context: trimSentence(thread.title),
		id: `thread:${thread.id}`,
		kind: fromYou ? "wrote" : "replied",
		target: { kind: "open", threadId: thread.id },
		verb: fromYou ? `wrote${who ? ` to ${who}` : ""}` : "replied",
	};
}

function runActivity(
	snapshot: InterfaceSnapshot,
	event: InterfaceEvent
): PanelsActivity {
	const agent = agentById(snapshot, event.agentId);
	const failed = event.outcome === "failure";
	return {
		actor: event.title,
		agent,
		at: event.end ?? event.start,
		context: agent?.name ?? null,
		id: `run:${event.id}`,
		kind: failed ? "failed" : "finished",
		target: runTarget(snapshot, event),
		verb: failed ? "failed" : "finished",
	};
}

/**
 * The newest things that happened, newest first: replies and your messages in
 * conversations that are not live (Working now lists those), and finished or
 * failed scheduled runs.
 */
export function activityItems(
	snapshot: InterfaceSnapshot,
	now: number,
	limit = 5
): PanelsActivity[] {
	const items: PanelsActivity[] = [];
	for (const thread of snapshot.threads) {
		if (!thread.running && thread.lastMessage?.trim()) {
			items.push(threadActivity(snapshot, thread));
		}
	}
	for (const event of snapshot.events ?? []) {
		if (event.kind === "past" && Date.parse(event.start) <= now) {
			items.push(runActivity(snapshot, event));
		}
	}
	return items
		.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
		.slice(0, limit);
}

/**
 * The conversation that is "with" an agent: its newest one-to-one thread, or
 * failing that the newest thread it is part of.
 */
export function agentThreadFor(
	snapshot: InterfaceSnapshot,
	agentId: string
): InterfaceThread | undefined {
	const own = [...snapshot.threads]
		.filter(
			(thread) => thread.agentIds.length === 1 && thread.agentIds[0] === agentId
		)
		.sort(byRecency)[0];
	return own ?? latestThreadFor(snapshot, agentId);
}

/** Where a scheduled run goes: its agent's own thread, or a new one. */
export function runTarget(
	snapshot: InterfaceSnapshot,
	event: InterfaceEvent
): PanelsTarget | null {
	if (!event.agentId) {
		return null;
	}
	const thread = agentThreadFor(snapshot, event.agentId);
	return thread
		? { kind: "open", threadId: thread.id }
		: { agentId: event.agentId, kind: "start" };
}

export interface PanelsSummary {
	needsYou: number;
	working: number;
}

export function panelsSummary(snapshot: InterfaceSnapshot): PanelsSummary {
	let needsYou = 0;
	let working = 0;
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		if (status === "attention" || status === "your-turn") {
			needsYou += 1;
		} else if (status === "working") {
			working += 1;
		}
	}
	return { needsYou, working };
}

const SPELLED = [
	"No",
	"One",
	"Two",
	"Three",
	"Four",
	"Five",
	"Six",
	"Seven",
	"Eight",
	"Nine",
];

function spell(count: number): string {
	return SPELLED[count] ?? String(count);
}

/** One calm sentence under the greeting. */
export function summarySentence(summary: PanelsSummary): string {
	const { needsYou, working } = summary;
	if (needsYou === 0 && working === 0) {
		return "Nothing needs you right now.";
	}
	const parts: string[] = [];
	if (needsYou > 0) {
		parts.push(
			`${spell(needsYou)} ${needsYou === 1 ? "conversation needs" : "conversations need"} you`
		);
	}
	if (working > 0) {
		const lead =
			parts.length > 0 ? spell(working).toLowerCase() : spell(working);
		parts.push(`${lead} ${working === 1 ? "agent is" : "agents are"} working`);
	}
	return `${parts.join(", and ")}.`;
}
