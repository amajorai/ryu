import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import type { FlowDotTone } from "./flow-model-types.ts";

const STATUS_RANK = new Map(
	THREAD_STATUS_ORDER.map((status, index) => [status, index])
);

export function byUrgency(a: InterfaceThread, b: InterfaceThread): number {
	const rank =
		(STATUS_RANK.get(threadStatus(a)) ?? 0) -
		(STATUS_RANK.get(threadStatus(b)) ?? 0);
	return (
		rank ||
		Number(b.pinned) - Number(a.pinned) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

/** The status a lead shows: live work first, then what needs the user. */
export function leadTone(
	threads: readonly InterfaceThread[],
	working: boolean
): FlowDotTone {
	const statuses = new Set(threads.map(threadStatus));
	if (working || statuses.has("working")) {
		return "working";
	}
	if (statuses.has("attention")) {
		return "attention";
	}
	if (statuses.has("your-turn")) {
		return "your-turn";
	}
	return "idle";
}

/** The lane that gathers conversations with no agent or team. */
export const FLOW_UNASSIGNED_KEY = "lane:unassigned";

/** Which flow group a thread belongs to: its team, else its first agent. */
export function threadGroupKey(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): string {
	if (
		thread.teamId &&
		snapshot.groups.some(
			(group) => group.kind === "team" && group.id === thread.teamId
		)
	) {
		return `team:${thread.teamId}`;
	}
	const agentId = thread.agentIds.find((id) =>
		snapshot.agents.some((agent) => agent.id === id)
	);
	return agentId ? `agent:${agentId}` : "orphan";
}

/** Conversations waiting on the user: failed runs and replies. */
export function needsYou(thread: InterfaceThread): boolean {
	const status = threadStatus(thread);
	return status === "attention" || status === "your-turn";
}

export function needsYouCount(snapshot: InterfaceSnapshot): number {
	return snapshot.threads.filter(needsYou).length;
}

/** The most urgent conversation waiting on the user, if any. */
export function firstNeedingYou(
	snapshot: InterfaceSnapshot
): InterfaceThread | undefined {
	return snapshot.threads
		.filter((thread) => {
			const status = threadStatus(thread);
			return status === "attention" || status === "your-turn";
		})
		.sort(byUrgency)[0];
}
