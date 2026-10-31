import type { LiteralMessage } from "@ryu/i18n";

/** A reply chain is long enough to benefit from a focused fork at this size. */
export const REPLY_THREAD_SUGGESTION_THRESHOLD = 3;

export function shouldSuggestReplyThread(chainLength: number): boolean {
	return chainLength >= REPLY_THREAD_SUGGESTION_THRESHOLD;
}

export function replyThreadDescription(
	chainLength: number,
	tl: LiteralMessage
): string {
	return tl(
		"This reply is part of a {chainLength}-turn chain. Keep the context in a focused thread.",
		{ chainLength: String(chainLength) }
	);
}
