import { describe, expect, it } from "bun:test";
import {
	displayRemixSource,
	githubRepositoryUrl,
	remixAllowed,
	remixableFromEntry,
	remixCreditSnippet,
	remixPlan,
	remixSourceOf,
} from "./remix.ts";

describe("remixAllowed", () => {
	it("treats an absent declaration as allowed", () => {
		expect(remixAllowed({})).toBe(true);
		expect(remixAllowed({ allowRemix: null })).toBe(true);
		expect(remixAllowed({ allowRemix: true })).toBe(true);
		expect(remixAllowed({ allowRemix: false })).toBe(false);
	});
});

describe("githubRepositoryUrl", () => {
	it("accepts slugs and GitHub URLs only", () => {
		expect(githubRepositoryUrl("acme/tool")).toBe(
			"https://github.com/acme/tool"
		);
		expect(githubRepositoryUrl("https://github.com/acme/tool.git")).toBe(
			"https://github.com/acme/tool"
		);
		expect(githubRepositoryUrl("https://github.com/acme/tool/tree/main")).toBe(
			"https://github.com/acme/tool"
		);
		expect(githubRepositoryUrl("https://gitlab.com/acme/tool")).toBeNull();
		expect(githubRepositoryUrl("javascript:alert(1)")).toBeNull();
		expect(githubRepositoryUrl("https://github.com/acme")).toBeNull();
		expect(githubRepositoryUrl("")).toBeNull();
		expect(githubRepositoryUrl(null)).toBeNull();
	});
});

describe("remixPlan", () => {
	it("refuses a listing whose author opted out", () => {
		expect(
			remixPlan({
				allowRemix: false,
				githubRepository: "acme/tool",
				id: "acme/tool",
				kind: "plugin",
			})
		).toEqual({ kind: "blocked" });
	});

	it("forks a GitHub-backed listing, preferring the bound source", () => {
		expect(
			remixPlan({
				githubRepository: "acme/bound",
				id: "acme/tool",
				kind: "app",
				repositoryUrl: "https://github.com/acme/declared",
			})
		).toEqual({
			forkUrl: "https://github.com/acme/bound/fork",
			kind: "fork",
			repositoryUrl: "https://github.com/acme/bound",
		});
		expect(
			remixPlan({
				id: "acme/tool",
				kind: "plugin",
				repositoryUrl: "https://github.com/acme/declared",
			})
		).toMatchObject({ kind: "fork" });
	});

	it("copies agent and workflow templates in Ryu", () => {
		expect(remixPlan({ id: "ryu/animator", kind: "agent" })).toEqual({
			kind: "copy",
		});
		expect(remixPlan({ id: "ryu/autoresearch", kind: "workflow" })).toEqual({
			kind: "copy",
		});
	});

	it("has nothing to offer for a source-less listing", () => {
		expect(remixPlan({ id: "x", kind: "mcp" })).toEqual({
			kind: "unavailable",
		});
	});
});

describe("remix credit", () => {
	it("names the source listing and its version", () => {
		expect(
			remixSourceOf({ id: "ryu/animator", kind: "agent", version: "1.0.0" })
		).toEqual({ id: "ryu/animator", kind: "agent", version: "1.0.0" });
		expect(remixSourceOf({ id: "ryu/animator", kind: "agent" })).toEqual({
			id: "ryu/animator",
			kind: "agent",
		});
	});

	it("produces lines that paste into a package manifest", () => {
		const snippet = remixCreditSnippet({
			id: "ryu/animator",
			kind: "agent",
			version: "1.0.0",
		});
		expect(snippet).toBe(
			[
				'"remixedFrom": {',
				'  "id": "ryu/animator",',
				'  "kind": "agent",',
				'  "version": "1.0.0"',
				"}",
			].join("\n")
		);
		expect(JSON.parse(`{${snippet}}`)).toEqual({
			remixedFrom: { id: "ryu/animator", kind: "agent", version: "1.0.0" },
		});
	});
});

describe("Core catalog cards", () => {
	it("read the bound source first and default to remixable", () => {
		const listing = remixableFromEntry({
			github_source: { repository: "acme/bound" },
			id: "@acme/tool",
			repository_url: "https://github.com/acme/declared",
			type: "app",
			version: "2.0.0",
		});
		expect(listing).toEqual({
			allowRemix: null,
			githubRepository: "acme/bound",
			id: "@acme/tool",
			kind: "app",
			repositoryUrl: "https://github.com/acme/declared",
			version: "2.0.0",
		});
		expect(remixPlan(listing)).toMatchObject({
			forkUrl: "https://github.com/acme/bound/fork",
		});
	});

	it("carry an author's opt-out", () => {
		expect(
			remixPlan(
				remixableFromEntry({
					allow_remix: false,
					id: "@acme/tool",
					repo_url: "https://github.com/acme/tool",
				})
			)
		).toEqual({ kind: "blocked" });
	});

	it("only render complete, bounded credits", () => {
		expect(displayRemixSource({ id: " acme/x ", kind: "plugin" })).toEqual({
			id: "acme/x",
			kind: "plugin",
		});
		expect(displayRemixSource({ id: "acme/x" })).toBeNull();
		expect(
			displayRemixSource({ id: "x".repeat(201), kind: "plugin" })
		).toBeNull();
		expect(displayRemixSource(null)).toBeNull();
	});
});
