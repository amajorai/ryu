import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
// apps/desktop/src/lib/api/chat.ts
//
// Typed client for Core's chat streaming endpoint (`/api/chat/stream`). The chat
// page drives an AI SDK `useChat` transport, so rather than owning the fetch this
// module exposes the endpoint URL + auth headers the transport needs. Centralizing
// it here keeps base-URL + bearer handling out of the page.

import {
	type ApiTarget,
	apiUrl,
	makeHeaders,
	request,
	USER_JWT_HEADER,
} from "./client.ts";

// Complete actual proactive opening and turn-control publisher fields; raw
// future metadata remains attached to the original decoded response.
const openingFields = z.object({
	conversation_id: z.string(),
	reply: z.string().optional(),
	status: z.enum(["already_completed", "completed", "pending"]),
});
const cancelledFields = z.object({ cancelled: z.boolean() });
const answerNowFields = z.object({
	accepted: z.boolean(),
	action: z.string().optional(),
	strategy: z.string().optional(),
});
const suggestionsFields = z.object({
	suggestions: z.array(z.string()).optional(),
});
const predictionFields = z.object({
	prediction: z.string().nullable().optional(),
});
const openingResponseSchema = z.custom<z.output<typeof openingFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		openingFields.safeParse(value).success
);
const cancelledResponseSchema = z.custom<z.output<typeof cancelledFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		cancelledFields.safeParse(value).success
);
const answerNowResponseSchema = z.custom<z.output<typeof answerNowFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		answerNowFields.safeParse(value).success
);
const suggestionsResponseSchema = z.custom<z.output<typeof suggestionsFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		suggestionsFields.safeParse(value).success
);
const predictionResponseSchema = z.custom<z.output<typeof predictionFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		predictionFields.safeParse(value).success
);

/** Cloud execution resolves setup and credentials on Core, using only this opaque ID. */
export interface CloudChatRequestFields {
	cloudEnvironmentId?: string;
}

/** Absolute URL of the streaming chat endpoint for a given node. */
export function chatStreamUrl(target: ApiTarget): string {
	return apiUrl(target, "/api/chat/stream");
}

/** Auth headers (bearer token when present) for the chat transport. */
export function chatHeaders(target: ApiTarget) {
	const headers = makeHeaders(target.token, target.userJwt);
	// The AI SDK transport sets its own content-type per request, so carry only
	// the credentials: the node bearer and, on a shared node, the user identity
	// that lets Core attribute the turn and enforce per-member access.
	const auth: Record<string, string> = {};
	if (headers.Authorization) {
		auth.Authorization = headers.Authorization;
	}
	if (headers[USER_JWT_HEADER]) {
		auth[USER_JWT_HEADER] = headers[USER_JWT_HEADER];
	}
	return auth;
}

/** URL for reconnecting to an active ACP turn's replay/live stream. */
export function chatStreamResumeUrl(
	target: ApiTarget,
	conversationId: string
): string {
	return apiUrl(
		target,
		`/api/chat/stream/resume/${encodeURIComponent(conversationId)}`
	);
}

export interface ProactiveOpeningResponse {
	conversation_id: string;
	reply?: string;
	status: "already_completed" | "completed" | "pending";
}

/** Start or resume the one-time assistant-first opening for a conversation. */
export async function startProactiveOpening(
	target: ApiTarget,
	conversationId: string,
	agentId = "ryu",
	idempotencyKey?: string
): Promise<ProactiveOpeningResponse> {
	return request(
		target,
		"/api/proactive/opening",
		{
			method: "POST",
			body: {
				conversation_id: conversationId,
				agent_id: agentId,
				idempotency_key: idempotencyKey,
			},
		},
		openingResponseSchema
	);
}

/** Cancel a live chat turn. Aborting the client stream alone does not stop Core. */
export async function cancelChat(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<boolean> {
	const response = await request(
		target,
		"/api/chat/cancel",
		{ method: "POST", body: { conversation_id: conversationId }, signal },
		cancelledResponseSchema
	);
	return response.cancelled;
}

/** Ask a supported native provider to leave reasoning and continue the answer. */
export async function answerNowChat(
	target: ApiTarget,
	conversationId: string,
	turnId: string
): Promise<boolean> {
	const response = await request(
		target,
		"/api/chat/control",
		{
			method: "POST",
			body: {
				action: "answer_now",
				conversation_id: conversationId,
				turn_id: turnId,
			},
		},
		answerNowResponseSchema
	);
	return response.accepted;
}

/** Fetch post-turn prompt suggestions; failures intentionally degrade to no chips. */
export async function fetchNextPromptSuggestions(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<string[]> {
	try {
		const response = await request(
			target,
			"/api/chat/suggestions",
			{
				method: "POST",
				body: { conversation_id: conversationId },
				signal,
			},
			suggestionsResponseSchema
		);
		return response.suggestions ?? [];
	} catch {
		return [];
	}
}

/**
 * Fetch the composer prediction (the user's likely next message) for a settled
 * turn. `null` when Core abstains, the plugin is off, or the request fails.
 */
export async function fetchComposerPrediction(
	target: ApiTarget,
	conversationId: string,
	signal?: AbortSignal
): Promise<string | null> {
	try {
		const response = await request(
			target,
			"/api/chat/prediction",
			{
				method: "POST",
				body: { conversation_id: conversationId },
				signal,
			},
			predictionResponseSchema
		);
		return response.prediction?.trim() || null;
	} catch {
		return null;
	}
}
