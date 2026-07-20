// apps/desktop/src/lib/api/conversation-search.ts
//
// Typed client for Core's semantic chat-message search
// (`GET /api/conversations/search`), the human-facing surface of the
// `search_conversations` capability. Core embeds the query, runs a KNN over the
// message index (lazily backfilling older chats), and re-decrypts each hit's
// snippet — so results match by meaning, not substring.
//
// `indexed: false` means the message index isn't wired (e.g. the embedder
// sidecar never ran), so the caller can explain the absence rather than implying
// the chats are empty.

import { type ApiTarget, request } from "./client.ts";

/** A single semantic message match. */
export interface MessageSearchHit {
	/** Decrypted message text. */
	content: string;
	conversationId: string;
	/** Unix milliseconds. */
	createdAt: number;
	messageId: string;
	/** "user" | "assistant" | … */
	role: string;
	/** Relevance in [0, 1] (higher is closer). */
	score: number;
}

/** Result of {@link searchConversations}. */
export interface MessageSearchResult {
	hits: MessageSearchHit[];
	/** False when Core has no message index wired (embedder never ran). */
	indexed: boolean;
}

interface RawHit {
	content?: string;
	conversation_id?: string;
	created_at?: number;
	message_id?: string;
	role?: string;
	score?: number;
}

interface RawResult {
	hits?: RawHit[];
	indexed?: boolean;
}

/**
 * Semantic search over past chat messages. Returns `{ hits: [], indexed: true }`
 * for an empty/whitespace query. Resolves to `null` on any transport failure
 * (Core unreachable, or an older binary without the route) so the caller can
 * fall back silently — search is a soft enhancement to the command palette.
 */
export async function searchConversations(
	target: ApiTarget,
	query: string,
	limit = 8,
	signal?: AbortSignal
): Promise<MessageSearchResult | null> {
	const q = query.trim();
	if (!q) {
		return { hits: [], indexed: true };
	}
	try {
		const params = new URLSearchParams({ q, limit: String(limit) });
		const raw = await request<RawResult>(
			target,
			`/api/conversations/search?${params}`,
			{ signal }
		);
		return {
			indexed: raw.indexed ?? true,
			hits: (raw.hits ?? []).map((h) => ({
				conversationId: h.conversation_id ?? "",
				messageId: h.message_id ?? "",
				role: h.role ?? "",
				content: h.content ?? "",
				createdAt: h.created_at ?? 0,
				score: h.score ?? 0,
			})),
		};
	} catch {
		return null;
	}
}
