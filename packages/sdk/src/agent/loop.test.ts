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
	it("forwards real gateway text deltas and assembles a streamed tool call", async () => {
		let modelCalls = 0;
		let firstBody: string | undefined;
		globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (!url.includes("/v1/chat/completions")) {
				return Promise.resolve(new Response("not found", { status: 404 }));
			}
			modelCalls += 1;
			if (modelCalls === 1) {
				firstBody = init?.body?.toString();
			}
			const frames =
				modelCalls === 1
					? [
							{
								choices: [
									{
										delta: {
											tool_calls: [
												{
													index: 0,
													id: "call-1",
													function: {
														arguments: '{"text":"hi"',
														name: "echo",
													},
												},
											],
										},
										finish_reason: null,
									},
								],
							},
							{
								choices: [
									{
										delta: {
											tool_calls: [
												{
													index: 0,
													function: { arguments: "}" },
												},
											],
										},
										finish_reason: "tool_calls",
									},
								],
							},
						]
					: [
							{
								choices: [{ delta: { content: "hel" }, finish_reason: null }],
							},
							{
								choices: [{ delta: { content: "lo" }, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 2,
									completion_tokens: 2,
									total_tokens: 4,
								},
							},
						];
			const body = `${frames
				.map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
				.join("")}data: [DONE]\n\n`;
			return Promise.resolve(
				new Response(body, { headers: { "content-type": "text/event-stream" } })
			);
		}) as typeof globalThis.fetch;

		const echo = defineTool({
			id: "echo",
			name: "Echo",
			schema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
			run: (input) => Promise.resolve({ echoed: input.text }),
		});
		const events = await collect(
			new Agent({
				model: "gpt-4o",
				name: "streaming",
				node: { baseUrl: NODE },
				tools: { echo },
			}).stream("go")
		);

		expect(
			events
				.filter((event) => event.type === "text")
				.map((event) => event.content)
		).toEqual(["hel", "lo"]);
		expect(events.some((event) => event.type === "tool_call")).toBe(true);
		const result = events.find((event) => event.type === "result");
		expect(result?.type === "result" && result.text).toBe("hello");
		expect(modelCalls).toBe(2);
		expect(JSON.parse(String(firstBody)).stream).toBe(true);
	});

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

	it("pauses a gated tool until the approval handler allows it", async () => {
		let ran = false;
		let approvalName = "";
		const gated = defineTool({
			id: "gated",
			name: "Gated tool",
			needsApproval: true,
			schema: { type: "object", properties: {} },
			run: () => {
				ran = true;
				return Promise.resolve({ ok: true });
			},
		});
		modelQueue = [
			modelResponse({ toolCalls: [toolCall("c1", "gated", {})] }),
			modelResponse({ content: "approved", finish: "stop" }),
		];
		const events = await collect(
			new Agent({
				name: "approval",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				tools: { gated },
				approvalHandler: async (request) => {
					approvalName = request.name;
					return true;
				},
			}).stream("run it")
		);
		expect(ran).toBe(true);
		expect(approvalName).toBe("gated");
		expect(events.some((event) => event.type === "approval_requested")).toBe(
			true
		);
		expect(events.find((event) => event.type === "result")?.type).toBe(
			"result"
		);
	});

	it("parses structured output and rejects invalid JSON", async () => {
		modelQueue = [
			modelResponse({ content: '{"answer":"ok"}', finish: "stop" }),
		];
		const resultEvents = await collect(
			new Agent({
				name: "structured",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				outputSchema: {
					type: "object",
					properties: { answer: { type: "string" } },
					required: ["answer"],
				},
			}).stream("return JSON")
		);
		const result = resultEvents.find((event) => event.type === "result");
		expect(result?.type === "result" && result.output).toEqual({
			answer: "ok",
		});

		modelQueue = [modelResponse({ content: "not json", finish: "stop" })];
		const invalid = await collect(
			new Agent({
				name: "structured-invalid",
				model: "gpt-4o",
				node: { baseUrl: NODE },
				outputSchema: { type: "object" },
			}).stream("return JSON")
		);
		expect(invalid.some((event) => event.type === "error")).toBe(true);
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
				gmailSearch: ryuTool("composio.GMAIL_SEARCH_EMAILS", {
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
		expect(captured.body?.tool).toBe("composio.GMAIL_SEARCH_EMAILS");
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
				gmailSearch: ryuTool("composio.GMAIL_SEARCH_EMAILS", {
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
			gmailSearch: ryuTool("composio.GMAIL_SEARCH_EMAILS"),
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
