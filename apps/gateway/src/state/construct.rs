//! Building [`AppState`] for the custody `main` detected at boot.

use super::*;

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
}
