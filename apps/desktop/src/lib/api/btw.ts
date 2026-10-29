import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
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
// `conversation_id` plus the visible main-chat transcript; the model/effort live
// in preferences (see preferences.ts). See apps/core/src/server/mod.rs
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

/** A bounded, plain-text turn from the main chat sent as side-chat context. */
export interface BtwMessage {
	content: string;
	role: "user" | "assistant";
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

/** Ask a side question against the current main-chat context (also persisted). */
export function askBtw(
	target: ApiTarget,
	conversationId: string,
	question: string,
	messages: readonly BtwMessage[] = [],
	signal?: AbortSignal,
	model?: string
): Promise<BtwResult> {
	return request<BtwResult>(
		target,
		"/api/btw",
		{
			method: "POST",
			body: {
				question,
				conversation_id: conversationId,
				...(messages.length > 0 ? { messages } : undefined),
				...(model?.trim() ? { model: model.trim() } : undefined),
			},
			signal,
		},
		btwResultResponseCodec
	);
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
		{ signal },
		responseCodec1
	);
}

/** Delete a single persisted side chat by id. */
export function deleteBtw(
	target: ApiTarget,
	id: string,
	signal?: AbortSignal
): Promise<void> {
	return request<void>(
		target,
		`/api/btw/${encodeURIComponent(id)}`,
		{
			method: "DELETE",
			signal,
		},
		responseCodec2
	);
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const btwResultResponseCodec = z
	.object({
		answer: z.string(),
		id: z.union([z.string(), z.null()]).optional(),
		model: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const btwEntryResponseCodec = z
	.object({
		agent_id: z.union([z.string(), z.null()]).optional(),
		answer: z.string(),
		child_conversation_id: z.union([z.string(), z.null()]).optional(),
		conversation_id: z.string(),
		created_at: z.number(),
		id: z.string(),
		kind: z.string().optional(),
		model: z.union([z.string(), z.null()]).optional(),
		preset: z.union([z.string(), z.null()]).optional(),
		question: z.string(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec1 = z.array(btwEntryResponseCodec);
const responseCodec2 = gatewayJsonValueSchema
	.optional()
	.transform(() => undefined);
