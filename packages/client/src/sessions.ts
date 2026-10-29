import { z } from "zod";
// packages/client/src/sessions.ts
//
// SessionsAPI: typed client for Core's conversation endpoints
// (/api/conversations). A conversation is a persisted session with message
// history and optional agent binding.

import { request } from "./request.ts";
import type { Conversation, RyuClientOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// Wire shapes (snake_case from Core)
// ---------------------------------------------------------------------------

const conversationWireSchema = z.object({
	agent_id: z.string().nullish(),
	created_at: z.string().nullish(),
	id: z.string(),
	title: z.string().nullish(),
	updated_at: z.string().nullish(),
});
type ConversationWire = z.infer<typeof conversationWireSchema>;
const conversationListSchema = z.object({
	conversations: z.array(conversationWireSchema).nullish(),
});

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toConversation(c: ConversationWire): Conversation {
	return {
		id: c.id,
		agentId: c.agent_id ?? null,
		title: c.title ?? null,
		createdAt: c.created_at ?? null,
		updatedAt: c.updated_at ?? null,
	};
}

// ---------------------------------------------------------------------------
// API class
// ---------------------------------------------------------------------------

export class SessionsAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	/** List all conversations, most recent first. */
	async list(): Promise<Conversation[]> {
		const data = await request(
			this.options,
			"/api/conversations",
			undefined,
			conversationListSchema.parse
		);
		return (data.conversations ?? []).map(toConversation);
	}

	/**
	 * Fetch a single conversation by id. Core returns the conversation detail
	 * object directly (not wrapped), so we map it as-is.
	 */
	async get(id: string): Promise<Conversation> {
		const data = await request(
			this.options,
			`/api/conversations/${encodeURIComponent(id)}`,
			undefined,
			conversationWireSchema.parse
		);
		return toConversation(data);
	}
}
