import { describe, expect, it } from "bun:test";
import {
	type MessageReadReceipt,
	mergeReadReceipts,
	readReceiptFromFrame,
} from "./read-receipts.ts";

const ada: MessageReadReceipt = {
	messageId: "m1",
	readAt: "2026-09-14T10:00:00.000Z",
	userId: "ada",
};

describe("read receipt contract", () => {
	it("accepts the camelCase realtime shape and scopes it to the active conversation", () => {
		expect(
			readReceiptFromFrame(
				{
					conversationId: "chat-1",
					messageId: "m1",
					readAt: ada.readAt,
					type: "readReceipt",
					userId: "ada",
					userName: "Ada Lovelace",
				},
				"chat-1"
			)
		).toEqual({ ...ada, userName: "Ada Lovelace" });
		expect(
			readReceiptFromFrame(
				{ ...ada, conversationId: "other-chat", type: "readReceipt" },
				"chat-1"
			)
		).toBeNull();
	});

	it("ignores malformed frames", () => {
		expect(readReceiptFromFrame(null, "chat-1")).toBeNull();
		expect(
			readReceiptFromFrame(
				{ messageId: "m1", readAt: ada.readAt, type: "readReceipt" },
				"chat-1"
			)
		).toBeNull();
		expect(
			readReceiptFromFrame(
				{ ...ada, type: "readReceipt", userId: "bea" },
				"chat-1"
			)
		).toBeNull();
	});

	it("deduplicates a receipt while enriching a snapshot with its event name", () => {
		expect(
			mergeReadReceipts(
				[ada],
				[
					{ ...ada, userName: "Ada Lovelace" },
					{
						messageId: "m2",
						readAt: "2026-09-14T10:01:00.000Z",
						userId: "bea",
					},
				]
			)
		).toEqual([
			{ ...ada, userName: "Ada Lovelace" },
			{
				messageId: "m2",
				readAt: "2026-09-14T10:01:00.000Z",
				userId: "bea",
			},
		]);
	});
});

it("accepts legacy snake_case and preserves camelCase precedence before trimming", () => {
	expect(
		readReceiptFromFrame(
			{
				type: "read_receipt",
				conversation_id: "chat-1",
				message_id: " m1 ",
				user_id: " ada ",
				read_at: ` ${ada.readAt} `,
				user_name: " Ada ",
			},
			"chat-1"
		)
	).toEqual({ ...ada, userName: "Ada" });
	expect(
		readReceiptFromFrame(
			{
				...ada,
				type: "readReceipt",
				conversationId: "chat-1",
				messageId: " ",
				message_id: "fallback",
				user_id: "other",
			},
			"chat-1"
		)
	).toBeNull();
});

it("falls back from malformed aliases and omits a blank display name", () => {
	expect(
		readReceiptFromFrame(
			{
				type: "readReceipt",
				conversationId: 1,
				conversation_id: "chat-1",
				messageId: false,
				message_id: "m1",
				userId: null,
				user_id: "ada",
				readAt: [],
				read_at: ada.readAt,
				userName: " ",
				user_name: "Ignored",
			},
			"chat-1"
		)
	).toEqual(ada);
});
