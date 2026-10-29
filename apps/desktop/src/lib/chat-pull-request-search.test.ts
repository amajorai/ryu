import { describe, expect, test } from "bun:test";
import {
	chatPullRequestUrls,
	conversationSearchText,
	pullRequestSearchTerms,
} from "./chat-pull-request-search.ts";

const LINKED = "https://github.com/acme/app/pull/42";
const BRANCH = "https://github.com/acme/api/pull/7";

describe("chat pull request search", () => {
	test("terms cover bare, prefixed, and repository-qualified numbers", () => {
		const terms = pullRequestSearchTerms([LINKED, "not a link"]);
		for (const query of ["#42", "pr 42", "pr#42", "app#42", "acme/app#42"]) {
			expect(terms).toContain(query);
		}
		expect(pullRequestSearchTerms(["https://example.com/pull/1"])).toBe("");
	});

	test("a chat's URLs merge explicit links with indexed branch pull requests", () => {
		const conversation = { id: "chat", linkedPullRequests: [LINKED] };
		expect(
			chatPullRequestUrls(conversation, { chat: [BRANCH, LINKED] })
		).toEqual([LINKED, BRANCH]);
		expect(chatPullRequestUrls({ id: "other" }, { chat: [BRANCH] })).toEqual(
			[]
		);
	});

	test("search text matches the title or any pull request number", () => {
		const text = conversationSearchText(
			{ id: "chat", linkedPullRequests: [LINKED], title: "Fix login" },
			{ chat: [BRANCH] }
		).toLowerCase();
		expect(text).toContain("fix login");
		expect(text).toContain("#42");
		expect(text).toContain("#7");
		expect(conversationSearchText({ id: "x", title: "Plain" }, {})).toBe(
			"Plain"
		);
	});
});
