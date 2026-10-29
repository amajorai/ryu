import { z } from "zod";
// apps/desktop/src/lib/api/conversation-search.ts
//
// Typed client for Core's exact + semantic chat-message search
// (`GET /api/conversations/search`), the human-facing surface of the
// `search_conversations` capability. Core merges lexical exact hits with a KNN
// over the message index (lazily backfilling older chats), and re-decrypts each
// hit's snippet.
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
		const params = new URLSearchParams({
			limit: String(limit),
			mode: "all",
			q,
		});
		const raw = await request(
			target,
			`/api/conversations/search?${params}`,
			{ signal },
			rawResultResponseSchema
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

const rawHitResponseSchema = z
	.object({
		content: z.string().optional(),
		conversation_id: z.string().optional(),
		created_at: z.number().optional(),
		message_id: z.string().optional(),
		role: z.string().optional(),
		score: z.number().optional(),
	})
	.passthrough();

const rawResultResponseSchema = z
	.object({
		hits: z.array(rawHitResponseSchema).optional(),
		indexed: z.boolean().optional(),
	})
	.passthrough();
