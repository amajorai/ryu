import { z } from "zod";
import { gatewayJsonValueSchema } from "@/src/lib/api/gateway-json-contracts.ts";
// apps/desktop/src/lib/api/message-feedback.ts
//
// Typed client for thumbs 👍/👎 on an assistant message
// (`POST /api/conversations/:id/messages/:message_id/feedback` +
// `GET /api/conversations/:id/feedback`). The vote is persisted on the message
// and fanned out server-side to the continual-learning reward + RAG-memory
// sinks (each independently consent-gated). See `crate::learning`.
//
// Both calls are best-effort so a transport hiccup never blocks the click: the
// setter resolves the server outcome or `null` on failure, and the getter
// resolves an empty map on failure.

import { type ApiTarget, request } from "./client.ts";

export type FeedbackRating = "up" | "down";

export interface FeedbackOutcome {
	/** A RAG memory fact was recorded (memory sink was on). */
	memoryCaptured: boolean;
	ok: boolean;
	rating: FeedbackRating | null;
	/** A reward was written to the experience buffer (training path was on). */
	rewardCaptured: boolean;
}

/**
 * Set (or clear with `null`) the thumbs feedback on an assistant message.
 * Resolves the server outcome, or `null` on any transport failure.
 */
export async function setMessageFeedback(
	target: ApiTarget,
	conversationId: string,
	messageId: string,
	rating: FeedbackRating | null,
	// A freshly-streamed reply is still rendered under a client-generated id that
	// never reached Core's DB. When this vote is on the latest turn, let the server
	// retarget the newest assistant message so it works before any reload.
	allowLatestFallback = false
): Promise<FeedbackOutcome | null> {
	try {
		const res = await request<{
			ok?: boolean;
			rating?: FeedbackRating | null;
			reward_captured?: boolean;
			memory_captured?: boolean;
		}>(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`,
			{
				method: "POST",
				body: { rating, allow_latest_fallback: allowLatestFallback },
			},
			responseCodec1
		);
		return {
			ok: res.ok ?? true,
			rating: res.rating ?? rating,
			rewardCaptured: res.reward_captured ?? false,
			memoryCaptured: res.memory_captured ?? false,
		};
	} catch {
		return null;
	}
}

/**
 * The persisted thumbs state of a conversation as a `{ messageId: rating }` map
 * (un-rated messages omitted). Resolves an empty map on any transport failure.
 */
export async function getConversationFeedback(
	target: ApiTarget,
	conversationId: string
): Promise<Record<string, FeedbackRating>> {
	try {
		const res = await request<{
			feedback?: Record<string, FeedbackRating>;
		}>(
			target,
			`/api/conversations/${encodeURIComponent(conversationId)}/feedback`,
			undefined,
			responseCodec2
		);
		return res.feedback ?? {};
	} catch {
		return {};
	}
}

// Response codecs validate the consumed native DTO fields and retain JSON extension fields.
const feedbackRatingResponseCodec = z.union([
	z.literal("up"),
	z.literal("down"),
]);
const responseCodec1 = z
	.object({
		ok: z.boolean().optional(),
		rating: z.union([feedbackRatingResponseCodec, z.null()]).optional(),
		reward_captured: z.boolean().optional(),
		memory_captured: z.boolean().optional(),
	})
	.catchall(gatewayJsonValueSchema);
const responseCodec2 = z
	.object({
		feedback: z.record(z.string(), feedbackRatingResponseCodec).optional(),
	})
	.catchall(gatewayJsonValueSchema);
