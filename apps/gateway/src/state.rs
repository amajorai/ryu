use std::sync::{Arc, RwLock};

use crate::{
    audit::AuditLogger,
    budget::{BudgetEnforcer, ExecBudgetEnforcer, SharedBudgetState, WalletState},
    cache::Cache,
    circuit_breaker::CircuitBreakers,
    composio::ComposioClient,
    concurrency::ConcurrencyLimiter,
    config::{ApiKeyConfig, AuthConfig, BudgetConfig, FirewallConfig, GatewayConfig},
    evals::EvalsRunner,
    firewall::FirewallScanner,
    jobs::MediaJobStore,
    metrics::Metrics,
    policy::{EffectivePolicy, ResolveCache},
    providers::ProviderRegistry,
    quota::ProviderQuotas,
    rate_limit::RateLimiter,
    router::{smart::SmartRouter, ModelRouter},
    semantic_cache::SemanticCache,
    skills::SkillsRegistry,
    tools::ToolSearchClient,
};

pub struct AppState {
    pub config: GatewayConfig,
    pub providers: ProviderRegistry,
    pub router: ModelRouter,
    /// Classifier-driven model routing (custom routing instructions). Inert
    /// unless `config.routing.smart_routing` is active; holds a per-session
    /// decision cache. Like `router`, it is a startup snapshot of the config.
    pub smart_router: SmartRouter,
    /// `RwLock` so `PUT /v1/config` can hot-swap the scanner without a restart.
    pub firewall: RwLock<FirewallScanner>,
    pub rate_limiter: RateLimiter,
    pub cache: Cache,
    pub circuit_breaker: CircuitBreakers,
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
    pub audit: AuditLogger,
    /// `RwLock` so `PUT /v1/config` can hot-swap the enforcer without a restart.
    pub budget: RwLock<BudgetEnforcer>,
    /// Exec (sandbox/tool) budget enforcer (M6 / #192). Enforces count + wall-clock
    /// limits per rolling window; checked pre-run by Core via `POST /v1/exec/budget/check`.
    pub exec_budget: ExecBudgetEnforcer,
    pub evals: EvalsRunner,
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
    pub semantic_cache: Option<SemanticCache>,
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
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(config: GatewayConfig) -> Self {
        let quota = Arc::new(ProviderQuotas::new());
        let providers = ProviderRegistry::new(&config.providers, Arc::clone(&quota));
        let router = ModelRouter::new(config.routing.clone());
        let smart_router = SmartRouter::new(config.routing.smart_routing.clone());
        let firewall = FirewallScanner::new(config.firewall.clone());
        let rate_limiter = RateLimiter::new(config.rate_limit.clone());
        let cache = Cache::new(config.cache.clone());
        let circuit_breaker = CircuitBreakers::new(config.circuit_breaker.clone());
        let admission = ConcurrencyLimiter::new(&config.concurrency);
        let skills = SkillsRegistry::new(config.skills.skills.clone());

        let audit = AuditLogger::new(&config.audit).unwrap_or_default();
        let budget = BudgetEnforcer::new(config.budgets.clone());
        let exec_budget = ExecBudgetEnforcer::new(config.exec_budget.clone());
        let evals = EvalsRunner::new(config.evals.clone());
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

        let semantic_cache = if config.semantic_cache.enabled {
            Some(SemanticCache::new(
                config.semantic_cache.clone(),
                config.cache.ttl_secs,
            ))
        } else {
            None
        };

        let auth = config.auth.clone();

        Self {
            config,
            providers,
            router,
            smart_router,
            firewall: RwLock::new(firewall),
            rate_limiter,
            cache,
            circuit_breaker,
            quota,
            admission,
            skills,
            audit,
            budget: RwLock::new(budget),
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
        }
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

    /// Hot-swap the firewall scanner with a new config. Called by PUT /v1/config.
    /// The existing scanner is replaced atomically; in-flight requests that already
    /// acquired a read guard finish with the old config.
    pub fn update_firewall_config(&self, cfg: FirewallConfig) {
        if let Ok(mut guard) = self.firewall.write() {
            *guard = FirewallScanner::new(cfg);
        }
    }

    /// Hot-swap the budget enforcer with a new config. Called by PUT /v1/config.
    /// In-memory usage counters reset on swap — this is intentional: lifetime
    /// counters are ephemeral by design (see budget/mod.rs module comment).
    pub fn update_budget_config(&self, cfg: BudgetConfig) {
        if let Ok(mut guard) = self.budget.write() {
            *guard = BudgetEnforcer::new(cfg);
        }
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
        F: FnOnce(&FirewallScanner) -> T,
    {
        match self.firewall.read() {
            Ok(guard) => f(&*guard),
            Err(poisoned) => f(&*poisoned.into_inner()),
        }
    }

    /// Borrow the budget enforcer for the duration of a closure.
    pub fn with_budget<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&BudgetEnforcer) -> T,
    {
        match self.budget.read() {
            Ok(guard) => f(&*guard),
            Err(poisoned) => f(&*poisoned.into_inner()),
        }
    }

    /// Construct a minimal AppState for unit tests, injecting caller-provided
    /// `AuditLogger` and `EvalsRunner` instances so tests can inspect them
    /// after the fact. All other fields are set to their defaults.
    #[cfg(test)]
    pub fn new_for_test(config: GatewayConfig, audit: AuditLogger, evals: EvalsRunner) -> Self {
        let quota = Arc::new(ProviderQuotas::new());
        let providers = ProviderRegistry::new(&config.providers, Arc::clone(&quota));
        let router = ModelRouter::new(config.routing.clone());
        let smart_router = SmartRouter::new(config.routing.smart_routing.clone());
        let firewall = FirewallScanner::new(config.firewall.clone());
        let rate_limiter = RateLimiter::new(config.rate_limit.clone());
        let cache = Cache::new(config.cache.clone());
        let circuit_breaker = CircuitBreakers::new(config.circuit_breaker.clone());
        let admission = ConcurrencyLimiter::new(&config.concurrency);
        let skills = SkillsRegistry::new(config.skills.skills.clone());
        let budget = BudgetEnforcer::new(config.budgets.clone());
        let exec_budget = ExecBudgetEnforcer::new(config.exec_budget.clone());
        let shared_budget = SharedBudgetState::default();
        let metrics = Metrics::default();
        let http = reqwest::Client::new();
        let auth = config.auth.clone();

        Self {
            config,
            providers,
            router,
            smart_router,
            firewall: RwLock::new(firewall),
            rate_limiter,
            cache,
            circuit_breaker,
            quota,
            admission,
            skills,
            audit,
            budget: RwLock::new(budget),
            exec_budget,
            evals,
            shared_budget,
            wallet: WalletState::default(),
            metrics,
            composio: None,
            tools: None,
            semantic_cache: None,
            auth: RwLock::new(auth),
            resolve_cache: None,
            http,
            policy: RwLock::new(EffectivePolicy::default()),
            jobs: MediaJobStore::new(),
        }
    }
}
