import { describe, expect, test } from "bun:test";
import type { Conversation } from "@/types/chat.ts";
import { focusSidebarProjects } from "./sidebar-project-focus.ts";

const chat = (id: string, folderPath?: string): Conversation =>
	({ createdAt: 0, folderPath, id, title: id }) as Conversation;

const alpha = chat("a1", "/work/alpha");
const alphaPinned = chat("a2", "/work/alpha/");
const alphaArchived = chat("a3", "/work/alpha");
const beta = chat("b1", "/work/beta");
const loose = chat("l1");

const buckets = {
	agentModeOtherChats: [loose],
	archived: [alphaArchived],
	pinned: [alphaPinned, beta],
	projectList: [
		{
			conversations: [alpha],
			name: "alpha",
			path: "/work/alpha",
			sourceFolders: ["/work/alpha"],
		},
		{
			conversations: [beta],
			name: "beta",
			path: "/work/beta",
			sourceFolders: ["/work/beta"],
		},
	],
	rest: [alpha, beta, loose],
};

describe("focusSidebarProjects", () => {
	test("Home (null) keeps every bucket", () => {
		expect(focusSidebarProjects(buckets, null)).toBe(buckets);
	});

	test("a focused project keeps only its own chats", () => {
		const focused = focusSidebarProjects(buckets, "/work/alpha/");
		expect(focused.projectList.map((p) => p.name)).toEqual(["alpha"]);
		expect(focused.pinned.map((c) => c.id)).toEqual(["a2"]);
		expect(focused.archived.map((c) => c.id)).toEqual(["a3"]);
		expect(focused.rest.map((c) => c.id)).toEqual(["a1"]);
		expect(focused.agentModeOtherChats).toEqual([]);
	});

	test("an unknown project falls back to everything", () => {
		expect(focusSidebarProjects(buckets, "/gone")).toBe(buckets);
	});
});
