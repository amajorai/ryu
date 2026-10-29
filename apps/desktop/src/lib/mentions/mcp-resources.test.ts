import { expect, test } from "bun:test";
import {
	isMcpMentionTool,
	mcpMentionSources,
	mentionedMcpResources,
	mentionSearchQuery,
} from "./mcp-resources.ts";

const tool = {
	id: "cad.mentions",
	server: "cad",
	name: "mentions",
	description: null,
	inputSchema: {},
	meta: {
		"openai/extensions": { "mentions/search": {} },
		ui: { visibility: ["app"] },
	},
};

test("discovers exact OpenAI app-visible mention tools and parses bounded resource links", () => {
	expect(isMcpMentionTool(tool)).toBe(true);
	expect(
		isMcpMentionTool({
			...tool,
			meta: { ...tool.meta, ui: { visibility: ["model"] } },
		})
	).toBe(false);
	const sources = mcpMentionSources(tool, {
		structuredContent: {
			items: [
				{
					type: "resource_link",
					name: "Hex bolt",
					uri: "cad://parts/hex-bolt",
				},
				{ type: "text", text: "ignored" },
			],
		},
	});
	expect(sources).toHaveLength(1);
	expect(mentionedMcpResources("Review @Hex bolt please", sources)).toEqual([
		"Hex bolt: cad://parts/hex-bolt",
	]);
	expect(mentionedMcpResources("mail@Hex bolt", sources)).toEqual([]);
});

test("extracts active typeahead query without treating typed links as search", () => {
	expect(mentionSearchQuery("Review @hex")).toBe("hex");
	expect(mentionSearchQuery("@")).toBe("");
	expect(mentionSearchQuery("mail@person")).toBeNull();
	expect(mentionSearchQuery("@[bolt](cad://bolt)")).toBeNull();
});

test("keeps resource-link text and bounds raw items before filtering", () => {
	const link = {
		type: "resource_link",
		name: "  Future CAD part  ",
		uri: "cad://parts/future",
		description: 42,
		mimeType: "application/vnd.future-cad",
		future: { revision: 2 },
	};
	const sources = mcpMentionSources(tool, {
		items: [null, { ...link, name: " " }, link],
	});
	expect(sources).toEqual([
		{
			id: "cad.mentions:cad://parts/future",
			name: "  Future CAD part  ",
			ownerId: "cad",
			description: "cad",
			resourceUri: "cad://parts/future",
		},
	]);
	expect(
		mcpMentionSources(tool, {
			items: [...Array.from({ length: 100 }, () => null), link],
		})
	).toEqual([]);
	expect(
		mcpMentionSources(tool, { structuredContent: null, items: [link] })
	).toEqual([]);
	expect(
		isMcpMentionTool({
			...tool,
			meta: { ...tool.meta, ui: { visibility: [null, "app", 3] } },
		})
	).toBe(true);
	expect(
		isMcpMentionTool({
			...tool,
			meta: { ...tool.meta, "openai/extensions": {} },
		})
	).toBe(false);
});
