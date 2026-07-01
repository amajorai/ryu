// apps/desktop/src/lib/api/chat.ts
//
// Typed client for Core's chat streaming endpoint (`/api/chat/stream`). The chat
// page drives an AI SDK `useChat` transport, so rather than owning the fetch this
// module exposes the endpoint URL + auth headers the transport needs. Centralizing
// it here keeps base-URL + bearer handling out of the page.

import { type ApiTarget, apiUrl, makeHeaders } from "./client.ts";

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
