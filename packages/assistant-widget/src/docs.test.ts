import { describe, expect, test } from "bun:test";

import {
	buildBrowserContextMessage,
	deterministicAssistantAnswer,
	findRelevantDocs,
	RYU_DOC_REFERENCES,
	resolveDocHref,
} from "./docs.ts";

describe("assistant docs grounding", () => {
	test("ranks the matching public source", () => {
		expect(
			findRelevantDocs("How do I ship a customer support widget?")[0]
		).toMatchObject({
			title: "Ship a support widget",
		});
	});

	test("has a deterministic useful answer before a model is downloaded", () => {
		expect(
			deterministicAssistantAnswer(
				"What is Ryu?",
				findRelevantDocs("What is Ryu?")
			)
		).toContain("governed production AI platform");
	});

	test("keeps docs links on the configured public origin", () => {
		expect(
			resolveDocHref("https://docs.ryuhq.com/", "/docs/surfaces/webapp")
		).toBe("https://docs.ryuhq.com/docs/surfaces/webapp");
		expect(resolveDocHref(undefined, "/docs/surfaces/webapp")).toBe(
			"/docs/surfaces/webapp"
		);
	});

	test("uses valid public documentation routes", () => {
		expect(RYU_DOC_REFERENCES.map((reference) => reference.href)).toEqual([
			"/docs/start-here/architecture/three-products",
			"/docs/extend/develop/sdk",
			"/docs/extend/develop/extensions/support-widget",
			"/docs/surfaces/browser-extension",
			"/docs/surfaces/webapp",
			"/docs/extend/mcp/llms",
		]);
	});

	test("attaches only the browser context the visitor opted to share", () => {
		const context = {
			selection: " selected sentence ",
			text: "page body",
			title: "Article",
			url: "https://example.test/article",
		};
		expect(buildBrowserContextMessage("Question", context, false, false)).toBe(
			"Question"
		);
		const selectedOnly = buildBrowserContextMessage(
			"Question",
			context,
			false,
			true
		);
		expect(selectedOnly).toContain("selected sentence");
		expect(selectedOnly).not.toContain("page body");
		const pageOnly = buildBrowserContextMessage(
			"Question",
			context,
			true,
			false
		);
		expect(pageOnly).toContain("page body");
		expect(pageOnly).toContain("https://example.test/article");
		expect(pageOnly).not.toContain("selected sentence");
	});

	test("bounds attached browser text and marks it as untrusted page data", () => {
		const message = buildBrowserContextMessage(
			"Question",
			{
				selection: "s".repeat(2000),
				text: "p".repeat(12_000),
				title: "Article",
				url: "https://example.test/article",
			},
			true,
			true
		);
		expect(message).toContain("untrusted page data");
		expect(message).toContain("p".repeat(10_000));
		expect(message).not.toContain("p".repeat(10_001));
		expect(message).toContain("s".repeat(1500));
		expect(message).not.toContain("s".repeat(1501));
	});
});
