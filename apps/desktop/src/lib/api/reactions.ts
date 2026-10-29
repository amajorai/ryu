import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/reactions.ts
//
// Typed client for Core's emoji-reaction surface on a conversation's messages.
//
// The read is deliberately ONE bulk call per conversation rather than one per
// message: a long thread would otherwise open hundreds of requests to render a
// row of chips that is empty on almost every message.
//
// Identity is never sent from here. Core resolves the reacting user from the
// JWT on every write, and resolves `reacted_by_me` against that same subject on
// the read — so a client cannot react as someone else by shaping a body.

import { type ApiTarget, request } from "./client.ts";

const reactionsResponseSchema = z.looseObject({
	count: z.number().optional(),
	emoji: z.string().optional(),
	message_id: z.string().optional(),
	reacted_by_me: z.boolean().optional(),
});
const bodyResponseSchema = z.looseObject({
	reactions: z.array(reactionsResponseSchema).optional(),
});

/**
 * One `(message_id, emoji)` bucket: how many people used that emoji on that
 * message, and whether the calling user is one of them.
 */
export interface ReactionBucket {
	/** How many distinct users reacted with this emoji. */
	count: number;
	emoji: string;
	messageId: string;
	/** True when the JWT subject of the read is in the bucket. */
	reactedByMe: boolean;
}

/** Wire shape, snake_case as Core emits it. */
interface RawBucket {
	count?: number;
	emoji?: string;
	message_id?: string;
	reacted_by_me?: boolean;
}

function normalizeBucket(raw: RawBucket): ReactionBucket {
	return {
		messageId: raw.message_id ?? "",
		emoji: raw.emoji ?? "",
		count: raw.count ?? 0,
		reactedByMe: Boolean(raw.reacted_by_me),
	};
}

/**
 * Every reaction bucket in a conversation
 * (`GET /api/conversations/:id/reactions`).
 *
 * Core returns them ordered by first-reaction time, then emoji — that ordering
 * is what keeps a chip row from reshuffling under the reader's cursor as counts
 * change, so callers must preserve it rather than re-sorting.
 */
export async function listReactions(
	target: ApiTarget,
	conversationId: string
): Promise<ReactionBucket[]> {
	const body = await request(
		target,
		`/api/conversations/${encodeURIComponent(conversationId)}/reactions`,
		undefined,
		bodyResponseSchema
	);
	return (body.reactions ?? []).map(normalizeBucket);
}

function messagePath(conversationId: string, messageId: string): string {
	return `/api/conversations/${encodeURIComponent(
		conversationId
	)}/messages/${encodeURIComponent(messageId)}/reactions`;
}

/**
 * Add `emoji` to a message (`POST …/messages/:messageId/reactions`).
 *
 * `messageId` MUST be a server-assigned id. A client-generated optimistic id
 * 404s by design — there is deliberately no retarget fallback in Core, because
 * silently re-pointing a reaction at whatever row the server later created is
 * how a reaction lands on the wrong message. Callers gate the affordance on
 * {@link isServerAssignedMessageId} instead of catching the 404.
 */
export async function addReaction(
	target: ApiTarget,
	conversationId: string,
	messageId: string,
	emoji: string
): Promise<void> {
	await request(
		target,
		messagePath(conversationId, messageId),
		{
			method: "POST",
			body: { emoji },
		},
		gatewayJsonValueSchema
	);
}

/** Remove the caller's own `emoji` from a message. Same id rule as {@link addReaction}. */
export async function removeReaction(
	target: ApiTarget,
	conversationId: string,
	messageId: string,
	emoji: string
): Promise<void> {
	await request(
		target,
		messagePath(conversationId, messageId),
		{
			method: "DELETE",
			body: { emoji },
		},
		gatewayJsonValueSchema
	);
}

// The "is this id server-assigned?" gate that keeps callers off the 404 path
// lives with the UI that renders the affordance —
// `isServerAssignedMessageId` in
// `@ryu/blocks/desktop/agent-elements/message-reactions`. It is a rendering
// decision (show the picker or not), and putting it here would make
// `packages/blocks` import from `apps/desktop`, which is backwards.
