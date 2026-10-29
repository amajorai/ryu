// Typed client for Core's hierarchical run traces.
//
// GET /api/runs/:id/trace?format=tree — a run's spans nested by parent
// GET /api/traces                     — list/search traces across runs
//
// Spans record what ran (Core). Token counts and cost are measured by the
// Gateway; `joinTraceUsage` attaches Gateway audit rows to model-call spans by
// their shared session id and time window, so a waterfall can show latency,
// tokens, and cost together without either service owning the other's data.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";
import {
	normalizeSpan,
	type RunSpan,
	type RunSpanStatus,
	runSpanSchema,
} from "./runs.ts";

function nativeResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}

const nullableNumber = z.number().nullable().optional();

const treeNodeFieldsSchema = z.object({
	normalized_kind: z.string().nullable().optional(),
	depth: z.number(),
	offset_ms: z.number(),
	duration_ms: nullableNumber,
	children: z.array(z.unknown()).optional(),
});

const runTraceTreeResponseSchema = nativeResponse(
	z.object({
		run_id: z.string(),
		started_at: nullableNumber,
		ended_at: nullableNumber,
		duration_ms: nullableNumber,
		span_count: z.number(),
		error_count: z.number(),
		roots: z.array(z.unknown()),
	})
);

const traceSummarySchema = z.object({
	trace_id: z.string(),
	run_id: z.string(),
	root_id: z.string(),
	span_id: z.string().nullable().optional(),
	kind: z.string(),
	name: z.string(),
	agent_id: z.string().nullable().optional(),
	status: z.string(),
	started_at: z.number(),
	ended_at: nullableNumber,
	duration_ms: nullableNumber,
	span_count: z.number(),
	error_count: z.number(),
});

const traceListResponseSchema = nativeResponse(
	z.object({ traces: z.array(traceSummarySchema).optional() })
);

/** Gateway-measured usage joined onto a model-call span. */
export interface TraceSpanUsage {
	/** Gateway audit row id. */
	auditId: string;
	/** Estimated cost in micro-USD; `null` when cost attribution is off. */
	costMicroUsd: number | null;
	inputTokens: number | null;
	/** Provider latency the Gateway measured. */
	latencyMs: number | null;
	model: string | null;
	outputTokens: number | null;
}

/** Usage totals for a node and everything under it. */
export interface TraceUsageTotals {
	costMicroUsd: number;
	inputTokens: number;
	modelCalls: number;
	outputTokens: number;
}

/** One span in a trace tree, positioned on the run's timeline. */
export interface TraceNode {
	children: TraceNode[];
	depth: number;
	/** `null` while the span is running. */
	durationMs: number | null;
	/** Canonical kind (`tool-call` → `tool_call`); `null` when unknown. */
	normalizedKind: string | null;
	/** Milliseconds from the run's first span to this span's start. */
	offsetMs: number;
	span: RunSpan;
	/** Usage joined from Gateway audit (model calls only). */
	usage?: TraceSpanUsage;
}

/** A run's spans as a forest. */
export interface RunTraceTree {
	durationMs: number | null;
	endedAt: number | null;
	errorCount: number;
	roots: TraceNode[];
	runId: string;
	spanCount: number;
	startedAt: number | null;
}

/** One trace (root span) in a listing. */
export interface TraceSummary {
	agentId: string | null;
	durationMs: number | null;
	endedAt: number | null;
	errorCount: number;
	kind: string;
	name: string;
	rootId: string;
	runId: string;
	spanCount: number;
	spanId: string | null;
	startedAt: number;
	status: RunSpanStatus;
	traceId: string;
}

/** Filters for {@link listTraces}. */
export interface TraceListFilters {
	agentId?: string;
	kind?: string;
	limit?: number;
	offset?: number;
	/** Substring of the root name, or an exact run id / trace id. */
	query?: string;
	runId?: string;
	/** Unix milliseconds or an ISO timestamp. */
	since?: number | string;
	status?: RunSpanStatus;
	/** Unix milliseconds or an ISO timestamp. */
	until?: number | string;
}

const MAX_TREE_DEPTH = 256;

function normalizeNode(raw: unknown, depth: number): TraceNode | null {
	const span = runSpanSchema.safeParse(raw);
	const fields = treeNodeFieldsSchema.safeParse(raw);
	if (!(span.success && fields.success)) {
		return null;
	}
	const children =
		depth >= MAX_TREE_DEPTH
			? []
			: (fields.data.children ?? [])
					.map((child) => normalizeNode(child, depth + 1))
					.filter((child): child is TraceNode => child !== null);
	return {
		span: normalizeSpan(span.data),
		normalizedKind: fields.data.normalized_kind ?? null,
		depth: fields.data.depth,
		offsetMs: fields.data.offset_ms,
		durationMs: fields.data.duration_ms ?? null,
		children,
	};
}

/** Fetch a run's spans as a tree (`GET /api/runs/:id/trace?format=tree`). */
export async function fetchRunTraceTree(
	target: ApiTarget,
	runId: string,
	signal?: AbortSignal
): Promise<RunTraceTree> {
	const raw = await request(
		target,
		`/api/runs/${encodeURIComponent(runId)}/trace?format=tree`,
		{ signal },
		runTraceTreeResponseSchema
	);
	return {
		runId: raw.run_id,
		startedAt: raw.started_at ?? null,
		endedAt: raw.ended_at ?? null,
		durationMs: raw.duration_ms ?? null,
		spanCount: raw.span_count,
		errorCount: raw.error_count,
		roots: raw.roots
			.map((root) => normalizeNode(root, 0))
			.filter((root): root is TraceNode => root !== null),
	};
}

function statusOf(value: string): RunSpanStatus {
	switch (value) {
		case "running":
		case "ok":
		case "error":
		case "cancelled":
			return value;
		default:
			return "ok";
	}
}

/** List and search traces across the caller's readable runs (`GET /api/traces`). */
export async function listTraces(
	target: ApiTarget,
	filters: TraceListFilters = {},
	signal?: AbortSignal
): Promise<TraceSummary[]> {
	const params = new URLSearchParams();
	const set = (key: string, value: number | string | undefined) => {
		if (value !== undefined && value !== "") {
			params.set(key, String(value));
		}
	};
	set("agent_id", filters.agentId);
	set("status", filters.status);
	set("kind", filters.kind);
	set("since", filters.since);
	set("until", filters.until);
	set("q", filters.query);
	set("run_id", filters.runId);
	set("limit", filters.limit);
	set("offset", filters.offset);
	const path = params.size > 0 ? `/api/traces?${params}` : "/api/traces";
	const raw = await request(target, path, { signal }, traceListResponseSchema);
	return (raw.traces ?? []).map((row) => ({
		traceId: row.trace_id,
		runId: row.run_id,
		rootId: row.root_id,
		spanId: row.span_id ?? null,
		kind: row.kind,
		name: row.name,
		agentId: row.agent_id ?? null,
		status: statusOf(row.status),
		startedAt: row.started_at,
		endedAt: row.ended_at ?? null,
		durationMs: row.duration_ms ?? null,
		spanCount: row.span_count,
		errorCount: row.error_count,
	}));
}

/** The Gateway audit fields the usage join reads. */
export interface TraceAuditRow {
	cost_micro_usd: number | null;
	event_type: string | null;
	id: string;
	input_tokens: number | null;
	latency_ms: number | null;
	model: string | null;
	output_tokens: number | null;
	session_id: string | null;
	/** ISO-8601 time the Gateway processed the request. */
	timestamp: string;
}

/** Slack around a span's window when matching audit timestamps (clock skew). */
const AUDIT_MATCH_SLACK_MS = 2000;

function isModelCall(node: TraceNode): boolean {
	return (
		(node.normalizedKind ?? node.span.kind.replace("-", "_")) === "model_call"
	);
}

function collectModelCalls(roots: TraceNode[]): TraceNode[] {
	const out: TraceNode[] = [];
	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) {
			break;
		}
		if (isModelCall(node)) {
			out.push(node);
		}
		stack.push(...node.children);
	}
	return out.sort((a, b) => a.span.startedAt - b.span.startedAt);
}

/**
 * Attach Gateway audit usage to each model-call span. A row matches a span
 * when it shares the span's session id, is a model call, and its timestamp
 * falls inside the span window (± a small skew). Each row is used at most
 * once, nearest end time first. Returns a new tree; the input is unchanged.
 */
export function joinTraceUsage(
	tree: RunTraceTree,
	auditRows: readonly TraceAuditRow[]
): RunTraceTree {
	const cloned = structuredClone(tree);
	const candidates = auditRows
		.filter(
			(row) =>
				row.session_id !== null &&
				(row.event_type === null || row.event_type === "model_call")
		)
		.map((row) => ({ row, at: Date.parse(row.timestamp) }))
		.filter((entry) => Number.isFinite(entry.at));
	const used = new Set<string>();
	for (const node of collectModelCalls(cloned.roots)) {
		const { sessionId, startedAt, endedAt } = node.span;
		if (!sessionId) {
			continue;
		}
		const end = endedAt ?? Number.POSITIVE_INFINITY;
		let best: { row: TraceAuditRow; distance: number } | null = null;
		for (const { row, at } of candidates) {
			if (
				used.has(row.id) ||
				row.session_id !== sessionId ||
				at < startedAt - AUDIT_MATCH_SLACK_MS ||
				at > end + AUDIT_MATCH_SLACK_MS
			) {
				continue;
			}
			const distance = Math.abs((endedAt ?? at) - at);
			if (!best || distance < best.distance) {
				best = { row, distance };
			}
		}
		if (best) {
			used.add(best.row.id);
			node.usage = {
				auditId: best.row.id,
				model: best.row.model,
				inputTokens: best.row.input_tokens,
				outputTokens: best.row.output_tokens,
				costMicroUsd: best.row.cost_micro_usd,
				latencyMs: best.row.latency_ms,
			};
		}
	}
	return cloned;
}

/** Sum joined usage over a node and its descendants. */
export function usageTotals(node: TraceNode): TraceUsageTotals {
	const totals: TraceUsageTotals = {
		costMicroUsd: 0,
		inputTokens: 0,
		modelCalls: 0,
		outputTokens: 0,
	};
	const stack = [node];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			break;
		}
		if (current.usage) {
			totals.modelCalls += 1;
			totals.inputTokens += current.usage.inputTokens ?? 0;
			totals.outputTokens += current.usage.outputTokens ?? 0;
			totals.costMicroUsd += current.usage.costMicroUsd ?? 0;
		}
		stack.push(...current.children);
	}
	return totals;
}

/** A visible waterfall row. */
export interface WaterfallRow {
	hasChildren: boolean;
	node: TraceNode;
}

/**
 * Depth-first rows for a waterfall, skipping the descendants of collapsed
 * span ids. Siblings keep their start order.
 */
export function flattenTraceTree(
	roots: readonly TraceNode[],
	collapsed: ReadonlySet<string> = new Set()
): WaterfallRow[] {
	const rows: WaterfallRow[] = [];
	const stack = [...roots].reverse();
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) {
			break;
		}
		rows.push({ node, hasChildren: node.children.length > 0 });
		if (!collapsed.has(node.span.id)) {
			stack.push(...[...node.children].reverse());
		}
	}
	return rows;
}
