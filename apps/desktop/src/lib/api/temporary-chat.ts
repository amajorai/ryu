import { z } from "zod";
import type { GatewayJsonValue } from "./gateway-json-contracts.ts";
// Typed client for promoting a client-held temporary chat into Core's durable
// conversation store. Temporary turns do not have server rows until this action.

import { type ApiTarget, request } from "./client.ts";

const conversationResponseSchema = z.looseObject({ id: z.string().optional() });
const saveTemporaryChatResponseSchema = z.looseObject({
	conversation: conversationResponseSchema.optional(),
});

/** Composer flag that opts a temporary chat into read-only personal context. */
export const TEMPORARY_CONTEXT_FLAG = "@ryu/memory/temporary-context";

export interface TemporaryChatMessageInput {
	content: string;
	metadata?: Record<string, GatewayJsonValue>;
	parts?: unknown[];
	role: "assistant" | "user";
}

export interface SaveTemporaryChatInput {
	agentId?: string;
	folderPath?: string;
	messages: TemporaryChatMessageInput[];
}

/** Save a temporary transcript as a normal conversation. */
export async function saveTemporaryChat(
	target: ApiTarget,
	conversationId: string,
	input: SaveTemporaryChatInput
): Promise<void> {
	await request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/save`,
		{
			body: {
				...(input.agentId ? { agent_id: input.agentId } : undefined),
				...(input.folderPath ? { folder_path: input.folderPath } : undefined),
				messages: input.messages.map((message) => ({
					content: message.content,
					...(message.metadata ? { metadata: message.metadata } : undefined),
					parts: message.parts ?? [],
					role: message.role,
				})),
			},
			method: "POST",
		},
		saveTemporaryChatResponseSchema
	);
}
