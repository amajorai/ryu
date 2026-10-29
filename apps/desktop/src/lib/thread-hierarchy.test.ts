import { describe, expect, test } from "bun:test";
import type { Conversation, ThreadHierarchy } from "@/types/chat.ts";
import {
	hasRunningSession,
	hierarchyCrumbs,
	isHiddenSession,
	sessionsOf,
	sidebarRows,
	sidebarThreadKind,
} from "./thread-hierarchy.ts";

function conv(
	id: string,
	title: string,
	hierarchy?: Partial<ThreadHierarchy>,
	extra: Partial<Conversation> = {}
): Conversation {
	return {
		createdAt: 1,
		hierarchy: hierarchy ? { role: "session", ...hierarchy } : undefined,
		id,
		messages: [],
		title,
		updatedAt: 1,
		...extra,
	};
}

const project = conv("p", "Atlas", {
	ownerId: "atlas",
	ownerKind: "project",
	projectId: "atlas",
	role: "main",
});
const botInProject = conv(
	"b",
	"Scout · Atlas",
	{
		ownerId: "scout",
		ownerKind: "agent",
		projectId: "atlas",
		role: "main",
		spawnedByConversationId: undefined,
	},
	{ agentId: "scout" }
);
const session = conv("s", "Audit PRs", {
	projectId: "atlas",
	spawnedByConversationId: "b",
});
const legacy = conv("c", "Old chat");
const group = conv("g", "Reviewers", {
	ownerId: "g",
	ownerKind: "group",
	role: "main",
});

describe("thread hierarchy", () => {
	test("classifies rows: main threads and legacy chats show, sessions hide", () => {
		expect(sidebarThreadKind(project)).toBe("project");
		expect(sidebarThreadKind(group)).toBe("group");
		expect(sidebarThreadKind(legacy)).toBe("chat");
		expect(sidebarThreadKind(session)).toBe("session");
		expect(sidebarThreadKind(botInProject)).toBe("session");
		expect(isHiddenSession(session)).toBe(true);
		expect(
			sidebarRows([project, botInProject, session, legacy, group]).map(
				(c) => c.id
			)
		).toEqual(["p", "c", "g"]);
	});

	test("breadcrumb walks session → bot thread → project", () => {
		const crumbs = hierarchyCrumbs(
			session,
			[project, botInProject, session],
			(id) => (id === "scout" ? "Scout" : undefined)
		);
		expect(crumbs).toEqual([
			{ conversationId: "p", kind: "project", label: "Atlas" },
			{ conversationId: "b", kind: "bot", label: "Scout" },
			{ conversationId: null, kind: "session", label: "Audit PRs" },
		]);
	});

	test("a plain chat has no breadcrumb; a project main thread has one crumb", () => {
		expect(hierarchyCrumbs(legacy, [legacy])).toEqual([]);
		expect(hierarchyCrumbs(project, [project])).toEqual([
			{ conversationId: null, kind: "project", label: "Atlas" },
		]);
	});

	test("a lineage cycle stops instead of looping", () => {
		const a = conv("a", "A", { spawnedByConversationId: "b2" });
		const b2 = conv("b2", "B", { spawnedByConversationId: "a" });
		expect(hierarchyCrumbs(a, [a, b2]).length).toBe(2);
	});

	test("sessions and their running state roll up to the main thread", () => {
		const running = conv(
			"r",
			"Run",
			{ spawnedByConversationId: "b" },
			{ runStatus: "running" }
		);
		expect(sessionsOf("b", [session, running]).map((c) => c.id)).toEqual([
			"s",
			"r",
		]);
		expect(hasRunningSession("b", [session, running])).toBe(true);
		expect(hasRunningSession("p", [session, running])).toBe(false);
	});
});
