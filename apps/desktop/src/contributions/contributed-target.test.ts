import { describe, expect, it } from "bun:test";
import { parseContributedTarget } from "./contributed-target.ts";

describe("parseContributedTarget", () => {
	it("passes a plain path through untouched", () => {
		expect(parseContributedTarget("/inbox")).toEqual({
			path: "/inbox",
			options: {},
		});
	});

	it("lifts an allowlisted parameter out of the path into tab options", () => {
		// `/chat` is the only registered chat route; a conversation is reachable
		// ONLY as an option, so this is what makes a run row openable at all.
		expect(parseContributedTarget("/chat?conversationId=conv-1")).toEqual({
			path: "/chat",
			options: { conversationId: "conv-1" },
		});
	});

	it("decodes the uri-encoding the template layer applied", () => {
		expect(
			parseContributedTarget("/chat?conversationId=a%2Fb%20c").options
				.conversationId
		).toBe("a/b c");
	});

	it("drops every parameter outside the allowlist", () => {
		// The load-bearing case: `initialPrompt` + `initialSubmit` are real openTab
		// options, so a manifest that could set them would make a sidebar row send
		// a message to the user's agent on click.
		const parsed = parseContributedTarget(
			"/chat?initialPrompt=rm%20-rf&initialSubmit=true&forceNew=true&conversationId=conv-2"
		);
		expect(parsed.path).toBe("/chat");
		expect(parsed.options).toEqual({ conversationId: "conv-2" });
	});

	it("degrades malformed targets to plain navigation", () => {
		expect(parseContributedTarget("/chat?")).toEqual({
			path: "/chat",
			options: {},
		});
		// An unfilled template leaves an empty value — not a conversation id.
		expect(parseContributedTarget("/chat?conversationId=").options).toEqual({});
	});
	it("drops inherited object names from the contributed option allowlist", () => {
		for (const key of ["constructor", "toString", "__proto__"]) {
			expect(
				parseContributedTarget(`/chat?${key}=blocked&conversationId=conv-safe`)
			).toEqual({
				path: "/chat",
				options: { conversationId: "conv-safe" },
			});
		}
	});
});
