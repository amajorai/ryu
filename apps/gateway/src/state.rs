use std::sync::{Arc, OnceLock, RwLock};

use dashmap::DashMap;

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
    pipeline::RequestContext,
    policy::{EffectivePolicy, ResolveCache},
    providers::ProviderRegistry,
    quota::ProviderQuotas,
    rate_limit::RateLimiterRegistry,
    router::{
        smart::{SmartRouter, SmartRouterBackend, SmartRouterRegistry},
        RouterRegistry,
    },
    semantic_cache::{SemanticCache, SemanticCacheRegistry},
    skills::SkillsRegistry,
    tools::ToolSearchClient,
    wasm_policy::WasmPolicyHost,
};

pub struct AppState {
    pub config: GatewayConfig,
    /// Resolved, validated pre-processing stage order (W6d). Built ONCE here at
    /// config-apply time from `config.pipeline` and iterated by
    /// [`crate::pipeline::pre_process`], so the request hot path pays zero
    /// per-request allocation to know the order — it borrows this pre-resolved
    /// slice. Default = [`crate::pipeline::stages::DEFAULT_ORDER`] (the exact
    /// pre-W6d sequence).
    pub stage_order: crate::pipeline::stages::StageOrder,
    pub providers: ProviderRegistry,
    /// Model routing (Plane A) as a swappable registry (W6c decomposition): the
    /// built-in [`crate::router::ModelRouter`] is the default active backend. The
    /// inherent `route`/`route_modality_with_slot`/`fallback_chain`/`eval_route`
    /// methods delegate to the active backend, so `state.router.route(…)` call
    /// sites are unchanged; by-ref consumers take [`RouterRegistry::active`].
    pub router: RouterRegistry,
    /// Classifier-driven model routing (custom routing instructions). Inert
    /// unless `config.routing.smart_routing` is active; holds a per-session
    /// decision cache.
    ///
    /// `RwLock<Arc<…>>` so `PUT /v1/config { routing: { smart_routing … } }` can
    /// **hot-swap** the smart router without a gateway restart — the same live-swap
    /// discipline as `firewall`/`budget`, but Arc-wrapped because
    /// [`SmartRouter::resolve`] is async and is held across an `.await` on the
    /// request path (a read guard cannot be). Callers clone the `Arc` out under a
    /// brief read lock (see [`Self::smart_router`]) and keep it across the await.
    /// Only `routing.smart_routing` swaps here; the [`Self::router`] model-map /
    /// fallback / tiers remain a startup snapshot (restart-only).
    ///
    /// W6c: now a swappable [`SmartRouterRegistry`] (async backend, `Arc`-yielding)
    /// whose built-in is the [`SmartRouter`]. `update_smart_router` hot-swaps the
    /// built-in — the same live-swap the old `RwLock<Arc<SmartRouter>>` gave.
    pub smart_router: SmartRouterRegistry,
    /// Per-agent smart-routing override cache (the "both" config scope: global
    /// `smart_router` is the default, an agent may override it). Keyed by a stable
    /// hash of the override [`SmartRoutingConfig`] JSON that Core injects as the
    /// private `ryu_smart_route` request-body field; each distinct config gets one
    /// ephemeral [`SmartRouter`] so its rule-embedding + session caches are reused
    /// across that agent's turns. Empty until an override is first seen.
    pub per_agent_routers: DashMap<u64, Arc<SmartRouter>>,
    /// `RwLock` so `PUT /v1/config` can hot-swap the scanner without a restart.
    /// This is the **node-level** scanner: it still serves the outbound-scan,
    /// error-redaction, and multimodal paths, and it alone owns the process-global
    /// untrusted-wrapping flag. The per-request *resolved* (node→org→agent)
    /// scanner used by the chat inbound/locked/companion paths comes from
    /// [`Self::resolver`] instead.
    ///
    /// W6c: now a swappable [`FirewallRegistry`] whose built-in is the
    /// [`FirewallScanner`]. `with_firewall` delegates to the active backend;
    /// `update_firewall_config` hot-swaps the built-in — same live-swap as before.
    pub firewall: FirewallRegistry,
    /// Hierarchical firewall resolver (node → org → agent cascade, #hierarchical
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
    /// active backend. HOT primitive — in-process swap only, never IPC.
    pub rate_limiter: RateLimiterRegistry,
    /// Exact-match response cache as a swappable registry (Lg decomposition):
    /// the built-in in-process [`crate::cache::Cache`] is the default active
    /// backend; a plugin backend can register without touching the pipeline.
    pub cache: CacheRegistry,
    /// Per-provider circuit breaker as a swappable registry (Lg decomposition):
    /// the built-in in-process [`crate::circuit_breaker::CircuitBreakers`] is the
    /// default active backend. HOT primitive — in-process swap only, never IPC.
    pub circuit_breaker: CircuitBreakerRegistry,
    /// Live per-provider upstream quota / rate-limit snapshots (#3). Providers
    /// write into it on each completion; `/metrics` reads it for the desktop
    /// cost/quota dashboard. A shared `Arc` so the provider structs can hold a
    /// handle.
    pub quota: Arc<ProviderQuotas>,
    /// Priority admission queue for the resident local engine (interactive ahead
    /// of background fan-out). Inert for remote providers and when disabled.
    /// A startup snapshot of `config.concurrency` (applies on the next restart).
    pub admission: ConcurrencyLimiter,
    pub skills: SkillsRegistry,
    /// Audit sink as a swappable registry (Lg decomposition): the built-in
    /// [`crate::audit::AuditLogger`] is the default active backend.
    pub audit: AuditRegistry,
    /// Token budget enforcer as a swappable, live-swap registry (Lg
    /// decomposition): the built-in [`crate::budget::BudgetEnforcer`] is the
    /// default active backend. `PUT /v1/config` hot-swaps it without a restart
    /// (see [`Self::update_budget_config`]); a plugin backend can register.
    pub budget: BudgetRegistry,
    /// Exec (sandbox/tool) budget enforcer (M6 / #192). Enforces count + wall-clock
    /// limits per rolling window; checked pre-run by Core via `POST /v1/exec/budget/check`.
    pub exec_budget: ExecBudgetEnforcer,
    /// Live eval runner as a swappable registry (Lg decomposition): the built-in
    /// [`crate::evals::EvalsRunner`] is the default active backend.
    pub evals: EvalsRegistry,
    pub shared_budget: SharedBudgetState,
    /// Per-org credit-wallet empty cache (#486). The debit hook sets an org's
    /// flag after a metered call drives its balance non-positive; the pre-call
    /// budget gate reads it. Inert unless `config.credits` is active and the
    /// request carries an org.
    pub wallet: WalletState,
    pub metrics: Metrics,
    pub composio: Option<ComposioClient>,
    /// Unified tool catalog client over Core (#475). `Some` when `providers.core`
    /// is configured (CORE_URL set); `None` ⇒ the tool loop and `/v1/exec/tool`
    /// are inert. Behind the [`tools::CoreCatalog`] trait for the loop.
    pub tools: Option<ToolSearchClient>,
    /// Semantic (embedding-similarity) cache as a swappable registry (Lg
    /// decomposition): the built-in [`crate::semantic_cache::SemanticCache`] is
    /// the default active backend when enabled; disabled ⇒ no active backend
    /// (`active()` is `None`), matching the old `Option<SemanticCache>`.
    pub semantic_cache: SemanticCacheRegistry,
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
    /// Token → org resolve cache for the multi-tenant data plane. `Some` when a
    /// control-plane URL is configured (`CONTROL_PLANE_URL`); resolves any minted
    /// `rgw_` bearer to its org + budget + policy and caches the result. `None`
    /// ⇒ the dynamic per-token auth path is inert and single-org behavior holds.
    pub resolve_cache: Option<ResolveCache>,
    /// The hardened wasmtime host for untrusted WASM **policy** plugins
    /// (`EvaluatorImpl::Wasm`). Lazily built on first use — a gateway with no wasm
    /// policy declared pays nothing (no engine init, no epoch ticker thread).
    /// `Some(host)` once initialised; the inner `Option` is `None` only if engine
    /// construction failed, in which case wasm evaluation fails closed. See
    /// [`Self::wasm_host`].
    wasm_host: OnceLock<Option<Arc<WasmPolicyHost>>>,
}

pub type SharedState = Arc<AppState>;

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
    pub fn new(config: GatewayConfig) -> Result<Self, String> {
        let quota = Arc::new(ProviderQuotas::new());
        let providers = ProviderRegistry::new(&config.providers, Arc::clone(&quota));
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

        let mut audit =
            AuditRegistry::from_logger(AuditLogger::new(&config.audit).unwrap_or_default());
        let budget = BudgetRegistry::new(config.budgets.clone());
        let exec_budget = ExecBudgetEnforcer::new(config.exec_budget.clone());
        let mut evals = EvalsRegistry::new(config.evals.clone());
        let shared_budget = SharedBudgetState::default();
        let metrics = Metrics::default();

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("failed to build HTTP client");

        let composio = if config.composio.enabled {
            Some(ComposioClient::new(config.composio.clone(), http.clone()))
        } else {
            None
        };

        // Unified tool catalog client (#475): wired only when Core is configured
        // (CORE_URL → providers.core). Without it the tool loop is inert.
        let tools = config
            .providers
            .core
            .as_ref()
            .map(|core| ToolSearchClient::new(core, http.clone()));

        let mut semantic_cache = if config.semantic_cache.enabled {
            SemanticCacheRegistry::from_cache(SemanticCache::new(
                config.semantic_cache.clone(),
                config.cache.ttl_secs,
            ))
        } else {
            SemanticCacheRegistry::disabled()
        };

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

        Ok(Self {
            config,
            stage_order,
            providers,
            router,
            smart_router,
            per_agent_routers: DashMap::new(),
            firewall,
            passthrough,
            resolver,
            rate_limiter,
            cache,
            circuit_breaker,
            quota,
            admission,
            skills,
            audit,
            budget,
            exec_budget,
            evals,
            shared_budget,
            wallet: WalletState::default(),
            metrics,
            composio,
            tools,
            semantic_cache,
            auth: RwLock::new(auth),
            resolve_cache: ResolveCache::from_env(http.clone()),
            http,
            policy: RwLock::new(EffectivePolicy::default()),
            jobs: MediaJobStore::new(),
            wasm_host: OnceLock::new(),
        })
    }

    /// The lazily-constructed WASM policy host. Returns `None` only if the wasmtime
    /// engine could not be built (wasm evaluation then fails closed for security
    /// policies). Construction — including the epoch ticker thread — happens at most
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

    /// Snapshot the current effective policy. Cheap clone; recovers from a
    /// poisoned lock by returning the default (fail-open) policy.
    pub fn policy_snapshot(&self) -> EffectivePolicy {
        self.policy.read().map(|p| p.clone()).unwrap_or_default()
    }

    /// Replace the effective policy (called by the control-plane refresh task).
    pub fn set_policy(&self, policy: EffectivePolicy) {
        if let Ok(mut guard) = self.policy.write() {
            *guard = policy;
        }
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
    /// takes effect on the request path with **no gateway restart** — the same
    /// live-swap discipline as [`Self::update_firewall_config`].
    ///
    /// Rebuilding drops the per-session decision cache (like the firewall scanner
    /// swap resets its compiled state); this is intentional and cheap. Only
    /// `smart_routing` swaps here — `model_map` / `fallback_chain` / `provider_tiers`
    /// live in [`Self::router`] (a startup snapshot) and remain restart-only.
    pub fn update_smart_router(&self, cfg: crate::config::SmartRoutingConfig) {
        self.smart_router.update_config(cfg);
    }

    /// Hot-swap the firewall scanner with a new config. Called by PUT /v1/config.
    /// The existing scanner is replaced atomically; in-flight requests that already
    /// acquired a read guard finish with the old config. Also updates the
    /// resolver's node base and invalidates its scanner cache so every resolved
    /// (node→org→agent) scanner picks up the new baseline.
    pub fn update_firewall_config(&self, cfg: FirewallConfig) {
        self.firewall.update_config(cfg.clone());
        self.resolver.set_node_base(cfg);
    }

    /// Build the per-request control-plane [`PolicyBundle`] from the request's
    /// resolved policy (the dynamic `rgw_`-token tenant path) or the global
    /// startup policy, mirroring the pipeline's `resolved_policy || snapshot`
    /// fallback. Returns `None` when neither carries any firewall overlay, so the
    /// resolver falls back to its standalone-local overlay store.
    fn request_bundle(&self, ctx: &RequestContext) -> Option<PolicyBundle> {
        let policy = ctx
            .resolved_policy
            .clone()
            .unwrap_or_else(|| self.policy_snapshot());
        let bundle = PolicyBundle {
            firewall: policy.firewall.clone(),
            agent_overlays: policy.agent_overlays.clone(),
        };
        if bundle.is_empty() {
            None
        } else {
            Some(bundle)
        }
    }

    /// Resolve the per-request firewall scanner for `ctx` (node → org → agent),
    /// returning a shared, cached [`FirewallScanner`]. The returned `Arc` holds
    /// no lock, so it is safe to keep across an `.await` (the inspector needs to).
    pub fn resolved_scanner(&self, ctx: &RequestContext) -> Arc<FirewallScanner> {
        let bundle = self.request_bundle(ctx);
        self.resolver.scanner_for(
            ctx.org_id.as_deref(),
            ctx.agent_id.as_deref(),
            bundle.as_ref(),
        )
    }

    /// Borrow the per-request *resolved* firewall scanner for the duration of a
    /// closure. The per-agent analogue of [`Self::with_firewall`]: it resolves
    /// the node→org→agent cascade from `ctx` and hands a cached scanner to `f`.
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
    /// In-memory usage counters reset on swap — this is intentional: lifetime
    /// counters are ephemeral by design (see budget/mod.rs module comment).
    pub fn update_budget_config(&self, cfg: BudgetConfig) {
        self.budget.update_config(cfg);
    }

    /// Replace the `api_keys` list in the live auth config. Called by PUT /v1/config.
    /// The master_key and require_auth flag are unchanged — they are startup-only.
    pub fn update_auth_config(&self, api_keys: Vec<ApiKeyConfig>) {
        if let Ok(mut guard) = self.auth.write() {
            guard.api_keys = api_keys;
        }
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
        let quota = Arc::new(ProviderQuotas::new());
        let providers = ProviderRegistry::new(&config.providers, Arc::clone(&quota));
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
        let mut semantic_cache = SemanticCacheRegistry::disabled();

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
            config,
            stage_order,
            providers,
            router,
            smart_router,
            per_agent_routers: DashMap::new(),
            firewall,
            passthrough,
            resolver,
            rate_limiter,
            cache,
            circuit_breaker,
            quota,
            admission,
            skills,
            audit,
            budget,
            exec_budget,
            evals,
            shared_budget,
            wallet: WalletState::default(),
            metrics,
            composio: None,
            tools: None,
            semantic_cache,
            auth: RwLock::new(auth),
            resolve_cache: None,
            http,
            policy: RwLock::new(EffectivePolicy::default()),
            jobs: MediaJobStore::new(),
            wasm_host: OnceLock::new(),
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

    /// A cache backend that answers every `get` with a fixed sentinel — proof the
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
    /// stage is left on its built-in backend — the field is read and applied, not
    /// ignored.
    #[test]
    fn default_config_selects_builtin_for_every_stage() {
        let state =
            AppState::new(GatewayConfig::default()).expect("default stage backends must build");
        assert_eq!(state.cache.active_id(), CacheRegistry::BUILTIN);
        assert_eq!(state.budget.active_id().as_str(), "builtin");
        // W6c: the four newly-inverted stages are read + applied to their built-in.
        assert_eq!(state.firewall.active_id().as_str(), "builtin");
        assert_eq!(state.router.active_id().as_str(), "builtin");
        assert_eq!(state.smart_router.active_id().as_str(), "builtin");
        assert_eq!(state.passthrough.active_id().as_str(), "builtin");
    }

    /// A config that names a backend NOT registered in a stage's registry refuses
    /// the whole build (fail-closed), and the error names the stage + the
    /// registered ids so a typo is diagnosable.
    #[test]
    fn unknown_stage_backend_refuses_build() {
        let mut config = GatewayConfig::default();
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
        // Default config → smart routing disabled → the request path is inert.
        let state = AppState::new_for_test_default();
        assert!(
            !state.smart_router().is_active(),
            "default smart routing must be inactive (fail-open)"
        );

        // Push an ENABLED smart-routing config (a classifier + one rule) — exactly
        // what `PUT /v1/config { routing: { smart_routing } }` would apply live.
        let cfg = SmartRoutingConfig {
            strategy: RouteStrategy::Llm,
            enabled: true,
            classifier_model: "gemma-classifier".to_string(),
            rules: vec![SmartRule {
                description: "writing or refactoring code".to_string(),
                model: "claude-sonnet-4-5".to_string(),
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
