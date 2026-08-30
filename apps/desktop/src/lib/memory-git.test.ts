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
