// apps/desktop/src/components/panels/cowork-sources.test.ts
//
// Tests for the Cowork rail's Sources derivation. The section used to list only
// the CONNECTOR ("Web search", "Local files"), which told a user nothing about
// what the run actually read or fetched. Now each connector carries the items it
// touched, and the load-bearing behaviours are:
//   - the item field names match what really arrives in `parts[].input`
//     (`file_path`, `pattern`, `command`, `url`) — a wrong guess renders a group
//     with a count and an empty list, which is worse than the old behaviour;
//   - a `dynamic-tool` part (how MCP tools arrive over the ACP bridge) is
//     attributed to its server instead of being dropped;
//   - web results come from the tool OUTPUT, so a search shows the links it
//     found and not just the query string;
//   - user attachments come from the same file parts the transcript renders;
//   - items dedupe, so reading one file ten times is one row.

import { describe, expect, mock, test } from "bun:test";

// This suite exercises the pure Sources derivation, not the visual shimmer. The
// block's production module imports the UI package through a Vite-only
// extensionless path, so keep that unrelated renderer out of Bun's test graph.
mock.module("@ryu/blocks/desktop/agent-elements/text-shimmer", () => ({
	TextShimmer: () => null,
}));
mock.module("@/components/agent-elements/message-list.tsx", () => ({
	MessageList: () => null,
}));

const { extractSources } = await import(
	"@/src/components/panels/CoworkContextPanel.tsx"
);

function toolMessage(parts: Record<string, unknown>[]) {
	return { role: "assistant", parts };
}

describe("extractSources", () => {
	test("lists image and document attachments from user chat messages", () => {
		const sources = extractSources([
			{
				role: "user",
				parts: [
					{
						type: "file",
						filename: "reference.png",
						mediaType: "image/png",
						url: "data:image/png;base64,abc",
					},
					{
						type: "file",
						filename: "brief.pdf",
						mediaType: "application/pdf",
					},
				],
			},
			{
				role: "user",
				experimental_attachments: [
					{
						name: "legacy-photo.jpg",
						contentType: "image/jpeg",
						url: "data:image/jpeg;base64,abc",
					},
				],
			},
			toolMessage([
				{ type: "tool-Read", input: { file_path: "/repo/src/main.rs" } },
			]),
		]);

		expect(sources.map((source) => source.id)).toEqual([
			"attachments",
			"local",
		]);
		const attachments = sources[0];
		expect(attachments.label).toBe("Chat attachments");
		expect(attachments.items.map((item) => item.label)).toEqual([
			"reference.png",
			"brief.pdf",
			"legacy-photo.jpg",
		]);
		expect(attachments.items.map((item) => item.detail)).toEqual([
			"image/png",
			"application/pdf",
			"image/jpeg",
		]);
		expect(attachments.items.map((item) => item.filePath)).toEqual([
			"reference.png",
			"brief.pdf",
			"legacy-photo.jpg",
		]);
	});

	test("does not treat assistant-generated files as input sources", () => {
		expect(
			extractSources([
				{
					role: "assistant",
					parts: [
						{
							type: "file",
							filename: "result.png",
							mediaType: "image/png",
						},
					],
				},
			])
		).toEqual([]);
	});

	test("lists the files a run read and wrote, by basename", () => {
		const sources = extractSources([
			toolMessage([
				{ type: "tool-Read", input: { file_path: "/repo/src/main.rs" } },
				{ type: "tool-Read", input: { file_path: "/repo/src/main.rs" } },
				{ type: "tool-Edit", input: { file_path: "/repo/src/lib.rs" } },
			]),
		]);

		expect(sources).toHaveLength(1);
		const local = sources[0];
		expect(local.id).toBe("local");
		expect(local.items.map((item) => item.label)).toEqual([
			"main.rs",
			"lib.rs",
		]);
		expect(local.items[0].detail).toBe("/repo/src/main.rs");
		expect(local.items[0].filePath).toBe("/repo/src/main.rs");
	});

	test("keeps searches and shell commands beside the files", () => {
		const [local] = extractSources([
			toolMessage([
				{ type: "tool-Grep", input: { pattern: "TODO", path: "src" } },
				{ type: "tool-Bash", input: { command: "cargo test\n# noise" } },
			]),
		]);

		expect(local.items.map((item) => item.label)).toEqual([
			"TODO",
			"cargo test",
		]);
		expect(local.items[0].detail).toBe("src");
	});

	test("web sources carry the fetched URL and the links a search found", () => {
		const [web] = extractSources([
			toolMessage([
				{ type: "tool-WebFetch", input: { url: "https://example.com/a" } },
				{
					type: "tool-WebSearch",
					input: { query: "rust async" },
					output: {
						results: [
							{ title: "Async book", url: "https://rust-lang.org/async" },
						],
					},
				},
			]),
		]);

		expect(web.id).toBe("web");
		const urls = web.items.map((item) => item.url).filter(Boolean);
		expect(urls).toContain("https://example.com/a");
		expect(urls).toContain("https://rust-lang.org/async");
		// The query itself still shows, so an in-flight search isn't a blank group.
		expect(web.items.some((item) => item.label === "rust async")).toBe(true);
	});

	test("a fetched page's own title replaces the bare URL row", () => {
		const [web] = extractSources([
			toolMessage([
				{
					type: "tool-WebFetch",
					input: { url: "https://example.com/post" },
					output: { title: "The post" },
				},
			]),
		]);

		expect(web.items).toHaveLength(1);
		expect(web.items[0].label).toBe("The post");
		expect(web.items[0].url).toBe("https://example.com/post");
	});

	test("attributes a dynamic-tool MCP call to its server", () => {
		const sources = extractSources([
			toolMessage([
				{
					type: "dynamic-tool",
					toolName: "mcp.linear.create_issue",
					input: { name: "Fix the rail" },
				},
			]),
		]);

		expect(sources).toHaveLength(1);
		expect(sources[0].id).toBe("mcp-linear");
		expect(sources[0].label).toBe("Linear");
		expect(sources[0].items[0].label).toBe("create issue");
		expect(sources[0].items[0].detail).toBe("Fix the rail");
	});

	test("ignores tool calls that aren't an external source", () => {
		expect(
			extractSources([
				toolMessage([{ type: "tool-TodoWrite", input: { todos: [] } }]),
			])
		).toEqual([]);
	});

	test("a source whose input hasn't streamed yet has no phantom items", () => {
		const [local] = extractSources([
			toolMessage([{ type: "tool-Read", input: {}, state: "input-streaming" }]),
		]);

		expect(local.id).toBe("local");
		expect(local.items).toEqual([]);
	});
});
