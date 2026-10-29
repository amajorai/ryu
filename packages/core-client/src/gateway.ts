// packages/core-client/src/gateway.ts
//
// Typed client for the Gateway observability surface, surfaced through Core's
// read-only proxy (`GET /api/gateway/status`). The proxy fetches the gateway's
// /health and /metrics and returns a combined snapshot, or a clear down state
// (`reachable: false`) when the gateway is unreachable while Core is still up.
//
// ── WHAT THIS FILE IS, AND WHAT IT IS NOT ────────────────────────────────────
//
// It started as a *subset fork* of `apps/desktop/src/lib/api/gateway.ts`, not a
// shared core the desktop delegates to. The header above used to literally read
// `// apps/desktop/src/lib/api/gateway.ts`, which is how the two came to drift:
// the desktop file grew evaluators, `modality_map`, `eval_routing`,
// `provider_tiers`, the firewall inspector, budget spend and the classify-tier
// helpers; none of that exists here. Reconciling the two clients is a real
// piece of work and deliberately out of scope for the fix below.
//
// The wire *types* are shared, though: `apps/desktop/src/lib/api/gateway.ts`
// re-exports the overlapping response types from this module, as do the CLI,
// extension, native app and GitHub Action. A change to an exported type here
// changes the desktop's public types with no edit to the desktop, so keep every
// exported type compatible with the desktop's consumers (run
// `bun run --cwd apps/desktop check-types` when you change one).
//
// It is NOT dead code, though, and that is the reason the fix below matters:
// this package publishes to npm as `@ryuhq/core-client` (0.0.14) with an
// `"./*": "./src/*.ts"` export map, so `@ryuhq/core-client/gateway` is a
// supported public entry point for anyone building a surface against Core. Its
// `fetchGatewayConfig` therefore has to hold the same contract the desktop's
// does — in particular it must not fabricate config sections the gateway never
// served. See {@link routingViewIncludesSmartRouting}.
//
// If you extend this file, port the desktop's *reasoning*, not its whole
// surface, and say here which parts are still missing.

import { z } from "zod";
import {
	type AppResponseValue,
	appResponseValueSchema,
} from "./app-request-json.ts";
import { type ApiTarget, type RequestOptions, request } from "./client.ts";

/** JSON values accepted by Gateway's serde_json wire boundary. */
const gatewayJsonValidationSchema = z.json();
export type GatewayJsonValue = z.output<typeof gatewayJsonValidationSchema>;
/** Validate without cloning: Zod's JSON object decoder omits own __proto__
 * properties, but those are legitimate variable names in the wire contract. */
export const gatewayJsonValueSchema: z.ZodType<GatewayJsonValue> =
	z.custom<GatewayJsonValue>((value) => {
		if (!gatewayJsonValidationSchema.safeParse(value).success) {
			return false;
		}
		if (
			z.union([z.string(), z.number(), z.boolean(), z.null()]).safeParse(value)
				.success
		) {
			return true;
		}
		return Object.values(new Object(value)).every(
			(entry) => gatewayJsonValueSchema.safeParse(entry).success
		);
	});
const gatewayJsonCompositeSchema = z.union([
	z.array(gatewayJsonValueSchema),
	z.record(z.string(), gatewayJsonValueSchema),
]);
/** Optional properties follow JSON.stringify omission semantics. */
const gatewayEvalFieldsValidationSchema = z.record(
	z.string(),
	gatewayJsonValueSchema.optional()
);
export type GatewayEvalFields = z.output<
	typeof gatewayEvalFieldsValidationSchema
>;
export const gatewayEvalFieldsSchema = z.custom<GatewayEvalFields>(
	(value) =>
		gatewayEvalFieldsValidationSchema.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(entry) => gatewayJsonValueSchema.optional().safeParse(entry).success
		)
);

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

// Full native status projection: health4, metrics8 plus provider-quota7,
// and Core's redacted TOML JSON effective_config. Native map keys stay intact.
const gatewayHealthFields = z.object({
	auth_required: z.boolean().optional(),
	providers: z.array(z.string()).optional(),
	status: z.string().optional(),
	version: z.string().nullable().optional(),
});
const gatewayCircuitFields = z.object({
	circuit: z.string().optional(),
	consecutive_failures: z.number().optional(),
	open_for_secs: z.number().nullable().optional(),
});
const gatewayCircuitMapFields = z.record(z.string(), gatewayCircuitFields);
const gatewayCircuitMapSchema = z.custom<
	z.output<typeof gatewayCircuitMapFields>
>(
	(value) =>
		gatewayCircuitMapFields.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(row) => gatewayCircuitFields.safeParse(row).success
		)
);
const gatewayCounterMapFields = z.record(z.string(), z.number());
const gatewayCounterMapSchema = z.custom<
	z.output<typeof gatewayCounterMapFields>
>(
	(value) =>
		gatewayCounterMapFields.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(row) => z.number().safeParse(row).success
		)
);
const gatewayEvalScoreMapFields = z.record(z.string(), z.number().nullable());
const gatewayEvalScoreMapSchema = z.custom<
	z.output<typeof gatewayEvalScoreMapFields>
>(
	(value) =>
		gatewayEvalScoreMapFields.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(row) => z.number().nullable().safeParse(row).success
		)
);
const gatewayQuotaFields = z.object({
	remaining: z.number().nullable(),
	limit: z.number().nullable(),
	reset_at: z.number().nullable(),
	reset_in_secs: z.number().nullable(),
	retry_after: z.number().nullable(),
	rate_limited: z.boolean(),
	updated_at: z.number(),
});
const gatewayQuotaMapFields = z.record(z.string(), gatewayQuotaFields);
const gatewayQuotaMapSchema = z.custom<z.output<typeof gatewayQuotaMapFields>>(
	(value) =>
		gatewayQuotaMapFields.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(row) => gatewayQuotaFields.safeParse(row).success
		)
);
const gatewayMetricsFields = z.object({
	requests: z
		.object({
			total: z.number().optional(),
			errors: z.number().optional(),
			rate_limited: z.number().optional(),
			firewall_blocked: z.number().optional(),
			budget_exceeded: z.number().optional(),
			budget_notified: z.number().optional(),
			budget_downgraded: z.number().optional(),
			budget_restricted: z.number().optional(),
			degraded_fallback: z.number().optional(),
			degraded_exhausted: z.number().optional(),
		})
		.nullable()
		.optional(),
	cache: z
		.object({
			exact_hits: z.number().optional(),
			semantic_hits: z.number().optional(),
			misses: z.number().optional(),
			hit_rate: z.number().optional(),
		})
		.nullable()
		.optional(),
	tokens: z
		.object({
			input: z.number().optional(),
			output: z.number().optional(),
			cached_input: z.number().optional(),
			cache_write: z.number().optional(),
		})
		.nullable()
		.optional(),
	composio: z.object({ calls: z.number().optional() }).nullable().optional(),
	providers: z
		.object({
			requests: gatewayCounterMapSchema.optional(),
			errors: gatewayCounterMapSchema.optional(),
		})
		.nullable()
		.optional(),
	evals: z
		.object({
			enabled: z.boolean(),
			sample_rate: z.number().nullable().optional(),
			sampled: z.number().optional(),
			providers: gatewayEvalScoreMapSchema,
		})
		.optional(),
	provider_health: gatewayCircuitMapSchema.nullable().optional(),
	provider_quota: gatewayQuotaMapSchema.optional(),
});
const gatewayStatusFields = z.object({
	reachable: z.boolean().optional(),
	url: z.string().nullable().optional(),
	health: gatewayHealthFields.nullable().optional(),
	metrics: gatewayMetricsFields.nullable().optional(),
	effective_config: appResponseValueSchema.optional(),
});
const gatewayStatusResponseSchema = z.custom<
	z.output<typeof gatewayStatusFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayStatusFields.safeParse(value).success
);

type RawHealth = z.output<typeof gatewayHealthFields>;
type RawProviderCircuitState = z.output<typeof gatewayCircuitFields>;
type RawMetrics = z.output<typeof gatewayMetricsFields>;

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
	raw: Record<string, RawProviderCircuitState> | null | undefined
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
	const json = await request(
		target,
		"/api/gateway/status",
		{
			signal,
		},
		gatewayStatusResponseSchema
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
export const providerKindSchema = z.enum([
	"openai",
	"anthropic",
	"local",
	"openrouter",
	"core",
]);
export type ProviderKind = z.output<typeof providerKindSchema>;

/** Routing names configured provider instances, including custom IDs. */
export const providerIdSchema = z.string();
export type ProviderId = z.output<typeof providerIdSchema>;

/** A single model-to-provider mapping entry. */
export interface ModelMapping {
	provider: ProviderId;
	/** If set, rewrite the model name before forwarding to the provider. */
	provider_model?: string | null;
}

/**
 * How the matching rule is chosen for a smart-routing decision:
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
 *
 * All served fields are always on the wire: `RoutingView.smart_routing`
 * (`apps/gateway/src/api/config.rs`) is a plain `SmartRoutingConfig` struct, not
 * an `Option`, and every field on it is `#[serde(default)]`-filled rather than
 * skipped. `strategy` / `embedding_model` / `similarity_threshold` were missing
 * from this interface while the gateway served them — a type that cannot see a
 * served field is a setting a consumer of this package cannot round-trip, and a
 * `smart_routing` literal built field-by-field from the six it *could* see would
 * reset the other three on the next `PUT` (the section is replaced wholesale;
 * see {@link routingViewIncludesSmartRouting}). They are required, not optional,
 * because the gateway always emits them.
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
	default_provider: ProviderId;
	/** Ordered fallback chain used when the primary provider is unavailable. */
	fallback_chain: ProviderId[];
	/** Static model-to-provider mappings (exact or prefix match). */
	model_map: Record<string, ModelMapping>;
	/** Gateway Plane A model routing (custom routing instructions). Optional. */
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
export const budgetActionSchema = z.enum([
	"notify",
	"downgrade",
	"restrict",
	"stop",
]);
export type BudgetAction = z.output<typeof budgetActionSchema>;

/** Charged work categories that a budget rule includes. */
export interface BudgetChargeInclusion {
	media: boolean;
	model: boolean;
	tools: boolean;
}

/** Notification fan-out tier emitted by the gateway budget contract. */
export type GatewayAlertTier = "silent" | "warn" | "fanout" | "email";

/**
 * A single per-agent or per-user budget rule.
 * Field names are snake_case — the gateway config API passes these through
 * without camelCase normalization (unlike the status proxy).
 */
export interface BudgetRule {
	/** Action taken once the charged-cost limit is reached. */
	action: BudgetAction;
	/** Notification fan-out tier when this rule matches. */
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

/**
 * Per-user and per-agent charged-cost budgets (mirrors gateway BudgetConfig).
 * Keys are user/agent ids; values are budget rules.
 */
export interface GatewayBudgetConfig {
	agents: Record<string, BudgetRule>;
	/** One charged-cost rule applied independently to each conversation session. */
	session: BudgetRule;
	users: Record<string, BudgetRule>;
}

/** Legacy writable config view. Native GET returns additional sections and
 * arbitrary successful upstream JSON; use GatewayConfigSnapshot for reads. */
export interface GatewayConfig {
	auth: GatewayAuthConfig;
	budgets: GatewayBudgetConfig;
	firewall: GatewayFirewallConfig;
	phoneCalls?: GatewayPhoneCallsConfig;
	providers: GatewayProvidersConfig;
	routing: GatewayRoutingConfig;
}
/** Enumerable native response cells, retained without projecting future fields. */
const gatewayConfigCellsSchema = z.custom<Record<string, AppResponseValue>>(
	(value) =>
		z.instanceof(Object).safeParse(value).success &&
		Object.values(new Object(value)).every(
			(cell) => appResponseValueSchema.safeParse(cell).success
		)
);
export interface GatewayConfigSnapshot {
	routing: AppResponseValue;
	[field: string]: AppResponseValue;
}
// Full ApiKeyView publisher fields. Older native keys omit the two additive
// operation/system-relay fields; those omissions are preserved on PUT.
const gatewayStoredKeyFields = z.object({
	name: z.string(),
	key: z.string(),
	trusted_forwarder: z.boolean(),
	org_id: z.string().nullable().optional(),
	team_id: z.string().nullable().optional(),
	allowed_operations: z
		.array(z.enum(["inference", "web_search", "web_fetch"]))
		.optional(),
	system_relay: z.boolean().optional(),
});
const gatewayStoredKeysSchema = z.custom<
	z.output<typeof gatewayStoredKeyFields>[]
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		z.array(gatewayStoredKeyFields).safeParse(value).success
);
const gatewayAuthObservationFields = z.object({
	require_auth: z.boolean().optional(),
	api_keys: appResponseValueSchema.optional(),
});
const gatewayAuthObservationSchema = z.custom<
	z.output<typeof gatewayAuthObservationFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayAuthObservationFields.safeParse(value).success
);
function gatewayByoaKeys(
	snapshot: GatewayConfigSnapshot
): z.output<typeof gatewayStoredKeyFields>[] {
	const auth = snapshot.auth;
	if (auth === null || auth === undefined) {
		return [];
	}
	return gatewayStoredKeysSchema.parse(
		gatewayAuthObservationSchema.parse(auth).api_keys ?? []
	);
}

// Full native phone-controller publishers, including complete stored transcript
// messages. Known legacy additive omissions remain accepted without cloning rows.
const phoneLineFields = z.object({
	id: z.string(),
	label: z.string(),
	twilioNumber: z.string(),
	callerId: z.string(),
	agentId: z.string().nullable().optional(),
	ttsEngine: z.string().nullable().optional(),
	ttsVoice: z.string().nullable().optional(),
	transferTo: z.string().nullable().optional(),
	allowedCallers: z.array(z.string()).optional(),
	maxConcurrentCalls: z.number().nullable().optional(),
});
const phoneRecordFields = z.object({
	callSid: z.string(),
	conversationId: z.string(),
	lineId: z.string().nullable().optional(),
	status: z.string(),
	direction: z.string(),
	from: z.string(),
	to: z.string(),
	startTime: z.string().nullable().optional(),
	endTime: z.string().nullable().optional(),
	duration: z.string().nullable().optional(),
});
const phoneCallsFields = z.object({
	enabled: z.boolean(),
	twilioConfigured: z.boolean(),
	providerConfigured: z.boolean(),
	webhookUrl: z.string().nullable().optional(),
	lines: z.array(phoneLineFields),
	calls: z.array(phoneRecordFields),
	verifiedCallerIds: z.array(z.string()),
});
const phoneMessageFields = z.object({
	id: z.string(),
	role: z.string(),
	content: z.string(),
	agent_id: z.string().optional(),
	author_user_id: z.string().optional(),
	author_name: z.string().optional(),
	source: z.string().optional(),
	widget_instance_id: z.string().optional(),
	origin_server: z.string().optional(),
	parts: appResponseValueSchema.optional(),
	metadata: appResponseValueSchema.optional(),
	parent_message_id: z.string().optional(),
	interrupted: z.boolean().optional(),
	sibling_index: z.number().optional(),
	sibling_count: z.number().optional(),
	sibling_ids: z.array(z.string()).optional(),
	created_at: z.number(),
});
const phoneTranscriptFields = z.object({
	conversationId: z.string(),
	messages: z.array(phoneMessageFields),
});
const phoneNumberFields = z.object({
	friendlyName: z.string(),
	locality: z.string().nullable().optional(),
	phoneNumber: z.string(),
	region: z.string().nullable().optional(),
});
const phoneNumbersFields = z.object({ numbers: z.array(phoneNumberFields) });
const phonePurchasedFields = z.object({
	phoneNumber: z.string(),
	sid: z.string(),
	voiceUrl: z.string(),
});
const phoneVerifiedFields = z.object({
	callSid: z.string(),
	phoneNumber: z.string(),
	validationCode: z.string(),
});
const phoneStartedFields = z.object({
	callSid: z.string().nullable().optional(),
	conversationId: z.string().nullable().optional(),
	idempotencyKey: z.string(),
	status: z.string(),
});
const phoneActionFields = z.object({
	ok: z.boolean(),
	status: z.string().nullable().optional(),
});
const phoneCallsResponseSchema = z.custom<z.output<typeof phoneCallsFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		phoneCallsFields.safeParse(value).success
);
const phoneTranscriptResponseSchema = z.custom<
	z.output<typeof phoneTranscriptFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		phoneTranscriptFields.safeParse(value).success
);
const phoneNumbersResponseSchema = z.custom<
	z.output<typeof phoneNumbersFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		phoneNumbersFields.safeParse(value).success
);
const phonePurchasedResponseSchema = z.custom<
	z.output<typeof phonePurchasedFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		phonePurchasedFields.safeParse(value).success
);
const phoneVerifiedResponseSchema = z.custom<
	z.output<typeof phoneVerifiedFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		phoneVerifiedFields.safeParse(value).success
);
const phoneStartedResponseSchema = z.custom<
	z.output<typeof phoneStartedFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		phoneStartedFields.safeParse(value).success
);
const phoneActionResponseSchema = z.custom<z.output<typeof phoneActionFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		phoneActionFields.safeParse(value).success
);

export interface GatewayPhoneLineConfig {
	agentId?: string | null;
	/**
	 * Inbound callers (E.164) allowed to reach the assistant. Empty lets anyone
	 * call; callers the line does not list get Core's restricted tool profile.
	 */
	allowedCallers?: string[];
	callerId: string;
	greeting: string;
	id: string;
	label: string;
	/** Simultaneous calls on this line; `null` uses the Gateway default. */
	maxConcurrentCalls?: number | null;
	transferTo?: string | null;
	ttsEngine?: string | null;
	ttsVoice?: string | null;
	twilioNumber: string;
}

/** Limits the Gateway applies to a phone line's caller controls. */
export const GATEWAY_PHONE_LINE_LIMITS = {
	defaultConcurrentCalls: 2,
	maxAllowedCallers: 100,
	maxConcurrentCalls: 20,
} as const;

const GATEWAY_E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/** The Gateway's E.164 rule: `+`, then 8 to 15 digits not starting with 0. */
export function isGatewayE164Number(value: string): boolean {
	return GATEWAY_E164_PATTERN.test(value);
}

// Complete native PhoneCallsView2/PhoneCallLineView9; validation retains raw
// metadata and line references instead of projecting a writable header.
const gatewayPhoneConfigLineFields = phoneLineFields.extend({
	greeting: z.string(),
});
const gatewayPhoneConfigFields = z.object({
	enabled: z.boolean(),
	lines: z.array(gatewayPhoneConfigLineFields),
});
export const gatewayPhoneCallsConfigSchema = z.custom<
	z.output<typeof gatewayPhoneConfigFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayPhoneConfigFields.safeParse(value).success
);
export interface GatewayPhoneCallsConfig {
	enabled: boolean;
	lines: GatewayPhoneLineConfig[];
}

export interface GatewayPhoneCall {
	callSid: string;
	conversationId: string;
	direction: string;
	duration?: string | null;
	endTime?: string | null;
	from: string;
	lineId?: string | null;
	startTime?: string | null;
	status: string;
	to: string;
}

export type GatewayPhoneCallTranscript = z.output<typeof phoneTranscriptFields>;

export interface GatewayPhoneCallsResponse {
	calls: GatewayPhoneCall[];
	enabled: boolean;
	lines: Omit<GatewayPhoneLineConfig, "greeting">[];
	providerConfigured: boolean;
	twilioConfigured: boolean;
	verifiedCallerIds: string[];
	webhookUrl?: string | null;
}

export interface GatewayAvailablePhoneNumber {
	friendlyName: string;
	locality?: string | null;
	phoneNumber: string;
	region?: string | null;
}

export interface GatewayPhoneNumberPurchase {
	phoneNumber: string;
	sid: string;
	voiceUrl: string;
}

export interface GatewayCallerIdVerification {
	callSid: string;
	phoneNumber: string;
	validationCode: string;
}

export interface StartGatewayPhoneCallRequest {
	goal: string;
	idempotencyKey: string;
	lineId: string;
	to: string;
}

export interface StartGatewayPhoneCallResponse {
	callSid?: string | null;
	conversationId?: string | null;
	idempotencyKey: string;
	status: string;
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
	phoneCalls?: GatewayPhoneCallsConfig;
	/**
	 * Ryu's user-level routing config (persisted; takes effect after gateway restart).
	 * Runs before any upstream provider routing — this is the governance layer.
	 */
	routing?: GatewayRoutingConfig;
}

/**
 * Values matching `SmartRoutingConfig::default()` on the gateway, for a consumer
 * to bind a form control to when the served section is absent.
 *
 * Coalesce with this at YOUR OWN render edge, never inside
 * {@link fetchGatewayConfig} — see {@link routingViewIncludesSmartRouting} for
 * the difference that would destroy.
 */
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
 * deliberately omits `smart_routing`: this object stands in for "the gateway
 * told us nothing", and manufacturing a section here would assert something
 * about the node that was never observed.
 */
const DEFAULT_ROUTING: GatewayRoutingConfig = {
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
};

/**
 * Whether this gateway's `GET /v1/config` actually reported
 * `routing.smart_routing`.
 *
 * A presence test rather than a `?? DEFAULT_SMART_ROUTING` default, and the
 * reason is structural, not defensive typing.
 *
 * `PUT /v1/config { routing }` assigns the section wholesale
 * (`apps/gateway/src/api/config.rs`: `updated_config.routing = routing.clone()`)
 * and `RoutingConfig::smart_routing` is `#[serde(default)]`
 * (`apps/gateway/src/config.rs`), so a PUT body that omits it deserializes to
 * `SmartRoutingConfig::default()` and replaces whatever was on disk. Omission
 * and an explicit default erase identically; there is no clobber guard on
 * `routing`.
 *
 * So against a gateway too old to serve the field, a caller cannot round-trip
 * what it cannot see, and any routing save wipes a hand-written
 * `[routing.smart_routing]` in `gateway.toml`. From here that is not fixable,
 * only reportable — which is precisely why the two states have to stay
 * distinguishable.
 *
 * {@link fetchGatewayConfig} used to coalesce the field to
 * {@link DEFAULT_SMART_ROUTING}, and that coalesce is worse than it looks: an
 * unserved section became a *concrete* `enabled: false`, a fabricated "classifier
 * routing is off" that the client then spread back out on the next save of any
 * unrelated routing field. A status reporting healthy for a thing that was never
 * there, then writing that status back. The desktop copy
 * (`apps/desktop/src/lib/api/gateway.ts::routingViewIncludesSmartRouting`) was
 * fixed first; this is the same fix for the published package.
 *
 * A gateway that DOES serve the field always emits the key (`RoutingView`
 * carries a plain `SmartRoutingConfig`, not an `Option`), so presence is an
 * exact test.
 */
export function routingViewIncludesSmartRouting(
	routing: GatewayRoutingConfig
): boolean {
	return "smart_routing" in routing;
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
): Promise<GatewayConfigSnapshot> {
	const raw = await request(
		target,
		"/api/gateway/config",
		{ signal },
		appResponseValueSchema
	);
	// Preserve the native null/empty-response failure phase rather than inventing
	// an empty successful config. Other native primitives keep spread semantics.
	if (raw === null || raw === undefined) {
		throw new TypeError(
			"Gateway configuration response has no readable routing property"
		);
	}
	const cells = gatewayConfigCellsSchema.parse(new Object(raw));
	const routing =
		cells.routing ?? appResponseValueSchema.parse(DEFAULT_ROUTING);
	return {
		...cells,
		// Passed through EXACTLY as served — no `smart_routing` default folded in.
		// Coalescing here would erase the difference between "this gateway does not
		// serve the section" and "it serves it, switched off", and because the PUT
		// replaces `routing` wholesale the manufactured section rides back out on
		// the next save of anything else. See {@link routingViewIncludesSmartRouting};
		// a consumer that needs a value to bind a control to coalesces at its own
		// edge, where it can also say which of the two states it is in.
		routing,
	};
}

/**
 * Apply a partial config change to the gateway via Core's proxy
 * (`PUT /api/gateway/config`). Phone-line policy is non-secret; provider
 * credentials remain in the Gateway deployment secret boundary.
 *
 * Rejects on Core-unreachable or a non-2xx relay from the gateway.
 */
export async function updateGatewayConfig(
	target: ApiTarget,
	patch: RequestOptions["body"],
	signal?: AbortSignal
): Promise<AppResponseValue> {
	return request(
		target,
		"/api/gateway/config",
		{
			method: "PUT",
			body: patch,
			signal,
		},
		appResponseValueSchema
	);
}

/** Fetch recent phone-call records and Gateway provider readiness. */
export async function fetchGatewayPhoneCalls(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<GatewayPhoneCallsResponse> {
	return request(
		target,
		"/api/gateway/phone-calls",
		{
			signal,
		},
		phoneCallsResponseSchema
	);
}

/** Fetch the owner-only Core transcript associated with a Gateway PSTN call. */
export async function fetchGatewayPhoneCallTranscript(
	target: ApiTarget,
	callSid: string,
	signal?: AbortSignal
): Promise<GatewayPhoneCallTranscript> {
	return request(
		target,
		`/api/gateway/phone-calls/${encodeURIComponent(callSid)}/transcript`,
		{ signal },
		phoneTranscriptResponseSchema
	);
}

/** Search Twilio local voice numbers. Purchasing is a separate, explicit action. */
export async function searchGatewayPhoneNumbers(
	target: ApiTarget,
	countryCode: string,
	areaCode?: string,
	signal?: AbortSignal
): Promise<{ numbers: GatewayAvailablePhoneNumber[] }> {
	const params = new URLSearchParams({ countryCode });
	if (areaCode) {
		params.set("areaCode", areaCode);
	}
	return request(
		target,
		`/api/gateway/phone-calls/numbers/available?${params.toString()}`,
		{ signal },
		phoneNumbersResponseSchema
	);
}

/** Buy one number after the UI has shown the user that Twilio charges apply. */
export async function purchaseGatewayPhoneNumber(
	target: ApiTarget,
	phoneNumber: string,
	signal?: AbortSignal
): Promise<GatewayPhoneNumberPurchase> {
	return request(
		target,
		"/api/gateway/phone-calls/numbers",
		{ method: "POST", body: { phoneNumber }, signal },
		phonePurchasedResponseSchema
	);
}

/** Ask Twilio to verify that the user controls an outbound caller-ID number. */
export async function verifyGatewayCallerId(
	target: ApiTarget,
	phoneNumber: string,
	signal?: AbortSignal
): Promise<GatewayCallerIdVerification> {
	return request(
		target,
		"/api/gateway/phone-calls/caller-id-verifications",
		{ method: "POST", body: { phoneNumber }, signal },
		phoneVerifiedResponseSchema
	);
}

/** Ask the connected Gateway to place a call using a configured phone line. */
export async function startGatewayPhoneCall(
	target: ApiTarget,
	input: StartGatewayPhoneCallRequest,
	signal?: AbortSignal
): Promise<StartGatewayPhoneCallResponse> {
	return request(
		target,
		"/api/gateway/phone-calls",
		{
			method: "POST",
			body: input,
			signal,
		},
		phoneStartedResponseSchema
	);
}

/** Send an instruction to the agent on a live call. */
export async function guideGatewayPhoneCall(
	target: ApiTarget,
	callSid: string,
	content: string,
	signal?: AbortSignal
): Promise<{ ok: boolean }> {
	return request(
		target,
		`/api/gateway/phone-calls/${encodeURIComponent(callSid)}/control`,
		{ method: "POST", body: { content }, signal },
		phoneActionResponseSchema
	);
}

/** Stop the agent's current spoken response without ending the call. */
export async function interruptGatewayPhoneCall(
	target: ApiTarget,
	callSid: string,
	signal?: AbortSignal
): Promise<{ ok: boolean }> {
	return request(
		target,
		`/api/gateway/phone-calls/${encodeURIComponent(callSid)}/control`,
		{ method: "POST", body: { action: "abort" }, signal },
		phoneActionResponseSchema
	);
}

/** Transfer a call to the human number configured for its line. */
export async function handoffGatewayPhoneCall(
	target: ApiTarget,
	callSid: string,
	lineId: string,
	signal?: AbortSignal
): Promise<{ ok: boolean; status?: string | null }> {
	return request(
		target,
		`/api/gateway/phone-calls/${encodeURIComponent(callSid)}/handoff`,
		{ method: "POST", body: { lineId }, signal },
		phoneActionResponseSchema
	);
}

/** End a call from the owner control surface. */
export async function hangupGatewayPhoneCall(
	target: ApiTarget,
	callSid: string,
	signal?: AbortSignal
): Promise<{ ok: boolean; status?: string | null }> {
	return request(
		target,
		`/api/gateway/phone-calls/${encodeURIComponent(callSid)}/hangup`,
		{ method: "POST", signal },
		phoneActionResponseSchema
	);
}

// ── BYOK provider-key vault helpers (Unit U026) ──────────────────────────────
//
// These call Core's `PUT /api/gateway/providers`, which writes the key to
// gateway.toml and restarts the gateway so the change takes effect immediately.
// The key value travels over the loopback interface only (desktop → Core); it
// is not stored in renderer state after the save completes.

export type ByokProvider = "openai" | "anthropic" | "openrouter";

// Complete native provider application receipt; epoch is a UUID boot plus
// integer sequence, not a scalar. Core retains the historical three-field BYOK publisher.
const gatewayConfigRevisionFields = z.string().regex(/^[0-9a-f]{64}$/);
const gatewayProviderEpochFields = z.object({
	boot: z
		.string()
		.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
	sequence: z.number().nonnegative(),
});
const gatewayProviderApplyFields = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("applied"),
		requestedRevision: gatewayConfigRevisionFields,
		appliedRevision: gatewayConfigRevisionFields,
		epoch: gatewayProviderEpochFields,
	}),
	z.object({
		status: z.literal("already_applied"),
		requestedRevision: gatewayConfigRevisionFields,
		appliedRevision: gatewayConfigRevisionFields,
		epoch: gatewayProviderEpochFields,
	}),
	z.object({
		status: z.literal("superseded"),
		requestedRevision: gatewayConfigRevisionFields,
		currentRevision: gatewayConfigRevisionFields,
	}),
	z.object({
		status: z.literal("failed"),
		requestedRevision: gatewayConfigRevisionFields,
		activeRevision: gatewayConfigRevisionFields.nullable(),
		code: z.enum([
			"config_unavailable",
			"invalid_config",
			"sources_changed",
			"publication_failed",
			"transport",
			"unexpected_response",
			"apply_not_enabled",
		]),
	}),
	z.object({
		status: z.literal("offline"),
		requestedRevision: gatewayConfigRevisionFields,
	}),
	z.object({
		status: z.literal("unmanaged"),
		requestedRevision: gatewayConfigRevisionFields,
	}),
]);
export const gatewayProviderApplicationSchema = z.custom<
	z.output<typeof gatewayProviderApplyFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayProviderApplyFields.safeParse(value).success
);
const gatewayProviderCurrentFields = z.object({
	success: z.boolean(),
	gateway_restarted: z.boolean(),
	persisted: z.boolean(),
	configRevision: gatewayConfigRevisionFields,
	provider: z.string(),
	accountsApplied: z.boolean().optional(),
	gateway_application: gatewayProviderApplicationSchema,
});
const gatewayProviderLegacyFields = z.object({
	success: z.boolean(),
	gateway_restarted: z.boolean(),
	provider: z.string(),
});
const gatewayProviderMutationFields = z.union([
	gatewayProviderCurrentFields,
	gatewayProviderLegacyFields,
]);
const gatewayProviderMutationSchema = z.custom<
	z.output<typeof gatewayProviderMutationFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		([
			"persisted",
			"configRevision",
			"gateway_application",
			"accountsApplied",
		].some((key) => Object.hasOwn(new Object(value), key))
			? gatewayProviderCurrentFields.safeParse(value).success
			: gatewayProviderLegacyFields.safeParse(value).success)
);
export type GatewayProviderMutationResponse = z.output<
	typeof gatewayProviderMutationFields
>;

/** Set (or overwrite) a provider API key in the gateway config. */
export async function setGatewayProvider(
	target: ApiTarget,
	provider: ByokProvider,
	apiKey: string,
	signal?: AbortSignal
): Promise<GatewayProviderMutationResponse> {
	return request(
		target,
		"/api/gateway/providers",
		{ method: "PUT", body: { provider, api_key: apiKey }, signal },
		gatewayProviderMutationSchema
	);
}

/** Remove a provider key from the gateway config. */
export async function clearGatewayProvider(
	target: ApiTarget,
	provider: ByokProvider,
	signal?: AbortSignal
): Promise<GatewayProviderMutationResponse> {
	return request(
		target,
		"/api/gateway/providers",
		{ method: "PUT", body: { provider, api_key: null }, signal },
		gatewayProviderMutationSchema
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
): Promise<AppResponseValue> {
	const cfg = await fetchGatewayConfig(target);
	const existingKeys = gatewayByoaKeys(cfg);
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
): Promise<AppResponseValue> {
	const cfg = await fetchGatewayConfig(target);
	const next = gatewayByoaKeys(cfg).filter((k) => k.name !== name);
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
// Complete persisted audit row (35 fields), plus charged cost/source enrichment.
// Optional service_usage is the only omitted current serializer field.
const gatewayAuditServiceUsageFields = z.object({
	requests: z.number(),
	documents: z.number(),
	provider_credits: z.number().nullable(),
	cost_source: z.enum([
		"provider_reported",
		"configured_estimate",
		"unpriced",
		"unsettled",
	]),
	cost_is_estimate: z.boolean(),
});
const gatewayAuditEntryFields = z.object({
	id: z.number(),
	timestamp: z.string(),
	request_id: z.string(),
	api_key: z.string(),
	user_name: z.string().nullable(),
	org_id: z.string().nullable(),
	team_id: z.string().nullable(),
	project_id: z.string().nullable(),
	provider: z.string(),
	model: z.string(),
	input_tokens: z.number(),
	output_tokens: z.number(),
	cache_read_tokens: z.number().nullable(),
	cache_write_tokens: z.number().nullable(),
	cache_hit: z.boolean(),
	prompt_cache_outcome: z.string().nullable(),
	prompt_cache_read_tokens: z.number().nullable(),
	prompt_cache_write_tokens: z.number().nullable(),
	latency_ms: z.number(),
	eval_score: z.number().nullable(),
	error: z.string().nullable(),
	skill_ids: z.string().nullable(),
	session_id: z.string().nullable(),
	event_type: z.string(),
	backend: z.string().nullable(),
	command: z.string().nullable(),
	duration_ms: z.number().nullable(),
	exit_code: z.number().nullable(),
	user_id: z.string().nullable(),
	agent_id: z.string().nullable(),
	feature: z.string().nullable(),
	managed_inference: z.boolean(),
	provider_cost_micro_usd: z.number().nullable(),
	purpose: z.string().nullable().optional(),
	widget_instance_id: z.string().nullable(),
	service_usage: gatewayAuditServiceUsageFields.optional(),
	cost_micro_usd: z.number().nullable(),
	source: z.string(),
});
const gatewayAuditFields = z.object({
	reachable: z.boolean().optional(),
	entries: z.array(gatewayAuditEntryFields).nullable().optional(),
	count: z.number().nullable().optional(),
	error: appResponseValueSchema.optional(),
	status: z.number().optional(),
});
const gatewayAuditResponseSchema = z.custom<
	z.output<typeof gatewayAuditFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayAuditFields.safeParse(value).success
);
export type AuditEntry = z.output<typeof gatewayAuditEntryFields>;
const gatewayAuditRetentionFields = z.object({
	kind: z.literal("retention"),
	deleted_rows: z.number(),
	retention_days: z.number().nullable(),
	max_rows: z.number().nullable(),
});
const gatewayAuditPruneFields = z.union([
	gatewayAuditRetentionFields,
	z.object({ reachable: z.literal(false), error: z.string() }),
	z.strictObject({}),
]);
const gatewayAuditPruneResponseSchema = z.custom<
	z.output<typeof gatewayAuditPruneFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayAuditPruneFields.safeParse(value).success
);
export type GatewayAuditPruneResponse = z.output<
	typeof gatewayAuditPruneFields
>;

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
	/** Filter by stable agent id. */
	agentId?: string;
	/** Return only entries that have an error. */
	errorsOnly?: boolean;
	/** Filter by model/provider dimensions. */
	eventType?: string;
	/** Inclusive ISO timestamp lower bound. */
	from?: string;
	/** Maximum number of entries to return (gateway default: 100). */
	limit?: number;
	model?: string;
	provider?: string;
	/** Filter by Core session/conversation id. */
	sessionId?: string;
	/** Exclusive ISO timestamp upper bound. */
	until?: string;
	widgetInstanceId?: string;
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
	if (filters.agentId) {
		qs.set("agent_id", filters.agentId);
	}
	if (filters.from) {
		qs.set("from", filters.from);
	}
	if (filters.model) {
		qs.set("model", filters.model);
	}
	if (filters.provider) {
		qs.set("provider", filters.provider);
	}
	if (filters.eventType) {
		qs.set("event_type", filters.eventType);
	}
	if (filters.until) {
		qs.set("until", filters.until);
	}
	if (filters.widgetInstanceId) {
		qs.set("widget_instance_id", filters.widgetInstanceId);
	}
	if (filters.errorsOnly) {
		qs.set("errors_only", "true");
	}
	if (filters.limit !== undefined) {
		qs.set("limit", String(filters.limit));
	}
	const path = qs.size > 0 ? `/api/gateway/audit?${qs}` : "/api/gateway/audit";
	const raw = await request(
		target,
		path,
		{ signal },
		gatewayAuditResponseSchema
	);
	return {
		reachable: raw.reachable ?? false,
		entries: raw.entries ?? [],
		count: raw.count ?? 0,
	};
}

/** Apply the Gateway's configured local audit retention policy. */
export async function pruneGatewayAudit(
	target: ApiTarget
): Promise<GatewayAuditPruneResponse> {
	return await request(
		target,
		"/api/gateway/audit/prune",
		{ method: "POST" },
		gatewayAuditPruneResponseSchema
	);
}

// ── Eval dataset runner (M4 / #180) ──────────────────────────────────────────
//
// Scorers: latency / token_efficiency / policy_pass / optional substring_match,
// plus promptfoo-style per-case assertions (deterministic + llm_judge),
// run-level system prompts, {{var}} substitution, and multi-model compare.

/** Promptfoo-compatible per-assertion controls. */
export interface AssertionOptions {
	config?: GatewayEvalFields;
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

/** Validates the existing Gateway assertion wire contract, including nested sets. */
export const assertionSchema: z.ZodType<Assertion> = z.lazy(() => {
	const options = z
		.looseObject({
			config: z.record(z.string(), z.json()).optional(),
			metric: z.string().optional(),
			not: z.boolean().optional(),
			provider: z.string().optional(),
			rubric_prompt: z.string().optional(),
			threshold: z.number().optional(),
			transform: z.string().optional(),
			weight: z.number().optional(),
		})
		.optional();
	return z.union([
		z.looseObject({
			kind: z.enum([
				"contains",
				"not_contains",
				"equals",
				"regex",
				"icontains",
				"starts_with",
				"contains_any",
				"contains_all",
				"icontains_any",
				"icontains_all",
				"contains_json",
				"contains_html",
				"contains_xml",
				"contains_sql",
				"levenshtein",
				"latency",
				"cost",
				"moderation",
				"javascript",
				"python",
				"ruby",
				"webhook",
				"similar",
			]),
			value: z.string(),
			options,
		}),
		z.looseObject({
			kind: z.enum([
				"is_html",
				"is_xml",
				"is_sql",
				"is_refusal",
				"is_json",
				"json_valid",
			]),
			options,
		}),
		z.looseObject({
			kind: z.enum([
				"llm_judge",
				"llm_rubric",
				"factuality",
				"context_faithfulness",
				"answer_relevance",
			]),
			rubric: z.string(),
			options,
		}),
		z.looseObject({
			kind: z.literal("assert_set"),
			assertions: z.array(assertionSchema),
			options,
		}),
	]);
});

/** Result of evaluating one assertion against a response. */
export interface AssertionResult {
	/** Human-readable explanation (matched text, regex error, judge verdict, …). */
	detail: string;
	/** False when a runtime/judge prerequisite was unavailable. */
	executed?: boolean;
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
	/** Optional reference/context payload for factuality and faithfulness checks. */
	context?: unknown;
	description?: string;
	/** Shared Gateway evaluator ids applied to this case. */
	evaluators?: string[];
	/**
	 * Optional expected substring. When present the gateway applies a
	 * case-insensitive contains check and adds a substring_match score.
	 * When absent the scorer is omitted — no penalty for a missing expected.
	 */
	expected?: string | null;
	id?: string;
	/** Optional ordered chat turns; when present the gateway replays these. */
	messages?: EvalMessage[];
	metadata?: GatewayEvalFields;
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
	provider?: string;
	provider_cost_micro_usd?: number;
	provider_latency_ms?: number;
	provider_output?: unknown;
	provider_output_policy_pass?: boolean;
	provider_output_provider?: string;
	providers?: string[];
	/** Promptfoo-style threshold for the mean assertion score (0..1). */
	threshold?: number;
	/** Per-case {{var}} substitutions (prompt, system prompt, assertions). */
	vars?: GatewayEvalFields;
}

/** One ordered chat turn in a Promptfoo-compatible case. */
export interface EvalMessage {
	content: string;
	role: "assistant" | "system" | "user";
}

// Full native CaseScore29 / Aggregate13 / assertion5 / evaluator6+3,
// preserving older additive omissions and exact raw JSON references.
const gatewayAssertionResultFields = z.object({
	kind: z.string(),
	pass: z.boolean(),
	score: z.number(),
	detail: z.string(),
	executed: z.boolean().optional(),
});
const gatewayEvaluatorResultFields = z.object({
	id: z.string(),
	category: z.string(),
	score: z.number(),
	pass: z.boolean(),
	detail: z.string(),
	executed: z.boolean(),
});
const gatewayEvaluatorAggregateFields = z.object({
	meanScore: z.number(),
	passRate: z.number(),
	executedCount: z.number(),
});
const gatewayEvaluatorAggregatesFields = z.record(
	z.string(),
	gatewayEvaluatorAggregateFields
);
const gatewayEvaluatorAggregatesSchema = z.custom<
	z.output<typeof gatewayEvaluatorAggregatesFields>
>(
	(value) =>
		gatewayEvaluatorAggregatesFields.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(row) => gatewayEvaluatorAggregateFields.safeParse(row).success
		)
);
const gatewayEvalCaseScoreFields = z.object({
	id: z.string().optional(),
	description: z.string().optional(),
	prompt_id: z.string().optional(),
	model: z.string().optional(),
	provider: z.string().optional(),
	rendered_prompt: z.string().optional(),
	vars: gatewayEvalFieldsSchema.optional(),
	metadata: gatewayEvalFieldsSchema.optional(),
	context: appResponseValueSchema.optional(),
	input_tokens: z.number().optional(),
	output_tokens: z.number().optional(),
	total_tokens: z.number().optional(),
	cost_micro_usd: z.number().nullable().optional(),
	latency_ms: z.number().optional(),
	latency_available: z.boolean().optional(),
	cache_hit: z.boolean().optional(),
	error: z.string().nullable().optional(),
	prompt: z.string(),
	response_text: z.string(),
	latency_score: z.number(),
	token_efficiency: z.number(),
	policy_pass: z.boolean(),
	policy_available: z.boolean().optional(),
	substring_match: z.number().nullable(),
	overall: z.number(),
	assertions: z.array(gatewayAssertionResultFields),
	assertion_score: z.number().nullable(),
	assertions_pass: z.boolean(),
	evaluators: z.array(gatewayEvaluatorResultFields).optional(),
});
const gatewayEvalAggregateFields = z.object({
	mean_overall: z.number(),
	mean_latency: z.number(),
	latency_available_cases: z.number().optional(),
	mean_token_efficiency: z.number(),
	policy_pass_rate: z.number(),
	policy_available_cases: z.number().optional(),
	mean_substring_match: z.number().nullable(),
	total_cases: z.number(),
	total_input_tokens: z.number().optional(),
	total_output_tokens: z.number().optional(),
	total_cost_micro_usd: z.number().nullable().optional(),
	assertion_pass_rate: z.number().optional(),
	evaluators: gatewayEvaluatorAggregatesSchema.optional(),
});
const gatewayModelEvalFields = z.object({
	model: z.string(),
	cases: z.array(gatewayEvalCaseScoreFields),
	aggregate: gatewayEvalAggregateFields,
});
const gatewayEvalTagFields = z.record(z.string(), z.string());
const gatewayEvalTagSchema = z.custom<z.output<typeof gatewayEvalTagFields>>(
	(value) =>
		gatewayEvalTagFields.safeParse(value).success &&
		Object.values(new Object(value)).every(
			(tag) => z.string().safeParse(tag).success
		)
);
const gatewayEvalRunFields = z.object({
	cases: z.array(gatewayEvalCaseScoreFields),
	aggregate: gatewayEvalAggregateFields,
	models: z.array(gatewayModelEvalFields).optional(),
	run_id: z.string().optional(),
	started_at: z.string().optional(),
	finished_at: z.string().optional(),
	tags: gatewayEvalTagSchema.optional(),
});
export const gatewayEvalRunSchema = z.custom<
	z.output<typeof gatewayEvalRunFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayEvalRunFields.safeParse(value).success
);
const gatewayOnlineScoreFields = z.object({
	kind: z.literal("online_score"),
	score: gatewayEvalCaseScoreFields,
	scored_at: z.string(),
});
export const gatewayOnlineScoreSchema = z.custom<
	z.output<typeof gatewayOnlineScoreFields>
>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayOnlineScoreFields.safeParse(value).success
);
const gatewayRedTeamFields = z.object({
	campaign_id: z.string(),
	model: z.string(),
	strategies: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			evaluator: z.string(),
			protected: z.boolean(),
			detail: z.string(),
		})
	),
	summary: z.object({
		total: z.number(),
		protected: z.number(),
		needs_attention: z.number(),
	}),
	result: appResponseValueSchema.optional(),
});
const gatewayRedTeamSchema = z.custom<z.output<typeof gatewayRedTeamFields>>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		gatewayRedTeamFields.safeParse(value).success
);
export type GatewayEvaluatorResult = z.output<
	typeof gatewayEvaluatorResultFields
>;
export type GatewayEvaluatorAggregate = z.output<
	typeof gatewayEvaluatorAggregateFields
>;

/** Per-case scores returned by the gateway eval runner. */
export interface EvalCaseScore {
	/** Mean assertion score in [0,1], before the case threshold is applied. */
	assertion_score: number | null;
	/** NEW: per-assertion results (always present; [] when no assertions). */
	assertions: AssertionResult[];
	/** NEW: true iff every assertion passed (vacuously true for []). */
	assertions_pass: boolean;
	cache_hit?: boolean;
	context?: unknown;
	cost_micro_usd?: number | null;
	description?: string;
	error?: string | null;
	evaluators?: GatewayEvaluatorResult[];
	id?: string;
	input_tokens?: number;
	latency_available?: boolean;
	latency_ms?: number;
	/** 1.0 = instant, 0.0 = at/beyond max_latency_ms. */
	latency_score: number;
	metadata?: GatewayEvalFields;
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
	vars?: GatewayEvalFields;
}

/** Aggregate summary across all eval cases. */
export interface EvalRunAggregate {
	assertion_pass_rate?: number;
	evaluators?: z.output<typeof gatewayEvaluatorAggregatesFields>;
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

/** One bounded local security probe in a red-team campaign. */
export interface RedTeamStrategyResult {
	detail: string;
	evaluator: string;
	id: string;
	name: string;
	protected: boolean;
}

/** Response from POST /api/gateway/redteam/run (via Core's proxy). */
export interface RedTeamRunResult {
	campaign_id: string;
	model: string;
	result?: EvalRunResult | AppResponseValue;
	strategies: RedTeamStrategyResult[];
	summary: {
		needs_attention: number;
		protected: number;
		total: number;
	};
}

/** Request body for POST /api/gateway/evals/run. */
export interface RunEvalsRequest {
	/** Optional agent id for per-agent budget tracking. */
	agent_id?: string | null;
	cache?: boolean;
	/** Core-owned custom JS/Python evaluators. */
	code_evaluators?: CodeEvaluatorSpec[];
	/**
	 * Dataset to replay. When empty or absent the gateway uses its built-in
	 * 3-case dataset so the panel works on first run without any configuration.
	 */
	dataset?: EvalDatasetCase[];
	/** Registry evaluator ids applied to every case. */
	evaluators?: string[];
	/**
	 * Optional judge model override; a single fixed judge across all models.
	 * When unset, the server defaults to the first model in `models`.
	 */
	judge_model?: string;
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
	prefix?: string;
	prompt_id?: string;
	repeat?: number;
	suffix?: string;
	/** Run-level multi-turn prompt variant; rendered before each test case. */
	system_messages?: EvalMessage[];
	/**
	 * Run-level system prompt; the server prepends it as a system message per
	 * case and substitutes any {{vars}} using that case's `vars`.
	 */
	system_prompt?: string;
	tags?: Record<string, string>;
	timeout_ms?: number;
}

/** OpenRouter Batch API endpoint shape. One batch can contain exactly one. */
export type GatewayBatchEndpoint =
	| "/v1/chat/completions"
	| "/v1/responses"
	| "/v1/messages"
	| "/v1/embeddings";

/** One independently addressable request in a batch. */
export interface GatewayBatchRequestItem {
	body: GatewayEvalFields;
	custom_id: string;
}

/** Request accepted by POST /api/gateway/batches. */
export interface GatewayBatchCreateRequest {
	completion_window?: "24h";
	endpoint: GatewayBatchEndpoint;
	model: string;
	provider?: { only: string[] };
	requests: GatewayBatchRequestItem[];
}

/** Per-row output returned when an OpenRouter batch has completed. */
export interface GatewayBatchResult {
	custom_id: string;
	error?: unknown | null;
	id: string;
	response?: {
		body: unknown;
		request_id?: string;
		status_code: number;
	} | null;
}

/** OpenRouter batch status and, when completed, its inline results. */
export interface GatewayBatch {
	completion_window?: string;
	created_at?: number;
	endpoint: GatewayBatchEndpoint;
	error?: unknown;
	finalized_at?: number | null;
	id: string;
	model: string;
	request_counts?: { completed: number; failed: number; total: number };
	results?: GatewayBatchResult[] | null;
	status:
		| "validating"
		| "in_progress"
		| "finalizing"
		| "completed"
		| "failed"
		| "expired"
		| "cancelling"
		| "cancelled";
	usage?: {
		completion_tokens?: number;
		cost?: number;
		is_byok?: boolean;
		prompt_tokens?: number;
		total_tokens?: number;
	} | null;
}

/** A cursor page returned by GET /api/gateway/batches. */
export interface GatewayBatchPage {
	data: GatewayBatch[];
	first_id?: string | null;
	has_more: boolean;
	last_id?: string | null;
}

/** Filters supported by OpenRouter's cursor-paginated batch listing. */
export type GatewayBatchListStatus =
	| "validating"
	| "in_progress"
	| "completed"
	| "failed"
	| "expired"
	| "cancelled";

export interface GatewayBatchListQuery {
	after?: string;
	created_after?: string;
	created_before?: string;
	limit?: number;
	status?: GatewayBatchListStatus | GatewayBatchListStatus[];
}

/** Batch-ready evaluation prompt mapping; expected answers stay local. */
export interface GatewayEvalBatchPlan {
	cases_by_custom_id: Record<string, EvalDatasetCase>;
	eval_options: Pick<
		RunEvalsRequest,
		| "agent_id"
		| "evaluators"
		| "judge_model"
		| "max_concurrency"
		| "prefix"
		| "suffix"
		| "system_messages"
		| "system_prompt"
		| "tags"
		| "timeout_ms"
	>;
	request: GatewayBatchCreateRequest;
}

/** Scored successful rows and independent provider failures from an eval batch. */
export interface GatewayEvalBatchScoreResult {
	batch_turnaround_ms: number;
	failures: Array<{ custom_id: string; error: string }>;
	result: EvalRunResult | AppResponseValue;
}

/**
 * Convert text evaluation cases into one OpenRouter chat-completion batch.
 * The model must be an OpenRouter model slug, and callers submit one plan per
 * model because OpenRouter applies one model to every row in a batch.
 */
export function buildGatewayEvalBatchPlan(
	model: string,
	cases: readonly EvalDatasetCase[],
	options: {
		agent_id?: string;
		evaluators?: string[];
		judge_model?: string;
		max_concurrency?: number;
		prefix?: string;
		suffix?: string;
		system_messages?: readonly EvalMessage[];
		system_prompt?: string;
		tags?: Record<string, string>;
		timeout_ms?: number;
	} = {}
): GatewayEvalBatchPlan {
	const normalizedModel = model.trim();
	if (!normalizedModel) {
		throw new Error("An OpenRouter model slug is required.");
	}
	if (cases.length === 0 || cases.length > 10_000) {
		throw new Error("A batch eval needs between 1 and 10,000 cases.");
	}
	const casesByCustomId: Record<string, EvalDatasetCase> = {};
	const requests = cases.map((testCase, index) => {
		if (
			testCase.provider ||
			testCase.providers?.length ||
			testCase.provider_output
		) {
			throw new Error(
				"Batch eval cases cannot override the batch model or use precomputed outputs."
			);
		}
		if (testCase.options?.cache) {
			throw new Error("Batch eval does not support per-case response caching.");
		}
		const vars = transformGatewayEvalVars(
			gatewayEvalFieldsSchema.parse(testCase.vars ?? {}),
			testCase.options?.transform_vars
		);
		const customId = `eval-${String(index + 1).padStart(6, "0")}`;
		casesByCustomId[customId] = testCase;
		const render = (text: string) => renderGatewayEvalTemplate(text, vars);
		const messages: Array<{ role: string; content: string }> = [];
		if (options.system_prompt) {
			messages.push({ role: "system", content: render(options.system_prompt) });
		}
		for (const message of options.system_messages ?? []) {
			messages.push({ role: message.role, content: render(message.content) });
		}
		const prompt = `${options.prefix ?? ""}${testCase.options?.prefix ?? ""}${render(testCase.prompt)}${testCase.options?.suffix ?? ""}${options.suffix ?? ""}`;
		if (testCase.messages?.length) {
			let hasUser = false;
			for (const message of testCase.messages) {
				hasUser ||= message.role === "user";
				messages.push({ role: message.role, content: render(message.content) });
			}
			if (!hasUser) {
				messages.push({ role: "user", content: prompt });
			}
		} else {
			messages.push({ role: "user", content: prompt });
		}
		return {
			custom_id: customId,
			body: { messages },
		};
	});
	return {
		cases_by_custom_id: casesByCustomId,
		eval_options: {
			agent_id: options.agent_id,
			evaluators: options.evaluators,
			judge_model: options.judge_model,
			max_concurrency: options.max_concurrency,
			prefix: options.prefix,
			suffix: options.suffix,
			system_messages: options.system_messages
				? [...options.system_messages]
				: undefined,
			system_prompt: options.system_prompt,
			tags: options.tags,
			timeout_ms: options.timeout_ms,
		},
		request: {
			endpoint: "/v1/chat/completions",
			model: normalizedModel,
			completion_window: "24h",
			requests,
		},
	};
}

function renderGatewayEvalTemplate(
	text: string,
	vars: GatewayEvalFields
): string {
	if (text.includes("{%")) {
		throw new Error(
			"Batch eval preparation does not render template control blocks; pre-render the prompt first."
		);
	}
	return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawKey: string) => {
		const key = rawKey.trim();
		if (key.includes("|")) {
			throw new Error(
				"Batch eval preparation supports variable lookup only; pre-render filtered expressions first."
			);
		}
		const [root, ...segments] = key.split(".");
		if (!(root && Object.hasOwn(vars, root))) {
			return match;
		}
		let value = vars[root];
		for (const segment of segments) {
			if (
				!(
					gatewayJsonCompositeSchema.safeParse(value).success &&
					Object.hasOwn(new Object(value), segment)
				)
			) {
				return match;
			}
			const descriptor = Object.getOwnPropertyDescriptor(
				new Object(value),
				segment
			);
			if (!descriptor) {
				return match;
			}
			value = gatewayJsonValueSchema.optional().parse(descriptor.value);
		}
		const stringValue = z.string().safeParse(value);
		if (stringValue.success) {
			return stringValue.data;
		}
		if (value === null || value === undefined) {
			return "";
		}
		const composite = gatewayJsonCompositeSchema.safeParse(value);
		return composite.success ? (JSON.stringify(value) ?? "") : String(value);
	});
}

function transformGatewayEvalVars(
	vars: GatewayEvalFields,
	transform: string | undefined
): GatewayEvalFields {
	if (!transform || transform === "identity") {
		return vars;
	}
	if (transform !== "json") {
		throw new Error(`Unsupported eval variable transform: ${transform}`);
	}
	return Object.fromEntries(
		Object.entries(vars).map(([key, value]) => {
			const stringValue = z.string().safeParse(value);
			if (!stringValue.success) {
				return [key, value];
			}
			try {
				return [
					key,
					gatewayJsonValueSchema.parse(JSON.parse(stringValue.data)),
				];
			} catch {
				throw new Error(`Eval variable ${key} is not valid JSON.`);
			}
		})
	);
}

/** One custom evaluator source executed by Core's sandbox seam. */
export interface CodeEvaluatorSpec {
	id: string;
	lang: "js" | "python";
	source: string;
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
): Promise<EvalRunResult | AppResponseValue> {
	return await request(
		target,
		"/api/gateway/evals/run",
		{
			method: "POST",
			body: req,
			signal,
		},
		appResponseValueSchema
	);
}

/**
 * Score a completed batch against its original eval cases through Gateway's
 * existing scorer. Every successful row carries the whole batch turnaround as
 * its latency measurement because OpenRouter does not report per-row latency.
 */
export async function scoreGatewayEvalBatch(
	target: ApiTarget,
	plan: GatewayEvalBatchPlan,
	batch: GatewayBatch,
	signal?: AbortSignal
): Promise<GatewayEvalBatchScoreResult> {
	if (batch.status !== "completed" || !Array.isArray(batch.results)) {
		throw new Error(
			"Only completed batches with inline results can be scored."
		);
	}
	const timestamps = z
		.object({ created_at: z.number(), finalized_at: z.number() })
		.safeParse(batch);
	if (!timestamps.success) {
		throw new Error(
			"The completed batch is missing creation or finalization timestamps."
		);
	}
	const batchTurnaroundMs = Math.max(
		0,
		Math.round(
			(timestamps.data.finalized_at - timestamps.data.created_at) * 1000
		)
	);
	const seenIds = new Set<string>();
	const completedIds = new Set<string>();
	const dataset: EvalDatasetCase[] = [];
	const failures: Array<{ custom_id: string; error: string }> = [];
	for (const row of batch.results) {
		const testCase = plan.cases_by_custom_id[row.custom_id];
		if (!testCase) {
			throw new Error(
				`Batch result ${row.custom_id} has no matching eval case.`
			);
		}
		if (seenIds.has(row.custom_id)) {
			throw new Error(`Batch returned duplicate custom_id ${row.custom_id}.`);
		}
		seenIds.add(row.custom_id);
		completedIds.add(row.custom_id);
		if (
			(row.error !== null && row.error !== undefined) ||
			!row.response ||
			row.response.status_code < 200 ||
			row.response.status_code >= 300
		) {
			failures.push({
				custom_id: row.custom_id,
				error: batchRowError(row),
			});
			continue;
		}
		if (row.response.body === null || row.response.body === undefined) {
			failures.push({
				custom_id: row.custom_id,
				error: "Batch result has no response body.",
			});
			continue;
		}
		const providerCost = batchResponseCostMicroUsd(row.response);
		const scoredCase: EvalDatasetCase = {
			...testCase,
			provider_output: row.response.body,
			provider_output_provider: "openrouter",
			provider_latency_ms: batchTurnaroundMs,
		};
		if (providerCost !== undefined) {
			scoredCase.provider_cost_micro_usd = providerCost;
		}
		dataset.push(scoredCase);
	}
	for (const customId of Object.keys(plan.cases_by_custom_id)) {
		if (!completedIds.has(customId)) {
			failures.push({
				custom_id: customId,
				error: "OpenRouter returned no result for this row.",
			});
		}
	}
	if (dataset.length > 1000) {
		throw new Error(
			"Gateway's eval scorer accepts at most 1,000 completed batch rows at a time."
		);
	}
	const result = dataset.length
		? await runGatewayEvals(
				target,
				{
					...plan.eval_options,
					model: batch.model,
					tags: {
						...plan.eval_options.tags,
						execution_mode: "openrouter_batch",
					},
					dataset,
				},
				signal
			)
		: null;
	return {
		batch_turnaround_ms: batchTurnaroundMs,
		failures,
		result,
	};
}

function batchRowError(row: GatewayBatchResult): string {
	const stringError = z.string().safeParse(row.error);
	if (stringError.success) {
		return stringError.data;
	}
	if (row.error !== null && row.error !== undefined) {
		return JSON.stringify(row.error) ?? String(row.error);
	}
	return `OpenRouter returned HTTP ${row.response?.status_code ?? "unknown"} for this row.`;
}

/** Only finite nonnegative provider costs contribute to the scorer. Invalid
 * micro-dollar fields still allow the provider's dollar field as a fallback. */
const batchCostSchema = z.number().nonnegative().optional().catch(undefined);
const batchUsageSchema = z.object({
	usage: z.object({
		cost: batchCostSchema.optional(),
		cost_micro_usd: batchCostSchema.optional(),
	}),
});
function batchResponseCostMicroUsd(
	response: GatewayBatchResult["response"]
): number | undefined {
	const parsed = batchUsageSchema.safeParse(response?.body);
	if (!parsed.success) {
		return undefined;
	}
	const usage = parsed.data.usage;
	if (usage.cost_micro_usd !== undefined) {
		return usage.cost_micro_usd;
	}
	return usage.cost === undefined
		? undefined
		: Math.round(usage.cost * 1_000_000);
}

/** Submit a provider-native OpenRouter batch through Core's admin proxy. */
export async function createGatewayBatch(
	target: ApiTarget,
	input: GatewayBatchCreateRequest,
	signal?: AbortSignal
): Promise<GatewayBatch | AppResponseValue> {
	return await request(
		target,
		"/api/gateway/batches",
		{
			method: "POST",
			body: input,
			signal,
		},
		appResponseValueSchema
	);
}

/** List the configured OpenRouter workspace's batches using its `after` cursor. */
export async function listGatewayBatches(
	target: ApiTarget,
	query: GatewayBatchListQuery = {},
	signal?: AbortSignal
): Promise<GatewayBatchPage | AppResponseValue> {
	const params = new URLSearchParams();
	if (query.limit !== undefined) {
		params.set("limit", String(query.limit));
	}
	if (query.after) {
		params.set("after", query.after);
	}
	for (const status of Array.isArray(query.status)
		? query.status
		: query.status
			? [query.status]
			: []) {
		params.append("status", status);
	}
	if (query.created_after) {
		params.set("created_after", query.created_after);
	}
	if (query.created_before) {
		params.set("created_before", query.created_before);
	}
	const suffix = params.size ? `?${params.toString()}` : "";
	return await request(
		target,
		`/api/gateway/batches${suffix}`,
		{ signal },
		appResponseValueSchema
	);
}

/** Poll one OpenRouter batch. Completed results arrive inline in `results`. */
export async function getGatewayBatch(
	target: ApiTarget,
	id: string,
	signal?: AbortSignal
): Promise<GatewayBatch | AppResponseValue> {
	return await request(
		target,
		`/api/gateway/batches/${encodeURIComponent(id)}`,
		{
			signal,
		},
		appResponseValueSchema
	);
}

/** Delete a terminal batch and ask OpenRouter to purge retained request/results. */
export async function deleteGatewayBatch(
	target: ApiTarget,
	id: string,
	signal?: AbortSignal
): Promise<GatewayJsonValue> {
	return gatewayJsonValueSchema.parse(
		await request(
			target,
			`/api/gateway/batches/${encodeURIComponent(id)}`,
			{
				method: "DELETE",
				signal,
			},
			appResponseValueSchema
		)
	);
}

/** Score a completed production output without replaying its provider call. */
export async function scoreGatewayOutput(
	target: ApiTarget,
	input: {
		agent_id?: string;
		assertions?: Assertion[];
		cost_micro_usd?: number;
		context?: unknown;
		description?: string;
		evaluators?: string[];
		expected?: string;
		id?: string;
		latency_ms?: number;
		metadata?: GatewayEvalFields;
		model?: string;
		policy_pass?: boolean;
		prompt?: string;
		response: unknown;
		threshold?: number;
		vars?: GatewayEvalFields;
	},
	signal?: AbortSignal
): Promise<
	| { kind: "online_score"; score: EvalCaseScore; scored_at: string }
	| AppResponseValue
> {
	return await request(
		target,
		"/api/gateway/evals/score",
		{
			method: "POST",
			body: input,
			signal,
		},
		appResponseValueSchema
	);
}

/** Run the server-owned bounded red-team probe set through Core. */
export async function runGatewayRedTeam(
	target: ApiTarget,
	input: {
		agent_id: string;
		model?: string;
		strategies?: string[];
	},
	signal?: AbortSignal
): Promise<RedTeamRunResult> {
	return await request(
		target,
		"/api/gateway/redteam/run",
		{
			method: "POST",
			body: input,
			signal,
		},
		gatewayRedTeamSchema
	);
}
