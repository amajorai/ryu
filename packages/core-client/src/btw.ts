// apps/desktop/src/lib/api/btw.ts
//
// Typed client for Core's `/btw` side-question endpoint. A `/btw` question
// (modeled on Claude Code's interactive `/btw`) asks something about the current
// conversation WITHOUT adding to the chat history: it sees the conversation
// context but has no tool access and returns a single ephemeral answer the UI
// shows in a dismissible overlay and then discards.
//
// Core best-effort persists the aside when a parent conversation is available. The desktop passes the Core
// `conversation_id` (Core holds the authoritative transcript); the model/effort
// live in preferences (see preferences.ts). See apps/core/src/server/mod.rs
// `btw_handler`.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

function nativeResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
export const btwResponseSchema = nativeResponse(
	z.object({
		answer: z.string(),
		model: z.string(),
		id: z.string().nullable().optional(),
	})
);

/** One `/btw` side-question answer. */
export interface BtwResult {
	/** The model's answer to the side question (Markdown). */
	answer: string;
	/** The persisted aside id; null when best-effort storage failed or unavailable. */
	id?: string | null;
	/** The model id that answered (resolved server-side). */
	model: string;
}

/** Ask an ephemeral side question against a conversation's context. */
export function askBtw(
	target: ApiTarget,
	conversationId: string,
	question: string,
	signal?: AbortSignal
): Promise<BtwResult> {
	return request(
		target,
		"/api/btw",
		{
			method: "POST",
			body: { question, conversation_id: conversationId },
			signal,
		},
		btwResponseSchema
	);
}
