// apps/desktop/src/contexts/tab-conversation.test.ts
//
// Guards the invariant behind the "clicking an open chat opens a SECOND broken
// tab" report: a chat tab that acquires its conversation id after it was opened
// (every blank "New chat" — the id only exists after the first send) must become
// findable by that id. When it doesn't, `openTab`'s dedup misses, a duplicate tab
// mounts on the same thread, and the two mounts share one `useChat({ id })`
// instance and clobber each other. The same binding is what session restore
// persists, so an unbound tab also reopens EMPTY after a relaunch.

import { describe, expect, test } from "bun:test";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import {
	bindConversation,
	findChatTab,
	findChatTabOnNode,
	tabNodeKey,
} from "@/src/contexts/tab-conversation.ts";

const freshChatTab = (): Tab[] => [
	{ id: "t1", path: "/chat", title: "New chat" },
];

describe("bindConversation", () => {
	test("an unbound chat tab is not findable until it is bound", () => {
		const tabs = freshChatTab();
		expect(findChatTab(tabs, "conv-1")).toBeUndefined();

		const bound = bindConversation(tabs, "t1", "conv-1");
		expect(findChatTab(bound, "conv-1")?.id).toBe("t1");
	});

	// The tab LABEL has a single writer (`useTitleBar`); binding must not become a
	// second one, or a ghost thread's "Temporary chat" label races the default.
	test("never touches the tab title", () => {
		const bound = bindConversation(freshChatTab(), "t1", "conv-1");
		expect(bound[0].title).toBe("New chat");
	});

	test("re-binding the same values is a no-op (same array reference)", () => {
		const bound = bindConversation(freshChatTab(), "t1", "conv-1");
		expect(bindConversation(bound, "t1", "conv-1")).toBe(bound);
	});

	test("unbinding drops the id so the old thread stops matching this tab", () => {
		const bound = bindConversation(freshChatTab(), "t1", "conv-1");
		const unbound = bindConversation(bound, "t1", undefined);
		expect(findChatTab(unbound, "conv-1")).toBeUndefined();
		expect(unbound[0].conversationId).toBeUndefined();
	});

	test("an unknown tab id changes nothing", () => {
		const tabs = freshChatTab();
		expect(bindConversation(tabs, "nope", "conv-1")).toBe(tabs);
	});

	test("only touches the named tab", () => {
		const tabs: Tab[] = [
			{ id: "t1", path: "/chat", title: "New chat" },
			{ id: "t2", path: "/chat", title: "Other", conversationId: "conv-2" },
		];
		const bound = bindConversation(tabs, "t1", "conv-1");
		expect(bound[1]).toBe(tabs[1]);
		expect(findChatTab(bound, "conv-2")?.id).toBe("t2");
	});
});

describe("findChatTab", () => {
	test("ignores non-chat tabs carrying the same id", () => {
		const tabs: Tab[] = [
			{
				id: "t1",
				path: "/library",
				title: "Library",
				conversationId: "conv-1",
			},
		];
		expect(findChatTab(tabs, "conv-1")).toBeUndefined();
	});
});

describe("findChatTabOnNode", () => {
	const tabs: Tab[] = [
		{ id: "on-default", path: "/chat", title: "A", conversationId: "same" },
		{ id: "on-studio", path: "/chat", title: "B", conversationId: "same" },
	];
	const overrides = { "on-studio": "studio" };

	test("matches only the same conversation on the same computer", () => {
		expect(findChatTabOnNode(tabs, "same", null, overrides)?.id).toBe(
			"on-default"
		);
		expect(findChatTabOnNode(tabs, "same", "studio", overrides)?.id).toBe(
			"on-studio"
		);
		expect(
			findChatTabOnNode(tabs, "same", "laptop", overrides)
		).toBeUndefined();
		expect(findChatTabOnNode(tabs, "other", null, overrides)).toBeUndefined();
	});

	test("an override naming the default computer counts as the default", () => {
		const named = { "on-default": "local" };
		expect(tabNodeKey(named, "on-default", "local")).toBeNull();
		expect(tabNodeKey(overrides, "on-studio", "local")).toBe("studio");
		expect(tabNodeKey(overrides, "missing", "local")).toBeNull();
	});
});
