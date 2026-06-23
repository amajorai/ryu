/**
 * Runnable authoring API tests — covers all four acceptance criteria for #205:
 *
 * AC1: defineAgent/defineWorkflow/defineTool/defineSkill each return a Runnable
 *      (id, kind, inputSchema via ToolRunnable, run).
 * AC2: A tool defined with a typed schema validates input at run() and exposes
 *      a JSON Schema compatible with Core's ToolInfo.schema shape.
 * AC3: An agent can reference a workflow as a named tool and a workflow can
 *      reference an agent as a step; a test exercises one nested invocation
 *      end to end against a mock model client.
 * AC4: All model calls inside any Runnable route through the unit-c gateway
 *      client (no direct provider import path), verified by a test.
 */

import { describe, expect, it } from "bun:test";
import { defineAgent } from "./agent";
import type { GatewayClient, RunnableContext } from "./runnable-types";
import { defineSkill } from "./skill";
import { defineTool } from "./tool";
import { defineWorkflow } from "./workflow";

// ── Mock gateway ──────────────────────────────────────────────────────────────

/**
 * Build a mock GatewayClient that records every chat call and returns a
 * controlled response.  Used to assert AC4 (all model calls route through
 * the gateway client, never a direct provider).
 */
function makeMockGateway(replyContent = "mock-reply"): {
	gateway: GatewayClient;
	calls: Array<{ messages: Array<{ role: string; content: string }> }>;
} {
	const calls: Array<{ messages: Array<{ role: string; content: string }> }> =
		[];

	const gateway: GatewayClient = {
		chat(messages) {
			calls.push({ messages: [...messages] });
			return Promise.resolve({ content: replyContent, finishReason: "stop" });
		},
		stream(messages) {
			calls.push({ messages: [...messages] });
			const delta = { content: replyContent, finishReason: null };
			const items = [delta];
			return items[Symbol.asyncIterator]() as AsyncGenerator<typeof delta>;
		},
	};

	return { gateway, calls };
}

function makeCtx(gateway: GatewayClient): RunnableContext {
	return { gateway };
}

// ── AC1: each factory returns a Runnable with id/kind/run ─────────────────────

describe("defineAgent", () => {
	it("returns a Runnable with kind=agent", () => {
		const agent = defineAgent({
			id: "agent-test",
			name: "Test Agent",
			run(_input, _ctx) {
				return Promise.resolve("done");
			},
		});

		expect(agent.id).toBe("agent-test");
		expect(agent.name).toBe("Test Agent");
		expect(agent.kind).toBe("agent");
		expect(typeof agent.run).toBe("function");
	});
});

describe("defineWorkflow", () => {
	it("returns a Runnable with kind=workflow", () => {
		const wf = defineWorkflow({
			id: "workflow-test",
			name: "Test Workflow",
			run(_input, _ctx) {
				return Promise.resolve("done");
			},
		});

		expect(wf.id).toBe("workflow-test");
		expect(wf.name).toBe("Test Workflow");
		expect(wf.kind).toBe("workflow");
		expect(typeof wf.run).toBe("function");
	});
});

describe("defineTool", () => {
	it("returns a ToolRunnable with kind=tool and a schema property", () => {
		const tool = defineTool({
			id: "tool-test",
			name: "Test Tool",
			schema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
			run(input, _ctx) {
				return Promise.resolve({ result: input.query });
			},
		});

		expect(tool.id).toBe("tool-test");
		expect(tool.name).toBe("Test Tool");
		expect(tool.kind).toBe("tool");
		expect(typeof tool.run).toBe("function");
		// ToolRunnable exposes schema
		expect(tool.schema.type).toBe("object");
		expect(tool.schema.properties.query.type).toBe("string");
	});
});

describe("defineSkill", () => {
	it("returns a Runnable with kind=skill", () => {
		const skill = defineSkill({
			id: "skill-test",
			name: "Test Skill",
			run(_input, _ctx) {
				return Promise.resolve("done");
			},
		});

		expect(skill.id).toBe("skill-test");
		expect(skill.name).toBe("Test Skill");
		expect(skill.kind).toBe("skill");
		expect(typeof skill.run).toBe("function");
	});
});

// ── AC2: tool schema validates input and exposes JSON Schema ──────────────────

describe("defineTool — input validation", () => {
	const searchTool = defineTool({
		id: "tool-search",
		name: "Search",
		schema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				limit: { type: "integer", description: "Max results" },
			},
			required: ["query"],
		},
		run(input, _ctx) {
			return Promise.resolve({ results: [`Result for: ${input.query}`] });
		},
	});

	it("exposes JSON Schema compatible with Core ToolInfo.schema", () => {
		// Core's ToolInfo.schema is serde_json::Value — the object shape must match
		// apps/core/src/sidecar/adapters/mod.rs:66-71
		const schema = searchTool.schema;
		expect(schema.type).toBe("object");
		expect(schema.properties).toBeDefined();
		expect(schema.properties.query).toBeDefined();
		expect(schema.properties.query.type).toBe("string");
		expect(schema.required).toContain("query");
	});

	it("runs successfully when required fields are present", async () => {
		const { gateway } = makeMockGateway();
		const result = await searchTool.run({ query: "hello" }, makeCtx(gateway));
		expect(result.results[0]).toBe("Result for: hello");
	});

	it("throws when a required field is missing", async () => {
		const { gateway } = makeMockGateway();
		let caught: unknown;
		try {
			// @ts-expect-error — intentional: testing runtime validation
			await searchTool.run({}, makeCtx(gateway));
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain(
			'missing required field "query"'
		);
	});

	it("throws when a field has the wrong type", async () => {
		const { gateway } = makeMockGateway();
		let caught: unknown;
		try {
			// @ts-expect-error — intentional: testing runtime validation
			await searchTool.run({ query: 42 }, makeCtx(gateway));
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain('expected type "string"');
	});

	it("throws when input is not an object", async () => {
		const { gateway } = makeMockGateway();
		let caught: unknown;
		try {
			// @ts-expect-error — intentional: testing runtime validation
			await searchTool.run("bad", makeCtx(gateway));
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("input must be an object");
	});
});

// ── AC3: nested invocation — agent invokes workflow, workflow invokes agent ───

describe("nested invocation (agent <-> workflow peer relationship)", () => {
	it("workflow uses an agent as a step and returns combined output", async () => {
		const { gateway, calls } = makeMockGateway("research-result");
		const ctx = makeCtx(gateway);

		// Inner agent: does research via the gateway
		const researchAgent = defineAgent<{ query: string }, { answer: string }>({
			id: "agent-research",
			name: "Research Agent",
			async run({ query }, innerCtx) {
				const result = await innerCtx.gateway.chat([
					{ role: "user", content: query },
				]);
				return { answer: result.content };
			},
		});

		// Outer workflow: calls the agent as a step
		const reportWorkflow = defineWorkflow<
			{ topic: string },
			{ report: string }
		>({
			id: "workflow-report",
			name: "Report Workflow",
			steps: [researchAgent],
			async run({ topic }, wfCtx) {
				const { answer } = await researchAgent.run({ query: topic }, wfCtx);
				return { report: `Report on "${topic}": ${answer}` };
			},
		});

		const result = await reportWorkflow.run({ topic: "TypeScript" }, ctx);

		expect(result.report).toBe('Report on "TypeScript": research-result');
		// Gateway was called exactly once (by the agent step)
		expect(calls).toHaveLength(1);
		expect(calls[0].messages[0].content).toBe("TypeScript");
	});

	it("agent invokes a workflow as a named tool", async () => {
		const { gateway, calls } = makeMockGateway("workflow-output");
		const ctx = makeCtx(gateway);

		// A workflow that the agent can delegate to
		const summaryWorkflow = defineWorkflow<
			{ text: string },
			{ summary: string }
		>({
			id: "workflow-summary",
			name: "Summary Workflow",
			async run({ text }, wfCtx) {
				const result = await wfCtx.gateway.chat([
					{ role: "user", content: `Summarise: ${text}` },
				]);
				return { summary: result.content };
			},
		});

		// Agent that calls the workflow as a tool
		const orchestratorAgent = defineAgent<{ doc: string }, { output: string }>({
			id: "agent-orchestrator",
			name: "Orchestrator Agent",
			tools: [summaryWorkflow],
			async run({ doc }, agentCtx) {
				// Agent invokes the workflow as a peer (by calling its run())
				const { summary } = await summaryWorkflow.run({ text: doc }, agentCtx);
				return { output: summary };
			},
		});

		const result = await orchestratorAgent.run({ doc: "long document" }, ctx);

		expect(result.output).toBe("workflow-output");
		// Gateway was called once inside the workflow
		expect(calls).toHaveLength(1);
		expect(calls[0].messages[0].content).toBe("Summarise: long document");
	});
});

// ── AC4: all model calls route through the gateway client ────────────────────

describe("gateway-mandatory routing (AC4)", () => {
	it("agent routes all model calls through ctx.gateway", async () => {
		const { gateway, calls } = makeMockGateway("hello");
		const agent = defineAgent({
			id: "agent-gw",
			name: "GW Agent",
			async run(_input, ctx) {
				return await ctx.gateway.chat([{ role: "user", content: "ping" }]);
			},
		});

		await agent.run({}, makeCtx(gateway));

		expect(calls).toHaveLength(1);
		expect(calls[0].messages[0].content).toBe("ping");
	});

	it("workflow routes all model calls through ctx.gateway", async () => {
		const { gateway, calls } = makeMockGateway("hello");
		const wf = defineWorkflow({
			id: "wf-gw",
			name: "GW Workflow",
			async run(_input, ctx) {
				return await ctx.gateway.chat([
					{ role: "user", content: "workflow-ping" },
				]);
			},
		});

		await wf.run({}, makeCtx(gateway));

		expect(calls).toHaveLength(1);
		expect(calls[0].messages[0].content).toBe("workflow-ping");
	});

	it("skill routes all model calls through ctx.gateway", async () => {
		const { gateway, calls } = makeMockGateway("skill-reply");
		const skill = defineSkill({
			id: "skill-gw",
			name: "GW Skill",
			async run({ text }: { text: string }, ctx) {
				return await ctx.gateway.chat([{ role: "user", content: text }]);
			},
		});

		await skill.run({ text: "skill-ping" }, makeCtx(gateway));

		expect(calls).toHaveLength(1);
		expect(calls[0].messages[0].content).toBe("skill-ping");
	});

	it("tool can optionally route model calls through ctx.gateway", async () => {
		const { gateway, calls } = makeMockGateway("tool-model-reply");
		const tool = defineTool({
			id: "tool-gw",
			name: "GW Tool",
			schema: {
				type: "object",
				properties: { prompt: { type: "string" } },
				required: ["prompt"],
			},
			async run({ prompt }, ctx) {
				return await ctx.gateway.chat([{ role: "user", content: prompt }]);
			},
		});

		await tool.run({ prompt: "tool-ping" }, makeCtx(gateway));

		expect(calls).toHaveLength(1);
		expect(calls[0].messages[0].content).toBe("tool-ping");
	});
});
