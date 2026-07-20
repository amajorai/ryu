// apps/desktop/src/lib/api/btw.ts
//
// Typed client for Core's `/btw` side-question endpoint. A `/btw` question
// (modeled on Claude Code's interactive `/btw`) asks something about the current
// conversation WITHOUT adding to the chat history: it sees the conversation
// context but has no tool access and returns a single answer the UI shows in an
// overlay.
//
// The answer is also persisted as a lightweight "side chat" keyed to its parent
// conversation, so it can be listed later in the Context rail and under the
// thread in the sidebar (see listBtw/deleteBtw). The desktop passes the Core
// `conversation_id` (Core holds the authoritative transcript); the model/effort
// live in preferences (see preferences.ts). See apps/core/src/server/mod.rs
// `btw_handler`.

import { type ApiTarget, request } from "./client.ts";

/** One `/btw` side-question answer. */
export interface BtwResult {
	/** The model's answer to the side question (Markdown). */
	answer: string;
	/** The id of the persisted side chat (null when not persisted). */
	id?: string | null;
	/** The model id that answered (resolved server-side). */
	model: string;
}

/** A persisted `/btw` side chat, as returned by the list endpoint. */
export interface BtwEntry {
	agent_id?: string | null;
	answer: string;
	child_conversation_id?: string | null;
	conversation_id: string;
	/** Unix milliseconds. */
	created_at: number;
	id: string;
	kind?: "btw" | "subagent" | string;
	model?: string | null;
	preset?: string | null;
	question: string;
}

/** Ask a side question against a conversation's context (also persisted). */
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

/** List a conversation's persisted side chats, newest first. */
export function listBtw(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<BtwEntry[]> {
	return request<BtwEntry[]>(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/btw`,
		{ signal }
	);
}

/** Delete a single persisted side chat by id. */
export function deleteBtw(
	target: ApiTarget,
	id: string,
	signal?: AbortSignal
): Promise<void> {
	return request<void>(target, `/api/btw/${encodeURIComponent(id)}`, {
		method: "DELETE",
		signal,
	});
}
