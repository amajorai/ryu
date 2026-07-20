// apps/desktop/src/lib/api/runs.ts
//
// Typed client for Core's per-run observability endpoints.
//
// GET /api/runs          — list conversations that have a run_status set
// GET /api/runs/:id/trace — ordered spans for a single run (M4 / issue #178)
//
// Placement rationale: spans record *what ran* (tool calls, model calls) —
// a Core concern. Token counts / cost / provider-latency live in Gateway audit
// only and are NOT present here.

import { type ApiTarget, request } from "./client.ts";

// ── Wire shapes (snake_case as returned by Core) ──────────────────────────────

interface RawSpan {
	args_hash: string | null;
	conversation_id: string;
	ended_at: number | null;
	error: string | null;
	id: string;
	kind: string;
	name: string;
	seq: number;
	session_id: string | null;
	started_at: number;
}

interface RawTraceResponse {
	spans?: RawSpan[];
}

// ── Public shapes (camelCase) ─────────────────────────────────────────────────

/** A single ordered span within a run. */
export interface RunSpan {
	/** SHA-256 hex of the tool-input JSON — never the raw payload. */
	argsHash: string | null;
	/** Run this span belongs to (same as the conversation_id / run_id). */
	conversationId: string;
	/** Unix milliseconds — when the span was closed. `null` while in-flight. */
	endedAt: number | null;
	/** Error message if the span ended with a failure. */
	error: string | null;
	/** Stable span UUID. */
	id: string;
	/** `"tool-call"` or `"model-call"`. */
	kind: "tool-call" | "model-call" | string;
	/** Tool name (tool-call) or model id (model-call). */
	name: string;
	/** Monotonically increasing within the DB — use for ordering. */
	seq: number;
	/** Nullable link to the gateway audit row (populated when #176 lands). */
	sessionId: string | null;
	/** Unix milliseconds — when the span was opened. */
	startedAt: number;
}

function normalizeSpan(raw: RawSpan): RunSpan {
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
	const raw = await request<RawTraceResponse>(
		target,
		`/api/runs/${encodeURIComponent(runId)}/trace`,
		{ signal }
	);
	return (raw.spans ?? []).map(normalizeSpan);
}
