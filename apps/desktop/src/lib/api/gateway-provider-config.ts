import type {
	GatewayCoreProviderView,
	GatewayLocalProviderView,
	ModelRouterType,
	RouteStrategy,
} from "@ryuhq/core-client/gateway.ts";
import type { GatewayProviderAccount } from "./gateway.ts";
import type { ByokProvider } from "./gateway-provider-keys.ts";

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
