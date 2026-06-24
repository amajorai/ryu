// apps/desktop/src/lib/api/gateway.ts
//
// Typed client for the Gateway observability surface, surfaced through Core's
// read-only proxy (`GET /api/gateway/status`). The proxy fetches the gateway's
// /health and /metrics and returns a combined snapshot, or a clear down state
// (`reachable: false`) when the gateway is unreachable while Core is still up.

import { type ApiTarget, request } from "./client.ts";

/** Gateway `/health` payload (status, version, providers, auth flag). */
export interface GatewayHealth {
	authRequired: boolean;
	providers: string[];
	status: string;
	version: string | null;
}

/** Request counters reported by gateway `/metrics`. */
export interface GatewayRequestMetrics {
	budgetDowngraded: number;
	budgetExceeded: number;
	budgetNotified: number;
	budgetRestricted: number;
	errors: number;
	firewallBlocked: number;
	rateLimited: number;
	total: number;
}

/** Cache counters and derived hit rate (0..1). */
export interface GatewayCacheMetrics {
	exactHits: number;
	hitRate: number;
	misses: number;
	semanticHits: number;
}

/** Token usage totals. */
export interface GatewayTokenMetrics {
	input: number;
	output: number;
}

/** Per-provider request / error counters. */
export interface GatewayProviderMetrics {
	errors: Record<string, number>;
	requests: Record<string, number>;
}

/**
 * Circuit-breaker state snapshot for a single provider.
 * `circuit` is one of `"closed"` | `"open"` | `"half_open"`.
 */
export interface ProviderCircuitState {
	/** `"closed"` (healthy), `"open"` (tripped), or `"half_open"` (probe). */
	circuit: "closed" | "open" | "half_open";
	/** Consecutive failures recorded while the circuit was Closed. */
	consecutiveFailures: number;
	/** Seconds since the circuit opened. `null` when the circuit is not Open. */
	openForSecs: number | null;
}

export interface GatewayMetrics {
	cache: GatewayCacheMetrics;
	composioCalls: number;
	/**
	 * Per-provider circuit-breaker health. Only includes providers that have
	 * been observed (at least one request attempted). Empty map when the
	 * circuit breaker has not yet seen any traffic.
	 */
	providerHealth: Record<string, ProviderCircuitState>;
	providers: GatewayProviderMetrics;
	requests: GatewayRequestMetrics;
	tokens: GatewayTokenMetrics;
}

export interface GatewayStatus {
	/** Health snapshot, present only when reachable. */
	health: GatewayHealth | null;
	/** Metrics snapshot, present when reachable and /metrics responded. */
	metrics: GatewayMetrics | null;
	/** Whether Core could reach a healthy gateway. */
	reachable: boolean;
	/** The gateway base URL Core proxied to. */
	url: string | null;
}

// ── Raw wire shapes (snake_case, as returned by gateway + Core proxy) ──────────

interface RawHealth {
	auth_required?: boolean;
	providers?: string[];
	status?: string;
	version?: string | null;
}

interface RawProviderCircuitState {
	circuit?: string;
	consecutive_failures?: number;
	open_for_secs?: number | null;
}

interface RawMetrics {
	cache?: {
		exact_hits?: number;
		semantic_hits?: number;
		misses?: number;
		hit_rate?: number;
	};
	composio?: { calls?: number };
	provider_health?: Record<string, RawProviderCircuitState>;
	providers?: {
		requests?: Record<string, number>;
		errors?: Record<string, number>;
	};
	requests?: {
		total?: number;
		errors?: number;
		rate_limited?: number;
		firewall_blocked?: number;
		budget_exceeded?: number;
		budget_notified?: number;
		budget_downgraded?: number;
		budget_restricted?: number;
	};
	tokens?: { input?: number; output?: number };
}

interface RawStatus {
	health?: RawHealth | null;
	metrics?: RawMetrics | null;
	reachable?: boolean;
	url?: string | null;
}

function normalizeHealth(
	raw: RawHealth | null | undefined
): GatewayHealth | null {
	if (!raw) {
		return null;
	}
	return {
		status: raw.status ?? "unknown",
		version: raw.version ?? null,
		providers: raw.providers ?? [],
		authRequired: raw.auth_required ?? false,
	};
}

function normalizeMetrics(
	raw: RawMetrics | null | undefined
): GatewayMetrics | null {
	if (!raw) {
		return null;
	}
	const req = raw.requests ?? {};
	const cache = raw.cache ?? {};
	const tokens = raw.tokens ?? {};
	const providers = raw.providers ?? {};
	return {
		requests: {
			total: req.total ?? 0,
			errors: req.errors ?? 0,
			rateLimited: req.rate_limited ?? 0,
			firewallBlocked: req.firewall_blocked ?? 0,
			budgetExceeded: req.budget_exceeded ?? 0,
			budgetNotified: req.budget_notified ?? 0,
			budgetDowngraded: req.budget_downgraded ?? 0,
			budgetRestricted: req.budget_restricted ?? 0,
		},
		cache: {
			exactHits: cache.exact_hits ?? 0,
			semanticHits: cache.semantic_hits ?? 0,
			misses: cache.misses ?? 0,
			hitRate: cache.hit_rate ?? 0,
		},
		tokens: {
			input: tokens.input ?? 0,
			output: tokens.output ?? 0,
		},
		composioCalls: raw.composio?.calls ?? 0,
		providers: {
			requests: providers.requests ?? {},
			errors: providers.errors ?? {},
		},
		providerHealth: normalizeProviderHealth(raw.provider_health),
	};
}

function normalizeCircuit(
	raw: string | undefined
): "closed" | "open" | "half_open" {
	if (raw === "open" || raw === "half_open") {
		return raw;
	}
	return "closed";
}

function normalizeProviderHealth(
	raw: Record<string, RawProviderCircuitState> | undefined
): Record<string, ProviderCircuitState> {
	if (!raw) {
		return {};
	}
	const result: Record<string, ProviderCircuitState> = {};
	for (const [name, state] of Object.entries(raw)) {
		result[name] = {
			circuit: normalizeCircuit(state.circuit),
			consecutiveFailures: state.consecutive_failures ?? 0,
			openForSecs: state.open_for_secs ?? null,
		};
	}
	return result;
}

/**
 * Fetch combined Gateway status via Core's proxy (`/api/gateway/status`).
 *
 * Resolves to `{ reachable: false }` when the gateway is down but Core is up;
 * rejects only when Core itself is unreachable (so the status spine can tell the
 * two apart).
 */
export async function fetchGatewayStatus(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayStatus> {
	const json = await request<RawStatus>(target, "/api/gateway/status", {
		signal,
	});
	return {
		reachable: json.reachable ?? false,
		url: json.url ?? null,
		health: normalizeHealth(json.health),
		metrics: normalizeMetrics(json.metrics),
	};
}

// ── Gateway config helpers (Unit U017) ───────────────────────────────────────
//
// These call Core's /api/gateway/config proxy, which forwards the bearer token
// to the gateway server-side. The desktop never holds the master key.

/** Provider view returned by the gateway's redacted GET /v1/config. */
export interface GatewayProviderView {
	api_key: string;
	base_url: string;
}

/** Local provider view (no api_key). */
export interface GatewayLocalProviderView {
	base_url: string;
}

/** Core provider view (url + whether a token is set). */
export interface GatewayCoreProviderView {
	base_url: string;
	has_token: boolean;
}

/** Redacted provider config from GET /v1/config. */
export interface GatewayProvidersConfig {
	anthropic: GatewayProviderView | null;
	core: GatewayCoreProviderView | null;
	local: GatewayLocalProviderView | null;
	openai: GatewayProviderView | null;
	openrouter: GatewayProviderView | null;
}

/**
 * The five provider kinds the gateway supports.
 * Values are lowercase strings matching the gateway's serde(rename_all = "lowercase").
 */
export type ProviderKind =
	| "openai"
	| "anthropic"
	| "local"
	| "openrouter"
	| "core";

/** A single model-to-provider mapping entry. */
export interface ModelMapping {
	provider: ProviderKind;
	/** If set, rewrite the model name before forwarding to the provider. */
	provider_model?: string | null;
}

/** A single smart-routing rule: a plain-language condition + target model. */
export interface SmartRule {
	/** Natural-language condition, e.g. "writing or refactoring code". */
	description: string;
	/** Model to route matching requests to (resolved via the router). */
	model: string;
}

/**
 * Classifier-driven model routing ("custom routing instructions"). When enabled,
 * a cheap `classifier_model` reads each request's latest message, picks the
 * best-matching rule, and the request is re-routed to that rule's target model
 * before the normal model→provider routing runs. Fails open: any error keeps the
 * originally requested model. Takes effect after the gateway restarts.
 */
export interface SmartRoutingConfig {
	/** Master switch. Off by default (the classifier adds a per-request call). */
	enabled: boolean;
	/** The cheap model used to classify each request (any routable model id). */
	classifier_model: string;
	/** Ordered natural-language rules. */
	rules: SmartRule[];
	/** Model used when no rule matches. null/empty ⇒ keep the requested model. */
	default_model?: string | null;
	/** Classify once per conversation and reuse the decision. Default true. */
	cache_by_session: boolean;
	/** Per-classification timeout in ms. Default 4000. */
	timeout_ms: number;
}

/**
 * Ryu's user-level routing config. This layer runs BEFORE any upstream
 * provider's own routing (e.g. OpenRouter's openrouter/auto) and determines
 * which provider a request is sent to based on the requested model name.
 */
export interface GatewayRoutingConfig {
	/** Provider to use when no model-map entry matches. */
	default_provider: ProviderKind;
	/** Ordered fallback chain used when the primary provider is unavailable. */
	fallback_chain: ProviderKind[];
	/** Static model-to-provider mappings (exact or prefix match). */
	model_map: Record<string, ModelMapping>;
	/** Classifier-driven routing (custom routing instructions). Optional. */
	smart_routing?: SmartRoutingConfig;
}

/** The three policy values the gateway firewall accepts (snake_case wire form). */
export type GatewayFirewallPolicy = "block" | "warn_and_continue" | "sanitize";

/** Firewall config shape (mirrors gateway FirewallConfig exactly). */
export interface GatewayFirewallConfig {
	enabled: boolean;
	log_detections: boolean;
	policy: GatewayFirewallPolicy;
	/** Redact PII patterns (email, phone, SSN, etc.) when policy = sanitize. */
	redact_pii: boolean;
	/** Redact secret patterns (API keys, tokens, PEM keys) when policy = sanitize. */
	redact_secrets: boolean;
	scan_inbound: boolean;
	scan_outbound: boolean;
}

/**
 * What the gateway does when a budget is exhausted.
 * Values are lowercase strings matching the gateway's serde(rename_all = "lowercase").
 */
export type BudgetAction = "notify" | "downgrade" | "restrict" | "stop";

/**
 * A single per-agent or per-user budget rule.
 * Field names are snake_case — the gateway config API passes these through
 * without camelCase normalization (unlike the status proxy).
 */
export interface BudgetRule {
	/** Action taken once limit is reached. */
	action: BudgetAction;
	/** Model to route to when action = downgrade. */
	downgrade_to?: string | null;
	/** Lifetime token cap (input + output combined). 0 = unlimited. */
	limit: number;
	/** Max tokens cap when action = restrict. Defaults to 256 on the gateway. */
	restrict_max_tokens?: number;
}

/**
 * Per-user and per-agent token budgets (mirrors gateway BudgetConfig).
 * Keys are user/agent ids; values are budget rules.
 */
export interface GatewayBudgetConfig {
	agents: Record<string, BudgetRule>;
	users: Record<string, BudgetRule>;
}

/** Full redacted config returned by GET /v1/config (via Core proxy). */
export interface GatewayConfig {
	auth: GatewayAuthConfig;
	budgets: GatewayBudgetConfig;
	firewall: GatewayFirewallConfig;
	providers: GatewayProvidersConfig;
	routing: GatewayRoutingConfig;
}

/**
 * A single gateway API key entry (as returned by GET /v1/config).
 * The `key` field is always `"***"` in GET responses; the real value is only
 * visible at creation time (returned by the generate helper, never by GET).
 */
export interface GatewayApiKey {
	/** Always `"***"` in GET responses. */
	key: string;
	/** Human-readable label, e.g. "OpenClaw BYOA". */
	name: string;
	org_id?: string | null;
	team_id?: string | null;
	/** When true, the gateway honors `x-ryu-agent-id` for per-agent budgets. */
	trusted_forwarder: boolean;
}

/** The auth section of the gateway config (read-only view). */
export interface GatewayAuthConfig {
	api_keys: GatewayApiKey[];
	require_auth: boolean;
}

/** Partial update body accepted by PUT /v1/config (firewall/budgets/auth/routing are writable). */
export interface GatewayConfigPatch {
	/** When present, replaces the api_keys list. Must include ALL keys to keep. */
	auth?: { api_keys: GatewayApiKey[] };
	budgets?: GatewayBudgetConfig;
	firewall?: GatewayFirewallConfig;
	/**
	 * Ryu's user-level routing config (persisted; takes effect after gateway restart).
	 * Runs before any upstream provider routing — this is the moat layer.
	 */
	routing?: GatewayRoutingConfig;
}

export const DEFAULT_SMART_ROUTING: SmartRoutingConfig = {
	enabled: false,
	classifier_model: "",
	rules: [],
	default_model: null,
	cache_by_session: true,
	timeout_ms: 4000,
};

const DEFAULT_ROUTING: GatewayRoutingConfig = {
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
	smart_routing: DEFAULT_SMART_ROUTING,
};

/**
 * Fetch the gateway's current config (redacted) via Core's proxy
 * (`/api/gateway/config`). Provider API keys are replaced with `"***"`.
 *
 * Rejects on Core-unreachable or gateway-down (502 relayed from Core).
 */
export async function fetchGatewayConfig(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayConfig> {
	const raw = await request<GatewayConfig>(target, "/api/gateway/config", {
		signal,
	});
	const routing = raw.routing ?? DEFAULT_ROUTING;
	return {
		...raw,
		routing: {
			...routing,
			smart_routing: routing.smart_routing ?? DEFAULT_SMART_ROUTING,
		},
	};
}

/**
 * Apply a partial config change to the gateway via Core's proxy
 * (`PUT /api/gateway/config`). Only `firewall` and `budgets` are writable;
 * provider keys must be changed via environment variables.
 *
 * Rejects on Core-unreachable or a non-2xx relay from the gateway.
 */
export async function updateGatewayConfig(
	target: ApiTarget,
	patch: GatewayConfigPatch,
	signal?: AbortSignal
): Promise<{ ok: boolean }> {
	return request<{ ok: boolean }>(target, "/api/gateway/config", {
		method: "PUT",
		body: patch,
		signal,
	});
}

// ── BYOK provider-key vault helpers (Unit U026) ──────────────────────────────
//
// These call Core's `PUT /api/gateway/providers`, which writes the key to
// gateway.toml and restarts the gateway so the change takes effect immediately.
// The key value travels over the loopback interface only (desktop → Core); it
// is not stored in renderer state after the save completes.

export type ByokProvider = "openai" | "anthropic" | "openrouter";

/** Set (or overwrite) a provider API key in the gateway config. */
export async function setGatewayProvider(
	target: ApiTarget,
	provider: ByokProvider,
	apiKey: string,
	signal?: AbortSignal
): Promise<{ success: boolean; gateway_restarted: boolean }> {
	return request<{ success: boolean; gateway_restarted: boolean }>(
		target,
		"/api/gateway/providers",
		{ method: "PUT", body: { provider, api_key: apiKey }, signal }
	);
}

/** Remove a provider key from the gateway config. */
export async function clearGatewayProvider(
	target: ApiTarget,
	provider: ByokProvider,
	signal?: AbortSignal
): Promise<{ success: boolean; gateway_restarted: boolean }> {
	return request<{ success: boolean; gateway_restarted: boolean }>(
		target,
		"/api/gateway/providers",
		{ method: "PUT", body: { provider, api_key: null }, signal }
	);
}

// ── BYOA key management (U027) ────────────────────────────────────────────────
//
// BYOA = "bring your own agent". An existing OpenAI-compatible agent (OpenClaw,
// Hermes, any framework) is pointed at the Ryu gateway as its OpenAI base URL.
// It authenticates using an API key generated here, with `trusted_forwarder: true`
// so the gateway honours the `x-ryu-agent-id` header for per-agent budgets.
//
// Interpretation: the EXTERNAL AGENT points TO the gateway (it becomes a gateway
// client). This is NOT about Core routing OUT to dynamic per-agent upstreams —
// that is a separate, deferred spike.
//
// The 'migrate to the lean Ryu agent' flow (replacing the external agent with
// Pi or a native Ryu agent) is also distinct from BYOA and tracked separately.

/**
 * Generate a cryptographically random gateway API key value.
 * The key is a 32-byte hex string (256 bits of entropy), prefixed with `sk-ryu-`
 * so it is visually distinct from other API keys.
 */
export function generateGatewayKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		""
	);
	return `sk-ryu-${hex}`;
}

/**
 * Register a new BYOA gateway key by merging it into the existing `api_keys`
 * list. Fetches the current config, appends (or replaces by name) the new entry,
 * and persists via `PUT /api/gateway/config`.
 *
 * The returned `key` is the plaintext value — save it before returning to the
 * user; GET /v1/config always redacts it to `"***"`.
 */
export async function registerByoaKey(
	target: ApiTarget,
	entry: GatewayApiKey
): Promise<{ ok: boolean }> {
	const cfg = await fetchGatewayConfig(target);
	const existingKeys = cfg.auth?.api_keys ?? [];
	const filtered = existingKeys.filter((k) => k.name !== entry.name);
	const next = [...filtered, entry];
	return updateGatewayConfig(target, { auth: { api_keys: next } });
}

/**
 * Remove a BYOA gateway key by name.
 */
export async function removeByoaKey(
	target: ApiTarget,
	name: string
): Promise<{ ok: boolean }> {
	const cfg = await fetchGatewayConfig(target);
	const next = (cfg.auth?.api_keys ?? []).filter((k) => k.name !== name);
	return updateGatewayConfig(target, { auth: { api_keys: next } });
}

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
	/** API key that made the request (always "***" in read responses). */
	api_key: string | null;
	/** Error message, if the request failed. */
	error: string | null;
	/** Eval score for this request, if an eval was attached. */
	eval_score: number | null;
	/** Event type — "model_call" for LLM calls, "exec" for sandbox executions. */
	event_type: string | null;
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
	/** Provider used for the request (e.g. "openai", "anthropic"). */
	provider: string | null;
	/** Core session/conversation id for per-run correlation. */
	session_id: string | null;
	/** ISO-8601 timestamp when the request was processed. */
	timestamp: string;
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

/** Filters accepted by fetchGatewayAudit. */
export interface GatewayAuditFilters {
	/** Return only entries that have an error. */
	errorsOnly?: boolean;
	/** Maximum number of entries to return (gateway default: 100). */
	limit?: number;
	/** Filter by Core session/conversation id. */
	sessionId?: string;
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
	if (filters.sessionId) {
		qs.set("session_id", filters.sessionId);
	}
	if (filters.errorsOnly) {
		qs.set("errors_only", "true");
	}
	if (filters.limit !== undefined) {
		qs.set("limit", String(filters.limit));
	}
	const path = qs.size > 0 ? `/api/gateway/audit?${qs}` : "/api/gateway/audit";
	const raw = await request<GatewayAuditResponse>(target, path, { signal });
	return {
		reachable: raw.reachable ?? false,
		entries: raw.entries ?? [],
		count: raw.count ?? 0,
	};
}

// ── Eval dataset runner (M4 / #180) ──────────────────────────────────────────
//
// Scorers: latency / token_efficiency / policy_pass / optional substring_match,
// plus promptfoo-style per-case assertions (deterministic + llm_judge),
// run-level system prompts, {{var}} substitution, and multi-model compare.

/** One assertion to evaluate against a case's response (internally tagged on kind). */
export type Assertion =
	| { kind: "contains"; value: string }
	| { kind: "not_contains"; value: string }
	| { kind: "equals"; value: string }
	| { kind: "regex"; value: string }
	| { kind: "json_valid" }
	| { kind: "llm_judge"; rubric: string };

/** Result of evaluating one assertion against a response. */
export interface AssertionResult {
	/** Human-readable explanation (matched text, regex error, judge verdict, …). */
	detail: string;
	/** The assertion kind as the snake_case wire tag ("contains", "llm_judge", …). */
	kind: string;
	/** Whether this assertion passed. */
	pass: boolean;
	/** Confidence/quality in [0,1]. Deterministic kinds emit 1.0/0.0. */
	score: number;
}

/** A single case in an eval dataset. */
export interface EvalDatasetCase {
	/** Assertions to evaluate against this case's response. */
	assertions?: Assertion[];
	/**
	 * Optional expected substring. When present the gateway applies a
	 * case-insensitive contains check and adds a substring_match score.
	 * When absent the scorer is omitted — no penalty for a missing expected.
	 */
	expected?: string | null;
	/** The prompt to replay through the gateway pipeline. May contain {{vars}}. */
	prompt: string;
	/** Per-case {{var}} substitutions (prompt, system prompt, assertions). */
	vars?: Record<string, string>;
}

/** Per-case scores returned by the gateway eval runner. */
export interface EvalCaseScore {
	/** NEW: per-assertion results (always present; [] when no assertions). */
	assertions: AssertionResult[];
	/** NEW: true iff every assertion passed (vacuously true for []). */
	assertions_pass: boolean;
	/** 1.0 = instant, 0.0 = at/beyond max_latency_ms. */
	latency_score: number;
	/** Weighted aggregate for this case. Range [0, 1]. */
	overall: number;
	/** Whether the request passed all firewall/policy checks. */
	policy_pass: boolean;
	prompt: string;
	/** The response text the provider returned (or an error message). */
	response_text: string;
	/** Present only when the case had an expected value. */
	substring_match: number | null;
	/** Ratio output/input tokens clamped to [0,1]. */
	token_efficiency: number;
}

/** Aggregate summary across all eval cases. */
export interface EvalRunAggregate {
	mean_latency: number;
	/** Mean overall score across all cases. Range [0, 1]. */
	mean_overall: number;
	/** Mean substring match across cases that had an expected value. null when none did. */
	mean_substring_match: number | null;
	mean_token_efficiency: number;
	/** Fraction of cases where policy_pass was true. Range [0, 1]. */
	policy_pass_rate: number;
	total_cases: number;
}

/** One model's full result block in a multi-model run. */
export interface ModelEvalResult {
	aggregate: EvalRunAggregate;
	cases: EvalCaseScore[];
	model: string;
}

/** Response from POST /api/gateway/evals/run (via Core proxy). */
export interface EvalRunResult {
	/** Always the FIRST evaluated model's aggregate (back-compat). */
	aggregate: EvalRunAggregate;
	/** Always the FIRST evaluated model's cases (back-compat). */
	cases: EvalCaseScore[];
	/** Present ONLY on the multi-model path; absent on single-model. */
	models?: ModelEvalResult[];
}

/** Request body for POST /api/gateway/evals/run. */
export interface RunEvalsRequest {
	/** Optional agent id for per-agent budget tracking. */
	agent_id?: string | null;
	/**
	 * Dataset to replay. When empty or absent the gateway uses its built-in
	 * 3-case dataset so the panel works on first run without any configuration.
	 */
	dataset?: EvalDatasetCase[];
	/**
	 * Optional judge model override; a single fixed judge across all models.
	 * When unset, the server defaults to the first model in `models`.
	 */
	judge_model?: string;
	/**
	 * Model to evaluate. Flows through the gateway router — no provider is
	 * hardcoded; the gateway config determines which provider is used.
	 */
	model?: string;
	/**
	 * Multi-model compare. When set, the whole dataset runs against each model
	 * and the response gains a per-model `models` breakdown.
	 */
	models?: string[];
	/**
	 * Run-level system prompt; the server prepends it as a system message per
	 * case and substitutes any {{vars}} using that case's `vars`.
	 */
	system_prompt?: string;
}

/**
 * Run a dataset eval against the gateway via Core's proxy
 * (POST /api/gateway/evals/run).
 *
 * Each prompt is replayed through the full gateway pipeline (firewall, routing,
 * provider call). Returns per-case scores and an aggregate summary.
 *
 * Rejects when Core is unreachable; returns a structured error when the gateway
 * is down (Core relays a 502).
 */
export async function runGatewayEvals(
	target: ApiTarget,
	req: RunEvalsRequest = {},
	signal?: AbortSignal
): Promise<EvalRunResult> {
	return await request<EvalRunResult>(target, "/api/gateway/evals/run", {
		method: "POST",
		body: req,
		signal,
	});
}
