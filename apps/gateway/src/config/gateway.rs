//! The root `GatewayConfig` (the `gateway.toml` shape) and its defaults.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GatewayConfig {
    /// Optional operator-published RFC 9116 contact. Never derived from account data.
    #[serde(default)]
    pub public_contact: PublicContactConfig,
    #[serde(default = "default_bind")]
    pub bind: String,

    #[serde(default)]
    pub providers: ProvidersConfig,

    /// Explicit process inputs; never authored, serialized or printed as material.
    #[serde(skip)]
    pub(crate) provider_environment: Option<ProviderEnvironment>,
    #[serde(skip)]
    pub(crate) provider_vault_source:
        Option<std::sync::Arc<crate::provider_vault::VaultSourceSnapshot>>,

    /// Explicit transport pools for direct OpenAI-compatible upstreams. Proxy
    /// credentials are referenced by environment variable name, never stored
    /// in this config or returned in a URL.
    #[serde(default, skip_serializing_if = "EgressConfig::is_empty")]
    pub egress: EgressConfig,

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

    /// Redis/Valkey settings shared by the `"redis"` exact/semantic cache
    /// backends and the Redis embedding store. The connection URL is a secret
    /// and is read only from `RYU_GATEWAY_REDIS_URL`, never from this file.
    #[serde(default)]
    pub redis_cache: RedisCacheConfig,

    /// `/v1/embeddings` cache (off by default).
    #[serde(default)]
    pub embedding_cache: EmbeddingCacheConfig,

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

    /// Hazard screener endpoints (`[screening]`, screener addendum 5.2).
    /// Policy comes from the platform floor on the fleet; a self-hosted node
    /// opts in with `node_classifiers`. Skipped when untouched so an existing
    /// `gateway.toml` stays byte-identical.
    #[serde(default, skip_serializing_if = "ScreeningConfig::is_default")]
    pub screening: ScreeningConfig,

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
    ///
    /// This is exposure hardening only, and a self-hosted stack behind its own
    /// proxy sets it too. It never decides custody: Ryu's floor, identity
    /// secrets and hosted route gates follow [`crate::custody::GatewayCustody`],
    /// which only the provider-vault signals make Fleet.
    #[serde(default)]
    pub fleet: bool,
}

pub(super) fn default_bind() -> String {
    // Profile-aware (release `127.0.0.1:7981`, dev `127.0.0.1:8981`, …) so a
    // standalone dev gateway never collides with a release one. Core-spawned
    // gateways get an explicit `--bind` that is already profile-offset.
    crate::profile::default_bind()
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            public_contact: PublicContactConfig::default(),
            bind: default_bind(),
            providers: ProvidersConfig::default(),
            provider_environment: None,
            provider_vault_source: None,
            egress: EgressConfig::default(),
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
            redis_cache: RedisCacheConfig::default(),
            embedding_cache: EmbeddingCacheConfig::default(),
            budgets: BudgetConfig::default(),
            channels: ChannelsConfig::default(),
            control_plane: ControlPlaneConfig::default(),
            exec_budget: ExecBudgetConfig::default(),
            compression: CompressionConfig::default(),
            backends: StageBackendsConfig::default(),
            pipeline: crate::pipeline::stages::PipelineOrderConfig::default(),
            tools: ToolsConfig::default(),
            screening: ScreeningConfig::default(),
            widget: WidgetConfig::default(),
            credits: CreditsConfig::default(),
            fleet: false,
        }
    }
}
