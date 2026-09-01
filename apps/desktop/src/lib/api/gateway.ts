// apps/desktop/src/lib/api/gateway.ts
//
// Typed client for the Gateway observability surface, surfaced through Core's
// read-only proxy (`GET /api/gateway/status`). The proxy fetches the gateway's
// /health and /metrics and returns a combined snapshot, or a clear down state
// (`reachable: false`) when the gateway is unreachable while Core is still up.

import { type ApiTarget, apiUrl, request, requestHeaders } from "./client.ts";
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
 * The request modalities the gateway router knows about — the wire form of
 * `Modality` (`apps/gateway/src/config.rs`, `#[serde(rename_all = "lowercase")]`,
 * so these are the variant names lowercased) and the exact key set of
 * `routing.modality_map`.
 *
 * NOT a guessed list: `gateway.test.ts` parses the Rust enum and asserts this
 * tuple matches it variant-for-variant. A key the Rust side does not know
 * deserializes to nothing and the setting is silently ignored, which is the
 * whole defect class this editor exists to close.
 */
export const MODALITIES = ["chat", "image", "tts", "stt", "video"] as const;

/** One of {@link MODALITIES}. */
export type Modality = (typeof MODALITIES)[number];

/**
 * A single modality → provider mapping entry, mirroring `ModalityMapping`
 * (`apps/gateway/src/config.rs`).
 *
 * `provider` is a `ProviderId` — a newtype over `String`, i.e. an OPEN registry
 * id, not the closed {@link ProviderKind} union. It is typed `string` on purpose:
 * the media providers this map exists to select (`fal`, `replicate`, `modal`)
 * are registered in `apps/gateway/src/providers/mod.rs` but are deliberately
 * absent from `ProviderKind`, which only covers the chat-capable passthroughs.
 * Narrowing this to `ProviderKind` would make the map unable to name the very
 * providers it was built for.
 */
export interface ModalityMapping {
	/**
	 * Model id to send to the provider. Absent ⇒ the caller's own `model` field
	 * is forwarded unchanged (`crates/gateway/router/src/lib.rs`:
	 * `mapping_model.clone().unwrap_or_else(|| requested_model.to_string())`).
	 *
	 * Note the consequence for the save path: `Some("")` is NOT the same as
	 * absent — an empty string is forwarded as the literal model name. Blank
	 * input must therefore be OMITTED, never sent as `""`. See
	 * {@link withModalityMapping}.
	 */
	model?: string | null;
	provider: string;
}

/**
 * Eval-driven (A/B) routing across candidate providers, mirroring
 * `EvalRoutingConfig` (`apps/gateway/src/config.rs`).
 *
 * Declared here for one reason only: `PUT /v1/config { routing }` replaces the
 * routing section WHOLESALE (`api/config.rs`: `updated_config.routing =
 * routing.clone()`), and every `RoutingConfig` field is `#[serde(default)]`, so
 * a field the desktop never round-trips is a field the desktop erases. There is
 * no editor for it and there should not be one — the desktop's job is to carry
 * it through untouched.
 */
export interface EvalRoutingConfig {
	/** Candidate provider ids traffic is split across. */
	candidates: string[];
	/** Master switch. Off by default. */
	enabled: boolean;
	/** Fraction of eligible traffic reserved for non-leader candidates. Default 0.2. */
	explore_ratio: number;
}

/**
 * How the matching rule is chosen for a smart-routing decision. Shared vocabulary
 * across both routing planes (model routing here, agent routing in Core):
 * - `llm`: a cheap classifier model reads the message and picks a rule.
 * - `embedding`: embed rule descriptions + the query, cosine-nearest above a threshold.
 * - `keyword`: case-insensitive significant-word match; zero cost, zero network.
 */
export type RouteStrategy = "llm" | "embedding" | "keyword";

/** Top-level Gateway model-router algorithms inspired by NeMo Switchyard. */
export type ModelRouterType =
	| "llm_classifier"
	| "passthrough"
	| "random"
	| "stage_router"
	| "escalation";

export type StagePicker = "capable_first" | "efficient_first";

export const MODEL_ROUTER_TYPE_LABELS: Record<ModelRouterType, string> = {
	llm_classifier: "LLM classifier",
	passthrough: "Passthrough",
	random: "Weighted random",
	stage_router: "Stage router",
	escalation: "Escalation",
};

export const MODEL_ROUTER_TYPE_DESCRIPTIONS: Record<ModelRouterType, string> = {
	llm_classifier: "match request rules by model, meaning, or words",
	passthrough: "keep the model requested by the caller",
	random: "split traffic across target models for experiments",
	stage_router: "use recent tool and progress signals per turn",
	escalation: "judge the trajectory and latch hard sessions upward",
};

/**
 * The ONE naming of the three smart-routing strategies, in both vocabularies.
 *
 * This table exists because the same picker is rendered in THREE places — the
 * agent auto-routing editor, the per-agent smart-route override, and the Gateway
 * dialog's routing section — and each had carried its own private copy of these
 * six strings. They happened to still agree, which is the state a triplicated copy
 * table is in right up until it isn't: the copies are what let one surface be
 * reworded and the other two silently keep promising something else about how an
 * agent picks a model.
 *
 * The technical names describe the MECHANISM ("LLM classifier", "Embedding") and
 * the friendly names describe the DECISION a user is actually making — "let a
 * model read it" versus "match on meaning" versus "match on words". `cosine` is
 * the clearest example of why the split is worth having: it is the precise word
 * for what the code does and it is meaningless to someone choosing how their own
 * assistant should route, so friendly mode says "how close the meaning is" and the
 * technical mode still says cosine for whoever is tuning `similarity_threshold`.
 *
 * Costs stay stated in BOTH vocabularies. "Zero cost" and "a cheap model" are the
 * facts that decide this setting for most people, so the friendly copy keeps them
 * rather than trading them for a shorter sentence.
 */
export const ROUTE_STRATEGY_LABELS: Record<RouteStrategy, string> = {
	llm: "LLM classifier",
	embedding: "Embedding",
	keyword: "Keyword",
};

export const ROUTE_STRATEGY_FRIENDLY_LABELS: Record<RouteStrategy, string> = {
	llm: "Let a model decide",
	embedding: "Match on meaning",
	keyword: "Match on words",
};

export const ROUTE_STRATEGY_DESCRIPTIONS: Record<RouteStrategy, string> = {
	llm: "a cheap model reads the message and picks a rule",
	embedding: "cosine-match rule text against the message",
	keyword: "case-insensitive word match, zero cost",
};

export const ROUTE_STRATEGY_FRIENDLY_DESCRIPTIONS: Record<
	RouteStrategy,
	string
> = {
	llm: "a small, cheap model reads the message and picks the rule that fits",
	embedding: "compares what the message means with what each rule describes",
	keyword: "looks for the rule's words in the message; free and instant",
};

/**
 * The label + description pair for each strategy in the caller's current mode.
 *
 * Returned as one object so a surface cannot pick a friendly label and leave a
 * technical description under it — the mismatch that makes a control read as half
 * translated.
 */
export function routeStrategyCopy(friendly: boolean): {
	descriptions: Record<RouteStrategy, string>;
	labels: Record<RouteStrategy, string>;
} {
	return friendly
		? {
				descriptions: ROUTE_STRATEGY_FRIENDLY_DESCRIPTIONS,
				labels: ROUTE_STRATEGY_FRIENDLY_LABELS,
			}
		: {
				descriptions: ROUTE_STRATEGY_DESCRIPTIONS,
				labels: ROUTE_STRATEGY_LABELS,
			};
}

/** A single smart-routing rule: a plain-language condition + target model. */
export interface SmartRule {
	/** Natural-language condition, e.g. "writing or refactoring code". */
	description: string;
	/** Model to route matching requests to (resolved via the router). */
	model: string;
	/** Relative traffic weight for the `random` router; defaults to 1. */
	weight?: number;
}

/**
 * Gateway Plane A model routing ("custom routing instructions"). When enabled,
 * the selected `router_type` picks or preserves a target model before normal
 * model→provider routing runs. Fails open: any error keeps the originally
 * requested model. Takes effect after the gateway restarts.
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
	/** Consecutive judge escalations required to latch a session. */
	escalation_confirmations?: number;
	/** Judge model used by the escalation router. */
	escalation_judge_model?: string;
	/** Per-message character cap in the escalation judge prompt. */
	escalation_message_chars?: number;
	/** Recent message window shown to the escalation judge. */
	escalation_recent_message_window?: number;
	/** Strong tier used by the escalation router. */
	escalation_strong_model?: string;
	/** Weak tier used by the escalation router. */
	escalation_weak_model?: string;
	/** Optional reproducible seed for weighted random routing. */
	random_seed?: number | null;
	/** Top-level model-router algorithm. Older gateways omit this field. */
	router_type?: ModelRouterType;
	/** Ordered natural-language rules. */
	rules: SmartRule[];
	/** Min cosine for the `embedding` strategy to accept a rule. Default 0.35. */
	similarity_threshold: number;
	/** Capable tier used by the stage router. */
	stage_capable_model?: string;
	/** Minimum confidence before stage signals override the picker default. */
	stage_confidence_threshold?: number;
	/** Efficient tier used by the stage router. */
	stage_efficient_model?: string;
	/** Default tier when stage signals are ambiguous. */
	stage_picker?: StagePicker;
	/** Recent request-message window inspected by the stage scorer. */
	stage_recent_message_window?: number;
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
	/**
	 * Eval-driven (A/B) routing. Optional on the wire — a gateway whose
	 * `RoutingView` predates this field omits it. Round-trip only; no editor.
	 */
	eval_routing?: EvalRoutingConfig;
	/** Ordered fallback chain used when the primary provider is unavailable. */
	fallback_chain: ProviderKind[];
	/**
	 * Per-modality provider/model overrides, consulted BEFORE the model map for
	 * any non-chat request (`crates/gateway/router/src/lib.rs::route_modality`).
	 * A modality with no entry falls through to ordinary model routing and
	 * therefore to `default_provider`.
	 *
	 * `Partial<Record<…>>` because absence is the meaningful state: the gateway
	 * serializes a `HashMap<Modality, ModalityMapping>`, so only configured
	 * modalities appear as keys.
	 *
	 * Optional on the wire for a load-bearing reason — see
	 * {@link routingViewIncludesModalityMap}. Do NOT coalesce this to `{}` in
	 * {@link fetchGatewayConfig}: "this gateway never served the field" and "this
	 * gateway says the map is empty" must stay distinguishable, because a save
	 * built from the first case silently wipes a working map.
	 */
	modality_map?: Partial<Record<Modality, ModalityMapping>>;
	/** Static model-to-provider mappings (exact or prefix match). */
	model_map: Record<string, ModelMapping>;
	/**
	 * Per-provider cost tier used to order the fallback chain: 0 = subscription,
	 * 1 = cheap, 2 = free. Keyed by provider kind. Absent providers default to
	 * tier 0. Optional on the wire — gateways that don't surface it omit the
	 * field (treat `undefined` as `{}`).
	 */
	provider_tiers?: Record<string, number>;
	/** Gateway Plane A model routing (custom routing instructions). Optional. */
	smart_routing?: SmartRoutingConfig;
}

/** The three policy values the gateway firewall accepts (snake_case wire form). */
export type GatewayFirewallPolicy = "block" | "warn_and_continue" | "sanitize";

/**
 * The alert tiers, ASCENDING in severity — the wire form of the gateway's
 * `AlertTier` (`crates/gateway/contracts/src/lib.rs`, `rename_all = "lowercase"`,
 * so these are the variant names lowercased).
 *
 * Order is load-bearing, not cosmetic. The gateway takes the `max` tier across
 * every rule a request matched (`pipeline/mod.rs`, `max_tier`) before it stamps
 * the alert header, and the Rust enum derives `Ord` from its declaration order
 * for exactly that reason. A UI that offered these in a different order would
 * still save correct values, but the mirror test below compares this array to the
 * Rust declaration order so the two can never diverge unnoticed.
 *
 * ORTHOGONAL to enforcement (`GatewayFirewallPolicy` / {@link BudgetAction}):
 * enforcement decides what happens to the request, the tier decides who is told.
 */
export const ALERT_TIERS = ["silent", "warn", "fanout", "email"] as const;

/**
 * Notification fan-out tier for a matched policy rule. Derived from
 * {@link ALERT_TIERS} so the union and the ordered list cannot drift apart.
 *
 * What each tier actually delivers, read out of Core's `dispatch`
 * (`apps/core/src/policy_alerts/mod.rs`) — the only place the tier is turned into
 * sinks. Note that Core does not import the gateway's `AlertTier`; that module
 * declares its own mirror of the enum, so "the Rust type" is two types that agree
 * only on their wire strings (see the mirror warning on the gateway enum).
 *
 * - `silent` — nothing. The default, so every pre-existing config is silent.
 * - `warn` — the in-app desktop notification only (Core publishes that SSE event
 *   for any delivered alert, before it matches on the tier), no external sink.
 * - `fanout` — `targets.targets`: webhook / Telegram / Expo push.
 * - `email` — `targets.emails` over the node's BYO SMTP transport. It REPLACES
 *   the fan-out channels rather than adding to them: Core's match arms are
 *   exclusive, so an `email` rule does not also hit the webhook. Do not describe
 *   `email` as "fanout plus email" in UI copy — `AlertTier`'s own doc comment
 *   used to say that and now says the same thing this comment does.
 *
 * Every tier above `silent` needs delivery targets configured on the node
 * ("Email & alerts"); with none, a raised tier still delivers nothing but the
 * in-app notification.
 *
 * The chain between the two processes, traced end to end so the UI copy is not
 * promising a delivery nobody performs: gateway reads the tier off the firewall /
 * budget config → `PolicyAlert` → `x-ryu-policy-alert` on the response (the 403
 * path via `GatewayError::into_response`, the allow path via the response
 * extension + the `stamp_policy_alert` map_response layer in
 * `apps/gateway/src/api/mod.rs`) → Core's `dispatch_from_headers`, called from the
 * three response heads that may have been gateway-fronted
 * (`apps/core/src/sidecar/adapters/mod.rs`, and two in `server/widgets.rs`) →
 * `policy_alerts::dispatch` on a spawned task. A gateway client that is NOT Core (a
 * raw `/v1/chat/completions` caller) receives the header and does nothing with it;
 * delivery is Core's half.
 */
export type GatewayAlertTier = (typeof ALERT_TIERS)[number];

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

// ── Local classify tier ───────────────────────────────────────────────────────
//
// Core runs a lazy `llama.cpp` sidecar dedicated to classification-shaped work
// (guardrail inspection, smart-routing rule picking, LLM-judge evaluators) so
// those cheap per-turn calls never contend with Chat or burn a paid
// provider's tokens. The gateway exposes it as the `classify` provider, and the
// router's builtin prefix table maps the `gemma-3-270m` model prefix onto it.
//
// The desktop binds no port of its own to that tier. All it needs is to (a) name
// the sidecar when reading `/api/sidecar/status`, (b) offer the model id as a
// picker value, and (c) ask whether the tier can actually SERVE right now — two
// independent facts (a registered process manager, and a weights file on disk)
// which the derivation below folds into one {@link ClassifyTierState}. All of it
// lives here, beside the config types whose model fields consume it, rather than
// in a new module.

/**
 * Name of the Core sidecar serving the local classify tier — mirrors its Rust
 * `Sidecar::name()`, which is the key `/api/sidecar/status` reports it under.
 * The sidecar is LAZY (deliberately absent from Core's `startup_order`):
 * "registered but not running" is its normal resting state, not a fault — which
 * is why this key alone cannot report the tier's health, and
 * {@link deriveClassifyTierState} crosses it with a weights probe to tell a lazy
 * idle apart from a sidecar that can never start.
 */
export const CLASSIFY_SIDECAR_NAME = "llamacpp-classify";

/**
 * Model id of the local classify tier (Gemma 3 270M, QAT Q4_0). Routable
 * through the gateway because the router maps the `gemma-3-270m` prefix to the
 * `classify` provider — see the ORDER-IS-LOAD-BEARING note in
 * `crates/gateway/router/src/lib.rs`, which keeps that prefix above the generic
 * `gemma` → `local` row. Legal value for any "cheap model" field
 * (`inspector.model`, `smart_routing.classifier_model`), and the gateway's own
 * `DEFAULT_INSPECTOR_MODEL` — which is the gateway's COMPILE-TIME fallback: a
 * Core-spawned gateway prefers the id Core publishes as `RYU_CLASSIFY_MODEL_ID`
 * (`classify_model_id()`), and that is the one seam this constant cannot follow.
 * See the KNOWN LIMIT on {@link fetchClassifyWeightsPresent}.
 */
export const CLASSIFY_MODEL_ID = "gemma-3-270m-it-qat-Q4_0";

/**
 * The router's builtin model prefix for the classify provider. Any model id
 * starting with this is served by the local classify sidecar and by nothing
 * else, which is what lets a client ask "will this model need the local tier?"
 * without enumerating quant variants.
 */
export const CLASSIFY_MODEL_PREFIX = "gemma-3-270m";

/**
 * Live state of the local classify tier on one node.
 *
 * - `unknown` — nothing has answered yet (or a probe failed, e.g. an older Core
 *   without `/api/models/installed`). Renders as nothing: an unreachable node
 *   already says so elsewhere, and guessing "broken" would flash a false alarm
 *   on every dialog open.
 * - `absent` — Core answered `/api/sidecar/status` but does not register the
 *   sidecar at all. Current Core registers the manager unconditionally
 *   (`apps/core/src/main.rs`) and `SidecarManager::statuses` deliberately emits
 *   every registered sidecar that is NOT in `startup_order`, so the key is
 *   always present there — this variant only reaches an older Core (or a build
 *   without the manager), which is exactly the node where the tier genuinely
 *   does not exist.
 * - `unweighted` — the sidecar is registered but its GGUF is not on disk, so it
 *   CANNOT start: `classify.rs` bails "classifier model not found" at
 *   `weight_path().exists()` and logs it at `debug`. This is the live failure the
 *   whole status row exists for, because the onboarding download that fetches
 *   those weights is deliberately non-fatal (`install_local_stack` records a
 *   warning and moves on), so a node can sit here indefinitely while every other
 *   signal reads healthy.
 * - `idle` — registered, weights present, no resident process. The NORMAL resting
 *   state: the sidecar is lazy (deliberately not in `startup_order`) and starts
 *   on the first classification, so `idle` must never read as broken.
 * - `running` — holding a resident process right now.
 */
export type ClassifyTierState =
	| "absent"
	| "idle"
	| "running"
	| "unknown"
	| "unweighted";

/**
 * Fold the two independent probes into a {@link ClassifyTierState}.
 *
 * `undefined` means "not answered / probe failed" for BOTH inputs, and the whole
 * sidecar map is taken rather than one pre-read boolean on purpose: a bare
 * `running: boolean | undefined` cannot distinguish "Core says the sidecar isn't
 * registered" from "the status call hasn't answered", and collapsing those two
 * into `absent` is precisely the kind of confident-but-wrong claim this state
 * machine exists to prevent. Taking the map makes the distinction unfakeable.
 *
 * Order is load-bearing:
 *
 *  1. no status ⇒ `unknown`.
 *  2. status without our key ⇒ `absent` — the weights are irrelevant on a Core
 *     that cannot serve them.
 *  3. `running` ⇒ `running` WITHOUT consulting the weights probe. A resident
 *     process proves the weights exist (the start path bails otherwise), so a
 *     transient failure of the weights endpoint must not downgrade a
 *     demonstrably-working tier.
 *  4. otherwise the weights decide, and an unresolved probe is `unknown` rather
 *     than either happy answer.
 */
export function deriveClassifyTierState({
	sidecarStatus,
	weightsPresent,
}: {
	/** `/api/sidecar/status` as a name→running map; `undefined` = unanswered. */
	sidecarStatus: Record<string, boolean> | undefined;
	/** {@link fetchClassifyWeightsPresent}; `undefined` = unanswered/failed. */
	weightsPresent: boolean | undefined;
}): ClassifyTierState {
	if (sidecarStatus === undefined) {
		return "unknown";
	}
	const running = sidecarStatus[CLASSIFY_SIDECAR_NAME];
	if (running === undefined) {
		return "absent";
	}
	if (running) {
		return "running";
	}
	if (weightsPresent === undefined) {
		return "unknown";
	}
	return weightsPresent ? "idle" : "unweighted";
}

/**
 * Whether the tier can serve a classification on this node. `false` for both
 * failure states AND for `unknown`, so nothing offers the tier's model id as a
 * one-click value before the node has confirmed it can honour it.
 */
export function classifyTierServable(state: ClassifyTierState): boolean {
	return state === "idle" || state === "running";
}

/**
 * Whether a configured "cheap model" value points at the local classify tier on
 * a node that is KNOWN not to serve it — the shared gate for the two cards that
 * warn about it. `unknown` deliberately does not qualify: an unanswered probe
 * must not raise an alarm.
 *
 * The check is a property of the node crossed with the model id, and nothing
 * else in either card can reveal it: both consumers fail OPEN by design (the
 * inspector treats an errored inspection as not-flagged; smart routing keeps the
 * originally requested model), so the UI would otherwise report a guardrail that
 * is on, shows `Block`, and allows every turn.
 */
export function classifyTierCannotServeModel(
	state: ClassifyTierState,
	model: string
): boolean {
	if (state !== "absent" && state !== "unweighted") {
		return false;
	}
	return model.trim().startsWith(CLASSIFY_MODEL_PREFIX);
}

/**
 * Badge + hint for every resolvable tier state, plus — for the two states that
 * cannot serve — the `reason` clause each card composes its own consequence
 * onto (the inspector allows the turn; smart routing keeps the requested model).
 */
export const CLASSIFY_TIER_COPY: Record<
	Exclude<ClassifyTierState, "unknown">,
	{ badge: string; hint: string; reason?: string }
> = {
	running: {
		badge: "Local classifier running",
		hint: "Gemma 3 270M is loaded on this node — classification costs nothing and leaves no data.",
	},
	idle: {
		badge: "Local classifier ready",
		hint: "Gemma 3 270M is downloaded on this node; it starts on the first classification.",
	},
	unweighted: {
		badge: "Local classifier not downloaded",
		// Says "the weights this node's Core defaults to" rather than "the weights",
		// because that is exactly what the probe measured: an operator who pointed
		// the registry at a different id has other weights we cannot see.
		//
		// It used to end "…so it can never start", and both halves of that were
		// wrong: it overstated a recoverable state AND withheld the one-step remedy.
		// Core's boot spawns `install_local_stack` UNCONDITIONALLY
		// (apps/core/src/main.rs, the "Auto-install the local inference stack" block)
		// and that routine re-attempts the classifier GGUF every time
		// (apps/core/src/sidecar/onboarding.rs — the `classifier_gguf_installed`
		// step), so a restart genuinely retries the download. "Usually" is
		// load-bearing and not hedging: that step is gated on the llama.cpp BINARY
		// having installed, and a download that keeps failing is failing for a reason
		// (network, disk, a bad mirror) that only Core's log can name — so the copy
		// promises a retry, never a fix.
		hint: "This node registers the classify sidecar but not the Gemma 3 270M weights its Core defaults to, so it cannot start yet. Core retries the download every time it starts, so restarting Core is usually enough; if it keeps failing, Core's log says why.",
		// Stays a mid-sentence CLAUSE: both cards compose their own consequence onto
		// it ("…, but {reason} — so the call will fail…"), so it cannot grow a second
		// sentence. The remedy therefore lives in `hint`, which
		// `ClassifyTierNote` renders on both cards beside the badge.
		reason:
			"this node has not finished downloading the classifier weights (Gemma 3 270M) yet",
	},
	absent: {
		badge: "No local classifier",
		hint: "This node's Core does not provide the local classify tier — pick a hosted model instead.",
		reason: "this node's Core does not provide that tier",
	},
};

/**
 * Whether the classify tier's WEIGHTS are on this node's disk.
 *
 * Reads Core's `/api/models/installed`, whose `load_present()` drops any record
 * whose file is gone — the same `~/.ryu/models/<stem>.gguf` existence check
 * `classify.rs` bails on, so this answers exactly the question "will the sidecar
 * start?". Matched on the EXACT id, never the prefix: a user who installs
 * another `gemma-3-270m` quant as a chat model would otherwise make this report
 * ready while the sidecar still bails on the missing default quant.
 *
 * A Core endpoint in the gateway client because it exists solely to judge the
 * gateway's two "cheap model" fields. Deliberately not `listInstalledModels`
 * from `./models.ts`: that one returns `[]` on any error by design, and an empty
 * list is indistinguishable from "the endpoint is missing" — which would render
 * an older Core as a hard "weights missing" alarm. This one THROWS so the caller
 * can stay `unknown`.
 *
 * KNOWN LIMIT: an operator who overrides Core's registry id
 * (`RYU_LOCAL_CLASSIFIER_MODEL_ID`, republished to the gateway as
 * `RYU_CLASSIFY_MODEL_ID`) serves a different stem, and this probe would report
 * its own default missing. There is no Core route that publishes the resolved
 * registry id, and the gateway config cannot stand in for one: the exact
 * `<classify id>` → `classify` row `seed_classify_route` inserts is DERIVED, and the
 * gateway strips it from everything that leaves the process — both `GET /v1/config`
 * and its own `save()`, via `GatewayConfig::without_derived_values`
 * (apps/gateway/src/config.rs). So a served `routing.model_map` carries a classify
 * mapping only when an operator hand-wrote one, and reading it would report either
 * nothing or that operator's possibly-superseded alias as "current" — and calling a
 * tier ready that cannot start is the exact failure this probe exists to catch. So
 * the limit is
 * accepted in the pessimistic direction: an overridden node shows a "not
 * downloaded" badge it does not deserve. It stays a badge and not a warning unless
 * the override is to another quant of the SAME model, since
 * {@link classifyTierCannotServeModel} only judges ids under
 * {@link CLASSIFY_MODEL_PREFIX} and a coherent override points both the registry
 * and the config at an id outside it.
 */
export async function fetchClassifyWeightsPresent(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<boolean> {
	const json = await request<{ models?: { stem?: string }[] }>(
		target,
		"/api/models/installed",
		{ signal }
	);
	return (json.models ?? []).some((m) => m.stem === CLASSIFY_MODEL_ID);
}

/**
 * The swappable cheap-LLM traffic inspector (mirrors gateway `InspectorConfig`).
 * A detection *method* orthogonal to `policy` (the *action*). Opt-in and
 * fail-open.
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
	/**
	 * Model id used for inspection, resolved through the gateway router so it
	 * stays swappable.
	 *
	 * A blank value is NOT harmless, and the earlier claim here ("never
	 * meaningfully empty") was the round-2 mistake this doc now exists to prevent.
	 * The gateway does resolve a blank to {@link CLASSIFY_MODEL_ID} at
	 * DESERIALIZATION (`de_inspector_model`, apps/gateway/src/config.rs) — but that
	 * runs in the GATEWAY process, strictly downstream of a save. A desktop save
	 * goes to Core's `PUT /api/gateway/config`, and Core inspects the raw JSON body
	 * on the way through (`gateway_put_config` → `push_config` →
	 * `maybe_start_classify_tier`, apps/core/src/sidecar/gateway.rs) to decide
	 * whether to start the `llamacpp-classify` sidecar the classify id routes to.
	 * That predicate USED to return false for an empty model, so a blank on the wire
	 * meant "do not start the local classifier" — after which the gateway resolved
	 * the blank to that very classifier and called a provider nothing was listening
	 * on, and the inspector failed open. Core now treats blank-and-enabled as a
	 * selection as well (`inspector_model_resolves_to_tier`, inside
	 * `patch_selects_classify_tier` — a deliberate mirror of `de_inspector_model` on
	 * Core's side of the process boundary), so a blank is no longer silently fatal
	 * against a CURRENT Core.
	 *
	 * {@link withResolvedInspectorModels} still writes a concrete id on every save,
	 * for the two reasons that outlive that fix: `PUT /api/gateway/config` is a
	 * generic proxy, so the Core on the far side is whatever version the node runs
	 * (an older one still declines a blank), and what gets persisted should equal
	 * what the card displays. Neither half is redundant — Core's covers every other
	 * client of that proxy, this one covers every Core version.
	 */
	model: string;
	/** Per-inspection timeout in milliseconds; on timeout the request is allowed. */
	timeout_ms: number;
}

/**
 * Default (disabled) inspector config used when the gateway omits one.
 *
 * MIRRORS `impl Default for InspectorConfig` (apps/gateway/src/config.rs). Two
 * fields drifted from it and both drifts were silent:
 *
 * - `action` said `warn_and_continue`; the Rust default is `FirewallPolicy`'s
 *   `#[default]`, which is `Block` — an injection match is not meaningfully
 *   redactable, so blocking is the only action that actually stops it. A mirror
 *   that is strictly WEAKER than the enforced default is the dangerous
 *   direction to drift in.
 * - `model` said `""`. That used to match Rust, but the gateway now defaults it
 *   to the classify-tier classifier (and resolves a blank back to it as it reads
 *   the wire, in its OWN process — which is downstream of Core's start decision, so
 *   the gateway's resolution ALONE never made a blank safe to send; see
 *   {@link InspectorConfig.model} for which half of that is fixed where),
 *   precisely so that "inspector enabled" cannot mean "inspector silently never
 *   runs".
 *
 * Both were inert while the gateway always serializes `inspector` — the `??`
 * fallbacks in `normalizeConfig` and `InspectorCard` never fired — which is
 * exactly why they went unnoticed; the first response that omits the section
 * would have shown, and then saved back, the wrong values.
 */
export const DEFAULT_INSPECTOR: InspectorConfig = {
	enabled: false,
	model: CLASSIFY_MODEL_ID,
	mode: "both",
	min_chars: 40,
	timeout_ms: 1500,
	action: "block",
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
	 * Notification fan-out tier when the firewall matches — orthogonal to
	 * `policy`, which is the enforcement action. Optional on the wire (older
	 * gateways omit it and the Rust field is `#[serde(default)]`); treat
	 * `undefined` as `"silent"`. {@link fetchGatewayConfig} coalesces it so the
	 * card always has a concrete value to bind a Select to.
	 */
	alert?: GatewayAlertTier;
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
	/**
	 * Per-scope alert tier. `null`/`undefined` inherits the broader scope's tier.
	 *
	 * The gateway half is in place: `FirewallOverlay.alert: Option<AlertTier>`
	 * (`apps/gateway/src/config.rs`) plus its arm in `apply_overlay`
	 * (`apps/gateway/src/firewall/resolve.rs`). An earlier revision of this comment
	 * described both as pending and concluded several things from their absence;
	 * all of that is superseded, and the two conclusions worth correcting by name:
	 *
	 * LOCKABLE — yes. The `apply_overlay` arm honours a lock via `louder_alert` =
	 * `max` over `AlertTier`'s ascending-severity `Ord`, so with `"alert"` in a
	 * broader scope's `locked_fields` a narrower scope may only RAISE the tier.
	 * `"alert"` is a canonical name on `FirewallConfig::locked_fields`, and
	 * `GuardrailAlertRow` offers the node-scope toggle. It is not in
	 * `default_firewall_locked_fields`: a notification dial is not a protection
	 * dial, so it starts unlocked.
	 *
	 * COVERAGE — partial, and the boundary is NOT inbound-vs-outbound. Enumerated
	 * from the `firewall_policy_alert` call sites in `apps/gateway/src/pipeline/mod.rs`:
	 *
	 * - Scope-aware, via `state.resolved_scanner(ctx)` → `scanner.config()`:
	 *   `pre_process` (inbound text), `apply_inline_input_evaluators`, and
	 *   `apply_inline_output_evaluators` — the last of which raises OUTBOUND blocks,
	 *   so an org/agent tier does govern those.
	 * - Node-base only, via `state.with_firewall(|fw| … fw.config() …)`: `run`'s
	 *   stage-9 outbound response scan, `run_multimodal`'s inbound scan, and
	 *   `submit_video_job`'s inbound scan. An overlay tier is ignored at all three;
	 *   the node tier fires.
	 *
	 * So UI copy must not promise that an org/agent tier governs image or video
	 * requests, nor that it is powerless on outbound. Only the node scope covers
	 * all six sites. Widening the three is a `pipeline/mod.rs` change.
	 */
	alert?: GatewayAlertTier | null;
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

/** Charged work categories that a budget rule includes. */
export interface BudgetChargeInclusion {
	media: boolean;
	model: boolean;
	tools: boolean;
}

export const DEFAULT_BUDGET_INCLUSION: BudgetChargeInclusion = {
	model: true,
	media: true,
	tools: true,
};

/**
 * A single per-agent or per-user budget rule.
 * Field names are snake_case — the gateway config API passes these through
 * without camelCase normalization (unlike the status proxy).
 */
export interface BudgetRule {
	/** Action taken once the charged-cost cap is reached. */
	action: BudgetAction;
	/**
	 * Notification fan-out tier when this rule matches — orthogonal to `action`.
	 * Optional on the wire (`#[serde(default)]` in Rust); `undefined` = `silent`.
	 * Always write it through {@link buildBudgetRule}: a rule object assembled by
	 * hand from a form used to drop this field, which silently demoted an
	 * operator's `email` rule to `silent` on the next edit-and-save.
	 */
	alert?: GatewayAlertTier;
	/** Model to route to when action = downgrade. */
	downgrade_to?: string | null;
	/** Which charged work categories contribute to this cap. */
	include?: BudgetChargeInclusion;
	/** Lifetime charged-cost cap in micro-USD (1_000_000 = $1). 0 = unlimited. */
	limit: number;
	/** Max tokens cap when action = restrict. Defaults to 256 on the gateway. */
	restrict_max_tokens?: number;
}

/** Loose scalars a budget form holds, before {@link buildBudgetRule} tightens them. */
export interface BudgetRuleInput {
	action: BudgetAction;
	/** Omitted ⇒ `silent`, matching the Rust `#[serde(default)]`. */
	alert?: GatewayAlertTier;
	/** Raw model id; trimmed, and only kept when `action === "downgrade"`. */
	downgradeTo?: string | null;
	/** Charged work categories to include. */
	include?: BudgetChargeInclusion;
	limit: number;
	/**
	 * Raw cap, as typed. Only kept when `action === "restrict"` AND it parses to a
	 * positive integer — otherwise omitted so the gateway applies its own 256.
	 */
	restrictMaxTokens?: number | string | null;
}

/**
 * The ONE place a {@link BudgetRule} is assembled for the wire.
 *
 * It exists because the same object literal was being built in three places in
 * `GatewayDialog.tsx` (the add dialogs' `formToRule`, `BudgetScopeSection`'s
 * duplicate of it, and `SessionBudgetEditor.handleSave`), each carrying only
 * `limit`/`action`/`downgrade_to`/`restrict_max_tokens`. Since `PUT /v1/config`
 * REPLACES the whole `BudgetConfig`, every one of those was a wipe of any field
 * they did not name — which is how `alert` stayed pinned at `silent` no matter
 * what an operator configured. Constructing rules anywhere else re-opens that.
 *
 * `alert` is always emitted, even at `silent`: the value the card shows and the
 * value on the wire then agree, and `silent` is the Rust default anyway, so this
 * is not a behaviour change for pre-existing rules.
 *
 * Pure and total — no throwing. Bad numbers are dropped rather than rejected,
 * mirroring what the dialogs already did (the dialogs validate `limit`
 * themselves; this only refuses to put junk on the wire). `limit` is charged
 * micro-USD (1_000_000 = $1), not a token count.
 */
export function buildBudgetRule(input: BudgetRuleInput): BudgetRule {
	const rule: BudgetRule = {
		limit: input.limit,
		action: input.action,
		alert: input.alert ?? "silent",
	};
	if (input.include) {
		rule.include = {
			model: input.include.model,
			media: input.include.media,
			tools: input.include.tools,
		};
	}
	const downgradeTo = (input.downgradeTo ?? "").trim();
	if (input.action === "downgrade" && downgradeTo !== "") {
		rule.downgrade_to = downgradeTo;
	}
	if (input.action === "restrict" && input.restrictMaxTokens != null) {
		const raw =
			typeof input.restrictMaxTokens === "string"
				? input.restrictMaxTokens.trim()
				: input.restrictMaxTokens;
		if (raw !== "") {
			const cap = Number(raw);
			if (Number.isInteger(cap) && cap > 0) {
				rule.restrict_max_tokens = cap;
			}
		}
	}
	return rule;
}

/**
 * Read-modify-write helper for one agent rule. Gateway budget updates replace
 * the complete budget object, so callers must preserve users, other agents,
 * and the global session rule when saving or removing a single agent cap.
 */
export function withAgentBudget(
	budgets: GatewayBudgetConfig,
	agentId: string,
	rule: BudgetRule | null
): GatewayBudgetConfig {
	const agents = { ...budgets.agents };
	if (rule) {
		agents[agentId] = rule;
	} else {
		delete agents[agentId];
	}
	return {
		users: { ...budgets.users },
		agents,
		session: budgets.session ?? DEFAULT_SESSION_BUDGET,
	};
}

/**
 * Per-user and per-agent charged-cost budgets (mirrors gateway BudgetConfig).
 * Keys are user/agent ids; values are budget rules.
 */
export interface GatewayBudgetConfig {
	agents: Record<string, BudgetRule>;
	/**
	 * A single GLOBAL per-session charged-cost cap (#510). Unlike `users`/`agents`,
	 * this is not a map: session ids are ephemeral (Core mints a fresh
	 * conversation id per chat), so one rule applies to every session. The
	 * shape is identical to a per-user/per-agent rule. `limit: 0` = off; values
	 * are charged micro-USD.
	 */
	session: BudgetRule;
	users: Record<string, BudgetRule>;
}

/**
 * Default (off) per-session budget rule used when the gateway omits one.
 *
 * `alert: "silent"` matches `impl Default for SessionBudgetConfig`
 * (`crates/gateway/budget/src/lib.rs`), which initialises `AlertTier::default()`
 * — so this fallback cannot claim a tier the gateway would not have.
 */
export const DEFAULT_SESSION_BUDGET: BudgetRule = {
	include: { ...DEFAULT_BUDGET_INCLUSION },
	limit: 0,
	action: "notify",
	alert: "silent",
	downgrade_to: null,
	restrict_max_tokens: 256,
};

/** Full redacted config returned by GET /v1/config (via Core proxy). */
export interface GatewayConfig {
	acp: GatewayAcpConfig;
	auth: GatewayAuthConfig;
	budgets: GatewayBudgetConfig;
	/** Node-wide computer-use policy. */
	computer_use: GatewayComputerUseConfig;
	/** Static policy drift projection retained for older Gateway clients. */
	drift?: GatewayDriftWarning[];
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
	marketplace_recommendations?: {
		cadence: "daily" | "weekly" | "monthly";
		enabled: boolean;
	};
	/** Resolved pipeline stages currently running in the gateway process. */
	pipeline_stages?: string[];
	providers: GatewayProvidersConfig;
	routing: GatewayRoutingConfig;
	/** Redacted tool-loop config returned by newer Gateways. */
	tools?: GatewayToolsConfig;
}

/** Persisted policy for computer-use providers attached to one node. */
export interface GatewayComputerUseConfig {
	/** Whether Ghost may request the platform's locked-session path. */
	locked_use: boolean;
}

export const DEFAULT_GATEWAY_COMPUTER_USE: GatewayComputerUseConfig = {
	locked_use: false,
};

/** Persisted ACP lifecycle controls plus Core's runtime-only status projection. */
export interface GatewayAcpConfig {
	/** Number of ACP processes currently admitted by Core. */
	active_agents?: number;
	/** Core's hardware-derived limit before a manual override. */
	auto_max_parallel_agents?: number;
	/** Core's chosen limit after applying Auto or the manual override. */
	effective_max_parallel_agents?: number;
	hardware?: {
		cpu_cores: number;
		physical_cores: number;
		total_ram_bytes: number;
	};
	/** Kill an inactive pooled ACP process after this many minutes. */
	idle_timeout_minutes: number;
	/** Keep the local computer awake while Core reports active ACP agents. */
	keep_computer_awake: boolean;
	/** `null` means Core calculates a conservative limit from CPU and RAM. */
	max_parallel_agents: number | null;
}

/** Only the persisted fields are writable; runtime status stays Core-owned. */
export type GatewayAcpSettings = Pick<
	GatewayAcpConfig,
	"idle_timeout_minutes" | "max_parallel_agents" | "keep_computer_awake"
>;

export const DEFAULT_GATEWAY_ACP: GatewayAcpConfig = {
	idle_timeout_minutes: 10,
	max_parallel_agents: null,
	keep_computer_awake: true,
};

export interface GatewayDriftWarning {
	code: string;
	message: string;
	severity: "high" | "medium" | string;
}

export type GatewayDoctorCategory =
	| "configuration"
	| "security"
	| "performance"
	| "connectivity"
	| "coverage";

export type GatewayDoctorSeverity = "info" | "warning" | "error";

export interface GatewayDoctorFinding {
	canAutoFix: boolean;
	category: GatewayDoctorCategory | string;
	checkId: string;
	detail: string;
	recommendedAction?: string;
	settingPath?: string;
	severity: GatewayDoctorSeverity;
	summary: string;
}

export interface GatewayDoctorReport {
	counts: { errors: number; warnings: number; info: number };
	error?: string;
	findings: GatewayDoctorFinding[];
	generatedAt?: number;
	posture?: string;
	profile?: string;
	reachable?: boolean;
	readOnly?: boolean;
	rulesetVersion?: string;
	schemaVersion?: string;
}

export interface GatewayDoctorFix {
	action: string;
	checkId: string;
	settingPath: string;
	summary: string;
}

export interface GatewayDoctorFixResult {
	appliedFixes: GatewayDoctorFix[];
	dryRun: boolean;
	plannedFixes: GatewayDoctorFix[];
	report: GatewayDoctorReport;
}

export interface GatewayToolsConfig {
	always_on: unknown[];
	describe_top_n: number;
	enabled: boolean;
	max_rounds: number;
	profiles: Record<string, unknown>;
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
	/** ACP lifecycle/resource controls for Core-owned subprocesses. */
	acp?: GatewayAcpSettings;
	/** When present, replaces the api_keys list. Must include ALL keys to keep. */
	auth?: { api_keys: GatewayApiKey[] };
	budgets?: GatewayBudgetConfig;
	/** Node-wide Ghost/computer-use policy. */
	computer_use?: GatewayComputerUseConfig;
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
	marketplace_recommendations?: {
		cadence: "daily" | "weekly" | "monthly";
		enabled: boolean;
	};
	/**
	 * Ryu's user-level routing config (persisted; takes effect after gateway restart).
	 * Runs before any upstream provider routing — this is the governance layer. PUT
	 * replaces the ENTIRE routing object, so always read-modify-write the full
	 * routing from GET before sending.
	 */
	routing?: GatewayRoutingConfig;
}

export const DEFAULT_SMART_ROUTING: SmartRoutingConfig = {
	enabled: false,
	router_type: "llm_classifier",
	strategy: "llm",
	classifier_model: "",
	embedding_model: "",
	similarity_threshold: 0.35,
	random_seed: null,
	stage_capable_model: "",
	stage_efficient_model: "",
	stage_picker: "capable_first",
	stage_confidence_threshold: 0.5,
	stage_recent_message_window: 3,
	escalation_weak_model: "",
	escalation_strong_model: "",
	escalation_judge_model: "",
	escalation_confirmations: 2,
	escalation_recent_message_window: 28,
	escalation_message_chars: 500,
	rules: [],
	default_model: null,
	cache_by_session: true,
	timeout_ms: 4000,
};

/**
 * Shape used only when a 2xx arrives with no `routing` section at all. It
 * deliberately omits `modality_map` / `eval_routing` / `smart_routing`: this
 * object stands in for "the gateway told us nothing", and manufacturing a
 * section here would assert something about the node that was never observed.
 *
 * `smart_routing` used to be listed here (and coalesced again in
 * {@link fetchGatewayConfig}), which contradicted the paragraph above and cost
 * the caller the one distinction that matters — see
 * {@link routingViewIncludesSmartRouting}.
 */
const DEFAULT_ROUTING: GatewayRoutingConfig = {
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
};

/**
 * Whether this gateway's `GET /v1/config` actually reported `routing.modality_map`.
 *
 * Read this before offering a modality editor, and read the reason carefully —
 * it is not defensive typing.
 *
 * `PUT /v1/config { routing }` assigns the section wholesale
 * (`apps/gateway/src/api/config.rs`: `updated_config.routing = routing.clone()`)
 * and `RoutingConfig::modality_map` is `#[serde(default)]`. So a PUT body that
 * OMITS `modality_map` deserializes to an empty map and replaces whatever was on
 * disk — omission and `{}` erase identically. There is no clobber guard on
 * `routing` (the one documented on `custom_evaluators` does not cover it).
 *
 * Consequence: against a gateway old enough that its `RoutingView` has no
 * `modality_map` field, the desktop cannot round-trip what it cannot see, and
 * ANY routing save from this app wipes a hand-written `[routing.modality_map]`
 * in `gateway.toml`. That is the A7 defect, and on such a node it is not
 * fixable from here — only reportable. Hence a presence check rather than
 * `?? {}`: the two states demand different UI, and coalescing hides the one
 * that destroys data.
 *
 * A gateway that DOES serve the field always emits the key (an empty
 * `HashMap` serializes as `{}`), so presence is an exact test.
 */
export function routingViewIncludesModalityMap(
	routing: GatewayRoutingConfig
): boolean {
	return "modality_map" in routing;
}

/**
 * Whether this gateway's `GET /v1/config` actually reported
 * `routing.smart_routing`.
 *
 * The same presence test as {@link routingViewIncludesModalityMap}, and for the
 * same structural reason: `PUT /v1/config { routing }` assigns the section
 * wholesale and `RoutingConfig::smart_routing` is `#[serde(default)]`
 * (`apps/gateway/src/config.rs`), so a PUT body that omits it deserializes to
 * `SmartRoutingConfig::default()` and replaces whatever was on disk. Omission
 * and an explicit default erase identically; against a gateway too old to serve
 * the field this is not fixable from here, only reportable.
 *
 * ## Why it needed its own predicate rather than a `??` default
 *
 * `fetchGatewayConfig` used to coalesce the field to
 * {@link DEFAULT_SMART_ROUTING}, which is exactly the move the modality-map work
 * ruled out for itself. The coalesce is worse here than it is for
 * `modality_map`, not milder: an unserved map coalesces to `{}` (nothing
 * claimed), whereas an unserved `smart_routing` coalesces to a *concrete*
 * `enabled: false` — a fabricated "classifier routing is off" that the desktop
 * then spreads back on the next save of any other routing field. That is the
 * healthy-status-for-a-dead-thing shape inverted: the card reports a setting the
 * node never told it about, and saving something unrelated turns the operator's
 * hand-written `[routing.smart_routing]` off.
 *
 * A gateway that DOES serve the field always emits the key (`SmartRoutingConfig`
 * is a plain struct on `RoutingView`, not an `Option`), so presence is an exact
 * test.
 *
 * ## Consumed by `SmartRoutingCard` (`GatewayDialog.tsx`)
 *
 * The card keeps a three-state `served` (`null` = not loaded, so a healthy
 * gateway does not flash a data-loss warning during its first fetch). When it is
 * `false` the card disables every control and says on screen that the switch
 * reads off because nothing was reported, not because routing is off.
 *
 * `cfg.routing.smart_routing ?? DEFAULT_SMART_ROUTING` survives at the load edge
 * and that is deliberate: a Switch or Select bound to `undefined` goes
 * uncontrolled. It is a *rendering* stand-in only — `served` carries the truth,
 * and `handleSave` refuses on anything but `served === true`, re-testing this
 * predicate against the freshly re-fetched config (the gateway can restart, or be
 * swapped for an older build, between mount and save) rather than trusting the
 * flag from mount.
 */
export function routingViewIncludesSmartRouting(
	routing: GatewayRoutingConfig
): boolean {
	return "smart_routing" in routing;
}

/**
 * Read-modify-write one `routing.modality_map` row, returning the FULL routing
 * object to PUT.
 *
 * Spread-based on purpose. Because `put_config` replaces the routing section
 * wholesale, every sibling field — `eval_routing`, `smart_routing`,
 * `provider_tiers`, `model_map`, and anything a newer gateway serves that this
 * TS interface has not learned about yet — has to ride along untouched. Spread
 * carries unknown keys; an object literal built field-by-field would not, and
 * that is exactly how `modality_map` came to be erased in the first place.
 *
 * @param routing The routing object as returned by a FRESH `GET` (never a stale
 *   snapshot — the gateway persists routing without updating its startup
 *   snapshot, so an old read spreads old values back over the file).
 * @param modality Which row to author.
 * @param mapping `null` clears the row so the modality falls back to ordinary
 *   model routing. Otherwise the provider id, plus a model that is OMITTED when
 *   blank — `Some("")` would be forwarded to the provider as a literal empty
 *   model name (`router/src/lib.rs` only substitutes the caller's model for
 *   `None`), whereas an absent key means "forward the caller's own model".
 */
export function withModalityMapping(
	routing: GatewayRoutingConfig,
	modality: Modality,
	mapping: { model?: string; provider: string } | null
): GatewayRoutingConfig {
	const next: Partial<Record<Modality, ModalityMapping>> = {
		...(routing.modality_map ?? {}),
	};
	if (mapping === null) {
		delete next[modality];
	} else {
		const model = mapping.model?.trim() ?? "";
		next[modality] = {
			provider: mapping.provider.trim(),
			...(model ? { model } : {}),
		};
	}
	return { ...routing, modality_map: next };
}

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
	const acp = raw.acp ?? DEFAULT_GATEWAY_ACP;
	const computerUse = raw.computer_use ?? DEFAULT_GATEWAY_COMPUTER_USE;
	// Guard the shared path: a 2xx always carries `firewall`, but this function
	// backs several cards (budgets/keys/routing), so never let a missing section
	// throw and take them all down.
	const firewall = raw.firewall ?? ({} as GatewayFirewallConfig);
	return {
		...raw,
		acp,
		computer_use: computerUse,
		budgets: {
			users: budgets.users ?? {},
			agents: budgets.agents ?? {},
			session: budgets.session ?? DEFAULT_SESSION_BUDGET,
		},
		// Passed through EXACTLY as served — no `smart_routing` (or `modality_map`,
		// or `eval_routing`) default folded in. Coalescing here would erase the
		// difference between "the gateway does not serve this section" and "it
		// serves it, switched off", and because the PUT replaces `routing`
		// wholesale the manufactured section rides back out on the next save of
		// anything else in the card. See {@link routingViewIncludesSmartRouting};
		// consumers that need a value to bind a control to coalesce at their own
		// edge, where they can also say which state they are in.
		routing,
		firewall: {
			...firewall,
			// Coalesced for the same reason as the three below: the guardrails card
			// binds a Select straight to this, and a `value={undefined}` Select renders
			// as an uncontrolled placeholder — which would then save an omitted tier.
			alert: firewall.alert ?? "silent",
			custom_patterns: firewall.custom_patterns ?? [],
			inspector: firewall.inspector ?? { ...DEFAULT_INSPECTOR },
			locked_fields: firewall.locked_fields ?? [],
		},
		firewall_org_overlays: raw.firewall_org_overlays ?? {},
		firewall_agent_overlays: raw.firewall_agent_overlays ?? {},
	};
}

/** Fetch the redacted Gateway + Core doctor report through Core's proxy. */
export async function fetchGatewayDoctor(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayDoctorReport> {
	return request<GatewayDoctorReport>(target, "/api/gateway/doctor", {
		signal,
	});
}

/** Preview or apply Gateway-owned safe Doctor fixes through Core. */
export async function fixGatewayDoctor(
	target: ApiTarget,
	dryRun: boolean
): Promise<GatewayDoctorFixResult> {
	return request<GatewayDoctorFixResult>(target, "/api/gateway/doctor/fix", {
		body: { dryRun },
		method: "POST",
	});
}

/**
 * Write a concrete id into any `inspector` whose `model` is blank/whitespace.
 *
 * Generic over the two shapes that carry an inspector — the node base
 * ({@link GatewayFirewallConfig}, `inspector?: InspectorConfig`) and an overlay
 * ({@link GatewayFirewallOverlay}, `inspector?: InspectorConfig | null`, where
 * `null` means "inherit, do not override"). A nullish inspector is returned
 * untouched, so "inherit" can never be turned into an override.
 *
 * Returns the SAME object when nothing needs changing; callers rely on identity to
 * avoid cloning a React draft that is already fine.
 *
 * `model` is typed `string`, but it is read defensively because this runs on a
 * transport path fed by whatever the gateway serialized: an inspector object
 * without the key would otherwise throw inside a save handler.
 */
function withResolvedInspectorModel<
	T extends { inspector?: InspectorConfig | null },
>(section: T): T {
	const inspector = section.inspector;
	if (!inspector) {
		return section;
	}
	const model =
		typeof inspector.model === "string" ? inspector.model.trim() : "";
	if (model !== "") {
		return section;
	}
	return { ...section, inspector: { ...inspector, model: CLASSIFY_MODEL_ID } };
}

/** {@link withResolvedInspectorModel} across one overlay store, identity-preserving. */
function withResolvedOverlayStore(
	store: Record<string, GatewayFirewallOverlay>
): Record<string, GatewayFirewallOverlay> {
	let changed = false;
	const next: Record<string, GatewayFirewallOverlay> = {};
	for (const [id, overlay] of Object.entries(store)) {
		const resolved = withResolvedInspectorModel(overlay);
		next[id] = resolved;
		changed ||= resolved !== overlay;
	}
	return changed ? next : store;
}

/**
 * Normalize a config patch so no `inspector.model` reaches the wire blank.
 *
 * WHY this is a transport concern and not a form concern. A blank model was never
 * the harmless "use the default" it reads as. The save travels desktop → Core
 * `PUT /api/gateway/config` → gateway `PUT /v1/config`, and Core reads the raw JSON
 * as it passes (`push_config` → `maybe_start_classify_tier` →
 * `patch_selects_classify_tier`, apps/core/src/sidecar/gateway.rs) to decide whether
 * to start `llamacpp-classify`. That predicate used to bail on an empty model, so a
 * blank meant "do not start the local classifier" — and THEN the gateway's
 * `de_inspector_model` resolved the same blank to the classify id and routed it at
 * the `classify` provider, whose port had nothing behind it. The inspector failed
 * open: the card said enabled, the action said Block, every turn was allowed. It
 * self-corrected only on a SECOND save, because that one carried the model the first
 * had persisted.
 *
 * Core's half of that bug is now fixed too (blank-and-enabled selects the tier), so
 * on a current node this function is NOT what makes the sidecar start. What it still
 * buys, and why it belongs on the transport rather than being deleted as redundant:
 * `PUT /api/gateway/config` is a generic authenticated proxy, so the Core on the far
 * side is whatever version that node runs — an older one still declines a blank —
 * and writing a concrete id keeps what is PERSISTED equal to what the card displays.
 * The two halves are deliberately asymmetric: Core's covers every other client of
 * that proxy, this one covers every Core version.
 *
 * The value written is {@link CLASSIFY_MODEL_ID}, which is byte-identical to what
 * the "Use it" button and {@link DEFAULT_INSPECTOR} already write, so this
 * introduces no divergence the UI did not already have — including the documented
 * KNOWN LIMIT on {@link fetchClassifyWeightsPresent} (a node whose registry id is
 * overridden resolves a different id inside the gateway; both ids still reach the
 * one `classify` provider via the router's builtin `gemma-3-270m` prefix).
 *
 * Overlay stores are normalized too, but for a NARROWER reason: Core's predicate
 * only ever reads `/firewall/inspector/model` at the top level, so an overlay-only
 * inspector never starts the sidecar regardless. Normalizing them keeps what is
 * persisted equal to what the card displays; it does not buy a sidecar start.
 *
 * Pure and exported for the tests: a patch with no firewall sections comes back
 * unchanged (by identity), and no input object is ever mutated — these patches are
 * React draft state.
 */
export function withResolvedInspectorModels(
	patch: GatewayConfigPatch
): GatewayConfigPatch {
	const firewall = patch.firewall
		? withResolvedInspectorModel(patch.firewall)
		: undefined;
	const orgOverlays = patch.firewall_org_overlays
		? withResolvedOverlayStore(patch.firewall_org_overlays)
		: undefined;
	const agentOverlays = patch.firewall_agent_overlays
		? withResolvedOverlayStore(patch.firewall_agent_overlays)
		: undefined;
	const changed =
		(firewall !== undefined && firewall !== patch.firewall) ||
		(orgOverlays !== undefined &&
			orgOverlays !== patch.firewall_org_overlays) ||
		(agentOverlays !== undefined &&
			agentOverlays !== patch.firewall_agent_overlays);
	if (!changed) {
		return patch;
	}
	return {
		...patch,
		...(firewall ? { firewall } : {}),
		...(orgOverlays ? { firewall_org_overlays: orgOverlays } : {}),
		...(agentOverlays ? { firewall_agent_overlays: agentOverlays } : {}),
	};
}

/**
 * Apply a partial config change to the gateway via Core's proxy
 * (`PUT /api/gateway/config`). Core forwards the body to the gateway's
 * `PUT /v1/config`, which accepts firewall, budgets, auth, and routing. Provider
 * credentials are environment-variable-only and cannot be set here.
 *
 * "Forwards" is not "ignores": Core inspects the body first to lazily start the
 * classify sidecar, which is why every patch passes through
 * {@link withResolvedInspectorModels} here — the one seam every firewall save in
 * the app funnels into — rather than at each card's save handler.
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
		body: withResolvedInspectorModels(patch),
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

// ── Live traffic (SSE via Core proxy) ────────────────────────────────────────
//
// Core proxies the gateway's admin-gated `GET /v1/traffic` SSE stream at
// `/api/gateway/traffic`, forwarding the gateway bearer token server-side so the
// desktop never holds the master key. The stream is seeded with the recent ring
// buffer on connect (newest last), then pushes every completed request as an
// `event: traffic` + `data:` pair.

/** A single redacted live-traffic event (the gateway's `/v1/traffic` payload). */
export interface TrafficEvent {
	/** API key, truncated to its prefix (`sk-sec***`). Never a full key. */
	api_key: string;
	/** Whether the gateway's own response cache answered. */
	cache_hit: boolean;
	/** Error message, when the request failed. */
	error: string | null;
	/** Event type — "model_call" for LLM calls. */
	event_type: string;
	/** Input tokens billed (0 on error). */
	input_tokens: number;
	/** Wall-clock latency in milliseconds. */
	latency_ms: number;
	/** Model name as seen by the gateway. */
	model: string;
	/** Output tokens billed (0 on error). */
	output_tokens: number;
	/** Provider that served the request (e.g. "openai", "anthropic"). */
	provider: string;
	/** Gateway-internal request id. */
	request_id: string;
	/** Core session/conversation id, when tagged. */
	session_id: string | null;
	/** ISO-8601 timestamp when the event was published. */
	ts: string;
}

/**
 * Subscribe to the gateway's live traffic feed via Core's proxy.
 *
 * Returns an unsubscribe function. The connection is created on demand and torn
 * down when the last subscriber unsubscribes. On gateway-down Core returns a
 * short `{ reachable: false }` JSON body instead of an SSE stream; the
 * subscription surfaces it as an error and closes (the caller reconnects via
 * its own retry loop).
 */
export function subscribeGatewayTraffic(
	target: ApiTarget,
	onEvent: (event: TrafficEvent) => void,
	onError?: (message: string) => void
): () => void {
	const url = apiUrl(target, "/api/gateway/traffic");
	const controller = new AbortController();
	const open = async (): Promise<void> => {
		try {
			const resp = await fetch(url, {
				headers: await requestHeaders(target),
				signal: controller.signal,
			});
			if (!resp.ok) {
				onError?.(`traffic feed returned ${resp.status}`);
				return;
			}
			const contentType = resp.headers.get("content-type") ?? "";
			if (!contentType.includes("text/event-stream")) {
				// Core answered a fail-soft JSON body (`{reachable:false}`) instead
				// of a stream — the gateway is down or auth-gated.
				const text = await resp.text().catch(() => "");
				let message = "traffic feed unavailable";
				try {
					const parsed = JSON.parse(text) as {
						error?: unknown;
						reachable?: boolean;
					};
					if (parsed.error) {
						message = `traffic feed: ${String(parsed.error)}`;
					} else if (parsed.reachable === false) {
						message = "traffic feed: gateway unreachable";
					}
				} catch {
					// Not JSON — fall through to the generic message.
				}
				onError?.(message);
				return;
			}

			const reader = resp.body?.getReader();
			if (!reader) {
				onError?.("traffic feed: no response body");
				return;
			}
			const decoder = new TextDecoder();
			let buffer = "";
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				// Split on event boundaries: `event: traffic\ndata: {…}\n\n`.
				while (true) {
					const idx = buffer.indexOf("\n\n");
					if (idx === -1) {
						break;
					}
					const frame = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					const dataLine = frame
						.split("\n")
						.find((l) => l.startsWith("data:"))
						?.slice(5)
						.trim();
					if (!dataLine || dataLine === "[DONE]") {
						continue;
					}
					try {
						const parsed = JSON.parse(dataLine) as TrafficEvent;
						onEvent(parsed);
					} catch {
						// Malformed frame — skip; the stream continues.
					}
				}
			}
		} catch (error) {
			if (controller.signal.aborted) {
				return; // Tear-down, not an error.
			}
			onError?.(error instanceof Error ? error.message : "traffic feed failed");
		}
	};

	void open();
	return () => controller.abort();
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
	/** Stable selected agent id for per-agent passport filtering. */
	agent_id: string | null;
	/** API key that made the request (always "***" in read responses). */
	api_key: string | null;
	/** Gateway backend that performed an execution or control operation. */
	backend: string | null;
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
	/** Provider used for the request (e.g. "openai", "anthropic"). */
	provider: string | null;
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

/** Filters accepted by fetchGatewayAudit. */
export interface GatewayAuditFilters {
	/** Filter by the stable agent id attached by Core. */
	agentId?: string;
	/** Return only entries that have an error. */
	errorsOnly?: boolean;
	/** Inclusive ISO timestamp lower bound. */
	from?: string;
	/** Maximum number of entries to return (gateway default: 100). */
	limit?: number;
	/** Filter by model provider. */
	model?: string;
	/** Filter by upstream provider. */
	provider?: string;
	/** Filter by Core session/conversation id. */
	sessionId?: string;
	/** Exclusive ISO timestamp upper bound. */
	until?: string;
}

/** One server-owned 15-minute usage aggregate. */
export interface GatewayUsageRollupEvent {
	agentSeconds: number;
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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsageSource(
	value: unknown
): value is GatewayUsageRollupEvent["source"] {
	return (
		value === "byok" ||
		value === "local" ||
		value === "managed" ||
		value === "self_hosted" ||
		value === "unknown"
	);
}

function isGatewayUsageRollupEvent(
	value: unknown
): value is GatewayUsageRollupEvent {
	if (!isUnknownRecord(value)) {
		return false;
	}
	return (
		typeof value.timestamp === "string" &&
		Number.isFinite(Date.parse(value.timestamp)) &&
		typeof value.provider === "string" &&
		typeof value.model === "string" &&
		isNullableString(value.memberId) &&
		isNullableString(value.nodeId) &&
		isNullableString(value.feature) &&
		isUsageSource(value.source) &&
		isNonNegativeInteger(value.inputTokens) &&
		isNonNegativeInteger(value.outputTokens) &&
		isNonNegativeInteger(value.requestCount) &&
		isNonNegativeInteger(value.errorCount) &&
		isNonNegativeInteger(value.latencyTotalMs) &&
		isNonNegativeInteger(value.latencySamples) &&
		isNonNegativeNumber(value.agentSeconds) &&
		(value.costMicroUsd === null || isNonNegativeInteger(value.costMicroUsd))
	);
}

/**
 * Parse an untrusted canonical usage response at the HTTP boundary.
 *
 * Exported because the control-plane organization endpoint uses the same wire
 * contract as the local gateway endpoint.
 */
export function parseGatewayUsageRollupResponse(
	value: unknown
): GatewayUsageRollupResponse {
	if (
		!isUnknownRecord(value) ||
		value.kind !== "rollup" ||
		value.bucketSeconds !== 900 ||
		!Array.isArray(value.events) ||
		(value.reachable !== undefined && typeof value.reachable !== "boolean") ||
		(value.status !== undefined && !isNonNegativeInteger(value.status))
	) {
		throw new Error("Gateway usage rollup response was malformed.");
	}
	const events: GatewayUsageRollupEvent[] = [];
	for (const event of value.events) {
		if (!isGatewayUsageRollupEvent(event)) {
			throw new Error("Gateway usage rollup response was malformed.");
		}
		events.push(event);
	}
	return {
		bucketSeconds: 900,
		events,
		kind: "rollup",
		...(value.reachable === undefined ? {} : { reachable: value.reachable }),
		...(value.status === undefined ? {} : { status: value.status }),
	};
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
	const path = qs.size > 0 ? `/api/gateway/audit?${qs}` : "/api/gateway/audit";
	const raw = await request<GatewayAuditResponse>(target, path, { signal });
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
	const value = await request<unknown>(
		target,
		`/api/gateway/audit/usage?${query}`,
		{ signal }
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
		currency: raw.currency ?? "USD",
		unit: raw.unit ?? "micro_usd",
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

/** Promptfoo-compatible per-assertion controls. */
export interface AssertionOptions {
	config?: Record<string, unknown>;
	metric?: string;
	provider?: string;
	rubric_prompt?: string;
	threshold?: number;
	transform?: string;
	weight?: number;
}

/** One assertion to evaluate against a case's response (internally tagged on kind). */
export type Assertion =
	| { kind: "contains"; options?: AssertionOptions; value: string }
	| { kind: "not_contains"; options?: AssertionOptions; value: string }
	| { kind: "equals"; options?: AssertionOptions; value: string }
	| { kind: "regex"; options?: AssertionOptions; value: string }
	| { kind: "icontains"; options?: AssertionOptions; value: string }
	| { kind: "starts_with"; options?: AssertionOptions; value: string }
	| { kind: "contains_any"; options?: AssertionOptions; value: string }
	| { kind: "contains_all"; options?: AssertionOptions; value: string }
	| { kind: "icontains_any"; options?: AssertionOptions; value: string }
	| { kind: "icontains_all"; options?: AssertionOptions; value: string }
	| { kind: "contains_json"; options?: AssertionOptions; value: string }
	| { kind: "is_html"; options?: AssertionOptions }
	| { kind: "is_xml"; options?: AssertionOptions }
	| { kind: "is_sql"; options?: AssertionOptions }
	| { kind: "is_refusal"; options?: AssertionOptions }
	| { kind: "moderation"; options?: AssertionOptions; value: string }
	| { kind: "javascript"; options?: AssertionOptions; value: string }
	| { kind: "python"; options?: AssertionOptions; value: string }
	| { kind: "ruby"; options?: AssertionOptions; value: string }
	| { kind: "webhook"; options?: AssertionOptions; value: string }
	| { kind: "is_json"; options?: AssertionOptions }
	| { kind: "json_valid"; options?: AssertionOptions }
	| { kind: "llm_judge"; options?: AssertionOptions; rubric: string }
	| { kind: "llm_rubric"; options?: AssertionOptions; rubric: string }
	| { kind: "factuality"; options?: AssertionOptions; rubric: string }
	| { kind: "context_faithfulness"; options?: AssertionOptions; rubric: string }
	| { kind: "answer_relevance"; options?: AssertionOptions; rubric: string };

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
	/** Optional ordered chat turns; when present the gateway replays these. */
	messages?: EvalMessage[];
	/** The single-turn prompt fallback. May contain {{vars}}. */
	prompt: string;
	/** Promptfoo-style threshold for the mean assertion score (0..1). */
	threshold?: number;
	/** Per-case {{var}} substitutions (prompt, system prompt, assertions). */
	vars?: Record<string, unknown>;
}

/** One ordered chat turn in a Promptfoo-compatible case. */
export interface EvalMessage {
	content: string;
	role: "assistant" | "system" | "user";
}

/** Per-case scores returned by the gateway eval runner. */
export interface EvalCaseScore {
	/** Mean assertion score in [0,1], before the case threshold is applied. */
	assertion_score: number;
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
	/** Run-level multi-turn prompt variant; rendered before each test case. */
	system_messages?: EvalMessage[];
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
