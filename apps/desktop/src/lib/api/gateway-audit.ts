import type { GatewayAuditFilters } from "@ryuhq/core-client/gateway.ts";
import { type ApiTarget, request } from "./client.ts";
import {
	rawStatusResponseSchema5,
	rawStatusResponseSchema6,
	rawStatusResponseSchema7,
} from "./gateway-audit-response-contracts.ts";
import { gatewayJsonValueSchema } from "./gateway-json-contracts.ts";
import { gatewayUsageWireSchema } from "./gateway-usage-contracts.ts";

// ── Gateway audit proxy (M4 / #177) ──────────────────────────────────────────
//
// Core proxies GET /v1/audit from the gateway, forwarding the bearer token
// server-side (the desktop never holds the master key). Core returns
// `{ reachable: false }` when the gateway is down or audit is disabled.

/**
 * A single audit log entry as returned by the gateway's `/v1/audit` endpoint
 * (via Core's proxy). The `api_key` field is always redacted to `"***"` in
 * GET responses from the gateway.
 */
export interface AuditEntry {
	/** Stable selected agent id for per-agent passport filtering. */
	agent_id: string | null;
	/** API key that made the request (always "***" in read responses). */
	api_key: string | null;
	/** Gateway backend that performed an execution or control operation. */
	backend: string | null;
	/** Prompt tokens read from the provider cache, when reported upstream. */
	cache_read_tokens?: number | null;
	/** Prompt tokens written to the provider cache, when reported upstream. */
	cache_write_tokens?: number | null;
	/** Tool/command or control action, when applicable. */
	command: string | null;
	/**
	 * Derived estimated cost for this call in micro-USD (#548). The gateway
	 * computes it from tokens at its configured rate; `null` when cost
	 * attribution is disabled (rate 0) or for non-model events.
	 */
	cost_micro_usd: number | null;
	/** Execution wall-clock duration, when applicable. */
	duration_ms: number | null;
	/** Error message, if the request failed. */
	error: string | null;
	/** Eval score for this request, if an eval was attached. */
	eval_score: number | null;
	/** Event type — "model_call" for LLM calls, "exec" for sandbox executions. */
	event_type: string | null;
	/** Product surface tag when the node could attribute the request. */
	feature: string | null;
	/** Unique request id assigned by the gateway. */
	id: string;
	/** Number of input tokens billed. */
	input_tokens: number | null;
	/** Wall-clock latency in milliseconds. */
	latency_ms: number | null;
	/** Model name as seen by the gateway. */
	model: string | null;
	/** Number of output tokens billed. */
	output_tokens: number | null;
	/** Gateway's provider prompt-cache policy result, when available. */
	prompt_cache_outcome: string | null;
	/** Provider-reported input tokens read from prompt cache; null means unreported. */
	prompt_cache_read_tokens: number | null;
	/** Provider-reported input tokens written to prompt cache; null means unreported. */
	prompt_cache_write_tokens: number | null;
	/** Provider used for the request (e.g. "openai", "anthropic"). */
	provider: string | null;
	/**
	 * Background work tag (`x-ryu-purpose`). `null` for foreground or untagged
	 * rows; absent from older Gateways that do not record it.
	 */
	purpose?: string | null;
	/** Request correlation id carried by the gateway audit row. */
	request_id: string;
	/** Core session/conversation id for per-run correlation. */
	session_id: string | null;
	/** Billing/hosting source classified by the gateway for usage analytics. */
	source?: "byok" | "local" | "managed" | "self_hosted" | "unknown";
	/** ISO-8601 timestamp when the request was processed. */
	timestamp: string;
	/** Forwarded end-user id when the node could attribute the request. */
	user_id: string | null;
	/** Forwarded display name for the end user, when available. */
	user_name: string | null;
	/** Widget instance correlation id, when the row came from a widget. */
	widget_instance_id?: string | null;
}

/** Response from GET /api/gateway/audit (Core proxy). */
export interface GatewayAuditResponse {
	/** Total entry count (may be capped by limit). */
	count: number;
	/** Audit entries, newest-first. Empty when reachable is false. */
	entries: AuditEntry[];
	/** Whether the gateway was reachable and audit is enabled. */
	reachable: boolean;
}

/**
 * Core's `GET /api/gateway/audit` body. Core omits `count` on its
 * gateway-down / audit-disabled fallback; fetchGatewayAudit defaults it.
 */
export type GatewayAuditWireResponse = Omit<GatewayAuditResponse, "count"> & {
	count?: number;
};

/** One server-owned 15-minute usage aggregate. */
export interface GatewayUsageRollupEvent {
	agentSeconds: number;
	/** Prompt tokens read from the provider cache; absent from older Gateways. */
	cacheReadTokens?: number;
	/** Prompt tokens written to the provider cache; absent from older Gateways. */
	cacheWriteTokens?: number;
	costMicroUsd: number | null;
	errorCount: number;
	feature: string | null;
	inputTokens: number;
	latencySamples: number;
	latencyTotalMs: number;
	memberId: string | null;
	model: string;
	nodeId: string | null;
	outputTokens: number;
	provider: string;
	/**
	 * Background work tag (`x-ryu-purpose`), `null` for foreground or untagged
	 * calls, and absent from older Gateways.
	 */
	purpose?: string | null;
	requestCount: number;
	source: "byok" | "local" | "managed" | "self_hosted" | "unknown";
	timestamp: string;
}

/** Validated response from Core's canonical gateway usage proxy. */
export interface GatewayUsageRollupResponse {
	bucketSeconds: 900;
	events: GatewayUsageRollupEvent[];
	kind: "rollup";
	/** Core includes this for node requests; the organization endpoint may omit it. */
	reachable?: boolean;
	/** Upstream Gateway status when Core returned a fail-soft node response. */
	status?: number;
}

/** Required range and optional dimensions for the canonical usage query. */
export interface GatewayUsageRollupFilters {
	/** Inclusive ISO timestamp lower bound. */
	from: string;
	model?: string;
	provider?: string;
	/** Exclusive ISO timestamp upper bound. */
	until: string;
}

/** Parse the canonical usage wire contract while preserving each event's identity. */
export function parseGatewayUsageRollupResponse(
	value: Parameters<typeof gatewayUsageWireSchema.parse>[0]
): GatewayUsageRollupResponse {
	const parsed = gatewayUsageWireSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("Gateway usage rollup response was malformed.");
	}
	const response: GatewayUsageRollupResponse = {
		bucketSeconds: 900,
		events: parsed.data.events,
		kind: "rollup",
	};
	if (parsed.data.reachable !== undefined) {
		response.reachable = parsed.data.reachable;
	}
	if (parsed.data.status !== undefined) {
		response.status = parsed.data.status;
	}
	return response;
}

/**
 * Fetch audit log entries via Core's proxy (`GET /api/gateway/audit`).
 *
 * Resolves to `{ reachable: false, entries: [] }` when the gateway is down or
 * audit logging is disabled on the gateway — the desktop shows the empty state
 * rather than throwing. Rejects only when Core itself is unreachable.
 */
export async function fetchGatewayAudit(
	target: ApiTarget,
	filters: GatewayAuditFilters = {},
	signal?: AbortSignal
): Promise<GatewayAuditResponse> {
	const qs = new URLSearchParams();
	if (filters.from) {
		qs.set("from", filters.from);
	}
	if (filters.provider) {
		qs.set("provider", filters.provider);
	}
	if (filters.eventType) {
		qs.set("event_type", filters.eventType);
	}
	if (filters.model) {
		qs.set("model", filters.model);
	}
	if (filters.sessionId) {
		qs.set("session_id", filters.sessionId);
	}
	if (filters.agentId) {
		qs.set("agent_id", filters.agentId);
	}
	if (filters.errorsOnly) {
		qs.set("errors_only", "true");
	}
	if (filters.limit !== undefined) {
		qs.set("limit", String(filters.limit));
	}
	if (filters.until) {
		qs.set("until", filters.until);
	}
	if (filters.widgetInstanceId) {
		qs.set("widget_instance_id", filters.widgetInstanceId);
	}
	const path = qs.size > 0 ? `/api/gateway/audit?${qs}` : "/api/gateway/audit";
	const raw = await request<GatewayAuditWireResponse>(
		target,
		path,
		{ signal },
		rawStatusResponseSchema5
	);
	return {
		reachable: raw.reachable ?? false,
		entries: raw.entries ?? [],
		count: raw.count ?? 0,
	};
}

/** Fetch the gateway's complete server-aggregated usage range via Core. */
export async function fetchGatewayUsageRollup(
	target: ApiTarget,
	filters: GatewayUsageRollupFilters,
	signal?: AbortSignal
): Promise<GatewayUsageRollupResponse> {
	const query = new URLSearchParams({
		from: filters.from,
		until: filters.until,
	});
	if (filters.provider) {
		query.set("provider", filters.provider);
	}
	if (filters.model) {
		query.set("model", filters.model);
	}
	const value = await request(
		target,
		`/api/gateway/audit/usage?${query}`,
		{ signal },
		gatewayJsonValueSchema
	);
	return parseGatewayUsageRollupResponse(value);
}

// ── Live budget spend (M2 control-layer UX) ──────────────────────────────────
//
// The gateway tracks live per-user / per-agent / per-session charged spend in
// memory; Core proxies its admin-gated `GET /v1/budget/spend` read surface so
// the desktop budget panel can render spend-vs-limit. Counters only track ids
// that have a CONFIGURED budget (the enforcer skips unbudgeted scopes and a
// session cap of 0 records nothing), so the maps are empty until a budget is
// set — the panel shows a hint in that case rather than a broken pane.

/** Configured limits echoed alongside spend so a caller can compute spend/limit. */
export interface BudgetSpendLimits {
	/** Per-agent lifetime charged micro-USD caps, keyed by agent id (0 = unlimited). */
	agents: Record<string, number>;
	/** The single global per-session charged micro-USD cap (0 = disabled). */
	session: number;
	/** Per-user lifetime charged micro-USD caps, keyed by user id (0 = unlimited). */
	users: Record<string, number>;
}

/** Response from GET /api/gateway/budget/spend (Core proxy). */
export interface BudgetSpend {
	/** Per-agent lifetime charged micro-USD spent, keyed by agent id. */
	agents: Record<string, number>;
	/** Currency for the spend and limit values. */
	currency?: "USD";
	/** Configured charged micro-USD caps for the same scopes (0 = unlimited / off). */
	limits: BudgetSpendLimits;
	/** Whether the gateway was reachable. Maps are empty when false. */
	reachable: boolean;
	/** Per-session lifetime charged micro-USD spent, keyed by Core conversation/session id. */
	sessions: Record<string, number>;
	/** Integer unit used on the wire. */
	unit?: "micro_usd";
	/** Per-user lifetime charged micro-USD spent, keyed by user id. */
	users: Record<string, number>;
}

/**
 * Core's `GET /api/gateway/budget/spend` body. Core sends `limits: {}` on its
 * gateway-down / non-2xx fallback; fetchBudgetSpend fills each member.
 */
export type BudgetSpendWireResponse = Omit<BudgetSpend, "limits"> & {
	limits?: Partial<BudgetSpendLimits>;
};

/** Optional single-id filters for fetchBudgetSpend. */
export interface BudgetSpendFilters {
	/** Narrow the agents map to a single agent id. */
	agentId?: string;
	/** Narrow the sessions map to a single session/conversation id. */
	sessionId?: string;
	/** Narrow the users map to a single user id. */
	userId?: string;
}

/**
 * Fetch live budget spend via Core's proxy (`GET /api/gateway/budget/spend`).
 *
 * Resolves to `{ reachable: false, ...empty }` when the gateway is down —
 * the desktop shows the empty state rather than throwing. Rejects only when
 * Core itself is unreachable.
 */
export async function fetchBudgetSpend(
	target: ApiTarget,
	filters: BudgetSpendFilters = {},
	signal?: AbortSignal
): Promise<BudgetSpend> {
	const qs = new URLSearchParams();
	if (filters.userId) {
		qs.set("user_id", filters.userId);
	}
	if (filters.agentId) {
		qs.set("agent_id", filters.agentId);
	}
	if (filters.sessionId) {
		qs.set("session_id", filters.sessionId);
	}
	const path =
		qs.size > 0
			? `/api/gateway/budget/spend?${qs}`
			: "/api/gateway/budget/spend";
	const raw = await request<BudgetSpendWireResponse>(
		target,
		path,
		{ signal },
		rawStatusResponseSchema6
	);
	return {
		reachable: raw.reachable ?? false,
		currency: raw.currency ?? "USD",
		unit: raw.unit ?? "micro_usd",
		users: raw.users ?? {},
		agents: raw.agents ?? {},
		sessions: raw.sessions ?? {},
		limits: {
			users: raw.limits?.users ?? {},
			agents: raw.limits?.agents ?? {},
			session: raw.limits?.session ?? 0,
		},
	};
}

/** Apply the Gateway's configured local audit retention policy. */
export async function pruneGatewayAudit(target: ApiTarget): Promise<{
	deleted_rows?: number;
	kind?: string;
	max_rows?: number | null;
	retention_days?: number | null;
}> {
	return await request(
		target,
		"/api/gateway/audit/prune",
		{ method: "POST" },
		rawStatusResponseSchema7
	);
}
