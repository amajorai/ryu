import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { agentById } from "./interface-renderer.ts";

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function threadAgents(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	return thread.agentIds
		.map((id) => agentById(snapshot, id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
}

export function groupById(
	snapshot: InterfaceSnapshot,
	id: string | null
): InterfaceGroup | undefined {
	return id ? snapshot.groups.find((group) => group.id === id) : undefined;
}

/**
 * Who a thread is "with", in a sentence: the team for a team thread with more
 * than one agent, otherwise its lead agent.
 */
export function threadCounterpart(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string | null {
	const team = groupById(snapshot, thread.teamId);
	if (team && thread.agentIds.length > 1) {
		return team.name;
	}
	return threadAgents(snapshot, thread)[0]?.name ?? team?.name ?? null;
}

export function recentThreads(
	snapshot: InterfaceSnapshot,
	limit: number
): InterfaceThread[] {
	return [...snapshot.threads].sort(byRecency).slice(0, limit);
}

/** The newest thread this agent is part of. */
export function latestThreadFor(
	snapshot: InterfaceSnapshot,
	agentId: string
): InterfaceThread | undefined {
	return [...snapshot.threads]
		.filter((thread) => thread.agentIds.includes(agentId))
		.sort(byRecency)[0];
}

/**
 * The first full sentence of a message, so a one-line detail never stops
 * mid-thought. Falls back to the whole (trimmed) text when it has no break.
 */
export function firstSentence(text: string): string {
	const line = text.trim().split("\n")[0]?.trim() ?? "";
	const match = line.match(/^(.+?[.!?])(?=\s|$)/);
	return match?.[1] ?? line;
}

/** One line for a thread's newest message, or a plain fallback. */
export function threadExcerpt(thread: InterfaceThread): string {
	const line = thread.lastMessage?.trim();
	if (!line) {
		return "No messages yet";
	}
	return thread.lastMessageRole === "user" ? `You: ${line}` : line;
}

export function lowerFirst(text: string): string {
	return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export function trimSentence(text: string): string {
	return text.trim().replace(/[.!?]+$/, "");
}
