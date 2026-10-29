import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";
import {
	clearUnreadMessageState,
	createUnreadMessageState,
	getIncomingMessageIds,
	getUnreadMessageLabel,
	reconcileUnreadMessageState,
} from "./message-list-unread.ts";

function message(id: string, role: "assistant" | "user"): UIMessage {
	return {
		id,
		role,
		parts: [{ type: "text", text: id }],
	};
}

describe("message-list unread state", () => {
	it("counts distinct incoming assistant messages only", () => {
		expect(
			getIncomingMessageIds([
				message("user-1", "user"),
				message("assistant-1", "assistant"),
				message("assistant-1", "assistant"),
				message("user-2", "user"),
			])
		).toEqual(["assistant-1"]);
		expect(getUnreadMessageLabel(3)).toBe("3 new messages");
	});

	it("counts a streamed assistant message once, not once per text update", () => {
		const initial = createUnreadMessageState("conversation-a", ["assistant-1"]);
		const firstChunk = reconcileUnreadMessageState(
			initial,
			"conversation-a",
			["assistant-1", "assistant-2"],
			false
		);
		const nextChunk = reconcileUnreadMessageState(
			firstChunk,
			"conversation-a",
			["assistant-1", "assistant-2"],
			false
		);

		expect(firstChunk.unreadIds).toEqual(["assistant-2"]);
		expect(nextChunk.unreadIds).toEqual(["assistant-2"]);
	});

	it("clears when the reader returns to the live edge", () => {
		const state = reconcileUnreadMessageState(
			createUnreadMessageState("conversation-a", ["assistant-1"]),
			"conversation-a",
			["assistant-1", "assistant-2", "assistant-3"],
			false
		);

		expect(
			reconcileUnreadMessageState(
				state,
				"conversation-a",
				["assistant-1", "assistant-2", "assistant-3"],
				true
			).unreadIds
		).toEqual([]);
		expect(clearUnreadMessageState(state).unreadIds).toEqual([]);
	});

	it("does not carry unread messages across conversations", () => {
		const state = reconcileUnreadMessageState(
			createUnreadMessageState("conversation-a", ["assistant-a-1"]),
			"conversation-a",
			["assistant-a-1", "assistant-a-2"],
			false
		);

		const nextConversation = reconcileUnreadMessageState(
			state,
			"conversation-b",
			["assistant-b-1", "assistant-b-2"],
			false
		);

		expect(nextConversation.unreadIds).toEqual([]);
		expect(nextConversation.incomingIds).toEqual([
			"assistant-b-1",
			"assistant-b-2",
		]);
	});

	it("drops unread ids that are no longer in the transcript", () => {
		const state = reconcileUnreadMessageState(
			createUnreadMessageState("conversation-a", ["assistant-1"]),
			"conversation-a",
			["assistant-1", "assistant-2"],
			false
		);

		const trimmed = reconcileUnreadMessageState(
			state,
			"conversation-a",
			["assistant-1"],
			false
		);

		expect(trimmed.unreadIds).toEqual([]);
	});
});
