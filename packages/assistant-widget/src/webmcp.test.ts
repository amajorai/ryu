import { describe, expect, test } from "bun:test";
import { normalizeWebMcpTool } from "./webmcp.ts";

describe("WebMCP page-tool boundary", () => {
	test("keeps safe metadata and bounds the input schema", () => {
		const tool = normalizeWebMcpTool({
			annotations: {
				consequentialHint: true,
				readOnlyHint: true,
				untrustedContentHint: true,
			},
			description: "Read the page\nprovided by the current origin.",
			inputSchema: {
				properties: Object.fromEntries(
					Array.from({ length: 14 }, (_, index) => [
						`field-${index}`,
						{ description: "field", enum: ["one", "two"], type: "string" },
					])
				),
				required: ["field-0"],
				type: "object",
			},
			name: "read_page",
			origin: "https://docs.example",
			title: "Read page\nnow",
		});

		if (!tool) {
			throw new Error("expected a normalized tool");
		}
		expect(tool.description).toBe(
			"Read the page provided by the current origin."
		);
		expect(tool.title).toBe("Read page now");
		expect(tool.origin).toBe("https://docs.example");
		expect(Object.keys(tool.inputSchema.properties)).toHaveLength(12);
		expect(tool.annotations).toEqual({
			consequentialHint: true,
			readOnlyHint: true,
			untrustedContentHint: true,
		});
	});

	test("parses current RegisteredTool schemas and rejects hidden required fields", () => {
		const tool = normalizeWebMcpTool({
			description: "Read a page.",
			inputSchema:
				'{"properties":{"path":{"type":"string"}},"required":["path"],"type":"object"}',
			name: "read_page",
			origin: "https://docs.example/path-is-not-an-origin",
		});

		expect(tool?.inputSchema.required).toEqual(["path"]);
		expect(tool?.origin).toBeUndefined();
		expect(
			normalizeWebMcpTool({
				description: "A tool with an unsupported required field.",
				inputSchema: {
					properties: Object.fromEntries(
						Array.from({ length: 13 }, (_, index) => [
							`field-${index}`,
							{ type: "string" },
						])
					),
					required: ["field-12"],
					type: "object",
				},
				name: "too_many_fields",
			})
		).toBeNull();
	});

	test("rejects malformed or executable-looking tool names", () => {
		expect(
			normalizeWebMcpTool({
				description: "missing a valid name",
				name: "delete everything!",
			})
		).toBeNull();
		expect(
			normalizeWebMcpTool({
				description: "",
				name: "read_page",
			})
		).toBeNull();
	});
});
