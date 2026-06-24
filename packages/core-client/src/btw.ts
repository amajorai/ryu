// apps/desktop/src/lib/api/btw.ts
//
// Typed client for Core's `/btw` side-question endpoint. A `/btw` question
// (modeled on Claude Code's interactive `/btw`) asks something about the current
// conversation WITHOUT adding to the chat history: it sees the conversation
// context but has no tool access and returns a single ephemeral answer the UI
// shows in a dismissible overlay and then discards.
//
// Stateless — Core persists nothing. The desktop passes the Core
// `conversation_id` (Core holds the authoritative transcript); the model/effort
// live in preferences (see preferences.ts). See apps/core/src/server/mod.rs
// `btw_handler`.

import { type ApiTarget, request } from "./client.ts";

/** One `/btw` side-question answer. */
export interface BtwResult {
	/** The model's answer to the side question (Markdown). */
	answer: string;
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
	return request<BtwResult>(target, "/api/btw", {
		method: "POST",
		body: { question, conversation_id: conversationId },
		signal,
	});
}
