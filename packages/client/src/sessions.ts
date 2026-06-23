// packages/client/src/sessions.ts
//
// SessionsAPI: typed client for Core's conversation endpoints
// (/api/conversations). A conversation is a persisted session with message
// history and optional agent binding.

import { request } from "./request";
import type { Conversation, RyuClientOptions } from "./types";

// ---------------------------------------------------------------------------
// Wire shapes (snake_case from Core)
// ---------------------------------------------------------------------------

interface ConversationWire {
	agent_id?: string | null;
	created_at?: string | null;
	id: string;
	title?: string | null;
	updated_at?: string | null;
}

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
		const data = await request<{ conversations?: ConversationWire[] }>(
			this.options,
			"/api/conversations"
		);
		return (data.conversations ?? []).map(toConversation);
	}

	/**
	 * Fetch a single conversation by id. Core returns the conversation detail
	 * object directly (not wrapped), so we map it as-is.
	 */
	async get(id: string): Promise<Conversation> {
		const data = await request<ConversationWire>(
			this.options,
			`/api/conversations/${encodeURIComponent(id)}`
		);
		return toConversation(data);
	}
}
