import { describe, expect, it } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	fetchRunTraceTree,
	flattenTraceTree,
	joinTraceUsage,
	listTraces,
	type TraceAuditRow,
	usageTotals,
} from "./traces.ts";

function node(
	id: string,
	kind: string,
	startedAt: number,
	endedAt: number | null,
	children: unknown[] = [],
	extra: Record<string, unknown> = {}
) {
	return {
		id: `row-${id}`,
		conversation_id: "run-1",
		kind,
		name: id,
		args_hash: null,
		started_at: startedAt,
		ended_at: endedAt,
		error: null,
		session_id: kind === "model_call" ? "run-1" : null,
		seq: startedAt,
		trace_id: "t".repeat(32),
		span_id: id,
		parent_span_id: null,
		status: endedAt === null ? "running" : "ok",
		agent_id: "agent-1",
		attributes: {},
		normalized_kind: kind,
		depth: 0,
		offset_ms: startedAt - 1000,
		duration_ms: endedAt === null ? null : endedAt - startedAt,
		children,
		...extra,
	};
}

function targetReturning(body: unknown, seen: string[]): ApiTarget {
	return {
		token: "t",
		url: "http://core.test",
		fetch: ((input: RequestInfo | URL) => {
			seen.push(String(input));
			return Promise.resolve(Response.json(body));
		}) as ApiTarget["fetch"],
	};
}

const treeBody = {
	format: "tree",
	run_id: "run-1",
	started_at: 1000,
	ended_at: 5000,
	duration_ms: 4000,
	span_count: 4,
	error_count: 0,
	roots: [
		node("root", "agent_run", 1000, 5000, [
			node("model-a", "model_call", 1100, 2000),
			node("tool", "tool_call", 2100, 2600, [
				node("recall", "retrieval", 2200, 2300),
			]),
			node("model-b", "model_call", 2700, 4900),
		]),
	],
};

describe("fetchRunTraceTree", () => {
	it("requests the tree format and normalizes nested nodes", async () => {
		const seen: string[] = [];
		const tree = await fetchRunTraceTree(
			targetReturning(treeBody, seen),
			"run 1"
		);
		expect(seen[0]).toBe("http://core.test/api/runs/run%201/trace?format=tree");
		expect(tree.spanCount).toBe(4);
		const root = tree.roots[0];
		expect(root?.normalizedKind).toBe("agent_run");
		expect(root?.span.agentId).toBe("agent-1");
		expect(root?.children.map((child) => child.span.name)).toEqual([
			"model-a",
			"tool",
			"model-b",
		]);
		expect(root?.children[1]?.children[0]?.span.status).toBe("ok");
	});
});

describe("listTraces", () => {
	it("encodes filters and maps summaries", async () => {
		const seen: string[] = [];
		const traces = await listTraces(
			targetReturning(
				{
					traces: [
						{
							trace_id: "t1",
							run_id: "run-1",
							root_id: "row",
							span_id: "s",
							kind: "agent_run",
							name: "support",
							agent_id: "a1",
							status: "error",
							started_at: 1,
							ended_at: 3,
							duration_ms: 2,
							span_count: 5,
							error_count: 1,
						},
					],
				},
				seen
			),
			{ agentId: "a1", status: "error", query: "sup", limit: 10 }
		);
		expect(seen[0]).toBe(
			"http://core.test/api/traces?agent_id=a1&status=error&q=sup&limit=10"
		);
		expect(traces[0]).toMatchObject({
			traceId: "t1",
			status: "error",
			errorCount: 1,
			durationMs: 2,
		});
	});
});

describe("joinTraceUsage", () => {
	const audit = (
		id: string,
		timestamp: number,
		tokens: number,
		sessionId = "run-1"
	): TraceAuditRow => ({
		id,
		session_id: sessionId,
		event_type: "model_call",
		timestamp: new Date(timestamp).toISOString(),
		model: "m",
		input_tokens: tokens,
		output_tokens: tokens / 2,
		cost_micro_usd: tokens * 10,
		latency_ms: 500,
	});

	it("matches audit rows to model calls by session and time window", async () => {
		const tree = await fetchRunTraceTree(
			targetReturning(treeBody, []),
			"run-1"
		);
		const joined = joinTraceUsage(tree, [
			audit("late", 4900, 200),
			audit("early", 2000, 100),
			audit("other-session", 2000, 999, "run-2"),
			audit("outside", 60_000, 999),
		]);
		const [modelA, , modelB] = joined.roots[0]?.children ?? [];
		expect(modelA?.usage?.auditId).toBe("early");
		expect(modelB?.usage?.auditId).toBe("late");
		expect(tree.roots[0]?.children[0]?.usage).toBeUndefined();
		const totals = usageTotals(
			joined.roots[0] as NonNullable<(typeof joined.roots)[0]>
		);
		expect(totals).toEqual({
			modelCalls: 2,
			inputTokens: 300,
			outputTokens: 150,
			costMicroUsd: 3000,
		});
	});
});

describe("flattenTraceTree", () => {
	it("lists rows depth-first and hides collapsed descendants", async () => {
		const tree = await fetchRunTraceTree(
			targetReturning(treeBody, []),
			"run-1"
		);
		expect(
			flattenTraceTree(tree.roots).map((row) => row.node.span.name)
		).toEqual(["root", "model-a", "tool", "recall", "model-b"]);
		const collapsed = flattenTraceTree(tree.roots, new Set(["row-tool"]));
		expect(collapsed.map((row) => row.node.span.name)).toEqual([
			"root",
			"model-a",
			"tool",
			"model-b",
		]);
		expect(collapsed[2]?.hasChildren).toBe(true);
	});
});
