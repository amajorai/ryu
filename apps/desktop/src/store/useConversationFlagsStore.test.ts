import { beforeEach, describe, expect, it } from "bun:test";
import { useConversationFlagsStore } from "./useConversationFlagsStore.ts";

function unreadCount(conversationId: string): number {
	const state = useConversationFlagsStore.getState();
	return state.unreadIds.has(conversationId)
		? (state.unreadMessageCounts.get(conversationId) ?? 1)
		: 0;
}

describe("conversation unread message counts", () => {
	beforeEach(() => {
		useConversationFlagsStore.setState({
			lastObservedMessageCounts: new Map(),
			unreadIds: new Set(),
			unreadMessageCounts: new Map(),
		});
	});

	it("counts message deltas while a conversation is inactive", () => {
		const observe = useConversationFlagsStore.getState().observeMessageCounts;

		observe([{ id: "chat-1", messageCount: 4 }], null);
		observe([{ id: "chat-1", messageCount: 7 }], null);
		expect(unreadCount("chat-1")).toBe(3);

		observe([{ id: "chat-1", messageCount: 9 }], null);
		expect(unreadCount("chat-1")).toBe(5);
	});

	it("treats the first observed total as the read baseline", () => {
		const observe = useConversationFlagsStore.getState().observeMessageCounts;

		observe([{ id: "chat-1", messageCount: 48 }], null);
		expect(unreadCount("chat-1")).toBe(0);

		observe([{ id: "chat-1", messageCount: 49 }], null);
		expect(unreadCount("chat-1")).toBe(1);
	});

	it("clears unread counts when the conversation is active or marked read", () => {
		const observe = useConversationFlagsStore.getState().observeMessageCounts;

		observe([{ id: "chat-1", messageCount: 2 }], null);
		observe([{ id: "chat-1", messageCount: 5 }], "chat-1");
		expect(unreadCount("chat-1")).toBe(0);

		observe([{ id: "chat-1", messageCount: 8 }], null);
		expect(unreadCount("chat-1")).toBe(3);
		useConversationFlagsStore.getState().markRead("chat-1");
		expect(unreadCount("chat-1")).toBe(0);
		expect(
			useConversationFlagsStore.getState().unreadMessageCounts.has("chat-1")
		).toBe(false);
	});

	it("starts manually marked chats at one and increments new messages", () => {
		const observe = useConversationFlagsStore.getState().observeMessageCounts;

		observe([{ id: "chat-1", messageCount: 10 }], null);
		useConversationFlagsStore.getState().markUnread("chat-1");
		expect(unreadCount("chat-1")).toBe(1);

		observe([{ id: "chat-1", messageCount: 12 }], null);
		expect(unreadCount("chat-1")).toBe(3);
	});
});
