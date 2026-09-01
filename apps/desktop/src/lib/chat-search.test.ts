import { describe, expect, it } from "bun:test";
import { chatMessageText, searchChatMessages } from "./chat-search.ts";

describe("chat-local search", () => {
	it("matches visible text case-insensitively and anchors assistant hits to the turn", () => {
		const matches = searchChatMessages(
			[
				{
					id: "user-1",
					parts: [{ type: "text", text: "Review the deployment plan" }],
					role: "user",
				},
				{
					id: "assistant-1",
					parts: [{ type: "text", text: "The deployment is ready." }],
					role: "assistant",
				},
			],
			"DEPLOYMENT"
		);

		expect(matches).toEqual([
			{
				anchorMessageId: "user-1",
				content: "Review the deployment plan",
				messageId: "user-1",
				role: "user",
			},
			{
				anchorMessageId: "user-1",
				content: "The deployment is ready.",
				messageId: "assistant-1",
				role: "assistant",
			},
		]);
	});

	it("ignores non-text parts and empty queries", () => {
		expect(
			chatMessageText({
				content: "fallback",
				id: "message",
				parts: [{ type: "tool-read", input: { path: "README.md" } }],
			})
		).toBe("");
		expect(searchChatMessages([], "  ")).toEqual([]);
		expect(
			searchChatMessages(
				[{ content: "hello", id: "message", role: "user" }],
				"missing"
			)
		).toEqual([]);
	});
});
