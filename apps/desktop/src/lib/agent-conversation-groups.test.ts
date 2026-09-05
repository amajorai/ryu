import { describe, expect, test } from "bun:test";
import type { Conversation } from "@/types/chat.ts";
import {
	conversationGroupKey,
	conversationParticipantIds,
	conversationsForOtherChats,
	directAgentThreads,
	isForkedConversation,
	isGroupConversation,
} from "./agent-conversation-groups.ts";

function conversation(
	id: string,
	options: Partial<Conversation> = {}
): Conversation {
	return {
		createdAt: 1,
		id,
		messages: [],
		title: id,
		updatedAt: 1,
		...options,
	};
}

describe("agent conversation grouping", () => {
	test("unions the primary agent with additional participants", () => {
		expect(
			conversationParticipantIds(conversation("legacy", { agentId: "builder" }))
		).toEqual(["builder"]);
		expect(
			conversationParticipantIds(
				conversation("council", {
					agentId: "builder",
					participants: ["builder", "reviewer", "builder"],
				})
			)
		).toEqual(["builder", "reviewer"]);
	});

	test("classifies group conversations and gives participant sets a stable key", () => {
		const group = conversation("group", {
			agentId: "builder",
			participants: ["reviewer"],
		});
		expect(isGroupConversation(group)).toBe(true);
		expect(conversationGroupKey(group)).toBe("builder\u001freviewer");
		expect(
			isGroupConversation(conversation("solo", { agentId: "builder" }))
		).toBe(false);
		expect(conversationGroupKey(conversation("solo"))).toBeNull();
	});

	test("keeps only active direct threads under a bot and orders newest first", () => {
		const threads = directAgentThreads("builder", [
			conversation("old", { agentId: "builder", updatedAt: 10 }),
			conversation("new", { participants: ["builder"], updatedAt: 30 }),
			conversation("group", {
				agentId: "builder",
				participants: ["reviewer"],
				updatedAt: 40,
			}),
			conversation("archived", {
				agentId: "builder",
				archived: true,
				updatedAt: 50,
			}),
		]);
		expect(threads.map(({ id }) => id)).toEqual(["new", "old"]);
	});

	test("recognizes Core's fork title without confusing a git branch name", () => {
		expect(
			isForkedConversation(conversation("fork", { title: "Plan (branch)" }))
		).toBe(true);
		expect(
			isForkedConversation(
				conversation("git", { branch: "feature/login", title: "Plan" })
			)
		).toBe(false);
	});

	test("keeps group and unknown-agent chats reachable outside bot rows", () => {
		const other = conversationsForOtherChats(
			[
				conversation("direct", { agentId: "builder" }),
				conversation("group", {
					agentId: "builder",
					participants: ["reviewer"],
				}),
				conversation("unknown", { agentId: "deleted-agent" }),
			],
			new Set(["builder"])
		);
		expect(other.map(({ id }) => id)).toEqual(["group", "unknown"]);
	});
});
