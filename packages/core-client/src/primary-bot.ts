import { z } from "zod";
import {
	ApiError,
	type ApiTarget,
	type RequestOptions,
	request,
} from "./client.ts";

/** Caller-owned selection on the connected node. Projects own their coordinator. */
export const primaryBotSelectionSchema = z.object({
	agentId: z.string().nullable(),
	effectiveAgentId: z.string().nullable(),
	revision: z.number().int().nonnegative(),
	source: z.enum(["selected", "default"]),
	unavailableReason: z.string().nullable(),
});

export type PrimaryBotSelection = z.infer<typeof primaryBotSelectionSchema>;

const mainThreadSchema = z.object({ conversation_id: z.unknown().optional() });

async function primaryRequest<T>(
	target: ApiTarget,
	path: string,
	options: RequestOptions | undefined,
	codec: z.ZodType<T>
): Promise<T> {
	try {
		return await request(target, path, options, codec);
	} catch (error) {
		// Preserve structured status while showing the owner's recovery instruction.
		if (error instanceof ApiError && error.serverMessage) {
			error.message = error.serverMessage;
		}
		throw error;
	}
}

export function getPrimaryBot(target: ApiTarget): Promise<PrimaryBotSelection> {
	return primaryRequest(
		target,
		"/api/primary-bot",
		undefined,
		primaryBotSelectionSchema
	);
}

/** Compare-and-set: refresh after a conflict before explicitly trying again. */
export function setPrimaryBot(
	target: ApiTarget,
	input: { agentId: string | null; expectedRevision: number }
): Promise<PrimaryBotSelection> {
	return primaryRequest(
		target,
		"/api/primary-bot",
		{ method: "PUT", body: input },
		primaryBotSelectionSchema
	);
}

/** Open the bot's durable main thread without retargeting existing sessions. */
export async function ensurePrimaryBotConversation(
	target: ApiTarget,
	agentId: string
): Promise<string> {
	const result = await primaryRequest(
		target,
		"/api/hierarchy/main-threads",
		{
			method: "POST",
			body: { owner_kind: "agent", owner_id: agentId, agent_id: agentId },
		},
		mainThreadSchema
	);
	const conversationId = result.conversation_id;
	if (typeof conversationId !== "string" || !conversationId.trim()) {
		throw new Error(
			"Core did not return a main conversation ID. Reconnect and try opening the bot again."
		);
	}
	return conversationId;
}
