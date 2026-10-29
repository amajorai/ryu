import { z } from "zod";

/**
 * Remembers what the user decided on a consent card, keyed by the tool call,
 * so a reopened conversation shows the card closed instead of asking again.
 *
 * Stored on this device only. The decision itself already reached the agent as
 * the user's message; this record only keeps the card from offering a second,
 * contradictory answer. Storage failures (private mode, quota, blocked site
 * data) fall back to the in-memory card state.
 */

const KEY_PREFIX = "ryu.consent-decision:";

const decisionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("connected") }),
	z.object({ kind: z.literal("declined") }),
	z.object({ kind: z.literal("unavailable") }),
	z.object({ id: z.string().min(1), kind: z.literal("installed") }),
]);

export type ConsentDecision = z.output<typeof decisionSchema>;

export function readConsentDecision(
	toolCallId: string | undefined
): ConsentDecision | null {
	if (!toolCallId) {
		return null;
	}
	try {
		const raw = globalThis.localStorage?.getItem(KEY_PREFIX + toolCallId);
		if (!raw) {
			return null;
		}
		const parsed = decisionSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function writeConsentDecision(
	toolCallId: string | undefined,
	decision: ConsentDecision
): void {
	if (!toolCallId) {
		return;
	}
	try {
		globalThis.localStorage?.setItem(
			KEY_PREFIX + toolCallId,
			JSON.stringify(decision)
		);
	} catch {
		// Keep the in-memory state; the card still closes for this session.
	}
}
