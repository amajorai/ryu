import { describe, expect, it } from "bun:test";
import {
	REPLY_THREAD_SUGGESTION_THRESHOLD,
	replyThreadDescription,
	shouldSuggestReplyThread,
} from "./reply-thread.ts";

describe("reply thread suggestion", () => {
	it("waits until a reply chain reaches three turns", () => {
		expect(
			shouldSuggestReplyThread(REPLY_THREAD_SUGGESTION_THRESHOLD - 1)
		).toBe(false);
		expect(shouldSuggestReplyThread(REPLY_THREAD_SUGGESTION_THRESHOLD)).toBe(
			true
		);
	});

	it("describes the context-preserving focused thread", () => {
		expect(replyThreadDescription(4)).toBe(
			"This reply is part of a 4-turn chain. Keep the context in a focused thread."
		);
	});
});
