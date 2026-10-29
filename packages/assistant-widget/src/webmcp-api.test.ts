import { describe, expect, test } from "bun:test";
import {
	registerWebMcpTools,
	type WebMcpModelContext,
	type WebMcpToolDefinition,
} from "./webmcp-api.ts";

describe("WebMCP provider contract", () => {
	test("registers tools through registerTool and aborts them on cleanup", () => {
		const registrations: Array<{
			name: string;
			signal: AbortSignal | undefined;
		}> = [];
		const context: WebMcpModelContext = {
			registerTool(tool, options) {
				registrations.push({ name: tool.name, signal: options?.signal });
				return Promise.resolve();
			},
		};
		const tools: WebMcpToolDefinition[] = [
			{
				description: "Read the current page.",
				execute: async () => "page",
				inputSchema: { type: "object" },
				name: "read_page",
			},
			{
				description: "Start a hosted checkout.",
				execute: async () => "checkout",
				inputSchema: { type: "object" },
				name: "start_checkout",
			},
		];

		const cleanup = registerWebMcpTools(context, tools);

		expect(registrations.map(({ name }) => name)).toEqual([
			"read_page",
			"start_checkout",
		]);
		expect(
			registrations.every(({ signal }) => signal === registrations[0]?.signal)
		).toBe(true);
		cleanup();
		expect(registrations.every(({ signal }) => signal?.aborted)).toBe(true);
	});

	test("does nothing when the browser does not implement registerTool", () => {
		const context: WebMcpModelContext = {};
		const cleanup = registerWebMcpTools(context, []);

		expect(() => cleanup()).not.toThrow();
	});
});
