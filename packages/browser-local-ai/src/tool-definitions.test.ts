import { expect, test } from "bun:test";
import { parseBrowserToolDefinitions } from "./runtime.ts";

test("browser tool definitions retain nested JSON schema fields", () => {
	const definitions = [
		{
			name: "read_page",
			parameters: {
				type: "object",
				properties: { limit: { type: "number" } },
				required: ["limit"],
			},
		},
	];
	expect(parseBrowserToolDefinitions(definitions)).toEqual(definitions);
});

test("browser messages cannot supply executable or non-JSON tool metadata", () => {
	expect(() =>
		parseBrowserToolDefinitions([{ name: "read_page", run: () => "page" }])
	).toThrow();
	expect(() => parseBrowserToolDefinitions([null])).toThrow();
});
