use std::sync::{atomic::AtomicI64, Arc, OnceLock, RwLock};

use crate::{
    audit::{AuditLogger, AuditRegistry},
    budget::{BudgetBackend, BudgetRegistry, ExecBudgetEnforcer, SharedBudgetState, WalletState},
    cache::CacheRegistry,
    circuit_breaker::CircuitBreakerRegistry,
    composio::ComposioClient,
    concurrency::ConcurrencyLimiter,
    config::{ApiKeyConfig, AuthConfig, BudgetConfig, FirewallConfig, GatewayConfig},
    evals::EvalsRegistry,
    firewall::{
        resolve::{FirewallResolver, PolicyBundle},
        FirewallRegistry, FirewallScanner,
    },
    jobs::MediaJobStore,
    metrics::Metrics,
    passthrough::PassthroughRegistry,
    phone_calls::PhoneCallHub,
    pipeline::RequestContext,
    policy::{EffectivePolicy, ResolveCache},
    providers::{ProviderRegistry, ProviderRuntime},
    quota::ProviderQuotas,
    rate_limit::RateLimiterRegistry,
    responses_store::ResponsesStore,
    router::{
        smart::{SmartRouter, SmartRouterBackend, SmartRouterRegistry},
        RouterRegistry,
    },
    semantic_cache::{SemanticCache, SemanticCacheRegistry},
    skills::SkillsRegistry,
    tools::ToolSearchClient,
    traffic::TrafficBus,
    treg::TregClient,
    wasm_policy::WasmPolicyHost,
};

/// Receiver half of the online-eval queue, drained by `online_evals::spawn_worker`.
pub(crate) type OnlineEvalReceiver =
    tokio::sync::mpsc::Receiver<crate::evals::online::OnlineEvalJob<RequestContext>>;

/// Reject an `[evals.online]` block that references unknown or
/// offline-unavailable evaluators before the Gateway starts serving.
pub(crate) fn validate_online_evals(config: &GatewayConfig) -> Result<(), String> {
    validate_online_evals_against(&config.evals.online, &config.custom_evaluators)
}

/// [`validate_online_evals`] against an explicit custom-evaluator set, so
/// `PUT /v1/config` can refuse a custom-evaluator change that would orphan an
/// `[evals.online]` reference (and make the next Gateway start fail).
pub(crate) fn validate_online_evals_against(
    online: &crate::evals::OnlineEvalsConfig,
    custom: &[crate::evaluators::Evaluator],
) -> Result<(), String> {
    online.validate()?;
    let registry = crate::evaluators::EvaluatorRegistry::from_custom(custom);
    let ids: Vec<String> = online
        .referenced_evaluators()
        .into_iter()
        .map(str::to_owned)
        .collect();
    if let Some(unknown) = ids.iter().find(|id| registry.get(id).is_none()) {
        return Err(format!(
            "evals.online references unknown evaluator '{unknown}'"
        ));
    }
    registry
        .validate_offline_ids(&ids)
        .map_err(|error| format!("evals.online: {error}"))
}

pub struct AppState {
    pub config: GatewayConfig,
    /// Resolved, validated pre-processing stage order (W6d). Built ONCE here at
    /// config-apply time from `config.pipeline` and iterated by
    /// [`crate::pipeline::pre_process`], so the request hot path pays zero
    /// per-request allocation to know the order â€” it borrows this pre-resolved
    /// slice. Default = [`crate::pipeline::stages::DEFAULT_ORDER`] (the exact
    /// pre-W6d sequence).
    pub stage_order: crate::pipeline::stages::StageOrder,
    /// Capture once per request before routing/governance/dispatch.
    pub provider_runtime: ProviderRuntime,
    /// Classifier-driven model routing (custom routing instructions). Inert
    /// unless `config.routing.smart_routing` is active; holds a per-session
    /// decision cache.
    ///
    /// `RwLock<Arc<â€¦>>` so `PUT /v1/config { routing: { smart_routing â€¦ } }` can
    /// **hot-swap** the smart router without a gateway restart â€” the same live-swap
    /// discipline as `firewall`/`budget`, but Arc-wrapped because
    /// [`SmartRouter::resolve`] is async and is held across an `.await` on the
    /// request path (a read guard cannot be). Callers clone the `Arc` out under a
    /// brief read lock (see [`Self::smart_router`]) and keep it across the await.
    /// Only `routing.smart_routing` swaps here; the [`Self::router`] model-map /
    /// fallback / tiers remain a startup snapshot (restart-only).
    ///
    /// W6c: now a swappable [`SmartRouterRegistry`] (async backend, `Arc`-yielding)
    /// whose built-in is the [`SmartRouter`]. `update_smart_router` hot-swaps the
    /// built-in â€” the same live-swap the old `RwLock<Arc<SmartRouter>>` gave.
    pub smart_router: SmartRouterRegistry,
    /// Per-agent smart-routing override cache (the "both" config scope: global
    /// `smart_router` is the default, an agent may override it). Keyed by a stable
    /// hash of the override [`SmartRoutingConfig`] JSON that Core injects as the
    /// private `ryu_smart_route` request-body field; each distinct config gets one
    /// ephemeral [`SmartRouter`] so its rule-embedding + session caches are reused
    /// across that agent's turns. Empty until an override is first seen.
    pub per_agent_routers: crate::router::smart::bounded::BoundedCache<String, Arc<SmartRouter>>,
    /// `RwLock` so `PUT /v1/config` can hot-swap the scanner without a restart.
    /// This is the **node-level** scanner: it still serves the outbound-scan,
    /// error-redaction, and multimodal paths, and it alone owns the process-global
    /// untrusted-wrapping flag. The per-request *resolved* (nodeâ†’orgâ†’agent)
    /// scanner used by the chat inbound/locked/companion paths comes from
    /// [`Self::resolver`] instead.
    ///
    /// W6c: now a swappable [`FirewallRegistry`] whose built-in is the
    /// [`FirewallScanner`]. `with_firewall` delegates to the active backend;
    /// `update_firewall_config` hot-swaps the built-in â€” same live-swap as before.
    pub firewall: FirewallRegistry,
    /// Hierarchical firewall resolver (node â†’ org â†’ agent cascade, #hierarchical
    /// policy). Holds the standalone-local org/agent overlay stores and a
    /// compiled-scanner cache; hands per-request scanners to
    /// [`Self::with_resolved_firewall`]. Its own internal `RwLock`s carry the
    /// poison-recovery discipline, so it is stored directly (not wrapped).
    pub resolver: FirewallResolver,
    /// Native-format passthrough reverse proxy (Claude Code / Codex) as a
    /// swappable registry (W6c decomposition): the built-in
    /// [`crate::passthrough::BuiltinPassthrough`] is the default active backend.
    /// The `/passthrough/*` handlers delegate through [`PassthroughRegistry::active`].
    pub passthrough: PassthroughRegistry,
    /// Per-key rate limiter as a swappable registry (Lg decomposition): the
    /// built-in in-process [`crate::rate_limit::RateLimiter`] is the default
    /// active backend. HOT primitive â€” in-process swap only, never IPC.
    pub rate_limiter: RateLimiterRegistry,
    /// Exact-match response cache as a swappable registry (Lg decomposition):
    /// the built-in in-process [`crate::cache::Cache`] is the default active
    /// backend; a plugin backend can register without touching the pipeline.
    pub cache: CacheRegistry,
    /// Per-provider circuit breaker as a swappable registry (Lg decomposition):
    /// the built-in in-process [`crate::circuit_breaker::CircuitBreakers`] is the
    /// default active backend. HOT primitive â€” in-process swap only, never IPC.
    pub circuit_breaker: CircuitBreakerRegistry,
    /// Priority admission queue for the resident local engine (interactive ahead
    /// of background fan-out). Inert for remote providers and when disabled.
    /// A startup snapshot of `config.concurrency` (applies on the next restart).
    pub admission: ConcurrencyLimiter,
    pub skills: SkillsRegistry,
    /// Bounded, credential-scoped in-memory state for Responses API continuation.
    pub response_states: ResponsesStore,
    /// Audit sink as a swappable registry (Lg decomposition): the built-in
    /// [`crate::audit::AuditLogger`] is the default active backend.
    pub audit: AuditRegistry,
    /// Charged-spend budget enforcer as a swappable, live-swap registry (Lg
    /// decomposition): the built-in [`crate::budget::BudgetEnforcer`] is the
    /// default active backend. `PUT /v1/config` hot-swaps it without a restart
    /// (see [`Self::update_budget_config`]); a plugin backend can register.
    pub budget: BudgetRegistry,
    /// Windowed charged-spend counters shared by the local budget enforcer
    /// (scopes `user` / `agent`) and the control-plane org limits (scopes `org`
    /// / `member` / `team` / `key`). SQLite next to `audit.db` when auditing is
    /// enabled, so spend survives a restart; in memory otherwise.
    pub spend_store: Arc<dyn crate::budget::SpendStore>,
    /// RPM / TPM buckets for control-plane org limits, keyed per subject.
    /// Also holds the abuse ladder's throttle and new-key buckets
    /// ([`crate::enforcement`]), under their own `abuse:` and `newkey:` keys.
    pub org_rate: crate::rate_limit::ScopedRateLimiter,
    /// In-flight counters for throttled subjects and new keys on the fleet
    /// ([`crate::enforcement`]).
    pub abuse_in_flight: Arc<crate::enforcement::InFlight>,
    /// Verifies the forwarded `x-ryu-user-jwt` on hosted `rgw_` traffic. `Some`
    /// when a control-plane URL is configured.
    pub user_jwt: Option<crate::policy::UserJwtVerifier>,
    /// Last `policyVersion` the control plane reported for this gateway's own
    /// key, surfaced on the admin health view. `None` until fetched or when the
    /// control plane predates the field.
    pub policy_version: RwLock<Option<String>>,
    /// Exec (sandbox/tool) budget enforcer (M6 / #192). Enforces count + wall-clock
    /// limits per rolling window; checked pre-run by Core via `POST /v1/exec/budget/check`.
    pub exec_budget: ExecBudgetEnforcer,
    /// Live eval runner as a swappable registry (Lg decomposition): the built-in
    /// [`crate::evals::EvalsRunner`] is the default active backend.
    pub evals: EvalsRegistry,
    /// Online evals (`[evals.online]`): the bounded hand-off queue, per-tenant
    /// judge budget and recent scored production requests. The pipeline only
    /// `try_send`s here; [`crate::online_evals::spawn_worker`] scores off-path.
    pub online_evals: Arc<crate::evals::online::OnlineEvals<RequestContext>>,
    /// The receiver half of [`Self::online_evals`], taken once by the worker.
    pub(crate) online_eval_receiver: std::sync::Mutex<Option<OnlineEvalReceiver>>,
    /// Live user-authored evaluators. Seeded from `config.custom_evaluators` and
    /// swapped by `PUT /v1/config`, so a saved custom evaluator is visible to
    /// the catalog, offline runner, online scorer and inline guardrails without
    /// a Gateway restart. Read through [`Self::evaluator_registry`].
    pub custom_evaluators: RwLock<Arc<Vec<crate::evaluators::Evaluator>>>,
    pub shared_budget: SharedBudgetState,
    /// Per-org credit-wallet empty cache (#486). The debit hook sets an org's
    /// flag after a metered call drives its balance non-positive; the pre-call
    /// budget gate reads it. Inert unless `config.credits` is active and the
    /// request carries an org.
    pub wallet: Arc<WalletState>,
    /// Ryu's own-supply allowances from the latest control-plane handshake,
    /// read by own-supply routing (`pipeline::own_supply`).
    pub pool_allowances: Arc<crate::credit_pools::PoolAllowances>,
    /// The Ryu Router own-supply table plus this gateway's canary and
    /// quarantine state (`own_supply_table`). The compiled seed by default;
    /// `main` installs the fleet runtime when this is a fleet gateway.
    pub own_supply: Arc<crate::own_supply_table::OwnSupplyRuntime>,
    /// Where this process runs (`custody`). `SelfHosted` by default; `main`
    /// installs the detected custody before the router is built, and the
    /// router and route gates read only this field, never the environment.
    pub custody: crate::custody::GatewayCustody,
    /// End-user salt root and upstream-subject pepper (`identity`). A local
    /// root with no pepper by default; `main` installs the secrets loaded for
    /// the detected custody, and the fleet refuses to start without them.
    pub identity_keys: Arc<crate::identity::IdentityKeys>,
    pub metrics: Metrics,
    pub composio: Option<ComposioClient>,
    pub treg: Option<TregClient>,
    /// The connections layer over [`Self::composio`] / [`Self::treg`]: provider
    /// dispatch for `/v1/providers/*` and the live `backends.connections` pick.
    pub connections: crate::connections::ConnectionRegistry,
    /// Unified tool catalog client over Core (#475). `Some` when `providers.core`
    /// is configured (CORE_URL set); `None` â‡’ the tool loop and `/v1/exec/tool`
    /// are inert. Behind the [`tools::CoreCatalog`] trait for the loop.
    pub tools: Option<ToolSearchClient>,
    /// Semantic (embedding-similarity) cache as a swappable registry (Lg
    /// decomposition): the built-in [`crate::semantic_cache::SemanticCache`] is
    /// the default active backend when enabled; disabled â‡’ no active backend
    /// (`active()` is `None`), matching the old `Option<SemanticCache>`.
    pub semantic_cache: SemanticCacheRegistry,
    /// `/v1/embeddings` cache (`[embedding_cache]`); `None` when disabled.
    pub embedding_cache: Option<ryu_gw_cache::EmbeddingCache>,
    /// Shared HTTP client for embedding calls (semantic cache) and Composio.
    pub http: reqwest::Client,
    /// Effective control-plane policy (U28). Empty by default; populated when
    /// the gateway is bound to a control plane and refreshed in the background.
    /// `RwLock` so a refresh task can swap it without restarting the gateway.
    pub policy: RwLock<EffectivePolicy>,
    /// `RwLock` so `PUT /v1/config` can hot-swap the auth config (API keys)
    /// without a restart. The master key and require_auth flag are read from the
    /// static `config` field; only `api_keys` is mutable at runtime.
    pub auth: RwLock<AuthConfig>,
    /// In-memory async media-job store (video generation). Job-based because
    /// cloud video runs for minutes; the client polls the gateway.
    pub jobs: MediaJobStore,
    /// Live PSTN sessions keyed by provider call SID, for authenticated mobile
    /// guidance, abort, and handoff controls.
    pub phone_calls: PhoneCallHub,
    /// The node's shared channel pairing store, set once when channels start
    /// (`channels_host::spawn_registered`) so the admin approval route acts on
    /// the same store every channel adapter reads. Unset until then.
    pub channel_pairing: OnceLock<ryu_gw_channels::pairing::PairingStore>,
    /// Token → org resolve cache for the multi-tenant data plane. `Some` when a
    /// control-plane URL is configured (`CONTROL_PLANE_URL`); resolves any minted
    /// `rgw_` bearer to its org + budget + policy and caches the result. `None`
    /// â‡’ the dynamic per-token auth path is inert and single-org behavior holds.
    pub resolve_cache: Option<ResolveCache>,
    /// The fleet's internal secret (`RYU_VAULT_INTERNAL_SECRET`) that
    /// authenticates control-plane enforcement pushes
    /// (`POST /internal/enforcement/invalidate`). `None` refuses every push.
    pub enforcement_push_secret: Option<String>,
    /// The newest valid platform floor any resolve carried (spec 02.3). Empty
    /// at boot in production, so a fleet Gateway refuses until its first
    /// resolve delivers one; test builds start from the compiled baseline.
    pub platform_floor: crate::platform_floor::FloorStore,
    /// Per-caller model policy for shared nodes (`policy::user_policy`). `Some`
    /// when a control plane is configured; applied once a caller is known.
    pub user_policy: Option<crate::policy::UserPolicyCache>,
    /// The hardened wasmtime host for untrusted WASM **policy** plugins
    /// (`EvaluatorImpl::Wasm`). Lazily built on first use â€” a gateway with no wasm
    /// policy declared pays nothing (no engine init, no epoch ticker thread).
    /// `Some(host)` once initialised; the inner `Option` is `None` only if engine
    /// construction failed, in which case wasm evaluation fails closed. See
    /// [`Self::wasm_host`].
    wasm_host: OnceLock<Option<Arc<WasmPolicyHost>>>,
    /// Live traffic bus for `GET /v1/traffic`. Every audit record published via
    /// [`Self::log_audit`] is also broadcast here (redacted), so the desktop's
    /// live dashboard needs no polling. Inert when no subscriber is connected.
    pub traffic: TrafficBus,
    /// Highest local audit row id acknowledged by the control plane reporter.
    /// The cursor advances only after a successful ingest response, allowing a
    /// retry to reuse the same idempotency key when a response is lost.
    pub report_cursor: AtomicI64,
    /// Violation events awaiting the control plane (`crate::violations`):
    /// `violations.db` beside the audit database with its own delivery
    /// cursor, so an audit backlog never delays a strike signal. In memory
    /// when auditing is disabled.
    pub violations: Arc<crate::audit::ViolationOutbox>,
    /// Open per-credential usage windows (spec 04.4), folded from every
    /// model-call row [`Self::log_audit_with`] records on a Ryu-operated
    /// Gateway and drained into `violations` once their minute closes.
    pub usage_windows: crate::usage_windows::UsageWindows,
    /// The hazard screener runtime (`crate::screening`): the configured
    /// backends behind their breakers, the active chain and the degraded
    /// throttle. Built from `[screening]` at startup; tests swap in one over
    /// deterministic backends.
    pub screening: Arc<crate::screening::ScreeningRuntime>,
}

pub type SharedState = Arc<AppState>;

/// The Gateway component key's content cipher for one store, or why it is
/// unavailable. Tests get the fixed test key the config fixtures use.
fn gateway_content_cipher(store: &str) -> Result<ryu_crypto::ContentCipher, String> {
    #[cfg(test)]
    crate::config::test_config_path::ensure_test_seal_key();
    ryu_crypto::component_cipher_for_process(ryu_crypto::components::GATEWAY)
        .map(|component| component.content_cipher(store))
        .map_err(|error| error.to_string())
}

/// Spend counters stored as `spend.db` beside the audit database, or in
/// memory when auditing is disabled (no durable store exists to sit beside).
fn spend_store_beside(
    audit_db_path: Option<&str>,
) -> Result<Arc<dyn crate::budget::SpendStore>, String> {
    let Some(audit_db_path) = audit_db_path else {
        return Ok(Arc::new(crate::budget::MemorySpendStore::new()));
    };
    let path = std::path::Path::new(audit_db_path).with_file_name(crate::budget::SPEND_STORE);
    // Subject ids are stored as blind tokens under the Gateway component key;
    // without that key (or under another one) the store opens unhealthy and
    // metered requests are refused rather than counted from zero.
    let seal = gateway_spend_seal();
    Ok(Arc::new(crate::budget::SqliteSpendStore::open(
        &path, seal,
    )?))
}

/// The Gateway component key's seal for `spend.db` subjects.
fn gateway_spend_seal() -> Result<crate::budget::SpendSeal, String> {
    #[cfg(test)]
    crate::config::test_config_path::ensure_test_seal_key();
    let component = ryu_crypto::component_cipher_for_process(ryu_crypto::components::GATEWAY)
        .map_err(|error| error.to_string())?;
    Ok(crate::budget::SpendSeal::new(
        component.content_cipher(crate::budget::SPEND_STORE),
        component.blind_index(crate::budget::SPEND_STORE, crate::budget::SUBJECT_FIELD),
    ))
}

/// Apply one inverted stage's config-selected active backend, failing closed
/// when the id is not registered (W6a). An empty `available` set is an
/// intentionally-disabled stage (semantic_cache when off): a default `"builtin"`
/// request is a no-op, any other id is an error. Otherwise `apply(id)` runs the
/// registry's `set_active`, and a `false` return (unknown id) becomes a
/// startup-refusing error that lists the registered ids so a typo is diagnosable.
fn select_stage_backend(
    stage: &str,
    requested: &str,
    available: Vec<String>,
    apply: impl FnOnce(&str) -> bool,
) -> Result<(), String> {
    if available.is_empty() {
        if requested == crate::config::default_stage_backend() {
            return Ok(());
        }
        return Err(format!(
            "gateway stage '{stage}': backend '{requested}' is not registered \
             (stage is disabled; no backends available)"
        ));
    }
    if apply(requested) {
        Ok(())
    } else {
        Err(format!(
            "gateway stage '{stage}': unknown backend '{requested}'; \
             registered backends: [{}]",
            available.join(", ")
        ))
    }
}

/// Register the `"redis"` exact/semantic cache backends when a Redis URL is
/// configured (`RYU_GATEWAY_REDIS_URL`), and build the `/v1/embeddings` cache.
/// Runs before [`apply_stage_backends`], so `[backends] cache = "redis"` (or
/// `semantic_cache = "redis"`) selects them and an unset URL fails closed with
/// the registered ids listed. The semantic backend registers only when the
/// semantic cache is enabled, keeping a disabled stage's registry empty.
fn build_redis_caches(
    config: &GatewayConfig,
    redis_url: Option<&str>,
    cache: &mut CacheRegistry,
    semantic_cache: &mut SemanticCacheRegistry,
) -> Result<Option<ryu_gw_cache::EmbeddingCache>, String> {
    use ryu_gw_cache::{RedisExactCache, RedisSemanticCache, REDIS_BACKEND_ID};

    let client = redis_url
        .map(|url| config.redis_cache.client(url))
        .transpose()?;
    if let Some(client) = &client {
        cache.register(
            REDIS_BACKEND_ID,
            Arc::new(RedisExactCache::new(
                Arc::clone(client),
                &config.redis_cache,
                &config.cache,
            )),
        );
        if config.semantic_cache.enabled {
            semantic_cache.register(
                REDIS_BACKEND_ID,
                Arc::new(RedisSemanticCache::new(
                    Arc::clone(client),
                    &config.redis_cache,
                    config.semantic_cache.clone(),
                    config.cache.ttl_secs,
                    config.cache.max_entries,
                )),
            );
        }
    }
    ryu_gw_cache::EmbeddingCache::from_config(
        &config.embedding_cache,
        client
            .as_ref()
            .map(|client| (Arc::clone(client), config.redis_cache.key_prefix.as_str())),
    )
}

/// Apply the per-stage backend selection to freshly-built registries, failing
/// closed on any unknown id. Shared by [`AppState::new`] and `new_for_test` so
/// the two constructors cannot drift. Budget's registry hot-swaps through
/// `&self`; the rest take `&mut self`, so this runs during construction on owned
/// locals before they move into `AppState`.
#[allow(clippy::too_many_arguments)]
fn apply_stage_backends(
    cfg: &crate::config::StageBackendsConfig,
    budget: &BudgetRegistry,
    cache: &mut CacheRegistry,
    semantic_cache: &mut SemanticCacheRegistry,
    audit: &mut AuditRegistry,
    evals: &mut EvalsRegistry,
    circuit_breaker: &mut CircuitBreakerRegistry,
    rate_limiter: &mut RateLimiterRegistry,
    firewall: &FirewallRegistry,
    router: &RouterRegistry,
    smart_router: &SmartRouterRegistry,
    passthrough: &PassthroughRegistry,
) -> Result<(), String> {
    let avail = budget.available();
    select_stage_backend("budget", &cfg.budget, avail, |id| budget.set_active(id))?;
    let avail = cache.available();
    select_stage_backend("cache", &cfg.cache, avail, |id| cache.set_active(id))?;
    let avail = semantic_cache.available();
    select_stage_backend("semantic_cache", &cfg.semantic_cache, avail, |id| {
        semantic_cache.set_active(id)
    })?;
    let avail = audit.available();
    select_stage_backend("audit", &cfg.audit, avail, |id| audit.set_active(id))?;
    let avail = evals.available();
    select_stage_backend("evals", &cfg.evals, avail, |id| evals.set_active(id))?;
    let avail = circuit_breaker.available();
    select_stage_backend("circuit_breaker", &cfg.circuit_breaker, avail, |id| {
        circuit_breaker.set_active(id)
    })?;
    let avail = rate_limiter.available();
    select_stage_backend("rate_limit", &cfg.rate_limit, avail, |id| {
        rate_limiter.set_active(id)
    })?;
    // W6c: the four newly-inverted stages, same fail-closed selection. These
    // registries carry their own internal RwLock, so `set_active` takes `&self`.
    let avail = firewall.available();
    select_stage_backend("firewall", &cfg.firewall, avail, |id| {
        firewall.set_active(id)
    })?;
    let avail = router.available();
    select_stage_backend("router", &cfg.router, avail, |id| router.set_active(id))?;
    let avail = smart_router.available();
    select_stage_backend("smart_router", &cfg.smart_router, avail, |id| {
        smart_router.set_active(id)
    })?;
    let avail = passthrough.available();
    select_stage_backend("passthrough", &cfg.passthrough, avail, |id| {
        passthrough.set_active(id)
    })?;
    Ok(())
}

impl AppState {
    /// A self-hosted state for tests. Fleet-only provider slots stay off.
    #[cfg(test)]
    pub fn new(config: GatewayConfig) -> Result<Self, String> {
        Self::new_with_custody(config, crate::custody::GatewayCustody::SelfHosted)
    }

    /// Build the state for the custody `main` detected at boot, so the
    /// provider registry (and every reload of it) is built for that custody.
    pub fn new_with_custody(
        config: GatewayConfig,
        custody: crate::custody::GatewayCustody,
    ) -> Result<Self, String> {
        let quota = Arc::new(ProviderQuotas::new());
        let egress = crate::egress::EgressPools::new(&config.egress)?;
        let environment = config
            .provider_environment
            .as_ref()
            .map(|environment| environment.values().clone())
            .unwrap_or_else(crate::providers::sdk_environment);
        let providers = ProviderRegistry::build_with_environment(
            &config.providers,
            Some(&egress),
            Arc::clone(&quota),
            &environment,
            custody,
        );
        let provider_pools = crate::provider_pools::ProviderPools::new(&config.routing)?;
        crate::web_pools::WebServicePools::new(&config.routing)?;
        let web_pricing = crate::web_config::WebPricingSnapshot::new(
            config.credits.web_service_prices.clone(),
            &config.credits,
        )?;
        let router = RouterRegistry::new(config.routing.clone());
        let smart_router = SmartRouterRegistry::new(config.routing.smart_routing.clone());
        let firewall = FirewallRegistry::new(config.firewall.clone());
        let passthrough = PassthroughRegistry::new();
        let resolver = FirewallResolver::new(config.firewall.clone());
        // Reload standalone org/agent overlays persisted to gateway.toml (FIX 4)
        // so they survive a gateway restart instead of resetting to empty.
        resolver.seed_overlays(
            &config.firewall_org_overlays,
            &config.firewall_agent_overlays,
        );
        let mut rate_limiter = RateLimiterRegistry::new(config.rate_limit.clone());
        let mut cache = CacheRegistry::new(config.cache.clone());
        let mut circuit_breaker = CircuitBreakerRegistry::new(config.circuit_breaker.clone());
        let admission = ConcurrencyLimiter::new(&config.concurrency);
        let skills = SkillsRegistry::new(config.skills.skills.clone());

        let audit_logger = AuditLogger::new(&config.audit)
            .map_err(|error| format!("audit initialization failed: {error}"))?;
        let spend_store = spend_store_beside(audit_logger.db_path())
            .map_err(|error| format!("spend counter initialization failed: {error}"))?;
        let violations = crate::violations::outbox_beside(audit_logger.db_path())?;
        let mut audit = AuditRegistry::from_logger(audit_logger);
        let budget = BudgetRegistry::with_store(config.budgets.clone(), Arc::clone(&spend_store));
        let exec_budget = ExecBudgetEnforcer::new(config.exec_budget.clone());
        let mut evals = EvalsRegistry::new(config.evals.clone());
        validate_online_evals(&config)?;
        let (online_evals, online_eval_receiver) =
            crate::evals::online::OnlineEvals::new(&config.evals.online);
        let live_custom_evaluators = Arc::new(config.custom_evaluators.clone());
        let shared_budget = SharedBudgetState::default();
        let metrics = Metrics::default();

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("failed to build HTTP client");

        let composio = if config.composio.enabled {
            // The project API key is a custom header. A redirect must never
            // forward it to a different host, including during account lookup.
            let composio_http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|error| format!("Composio HTTP client initialization failed: {error}"))?;
            Some(ComposioClient::new(config.composio.clone(), composio_http))
        } else {
            None
        };
        let treg = if config.treg.enabled {
            TregClient::from_config(&config.treg, http.clone())
        } else {
            None
        };
        let connections = crate::connections::ConnectionRegistry::new();
        select_stage_backend(
            "connections",
            &config.backends.connections,
            connections.available(),
            |id| connections.set_selected(id),
        )?;

        // Unified tool catalog client (#475): wired only when Core is configured
        // (CORE_URL â†’ providers.core). Without it the tool loop is inert.
        let tools = config
            .providers
            .core
            .as_ref()
            .map(|core| ToolSearchClient::new(core, http.clone()));

        let mut semantic_cache = if config.semantic_cache.enabled {
            SemanticCacheRegistry::from_cache(SemanticCache::new(
                config.semantic_cache.clone(),
                config.cache.ttl_secs,
                config.cache.max_entries,
            ))
        } else {
            SemanticCacheRegistry::disabled()
        };
        let embedding_cache = build_redis_caches(
            &config,
            ryu_gw_cache::redis_url_from_env().as_deref(),
            &mut cache,
            &mut semantic_cache,
        )
        .map_err(|error| format!("cache initialization failed: {error}"))?;

        // Apply the config-selected active backend for every inverted stage,
        // failing closed (a startup-refusing error) on an unknown id. Runs on the
        // freshly-built registries before they move into `Self`, so the &mut
        // `set_active` verbs are reachable. This is what makes the 8 stage
        // registries load-bearing instead of always-BUILTIN dead code.
        apply_stage_backends(
            &config.backends,
            &budget,
            &mut cache,
            &mut semantic_cache,
            &mut audit,
            &mut evals,
            &mut circuit_breaker,
            &mut rate_limiter,
            &firewall,
            &router,
            &smart_router,
            &passthrough,
        )?;

        // Resolve the declarative pipeline order at config-apply time (fail-closed:
        // a config that violates a safety invariant refuses startup). Done here so
        // the request path never resolves it.
        let stage_order = crate::pipeline::stages::StageOrder::resolve(&config.pipeline)
            .map_err(|e| format!("gateway pipeline order: {e}"))?;

        let auth = config.auth.clone();
        // Sealed under the Gateway content key; an unreadable journal is moved
        // aside instead of refusing startup (see `phone_calls`).
        let journal_cipher = gateway_content_cipher(crate::phone_calls::JOURNAL_STORE);
        let screening_config = config.screening.clone();
        let phone_calls = PhoneCallHub::with_journal(
            crate::phone_calls::journal_path(
                crate::config::GatewayConfig::config_path().as_deref(),
                journal_cipher.as_ref().ok(),
            ),
            journal_cipher,
        );

        Ok(Self {
            stage_order,
            provider_runtime: ProviderRuntime::from_parts(
                config.providers.clone(),
                config.routing.clone(),
                config.egress.clone(),
                environment,
                providers,
                router,
                provider_pools,
                egress,
                quota,
                crate::providers::ProviderInputs::from_loaded(&config),
                web_pricing,
            ),
            config,
            smart_router,
            per_agent_routers: crate::router::smart::bounded::BoundedCache::new(64),
            firewall,
            passthrough,
            resolver,
            rate_limiter,
            cache,
            circuit_breaker,
            admission,
            skills,
            response_states: ResponsesStore::default(),
            audit,
            budget,
            spend_store,
            org_rate: crate::rate_limit::ScopedRateLimiter::default(),
            abuse_in_flight: Arc::default(),
            user_jwt: crate::policy::UserJwtVerifier::from_env(),
            policy_version: RwLock::new(None),
            exec_budget,
            evals,
            online_evals,
            online_eval_receiver: std::sync::Mutex::new(online_eval_receiver),
            custom_evaluators: RwLock::new(live_custom_evaluators),
            shared_budget,
            wallet: Arc::new(WalletState::default()),
            pool_allowances: Arc::default(),
            own_supply: Arc::default(),
            custody,
            identity_keys: Arc::new(crate::identity::IdentityKeys::local()),
            metrics,
            composio,
            treg,
            connections,
            tools,
            semantic_cache,
            embedding_cache,
            auth: RwLock::new(auth),
            resolve_cache: ResolveCache::from_env(http.clone()),
            enforcement_push_secret: crate::standing::internal_secret_from_env(),
            platform_floor: crate::platform_floor::FloorStore::default(),
            user_policy: crate::policy::UserPolicyCache::from_env(http.clone()),
            http,
            policy: RwLock::new(EffectivePolicy::default()),
            jobs: MediaJobStore::new(),
            phone_calls,
            channel_pairing: OnceLock::new(),
            wasm_host: OnceLock::new(),
            traffic: TrafficBus::new(),
            report_cursor: AtomicI64::new(0),
            violations,
            usage_windows: crate::usage_windows::UsageWindows::new(),
            screening: Arc::new(crate::screening::ScreeningRuntime::from_config(
                &screening_config,
                &|name| std::env::var(name).ok(),
            )),
        })
    }

    /// The lazily-constructed WASM policy host. Returns `None` only if the wasmtime
    /// engine could not be built (wasm evaluation then fails closed for security
    /// policies). Construction â€” including the epoch ticker thread â€” happens at most
    /// once, on the first request that references a `Wasm` evaluator; a gateway
    /// without any wasm policy never pays for it.
    pub fn wasm_host(&self) -> Option<&Arc<WasmPolicyHost>> {
        self.wasm_host
            .get_or_init(|| match WasmPolicyHost::new() {
                Ok(h) => Some(Arc::new(h)),
                Err(e) => {
                    tracing::error!("failed to build WASM policy host: {e}");
                    None
                }
            })
            .as_ref()
    }

    /// The merged evaluator catalog (built-ins + the live custom evaluators).
    /// Every request-time and API call site reads through this so a custom
    /// evaluator saved by `PUT /v1/config` applies without a restart.
    pub fn evaluator_registry(&self) -> crate::evaluators::EvaluatorRegistry {
        crate::evaluators::EvaluatorRegistry::from_custom(&self.live_custom_evaluators())
    }

    /// The live user-authored evaluator set (not the startup config snapshot).
    pub fn live_custom_evaluators(&self) -> Arc<Vec<crate::evaluators::Evaluator>> {
        self.custom_evaluators
            .read()
            .map(|custom| Arc::clone(&custom))
            .unwrap_or_else(|poisoned| Arc::clone(&poisoned.into_inner()))
    }

    /// Swap the live custom-evaluator set (called after `PUT /v1/config`
    /// validated and persisted it).
    pub fn update_custom_evaluators(&self, custom: Vec<crate::evaluators::Evaluator>) {
        let next = Arc::new(custom);
        match self.custom_evaluators.write() {
            Ok(mut guard) => *guard = next,
            Err(poisoned) => *poisoned.into_inner() = next,
        }
    }

    /// Snapshot the current effective policy. Cheap clone; a poisoned policy
    /// lock returns an unavailable policy so managed requests fail closed.
    pub fn policy_snapshot(&self) -> EffectivePolicy {
        self.policy
            .read()
            .map(|policy| policy.clone())
            .unwrap_or_else(|_| EffectivePolicy {
                available: false,
                ..EffectivePolicy::default()
            })
    }

    /// Replace the effective policy (called by the control-plane refresh task).
    pub fn set_policy(&self, policy: EffectivePolicy) {
        if let Ok(mut guard) = self.policy.write() {
            *guard = policy;
        }
    }

    /// Apply a fresh resolution of this gateway's own key: swap in its policy
    /// and record its `policyVersion`. When the version changed, cached
    /// per-token resolutions for the same org are dropped so new policy and
    /// limits reach hosted traffic on the next request instead of after the
    /// positive TTL. Returns whether the version changed.
    pub fn apply_resolved_policy(&self, resolved: crate::policy::ResolvedOrg) -> bool {
        self.observe_platform_floor(&resolved);
        // A standing that refuses this gateway's own key installs a policy
        // that permits nothing, never the (possibly empty) body it came with.
        let mut policy = resolved.policy;
        if resolved.standing.refusal(self.custody).is_some() {
            policy.available = false;
            tracing::warn!(
                state = ?resolved.standing.state,
                "policy: this gateway's own key is refused by its platform standing"
            );
        }
        self.set_policy(policy);
        let mut guard = self
            .policy_version
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let changed = guard.is_some() && *guard != resolved.policy_version;
        *guard = resolved.policy_version;
        drop(guard);
        if changed {
            if let Some(cache) = self.resolve_cache.as_ref() {
                let dropped = cache.invalidate_org(&resolved.org_id);
                tracing::info!(
                    dropped,
                    "policy: version changed; refreshed cached resolutions"
                );
            }
        }
        changed
    }

    /// Keep the platform floor a resolve carried when it is newer than the
    /// one held (see [`crate::platform_floor::FloorStore::observe`]). Called
    /// for this gateway's own key and for every dynamically resolved `rgw_`
    /// bearer. A changed floor drops every cached scanner, since each was
    /// compiled against the old one.
    pub fn observe_platform_floor(&self, resolved: &crate::policy::ResolvedOrg) {
        let Some(floor) = resolved.platform_floor.as_ref() else {
            return;
        };
        let newer = self
            .platform_floor
            .current()
            .is_none_or(|current| current.version < floor.version);
        // A `screener` this replica cannot apply (a role naming a backend it
        // has no endpoint for, a remote processor without its record, a role
        // that cannot cover a hard code) rejects the whole floor: the previous
        // one stays and a `screening_degraded` event fires.
        if newer {
            if let Some(screener) = floor.screener.as_deref() {
                if let Err(reason) = self.screening.validate_floor(screener) {
                    tracing::warn!(
                        version = floor.version,
                        reason,
                        "platform floor: rejected as a whole"
                    );
                    crate::screening::publish_degraded(
                        &self.traffic,
                        serde_json::json!({
                            "reason": "floor_rejected",
                            "floorVersion": floor.version,
                            "detail": reason,
                        }),
                    );
                    return;
                }
            }
        }
        if self.platform_floor.observe(Some(floor)) {
            self.resolver.invalidate_cache();
        }
    }

    /// The last `policyVersion` reported for this gateway's own key.
    pub fn policy_version(&self) -> Option<String> {
        self.policy_version
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Clone the current global smart router out under a brief read lock. The
    /// returned `Arc` holds no lock, so the async request path
    /// ([`crate::pipeline::apply_smart_routing`]) can keep it across the classifier
    /// `.await`. Recovers from a poisoned lock by returning the inner value.
    pub fn smart_router(&self) -> std::sync::Arc<dyn SmartRouterBackend> {
        self.smart_router.active()
    }

    /// Hot-swap the global smart router with one built from a new
    /// [`crate::config::SmartRoutingConfig`]. Called by `PUT /v1/config` when the
    /// patch carries `routing`, so a smart-routing toggle (or an updated ruleset)
    /// takes effect on the request path with **no gateway restart** â€” the same
    /// live-swap discipline as [`Self::update_firewall_config`].
    ///
    /// Rebuilding drops the per-session decision cache (like the firewall scanner
    /// swap resets its compiled state); this is intentional and cheap. Only
    /// `smart_routing` swaps here â€” `model_map` / `fallback_chain` / `provider_tiers`
    /// live in [`Self::router`] (a startup snapshot) and remain restart-only.
    pub fn update_smart_router(&self, cfg: crate::config::SmartRoutingConfig) {
        self.smart_router.update_config(cfg);
    }

    /// Hot-swap the firewall scanner with a new config. Called by PUT /v1/config.
    /// The existing scanner is replaced atomically; in-flight requests that already
    /// acquired a read guard finish with the old config. Also updates the
    /// resolver's node base and invalidates its scanner cache so every resolved
    /// (nodeâ†’orgâ†’agent) scanner picks up the new baseline.
    pub fn update_firewall_config(&self, cfg: FirewallConfig) {
        self.firewall.update_config(cfg.clone());
        self.resolver.set_node_base(cfg);
    }

    /// Build the per-request control-plane [`PolicyBundle`] from the request's
    /// resolved policy (the dynamic `rgw_`-token tenant path) or the global
    /// startup policy, mirroring the pipeline's `resolved_policy || snapshot`
    /// fallback. On fleet custody it also carries the platform floor, which
    /// binds every request there. Returns `None` when nothing carries any
    /// firewall overlay, so the resolver falls back to its standalone-local
    /// overlay store.
    fn request_bundle(&self, ctx: &RequestContext) -> Option<PolicyBundle> {
        let policy = ctx
            .resolved_policy
            .clone()
            .unwrap_or_else(|| self.policy_snapshot());
        let bundle = PolicyBundle {
            platform_floor: crate::platform_floor::binding_floor(
                self.custody,
                &self.platform_floor,
            ),
            firewall: policy.firewall.clone(),
            team_firewall: policy.team_firewall.clone(),
            agent_overlays: policy.agent_overlays.clone(),
        };
        if bundle.is_empty() {
            None
        } else {
            Some(bundle)
        }
    }

    /// Resolve the per-request firewall scanner for `ctx` (node â†’ org â†’ agent),
    /// returning a shared, cached [`FirewallScanner`]. The returned `Arc` holds
    /// no lock, so it is safe to keep across an `.await` (the inspector needs to).
    pub fn resolved_scanner(&self, ctx: &RequestContext) -> Arc<FirewallScanner> {
        let bundle = self.request_bundle(ctx);
        // The node's OWN extra rules, as the narrowest scope. Clamped here rather
        // than read raw: the resolver applies it under locked = every field, so it
        // can only tighten, and `clamp_firewall` is what enforces the node's
        // `allow_request_override` lever and the size caps before it gets there.
        //
        // `pre_process` calls this ONCE at the top and shares the returned `Arc`
        // across the regex scan, the inspector's `.await`, the locked-guardrail
        // scan and companion redaction â€” so the request overlay lands on all four
        // with no second resolution.
        let (request_overlay, _dropped) = crate::pipeline::node_routing::clamp_firewall(
            ctx.node_routing.as_ref(),
            &self.config.node_routing,
        );
        self.resolver.scanner_for_request(
            ctx.org_id.as_deref(),
            ctx.agent_id.as_deref(),
            bundle.as_ref(),
            request_overlay.as_ref(),
        )
    }

    /// The resolved firewall scanner for the loopback subscription passthrough,
    /// which carries no Gateway credential and so has no org or request scope:
    /// node base → the global control-plane org overlay (or the standalone local
    /// overlay) → the node's tighten-only team overlay → the agent overlay when a
    /// trusted forwarder named the agent. It
    /// is the scanner the chat path resolves for an anonymous request, so
    /// overlays and custom patterns apply to agent passthrough traffic too.
    pub fn passthrough_scanner(&self, agent_id: Option<&str>) -> Arc<FirewallScanner> {
        let policy = self.policy_snapshot();
        let bundle = PolicyBundle {
            platform_floor: crate::platform_floor::binding_floor(
                self.custody,
                &self.platform_floor,
            ),
            firewall: policy.firewall.clone(),
            team_firewall: policy.team_firewall.clone(),
            agent_overlays: policy.agent_overlays.clone(),
        };
        let bundle = (!bundle.is_empty()).then_some(bundle);
        self.resolver
            .scanner_for_request(None, agent_id, bundle.as_ref(), None)
    }

    /// Borrow the per-request *resolved* firewall scanner for the duration of a
    /// closure. The per-agent analogue of [`Self::with_firewall`]: it resolves
    /// the nodeâ†’orgâ†’agent cascade from `ctx` and hands a cached scanner to `f`.
    ///
    /// The chat inbound/locked/companion paths call [`Self::resolved_scanner`]
    /// directly to share ONE resolution (and its `Arc`) across the regex scan,
    /// the inspector's `.await`, the locked-guardrail scan, and companion
    /// redaction; this closure form is provided for single-shot call sites.
    #[allow(dead_code)]
    pub fn with_resolved_firewall<F, T>(&self, ctx: &RequestContext, f: F) -> T
    where
        F: FnOnce(&FirewallScanner) -> T,
    {
        let scanner = self.resolved_scanner(ctx);
        f(&scanner)
    }

    /// Hot-swap the budget enforcer with a new config. Called by PUT /v1/config.
    /// In-memory usage counters reset on swap â€” this is intentional: lifetime
    /// counters are ephemeral by design (see budget/mod.rs module comment).
    pub fn update_budget_config(&self, cfg: BudgetConfig) {
        self.budget.update_config(cfg);
    }

    /// Replace the `api_keys` list in the live auth config. Called by PUT /v1/config.
    /// The master_key and require_auth flag are unchanged â€” they are startup-only.
    pub fn update_auth_config(&self, mut api_keys: Vec<ApiKeyConfig>) {
        // Host-provisioned relays are bootstrap credentials, not user-editable
        // API keys. Preserve their original authority even if a config patch
        // omits them or submits the same bearer with trusted_forwarder changed.
        for managed in self
            .config
            .auth
            .api_keys
            .iter()
            .filter(|entry| entry.is_system_relay())
        {
            api_keys.retain(|entry| entry.key != managed.key && entry.name != managed.name);
            api_keys.push(managed.clone());
        }
        if let Ok(mut guard) = self.auth.write() {
            guard.api_keys = api_keys;
        }
    }

    /// The gateway's single audit chokepoint: persists the record to the active
    /// audit backend AND broadcasts a redacted copy to the live traffic bus.
    /// Every audit call site funnels through here, so the `GET /v1/traffic` feed
    /// can never miss a request the audit store recorded (and vice-versa).
    pub fn log_audit(&self, record: crate::audit::AuditRecord) {
        let outcome = crate::traffic::TrafficOutcome::inferred(&record);
        self.log_audit_with(record, outcome);
    }

    /// [`Self::log_audit`] for a row whose outcome the caller knows: a
    /// guardrail verdict, or a failure and the error it returned. The live
    /// event is published even when the audit store is disabled, so blocks
    /// and rate limits stay visible on the feed.
    pub fn log_audit_with(
        &self,
        record: crate::audit::AuditRecord,
        outcome: crate::traffic::TrafficOutcome,
    ) {
        if record.event_type == crate::audit::EventType::ServiceCall {
            tracing::warn!("service audit requires validated service usage");
            return;
        }
        let event = self.traffic.enrich(
            crate::traffic::traffic_event(&record),
            &record,
            outcome,
            self.custody,
        );
        if crate::usage_windows::window_reporting_active(self.custody, &self.config.control_plane) {
            let cost = crate::reporter::record_cost_micro_usd(&record, &self.config);
            self.usage_windows
                .observe(self.custody, &record, &event, cost);
        }
        self.traffic.publish(event);
        self.audit.log(record);
    }

    /// The gateway's single violation chokepoint, beside [`Self::log_audit`]
    /// (spec 03.4.3). Fills the identity from `ctx` (the TENANT org, the
    /// presenting credential, the actor and every hashed subject), redacts
    /// and bounds the excerpt, hashes the evidence, and writes the event to
    /// the violation outbox, which the reporter drains with its own cursor.
    /// Call it only in verdict branches, never for transport or budget
    /// errors. Returns the event id when a new event was stored, or when an
    /// unreported event with the same `dedupeKey` took this stronger action;
    /// any other repeat of the key returns `None`.
    pub fn record_violation(
        &self,
        ctx: &RequestContext,
        input: crate::violations::VerdictInput,
    ) -> Option<String> {
        let redact = |text: &str| {
            self.with_firewall(|fw| {
                let sanitized = fw.sanitize(text);
                fw.redact_outbound(&sanitized).0
            })
        };
        // A stream cut is recorded after its handler returned, outside the
        // route scope; the route the request noted then stands in.
        let route =
            crate::traffic::current_route().or_else(|| self.traffic.noted_route(&ctx.request_id));
        let (event, excerpt) = crate::violations::build_event(
            self.custody,
            &self.identity_keys,
            &redact,
            ctx,
            route,
            input,
        );
        match self.violations.record(&event, excerpt.as_deref()) {
            Ok(crate::audit::RecordOutcome::Inserted) => Some(event.event_id),
            Ok(crate::audit::RecordOutcome::Upgraded { event_id }) => Some(event_id),
            Ok(crate::audit::RecordOutcome::Duplicate) => None,
            Err(error) => {
                tracing::error!(
                    request_id = %ctx.request_id,
                    category = %event.category,
                    "violation event not stored: {error}"
                );
                None
            }
        }
    }

    /// The custom pattern names each firewall layer contributes to `ctx`'s
    /// scanner, so a firewall match can be attributed to the layer that
    /// declared it on the live feed. Read only when a match happened.
    pub(crate) fn firewall_layers(&self, ctx: &RequestContext) -> crate::traffic::FirewallLayers {
        fn names(overlay: Option<&crate::config::FirewallOverlay>) -> Vec<String> {
            overlay
                .map(|overlay| {
                    overlay
                        .custom_patterns
                        .iter()
                        .map(|p| p.name.clone())
                        .collect()
                })
                .unwrap_or_default()
        }
        let bundle = self.request_bundle(ctx);
        let floor = bundle.as_ref().and_then(|b| b.platform_floor.as_deref());
        let org = bundle
            .as_ref()
            .and_then(|b| b.firewall.clone())
            .or_else(|| {
                ctx.org_id
                    .as_deref()
                    .and_then(|id| self.resolver.org_overlays().get(id).cloned())
            });
        let agent = bundle
            .as_ref()
            .and_then(|b| {
                ctx.agent_id
                    .as_deref()
                    .and_then(|id| b.agent_overlays.get(id).cloned())
            })
            .or_else(|| {
                ctx.agent_id
                    .as_deref()
                    .and_then(|id| self.resolver.agent_overlays().get(id).cloned())
            });
        let mut org_patterns = names(org.as_ref());
        org_patterns.extend(names(
            bundle.as_ref().and_then(|b| b.team_firewall.as_ref()),
        ));
        let (request_overlay, _dropped) = crate::pipeline::node_routing::clamp_firewall(
            ctx.node_routing.as_ref(),
            &self.config.node_routing,
        );
        let mut node_patterns: Vec<String> = self
            .resolver
            .node_base()
            .custom_patterns
            .iter()
            .map(|p| p.name.clone())
            .collect();
        node_patterns.extend(names(request_overlay.as_ref()));
        crate::traffic::FirewallLayers {
            floor_scans_inbound: floor.is_some_and(|floor| {
                floor.overlay.enabled == Some(true) && floor.overlay.scan_inbound != Some(false)
            }),
            floor_patterns: names(floor.map(|floor| &floor.overlay)),
            org_patterns,
            agent_patterns: names(agent.as_ref()),
            node_patterns,
        }
    }

    pub fn log_audit_service(
        &self,
        record: crate::audit::AuditRecord,
        usage: crate::audit::AuditServiceUsage,
    ) -> Result<(), crate::audit::ServiceAuditError> {
        let safe = crate::audit::normalize_service_audit_record(record, &usage)?;
        let event = self.traffic.enrich(
            crate::traffic::service_traffic_event(&safe, &usage)?,
            &safe,
            crate::traffic::TrafficOutcome::inferred(&safe),
            self.custody,
        );
        self.audit.log_service(safe, usage)?;
        self.traffic.publish(event);
        Ok(())
    }

    /// Borrow the auth config for the duration of a closure.
    pub fn with_auth<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&AuthConfig) -> T,
    {
        match self.auth.read() {
            Ok(guard) => f(&*guard),
            Err(poisoned) => f(&*poisoned.into_inner()),
        }
    }

    /// Borrow the firewall scanner for the duration of a closure. Recovers from
    /// a poisoned lock by rebuilding a default scanner rather than panicking.
    pub fn with_firewall<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&dyn crate::firewall::FirewallBackend) -> T,
    {
        self.firewall.with_active(f)
    }

    /// Borrow the budget enforcer for the duration of a closure.
    pub fn with_budget<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&dyn BudgetBackend) -> T,
    {
        self.budget.with_active(f)
    }

    /// Construct a minimal AppState for unit tests, injecting caller-provided
    /// `AuditLogger` and `EvalsRunner` instances so tests can inspect them
    /// after the fact. All other fields are set to their defaults.
    #[cfg(test)]
    pub fn new_for_test_default() -> Self {
        let audit = AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
        Self::new_for_test(GatewayConfig::default(), audit, evals)
    }

    #[cfg(test)]
    pub fn new_for_test(
        config: GatewayConfig,
        audit: AuditLogger,
        evals: crate::evals::EvalsRunner,
    ) -> Self {
        Self::new_for_test_with_custody(
            config,
            audit,
            evals,
            crate::custody::GatewayCustody::SelfHosted,
        )
    }

    /// [`Self::new_for_test`] with the provider registry built for `custody`.
    #[cfg(test)]
    pub fn new_for_test_with_custody(
        config: GatewayConfig,
        audit: AuditLogger,
        evals: crate::evals::EvalsRunner,
        custody: crate::custody::GatewayCustody,
    ) -> Self {
        let quota = Arc::new(ProviderQuotas::new());
        let egress = crate::egress::EgressPools::new(&config.egress)
            .expect("test egress proxy config must be valid");
        let environment = config
            .provider_environment
            .as_ref()
            .map(|environment| environment.values().clone())
            .unwrap_or_else(crate::providers::sdk_environment);
        let providers = ProviderRegistry::build_with_environment(
            &config.providers,
            Some(&egress),
            Arc::clone(&quota),
            &environment,
            custody,
        );
        let provider_pools = crate::provider_pools::ProviderPools::new(&config.routing)
            .expect("test provider pools must be valid");
        crate::web_pools::WebServicePools::new(&config.routing).expect("valid test web pools");
        let web_pricing = crate::web_config::WebPricingSnapshot::new(
            config.credits.web_service_prices.clone(),
            &config.credits,
        )
        .expect("valid test web prices");
        let router = RouterRegistry::new(config.routing.clone());
        let smart_router = SmartRouterRegistry::new(config.routing.smart_routing.clone());
        let firewall = FirewallRegistry::new(config.firewall.clone());
        let passthrough = PassthroughRegistry::new();
        let resolver = FirewallResolver::new(config.firewall.clone());
        // Reload standalone org/agent overlays persisted to gateway.toml (FIX 4)
        // so they survive a gateway restart instead of resetting to empty.
        resolver.seed_overlays(
            &config.firewall_org_overlays,
            &config.firewall_agent_overlays,
        );
        let mut rate_limiter = RateLimiterRegistry::new(config.rate_limit.clone());
        let mut cache = CacheRegistry::new(config.cache.clone());
        let mut circuit_breaker = CircuitBreakerRegistry::new(config.circuit_breaker.clone());
        let admission = ConcurrencyLimiter::new(&config.concurrency);
        let skills = SkillsRegistry::new(config.skills.skills.clone());
        let budget = BudgetRegistry::new(config.budgets.clone());
        let exec_budget = ExecBudgetEnforcer::new(config.exec_budget.clone());
        let shared_budget = SharedBudgetState::default();
        let metrics = Metrics::default();
        let http = reqwest::Client::new();
        let auth = config.auth.clone();
        let mut audit = AuditRegistry::from_logger(audit);
        let mut evals = EvalsRegistry::from_runner(evals);
        let (online_evals, online_eval_receiver) =
            crate::evals::online::OnlineEvals::new(&config.evals.online);
        let live_custom_evaluators = Arc::new(config.custom_evaluators.clone());
        let mut semantic_cache = SemanticCacheRegistry::disabled();
        // Tests never reach a Redis server; an enabled `[embedding_cache]` with
        // the memory store is built as in production.
        let embedding_cache = build_redis_caches(&config, None, &mut cache, &mut semantic_cache)
            .expect("test embedding-cache config is valid");

        // Same fail-closed stage-backend selection as `new`; test configs default
        // to `"builtin"` for every stage, so this cannot fail here.
        apply_stage_backends(
            &config.backends,
            &budget,
            &mut cache,
            &mut semantic_cache,
            &mut audit,
            &mut evals,
            &mut circuit_breaker,
            &mut rate_limiter,
            &firewall,
            &router,
            &smart_router,
            &passthrough,
        )
        .expect("test stage-backend selection defaults to builtin");

        let stage_order = crate::pipeline::stages::StageOrder::resolve(&config.pipeline)
            .expect("test pipeline order defaults to the built-in order");

        Self {
            stage_order,
            provider_runtime: ProviderRuntime::from_parts(
                config.providers.clone(),
                config.routing.clone(),
                config.egress.clone(),
                environment,
                providers,
                router,
                provider_pools,
                egress,
                quota,
                crate::providers::ProviderInputs::from_loaded(&config),
                web_pricing,
            ),
            config,
            smart_router,
            per_agent_routers: crate::router::smart::bounded::BoundedCache::new(64),
            firewall,
            passthrough,
            resolver,
            rate_limiter,
            cache,
            circuit_breaker,
            admission,
            skills,
            response_states: ResponsesStore::default(),
            audit,
            spend_store: budget.store(),
            budget,
            org_rate: crate::rate_limit::ScopedRateLimiter::default(),
            abuse_in_flight: Arc::default(),
            user_jwt: None,
            policy_version: RwLock::new(None),
            exec_budget,
            evals,
            online_evals,
            online_eval_receiver: std::sync::Mutex::new(online_eval_receiver),
            custom_evaluators: RwLock::new(live_custom_evaluators),
            shared_budget,
            wallet: Arc::new(WalletState::default()),
            pool_allowances: Arc::default(),
            own_supply: Arc::default(),
            custody,
            identity_keys: Arc::new(crate::identity::IdentityKeys::local()),
            metrics,
            composio: None,
            connections: crate::connections::ConnectionRegistry::new(),
            treg: None,
            tools: None,
            semantic_cache,
            embedding_cache,
            auth: RwLock::new(auth),
            resolve_cache: None,
            enforcement_push_secret: None,
            // Every existing fleet suite runs with a floor; a test that needs
            // a fleet that never received one clears it.
            platform_floor: crate::platform_floor::FloorStore::with(
                crate::platform_floor::PlatformFloor::compiled_baseline(),
            ),
            user_policy: None,
            http,
            policy: RwLock::new(EffectivePolicy::default()),
            jobs: MediaJobStore::new(),
            phone_calls: PhoneCallHub::default(),
            channel_pairing: OnceLock::new(),
            wasm_host: OnceLock::new(),
            traffic: TrafficBus::new(),
            report_cursor: AtomicI64::new(0),
            violations: Arc::new(
                crate::audit::ViolationOutbox::in_memory().expect("in-memory violation outbox"),
            ),
            usage_windows: crate::usage_windows::UsageWindows::new(),
            // Inert: suites for other gates run unscreened; the screening
            // tests install a live runtime.
            screening: Arc::new(crate::screening::ScreeningRuntime::inert()),
        }
    }
}

#[cfg(test)]
mod stage_backend_selection_tests {
    use super::{apply_stage_backends, select_stage_backend, AppState};
    use crate::cache::{CacheBackend, CacheRegistry};
    use crate::config::{GatewayConfig, StageBackendsConfig};
    use serde_json::{json, Value};
    use std::sync::Arc;

    /// A cache backend that answers every `get` with a fixed sentinel â€” proof the
    /// config-selected backend actually becomes active (not just registered).
    struct StubCache;
    impl CacheBackend for StubCache {
        fn get(&self, _key: &str) -> Option<Value> {
            Some(json!({ "stub": true }))
        }
        fn insert(&self, _key: String, _response: Value) {}
        fn evict_expired(&self) {}
    }

    /// The default config (all `"builtin"`) builds successfully and every inverted
    /// stage is left on its built-in backend â€” the field is read and applied, not
    /// ignored.
    #[test]
    fn default_config_selects_builtin_for_every_stage() {
        let mut config = GatewayConfig::default();
        config.audit.enabled = false;
        let state = AppState::new(config).expect("default stage backends must build");
        assert_eq!(state.cache.active_id(), CacheRegistry::BUILTIN);
        assert_eq!(state.budget.active_id().as_str(), "builtin");
        // W6c: the four newly-inverted stages are read + applied to their built-in.
        assert_eq!(state.firewall.active_id().as_str(), "builtin");
        assert_eq!(
            state
                .provider_runtime
                .snapshot()
                .router
                .active_id()
                .as_str(),
            "builtin"
        );
        assert_eq!(state.smart_router.active_id().as_str(), "builtin");
        assert_eq!(state.passthrough.active_id().as_str(), "builtin");
    }

    #[test]
    fn audit_storage_open_failure_refuses_state_creation() {
        let path = std::env::temp_dir().join(format!("ryu-audit-init-dir-{}", std::process::id()));
        std::fs::create_dir_all(&path).expect("create test directory");
        let mut config = GatewayConfig::default();
        config.audit.enabled = true;
        config.audit.db_path = path.to_string_lossy().into_owned();

        let error = match AppState::new(config) {
            Err(error) => error,
            Ok(_) => panic!("audit directory must not become disabled audit"),
        };
        assert!(error.contains("audit initialization failed"), "{error}");

        std::fs::remove_dir(&path).expect("remove test directory");
    }

    /// A config that names a backend NOT registered in a stage's registry refuses
    /// the whole build (fail-closed), and the error names the stage + the
    /// registered ids so a typo is diagnosable.
    #[test]
    fn unknown_stage_backend_refuses_build() {
        let mut config = GatewayConfig::default();
        config.audit.enabled = false;
        config.backends.cache = "ghost".to_string();
        // `AppState` is not `Debug`, so match rather than `expect_err`.
        let err = match AppState::new(config) {
            Err(e) => e,
            Ok(_) => panic!("unknown backend must refuse startup"),
        };
        assert!(err.contains("cache"), "error names the stage: {err}");
        assert!(err.contains("ghost"), "error names the bad id: {err}");
        assert!(err.contains("builtin"), "error lists registered ids: {err}");
    }

    /// The config value drives `set_active` to a *registered non-builtin* backend:
    /// register a stub under `"stub"`, name it in the config, and the applied
    /// registry dispatches to the stub.
    #[test]
    fn config_selects_a_registered_backend() {
        let mut cache = CacheRegistry::new(crate::config::CacheConfig::default());
        cache.register("stub", Arc::new(StubCache) as Arc<dyn CacheBackend>);
        let budget = crate::budget::BudgetRegistry::new(crate::config::BudgetConfig::default());
        let mut semantic_cache = crate::semantic_cache::SemanticCacheRegistry::disabled();
        let mut audit = crate::audit::AuditRegistry::from_logger(Default::default());
        let mut evals = crate::evals::EvalsRegistry::new(crate::config::EvalsConfig::default());
        let mut circuit_breaker =
            crate::circuit_breaker::CircuitBreakerRegistry::new(Default::default());
        let mut rate_limiter = crate::rate_limit::RateLimiterRegistry::new(Default::default());
        let firewall =
            crate::firewall::FirewallRegistry::new(crate::config::FirewallConfig::default());
        let router = crate::router::RouterRegistry::new(crate::config::RoutingConfig::default());
        let smart_router = crate::router::smart::SmartRouterRegistry::new(
            crate::config::SmartRoutingConfig::default(),
        );
        let passthrough = crate::passthrough::PassthroughRegistry::new();

        let mut cfg = StageBackendsConfig::default();
        cfg.cache = "stub".to_string();
        apply_stage_backends(
            &cfg,
            &budget,
            &mut cache,
            &mut semantic_cache,
            &mut audit,
            &mut evals,
            &mut circuit_breaker,
            &mut rate_limiter,
            &firewall,
            &router,
            &smart_router,
            &passthrough,
        )
        .expect("a registered id must be accepted");

        assert_eq!(cache.active_id(), "stub");
        assert_eq!(cache.get("any-key"), Some(json!({ "stub": true })));
    }

    /// The disabled-stage edge (semantic_cache when off): an empty registry accepts
    /// only the default `"builtin"` no-op; any other id is refused.
    #[test]
    fn disabled_stage_accepts_only_default_builtin() {
        assert!(select_stage_backend("semantic_cache", "builtin", vec![], |_| false).is_ok());
        let err = select_stage_backend("semantic_cache", "redis", vec![], |_| false)
            .expect_err("non-default id on a disabled stage must be refused");
        assert!(
            err.contains("semantic_cache") && err.contains("redis"),
            "{err}"
        );
    }

    /// A Redis URL registers the `"redis"` exact backend (and the semantic one
    /// only when that stage is enabled) so `[backends]` can select it; without a
    /// URL selecting `"redis"` fails closed. Client construction is lazy, so no
    /// server is contacted here.
    #[test]
    fn redis_url_registers_selectable_cache_backends() {
        use super::build_redis_caches;
        use crate::semantic_cache::{SemanticCache, SemanticCacheRegistry};

        let mut config = crate::config::GatewayConfig::default();
        let mut cache = CacheRegistry::new(config.cache.clone());
        let mut semantic = SemanticCacheRegistry::disabled();
        let embedding = build_redis_caches(
            &config,
            Some("redis://127.0.0.1:1/0"),
            &mut cache,
            &mut semantic,
        )
        .expect("valid redis settings");
        assert!(embedding.is_none(), "embedding cache is off by default");
        assert_eq!(cache.available(), vec!["builtin", "redis"]);
        assert!(semantic.available().is_empty());
        assert!(cache.set_active("redis"));

        config.semantic_cache.enabled = true;
        let mut cache = CacheRegistry::new(config.cache.clone());
        let mut semantic = SemanticCacheRegistry::from_cache(SemanticCache::new(
            config.semantic_cache.clone(),
            60,
            10,
        ));
        build_redis_caches(
            &config,
            Some("redis://cache:6379"),
            &mut cache,
            &mut semantic,
        )
        .expect("valid redis settings");
        assert_eq!(semantic.available(), vec!["builtin", "redis"]);

        let mut cache = CacheRegistry::new(config.cache.clone());
        let mut semantic = SemanticCacheRegistry::disabled();
        build_redis_caches(&config, None, &mut cache, &mut semantic).expect("no redis");
        let err = select_stage_backend("cache", "redis", cache.available(), |id| {
            cache.set_active(id)
        })
        .expect_err("redis is not registered without a URL");
        assert!(err.contains("builtin"), "{err}");
    }

    /// `[embedding_cache]` builds the memory store without Redis and refuses the
    /// Redis store when no URL is configured.
    #[test]
    fn embedding_cache_is_built_from_config() {
        use super::build_redis_caches;
        use crate::semantic_cache::SemanticCacheRegistry;

        let mut config = crate::config::GatewayConfig::default();
        config.embedding_cache.enabled = true;
        let mut cache = CacheRegistry::new(config.cache.clone());
        let mut semantic = SemanticCacheRegistry::disabled();
        let built = build_redis_caches(&config, None, &mut cache, &mut semantic)
            .expect("memory store needs no redis");
        assert_eq!(built.expect("enabled").stats().backend, "memory");

        config.embedding_cache.backend = "redis".to_owned();
        let err = build_redis_caches(&config, None, &mut cache, &mut semantic)
            .err()
            .expect("redis store without a URL is refused");
        assert!(err.contains(ryu_gw_cache::REDIS_URL_ENV), "{err}");

        config.redis_cache.key_prefix = "bad prefix".to_owned();
        assert!(build_redis_caches(&config, Some("redis://x"), &mut cache, &mut semantic).is_err());
    }
}

#[cfg(test)]
mod smart_router_swap_tests {
    use super::AppState;
    use crate::config::{RouteStrategy, SmartRoutingConfig, SmartRule};

    /// The routing toggle must take effect on the request path with NO restart:
    /// after `update_smart_router` the gate the pipeline reads
    /// (`state.smart_router().is_active()`, checked in `apply_smart_routing`) must
    /// flip live. This is the gateway-side proof that `PUT /v1/config { routing }`
    /// hot-swaps smart routing instead of requiring a respawn.
    #[test]
    fn update_smart_router_flips_the_request_path_gate_live() {
        // Default config â†’ smart routing disabled â†’ the request path is inert.
        let state = AppState::new_for_test_default();
        assert!(
            !state.smart_router().is_active(),
            "default smart routing must be inactive (fail-open)"
        );

        // Push an ENABLED smart-routing config (a classifier + one rule) â€” exactly
        // what `PUT /v1/config { routing: { smart_routing } }` would apply live.
        let cfg = SmartRoutingConfig {
            strategy: RouteStrategy::Llm,
            enabled: true,
            classifier_model: "gemma-classifier".to_string(),
            rules: vec![SmartRule {
                description: "writing or refactoring code".to_string(),
                model: "claude-sonnet-4-5".to_string(),
                weight: 1.0,
            }],
            ..Default::default()
        };
        state.update_smart_router(cfg);

        assert!(
            state.smart_router().is_active(),
            "the request-path gate must see the new routing flag with no restart"
        );

        // And a subsequent disable swaps it back off, still live.
        state.update_smart_router(SmartRoutingConfig::default());
        assert!(
            !state.smart_router().is_active(),
            "disabling smart routing hot-swaps back to inert"
        );
    }
}

#[cfg(test)]
mod resolved_scanner_request_scope_tests {
    use super::AppState;
    use crate::config::{CustomPattern, CustomPatternKind, FirewallOverlay};
    use crate::pipeline::node_routing::NodeRoutingPrefs;

    /// The seam test the unit tests structurally cannot provide.
    ///
    /// `clamp_firewall` is covered in `pipeline::node_routing`, and
    /// `resolve_with_request` is covered in `firewall::resolve` â€” but both are
    /// called DIRECTLY there. Nothing asserted that `resolved_scanner` actually
    /// joins them, so deleting the `clamp_firewall` call in `resolved_scanner`
    /// left the whole suite green while the node's firewall rules silently stopped
    /// reaching any request. `resolved_scanner` is the seam (it hands the ONE
    /// `Arc` that `pre_process` shares across the regex scan, the inspector await,
    /// the locked-guardrail scan and companion redaction), so it is what to assert
    /// on â€” no `run()` needed.
    #[test]
    fn a_request_scope_firewall_overlay_reaches_the_resolved_scanner() {
        let state = AppState::new_for_test_default();
        let mut ctx = crate::pipeline::test_support::plain_request_context();
        ctx.node_routing = Some(NodeRoutingPrefs {
            fallback: Vec::new(),
            firewall: Some(FirewallOverlay {
                custom_patterns: vec![CustomPattern {
                    name: "acme_internal_id".into(),
                    regex: r"ACME-\d{6}".into(),
                    kind: CustomPatternKind::Pii,
                }],
                ..Default::default()
            }),
            openrouter: None,
            openrouter_model_fallbacks: Vec::new(),
        });

        let scanner = state.resolved_scanner(&ctx);
        assert!(
            scanner
                .config()
                .custom_patterns
                .iter()
                .any(|p| p.name == "acme_internal_id"),
            "the node's own extra rule never reached the per-request scanner"
        );

        // Control: the same state with no preference must be unchanged, so the
        // assertion above is detecting the overlay and not a pre-seeded pattern.
        let bare = crate::pipeline::test_support::plain_request_context();
        assert!(state
            .resolved_scanner(&bare)
            .config()
            .custom_patterns
            .is_empty());
    }

    /// A locked node must not let a request contribute rules at all â€” the clamp
    /// runs inside `resolved_scanner`, so this is where the lever is observable.
    #[test]
    fn a_locked_node_keeps_request_rules_out_of_the_scanner() {
        let mut state = AppState::new_for_test_default();
        state.config.node_routing.allow_request_override = false;
        let mut ctx = crate::pipeline::test_support::plain_request_context();
        ctx.node_routing = Some(NodeRoutingPrefs {
            fallback: Vec::new(),
            firewall: Some(FirewallOverlay {
                custom_patterns: vec![CustomPattern {
                    name: "acme_internal_id".into(),
                    regex: r"ACME-\d{6}".into(),
                    kind: CustomPatternKind::Pii,
                }],
                ..Default::default()
            }),
            openrouter: None,
            openrouter_model_fallbacks: Vec::new(),
        });

        assert!(state
            .resolved_scanner(&ctx)
            .config()
            .custom_patterns
            .is_empty());
    }
}
