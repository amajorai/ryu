import type {
	ModelRouterType,
	RouteStrategy,
	SmartRule,
	StagePicker,
} from "@ryuhq/core-client/gateway.ts";
import type {
	EvalRoutingConfig,
	Modality,
	ModalityMapping,
	ModelMapping,
} from "./gateway-provider-config.ts";
import type { RoutePool } from "./gateway-routing-helpers.ts";

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
