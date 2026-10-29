import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import { getAuthor } from "./message-author.ts";

function message(metadata: UIMessage["metadata"]): UIMessage {
	return {
		id: "human",
		role: "user",
		parts: [{ type: "text", text: "Hello" }],
		metadata,
	};
}

describe("human attribution at the transcript metadata boundary", () => {
	it("accepts the Core history and live collaboration author projections", () => {
		expect(
			getAuthor(
				message({
					author: { id: "user-ada", name: "Ada" },
					createdAt: "2026-10-10T00:00:00Z",
					ryuPersisted: true,
				})
			)
		).toEqual({ id: "user-ada", name: "Ada" });
		expect(
			getAuthor(message({ author: { id: "user-ada", name: undefined } }))
		).toEqual({ id: "user-ada", name: undefined });
		expect(
			getAuthor(
				message({
					author: { name: "Ada", avatar: "https://example.com/ada.png" },
				})
			)
		).toEqual({ name: "Ada", avatar: "https://example.com/ada.png" });
	});
	it("rejects malformed author metadata and keeps optimistic messages unattributed", () => {
		for (const metadata of [
			undefined,
			null,
			[],
			"author",
			{ author: null },
			{ author: { name: 42 } },
			{ author: { id: {} } },
			{ author: { name: "Ada", avatar: false } },
			{ author: {} },
			{ author: { name: "", id: "" } },
		]) {
			expect(getAuthor(message(metadata))).toBeNull();
		}
	});
});
