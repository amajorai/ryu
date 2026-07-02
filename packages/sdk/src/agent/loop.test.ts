/**
 * Unit tests for the autonomous agent loop.
 *
 * The loop talks to the gateway and Core over `fetch` (the model client's native
 * reqwest transport is bypassed here), so we stub `globalThis.fetch` and route
 * by URL: gateway completions, Core tool calls, and Core describe. Egress
 * enforcement is real (loopback passes), matching model/client.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defineTool } from "../runnable/tool.ts";
import { Agent } from "./agent.ts";
import type { AgentEvent } from "./loop.ts";
import type { ToolCall } from "./model-call.ts";
import { executeTool, ryuTool } from "./tools.ts";

const NODE = "http://127.0.0.1:7981";
const RE_AGENT_ID = /agentId/;

// ── Fetch stub ────────────────────────────────────────────────────────────────

let modelQueue: unknown[] = [];
let toolHandler: (body: Record<string, unknown>) => unknown = () => ({
	ok: true,
	output: {},
});
let originalFetch: typeof globalThis.fetch;

function modelResponse(opts: {
	content?: string | null;
	finish?: string;
	toolCalls?: ToolCall[];
}) {
	const toolCalls = opts.toolCalls ?? [];
	return {
		choices: [
			{
				finish_reason:
					opts.finish ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
				message: {
					content: opts.content ?? null,
					tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
				},
			},
		],
		usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
	};
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
	return {
		id,
		type: "function",
		function: { name, arguments: JSON.stringify(args) },
	};
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	modelQueue = [];
	toolHandler = () => ({ ok: true, output: {} });
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.includes("/v1/chat/completions")) {
			const next = modelQueue.shift() ?? modelResponse({ content: "done" });
			return Promise.resolve(
				new Response(JSON.stringify(next), { status: 200 })
			);
		}
		if (url.includes("/api/mcp/tools/call")) {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<
				string,
				unknown
			>;
			return Promise.resolve(
				new Response(JSON.stringify(toolHandler(body)), { status: 200 })
			);
		}
		if (url.includes("/api/tools/describe")) {
			return Promise.resolve(
				new Response(JSON.stringify({ description: "desc" }), { status: 200 })
			);
		}
		return Promise.resolve(new Response("not found", { status: 404 }));
	}) as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAgentLoop", () => {
	it("executes a local tool, feeds the result back, and terminates", async () => {
		let ran = false;
		const echo = defineTool({
			id: "echo",
			name: "Echo the input",
			schema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
			run: (input) => {
				ran = true;
				return Promise.resolve({ echoed: input.text });
			},
		});

		modelQueue = [
			modelResponse({ toolCalls: [toolCall("c1", "echo", { text: "hi" })] }),
			modelResponse({ content: "All done.", finish: "stop" }),
		];

		const agent = new Agent({
			name: "t",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			tools: { echo },
		});

		const events = await collect(agent.stream("go"));
		const types = events.map((e) => e.type);

		expect(ran).toBe(true);
		expect(types).toContain("tool_call");
		expect(types).toContain("tool_result");
		const result = events.find((e) => e.type === "result");
		expect(result).toBeDefined();
		expect(result?.type === "result" && result.text).toBe("All done.");
		// Usage aggregates across both model rounds (8 + 8).
		expect(result?.type === "result" && result.usage?.totalTokens).toBe(16);
	});

	it("executes a remote tool via Core /api/mcp/tools/call", async () => {
		const captured: {
			body: { agent_id?: unknown; tool?: unknown; user_id?: unknown } | null;
		} = { body: null };
		toolHandler = (body) => {
			captured.body = body;
			return { ok: true, output: { messages: ["expense receipt"] } };
		};
		modelQueue = [
			modelResponse({
				toolCalls: [toolCall("c1", "gmailSearch", { query: "receipt" })],
			}),
			modelResponse({ content: "Found 1 expense.", finish: "stop" }),
		];

		const agent = new Agent({
			name: "expense",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			agentId: "agent-expense",
			userId: "user-1",
			tools: {
				gmailSearch: ryuTool("composio__GMAIL_SEARCH_EMAILS", {
					description: "Search Gmail",
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
				}),
			},
		});

		const events = await collect(agent.stream("find expenses"));
		expect(captured.body).not.toBeNull();
		expect(captured.body?.tool).toBe("composio__GMAIL_SEARCH_EMAILS");
		expect(captured.body?.agent_id).toBe("agent-expense");
		expect(captured.body?.user_id).toBe("user-1");
		const result = events.find((e) => e.type === "result");
		expect(result?.type === "result" && result.text).toBe("Found 1 expense.");
	});

	it("pauses with auth_required when a remote tool returns an elicitation", async () => {
		toolHandler = () => ({
			ok: true,
			output: {
				__ryu_elicitation__: {
					kind: "url",
					url: "https://connect.example/gmail",
					message: "Connect your Gmail",
				},
			},
		});
		modelQueue = [
			modelResponse({
				toolCalls: [toolCall("c1", "gmailSearch", { query: "x" })],
			}),
			// This second response must NOT be consumed — the loop stops on auth.
			modelResponse({ content: "should not reach", finish: "stop" }),
		];

		const agent = new Agent({
			name: "expense",
			model: "gpt-4o",
			node: { baseUrl: NODE },
			agentId: "agent-expense",
			tools: {
				gmailSearch: ryuTool("composio__GMAIL_SEARCH_EMAILS", {
					parameters: { type: "object", properties: {} },
				}),
			},
		});

		const events = await collect(agent.stream("find expenses"));
		const auth = events.find((e) => e.type === "auth_required");
		expect(auth?.type === "auth_required" && auth.url).toBe(
			"https://connect.example/gmail"
		);
		// Loop stopped: no result event, second model response left unconsumed.
		expect(events.some((e) => e.type === "result")).toBe(false);
		expect(modelQueue.length).toBe(1);
	});

	it("query() yields the same terminal result as Agent.generate()", async () => {
		const { query } = await import("./query.ts");
		modelQueue = [modelResponse({ content: "Hello there.", finish: "stop" })];

		const events = await collect(
			query({
				prompt: "hi",
				options: { model: "gpt-4o", node: { baseUrl: NODE } },
			})
		);
		const result = events.find((e) => e.type === "result");
		expect(result?.type === "result" && result.text).toBe("Hello there.");
	});
});

describe("executeTool", () => {
	it("throws when a remote tool is used without an agentId", async () => {
		const tools = {
			gmailSearch: ryuTool("composio__GMAIL_SEARCH_EMAILS"),
		};
		await expect(
			executeTool("gmailSearch", "{}", tools, {
				coreBaseUrl: "http://127.0.0.1:7980",
				runnableContext: {
					gateway: {
						chat: () => Promise.reject(new Error("unused")),
						async *stream() {
							// no-op
						},
					},
				},
			})
		).rejects.toThrow(RE_AGENT_ID);
	});
});
