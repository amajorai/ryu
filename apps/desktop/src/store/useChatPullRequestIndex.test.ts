import { describe, expect, test } from "bun:test";
import {
	recordChatBranchPullRequest,
	useChatPullRequestIndex,
} from "./useChatPullRequestIndex.ts";

describe("useChatPullRequestIndex", () => {
	test("records canonical branch pull requests once per chat", () => {
		recordChatBranchPullRequest(
			"chat-a",
			"https://github.com/acme/app/pull/9/files"
		);
		recordChatBranchPullRequest("chat-a", "https://github.com/acme/app/pull/9");
		recordChatBranchPullRequest("chat-a", "https://example.com/pull/1");
		expect(
			useChatPullRequestIndex.getState().branchPullRequests["chat-a"]
		).toEqual(["https://github.com/acme/app/pull/9"]);
	});

	test("keeps only the most recent pull requests for a reused branch", () => {
		for (let number = 1; number <= 7; number += 1) {
			recordChatBranchPullRequest(
				"chat-b",
				`https://github.com/acme/app/pull/${number}`
			);
		}
		const urls =
			useChatPullRequestIndex.getState().branchPullRequests["chat-b"] ?? [];
		expect(urls).toHaveLength(5);
		expect(urls.at(-1)).toBe("https://github.com/acme/app/pull/7");
	});
});
