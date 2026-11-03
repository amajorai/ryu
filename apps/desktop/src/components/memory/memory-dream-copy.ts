import type { LiteralMessage } from "@ryu/i18n/react";

// Core's Dream review (`apps/core/src/server/memory_dream.rs`) still sends a
// few fixed English sentences as data: the review summary, the proposal
// source badge and the rationale used when the model gave none. Rows persisted
// before any Core change keep them too. Recognise those exact literals here and
// render the reader's language instead; model-written text already follows the
// node UI language (`with_dream_language`) and passes through untouched.
// `memory-dream-copy.test.ts` greps the Core file, so a wording change there
// fails the test instead of silently showing English again.

/**
 * Core summaries that carry no information beyond "proposals are pending".
 * A set, not a copy list: these are matched, never rendered.
 */
export const CORE_DREAM_SUMMARY_FALLBACKS: ReadonlySet<string> = new Set([
	"Chat-derived suggestions waiting for your review.",
	"Dream decomposed recent chats into reviewable memory suggestions.",
	"No recent chat sources are available to decompose.",
]);

/** Core's fixed proposal source label. */
export const CORE_DREAM_CHAT_SOURCE = "Chat decomposition";

/** Core's rationale when the model returned no reason. */
export const CORE_DREAM_REASON_FALLBACK =
	"Derived from recent chat context; review before saving.";

function trimmed(value: string | null | undefined): string | null {
	const text = value?.trim();
	return text ? text : null;
}

/**
 * The review status line: a model-written summary as sent, otherwise the
 * localized pending count (Core's English fallbacks count as no summary).
 */
export function dreamSummary(
	review: { proposals: readonly unknown[]; summary: string | null },
	tl: LiteralMessage
): string {
	const summary = trimmed(review.summary);
	if (summary && !CORE_DREAM_SUMMARY_FALLBACKS.has(summary)) {
		return summary;
	}
	return tl(
		"{count, plural, one {# proposal} other {# proposals}} waiting for your review.",
		{ count: review.proposals.length }
	);
}

/** The proposal source badge, or null when Core sent none. */
export function dreamSource(
	source: string | null | undefined,
	tl: LiteralMessage
): string | null {
	const text = trimmed(source);
	if (text === CORE_DREAM_CHAT_SOURCE) {
		return tl("Chat decomposition");
	}
	return text;
}

/** The proposal reason, or null when Core sent none. */
export function dreamReason(
	reason: string | null | undefined,
	tl: LiteralMessage
): string | null {
	const text = trimmed(reason);
	if (text === CORE_DREAM_REASON_FALLBACK) {
		return tl("Derived from recent chat context; review before saving.");
	}
	return text;
}
