// apps/desktop/src/lib/api/chat.ts
//
// Typed client for Core's chat streaming endpoint (`/api/chat/stream`). The chat
// page drives an AI SDK `useChat` transport, so rather than owning the fetch this
// module exposes the endpoint URL + auth headers the transport needs. Centralizing
// it here keeps base-URL + bearer handling out of the page.

import { type ApiTarget, apiUrl, makeHeaders, request } from "./client.ts";

/** Absolute URL of the streaming chat endpoint for a given node. */
export function chatStreamUrl(target: ApiTarget): string {
	return apiUrl(target, "/api/chat/stream");
}

/** Auth headers (bearer token when present) for the chat transport. */
export function chatHeaders(target: ApiTarget): Record<string, string> {
	const headers = makeHeaders(target.token);
	// The AI SDK transport sets its own content-type per request; only the
	// Authorization header needs to be carried here.
	const auth: Record<string, string> = {};
	if (headers.Authorization) {
		auth.Authorization = headers.Authorization;
	}
	return auth;
}

/**
 * Resume URL for reconnecting to a running ACP turn's live UI frame stream.
 * The endpoint returns the accumulated reply text as a synthetic replay, then
 * forwards live frames until the turn completes. Returns 404 when no turn is
 * running.
 */
export function chatStreamResumeUrl(
	target: ApiTarget,
	conversationId: string
): string {
	return apiUrl(
		target,
		`/api/chat/stream/resume/${encodeURIComponent(conversationId)}`
	);
}

/**
 * Ask Core to cancel the live ACP turn for a conversation. Aborting the SSE
 * stream on the client only stops reading — the agent keeps running to
 * completion server-side — so the Stop button also fires this. Best-effort:
 * Core returns `{ cancelled: false }` when there is no live turn.
 */
export async function cancelChat(
	target: ApiTarget,
	conversationId: string
): Promise<boolean> {
	const res = await request<{ cancelled: boolean }>(
		target,
		"/api/chat/cancel",
		{ method: "POST", body: { conversation_id: conversationId } }
	);
	return res.cancelled;
}

/**
 * Ask Core for ChatGPT-style next-prompt suggestions once the assistant has
 * finished a turn. Best-effort: Core returns an empty list (never an error) when
 * suggestions are disabled or no model is available, and network failures are
 * swallowed to an empty list so the composer simply shows no chips.
 */
export async function fetchNextPromptSuggestions(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<string[]> {
	try {
		const res = await request<{ suggestions?: string[] }>(
			target,
			"/api/chat/suggestions",
			{
				method: "POST",
				body: { conversation_id: conversationId },
				signal,
			}
		);
		return res.suggestions ?? [];
	} catch {
		return [];
	}
}
