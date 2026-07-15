use std::sync::{Arc, OnceLock, RwLock};

use dashmap::DashMap;

use crate::{
    audit::AuditLogger,
    budget::{BudgetEnforcer, ExecBudgetEnforcer, SharedBudgetState, WalletState},
    cache::Cache,
    circuit_breaker::CircuitBreakers,
    composio::ComposioClient,
    concurrency::ConcurrencyLimiter,
    config::{ApiKeyConfig, AuthConfig, BudgetConfig, FirewallConfig, GatewayConfig},
    evals::EvalsRunner,
    firewall::{
        resolve::{FirewallResolver, PolicyBundle},
        FirewallScanner,
    },
    jobs::MediaJobStore,
    pipeline::RequestContext,
    metrics::Metrics,
    policy::{EffectivePolicy, ResolveCache},
    providers::ProviderRegistry,
    quota::ProviderQuotas,
    rate_limit::RateLimiter,
    router::{smart::SmartRouter, ModelRouter},
    semantic_cache::SemanticCache,
    skills::SkillsRegistry,
    tools::ToolSearchClient,
    wasm_policy::WasmPolicyHost,
};

pub struct AppState {
    pub config: GatewayConfig,
    pub providers: ProviderRegistry,
    pub router: ModelRouter,
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
    pub smart_router: RwLock<Arc<SmartRouter>>,
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
    pub firewall: RwLock<FirewallScanner>,
    /// Hierarchical firewall resolver (node → org → agent cascade, #hierarchical
    /// policy). Holds the standalone-local org/agent overlay stores and a
    /// compiled-scanner cache; hands per-request scanners to
    /// [`Self::with_resolved_firewall`]. Its own internal `RwLock`s carry the
    /// poison-recovery discipline, so it is stored directly (not wrapped).
    pub resolver: FirewallResolver,
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
    /// The hardened wasmtime host for untrusted WASM **policy** plugins
    /// (`EvaluatorImpl::Wasm`). Lazily built on first use — a gateway with no wasm
    /// policy declared pays nothing (no engine init, no epoch ticker thread).
    /// `Some(host)` once initialised; the inner `Option` is `None` only if engine
    /// construction failed, in which case wasm evaluation fails closed. See
    /// [`Self::wasm_host`].
    wasm_host: OnceLock<Option<Arc<WasmPolicyHost>>>,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(config: GatewayConfig) -> Self {
        let quota = Arc::new(ProviderQuotas::new());
        let providers = ProviderRegistry::new(&config.providers, Arc::clone(&quota));
        let router = ModelRouter::new(config.routing.clone());
        let smart_router = Arc::new(SmartRouter::new(config.routing.smart_routing.clone()));
        let firewall = FirewallScanner::new(config.firewall.clone());
        let resolver = FirewallResolver::new(config.firewall.clone());
        // Reload standalone org/agent overlays persisted to gateway.toml (FIX 4)
        // so they survive a gateway restart instead of resetting to empty.
        resolver.seed_overlays(
            &config.firewall_org_overlays,
            &config.firewall_agent_overlays,
        );
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
            smart_router: RwLock::new(smart_router),
            per_agent_routers: DashMap::new(),
            firewall: RwLock::new(firewall),
            resolver,
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
            wasm_host: OnceLock::new(),
        }
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
    pub fn smart_router(&self) -> std::sync::Arc<crate::router::smart::SmartRouter> {
        match self.smart_router.read() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
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
        let next = std::sync::Arc::new(crate::router::smart::SmartRouter::new(cfg));
        if let Ok(mut guard) = self.smart_router.write() {
            *guard = next;
        }
    }

    /// Hot-swap the firewall scanner with a new config. Called by PUT /v1/config.
    /// The existing scanner is replaced atomically; in-flight requests that already
    /// acquired a read guard finish with the old config. Also updates the
    /// resolver's node base and invalidates its scanner cache so every resolved
    /// (node→org→agent) scanner picks up the new baseline.
    pub fn update_firewall_config(&self, cfg: FirewallConfig) {
        if let Ok(mut guard) = self.firewall.write() {
            *guard = FirewallScanner::new(cfg.clone());
        }
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
    pub fn new_for_test_default() -> Self {
        let audit = AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = EvalsRunner::new(crate::config::EvalsConfig::default());
        Self::new_for_test(GatewayConfig::default(), audit, evals)
    }

    #[cfg(test)]
    pub fn new_for_test(config: GatewayConfig, audit: AuditLogger, evals: EvalsRunner) -> Self {
        let quota = Arc::new(ProviderQuotas::new());
        let providers = ProviderRegistry::new(&config.providers, Arc::clone(&quota));
        let router = ModelRouter::new(config.routing.clone());
        let smart_router = Arc::new(SmartRouter::new(config.routing.smart_routing.clone()));
        let firewall = FirewallScanner::new(config.firewall.clone());
        let resolver = FirewallResolver::new(config.firewall.clone());
        // Reload standalone org/agent overlays persisted to gateway.toml (FIX 4)
        // so they survive a gateway restart instead of resetting to empty.
        resolver.seed_overlays(
            &config.firewall_org_overlays,
            &config.firewall_agent_overlays,
        );
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
            smart_router: RwLock::new(smart_router),
            per_agent_routers: DashMap::new(),
            firewall: RwLock::new(firewall),
            resolver,
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
            wasm_host: OnceLock::new(),
        }
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
