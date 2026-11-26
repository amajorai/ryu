import { describe, expect, test } from "bun:test";
import type { Conversation, ThreadHierarchy } from "@/types/chat.ts";
import {
	COMPACT_CRUMB_LIMIT,
	collapseCrumbs,
	hasRunningSession,
	hierarchyCrumbs,
	hierarchySiblings,
	isHiddenSession,
	MAX_CRUMB_SIBLINGS,
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
			{
				conversationId: "p",
				id: "p",
				kind: "project",
				label: "Atlas",
				siblings: [],
			},
			{
				conversationId: "b",
				id: "b",
				kind: "bot",
				label: "Scout",
				siblings: [],
			},
			{
				conversationId: null,
				id: "s",
				kind: "session",
				label: "Audit PRs",
				siblings: [],
			},
		]);
	});

	test("a plain chat has no breadcrumb; a project main thread has one crumb", () => {
		expect(hierarchyCrumbs(legacy, [legacy])).toEqual([]);
		expect(hierarchyCrumbs(project, [project])).toEqual([
			{
				conversationId: null,
				id: "p",
				kind: "project",
				label: "Atlas",
				siblings: [],
			},
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

	test("a crumb carries the run status of its thread", () => {
		const failedParent = conv(
			"fp",
			"Plan",
			{ ownerId: "scout", ownerKind: "agent", role: "main" },
			{ runStatus: "failed" }
		);
		const runningChild = conv(
			"rc",
			"Build",
			{ spawnedByConversationId: "fp" },
			{ runStatus: "running" }
		);
		const crumbs = hierarchyCrumbs(runningChild, [failedParent, runningChild]);
		expect(crumbs.map((crumb) => [crumb.id, crumb.runStatus])).toEqual([
			["fp", "failed"],
			["rc", "running"],
		]);
	});

	test("siblings are the other sessions of the same spawning thread, newest first", () => {
		const older = conv(
			"s-old",
			"Older",
			{ spawnedByConversationId: "b" },
			{ runStatus: "completed", updatedAt: 5 }
		);
		const newer = conv(
			"s-new",
			"Newer",
			{ spawnedByConversationId: "b" },
			{ runStatus: "running", updatedAt: 9 }
		);
		const elsewhere = conv("s-else", "Elsewhere", {
			spawnedByConversationId: "p",
		});
		const all = [project, botInProject, session, older, newer, elsewhere];
		expect(hierarchySiblings(session, all)).toEqual([
			{ conversationId: "s-new", label: "Newer", runStatus: "running" },
			{ conversationId: "s-old", label: "Older", runStatus: "completed" },
		]);
		// The breadcrumb carries the same list on the session's own crumb.
		expect(
			hierarchyCrumbs(session, all)
				.at(-1)
				?.siblings.map((sibling) => sibling.conversationId)
		).toEqual(["s-new", "s-old"]);
		// A project's main thread and a plain chat have nothing beside them.
		expect(hierarchySiblings(project, all)).toEqual([]);
		expect(hierarchySiblings(legacy, [...all, legacy])).toEqual([]);
	});

	test("a member's main thread lists the other members of its project", () => {
		const otherBot = conv(
			"b2",
			"Quill · Atlas",
			{
				ownerId: "quill",
				ownerKind: "agent",
				projectId: "atlas",
				role: "main",
			},
			{ agentId: "quill" }
		);
		const otherProjectBot = conv(
			"b3",
			"Scout · Borealis",
			{
				ownerId: "scout",
				ownerKind: "agent",
				projectId: "borealis",
				role: "main",
			},
			{ agentId: "scout" }
		);
		const names = (id: string) => (id === "quill" ? "Quill" : undefined);
		expect(
			hierarchySiblings(
				botInProject,
				[project, botInProject, otherBot, otherProjectBot, session],
				names
			)
		).toEqual([{ conversationId: "b2", label: "Quill" }]);
	});

	test("a sibling menu is capped", () => {
		const many = Array.from({ length: MAX_CRUMB_SIBLINGS + 5 }, (_, index) =>
			conv(
				`n${index}`,
				`Session ${index}`,
				{ spawnedByConversationId: "b" },
				{ updatedAt: index }
			)
		);
		const siblings = hierarchySiblings(session, [session, ...many]);
		expect(siblings).toHaveLength(MAX_CRUMB_SIBLINGS);
		// Newest first, so the cap drops the oldest.
		expect(siblings[0]?.conversationId).toBe(`n${MAX_CRUMB_SIBLINGS + 4}`);
	});
});

describe("collapsing a long breadcrumb", () => {
	const chain = (length: number) =>
		Array.from({ length }, (_, index) => `c${index}`);

	test("a chain of up to four crumbs stays whole", () => {
		for (const length of [0, 1, 2, 3, 4]) {
			expect(collapseCrumbs(chain(length))).toEqual({
				head: chain(length),
				hidden: [],
				tail: [],
			});
		}
	});

	test("a chain longer than four keeps the first, the parent and the current crumb", () => {
		expect(collapseCrumbs(chain(5))).toEqual({
			head: ["c0"],
			hidden: ["c1", "c2"],
			tail: ["c3", "c4"],
		});
		expect(collapseCrumbs(chain(8))).toEqual({
			head: ["c0"],
			hidden: ["c1", "c2", "c3", "c4", "c5"],
			tail: ["c6", "c7"],
		});
	});

	test("a narrow bar keeps only the parent and the current crumb", () => {
		expect(collapseCrumbs(chain(2), COMPACT_CRUMB_LIMIT)).toEqual({
			head: ["c0", "c1"],
			hidden: [],
			tail: [],
		});
		expect(collapseCrumbs(chain(5), COMPACT_CRUMB_LIMIT)).toEqual({
			head: [],
			hidden: ["c0", "c1", "c2"],
			tail: ["c3", "c4"],
		});
	});

	test("every crumb lands in exactly one part, in order", () => {
		for (const limit of [1, 2, 3, 4, 6]) {
			for (const length of [0, 1, 3, 5, 9]) {
				const parts = collapseCrumbs(chain(length), limit);
				expect([...parts.head, ...parts.hidden, ...parts.tail]).toEqual(
					chain(length)
				);
			}
		}
	});
});
