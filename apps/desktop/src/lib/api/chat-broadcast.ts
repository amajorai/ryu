import { modelContextParts } from "@ryu/app-host/model-context";
import { z } from "zod";
import {
	ApiError,
	type ApiTarget,
	apiUrl,
	readJsonBody,
	request,
	requestHeaders,
} from "./client.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";

/** The summary the Chat Broadcast companion is allowed to render. */
export interface ChatBroadcastConversation {
	agent_id: string | null;
	archived?: boolean;
	created_at: number;
	id: string;
	last_message?: string;
	last_message_at?: number;
	last_message_role?: string;
	message_count: number;
	run_status: string | null;
	title: string | null;
	updated_at: number;
}

export interface ChatBroadcastSendInput {
	conversationId: string;
	text: string;
	widgetFollowUpTicket?: string;
}

export interface ChatBroadcastSendResult {
	conversation_id: string;
	status: "accepted";
}

const conversationSummarySchema = z
	.object({
		agent_id: z.string().nullable(),
		archived: z.boolean().optional(),
		created_at: z.number(),
		id: z.string(),
		last_message: z.string().optional(),
		last_message_at: z.number().optional(),
		last_message_role: z.string().optional(),
		message_count: z.number(),
		run_status: z.string().nullable(),
		title: z.string().nullable(),
		updated_at: z.number(),
	})
	.passthrough();
const conversationListSchema = z
	.object({ conversations: z.array(conversationSummarySchema).optional() })
	.passthrough();
const conversationDetailSchema = z
	.object({
		agent_id: z.string().nullable(),
		messages: z
			.array(
				z
					.object({
						content: z.string(),
						parts: z.array(gatewayJsonValueSchema).optional(),
						role: z.string(),
					})
					.passthrough()
			)
			.optional(),
	})
	.passthrough();
const CHAT_STREAM_PATH = "/api/chat/stream";

/** List every conversation visible to the signed-in user, including idle chats. */
export async function listChatBroadcastConversations(
	target: ApiTarget
): Promise<ChatBroadcastConversation[]> {
	const response = await request(
		target,
		"/api/conversations?preview=1",
		undefined,
		conversationListSchema
	);
	return Array.isArray(response.conversations) ? response.conversations : [];
}

/**
 * Append one real user turn to an existing conversation.
 *
 * Core's OpenAI-compatible route expects the client-held transcript, while ACP
 * uses the conversation id to continue its queued session. The trusted host
 * therefore loads the full transcript here, adds the new text and the owning
 * conversation's current app context, and then
 * drops the SSE body after Core accepts it. Core keeps the completion task alive
 * after the client disconnects, so a broadcast does not need a visible stream
 * per target and the sandbox never receives assistant content.
 */
export async function sendChatBroadcastTurn(
	target: ApiTarget,
	input: ChatBroadcastSendInput
): Promise<ChatBroadcastSendResult> {
	const conversation = await request(
		target,
		`/api/conversations/${encodeURIComponent(input.conversationId)}`,
		undefined,
		conversationDetailSchema
	);
	const messages = (conversation.messages ?? []).map((message) => ({
		content: message.content,
		parts: Array.isArray(message.parts) ? message.parts : [],
		role: message.role === "assistant" ? "assistant" : "user",
	}));
	const context = modelContextParts(`${target.url}:${input.conversationId}`);
	messages.push({
		content: input.text,
		parts: context.length
			? [{ type: "text", text: input.text }, ...context]
			: [],
		role: "user",
	});

	const response = await fetch(apiUrl(target, CHAT_STREAM_PATH), {
		body: JSON.stringify({
			widget_follow_up_ticket: input.widgetFollowUpTicket,
			agent_id: conversation.agent_id ?? undefined,
			conversation_id: input.conversationId,
			enable_long_term: false,
			messages,
			persist: true,
		}),
		headers: await requestHeaders(target),
		method: "POST",
	});
	if (!response.ok) {
		const body = await readJsonBody(
			response,
			CHAT_STREAM_PATH,
			gatewayJsonValueSchema
		);
		throw new ApiError(CHAT_STREAM_PATH, body.status, body.error ?? undefined);
	}

	// The Core completion task is deliberately detached from the SSE generator;
	// cancelling the body stops this host request without stopping the chat turn.
	await response.body?.cancel();
	return {
		conversation_id: input.conversationId,
		status: "accepted",
	};
}
