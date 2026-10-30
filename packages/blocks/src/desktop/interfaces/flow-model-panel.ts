import {
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	FLOW_UNASSIGNED_KEY,
	needsYou,
	threadGroupKey,
} from "./flow-model-threads.ts";
import type { FlowDotTone } from "./flow-model-types.ts";

// ---------------------------------------------------------------------------
// Panel numbers
// ---------------------------------------------------------------------------

export type FlowScope =
	| { kind: "agent"; agentId: string }
	| { kind: "all" }
	| { kind: "team"; teamId: string }
	| { kind: "unassigned" };

export function scopeFromNodeId(id: string | null): FlowScope | null {
	if (id === "origin") {
		return { kind: "all" };
	}
	if (id?.startsWith("agent:")) {
		return { agentId: id.slice("agent:".length), kind: "agent" };
	}
	if (id?.startsWith("team:")) {
		return { kind: "team", teamId: id.slice("team:".length) };
	}
	if (id === FLOW_UNASSIGNED_KEY) {
		return { kind: "unassigned" };
	}
	return null;
}

export function scopeThreads(
	snapshot: InterfaceSnapshot,
	scope: FlowScope
): InterfaceThread[] {
	if (scope.kind === "all") {
		return snapshot.threads;
	}
	// The same grouping the canvas draws, so a lead's panel and its node agree.
	let key = "orphan";
	if (scope.kind === "agent") {
		key = `agent:${scope.agentId}`;
	} else if (scope.kind === "team") {
		key = `team:${scope.teamId}`;
	}
	return snapshot.threads.filter(
		(thread) => threadGroupKey(snapshot, thread) === key
	);
}

export interface FlowMetrics {
	conversations: number;
	messages: number;
	/** Failed runs plus replies waiting on the user: what the inbox chips count. */
	needsYou: number;
	working: number;
}

export function flowMetrics(threads: readonly InterfaceThread[]): FlowMetrics {
	let needsYouTotal = 0;
	let working = 0;
	let messages = 0;
	for (const thread of threads) {
		if (needsYou(thread)) {
			needsYouTotal += 1;
		}
		if (threadStatus(thread) === "working") {
			working += 1;
		}
		messages += thread.messageCount;
	}
	return {
		conversations: threads.length,
		messages,
		needsYou: needsYouTotal,
		working,
	};
}

const HOUR = 3_600_000;

function inScope(
	snapshot: InterfaceSnapshot,
	scope: FlowScope,
	agentId: string | null
): boolean {
	if (scope.kind === "all") {
		return true;
	}
	if (scope.kind === "agent") {
		return agentId === scope.agentId;
	}
	if (scope.kind === "unassigned") {
		return agentId === null;
	}
	const team = snapshot.groups.find((group) => group.id === scope.teamId);
	return agentId !== null && Boolean(team?.memberAgentIds.includes(agentId));
}

/**
 * Activity in each of the last 24 hours, oldest first: conversation updates
 * plus scheduled runs that started in that hour.
 */
export function activityPerHour(
	snapshot: InterfaceSnapshot,
	scope: FlowScope,
	now: number
): number[] {
	const buckets = Array.from({ length: 24 }, () => 0);
	const add = (iso: string) => {
		const at = Date.parse(iso);
		if (Number.isNaN(at) || at > now) {
			return;
		}
		const age = Math.floor((now - at) / HOUR);
		if (age < 24) {
			buckets[23 - age] = (buckets[23 - age] ?? 0) + 1;
		}
	};
	for (const thread of scopeThreads(snapshot, scope)) {
		add(thread.updatedAt);
	}
	for (const event of snapshot.events ?? []) {
		if (event.kind === "past" && inScope(snapshot, scope, event.agentId)) {
			add(event.start);
		}
	}
	return buckets;
}

export interface FlowLogEntry {
	at: string;
	id: string;
	threadId: string | null;
	title: string;
	tone: FlowDotTone;
	verb: string;
}

function threadVerb(thread: InterfaceThread): string {
	switch (threadStatus(thread)) {
		case "attention":
			return thread.runState === "interrupted" ? "Stopped" : "Failed";
		case "working":
			return "Working";
		case "your-turn":
			return "Replied";
		case "waiting":
			return "Asked";
		default:
			return "Opened";
	}
}

/** Recent updates in a scope, newest first, like a request log. */
export function flowLogs(
	snapshot: InterfaceSnapshot,
	scope: FlowScope,
	now: number,
	limit = 24
): FlowLogEntry[] {
	const entries: FlowLogEntry[] = scopeThreads(snapshot, scope).map(
		(thread) => ({
			at: thread.updatedAt,
			id: `thread:${thread.id}`,
			threadId: thread.id,
			title: thread.title.trim() || "Untitled conversation",
			tone: threadStatus(thread),
			verb: threadVerb(thread),
		})
	);
	for (const event of snapshot.events ?? []) {
		const start = Date.parse(event.start);
		if (
			event.kind !== "past" ||
			Number.isNaN(start) ||
			start > now ||
			!inScope(snapshot, scope, event.agentId)
		) {
			continue;
		}
		const failed = event.outcome === "failure";
		entries.push({
			at: event.start,
			id: `event:${event.id}`,
			threadId: null,
			title: event.title,
			tone: failed ? "attention" : "success",
			verb: failed ? "Failed" : "Ran",
		});
	}
	return entries
		.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
		.slice(0, limit);
}

const pad = (value: number) => String(value).padStart(2, "0");
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** `HH:MM` in local time, for the log's fixed-width time column. */
export function logClock(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The day heading a log entry falls under: Today, Yesterday, or `Mon D`. */
export function logDay(iso: string, now: number): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const day = new Date(date);
	day.setHours(0, 0, 0, 0);
	const daysAgo = Math.round((start.getTime() - day.getTime()) / 86_400_000);
	if (daysAgo === 0) {
		return "Today";
	}
	if (daysAgo === 1) {
		return "Yesterday";
	}
	return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}
