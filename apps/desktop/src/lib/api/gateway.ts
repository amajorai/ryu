import { appJsonValueSchema } from "@ryuhq/core-client/app-request-json.ts";
// apps/desktop/src/lib/api/gateway.ts
//
// Typed client for the Gateway observability surface, surfaced through Core's
// read-only proxy (`GET /api/gateway/status`). The proxy fetches the gateway's
// /health and /metrics and returns a combined snapshot, or a clear down state
// (`reachable: false`) when the gateway is unreachable while Core is still up.

import type { RyuJsonValue } from "@ryu/app-host/rpc";
import type {
	AssertionResult,
	BudgetChargeInclusion,
	EvalMessage,
	GatewayAuditFilters,
	GatewayCacheMetrics,
	GatewayCoreProviderView,
	GatewayFirewallPolicy,
	GatewayHealth,
	GatewayLocalProviderView,
	GatewayProviderMetrics,
	GatewayRequestMetrics,
	GatewayTokenMetrics,
	ModelRouterType,
	ProviderCircuitState,
	RedTeamStrategyResult,
	RouteStrategy,
	SmartRule,
	StagePicker,
} from "@ryuhq/core-client/gateway.ts";
import { z } from "zod";
import {
	ApiError,
	type ApiTarget,
	apiUrl,
	request,
	requestHeaders,
} from "./client.ts";
import {
	rawStatusResponseSchema5,
	rawStatusResponseSchema6,
	rawStatusResponseSchema7,
	rawStatusResponseSchema8,
} from "./gateway-audit-response-contracts.ts";
import {
	type GatewayJsonValue,
	gatewayJsonValueSchema,
} from "./gateway-json-contracts.ts";
import {
	fetchClassifyWeightsPresentResponseSchema0,
	rawStatusResponseSchema9,
} from "./gateway-redteam-response-contracts.ts";
import {
	fetchClassifyWeightsPresentResponseSchema,
	fetchEvaluatorsResponseSchema,
	gatewayDoctorFixResultResponseSchema,
	gatewayDoctorReportResponseSchema,
	gatewayProviderEditResultResponseSchema,
	rawStatusResponseSchema,
	retainValidatedResponse,
	updateGatewayConfigResponseSchema,
} from "./gateway-status-response-contracts.ts";
import {
	gatewayTrafficUnavailableSchema,
	parseTrafficFrame,
} from "./gateway-traffic-contracts.ts";
import { gatewayUsageWireSchema } from "./gateway-usage-contracts.ts";
import { restartGateway } from "./system.ts";

export type {
	AssertionResult,
	BudgetChargeInclusion,
	EvalMessage,
	GatewayAuditFilters,
	GatewayCacheMetrics,
	GatewayCoreProviderView,
	GatewayFirewallPolicy,
	GatewayHealth,
	GatewayLocalProviderView,
	GatewayProviderMetrics,
	GatewayRequestMetrics,
	GatewayTokenMetrics,
	ModelRouterType,
	ProviderCircuitState,
	RedTeamStrategyResult,
	RouteStrategy,
	SmartRule,
	StagePicker,
} from "@ryuhq/core-client/gateway.ts";

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

export interface RawStatus {
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
): GatewayMetrics["providerQuota"] {
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
): GatewayMetrics["providerHealth"] {
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
	const json = await request<RawStatus>(
		target,
		"/api/gateway/status",
		{
			signal,
		},
		rawStatusResponseSchema
	);
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
	 * Number of configured account keys (primary plus extras) for rotation. Key
	 * values stay redacted. Local Core can add/remove accounts without reading
	 * them back; standalone Gateways can also use `*_API_KEYS` or `api_keys`.
	 * Older gateways omit the field (treat `undefined` as 0).
	 */
	api_key_count?: number;
	base_url: string;
}

/**
 * Redacted view of the genai multi-provider backend. Lists only the adapter
 * kinds that have a configured key (e.g. "gemini"); key values are never sent.
 */
export type GatewaySdkContext =
	| { kind: "default" }
	| { kind: "vertex"; project: string; location: string }
	| { kind: "bedrock_api"; region: string }
	| { kind: "ollama"; base_url: string };

export interface GatewaySdkProviderView {
	account_count: number;
	account_scope: ByokProvider;
	accounts: { id: string; source: "stored" | "environment" | "fleet" }[];
	activation_error?: string | null;
	auth_kind: "api_key" | "bearer_token" | "no_auth";
	brand: string;
	configured: boolean;
	context?: GatewaySdkContext | null;
	context_kind: GatewaySdkContext["kind"];
	kind: string;
	label: string;
	operations: ("chat" | "stream" | "image")[];
	provider_id: string;
}

export interface GatewayGenAiProviderView {
	gemini_account_count?: number;
	keys: string[];
	sdk_providers?: GatewaySdkProviderView[];
}

/** Redacted provider config from GET /v1/config. */
export type GatewayAccountStrategy =
	| "round_robin"
	| "quota_first"
	| "fill_first"
	| "reset_first";

export interface GatewayProvidersConfig {
	accountDrainThresholds?: Record<string, number>;
	accountStrategies?: Record<string, GatewayAccountStrategy>;
	accounts?: Record<string, GatewayProviderAccount[]>;
	anthropic: GatewayProviderView | null;
	assemblyai?: GatewayProviderView | null;
	bfl?: GatewayProviderView | null;
	cohere?: GatewayProviderView | null;
	compatible?: Record<string, GatewayProviderView>;
	core: GatewayCoreProviderView | null;
	deepgram?: GatewayProviderView | null;
	elevenlabs?: GatewayProviderView | null;
	fal?: GatewayProviderView | null;
	genai: GatewayGenAiProviderView | null;
	google_tts?: { account_count: number; mode: string } | null;
	inworld?: GatewayProviderView | null;
	local: GatewayLocalProviderView | null;
	minimax?: GatewayProviderView | null;
	modal?: GatewayProviderView | null;
	openai: GatewayProviderView | null;
	openrouter: GatewayProviderView | null;
	polly?: { account_count: number; mode: string; region: string } | null;
	recraft?: GatewayProviderView | null;
	replicate?: GatewayProviderView | null;
	runway?: GatewayProviderView | null;
	stability?: GatewayProviderView | null;
	topaz?: GatewayProviderView | null;
}

/**
 * The provider kinds the gateway supports.
 * Values are lowercase strings matching the gateway's serde(rename_all = "lowercase").
 * `genai` is the multi-provider backend that serves native-format providers
 * (currently Gemini). The remaining direct chat-capable compatible backends are
 * separate registry IDs. Speech-only and embedding-only IDs are excluded.
 */
export type ProviderKind =
	| "openai"
	| "anthropic"
	| "local"
	| "openrouter"
	| "core"
	| "genai"
	| "mistral"
	| "huggingface"
	| "nvidia"
	| "together"
	| "fireworks";

/** A single model-to-provider mapping entry. */
export interface ModelMapping {
	provider: string;
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
export const MODALITIES = [
	"chat",
	"image",
	"tts",
	"stt",
	"video",
	"audio",
] as const;

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

export const MODEL_ROUTER_TYPE_LABELS = {
	llm_classifier: "LLM classifier",
	passthrough: "Passthrough",
	random: "Weighted random",
	stage_router: "Stage router",
	escalation: "Escalation",
} satisfies Record<ModelRouterType, string>;

export const MODEL_ROUTER_TYPE_DESCRIPTIONS = {
	llm_classifier: "match request rules by model, meaning, or words",
	passthrough: "keep the model requested by the caller",
	random: "split traffic across target models for experiments",
	stage_router: "use recent tool and progress signals per turn",
	escalation: "judge the trajectory and latch hard sessions upward",
} satisfies Record<ModelRouterType, string>;

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
export const ROUTE_STRATEGY_LABELS = {
	llm: "LLM classifier",
	embedding: "Embedding",
	keyword: "Keyword",
} satisfies Record<RouteStrategy, string>;

export const ROUTE_STRATEGY_FRIENDLY_LABELS = {
	llm: "Let a model decide",
	embedding: "Match on meaning",
	keyword: "Match on words",
} satisfies Record<RouteStrategy, string>;

export const ROUTE_STRATEGY_DESCRIPTIONS = {
	llm: "a cheap model reads the message and picks a rule",
	embedding: "cosine-match rule text against the message",
	keyword: "case-insensitive word match, zero cost",
} satisfies Record<RouteStrategy, string>;

export const ROUTE_STRATEGY_FRIENDLY_DESCRIPTIONS = {
	llm: "a small, cheap model reads the message and picks the rule that fits",
	embedding: "compares what the message means with what each rule describes",
	keyword: "looks for the rule's words in the message; free and instant",
} satisfies Record<RouteStrategy, string>;

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

/**
 * Gateway Plane A model routing ("custom routing instructions"). When enabled,
 * the selected `router_type` picks or preserves a target model before normal
 * model→provider routing runs. Fails open: any error keeps the originally
 * requested model. Takes effect after the gateway restarts.
 */
export interface SmartRoutingConfig {
	/**
	 * Per-agent pools keyed by agent id. Each narrows this node's pool for that
	 * agent's requests (OpenAI-compatible and gateway-routed ACP agents alike).
	 * Read from the global config only. Older gateways omit this field.
	 */
	agent_pools?: Record<string, RoutePool>;
	/**
	 * Per-agent routing overrides keyed by agent id: a whole config that
	 * replaces this one for that agent's requests (OpenAI-compatible and
	 * gateway-routed ACP agents alike). Read from the global config only.
	 * Older gateways omit this field.
	 */
	agent_routes?: Record<string, SmartRoutingConfig>;
	/**
	 * Model pool: case-insensitive globs (`*` wildcard) a routed target must
	 * match, e.g. `["*claude*", "gpt-*"]`. Empty ⇒ any model. Older gateways
	 * omit this field.
	 */
	allowed_models?: string[];
	/**
	 * Provider pool: provider ids (`anthropic`, `openrouter`, a compatible
	 * endpoint id, `core` for Core-hosted agents, …) a routed target may resolve
	 * to. Empty ⇒ any provider. Older gateways omit this field.
	 */
	allowed_providers?: string[];
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
export const PROVIDER_POOL_STRATEGIES = [
	"priority",
	"round_robin",
	"weighted_round_robin",
	"random",
	"least_used",
	"weighted",
	"fill_first",
	"p2c",
	"strict_random",
	"cost_optimized",
	"headroom",
	"reset_window",
	"reset_aware",
	"context_relay",
	"context_optimized",
	"cache_optimized",
	"lkgp",
	"auto",
	"fusion",
	"pipeline",
	"quota_weighted",
] as const;

export type ProviderPoolStrategy = (typeof PROVIDER_POOL_STRATEGIES)[number];

export const LEGACY_PROVIDER_POOL_STRATEGIES: readonly ProviderPoolStrategy[] =
	["priority", "round_robin", "weighted_round_robin", "random", "least_used"];

export function supportedProviderPoolStrategies(
	supported?: readonly ProviderPoolStrategy[]
): readonly ProviderPoolStrategy[] {
	return supported === undefined ? LEGACY_PROVIDER_POOL_STRATEGIES : supported;
}

export interface PoolExecutionConfig {
	grace_ms: number;
	leg_timeout_ms: number;
	max_output_bytes: number;
	quorum: number;
	total_timeout_ms: number;
}

export const DEFAULT_POOL_EXECUTION: PoolExecutionConfig = {
	leg_timeout_ms: 30_000,
	total_timeout_ms: 120_000,
	max_output_bytes: 262_144,
	quorum: 2,
	grace_ms: 250,
};

export const DEFAULT_POOL_AUTO_WEIGHTS = {
	quota: 0.1429,
	health: 0.1605,
	cost_inv: 0.1429,
	latency_inv: 0.1143,
	task_fit: 0.0762,
	stability: 0.0476,
	tier_priority: 0.0476,
	tier_affinity: 0.0476,
	specificity_match: 0.0476,
	context_affinity: 0.0476,
	cache_affinity: 0,
	session_availability: 0.0476,
	reset_window_affinity: 0,
	connection_density: 0.0476,
	quality: 0.03,
	reliability: 0,
};

export type AutoScoringWeights = typeof DEFAULT_POOL_AUTO_WEIGHTS;

export interface GatewayProviderPool {
	auto_weights?: Partial<AutoScoringWeights> | null;
	execution?: PoolExecutionConfig;
	judge?: { provider: string; model: string } | null;
	members: {
		provider: string;
		model: string;
		priority: number;
		weight: number;
		enabled: boolean;
		last_resort?: boolean;
		context_tokens?: number | null;
	}[];
	sticky_limit?: number;
	strategy: ProviderPoolStrategy;
	wait_for_cooldown_ms?: number;
}

/** UI boundary validation mirrors the bounded canonical pool config. */
export function providerPoolSettingsError(
	pool: GatewayProviderPool
): string | null {
	if (pool.auto_weights != null) {
		const values = Object.values(pool.auto_weights);
		if (
			values.some(
				(value) => !Number.isFinite(value) || value < 0 || value > 1000
			) ||
			values.reduce((total, value) => total + value, 0) <= 0
		) {
			return "Auto weights must be finite values from 0–1,000 with a positive total. Unset configured fields count as zero.";
		}
	}
	if (
		new Set(
			pool.members.map((member) =>
				JSON.stringify([member.provider, member.model.trim()])
			)
		).size !== pool.members.length
	) {
		return "Each exact provider/model target can appear only once in a pool.";
	}
	for (const member of pool.members) {
		if (
			member.context_tokens != null &&
			(!Number.isInteger(member.context_tokens) ||
				member.context_tokens < 1 ||
				member.context_tokens > 2_000_000)
		) {
			return "Model context capacity must be 1–2,000,000 tokens, or blank when unknown.";
		}
	}
	if (pool.strategy !== "fusion" && pool.strategy !== "pipeline") {
		return null;
	}
	const limits = pool.execution ?? DEFAULT_POOL_EXECUTION;
	const boundedFields: readonly [number, number, number][] = [
		[limits.leg_timeout_ms, 1, 30_000],
		[limits.total_timeout_ms, 1, 120_000],
		[limits.max_output_bytes, 1, 262_144],
		[limits.quorum, 1, 8],
		[limits.grace_ms, 0, 5000],
	];
	for (const [value, minimum, maximum] of boundedFields) {
		if (!Number.isInteger(value) || value < minimum || value > maximum) {
			return "Execution limits exceed the supported bounds.";
		}
	}
	if (limits.total_timeout_ms < limits.leg_timeout_ms) {
		return "Total timeout must be at least the per-target timeout.";
	}
	if (pool.members.filter((member) => member.enabled).length > 8) {
		return "Fusion and pipeline support at most eight enabled targets.";
	}
	if (
		pool.strategy === "fusion" &&
		(!pool.judge?.provider ||
			pool.judge.provider.startsWith("pool:") ||
			!pool.judge.model.trim())
	) {
		return "Fusion needs a connected judge provider and its exact model ID.";
	}
	if (
		pool.judge &&
		(new TextEncoder().encode(pool.judge.model).length > 256 ||
			Array.from(pool.judge.model).some((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || (code >= 127 && code <= 159);
			}))
	) {
		return "The judge model must be a valid exact upstream model ID, up to 256 characters.";
	}
	return null;
}

export interface GatewayRoutingConfig {
	/**
	 * Provider to use when no model-map entry matches. An OPEN `ProviderId`
	 * registry id (gateway `RoutingView`), not the closed {@link ProviderKind}
	 * union — `modal`, `replicate`, `fal` and custom providers are valid.
	 */
	default_provider: string;
	/**
	 * Eval-driven (A/B) routing. Optional on the wire — a gateway whose
	 * `RoutingView` predates this field omits it. Round-trip only; no editor.
	 */
	eval_routing?: EvalRoutingConfig;
	/**
	 * Ordered fallback chain used when the primary provider is unavailable.
	 * Open `ProviderId` registry ids, like {@link default_provider}.
	 */
	fallback_chain: string[];
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
	/** Named direct-provider pools; round-tripped even before the pool editor ships. */
	provider_pools?: Record<string, GatewayProviderPool>;
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

/**
 * The alert tiers, ASCENDING in severity — the wire form of the gateway's
 * `AlertTier` (`crates/gateway/contracts/src/lib.rs`, `rename_all = "lowercase"`,
 * so these are the variant names lowercased).
 *
 * Order is load-bearing, not cosmetic. The gateway takes the `max` tier across
 * every rule a request matched (`pipeline/budget.rs`, `max_tier`) before it stamps
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
export const CLASSIFY_TIER_COPY = {
	running: {
		reason: undefined,
		badge: "Local classifier running",
		hint: "Gemma 3 270M is loaded on this node — classification costs nothing and leaves no data.",
	},
	idle: {
		reason: undefined,
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
} satisfies Record<
	Exclude<ClassifyTierState, "unknown">,
	{ badge: string; hint: string; reason?: string }
>;

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
		{ signal },
		fetchClassifyWeightsPresentResponseSchema
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
		{ signal },
		fetchEvaluatorsResponseSchema
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
/** The desktop's fail-soft config view also supports an omitted legacy firewall. */
export interface GatewayFirewallView extends Partial<GatewayFirewallConfig> {
	alert: GatewayAlertTier;
	custom_patterns: CustomPattern[];
	inspector: InspectorConfig;
	locked_fields: string[];
}

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
	 * from the `firewall_policy_alert` call sites across `apps/gateway/src/pipeline/`:
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
	 * all six sites. Widening the three is a `pipeline/` change.
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
		const raw = String(input.restrictMaxTokens).trim();
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

export interface GatewayEgressConfig {
	assignments: Record<string, string>;
	pools: Record<
		string,
		{
			include_direct: boolean;
			direct_fallback_only?: boolean;
			endpoints: {
				id: string;
				url: string;
				enabled: boolean;
				priority?: number;
				username_env: string | null;
				password_env: string | null;
			}[];
		}
	>;
}

/** Full redacted config returned by GET /v1/config (via Core proxy). */
export interface GatewayConfig {
	acp: GatewayAcpConfig;
	appliedProviderRevision?: string | null;
	auth: GatewayAuthConfig;
	budgets: GatewayBudgetConfig;
	/** Node-wide computer-use policy. */
	computer_use: GatewayComputerUseConfig;
	configRevision?: string | null;
	/** Static policy drift projection retained for older Gateway clients. */
	drift?: GatewayDriftWarning[];
	/** Explicit outbound proxy pools. Older Gateways omit this section. */
	egress?: GatewayEgressConfig;
	firewall: GatewayFirewallView;
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
	providerEpoch?: { boot: string; sequence: number } | null;
	providers: GatewayProvidersConfig;
	routing: GatewayRoutingConfig;
	/** Explicit strategy support; absent on older nodes, not equivalent to empty. */
	strategyCapabilities?: {
		chat: ProviderPoolStrategy[];
		web: ProviderPoolStrategy[];
	};
	/** Redacted tool-loop config returned by newer Gateways. */
	tools?: GatewayToolsConfig;
	webServiceSchema?: 1;
}

/** Persisted policy for computer-use providers attached to one node. */
export interface GatewayComputerUseConfig {
	/** Whether Ghost may request the platform's locked-session path. */
	locked_use: boolean;
	/**
	 * Stored permission for features that use a hardware security key connected
	 * to this node. No current feature reads it. Absent on Gateways that predate
	 * the field.
	 */
	security_key?: boolean;
}

// `security_key` stays absent: a Gateway that sends no `computer_use` section
// predates the field, and the settings row treats absence as unsupported.
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
	idle_timeout_minutes: 5,
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

/** Gateway's config.rs ToolProfile serialization, including its defaulted lists. */
export interface GatewayToolProfile {
	allow: string[];
	deny: string[];
	unrestricted: boolean;
}

export interface GatewayToolsConfig {
	always_on: RyuJsonValue[];
	describe_top_n: number;
	enabled: boolean;
	max_rounds: number;
	/** Concurrent read-only tool calls per model step; absent on older Gateways. */
	parallel_reads?: number;
	profiles: Record<string, GatewayToolProfile>;
}

/**
 * A single gateway API key entry (as returned by GET /v1/config).
 * The `key` field is always `"***"` in GET responses; the real value is only
 * visible at creation time (returned by the generate helper, never by GET).
 */
export interface GatewayApiKey {
	allowed_operations?: GatewayClientOperation[];
	/** Always `"***"` in GET responses. */
	key: string;
	/** Human-readable label, e.g. "OpenClaw BYOA". */
	name: string;
	org_id?: string | null;
	/** Read-only metadata for a bootstrapped relay that cannot be revoked here. */
	system_relay?: boolean;
	team_id?: string | null;
	/** When true, the gateway honors `x-ryu-agent-id` for per-agent budgets. */
	trusted_forwarder: boolean;
}

export type GatewayClientOperation = "inference" | "web_search" | "web_fetch";

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
	/** Full replacement. Validated and applied after Gateway restarts. */
	egress?: GatewayEgressConfig;
	expectedRevision?: string;
	firewall?: Partial<GatewayFirewallConfig>;
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
	providerAccountDrainThresholds?: Record<string, number>;
	providerAccountPolicies?: Record<
		string,
		Record<string, Omit<GatewayProviderAccount, "id">>
	>;
	providerAccountStrategies?: Record<string, GatewayAccountStrategy>;
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
	allowed_models: [],
	allowed_providers: [],
	agent_pools: {},
	agent_routes: {},
};

/**
 * The auto-routing pool: which models and providers automatic model routing may
 * pick. Both lists must match; an empty list does not constrain. The gateway's
 * global `smart_routing` pool is the ceiling and a per-agent pool
 * (`smart_routing.agent_pools`) can only narrow it.
 */
export interface RoutePool {
	allowed_models: string[];
	allowed_providers: string[];
}

/** Split a comma- or newline-separated pool field into trimmed, unique entries. */
export function parsePoolList(text: string): string[] {
	const entries = text
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return [...new Set(entries)];
}

/** Render a pool list back into its editable comma-separated form. */
export function formatPoolList(entries: readonly string[] | undefined): string {
	return (entries ?? []).join(", ");
}

/** Whether a pool constrains nothing. */
export function isOpenRoutePool(pool: RoutePool): boolean {
	return (
		pool.allowed_models.length === 0 && pool.allowed_providers.length === 0
	);
}

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
	const next: GatewayRoutingConfig["modality_map"] = {
		...routing.modality_map,
	};
	if (mapping === null) {
		delete next[modality];
	} else {
		const model = mapping.model?.trim() ?? "";
		const entry: ModalityMapping = { provider: mapping.provider.trim() };
		if (model) {
			entry.model = model;
		}
		next[modality] = entry;
	}
	return { ...routing, modality_map: next };
}

/**
 * Rebuild the routing card's draft-plus-Save edits onto a FRESH routing read.
 * `PUT /v1/config { routing }` replaces the whole section, and the card's draft
 * is loaded once, so sending it as-is would revert whatever another surface
 * saved in the meantime (Smart Routing, eval routing, cost tiers, model map).
 *
 * Only what the draft changed relative to `base` (the copy it was loaded from)
 * is applied: the default provider, the fallback chain, and individual provider
 * tiers. Everything else, including unknown future keys, comes from `fresh`.
 */
export function withRoutingDraftEdits(
	fresh: GatewayRoutingConfig,
	base: GatewayRoutingConfig,
	draft: GatewayRoutingConfig
): GatewayRoutingConfig {
	const next: GatewayRoutingConfig = { ...fresh };
	if (draft.default_provider !== base.default_provider) {
		next.default_provider = draft.default_provider;
	}
	const chainChanged =
		draft.fallback_chain.length !== base.fallback_chain.length ||
		draft.fallback_chain.some(
			(provider, index) => provider !== base.fallback_chain[index]
		);
	if (chainChanged) {
		next.fallback_chain = [...draft.fallback_chain];
	}
	const tierEdits = Object.entries(draft.provider_tiers ?? {}).filter(
		([provider, tier]) => base.provider_tiers?.[provider] !== tier
	);
	if (tierEdits.length > 0) {
		next.provider_tiers = {
			...fresh.provider_tiers,
			...Object.fromEntries(tierEdits),
		};
	}
	return next;
}

/** JSON with object keys sorted, so map order from the gateway never matters. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))
				)
			: inner
	);
}

/**
 * Whether `fresh` still holds the guardrail sections `base` was loaded with.
 * The Guardrails Save replaces `firewall` and both overlay stores wholesale, so
 * only a change to those is a real conflict for it. The config revision covers
 * the whole file and also moves for unrelated saves (a provider key, routing),
 * which must not throw away a guardrails draft.
 */
export function sameGuardrailSections(
	base: GatewayConfig,
	fresh: GatewayConfig
): boolean {
	return (
		canonicalJson([
			base.firewall,
			base.firewall_org_overlays,
			base.firewall_agent_overlays,
		]) ===
		canonicalJson([
			fresh.firewall,
			fresh.firewall_org_overlays,
			fresh.firewall_agent_overlays,
		])
	);
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
	const raw = await request(
		target,
		"/api/gateway/config",
		{
			signal,
		},
		gatewayConfigResponseSchema
	);
	const routing = raw.routing ?? DEFAULT_ROUTING;
	const budgets = raw.budgets ?? { users: {}, agents: {}, session: undefined };
	const acp = raw.acp ?? DEFAULT_GATEWAY_ACP;
	const computerUse = raw.computer_use ?? DEFAULT_GATEWAY_COMPUTER_USE;
	// Guard the shared path: a 2xx always carries `firewall`, but this function
	// backs several cards (budgets/keys/routing), so never let a missing section
	// throw and take them all down.
	const firewall: Partial<GatewayFirewallConfig> = raw.firewall ?? {};
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
	return request<GatewayDoctorReport>(
		target,
		"/api/gateway/doctor",
		{
			signal,
		},
		gatewayDoctorReportResponseSchema
	);
}

/** Preview or apply Gateway-owned safe Doctor fixes through Core. */
export async function fixGatewayDoctor(
	target: ApiTarget,
	dryRun: boolean
): Promise<GatewayDoctorFixResult> {
	return request<GatewayDoctorFixResult>(
		target,
		"/api/gateway/doctor/fix",
		{
			body: { dryRun },
			method: "POST",
		},
		gatewayDoctorFixResultResponseSchema
	);
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
	T extends { inspector?: Partial<InspectorConfig> | null },
>(section: T): T {
	const inspector = section.inspector;
	if (!inspector) {
		return section;
	}
	const parsedModel = z.string().safeParse(inspector.model);
	const model = parsedModel.success ? parsedModel.data.trim() : "";
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
/** Legacy draft inputs may omit inspector fields before Gateway deserialization. */
export type GatewayConfigPatchInput = Omit<GatewayConfigPatch, "firewall"> & {
	firewall?: Omit<Partial<GatewayFirewallConfig>, "inspector"> & {
		inspector?: Partial<InspectorConfig>;
	};
};

export function withResolvedInspectorModels<T extends GatewayConfigPatchInput>(
	patch: T
): T {
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
	const resolved = { ...patch };
	if (firewall) {
		resolved.firewall = firewall;
	}
	if (orgOverlays) {
		resolved.firewall_org_overlays = orgOverlays;
	}
	if (agentOverlays) {
		resolved.firewall_agent_overlays = agentOverlays;
	}
	return resolved;
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
	return request<{ ok: boolean }>(
		target,
		"/api/gateway/config",
		{
			method: "PUT",
			body: withResolvedInspectorModels(patch),
			signal,
		},
		updateGatewayConfigResponseSchema
	);
}

/** Thrown when the gateway does not report `routing.smart_routing`. */
export class SmartRoutingUnavailableError extends Error {
	constructor() {
		super(
			"This gateway does not report smart routing, so it has no routing pools."
		);
		this.name = "SmartRoutingUnavailableError";
	}
}

/** One agent's routing pool from the gateway config, or null when it has none. */
export async function fetchAgentRoutePool(
	target: ApiTarget,
	agentId: string
): Promise<RoutePool | null> {
	const cfg = await fetchGatewayConfig(target);
	if (!routingViewIncludesSmartRouting(cfg.routing)) {
		throw new SmartRoutingUnavailableError();
	}
	return cfg.routing.smart_routing?.agent_pools?.[agentId] ?? null;
}

/**
 * Set (or clear, for null or an open pool) one agent's routing pool. Reads the
 * current routing and writes it back whole with only this agent's entry
 * changed, because `PUT /v1/config` replaces the routing section wholesale.
 * Refuses when the gateway does not serve `smart_routing`, so a fabricated
 * default can never overwrite a hand-written config.
 */
export async function saveAgentRoutePool(
	target: ApiTarget,
	agentId: string,
	pool: RoutePool | null
): Promise<void> {
	await updateSmartRouting(target, (current) => {
		const agentPools = { ...(current.agent_pools ?? {}) };
		if (pool === null || isOpenRoutePool(pool)) {
			delete agentPools[agentId];
		} else {
			agentPools[agentId] = pool;
		}
		return { ...current, agent_pools: agentPools };
	});
}

/**
 * One agent's stored routing override (`smart_routing.agent_routes`), or null
 * when it routes with the node's smart routing.
 */
export async function fetchAgentRouteOverride(
	target: ApiTarget,
	agentId: string
): Promise<SmartRoutingConfig | null> {
	const cfg = await fetchGatewayConfig(target);
	if (!routingViewIncludesSmartRouting(cfg.routing)) {
		throw new SmartRoutingUnavailableError();
	}
	return cfg.routing.smart_routing?.agent_routes?.[agentId] ?? null;
}

/**
 * Set (or clear, for null) one agent's stored routing override. The gateway
 * applies it to every request attributed to the agent, ACP agents included.
 * Same read-merge-write and refusal rules as {@link saveAgentRoutePool}.
 */
export async function saveAgentRouteOverride(
	target: ApiTarget,
	agentId: string,
	config: SmartRoutingConfig | null
): Promise<void> {
	await updateSmartRouting(target, (current) => {
		const agentRoutes = { ...(current.agent_routes ?? {}) };
		if (config === null) {
			delete agentRoutes[agentId];
		} else {
			// An override's own per-agent maps are ignored by the gateway; keep
			// them off the wire so the stored entry stays small.
			const { agent_pools: _pools, agent_routes: _routes, ...own } = config;
			agentRoutes[agentId] = own;
		}
		return { ...current, agent_routes: agentRoutes };
	});
}

/** Attempts per save before a revision conflict is surfaced to the caller. */
const SMART_ROUTING_SAVE_ATTEMPTS = 3;

/** Tail of the in-flight smart-routing saves, per gateway target. */
const smartRoutingSaveQueues = new Map<string, Promise<void>>();

/**
 * Read the gateway config, apply `mutate` to `routing.smart_routing`, and write
 * the whole routing section back (`PUT /v1/config` replaces it wholesale).
 * Refuses when the gateway does not serve `smart_routing`, so a fabricated
 * default can never overwrite a hand-written config.
 *
 * Lost updates are prevented two ways. Saves to the same target run one after
 * another, each reading the config the previous one wrote. Every write also
 * carries the read's `expectedRevision`, so a write that lands in between
 * (another window, or the Gateway dialog's own revision-checked save) makes the
 * gateway answer 409; `mutate` only changes this caller's entry, so it is
 * re-applied to a fresh read instead of overwriting the other change.
 */
function updateSmartRouting(
	target: ApiTarget,
	mutate: (current: SmartRoutingConfig) => SmartRoutingConfig
): Promise<void> {
	const key = target.url;
	const previous = smartRoutingSaveQueues.get(key) ?? Promise.resolve();
	const run = previous
		.catch(() => undefined)
		.then(() => writeSmartRouting(target, mutate));
	const tail = run.catch(() => undefined);
	smartRoutingSaveQueues.set(key, tail);
	tail.then(() => {
		if (smartRoutingSaveQueues.get(key) === tail) {
			smartRoutingSaveQueues.delete(key);
		}
	});
	return run;
}

async function writeSmartRouting(
	target: ApiTarget,
	mutate: (current: SmartRoutingConfig) => SmartRoutingConfig
): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		const cfg = await fetchGatewayConfig(target);
		const current = cfg.routing.smart_routing;
		if (!(routingViewIncludesSmartRouting(cfg.routing) && current)) {
			throw new SmartRoutingUnavailableError();
		}
		try {
			await updateGatewayConfig(target, {
				routing: { ...cfg.routing, smart_routing: mutate(current) },
				expectedRevision: cfg.configRevision ?? undefined,
			});
			return;
		} catch (error) {
			const conflict = error instanceof ApiError && error.status === 409;
			if (!conflict || attempt >= SMART_ROUTING_SAVE_ATTEMPTS) {
				throw error;
			}
		}
	}
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
	const result = await updateGatewayConfig(
		target,
		{ custom_evaluators: customEvaluators },
		signal
	);
	// Current gateways apply custom evaluators live and report
	// `applied.restartRequired: false`. An older gateway that omits the receipt
	// still reads them only at startup, so it is restarted as before.
	// restartGateway never throws for the externally-managed / failure cases.
	if (configUpdateNeedsRestart(result)) {
		await restartGateway(target);
	}
}

/** Whether a `PUT /api/gateway/config` receipt asks for a gateway restart. */
export function configUpdateNeedsRestart(receipt: object): boolean {
	if (!("applied" in receipt)) {
		return true;
	}
	const applied = receipt.applied;
	if (typeof applied !== "object" || applied === null) {
		return true;
	}
	return !("restartRequired" in applied) || applied.restartRequired !== false;
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
export type ByokProvider =
	| "openai"
	| "anthropic"
	| "openrouter"
	| "gemini"
	| "voyage"
	| "jina"
	| "mistral"
	| "huggingface"
	| "nvidia"
	| "together"
	| "fireworks"
	| "qwen"
	| "cohere"
	| "deepgram"
	| "assemblyai"
	| "elevenlabs"
	| "inworld"
	| "modal"
	| "replicate"
	| "fal"
	| "recraft"
	| "stability"
	| "bfl"
	| "minimax"
	| "runway"
	| "topaz"
	| `genai-${string}`;

export interface GatewayProviderAccount {
	drainThresholdPercent?: number | null;
	enabled: boolean;
	id: string;
	name: string;
	priority: number;
	source?: "stored" | "environment" | "fleet";
}

export type GatewayProviderApplication =
	| {
			status: "applied" | "already_applied";
			requestedRevision: string;
			appliedRevision: string;
			epoch: { boot: string; sequence: number };
	  }
	| { status: "superseded"; requestedRevision: string; currentRevision: string }
	| {
			status: "failed";
			requestedRevision: string;
			activeRevision?: string | null;
			code: string;
	  }
	| { status: "offline" | "unmanaged"; requestedRevision: string };

export interface GatewayProviderEditResult {
	accountsApplied?: boolean;
	configRevision?: string;
	gateway_application?: GatewayProviderApplication;
	gateway_outcome?: string;
	gateway_restarted: boolean;
	persisted?: boolean;
	success: boolean;
}

export function applySavedGatewayProviderConnections(
	target: ApiTarget,
	revision: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers/apply",
		{
			method: "POST",
			body: { revision },
		},
		gatewayProviderEditResultResponseSchema
	);
}

export async function configureGatewayProviderAccount(
	target: ApiTarget,
	provider: ByokProvider,
	account: GatewayProviderAccount,
	expectedRevision?: string
): Promise<void> {
	const result = await request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				account_action: "configure",
				expectedRevision,
				accountId: account.id,
				accountPolicy: {
					drain_threshold_percent: account.drainThresholdPercent ?? null,
					name: account.name,
					enabled: account.enabled,
					priority: account.priority,
				},
			},
		},
		gatewayProviderEditResultResponseSchema
	);
	requireGatewayProviderReload(result);
}

export async function setGatewaySdkConnection(
	target: ApiTarget,
	provider: ByokProvider,
	options: {
		apiKey?: string;
		context?: GatewaySdkContext;
		allowEnvironment?: boolean;
		accountId?: string;
		expectedRevision?: string;
	}
): Promise<void> {
	const result = await request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				account_action: options.accountId ? "replace" : "set",
				api_key: options.apiKey,
				sdkContext: options.context,
				allowEnvironment: options.allowEnvironment,
				accountId: options.accountId,
				expectedRevision: options.expectedRevision,
			},
		},
		gatewayProviderEditResultResponseSchema
	);
	requireGatewayProviderReload(result);
}

export function requireGatewayProviderReload(
	result: GatewayProviderEditResult
): void {
	const application = result.gateway_application;
	if (application) {
		switch (application.status) {
			case "applied":
			case "already_applied":
				if (
					application.requestedRevision !== application.appliedRevision ||
					(result.configRevision &&
						result.configRevision !== application.appliedRevision)
				) {
					throw new Error(
						"Connection saved, but Gateway acknowledged a different configuration. Refresh the node before editing again."
					);
				}
				return;
			case "superseded":
				throw new Error(
					"Connection saved, but a newer configuration replaced it. Refresh the node before editing again."
				);
			case "offline":
				throw new Error(
					"Connection saved. Start your Gateway and refresh the node to apply it."
				);
			case "unmanaged":
				throw new Error(
					"Connection saved. Restart your externally managed Gateway to apply it."
				);
			case "failed":
				throw new Error(
					"Connection saved, but Gateway could not apply it. Refresh the node and check its status before retrying."
				);
			default: {
				const exhaustive: never = application;
				void exhaustive;
				throw new Error(
					"Gateway returned an unknown application result. Refresh the node before editing again."
				);
			}
		}
	}
	if (result.gateway_restarted || result.accountsApplied) {
		return;
	}
	if (result.gateway_outcome === "unmanaged") {
		throw new Error(
			"Connection saved. Restart your externally managed Gateway to apply it."
		);
	}
	throw new Error(
		"Connection saved, but Gateway restart did not finish. Check its status before retrying."
	);
}

/** Set (or overwrite) a provider API key in the gateway config. */
export async function setGatewayProvider(
	target: ApiTarget,
	provider: ByokProvider,
	apiKey: string,
	signal?: AbortSignal,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: { provider, api_key: apiKey, expectedRevision },
			signal,
		},
		gatewayProviderEditResultResponseSchema
	);
}

/** Remove a provider key from the gateway config. */
export async function clearGatewayProvider(
	target: ApiTarget,
	provider: ByokProvider,
	signal?: AbortSignal,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: { provider, api_key: null, expectedRevision },
			signal,
		},
		gatewayProviderEditResultResponseSchema
	);
}

/** Replace the stored credential identified by its stable account ID. */
export function replaceGatewayProviderAccount(
	target: ApiTarget,
	provider: ByokProvider,
	accountId: string,
	apiKey: string,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				account_action: "replace",
				accountId,
				api_key: apiKey,
				expectedRevision,
			},
		},
		gatewayProviderEditResultResponseSchema
	);
}

/** Add another credential to a provider's Gateway rotation set. */
export async function addGatewayProviderAccount(
	target: ApiTarget,
	provider: ByokProvider,
	apiKey: string,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				api_key: apiKey,
				account_action: "add",
				expectedRevision,
			},
		},
		gatewayProviderEditResultResponseSchema
	);
}

/** Remove one credential by its index in the redacted Gateway account list. */
export async function removeGatewayProviderAccount(
	target: ApiTarget,
	provider: ByokProvider,
	accountIndex: number,
	accountId?: string,
	expectedRevision?: string
): Promise<GatewayProviderEditResult> {
	return request<GatewayProviderEditResult>(
		target,
		"/api/gateway/providers",
		{
			method: "PUT",
			body: {
				provider,
				account_action: "remove",
				expectedRevision,
				...(accountId ? { accountId } : { account_index: accountIndex }),
			},
		},
		gatewayProviderEditResultResponseSchema
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
	return updateGatewayConfig(target, {
		auth: { api_keys: next },
		expectedRevision: cfg.configRevision ?? undefined,
	});
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
	return updateGatewayConfig(target, {
		auth: { api_keys: next },
		expectedRevision: cfg.configRevision ?? undefined,
	});
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
	command?: string | null;
	/** A hosted credential id, truncated to its prefix. */
	credential_id_prefix?: string | null;
	/** Whose credential the request spent (`node_operator`, `ryu_vault`, ...). */
	credential_origin?: string | null;
	custody?: string | null;
	/** Error message, when the request failed. */
	error: string | null;
	/** Event type — "model_call" for LLM calls. */
	event_type: string;
	/** Input tokens billed (0 on error). */
	input_tokens: number;
	/**
	 * Which row of the request this is. This and the other optional verdict
	 * feed fields (spec 07.2) are absent on older gateways.
	 */
	kind?: "completion" | "verdict" | "cache_hit" | "failure";
	/** Wall-clock latency in milliseconds. */
	latency_ms: number;
	/** Model name, absent for a direct service call. */
	model: string | null;
	org_id?: string | null;
	/** Output tokens billed (0 on error). */
	output_tokens: number;
	/** Provider that served the request (e.g. "openai", "anthropic"). */
	provider: string;
	provider_cost_micro_usd?: number | null;
	/** Gateway-internal request id. */
	request_id: string;
	/** The matched route template, never the raw path. */
	route?: string | null;
	/** Strictly increasing per gateway process; dedupes a reconnect replay. */
	seq?: number;
	service_usage?: {
		requests: number;
		documents: number;
		provider_credits: number | null;
		cost_source:
			| "provider_reported"
			| "configured_estimate"
			| "unpriced"
			| "unsettled";
		cost_is_estimate: boolean;
	} | null;
	/** Core session/conversation id, when tagged. */
	session_id: string | null;
	stage_latency_ms?: { screen: number | null; upstream: number | null } | null;
	/** HTTP status the client received, when known. */
	status?: number | null;
	team_ids?: string[] | null;
	/** ISO-8601 timestamp when the event was published. */
	ts: string;
	/** What the deciding layer did. Names layers and codes, never text. */
	verdict?: TrafficVerdict | null;
}

/** The redacted verdict summary on a traffic event (spec 00.6). */
export interface TrafficVerdict {
	action: "allow" | "warn" | "sanitize" | "block";
	categories: string[];
	code?: string | null;
	decided_by: string;
	/** Why the screener ran in a reduced mode, when it did. */
	degraded?: string | null;
	detector_ids: string[];
	evaluator_ids: string[];
	event_id?: string | null;
}

/**
 * Subscribe to the gateway's live traffic feed via Core's proxy.
 *
 * Returns an unsubscribe function. The connection is created on demand and torn
 * down when the last subscriber unsubscribes. On gateway-down Core returns a
 * short `{ reachable: false }` JSON body instead of an SSE stream; the
 * subscription surfaces it as an error and closes (the caller reconnects via
 * its own retry loop). A non-2xx answer also reports its HTTP `status`, so a
 * caller can stop retrying a permission refusal (403) that a reconnect cannot
 * change. `onOpen` fires once the stream is open, before any row arrives.
 * `onEnd` fires when the stream closes cleanly (a gateway restart), so a
 * caller that dedupes the replay can reconnect.
 */
export function subscribeGatewayTraffic(
	target: ApiTarget,
	onEvent: (event: TrafficEvent) => void,
	onError?: (message: string, detail?: { status: number }) => void,
	onEnd?: () => void,
	onOpen?: () => void
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
				onError?.(`traffic feed returned ${resp.status}`, {
					status: resp.status,
				});
				return;
			}
			const contentType = resp.headers.get("content-type") ?? "";
			if (!contentType.includes("text/event-stream")) {
				// Core answered a fail-soft JSON body (`{reachable:false}`) instead
				// of a stream — the gateway is down or auth-gated.
				const text = await resp.text().catch(() => "");
				let message = "traffic feed unavailable";
				try {
					const parsed = gatewayTrafficUnavailableSchema.parse(
						JSON.parse(text)
					);
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
			onOpen?.();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (!controller.signal.aborted) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					buffer += decoder.decode(value, { stream: true });
					// Split on event boundaries: `event: traffic\ndata: {…}\n\n`.
					while (!controller.signal.aborted) {
						const idx = buffer.indexOf("\n\n");
						if (idx === -1) {
							break;
						}
						const frame = buffer.slice(0, idx);
						buffer = buffer.slice(idx + 2);
						const parsed = parseTrafficFrame(frame);
						if (parsed) {
							onEvent(parsed);
						}
					}
				}
			} finally {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
			if (!controller.signal.aborted) {
				onEnd?.();
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

// ── Eval dataset runner (M4 / #180) ──────────────────────────────────────────
//
// Scorers: latency / token_efficiency / policy_pass / optional substring_match,
// plus promptfoo-style per-case assertions (deterministic + llm_judge),
// run-level system prompts, {{var}} substitution, and multi-model compare.

/** Promptfoo-compatible per-assertion controls. */
export interface AssertionOptions {
	config?: Record<string, GatewayJsonValue>;
	metric?: string;
	not?: boolean;
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
	| { kind: "contains_html"; options?: AssertionOptions; value: string }
	| { kind: "contains_xml"; options?: AssertionOptions; value: string }
	| { kind: "contains_sql"; options?: AssertionOptions; value: string }
	| { kind: "levenshtein"; options?: AssertionOptions; value: string }
	| { kind: "latency"; options?: AssertionOptions; value: string }
	| { kind: "cost"; options?: AssertionOptions; value: string }
	| {
			assertions: Assertion[];
			kind: "assert_set";
			options?: AssertionOptions;
	  }
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
	| { kind: "similar"; options?: AssertionOptions; value: string }
	| { kind: "factuality"; options?: AssertionOptions; rubric: string }
	| { kind: "context_faithfulness"; options?: AssertionOptions; rubric: string }
	| { kind: "answer_relevance"; options?: AssertionOptions; rubric: string };

/** A single case in an eval dataset. */
export interface EvalDatasetCase {
	/** Assertions to evaluate against this case's response. */
	assertions?: Assertion[];
	/** Optional reference/context payload for factuality and faithfulness checks. */
	context?: unknown;
	/** Human-readable case description. */
	description?: string;
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
	/** Stable case id used in persisted result matrices. */
	id?: string;
	/** Optional ordered chat turns; when present the gateway replays these. */
	messages?: EvalMessage[];
	/** Case metadata preserved in results and exports. */
	metadata?: Record<string, GatewayJsonValue>;
	/** Promptfoo-compatible per-case prompt/output options. */
	options?: {
		cache?: boolean;
		prefix?: string;
		suffix?: string;
		timeout_ms?: number;
		transform?: string;
		transform_vars?: string;
	};
	/** The single-turn prompt fallback. May contain {{vars}}. */
	prompt: string;
	/** Optional per-case provider/model target. */
	provider?: string;
	/** Exact provider-reported row cost in micro-USD when the response omits it. */
	provider_cost_micro_usd?: number;
	/** Externally measured operation turnaround in milliseconds. */
	provider_latency_ms?: number;
	/** Precomputed provider output; skips a live provider call. */
	provider_output?: unknown;
	provider_output_policy_pass?: boolean;
	/** Source label for a precomputed provider response. */
	provider_output_provider?: string;
	/** Optional per-case provider/model alternatives. */
	providers?: string[];
	/** Promptfoo-style threshold for the mean assertion score (0..1). */
	threshold?: number;
	/** Per-case {{var}} substitutions (prompt, system prompt, assertions). */
	vars?: Record<string, GatewayJsonValue>;
}

/** Per-case scores returned by the gateway eval runner. */
export interface EvalCaseScore {
	/** Mean assertion score in [0,1], before the case threshold is applied. */
	assertion_score: number;
	/** NEW: per-assertion results (always present; [] when no assertions). */
	assertions: AssertionResult[];
	/** NEW: true iff every assertion passed (vacuously true for []). */
	assertions_pass: boolean;
	cache_hit?: boolean;
	/** Optional reference/context payload preserved for result inspection. */
	context?: unknown;
	cost_micro_usd?: number | null;
	description?: string;
	error?: string | null;
	/**
	 * Per-evaluator scores for the registry evaluators requested for this case.
	 * Present ([] when none requested). Additive to `overall`; never folded in.
	 */
	evaluators?: EvaluatorScore[];
	id?: string;
	input_tokens?: number;
	latency_available?: boolean;
	latency_ms?: number;
	/** 1.0 = instant, 0.0 = at/beyond max_latency_ms. */
	latency_score: number;
	metadata?: Record<string, RyuJsonValue>;
	model?: string;
	output_tokens?: number;
	/** Weighted aggregate for this case. Range [0, 1]. */
	overall: number;
	policy_available?: boolean;
	/** Whether the request passed all firewall/policy checks. */
	policy_pass: boolean;
	prompt: string;
	prompt_id?: string;
	provider?: string;
	rendered_prompt?: string;
	/** The response text the provider returned (or an error message). */
	response_text: string;
	/** Present only when the case had an expected value. */
	substring_match: number | null;
	/** Ratio output/input tokens clamped to [0,1]. */
	token_efficiency: number;
	total_tokens?: number;
	vars?: Record<string, RyuJsonValue>;
}

/** Aggregate summary across all eval cases. */
export interface EvalRunAggregate {
	assertion_pass_rate?: number;
	/**
	 * Per-evaluator aggregate keyed by evaluator id. Empty when no registry
	 * evaluators were requested. Values are camelCase (`meanScore`/`passRate`/
	 * `executedCount`) even though the parent key is snake_case.
	 */
	evaluators?: Record<string, EvaluatorAggregate>;
	latency_available_cases?: number;
	mean_latency: number;
	/** Mean overall score across all cases. Range [0, 1]. */
	mean_overall: number;
	/** Mean substring match across cases that had an expected value. null when none did. */
	mean_substring_match: number | null;
	mean_token_efficiency: number;
	policy_available_cases?: number;
	/** Fraction of cases where policy_pass was true. Range [0, 1]. */
	policy_pass_rate: number;
	total_cases: number;
	total_cost_micro_usd?: number | null;
	total_input_tokens?: number;
	total_output_tokens?: number;
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
	finished_at?: string;
	/** Present ONLY on the multi-model path; absent on single-model. */
	models?: ModelEvalResult[];
	run_id?: string;
	started_at?: string;
	tags?: Record<string, string>;
}

/** Response from POST /api/gateway/redteam/run (via Core's proxy). */
export interface RedTeamRunResult {
	campaign_id: string;
	model: string;
	result?: EvalRunResult;
	strategies: RedTeamStrategyResult[];
	summary: {
		needs_attention: number;
		protected: number;
		total: number;
	};
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
	/** Reuse identical provider inputs within this run. */
	cache?: boolean;
	/**
	 * Custom Code evaluators. Pulled out by the Core proxy and run locally
	 * (Core's JS sandbox for JS, the sandbox backend for Python); their scores are merged into each
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
	/** Maximum provider calls in flight. */
	max_concurrency?: number;
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
	/** Run-level prompt prefix/suffix. */
	prefix?: string;
	/** Stable prompt variant id for result matrices. */
	prompt_id?: string;
	/** Repeat each dataset case this many times. */
	repeat?: number;
	suffix?: string;
	/** Run-level multi-turn prompt variant; rendered before each test case. */
	system_messages?: EvalMessage[];
	/**
	 * Run-level system prompt; the server prepends it as a system message per
	 * case and substitutes any {{vars}} using that case's `vars`.
	 */
	system_prompt?: string;
	/** Run tags preserved in the result envelope. */
	tags?: Record<string, string>;
	/** Per-provider call deadline in milliseconds. */
	timeout_ms?: number;
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
	return await request<EvalRunResult>(
		target,
		"/api/gateway/evals/run",
		{
			method: "POST",
			body: gatewayJsonValueSchema.parse(req),
			signal,
		},
		rawStatusResponseSchema8
	);
}

/** Score a completed production output without replaying its provider call. */
export async function scoreGatewayOutput(
	target: ApiTarget,
	input: {
		agent_id?: string;
		assertions?: Assertion[];
		cost_micro_usd?: number;
		description?: string;
		evaluators?: string[];
		expected?: string;
		id?: string;
		latency_ms?: number;
		metadata?: Record<string, GatewayJsonValue>;
		model?: string;
		policy_pass?: boolean;
		prompt?: string;
		response: unknown;
		threshold?: number;
		vars?: Record<string, GatewayJsonValue>;
	},
	signal?: AbortSignal
): Promise<{ kind: "online_score"; score: EvalCaseScore; scored_at: string }> {
	return await request(
		target,
		"/api/gateway/evals/score",
		{
			method: "POST",
			body: gatewayJsonValueSchema.parse(input),
			signal,
		},
		rawStatusResponseSchema9
	);
}

/**
 * Run the closed, safe local red-team probe set through the same Gateway path
 * as production traffic. The server owns the probe prompts and evaluator
 * mapping so callers cannot silently widen the campaign's security scope.
 */
export async function runGatewayRedTeam(
	target: ApiTarget,
	input: {
		agent_id: string;
		model?: string;
		strategies?: string[];
	},
	signal?: AbortSignal
): Promise<RedTeamRunResult> {
	return await request<RedTeamRunResult>(
		target,
		"/api/gateway/redteam/run",
		{
			method: "POST",
			body: gatewayJsonValueSchema.parse(input),
			signal,
		},
		fetchClassifyWeightsPresentResponseSchema0
	);
}

const gatewayConfigResponseSchema = retainValidatedResponse(
	z
		.object({
			acp: z
				.object({
					active_agents: z.number().optional(),
					auto_max_parallel_agents: z.number().optional(),
					effective_max_parallel_agents: z.number().optional(),
					hardware: z
						.object({
							cpu_cores: z.number(),
							physical_cores: z.number(),
							total_ram_bytes: z.number(),
						})
						.passthrough()
						.optional(),
					idle_timeout_minutes: z.number(),
					keep_computer_awake: z.boolean(),
					max_parallel_agents: z.union([z.number(), z.null()]),
				})
				.passthrough()
				.nullish(),
			appliedProviderRevision: z.union([z.string(), z.null()]).optional(),
			auth: z
				.object({
					api_keys: z.array(
						z
							.object({
								allowed_operations: z
									.array(
										z.union([
											z.literal("inference"),
											z.literal("web_search"),
											z.literal("web_fetch"),
										])
									)
									.optional(),
								key: z.string(),
								name: z.string(),
								org_id: z.union([z.string(), z.null()]).optional(),
								system_relay: z.boolean().optional(),
								team_id: z.union([z.string(), z.null()]).optional(),
								trusted_forwarder: z.boolean(),
							})
							.passthrough()
					),
					require_auth: z.boolean(),
				})
				.passthrough(),
			budgets: z
				.object({
					agents: z.record(
						z.string(),
						z
							.object({
								action: z.union([
									z.literal("notify"),
									z.literal("downgrade"),
									z.literal("restrict"),
									z.literal("stop"),
								]),
								alert: z.enum(ALERT_TIERS).optional(),
								downgrade_to: z.union([z.string(), z.null()]).optional(),
								include: z
									.object({
										media: z.boolean(),
										model: z.boolean(),
										tools: z.boolean(),
									})
									.passthrough()
									.optional(),
								limit: z.number(),
								restrict_max_tokens: z.number().optional(),
							})
							.passthrough()
					),
					session: z
						.object({
							action: z.union([
								z.literal("notify"),
								z.literal("downgrade"),
								z.literal("restrict"),
								z.literal("stop"),
							]),
							alert: z.enum(ALERT_TIERS).optional(),
							downgrade_to: z.union([z.string(), z.null()]).optional(),
							include: z
								.object({
									media: z.boolean(),
									model: z.boolean(),
									tools: z.boolean(),
								})
								.passthrough()
								.optional(),
							limit: z.number(),
							restrict_max_tokens: z.number().optional(),
						})
						.passthrough(),
					users: z.record(
						z.string(),
						z
							.object({
								action: z.union([
									z.literal("notify"),
									z.literal("downgrade"),
									z.literal("restrict"),
									z.literal("stop"),
								]),
								alert: z.enum(ALERT_TIERS).optional(),
								downgrade_to: z.union([z.string(), z.null()]).optional(),
								include: z
									.object({
										media: z.boolean(),
										model: z.boolean(),
										tools: z.boolean(),
									})
									.passthrough()
									.optional(),
								limit: z.number(),
								restrict_max_tokens: z.number().optional(),
							})
							.passthrough()
					),
				})
				.passthrough()
				.partial()
				.nullish(),
			computer_use: z
				.object({
					locked_use: z.boolean(),
					security_key: z.boolean().optional(),
				})
				.passthrough()
				.nullish(),
			configRevision: z.union([z.string(), z.null()]).optional(),
			drift: z
				.array(
					z
						.object({
							code: z.string(),
							message: z.string(),
							severity: z.union([
								z.literal("high"),
								z.literal("medium"),
								z.string(),
							]),
						})
						.passthrough()
				)
				.optional(),
			egress: z
				.object({
					assignments: z.record(z.string(), z.string()),
					pools: z.record(
						z.string(),
						z
							.object({
								include_direct: z.boolean(),
								direct_fallback_only: z.boolean().optional(),
								endpoints: z.array(
									z
										.object({
											id: z.string(),
											url: z.string(),
											enabled: z.boolean(),
											priority: z.number().optional(),
											username_env: z.union([z.string(), z.null()]),
											password_env: z.union([z.string(), z.null()]),
										})
										.passthrough()
								),
							})
							.passthrough()
					),
				})
				.passthrough()
				.optional(),
			firewall: z
				.intersection(
					z
						.object({
							alert: z.enum(ALERT_TIERS).optional(),
							custom_patterns: z
								.array(
									z
										.object({
											kind: z.union([
												z.literal("pii"),
												z.literal("secret"),
												z.literal("prompt_injection"),
											]),
											name: z.string(),
											regex: z.string(),
										})
										.passthrough()
								)
								.optional(),
							enabled: z.boolean().optional(),
							evaluators: z
								.array(
									z
										.object({
											enabled: z.boolean(),
											id: z.string(),
											inlineAction: z
												.union([
													z.union([
														z.literal("block"),
														z.literal("warn_and_continue"),
														z.literal("sanitize"),
													]),
													z.null(),
												])
												.optional(),
											locked: z.boolean().optional(),
											offline: z
												.union([
													z
														.object({
															judgeModel: z
																.union([z.string(), z.null()])
																.optional(),
															threshold: z.number(),
														})
														.passthrough(),
													z.null(),
												])
												.optional(),
										})
										.passthrough()
								)
								.optional(),
							inspector: z
								.object({
									action: z.union([
										z.literal("block"),
										z.literal("warn_and_continue"),
										z.literal("sanitize"),
									]),
									enabled: z.boolean(),
									min_chars: z.number(),
									mode: z.union([
										z.literal("injection"),
										z.literal("dlp"),
										z.literal("both"),
									]),
									model: z.string(),
									timeout_ms: z.number(),
								})
								.passthrough()
								.optional(),
							locked_fields: z.array(z.string()).optional(),
							log_detections: z.boolean().optional(),
							policy: z
								.union([
									z.literal("block"),
									z.literal("warn_and_continue"),
									z.literal("sanitize"),
								])
								.optional(),
							redact_pii: z.boolean().optional(),
							redact_secrets: z.boolean().optional(),
							scan_inbound: z.boolean().optional(),
							scan_outbound: z.boolean().optional(),
							wrap_untrusted_tool_results: z.boolean().optional(),
						})
						.passthrough(),
					z
						.object({
							alert: z.enum(ALERT_TIERS),
							custom_patterns: z.array(
								z
									.object({
										kind: z.union([
											z.literal("pii"),
											z.literal("secret"),
											z.literal("prompt_injection"),
										]),
										name: z.string(),
										regex: z.string(),
									})
									.passthrough()
							),
							inspector: z
								.object({
									action: z.union([
										z.literal("block"),
										z.literal("warn_and_continue"),
										z.literal("sanitize"),
									]),
									enabled: z.boolean(),
									min_chars: z.number(),
									mode: z.union([
										z.literal("injection"),
										z.literal("dlp"),
										z.literal("both"),
									]),
									model: z.string(),
									timeout_ms: z.number(),
								})
								.passthrough(),
							locked_fields: z.array(z.string()),
						})
						.passthrough()
						.partial()
				)
				.nullish(),
			firewall_agent_overlays: z
				.record(
					z.string(),
					z
						.object({
							alert: z.union([z.enum(ALERT_TIERS), z.null()]).optional(),
							custom_patterns: z
								.array(
									z
										.object({
											kind: z.union([
												z.literal("pii"),
												z.literal("secret"),
												z.literal("prompt_injection"),
											]),
											name: z.string(),
											regex: z.string(),
										})
										.passthrough()
								)
								.optional(),
							enabled: z.union([z.boolean(), z.null()]).optional(),
							evaluators: z
								.array(
									z
										.object({
											enabled: z.boolean(),
											id: z.string(),
											inlineAction: z
												.union([
													z.union([
														z.literal("block"),
														z.literal("warn_and_continue"),
														z.literal("sanitize"),
													]),
													z.null(),
												])
												.optional(),
											locked: z.boolean().optional(),
											offline: z
												.union([
													z
														.object({
															judgeModel: z
																.union([z.string(), z.null()])
																.optional(),
															threshold: z.number(),
														})
														.passthrough(),
													z.null(),
												])
												.optional(),
										})
										.passthrough()
								)
								.optional(),
							inspector: z
								.union([
									z
										.object({
											action: z.union([
												z.literal("block"),
												z.literal("warn_and_continue"),
												z.literal("sanitize"),
											]),
											enabled: z.boolean(),
											min_chars: z.number(),
											mode: z.union([
												z.literal("injection"),
												z.literal("dlp"),
												z.literal("both"),
											]),
											model: z.string(),
											timeout_ms: z.number(),
										})
										.passthrough(),
									z.null(),
								])
								.optional(),
							locked_fields: z.array(z.string()).optional(),
							log_detections: z.union([z.boolean(), z.null()]).optional(),
							policy: z
								.union([
									z.union([
										z.literal("block"),
										z.literal("warn_and_continue"),
										z.literal("sanitize"),
									]),
									z.null(),
								])
								.optional(),
							redact_pii: z.union([z.boolean(), z.null()]).optional(),
							redact_secrets: z.union([z.boolean(), z.null()]).optional(),
							scan_inbound: z.union([z.boolean(), z.null()]).optional(),
							scan_outbound: z.union([z.boolean(), z.null()]).optional(),
							wrap_untrusted_tool_results: z
								.union([z.boolean(), z.null()])
								.optional(),
						})
						.passthrough()
				)
				.nullish(),
			firewall_org_overlays: z
				.record(
					z.string(),
					z
						.object({
							alert: z.union([z.enum(ALERT_TIERS), z.null()]).optional(),
							custom_patterns: z
								.array(
									z
										.object({
											kind: z.union([
												z.literal("pii"),
												z.literal("secret"),
												z.literal("prompt_injection"),
											]),
											name: z.string(),
											regex: z.string(),
										})
										.passthrough()
								)
								.optional(),
							enabled: z.union([z.boolean(), z.null()]).optional(),
							evaluators: z
								.array(
									z
										.object({
											enabled: z.boolean(),
											id: z.string(),
											inlineAction: z
												.union([
													z.union([
														z.literal("block"),
														z.literal("warn_and_continue"),
														z.literal("sanitize"),
													]),
													z.null(),
												])
												.optional(),
											locked: z.boolean().optional(),
											offline: z
												.union([
													z
														.object({
															judgeModel: z
																.union([z.string(), z.null()])
																.optional(),
															threshold: z.number(),
														})
														.passthrough(),
													z.null(),
												])
												.optional(),
										})
										.passthrough()
								)
								.optional(),
							inspector: z
								.union([
									z
										.object({
											action: z.union([
												z.literal("block"),
												z.literal("warn_and_continue"),
												z.literal("sanitize"),
											]),
											enabled: z.boolean(),
											min_chars: z.number(),
											mode: z.union([
												z.literal("injection"),
												z.literal("dlp"),
												z.literal("both"),
											]),
											model: z.string(),
											timeout_ms: z.number(),
										})
										.passthrough(),
									z.null(),
								])
								.optional(),
							locked_fields: z.array(z.string()).optional(),
							log_detections: z.union([z.boolean(), z.null()]).optional(),
							policy: z
								.union([
									z.union([
										z.literal("block"),
										z.literal("warn_and_continue"),
										z.literal("sanitize"),
									]),
									z.null(),
								])
								.optional(),
							redact_pii: z.union([z.boolean(), z.null()]).optional(),
							redact_secrets: z.union([z.boolean(), z.null()]).optional(),
							scan_inbound: z.union([z.boolean(), z.null()]).optional(),
							scan_outbound: z.union([z.boolean(), z.null()]).optional(),
							wrap_untrusted_tool_results: z
								.union([z.boolean(), z.null()])
								.optional(),
						})
						.passthrough()
				)
				.nullish(),
			marketplace_recommendations: z
				.object({
					cadence: z.union([
						z.literal("daily"),
						z.literal("weekly"),
						z.literal("monthly"),
					]),
					enabled: z.boolean(),
				})
				.passthrough()
				.optional(),
			pipeline_stages: z.array(z.string()).optional(),
			providerEpoch: z
				.union([
					z.object({ boot: z.string(), sequence: z.number() }).passthrough(),
					z.null(),
				])
				.optional(),
			providers: z
				.object({
					accountDrainThresholds: z.record(z.string(), z.number()).optional(),
					accountStrategies: z
						.record(
							z.string(),
							z.union([
								z.literal("round_robin"),
								z.literal("quota_first"),
								z.literal("fill_first"),
								z.literal("reset_first"),
							])
						)
						.optional(),
					accounts: z
						.record(
							z.string(),
							z.array(
								z
									.object({
										drainThresholdPercent: z
											.union([z.number(), z.null()])
											.optional(),
										enabled: z.boolean(),
										id: z.string(),
										name: z.string(),
										priority: z.number(),
										source: z
											.union([
												z.literal("stored"),
												z.literal("environment"),
												z.literal("fleet"),
											])
											.optional(),
									})
									.passthrough()
							)
						)
						.optional(),
					anthropic: z.union([
						z
							.object({
								api_key: z.string(),
								api_key_count: z.number().optional(),
								base_url: z.string(),
							})
							.passthrough(),
						z.null(),
					]),
					assemblyai: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					bfl: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					cohere: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					compatible: z
						.record(
							z.string(),
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough()
						)
						.optional(),
					core: z.union([
						z
							.object({ base_url: z.string(), has_token: z.boolean() })
							.passthrough(),
						z.null(),
					]),
					deepgram: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					elevenlabs: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					fal: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					genai: z.union([
						z
							.object({
								gemini_account_count: z.number().optional(),
								keys: z.array(z.string()),
								sdk_providers: z
									.array(
										z
											.object({
												account_count: z.number(),
												account_scope: z.union([
													z.literal("openai"),
													z.literal("anthropic"),
													z.literal("openrouter"),
													z.literal("gemini"),
													z.literal("voyage"),
													z.literal("jina"),
													z.literal("mistral"),
													z.literal("huggingface"),
													z.literal("nvidia"),
													z.literal("together"),
													z.literal("fireworks"),
													z.literal("qwen"),
													z.literal("cohere"),
													z.literal("deepgram"),
													z.literal("assemblyai"),
													z.literal("elevenlabs"),
													z.literal("inworld"),
													z.literal("modal"),
													z.literal("replicate"),
													z.literal("fal"),
													z.literal("recraft"),
													z.literal("stability"),
													z.literal("bfl"),
													z.literal("minimax"),
													z.literal("runway"),
													z.literal("topaz"),
													z.templateLiteral(["genai-", z.string()]),
												]),
												accounts: z.array(
													z
														.object({
															id: z.string(),
															source: z.union([
																z.literal("stored"),
																z.literal("environment"),
																z.literal("fleet"),
															]),
														})
														.passthrough()
												),
												activation_error: z
													.union([z.string(), z.null()])
													.optional(),
												auth_kind: z.union([
													z.literal("api_key"),
													z.literal("bearer_token"),
													z.literal("no_auth"),
												]),
												brand: z.string(),
												configured: z.boolean(),
												context: z
													.union([
														z.union([
															z
																.object({ kind: z.literal("default") })
																.passthrough(),
															z
																.object({
																	kind: z.literal("vertex"),
																	project: z.string(),
																	location: z.string(),
																})
																.passthrough(),
															z
																.object({
																	kind: z.literal("bedrock_api"),
																	region: z.string(),
																})
																.passthrough(),
															z
																.object({
																	kind: z.literal("ollama"),
																	base_url: z.string(),
																})
																.passthrough(),
														]),
														z.null(),
													])
													.optional(),
												context_kind: z.union([
													z.literal("default"),
													z.literal("vertex"),
													z.literal("bedrock_api"),
													z.literal("ollama"),
												]),
												kind: z.string(),
												label: z.string(),
												operations: z.array(
													z.union([
														z.literal("chat"),
														z.literal("stream"),
														z.literal("image"),
													])
												),
												provider_id: z.string(),
											})
											.passthrough()
									)
									.optional(),
							})
							.passthrough(),
						z.null(),
					]),
					google_tts: z
						.union([
							z
								.object({ account_count: z.number(), mode: z.string() })
								.passthrough(),
							z.null(),
						])
						.optional(),
					inworld: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					local: z.union([
						z.object({ base_url: z.string() }).passthrough(),
						z.null(),
					]),
					minimax: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					modal: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					openai: z.union([
						z
							.object({
								api_key: z.string(),
								api_key_count: z.number().optional(),
								base_url: z.string(),
							})
							.passthrough(),
						z.null(),
					]),
					openrouter: z.union([
						z
							.object({
								api_key: z.string(),
								api_key_count: z.number().optional(),
								base_url: z.string(),
							})
							.passthrough(),
						z.null(),
					]),
					polly: z
						.union([
							z
								.object({
									account_count: z.number(),
									mode: z.string(),
									region: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					recraft: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					replicate: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					runway: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					stability: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
					topaz: z
						.union([
							z
								.object({
									api_key: z.string(),
									api_key_count: z.number().optional(),
									base_url: z.string(),
								})
								.passthrough(),
							z.null(),
						])
						.optional(),
				})
				.passthrough(),
			routing: z
				.object({
					// Open `ProviderId` registry ids (gateway `RoutingView`), not the closed
					// `ProviderKind` union: `modal`, `replicate`, `fal` and custom providers
					// are valid routing targets.
					default_provider: z.string(),
					eval_routing: z
						.object({
							candidates: z.array(z.string()),
							enabled: z.boolean(),
							explore_ratio: z.number(),
						})
						.passthrough()
						.optional(),
					fallback_chain: z.array(z.string()),
					modality_map: z
						.partialRecord(
							z.enum(MODALITIES),
							z
								.object({
									model: z.union([z.string(), z.null()]).optional(),
									provider: z.string(),
								})
								.passthrough()
						)
						.optional(),
					model_map: z.record(
						z.string(),
						z
							.object({
								provider: z.string(),
								provider_model: z.union([z.string(), z.null()]).optional(),
							})
							.passthrough()
					),
					provider_pools: z
						.record(
							z.string(),
							z
								.object({
									auto_weights: z
										.union([
											z
												.object({
													quota: z.number(),
													health: z.number(),
													cost_inv: z.number(),
													latency_inv: z.number(),
													task_fit: z.number(),
													stability: z.number(),
													tier_priority: z.number(),
													tier_affinity: z.number(),
													specificity_match: z.number(),
													context_affinity: z.number(),
													cache_affinity: z.number(),
													session_availability: z.number(),
													reset_window_affinity: z.number(),
													connection_density: z.number(),
													quality: z.number(),
													reliability: z.number(),
												})
												.passthrough()
												.partial(),
											z.null(),
										])
										.optional(),
									execution: z
										.object({
											grace_ms: z.number(),
											leg_timeout_ms: z.number(),
											max_output_bytes: z.number(),
											quorum: z.number(),
											total_timeout_ms: z.number(),
										})
										.passthrough()
										.optional(),
									judge: z
										.union([
											z
												.object({ provider: z.string(), model: z.string() })
												.passthrough(),
											z.null(),
										])
										.optional(),
									members: z.array(
										z
											.object({
												provider: z.string(),
												model: z.string(),
												priority: z.number(),
												weight: z.number(),
												enabled: z.boolean(),
												last_resort: z.boolean().optional(),
												context_tokens: z
													.union([z.number(), z.null()])
													.optional(),
											})
											.passthrough()
									),
									sticky_limit: z.number().optional(),
									strategy: z.enum(PROVIDER_POOL_STRATEGIES),
									wait_for_cooldown_ms: z.number().optional(),
								})
								.passthrough()
						)
						.optional(),
					provider_tiers: z.record(z.string(), z.number()).optional(),
					smart_routing: z
						.object({
							cache_by_session: z.boolean(),
							classifier_model: z.string(),
							default_model: z.union([z.string(), z.null()]).optional(),
							embedding_model: z.string(),
							enabled: z.boolean(),
							escalation_confirmations: z.number().optional(),
							escalation_judge_model: z.string().optional(),
							escalation_message_chars: z.number().optional(),
							escalation_recent_message_window: z.number().optional(),
							escalation_strong_model: z.string().optional(),
							escalation_weak_model: z.string().optional(),
							random_seed: z.union([z.number(), z.null()]).optional(),
							router_type: z
								.union([
									z.literal("llm_classifier"),
									z.literal("passthrough"),
									z.literal("random"),
									z.literal("stage_router"),
									z.literal("escalation"),
								])
								.optional(),
							rules: z.array(
								z
									.object({
										description: z.string(),
										model: z.string(),
										weight: z.number().optional(),
									})
									.passthrough()
							),
							similarity_threshold: z.number(),
							stage_capable_model: z.string().optional(),
							stage_confidence_threshold: z.number().optional(),
							stage_efficient_model: z.string().optional(),
							stage_picker: z
								.union([
									z.literal("capable_first"),
									z.literal("efficient_first"),
								])
								.optional(),
							stage_recent_message_window: z.number().optional(),
							strategy: z.union([
								z.literal("llm"),
								z.literal("embedding"),
								z.literal("keyword"),
							]),
							timeout_ms: z.number(),
						})
						.passthrough()
						.optional(),
				})
				.passthrough()
				.nullish(),
			strategyCapabilities: z
				.object({
					chat: z.array(z.enum(PROVIDER_POOL_STRATEGIES)),
					web: z.array(z.enum(PROVIDER_POOL_STRATEGIES)),
				})
				.passthrough()
				.optional(),
			tools: z
				.object({
					always_on: z.array(appJsonValueSchema),
					describe_top_n: z.number(),
					enabled: z.boolean(),
					max_rounds: z.number(),
					parallel_reads: z.number().optional(),
					profiles: z.record(
						z.string(),
						z
							.object({
								allow: z.array(z.string()),
								deny: z.array(z.string()),
								unrestricted: z.boolean(),
							})
							.passthrough()
					),
				})
				.passthrough()
				.optional(),
			webServiceSchema: z.literal(1).optional(),
		})
		.passthrough()
);
