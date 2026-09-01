use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// The budget config value-types moved to the extracted `ryu-gw-budget` stage
// crate; `AlertTier` (a cross-stage type used by firewall too) moved to
// `ryu-gw-contracts`. Re-exported here so every `crate::config::{AlertTier,
// Budget*, ExecBudget*}` path — and `GatewayConfig`'s `budgets` / `exec_budget`
// fields below — stay byte-unchanged.
pub use ryu_gw_budget::{BudgetAction, BudgetConfig, ExecBudgetAction, ExecBudgetConfig};
// `BudgetRule` / `SessionBudgetConfig` have no production caller today (config
// deserializes the whole `BudgetConfig`); they are re-exported to keep the
// stable `crate::config::{BudgetRule,SessionBudgetConfig}` path and are
// referenced by the config tests via `super::`. Kept for API-path stability.
#[allow(unused_imports)]
pub use ryu_gw_budget::{BudgetChargeInclusion, BudgetRule, SessionBudgetConfig};
pub use ryu_gw_contracts::AlertTier;

// The evals config value-type moved to the extracted `ryu-gw-evals` stage crate.
// Re-exported here so every `crate::config::EvalsConfig` path — and
// `GatewayConfig`'s `evals` field below — stays byte-unchanged.
pub use ryu_gw_evals::EvalsConfig;

// The audit config value-type moved to the extracted `ryu-gw-audit` stage crate.
// Re-exported here so every `crate::config::AuditConfig` path — and
// `GatewayConfig`'s `audit` field below — stays byte-unchanged.
pub use ryu_gw_audit::AuditConfig;

// The cache config value-types moved to the extracted `ryu-gw-cache` stage crate
// (co-located with the `Cache` / `SemanticCache` backends they configure).
// Re-exported here so every `crate::config::{CacheConfig, SemanticCacheConfig}`
// path — and `GatewayConfig`'s `cache` / `semantic_cache` fields below — stays
// byte-unchanged.
pub use ryu_gw_cache::{CacheConfig, SemanticCacheConfig};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GatewayConfig {
    #[serde(default = "default_bind")]
    pub bind: String,

    #[serde(default)]
    pub providers: ProvidersConfig,

    #[serde(default)]
    pub routing: RoutingConfig,

    /// Which `routing.model_map` key [`seed_classify_route`] inserted during
    /// [`Self::load`], if any. Provenance of a DERIVED value, never configuration —
    /// which is why it hangs off the config root rather than living inside
    /// [`RoutingConfig`] (a `routing` value that arrived on a `PUT` body has no
    /// provenance at all).
    ///
    /// `#[serde(skip)]`, so it exists ONLY in the in-memory config: never read from
    /// `gateway.toml`, never written back by [`Self::save`], not a field a
    /// `PUT /v1/config` body can set. It exists so
    /// [`Self::strip_seeded_classify_route`] can drop **exactly** the row the seed
    /// added — once a row is in the map, a seeded one and an operator's own
    /// byte-identical one are indistinguishable, and stripping by shape would
    /// silently rewrite a hand-authored file.
    ///
    /// `None` therefore also covers the row already being present when the file was
    /// read: a pre-existing `<classify id> → classify` row in `gateway.toml` (an
    /// alias a pre-fix gateway persisted, or a deliberate operator entry) is treated
    /// as operator-authored and left alone — the same conservative call `or_insert`
    /// makes about which entry wins.
    #[serde(skip)]
    pub seeded_classify_model: Option<String>,

    /// Whether the live `providers.classify` came from Core's `RYU_CLASSIFY_LLM_URL`
    /// rather than from `gateway.toml`. The second piece of derived-value provenance,
    /// `#[serde(skip)]` for the same reasons as [`Self::seeded_classify_model`].
    ///
    /// Why it has to exist: the env WINS this slot (see the env overlay in
    /// [`Self::load`]), and every provider slot serializes back out on
    /// [`Self::save`]. Without this marker the first save on a Core-spawned node
    /// would freeze Core's computed, **profile-scoped** loopback URL into the file as
    /// an operator-authored table — a value that is wrong the moment the profile,
    /// the port, or the machine changes, and one that becomes *live* the moment the
    /// gateway is started by something other than Core (no env ⇒ nothing shadows it).
    #[serde(skip)]
    pub env_injected_classify_provider: bool,

    /// The `[providers.classify]` table exactly as `gateway.toml` had it, captured by
    /// [`Self::load`] immediately before the env overwrote the live slot. `None` when
    /// the file carried no table (the ordinary Core-spawned case) *and* when the env
    /// did not fire at all — it is only ever written alongside
    /// [`Self::env_injected_classify_provider`].
    ///
    /// This exists because env-wins and "never persist a derived slot" would
    /// otherwise combine into data loss: the strip used to blank `providers.classify`
    /// outright, which was safe only while a file table BEAT the env (the marker was
    /// then never set for a file-authored table). Under env-wins the env overwrites
    /// the operator's table in memory, so a blanking strip would delete it from the
    /// file on the next `PUT`-triggered save. [`Self::strip_env_injected_classify_provider`]
    /// therefore *restores* this value rather than clearing the slot.
    ///
    /// `#[serde(skip)]`: provenance, never configuration — a `PUT /v1/config` body
    /// must not be able to nominate what a save writes into the operator's file.
    #[serde(skip)]
    pub file_classify_provider: Option<ClassifyProviderConfig>,

    #[serde(default)]
    pub firewall: FirewallConfig,

    /// User-created ("create from scratch") evaluators that EXTEND the built-in
    /// evaluator catalog (unified-evaluator system). Merged over
    /// [`crate::evaluators::builtin_catalog`] by
    /// [`crate::evaluators::EvaluatorRegistry::from_config`] — a custom entry
    /// overrides a built-in with the same `id`, and every custom entry is forced
    /// `builtin = false` at merge time. Authored via `PUT /v1/config`. Like
    /// `routing`/`tools`, the request path reads this startup snapshot, so a newly
    /// saved custom evaluator takes effect on the next gateway restart (the desktop
    /// save flow triggers a restart, mirroring the BYOK provider vault).
    /// `#[serde(default)]` + skip-when-empty keeps an existing `gateway.toml`
    /// byte-identical when none is authored — back-compat: no field == today.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_evaluators: Vec<crate::evaluators::Evaluator>,

    /// Persisted standalone-desktop org firewall overlays (node→org→agent
    /// cascade, hierarchical-policy spec §6), keyed by org id. Authored via
    /// `PUT /v1/config` and seeded back into the resolver at startup so they
    /// survive a gateway restart. `#[serde(default)]` + skip-when-empty keeps
    /// an existing `gateway.toml` byte-identical when no overlay is authored.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub firewall_org_overlays: HashMap<String, FirewallOverlay>,

    /// Persisted standalone-desktop per-agent firewall overlays (spec §6), keyed
    /// by agent id. Same round-trip + skip-when-empty semantics as
    /// `firewall_org_overlays`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub firewall_agent_overlays: HashMap<String, FirewallOverlay>,

    #[serde(default)]
    pub rate_limit: RateLimitConfig,

    #[serde(default)]
    pub auth: AuthConfig,

    #[serde(default)]
    pub cache: CacheConfig,

    #[serde(default)]
    pub circuit_breaker: CircuitBreakerConfig,

    #[serde(default)]
    pub concurrency: ConcurrencyConfig,

    /// Lifecycle and resource bounds for Core-owned ACP subprocesses. The Gateway
    /// persists this section because it is the node-level control surface, while
    /// Core enforces it where ACP processes actually run.
    #[serde(default)]
    pub acp: AcpConfig,

    /// Node-wide computer-use policy. The Gateway owns this persisted permission;
    /// the local Ghost/provider boundary applies platform support and safety checks
    /// before it uses a locked session.
    #[serde(default)]
    pub computer_use: ComputerUseConfig,

    #[serde(default)]
    pub skills: SkillsConfig,

    /// Gateway-owned kill switch and refresh cadence for personalized Marketplace
    /// recommendations. Core reads this section before fetching catalog data or
    /// invoking the recommendation adapter, so disabling it is authoritative for
    /// the whole node.
    #[serde(default)]
    pub marketplace_recommendations: MarketplaceRecommendationsConfig,

    #[serde(default)]
    pub audit: AuditConfig,

    #[serde(default)]
    pub evals: EvalsConfig,

    #[serde(default)]
    pub composio: ComposioConfig,

    /// Treg tool-router credentials. The token is runtime-only: fleet values
    /// arrive from the sealed provider vault and must never be written to
    /// `gateway.toml` or returned by `/v1/config`.
    #[serde(default)]
    pub treg: TregConfig,

    #[serde(default)]
    pub semantic_cache: SemanticCacheConfig,

    #[serde(default)]
    pub budgets: BudgetConfig,

    #[serde(default)]
    pub channels: ChannelsConfig,

    #[serde(default)]
    pub control_plane: ControlPlaneConfig,

    #[serde(default)]
    pub exec_budget: ExecBudgetConfig,

    #[serde(default)]
    pub compression: CompressionConfig,

    /// Per-stage active-backend selection (W6a). Each inverted pipeline stage
    /// (budget, cache, semantic_cache, audit, evals, circuit_breaker, rate_limit)
    /// keeps an id-keyed [`crate::budget::BudgetRegistry`]-style registry whose
    /// built-in is registered under `"builtin"` and active by default. This map
    /// names which registered backend is active for each stage. Applied at
    /// `AppState` build (fail-closed: an unknown id refuses startup, listing the
    /// registered ids) so the registries are load-bearing rather than dead code.
    /// `#[serde(default)]` + all-`"builtin"` default keeps an existing
    /// `gateway.toml` byte-identical — omitting the field == today's behavior.
    #[serde(default)]
    pub backends: StageBackendsConfig,

    /// Declarative pre-processing pipeline stage order (W6d). Empty ⇒ the
    /// immutable [`crate::pipeline::stages::DEFAULT_ORDER`] (today's exact
    /// sequence). Config may reorder/disable only the reorderable governance
    /// stages; a config that violates a safety invariant (disable firewall, move
    /// audit, …) refuses startup. `#[serde(default)]` + skip-when-empty keeps an
    /// existing `gateway.toml` byte-identical when no `[pipeline]` table is set.
    #[serde(default, skip_serializing_if = "pipeline_order_is_default")]
    pub pipeline: crate::pipeline::stages::PipelineOrderConfig,

    #[serde(default)]
    pub tools: ToolsConfig,

    #[serde(default)]
    pub widget: WidgetConfig,

    #[serde(default)]
    pub credits: CreditsConfig,

    /// Provider-side prompt caching (upstream keeps a prompt prefix warm so a
    /// repeated prefix is billed at a discount). Distinct from `cache` /
    /// `semantic_cache`, which are this gateway's own *response* caches.
    /// Default off — a cache write bills above the normal input rate, so
    /// enabling it moves a caller's bill.
    #[serde(default)]
    pub prompt_cache: PromptCacheConfig,

    /// Per-request NODE ROUTING PREFERENCES (`x-ryu-node-routing`). A managed
    /// node states what it would *prefer*; this section is the operator's lever
    /// over whether that preference is honoured at all, and how big a document
    /// the parser will look at. See [`crate::pipeline::node_routing`] for why
    /// every knob can only narrow the org's envelope.
    #[serde(default)]
    pub node_routing: NodeRoutingConfig,

    /// Fleet mode (managed-cloud WS2). When true, this gateway is a publicly
    /// reachable multi-tenant replica sitting behind a co-located load balancer /
    /// reverse proxy, so external callers arrive over the loopback interface and
    /// appear to the process as `127.0.0.1`. Under fleet mode the admin gate
    /// (`/v1/config`, `/v1/audit`) DROPS loopback trust entirely — those
    /// endpoints require the master key even from a loopback peer, because
    /// "loopback" no longer implies "local operator". Off by default (loopback
    /// trust preserved for local dev); set via `RYU_GATEWAY_FLEET`. Nothing
    /// hardcoded.
    #[serde(default)]
    pub fleet: bool,
}

/// Node-level provider prompt-cache policy — the serde face of
/// [`ryu_gw_providers::PromptCacheOptions`], which holds the actual injection
/// logic and documents the wire formats and precedence.
///
/// Every field defaults to today's behaviour (`mode = "off"`, inject nothing),
/// so an existing `gateway.toml` with no `[prompt_cache]` table is unchanged.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PromptCacheConfig {
    /// `"off"` (default) | `"auto"` | `"explicit"`. `auto` hands breakpoint
    /// placement to the provider; `explicit` places them here.
    #[serde(default = "prompt_cache_mode")]
    pub mode: String,
    /// `cache_control.ttl`, e.g. `"1h"`. Empty ⇒ the provider default (5 min).
    #[serde(default)]
    pub ttl: String,
    /// Skip injection below this estimated prompt size; under a provider's
    /// minimum cacheable prefix a breakpoint cannot hit but can still bill a
    /// write. 1024 is the smallest documented provider minimum.
    #[serde(default = "prompt_cache_min_prefix_tokens")]
    pub min_prefix_tokens: u64,
    /// Explicit-mode breakpoint budget, clamped to the Anthropic maximum of 4.
    #[serde(default = "prompt_cache_breakpoints")]
    pub breakpoints: usize,
    /// Forward `x-ryu-session-id` as the provider's cache-affinity `session_id`.
    /// Off by default: that header is an audit identifier, and reusing it as a
    /// cache key is a tenancy decision, not plumbing.
    #[serde(default)]
    pub session_affinity: bool,
    /// Honour the per-request `x-ryu-prompt-cache` / `x-ryu-prompt-cache-ttl`
    /// headers. On by default; an operator who needs a node-wide posture (fixed
    /// cost profile, compliance) turns it off so config is the only lever.
    #[serde(default = "default_true")]
    pub allow_request_override: bool,
}

impl Default for PromptCacheConfig {
    fn default() -> Self {
        Self {
            mode: prompt_cache_mode(),
            ttl: String::new(),
            min_prefix_tokens: prompt_cache_min_prefix_tokens(),
            breakpoints: prompt_cache_breakpoints(),
            session_affinity: false,
            allow_request_override: true,
        }
    }
}

/// Node-level policy for the per-request `x-ryu-node-routing` preference channel.
///
/// The defaults reproduce today's behaviour on an untouched install: nothing
/// changes until a caller actually sends the header, and a caller that never
/// sends it never notices this section exists. The size caps exist because the
/// document is parsed BEFORE it is trusted — they bound the work an unauthorized
/// (or merely buggy) sender can make the parser do, and they are byte counts on
/// the wire rather than semantic limits so they can be enforced without decoding.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct NodeRoutingConfig {
    /// Honour the per-request `x-ryu-node-routing` header at all. On by default,
    /// mirroring [`PromptCacheConfig::allow_request_override`]: an operator
    /// running a fixed routing profile (fixed cost envelope, compliance) turns it
    /// off so node config is the only lever and the header is dropped whole.
    #[serde(default = "default_true")]
    pub allow_request_override: bool,
    /// Reject (ignore) an encoded header longer than this many bytes, measured
    /// before base64 decoding. 4096 sits well inside the usual terminating-proxy
    /// per-header limits (nginx 8k, Cloudflare 16k total).
    #[serde(default = "node_routing_max_header_bytes")]
    pub max_header_bytes: usize,
    /// Ignore a document whose DECODED JSON exceeds this many bytes. Bounds the
    /// serde work, which the wire bound alone cannot (base64 expands 4:3).
    #[serde(default = "node_routing_max_doc_bytes")]
    pub max_doc_bytes: usize,
    /// Maximum `fallback` entries considered. Each surviving entry costs a pool
    /// lookup plus a credit-gate evaluation, so this is a work bound, not a
    /// policy one — the clamp already refuses ids outside the fleet chain.
    #[serde(default = "node_routing_max_fallback")]
    pub max_fallback: usize,
    /// Maximum `firewall.custom_patterns` a request may append.
    #[serde(default = "node_routing_max_patterns")]
    pub max_patterns: usize,
    /// Maximum total bytes of regex source across `firewall.custom_patterns`.
    #[serde(default = "node_routing_max_pattern_bytes")]
    pub max_pattern_bytes: usize,
}

fn node_routing_max_header_bytes() -> usize {
    4096
}
fn node_routing_max_doc_bytes() -> usize {
    3072
}
fn node_routing_max_fallback() -> usize {
    16
}
fn node_routing_max_patterns() -> usize {
    16
}
fn node_routing_max_pattern_bytes() -> usize {
    1024
}

impl Default for NodeRoutingConfig {
    fn default() -> Self {
        Self {
            allow_request_override: true,
            max_header_bytes: node_routing_max_header_bytes(),
            max_doc_bytes: node_routing_max_doc_bytes(),
            max_fallback: node_routing_max_fallback(),
            max_patterns: node_routing_max_patterns(),
            max_pattern_bytes: node_routing_max_pattern_bytes(),
        }
    }
}

impl PromptCacheConfig {
    /// Resolve into the provider-side policy. An unparseable `mode` falls back
    /// to `Off` rather than guessing: a typo must not silently start billing
    /// cache writes. An unsupported `ttl` likewise degrades to the provider
    /// default instead of being forwarded — an arbitrary value is rejected
    /// upstream mid-request, and on the Anthropic path it would also trigger the
    /// extended-TTL beta header. Same closed set Core validates against, so the
    /// two layers cannot disagree about what a legal TTL is.
    pub fn options(&self) -> ryu_gw_providers::PromptCacheOptions {
        let ttl = self.ttl.trim().to_ascii_lowercase();
        ryu_gw_providers::PromptCacheOptions {
            mode: ryu_gw_providers::PromptCacheMode::parse(&self.mode).unwrap_or_default(),
            ttl: ryu_gw_providers::prompt_cache::is_supported_ttl(&ttl).then_some(ttl),
            min_prefix_tokens: self.min_prefix_tokens,
            breakpoints: self.breakpoints,
            session_affinity: self.session_affinity,
        }
    }
}

fn prompt_cache_mode() -> String {
    "off".to_string()
}
fn prompt_cache_min_prefix_tokens() -> u64 {
    1024
}
fn prompt_cache_breakpoints() -> usize {
    2
}

/// The default active-backend id for every inverted pipeline stage: the built-in
/// in-process implementation, registered under `"builtin"` and active out of the
/// box. Nothing hardcoded — a plugin registers an alternative under a new id and
/// names it here (or via `PUT /v1/config { backends }`).
pub fn default_stage_backend() -> String {
    "builtin".to_string()
}

/// Skip serializing an unset `[pipeline]` table so an existing `gateway.toml`
/// stays byte-identical when no stage reorder/disable is configured.
fn pipeline_order_is_default(cfg: &crate::pipeline::stages::PipelineOrderConfig) -> bool {
    cfg == &crate::pipeline::stages::PipelineOrderConfig::default()
}

/// Per-stage active-backend selection (W6a). One id per inverted stage naming
/// which registered backend is active; the registries themselves live in
/// `crate::{budget,cache,semantic_cache,audit,evals,circuit_breaker,rate_limit}`.
/// Every field defaults to `"builtin"`, so an absent `[backends]` table is
/// byte-identical to today. Selection is applied at `AppState` build and refused
/// fail-closed when an id is not registered (see `AppState::new`).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct StageBackendsConfig {
    #[serde(default = "default_stage_backend")]
    pub budget: String,
    #[serde(default = "default_stage_backend")]
    pub cache: String,
    #[serde(default = "default_stage_backend")]
    pub semantic_cache: String,
    #[serde(default = "default_stage_backend")]
    pub audit: String,
    #[serde(default = "default_stage_backend")]
    pub evals: String,
    #[serde(default = "default_stage_backend")]
    pub circuit_breaker: String,
    #[serde(default = "default_stage_backend")]
    pub rate_limit: String,
    #[serde(default = "default_stage_backend")]
    pub firewall: String,
    #[serde(default = "default_stage_backend")]
    pub router: String,
    #[serde(default = "default_stage_backend")]
    pub smart_router: String,
    #[serde(default = "default_stage_backend")]
    pub passthrough: String,
}

impl Default for StageBackendsConfig {
    fn default() -> Self {
        Self {
            budget: default_stage_backend(),
            cache: default_stage_backend(),
            semantic_cache: default_stage_backend(),
            audit: default_stage_backend(),
            evals: default_stage_backend(),
            circuit_breaker: default_stage_backend(),
            rate_limit: default_stage_backend(),
            firewall: default_stage_backend(),
            router: default_stage_backend(),
            smart_router: default_stage_backend(),
            passthrough: default_stage_backend(),
        }
    }
}

/// Provider-level billing mode for managed provider costs.
///
/// `inherit_global` preserves the existing `[credits].markup_bps` behavior.
/// `pass_through` charges the raw provider cost with no platform markup. This
/// controls wallet pricing only; it does not change credential ownership or
/// subscription-preserving egress.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderBillingMode {
    #[default]
    InheritGlobal,
    PassThrough,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProviderBillingPolicy {
    #[serde(default)]
    pub mode: ProviderBillingMode,
}

/// Platform-credits wallet debit hook (marketplace monetization #486, spec §4).
///
/// When enabled, after each metered model call the gateway debits the request's
/// org wallet in the control plane by the call's `costMicroUsd` (plus a
/// configurable platform markup). When the debit response reports a non-positive
/// balance, the org is flagged so the *next* request's budget gate fires (the
/// debit is post-call; the gate is pre-call — same one-call-grace shape as the
/// shared-budget coordinator). Disabled by default and a full no-op when the
/// request carries no org (`x-ryu-org-id` / key org), so existing behavior is
/// unchanged. Nothing hardcoded — every knob is a swappable default.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CreditsConfig {
    /// Master switch for the debit hook. Default: false.
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the control-plane API the debit endpoint lives on, e.g.
    /// `http://127.0.0.1:3000/api`. Defaults to the same control-plane URL.
    #[serde(default = "default_control_plane_url")]
    pub base_url: String,
    /// Shared internal secret sent as `x-ryu-internal-secret` so the control
    /// plane trusts a service-to-service debit for an arbitrary org. The hook is
    /// inert without it (the debit endpoint would reject the call).
    pub internal_secret: Option<String>,
    /// Platform markup on metered usage in basis points. The debited amount is
    /// `costMicroUsd * (10000 + markup_bps) / 10000`, round-half-up. Default: 0
    /// (pass-through at cost).
    #[serde(default)]
    pub markup_bps: u64,
    /// Provider-level billing modes. This is an operational billing policy, not
    /// the routing `provider_tiers` map and not subscription credential
    /// passthrough. Unknown ids are harmless and allow a provider adapter to be
    /// enabled before its first request reaches this gateway.
    #[serde(default)]
    pub provider_billing: HashMap<ProviderId, ProviderBillingPolicy>,
    /// Per-tool-call cost in micro-USD for billable (Composio) tool executions.
    ///
    /// AT COST, and that is the whole pricing position: Composio charges per
    /// action execution at $0.30/1k on the standard rate, so this defaults to
    /// 300 micro-USD per call and the customer is billed exactly what the
    /// provider bills us. Margin lives in the deposit fee, never in a per-unit
    /// markup (`markup_bps` is 0) — see `docs/pricing-remaining-work.md` item 6.
    ///
    /// ONE FLAT CLASS, deliberately. Composio's premium tools bill at 3x, but
    /// nothing in an execution response says which class a tool is, so telling
    /// them apart would mean a hand-maintained list of toolkit slugs that
    /// silently under-bills whatever it omits and has to be re-checked whenever
    /// Composio moves a tool. A single at-cost rate is honest, needs no
    /// maintenance, and cannot restrict which toolkits work.
    ///
    /// Overridable per deployment with
    /// `GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD` for a different Composio
    /// contract.
    #[serde(default = "default_cost_per_tool_call_micro_usd")]
    pub cost_per_tool_call_micro_usd: u64,
    /// Micro-USD per second of provider compute, used to price a media call from
    /// the compute time the provider actually reported.
    ///
    /// Replicate's published Nvidia L40S rate ($0.000975/sec) is the default —
    /// its most common serverless GPU, and a real published figure rather than
    /// an invented one. Override per deployment with
    /// `GATEWAY_CREDITS_COST_PER_GPU_SECOND_MICRO_USD` if you route to different
    /// hardware.
    ///
    /// This is what makes media metering track the TRANSACTION. A flat per-call
    /// rate charges a two-second image and a sixty-second video identically; the
    /// same configured number is then wrong by up to ~30x in both directions,
    /// and no single value fixes it.
    #[serde(default = "default_cost_per_gpu_second_micro_usd")]
    pub cost_per_gpu_second_micro_usd: u64,

    /// Per-call cost in micro-USD for a successful image generation — THE
    /// FALLBACK the flat path charges when the provider reported no compute time.
    /// Cloud media providers (Replicate/Fal/OpenRouter) may report a
    /// `usage.cost`; when present, that provider-reported USD amount wins. A
    /// call with no reported cost is debited at this flat fallback rate through
    /// the same at-cost + markup path as tokens. Default:
    /// [`default_cost_per_image_micro_usd`]
    /// (`GATEWAY_CREDITS_COST_PER_IMAGE_MICRO_USD`).
    ///
    /// These four defaulted to 0, which is what a fallback must never be: the
    /// media debit is guarded by `if cost > 0`, so a fallback that prices to
    /// nothing does not charge a small amount — it skips the debit entirely,
    /// silently, while the provider still invoices us. That combination already
    /// shipped once (the async video job, see `media_cost_micro_usd`).
    #[serde(default = "default_cost_per_image_micro_usd")]
    pub cost_per_image_micro_usd: u64,
    /// Per-call fallback cost in micro-USD for a successful video generation job.
    /// `GATEWAY_CREDITS_COST_PER_VIDEO_MICRO_USD`. Default:
    /// [`default_cost_per_video_micro_usd`].
    #[serde(default = "default_cost_per_video_micro_usd")]
    pub cost_per_video_micro_usd: u64,
    /// Per-call fallback cost in micro-USD for a successful Audio synthesis.
    /// `GATEWAY_CREDITS_COST_PER_TTS_MICRO_USD`. Default:
    /// [`default_cost_per_tts_micro_usd`].
    #[serde(default = "default_cost_per_tts_micro_usd")]
    pub cost_per_tts_micro_usd: u64,
    /// Per-call fallback cost in micro-USD for a successful Voice Recognition transcription.
    /// `GATEWAY_CREDITS_COST_PER_STT_MICRO_USD`. Default:
    /// [`default_cost_per_stt_micro_usd`].
    #[serde(default = "default_cost_per_stt_micro_usd")]
    pub cost_per_stt_micro_usd: u64,
    /// What the budget layer does when an org's wallet is empty: `stop` (default)
    /// aborts the next request; `downgrade` reroutes to `wallet_empty_downgrade_to`.
    #[serde(default)]
    pub wallet_empty_action: WalletEmptyAction,
    /// Model to downgrade to when `wallet_empty_action = downgrade`. When unset, a
    /// downgrade safely degrades to a restrict (mirrors the spend-budget rule).
    #[serde(default)]
    pub wallet_empty_downgrade_to: Option<String>,
    /// Notification fan-out tier when the org wallet-empty rule matches
    /// (orthogonal to `wallet_empty_action`). Old configs → `Silent`.
    #[serde(default)]
    pub wallet_empty_alert: AlertTier,
    /// Hold an estimate of a managed request's cost against the org's balance
    /// for the life of that request, so concurrent requests cannot all spend the
    /// same balance. `GATEWAY_CREDITS_RESERVE`. Default: **true**.
    ///
    /// Off restores the pre-reservation behaviour: the gate becomes "is the
    /// balance positive", every in-flight request is invisible to every other,
    /// and the only bound on a burst is the per-org rate limit. That is a
    /// deliberate escape hatch for an operator debugging a false 402, not a
    /// posture anyone should run on.
    #[serde(default = "default_true")]
    pub reserve_enabled: bool,
    /// Floor for a single request's reservation, in micro-USD.
    /// `GATEWAY_CREDITS_MIN_RESERVE_MICRO_USD`. Default: 10_000 ($0.01).
    ///
    /// THIS FLOOR, NOT THE ESTIMATE, IS WHAT BOUNDS A BURST. The per-request
    /// estimate is derived from `max_tokens` at the flat
    /// `control_plane.cost_per_1k_micro_usd` rate, which is the only price basis
    /// the gateway holds — it has no per-model price table, and for OpenRouter
    /// traffic the true cost only arrives with the response's `usage.cost`. So
    /// the estimate systematically UNDER-states a frontier model and cannot be
    /// leaned on alone. The floor makes the bound explicit and model-independent:
    /// at most `balance / min_reserve` requests can be in flight for an org, so
    /// a $10 balance admits at most 1000 concurrent requests at the default, and
    /// a wallet holding a fraction of a cent admits none.
    ///
    /// Raise it to tighten the burst bound at the cost of refusing more
    /// legitimate concurrency; it is the one number to tune if a managed tenant
    /// ever outruns its wallet.
    #[serde(default = "default_min_reserve_micro_usd")]
    pub min_reserve_micro_usd: u64,
    /// Per-request timeout in milliseconds for the debit POST. Default: 3000.
    #[serde(default = "default_credits_timeout_ms")]
    pub timeout_ms: u64,
    /// Fail CLOSED on debit errors for managed tenants (env
    /// `GATEWAY_CREDITS_FAIL_CLOSED`). Default: false (preserves today's
    /// fail-open behavior). When true and the request is a managed-inference
    /// tenant, a debit transport error or non-2xx response flips that org's
    /// wallet-empty flag so the NEXT request is refused, instead of the failure
    /// being silently swallowed. The current in-flight response is never blocked
    /// on the (async) debit — the failure is just made sticky.
    #[serde(default)]
    pub fail_closed: bool,

    // ─── Sandbox per-resource rates (Daytona), nano-USD per unit-second ───────
    // Rates are stored in NANO-USD (not micro) because the Daytona storage rate
    // (0.03 micro-USD/GiB/s) truncates to 0 in a u64 micro-USD field, silently
    // disabling storage billing. Everything downstream (accrual, debit, wallet,
    // balance, budgets) stays micro-USD — the single nano→micro conversion
    // happens inside `sandbox_tick_cost_raw_micro`.
    //
    // Every rate below carries `default = "fn"`, NOT a bare `#[serde(default)]`.
    // The difference is only visible when a `[credits]` table is PRESENT and
    // omits the rate — which is the shape the published self-host doc hands
    // operators (`docs/gateway/configuration.mdx`, the `[credits]` sample lists
    // `enabled`/`base_url`/`internal_secret`/`markup_bps`/`wallet_empty_*`/
    // `timeout_ms` and no sandbox rate at all). An ABSENT `[credits]` table takes
    // `impl Default for CreditsConfig` and was always correct; a present one used
    // to deserialize all nine rates to 0, and a 0 rate is not "free", it is
    // billing turned OFF plus a missing safety stop:
    // `sandbox_tick_cost_raw_micro` returns 0 → `sandbox_debit_amount` returns 0
    // → `debit_sandbox_sync` short-circuits on `billed_micro == 0` and returns
    // `None` → `compute_verdict` sees `balance: None` and cannot reach
    // `KillBalance`, and `accrued` never grows so `KillBudget` is unreachable
    // too. A sandbox on a drained wallet runs until something else stops it.
    // (Core-spawned gateways were rescued incidentally because Core force-injects
    // all nine `GATEWAY_CREDITS_COST_PER_SANDBOX_*` envs at spawn; a hand-run
    // gateway following the doc got the zeros.)
    //
    // The default fns are the SINGLE source for these nine numbers —
    // `impl Default for CreditsConfig` calls them rather than repeating the
    // literals, so the serde path and the struct default cannot drift apart.
    /// vCPU rate, nano-USD per vCPU-second. Default: 14000 (0.014 micro/s).
    #[serde(default = "default_sandbox_vcpu_rate")]
    pub cost_per_sandbox_vcpu_second_nano_usd: u64,
    /// Memory rate, nano-USD per GiB-second. Default: 4500.
    #[serde(default = "default_sandbox_mem_rate")]
    pub cost_per_sandbox_mem_gib_second_nano_usd: u64,
    /// Storage rate, nano-USD per GiB-second (over the free tier). Default: 30.
    #[serde(default = "default_sandbox_storage_rate")]
    pub cost_per_sandbox_storage_gib_second_nano_usd: u64,
    /// GPU H200 rate, nano-USD per GPU-second. Default: 1261000.
    #[serde(default = "default_sandbox_gpu_h200_rate")]
    pub cost_per_sandbox_gpu_h200_second_nano_usd: u64,
    /// GPU H100 rate, nano-USD per GPU-second. Default: 1097000.
    #[serde(default = "default_sandbox_gpu_h100_rate")]
    pub cost_per_sandbox_gpu_h100_second_nano_usd: u64,
    /// GPU RTX PRO 6000 rate, nano-USD per GPU-second. Default: 842000.
    #[serde(default = "default_sandbox_gpu_rtx_pro_6000_rate")]
    pub cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd: u64,
    /// GPU RTX 5090 rate, nano-USD per GPU-second. Default: 358000.
    #[serde(default = "default_sandbox_gpu_rtx_5090_rate")]
    pub cost_per_sandbox_gpu_rtx_5090_second_nano_usd: u64,
    /// GPU RTX 4090 rate, nano-USD per GPU-second. Default: 275000.
    #[serde(default = "default_sandbox_gpu_rtx_4090_rate")]
    pub cost_per_sandbox_gpu_rtx_4090_second_nano_usd: u64,
    /// Windows surcharge, nano-USD per vCPU-second (added on top of the base
    /// vCPU rate for Windows workspaces). Default: 23800.
    #[serde(default = "default_sandbox_windows_vcpu_rate")]
    pub cost_per_sandbox_windows_vcpu_second_nano_usd: u64,
    /// Storage GiB that are free before the storage rate applies. Default: 5.
    #[serde(default = "default_sandbox_free_storage_gib")]
    pub sandbox_free_storage_gib: u64,
    /// Platform markup on metered sandbox usage in basis points. SEPARATE from
    /// the global `markup_bps` (which is pinned 0 for at-cost tokens/Composio);
    /// sandbox carries its own margin. Default: 3000 (× 1.30).
    #[serde(default = "default_sandbox_markup_bps")]
    pub sandbox_markup_bps: u64,
}

/// GPU tier for a sandbox workspace. Canonical definition (Core mirrors it).
/// Explicit per-variant serde renames (do NOT rely on `rename_all`, which
/// mishandles the digits in `rtx_5090`/`rtx_4090`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum GpuKind {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "h200")]
    H200,
    #[serde(rename = "h100")]
    H100,
    #[serde(rename = "rtx_pro_6000")]
    RtxPro6000,
    #[serde(rename = "rtx_5090")]
    Rtx5090,
    #[serde(rename = "rtx_4090")]
    Rtx4090,
}

/// Operating system for a sandbox workspace. Canonical definition (Core mirrors
/// it). Windows carries a per-vCPU-second surcharge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum OsKind {
    #[serde(rename = "linux")]
    Linux,
    #[serde(rename = "windows")]
    Windows,
}

/// The budget action taken when an org's credit wallet is empty.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WalletEmptyAction {
    /// Abort the next request (`BudgetExceeded`). The default.
    #[default]
    Stop,
    /// Reroute to the configured cheaper model.
    Downgrade,
}

fn default_credits_timeout_ms() -> u64 {
    3000
}

/// $0.01. See [`CreditsConfig::min_reserve_micro_usd`] for why the floor rather
/// than the estimate is the number that bounds a burst.
fn default_min_reserve_micro_usd() -> u64 {
    10_000
}

fn default_sandbox_markup_bps() -> u64 {
    3000
}

fn default_sandbox_free_storage_gib() -> u64 {
    5
}

// ─── Sandbox rate defaults (nano-USD per unit-second) ────────────────────────
// These nine fns are the ONLY place the published sandbox rates are written.
// Both the serde `default = "…"` attribute on each `CreditsConfig` field and
// `impl Default for CreditsConfig` call them, so "the default when the key is
// absent from a present `[credits]` table" and "the default when the whole table
// is absent" are the same number by construction rather than by review.

fn default_sandbox_vcpu_rate() -> u64 {
    14_000
}

fn default_sandbox_mem_rate() -> u64 {
    4_500
}

fn default_sandbox_storage_rate() -> u64 {
    30
}

fn default_sandbox_gpu_h200_rate() -> u64 {
    1_261_000
}

fn default_sandbox_gpu_h100_rate() -> u64 {
    1_097_000
}

fn default_sandbox_gpu_rtx_pro_6000_rate() -> u64 {
    842_000
}

fn default_sandbox_gpu_rtx_5090_rate() -> u64 {
    358_000
}

fn default_sandbox_gpu_rtx_4090_rate() -> u64 {
    275_000
}

fn default_sandbox_windows_vcpu_rate() -> u64 {
    23_800
}

impl Default for CreditsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_control_plane_url(),
            internal_secret: None,
            markup_bps: 0,
            provider_billing: HashMap::new(),
            cost_per_tool_call_micro_usd: default_cost_per_tool_call_micro_usd(),
            cost_per_gpu_second_micro_usd: default_cost_per_gpu_second_micro_usd(),
            cost_per_image_micro_usd: default_cost_per_image_micro_usd(),
            cost_per_video_micro_usd: default_cost_per_video_micro_usd(),
            cost_per_tts_micro_usd: default_cost_per_tts_micro_usd(),
            cost_per_stt_micro_usd: default_cost_per_stt_micro_usd(),
            wallet_empty_action: WalletEmptyAction::default(),
            wallet_empty_downgrade_to: None,
            wallet_empty_alert: AlertTier::default(),
            reserve_enabled: default_true(),
            min_reserve_micro_usd: default_min_reserve_micro_usd(),
            timeout_ms: default_credits_timeout_ms(),
            fail_closed: false,
            // Delegated, not repeated: these must equal the serde `default = "…"`
            // fns on the same fields or an absent `[credits]` table and a present
            // one that omits the rates would bill differently.
            cost_per_sandbox_vcpu_second_nano_usd: default_sandbox_vcpu_rate(),
            cost_per_sandbox_mem_gib_second_nano_usd: default_sandbox_mem_rate(),
            cost_per_sandbox_storage_gib_second_nano_usd: default_sandbox_storage_rate(),
            cost_per_sandbox_gpu_h200_second_nano_usd: default_sandbox_gpu_h200_rate(),
            cost_per_sandbox_gpu_h100_second_nano_usd: default_sandbox_gpu_h100_rate(),
            cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd:
                default_sandbox_gpu_rtx_pro_6000_rate(),
            cost_per_sandbox_gpu_rtx_5090_second_nano_usd: default_sandbox_gpu_rtx_5090_rate(),
            cost_per_sandbox_gpu_rtx_4090_second_nano_usd: default_sandbox_gpu_rtx_4090_rate(),
            cost_per_sandbox_windows_vcpu_second_nano_usd: default_sandbox_windows_vcpu_rate(),
            sandbox_free_storage_gib: default_sandbox_free_storage_gib(),
            sandbox_markup_bps: default_sandbox_markup_bps(),
        }
    }
}

impl CreditsConfig {
    /// Whether this gateway provider is configured as raw-cost pass-through.
    /// Provider ids are operational strings, so matching is trimmed and
    /// case-insensitive while preserving the configured spelling on the wire.
    pub fn is_pass_through_provider(&self, provider: &str) -> bool {
        let provider = provider.trim();
        !provider.is_empty()
            && self.provider_billing.iter().any(|(configured, policy)| {
                configured.as_str().eq_ignore_ascii_case(provider)
                    && policy.mode == ProviderBillingMode::PassThrough
            })
    }

    /// The amount to debit (micro-USD) for a call costing `cost_micro_usd`, after
    /// applying the platform markup. Round-half-up; saturating to avoid overflow.
    /// With `markup_bps == 0` this is the identity (pass-through at cost).
    pub fn debit_amount(&self, cost_micro_usd: u64) -> u64 {
        const BPS_DENOM: u64 = 10_000;
        cost_micro_usd
            .saturating_mul(BPS_DENOM.saturating_add(self.markup_bps))
            .saturating_add(BPS_DENOM / 2)
            / BPS_DENOM
    }

    /// The charged amount for a raw provider cost, using the provider-level
    /// pass-through policy when one is configured and the global markup for all
    /// other providers. `None` keeps the legacy global-markup behavior for
    /// unattributed charges.
    pub fn debit_amount_for_provider(&self, provider: Option<&str>, cost_micro_usd: u64) -> u64 {
        if provider.is_some_and(|name| self.is_pass_through_provider(name)) {
            cost_micro_usd
        } else {
            self.debit_amount(cost_micro_usd)
        }
    }

    /// The inverse of [`Self::debit_amount`]: the raw provider cost whose debit
    /// would come to at most `debit_micro_usd`.
    ///
    /// Needed to size a spend ceiling. A budget is denominated in CHARGED
    /// micro-USD, but a token ceiling has to be computed from RAW provider cost,
    /// so converting the wrong way round (or not at all) hands out a ceiling the
    /// subsequent debit then exceeds — which is precisely the overdraft the
    /// ceiling exists to prevent.
    ///
    /// Rounds DOWN, deliberately, and does not round-half-up the way
    /// `debit_amount` does: this is a ceiling, so the error must fall on the side
    /// of charging less than the budget rather than a hair more.
    pub fn undo_debit_amount(&self, debit_micro_usd: u64) -> u64 {
        const BPS_DENOM: u64 = 10_000;
        let scale = BPS_DENOM.saturating_add(self.markup_bps);
        if scale == 0 {
            return debit_micro_usd;
        }
        debit_micro_usd.saturating_mul(BPS_DENOM) / scale
    }

    /// Inverse of [`Self::debit_amount_for_provider`], used when a charged
    /// wallet headroom must be converted into a raw-cost or token ceiling.
    pub fn undo_debit_amount_for_provider(
        &self,
        provider: Option<&str>,
        debit_micro_usd: u64,
    ) -> u64 {
        if provider.is_some_and(|name| self.is_pass_through_provider(name)) {
            debit_micro_usd
        } else {
            self.undo_debit_amount(debit_micro_usd)
        }
    }

    /// The raw (pre-markup) cost in micro-USD for `n` billable tool calls. Pass
    /// the result through [`Self::debit_amount`] to apply the platform markup,
    /// Refuse a configuration that meters money but charges nothing for it.
    ///
    /// A per-call rate of 0 means the customer's wallet is debited NOTHING while
    /// the upstream provider still invoices us — Composio bills per action
    /// execution, and image/video/TTS/STT all carry real per-call costs. Every
    /// one of those rates used to default to 0; they now default to a real
    /// number, so reaching 0 takes an explicit key in the deploy config.
    ///
    /// That old default was justified as protecting OSS self-hosters. It did not:
    /// `enabled` is ALSO false by default, so a self-hosted gateway performs no
    /// debits at all regardless of the rates. The only deployment that reaches
    /// these fields is one that deliberately switched billing ON — which makes a
    /// zero rate a misconfiguration in every case that can actually occur, not a
    /// supported mode. It is a silent one, too: nothing errors, requests succeed,
    /// and the loss shows up as a provider invoice with no matching revenue.
    ///
    /// So: with credits enabled, an EXPLICIT zero on a synchronously-served rate
    /// is a hard startup failure. An *unset* rate is not — it resolves to the
    /// field's `default = "fn"`, which is the change that let this gate be widened
    /// back out without keeping nodes down while an operator invents numbers. The
    /// escape hatch is explicit rather than implicit — set
    /// `GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1` to deliberately give a modality
    /// away, which leaves a decision in the deploy config instead of a blank.
    pub fn validate_metered_rates(&self) -> anyhow::Result<()> {
        if !self.enabled {
            return Ok(());
        }
        if std::env::var("GATEWAY_CREDITS_ALLOW_FREE_MODALITIES")
            .is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        {
            return Ok(());
        }

        // A ZERO IS ONLY EVER A DELIBERATE ONE NOW.
        //
        // This used to hard-fail on all five per-call rates, and was then cut
        // back to the tool rate alone because a managed node would not boot until
        // an operator had invented numbers — a gate demanding configuration that
        // kept nodes down at exactly the moment someone was restarting one. That
        // reason is gone: every rate this checks now carries a real `default =
        // "fn"`, so an unset key resolves to a working number and the gate can
        // only trip when a deployment writes an explicit `0`. Refusing an
        // explicit 0 costs a booting node nothing and is the whole point.
        //
        // The premise the cut-back was argued on was WRONG, and it is worth
        // stating plainly because it let a zero rate through twice: the claim was
        // that "image and video are metered from the provider's REPORTED cost, so
        // a flat rate of 0 there is a fallback that is never reached". That is
        // true of the SYNCHRONOUS media path only. The async video job debits
        // after the render, out of band, and its provider payload may carry no
        // compute time at all — so it lands on the flat rate, hits the `if cost >
        // 0` guard, and bills nothing. See
        // `an_async_video_job_bills_from_the_provider_payload_not_the_flat_rate`.
        //
        // Every media fallback is gated here alongside tool calls. Image and
        // video usually have a provider timing value, but the fallback is still
        // reachable for async jobs and providers that report no timing. A zero
        // fallback would otherwise skip the debit under the `cost > 0` guard.
        if self.cost_per_tool_call_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD is 0, \
so every Composio tool call bills the customer nothing while Composio still charges us. \
Unset it to take the at-cost default (300 = $0.30/1k), or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give tool calls away on purpose."
            );
        }
        if self.cost_per_tts_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_TTS_MICRO_USD is 0, \
so every TTS synthesis bills the customer nothing while the provider still charges us. \
Unset it to take the derived default, or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give TTS away on purpose."
            );
        }
        if self.cost_per_stt_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_STT_MICRO_USD is 0, \
so every STT transcription bills the customer nothing while the provider still charges us. \
Unset it to take the derived default, or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give STT away on purpose."
            );
        }
        if self.cost_per_image_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_IMAGE_MICRO_USD is 0, \
so an image without provider compute timing bills the customer nothing while the provider still charges us. \
Unset it to take the derived default, or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give images away on purpose."
            );
        }
        if self.cost_per_video_micro_usd == 0 {
            anyhow::bail!(
                "credits are ENABLED but GATEWAY_CREDITS_COST_PER_VIDEO_MICRO_USD is 0, \
so an async video job without provider compute timing bills the customer nothing while the provider still charges us. \
Unset it to take the derived default, or set \
GATEWAY_CREDITS_ALLOW_FREE_MODALITIES=1 to give videos away on purpose."
            );
        }
        Ok(())
    }

    /// exactly like token cost. Saturating to avoid overflow.
    pub fn tool_call_cost_micro_usd(&self, n: u64) -> u64 {
        self.cost_per_tool_call_micro_usd.saturating_mul(n)
    }

    /// The raw (pre-markup) flat cost in micro-USD for one successful media call
    /// of `modality`. Chat is never metered here (it uses real token/usage.cost);
    /// returns 0 for Chat and for any modality whose per-call rate is unset. Pass
    /// through [`Self::debit_amount`] to apply the platform markup, like tokens.
    /// Cost for one media call, preferring provider-reported `usage.cost`, then
    /// reported compute time, and finally the configured flat rate.
    ///
    /// Returns the amount and whether it was ESTIMATED. The flag is not
    /// decoration: a flat-rate fallback is a guess, and recording which ledger
    /// rows were guesses is what makes a later reconciliation against the
    /// provider's own invoice possible. Without it, an estimate and a measured
    /// charge are indistinguishable after the fact.
    pub fn media_cost_from_response(
        &self,
        modality: &Modality,
        response: &serde_json::Value,
    ) -> (u64, bool) {
        // OpenRouter's image adapter preserves the original chat response under
        // `raw`, while other providers commonly leave `usage` at the top level.
        // Prefer either provider-reported cost before using a local estimate.
        let reported_cost_usd = response
            .get("usage")
            .and_then(|usage| usage.get("cost"))
            .or_else(|| {
                response
                    .get("raw")
                    .and_then(|raw| raw.get("usage"))
                    .and_then(|usage| usage.get("cost"))
            })
            .and_then(serde_json::Value::as_f64)
            .filter(|cost| cost.is_finite() && *cost >= 0.0);
        if let Some(cost_usd) = reported_cost_usd {
            return (((cost_usd * 1_000_000.0).round()).max(0.0) as u64, false);
        }

        let seconds = response
            .get("usage")
            .and_then(|u| u.get("compute_seconds"))
            .and_then(serde_json::Value::as_f64)
            .filter(|s| *s > 0.0);
        if let Some(seconds) = seconds {
            if self.cost_per_gpu_second_micro_usd > 0 {
                // Round UP: a partial second of GPU time is a second we are
                // billed for, and rounding down would leak a sliver on every
                // call.
                let micro = (seconds * self.cost_per_gpu_second_micro_usd as f64).ceil();
                return (micro.max(0.0) as u64, false);
            }
        }
        // Audio and Voice Recognition have no provider-reported cost or compute-
        // time path, so their configured per-call rate is the actual price rather
        // than an estimate. Image and video are the modalities where this flat
        // amount is a fallback.
        (
            self.media_cost_micro_usd(modality),
            matches!(modality, Modality::Image | Modality::Video),
        )
    }

    /// The flat configured rate for a modality. For image/video it is THE
    /// FALLBACK, never the primary price; Audio/Voice Recognition have no
    /// provider-reported cost path, so this configured per-call amount is their
    /// actual price.
    ///
    /// PRIVATE ON PURPOSE. Call {@link media_cost_from_response} instead, which
    /// prefers the provider's reported compute time and returns a flag saying
    /// which of the two paid, so the ledger can mark an estimated row.
    ///
    /// This was `pub`, and the async video-job debit reached past
    /// `media_cost_from_response` to call it directly. `cost_per_video_micro_usd`
    /// then defaulted to 0 and the debit is guarded by `if cost > 0`, so every
    /// completed async video job billed NOTHING under the default config — while
    /// the startup gate had stopped guarding the video rate precisely because
    /// video was believed to be metered from provider cost. Narrowing the
    /// visibility is what makes that combination unrepresentable rather than
    /// merely fixed; giving all four rates a non-zero default is what removes the
    /// other half of it.
    fn media_cost_micro_usd(&self, modality: &Modality) -> u64 {
        match modality {
            Modality::Image => self.cost_per_image_micro_usd,
            Modality::Video => self.cost_per_video_micro_usd,
            Modality::Tts => self.cost_per_tts_micro_usd,
            Modality::Stt => self.cost_per_stt_micro_usd,
            Modality::Chat => 0,
        }
    }

    /// Whether the hook is active: enabled with both a control-plane URL and an
    /// internal secret. Without the secret the control plane rejects the debit,
    /// so treat it as disabled rather than emitting doomed calls.
    pub fn is_active(&self) -> bool {
        self.enabled && self.internal_secret.is_some() && !self.base_url.trim().is_empty()
    }

    /// Per-GPU-second rate in nano-USD for a GPU tier. `None` costs nothing.
    pub fn gpu_rate_nano(&self, gpu: GpuKind) -> u64 {
        match gpu {
            GpuKind::None => 0,
            GpuKind::H200 => self.cost_per_sandbox_gpu_h200_second_nano_usd,
            GpuKind::H100 => self.cost_per_sandbox_gpu_h100_second_nano_usd,
            GpuKind::RtxPro6000 => self.cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd,
            GpuKind::Rtx5090 => self.cost_per_sandbox_gpu_rtx_5090_second_nano_usd,
            GpuKind::Rtx4090 => self.cost_per_sandbox_gpu_rtx_4090_second_nano_usd,
        }
    }

    /// Raw (pre-markup) cost of one sandbox tick in MICRO-USD. Takes primitive
    /// args so this module does not depend on the metering route's `SandboxSpec`.
    /// Rates are summed in nano-USD per second, multiplied by `seconds`, then
    /// converted once to micro-USD (round-half-up). Storage is billed only above
    /// the free tier; a GPU count of 0 with a non-`None` tier bills as 1.
    pub fn sandbox_tick_cost_raw_micro(
        &self,
        vcpu: u32,
        mem_gib: u32,
        storage_gib: u32,
        gpu: GpuKind,
        gpu_count: u32,
        os: OsKind,
        seconds: u64,
    ) -> u64 {
        let vcpu = u64::from(vcpu);
        let billable_storage = u64::from(storage_gib).saturating_sub(self.sandbox_free_storage_gib);
        let eff_gpu = match gpu {
            GpuKind::None => 0,
            _ => u64::from(gpu_count.max(1)),
        };
        let per_sec_nano = vcpu
            .saturating_mul(self.cost_per_sandbox_vcpu_second_nano_usd)
            .saturating_add(
                u64::from(mem_gib).saturating_mul(self.cost_per_sandbox_mem_gib_second_nano_usd),
            )
            .saturating_add(
                billable_storage.saturating_mul(self.cost_per_sandbox_storage_gib_second_nano_usd),
            )
            .saturating_add(eff_gpu.saturating_mul(self.gpu_rate_nano(gpu)))
            .saturating_add(match os {
                OsKind::Windows => {
                    vcpu.saturating_mul(self.cost_per_sandbox_windows_vcpu_second_nano_usd)
                }
                OsKind::Linux => 0,
            });
        let total_nano = per_sec_nano.saturating_mul(seconds);
        // nano -> micro, round half up.
        total_nano.saturating_add(500) / 1_000
    }

    /// The amount to debit (micro-USD) for a sandbox tick costing
    /// `cost_micro_usd`, after applying the sandbox markup. SEPARATE from
    /// [`Self::debit_amount`]: this uses `sandbox_markup_bps` (default 3000 ⇒
    /// × 1.30), not the global at-cost `markup_bps`. Round-half-up, saturating.
    pub fn sandbox_debit_amount(&self, cost_micro_usd: u64) -> u64 {
        const BPS_DENOM: u64 = 10_000;
        cost_micro_usd
            .saturating_mul(BPS_DENOM.saturating_add(self.sandbox_markup_bps))
            .saturating_add(BPS_DENOM / 2)
            / BPS_DENOM
    }
}

/// Unified search-based tool loop (#475, P2). The gateway injects a `tool_search`
/// meta-tool on the openai-compat chat plane and runs a buffered tool-call loop
/// against Core's unified tool catalog when the request carries the tool signal.
///
/// `enabled` defaults true: the no-signal fast path is preserved (plain chat
/// streams directly), so enabling it costs nothing until a request opts in via
/// `x-ryu-tools` / `x-ryu-tool-search`. Nothing hardcoded — every knob is a
/// swappable default.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolsConfig {
    /// Master switch for the unified tool loop. Default: true.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Tool definitions always injected (and always allowlisted) for every
    /// tool-active request. Default: empty. Each entry is an OpenAI tool def.
    #[serde(default)]
    pub always_on: Vec<serde_json::Value>,
    /// Maximum tool-call rounds before returning the last turn. Default: 6.
    #[serde(default = "default_tools_max_rounds")]
    pub max_rounds: u8,
    /// How many top search hits to describe + inject per `tool_search`. Default: 5.
    #[serde(default = "default_describe_top_n")]
    pub describe_top_n: usize,
    /// Named tool-policy profiles (presets) layered ABOVE the per-request
    /// `x-ryu-tools` allowlist, modeled on OpenClaw's profile layering
    /// (profile → allow/deny → sandbox, checked in that order). A request
    /// selects one by name via `x-ryu-tool-profile`; the gateway resolves it to
    /// an effective allowlist (see `effective_tool_allowlist`). Default: empty
    /// map ⇒ no profiles ⇒ the allowlist path is byte-for-byte unchanged. An
    /// unknown/typo'd profile name falls back to today's behavior, never deny-all.
    #[serde(default)]
    pub profiles: HashMap<String, ToolProfile>,
}

/// A named tool-policy profile (preset). Resolves to an allowlist that an
/// explicit per-request `x-ryu-tools` allow/deny still overrides.
///
/// Resolution (in `effective_tool_allowlist`): seed the allow set from `allow`
/// (or the wildcard `"*"` when `unrestricted`), union the explicit
/// `x-ryu-tools` CSV on top, then strip any id listed in `deny` (deny wins over
/// allow). `always_on` tools are appended last and are never deny-stripped.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ToolProfile {
    /// Fully-qualified tool ids this profile grants. Ignored when `unrestricted`.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Fully-qualified tool ids this profile denies. Deny wins over `allow` and
    /// over the per-request `x-ryu-tools` grant. Does not strip `always_on`.
    #[serde(default)]
    pub deny: Vec<String>,
    /// The "full"/unrestricted preset: resolves the allow set to the wildcard
    /// `"*"`, which `ToolLoopContext::is_allowed` treats as allow-any. Opt-in:
    /// only a request that explicitly selects this profile gets the wildcard.
    #[serde(default)]
    pub unrestricted: bool,
}

fn default_tools_max_rounds() -> u8 {
    6
}
fn default_describe_top_n() -> usize {
    5
}

impl Default for ToolsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            always_on: Vec::new(),
            max_rounds: default_tools_max_rounds(),
            describe_top_n: default_describe_top_n(),
            profiles: HashMap::new(),
        }
    }
}

/// Context compression (M2 / #425). When enabled, the gateway sends the request
/// messages to an external compression service (headroom's `/v1/compress`)
/// before the upstream provider call and swaps in the compressed result. This
/// is the egress transform that auto-wraps every gateway-routed agent. It fails
/// open: any error leaves the original messages untouched so chat never breaks
/// when the service is absent.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompressionConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the compression service. Default: headroom proxy on :8787.
    #[serde(default = "default_compression_url")]
    pub url: String,
    /// Optional bearer token for the compression service.
    pub token: Option<String>,
    /// Per-request timeout in milliseconds. Default: 4000.
    #[serde(default = "default_compression_timeout_ms")]
    pub timeout_ms: u64,
    /// Only compress requests carrying at least this many messages; short
    /// single-turn prompts rarely benefit and add a round-trip. Default: 4.
    #[serde(default = "default_compression_min_messages")]
    pub min_messages: usize,
}

fn default_compression_url() -> String {
    "http://127.0.0.1:8787".to_string()
}
fn default_compression_timeout_ms() -> u64 {
    4000
}
fn default_compression_min_messages() -> usize {
    4
}

impl Default for CompressionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: default_compression_url(),
            token: None,
            timeout_ms: default_compression_timeout_ms(),
            min_messages: default_compression_min_messages(),
        }
    }
}

/// Connection to the control plane (M7 / U29). When enabled, the gateway
/// periodically pushes its eval/budget/audit snapshot up to the control plane
/// for aggregation, and reconciles shared budgets through the coordinator.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ControlPlaneConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the control-plane API, e.g. `http://127.0.0.1:3000/api`.
    #[serde(default = "default_control_plane_url")]
    pub base_url: String,
    /// Gateway credential issued by the control plane (env: CONTROL_PLANE_KEY).
    /// Sent as the `X-Gateway-Key` header to authenticate and resolve the org.
    pub gateway_key: Option<String>,
    /// How often to push a report, in seconds. Default: 60.
    #[serde(default = "default_report_interval_secs")]
    pub report_interval_secs: u64,
    /// Maximum audit rows to push per report. Default: 200.
    #[serde(default = "default_report_audit_limit")]
    pub audit_limit: u32,
    /// Optional shared-budget id to reconcile through the coordinator. When set,
    /// the gateway reports its consumption and respects the shared cap.
    pub shared_budget_id: Option<String>,
    /// Estimated cost in micro-USD per 1000 tokens (input + output combined),
    /// used to attribute spend. Default: 2000 (= $0.002 / 1k tokens).
    #[serde(default = "default_cost_per_1k_micro_usd")]
    pub cost_per_1k_micro_usd: u64,

    /// Per-model price table (#9). Keyed by model id (exact, then longest-prefix
    /// match, e.g. `"claude-sonnet"`). When a model matches, spend is attributed
    /// with real input/output rates instead of the flat `cost_per_1k_micro_usd`.
    /// Empty (the default) keeps the flat estimate — nothing hardcoded, fully
    /// swappable per deployment.
    #[serde(default)]
    pub model_pricing: HashMap<String, ModelPrice>,
}

/// Real input/output pricing for one model, in micro-USD per 1000 tokens.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelPrice {
    /// micro-USD per 1000 input (prompt) tokens.
    pub input_per_1k_micro_usd: u64,
    /// micro-USD per 1000 output (completion) tokens.
    pub output_per_1k_micro_usd: u64,
}

impl ControlPlaneConfig {
    /// Estimated spend in micro-USD for one call. Uses the per-model price table
    /// when the model matches (exact, then longest-prefix), else the flat
    /// `cost_per_1k_micro_usd` fallback.
    pub fn cost_for(&self, model: &str, input: u64, output: u64) -> u64 {
        if let Some(p) = self.price_for_model(model) {
            let i = input.saturating_mul(p.input_per_1k_micro_usd) / 1000;
            let o = output.saturating_mul(p.output_per_1k_micro_usd) / 1000;
            return i.saturating_add(o);
        }
        (input.saturating_add(output)).saturating_mul(self.cost_per_1k_micro_usd) / 1000
    }

    /// The OUTPUT price per 1k tokens for `model`, falling back to the flat
    /// `cost_per_1k_micro_usd` when the table has no entry.
    ///
    /// The spend ceiling is computed from this rather than from the flat rate,
    /// and the difference is the whole point: output prices span roughly 500x
    /// across the catalog, so one blended rate makes the ceiling far too
    /// generous on a frontier model — which is exactly where an overdraft is
    /// worth having — and needlessly tight on a cheap one, truncating
    /// completions that were affordable all along.
    ///
    /// OUTPUT only, not the blend `cost_for` uses: the ceiling bounds how many
    /// tokens the model may still GENERATE. The prompt is already paid for by
    /// the time this is asked, so charging the ceiling for input tokens would
    /// shrink it for a reason that has nothing to do with what remains to be
    /// spent.
    pub fn output_price_per_1k_micro_usd(&self, model: &str) -> u64 {
        self.price_for_model(model)
            .map(|p| p.output_per_1k_micro_usd)
            .filter(|p| *p > 0)
            .unwrap_or(self.cost_per_1k_micro_usd)
    }

    /// Exact match first, then the longest matching prefix (so `"claude-sonnet"`
    /// covers `"claude-sonnet-4-5-20250929"`).
    fn price_for_model(&self, model: &str) -> Option<&ModelPrice> {
        if let Some(p) = self.model_pricing.get(model) {
            return Some(p);
        }
        let mut best: Option<(&String, &ModelPrice)> = None;
        for (k, v) in &self.model_pricing {
            if model.starts_with(k.as_str()) && best.map_or(true, |(bk, _)| k.len() > bk.len()) {
                best = Some((k, v));
            }
        }
        best.map(|(_, v)| v)
    }
}

/// Composio's current standard rate, $0.30 per 1000 executions, in micro-USD
/// per call. Billed straight through at cost. Managed-app and premium-tool
/// contracts can override this deployment value when their provider invoice
/// is higher.
fn default_cost_per_tool_call_micro_usd() -> u64 {
    300
}

/// Replicate's published Nvidia L40S rate, $0.000975/sec, in micro-USD.
fn default_cost_per_gpu_second_micro_usd() -> u64 {
    975
}

// ─── Media fallback rates (micro-USD per call) ───────────────────────────────
// The four flat per-call rates the media debit falls back to when the provider
// reported no compute time. Each is DERIVED from the one published price this
// file already holds — Replicate's L40S GPU-second — times the nominal duration
// of that kind of job, so there is exactly one number to re-check when the
// hardware rate changes and no invented figures at all.
//
// Image and video take their durations from the derivation already written down
// on `cost_per_gpu_second_micro_usd`: "a two-second image and a sixty-second
// video". Nothing in this file publishes a per-character, per-second-of-audio or
// per-minute rate for speech, so TTS and STT take the shortest job the fallback
// can honestly represent — one GPU-second.
//
// These are FALLBACKS, not prices. The metered path
// ([`CreditsConfig::media_cost_from_response`]) is what should pay for a real
// call; a rate here only has to be non-zero, because zero is the one value that
// turns "charge a little" into "skip the debit" under the `if cost > 0` guard.
// Every one is overridable per deployment with the matching
// `GATEWAY_CREDITS_COST_PER_*_MICRO_USD`.

/// A nominal two-second image on L40S: `2 x $0.000975/sec`.
fn default_cost_per_image_micro_usd() -> u64 {
    default_cost_per_gpu_second_micro_usd() * 2
}

/// A nominal sixty-second video render on L40S: `60 x $0.000975/sec`.
fn default_cost_per_video_micro_usd() -> u64 {
    default_cost_per_gpu_second_micro_usd() * 60
}

/// One L40S second, the shortest job the fallback can represent. TTS is the
/// urgent half of this pair with STT: both are served synchronously, and neither
/// has a published per-audio-unit rate anywhere in this config.
fn default_cost_per_tts_micro_usd() -> u64 {
    default_cost_per_gpu_second_micro_usd()
}

/// One L40S second — see [`default_cost_per_tts_micro_usd`].
fn default_cost_per_stt_micro_usd() -> u64 {
    default_cost_per_gpu_second_micro_usd()
}

fn default_control_plane_url() -> String {
    "http://127.0.0.1:3000/api".to_string()
}
fn default_report_interval_secs() -> u64 {
    60
}
fn default_report_audit_limit() -> u32 {
    200
}
fn default_cost_per_1k_micro_usd() -> u64 {
    2000
}

impl Default for ControlPlaneConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_control_plane_url(),
            gateway_key: None,
            report_interval_secs: default_report_interval_secs(),
            audit_limit: default_report_audit_limit(),
            shared_budget_id: None,
            cost_per_1k_micro_usd: default_cost_per_1k_micro_usd(),
            model_pricing: HashMap::new(),
        }
    }
}

fn default_bind() -> String {
    // Profile-aware (release `127.0.0.1:7981`, dev `127.0.0.1:8981`, …) so a
    // standalone dev gateway never collides with a release one. Core-spawned
    // gateways get an explicit `--bind` that is already profile-offset.
    crate::profile::default_bind()
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ProvidersConfig {
    pub openai: Option<OpenAiProviderConfig>,
    pub anthropic: Option<AnthropicProviderConfig>,
    pub local: Option<LocalProviderConfig>,
    /// The **classify tier**: a second OpenAI-compatible local server dedicated
    /// to the tiny always-on classifier model (llama.cpp on
    /// [`DEFAULT_CLASSIFY_PORT`], fed by `RYU_CLASSIFY_LLM_URL`).
    ///
    /// Deliberately its own slot rather than a second `local`, because `local` is
    /// aimed by Core at the resident **chat** engine: sharing one slot would make
    /// the guardrail inspector, the LLM-judge evaluators, and smart routing
    /// contend for — and be circuit-broken alongside — the user's chat model, and
    /// would pin the classifier to whatever chat engine happens to be resident.
    ///
    /// **`Some` is the normal state on a Ryu node, and `None` means "standalone
    /// gateway".** This used to read "`None` is the normal state (the sidecar is
    /// lazy…)" — an inversion worth spelling out, because three units reasoned from
    /// it. The sidecar *process* is indeed lazy, but Core publishes
    /// `RYU_CLASSIFY_LLM_URL` **unconditionally** (`gateway_spawn_env` does not gate
    /// it on the sidecar being installed or running — deliberately, so a classifier
    /// installed later needs no gateway respawn), so every Core-spawned gateway
    /// fills this slot and registers a `classify` provider at boot.
    ///
    /// The consequence to design against: a *cold* tier is `Some(slot)` +
    /// connection-refused, NOT `None`. It surfaces as a `ProviderError` from
    /// `provider.complete`, not as the absent-provider branch — see
    /// [`crate::providers::ProviderRegistry::new`] and
    /// `firewall/inspector.rs`. Both are graceful (fail open), but only the `None`
    /// branch names the provider in its warning.
    pub classify: Option<ClassifyProviderConfig>,
    pub openrouter: Option<OpenRouterProviderConfig>,
    pub core: Option<CoreProviderConfig>,
    pub modal: Option<ModalProviderConfig>,
    pub genai: Option<GenAiProviderConfig>,
    /// Replicate (https://replicate.com) — cloud image/video generation via an
    /// async prediction API (create → poll → output URL). Opt-in: constructed
    /// only when an API key is present.
    pub replicate: Option<ReplicateProviderConfig>,
    /// Fal (https://fal.ai) — cloud image/video/audio generation via a queued
    /// request API (submit → poll status → result). Opt-in.
    pub fal: Option<FalProviderConfig>,
    /// Cloudflare Workers AI — the cheap open-model supply behind the
    /// `cloudflare` credit pool (see [`crate::credit_pools`]). OpenAI-compatible
    /// dialect, so it needs no impl of its own; see the registration in
    /// [`crate::providers::ProviderRegistry::new`]. Opt-in: absent unless both
    /// `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set, because the
    /// base URL is account-scoped and there is no sane hardcoded default.
    pub cloudflare: Option<CloudflareProviderConfig>,
    /// AWS Bedrock — the frontier supply behind the `bedrock` credit pool.
    /// Speaks the Anthropic Messages dialect (NOT OpenAI-compatible for Claude);
    /// see the registration for why. Opt-in: absent unless a bearer token and a
    /// region (or explicit base URL) are set, because the endpoint is
    /// region-scoped.
    pub bedrock: Option<BedrockProviderConfig>,
    /// Google Cloud Vertex AI — the supply behind the `vertex` credit pool,
    /// reached through Vertex's OpenAI-compatible Chat Completions surface.
    /// Opt-in: absent unless a bearer token plus a project and a location (or an
    /// explicit base URL) are set, because the endpoint embeds all three.
    pub vertex: Option<VertexProviderConfig>,
    /// The DONATED OpenAI allowance behind the `openai-credits` credit pool —
    /// deliberately a SECOND slot rather than reusing [`Self::openai`].
    ///
    /// Both speak the same dialect against the same endpoint, so the temptation
    /// to fold them together is real; the reason not to is money, not wiring. The
    /// `openai` slot carries a caller's OWN key (BYOK / pass-through) and is
    /// untagged, so its spend falls through to subscription and top-up buckets.
    /// This slot carries the donor's key, and every request served by it debits a
    /// grant. One slot would make the two indistinguishable at the debit site,
    /// and the failure is silent in the expensive direction: BYOK traffic would
    /// start burning donated credit that the user is already paying for
    /// themselves.
    pub openai_credits: Option<OpenAiProviderConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpenAiProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4, multi-account). When a
    /// key hits an upstream 429 the provider rotates to the next before failing
    /// over to the cost-tier chain. Empty → single-account (uses `api_key`).
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "openai_base_url")]
    pub base_url: String,
}

impl OpenAiProviderConfig {
    /// The full account rotation set: the extra `api_keys` when present, else the
    /// single `api_key`. Empty strings are dropped.
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

fn openai_base_url() -> String {
    "https://api.openai.com/v1".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AnthropicProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "anthropic_base_url")]
    pub base_url: String,
}

impl AnthropicProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

fn anthropic_base_url() -> String {
    "https://api.anthropic.com".to_string()
}

/// Cloudflare Workers AI, reached through its OpenAI-compatibility surface.
///
/// No `#[serde(default)]` on `base_url` on purpose: the endpoint embeds the
/// account id (`…/accounts/{account_id}/ai/v1`), so a compiled-in default would
/// be wrong for every deployment. The env overlay in [`GatewayConfig::load`]
/// interpolates it — serde default fns take no arguments and so cannot.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CloudflareProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: String,
}

impl CloudflareProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

/// AWS Bedrock, reached through its Anthropic-Messages-compatible surface.
///
/// Same "no default base URL" reasoning as [`CloudflareProviderConfig`]: the
/// endpoint is region-scoped (`https://bedrock-mantle.{region}.api.aws/anthropic`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BedrockProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: String,
}

impl BedrockProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

/// Google Cloud Vertex AI, reached through its OpenAI-compatible Chat
/// Completions surface (`…/endpoints/openapi/chat/completions`, bearer auth) —
/// byte-for-byte what [`crate::providers::OpenAiProvider`] already sends.
///
/// Same "no default base URL" reasoning as [`CloudflareProviderConfig`], only
/// more so: the endpoint embeds the project AND the location
/// (`https://{loc}-aiplatform.googleapis.com/v1/projects/{project}/locations/{loc}/endpoints/openapi`).
///
/// **`api_key` must be a LONG-LIVED credential, not a pasted access token.** The
/// obvious way to get a Vertex bearer is `gcloud auth print-access-token`, and it
/// expires in about an hour. On a donated pool that failure is nasty: the
/// provider keeps registering, every request 401s, and the pool looks *dead*
/// rather than misconfigured. Use a Vertex AI API key (express-mode) or a
/// credential broker that hands the gateway something durable.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VertexProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: String,
}

impl VertexProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

/// Merge a primary key + an optional extra-accounts list into the rotation set,
/// preferring the explicit list and always including the primary. Blank entries
/// are dropped so a stray empty string never becomes a "key". Falls back to a
/// single empty string only if nothing is configured (keeps the provider
/// constructible; the upstream call then fails auth as before).
fn all_provider_keys(primary: &str, extra: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    if !primary.is_empty() {
        keys.push(primary.to_string());
    }
    for k in extra {
        if !k.is_empty() && !keys.contains(k) {
            keys.push(k.clone());
        }
    }
    if keys.is_empty() {
        keys.push(String::new());
    }
    keys
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LocalProviderConfig {
    #[serde(default = "local_base_url")]
    pub base_url: String,
}

fn local_base_url() -> String {
    "http://127.0.0.1:11434/v1".to_string()
}

/// Loopback port the classify-tier llama.cpp server listens on, kept in lockstep
/// with Core's `llamacpp::classify::CLASSIFY_PORT_BASE` (chat 8080, embed 8081,
/// rerank 8082, classify 8083).
pub const DEFAULT_CLASSIFY_PORT: u16 = 8083;

/// Loopback port the embed tier listens on — the second slot in the same port map
/// as [`DEFAULT_CLASSIFY_PORT`].
pub const DEFAULT_EMBED_PORT: u16 = 8081;

/// Where to embed text when no `[providers.openai]` is configured.
///
/// The embedding-backed paths — smart routing's `Embedding` strategy and the
/// semantic cache — were written to take a bare `(base_url, api_key)` OpenAI
/// endpoint, so with no OpenAI provider they logged "no embedder configured" and
/// gave up. On a Core-spawned gateway that is wrong twice over: an embed sidecar
/// IS running on loopback, speaking the same OpenAI-compatible `/embeddings`
/// shape, and it is the embedder the model default (`nomic-embed-text-v1.5`)
/// names. So the absence of a cloud key made a local-first feature silently inert.
///
/// `RYU_EMBED_LLM_URL` overrides, mirroring `RYU_CLASSIFY_LLM_URL` for the
/// classify tier; the port is profile-aware for the same reason
/// [`classify_base_url`] is, so a dev gateway reaches `:9081`, not the release
/// sidecar on `:8081`.
pub fn local_embed_base_url() -> String {
    std::env::var("RYU_EMBED_LLM_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            format!(
                "http://127.0.0.1:{}/v1",
                crate::profile::port(DEFAULT_EMBED_PORT)
            )
        })
}

/// The classify tier's connection config — the same single-field shape as
/// [`LocalProviderConfig`], kept as a distinct type purely so it carries its own
/// `base_url` default: reusing `LocalProviderConfig` would make a bare
/// `[providers.classify]` table in `gateway.toml` silently default to Ollama's
/// `:11434` (the chat engine) instead of the classifier.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ClassifyProviderConfig {
    /// The **standalone-gateway** setting for the classify tier. Core's injected
    /// `RYU_CLASSIFY_LLM_URL` wins it (same rule as `local`/`LOCAL_LLM_URL`), and Core
    /// publishes that variable on EVERY gateway spawn — so on a Core-spawned gateway
    /// this field is overwritten at load and has no effect. Repointing the tier on
    /// such a node is done from Core's environment instead. The env overlay in
    /// [`GatewayConfig::load`] carries the full reasoning, including why the
    /// alternative (file-wins) could not be made safe across the two processes.
    ///
    /// The env-overwritten slot is never persisted, and the operator's own table is
    /// restored before anything is written
    /// ([`GatewayConfig::strip_env_injected_classify_provider`]).
    #[serde(default = "classify_base_url")]
    pub base_url: String,
}

/// Profile-aware so a standalone dev gateway (`RYU_PROFILE=dev`) reaches the dev
/// classifier on `:9083` rather than the release one on `:8083` — the same
/// reasoning as [`default_bind`]. This default is what a bare
/// `[providers.classify]` table resolves to, and the standalone gateway is the one
/// that reaches it: a Core-spawned gateway is handed an already-offset
/// `RYU_CLASSIFY_LLM_URL`, which overwrites the slot at load.
fn classify_base_url() -> String {
    format!(
        "http://127.0.0.1:{}/v1",
        crate::profile::port(DEFAULT_CLASSIFY_PORT)
    )
}

/// Make the resolved classify-tier model id route to the `classify` provider by
/// seeding an **exact** `routing.model_map` entry for it.
///
/// Why this is needed at all, given the `"gemma-3-270m"` built-in prefix: the
/// prefix table is a compile-time constant, so it cannot follow a registry
/// override (`RYU_LOCAL_CLASSIFIER_MODEL_ID` → [`ENV_CLASSIFY_MODEL_ID`]). Without
/// this seed, an operator who coherently swapped BOTH the registry id and
/// `inspector.model` got: no exact hit, no prefix hit, fall through to
/// `default_provider` — i.e. the classifier id shipped to OpenAI/Anthropic, a 400,
/// and an inspector failing open in silence, while Core still started the sidecar
/// nobody then called.
///
/// It also hardens the DEFAULT id, which is why the seed is unconditional rather
/// than override-only: `RoutingTables::route` evaluates the user `model_map`
/// (exact, then longest prefix) BEFORE the built-in table, so a pre-existing user
/// mapping like `gemma` → `openrouter` silently sent the guardrail classifier to a
/// paid hosted provider. An exact entry wins step 1, ahead of that prefix scan.
///
/// `or_insert` semantics: an operator's **explicit exact** entry for the classify
/// id is deliberate and still wins.
///
/// The seeded row is DERIVED, not configuration, so it must never be served or
/// saved. The inserted key is RETURNED (`None` when nothing was inserted) for
/// [`GatewayConfig::seeded_classify_model`] to record, and removed again by
/// [`GatewayConfig::strip_seeded_classify_route`] on both of those paths.
/// (The ideal fix seeds at route-resolution time so the config is never touched at
/// all, but the `RoutingConfig` → `ryu_gw_router::RoutingTables` lowering lives in
/// `router/mod.rs::ModelRouter::new`, outside this change's file scope.)
///
/// That makes routing correctness depend on the seed being re-applied on every
/// `load()`, upstream of every router. Verified, not assumed: `main.rs:85` builds
/// the process config with [`GatewayConfig::load`] and hands it to
/// `AppState::new` (`main.rs:143`), whose `state.rs:275`
/// `RouterRegistry::new(config.routing.clone())` is the only production
/// `ModelRouter` construction — the other `RouterRegistry::new` call sites in
/// `state.rs` are `#[cfg(test)]` constructors. A `PUT /v1/config` cannot break this
/// either: `model_map` is a restart-only startup snapshot, so the running router
/// keeps the seeded tables until the next boot re-seeds them. (One pre-existing gap
/// is unchanged: if `load()` *errors*, `main` falls back to
/// `GatewayConfig::default()`, which has no seed — and no operator config either.)
fn seed_classify_route(routing: &mut RoutingConfig, model_id: &str) -> Option<String> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return None;
    }
    let mut inserted = false;
    routing
        .model_map
        .entry(model_id.to_owned())
        .or_insert_with(|| {
            inserted = true;
            ModelMapping {
                provider: ProviderId::from(CLASSIFY_PROVIDER_ID),
                provider_model: None,
            }
        });
    // Only OUR insert is reported. A row that was already there — an operator's entry,
    // or an alias a pre-fix gateway persisted — stays unmarked and is therefore never
    // stripped from the file or the view.
    inserted.then(|| model_id.to_owned())
}

/// Registry id of the classify provider. Must match the id
/// `ProviderRegistry::register_as` aliases the classify tier under, and the
/// `("gemma-3-270m", "classify")` row in `ryu_gw_router::builtin_prefixes`.
///
/// `pub(crate)` for `firewall::inspector`, which compares a routed decision's
/// provider against it to tell "the local classify tier is not running" apart from
/// "the upstream returned an error" — one id, so those two cannot drift.
pub(crate) const CLASSIFY_PROVIDER_ID: &str = "classify";

/// Registry ids of the segregated credit-pool supplies. Named constants rather
/// than repeated literals because THREE places must agree on each string or money
/// lands in the wrong donor account: the `register_as` id in
/// [`crate::providers::ProviderRegistry::new`], the pool table in
/// [`crate::credit_pools`], and `CREDIT_POOLS[*].gatewayProviders` over in
/// `packages/auth/src/lib/credit-pools.ts`. Only the last one is out of the
/// compiler's reach; these consts remove the other two failure modes.
///
/// They are also the strings `apps/desktop/src/lib/provider-brand.tsx` matches on
/// to render the vendor marks, so renaming one is a UI change too.
pub(crate) const CLOUDFLARE_PROVIDER_ID: &str = "cloudflare";
pub(crate) const BEDROCK_PROVIDER_ID: &str = "bedrock";
pub(crate) const VERTEX_PROVIDER_ID: &str = "vertex";

/// Registry id of the DONATED OpenAI supply — note the suffix, and do not "tidy"
/// it to `"openai"`.
///
/// Every other pool got to name itself after its vendor because no BYOK slot
/// claimed that id first. OpenAI is the exception: `"openai"` is already the
/// pass-through slot serving callers' own keys, and it must stay UNTAGGED so its
/// spend keeps falling through to subscription/top-up. Collapsing the two ids
/// would make `pool_for_gateway_provider("openai")` return a pool, and from then
/// on every BYOK request would silently debit the donated grant.
pub(crate) const OPENAI_CREDITS_PROVIDER_ID: &str = "openai-credits";

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpenRouterProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "openrouter_base_url")]
    pub base_url: String,
    #[serde(default = "openrouter_site_url")]
    pub site_url: String,
    #[serde(default = "openrouter_site_name")]
    pub site_name: String,
    /// `provider.data_collection` policy sent on every request: "deny" uses only
    /// providers that do not retain/train on prompts, "allow" permits them.
    /// Empty (the default) omits the field entirely, leaving OpenRouter's own
    /// default and — crucially — NOT overriding a BYOK caller's own routing
    /// intent. Managed Ryu Cloud nodes set this to "deny" for privacy-by-default
    /// (via `OPENROUTER_DATA_COLLECTION`, wired in Core's gateway spawn env).
    #[serde(default = "openrouter_data_collection")]
    pub data_collection: String,
    /// Require zero-data-retention endpoints (`provider.zdr`). Default off.
    #[serde(default)]
    pub zdr: bool,
    /// Provider sort preference: "price" | "throughput" | "latency". Empty → omit.
    #[serde(default)]
    pub sort: String,
    /// Add the `response-healing` plugin (repairs malformed JSON). Default off
    /// until its billing is confirmed.
    #[serde(default)]
    pub response_healing: bool,
    /// Send the legacy `usage: {include: true}` flag. Current OpenRouter always
    /// returns `usage.cost` (read by `response_cost_micro_usd` for at-cost credit
    /// metering), so this only helps older or OpenRouter-compatible endpoints.
    /// Default on for compatibility; harmless no-op on modern OpenRouter.
    #[serde(default = "default_true")]
    pub usage_accounting: bool,
    /// Reserved: per-org OpenRouter sub-keys minted via the management-key API
    /// (`/api/v1/keys`) so per-tenant spend is capped and attributed at
    /// OpenRouter. Empty today (single shared account key); the per-request key
    /// selection through the pipeline is the follow-up to the provisioning loop.
    #[serde(default)]
    pub org_api_keys: std::collections::HashMap<String, String>,
}

impl OpenRouterProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

fn openrouter_base_url() -> String {
    "https://openrouter.ai/api/v1".to_string()
}
fn openrouter_site_url() -> String {
    "https://github.com/ryuhq/ryu".to_string()
}
fn openrouter_site_name() -> String {
    "ryu-gateway".to_string()
}
fn openrouter_data_collection() -> String {
    // Empty → the `provider.data_collection` field is omitted, so out-of-the-box
    // behaviour is unchanged and a BYOK caller's own routing is never overridden.
    // Managed nodes opt in to "deny" via env.
    String::new()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CoreProviderConfig {
    #[serde(default = "core_base_url")]
    pub base_url: String,
    pub token: Option<String>,
}

fn core_base_url() -> String {
    "http://127.0.0.1:2049".to_string()
}

/// Modal (https://modal.com) — serverless GPU compute. A Ryu Cloud GPU node
/// deploys an OpenAI-compatible inference app (e.g. vLLM) on Modal and points
/// the gateway at it, so heavy local-model inference bursts onto Modal's GPUs
/// (pay-per-second, scale-to-zero) while the always-on orchestration node stays
/// on cheap CPU. Wire-compatible with OpenAI, so the provider is a thin bearer
/// client. There is NO universal default URL — every Modal deployment has its
/// own `*.modal.run` endpoint — so `base_url` is required, and the provider is
/// only constructed when both it and the token are configured (opt-in).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModalProviderConfig {
    /// The Modal proxy-auth token (sent as a bearer). Modal apps gate access
    /// with a token; never hardcoded.
    pub api_key: String,
    /// The deployed Modal app's OpenAI-compatible base URL (its `*.modal.run`
    /// `/v1` endpoint). Required — no sensible default exists.
    pub base_url: String,
}

/// `genai` multi-provider backend. Covers the *native-format* providers the
/// gateway does not implement by hand (primarily Gemini), so they can be added
/// by config rather than by writing a bespoke translator per provider. The
/// OpenAI-compatible ecosystem is still served by the byte-passthrough
/// providers (OpenAI, OpenRouter); this is for the native-protocol long tail.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct GenAiProviderConfig {
    /// API keys keyed by the lowercase `genai` adapter kind, e.g. `"gemini"`,
    /// `"groq"`, `"xai"`, `"deepseek"`, `"cohere"`. Looked up per request by the
    /// resolved provider. If a kind has no key here, `genai` falls back to its
    /// own default (env-var) auth for that provider.
    #[serde(default)]
    pub keys: std::collections::HashMap<String, String>,
}

/// Replicate (https://replicate.com) — cloud generative media over an async
/// prediction API. A request creates a prediction (`POST /predictions` with a
/// versioned model or `POST /models/{owner}/{name}/predictions`), then the
/// gateway polls the returned prediction until it reaches a terminal state and
/// exposes the `output` (usually a URL, or list of URLs). Image gen blocks and
/// polls inline (fast enough); video gen submits a job the client polls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReplicateProviderConfig {
    /// Replicate API token (sent as `Authorization: Bearer <token>`).
    pub api_key: String,
    #[serde(default = "replicate_base_url")]
    pub base_url: String,
    /// Poll interval in milliseconds while a prediction is running. Default: 1500.
    #[serde(default = "default_media_poll_interval_ms")]
    pub poll_interval_ms: u64,
    /// Max seconds to block-and-poll an inline (image) prediction before giving
    /// up. Video never blocks this long — it returns a job id. Default: 120.
    #[serde(default = "default_media_poll_timeout_secs")]
    pub poll_timeout_secs: u64,
}

fn replicate_base_url() -> String {
    "https://api.replicate.com/v1".to_string()
}

/// Fal (https://fal.ai) — cloud generative media over a queued request API. A
/// request submits to `https://queue.fal.run/{model}` and receives a
/// `request_id` + status/response URLs; the gateway polls the status URL until
/// `COMPLETED`, then fetches the response. Image gen blocks and polls inline;
/// video gen submits a job the client polls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FalProviderConfig {
    /// Fal API key (sent as `Authorization: Key <key>`).
    pub api_key: String,
    /// Queue base URL (model id is appended per request). Default:
    /// `https://queue.fal.run`.
    #[serde(default = "fal_base_url")]
    pub base_url: String,
    /// Poll interval in milliseconds while a request is queued/in-progress.
    #[serde(default = "default_media_poll_interval_ms")]
    pub poll_interval_ms: u64,
    /// Max seconds to block-and-poll an inline (image) request. Default: 120.
    #[serde(default = "default_media_poll_timeout_secs")]
    pub poll_timeout_secs: u64,
}

fn fal_base_url() -> String {
    "https://queue.fal.run".to_string()
}

fn default_media_poll_interval_ms() -> u64 {
    1500
}
fn default_media_poll_timeout_secs() -> u64 {
    120
}

/// The modality of a request. The router uses this to pick a provider that
/// supports the requested capability, so an agent's chat, image-gen, TTS, and
/// STT calls can each go to different providers.
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    /// Text chat completion (default).
    #[default]
    Chat,
    /// Image generation.
    Image,
    /// Text-to-speech synthesis.
    Tts,
    /// Speech-to-text transcription.
    Stt,
    /// Video generation. Unlike the other modalities this is job-based: a submit
    /// creates a job the client polls, because cloud video runs for minutes.
    Video,
}

impl Modality {
    pub fn as_str(&self) -> &'static str {
        match self {
            Modality::Chat => "chat",
            Modality::Image => "image",
            Modality::Tts => "tts",
            Modality::Stt => "stt",
            Modality::Video => "video",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct RoutingConfig {
    #[serde(default)]
    pub default_provider: ProviderId,

    /// Static model → provider mappings (e.g. "claude-3-5-sonnet" → anthropic)
    #[serde(default)]
    pub model_map: HashMap<String, ModelMapping>,

    /// Fallback chain when the primary provider is unavailable
    #[serde(default)]
    pub fallback_chain: Vec<ProviderId>,

    /// Cost-tier ordering for the fallback chain (#2). Lower = preferred:
    /// subscription (0) → cheap (1) → free (2). After the primary provider, the
    /// chain is stably sorted by tier so a rate-limited/failed primary demotes
    /// down the cost ladder instead of round-robining at random. Absent entries
    /// default to tier 0. Empty map (the default) preserves the flat
    /// `fallback_chain` order exactly — nothing hardcoded.
    #[serde(default)]
    pub provider_tiers: HashMap<ProviderId, u8>,

    /// Eval-driven (A/B) routing. When enabled, requests are split across a set
    /// of candidate providers and the winner is biased toward whichever candidate
    /// has the better rolling eval score (see `apps/gateway/src/evals`).
    #[serde(default)]
    pub eval_routing: EvalRoutingConfig,

    /// Modality-to-provider mappings. When a request carries a modality other
    /// than `chat`, the router looks here first before falling back to the
    /// model_map / default_provider logic. All entries are swappable; there are
    /// no hardcoded defaults so zero configuration works (every modality falls
    /// back to the default_provider).
    #[serde(default)]
    pub modality_map: HashMap<Modality, ModalityMapping>,

    /// Smart model routing. When enabled, the selected model-router algorithm
    /// picks or preserves a target before normal model→provider routing runs.
    /// Off by default; fully swappable.
    #[serde(default)]
    pub smart_routing: SmartRoutingConfig,
}

/// How a routing decision is reached. Shared vocabulary across both routing
/// planes (Gateway model routing here, and Core agent routing) so a route is
/// always resolved by one of a small, swappable set of strategies — never a
/// hardcoded classifier. Every strategy fails open (see [`SmartRoutingConfig`]).
///
/// - `Llm`: a cheap classifier model reads the message and picks a rule. Most
///   capable, one extra LLM round-trip per (uncached) decision.
/// - `Embedding` (RAG): embed each rule's description once and embed the query,
///   then route to the nearest rule by cosine similarity above a threshold. No
///   LLM call — cheap and local when the embedder is local.
/// - `Keyword`: case-insensitive substring match of a rule's description terms
///   against the message. Zero cost, zero network; the crude fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RouteStrategy {
    #[default]
    Llm,
    Embedding,
    Keyword,
}

/// Top-level model-router algorithm used by Gateway Plane A.
///
/// `passthrough` keeps the requested model, while `llm_classifier` is the
/// existing rule-based router whose `strategy` field selects whether rules are
/// matched by an LLM, embeddings, or keywords. The other variants mirror the
/// useful runtime families in NeMo Switchyard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelRouterType {
    #[default]
    LlmClassifier,
    Passthrough,
    Random,
    StageRouter,
    Escalation,
}

/// Default tier when stage signals are too weak to clear the confidence gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum StagePicker {
    #[default]
    CapableFirst,
    EfficientFirst,
}

/// Model routing ("custom routing instructions") for Gateway Plane A.
///
/// The default `llm_classifier` router uses plain-language rules — e.g.
/// *"coding or debugging questions → claude-sonnet-4-5"* — and picks how the
/// sorting happens via [`RouteStrategy`]. `random` uses the same rules as a
/// weighted target list, `stage_router` chooses capable/efficient tiers from
/// recent request signals, and `escalation` asks a judge before a weak/strong
/// tier decision. `passthrough` is an explicit no-op. Every selected model then
/// flows through the ordinary [`crate::router::ModelRouter`] so the target's
/// provider is resolved exactly as a hand-picked model would — nothing about
/// providers is hardcoded here.
///
/// Everything fails open: an empty classifier/embedder, no rules, a classifier
/// error, or a timeout all leave the originally requested model untouched, so a
/// misconfiguration can never break chat. This is a Gateway concern (it decides
/// *what is allowed / where a call goes*), not Core.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmartRoutingConfig {
    /// The top-level model router algorithm. Defaults to the existing
    /// `llm_classifier` behavior for backward-compatible configs.
    #[serde(default)]
    pub router_type: ModelRouterType,

    /// How the matching rule is chosen. Default `Llm` preserves the original
    /// classifier behaviour; `Embedding` and `Keyword` are opt-in and swappable.
    #[serde(default)]
    pub strategy: RouteStrategy,

    /// Embedding model used by the `Embedding` (RAG) strategy, resolved through
    /// the gateway's OpenAI-compatible embeddings endpoint (the local
    /// `nomic-embed` sidecar by default). Empty ⇒ falls back to the semantic
    /// cache's configured embedding model. Ignored by other strategies.
    #[serde(default)]
    pub embedding_model: String,

    /// Minimum cosine similarity for the `Embedding` strategy to accept a rule as
    /// a match. Below this, the request falls back to `default_model` (or keeps
    /// its original model). Default 0.35. Ignored by other strategies.
    #[serde(default = "default_route_similarity_threshold")]
    pub similarity_threshold: f32,

    /// Optional seed for reproducible weighted-random sequences. Omit for a
    /// process-local seed. Used only by the `random` router.
    #[serde(default)]
    pub random_seed: Option<u64>,

    /// Capable tier used by the `stage_router` algorithm.
    #[serde(default)]
    pub stage_capable_model: String,
    /// Efficient tier used by the `stage_router` algorithm.
    #[serde(default)]
    pub stage_efficient_model: String,
    /// Default tier when stage signals are ambiguous.
    #[serde(default)]
    pub stage_picker: StagePicker,
    /// Minimum stage-signal confidence before the signal can override the picker.
    #[serde(default = "default_stage_confidence_threshold")]
    pub stage_confidence_threshold: f32,
    /// Number of recent request messages inspected by the stage scorer.
    #[serde(default = "default_stage_recent_message_window")]
    pub stage_recent_message_window: usize,

    /// Weak tier used by the `escalation` algorithm.
    #[serde(default)]
    pub escalation_weak_model: String,
    /// Strong tier used after the escalation streak is confirmed.
    #[serde(default)]
    pub escalation_strong_model: String,
    /// Judge model used to inspect the current trajectory before routing.
    #[serde(default)]
    pub escalation_judge_model: String,
    /// Consecutive escalation verdicts required to latch a session to strong.
    #[serde(default = "default_escalation_confirmations")]
    pub escalation_confirmations: u32,
    /// Number of recent messages included in the escalation judge prompt.
    #[serde(default = "default_escalation_recent_message_window")]
    pub escalation_recent_message_window: usize,
    /// Per-message character cap in the escalation judge prompt.
    #[serde(default = "default_escalation_message_chars")]
    pub escalation_message_chars: usize,

    /// Master switch. Default: false (the classifier call adds a round-trip to
    /// every request, so it is strictly opt-in).
    #[serde(default)]
    pub enabled: bool,

    /// The cheap model used to classify each request. Resolved to a provider via
    /// the normal model router, so it can be a local model (e.g. `"gemma-…"`), a
    /// hosted mini model, or an `openrouter/…` slug. Nothing hardcoded.
    ///
    /// Defaults to [`classify_model_id`] — the same classify-tier id the
    /// inspector takes — and an **empty value is resolved to that default at
    /// deserialization** (see [`de_classifier_model`]), so this field is never
    /// blank in practice.
    ///
    /// It used to default to `""` with a doc comment claiming "empty ⇒ smart
    /// routing is inert (fail-open)". Inert is the charitable reading; the real
    /// behaviour was worse. [`Self::is_active`] returns false on a blank
    /// classifier, and `pipeline::apply_smart_routing` treats a per-agent
    /// override as *present* the moment the agent has one — so an agent saved
    /// with routing switched on and the model box left empty did not fall back to
    /// the global smart router, it took the early return and DISABLED routing
    /// that would otherwise have worked. Resolving the blank here — the one
    /// construction seam every reader flows through — is what makes "enabled"
    /// mean "working", exactly as [`de_inspector_model`] does for the inspector.
    ///
    /// The behavioural shift is small and stays inside the module's fail-open
    /// contract: enabled + rules + blank was previously a silent no-op, and is
    /// now an attempt against the local classify tier whose failure lands on the
    /// same untouched-model outcome — minus the silence.
    #[serde(
        default = "default_classifier_model",
        deserialize_with = "de_classifier_model"
    )]
    pub classifier_model: String,

    /// Ordered natural-language rules. The classifier returns the index of the
    /// first matching rule; the request is then re-routed to that rule's `model`.
    #[serde(default)]
    pub rules: Vec<SmartRule>,

    /// Model to route to when the classifier matches no rule. `None`/empty ⇒
    /// keep the originally requested model (the fail-open default).
    #[serde(default)]
    pub default_model: Option<String>,

    /// Classify once per Core session (`x-ryu-session-id`) and reuse the decision
    /// for that session's later turns. Avoids a per-turn classifier call and
    /// mid-conversation model flapping. Default: true.
    #[serde(default = "default_true")]
    pub cache_by_session: bool,

    /// Per-classification timeout in milliseconds. On timeout the request keeps
    /// its original model. Default: 4000.
    #[serde(default = "default_smart_routing_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_smart_routing_timeout_ms() -> u64 {
    4000
}

/// The classify tier, same id the inspector defaults to. Cheap, local, and
/// already resolvable through the model router, so "enabled" needs no second
/// decision from the operator.
fn default_classifier_model() -> String {
    classify_model_id()
}

/// Resolve a blank `smart_routing.classifier_model` to [`classify_model_id`] as
/// the value is read off the wire — the sibling of [`de_inspector_model`], and
/// for the same reason: `#[serde(default = …)]` alone only covers an *absent*
/// field, while the desktop editor and the `PUT /v1/config` overlay both send an
/// explicit `""` when an operator clears the box.
///
/// It matters more here than for the inspector, because the per-agent override
/// map is keyed on *presence*: a blank model does not degrade to the global
/// router, it shadows it.
fn de_classifier_model<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    Ok(if raw.trim().is_empty() {
        default_classifier_model()
    } else {
        raw
    })
}

fn default_route_similarity_threshold() -> f32 {
    0.35
}

fn default_stage_confidence_threshold() -> f32 {
    0.5
}

fn default_stage_recent_message_window() -> usize {
    3
}

fn default_escalation_confirmations() -> u32 {
    2
}

fn default_escalation_recent_message_window() -> usize {
    28
}

fn default_escalation_message_chars() -> usize {
    500
}

impl Default for SmartRoutingConfig {
    fn default() -> Self {
        Self {
            router_type: ModelRouterType::default(),
            strategy: RouteStrategy::default(),
            embedding_model: String::new(),
            similarity_threshold: default_route_similarity_threshold(),
            random_seed: None,
            stage_capable_model: String::new(),
            stage_efficient_model: String::new(),
            stage_picker: StagePicker::default(),
            stage_confidence_threshold: default_stage_confidence_threshold(),
            stage_recent_message_window: default_stage_recent_message_window(),
            escalation_weak_model: String::new(),
            escalation_strong_model: String::new(),
            escalation_judge_model: String::new(),
            escalation_confirmations: default_escalation_confirmations(),
            escalation_recent_message_window: default_escalation_recent_message_window(),
            escalation_message_chars: default_escalation_message_chars(),
            enabled: false,
            classifier_model: default_classifier_model(),
            rules: Vec::new(),
            default_model: None,
            cache_by_session: true,
            timeout_ms: default_smart_routing_timeout_ms(),
        }
    }
}

impl SmartRoutingConfig {
    /// Whether smart routing should actually run: enabled, with at least one rule
    /// and whatever the chosen strategy needs to reach a decision. Anything short
    /// of this is a no-op (fail-open).
    ///
    /// - `Llm` needs a non-empty `classifier_model`. [`de_classifier_model`]
    ///   resolves a blank one to the classify tier as it comes off the wire, so
    ///   in practice this arm only trips on a config built in Rust — the check
    ///   stays as the last line of defence, not as the thing an operator hits.
    /// - `Embedding` needs an embedder (its own `embedding_model` or the semantic
    ///   cache's), validated at call time; here we only require rules.
    /// - `Keyword` needs nothing beyond rules.
    pub fn is_active(&self) -> bool {
        if !self.enabled {
            return false;
        }
        match self.router_type {
            ModelRouterType::Passthrough => true,
            ModelRouterType::LlmClassifier => {
                if self.rules.is_empty() {
                    return false;
                }
                match self.strategy {
                    RouteStrategy::Llm => !self.classifier_model.trim().is_empty(),
                    RouteStrategy::Embedding | RouteStrategy::Keyword => true,
                }
            }
            ModelRouterType::Random => {
                self.rules
                    .iter()
                    .filter(|rule| {
                        !rule.model.trim().is_empty()
                            && rule.weight.is_finite()
                            && rule.weight > 0.0
                    })
                    .count()
                    >= 2
            }
            ModelRouterType::StageRouter => {
                !self.stage_capable_model.trim().is_empty()
                    && !self.stage_efficient_model.trim().is_empty()
            }
            ModelRouterType::Escalation => {
                !self.escalation_weak_model.trim().is_empty()
                    && !self.escalation_strong_model.trim().is_empty()
                    && !self.escalation_judge_model.trim().is_empty()
            }
        }
    }
}

/// A single smart-routing rule: a natural-language condition plus the model to
/// route matching requests to.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmartRule {
    /// Plain-language condition, e.g. `"writing or refactoring code"`.
    pub description: String,
    /// Target model id for matching requests, resolved via the model router
    /// (e.g. `"claude-sonnet-4-5"`, `"gpt-4o-mini"`, `"openrouter/google/gemini-2.5-flash"`).
    pub model: String,
    /// Relative traffic weight for the `random` router. Other router types ignore it.
    #[serde(default = "default_smart_rule_weight")]
    pub weight: f32,
}

fn default_smart_rule_weight() -> f32 {
    1.0
}

/// A single modality-to-provider mapping entry. The `provider` field names
/// which backend handles this modality; the optional `model` field lets you
/// pin a specific model id (e.g. `"dall-e-3"` for image-gen) without changing
/// the provider config.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModalityMapping {
    pub provider: ProviderId,
    /// Model id to send to the provider. When absent the caller's `model`
    /// field is forwarded unchanged.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EvalRoutingConfig {
    /// When true, eligible requests are routed by eval score across `candidates`.
    #[serde(default)]
    pub enabled: bool,

    /// Candidate providers to split traffic across. The router compares their
    /// rolling eval scores and sends most traffic to the leader, reserving
    /// `explore_ratio` for the others so scores stay fresh.
    #[serde(default)]
    pub candidates: Vec<ProviderId>,

    /// Fraction of eligible traffic reserved for exploration (non-leader
    /// candidates), in `[0.0, 1.0]`. Default: 0.2.
    #[serde(default = "default_explore_ratio")]
    pub explore_ratio: f32,
}

fn default_explore_ratio() -> f32 {
    0.2
}

impl Default for EvalRoutingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            candidates: Vec::new(),
            explore_ratio: default_explore_ratio(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelMapping {
    pub provider: ProviderId,
    /// If set, rewrite the model name before forwarding (e.g. "gpt-4" → "gpt-4o")
    pub provider_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    #[default]
    OpenAi,
    Anthropic,
    Local,
    OpenRouter,
    Core,
    Modal,
    GenAi,
    Replicate,
    Fal,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Local => "local",
            ProviderKind::OpenRouter => "openrouter",
            ProviderKind::Core => "core",
            ProviderKind::Modal => "modal",
            ProviderKind::GenAi => "genai",
            ProviderKind::Replicate => "replicate",
            ProviderKind::Fal => "fal",
        }
    }
}

impl std::str::FromStr for ProviderKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "openai" => Ok(ProviderKind::OpenAi),
            "anthropic" => Ok(ProviderKind::Anthropic),
            "local" => Ok(ProviderKind::Local),
            "openrouter" => Ok(ProviderKind::OpenRouter),
            "core" => Ok(ProviderKind::Core),
            "modal" => Ok(ProviderKind::Modal),
            "genai" => Ok(ProviderKind::GenAi),
            "replicate" => Ok(ProviderKind::Replicate),
            "fal" => Ok(ProviderKind::Fal),
            other => Err(format!("unknown provider kind: {other}")),
        }
    }
}

/// A provider registry id — an arbitrary, open string naming which backend a
/// route resolves to (e.g. `"openai"`, `"anthropic"`, or a novel plugin id like
/// `"acme"`). This is the routing-layer analogue of the string-keyed
/// [`crate::providers::ProviderRegistry`]: routing is no longer pinned to the
/// closed [`ProviderKind`] enum, so a provider registered under a brand-new id
/// is routable purely via config (`default_provider`, `fallback_chain`,
/// `model_map`, `provider_tiers`, modality/eval maps) with no code change. An id
/// with no registered provider simply misses the registry at dispatch and falls
/// through the existing provider-unavailable path (fail-safe).
///
/// `#[serde(transparent)]` makes it (de)serialize as a bare string, so it works
/// as a JSON/TOML map key (`provider_tiers`) and every existing config naming one
/// of the nine legacy providers deserializes byte-identically. `ProviderKind` is
/// retained only as an ergonomic legacy alias that lowers to a `ProviderId` via
/// `From` / cross-type `PartialEq`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct ProviderId(pub String);

impl ProviderId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ProviderId {
    /// Mirrors the former `ProviderKind::default() == OpenAi` so zero-config
    /// routing keeps `default_provider = "openai"` (the only Default consumer).
    fn default() -> Self {
        ProviderId("openai".to_string())
    }
}

impl std::fmt::Display for ProviderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for ProviderId {
    fn from(s: String) -> Self {
        ProviderId(s)
    }
}

impl From<&str> for ProviderId {
    fn from(s: &str) -> Self {
        ProviderId(s.to_string())
    }
}

impl From<ProviderKind> for ProviderId {
    fn from(k: ProviderKind) -> Self {
        ProviderId(k.as_str().to_string())
    }
}

// Cross-type equality keeps `ProviderKind` an ergonomic legacy alias: call sites
// and tests can still write `decision.provider == ProviderKind::Anthropic`, and
// via std's blanket `Vec<A>: PartialEq<Vec<B>>` whole-chain assertions compile
// unchanged.
impl PartialEq<ProviderKind> for ProviderId {
    fn eq(&self, other: &ProviderKind) -> bool {
        self.0 == other.as_str()
    }
}

impl PartialEq<ProviderId> for ProviderKind {
    fn eq(&self, other: &ProviderId) -> bool {
        self.as_str() == other.0
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct FirewallConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,

    #[serde(default = "default_true")]
    pub scan_inbound: bool,

    #[serde(default = "default_true")]
    pub scan_outbound: bool,

    /// Action when a violation is detected
    #[serde(default)]
    pub policy: FirewallPolicy,

    #[serde(default = "default_true")]
    pub log_detections: bool,

    /// Whether PII patterns (email, phone, SSN, credit card, etc.) are redacted
    /// when policy = Sanitize. Defaults to true; set to false to suppress PII
    /// redaction while still redacting secrets.
    #[serde(default = "default_true")]
    pub redact_pii: bool,

    /// Whether secret patterns (API keys, tokens, PEM keys, connection strings)
    /// are redacted when policy = Sanitize. Defaults to true.
    #[serde(default = "default_true")]
    pub redact_secrets: bool,

    /// Whether external tool RESULTS re-entering the model on the openai-compat
    /// tool loop are wrapped in untrusted-content boundary markers and stripped
    /// of LLM chat-template control tokens (injection defense). Defaults to true;
    /// it only affects untrusted tool output (never user text), so it is safe to
    /// keep on. Set to false to disable the wrapping.
    #[serde(default = "default_true")]
    pub wrap_untrusted_tool_results: bool,

    /// User-defined firewall patterns, merged on top of the curated built-in
    /// PII/secret/injection sets when the scanner is (re)built. Each entry is a
    /// regex tagged with the category it belongs to; invalid regexes are skipped
    /// with a warning rather than failing the whole config (fail-open on the
    /// *pattern*, never on the firewall). Empty by default so existing configs
    /// keep the built-in-only behaviour.
    #[serde(default)]
    pub custom_patterns: Vec<CustomPattern>,

    /// Notification fan-out tier when the firewall matches inbound content
    /// (orthogonal to `policy`, which is the enforcement action). Old configs →
    /// `Silent`, so a firewall with no `alert` set fires no policy alert.
    #[serde(default)]
    pub alert: AlertTier,

    /// Optional cheap-LLM traffic inspector (a detection *method*, orthogonal to
    /// `policy`, which is the *action*). Disabled by default, so existing configs
    /// deserialize unchanged. Carried on the node base so the hierarchical
    /// resolver (`firewall/resolve.rs`) has a uniform shape to merge overlays into.
    #[serde(default)]
    pub inspector: InspectorConfig,

    /// Field names this scope freezes so a narrower scope (org → agent) can only
    /// *tighten* them, never *loosen* them. On the node base this is the box
    /// admin's baseline lock set; the resolver unions locks upward and, for a
    /// locked field, keeps the stricter value. Canonical names are the serde
    /// field names: `enabled`, `scan_inbound`, `scan_outbound`, `policy`,
    /// `log_detections`, `redact_pii`, `redact_secrets`,
    /// `wrap_untrusted_tool_results`, `inspector`, `alert` (locking that one means a
    /// narrower scope may only RAISE the tier, never go quieter). Defaults to locking
    /// `enabled`, `scan_inbound`, and `policy` — the three dials whose
    /// loosening silently disables the inbound firewall for a scope — so an
    /// org/agent overlay can only tighten them. A node admin opts out with an
    /// explicit `locked_fields = []`.
    #[serde(default = "default_firewall_locked_fields")]
    pub locked_fields: Vec<String>,

    /// Per-agent evaluator enablement (the unified-evaluator P1 dial). Each entry
    /// overrides one catalog evaluator; the hierarchical resolver merges them by
    /// `id` node → org → agent with the same union + per-binding lock semantics
    /// that govern the firewall dials (`firewall/resolve.rs::merge_evaluator_bindings`).
    /// Empty by default so existing configs deserialize unchanged. Nothing here
    /// executes yet (inline scanning is P3, offline scoring is P2); this phase is
    /// config plumbing + cascade + persistence only.
    #[serde(default)]
    pub evaluators: Vec<crate::evaluators::EvaluatorBinding>,
}

/// A partial [`FirewallConfig`] applied over a broader scope in the node → org →
/// agent cascade (`firewall/resolve.rs`). Every scalar is `Option`: `Some`
/// overrides the inherited value, `None` inherits it. `custom_patterns` are
/// *appended* (union, never replace); `locked_fields` freeze a field so a
/// narrower scope can only tighten it.
///
/// Wire keys are **snake_case** even though this object nests inside the
/// camelCase control-plane resolve response — serde applies `rename_all` per
/// struct, so the TS mirror and the resolve-response emitter must use snake_case
/// here. Empty overlays resolve to a byte-identical config to today's global
/// firewall.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct FirewallOverlay {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub scan_inbound: Option<bool>,
    #[serde(default)]
    pub scan_outbound: Option<bool>,
    #[serde(default)]
    pub policy: Option<FirewallPolicy>,
    #[serde(default)]
    pub log_detections: Option<bool>,
    #[serde(default)]
    pub redact_pii: Option<bool>,
    #[serde(default)]
    pub redact_secrets: Option<bool>,
    #[serde(default)]
    pub wrap_untrusted_tool_results: Option<bool>,
    /// Notification fan-out tier for this scope (see [`FirewallConfig::alert`]).
    /// `None` inherits the broader scope's tier.
    ///
    /// This is the org/agent half of alert delivery. Until it existed, `AlertTier` was
    /// `#[default] Silent` on the node base and *no* scope could raise it, so the whole
    /// fan-out — `firewall_policy_alert` (`pipeline/mod.rs`) gates on
    /// `cfg.alert >= AlertTier::Warn`, Core's webhook/Telegram/push/SMTP sinks behind
    /// it — could never fire.
    ///
    /// It is NOT node-only, and that was verified rather than assumed, because the
    /// `wrap_untrusted_tool_results` footgun (a per-scope override of a
    /// process-global, hence a silent no-op — see
    /// [`crate::firewall::resolve::normalize_overlay`]) is exactly what an unread
    /// assumption produces here. The resolved value does reach delivery:
    /// `FirewallScanner::new_scoped` stores the whole resolved [`FirewallConfig`]
    /// (`firewall/mod.rs::build`) and `config()` hands it back, so every
    /// `firewall_policy_alert(scanner.config(), …)` site is scope-aware.
    ///
    /// # Coverage is partial — three alert sites read the NODE BASE
    ///
    /// An earlier revision of this doc said flatly that "the pipeline reads
    /// `state.resolved_scanner(ctx).config()` before calling `firewall_policy_alert`",
    /// which is true of most sites but not all. Enumerated from the call sites in
    /// `pipeline/mod.rs` rather than inferred from one of them:
    ///
    /// * **Scope-aware** (`state.resolved_scanner(ctx)`) — `pre_process` (inbound text),
    ///   `apply_inline_input_evaluators`, and `apply_inline_output_evaluators`.
    /// * **Node base only** (`state.with_firewall`, which reads the boot/hot-swap global
    ///   and ignores every overlay) — `run`'s stage-9 outbound response scan,
    ///   `run_multimodal`'s inbound scan, and `submit_video_job`'s inbound scan.
    ///
    /// So the split is NOT inbound-vs-outbound, and describing it that way is wrong in
    /// both directions: an org/agent tier *does* govern an outbound block raised by an
    /// output-target inline evaluator, and it *does not* govern the image and video
    /// handlers' inbound scans. Those three sites fire the node-base tier instead.
    /// Widening them means routing `with_firewall` through `resolved_scanner`, which is
    /// a `pipeline/mod.rs` change, not a config one.
    ///
    /// Lock semantics are the shared ones: with `alert` in a broader scope's
    /// `locked_fields`, a narrower scope may only raise the tier — the `alert` arm of
    /// `resolve.rs::apply_overlay`, via `resolve.rs::louder_alert`.
    #[serde(default)]
    pub alert: Option<AlertTier>,
    #[serde(default)]
    pub inspector: Option<InspectorConfig>,
    /// Appended to the inherited pattern set (union), never replacing it.
    #[serde(default)]
    pub custom_patterns: Vec<CustomPattern>,
    /// Field names this scope locks (see [`FirewallConfig::locked_fields`]).
    #[serde(default)]
    pub locked_fields: Vec<String>,
    /// Evaluator bindings this scope contributes to the node → org → agent
    /// cascade. `None` inherits the broader scope's set; `Some` merges by `id`
    /// (union + per-binding lock) via
    /// `firewall/resolve.rs::merge_evaluator_bindings`. Unlike
    /// `wrap_untrusted_tool_results`, this is **not** node-only — org and agent
    /// overlays may set it, so `normalize_overlay` leaves it untouched.
    #[serde(default)]
    pub evaluators: Option<Vec<crate::evaluators::EvaluatorBinding>>,
}

/// The swappable cheap-LLM traffic inspector — a detection *method* that runs
/// alongside the regex scanner. It calls a model directly (never the tool loop,
/// so it cannot recurse) and fails **open** everywhere: a timeout, provider
/// error, or unparseable reply is treated as not-flagged (allow + warn). See
/// `firewall/inspector.rs`.
///
/// Wire keys are **snake_case** (see [`FirewallOverlay`]).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub struct InspectorConfig {
    /// Master switch. Default: false (opt-in — it adds a model round-trip).
    #[serde(default)]
    pub enabled: bool,
    /// Model id used for inspection, resolved through the normal
    /// [`crate::router::ModelRouter`] so it stays swappable (local, hosted, or an
    /// `openrouter/…` slug).
    ///
    /// Defaults to [`classify_model_id`] — the classify-tier classifier, resolved
    /// from the id Core published for the sidecar it actually runs — and an
    /// **empty value is resolved to that default at deserialization** (see
    /// [`de_inspector_model`]), so this field is never empty in practice.
    ///
    /// It used to default to `""` with a doc comment claiming "empty ⇒ the
    /// gateway's default model". That was false and load-bearing: `route("")`
    /// matches no map and no prefix, so it fell through to `default_provider`,
    /// which then stamped `"model": ""` on the payload and got a 400 from any
    /// real upstream. The inspector fails open, so turning the guardrail on
    /// without *also* remembering to pick a model produced a guardrail that
    /// silently never fired while `action` still read `Block`. Resolving the
    /// empty case here — at the one construction seam every reader flows through
    /// — is what makes "enabled" mean "working".
    #[serde(
        default = "default_inspector_model",
        deserialize_with = "de_inspector_model"
    )]
    pub model: String,
    /// What the inspector looks for. Default: [`InspectorMode::Both`].
    #[serde(default)]
    pub mode: InspectorMode,
    /// Skip inspection for turns shorter than this many characters (trivial
    /// prompts rarely carry an attack and every call costs a round-trip).
    #[serde(default = "default_inspector_min_chars")]
    pub min_chars: usize,
    /// Per-inspection timeout in milliseconds; on timeout the request is allowed
    /// (fail-open). Default: 1500.
    #[serde(default = "default_inspector_timeout_ms")]
    pub timeout_ms: u64,
    /// The action taken when the inspector flags a turn, reusing the firewall's
    /// [`FirewallPolicy`] (Block / Sanitize / WarnAndContinue). Default: block
    /// (the shared [`FirewallPolicy`] default).
    #[serde(default)]
    pub action: FirewallPolicy,
}

/// What the LLM inspector scans for. Shapes the inspection prompt.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InspectorMode {
    /// Prompt-injection / jailbreak attempts only.
    Injection,
    /// PII / secret data-leak detection only.
    Dlp,
    /// Both injection and DLP. The default.
    #[default]
    Both,
}

/// Env var Core publishes alongside `RYU_CLASSIFY_LLM_URL`: the **resolved
/// registry id** of the model the classify sidecar actually serves
/// (`ModelRegistry::local_classifier_model.id`, itself
/// overridable via `RYU_LOCAL_CLASSIFIER_MODEL_ID`). Set in
/// `apps/core/src/sidecar/gateway.rs::gateway_spawn_env`.
///
/// This closes the seam `sidecar/providers/llamacpp/classify.rs` documents as
/// "swappable registry defaults, never hardcoded": before it existed the gateway
/// knew the classify tier's **URL** but not its **id**, so
/// [`DEFAULT_INSPECTOR_MODEL`] was an independent literal and an operator who
/// swapped the registry id got an inspector default that no longer named the model
/// on the other end of the URL.
const ENV_CLASSIFY_MODEL_ID: &str = "RYU_CLASSIFY_MODEL_ID";

/// Compile-time fallback classify-tier model id, used only when Core has not
/// published [`ENV_CLASSIFY_MODEL_ID`] (a standalone gateway). Kept in lockstep
/// with Core's `registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID`; it is the id the
/// `"gemma-3-270m"` built-in prefix routes to the `classify` provider (see
/// `ryu_gw_router::builtin_prefixes`). Cheap enough to sit in front of every turn,
/// and local — so the default guardrail never leaks traffic to a hosted provider
/// or spends a cent.
///
/// Prefer [`classify_model_id`] over this constant: on a Core-spawned gateway the
/// published id is authoritative and may differ from this literal.
pub const DEFAULT_INSPECTOR_MODEL: &str = "gemma-3-270m-it-qat-Q4_0";

/// The classify tier's resolved model id: Core's published
/// [`ENV_CLASSIFY_MODEL_ID`] when present, else [`DEFAULT_INSPECTOR_MODEL`].
///
/// The single reader of that env var, so "which id is the classifier" has one
/// answer for the inspector default, the LLM-judge default, and the seeded
/// `model_map` route ([`seed_classify_route`]).
pub fn classify_model_id() -> String {
    resolve_classify_model_id(std::env::var(ENV_CLASSIFY_MODEL_ID).ok().as_deref())
}

/// Pure core of [`classify_model_id`] — split out so the precedence is testable
/// without mutating the process environment (the gateway has no env test lock).
/// A blank published value is treated as absent: Core pushes the var
/// unconditionally, so an empty string must never become "the classifier is
/// named nothing" (that is the exact failure `de_inspector_model` exists to stop).
fn resolve_classify_model_id(published: Option<&str>) -> String {
    published
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_INSPECTOR_MODEL)
        .to_owned()
}

fn default_inspector_model() -> String {
    classify_model_id()
}

/// Resolve a blank `inspector.model` to [`classify_model_id`] as the value is
/// read off the wire.
///
/// This is the **single** choke point: `#[serde(default = …)]` alone only covers
/// an *absent* field, but the UI and the `PUT /v1/config` overlay path both send
/// an explicit `""` when an operator clears the box, and `firewall/resolve.rs`
/// clones deserialized overlays wholesale into the resolved config. Normalizing
/// here means every consumer that reads the plain `model` field — the inspector
/// (`firewall/inspector.rs`) *and* the `EvaluatorImpl::LlmJudge` arm in
/// `pipeline/mod.rs`, which reads `scanner.config().inspector.model` regardless
/// of `inspector.enabled` — gets a working id without either of them needing a
/// resolution call of its own.
fn de_inspector_model<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = String::deserialize(deserializer)?;
    Ok(if raw.trim().is_empty() {
        default_inspector_model()
    } else {
        raw
    })
}

fn default_inspector_min_chars() -> usize {
    40
}

fn default_inspector_timeout_ms() -> u64 {
    1500
}

impl Default for InspectorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            // Non-empty by default so `..InspectorConfig::default()` — how every
            // struct-literal construction in the codebase fills this field — can
            // never reintroduce the empty-model trap documented on `model`.
            model: default_inspector_model(),
            mode: InspectorMode::default(),
            min_chars: default_inspector_min_chars(),
            timeout_ms: default_inspector_timeout_ms(),
            action: FirewallPolicy::default(),
        }
    }
}

/// The category a [`CustomPattern`] belongs to. Determines which built-in
/// pattern set it is merged into, and therefore which toggles govern it:
/// `Pii`/`Secret` follow `redact_pii`/`redact_secrets` under the Sanitize
/// policy, and `PromptInjection` participates in inbound injection scanning.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CustomPatternKind {
    #[default]
    Pii,
    Secret,
    PromptInjection,
    /// Merged into the `code_injection` evaluator's pattern set (Input scanning).
    CodeInjection,
    /// Merged into the `toxicity` evaluator's lexical pattern set (Output).
    Toxicity,
    /// Merged into the `bias_fairness` evaluator's lexical pattern set (Output).
    Bias,
}

/// A single user-defined firewall pattern.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct CustomPattern {
    /// Human-readable label; also used as the placeholder marker on redaction
    /// (e.g. a `name` of `internal_id` redacts to `[REDACTED:INTERNAL_ID]`).
    pub name: String,
    /// The regular expression, in the `regex` crate's syntax. The crate is
    /// backtracking-free, so caller-supplied patterns cannot cause catastrophic
    /// (ReDoS) blow-up.
    pub regex: String,
    /// Which built-in category this pattern is merged into.
    #[serde(default)]
    pub kind: CustomPatternKind,
}

impl Default for FirewallConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scan_inbound: true,
            scan_outbound: true,
            policy: FirewallPolicy::default(),
            log_detections: true,
            redact_pii: true,
            redact_secrets: true,
            wrap_untrusted_tool_results: true,
            custom_patterns: Vec::new(),
            alert: AlertTier::default(),
            inspector: InspectorConfig::default(),
            locked_fields: default_firewall_locked_fields(),
            evaluators: Vec::new(),
        }
    }
}

/// The node-base lock set applied when `locked_fields` is omitted: the three
/// dials whose loosening lets an org/agent overlay silently disable the inbound
/// firewall for its scope. Kept in sorted order so a resolve of the bare node
/// base is byte-identical to the resolver's sorted lock union (stable
/// scanner-cache keys).
fn default_firewall_locked_fields() -> Vec<String> {
    vec![
        "enabled".to_string(),
        "policy".to_string(),
        "scan_inbound".to_string(),
    ]
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FirewallPolicy {
    /// Reject the request with a 403. This is the **default**: prompt-injection
    /// matches are not meaningfully redactable, so blocking is the only action
    /// that actually stops a detected injection from reaching the model.
    /// Redact-and-continue is opt-in via `Sanitize`.
    #[default]
    Block,
    /// Log the detection but allow the request through
    WarnAndContinue,
    /// Replace detected patterns with placeholder text: a detected secret/PII is
    /// redacted before egress (the leak is closed) while the request still
    /// succeeds (local-first UX preserved). Prompt-injection matches are not
    /// meaningfully redactable, so under Sanitize they proceed with any
    /// co-located PII/secrets scrubbed and the injection text left intact —
    /// which is why Sanitize is opt-in rather than the default.
    Sanitize,
}

impl FirewallPolicy {
    /// Parse a firewall policy from an environment-variable value. Accepts the
    /// snake_case names plus a couple of friendly aliases. Returns `None` for
    /// an unrecognised value so the caller can keep the existing config.
    fn from_env(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "block" => Some(Self::Block),
            "warn_and_continue" | "warn" | "warn-and-continue" => Some(Self::WarnAndContinue),
            "sanitize" | "redact" => Some(Self::Sanitize),
            _ => None,
        }
    }
}

/// Parse a boolean-ish environment-variable value. Returns `None` for an
/// unrecognised value so the caller can keep the existing config.
fn parse_bool_env(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Read a boolean flag from the environment, falling back to `default` when the
/// variable is unset or holds an unrecognised value.
fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .and_then(|v| parse_bool_env(&v))
        .unwrap_or(default)
}

/// Parse a comma-separated env var into a list of API keys for multi-account
/// rotation (#4), e.g. `OPENAI_API_KEYS=sk-a,sk-b,sk-c`. Blank entries dropped;
/// unset → empty (single-account, uses the scalar `*_API_KEY`).
fn env_keys(name: &str) -> Vec<String> {
    std::env::var(name)
        .ok()
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

fn first_non_empty_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn non_empty_provider_key<'a>(
    keys: &'a HashMap<String, String>,
    provider: &str,
) -> Option<&'a str> {
    keys.get(provider)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RateLimitConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Token-based limit per minute per API key (approximate). Omitted from a
    /// partial `[rate_limit]` section ⇒ the `Default` value, NOT unlimited.
    #[serde(default = "default_tokens_per_minute")]
    pub tokens_per_minute: Option<u64>,

    /// Request count limit per minute per API key. Same partial-section
    /// semantics as `tokens_per_minute`.
    #[serde(default = "default_requests_per_minute")]
    pub requests_per_minute: Option<u64>,

    /// Maximum requests per second per key before bot-detection triggers (0 = disabled).
    #[serde(default = "default_burst_rps")]
    pub max_burst_per_second: u32,
}

fn default_burst_rps() -> u32 {
    10
}

fn default_tokens_per_minute() -> Option<u64> {
    Some(100_000)
}

fn default_requests_per_minute() -> Option<u64> {
    Some(500)
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            tokens_per_minute: default_tokens_per_minute(),
            requests_per_minute: default_requests_per_minute(),
            max_burst_per_second: default_burst_rps(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct AuthConfig {
    /// When false, all requests are accepted regardless of API key
    #[serde(default)]
    pub require_auth: bool,

    /// Statically configured API keys
    #[serde(default)]
    pub api_keys: Vec<ApiKeyConfig>,

    /// A single master key that bypasses all per-key limits
    pub master_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApiKeyConfig {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    /// Internal control-plane id used only to namespace Core channel sessions.
    /// It is never written to gateway.toml; env-backed configs leave it empty.
    #[serde(skip)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Override the global requests_per_minute limit for this key.
    #[serde(default)]
    pub requests_per_minute: Option<u64>,
    /// Override the global tokens_per_minute limit for this key.
    #[serde(default)]
    pub tokens_per_minute: Option<u64>,
    /// Lifetime token cap for this key (input + output combined). 0 = unlimited.
    #[serde(default)]
    pub token_budget_total: Option<u64>,
    /// Model to downgrade to when token_budget_total is exceeded.
    /// If unset, the request is rejected with BudgetExceeded.
    #[serde(default)]
    pub downgrade_to: Option<String>,
    /// When true, this key is a trusted intermediary (e.g. Ryu Core relaying a
    /// real end-user identity) and the client-supplied `x-ryu-user-id` /
    /// `x-ryu-agent-id` headers are honored for per-user/per-agent budgets.
    /// When false (the default), those headers are ignored and budgets are
    /// keyed to this API key, so an untrusted caller cannot spoof or rotate
    /// identity headers to evade its quota.
    #[serde(default)]
    pub trusted_forwarder: bool,
}

/// Static `api_keys` are data-plane relay credentials. Administrative
/// authority is represented only by `AuthConfig::master_key`, never by a relay
/// token or by `trusted_forwarder`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeyPurpose {
    InferenceRelay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeyOperation {
    Inference,
}

impl ApiKeyConfig {
    pub const fn purpose(&self) -> ApiKeyPurpose {
        ApiKeyPurpose::InferenceRelay
    }

    pub const fn allows_operation(&self, operation: ApiKeyOperation) -> bool {
        matches!(
            (self.purpose(), operation),
            (ApiKeyPurpose::InferenceRelay, ApiKeyOperation::Inference)
        )
    }
}

#[cfg(test)]
mod api_key_purpose_tests {
    use super::{ApiKeyConfig, ApiKeyOperation, ApiKeyPurpose};

    fn relay_key() -> ApiKeyConfig {
        ApiKeyConfig {
            key: "sk-relay".to_owned(),
            name: "relay".to_owned(),
            org_id: None,
            team_id: None,
            channel_id: None,
            project_id: None,
            requests_per_minute: None,
            tokens_per_minute: None,
            token_budget_total: None,
            downgrade_to: None,
            trusted_forwarder: false,
        }
    }

    #[test]
    fn static_keys_are_inference_relays_not_admin_keys() {
        let key = relay_key();
        assert_eq!(key.purpose(), ApiKeyPurpose::InferenceRelay);
        assert!(key.allows_operation(ApiKeyOperation::Inference));
    }
}

/// Widget (Ryu Apps) governance config (§4.3). Governs the interactive widget
/// tool calls and follow-up messages that a rendered app iframe makes back
/// through the host — the traffic that arrives at the gateway carrying the
/// `widget: { instance_id, origin_server }` exec envelope.
///
/// The gateway owns rate/scan governance for these round-trips (D5: `exec_tool`
/// runs scan → budget → forward → audit for a widget `callTool`). The token
/// buckets are per-`instance_id` so one rendered widget cannot exhaust another's
/// budget. `max_concurrent_widget_instances_per_session` is declared here as the
/// single swappable knob (nothing hardcoded) but is enforced in Core at mint
/// time (D4, `WidgetInstanceStore::mint`), not on this request path.
///
/// Everything is a swappable default; the whole section can be disabled with
/// `enabled = false`, which makes the widget branch a bare governed forward.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WidgetConfig {
    /// Master switch for widget-specific governance. Default: true. When false,
    /// widget calls still forward (governed by the base exec gate) but skip the
    /// per-instance rate/scan layer.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Max widget `callTool`s per rolling minute, per widget instance. 0 =
    /// unlimited. Default: 60.
    #[serde(default = "default_widget_max_calls_per_min")]
    pub max_calls_per_min: u32,
    /// Max `sendFollowUpMessage`s per rolling minute, per widget instance
    /// (stricter than `callTool`). 0 = unlimited. Default: 6.
    #[serde(default = "default_widget_max_followups_per_min")]
    pub max_followups_per_min: u32,
    /// Max concurrently live widget instances per session. Declared here as the
    /// governance knob; enforced by Core at mint time (D4), not on this path.
    /// Default: 8.
    #[serde(default = "default_widget_max_concurrent_instances_per_session")]
    pub max_concurrent_widget_instances_per_session: u32,
    /// Scan widget `callTool` arguments through the firewall (PII/secret/
    /// injection) before forwarding. Default: true.
    #[serde(default = "default_true")]
    pub scan_arguments: bool,
    /// Scan `sendFollowUpMessage` prompts before they enter model context.
    /// Default: true.
    #[serde(default = "default_true")]
    pub scan_followups: bool,
}

fn default_widget_max_calls_per_min() -> u32 {
    60
}
fn default_widget_max_followups_per_min() -> u32 {
    6
}
fn default_widget_max_concurrent_instances_per_session() -> u32 {
    8
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_calls_per_min: default_widget_max_calls_per_min(),
            max_followups_per_min: default_widget_max_followups_per_min(),
            max_concurrent_widget_instances_per_session:
                default_widget_max_concurrent_instances_per_session(),
            scan_arguments: true,
            scan_followups: true,
        }
    }
}

impl GatewayConfig {
    /// Overlay shared fleet provider keys fetched from the control-plane vault.
    ///
    /// The overlay wins over env/file credentials and clears multi-account or
    /// org-key material from the active config so a hosted gateway has exactly
    /// one backend-owned source of truth. Base URLs and non-secret provider
    /// options remain deployment configuration.
    pub fn apply_provider_vault_keys(&mut self, keys: &HashMap<String, String>) -> Vec<String> {
        let mut applied = Vec::new();

        if let Some(key) = non_empty_provider_key(keys, "openai") {
            let mut provider = self
                .providers
                .openai
                .take()
                .unwrap_or(OpenAiProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: openai_base_url(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.openai = Some(provider);
            applied.push("openai".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "anthropic") {
            let mut provider = self
                .providers
                .anthropic
                .take()
                .unwrap_or(AnthropicProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: anthropic_base_url(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.anthropic = Some(provider);
            applied.push("anthropic".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "openrouter") {
            let mut provider =
                self.providers
                    .openrouter
                    .take()
                    .unwrap_or(OpenRouterProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url: openrouter_base_url(),
                        site_url: openrouter_site_url(),
                        site_name: openrouter_site_name(),
                        data_collection: openrouter_data_collection(),
                        zdr: false,
                        sort: String::new(),
                        response_healing: false,
                        usage_accounting: true,
                        org_api_keys: HashMap::new(),
                    });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            provider.org_api_keys.clear();
            self.providers.openrouter = Some(provider);
            applied.push("openrouter".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "replicate") {
            let mut provider = self
                .providers
                .replicate
                .take()
                .unwrap_or(ReplicateProviderConfig {
                    api_key: String::new(),
                    base_url: replicate_base_url(),
                    poll_interval_ms: default_media_poll_interval_ms(),
                    poll_timeout_secs: default_media_poll_timeout_secs(),
                });
            provider.api_key = key.to_owned();
            self.providers.replicate = Some(provider);
            applied.push("replicate".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "fal") {
            let mut provider = self.providers.fal.take().unwrap_or(FalProviderConfig {
                api_key: String::new(),
                base_url: fal_base_url(),
                poll_interval_ms: default_media_poll_interval_ms(),
                poll_timeout_secs: default_media_poll_timeout_secs(),
            });
            provider.api_key = key.to_owned();
            self.providers.fal = Some(provider);
            applied.push("fal".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "cloudflare") {
            let base_url = self
                .providers
                .cloudflare
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    std::env::var("CLOUDFLARE_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    std::env::var("CLOUDFLARE_ACCOUNT_ID")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .map(|account_id| {
                            format!(
                                "https://api.cloudflare.com/client/v4/accounts/{}/ai/v1",
                                account_id.trim()
                            )
                        })
                });
            if let Some(base_url) = base_url {
                let mut provider =
                    self.providers
                        .cloudflare
                        .take()
                        .unwrap_or(CloudflareProviderConfig {
                            api_key: String::new(),
                            api_keys: Vec::new(),
                            base_url,
                        });
                provider.api_key = key.to_owned();
                provider.api_keys.clear();
                self.providers.cloudflare = Some(provider);
                applied.push("cloudflare".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains a Cloudflare key but CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_BASE_URL is missing; Cloudflare remains disabled"
                );
            }
        }

        if let Some(key) = non_empty_provider_key(keys, "bedrock") {
            let base_url = self
                .providers
                .bedrock
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    std::env::var("BEDROCK_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    std::env::var("AWS_REGION")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .map(|region| {
                            format!("https://bedrock-mantle.{}.api.aws/anthropic", region.trim())
                        })
                });
            if let Some(base_url) = base_url {
                let mut provider = self
                    .providers
                    .bedrock
                    .take()
                    .unwrap_or(BedrockProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url,
                    });
                provider.api_key = key.to_owned();
                provider.api_keys.clear();
                self.providers.bedrock = Some(provider);
                applied.push("bedrock".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains a Bedrock key but AWS_REGION or BEDROCK_BASE_URL is missing; Bedrock remains disabled"
                );
            }
        }

        if let Some(key) = non_empty_provider_key(keys, "vertex") {
            let base_url = self
                .providers
                .vertex
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    std::env::var("VERTEX_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    let project = std::env::var("VERTEX_PROJECT_ID").ok()?;
                    let location = std::env::var("VERTEX_LOCATION").ok()?;
                    if project.trim().is_empty() || location.trim().is_empty() {
                        return None;
                    }
                    Some(format!(
                        "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/endpoints/openapi",
                        location.trim(),
                        project.trim(),
                        location.trim()
                    ))
                });
            if let Some(base_url) = base_url {
                let mut provider = self
                    .providers
                    .vertex
                    .take()
                    .unwrap_or(VertexProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url,
                    });
                provider.api_key = key.to_owned();
                provider.api_keys.clear();
                self.providers.vertex = Some(provider);
                applied.push("vertex".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains a Vertex key but Vertex project/location or VERTEX_BASE_URL is missing; Vertex remains disabled"
                );
            }
        }

        if let Some(key) = non_empty_provider_key(keys, "openai_credits") {
            let mut provider =
                self.providers
                    .openai_credits
                    .take()
                    .unwrap_or(OpenAiProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url: openai_base_url(),
                    });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.openai_credits = Some(provider);
            applied.push("openai_credits".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "composio") {
            self.composio.api_key = Some(key.to_owned());
            self.composio.enabled = true;
            applied.push("composio".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "treg") {
            self.treg.token = Some(key.to_owned());
            self.treg.enabled = true;
            applied.push("treg".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "modal") {
            let base_url = self
                .providers
                .modal
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .or_else(|| {
                    std::env::var("MODAL_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                });
            if let Some(base_url) = base_url {
                self.providers.modal = Some(ModalProviderConfig {
                    api_key: key.to_owned(),
                    base_url,
                });
                applied.push("modal".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains a Modal key but MODAL_BASE_URL is missing; Modal remains disabled"
                );
            }
        }

        applied
    }

    /// Replace every supported provider credential with the successful fleet
    /// vault response. Required hosted mode uses this instead of a partial
    /// overlay so a stale gateway.toml/env key cannot survive merely because
    /// its provider was omitted from MongoDB.
    pub fn replace_provider_vault_keys(&mut self, keys: &HashMap<String, String>) -> Vec<String> {
        if let Some(provider) = self.providers.openai.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.anthropic.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.openrouter.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
            provider.org_api_keys.clear();
        }
        if let Some(provider) = self.providers.replicate.as_mut() {
            provider.api_key.clear();
        }
        if let Some(provider) = self.providers.fal.as_mut() {
            provider.api_key.clear();
        }
        if let Some(provider) = self.providers.modal.as_mut() {
            provider.api_key.clear();
        }
        if let Some(provider) = self.providers.cloudflare.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.bedrock.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.vertex.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.openai_credits.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        self.composio.api_key = None;
        self.composio.enabled = false;
        self.treg.token = None;
        self.treg.enabled = false;
        let applied = self.apply_provider_vault_keys(keys);

        if non_empty_provider_key(keys, "openai").is_none() {
            self.providers.openai = None;
        }
        if non_empty_provider_key(keys, "anthropic").is_none() {
            self.providers.anthropic = None;
        }
        if non_empty_provider_key(keys, "openrouter").is_none() {
            self.providers.openrouter = None;
        }
        if non_empty_provider_key(keys, "replicate").is_none() {
            self.providers.replicate = None;
        }
        if non_empty_provider_key(keys, "fal").is_none() {
            self.providers.fal = None;
        }
        if non_empty_provider_key(keys, "modal").is_none() {
            self.providers.modal = None;
        }
        if non_empty_provider_key(keys, "cloudflare").is_none() {
            self.providers.cloudflare = None;
        }
        if non_empty_provider_key(keys, "bedrock").is_none() {
            self.providers.bedrock = None;
        }
        if non_empty_provider_key(keys, "vertex").is_none() {
            self.providers.vertex = None;
        }
        if non_empty_provider_key(keys, "openai_credits").is_none() {
            self.providers.openai_credits = None;
        }

        applied
    }

    /// Resolve the gateway.toml path using the same logic as `load()`:
    /// `GATEWAY_CONFIG` env var first, then `$config_dir/ryu/gateway.toml`.
    pub fn config_path() -> Option<std::path::PathBuf> {
        std::env::var("GATEWAY_CONFIG")
            .ok()
            .map(std::path::PathBuf::from)
            // Profile-aware fallback (`<config>/ryu{suffix}/gateway.toml`) so a
            // standalone dev gateway reads its own config, not the release one.
            .or_else(crate::profile::default_config_path)
    }

    /// Remove the load-time classify seed from `routing.model_map`.
    ///
    /// Why the seeded row must not be served or saved: `GET /v1/config` renders
    /// `routing.model_map` as the desktop's hand-authored "Model mappings" list
    /// (`GatewayDialog.tsx`), each row with a delete button. A seeded row there reads
    /// as operator-authored, and deleting it *cannot work* — the delete is a
    /// read-modify-write `PUT` of the whole `routing`, so the row does leave the file,
    /// and then the next [`Self::load`] seeds it straight back. The operator sees a
    /// mapping they never wrote, deletes it successfully, and watches it return. Same
    /// reason it must not reach `gateway.toml`: there it looks operator-authored
    /// forever and outlives the id it was seeded for.
    ///
    /// Routing is unaffected because the seed is re-applied on every `load()`, which
    /// is upstream of every production router — see [`seed_classify_route`].
    ///
    /// The shape re-check guards the one case the marker cannot: something replaced
    /// the mapping in memory after the seed ran, in which case the current value is
    /// somebody's choice and not ours to delete. (The converse — `routing` replaced
    /// wholesale by a `PUT` body that happens to contain a byte-identical
    /// `<id> → classify` row while the marker is still set — is unreachable:
    /// `api::config::persisted_config` consumes the marker before `put_config`
    /// assigns `routing`, so the value the strip sees is always the one it seeded.)
    pub fn strip_seeded_classify_route(&mut self) {
        let Some(model_id) = self.seeded_classify_model.take() else {
            return;
        };
        let is_untouched_seed = self
            .routing
            .model_map
            .get(&model_id)
            .is_some_and(|mapping| {
                mapping.provider.as_str() == CLASSIFY_PROVIDER_ID
                    && mapping.provider_model.is_none()
            });
        if is_untouched_seed {
            self.routing.model_map.remove(&model_id);
        }
    }

    /// Undo the env overlay on `providers.classify`: restore whatever
    /// `gateway.toml` said ([`Self::file_classify_provider`] — `None` when it said
    /// nothing) if and only if [`Self::load`] overwrote the slot from Core's
    /// `RYU_CLASSIFY_LLM_URL`.
    ///
    /// RESTORE, not clear. The env wins the live slot, so on a node whose operator
    /// *did* author `[providers.classify]` the in-memory value is Core's; clearing
    /// would delete the operator's table from their own file on the next
    /// `PUT`-triggered save (`api::config::put_config` re-serializes this shape).
    /// A marker-less config — no env, or a standalone gateway — is untouched.
    ///
    /// Why `classify` is stripped when `openai` / `anthropic` / `local` are not,
    /// stated honestly: for all four the env wins the next `load()`, so a persisted
    /// copy is shadowed rather than obeyed while Core is the spawner. The difference
    /// is what gets frozen. The others persist an operator's own credential or an
    /// engine URL; `classify` would persist a **computed, profile-scoped loopback
    /// port** (`:8083` release, `:9083` dev) that Core recomputes on every spawn — so
    /// the copy is stale on the next profile or port change and becomes *live* as soon
    /// as something other than Core starts the gateway. The same argument does apply
    /// to `local` (also computed by Core, from the active-engine store) and simply is
    /// not implemented there; this is the narrower, safer slot, not a categorical
    /// distinction.
    pub fn strip_env_injected_classify_provider(&mut self) {
        if std::mem::take(&mut self.env_injected_classify_provider) {
            self.providers.classify = self.file_classify_provider.take();
        }
    }

    /// `self` minus every DERIVED value that [`Self::load`] adds on top of the file:
    /// the seeded classify route is removed, and an env-overwritten
    /// `[providers.classify]` is reverted to what the file said. This is the shape
    /// that may leave the process — written to `gateway.toml`, or read by
    /// `api::config::persisted_config`.
    ///
    /// Applied in exactly two places, which between them cover both directions:
    /// [`Self::save`] (so no `save()` caller can persist a derived value) and
    /// `api::config::persisted_config` (whose `routing` half genuinely reaches
    /// `GET /v1/config` and the read-modify-write clients that PUT it back).
    ///
    /// The two halves are NOT equally load-bearing at the `persisted_config` call —
    /// see that function's doc for which is which; they are applied together because
    /// this is the single "may leave the process" gate and splitting it would create a
    /// second rule to keep in sync. See [`Self::strip_seeded_classify_route`] and
    /// [`Self::strip_env_injected_classify_provider`].
    pub fn without_derived_values(&self) -> Self {
        let mut clean = self.clone();
        clean.strip_seeded_classify_route();
        clean.strip_env_injected_classify_provider();
        clean
    }

    /// Atomically persist `self` to `gateway.toml`, creating the parent directory
    /// if needed. Writes to a `.tmp` file in the same directory, then renames over
    /// the target so a crash mid-write never leaves a corrupt file.
    ///
    /// Persists [`Self::without_derived_values`], never `self` verbatim: `load()`
    /// seeds a `routing.model_map` row for the classify tier and may overwrite
    /// `providers.classify` from Core's env, and writing either back would turn a
    /// derived value into a permanent, operator-authored-looking file entry — an
    /// undeletable "Model mappings" row in the first case; in the second, a computed
    /// profile-scoped loopback port frozen into the file (and, where the operator had
    /// authored a table of their own, that table silently replaced).
    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::config_path()
            .ok_or_else(|| anyhow::anyhow!("Cannot determine gateway config path"))?;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let toml_str = toml::to_string_pretty(&self.without_derived_values())
            .map_err(|e| anyhow::anyhow!("Failed to serialize config: {e}"))?;

        let tmp_path = path.with_extension("toml.tmp");
        std::fs::write(&tmp_path, &toml_str)?;
        std::fs::rename(&tmp_path, &path)?;

        Ok(())
    }

    pub fn load() -> anyhow::Result<Self> {
        let config_path = Self::config_path();

        let mut config: GatewayConfig = if let Some(path) = config_path {
            if path.exists() {
                let content = std::fs::read_to_string(&path)?;
                toml::from_str(&content)?
            } else {
                GatewayConfig::default()
            }
        } else {
            GatewayConfig::default()
        };

        // Bind address
        if let Ok(bind) = std::env::var("GATEWAY_BIND") {
            config.bind = bind;
        }

        // OpenAI
        if let Ok(key) = std::env::var("OPENAI_API_KEY") {
            let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| openai_base_url());
            config.providers.openai = Some(OpenAiProviderConfig {
                api_key: key,
                api_keys: env_keys("OPENAI_API_KEYS"),
                base_url,
            });
        }

        // Anthropic
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
            let base_url =
                std::env::var("ANTHROPIC_BASE_URL").unwrap_or_else(|_| anthropic_base_url());
            config.providers.anthropic = Some(AnthropicProviderConfig {
                api_key: key,
                api_keys: env_keys("ANTHROPIC_API_KEYS"),
                base_url,
            });
        }

        // Local LLM
        if let Ok(url) = std::env::var("LOCAL_LLM_URL") {
            config.providers.local = Some(LocalProviderConfig { base_url: url });
        }

        // Classify-tier LLM. Core publishes `RYU_CLASSIFY_LLM_URL` into the gateway
        // spawn env pointing at its lazy llama.cpp classify sidecar (profile-offset
        // [`DEFAULT_CLASSIFY_PORT`]) — unconditionally, so on a Core-spawned gateway
        // this slot is always `Some`. Absent (a STANDALONE gateway) ⇒ the slot stays
        // `None` and the `classify` provider is never registered, which the
        // inspector/judge handle by failing open — see
        // [`crate::providers::ProviderRegistry::new`].
        //
        // THE ENV WINS over the file here, exactly like `local`/`LOCAL_LLM_URL` above.
        // A previous round inverted this (file-wins) so that a `[providers.classify]
        // base_url` in `gateway.toml` would stop being inert on a Core-spawned node.
        // That is a real improvement in isolation and it is deliberately given up,
        // because the precedence is not a local decision — it is half of a
        // cross-process contract, and file-wins made the other half unsatisfiable:
        //
        //   Core lazily starts a ~300-400 MB `llamacpp-classify` sidecar whenever a
        //   config push selects the classify tier (`apps/core/src/sidecar/gateway.rs`
        //   ::`maybe_start_classify_tier`). Read, not assumed: its only locality check
        //   is `url_targets_this_machine(gateway_url())` — "is the gateway on this
        //   box" — and there is nothing else it *could* check under file-wins, because
        //   the deciding value then lives in a file in the gateway's own config
        //   directory, which Core neither reads nor is notified about. So on a node
        //   whose operator pointed `[providers.classify]` at an external small model,
        //   every selecting push started a local sidecar nothing ever dialed. Idle-stop
        //   is off unless `RYU_SIDECAR_IDLE`, so that RAM stayed resident for the life
        //   of the process.
        //
        // Under env-wins the URL the gateway will dial for `classify` on a Core-spawned
        // node is EXACTLY the value Core published, i.e. `classify_gateway_url()` — a
        // fact Core can evaluate from its own process with no file access and no new
        // channel. That is what lets the lazy start be gated on the classify *target's*
        // locality (it now is), which removes the wasted-RAM class instead of trading
        // it for an inert setting.
        //
        // Consequence, stated plainly rather than left implicit: `[providers.classify]`
        // is the **standalone-gateway** setting. On a gateway Core spawned it is
        // overwritten on every load and therefore has no effect; repointing the tier
        // there takes `RYU_CLASSIFY_LLM_URL` (plus `RYU_LOCAL_CLASSIFIER_MODEL_ID` for
        // the id) in *Core's* environment. This matches `local`/`LOCAL_LLM_URL`, the
        // established precedent for a Core-published provider URL, so there is one rule
        // for both slots instead of two.
        //
        // A blank env value reads as "not published" (Core never sends one, but a shell
        // could): the file table — or `None` — survives, so the tier fails open rather
        // than registering an unusable "" URL.
        //
        // The slot the env fills is DERIVED and is stripped again before anything is
        // written ([`GatewayConfig::without_derived_values`]). It must be: every
        // provider slot serializes back out on `save()`, and Core's URL is a computed,
        // profile-scoped loopback address — persisting it would record a value that is
        // wrong on the next profile/port change and that goes live the moment Core is
        // not the spawner. The operator's own table is CAPTURED here
        // ([`Self::file_classify_provider`]) so the strip restores it instead of
        // deleting it from their file.
        if let Some(url) = std::env::var("RYU_CLASSIFY_LLM_URL")
            .ok()
            .filter(|url| !url.trim().is_empty())
        {
            config.file_classify_provider = config.providers.classify.take();
            config.providers.classify = Some(ClassifyProviderConfig { base_url: url });
            config.env_injected_classify_provider = true;
        }
        // …and make the classifier id ROUTABLE, not just readable. The built-in
        // `"gemma-3-270m"` prefix cannot follow a registry override (it is a
        // compile-time table), and `route`'s two user-`model_map` steps run BEFORE
        // it — so both an overridden id and a stray user `gemma` prefix mapping
        // would send the guardrail classifier somewhere other than the classify
        // tier. Seeding an exact entry fixes both at once because exact-match is
        // step 1. The seeded key is remembered so the row can be stripped again from
        // everything that leaves the process — it is derived, not operator config.
        // See [`seed_classify_route`] and [`GatewayConfig::without_derived_values`].
        config.seeded_classify_model =
            seed_classify_route(&mut config.routing, &classify_model_id());

        // Auth master key
        if let Ok(key) = std::env::var("GATEWAY_MASTER_KEY") {
            config.auth.master_key = Some(key);
            config.auth.require_auth = true;
        }

        // Admin key WITHOUT flipping base auth.
        //
        // `GATEWAY_MASTER_KEY` above does two things at once — provisions an admin
        // credential and turns on auth for EVERY route. That coupling is right for
        // an operator hardening a deployment, and wrong for the one caller that
        // needs an admin credential by construction: Core, which spawns this
        // gateway as its own child.
        //
        // The problem it solves: the admin surface (`/v1/config`, audit,
        // budget/spend) is otherwise reachable only by loopback trust, and
        // `admin_loopback_allowed` deliberately revokes that trust whenever the
        // MESH is on — mesh peers arrive as `127.0.0.1`, so loopback would
        // otherwise fail open to them. Correct, but it also locked out Core, which
        // had no admin credential to fall back on: every gateway settings tab
        // answered 401 the moment the user enabled the mesh.
        //
        // Core cannot use `GATEWAY_MASTER_KEY` for this, because flipping
        // `require_auth` would demand a bearer on every ordinary call (chat,
        // media, titles, widgets, …) that Core and its sidecars make without one.
        // So this sets the credential alone: admin routes start demanding it,
        // everything else is untouched.
        //
        // Ignored when `GATEWAY_MASTER_KEY` already provisioned one — an explicit
        // operator key outranks the one Core mints for itself.
        if config.auth.master_key.is_none() {
            if let Ok(key) = std::env::var("GATEWAY_ADMIN_KEY") {
                let key = key.trim().to_owned();
                if !key.is_empty() {
                    config.auth.master_key = Some(key);
                }
            }
        }

        // Provider prompt caching. Every knob is independently overridable so a
        // managed node can set a posture without shipping a gateway.toml.
        if let Ok(mode) = std::env::var("GATEWAY_PROMPT_CACHE") {
            config.prompt_cache.mode = mode;
        }
        if let Ok(ttl) = std::env::var("GATEWAY_PROMPT_CACHE_TTL") {
            config.prompt_cache.ttl = ttl;
        }
        if let Some(n) = std::env::var("GATEWAY_PROMPT_CACHE_MIN_PREFIX_TOKENS")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
        {
            config.prompt_cache.min_prefix_tokens = n;
        }
        if let Some(n) = std::env::var("GATEWAY_PROMPT_CACHE_BREAKPOINTS")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
        {
            config.prompt_cache.breakpoints = n;
        }
        if std::env::var("GATEWAY_PROMPT_CACHE_SESSION_AFFINITY").is_ok() {
            config.prompt_cache.session_affinity =
                env_bool("GATEWAY_PROMPT_CACHE_SESSION_AFFINITY", false);
        }
        if std::env::var("GATEWAY_PROMPT_CACHE_ALLOW_OVERRIDE").is_ok() {
            config.prompt_cache.allow_request_override =
                env_bool("GATEWAY_PROMPT_CACHE_ALLOW_OVERRIDE", true);
        }

        // Node routing preferences (`x-ryu-node-routing`). Only the on/off lever
        // is env-settable: the size caps are a work bound an operator has no
        // reason to tune per replica, and making them env-settable would invite
        // raising them past what the terminating proxy will even forward.
        if std::env::var("GATEWAY_NODE_ROUTING_ALLOW_OVERRIDE").is_ok() {
            config.node_routing.allow_request_override =
                env_bool("GATEWAY_NODE_ROUTING_ALLOW_OVERRIDE", true);
        }

        // Composio
        if let Ok(key) = std::env::var("COMPOSIO_API_KEY") {
            config.composio.api_key = Some(key);
            config.composio.enabled = true;
        }
        if let Ok(entity_id) = std::env::var("COMPOSIO_ENTITY_ID") {
            config.composio.entity_id = entity_id;
        }

        // Treg. A local standalone gateway may use an operator-provided token;
        // required fleet mode replaces this runtime value from the provider vault
        // after load, so a stale env token cannot survive a successful vault read.
        if let Some(token) = first_non_empty_env(&["RYU_TREG_TOKEN", "TREG_TOKEN"]) {
            config.treg.token = Some(token);
            config.treg.enabled = true;
        }
        if let Some(base_url) = first_non_empty_env(&["RYU_TREG_URL", "TREG_URL"]) {
            config.treg.base_url = base_url;
        }

        // OpenRouter
        if let Ok(key) = std::env::var("OPENROUTER_API_KEY") {
            let base_url =
                std::env::var("OPENROUTER_BASE_URL").unwrap_or_else(|_| openrouter_base_url());
            let site_url =
                std::env::var("OPENROUTER_SITE_URL").unwrap_or_else(|_| openrouter_site_url());
            let site_name =
                std::env::var("OPENROUTER_SITE_NAME").unwrap_or_else(|_| openrouter_site_name());
            let data_collection = std::env::var("OPENROUTER_DATA_COLLECTION")
                .unwrap_or_else(|_| openrouter_data_collection());
            let zdr = env_bool("OPENROUTER_ZDR", false);
            let sort = std::env::var("OPENROUTER_SORT").unwrap_or_default();
            let response_healing = env_bool("OPENROUTER_RESPONSE_HEALING", false);
            let usage_accounting = env_bool("OPENROUTER_USAGE_ACCOUNTING", true);
            config.providers.openrouter = Some(OpenRouterProviderConfig {
                api_key: key,
                api_keys: env_keys("OPENROUTER_API_KEYS"),
                base_url,
                site_url,
                site_name,
                data_collection,
                zdr,
                sort,
                response_healing,
                usage_accounting,
                org_api_keys: std::collections::HashMap::new(),
            });
        }

        // Replicate (cloud image/video). Key presence alone activates the
        // provider — mirrors the OpenRouter block. base_url overridable for
        // proxies / self-host.
        if let Ok(key) = std::env::var("REPLICATE_API_KEY") {
            if !key.trim().is_empty() {
                let base_url = std::env::var("REPLICATE_BASE_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(replicate_base_url);
                config.providers.replicate = Some(ReplicateProviderConfig {
                    api_key: key,
                    base_url,
                    poll_interval_ms: default_media_poll_interval_ms(),
                    poll_timeout_secs: default_media_poll_timeout_secs(),
                });
            }
        }

        // Fal (cloud image/video/audio). Key presence alone activates it.
        if let Ok(key) = std::env::var("FAL_API_KEY") {
            if !key.trim().is_empty() {
                let base_url = std::env::var("FAL_BASE_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(fal_base_url);
                config.providers.fal = Some(FalProviderConfig {
                    api_key: key,
                    base_url,
                    poll_interval_ms: default_media_poll_interval_ms(),
                    poll_timeout_secs: default_media_poll_timeout_secs(),
                });
            }
        }

        // Core sidecar manager
        if let Ok(url) = std::env::var("CORE_URL") {
            let token = std::env::var("CORE_TOKEN").ok();
            config.providers.core = Some(CoreProviderConfig {
                base_url: url,
                token,
            });
        }

        // Modal serverless GPU (opt-in). A Ryu Cloud GPU node sets both vars to
        // its deployed Modal inference app; absent either, the provider stays
        // off (nothing hardcoded, no default URL).
        if let (Ok(base_url), Ok(api_key)) = (
            std::env::var("MODAL_BASE_URL"),
            std::env::var("MODAL_API_KEY"),
        ) {
            if !base_url.trim().is_empty() && !api_key.trim().is_empty() {
                config.providers.modal = Some(ModalProviderConfig { api_key, base_url });
            }
        }

        // Cloudflare Workers AI — the `cloudflare` credit pool's supply. Both the
        // account id and the token are required because the endpoint embeds the
        // account (`…/accounts/{id}/ai/v1`); absent either, the provider stays off
        // and the id is simply missing from the registry (nothing hardcoded, no
        // default URL, no boot failure). `CLOUDFLARE_BASE_URL` overrides the
        // interpolation wholesale for gateways fronted by a proxy.
        if let Ok(token) = std::env::var("CLOUDFLARE_API_TOKEN") {
            let account_id = std::env::var("CLOUDFLARE_ACCOUNT_ID").unwrap_or_default();
            let base_url = std::env::var("CLOUDFLARE_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    (!account_id.trim().is_empty()).then(|| {
                        format!(
                            "https://api.cloudflare.com/client/v4/accounts/{}/ai/v1",
                            account_id.trim()
                        )
                    })
                });
            if let Some(base_url) = base_url {
                if !token.trim().is_empty() {
                    config.providers.cloudflare = Some(CloudflareProviderConfig {
                        api_key: token,
                        api_keys: env_keys("CLOUDFLARE_API_TOKENS"),
                        base_url,
                    });
                }
            }
        }

        // AWS Bedrock — the `bedrock` credit pool's supply. `AWS_BEARER_TOKEN_BEDROCK`
        // is Bedrock's own long-lived API key (not SigV4 credentials), which is what
        // lets the Anthropic-Messages impl talk to it unmodified. Region-scoped, so
        // the URL is interpolated from `AWS_REGION` unless `BEDROCK_BASE_URL` pins it.
        if let Ok(token) = std::env::var("AWS_BEARER_TOKEN_BEDROCK") {
            let region = std::env::var("AWS_REGION").unwrap_or_default();
            let base_url = std::env::var("BEDROCK_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    (!region.trim().is_empty()).then(|| {
                        format!("https://bedrock-mantle.{}.api.aws/anthropic", region.trim())
                    })
                });
            if let Some(base_url) = base_url {
                if !token.trim().is_empty() {
                    config.providers.bedrock = Some(BedrockProviderConfig {
                        api_key: token,
                        api_keys: env_keys("AWS_BEARER_TOKENS_BEDROCK"),
                        base_url,
                    });
                }
            }
        }

        // Google Cloud Vertex AI — the `vertex` credit pool's supply, on Vertex's
        // OpenAI-compatible surface. Project AND location are both required because
        // the endpoint embeds both; absent either, the provider stays off and the id
        // is simply missing from the registry. `VERTEX_BASE_URL` overrides the
        // interpolation wholesale (global endpoint, a proxy, or a pinned API version).
        //
        // The interpolated form deliberately stops at `/endpoints/openapi` — the
        // OpenAI impl appends `/chat/completions` itself.
        if let Ok(token) = std::env::var("VERTEX_API_KEY") {
            let project = std::env::var("VERTEX_PROJECT_ID").unwrap_or_default();
            let location = std::env::var("VERTEX_LOCATION").unwrap_or_default();
            let base_url = std::env::var("VERTEX_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    (!project.trim().is_empty() && !location.trim().is_empty()).then(|| {
                        format!(
                            "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/endpoints/openapi",
                            location.trim(),
                            project.trim(),
                            location.trim()
                        )
                    })
                });
            if let Some(base_url) = base_url {
                if !token.trim().is_empty() {
                    config.providers.vertex = Some(VertexProviderConfig {
                        api_key: token,
                        api_keys: env_keys("VERTEX_API_KEYS"),
                        base_url,
                    });
                }
            }
        }

        // The donated OpenAI allowance — a SEPARATE env var from `OPENAI_API_KEY`
        // on purpose. Reading the same var would tag a BYOK deploy's own key as
        // donated supply, which is the whole failure this slot exists to avoid.
        // Unlike the other three pools the endpoint is not account/region-scoped,
        // so `base_url` keeps its ordinary default and only the key gates the slot.
        if let Ok(key) = std::env::var("OPENAI_CREDITS_API_KEY") {
            if !key.trim().is_empty() {
                config.providers.openai_credits = Some(OpenAiProviderConfig {
                    api_key: key,
                    api_keys: env_keys("OPENAI_CREDITS_API_KEYS"),
                    base_url: std::env::var("OPENAI_CREDITS_BASE_URL")
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(openai_base_url),
                });
            }
        }

        // Firewall (data-plane, per-machine) — env overrides following the
        // gateway's GATEWAY_* env convention (GATEWAY_BIND, GATEWAY_MASTER_KEY).
        // `gateway.toml [firewall]` is the primary config; these let the local
        // stack toggle/configure the firewall without a config file.
        if let Ok(raw) = std::env::var("GATEWAY_FIREWALL_ENABLED") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.firewall.enabled = enabled;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_FIREWALL_POLICY") {
            if let Some(policy) = FirewallPolicy::from_env(&raw) {
                config.firewall.policy = policy;
            }
        }

        // Telegram channel — env token registers the bot at startup.
        if let Ok(token) = std::env::var("TELEGRAM_BOT_TOKEN") {
            if !token.trim().is_empty() {
                let existing = config.channels.telegram.take();
                config.channels.telegram = Some(TelegramChannelConfig {
                    token,
                    common: common_channel_from_env(
                        "TELEGRAM",
                        existing.as_ref().map(|c| &c.common),
                    ),
                    options: existing
                        .as_ref()
                        .map(|c| c.options.clone())
                        .unwrap_or_default(),
                });
            }
        }

        // Control plane (aggregation up + shared budgets)
        if let Ok(key) = std::env::var("CONTROL_PLANE_KEY") {
            config.control_plane.gateway_key = Some(key);
            config.control_plane.enabled = true;
        }
        if let Ok(url) = std::env::var("CONTROL_PLANE_URL") {
            config.control_plane.base_url = url;
        }
        if let Ok(id) = std::env::var("CONTROL_PLANE_SHARED_BUDGET_ID") {
            config.control_plane.shared_budget_id = Some(id);
        }

        // Slack channel — env tokens register the bot at startup. Both an
        // app-level token (Socket Mode) and a bot token (replies) are required.
        if let Ok(app_token) = std::env::var("SLACK_APP_TOKEN") {
            let bot_token = std::env::var("SLACK_BOT_TOKEN").unwrap_or_default();
            if !app_token.trim().is_empty() && !bot_token.trim().is_empty() {
                let existing = config.channels.slack.take();
                config.channels.slack = Some(SlackChannelConfig {
                    app_token,
                    bot_token,
                    common: common_channel_from_env("SLACK", existing.as_ref().map(|c| &c.common)),
                    options: existing
                        .as_ref()
                        .map(|c| c.options.clone())
                        .unwrap_or_default(),
                });
            }
        }

        // Discord channel — env token registers the bot at startup.
        if let Ok(token) = std::env::var("DISCORD_BOT_TOKEN") {
            if !token.trim().is_empty() {
                let existing = config.channels.discord.take();
                let channel_ids = channel_env_list("DISCORD", "CHANNEL_IDS")
                    .or_else(|| existing.as_ref().map(|c| c.channel_ids.clone()))
                    .unwrap_or_default();
                let thread_replies = channel_env_bool("DISCORD", "THREAD_REPLIES")
                    .or_else(|| existing.as_ref().map(|c| c.thread_replies))
                    .unwrap_or(false);
                let history_backfill = channel_env_bool("DISCORD", "HISTORY_BACKFILL")
                    .or_else(|| existing.as_ref().map(|c| c.history_backfill))
                    .unwrap_or(false);
                config.channels.discord = Some(DiscordChannelConfig {
                    token,
                    channel_ids,
                    thread_replies,
                    history_backfill,
                    free_response_channels: existing
                        .as_ref()
                        .map(|c| c.free_response_channels.clone())
                        .unwrap_or_default(),
                    allowed_channels: existing
                        .as_ref()
                        .map(|c| c.allowed_channels.clone())
                        .unwrap_or_default(),
                    allowed_roles: existing
                        .as_ref()
                        .map(|c| c.allowed_roles.clone())
                        .unwrap_or_default(),
                    thread_require_mention: existing
                        .as_ref()
                        .map(|c| c.thread_require_mention)
                        .unwrap_or(false),
                    mention_patterns: existing
                        .as_ref()
                        .map(|c| c.mention_patterns.clone())
                        .unwrap_or_default(),
                    ignored_channels: existing
                        .as_ref()
                        .map(|c| c.ignored_channels.clone())
                        .unwrap_or_default(),
                    no_thread_channels: existing
                        .as_ref()
                        .map(|c| c.no_thread_channels.clone())
                        .unwrap_or_default(),
                    allow_bots: existing.as_ref().map(|c| c.allow_bots).unwrap_or(false),
                    home_channel: existing.as_ref().and_then(|c| c.home_channel.clone()),
                    common: common_channel_from_env(
                        "DISCORD",
                        existing.as_ref().map(|c| &c.common),
                    ),
                });
            }
        }

        // WhatsApp channel — env credentials register the adapter at startup.
        if let Ok(access_token) = std::env::var("WHATSAPP_ACCESS_TOKEN") {
            if !access_token.trim().is_empty() {
                let existing = config.channels.whatsapp.take();
                let phone_number_id = std::env::var("WHATSAPP_PHONE_NUMBER_ID")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.phone_number_id.clone()))
                    .unwrap_or_default();
                let verify_token = std::env::var("WHATSAPP_VERIFY_TOKEN")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.verify_token.clone()))
                    .unwrap_or_default();
                let app_secret = std::env::var("WHATSAPP_APP_SECRET")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.app_secret.clone()))
                    .unwrap_or_default();
                let webhook_bind = std::env::var("WHATSAPP_WEBHOOK_BIND")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.webhook_bind.clone()))
                    .unwrap_or_else(default_whatsapp_bind);
                let webhook_path = std::env::var("WHATSAPP_WEBHOOK_PATH")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.webhook_path.clone()))
                    .unwrap_or_else(default_whatsapp_path);
                let graph_version = std::env::var("WHATSAPP_GRAPH_VERSION")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.graph_version.clone()))
                    .unwrap_or_else(default_whatsapp_graph_version);
                let send_read_receipts = channel_env_bool("WHATSAPP", "SEND_READ_RECEIPTS")
                    .or_else(|| existing.as_ref().map(|c| c.send_read_receipts))
                    .unwrap_or(true);
                config.channels.whatsapp = Some(WhatsAppChannelConfig {
                    access_token,
                    phone_number_id,
                    verify_token,
                    app_secret,
                    webhook_bind,
                    webhook_path,
                    graph_version,
                    send_read_receipts,
                    common: common_channel_from_env(
                        "WHATSAPP",
                        existing.as_ref().map(|c| &c.common),
                    ),
                });
            }
        }

        // BlueBubbles (iMessage) channel — the bridge's URL + password register
        // the adapter at startup. Unlike the other channels there is no vendor
        // cloud: `server_url` points at a Mac the operator runs, and the webhook
        // receiver below is what that Mac POSTs into.
        if let Ok(server_url) = std::env::var("BLUEBUBBLES_SERVER_URL") {
            if !server_url.trim().is_empty() {
                let existing = config.channels.bluebubbles.take();
                let password = channel_env("BLUEBUBBLES", "PASSWORD")
                    .or_else(|| existing.as_ref().map(|c| c.password.clone()))
                    .unwrap_or_default();
                let webhook_bind = channel_env("BLUEBUBBLES", "WEBHOOK_BIND")
                    .or_else(|| existing.as_ref().map(|c| c.webhook_bind.clone()))
                    .unwrap_or_else(default_bluebubbles_bind);
                let webhook_path = channel_env("BLUEBUBBLES", "WEBHOOK_PATH")
                    .or_else(|| existing.as_ref().map(|c| c.webhook_path.clone()))
                    .unwrap_or_else(default_bluebubbles_path);
                let private_api = channel_env_bool("BLUEBUBBLES", "PRIVATE_API")
                    .or_else(|| existing.as_ref().map(|c| c.private_api))
                    .unwrap_or(false);
                let send_read_receipts = channel_env_bool("BLUEBUBBLES", "SEND_READ_RECEIPTS")
                    .or_else(|| existing.as_ref().map(|c| c.send_read_receipts))
                    .unwrap_or(false);
                config.channels.bluebubbles = Some(BlueBubblesChannelConfig {
                    server_url,
                    password,
                    webhook_bind,
                    webhook_path,
                    private_api,
                    send_read_receipts,
                    mention_patterns: existing
                        .as_ref()
                        .map(|c| c.mention_patterns.clone())
                        .unwrap_or_default(),
                    home_channel: existing.as_ref().and_then(|c| c.home_channel.clone()),
                    common: common_channel_from_env(
                        "BLUEBUBBLES",
                        existing.as_ref().map(|c| &c.common),
                    ),
                });
            }
        }

        // Context compression (egress transform via headroom). Off by default;
        // Core sets these when the headroom proxy sidecar is enabled so that
        // every gateway-routed agent is auto-compressed.
        if let Ok(raw) = std::env::var("GATEWAY_COMPRESSION_ENABLED") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.compression.enabled = enabled;
            }
        }
        if let Ok(url) = std::env::var("GATEWAY_COMPRESSION_URL") {
            if !url.trim().is_empty() {
                config.compression.url = url;
            }
        }
        if let Ok(token) = std::env::var("GATEWAY_COMPRESSION_TOKEN") {
            if !token.trim().is_empty() {
                config.compression.token = Some(token);
            }
        }
        // The compression *service* is plugin-defined: Core forwards the policy
        // definition's `timeout_ms` / `min_messages` here so the whole config is
        // data-driven (any compression plugin, not just the bundled headroom one).
        if let Ok(raw) = std::env::var("GATEWAY_COMPRESSION_TIMEOUT_MS") {
            if let Ok(v) = raw.trim().parse::<u64>() {
                config.compression.timeout_ms = v;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_COMPRESSION_MIN_MESSAGES") {
            if let Ok(v) = raw.trim().parse::<usize>() {
                config.compression.min_messages = v;
            }
        }

        // Unified tool loop (#475). The client is keyed off CORE_URL (above);
        // this only toggles the master switch (default true).
        if let Ok(raw) = std::env::var("GATEWAY_TOOLS_ENABLED") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.tools.enabled = enabled;
            }
        }

        // Smart model routing. `gateway.toml [routing.smart_routing]` is the
        // primary config (rules live there); these env knobs only toggle the
        // master switch and the classifier model so the local stack can flip
        // it on without a config file. Rules are config-file-only.
        if let Ok(raw) = std::env::var("GATEWAY_SMART_ROUTING_ENABLED") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.routing.smart_routing.enabled = enabled;
            }
        }
        if let Ok(model) = std::env::var("GATEWAY_SMART_ROUTING_MODEL") {
            if !model.trim().is_empty() {
                config.routing.smart_routing.classifier_model = model;
            }
        }

        // Per-session charged-cost budget (#510). Config-file (`[budgets.session]`)
        // is primary; these envs override for a quick per-deployment cap with no
        // gateway.toml edit. The value is micro-USD (`1_000_000 = $1`), and
        // `GATEWAY_SESSION_BUDGET_LIMIT=0` disables it.
        if let Ok(raw) = std::env::var("GATEWAY_SESSION_BUDGET_LIMIT") {
            if let Ok(limit) = raw.trim().parse::<u64>() {
                config.budgets.session.limit = limit;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_SESSION_BUDGET_ACTION") {
            match raw.trim().to_ascii_lowercase().as_str() {
                "notify" => config.budgets.session.action = BudgetAction::Notify,
                "downgrade" => config.budgets.session.action = BudgetAction::Downgrade,
                "restrict" => config.budgets.session.action = BudgetAction::Restrict,
                "stop" => config.budgets.session.action = BudgetAction::Stop,
                _ => {}
            }
        }

        // Platform-credits debit hook (#486). Off by default; Core enables it
        // when the credits wallet is live for the deployment. The debit endpoint
        // shares the control-plane API, so inherit the resolved
        // control_plane.base_url ONLY when `[credits] base_url` was left at its
        // default — an explicit gateway.toml value (or GATEWAY_CREDITS_URL below)
        // wins, preserving the "TOML primary, env overrides" convention.
        if config.credits.base_url == default_control_plane_url() {
            config.credits.base_url = config.control_plane.base_url.clone();
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_ENABLED") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.credits.enabled = enabled;
            }
        } else if config.credits.internal_secret.is_some() {
            // MANAGED NODES BILL BY DEFAULT; self-hosted ones never do.
            //
            // `enabled` defaults to false, which is right for a self-hoster and
            // catastrophic for us: a managed node that simply forgot
            // GATEWAY_CREDITS_ENABLED serves every request — tokens, tools,
            // media, sandbox — and debits NOTHING. That is a bigger hole than any
            // unset per-call rate, and it fails silently in the same way.
            //
            // The internal secret is the discriminator, and it is the right one
            // because it is not a preference: it is the service-to-service
            // credential the control plane issues so this gateway may debit an
            // ARBITRARY org's wallet. Only a Ryu-provisioned node is given one. A
            // self-hoster has no secret, so this branch never fires for them and
            // their gateway stays free exactly as before.
            //
            // An explicit GATEWAY_CREDITS_ENABLED still wins in both directions,
            // so a managed node can be deliberately un-metered when needed.
            config.credits.enabled = true;
        }
        if let Ok(url) = std::env::var("GATEWAY_CREDITS_URL") {
            if !url.trim().is_empty() {
                config.credits.base_url = url;
            }
        }
        if let Ok(secret) = std::env::var("RYU_CREDITS_INTERNAL_SECRET") {
            if !secret.trim().is_empty() {
                config.credits.internal_secret = Some(secret);
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_MARKUP_BPS") {
            if let Ok(bps) = raw.trim().parse::<u64>() {
                config.credits.markup_bps = bps;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_PASS_THROUGH_PROVIDERS") {
            config.credits.provider_billing = raw
                .split(',')
                .map(str::trim)
                .filter(|provider| !provider.is_empty())
                .map(|provider| {
                    (
                        ProviderId::from(provider),
                        ProviderBillingPolicy {
                            mode: ProviderBillingMode::PassThrough,
                        },
                    )
                })
                .collect();
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD") {
            if let Ok(cost) = raw.trim().parse::<u64>() {
                config.credits.cost_per_tool_call_micro_usd = cost;
            }
        }
        // Per-modality flat media rates. Each has a real non-zero default, so an
        // unset var never lands on 0; setting one of these to 0 explicitly is
        // REFUSED at boot for TTS and STT (see `validate_metered_rates`), the two
        // whose only cost source is the flat rate.
        for (var, slot) in [
            (
                "GATEWAY_CREDITS_COST_PER_IMAGE_MICRO_USD",
                &mut config.credits.cost_per_image_micro_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_VIDEO_MICRO_USD",
                &mut config.credits.cost_per_video_micro_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_TTS_MICRO_USD",
                &mut config.credits.cost_per_tts_micro_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_STT_MICRO_USD",
                &mut config.credits.cost_per_stt_micro_usd,
            ),
        ] {
            if let Ok(raw) = std::env::var(var) {
                if let Ok(cost) = raw.trim().parse::<u64>() {
                    *slot = cost;
                }
            }
        }
        // Sandbox per-resource Daytona rates (nano-USD/unit-second) + the two
        // scalar knobs. Rates default to the Daytona base rates (manual `Default`
        // impl); these envs let a deployment override any rate without a
        // gateway.toml edit. Core injects all of them at gateway spawn.
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_SANDBOX_MARKUP_BPS") {
            if let Ok(bps) = raw.trim().parse::<u64>() {
                config.credits.sandbox_markup_bps = bps;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_SANDBOX_FREE_STORAGE_GIB") {
            if let Ok(gib) = raw.trim().parse::<u64>() {
                config.credits.sandbox_free_storage_gib = gib;
            }
        }
        for (var, slot) in [
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_VCPU_SECOND_NANO_USD",
                &mut config.credits.cost_per_sandbox_vcpu_second_nano_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_MEM_GIB_SECOND_NANO_USD",
                &mut config.credits.cost_per_sandbox_mem_gib_second_nano_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_STORAGE_GIB_SECOND_NANO_USD",
                &mut config.credits.cost_per_sandbox_storage_gib_second_nano_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_H200_SECOND_NANO_USD",
                &mut config.credits.cost_per_sandbox_gpu_h200_second_nano_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_H100_SECOND_NANO_USD",
                &mut config.credits.cost_per_sandbox_gpu_h100_second_nano_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_PRO_6000_SECOND_NANO_USD",
                &mut config
                    .credits
                    .cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_5090_SECOND_NANO_USD",
                &mut config.credits.cost_per_sandbox_gpu_rtx_5090_second_nano_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_4090_SECOND_NANO_USD",
                &mut config.credits.cost_per_sandbox_gpu_rtx_4090_second_nano_usd,
            ),
            (
                "GATEWAY_CREDITS_COST_PER_SANDBOX_WINDOWS_VCPU_SECOND_NANO_USD",
                &mut config.credits.cost_per_sandbox_windows_vcpu_second_nano_usd,
            ),
        ] {
            if let Ok(raw) = std::env::var(var) {
                if let Ok(rate) = raw.trim().parse::<u64>() {
                    *slot = rate;
                }
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_WALLET_EMPTY_ACTION") {
            match raw.trim().to_ascii_lowercase().as_str() {
                "downgrade" => config.credits.wallet_empty_action = WalletEmptyAction::Downgrade,
                "stop" => config.credits.wallet_empty_action = WalletEmptyAction::Stop,
                _ => {}
            }
        }
        if let Ok(model) = std::env::var("GATEWAY_CREDITS_WALLET_EMPTY_DOWNGRADE_TO") {
            if !model.trim().is_empty() {
                config.credits.wallet_empty_downgrade_to = Some(model);
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_FAIL_CLOSED") {
            if let Some(fail_closed) = parse_bool_env(&raw) {
                config.credits.fail_closed = fail_closed;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_RESERVE") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.credits.reserve_enabled = enabled;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_MIN_RESERVE_MICRO_USD") {
            if let Ok(value) = raw.trim().parse::<u64>() {
                config.credits.min_reserve_micro_usd = value;
            }
        }

        // Fleet mode (managed-cloud WS2). A publicly-exposed multi-tenant replica
        // sets this so the admin gate stops trusting loopback peers (an external
        // caller through the co-located LB looks like 127.0.0.1). Config-file
        // (`fleet = true`) is primary; this env override flips it per deployment.
        if let Ok(raw) = std::env::var("RYU_GATEWAY_FLEET") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.fleet = enabled;
            }
        }

        // Money config is validated at BOOT, not at first debit: a gateway that
        // starts and silently gives away metered surfaces is the failure mode
        // this whole check exists to prevent.
        config.credits.validate_metered_rates()?;

        Ok(config)
    }
}

// ─── Channels (bots) config ───────────────────────────────────────────────────

/// Configuration for the channel layer: external messaging surfaces (Telegram,
/// Slack, etc.) that register once at the gateway. Inbound messages become
/// gateway pipeline requests; outbound responses route back to the channel.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ChannelsConfig {
    /// Telegram bot adapter. Set `token` (or env `TELEGRAM_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub telegram: Option<TelegramChannelConfig>,
    /// Slack bot adapter (Socket Mode). Set `app_token` + `bot_token` (or env
    /// `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub slack: Option<SlackChannelConfig>,

    /// Discord bot adapter. Set `token` (or env `DISCORD_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub discord: Option<DiscordChannelConfig>,

    /// WhatsApp Business (Meta Cloud API) adapter. Set credentials (or the
    /// `WHATSAPP_*` env vars) to enable.
    #[serde(default)]
    pub whatsapp: Option<WhatsAppChannelConfig>,

    /// BlueBubbles (iMessage bridge running on a Mac) adapter. Set `server_url`
    /// + `password` (or the `BLUEBUBBLES_*` env vars) to enable.
    #[serde(default)]
    pub bluebubbles: Option<BlueBubblesChannelConfig>,
}

// `GroupReplyMode`, `DmPolicy` and `GroupPolicy` are shared channel-domain types
// owned by the `ryu-gw-channels` crate. Re-exported here so `config::<T>` stays a
// valid path and the channel config structs below keep using them as field types.
// (They all derive serde with lowercase variants, so a config file spells them
// exactly as the crate documents them.)
pub use ryu_gw_channels::pairing::{DmPolicy, GroupPolicy};
pub use ryu_gw_channels::GroupReplyMode;

/// When the bot answers with synthesized speech as well as text.
///
/// A config-FILE mirror of `ryu_gw_channels::media::VoiceReplyMode`, which is a
/// plain domain enum with no serde derives — the same split as every other
/// channel type here (config shapes are serde-aware, the crate's are not).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceReplyMode {
    /// Never synthesize. The default — TTS costs time and most chats want text.
    #[default]
    Never,
    /// Speak only when the user's own message was a voice note.
    Mirror,
    /// Speak every reply.
    Always,
}

/// The behaviour every channel config shares, independent of transport.
///
/// `#[serde(flatten)]`-ed into each per-channel table, so the keys sit exactly
/// where they always did (`[channels.telegram] model = "..."`) and an existing
/// `gateway.toml` parses byte-identically — while a new knob is added once, here,
/// instead of five times across five near-identical structs. Mirrors
/// [`ryu_gw_channels::CommonChannelConfig`], which `channels_host.rs` maps this
/// into at the spawn boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CommonChannelFileConfig {
    /// Model to route inbound messages to. Defaults to `gpt-4o`.
    /// Ignored when `agent_id`/`team_id` is set (the Core binding takes precedence).
    #[serde(default = "default_channel_model")]
    pub model: String,
    /// Optional system prompt prepended to every inbound conversation.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Core agent id to route inbound messages to (M11).
    ///
    /// When set, inbound messages are routed through Core's
    /// `POST /api/channels/run` endpoint using this agent binding instead of
    /// going directly through the gateway pipeline. The agent binding is swappable
    /// via config; omit to keep the legacy gateway-pipeline path.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Core team id to route inbound messages to. When set, the bot targets a
    /// team (a lead agent orchestrating its members) instead of a single agent
    /// and takes precedence over `agent_id`. Also routed through
    /// `/api/channels/run`.
    #[serde(default)]
    pub team_id: Option<String>,
    /// Store-backed channel config id used to namespace platform chats in Core.
    /// Environment-only channel configs leave this unset and keep legacy ids.
    #[serde(skip)]
    pub channel_id: Option<String>,
    /// When the bot replies inside a group chat (DMs always reply). Mirrors the
    /// control-plane `groupReplyMode`; defaults to mentions-only.
    #[serde(default)]
    pub group_reply_mode: GroupReplyMode,
    /// Base URL of the Core sidecar. Defaults to the profile-aware Core bind
    /// address (`http://127.0.0.1:7980` on release). Used when `agent_id` or
    /// `team_id` is set, and for the voice/command round trips.
    #[serde(default = "default_core_url")]
    pub core_url: String,
    /// Optional reaction-to-Learning bridge. Disabled by default; when enabled,
    /// `positive_emoji` / `negative_emoji` choose the provider reactions that
    /// become thumbs-up/down labels. The exact reaction is still bound to a
    /// confirmed bot reply before Core receives it.
    #[serde(default)]
    pub reaction_learning: ryu_gw_channels::ReactionLearningConfig,

    // ── Access ──────────────────────────────────────────────────────────────
    //
    // `None` means "not configured here", which is NOT the same as the policy
    // default: it hands the decision to the legacy env allowlist
    // (`RYU_CHANNEL_ALLOWED_USERS[_<PLATFORM>]`, `RYU_CHANNEL_ALLOW_ALL`) that
    // deployments already depend on. Setting either key here overrides that env
    // for this channel; leaving it unset keeps today's behaviour exactly.
    /// How a DM from an unknown sender is treated: `pairing` (default — issue a
    /// one-time code an operator approves), `allowlist`, `open`, or `disabled`.
    #[serde(default)]
    pub dm_policy: Option<DmPolicy>,
    /// How a group/multi-user chat is treated: `allowlist` (default), `open`, or
    /// `disabled`. There is no pairing flow for groups — a room is admitted by
    /// the operator or not at all.
    #[serde(default)]
    pub group_policy: Option<GroupPolicy>,
    /// Sender ids admitted without pairing. Non-empty replaces whatever the
    /// legacy env allowlist supplied.
    #[serde(default)]
    pub dm_allowlist: Vec<String>,
    /// Group/chat ids admitted under `group_policy = "allowlist"`. Non-empty
    /// replaces whatever the legacy env allowlist supplied.
    #[serde(default)]
    pub group_allowlist: Vec<String>,
    /// Sender ids admitted inside groups. This is useful for Telegram, Slack and
    /// BlueBubbles where a platform can expose a stable author id even when the
    /// room itself is discovered dynamically.
    #[serde(default)]
    pub group_user_allowlist: Vec<String>,

    // ── Presentation ────────────────────────────────────────────────────────
    /// Show a platform typing indicator (and mark inbound read) while the agent
    /// is working. On by default: a silent bot looks broken.
    #[serde(default = "default_true")]
    pub typing_indicator: bool,
    /// Publish the Ryu command menu to the platform where one exists, so `/proof`
    /// autocompletes in Telegram the way it does in the desktop composer.
    #[serde(default = "default_true")]
    pub publish_commands: bool,
    /// Render replies as platform rich text where supported, instead of plain.
    #[serde(default = "default_true")]
    pub rich_text: bool,
    /// Stream partial output where the platform supports editable drafts. Off by
    /// default — it multiplies outbound API calls and every platform rate-limits
    /// edits.
    #[serde(default)]
    pub streaming: bool,
    /// Add 👀/✅/❌ lifecycle reactions where the platform supports them.
    #[serde(default = "default_true")]
    pub lifecycle_reactions: bool,
    /// When to answer with synthesized speech alongside the text reply.
    #[serde(default)]
    pub voice_reply: VoiceReplyMode,
    /// Send Ryu's first welcome without waiting for a user message. Requires an
    /// explicitly admitted `proactive_target`; it never broadcasts.
    #[serde(default)]
    pub proactive_opening: bool,
    /// Direct-chat id where the first welcome should appear.
    #[serde(default)]
    pub proactive_target: Option<String>,

    // ── Bot profile ─────────────────────────────────────────────────────────
    //
    // Kept as three flat keys rather than a `[profile]` sub-table: the whole
    // struct is flattened into the channel table, and a nested table inside a
    // flattened struct is exactly the shape TOML cannot serialise after values.
    /// Display name pushed to the platform at startup. Unset leaves the
    /// platform's current name alone rather than clearing it.
    #[serde(default)]
    pub profile_name: Option<String>,
    /// Short bio shown on the bot's profile page (clipped to 120 chars).
    #[serde(default)]
    pub profile_short_bio: Option<String>,
    /// Longer description shown in an empty chat (clipped to 512 chars).
    #[serde(default)]
    pub profile_description: Option<String>,
}

impl Default for CommonChannelFileConfig {
    fn default() -> Self {
        Self {
            model: default_channel_model(),
            system_prompt: None,
            agent_id: None,
            team_id: None,
            channel_id: None,
            group_reply_mode: GroupReplyMode::default(),
            core_url: default_core_url(),
            reaction_learning: ryu_gw_channels::ReactionLearningConfig::default(),
            dm_policy: None,
            group_policy: None,
            dm_allowlist: Vec::new(),
            group_allowlist: Vec::new(),
            group_user_allowlist: Vec::new(),
            typing_indicator: true,
            publish_commands: true,
            rich_text: true,
            streaming: false,
            lifecycle_reactions: true,
            voice_reply: VoiceReplyMode::default(),
            proactive_opening: false,
            proactive_target: None,
            profile_name: None,
            profile_short_bio: None,
            profile_description: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelegramChannelConfig {
    /// Bot token issued by @BotFather.
    pub token: String,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.telegram]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
    /// Telegram Bot API transport and group-addressing options.
    #[serde(default)]
    pub options: TelegramChannelOptionsFileConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelegramChannelOptionsFileConfig {
    #[serde(default)]
    pub webhook_url: Option<String>,
    #[serde(default)]
    pub webhook_secret: Option<String>,
    #[serde(default = "default_telegram_webhook_bind")]
    pub webhook_bind: String,
    #[serde(default = "default_telegram_webhook_path")]
    pub webhook_path: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub base_file_url: Option<String>,
    #[serde(default)]
    pub local_mode: bool,
    #[serde(default)]
    pub mention_patterns: Vec<String>,
    #[serde(default)]
    pub ignored_threads: Vec<String>,
    #[serde(default)]
    pub exclusive_bot_mentions: bool,
    #[serde(default = "default_true")]
    pub guest_mode: bool,
    #[serde(default = "default_telegram_command_menu_max")]
    pub command_menu_max: usize,
}

impl Default for TelegramChannelOptionsFileConfig {
    fn default() -> Self {
        Self {
            webhook_url: None,
            webhook_secret: None,
            webhook_bind: default_telegram_webhook_bind(),
            webhook_path: default_telegram_webhook_path(),
            base_url: None,
            base_file_url: None,
            local_mode: false,
            mention_patterns: Vec::new(),
            ignored_threads: Vec::new(),
            exclusive_bot_mentions: false,
            guest_mode: true,
            command_menu_max: default_telegram_command_menu_max(),
        }
    }
}

pub(crate) fn default_telegram_webhook_bind() -> String {
    "0.0.0.0:8443".to_string()
}

pub(crate) fn default_telegram_webhook_path() -> String {
    "/webhooks/telegram".to_string()
}

pub(crate) fn default_telegram_command_menu_max() -> usize {
    60
}

pub(crate) fn default_core_url() -> String {
    // The channels callback URL to Core. Profile-aware (release 7980, dev 8980, …)
    // so a standalone dev gateway's channel adapters reach the dev Core, not the
    // release one. `RYU_CORE_URL` (set explicitly) still wins.
    format!("http://127.0.0.1:{}", crate::profile::port(7980))
}

/// Slack channel config. Uses Socket Mode so no public webhook URL is required:
/// the gateway opens an outbound WebSocket via the app-level token and receives
/// events over it, replying with the bot token.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SlackChannelConfig {
    /// App-level token (`xapp-...`) with `connections:write`, used to open the
    /// Socket Mode WebSocket via `apps.connections.open`.
    pub app_token: String,
    /// Bot user OAuth token (`xoxb-...`) used to post replies via
    /// `chat.postMessage`.
    pub bot_token: String,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.slack]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
    #[serde(default)]
    pub options: SlackChannelOptionsFileConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SlackChannelOptionsFileConfig {
    #[serde(default = "default_true")]
    pub reply_in_thread: bool,
    #[serde(default)]
    pub reply_broadcast: bool,
    #[serde(default)]
    pub strict_mention: bool,
    #[serde(default)]
    pub thread_require_mention: bool,
    #[serde(default)]
    pub free_response_channels: Vec<String>,
    #[serde(default)]
    pub require_mention_channels: Vec<String>,
    #[serde(default)]
    pub allowed_channels: Vec<String>,
    #[serde(default)]
    pub ignored_channels: Vec<String>,
    #[serde(default)]
    pub allow_bots: bool,
    #[serde(default)]
    pub reply_prefix: Option<String>,
    #[serde(default)]
    pub mention_patterns: Vec<String>,
    #[serde(default)]
    pub rich_blocks: bool,
    #[serde(default)]
    pub feedback_buttons: bool,
}

impl Default for SlackChannelOptionsFileConfig {
    fn default() -> Self {
        Self {
            reply_in_thread: true,
            reply_broadcast: false,
            strict_mention: false,
            thread_require_mention: false,
            free_response_channels: Vec::new(),
            require_mention_channels: Vec::new(),
            allowed_channels: Vec::new(),
            ignored_channels: Vec::new(),
            allow_bots: false,
            reply_prefix: None,
            mention_patterns: Vec::new(),
            rich_blocks: false,
            feedback_buttons: false,
        }
    }
}

pub(crate) fn default_channel_model() -> String {
    "gpt-4o".to_string()
}

/// Read a channel's group-reply mode from `<PLATFORM>_GROUP_REPLY_MODE`
/// (e.g. `TELEGRAM_GROUP_REPLY_MODE=all`). `None` when unset or unrecognised, so
/// the caller falls back to the config file and ultimately to the safe default
/// (mentions-only) — an env bot never gets talkative in groups by accident.
fn group_reply_mode_from_env(platform: &str) -> Option<GroupReplyMode> {
    match std::env::var(format!("{platform}_GROUP_REPLY_MODE")) {
        Ok(v) if v.trim().eq_ignore_ascii_case("all") => Some(GroupReplyMode::All),
        Ok(v) if v.trim().eq_ignore_ascii_case("mentions") => Some(GroupReplyMode::Mentions),
        _ => None,
    }
}

// ─── Channel env loading ─────────────────────────────────────────────────────
//
// Every channel reads the same shared knobs from `<PLATFORM>_<KNOB>`, so the
// reading is written once here and each transport block below only handles its
// own secrets. Precedence is env → the value already loaded from `gateway.toml`
// → the documented default, which is the precedence the per-channel blocks
// already implemented by hand.

/// A `<PLATFORM>_<SUFFIX>` env var, or `None` when unset or blank.
///
/// Blank is treated as unset throughout: an exported-but-empty variable is how a
/// shell script says "I have no value for this", and letting `MODEL=""` through
/// would route the bot at a model named "".
fn channel_env(platform: &str, suffix: &str) -> Option<String> {
    std::env::var(format!("{platform}_{suffix}"))
        .ok()
        .filter(|v| !v.trim().is_empty())
}

/// A boolean `<PLATFORM>_<SUFFIX>` knob. Unrecognised values are ignored (→
/// `None`) rather than guessed at, so a typo falls back to the configured value
/// instead of silently flipping behaviour.
fn channel_env_bool(platform: &str, suffix: &str) -> Option<bool> {
    channel_env(platform, suffix).and_then(|v| parse_bool_env(&v))
}

/// `<PLATFORM>_DM_POLICY` → [`DmPolicy`]. `None` when unset or unrecognised,
/// which leaves the legacy env allowlist in charge.
fn dm_policy_from_env(platform: &str) -> Option<DmPolicy> {
    match channel_env(platform, "DM_POLICY")?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "pairing" => Some(DmPolicy::Pairing),
        "allowlist" => Some(DmPolicy::Allowlist),
        "open" => Some(DmPolicy::Open),
        "disabled" | "off" => Some(DmPolicy::Disabled),
        _ => None,
    }
}

/// `<PLATFORM>_GROUP_POLICY` → [`GroupPolicy`]. There is deliberately no
/// `pairing` variant: a room is admitted by the operator or not at all.
fn group_policy_from_env(platform: &str) -> Option<GroupPolicy> {
    match channel_env(platform, "GROUP_POLICY")?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "allowlist" => Some(GroupPolicy::Allowlist),
        "open" => Some(GroupPolicy::Open),
        "disabled" | "off" => Some(GroupPolicy::Disabled),
        _ => None,
    }
}

/// `<PLATFORM>_VOICE_REPLY` → [`VoiceReplyMode`].
fn voice_reply_from_env(platform: &str) -> Option<VoiceReplyMode> {
    match channel_env(platform, "VOICE_REPLY")?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "never" | "off" => Some(VoiceReplyMode::Never),
        "mirror" => Some(VoiceReplyMode::Mirror),
        "always" => Some(VoiceReplyMode::Always),
        _ => None,
    }
}

/// A comma-separated `<PLATFORM>_<SUFFIX>` id list (allowlists, channel ids).
fn channel_env_list(platform: &str, suffix: &str) -> Option<Vec<String>> {
    let list: Vec<String> = channel_env(platform, suffix)?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    (!list.is_empty()).then_some(list)
}

/// Build the shared per-channel config from `<PLATFORM>_*` env vars, layered over
/// whatever `gateway.toml` already supplied for this channel (`existing`).
///
/// `core_url` is the one knob read from a GLOBAL var (`RYU_CORE_URL`): every
/// channel on a node talks to the same Core, and that is how the existing
/// deployments spell it.
fn common_channel_from_env(
    platform: &str,
    existing: Option<&CommonChannelFileConfig>,
) -> CommonChannelFileConfig {
    let base = existing.cloned().unwrap_or_default();
    CommonChannelFileConfig {
        model: channel_env(platform, "MODEL").unwrap_or(base.model),
        system_prompt: channel_env(platform, "SYSTEM_PROMPT").or(base.system_prompt),
        agent_id: channel_env(platform, "AGENT_ID").or(base.agent_id),
        team_id: channel_env(platform, "TEAM_ID").or(base.team_id),
        channel_id: base.channel_id,
        group_reply_mode: group_reply_mode_from_env(platform).unwrap_or(base.group_reply_mode),
        core_url: std::env::var("RYU_CORE_URL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(base.core_url),
        reaction_learning: base.reaction_learning,
        dm_policy: dm_policy_from_env(platform).or(base.dm_policy),
        group_policy: group_policy_from_env(platform).or(base.group_policy),
        dm_allowlist: channel_env_list(platform, "DM_ALLOWLIST").unwrap_or(base.dm_allowlist),
        group_allowlist: channel_env_list(platform, "GROUP_ALLOWLIST")
            .unwrap_or(base.group_allowlist),
        group_user_allowlist: channel_env_list(platform, "GROUP_USER_ALLOWLIST")
            .unwrap_or(base.group_user_allowlist),
        typing_indicator: channel_env_bool(platform, "TYPING_INDICATOR")
            .unwrap_or(base.typing_indicator),
        publish_commands: channel_env_bool(platform, "PUBLISH_COMMANDS")
            .unwrap_or(base.publish_commands),
        rich_text: channel_env_bool(platform, "RICH_TEXT").unwrap_or(base.rich_text),
        streaming: channel_env_bool(platform, "STREAMING").unwrap_or(base.streaming),
        lifecycle_reactions: channel_env_bool(platform, "LIFECYCLE_REACTIONS")
            .unwrap_or(base.lifecycle_reactions),
        voice_reply: voice_reply_from_env(platform).unwrap_or(base.voice_reply),
        proactive_opening: channel_env_bool(platform, "PROACTIVE_OPENING")
            .unwrap_or(base.proactive_opening),
        proactive_target: channel_env(platform, "PROACTIVE_TARGET").or(base.proactive_target),
        profile_name: channel_env(platform, "BOT_NAME").or(base.profile_name),
        profile_short_bio: channel_env(platform, "BOT_SHORT_BIO").or(base.profile_short_bio),
        profile_description: channel_env(platform, "BOT_DESCRIPTION").or(base.profile_description),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiscordChannelConfig {
    /// Bot token issued in the Discord developer portal (without the `Bot ` prefix).
    pub token: String,
    /// Optional legacy channel IDs the bot watches for inbound messages. An
    /// empty list keeps Discord DMs working; platform options can further scope
    /// guild channels.
    #[serde(default)]
    pub channel_ids: Vec<String>,
    /// Answer inside a thread opened on the triggering message instead of in the
    /// channel itself, which keeps a busy channel readable. Off by default so an
    /// existing deployment's replies stay where its users expect them.
    #[serde(default)]
    pub thread_replies: bool,
    #[serde(default)]
    pub history_backfill: bool,
    #[serde(default)]
    pub free_response_channels: Vec<String>,
    #[serde(default)]
    pub allowed_channels: Vec<String>,
    #[serde(default)]
    pub allowed_roles: Vec<String>,
    #[serde(default)]
    pub thread_require_mention: bool,
    #[serde(default)]
    pub mention_patterns: Vec<String>,
    #[serde(default)]
    pub ignored_channels: Vec<String>,
    #[serde(default)]
    pub no_thread_channels: Vec<String>,
    #[serde(default)]
    pub allow_bots: bool,
    #[serde(default)]
    pub home_channel: Option<String>,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.discord]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WhatsAppChannelConfig {
    /// Permanent or temporary access token for the Meta Graph API.
    pub access_token: String,
    /// Phone-number ID issued by Meta for the WhatsApp Business number.
    pub phone_number_id: String,
    /// Token used to verify Meta's webhook subscription handshake.
    pub verify_token: String,
    /// Meta App Secret, used to verify the `X-Hub-Signature-256` HMAC on every
    /// inbound webhook POST so spoofed messages are rejected. Required: the
    /// channel refuses to start if this is empty.
    #[serde(default)]
    pub app_secret: String,
    /// Local address the webhook receiver binds to. Meta delivers inbound
    /// messages here (front this with a public HTTPS reverse proxy in prod).
    #[serde(default = "default_whatsapp_bind")]
    pub webhook_bind: String,
    /// Path the webhook receiver listens on. Defaults to `/webhooks/whatsapp`.
    #[serde(default = "default_whatsapp_path")]
    pub webhook_path: String,
    /// Graph API version segment, e.g. `v21.0`.
    #[serde(default = "default_whatsapp_graph_version")]
    pub graph_version: String,
    /// Mark inbound messages read (blue ticks) when the bot picks them up. On by
    /// default: the bot is about to answer anyway, so withholding the receipt
    /// only makes it look unresponsive while it thinks.
    #[serde(default = "default_true")]
    pub send_read_receipts: bool,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.whatsapp]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
}

pub(crate) fn default_whatsapp_bind() -> String {
    "0.0.0.0:8443".to_string()
}

pub(crate) fn default_whatsapp_path() -> String {
    "/webhooks/whatsapp".to_string()
}

pub(crate) fn default_whatsapp_graph_version() -> String {
    "v21.0".to_string()
}

/// Default listener for a channel-level WhatsApp Personal/OpenWA webhook.
/// Kept separate from the Cloud API port so both adapters can be enabled in one
/// gateway without an accidental bind collision.
pub(crate) fn default_whatsapp_personal_bind() -> String {
    "0.0.0.0:8444".to_string()
}

pub(crate) fn default_whatsapp_personal_path() -> String {
    "/webhooks/whatsapp-personal".to_string()
}

/// BlueBubbles (iMessage) channel config.
///
/// BlueBubbles is a bridge the operator runs on a Mac: it talks to Messages.app
/// locally and exposes an HTTP API plus an outbound webhook. So unlike the other
/// channels there is no vendor cloud in the middle — the "credentials" are the
/// bridge's own URL and password, and the gateway must be reachable *from* that
/// Mac for the webhook to land.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BlueBubblesChannelConfig {
    /// Base URL of the BlueBubbles Server, e.g. `http://192.168.1.10:1234`.
    pub server_url: String,
    /// The server password, sent as the `password` query parameter on every call.
    pub password: String,
    /// Local address the webhook receiver binds to. BlueBubbles POSTs new
    /// messages here.
    #[serde(default = "default_bluebubbles_bind")]
    pub webhook_bind: String,
    /// Path BlueBubbles is configured to POST to.
    #[serde(default = "default_bluebubbles_path")]
    pub webhook_path: String,
    /// Use the Private API helper for typing indicators, read receipts and
    /// tapbacks. Off by default because it requires the operator to have
    /// installed the helper on the Mac; enabling it without that just produces
    /// failing calls.
    #[serde(default)]
    pub private_api: bool,
    /// Mark chats read when the bot picks a message up. Requires `private_api`.
    #[serde(default)]
    pub send_read_receipts: bool,
    #[serde(default)]
    pub mention_patterns: Vec<String>,
    #[serde(default)]
    pub home_channel: Option<String>,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.bluebubbles]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
}

pub(crate) fn default_bluebubbles_bind() -> String {
    "0.0.0.0:8446".to_string()
}

pub(crate) fn default_bluebubbles_path() -> String {
    "/webhooks/bluebubbles".to_string()
}

// ─── Phase-2 config structs ───────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComposioConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Composio API key (env: COMPOSIO_API_KEY).
    pub api_key: Option<String>,
    /// Allowlist of Composio action names the gateway may execute.
    #[serde(default)]
    pub actions: Vec<String>,
    /// Maximum agentic loop rounds before returning the last response. Default: 3.
    #[serde(default = "default_composio_max_rounds")]
    pub max_rounds: u8,
    /// Per-user entity ID that scopes connected accounts in Composio.
    ///
    /// Composio's entity model: each call to `/actions/{name}/execute` must
    /// carry an `entityId` that identifies the connected-account owner. The
    /// default value `"default"` is Composio's built-in fallback entity and
    /// works for single-user / test setups. In multi-user deployments, the
    /// gateway receives the caller identity in the `x-ryu-user-id` header
    /// (forwarded by Core) and passes it here so each user's OAuth-connected
    /// account is selected correctly. Override the startup default via the
    /// `COMPOSIO_ENTITY_ID` env var; at runtime the pipeline will prefer
    /// `RequestContext::user_id` when present (see pipeline/mod.rs).
    #[serde(default = "default_composio_entity_id")]
    pub entity_id: String,
}

fn default_composio_max_rounds() -> u8 {
    3
}

fn default_composio_entity_id() -> String {
    "default".to_string()
}

impl Default for ComposioConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key: None,
            actions: Vec::new(),
            max_rounds: default_composio_max_rounds(),
            entity_id: default_composio_entity_id(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct TregConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_treg_base_url")]
    pub base_url: String,
    /// Runtime-only secret, supplied by the environment or provider vault.
    #[serde(skip)]
    pub token: Option<String>,
}

fn default_treg_base_url() -> String {
    "https://treg.to".to_owned()
}

impl Default for TregConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_treg_base_url(),
            token: None,
        }
    }
}

impl std::fmt::Debug for TregConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TregConfig")
            .field("enabled", &self.enabled)
            .field("base_url", &self.base_url)
            .field(
                "token",
                &self.token.as_ref().map(|_| "<set>").unwrap_or("<unset>"),
            )
            .finish()
    }
}

// `SemanticCacheConfig` + `CacheConfig` moved to the extracted `ryu-gw-cache`
// stage crate (co-located with the backends they configure) and are re-exported
// from the top of this module.

// ─── Original Phase-1 config structs ─────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CircuitBreakerConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Number of consecutive failures before the circuit opens. Default: 5.
    #[serde(default = "default_failure_threshold")]
    pub failure_threshold: u32,
    /// Seconds to wait in the Open state before trying again. Default: 30.
    #[serde(default = "default_reset_timeout")]
    pub reset_timeout_secs: u64,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            failure_threshold: default_failure_threshold(),
            reset_timeout_secs: default_reset_timeout(),
        }
    }
}

fn default_failure_threshold() -> u32 {
    5
}
fn default_reset_timeout() -> u64 {
    30
}

/// Concurrency admission control for a scarce resident resource — the **local**
/// inference engine (one llama.cpp/ollama/… server, a fixed number of batch
/// slots). Unlike the rate limiter (per-key cost/abuse) and circuit breaker
/// (per-provider failure), this is per-provider *concurrency* with priority:
/// it admits at most `local_max_in_flight` requests to the local provider at
/// once (match the engine's `--parallel` slot count so every slot is busy and
/// llama-server's internal FIFO stays empty), queues the rest up to
/// `local_max_queued`, and serves **interactive** waiters ahead of **background**
/// fan-out (delegate / threads / scheduler / monitors). Remote providers are not
/// gated (they scale elastically). Lives in the Gateway because it governs a
/// *shared* resource (§ Core-vs-Gateway rule). Takes effect on the next restart.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConcurrencyConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Max concurrent in-flight requests to the local provider. Should match the
    /// engine's slot count (`--parallel`). Default 4 (mirrors Core's mid-tier
    /// `default_parallel_slots`). `0` disables gating (treated as unlimited).
    #[serde(default = "default_local_max_in_flight")]
    pub local_max_in_flight: u32,
    /// Max requests allowed to wait for a slot before new ones are rejected with
    /// `engine_overloaded` (503). Bounds memory/latency under a flood. Default 64.
    #[serde(default = "default_local_max_queued")]
    pub local_max_queued: u32,
}

impl Default for ConcurrencyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            local_max_in_flight: default_local_max_in_flight(),
            local_max_queued: default_local_max_queued(),
        }
    }
}

fn default_local_max_in_flight() -> u32 {
    4
}
fn default_local_max_queued() -> u32 {
    64
}

/// Node-level lifecycle and resource controls for ACP subprocess sessions.
///
/// `max_parallel_agents = None` is the safe default: Core derives a conservative
/// limit from the node's CPU and RAM instead of making every machine use the same
/// arbitrary number. The setting is intentionally Gateway-owned so it applies to
/// every ACP agent on the node, including agents that do not expose plugins.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AcpConfig {
    /// Tear down a pooled ACP subprocess after this many inactive minutes. The
    /// next message lazily starts a fresh subprocess and may take longer.
    #[serde(default = "default_acp_idle_timeout_minutes")]
    pub idle_timeout_minutes: u32,
    /// Maximum number of ACP subprocesses that may be running at once. `None`
    /// delegates to Core's conservative hardware-based calculation.
    #[serde(default)]
    pub max_parallel_agents: Option<u32>,
    /// Keep the local computer awake while at least one ACP agent is active.
    #[serde(default = "default_true")]
    pub keep_computer_awake: bool,
}

impl Default for AcpConfig {
    fn default() -> Self {
        Self {
            idle_timeout_minutes: default_acp_idle_timeout_minutes(),
            max_parallel_agents: None,
            keep_computer_awake: true,
        }
    }
}

impl AcpConfig {
    /// Validate values at the write boundary so a malformed persisted setting can
    /// never become an unbounded or effectively-disabled process policy.
    pub fn validate(&self) -> Result<(), String> {
        if !(ACP_IDLE_TIMEOUT_MIN_MINUTES..=ACP_IDLE_TIMEOUT_MAX_MINUTES)
            .contains(&self.idle_timeout_minutes)
        {
            return Err(format!(
                "acp.idle_timeout_minutes must be between {ACP_IDLE_TIMEOUT_MIN_MINUTES} and {ACP_IDLE_TIMEOUT_MAX_MINUTES}"
            ));
        }
        if let Some(max) = self.max_parallel_agents {
            if !(ACP_MAX_PARALLEL_MIN..=ACP_MAX_PARALLEL_MAX).contains(&max) {
                return Err(format!(
                    "acp.max_parallel_agents must be between {ACP_MAX_PARALLEL_MIN} and {ACP_MAX_PARALLEL_MAX}, or null for Auto"
                ));
            }
        }
        Ok(())
    }
}

pub const ACP_IDLE_TIMEOUT_MIN_MINUTES: u32 = 1;
pub const ACP_IDLE_TIMEOUT_MAX_MINUTES: u32 = 24 * 60;
pub const ACP_MAX_PARALLEL_MIN: u32 = 1;
pub const ACP_MAX_PARALLEL_MAX: u32 = 32;

fn default_acp_idle_timeout_minutes() -> u32 {
    10
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SkillsConfig {
    #[serde(default)]
    pub skills: Vec<crate::skills::Skill>,
}

/// Node-level policy for the personalized Marketplace "For you" feed.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct MarketplaceRecommendationsConfig {
    /// Whether Core may fetch catalog references or invoke the model adapter.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// How often an automatically refreshed recommendation cache may regenerate.
    #[serde(default)]
    pub cadence: MarketplaceRecommendationsCadence,
}

/// Permission policy for computer-use providers attached to this node.
///
/// `locked_use` is deliberately opt-in. A true value grants the node's
/// computer-use provider permission to request a locked-session execution path;
/// it does not itself unlock the operating system or bypass its safety prompts.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ComputerUseConfig {
    #[serde(default)]
    pub locked_use: bool,
}

impl Default for ComputerUseConfig {
    fn default() -> Self {
        Self { locked_use: false }
    }
}

impl Default for MarketplaceRecommendationsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            cadence: MarketplaceRecommendationsCadence::default(),
        }
    }
}

/// The intentionally closed refresh cadence accepted by Gateway config.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MarketplaceRecommendationsCadence {
    Daily,
    Weekly,
    Monthly,
}

impl Default for MarketplaceRecommendationsCadence {
    fn default() -> Self {
        Self::Weekly
    }
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            bind: default_bind(),
            providers: ProvidersConfig::default(),
            routing: RoutingConfig::default(),
            // Nothing derived until `load()` runs: a default config is the "we could
            // not read the file" fallback, and it has no env overlay applied yet.
            seeded_classify_model: None,
            env_injected_classify_provider: false,
            file_classify_provider: None,
            firewall: FirewallConfig::default(),
            prompt_cache: PromptCacheConfig::default(),
            node_routing: NodeRoutingConfig::default(),
            custom_evaluators: Vec::new(),
            firewall_org_overlays: HashMap::new(),
            firewall_agent_overlays: HashMap::new(),
            rate_limit: RateLimitConfig::default(),
            auth: AuthConfig::default(),
            cache: CacheConfig::default(),
            circuit_breaker: CircuitBreakerConfig::default(),
            concurrency: ConcurrencyConfig::default(),
            acp: AcpConfig::default(),
            computer_use: ComputerUseConfig::default(),
            skills: SkillsConfig::default(),
            marketplace_recommendations: MarketplaceRecommendationsConfig::default(),
            audit: AuditConfig::default(),
            evals: EvalsConfig::default(),
            composio: ComposioConfig::default(),
            treg: TregConfig::default(),
            semantic_cache: SemanticCacheConfig::default(),
            budgets: BudgetConfig::default(),
            channels: ChannelsConfig::default(),
            control_plane: ControlPlaneConfig::default(),
            exec_budget: ExecBudgetConfig::default(),
            compression: CompressionConfig::default(),
            backends: StageBackendsConfig::default(),
            pipeline: crate::pipeline::stages::PipelineOrderConfig::default(),
            tools: ToolsConfig::default(),
            widget: WidgetConfig::default(),
            credits: CreditsConfig::default(),
            fleet: false,
        }
    }
}

/// Test-only isolation for the process-global `GATEWAY_CONFIG` variable.
///
/// [`GatewayConfig::config_path`] falls back to the machine's REAL
/// `<config>/ryu/gateway.toml` when the var is unset, so any test that reaches
/// `load()` / `save()` / `config_path()` — directly or through a handler like
/// `api::config::get_config` — otherwise reads (or writes!) developer state and
/// becomes host-dependent. Every such test takes this guard.
///
/// `pub(crate)` and mutex-backed on purpose: the whole crate's unit tests share one
/// process, so `api::config`'s tests and `config`'s tests would race each other over
/// this one variable if each rolled its own window. One lock, one owner at a time.
#[cfg(test)]
pub(crate) mod test_config_path {
    /// RAII window in which `GATEWAY_CONFIG` points at a private temp file.
    ///
    /// Restores the prior value and deletes the temp directory on drop, so a panicking
    /// test cannot leak the variable pointing at a directory that no longer exists —
    /// which would silently redirect every later test in the binary.
    pub(crate) struct ConfigPathGuard {
        dir: std::path::PathBuf,
        path: std::path::PathBuf,
        prior: Option<std::ffi::OsString>,
        /// Declared LAST so field-drop order releases the lock only after the
        /// variable is restored and the directory is gone.
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl ConfigPathGuard {
        /// Point `GATEWAY_CONFIG` at `gateway.toml` in a fresh, uniquely named temp
        /// directory. `tag` only makes the path readable while debugging; uniqueness
        /// comes from the pid plus a monotonic counter, so repeated guards in one run
        /// never collide (nor with a parallel `cargo test` of another crate).
        pub(crate) fn isolated(tag: &str) -> Self {
            static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
            static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            // A poisoned lock means an earlier guarded test panicked; the env was
            // still restored by its `Drop`, so the window is safe to re-enter.
            let lock = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("ryu-gwcfg-{tag}-{}-{seq}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("temp gateway config dir");
            let path = dir.join("gateway.toml");
            let prior = std::env::var_os("GATEWAY_CONFIG");
            std::env::set_var("GATEWAY_CONFIG", &path);
            Self {
                dir,
                path,
                prior,
                _lock: lock,
            }
        }

        /// The `gateway.toml` the window points at. It does not exist until something
        /// writes it, which is the "fresh node" case.
        pub(crate) fn path(&self) -> &std::path::Path {
            &self.path
        }
    }

    impl Drop for ConfigPathGuard {
        fn drop(&mut self) {
            match self.prior.take() {
                Some(prior) => std::env::set_var("GATEWAY_CONFIG", prior),
                None => std::env::remove_var("GATEWAY_CONFIG"),
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

#[cfg(test)]
mod marketplace_recommendations_config_tests {
    use super::{GatewayConfig, MarketplaceRecommendationsCadence};

    #[test]
    fn defaults_and_toml_round_trip_preserve_weekly_policy() {
        let mut config = GatewayConfig::default();
        assert!(config.marketplace_recommendations.enabled);
        assert_eq!(
            config.marketplace_recommendations.cadence,
            MarketplaceRecommendationsCadence::Weekly
        );

        config.marketplace_recommendations.cadence = MarketplaceRecommendationsCadence::Monthly;
        let encoded = toml::to_string(&config).expect("serialize gateway config");
        let decoded: GatewayConfig = toml::from_str(&encoded).expect("deserialize gateway config");
        assert_eq!(
            decoded.marketplace_recommendations,
            config.marketplace_recommendations
        );
    }

    #[test]
    fn cadence_accepts_only_daily_weekly_or_monthly() {
        for cadence in ["daily", "weekly", "monthly"] {
            let value = format!("cadence = \"{cadence}\"");
            toml::from_str::<super::MarketplaceRecommendationsConfig>(&value)
                .expect("supported cadence");
        }
        assert!(
            toml::from_str::<super::MarketplaceRecommendationsConfig>("cadence = \"hourly\"")
                .is_err()
        );
    }
}

#[cfg(test)]
mod computer_use_config_tests {
    use super::{ComputerUseConfig, GatewayConfig};

    #[test]
    fn locked_use_defaults_off_and_round_trips() {
        let mut config = GatewayConfig::default();
        assert!(!config.computer_use.locked_use);

        config.computer_use = ComputerUseConfig { locked_use: true };
        let encoded = toml::to_string(&config).expect("serialize gateway config");
        let decoded: GatewayConfig = toml::from_str(&encoded).expect("deserialize gateway config");
        assert!(decoded.computer_use.locked_use);
    }

    #[test]
    fn missing_computer_use_section_keeps_locked_use_disabled() {
        let decoded: GatewayConfig = toml::from_str("[auth]\nrequire_auth = false\n")
            .expect("partial gateway config parses");
        assert!(!decoded.computer_use.locked_use);
    }
}

#[cfg(test)]
mod local_embed_endpoint_tests {
    use super::{local_embed_base_url, DEFAULT_EMBED_PORT};

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvVar {
        name: &'static str,
        prior: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvVar {
        fn set(name: &'static str, value: &str) -> Self {
            let lock = ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let prior = std::env::var_os(name);
            std::env::set_var(name, value);
            Self {
                name,
                prior,
                _lock: lock,
            }
        }
        fn cleared(name: &'static str) -> Self {
            let lock = ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let prior = std::env::var_os(name);
            std::env::remove_var(name);
            Self {
                name,
                prior,
                _lock: lock,
            }
        }
    }
    impl Drop for EnvVar {
        fn drop(&mut self) {
            match self.prior.take() {
                Some(prior) => std::env::set_var(self.name, prior),
                None => std::env::remove_var(self.name),
            }
        }
    }

    /// The default must be the PROFILE-ADJUSTED embed port, not a bare 8081. A dev
    /// gateway that dials the release sidecar embeds against whatever model the
    /// other profile happens to be serving, which is a silently wrong vector rather
    /// than an error.
    #[test]
    fn defaults_to_the_profile_adjusted_embed_port() {
        let _env = EnvVar::cleared("RYU_EMBED_LLM_URL");
        let expected = format!(
            "http://127.0.0.1:{}/v1",
            crate::profile::port(DEFAULT_EMBED_PORT)
        );
        assert_eq!(local_embed_base_url(), expected);
    }

    /// `RYU_EMBED_LLM_URL` wins, mirroring `RYU_CLASSIFY_LLM_URL` for the classify
    /// tier — that is how a Core-spawned gateway is repointed.
    #[test]
    fn env_override_wins() {
        let _env = EnvVar::set("RYU_EMBED_LLM_URL", "http://10.0.0.4:9999/v1");
        assert_eq!(local_embed_base_url(), "http://10.0.0.4:9999/v1");
    }

    /// A blank or whitespace-only override is not an endpoint. Treating it as one
    /// would send every embed call to the empty string and fail every request,
    /// where falling back to the local sidecar still works.
    #[test]
    fn blank_override_falls_back_to_the_local_sidecar() {
        let _env = EnvVar::set("RYU_EMBED_LLM_URL", "   ");
        let expected = format!(
            "http://127.0.0.1:{}/v1",
            crate::profile::port(DEFAULT_EMBED_PORT)
        );
        assert_eq!(local_embed_base_url(), expected);
    }
}

#[cfg(test)]
mod admin_key_env_tests {
    use super::test_config_path::ConfigPathGuard;
    use super::GatewayConfig;

    /// Restore one env var on drop, so a panicking test cannot leak it into the
    /// rest of the binary. The `ConfigPathGuard` the caller also holds serializes
    /// these windows against each other.
    struct EnvVar(&'static str, Option<std::ffi::OsString>);
    impl EnvVar {
        fn set(name: &'static str, value: &str) -> Self {
            let prior = std::env::var_os(name);
            std::env::set_var(name, value);
            Self(name, prior)
        }
        fn cleared(name: &'static str) -> Self {
            let prior = std::env::var_os(name);
            std::env::remove_var(name);
            Self(name, prior)
        }
    }
    impl Drop for EnvVar {
        fn drop(&mut self) {
            match self.1.take() {
                Some(prior) => std::env::set_var(self.0, prior),
                None => std::env::remove_var(self.0),
            }
        }
    }

    /// The whole point of `GATEWAY_ADMIN_KEY`: provision the admin credential
    /// WITHOUT turning on base auth.
    ///
    /// If this ever starts flipping `require_auth`, every ordinary call Core and
    /// its sidecars make without a bearer (chat, media, titles, widgets, …) starts
    /// answering 401 — which is exactly why Core could not just use
    /// `GATEWAY_MASTER_KEY` for this.
    #[test]
    fn admin_key_sets_master_key_without_enabling_require_auth() {
        let _path = ConfigPathGuard::isolated("admin-key");
        let _master = EnvVar::cleared("GATEWAY_MASTER_KEY");
        let _admin = EnvVar::set("GATEWAY_ADMIN_KEY", "gwadm_test");

        let cfg = GatewayConfig::load().expect("gateway config loads");
        assert_eq!(cfg.auth.master_key.as_deref(), Some("gwadm_test"));
        assert!(
            !cfg.auth.require_auth,
            "GATEWAY_ADMIN_KEY must not turn on base auth"
        );
    }

    /// An operator's explicit master key outranks the one Core mints for itself —
    /// and keeps its `require_auth` semantics.
    #[test]
    fn explicit_master_key_outranks_admin_key() {
        let _path = ConfigPathGuard::isolated("admin-key-precedence");
        let _master = EnvVar::set("GATEWAY_MASTER_KEY", "operator-key");
        let _admin = EnvVar::set("GATEWAY_ADMIN_KEY", "gwadm_test");

        let cfg = GatewayConfig::load().expect("gateway config loads");
        assert_eq!(cfg.auth.master_key.as_deref(), Some("operator-key"));
        assert!(cfg.auth.require_auth);
    }

    /// Blank is not a credential. An empty value must leave the admin surface on
    /// its previous behaviour rather than provisioning an unusable empty key that
    /// would neutralize loopback trust and lock everyone out.
    #[test]
    fn blank_admin_key_is_ignored() {
        let _path = ConfigPathGuard::isolated("admin-key-blank");
        let _master = EnvVar::cleared("GATEWAY_MASTER_KEY");
        let _admin = EnvVar::set("GATEWAY_ADMIN_KEY", "   ");

        let cfg = GatewayConfig::load().expect("gateway config loads");
        assert_eq!(cfg.auth.master_key, None);
        assert!(!cfg.auth.require_auth);
    }
}

#[cfg(test)]
mod prompt_cache_config_tests {
    use super::{GatewayConfig, PromptCacheConfig};
    use ryu_gw_providers::PromptCacheMode;

    #[test]
    fn default_is_off_so_an_existing_config_bills_the_same() {
        let cfg = PromptCacheConfig::default();
        assert_eq!(cfg.mode, "off");
        assert_eq!(cfg.options().mode, PromptCacheMode::Off);
        assert!(!cfg.session_affinity);
        assert!(cfg.allow_request_override);
        // A gateway.toml with no [prompt_cache] table deserializes to the same.
        assert_eq!(GatewayConfig::default().prompt_cache, cfg);
    }

    #[test]
    fn a_missing_table_deserializes_to_the_off_default() {
        let cfg: PromptCacheConfig =
            serde_json::from_value(serde_json::json!({})).expect("all fields default");
        assert_eq!(cfg, PromptCacheConfig::default());
    }

    #[test]
    fn options_map_every_knob_through() {
        let cfg = PromptCacheConfig {
            mode: "explicit".into(),
            ttl: " 1h ".into(),
            min_prefix_tokens: 4096,
            breakpoints: 4,
            session_affinity: true,
            allow_request_override: false,
        };
        let o = cfg.options();
        assert_eq!(o.mode, PromptCacheMode::Explicit);
        assert_eq!(o.ttl.as_deref(), Some("1h"), "ttl is trimmed");
        assert_eq!(o.min_prefix_tokens, 4096);
        assert_eq!(o.breakpoints, 4);
        assert!(o.session_affinity);
    }

    #[test]
    fn an_unparseable_mode_falls_back_to_off_not_on() {
        // A typo must never silently start billing cache writes.
        let cfg = PromptCacheConfig {
            mode: "atuo".into(),
            ..Default::default()
        };
        assert_eq!(cfg.options().mode, PromptCacheMode::Off);
    }

    #[test]
    fn an_empty_ttl_means_the_provider_default() {
        let cfg = PromptCacheConfig {
            mode: "auto".into(),
            ttl: "   ".into(),
            ..Default::default()
        };
        assert_eq!(cfg.options().ttl, None);
    }

    #[test]
    fn an_unsupported_ttl_degrades_instead_of_being_forwarded() {
        // `10m` is not a documented value: forwarding it would be rejected
        // upstream mid-request, and on the Anthropic path it would also trigger
        // the extended-TTL beta header. Degrade to the provider default.
        for bad in ["10m", "forever", "3600"] {
            let cfg = PromptCacheConfig {
                mode: "auto".into(),
                ttl: bad.into(),
                ..Default::default()
            };
            assert_eq!(cfg.options().ttl, None, "{bad}");
        }
        // Case-insensitive on the values that ARE supported.
        let cfg = PromptCacheConfig {
            mode: "auto".into(),
            ttl: " 1H ".into(),
            ..Default::default()
        };
        assert_eq!(cfg.options().ttl.as_deref(), Some("1h"));
    }
}

#[cfg(test)]
mod provider_id_tests {
    use super::{ProviderId, ProviderKind, RoutingConfig};

    /// Provider routing is keyed by open registry-id strings: an existing config
    /// naming one of the nine legacy providers deserializes byte-identically, AND
    /// a brand-new id (`"acme"`) that no enum variant covers survives round-trip
    /// through every routing field — including the `provider_tiers` map KEY, the
    /// one spot where a non-transparent newtype Deserialize would silently drop it.
    #[test]
    fn legacy_and_novel_provider_ids_roundtrip_via_serde() {
        let json = serde_json::json!({
            "default_provider": "acme",
            "fallback_chain": ["openai", "acme"],
            "provider_tiers": { "openai": 0, "acme": 2 },
            "model_map": { "my-model": { "provider": "acme" } }
        });

        let routing: RoutingConfig = serde_json::from_value(json)
            .expect("routing config with a novel provider id must parse");

        // Legacy name lowers to the same string it always was (back-compat).
        assert_eq!(routing.default_provider, ProviderId::from("acme"));
        assert_eq!(routing.fallback_chain[0], ProviderKind::OpenAi); // "openai" legacy id
        assert_eq!(routing.fallback_chain[1], ProviderId::from("acme"));

        // The map KEY is the serde trap — both legacy and novel keys must survive.
        assert_eq!(
            routing.provider_tiers.get(&ProviderId::from("openai")),
            Some(&0)
        );
        assert_eq!(
            routing.provider_tiers.get(&ProviderId::from("acme")),
            Some(&2)
        );

        assert_eq!(
            routing.model_map.get("my-model").unwrap().provider,
            ProviderId::from("acme")
        );

        // And it serializes back out as a bare string (no enum-shaped wrapper),
        // so the wire stays identical to the pre-open-id format.
        let back = serde_json::to_value(&routing).expect("serialize");
        assert_eq!(back["default_provider"], "acme");
        assert_eq!(back["fallback_chain"][0], "openai");
    }

    /// The empty/zero-config case keeps `default_provider = "openai"`, exactly as
    /// the former `ProviderKind::default() == OpenAi` produced.
    #[test]
    fn default_provider_id_is_openai() {
        assert_eq!(ProviderId::default(), ProviderKind::OpenAi);
        assert_eq!(
            RoutingConfig::default().default_provider,
            ProviderKind::OpenAi
        );
    }
}

#[cfg(test)]
mod capacity_config_tests {
    use super::{ControlPlaneConfig, ModelPrice, OpenAiProviderConfig};
    use std::collections::HashMap;

    #[test]
    fn all_keys_falls_back_to_single_key() {
        let c = OpenAiProviderConfig {
            api_key: "sk-primary".into(),
            api_keys: vec![],
            base_url: super::openai_base_url(),
        };
        assert_eq!(c.all_keys(), vec!["sk-primary".to_string()]);
    }

    #[test]
    fn all_keys_merges_and_dedupes() {
        let c = OpenAiProviderConfig {
            api_key: "sk-a".into(),
            api_keys: vec!["sk-b".into(), "sk-a".into(), "".into()],
            base_url: super::openai_base_url(),
        };
        // Primary first, extras appended, dupes + blanks dropped.
        assert_eq!(c.all_keys(), vec!["sk-a".to_string(), "sk-b".to_string()]);
    }

    #[test]
    fn cost_for_uses_flat_rate_without_a_price_table() {
        let cp = ControlPlaneConfig::default(); // 2000 micro-USD / 1k combined
                                                // 500 in + 500 out = 1000 tokens ⇒ 2000 micro-USD.
        assert_eq!(cp.cost_for("gpt-4o", 500, 500), 2000);
    }

    #[test]
    fn cost_for_prefers_per_model_prefix_pricing() {
        let mut pricing = HashMap::new();
        pricing.insert(
            "claude-sonnet".to_string(),
            ModelPrice {
                input_per_1k_micro_usd: 3000,
                output_per_1k_micro_usd: 15000,
            },
        );
        let cp = ControlPlaneConfig {
            model_pricing: pricing,
            ..Default::default()
        };
        // Longest-prefix match on the versioned id: 1k in (3000) + 1k out (15000).
        assert_eq!(cp.cost_for("claude-sonnet-4-5-20250929", 1000, 1000), 18000);
        // An unpriced model falls back to the flat 2000/1k rate.
        assert_eq!(cp.cost_for("gpt-4o", 1000, 0), 2000);
    }
}

#[cfg(test)]
mod credits_config_tests {
    use super::{
        CreditsConfig, GpuKind, Modality, OsKind, ProviderBillingPolicy, ProviderId,
        WalletEmptyAction,
    };

    #[test]
    fn debit_amount_passthrough_at_zero_bps() {
        let c = CreditsConfig::default();
        assert_eq!(c.markup_bps, 0);
        // bps=0 ⇒ identity.
        assert_eq!(c.debit_amount(0), 0);
        assert_eq!(c.debit_amount(1), 1);
        assert_eq!(c.debit_amount(1_000_000), 1_000_000);
    }

    #[test]
    fn debit_amount_applies_markup_round_half_up() {
        let c = CreditsConfig {
            markup_bps: 2000, // +20%
            ..Default::default()
        };
        // 1000 * 12000 / 10000 = 1200 exactly.
        assert_eq!(c.debit_amount(1000), 1200);
        // 1 * 12000 / 10000 = 1.2 → round-half-up → 1.
        assert_eq!(c.debit_amount(1), 1);
        // 5 * 12000 = 60000, +5000 = 65000, /10000 = 6 (was 6.0).
        assert_eq!(c.debit_amount(5), 6);
    }

    #[test]
    fn debit_amount_rounds_half_up_at_boundary() {
        // 50 bps markup: 100 * 10050 = 1_005_000, +5000 = 1_010_000, /10000 = 101.
        let c = CreditsConfig {
            markup_bps: 50,
            ..Default::default()
        };
        assert_eq!(c.debit_amount(100), 101);
    }

    #[test]
    fn undo_debit_amount_inverts_the_markup_without_overshooting() {
        // Sizes a spend ceiling, so it must never return a raw cost whose DEBIT
        // exceeds the budget it was derived from — that would hand out a ceiling
        // the charge then breaks through, which is the overdraft it exists to
        // prevent. Round DOWN, and verify the round trip stays inside.
        let c = CreditsConfig {
            markup_bps: 10_000, // +100%: charged = 2x raw
            ..Default::default()
        };
        assert_eq!(c.undo_debit_amount(50_000), 25_000);
        assert!(c.debit_amount(c.undo_debit_amount(50_000)) <= 50_000);

        // Pass-through at zero bps.
        let free = CreditsConfig::default();
        assert_eq!(free.markup_bps, 0);
        assert_eq!(free.undo_debit_amount(1_234), 1_234);

        // Odd rates must still not overshoot after the round trip.
        let odd = CreditsConfig {
            markup_bps: 333,
            ..Default::default()
        };
        for budget in [1_u64, 7, 99, 1000, 999_999] {
            assert!(
                odd.debit_amount(odd.undo_debit_amount(budget)) <= budget,
                "round trip overshot the budget at {budget}"
            );
        }
    }

    #[test]
    fn is_active_requires_enabled_url_and_secret() {
        let base = CreditsConfig {
            enabled: true,
            internal_secret: Some("s".to_string()),
            ..Default::default()
        };
        assert!(base.is_active());

        let no_secret = CreditsConfig {
            internal_secret: None,
            ..base.clone()
        };
        assert!(!no_secret.is_active());

        let disabled = CreditsConfig {
            enabled: false,
            ..base.clone()
        };
        assert!(!disabled.is_active());

        let no_url = CreditsConfig {
            base_url: "  ".to_string(),
            ..base
        };
        assert!(!no_url.is_active());
    }

    #[test]
    fn wallet_empty_action_defaults_to_stop() {
        assert_eq!(WalletEmptyAction::default(), WalletEmptyAction::Stop);
    }

    #[test]
    fn reservation_defaults_survive_a_partial_credits_table() {
        // THE DRIFT THIS CATCHES: `Default for CreditsConfig` and the serde
        // `default = "…"` fns are two separate declarations of the same number.
        // If they disagree, an ABSENT `[credits]` table and a PRESENT one that
        // omits these keys behave differently — and for `reserve_enabled` that
        // difference is "concurrent requests are bounded" vs "they are not".
        let absent: crate::GatewayConfig = toml::from_str("").expect("empty config parses");
        assert!(absent.credits.reserve_enabled);
        assert_eq!(absent.credits.min_reserve_micro_usd, 10_000);

        let partial: crate::GatewayConfig = toml::from_str(
            r#"
[credits]
enabled = true
"#,
        )
        .expect("partial credits table parses");
        assert!(
            partial.credits.reserve_enabled,
            "omitting the key must not silently disable the reservation"
        );
        assert_eq!(partial.credits.min_reserve_micro_usd, 10_000);
        assert_eq!(
            partial.credits.reserve_enabled,
            CreditsConfig::default().reserve_enabled
        );
        assert_eq!(
            partial.credits.min_reserve_micro_usd,
            CreditsConfig::default().min_reserve_micro_usd
        );
    }

    #[test]
    fn provider_billing_policy_round_trips_from_gateway_config() {
        let config: crate::GatewayConfig = toml::from_str(
            r#"
[credits]
[credits.provider_billing.whatsapp]
mode = "pass_through"

[credits.provider_billing.openrouter]
mode = "pass_through"
"#,
        )
        .expect("provider pass-through config parses");

        let encoded = serde_json::to_value(config.credits).expect("credits serialize");
        assert_eq!(
            encoded["provider_billing"]["whatsapp"]["mode"],
            "pass_through"
        );
        assert_eq!(
            encoded["provider_billing"]["openrouter"]["mode"],
            "pass_through"
        );
    }

    #[test]
    fn provider_pass_through_bypasses_global_markup_only_for_that_provider() {
        let config = CreditsConfig {
            markup_bps: 2000,
            provider_billing: [(
                ProviderId::from("WhatsApp"),
                ProviderBillingPolicy {
                    mode: super::ProviderBillingMode::PassThrough,
                },
            )]
            .into_iter()
            .collect(),
            ..Default::default()
        };

        assert_eq!(
            config.debit_amount_for_provider(Some("whatsapp"), 1000),
            1000
        );
        assert_eq!(
            config.debit_amount_for_provider(Some("openrouter"), 1000),
            1200
        );
        assert_eq!(config.debit_amount_for_provider(None, 1000), 1200);
        assert_eq!(
            config.undo_debit_amount_for_provider(Some("WHATSAPP"), 1000),
            1000
        );
        assert_eq!(
            config.undo_debit_amount_for_provider(Some("openrouter"), 1200),
            1000
        );
    }

    #[test]
    fn the_tool_call_rate_defaults_to_composios_cost() {
        // AT COST. Composio's standard rate is $0.30/1k executions, so the
        // default is 300 micro-USD per call and the customer pays exactly what we pay.
        // Margin is the deposit fee, never a per-unit markup.
        assert_eq!(CreditsConfig::default().cost_per_tool_call_micro_usd, 300);
        assert_eq!(CreditsConfig::default().markup_bps, 0);
    }

    #[test]
    fn the_boot_gate_passes_on_the_default_rates() {
        // The boot failure the gate was cut back to avoid — a node refusing to
        // start until someone invented numbers — cannot happen now that every
        // gated rate carries a real default. Nothing set, credits on, boots.
        let c = CreditsConfig {
            enabled: true,
            ..Default::default()
        };
        assert!(c.validate_metered_rates().is_ok());
    }

    #[test]
    fn zeroing_tts_or_stt_fails_the_boot_gate() {
        // TTS and STT are served synchronously and have NO second cost source, so
        // a flat rate of 0 there is not an unreached fallback — it is the only
        // number the debit will ever see, and `if cost > 0` then skips it. An
        // explicit 0 is a deliberate give-away and must be stated as one via
        // GATEWAY_CREDITS_ALLOW_FREE_MODALITIES, not left in a blank.
        let tts = CreditsConfig {
            enabled: true,
            cost_per_tts_micro_usd: 0,
            ..Default::default()
        };
        assert!(tts.validate_metered_rates().is_err());

        let stt = CreditsConfig {
            enabled: true,
            cost_per_stt_micro_usd: 0,
            ..Default::default()
        };
        assert!(stt.validate_metered_rates().is_err());
    }

    #[test]
    fn zeroing_any_media_fallback_fails_the_boot_gate() {
        for (name, field) in [
            ("image", Modality::Image),
            ("video", Modality::Video),
            ("tts", Modality::Tts),
            ("stt", Modality::Stt),
        ] {
            let mut c = CreditsConfig {
                enabled: true,
                ..Default::default()
            };
            match field {
                Modality::Image => c.cost_per_image_micro_usd = 0,
                Modality::Video => c.cost_per_video_micro_usd = 0,
                Modality::Tts => c.cost_per_tts_micro_usd = 0,
                Modality::Stt => c.cost_per_stt_micro_usd = 0,
                Modality::Chat => unreachable!("chat has no media fallback"),
            }
            assert!(
                c.validate_metered_rates().is_err(),
                "zero {name} fallback must fail the billing startup gate"
            );
        }
    }

    #[test]
    fn zeroing_the_tool_rate_still_fails_the_boot_gate() {
        let c = CreditsConfig {
            enabled: true,
            cost_per_tool_call_micro_usd: 0,
            ..Default::default()
        };
        assert!(c.validate_metered_rates().is_err());
    }

    #[test]
    fn tool_call_cost_is_flat_per_call_and_saturates() {
        let c = CreditsConfig {
            cost_per_tool_call_micro_usd: 500,
            ..Default::default()
        };
        assert_eq!(c.tool_call_cost_micro_usd(0), 0);
        assert_eq!(c.tool_call_cost_micro_usd(3), 1500);
        // Saturating on overflow rather than wrapping.
        assert_eq!(c.tool_call_cost_micro_usd(u64::MAX), u64::MAX);
    }

    #[test]
    fn media_is_priced_from_the_compute_time_the_provider_reported() {
        // THE POINT OF THE WHOLE CHANGE. A flat per-call rate charges a 2s image
        // and a 60s video the same; this bills what the transaction actually
        // consumed.
        let c = CreditsConfig {
            cost_per_gpu_second_micro_usd: 1000,
            cost_per_image_micro_usd: 40_000,
            ..Default::default()
        };
        let response = serde_json::json!({ "usage": { "compute_seconds": 2.5 } });
        let (cost, estimated) = c.media_cost_from_response(&Modality::Image, &response);
        assert_eq!(cost, 2500);
        assert!(!estimated);
    }

    #[test]
    fn media_prefers_provider_reported_cost_including_openrouter_raw_payload() {
        let c = CreditsConfig {
            cost_per_gpu_second_micro_usd: 1000,
            cost_per_image_micro_usd: 40_000,
            ..Default::default()
        };
        let response = serde_json::json!({
            "data": [{ "url": "data:image/png;base64,AAA" }],
            "raw": { "usage": { "cost": 0.012345 }, "choices": [] }
        });
        let (cost, estimated) = c.media_cost_from_response(&Modality::Image, &response);
        assert_eq!(cost, 12_345);
        assert!(!estimated);
    }

    #[test]
    fn a_partial_gpu_second_rounds_up_rather_than_leaking() {
        let c = CreditsConfig {
            cost_per_gpu_second_micro_usd: 1000,
            ..Default::default()
        };
        let response = serde_json::json!({ "usage": { "compute_seconds": 0.0011 } });
        let (cost, _) = c.media_cost_from_response(&Modality::Image, &response);
        assert_eq!(cost, 2);
    }

    #[test]
    fn a_response_with_no_usage_falls_back_and_is_marked_estimated() {
        // The flag is what lets a later reconciliation tell a guess from a
        // measurement; without it the two rows are identical.
        let c = CreditsConfig {
            cost_per_gpu_second_micro_usd: 1000,
            cost_per_video_micro_usd: 90_000,
            ..Default::default()
        };
        let (cost, estimated) =
            c.media_cost_from_response(&Modality::Video, &serde_json::json!({ "data": [] }));
        assert_eq!(cost, 90_000);
        assert!(estimated);
    }

    #[test]
    fn tts_and_stt_flat_rates_are_not_marked_as_estimated() {
        let c = CreditsConfig::default();
        for modality in [Modality::Tts, Modality::Stt] {
            let (cost, estimated) = c.media_cost_from_response(&modality, &serde_json::json!({}));
            assert!(cost > 0);
            assert!(!estimated, "{modality:?} flat rate is its configured price");
        }
    }

    #[test]
    fn an_async_video_job_bills_from_the_provider_payload_not_the_flat_rate() {
        // REGRESSION. The async video-job debit (submit + poll, in
        // `pipeline::mod`) called the flat `media_cost_micro_usd` directly and
        // then guarded on `if cost > 0`. `cost_per_video_micro_usd` defaults to
        // 0, so under a default config every completed async video job billed
        // NOTHING — while the startup gate had stopped guarding the video rate
        // precisely because video was believed to be metered from provider cost.
        // That belief was true of the synchronous path only.
        //
        // The payload shape here is the one those call sites now pass:
        // `MediaJob::to_response()` flattens the provider's output, so
        // `usage.compute_seconds` sits at the top level next to `data`.
        let c = CreditsConfig {
            cost_per_gpu_second_micro_usd: 975,
            // Explicitly zeroed — the shape that was silent back when 0 was also
            // the default for this field.
            cost_per_video_micro_usd: 0,
            ..Default::default()
        };
        let flattened_job_response = serde_json::json!({
            "id": "vid_1",
            "status": "succeeded",
            "data": [{ "url": "https://example.invalid/v.mp4" }],
            "usage": { "compute_seconds": 12.0 },
        });
        let (cost, estimated) =
            c.media_cost_from_response(&Modality::Video, &flattened_job_response);
        assert_eq!(cost, 11_700, "12s x $0.000975/s");
        assert!(!estimated);
        // And the property that actually failed: a real charge, not zero.
        assert!(cost > 0, "an async video job must never bill nothing");
    }

    #[test]
    fn the_gpu_second_rate_defaults_to_replicates_published_l40s_price() {
        // $0.000975/sec. A real published figure, not an invented one.
        assert_eq!(CreditsConfig::default().cost_per_gpu_second_micro_usd, 975);
    }

    #[test]
    fn media_cost_is_per_modality_and_chat_is_never_metered() {
        let c = CreditsConfig {
            cost_per_image_micro_usd: 10,
            cost_per_video_micro_usd: 20,
            cost_per_tts_micro_usd: 3,
            cost_per_stt_micro_usd: 4,
            ..Default::default()
        };
        assert_eq!(c.media_cost_micro_usd(&Modality::Image), 10);
        assert_eq!(c.media_cost_micro_usd(&Modality::Video), 20);
        assert_eq!(c.media_cost_micro_usd(&Modality::Tts), 3);
        assert_eq!(c.media_cost_micro_usd(&Modality::Stt), 4);
        // Chat is billed on real token usage, never on a flat media rate.
        assert_eq!(c.media_cost_micro_usd(&Modality::Chat), 0);
    }

    #[test]
    fn gpu_rate_nano_maps_each_tier_and_none_is_free() {
        let c = CreditsConfig::default();
        assert_eq!(c.gpu_rate_nano(GpuKind::None), 0);
        assert_eq!(c.gpu_rate_nano(GpuKind::H200), 1_261_000);
        assert_eq!(c.gpu_rate_nano(GpuKind::H100), 1_097_000);
        assert_eq!(c.gpu_rate_nano(GpuKind::RtxPro6000), 842_000);
        assert_eq!(c.gpu_rate_nano(GpuKind::Rtx5090), 358_000);
        assert_eq!(c.gpu_rate_nano(GpuKind::Rtx4090), 275_000);
    }

    #[test]
    fn sandbox_tick_sums_cpu_mem_storage_above_free_tier() {
        let c = CreditsConfig::default();
        // 2 vcpu (14000) + 4 GiB mem (4500) + (10-5)=5 billable storage GiB (30),
        // Linux, no GPU, 1 second:
        //   2*14000 + 4*4500 + 5*30 = 28000 + 18000 + 150 = 46150 nano/sec.
        //   (46150 + 500) / 1000 = 46 micro (round-half-up).
        assert_eq!(
            c.sandbox_tick_cost_raw_micro(2, 4, 10, GpuKind::None, 0, OsKind::Linux, 1),
            46
        );
    }

    #[test]
    fn sandbox_tick_bills_no_storage_within_the_free_tier() {
        let c = CreditsConfig::default();
        // 5 GiB storage == the free tier ⇒ zero storage cost. Only 1 vcpu counts.
        //   1*14000 = 14000 nano ⇒ (14000+500)/1000 = 14 micro.
        assert_eq!(
            c.sandbox_tick_cost_raw_micro(1, 0, 5, GpuKind::None, 0, OsKind::Linux, 1),
            14
        );
    }

    #[test]
    fn sandbox_tick_bills_a_zero_count_gpu_as_one() {
        let c = CreditsConfig::default();
        // A non-None GPU tier with gpu_count=0 still bills as 1 GPU (the invariant
        // in the doc comment): 1 vcpu (14000) + 1 * H200 (1_261_000) = 1_275_000 nano
        //   ⇒ (1_275_000 + 500)/1000 = 1275 micro.
        assert_eq!(
            c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::H200, 0, OsKind::Linux, 1),
            1275
        );
    }

    #[test]
    fn sandbox_tick_adds_windows_vcpu_surcharge() {
        let c = CreditsConfig::default();
        // Windows adds a per-vcpu surcharge (23800 nano/vcpu-sec) on top of the base
        // vcpu rate: 1*14000 + 1*23800 = 37800 ⇒ (37800+500)/1000 = 38 micro.
        assert_eq!(
            c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Windows, 1),
            38
        );
        // Linux has no such surcharge — same shape costs less.
        assert_eq!(
            c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, 1),
            14
        );
    }

    #[test]
    fn sandbox_tick_scales_with_seconds() {
        let c = CreditsConfig::default();
        let one = c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, 1);
        let ten = c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, 10);
        // 10 seconds ⇒ 10x the per-second nano before the single micro conversion:
        //   14000*10 = 140000 ⇒ (140000+500)/1000 = 140 micro (== 10 * 14).
        assert_eq!(one, 14);
        assert_eq!(ten, 140);
    }

    #[test]
    fn sandbox_debit_applies_its_own_markup_not_the_global_one() {
        // sandbox_markup_bps defaults to 3000 (× 1.30), distinct from markup_bps (0).
        let c = CreditsConfig::default();
        assert_eq!(c.sandbox_markup_bps, 3000);
        // 100 * 13000 = 1_300_000, +5000 = 1_305_000, /10000 = 130.
        assert_eq!(c.sandbox_debit_amount(100), 130);
        // The at-cost path (debit_amount, markup_bps=0) leaves 100 untouched — proof
        // the two ledgers use different markups.
        assert_eq!(c.debit_amount(100), 100);
    }
}

#[cfg(test)]
mod alert_tier_backcompat_tests {
    use super::{AlertTier, BudgetRule, FirewallConfig, SessionBudgetConfig};

    /// An old gateway.toml with no `alert` field must still parse, defaulting the
    /// tier to `Silent` (so no policy alert fires until an operator opts in).
    #[test]
    fn budget_rule_without_alert_parses_to_silent() {
        let rule: BudgetRule =
            toml::from_str("limit = 1000\naction = \"stop\"\n").expect("legacy rule must parse");
        assert_eq!(rule.alert, AlertTier::Silent);
    }

    #[test]
    fn session_budget_without_alert_parses_to_silent() {
        let cfg: SessionBudgetConfig =
            toml::from_str("limit = 500\n").expect("legacy session budget must parse");
        assert_eq!(cfg.alert, AlertTier::Silent);
    }

    #[test]
    fn firewall_without_alert_parses_to_silent() {
        let cfg: FirewallConfig = toml::from_str("enabled = true\npolicy = \"block\"\n")
            .expect("legacy firewall must parse");
        assert_eq!(cfg.alert, AlertTier::Silent);
    }

    /// The tier ordering is load-bearing (Core takes the max), so pin it.
    #[test]
    fn alert_tier_orders_ascending() {
        assert!(AlertTier::Silent < AlertTier::Warn);
        assert!(AlertTier::Warn < AlertTier::Fanout);
        assert!(AlertTier::Fanout < AlertTier::Email);
    }

    /// The tier serde renames to lowercase (the wire value on the debit payload
    /// and the PolicyAlert JSON).
    #[test]
    fn alert_tier_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&AlertTier::Fanout).unwrap(),
            "\"fanout\""
        );
    }
}

#[cfg(test)]
mod pure_helper_tests {
    use super::{
        parse_bool_env, FirewallPolicy, Modality, ModelRouterType, ProviderId, ProviderKind,
        RouteStrategy, SmartRoutingConfig, SmartRule, StagePicker,
    };
    use std::str::FromStr;

    #[test]
    fn provider_kind_as_str_covers_every_variant() {
        assert_eq!(ProviderKind::OpenAi.as_str(), "openai");
        assert_eq!(ProviderKind::Anthropic.as_str(), "anthropic");
        assert_eq!(ProviderKind::Local.as_str(), "local");
        assert_eq!(ProviderKind::OpenRouter.as_str(), "openrouter");
        assert_eq!(ProviderKind::Core.as_str(), "core");
        assert_eq!(ProviderKind::Modal.as_str(), "modal");
        assert_eq!(ProviderKind::GenAi.as_str(), "genai");
        assert_eq!(ProviderKind::Replicate.as_str(), "replicate");
        assert_eq!(ProviderKind::Fal.as_str(), "fal");
    }

    #[test]
    fn provider_kind_from_str_roundtrips_and_is_case_insensitive() {
        for kind in [
            ProviderKind::OpenAi,
            ProviderKind::Anthropic,
            ProviderKind::Local,
            ProviderKind::OpenRouter,
            ProviderKind::Core,
            ProviderKind::Modal,
            ProviderKind::GenAi,
            ProviderKind::Replicate,
            ProviderKind::Fal,
        ] {
            assert_eq!(ProviderKind::from_str(kind.as_str()).unwrap(), kind);
        }
        // Case-insensitive.
        assert_eq!(
            ProviderKind::from_str("OpenAI").unwrap(),
            ProviderKind::OpenAi
        );
        // Unknown ids are a typed error naming the bad value.
        let err = ProviderKind::from_str("acme").unwrap_err();
        assert!(err.contains("acme"));
    }

    #[test]
    fn provider_id_display_default_and_as_str() {
        assert_eq!(ProviderId::default().as_str(), "openai");
        let id = ProviderId::from("acme");
        assert_eq!(id.as_str(), "acme");
        assert_eq!(id.to_string(), "acme");
    }

    #[test]
    fn modality_as_str_covers_every_variant() {
        assert_eq!(Modality::Chat.as_str(), "chat");
        assert_eq!(Modality::Image.as_str(), "image");
        assert_eq!(Modality::Tts.as_str(), "tts");
        assert_eq!(Modality::Stt.as_str(), "stt");
        assert_eq!(Modality::Video.as_str(), "video");
    }

    #[test]
    fn smart_routing_is_active_gates_on_enabled_rules_and_strategy() {
        let rule = SmartRule {
            description: "code".to_string(),
            model: "claude".to_string(),
            weight: 1.0,
        };

        // Disabled ⇒ inert regardless of rules.
        let mut cfg = SmartRoutingConfig {
            enabled: false,
            rules: vec![rule.clone()],
            classifier_model: "gemma".to_string(),
            ..Default::default()
        };
        assert!(!cfg.is_active());

        // Enabled but no rules ⇒ inert.
        cfg.enabled = true;
        cfg.rules = vec![];
        assert!(!cfg.is_active());

        // Llm strategy needs a non-empty classifier model.
        cfg.rules = vec![rule.clone()];
        cfg.strategy = RouteStrategy::Llm;
        cfg.classifier_model = "  ".to_string();
        assert!(!cfg.is_active(), "blank classifier ⇒ Llm inert");
        cfg.classifier_model = "gemma".to_string();
        assert!(cfg.is_active());

        // Keyword / Embedding only need rules (no classifier).
        cfg.classifier_model = String::new();
        cfg.strategy = RouteStrategy::Keyword;
        assert!(cfg.is_active());
        cfg.strategy = RouteStrategy::Embedding;
        assert!(cfg.is_active());
    }

    #[test]
    fn switchyard_router_types_are_active_only_with_their_required_targets() {
        let mut cfg = SmartRoutingConfig {
            enabled: true,
            router_type: ModelRouterType::Random,
            rules: vec![
                SmartRule {
                    description: String::new(),
                    model: "strong".into(),
                    weight: 1.0,
                },
                SmartRule {
                    description: String::new(),
                    model: "weak".into(),
                    weight: 3.0,
                },
            ],
            ..Default::default()
        };
        assert!(cfg.is_active());

        cfg.rules.pop();
        assert!(!cfg.is_active());
        cfg.rules.push(SmartRule {
            description: String::new(),
            model: "weak".into(),
            weight: 3.0,
        });
        assert!(cfg.is_active());

        cfg.router_type = ModelRouterType::Passthrough;
        assert!(cfg.is_active());

        cfg.router_type = ModelRouterType::StageRouter;
        cfg.stage_capable_model = "strong".into();
        cfg.stage_efficient_model = "weak".into();
        cfg.stage_picker = StagePicker::EfficientFirst;
        assert!(cfg.is_active());

        cfg.router_type = ModelRouterType::Escalation;
        cfg.escalation_weak_model = "weak".into();
        cfg.escalation_strong_model = "strong".into();
        cfg.escalation_judge_model = "judge".into();
        assert!(cfg.is_active());

        cfg.escalation_judge_model.clear();
        assert!(!cfg.is_active());
    }

    #[test]
    fn old_smart_routing_json_defaults_to_llm_classifier_and_unit_weights() {
        let cfg: SmartRoutingConfig = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "strategy": "keyword",
            "rules": [{"description": "code", "model": "strong"}]
        }))
        .expect("legacy smart routing JSON must parse");
        assert_eq!(cfg.router_type, ModelRouterType::LlmClassifier);
        assert_eq!(cfg.rules[0].weight, 1.0);
        assert_eq!(cfg.stage_picker, StagePicker::CapableFirst);
    }

    /// REGRESSION: a per-agent smart-routing override saved with the classifier
    /// box left empty used to save as "on" and be inert — and worse than inert,
    /// because `pipeline::apply_smart_routing` treats a per-agent override as
    /// present the moment the agent has one, takes its early return, and skips
    /// the GLOBAL smart router that would otherwise have run. Turning the feature
    /// on actively DISABLED routing.
    ///
    /// This must go through serde, not field assignment. The sibling test above
    /// sets `classifier_model` in Rust, which bypasses `de_classifier_model`
    /// entirely — it would keep passing after the fix while proving nothing about
    /// any wire path, the same structural blindness the credits round-trip test
    /// has. The desktop editor and `PUT /v1/config` both send an explicit `""`.
    #[test]
    fn smart_routing_saved_with_a_blank_classifier_deserializes_to_a_working_one() {
        // The wire shape an operator produces by clearing the model box.
        let from_wire: SmartRoutingConfig = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "strategy": "llm",
            "classifier_model": "",
            "rules": [{ "description": "code", "model": "claude" }],
        }))
        .expect("an explicit empty classifier must still parse");
        assert!(
            !from_wire.classifier_model.trim().is_empty(),
            "a blank classifier must resolve to the classify tier, not stay blank"
        );
        assert_eq!(from_wire.classifier_model, super::classify_model_id());
        assert!(
            from_wire.is_active(),
            "enabled + rules must mean routing actually runs"
        );

        // An ABSENT key takes the same value — the `default = \"fn\"` half of the
        // pair. One without the other leaves half the hole open.
        let absent: SmartRoutingConfig = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "rules": [{ "description": "code", "model": "claude" }],
        }))
        .expect("an absent classifier must parse");
        assert_eq!(absent.classifier_model, from_wire.classifier_model);

        // And `Default` agrees, so a config built in Rust cannot drift from one
        // read off the wire.
        assert_eq!(
            SmartRoutingConfig::default().classifier_model,
            from_wire.classifier_model
        );

        // An operator's own pick is still honored untouched.
        let explicit: SmartRoutingConfig = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "classifier_model": "openrouter/google/gemini-2.5-flash",
            "rules": [{ "description": "code", "model": "claude" }],
        }))
        .expect("parses");
        assert_eq!(
            explicit.classifier_model,
            "openrouter/google/gemini-2.5-flash"
        );
    }

    #[test]
    fn firewall_policy_from_env_accepts_aliases_and_rejects_junk() {
        assert_eq!(
            FirewallPolicy::from_env("block"),
            Some(FirewallPolicy::Block)
        );
        assert_eq!(
            FirewallPolicy::from_env(" WARN "),
            Some(FirewallPolicy::WarnAndContinue)
        );
        assert_eq!(
            FirewallPolicy::from_env("warn-and-continue"),
            Some(FirewallPolicy::WarnAndContinue)
        );
        assert_eq!(
            FirewallPolicy::from_env("redact"),
            Some(FirewallPolicy::Sanitize)
        );
        assert_eq!(FirewallPolicy::from_env("nonsense"), None);
    }

    #[test]
    fn parse_bool_env_accepts_truthy_falsey_and_rejects_junk() {
        for t in ["1", "true", "YES", "on"] {
            assert_eq!(parse_bool_env(t), Some(true), "{t}");
        }
        for f in ["0", "false", "No", "off"] {
            assert_eq!(parse_bool_env(f), Some(false), "{f}");
        }
        assert_eq!(parse_bool_env("maybe"), None);
    }
}

#[cfg(test)]
mod reaction_learning_config_tests {
    use super::{CommonChannelFileConfig, TelegramChannelConfig, TelegramChannelOptionsFileConfig};

    #[test]
    fn telegram_channel_toml_round_trip_preserves_reaction_learning() {
        let mut common = CommonChannelFileConfig::default();
        common.reaction_learning.enabled = true;
        common.reaction_learning.positive_emojis = vec!["👍".to_owned(), "❤️".to_owned()];
        common.reaction_learning.negative_emojis = vec!["👎".to_owned(), "💀".to_owned()];
        common.reaction_learning.allow_group = true;

        let authored = TelegramChannelConfig {
            token: "[REDACTED_SECRET]".to_owned(),
            common,
            options: TelegramChannelOptionsFileConfig::default(),
        };
        let text = toml::to_string(&authored).expect("reaction config should serialize");
        let parsed: TelegramChannelConfig =
            toml::from_str(&text).expect("reaction config should parse after serialization");

        assert!(parsed.common.reaction_learning.enabled);
        assert_eq!(
            parsed.common.reaction_learning.positive_emojis,
            vec!["👍", "❤️"]
        );
        assert_eq!(
            parsed.common.reaction_learning.negative_emojis,
            vec!["👎", "💀"]
        );
        assert!(parsed.common.reaction_learning.allow_group);
    }

    #[test]
    fn telegram_channel_toml_accepts_issue_style_reaction_keys() {
        let parsed: TelegramChannelConfig = toml::from_str(
            r#"
token = "[REDACTED_SECRET]"

[reaction_learning]
enabled = true
positive_emoji = ["👍", "🎉"]
negative_emoji = ["👎", "😴"]
allow_group = false
"#,
        )
        .expect("issue-style reaction settings should parse");

        assert!(parsed.common.reaction_learning.enabled);
        assert_eq!(
            parsed.common.reaction_learning.positive_emojis,
            vec!["👍", "🎉"]
        );
        assert_eq!(
            parsed.common.reaction_learning.negative_emojis,
            vec!["👎", "😴"]
        );
        assert!(!parsed.common.reaction_learning.allow_group);
    }
}

#[cfg(test)]
mod channel_config_tests {
    use super::*;

    /// The shared knobs are `#[serde(flatten)]`-ed, so an EXISTING `gateway.toml`
    /// — which spells `model`/`agent_id`/`core_url` directly under the channel
    /// table — must still parse, and every key it does not mention must land on
    /// the documented default. This is the whole backwards-compatibility contract
    /// for the config file.
    #[test]
    fn legacy_channel_table_still_parses_with_defaults() {
        let cfg: TelegramChannelConfig = toml::from_str(
            r#"
            token = "123:ABC"
            model = "gpt-4o-mini"
            agent_id = "acp:pi"
            core_url = "http://127.0.0.1:9999"
            group_reply_mode = "all"
            "#,
        )
        .expect("a pre-existing telegram table must still parse");

        assert_eq!(cfg.token, "123:ABC");
        assert_eq!(cfg.common.model, "gpt-4o-mini");
        assert_eq!(cfg.common.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(cfg.common.core_url, "http://127.0.0.1:9999");
        assert_eq!(cfg.common.group_reply_mode, GroupReplyMode::All);

        // Unmentioned knobs default: nothing is silently switched off, and the
        // access policy stays unset so the legacy env allowlist keeps deciding.
        assert!(cfg.common.typing_indicator);
        assert!(cfg.common.publish_commands);
        assert!(cfg.common.rich_text);
        assert!(!cfg.common.streaming);
        assert_eq!(cfg.common.voice_reply, VoiceReplyMode::Never);
        assert!(cfg.common.dm_policy.is_none());
        assert!(cfg.common.group_policy.is_none());
        assert!(cfg.common.dm_allowlist.is_empty());
        assert!(cfg.common.profile_name.is_none());
    }

    /// The new knobs are read from the same flat namespace as the old ones.
    #[test]
    fn new_channel_knobs_parse_from_the_channel_table() {
        let cfg: DiscordChannelConfig = toml::from_str(
            r#"
            token = "bot-token"
            channel_ids = ["c1", "c2"]
            thread_replies = true
            dm_policy = "open"
            group_policy = "disabled"
            dm_allowlist = ["u1"]
            typing_indicator = false
            publish_commands = false
            rich_text = false
            streaming = true
            voice_reply = "always"
            profile_name = "Ryu"
            profile_short_bio = "your agent"
            "#,
        )
        .expect("the new knobs must parse");

        assert!(cfg.thread_replies);
        assert_eq!(cfg.common.dm_policy, Some(DmPolicy::Open));
        assert_eq!(cfg.common.group_policy, Some(GroupPolicy::Disabled));
        assert_eq!(cfg.common.dm_allowlist, vec!["u1".to_string()]);
        assert!(!cfg.common.typing_indicator);
        assert!(!cfg.common.publish_commands);
        assert!(!cfg.common.rich_text);
        assert!(cfg.common.streaming);
        assert_eq!(cfg.common.voice_reply, VoiceReplyMode::Always);
        assert_eq!(cfg.common.profile_name.as_deref(), Some("Ryu"));
    }

    /// BlueBubbles needs only the bridge's URL + password; the rest defaults, and
    /// the Private-API-only verbs stay off until the operator says the helper is
    /// installed.
    #[test]
    fn bluebubbles_defaults_are_conservative() {
        let cfg: BlueBubblesChannelConfig = toml::from_str(
            r#"
            server_url = "http://192.168.1.10:1234"
            password = "hunter2"
            "#,
        )
        .expect("minimal bluebubbles table must parse");

        assert_eq!(cfg.webhook_bind, default_bluebubbles_bind());
        assert_eq!(cfg.webhook_path, "/webhooks/bluebubbles");
        assert!(!cfg.private_api);
        assert!(!cfg.send_read_receipts);
        assert_eq!(cfg.common.model, default_channel_model());
    }

    /// WhatsApp's own read receipts default ON — the bot is about to reply, so
    /// withholding the blue tick only makes it look unresponsive.
    #[test]
    fn whatsapp_read_receipts_default_on() {
        let cfg: WhatsAppChannelConfig = toml::from_str(
            r#"
            access_token = "tok"
            phone_number_id = "123"
            verify_token = "verify"
            "#,
        )
        .expect("minimal whatsapp table must parse");
        assert!(cfg.send_read_receipts);
        assert_eq!(cfg.graph_version, default_whatsapp_graph_version());
    }

    /// A populated channel table must survive `save()` → `load()`. Flattened
    /// structs are the shape TOML is fussiest about (a nested table after a
    /// value is a hard error), so this is the guard that the flatten is safe.
    #[test]
    fn populated_channels_survive_a_toml_roundtrip() {
        let mut cfg = GatewayConfig::default();
        cfg.channels.telegram = Some(TelegramChannelConfig {
            token: "123:ABC".to_string(),
            common: CommonChannelFileConfig {
                agent_id: Some("acp:pi".to_string()),
                system_prompt: Some("be terse".to_string()),
                dm_policy: Some(DmPolicy::Allowlist),
                dm_allowlist: vec!["u1".to_string()],
                streaming: true,
                voice_reply: VoiceReplyMode::Mirror,
                profile_name: Some("Ryu".to_string()),
                ..CommonChannelFileConfig::default()
            },
            options: TelegramChannelOptionsFileConfig::default(),
        });
        cfg.channels.bluebubbles = Some(BlueBubblesChannelConfig {
            server_url: "http://mac:1234".to_string(),
            password: "pw".to_string(),
            webhook_bind: default_bluebubbles_bind(),
            webhook_path: default_bluebubbles_path(),
            private_api: true,
            send_read_receipts: true,
            mention_patterns: Vec::new(),
            home_channel: None,
            common: CommonChannelFileConfig::default(),
        });

        let text = toml::to_string_pretty(&cfg).expect("serialize channels");
        let back: GatewayConfig = toml::from_str(&text).expect("re-parse channels");

        let telegram = back.channels.telegram.expect("telegram survives");
        assert_eq!(telegram.token, "123:ABC");
        assert_eq!(telegram.common.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(telegram.common.dm_policy, Some(DmPolicy::Allowlist));
        assert_eq!(telegram.common.dm_allowlist, vec!["u1".to_string()]);
        assert!(telegram.common.streaming);
        assert_eq!(telegram.common.voice_reply, VoiceReplyMode::Mirror);
        assert_eq!(telegram.common.profile_name.as_deref(), Some("Ryu"));

        let bb = back.channels.bluebubbles.expect("bluebubbles survives");
        assert_eq!(bb.server_url, "http://mac:1234");
        assert!(bb.private_api);
    }

    /// Env parsing of the new knobs. One sequential test because it mutates
    /// process-global env; parallel sub-tests would race.
    #[test]
    fn channel_env_reads_the_new_knobs() {
        for key in [
            "TESTCHAN_DM_POLICY",
            "TESTCHAN_GROUP_POLICY",
            "TESTCHAN_VOICE_REPLY",
            "TESTCHAN_TYPING_INDICATOR",
            "TESTCHAN_STREAMING",
            "TESTCHAN_DM_ALLOWLIST",
            "TESTCHAN_BOT_NAME",
            "TESTCHAN_MODEL",
            "TESTCHAN_PROACTIVE_OPENING",
            "TESTCHAN_PROACTIVE_TARGET",
        ] {
            std::env::remove_var(key);
        }

        // Nothing set ⇒ the config-file values (here, the defaults) survive.
        let bare = common_channel_from_env("TESTCHAN", None);
        assert_eq!(bare.model, default_channel_model());
        assert!(bare.dm_policy.is_none());
        assert!(bare.typing_indicator);
        assert_eq!(bare.voice_reply, VoiceReplyMode::Never);

        std::env::set_var("TESTCHAN_DM_POLICY", "OPEN");
        std::env::set_var("TESTCHAN_GROUP_POLICY", "open");
        std::env::set_var("TESTCHAN_VOICE_REPLY", "mirror");
        std::env::set_var("TESTCHAN_TYPING_INDICATOR", "false");
        std::env::set_var("TESTCHAN_STREAMING", "1");
        std::env::set_var("TESTCHAN_DM_ALLOWLIST", "u1, u2 ,");
        std::env::set_var("TESTCHAN_BOT_NAME", "Ryu");
        std::env::set_var("TESTCHAN_PROACTIVE_OPENING", "true");
        std::env::set_var("TESTCHAN_PROACTIVE_TARGET", "chat-1");
        // Blank is treated as unset, not as an empty model.
        std::env::set_var("TESTCHAN_MODEL", "   ");

        let loaded = common_channel_from_env("TESTCHAN", None);
        assert_eq!(loaded.dm_policy, Some(DmPolicy::Open));
        assert_eq!(loaded.group_policy, Some(GroupPolicy::Open));
        assert_eq!(loaded.voice_reply, VoiceReplyMode::Mirror);
        assert!(!loaded.typing_indicator);
        assert!(loaded.streaming);
        assert_eq!(
            loaded.dm_allowlist,
            vec!["u1".to_string(), "u2".to_string()]
        );
        assert_eq!(loaded.profile_name.as_deref(), Some("Ryu"));
        assert_eq!(loaded.model, default_channel_model());
        assert!(loaded.proactive_opening);
        assert_eq!(loaded.proactive_target.as_deref(), Some("chat-1"));

        // An unrecognised value is ignored rather than guessed at, so the
        // config-file value keeps winning.
        std::env::set_var("TESTCHAN_DM_POLICY", "sometimes");
        let existing = CommonChannelFileConfig {
            dm_policy: Some(DmPolicy::Disabled),
            ..CommonChannelFileConfig::default()
        };
        let layered = common_channel_from_env("TESTCHAN", Some(&existing));
        assert_eq!(layered.dm_policy, Some(DmPolicy::Disabled));

        for key in [
            "TESTCHAN_DM_POLICY",
            "TESTCHAN_GROUP_POLICY",
            "TESTCHAN_VOICE_REPLY",
            "TESTCHAN_TYPING_INDICATOR",
            "TESTCHAN_STREAMING",
            "TESTCHAN_DM_ALLOWLIST",
            "TESTCHAN_BOT_NAME",
            "TESTCHAN_MODEL",
            "TESTCHAN_PROACTIVE_OPENING",
            "TESTCHAN_PROACTIVE_TARGET",
        ] {
            std::env::remove_var(key);
        }
    }
}

#[cfg(test)]
mod toml_roundtrip_tests {
    use super::*;

    /// The default config must survive a TOML serialize → deserialize round-trip
    /// unchanged. This is the exact `save()` → `load()` path (minus disk) and
    /// exercises the Serialize/Deserialize derives across every nested config
    /// struct, guarding against a `#[serde(default)]`/rename drift that would make
    /// a written config fail to re-parse.
    #[test]
    fn default_config_survives_toml_roundtrip() {
        let cfg = GatewayConfig::default();
        let text = toml::to_string_pretty(&cfg).expect("serialize default config");
        let back: GatewayConfig = toml::from_str(&text).expect("re-parse default config");
        // Spot-check load-bearing fields across several sub-configs.
        assert_eq!(back.bind, cfg.bind);
        assert_eq!(back.routing.default_provider, cfg.routing.default_provider);
        assert_eq!(back.firewall.policy, cfg.firewall.policy);
        assert_eq!(back.cache.enabled, cfg.cache.enabled);
        assert_eq!(
            back.circuit_breaker.failure_threshold,
            cfg.circuit_breaker.failure_threshold
        );
        assert_eq!(
            back.control_plane.cost_per_1k_micro_usd,
            cfg.control_plane.cost_per_1k_micro_usd
        );
        assert_eq!(
            back.credits.sandbox_markup_bps,
            cfg.credits.sandbox_markup_bps
        );
        assert_eq!(back.fleet, cfg.fleet);
    }

    /// The `[credits]` table the PUBLISHED self-host doc hands operators
    /// (`apps/fumadocs/content/docs/gateway/configuration.mdx`, "## Credits") must
    /// deserialize the nine sandbox rates to their documented non-zero defaults.
    ///
    /// ## Why the round-trip test above cannot catch this
    ///
    /// [`default_config_survives_toml_roundtrip`] serializes
    /// `GatewayConfig::default()` first, and `toml::to_string_pretty` EMITS every
    /// non-skipped field — including all nine rates, already at their default
    /// values. The re-parse therefore reads a `[credits]` table in which each key
    /// is *present*, so serde never runs the absent-key branch. A round-trip test
    /// is structurally blind to a wrong `#[serde(default)]`: it can only prove
    /// that a value serde WROTE survives being read back. Only a hand-authored
    /// TOML that OMITS the keys exercises the default path, which is why the
    /// fixture below is pasted from the docs verbatim rather than generated.
    ///
    /// ## Why a zero here is not "free"
    ///
    /// Zeroed rates do not make sandboxes cheap, they turn sandbox billing off and
    /// remove a safety stop: `sandbox_tick_cost_raw_micro` → 0 ⇒
    /// `sandbox_debit_amount` → 0 ⇒ `debit_sandbox_sync` short-circuits on
    /// `billed_micro == 0` and returns `None` ⇒ `compute_verdict` (api/sandbox.rs)
    /// sees `balance: None`, so `KillBalance` is unreachable and `accrued` never
    /// grows past a `per_run_budget`, so `KillBudget` is unreachable too.
    ///
    /// An ABSENT `[credits]` table was never affected (it takes
    /// `impl Default for CreditsConfig` wholesale) — which is exactly why this
    /// needs its own fixture with the table present.
    #[test]
    fn published_credits_doc_toml_keeps_the_documented_sandbox_rates() {
        // Verbatim from docs/gateway/configuration.mdx ("## Credits"). A present
        // `[credits]` table that names no sandbox rate.
        let doc_toml = r#"
[credits]
enabled = false
base_url = "http://127.0.0.1:3000/api"  # defaults to control_plane.base_url
internal_secret = "..."                 # also RYU_CREDITS_INTERNAL_SECRET
markup_bps = 0                          # platform markup in basis points (0 = pass-through)
wallet_empty_action = "stop"            # "stop" | "downgrade"
wallet_empty_downgrade_to = ""
reserve_enabled = true                  # hold an estimate against the balance while a request runs
min_reserve_micro_usd = 10000           # $0.01 floor per request; bounds concurrent burst
timeout_ms = 3000
"#;

        let parsed: GatewayConfig =
            toml::from_str(doc_toml).expect("the documented [credits] table parses");
        let credits = &parsed.credits;
        let want = CreditsConfig::default();

        // The keys the doc DOES set are honored (proves the table was really read
        // and the assertions below are not passing on an ignored fragment).
        assert!(!credits.enabled);
        assert_eq!(credits.timeout_ms, 3000);

        // The nine rates the doc does NOT set fall back to the documented values,
        // not to 0.
        assert_eq!(
            credits.cost_per_sandbox_vcpu_second_nano_usd,
            want.cost_per_sandbox_vcpu_second_nano_usd
        );
        assert_eq!(
            credits.cost_per_sandbox_mem_gib_second_nano_usd,
            want.cost_per_sandbox_mem_gib_second_nano_usd
        );
        assert_eq!(
            credits.cost_per_sandbox_storage_gib_second_nano_usd,
            want.cost_per_sandbox_storage_gib_second_nano_usd
        );
        assert_eq!(
            credits.cost_per_sandbox_gpu_h200_second_nano_usd,
            want.cost_per_sandbox_gpu_h200_second_nano_usd
        );
        assert_eq!(
            credits.cost_per_sandbox_gpu_h100_second_nano_usd,
            want.cost_per_sandbox_gpu_h100_second_nano_usd
        );
        assert_eq!(
            credits.cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd,
            want.cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd
        );
        assert_eq!(
            credits.cost_per_sandbox_gpu_rtx_5090_second_nano_usd,
            want.cost_per_sandbox_gpu_rtx_5090_second_nano_usd
        );
        assert_eq!(
            credits.cost_per_sandbox_gpu_rtx_4090_second_nano_usd,
            want.cost_per_sandbox_gpu_rtx_4090_second_nano_usd
        );
        assert_eq!(
            credits.cost_per_sandbox_windows_vcpu_second_nano_usd,
            want.cost_per_sandbox_windows_vcpu_second_nano_usd
        );
        // The two siblings that already had `default = "fn"` — asserted here so
        // the fixture covers the whole rate block, not just the repaired nine.
        assert_eq!(
            credits.sandbox_free_storage_gib,
            want.sandbox_free_storage_gib
        );
        assert_eq!(credits.sandbox_markup_bps, want.sandbox_markup_bps);

        // The rates the doc omits are non-zero, so a tick costs something and the
        // wallet path stays reachable. Pinned against the documented values rather
        // than only `!= 0` so a future "default" of 1 nano-USD is caught too.
        assert_eq!(credits.cost_per_sandbox_vcpu_second_nano_usd, 14_000);
        assert_eq!(credits.cost_per_sandbox_gpu_h200_second_nano_usd, 1_261_000);
    }

    /// The same fixture, for the four MEDIA rates — the second half of the bug
    /// the sandbox test above covers, and the one that already reached production.
    ///
    /// `cost_per_image/video/tts/stt_micro_usd` were bare `#[serde(default)]`, so
    /// the published `[credits]` table below — present, partial, naming none of
    /// them — deserialized all four to 0. The media debit is guarded by
    /// `if cost > 0`, so a 0 rate does not bill a little, it SKIPS THE DEBIT, and
    /// the provider invoices us anyway. That exact shape shipped once already as
    /// the async video job (see
    /// `an_async_video_job_bills_from_the_provider_payload_not_the_flat_rate`).
    ///
    /// ## Why the round-trip test cannot catch this
    ///
    /// Same structural reason spelled out on
    /// [`published_credits_doc_toml_keeps_the_documented_sandbox_rates`]:
    /// `default_config_survives_toml_roundtrip` serializes a fully-populated
    /// `GatewayConfig::default()` first, and `toml::to_string_pretty` EMITS every
    /// non-skipped field — so the re-parse reads all four keys as *present* and
    /// serde never runs the absent-key branch. A round-trip can only prove that a
    /// value serde wrote survives being read back; it is blind to a wrong
    /// `#[serde(default)]` by construction. Only a hand-authored TOML that OMITS
    /// the keys exercises the default path, which is why this fixture is pasted
    /// from the docs verbatim rather than generated.
    #[test]
    fn published_credits_doc_toml_keeps_nonzero_media_rates() {
        // Verbatim from docs/gateway/configuration.mdx ("## Credits"), the block
        // an operator self-hosting a metered gateway copies.
        let doc_toml = r#"
[credits]
enabled = false
base_url = "http://127.0.0.1:3000/api"  # defaults to control_plane.base_url
internal_secret = "..."                 # also RYU_CREDITS_INTERNAL_SECRET
markup_bps = 0                          # platform markup in basis points (0 = pass-through)
wallet_empty_action = "stop"            # "stop" | "downgrade"
wallet_empty_downgrade_to = ""
timeout_ms = 3000
"#;

        let credits = toml::from_str::<GatewayConfig>(doc_toml)
            .expect("the documented [credits] table parses")
            .credits;
        let want = CreditsConfig::default();

        // The keys the doc DOES set are honored, so the assertions below are not
        // passing on a fragment serde quietly ignored.
        assert!(!credits.enabled);
        assert_eq!(credits.timeout_ms, 3000);

        // Both halves, deliberately: `want` alone would still pass if the serde
        // attribute and `impl Default` were BOTH left at 0, and the literal alone
        // would not catch the two drifting apart.
        assert_eq!(
            credits.cost_per_image_micro_usd,
            want.cost_per_image_micro_usd
        );
        assert_eq!(
            credits.cost_per_video_micro_usd,
            want.cost_per_video_micro_usd
        );
        assert_eq!(credits.cost_per_tts_micro_usd, want.cost_per_tts_micro_usd);
        assert_eq!(credits.cost_per_stt_micro_usd, want.cost_per_stt_micro_usd);

        // Pinned against the derivation written on the accessor fns — each is a
        // nominal job duration times Replicate's published L40S GPU-second
        // ($0.000975/sec) — so a future "default" of 1 micro-USD is caught too.
        assert_eq!(credits.cost_per_image_micro_usd, 1_950, "2s x $0.000975/s");
        assert_eq!(
            credits.cost_per_video_micro_usd, 58_500,
            "60s x $0.000975/s"
        );
        assert_eq!(credits.cost_per_tts_micro_usd, 975, "1s x $0.000975/s");
        assert_eq!(credits.cost_per_stt_micro_usd, 975, "1s x $0.000975/s");

        // THE PROPERTY THAT ACTUALLY FAILED. Stated on its own so it survives any
        // later re-derivation of the numbers above: none of these may be 0, or
        // the `if cost > 0` debit guard silently gives the modality away.
        for (name, rate) in [
            ("image", credits.cost_per_image_micro_usd),
            ("video", credits.cost_per_video_micro_usd),
            ("tts", credits.cost_per_tts_micro_usd),
            ("stt", credits.cost_per_stt_micro_usd),
        ] {
            assert!(rate > 0, "{name} must never fall back to a rate of 0");
        }
    }

    /// The two neighbouring shapes the fixture above does not cover: an ABSENT
    /// `[credits]` table (which takes `impl Default for CreditsConfig` wholesale,
    /// the other half of the "same number by construction" invariant), and the
    /// minimal present-but-partial table. A fix applied to only one of the serde
    /// attribute or the `Default` impl passes one of these and fails the other.
    #[test]
    fn credits_media_rates_are_nonzero_whether_the_table_is_absent_or_partial() {
        let absent = CreditsConfig::default();
        assert!(absent.cost_per_image_micro_usd > 0);
        assert!(absent.cost_per_video_micro_usd > 0);
        assert!(absent.cost_per_tts_micro_usd > 0);
        assert!(absent.cost_per_stt_micro_usd > 0);

        // A present `[credits]` table naming no media rate at all.
        let partial = toml::from_str::<GatewayConfig>(
            r#"
[credits]
enabled = false
timeout_ms = 3000
"#,
        )
        .expect("parses")
        .credits;
        assert_eq!(
            partial.cost_per_image_micro_usd,
            absent.cost_per_image_micro_usd
        );
        assert_eq!(
            partial.cost_per_video_micro_usd,
            absent.cost_per_video_micro_usd
        );
        assert_eq!(
            partial.cost_per_tts_micro_usd,
            absent.cost_per_tts_micro_usd
        );
        assert_eq!(
            partial.cost_per_stt_micro_usd,
            absent.cost_per_stt_micro_usd
        );
    }

    /// A non-zero sandbox rate is what makes the wallet kill-switch reachable at
    /// all: with a present `[credits]` table that names no rate, a tick must still
    /// bill a non-zero `billed_micro`, so `debit_sandbox_sync` does not take its
    /// `billed_micro == 0` early return. The test above pins the parsed numbers;
    /// this one pins what those numbers DO.
    ///
    /// Each resource is priced in ISOLATION (one dimension non-zero at a time,
    /// with a long enough window that the nano→micro round-half-up cannot swallow
    /// the result). Pricing a mixed workspace instead would let one healthy rate
    /// mask eight zeroed ones — the assertion would pass while eight of the nine
    /// fields were still broken.
    #[test]
    fn each_documented_sandbox_rate_bills_a_nonzero_tick_on_its_own() {
        // A present `[credits]` table naming no sandbox rate at all — the shape
        // the published doc produces.
        let doc_toml = r#"
[credits]
enabled = false
timeout_ms = 3000
"#;
        let credits = toml::from_str::<GatewayConfig>(doc_toml)
            .expect("parses")
            .credits;
        // 1000s so even the smallest rate (storage, 30 nano/GiB/s) clears the
        // nano→micro rounding floor rather than testing the rounding.
        const SECS: u64 = 1_000;

        let mut cases: Vec<(&str, u64)> = vec![
            (
                "vcpu",
                credits.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, SECS),
            ),
            (
                "mem",
                credits.sandbox_tick_cost_raw_micro(0, 1, 0, GpuKind::None, 0, OsKind::Linux, SECS),
            ),
            (
                // Over the free-storage tier, so the storage rate is the only
                // term that can contribute.
                "storage",
                credits.sandbox_tick_cost_raw_micro(
                    0,
                    0,
                    u32::try_from(credits.sandbox_free_storage_gib)
                        .expect("the default free-storage tier fits in u32")
                        + 1,
                    GpuKind::None,
                    0,
                    OsKind::Linux,
                    SECS,
                ),
            ),
        ];
        for (label, gpu) in [
            ("gpu_h200", GpuKind::H200),
            ("gpu_h100", GpuKind::H100),
            ("gpu_rtx_pro_6000", GpuKind::RtxPro6000),
            ("gpu_rtx_5090", GpuKind::Rtx5090),
            ("gpu_rtx_4090", GpuKind::Rtx4090),
        ] {
            cases.push((
                label,
                credits.sandbox_tick_cost_raw_micro(0, 0, 0, gpu, 1, OsKind::Linux, SECS),
            ));
        }
        // Windows surcharge in isolation: the same 1-vCPU tick must cost strictly
        // MORE on Windows than on Linux, which is only true if the surcharge rate
        // is non-zero (a bare `windows` tick also carries the base vCPU rate, so
        // an absolute `> 0` here would pass with the surcharge zeroed).
        let linux_vcpu =
            credits.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, SECS);
        let windows_vcpu =
            credits.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Windows, SECS);
        assert!(
            windows_vcpu > linux_vcpu,
            "the Windows vCPU surcharge is not being applied ({windows_vcpu} vs {linux_vcpu})"
        );

        for (label, raw) in cases {
            assert!(
                raw > 0,
                "the {label} rate bills nothing; a 0 here means debit_sandbox_sync \
                 returns None on that workload, so compute_verdict never sees a \
                 balance and KillBalance is unreachable"
            );
            assert!(
                credits.sandbox_debit_amount(raw) > 0,
                "the {label} rate survives the markup as a zero debit"
            );
        }
    }

    /// A richly-populated config (providers with multi-account keys, routing with a
    /// tiered fallback chain, a non-default firewall policy, control-plane pricing)
    /// round-trips through TOML with every value preserved.
    #[test]
    fn populated_config_roundtrips_every_value() {
        let mut cfg = GatewayConfig::default();
        cfg.providers.openai = Some(OpenAiProviderConfig {
            api_key: "sk-primary".to_string(),
            api_keys: vec!["sk-a".to_string(), "sk-b".to_string()],
            base_url: "https://proxy.example/v1".to_string(),
        });
        cfg.routing.default_provider = ProviderId::from("primary");
        cfg.routing.fallback_chain =
            vec![ProviderId::from("primary"), ProviderId::from("secondary")];
        cfg.routing
            .provider_tiers
            .insert(ProviderId::from("secondary"), 2);
        cfg.firewall.policy = FirewallPolicy::Sanitize;
        cfg.control_plane.enabled = true;
        cfg.control_plane.gateway_key = Some("gw-key".to_string());
        cfg.control_plane.cost_per_1k_micro_usd = 4321;
        cfg.control_plane.model_pricing.insert(
            "claude-sonnet".to_string(),
            ModelPrice {
                input_per_1k_micro_usd: 3000,
                output_per_1k_micro_usd: 15000,
            },
        );
        cfg.credits.markup_bps = 700;

        let text = toml::to_string_pretty(&cfg).expect("serialize populated config");
        let back: GatewayConfig = toml::from_str(&text).expect("re-parse populated config");

        let openai = back.providers.openai.expect("openai survives");
        assert_eq!(openai.all_keys(), vec!["sk-primary", "sk-a", "sk-b"]);
        assert_eq!(openai.base_url, "https://proxy.example/v1");
        assert_eq!(back.routing.default_provider, ProviderId::from("primary"));
        assert_eq!(back.routing.fallback_chain.len(), 2);
        assert_eq!(
            back.routing
                .provider_tiers
                .get(&ProviderId::from("secondary")),
            Some(&2)
        );
        assert_eq!(back.firewall.policy, FirewallPolicy::Sanitize);
        assert!(back.control_plane.enabled);
        assert_eq!(back.control_plane.gateway_key.as_deref(), Some("gw-key"));
        assert_eq!(back.control_plane.cost_per_1k_micro_usd, 4321);
        // The per-model price table survived and still resolves via longest-prefix.
        assert_eq!(
            back.control_plane.cost_for("claude-sonnet-4-5", 1000, 1000),
            18000
        );
        assert_eq!(back.credits.markup_bps, 700);
    }
}

#[cfg(test)]
mod classify_tier_tests {
    use super::{
        resolve_classify_model_id, seed_classify_route, ClassifyProviderConfig, FirewallOverlay,
        InspectorConfig, ModelMapping, ProviderId, ProvidersConfig, RoutingConfig,
        DEFAULT_CLASSIFY_PORT, DEFAULT_INSPECTOR_MODEL, ENV_CLASSIFY_MODEL_ID,
    };

    /// Serializes the tests that read the inspector-model **default**, because
    /// `default_inspector_model` now consults [`ENV_CLASSIFY_MODEL_ID`] and one test
    /// below sets it. `apps/gateway` has no crate-wide env test lock, so this is the
    /// lock for this one variable; every test whose expectation depends on it takes
    /// this guard. (Tests that pass an explicit model, or that exercise the pure
    /// [`resolve_classify_model_id`], do not need it.)
    fn lock_classify_model_env() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The profile-aware port a standalone gateway resolves the classify slot to.
    fn expected_port() -> u16 {
        crate::profile::port(DEFAULT_CLASSIFY_PORT)
    }

    /// Resolve `routing` into the REAL router tables (`ModelRouter::new` does the
    /// same lowering) so the seed assertions close the loop through
    /// `RoutingTables::route` instead of only inspecting the map. `default_provider`
    /// is a hosted one on purpose: that is the fall-through that used to leak the
    /// classifier id upstream.
    fn tables_for(routing: &RoutingConfig) -> ryu_gw_router::RoutingTables {
        ryu_gw_router::RoutingTables {
            model_map: routing
                .model_map
                .iter()
                .map(|(model, mapping)| {
                    (
                        model.clone(),
                        (
                            mapping.provider.as_str().to_owned(),
                            mapping.provider_model.clone(),
                        ),
                    )
                })
                .collect(),
            builtin_prefixes: ryu_gw_router::builtin_prefixes(),
            default_provider: "openai".to_owned(),
            modality_map: std::collections::HashMap::new(),
            fallback_chain: Vec::new(),
            provider_tiers: std::collections::HashMap::new(),
            eval_candidates: Vec::new(),
            explore_ratio: 0.0,
        }
    }

    #[test]
    fn classify_slot_is_absent_by_default() {
        // A STANDALONE gateway's state — with no `RYU_CLASSIFY_LLM_URL` published we
        // must not materialize a slot pointing at a dead port. (On a Core-spawned
        // gateway the slot is always `Some`: Core publishes the URL unconditionally.)
        assert!(ProvidersConfig::default().classify.is_none());
    }

    #[test]
    fn classify_slot_parses_from_gateway_toml_and_keeps_its_url() {
        let cfg: ProvidersConfig =
            toml::from_str("[classify]\nbase_url = \"http://127.0.0.1:9083/v1\"\n")
                .expect("classify table must parse");
        assert_eq!(
            cfg.classify.expect("slot present").base_url,
            "http://127.0.0.1:9083/v1"
        );
    }

    #[test]
    fn bare_classify_table_defaults_to_the_classify_port_not_ollama() {
        // Regression guard for the reason `ClassifyProviderConfig` is its own type:
        // reusing `LocalProviderConfig` would default this to the chat engine's
        // :11434 and silently run the guardrail classifier against the chat model.
        let cfg: ProvidersConfig = toml::from_str("[classify]\n").expect("bare table must parse");
        let base_url = cfg.classify.expect("slot present").base_url;
        assert_eq!(base_url, format!("http://127.0.0.1:{}/v1", expected_port()));
        assert!(!base_url.contains("11434"));
    }

    #[test]
    fn classify_config_default_url_is_profile_aware() {
        let c: ClassifyProviderConfig =
            serde_json::from_value(serde_json::json!({})).expect("empty object parses");
        assert!(c.base_url.ends_with(&format!("{}/v1", expected_port())));
    }

    #[test]
    fn inspector_model_defaults_to_the_classify_tier_classifier() {
        let _lock = lock_classify_model_env();
        // "enabled" must mean "working": an empty default made the guardrail
        // fail open forever while `action` still read Block.
        assert_eq!(InspectorConfig::default().model, DEFAULT_INSPECTOR_MODEL);
        let from_wire: InspectorConfig =
            serde_json::from_value(serde_json::json!({ "enabled": true }))
                .expect("absent model parses");
        assert_eq!(from_wire.model, DEFAULT_INSPECTOR_MODEL);
    }

    #[test]
    fn blank_inspector_model_resolves_to_the_default() {
        let _lock = lock_classify_model_env();
        // The UI / `PUT /v1/config` send an explicit "" when an operator clears the
        // box — the case `#[serde(default)]` alone does NOT cover.
        for blank in ["", "   "] {
            let cfg: InspectorConfig =
                serde_json::from_value(serde_json::json!({ "enabled": true, "model": blank }))
                    .expect("blank model parses");
            assert_eq!(
                cfg.model, DEFAULT_INSPECTOR_MODEL,
                "blank {blank:?} must resolve to the default"
            );
        }
    }

    #[test]
    fn explicit_inspector_model_is_never_overridden() {
        let cfg: InspectorConfig =
            serde_json::from_value(serde_json::json!({ "model": "openrouter/auto" }))
                .expect("explicit model parses");
        assert_eq!(cfg.model, "openrouter/auto");
    }

    #[test]
    fn firewall_overlay_inspector_inherits_the_resolved_model() {
        let _lock = lock_classify_model_env();
        // Overlays are cloned wholesale into the resolved config by
        // `firewall/resolve.rs`, so the normalization has to hold on this path too
        // — otherwise an org/agent overlay reintroduces the empty model.
        let ov: FirewallOverlay = serde_json::from_value(serde_json::json!({
            "inspector": { "enabled": true, "model": "" }
        }))
        .expect("overlay parses");
        assert_eq!(
            ov.inspector.expect("inspector present").model,
            DEFAULT_INSPECTOR_MODEL
        );
    }

    /// Anchors Core's lazy-start predicate from the crate that owns the default.
    ///
    /// `apps/core/src/sidecar/gateway.rs::patch_selects_classify_tier` decides
    /// whether to spawn a 241 MB llama-server from the SERIALIZED firewall section,
    /// and it must decline on a fresh node. Two properties of `FirewallConfig`'s
    /// default make that safe, and both would be invisible to Core if they changed:
    /// the inspector is off, and there is not one enabled evaluator binding (an
    /// enabled binding is Core's third arm, because `EvaluatorImpl::LlmJudge` borrows
    /// `inspector.model` regardless of `inspector.enabled`). Core's own negative test
    /// hand-builds this shape; this is the assertion that keeps the shape honest.
    #[test]
    fn default_firewall_section_selects_nothing_for_cores_lazy_start() {
        // The model assertion below reads the published-id env var.
        let _lock = lock_classify_model_env();
        let wire = serde_json::to_value(super::FirewallConfig::default())
            .expect("firewall config serializes");
        assert_eq!(
            wire["inspector"]["enabled"],
            serde_json::json!(false),
            "the inspector must default OFF, or every firewall push spawns the tier"
        );
        assert_eq!(
            wire["evaluators"],
            serde_json::json!([]),
            "no evaluator binding may ship enabled — one would arm Core's judge arm on \
             every firewall push"
        );
        // …and the model IS the classify id, which is precisely why the enablement
        // flags above are the only thing standing between a checkbox save and a
        // resident llama-server.
        assert_eq!(
            wire["inspector"]["model"],
            serde_json::json!(super::classify_model_id())
        );
    }

    // ── Registry-swappable classifier id (the published-id seam) ─────────────

    #[test]
    fn published_classify_id_wins_and_blank_falls_back() {
        // Core pushes `RYU_CLASSIFY_MODEL_ID` unconditionally, so a blank value has
        // to read as "not published" — never as an empty model id, which is the very
        // failure `de_inspector_model` exists to prevent.
        assert_eq!(
            resolve_classify_model_id(Some("my-tiny-classifier")),
            "my-tiny-classifier"
        );
        assert_eq!(
            resolve_classify_model_id(Some("  my-tiny-classifier  ")),
            "my-tiny-classifier"
        );
        for absent in [None, Some(""), Some("   ")] {
            assert_eq!(
                resolve_classify_model_id(absent),
                DEFAULT_INSPECTOR_MODEL,
                "{absent:?} must fall back to the compile-time default"
            );
        }
    }

    #[test]
    fn published_classify_id_becomes_the_inspector_default() {
        // The WIRING assertion: `default_inspector_model` must actually consult the
        // published id, not just have a resolver available next to it.
        let _lock = lock_classify_model_env();
        let prev = std::env::var(ENV_CLASSIFY_MODEL_ID).ok();
        std::env::set_var(ENV_CLASSIFY_MODEL_ID, "my-tiny-classifier");
        let default_model = InspectorConfig::default().model;
        let blanked: InspectorConfig =
            serde_json::from_value(serde_json::json!({ "enabled": true, "model": "" }))
                .expect("blank model parses");
        match prev {
            Some(v) => std::env::set_var(ENV_CLASSIFY_MODEL_ID, v),
            None => std::env::remove_var(ENV_CLASSIFY_MODEL_ID),
        }
        assert_eq!(default_model, "my-tiny-classifier");
        assert_eq!(blanked.model, "my-tiny-classifier");
    }

    /// The end-to-end assertion the original seam was missing: an overridden
    /// classifier id must be **routable**, not merely readable. Before the seed,
    /// `route("my-tiny-classifier")` matched no map and no builtin prefix and fell
    /// through to `default_provider` — so the guardrail classifier id was shipped to
    /// a hosted provider, 400'd, and the inspector failed open in silence.
    #[test]
    fn seeded_classify_route_makes_an_overridden_id_routable() {
        let mut routing = RoutingConfig::default();
        seed_classify_route(&mut routing, "my-tiny-classifier");
        assert_eq!(
            routing.model_map["my-tiny-classifier"].provider.as_str(),
            "classify"
        );
        // Close the loop through the real router tables.
        assert_eq!(
            tables_for(&routing).route("my-tiny-classifier").0,
            "classify"
        );
    }

    #[test]
    fn seeded_classify_route_defends_the_default_id_from_a_user_gemma_prefix() {
        // `route` runs the user `model_map` (exact, then longest prefix) BEFORE the
        // builtin table, so `gemma` → `openrouter` used to capture the default
        // classifier and bill the guardrail to a paid provider. The exact seed wins
        // step 1, ahead of that prefix scan.
        let mut routing = RoutingConfig::default();
        routing.model_map.insert(
            "gemma".to_owned(),
            ModelMapping {
                provider: ProviderId::from("openrouter"),
                provider_model: None,
            },
        );
        seed_classify_route(&mut routing, DEFAULT_INSPECTOR_MODEL);
        let tables = tables_for(&routing);
        assert_eq!(tables.route(DEFAULT_INSPECTOR_MODEL).0, "classify");
        // A normal gemma chat model still follows the operator's mapping.
        assert_eq!(tables.route("gemma-3-12b-it").0, "openrouter");
    }

    #[test]
    fn seeded_classify_route_never_overwrites_an_explicit_operator_entry() {
        let mut routing = RoutingConfig::default();
        routing.model_map.insert(
            DEFAULT_INSPECTOR_MODEL.to_owned(),
            ModelMapping {
                provider: ProviderId::from("local"),
                provider_model: None,
            },
        );
        let marked = seed_classify_route(&mut routing, DEFAULT_INSPECTOR_MODEL);
        assert_eq!(
            routing.model_map[DEFAULT_INSPECTOR_MODEL].provider.as_str(),
            "local",
            "an explicit exact mapping is a deliberate operator choice"
        );
        assert!(
            marked.is_none(),
            "a row we did not insert must never be reported as ours to strip"
        );
        // A blank id is a no-op, never a `"" → classify` row.
        let before = routing.model_map.len();
        assert!(seed_classify_route(&mut routing, "   ").is_none());
        assert_eq!(routing.model_map.len(), before);
    }

    // ── The seeded row is DERIVED: routable in memory, absent from the file ──────
    //
    // `GET /v1/config` renders `routing.model_map` as the desktop's hand-authored
    // "Model mappings" list with per-row delete buttons, so a seeded row read as an
    // entry the operator never wrote AND could not delete (the delete PUT dropped it
    // from the file; the next `load()` seeded it straight back). These close the loop
    // from the config layer; `api::config`'s tests cover the served view and the PUT.

    /// How many `model_map` rows point at the classify provider. Asserted instead of
    /// looking up `classify_model_id()` on purpose: another test in this binary
    /// temporarily sets `RYU_CLASSIFY_MODEL_ID`, so *which* id got seeded is not
    /// stable across a parallel run — but "a row pointing at `classify` exists" is,
    /// and it is the stronger claim anyway.
    fn classify_rows(routing: &RoutingConfig) -> Vec<&String> {
        let mut rows: Vec<&String> = routing
            .model_map
            .iter()
            .filter(|(_, mapping)| mapping.provider.as_str() == "classify")
            .map(|(model, _)| model)
            .collect();
        rows.sort();
        rows
    }

    #[test]
    fn load_seeds_a_routable_classify_row_that_save_never_persists() {
        let guard = super::test_config_path::ConfigPathGuard::isolated("seed-not-persisted");
        // An operator's own mapping, so the assertions also prove the strip is
        // surgical rather than a `model_map` wipe.
        std::fs::write(
            guard.path(),
            "[routing.model_map.\"claude-3-5-sonnet\"]\nprovider = \"anthropic\"\n",
        )
        .expect("seed gateway.toml");

        let loaded = super::GatewayConfig::load().expect("load the seeded file");

        // In memory: exactly one classify row, it is marked as ours, and it ROUTES.
        // The id is read from the marker rather than recomputed, so a parallel test
        // flipping `RYU_CLASSIFY_MODEL_ID` cannot make this assert the wrong key.
        let seeded_id = loaded
            .seeded_classify_model
            .clone()
            .expect("load must mark the row it seeded");
        assert_eq!(classify_rows(&loaded.routing), vec![&seeded_id]);
        assert_eq!(
            tables_for(&loaded.routing).route(&seeded_id).0,
            "classify",
            "the seed's whole purpose is that the classifier id resolves to the tier"
        );

        loaded.save().expect("persist the loaded config");

        // On disk: the operator's row, and no classify row at all.
        let text = std::fs::read_to_string(guard.path()).expect("gateway.toml written");
        let on_disk: super::GatewayConfig = toml::from_str(&text).expect("re-parse");
        assert_eq!(
            on_disk.routing.model_map["claude-3-5-sonnet"]
                .provider
                .as_str(),
            "anthropic",
            "the operator's own mapping must survive"
        );
        assert!(
            classify_rows(&on_disk.routing).is_empty(),
            "a derived row must never reach the file: there it looks operator-authored \
             forever and outlives the id it was seeded for — got {:?}",
            classify_rows(&on_disk.routing)
        );

        // …and the next load re-seeds, so nothing was lost by not persisting it.
        let reloaded = super::GatewayConfig::load().expect("reload");
        assert_eq!(classify_rows(&reloaded.routing).len(), 1);
    }

    #[test]
    fn a_classify_row_already_in_the_file_is_treated_as_the_operators_and_kept() {
        // The migration case a marker-based strip must not get wrong: a node whose
        // `gateway.toml` ALREADY carries `<classify id> → classify`, either because a
        // pre-fix gateway persisted the seed or because the operator wrote it. `load`'s
        // `or_insert` finds it, marks nothing, and `save` must leave it alone —
        // otherwise the fix silently edits hand-authored files. Such a row is
        // deletable by the ordinary read-modify-write PUT (nothing re-adds it under
        // that exact id unless it IS the current classify id, in which case the row is
        // simply re-seeded in memory and stripped from the view again).
        let guard = super::test_config_path::ConfigPathGuard::isolated("preexisting-row");
        std::fs::write(
            guard.path(),
            "[routing.model_map.\"my-own-classifier\"]\nprovider = \"classify\"\n",
        )
        .expect("seed gateway.toml");

        let loaded = super::GatewayConfig::load().expect("load");
        assert!(
            loaded.routing.model_map.contains_key("my-own-classifier"),
            "the operator's classify row must be loaded"
        );
        assert_ne!(
            loaded.seeded_classify_model.as_deref(),
            Some("my-own-classifier"),
            "a row that came from the file is never claimed by the seed"
        );
        loaded.save().expect("save");

        let text = std::fs::read_to_string(guard.path()).expect("written");
        let on_disk: super::GatewayConfig = toml::from_str(&text).expect("re-parse");
        assert_eq!(
            on_disk.routing.model_map["my-own-classifier"]
                .provider
                .as_str(),
            "classify",
            "a classify row that came from the FILE is the operator's, not ours to strip"
        );
    }

    #[test]
    fn strip_leaves_a_seeded_row_that_was_since_replaced() {
        // The marker says "we inserted this key"; it does not license deleting whatever
        // value happens to live there later. If something re-pointed the mapping after
        // the seed ran, that value is somebody's choice.
        let mut cfg = super::GatewayConfig::default();
        cfg.seeded_classify_model = seed_classify_route(&mut cfg.routing, DEFAULT_INSPECTOR_MODEL);
        assert_eq!(
            cfg.seeded_classify_model.as_deref(),
            Some(DEFAULT_INSPECTOR_MODEL)
        );
        cfg.routing.model_map.insert(
            DEFAULT_INSPECTOR_MODEL.to_owned(),
            ModelMapping {
                provider: ProviderId::from("local"),
                provider_model: None,
            },
        );

        let clean = cfg.without_derived_values();

        assert_eq!(
            clean.routing.model_map[DEFAULT_INSPECTOR_MODEL]
                .provider
                .as_str(),
            "local"
        );
        assert!(
            clean.seeded_classify_model.is_none(),
            "the marker is consumed, so a second strip cannot delete a later row"
        );
    }

    #[test]
    fn seeded_classify_marker_never_crosses_the_wire() {
        // The marker is provenance, not config: it must not appear in `gateway.toml`,
        // must not be settable by a `PUT /v1/config` body, and must not survive a
        // round-trip (else a client could ask us to delete one of its own rows).
        let mut cfg = super::GatewayConfig::default();
        cfg.seeded_classify_model = seed_classify_route(&mut cfg.routing, DEFAULT_INSPECTOR_MODEL);

        let toml_text = toml::to_string_pretty(&cfg).expect("serialize config");
        assert!(!toml_text.contains("seeded_classify_model"), "{toml_text}");
        let json = serde_json::to_value(&cfg).expect("serialize config as json");
        assert!(json.get("seeded_classify_model").is_none());

        let injected: super::GatewayConfig = serde_json::from_value(serde_json::json!({
            "seeded_classify_model": DEFAULT_INSPECTOR_MODEL,
            "routing": { "model_map": { DEFAULT_INSPECTOR_MODEL: { "provider": "classify" } } }
        }))
        .expect("config patch parses");
        assert!(
            injected.seeded_classify_model.is_none(),
            "a PUT body must not be able to mark an operator row as strippable"
        );
    }

    // ── `[providers.classify]` is the STANDALONE setting; Core's env wins the slot ──

    #[test]
    fn cores_published_classify_url_wins_the_file_table() {
        // The precedence half of the cross-process contract (see the env overlay in
        // `load`): Core publishes `RYU_CLASSIFY_LLM_URL` on every spawn, so on a
        // Core-spawned node the URL the gateway dials for `classify` is always the one
        // Core computed — which is what lets Core gate its 300-400 MB lazy sidecar
        // start on that URL's locality without reading this file.
        //
        // This test mutates `RYU_CLASSIFY_LLM_URL`, which is process-global. The
        // config-path guard is what makes that safe: the only reader is
        // `GatewayConfig::load`, and every test that reaches `load` holds this same
        // lock, so no other test can be observing the variable while it is swapped.
        let guard = super::test_config_path::ConfigPathGuard::isolated("classify-url");
        let authored = "[providers.classify]\nbase_url = \"http://small-model.internal:9999/v1\"\n";
        std::fs::write(guard.path(), authored).expect("seed gateway.toml");
        let prior = std::env::var_os("RYU_CLASSIFY_LLM_URL");
        std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://127.0.0.1:8083/v1");

        // 1. File table + env ⇒ the env wins the LIVE slot, and the file's value is
        //    captured for the strip (asserted in the persistence test below).
        let with_file = super::GatewayConfig::load().expect("load");

        // 2. No table + env ⇒ the env registers the tier, as it always did.
        std::fs::write(guard.path(), "bind = \"127.0.0.1:7981\"\n").expect("rewrite gateway.toml");
        let without_table = super::GatewayConfig::load().map(|c| c.providers.classify);

        // 3. No table + BLANK env ⇒ "not published": the slot stays empty and the tier
        //    fails open, rather than registering an unusable "" URL.
        std::env::set_var("RYU_CLASSIFY_LLM_URL", "   ");
        let blank_env_no_table = super::GatewayConfig::load().map(|c| c.providers.classify);

        // 4. File table + BLANK env ⇒ the standalone case the field exists for. Nothing
        //    overwrites it, including a bare table, which keeps this type's own
        //    profile-aware default (never Ollama's `:11434`).
        std::fs::write(guard.path(), authored).expect("rewrite gateway.toml");
        let blank_env_with_table = super::GatewayConfig::load().expect("load");
        std::fs::write(guard.path(), "[providers.classify]\n").expect("rewrite gateway.toml");
        let blank_env_bare_table = super::GatewayConfig::load().map(|c| c.providers.classify);

        match prior {
            Some(v) => std::env::set_var("RYU_CLASSIFY_LLM_URL", v),
            None => std::env::remove_var("RYU_CLASSIFY_LLM_URL"),
        }

        assert_eq!(
            with_file
                .providers
                .classify
                .as_ref()
                .expect("slot present")
                .base_url,
            "http://127.0.0.1:8083/v1",
            "Core's published URL must win the live slot — the gateway has to dial the \
             tier Core decided on, because that is the only URL Core can gate its lazy \
             start against"
        );
        assert!(
            with_file.env_injected_classify_provider,
            "the overwritten slot must be marked derived"
        );
        assert_eq!(
            with_file
                .file_classify_provider
                .as_ref()
                .expect("the file's table is captured, not discarded")
                .base_url,
            "http://small-model.internal:9999/v1",
        );
        assert_eq!(
            without_table.expect("load").expect("slot present").base_url,
            "http://127.0.0.1:8083/v1",
            "with no table, Core's published URL is what registers the tier"
        );
        assert!(
            blank_env_no_table.expect("load").is_none(),
            "a blank env must leave the tier unregistered (fail open), not register \"\""
        );
        assert_eq!(
            blank_env_with_table
                .providers
                .classify
                .as_ref()
                .expect("slot present")
                .base_url,
            "http://small-model.internal:9999/v1",
            "on a STANDALONE gateway (no published URL) the file setting is what takes \
             effect — that is the scope this field has"
        );
        assert!(
            !blank_env_with_table.env_injected_classify_provider,
            "a file-authored table with no env is not derived"
        );
        assert_eq!(
            blank_env_bare_table
                .expect("load")
                .expect("slot present")
                .base_url,
            format!("http://127.0.0.1:{}/v1", expected_port()),
            "a bare table keeps the classify default, not Ollama's port"
        );
    }

    #[test]
    fn an_env_injected_classify_slot_is_never_written_back_and_never_eats_the_file() {
        // Two failure modes at once, both on the `save()` path, because env-wins makes
        // them the SAME code path:
        //
        // 1. No file table: every provider slot serializes out on `save()`, so the first
        //    save on a Core-spawned node would freeze Core's computed, profile-scoped
        //    loopback URL (`:8083` release, `:9083` dev) into `gateway.toml` as an
        //    operator-authored-looking table — stale on the next profile/port change,
        //    and live the moment something other than Core starts the gateway.
        // 2. WITH a file table: the strip used to blank the slot, which was safe only
        //    while the file BEAT the env (a file table then never set the marker).
        //    Under env-wins the live value is Core's, so a blanking strip would delete
        //    the operator's own `[providers.classify]` from their file on the next
        //    `PUT`-triggered save. It must RESTORE, not clear.
        let guard = super::test_config_path::ConfigPathGuard::isolated("classify-env-save");
        std::fs::write(guard.path(), "bind = \"127.0.0.1:7981\"\n").expect("seed gateway.toml");
        let prior = std::env::var_os("RYU_CLASSIFY_LLM_URL");
        std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://127.0.0.1:8083/v1");

        let loaded = super::GatewayConfig::load().expect("load");
        // In memory the tier IS registered — the strip must not cost the running
        // process its classify provider.
        assert_eq!(
            loaded
                .providers
                .classify
                .as_ref()
                .expect("env fills the slot")
                .base_url,
            "http://127.0.0.1:8083/v1"
        );
        assert!(loaded.env_injected_classify_provider);
        loaded.save().expect("save");

        let text = std::fs::read_to_string(guard.path()).expect("gateway.toml written");
        let on_disk: super::GatewayConfig = toml::from_str(&text).expect("re-parse");
        // …and the next load still registers the tier from the env.
        let after_save = super::GatewayConfig::load().expect("reload");

        // Now the operator's own table, which the env overwrites in memory and which a
        // save must nevertheless leave on disk untouched.
        std::fs::write(
            guard.path(),
            "[providers.classify]\nbase_url = \"http://small-model.internal:9999/v1\"\n",
        )
        .expect("rewrite gateway.toml");
        let authored = super::GatewayConfig::load().expect("load authored");
        assert!(
            authored.env_injected_classify_provider,
            "under env-wins the marker is set even when the file HAD a table — which is \
             exactly why the strip has to restore rather than clear"
        );
        // The strip is idempotent: `api::config::persisted_config` runs it, then the
        // resulting config is what `save()` strips again. Model both hops.
        let via_persisted_read = authored.without_derived_values();
        via_persisted_read.save().expect("save authored");
        let authored_text = std::fs::read_to_string(guard.path()).expect("written");
        let authored_on_disk: super::GatewayConfig =
            toml::from_str(&authored_text).expect("re-parse authored");

        match prior {
            Some(v) => std::env::set_var("RYU_CLASSIFY_LLM_URL", v),
            None => std::env::remove_var("RYU_CLASSIFY_LLM_URL"),
        }

        assert!(
            on_disk.providers.classify.is_none(),
            "a derived provider slot must not be persisted as a file setting: {text}"
        );
        assert!(
            !text.contains("[providers.classify]"),
            "not even as a bare table: {text}"
        );
        assert_eq!(
            after_save
                .providers
                .classify
                .expect("env still fills the slot")
                .base_url,
            "http://127.0.0.1:8083/v1",
            "saving must leave Core's published URL in charge of the slot"
        );
        assert_eq!(
            via_persisted_read
                .providers
                .classify
                .as_ref()
                .expect("the file's table is restored, not dropped")
                .base_url,
            "http://small-model.internal:9999/v1",
            "the strip restores what the file said — a `None` here is the data-loss bug"
        );
        assert_eq!(
            authored_on_disk
                .providers
                .classify
                .expect("authored table survives")
                .base_url,
            "http://small-model.internal:9999/v1",
            "the operator's own table must survive a save, even though the env \
             overwrote it in memory"
        );
    }
}
