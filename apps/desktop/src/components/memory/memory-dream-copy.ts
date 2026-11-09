import type { LiteralMessage } from "@ryu/i18n/react";

// Core's Dream review (`apps/core/src/server/memory_dream/`) still sends a
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

/** Core's rationale when the model proposed an archive without a reason. */
export const CORE_DREAM_ARCHIVE_REASON_FALLBACK =
	"Recent chats suggest this memory no longer holds; review before archiving.";

/** Core's rationale for archiving an old event no chat has used lately. */
export const CORE_DREAM_STALE_EVENT_REASON =
	"This event is more than 90 days old and no chat has used it in the last 90 days.";

/**
 * The same rationale as Core worded it before recall tracking was counted per
 * window. Proposals persisted then still carry it; it renders as the current
 * sentence, which is also true of them.
 */
export const CORE_DREAM_STALE_EVENT_REASON_LEGACY =
	"This event is more than 90 days old and no chat has used it since it was saved.";

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
	if (text === CORE_DREAM_ARCHIVE_REASON_FALLBACK) {
		return tl(
			"Recent chats suggest this memory no longer holds; review before archiving."
		);
	}
	if (
		text === CORE_DREAM_STALE_EVENT_REASON ||
		text === CORE_DREAM_STALE_EVENT_REASON_LEGACY
	) {
		return tl(
			"This event is more than 90 days old and no chat has used it in the last 90 days."
		);
	}
	return text;
}

/** Core's 409s for an Undo of a proposal that is no longer accepted. */
export const CORE_DREAM_UNDO_NOT_APPLIED: readonly string[] = [
	"only an accepted proposal can be undone",
	"proposal is no longer applied",
];

/** Core's 409s for an Undo whose memory was deleted since it was accepted. */
export const CORE_DREAM_UNDO_MEMORY_DELETED: readonly string[] = [
	"archived memory no longer exists",
	"revision memory no longer exists",
];

/**
 * Why Core refused an Undo with 409: the change is no longer accepted
 * (`gone`), a memory it touched was deleted (`deleted`), or a later change
 * builds on it (`later`). `stillListed` is whether Core's refreshed review
 * still lists the change as undoable, or null when that refresh failed.
 */
export function undoConflictKind(
	serverMessage: string | null | undefined,
	stillListed: boolean | null
): "deleted" | "gone" | "later" {
	const message = trimmed(serverMessage) ?? "";
	if (stillListed === false || CORE_DREAM_UNDO_NOT_APPLIED.includes(message)) {
		return "gone";
	}
	if (CORE_DREAM_UNDO_MEMORY_DELETED.includes(message)) {
		return "deleted";
	}
	return "later";
}

/**
 * The `code` Core sends with a 409 when an Accept or Reject could not change
 * a proposal (`apps/core/src/server/memory_dream/review.rs`).
 */
export const CORE_DREAM_REVIEW_CONFLICTS = [
	"already_accepted",
	"already_rejected",
	"already_undone",
	"target_deleted",
	"target_changed",
] as const;

/** Why Core refused an Accept or Reject; `handled` when it sent no known code. */
export type ReviewConflictKind =
	| (typeof CORE_DREAM_REVIEW_CONFLICTS)[number]
	| "handled";

/**
 * The cause of a 409 for an Accept or Reject. A Core from before these codes
 * only said the proposal was no longer pending, which reads as `handled`.
 */
export function reviewConflictKind(
	code: string | null | undefined
): ReviewConflictKind {
	return CORE_DREAM_REVIEW_CONFLICTS.find((kind) => kind === code) ?? "handled";
}
