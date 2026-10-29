import { describe, expect, test } from "bun:test";
import { pullRequestFeedbackSchema } from "./pull-request-wire-contracts.ts";
import { parsePullRequestUrl } from "./pull-requests.ts";

describe("pullRequestFeedbackSchema", () => {
	const entry = (overrides: Record<string, unknown> = {}) => ({
		author: "alice",
		authorAssociation: "member",
		authorType: "User",
		body: "  Please rename this  ",
		createdAt: "2026-01-01T00:00:00Z",
		id: "IC_1",
		isMinimized: false,
		kind: "comment",
		line: null,
		path: null,
		state: null,
		url: "https://github.com/acme/app/pull/1#issuecomment-1",
		viewerDidAuthor: false,
		...overrides,
	});

	test("maps the app's feedback route into trimmed entries", () => {
		expect(
			pullRequestFeedbackSchema.parse({
				feedback: [
					entry(),
					entry({
						author: "bob",
						authorAssociation: "OWNER",
						body: "Off by one",
						id: "RC_1",
						kind: "review_comment",
						line: 12,
						path: "src/a.ts",
					}),
				],
			})
		).toEqual([
			{
				author: "alice",
				authorAssociation: "MEMBER",
				authorIsBot: false,
				body: "Please rename this",
				createdAt: "2026-01-01T00:00:00Z",
				id: "IC_1",
				isMinimized: false,
				kind: "comment",
				line: null,
				path: null,
				state: null,
				url: "https://github.com/acme/app/pull/1#issuecomment-1",
				viewerDidAuthor: false,
			},
			{
				author: "bob",
				authorAssociation: "OWNER",
				authorIsBot: false,
				body: "Off by one",
				createdAt: "2026-01-01T00:00:00Z",
				id: "RC_1",
				isMinimized: false,
				kind: "review_comment",
				line: 12,
				path: "src/a.ts",
				state: null,
				url: "https://github.com/acme/app/pull/1#issuecomment-1",
				viewerDidAuthor: false,
			},
		]);
	});

	test("flags bots by GraphQL type or by a [bot] login", () => {
		const [graphQlBot, restBot, user] = pullRequestFeedbackSchema.parse({
			feedback: [
				entry({ author: "coderabbitai", authorType: "Bot", id: "a" }),
				entry({ author: "github-actions[bot]", authorType: null, id: "b" }),
				entry({ id: "c" }),
			],
		});
		expect(graphQlBot?.authorIsBot).toBe(true);
		expect(restBot?.authorIsBot).toBe(true);
		expect(user?.authorIsBot).toBe(false);
	});

	test("drops empty bodies, missing ids, unknown kinds, and malformed entries", () => {
		expect(
			pullRequestFeedbackSchema.parse({
				feedback: [
					entry({ body: "   " }),
					entry({ id: null }),
					entry({ kind: "commit" }),
					"not an entry",
					null,
				],
			})
		).toEqual([]);
		expect(pullRequestFeedbackSchema.parse({ pull: null })).toEqual([]);
	});

	test("missing trust fields fail closed", () => {
		const [parsed] = pullRequestFeedbackSchema.parse({
			feedback: [
				{ body: "hi", id: "x", kind: "comment", viewerDidAuthor: "yes" },
			],
		});
		expect(parsed).toMatchObject({
			authorAssociation: null,
			authorIsBot: false,
			isMinimized: false,
			viewerDidAuthor: false,
		});
	});
});

// Shared vectors with Core's `normalize_pull_request_url` (see the
// `pull_request_urls_normalize_to_canonical_github_links` Rust test). The
// desktop parser follows the same split-and-check steps, so these must agree.
describe("parsePullRequestUrl parity with Core", () => {
	test.each([
		[
			" https://github.com/acme/app/pull/42/files?x=1 ",
			"https://github.com/acme/app/pull/42",
		],
		[
			"https://github.com/acme/app/pulls/7",
			"https://github.com/acme/app/pull/7",
		],
		[
			"https://github.com/acme/app/pull/42#discussion",
			"https://github.com/acme/app/pull/42",
		],
		[
			"https://github.com/acme/app/pull/007",
			"https://github.com/acme/app/pull/7",
		],
		[
			"https://github.com/a.b/c_d-e/pull/1",
			"https://github.com/a.b/c_d-e/pull/1",
		],
		// Core splits on `?` and `#` as well as `/`, and Rust's u64 parser
		// accepts a leading `+`.
		[
			"https://github.com/acme/app?pull/3",
			"https://github.com/acme/app/pull/3",
		],
		[
			"https://github.com/acme/app/pull/+5",
			"https://github.com/acme/app/pull/5",
		],
	])("accepts %p", (raw, canonical) => {
		expect(parsePullRequestUrl(raw)?.url).toBe(canonical);
	});

	test.each([
		"http://github.com/acme/app/pull/1",
		"https://github.com/acme/app/issues/1",
		"https://github.com/acme/app/pull/0",
		"https://github.com/acme/../pull/1",
		"https://evil.example/acme/app/pull/1",
		"https://github.com/acme/./pull/1",
		"https://github.com//app/pull/1",
		"https://github.com/acme/app/pull/",
		"https://github.com/acme/app/pull/42abc",
		"https://github.com/acme/app/pull/-1",
		"https://github.com/ac me/app/pull/1",
		`https://github.com/${"a".repeat(101)}/app/pull/1`,
		"HTTPS://GITHUB.COM/acme/app/pull/1",
		"https://github.com.evil.example/acme/app/pull/1",
	])("rejects %p", (raw) => {
		expect(parsePullRequestUrl(raw)).toBeNull();
	});

	test("numbers beyond the safe integer range are rejected on the desktop", () => {
		expect(
			parsePullRequestUrl("https://github.com/acme/app/pull/9007199254740993")
		).toBeNull();
	});
});
