import { describe, expect, test } from "bun:test";
import {
	activeRailAgentId,
	agentsWithUnread,
	isCompactRailActive,
	railAgentGroups,
} from "./compact-rail.ts";

const shown = {
	enabled: true,
	excluded: false,
	narrow: true,
	navigationShown: false,
};

describe("compact rail visibility", () => {
	test("replaces collapsed navigation at narrow widths", () => {
		expect(isCompactRailActive(shown)).toBe(true);
	});

	test("stands down when the full navigation is showing", () => {
		expect(isCompactRailActive({ ...shown, navigationShown: true })).toBe(
			false
		);
	});

	test("never shows at wide widths, when turned off, or in excluded windows", () => {
		expect(isCompactRailActive({ ...shown, narrow: false })).toBe(false);
		expect(isCompactRailActive({ ...shown, enabled: false })).toBe(false);
		expect(isCompactRailActive({ ...shown, excluded: true })).toBe(false);
	});
});

describe("compact rail roster", () => {
	const agents = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

	test("puts pinned agents first in pin order and keeps the rest in roster order", () => {
		expect(railAgentGroups(agents, ["c", "a"])).toEqual({
			pinned: [{ id: "c" }, { id: "a" }],
			others: [{ id: "b" }, { id: "d" }],
		});
	});

	test("drops pins for agents that are gone and duplicate pins", () => {
		expect(railAgentGroups(agents, ["gone", "b", "b"])).toEqual({
			pinned: [{ id: "b" }],
			others: [{ id: "a" }, { id: "c" }, { id: "d" }],
		});
	});
});

describe("active rail agent", () => {
	const conversations = [
		{ id: "conv-1", agentId: "agent-1" },
		{ id: "conv-2" },
	];

	test("reads the merged agent view from the path", () => {
		expect(
			activeRailAgentId({ path: "/chat/agent/agent%201" }, conversations)
		).toBe("agent 1");
	});

	test("reads a bound chat through its conversation", () => {
		expect(
			activeRailAgentId(
				{ path: "/chat", conversationId: "conv-1" },
				conversations
			)
		).toBe("agent-1");
	});

	test("falls back to the agent a fresh chat was started with", () => {
		expect(
			activeRailAgentId(
				{ path: "/chat", conversationId: "conv-2", initialAgent: "agent-2" },
				conversations
			)
		).toBe("agent-2");
	});

	test("has no active agent without an agent-bound tab", () => {
		expect(activeRailAgentId({ path: "/library" }, conversations)).toBeNull();
		expect(activeRailAgentId(undefined, conversations)).toBeNull();
	});

	test("keeps an undecodable path segment as written", () => {
		expect(activeRailAgentId({ path: "/chat/agent/%E0%A4" }, [])).toBe(
			"%E0%A4"
		);
	});
});

describe("agents with unread threads", () => {
	test("marks an agent when any of its direct threads is unread", () => {
		const threads = new Map([
			["a", [{ id: "t1" }, { id: "t2" }]],
			["b", [{ id: "t3" }]],
		]);
		expect([...agentsWithUnread(threads, new Set(["t2"]))]).toEqual(["a"]);
	});
});
