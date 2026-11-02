//! Test-only [`AppState`] constructors.

use super::*;

impl AppState {
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
