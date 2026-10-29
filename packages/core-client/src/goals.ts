// apps/desktop/src/lib/api/goals.ts
//
// Typed client for Core's goal (`/goal`) endpoints. A goal is a persistent
// completion condition attached to a conversation; a separate judge model
// evaluates progress after each turn. Core owns the goal state and the judge
// call (routed through the Gateway); the continuation loop is driven here on the
// client. See apps/core/src/server/mod.rs (goal handlers) and conversations.rs.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

// Complete native persisted GoalState. Optional fields are omitted by serde
// when there is no goal; readback canonicalizes persisted status to three values.
const goalStateFieldsSchema = z.object({
	achieved_at: z.number().optional(),
	goal: z.string().optional(),
	last_reason: z.string().optional(),
	started_at: z.number().optional(),
	status: z.enum(["active", "paused", "achieved"]).optional(),
	turns: z.number(),
});
export const goalStateResponseSchema = z.custom<
	z.output<typeof goalStateFieldsSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		goalStateFieldsSchema.safeParse(value).success
);
const goalClearFieldsSchema = z.object({ success: z.boolean() });
const goalClearResponseSchema = z.custom<
	z.output<typeof goalClearFieldsSchema>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		goalClearFieldsSchema.safeParse(value).success
);

/** Goal state for a conversation, mirroring Core's `GoalState`. */
export interface GoalState {
	/** Unix milliseconds when the judge marked the goal achieved. */
	achieved_at?: number;
	/** The completion condition. Absent when no goal is set. */
	goal?: string;
	/** The judge's most recent reason for its yes/no verdict. */
	last_reason?: string;
	/** Unix milliseconds when the goal was set (drives the elapsed timer). */
	started_at?: number;
	/** "active" | "paused" | "achieved" | absent (no goal). */
	status?: "active" | "paused" | "achieved";
	/** Number of turns the judge has evaluated. */
	turns: number;
}

/** Read the current goal state for a conversation. */
export function getGoal(
	target: ApiTarget,
	conversationId: string
): Promise<GoalState> {
	return request(
		target,
		`/api/conversations/${conversationId}/goal`,
		{},
		goalStateResponseSchema
	);
}

/** Set or replace the goal on a conversation. Returns the new state. */
export function setGoal(
	target: ApiTarget,
	conversationId: string,
	goal: string
): Promise<GoalState> {
	return request(
		target,
		`/api/conversations/${conversationId}/goal`,
		{ method: "PUT", body: { goal } },
		goalStateResponseSchema
	);
}

/** Clear an active goal on a conversation. */
export async function clearGoal(
	target: ApiTarget,
	conversationId: string
): Promise<void> {
	await request(
		target,
		`/api/conversations/${conversationId}/goal`,
		{
			method: "DELETE",
		},
		goalClearResponseSchema
	);
}

/** Persistently pause the goal loop without creating a chat turn. */
export function pauseGoal(
	target: ApiTarget,
	conversationId: string
): Promise<GoalState> {
	return request(
		target,
		`/api/conversations/${conversationId}/goal/pause`,
		{ method: "POST" },
		goalStateResponseSchema
	);
}

/** Persistently resume the goal loop without creating a chat turn. */
export function resumeGoal(
	target: ApiTarget,
	conversationId: string
): Promise<GoalState> {
	return request(
		target,
		`/api/conversations/${conversationId}/goal/resume`,
		{ method: "POST" },
		goalStateResponseSchema
	);
}
