import { describe, expect, test } from "bun:test";
import { normalizeWebMcpTool } from "./webmcp";

describe("WebMCP page-tool boundary", () => {
	test("keeps safe metadata and bounds the input schema", () => {
		const tool = normalizeWebMcpTool({
			annotations: {
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
			title: "Read page\nnow",
		});

		if (!tool) {
			throw new Error("expected a normalized tool");
		}
		expect(tool.description).toBe(
			"Read the page provided by the current origin."
		);
		expect(tool.title).toBe("Read page now");
		expect(
			Object.keys(tool.inputSchema.properties as Record<string, unknown>)
		).toHaveLength(12);
		expect(tool.annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
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
