// Builds the grouped, filtered candidate list for the composer "@" menu. The
// workflow group is the chat-workflow integration seam: only workflows the
// caller puts in `sources.workflows` (Core's chat-triggerable subset) appear,
// and picking one sets a `workflow` target on the tab. See
// docs/rfc-mention-composer.md.

import { describe, expect, test } from "bun:test";
import {
	applyMention,
	buildComposioMentionSources,
	buildMentionGroups,
	resolveFirstNamedMentionId,
	resolveReferencedChatIds,
} from "./candidates.ts";
import type { MentionSources } from "./types.ts";

function sources(): MentionSources {
	return {
		agents: [{ id: "ryu", name: "Ryu" }],
		apps: [],
		appItems: [],
		chats: [
			{
				id: "conv-architecture",
				name: "Architecture notes",
				description: "Discussed the storage boundary",
			},
		],
		folders: [],
		integrations: [],
		mcp: [],
		plugins: [],
		skills: [],
		spaces: [],
		pages: [],
		outputStyles: [],
		teams: [],
		users: [],
		workflows: [
			{
				id: "wf_plan",
				name: "Plan → Implement → Verify",
				description: "3-step pipeline",
			},
			{ id: "wf_simple", name: "Summarize", description: null },
		],
	};
}

describe("buildMentionGroups", () => {
	test("filters the picker to approved capability and user kinds", () => {
		const groups = buildMentionGroups(
			{
				...sources(),
				users: [
					{
						description: "ada@example.test",
						id: "user-ada",
						name: "Ada Lovelace",
						visualIcon: "avatar",
					},
				],
			} satisfies MentionSources,
			"",
			["agent", "app", "plugin", "workflow", "user"]
		);
		expect(groups.map((group) => group.label)).toEqual([
			"Agents",
			"Workflows",
			"Users",
		]);
		expect(groups.find((group) => group.kind === "user")?.items[0]).toEqual({
			description: "ada@example.test",
			id: "user-ada",
			kind: "user",
			label: "Ada Lovelace",
			visualIcon: "avatar",
		});
	});

	test("offers installed agents as target mentions", () => {
		const groups = buildMentionGroups(sources(), "ryu");
		expect(groups.find((group) => group.kind === "agent")?.items).toEqual([
			{
				kind: "agent",
				id: "ryu",
				label: "Ryu",
				icon: expect.anything(),
			},
		]);
	});

	test("offers chat-triggerable workflows as a labelled group", () => {
		const groups = buildMentionGroups(sources(), "");
		const workflows = groups.find((g) => g.kind === "workflow");
		expect(workflows).toBeDefined();
		expect(workflows?.label).toBe("Workflows");
		expect(workflows?.items).toEqual([
			{
				kind: "workflow",
				id: "wf_plan",
				label: "Plan → Implement → Verify",
				description: "3-step pipeline",
				icon: expect.anything(),
			},
			{
				kind: "workflow",
				id: "wf_simple",
				label: "Summarize",
				description: undefined,
				icon: expect.anything(),
			},
		]);
	});

	test("filters workflows by name, case-insensitively", () => {
		const groups = buildMentionGroups(sources(), "summ");
		const workflows = groups.find((g) => g.kind === "workflow");
		expect(workflows?.items.map((i) => i.id)).toEqual(["wf_simple"]);
	});

	test("offers saved chats as reference mentions", () => {
		const groups = buildMentionGroups(sources(), "architecture");
		expect(groups.find((group) => group.kind === "chat")?.items).toEqual([
			{
				kind: "chat",
				id: "conv-architecture",
				label: "Architecture notes",
				description: "Discussed the storage boundary",
				icon: expect.anything(),
			},
		]);
	});

	test("hides the workflow group when no workflow sources are supplied", () => {
		const groups = buildMentionGroups(sources(), "");
		const without = { ...sources(), workflows: [] };
		const rebuilt = buildMentionGroups(without, "");
		expect(groups.find((g) => g.kind === "workflow")).toBeDefined();
		expect(rebuilt.find((g) => g.kind === "workflow")).toBeUndefined();
	});

	test("does not truncate installed apps or plugins", () => {
		const installed = Array.from({ length: 8 }, (_, index) => ({
			id: `installed-${index}`,
			name: `Installed ${index}`,
		}));
		const groups = buildMentionGroups(
			{ ...sources(), apps: installed, plugins: installed },
			""
		);

		expect(groups.find((group) => group.kind === "app")?.items).toHaveLength(8);
		expect(groups.find((group) => group.kind === "plugin")?.items).toHaveLength(
			8
		);
	});

	test("offers app rows, Space pages, and personality profiles with destinations", () => {
		const groups = buildMentionGroups(
			{
				...sources(),
				appItems: [
					{
						description: "Canvas · Product brief",
						id: "com.ryu.canvas:canvas:brief",
						name: "Product brief",
						ownerId: "com.ryu.canvas",
						target: { path: "/spaces/space-1/app/canvas/brief" },
					},
				],
				pages: [
					{
						description: "Planning · Page",
						id: "space-1:page-1",
						name: "Launch plan",
						target: { path: "/spaces/space-1/doc/page-1" },
					},
				],
				outputStyles: [
					{
						description: "Short and direct",
						id: "plain",
						name: "Plain text",
						target: { path: "/settings" },
					},
				],
			},
			""
		);

		expect(groups.map((group) => group.label)).toEqual([
			"Agents",
			"Workflows",
			"Chats",
			"App items",
			"Space pages",
			"Personality profiles",
		]);
		expect(groups.find((group) => group.kind === "app-item")?.items[0]).toEqual(
			{
				kind: "app-item",
				description: "Canvas · Product brief",
				id: "com.ryu.canvas:canvas:brief",
				label: "Product brief",
				ownerId: "com.ryu.canvas",
				target: { path: "/spaces/space-1/app/canvas/brief" },
				icon: expect.anything(),
			}
		);
		expect(
			groups.find((group) => group.kind === "page")?.items[0].target
		).toEqual({ path: "/spaces/space-1/doc/page-1" });
	});

	test("offers connected integrations and filters them by toolkit metadata", () => {
		const groups = buildMentionGroups(
			{
				...sources(),
				integrations: [
					{
						description: "Connected through Composio",
						id: "github",
						name: "GitHub",
					},
				],
			},
			"git"
		);
		expect(groups.find((group) => group.kind === "integration")?.items).toEqual(
			[
				{
					kind: "integration",
					id: "github",
					label: "GitHub",
					description: "Connected through Composio",
					icon: expect.anything(),
				},
			]
		);
	});
});

describe("buildComposioMentionSources", () => {
	test("fails closed when Composio is not configured", () => {
		expect(
			buildComposioMentionSources(
				false,
				[{ active: true, toolkit: "github" }],
				[{ description: "GitHub tools", name: "GitHub", slug: "github" }]
			)
		).toEqual([]);
	});

	test("keeps active toolkits once and uses catalog labels", () => {
		expect(
			buildComposioMentionSources(
				true,
				[
					{ active: false, toolkit: "slack" },
					{ active: true, toolkit: "github" },
					{ active: true, toolkit: "GITHUB" },
				],
				[
					{
						description: "Issues and repositories",
						name: "GitHub",
						slug: "github",
					},
				]
			)
		).toEqual([
			{
				description: "Issues and repositories",
				id: "github",
				name: "GitHub",
			},
		]);
	});
});

describe("resolveFirstNamedMentionId", () => {
	test("resolves full agent labels containing spaces", () => {
		expect(
			resolveFirstNamedMentionId("Ask @Claude Code to review this", [
				{ id: "claude", name: "Claude Code" },
			])
		).toBe("claude");
	});

	test("does not resolve a partial name inside another token", () => {
		expect(
			resolveFirstNamedMentionId("email me at @ClaudeCode", [
				{ id: "claude", name: "Claude" },
			])
		).toBeNull();
	});
});

describe("applyMention", () => {
	test("inserts an @Workflow token for a workflow item", () => {
		const value = "please @Plan";
		const item = {
			kind: "workflow" as const,
			id: "wf_plan",
			label: "Plan → Implement → Verify",
		};
		expect(applyMention(value, item)).toBe(
			"please @Plan → Implement → Verify "
		);
	});
});

describe("resolveReferencedChatIds", () => {
	test("resolves typed chat mentions and ignores removed selections", () => {
		const chats = sources().chats;
		expect(
			resolveReferencedChatIds(
				"compare with @Architecture notes",
				chats,
				new Set()
			)
		).toEqual(["conv-architecture"]);
		expect(
			resolveReferencedChatIds("no reference now", chats, new Set(chats[0].id))
		).toEqual([]);
	});
});
