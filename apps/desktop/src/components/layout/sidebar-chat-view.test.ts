import { describe, expect, it } from "bun:test";
import type { Conversation } from "@/types/chat.ts";
import {
	activeChatFilterCount,
	type ChatGroupContext,
	chatEnvironmentOf,
	chatStatusOf,
	emptyChatFilters,
	filterChats,
	groupChats,
	parseChatSectionViews,
} from "./sidebar-chat-view.ts";

const NOW = Date.UTC(2026, 9, 10, 12);
const DAY = 24 * 60 * 60 * 1000;

function chat(id: string, fields: Partial<Conversation> = {}): Conversation {
	return {
		createdAt: NOW - DAY,
		id,
		messages: [],
		title: id,
		updatedAt: NOW - 60_000,
		...fields,
	};
}

const running = chat("running", { runStatus: "running" });
const failed = chat("failed", { runStatus: "failed", folderPath: "/repo" });
const unread = chat("unread", { agentId: "agents/claude" });
const worktree = chat("worktree", {
	folderPath: "/repo",
	updatedAt: NOW - 40 * DAY,
	worktreePath: "/repo/.worktrees/x",
});
const idle = chat("idle", { participants: ["agents/a", "agents/b"] });
const ALL = [running, failed, unread, worktree, idle];

const classify = { unreadIds: new Set(["unread"]) };

const groupContext: ChatGroupContext = {
	...classify,
	agentName: (id) => id.split("/").pop() ?? id,
	customGroupOf: (conversation) =>
		conversation.id === "idle"
			? { id: "focus", label: "Focus" }
			: { id: "unorganized", label: "Ungrouped" },
	customGroups: [
		{ id: "focus", label: "Focus" },
		{ id: "later", label: "Later" },
		{ id: "unorganized", label: "Ungrouped" },
	],
	projectName: (path) => path.split("/").pop() ?? path,
};

describe("chat classification", () => {
	it("ranks status by urgency", () => {
		expect(chatStatusOf(failed, classify)).toBe("attention");
		expect(chatStatusOf(running, classify)).toBe("running");
		expect(chatStatusOf(unread, classify)).toBe("unread");
		expect(chatStatusOf(idle, classify)).toBe("idle");
	});

	it("treats a main thread with a running session as running", () => {
		expect(
			chatStatusOf(idle, { ...classify, runningIds: new Set(["idle"]) })
		).toBe("running");
	});

	it("derives the environment from folder and worktree", () => {
		expect(chatEnvironmentOf(idle)).toBe("chat");
		expect(chatEnvironmentOf(failed)).toBe("workspace");
		expect(chatEnvironmentOf(worktree)).toBe("worktree");
	});
});

describe("chat filters", () => {
	it("passes everything through with no filters", () => {
		expect(filterChats(ALL, emptyChatFilters(), classify, NOW)).toBe(ALL);
	});

	it("ORs within a dimension and ANDs across dimensions", () => {
		const filters = {
			...emptyChatFilters(),
			environments: ["workspace" as const, "worktree" as const],
			statuses: ["attention" as const, "idle" as const],
		};
		expect(filterChats(ALL, filters, classify, NOW).map((c) => c.id)).toEqual([
			"failed",
			"worktree",
		]);
		expect(activeChatFilterCount(filters)).toBe(2);
	});

	it("filters by activity window", () => {
		const recent = { ...emptyChatFilters(), activity: "week" as const };
		const stale = { ...emptyChatFilters(), activity: "stale" as const };
		expect(filterChats(ALL, recent, classify, NOW)).not.toContain(worktree);
		expect(filterChats(ALL, stale, classify, NOW)).toEqual([worktree]);
	});

	it("matches any participant for the agent filter", () => {
		const filters = { ...emptyChatFilters(), agentIds: ["agents/a"] };
		expect(filterChats(ALL, filters, classify, NOW)).toEqual([idle]);
	});
});

describe("chat grouping", () => {
	const labels = (groupBy: Parameters<typeof groupChats>[1]) =>
		groupChats(ALL, groupBy, groupContext).map((g) => [
			g.label,
			g.items.map((c) => c.id),
		]);

	it("groups by status in urgency order", () => {
		expect(labels("status")).toEqual([
			["Needs attention", ["failed"]],
			["Running", ["running"]],
			["Unread", ["unread"]],
			["Idle", ["worktree", "idle"]],
		]);
	});

	it("groups by project alphabetically with No project last", () => {
		expect(labels("project")).toEqual([
			["repo", ["failed", "worktree"]],
			["No project", ["running", "unread", "idle"]],
		]);
	});

	it("keys project groups like the Projects section, keeping a real folder", () => {
		const trailing = chat("trailing", { folderPath: "/repo/" });
		const docs = chat("docs", { folderPath: "/docs" });
		const groups = groupChats([failed, trailing, docs, idle], "project", {
			...groupContext,
			// `/docs` is the second folder of the `/repo` workspace project.
			projectFolder: (path) => (path === "/docs" ? "/repo" : path),
		});
		expect(
			groups.map((g) => [g.key, g.folderPath, g.items.map((c) => c.id)])
		).toEqual([
			["project:/repo", "/repo", ["failed", "trailing", "docs"]],
			["project:none", null, ["idle"]],
		]);
	});

	it("groups by the latest agent", () => {
		expect(labels("agent")).toEqual([
			["b", ["idle"]],
			["claude", ["unread"]],
			["No agent", ["running", "failed", "worktree"]],
		]);
	});

	it("keeps empty custom groups so chats can be dropped into them", () => {
		expect(labels("custom")).toEqual([
			["Focus", ["idle"]],
			["Later", []],
			["Ungrouped", ["running", "failed", "unread", "worktree"]],
		]);
	});
});

describe("saved chat section views", () => {
	it("keeps valid sections and repairs bad fields independently", () => {
		expect(
			parseChatSectionViews({
				chats: { filters: { statuses: ["running"] }, groupBy: "status" },
				pinned: { filters: "bad", groupBy: "nope" },
				unknown: { groupBy: "status" },
			})
		).toEqual({
			chats: {
				filters: {
					activity: "any",
					agentIds: [],
					environments: [],
					statuses: ["running"],
				},
				groupBy: "status",
			},
			pinned: { filters: emptyChatFilters(), groupBy: "default" },
		});
	});

	it("returns nothing for a malformed blob", () => {
		expect(parseChatSectionViews("nope")).toEqual({});
	});
});
