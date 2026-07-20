// apps/desktop/src/lib/api/gateway.ts
//
// Typed client for the Gateway observability surface, surfaced through Core's
// read-only proxy (`GET /api/gateway/status`). The proxy fetches the gateway's
// /health and /metrics and returns a combined snapshot, or a clear down state
// (`reachable: false`) when the gateway is unreachable while Core is still up.

import { type ApiTarget, request } from "./client.ts";
import { restartGateway } from "./system.ts";

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

/**
 * Live upstream quota / rate-limit snapshot for one provider, as folded into
 * `/metrics` under `provider_quota` by the gateway. Every field may be `null`
 * (never observed / not reported by the upstream). `resetInSecs` is a live
 * countdown computed server-side at snapshot time — tick it down client-side
 * between polls for a smooth display.
 */
export interface ProviderQuota {
	/** Window ceiling, or null if the upstream did not report one. */
	limit: number | null;
	/** Whether the provider is currently rate limited. */
	rateLimited: boolean;
	/** Remaining requests/tokens in the current window, or null if unknown. */
	remaining: number | null;
	/** Unix seconds when the window resets, or null. */
	resetAt: number | null;
	/** Seconds until reset at snapshot time, or null. Tick down client-side. */
	resetInSecs: number | null;
	/** `Retry-After` seconds from the last 429, or null. */
	retryAfter: number | null;
	/** Unix seconds when this snapshot was last updated, or null. */
	updatedAt: number | null;
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
	/**
	 * Per-provider upstream quota / rate-limit countdowns. Only includes
	 * providers whose quota headers have been observed at least once; absent
	 * providers have never been seen. Empty map when nothing observed yet.
	 */
	providerQuota: Record<string, ProviderQuota>;
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

interface RawProviderQuota {
	limit?: number | null;
	rate_limited?: boolean | null;
	remaining?: number | null;
	reset_at?: number | null;
	reset_in_secs?: number | null;
	retry_after?: number | null;
	updated_at?: number | null;
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
	provider_quota?: Record<string, RawProviderQuota>;
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
		providerQuota: normalizeProviderQuota(raw.provider_quota),
	};
}

function normalizeProviderQuota(
	raw: Record<string, RawProviderQuota> | undefined
): Record<string, ProviderQuota> {
	if (!raw) {
		return {};
	}
	const result: Record<string, ProviderQuota> = {};
	for (const [name, q] of Object.entries(raw)) {
		result[name] = {
			remaining: q.remaining ?? null,
			limit: q.limit ?? null,
			resetAt: q.reset_at ?? null,
			resetInSecs: q.reset_in_secs ?? null,
			retryAfter: q.retry_after ?? null,
			rateLimited: q.rate_limited ?? false,
			updatedAt: q.updated_at ?? null,
		};
	}
	return result;
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
	/**
	 * Number of extra account keys configured for round-robin rotation (the keys
	 * themselves stay redacted). Set via the provider's `*_API_KEYS` env var, not
	 * via PUT — provider credentials are environment-variable-only by design.
	 * Older gateways omit the field (treat `undefined` as 0).
	 */
	api_key_count?: number;
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

/**
 * Redacted view of the genai multi-provider backend. Lists only the adapter
 * kinds that have a configured key (e.g. "gemini"); key values are never sent.
 */
export interface GatewayGenAiProviderView {
	keys: string[];
}

/** Redacted provider config from GET /v1/config. */
export interface GatewayProvidersConfig {
	anthropic: GatewayProviderView | null;
	core: GatewayCoreProviderView | null;
	genai: GatewayGenAiProviderView | null;
	local: GatewayLocalProviderView | null;
	openai: GatewayProviderView | null;
	openrouter: GatewayProviderView | null;
}

/**
 * The provider kinds the gateway supports.
 * Values are lowercase strings matching the gateway's serde(rename_all = "lowercase").
 * `genai` is the multi-provider backend that serves native-format providers
 * (currently Gemini) that aren't covered by the OpenAI-compatible passthroughs.
 */
export type ProviderKind =
	| "openai"
	| "anthropic"
	| "local"
	| "openrouter"
	| "core"
	| "genai";

/** A single model-to-provider mapping entry. */
export interface ModelMapping {
	provider: ProviderKind;
	/** If set, rewrite the model name before forwarding to the provider. */
	provider_model?: string | null;
}

/**
 * How the matching rule is chosen for a smart-routing decision. Shared vocabulary
 * across both routing planes (model routing here, agent routing in Core):
 * - `llm`: a cheap classifier model reads the message and picks a rule.
 * - `embedding`: embed rule descriptions + the query, cosine-nearest above a threshold.
 * - `keyword`: case-insensitive significant-word match; zero cost, zero network.
 */
export type RouteStrategy = "llm" | "embedding" | "keyword";

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
	/** Classify once per conversation and reuse the decision. Default true. */
	cache_by_session: boolean;
	/** The cheap model used to classify each request (any routable model id). */
	classifier_model: string;
	/** Model used when no rule matches. null/empty ⇒ keep the requested model. */
	default_model?: string | null;
	/** Embedder for the `embedding` strategy. Empty ⇒ default local embedder. */
	embedding_model: string;
	/** Master switch. Off by default (the classifier adds a per-request call). */
	enabled: boolean;
	/** Ordered natural-language rules. */
	rules: SmartRule[];
	/** Min cosine for the `embedding` strategy to accept a rule. Default 0.35. */
	similarity_threshold: number;
	/** How the matching rule is chosen. Default `llm`. */
	strategy: RouteStrategy;
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
	/**
	 * Per-provider cost tier used to order the fallback chain: 0 = subscription,
	 * 1 = cheap, 2 = free. Keyed by provider kind. Absent providers default to
	 * tier 0. Optional on the wire — gateways that don't surface it omit the
	 * field (treat `undefined` as `{}`).
	 */
	provider_tiers?: Record<string, number>;
	/** Classifier-driven routing (custom routing instructions). Optional. */
	smart_routing?: SmartRoutingConfig;
}

/** The three policy values the gateway firewall accepts (snake_case wire form). */
export type GatewayFirewallPolicy = "block" | "warn_and_continue" | "sanitize";

/**
 * Which built-in category a custom firewall pattern is merged into. Mirrors the
 * gateway's `CustomPatternKind` (snake_case wire form). `pii`/`secret` follow
 * the redact toggles under the Sanitize policy; `prompt_injection` participates
 * in inbound injection scanning.
 */
export type CustomPatternKind = "pii" | "secret" | "prompt_injection";

/** A single user-defined firewall pattern (mirrors gateway `CustomPattern`). */
export interface CustomPattern {
	/** Which built-in category this pattern is merged into. */
	kind: CustomPatternKind;
	/** Label; also the redaction marker (`internal_id` → `[REDACTED:INTERNAL_ID]`). */
	name: string;
	/** Regex in the Rust `regex` crate's syntax (backtracking-free, ReDoS-safe). */
	regex: string;
}

/** What the LLM inspector scans for (mirrors gateway `InspectorMode`). */
export type InspectorMode = "injection" | "dlp" | "both";

/**
 * The swappable cheap-LLM traffic inspector (mirrors gateway `InspectorConfig`).
 * A detection *method* orthogonal to `policy` (the *action*). Opt-in and
 * fail-open. `model` is a plain id resolved through the gateway router, so it
 * stays swappable — empty string means "use the gateway's default model".
 */
export interface InspectorConfig {
	/** Action taken when the inspector flags a turn (reuses the firewall policy). */
	action: GatewayFirewallPolicy;
	/** Master switch. Off by default (adds a per-turn model round-trip). */
	enabled: boolean;
	/** Skip inspection for turns shorter than this many characters. */
	min_chars: number;
	/** What the inspector looks for. */
	mode: InspectorMode;
	/** Model id used for inspection. Empty ⇒ the gateway's default model. */
	model: string;
	/** Per-inspection timeout in milliseconds; on timeout the request is allowed. */
	timeout_ms: number;
}

/** Default (disabled) inspector config used when the gateway omits one. */
export const DEFAULT_INSPECTOR: InspectorConfig = {
	enabled: false,
	model: "",
	mode: "both",
	min_chars: 40,
	timeout_ms: 1500,
	action: "warn_and_continue",
};

/**
 * The canonical serde field names a scope may freeze via `locked_fields`. A
 * locked field cannot be loosened by a narrower scope (node → org → agent); the
 * resolver keeps the stricter value. Mirrors the gateway's canonical list.
 */
export type LockableFirewallField =
	| "enabled"
	| "scan_inbound"
	| "scan_outbound"
	| "policy"
	| "log_detections"
	| "redact_pii"
	| "redact_secrets"
	| "wrap_untrusted_tool_results"
	| "inspector";

// ── Unified evaluator taxonomy (one catalog: inline guardrails + offline evals) ─
//
// Mirrors the gateway `evaluators` module wire shapes. IMPORTANT casing: the
// evaluator FAMILY serializes camelCase (`inlineAction`, `judgeModel`,
// `higherIsBetter`, `impl`, `meanScore`, …); the CONTAINERS they ride
// (`custom_evaluators`, `firewall.evaluators`, and the eval `CaseScore` body)
// stay snake_case, matching the surrounding firewall/evals types.

/** Catalog section (matches the product screenshot's tabs; snake_case wire). */
export type EvaluatorCategory =
	| "security"
	| "safety"
	| "quality"
	| "conversation"
	| "trajectory"
	| "image"
	| "voice"
	| "custom";

/** What an evaluator judges (snake_case wire). */
export type EvaluatorTarget =
	| "input"
	| "output"
	| "conversation"
	| "trajectory"
	| "image"
	| "audio";

/** Language for a Code evaluator (snake_case wire). */
export type EvaluatorCodeLang = "js" | "python";

/** First-class gate: which surfaces may offer this evaluator. */
export interface EvaluatorCapabilities {
	/** May run inline as a request/response guardrail. */
	inline: boolean;
	/** May run offline over a dataset case. */
	offline: boolean;
}

/**
 * How an evaluator computes its judgment (discriminated on the snake_case
 * `kind`, mirroring the gateway `EvaluatorImpl` internally-tagged enum).
 */
export type EvaluatorImpl =
	| { kind: "regex"; patterns: string[] }
	| { kind: "heuristic" }
	| { kind: "llm_judge"; rubric: string }
	| { kind: "code"; lang: EvaluatorCodeLang; source: string }
	| { kind: "builtin"; detector: string };

/** Inline-guardrail config carried on a catalog entry (camelCase wire). */
export interface EvaluatorInlineConfig {
	/** `block | warn_and_continue | sanitize`. */
	action: GatewayFirewallPolicy;
}

/** Offline-eval config: pass threshold + optional judge model override. */
export interface EvaluatorOfflineConfig {
	/** Judge model override; omit/null routes through the default router. */
	judgeModel?: string | null;
	/** Score in [0,1] at/above which the case passes. */
	threshold: number;
}

/**
 * A single evaluator: one entry in the shared catalog (mirrors gateway
 * `Evaluator`, camelCase). `enforced` is the honesty flag — `true` only when the
 * detector is wired to real inline execution; a `false` entry can be catalogued
 * (and enabled) but does nothing yet, and the UI must say so.
 */
export interface Evaluator {
	/** `true` for shipped seed entries; `false` for user-created ("from scratch"). */
	builtin: boolean;
	capabilities: EvaluatorCapabilities;
	category: EvaluatorCategory;
	description: string;
	/** Honesty flag: `true` once wired to real execution. */
	enforced: boolean;
	/** Score polarity: `true` ⇒ higher is better (quality); `false` ⇒ higher is worse. */
	higherIsBetter: boolean;
	id: string;
	/** Serialized under the reserved key `impl`. */
	impl: EvaluatorImpl;
	inline?: EvaluatorInlineConfig | null;
	name: string;
	offline?: EvaluatorOfflineConfig | null;
	target: EvaluatorTarget;
}

/**
 * A per-scope override for one catalog evaluator, cascaded node → org → agent by
 * the firewall resolver with the same union + lock semantics as the firewall
 * dials (mirrors gateway `EvaluatorBinding`, camelCase). Rides
 * `firewall.evaluators` / the overlay `evaluators` list.
 */
export interface EvaluatorBinding {
	/** Whether this evaluator is enabled at this scope. */
	enabled: boolean;
	/** Stable id of the catalog evaluator this binding configures. */
	id: string;
	/** Inline-guardrail action when enabled inline; omit if not offered inline. */
	inlineAction?: GatewayFirewallPolicy | null;
	/** Freeze so a narrower scope can only tighten it, never loosen. */
	locked?: boolean;
	/** Offline-eval config (threshold + judge model) when enabled offline. */
	offline?: EvaluatorOfflineConfig | null;
}

/**
 * Result of scoring one registry evaluator against a single case's response
 * (mirrors gateway `EvaluatorScore`, camelCase-wrapped inside the snake_case
 * `CaseScore.evaluators` list).
 */
export interface EvaluatorScore {
	/** The evaluator's category (snake_case), e.g. "security", "quality". */
	category: string;
	/** Human-readable explanation (match text, judge verdict, or skip reason). */
	detail: string;
	/** Honesty flag: `true` only when a real score was computed. */
	executed: boolean;
	/** Stable id of the catalog evaluator that produced this score. */
	id: string;
	/** Whether this case passed the evaluator. */
	pass: boolean;
	/** Score in [0,1]. Higher = better for quality; 1.0 = clean for safety regex. */
	score: number;
}

/** Per-evaluator aggregate across all cases in a run (mirrors gateway `EvaluatorAggregate`). */
export interface EvaluatorAggregate {
	/** Number of cases where the evaluator actually executed. */
	executedCount: number;
	/** Mean `score` over cases where the evaluator executed. */
	meanScore: number;
	/** Fraction of executed cases that passed. */
	passRate: number;
}

/**
 * Fetch the full evaluator catalog via Core's proxy
 * (`GET /api/gateway/evaluators`) — the built-in seed table merged with any
 * user-authored custom evaluators (custom entries report `builtin: false`).
 * This is BOTH the catalog source and the read side for the custom set
 * (filter `builtin === false`); the redacted `/v1/config` does not carry it.
 */
export async function fetchEvaluators(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Evaluator[]> {
	const raw = await request<{ evaluators?: Evaluator[] }>(
		target,
		"/api/gateway/evaluators",
		{ signal }
	);
	return raw.evaluators ?? [];
}

/** Firewall config shape (mirrors gateway FirewallConfig exactly). */
export interface GatewayFirewallConfig {
	/**
	 * User-defined patterns merged on top of the curated built-in sets. Optional
	 * on the wire: older gateways omit it, so treat `undefined` as `[]`.
	 */
	custom_patterns?: CustomPattern[];
	enabled: boolean;
	/**
	 * Per-scope evaluator bindings that ride the firewall cascade (node base).
	 * Optional on the wire: older gateways omit it, so treat `undefined` as `[]`.
	 */
	evaluators?: EvaluatorBinding[];
	/**
	 * Optional cheap-LLM inspector carried on the node base. Older gateways omit
	 * it, so treat `undefined` as the disabled default.
	 */
	inspector?: InspectorConfig;
	/**
	 * Field names this (node) scope freezes so a narrower scope can only tighten
	 * them. Optional on the wire; treat `undefined` as `[]`.
	 */
	locked_fields?: string[];
	log_detections: boolean;
	policy: GatewayFirewallPolicy;
	/** Redact PII patterns (email, phone, SSN, etc.) when policy = sanitize. */
	redact_pii: boolean;
	/** Redact secret patterns (API keys, tokens, PEM keys) when policy = sanitize. */
	redact_secrets: boolean;
	scan_inbound: boolean;
	scan_outbound: boolean;
	/**
	 * Wrap untrusted tool results re-entering the model in boundary markers
	 * (injection defense). A node-level process global; per-scope overrides do
	 * not reach the tool loop in v1. Optional on the wire.
	 */
	wrap_untrusted_tool_results?: boolean;
}

/**
 * A partial FirewallConfig applied over a broader scope in the node → org →
 * agent cascade (mirrors gateway `FirewallOverlay`). Every scalar is optional:
 * a present value overrides the inherited one; `undefined`/`null` inherits.
 * `custom_patterns` are appended (union, never replace); `locked_fields` freeze
 * a field so a narrower scope can only tighten it. Wire keys are snake_case.
 */
export interface GatewayFirewallOverlay {
	custom_patterns?: CustomPattern[];
	enabled?: boolean | null;
	/**
	 * Per-scope evaluator bindings for this overlay. Appended (union) onto the
	 * broader scope's bindings; a binding a broader scope locked cannot be
	 * loosened. Optional on the wire.
	 */
	evaluators?: EvaluatorBinding[];
	inspector?: InspectorConfig | null;
	locked_fields?: string[];
	log_detections?: boolean | null;
	policy?: GatewayFirewallPolicy | null;
	redact_pii?: boolean | null;
	redact_secrets?: boolean | null;
	scan_inbound?: boolean | null;
	scan_outbound?: boolean | null;
	wrap_untrusted_tool_results?: boolean | null;
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
	/**
	 * A single GLOBAL per-session token cap (#510). Unlike `users`/`agents`,
	 * this is not a map: session ids are ephemeral (Core mints a fresh
	 * conversation id per chat), so one rule applies to every session. The
	 * shape is identical to a per-user/per-agent rule. `limit: 0` = off.
	 */
	session: BudgetRule;
	users: Record<string, BudgetRule>;
}

/** Default (off) per-session budget rule used when the gateway omits one. */
export const DEFAULT_SESSION_BUDGET: BudgetRule = {
	limit: 0,
	action: "notify",
	downgrade_to: null,
	restrict_max_tokens: 256,
};

/** Full redacted config returned by GET /v1/config (via Core proxy). */
export interface GatewayConfig {
	auth: GatewayAuthConfig;
	budgets: GatewayBudgetConfig;
	firewall: GatewayFirewallConfig;
	/**
	 * Gateway-local standalone-desktop per-agent firewall overlay store (the leaf
	 * scope of the node → org → agent cascade), keyed by agent id. `{}` on a fresh
	 * node and on the hosted path (there the overlays arrive on the resolve
	 * response, not `/v1/config`). Runtime-only on the gateway (not persisted).
	 */
	firewall_agent_overlays: Record<string, GatewayFirewallOverlay>;
	/**
	 * Gateway-local standalone-desktop per-org firewall overlay store (the mid
	 * scope of the cascade), keyed by org id. Same semantics as
	 * `firewall_agent_overlays`.
	 */
	firewall_org_overlays: Record<string, GatewayFirewallOverlay>;
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
	/**
	 * User-created ("create from scratch") evaluators that EXTEND the built-in
	 * catalog. Full-replacement: send the COMPLETE custom set every time (a
	 * field-omitting PUT is preserved by the gateway's clobber guard, but a
	 * partial array replaces). A custom entry whose `id` matches a built-in
	 * overrides that built-in. Takes effect after a gateway restart.
	 */
	custom_evaluators?: Evaluator[];
	firewall?: GatewayFirewallConfig;
	/**
	 * Full replacement of the gateway-local per-agent overlay store. Any agent id
	 * absent from this map is REMOVED, so always send the complete map (read from
	 * GET, mutate the one entry, send all).
	 */
	firewall_agent_overlays?: Record<string, GatewayFirewallOverlay>;
	/**
	 * Full replacement of the gateway-local per-org overlay store. Same
	 * full-replacement semantics as `firewall_agent_overlays`.
	 */
	firewall_org_overlays?: Record<string, GatewayFirewallOverlay>;
	/**
	 * Ryu's user-level routing config (persisted; takes effect after gateway restart).
	 * Runs before any upstream provider routing — this is the moat layer. PUT
	 * replaces the ENTIRE routing object, so always read-modify-write the full
	 * routing from GET before sending.
	 */
	routing?: GatewayRoutingConfig;
}

export const DEFAULT_SMART_ROUTING: SmartRoutingConfig = {
	enabled: false,
	strategy: "llm",
	classifier_model: "",
	embedding_model: "",
	similarity_threshold: 0.35,
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
	const budgets = raw.budgets ?? { users: {}, agents: {}, session: undefined };
	// Guard the shared path: a 2xx always carries `firewall`, but this function
	// backs several cards (budgets/keys/routing), so never let a missing section
	// throw and take them all down.
	const firewall = raw.firewall ?? ({} as GatewayFirewallConfig);
	return {
		...raw,
		budgets: {
			users: budgets.users ?? {},
			agents: budgets.agents ?? {},
			session: budgets.session ?? DEFAULT_SESSION_BUDGET,
		},
		routing: {
			...routing,
			smart_routing: routing.smart_routing ?? DEFAULT_SMART_ROUTING,
		},
		firewall: {
			...firewall,
			custom_patterns: firewall.custom_patterns ?? [],
			inspector: firewall.inspector ?? { ...DEFAULT_INSPECTOR },
			locked_fields: firewall.locked_fields ?? [],
		},
		firewall_org_overlays: raw.firewall_org_overlays ?? {},
		firewall_agent_overlays: raw.firewall_agent_overlays ?? {},
	};
}

/**
 * Apply a partial config change to the gateway via Core's proxy
 * (`PUT /api/gateway/config`). Core forwards the body verbatim to the gateway's
 * `PUT /v1/config`, which accepts firewall, budgets, auth, and routing. Provider
 * credentials are environment-variable-only and cannot be set here.
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

/**
 * Persist the full custom-evaluator set to the gateway, then restart it so the
 * new entry becomes catalogued + runnable (`custom_evaluators` is a startup
 * snapshot, like routing — invisible until the gateway respawns).
 *
 * Read the current custom set from `fetchEvaluators()` filtered by
 * `builtin === false`, add/replace your entry, and pass the COMPLETE array here
 * (full-replacement). Resolves once the restart request completes; callers
 * should refetch the catalog after this resolves.
 */
export async function saveCustomEvaluators(
	target: ApiTarget,
	customEvaluators: Evaluator[],
	signal?: AbortSignal
): Promise<void> {
	await updateGatewayConfig(
		target,
		{ custom_evaluators: customEvaluators },
		signal
	);
	// Restart is load-bearing: the gateway reads custom_evaluators once at
	// startup, so a saved evaluator stays invisible until the process respawns.
	// restartGateway never throws for the externally-managed / failure cases.
	await restartGateway(target);
}

/**
 * Convenience: add or replace one custom evaluator in the current set and
 * persist. `existing` should be the current custom set (from `fetchEvaluators`
 * filtered by `builtin === false`).
 */
export async function saveCustomEvaluator(
	target: ApiTarget,
	evaluator: Evaluator,
	existing: Evaluator[],
	signal?: AbortSignal
): Promise<void> {
	const next = existing.filter((e) => e.id !== evaluator.id);
	next.push({ ...evaluator, builtin: false });
	await saveCustomEvaluators(target, next, signal);
}

/**
 * Convenience: remove one custom evaluator by id and persist. `existing` is the
 * current custom set (from `fetchEvaluators` filtered by `builtin === false`).
 */
export async function deleteCustomEvaluator(
	target: ApiTarget,
	id: string,
	existing: Evaluator[],
	signal?: AbortSignal
): Promise<void> {
	const next = existing.filter((e) => e.id !== id);
	await saveCustomEvaluators(target, next, signal);
}

// ── BYOK provider-key vault helpers (Unit U026) ──────────────────────────────
//
// These call Core's `PUT /api/gateway/providers`, which writes the key to
// gateway.toml and restarts the gateway so the change takes effect immediately.
// The key value travels over the loopback interface only (desktop → Core); it
// is not stored in renderer state after the save completes.

// "gemini" is a BYOK slug rather than a gateway ProviderKind: the key is stored
// in the genai backend's nested keys table ([providers.genai].keys.gemini) by
// Core, so the gemini key flows to the `genai` provider.
export type ByokProvider = "openai" | "anthropic" | "openrouter" | "gemini";

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
	/**
	 * Derived estimated cost for this call in micro-USD (#548). The gateway
	 * computes it from tokens at its configured rate; `null` when cost
	 * attribution is disabled (rate 0) or for non-model events.
	 */
	cost_micro_usd: number | null;
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

// ── Live budget spend (M2 control-layer UX) ──────────────────────────────────
//
// The gateway tracks live per-user / per-agent / per-session token spend in
// memory; Core proxies its admin-gated `GET /v1/budget/spend` read surface so
// the desktop budget panel can render spend-vs-limit. Counters only track ids
// that have a CONFIGURED budget (the enforcer skips unbudgeted scopes and a
// session cap of 0 records nothing), so the maps are empty until a budget is
// set — the panel shows a hint in that case rather than a broken pane.

/** Configured limits echoed alongside spend so a caller can compute spend/limit. */
export interface BudgetSpendLimits {
	/** Per-agent lifetime token caps, keyed by agent id (0 = unlimited). */
	agents: Record<string, number>;
	/** The single global per-session cap (0 = disabled). */
	session: number;
	/** Per-user lifetime token caps, keyed by user id (0 = unlimited). */
	users: Record<string, number>;
}

/** Response from GET /api/gateway/budget/spend (Core proxy). */
export interface BudgetSpend {
	/** Per-agent lifetime tokens spent (input + output), keyed by agent id. */
	agents: Record<string, number>;
	/** Configured caps for the same scopes (0 = unlimited / off). */
	limits: BudgetSpendLimits;
	/** Whether the gateway was reachable. Maps are empty when false. */
	reachable: boolean;
	/** Per-session lifetime tokens spent, keyed by Core conversation/session id. */
	sessions: Record<string, number>;
	/** Per-user lifetime tokens spent, keyed by user id. */
	users: Record<string, number>;
}

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
	const raw = await request<BudgetSpend>(target, path, { signal });
	return {
		reachable: raw.reachable ?? false,
		users: raw.users ?? {},
		agents: raw.agents ?? {},
		sessions: raw.sessions ?? {},
		limits: raw.limits ?? { users: {}, agents: {}, session: 0 },
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
	 * Registry evaluator ids to score this case against, in addition to any
	 * run-level ids. Empty by default => assertion-only behavior.
	 */
	evaluators?: string[];
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
	/**
	 * Per-evaluator scores for the registry evaluators requested for this case.
	 * Present ([] when none requested). Additive to `overall`; never folded in.
	 */
	evaluators?: EvaluatorScore[];
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
	/**
	 * Per-evaluator aggregate keyed by evaluator id. Empty when no registry
	 * evaluators were requested. Values are camelCase (`meanScore`/`passRate`/
	 * `executedCount`) even though the parent key is snake_case.
	 */
	evaluators?: Record<string, EvaluatorAggregate>;
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

/** One custom Code evaluator's source, run by Core (not forwarded to the gateway). */
export interface CodeEvaluatorSpec {
	/** Stable id — matched against the gateway's placeholder score / injected. */
	id: string;
	/** `"js" | "python"` (aliases accepted server-side). */
	lang: EvaluatorCodeLang;
	/** The user function source. */
	source: string;
}

/** Request body for POST /api/gateway/evals/run. */
export interface RunEvalsRequest {
	/** Optional agent id for per-agent budget tracking. */
	agent_id?: string | null;
	/**
	 * Custom Code evaluators. Pulled out by the Core proxy and run locally
	 * (Deno for JS, sandbox for Python); their scores are merged into each
	 * case's `evaluators` list. Their ids do NOT need to appear in `evaluators`.
	 */
	code_evaluators?: CodeEvaluatorSpec[];
	/**
	 * Dataset to replay. When empty or absent the gateway uses its built-in
	 * 3-case dataset so the panel works on first run without any configuration.
	 */
	dataset?: EvalDatasetCase[];
	/**
	 * Registry evaluator ids applied to EVERY case (unioned with each case's own
	 * `evaluators`). Empty by default => assertion-only behavior. Code-evaluator
	 * ids belong in `code_evaluators`, not here.
	 */
	evaluators?: string[];
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
