import { describe, expect, test } from "bun:test";
import type { Memory } from "@/src/lib/api/memory.ts";
import {
	exportMemoryGitTree,
	memoryRepoRelativePath,
	parseMemoryMarkdown,
} from "./memory-git.ts";

const memory: Memory = {
	authorAgentId: null,
	category: "preference",
	content: "Use short paragraphs and show the exact file path.",
	createdAt: 1,
	id: "memory-1",
	importance: 4,
	scope: "project",
	scopeId: "/work/ryu",
	tags: ["style", "writing"],
	updatedAt: 2,
	whenToUse: "When reviewing implementation work",
	sensitiveTopics: [],
};

describe("memory Git Markdown", () => {
	test("exports stable source files and round-trips frontmatter", () => {
		const files = exportMemoryGitTree([memory]);
		const source = files.find(
			(file) => file.path === "memory/project/memory-1.md"
		);

		expect(source).toBeDefined();
		expect(source?.content).not.toContain("embedding");
		expect(
			parseMemoryMarkdown(source?.path ?? "", source?.content ?? "")
		).toMatchObject({
			category: "preference",
			content: memory.content,
			id: memory.id,
			importance: memory.importance,
			scope: memory.scope,
			scopeId: memory.scopeId,
			tags: memory.tags,
			whenToUse: memory.whenToUse,
		});
	});

	test("only maps files below the memory source root", () => {
		expect(
			memoryRepoRelativePath("/tmp/repo", "/tmp/repo/memory/user/a.md")
		).toBe("memory/user/a.md");
		expect(
			memoryRepoRelativePath("/tmp/repo", "/tmp/repo/docs/a.md")
		).toBeNull();
	});
});

test("legacy memory frontmatter retains optional-field defaults and mixed tag filtering", () => {
	const source =
		"---\ntype: memory\nid: ' memory-id '\nimportance: 9007199254740992\ncreated_at: 9007199254740992\nupdated_at: 0\ntags: [' tag ', 1, false, '', 'tag']\nscope_id: 1\nwhen_to_use: ' recall this '\n---\n body \n";
	expect(parseMemoryMarkdown("memory/user/memory-id.md", source)).toEqual({
		category: "user_fact",
		content: "body",
		createdAt: 9_007_199_254_740_992,
		id: "memory-id",
		importance: 5,
		path: "memory/user/memory-id.md",
		scope: "user",
		scopeId: null,
		tags: ["tag", "tag"],
		updatedAt: undefined,
		whenToUse: "recall this",
	});
	expect(
		parseMemoryMarkdown(
			"memory/user/memory-id.md",
			"---\ntype: memory\nid: memory-id\nimportance: '4'\ncreated_at: '20'\n---\nbody"
		)
	).toMatchObject({ importance: 3, createdAt: undefined });
});

test("memory Git import preserves invalid identifier, scope, category, and empty-body errors", () => {
	const path = "memory/user/memory-id.md";
	for (const [frontmatter, message] of [
		[
			"type: memory\nid: ../escape\nscope: bad",
			"memory id is missing or invalid",
		],
		[
			"type: memory\nid: valid\nscope: agent\ncategory: bad",
			"unsupported memory scope",
		],
		[
			"type: memory\nid: valid\ncategory: future-category",
			"unsupported memory category",
		],
	] satisfies [string, string][]) {
		expect(() =>
			parseMemoryMarkdown(path, `---\n${frontmatter}\n---\nbody`)
		).toThrow(message);
	}
	expect(() =>
		parseMemoryMarkdown(path, "---\ntype: memory\nid: valid\n---\n ")
	).toThrow("memory content is empty");
	expect(parseMemoryMarkdown(path, "---\ntype: bundle\n---\nbody")).toBeNull();
});
