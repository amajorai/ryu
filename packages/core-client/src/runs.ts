// apps/desktop/src/lib/api/runs.ts
//
// Typed client for Core's per-run observability endpoints.
//
// GET /api/runs          — list conversations that have a run_status set
// GET /api/runs/:id/trace — ordered spans for a single run (M4 / issue #178)
//
// The hierarchical reads (`?format=tree`, `GET /api/traces`) live in
// `traces.ts`; this module keeps the flat span list.
//
// Placement rationale: spans record *what ran* (tool calls, model calls) —
// a Core concern. Token counts / cost / provider-latency live in Gateway audit
// only and are NOT present here.

import { z } from "zod";
import { appResponseValueSchema } from "./app-request-json.ts";
import { type ApiTarget, request } from "./client.ts";

// ── Wire shapes (snake_case as returned by Core) ──────────────────────────────

function nativeResponse<S extends z.ZodType>(fields: S) {
	return z.custom<z.output<S>>(
		(value) =>
			appResponseValueSchema.safeParse(value).success &&
			fields.safeParse(value).success
	);
}
const spanNumberSchema = z.union([
	z.number(),
	z.literal(Number.POSITIVE_INFINITY),
	z.literal(Number.NEGATIVE_INFINITY),
]);
export const runSpanSchema = nativeResponse(
	z.object({
		args_hash: z.string().nullable().optional(),
		conversation_id: z.string(),
		ended_at: spanNumberSchema.nullable().optional(),
		error: z.string().nullable().optional(),
		id: z.string(),
		kind: z.string(),
		name: z.string(),
		seq: spanNumberSchema,
		session_id: z.string().nullable().optional(),
		started_at: spanNumberSchema,
		trace_id: z.string().nullable().optional(),
		span_id: z.string().nullable().optional(),
		parent_span_id: z.string().nullable().optional(),
		status: z.string().nullable().optional(),
		agent_id: z.string().nullable().optional(),
		attributes: z.record(z.string(), z.unknown()).nullable().optional(),
		input: z.unknown().optional(),
		output: z.unknown().optional(),
	})
);
export type RawSpan = z.output<typeof runSpanSchema>;
const runTraceResponseSchema = nativeResponse(
	z.object({ spans: z.array(runSpanSchema).optional() })
);

// ── Public shapes (camelCase) ─────────────────────────────────────────────────

/** Lifecycle state of a span (`running` while in flight). */
export type RunSpanStatus = "running" | "ok" | "error" | "cancelled";

/** A single ordered span within a run. */
export interface RunSpan {
	/** The agent the span ran under, when known. */
	agentId: string | null;
	/** SHA-256 hex of the tool-input JSON — never the raw payload. */
	argsHash: string | null;
	/** Small metadata object (counts, ids). Empty for pre-hierarchy rows. */
	attributes: Record<string, unknown>;
	/** Run this span belongs to (same as the conversation_id / run_id). */
	conversationId: string;
	/** Unix milliseconds — when the span was closed. `null` while in-flight. */
	endedAt: number | null;
	/** Error message if the span ended with a failure. */
	error: string | null;
	/** Stable span UUID. */
	id: string;
	/** Captured input; present only when the node captures trace content. */
	input?: unknown;
	/**
	 * `agent_run`, `workflow_run`, `workflow_step`, `model_call`, `tool_call`,
	 * `retrieval`, `memory`, `guardrail`, or a legacy `tool-call` / `model-call`.
	 */
	kind: string;
	/** Tool name, model id, or agent / workflow / step name. */
	name: string;
	/** Captured output; present only when the node captures trace content. */
	output?: unknown;
	/** Parent span id; `null` for a root or a pre-hierarchy row. */
	parentSpanId: string | null;
	/** Monotonically increasing within the DB — use for ordering. */
	seq: number;
	/** Nullable link to the gateway audit row (populated when #176 lands). */
	sessionId: string | null;
	/** 16-hex span id; `null` for rows written before hierarchical traces. */
	spanId: string | null;
	/** Unix milliseconds — when the span was opened. */
	startedAt: number;
	/** Lifecycle state, derived for pre-hierarchy rows. */
	status: RunSpanStatus;
	/** 32-hex trace id shared by one agent or workflow run. */
	traceId: string | null;
}

const SPAN_STATUSES: readonly RunSpanStatus[] = [
	"running",
	"ok",
	"error",
	"cancelled",
];

function normalizeStatus(raw: RawSpan): RunSpanStatus {
	const status = SPAN_STATUSES.find((value) => value === raw.status);
	if (status) {
		return status;
	}
	if (raw.ended_at === null || raw.ended_at === undefined) {
		return "running";
	}
	return raw.error ? "error" : "ok";
}

export function normalizeSpan(raw: RawSpan): RunSpan {
	return {
		seq: raw.seq,
		id: raw.id,
		conversationId: raw.conversation_id,
		kind: raw.kind,
		name: raw.name,
		argsHash: raw.args_hash ?? null,
		startedAt: raw.started_at,
		endedAt: raw.ended_at ?? null,
		error: raw.error ?? null,
		sessionId: raw.session_id ?? null,
		traceId: raw.trace_id ?? null,
		spanId: raw.span_id ?? null,
		parentSpanId: raw.parent_span_id ?? null,
		status: normalizeStatus(raw),
		agentId: raw.agent_id ?? null,
		attributes: raw.attributes ?? {},
		input: raw.input,
		output: raw.output,
	};
}

/**
 * Fetch the ordered span list for a run from Core's trace store.
 *
 * `runId` is the conversation_id used as the run key.
 * Returns an empty array when the run has no recorded spans yet — callers
 * can poll during an active run without special-casing.
 *
 * Rejects only when Core itself is unreachable.
 */
export async function fetchRunTrace(
	target: ApiTarget,
	runId: string,
	signal?: AbortSignal
): Promise<RunSpan[]> {
	const raw = await request(
		target,
		`/api/runs/${encodeURIComponent(runId)}/trace`,
		{ signal },
		runTraceResponseSchema
	);
	return (raw.spans ?? []).map(normalizeSpan);
}
