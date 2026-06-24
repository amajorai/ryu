// apps/desktop/src/lib/api/goals.ts
//
// Typed client for Core's goal (`/goal`) endpoints. A goal is a persistent
// completion condition attached to a conversation; a separate judge model
// evaluates progress after each turn. Core owns the goal state and the judge
// call (routed through the Gateway); the continuation loop is driven here on the
// client. See apps/core/src/server/mod.rs (goal handlers) and conversations.rs.

import { type ApiTarget, request } from "./client.ts";

/** Goal state for a conversation, mirroring Core's `GoalState`. */
export interface GoalState {
	/** The completion condition. Absent when no goal is set. */
	goal?: string;
	/** The judge's most recent reason for its yes/no verdict. */
	last_reason?: string;
	/** Unix milliseconds when the goal was set (drives the elapsed timer). */
	started_at?: number;
	/** "active" | "achieved" | absent (no goal). */
	status?: "active" | "achieved";
	/** Number of turns the judge has evaluated. */
	turns: number;
}

/** One judge evaluation result. */
export interface GoalVerdict {
	/** Whether the judge decided the condition is met. */
	met: boolean;
	/** The judge's short reason for its decision. */
	reason: string;
	/**
	 * Whether the loop must halt regardless of `met` — true when met, or when the
	 * judge was unreachable / its verdict was unparseable (fail-safe is to stop,
	 * never keep looping on garbage).
	 */
	stop: boolean;
	/** Turns evaluated so far (post-increment). */
	turns: number;
}

/** Read the current goal state for a conversation. */
export function getGoal(
	target: ApiTarget,
	conversationId: string
): Promise<GoalState> {
	return request<GoalState>(
		target,
		`/api/conversations/${conversationId}/goal`
	);
}

/** Set or replace the goal on a conversation. Returns the new state. */
export function setGoal(
	target: ApiTarget,
	conversationId: string,
	goal: string
): Promise<GoalState> {
	return request<GoalState>(
		target,
		`/api/conversations/${conversationId}/goal`,
		{ method: "PUT", body: { goal } }
	);
}

/** Clear an active goal on a conversation. */
export async function clearGoal(
	target: ApiTarget,
	conversationId: string
): Promise<void> {
	await request(target, `/api/conversations/${conversationId}/goal`, {
		method: "DELETE",
	});
}

/** Run one judge evaluation against the conversation transcript so far. */
export function judgeGoal(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<GoalVerdict> {
	return request<GoalVerdict>(
		target,
		`/api/conversations/${conversationId}/goal/judge`,
		{ method: "POST", signal }
	);
}
