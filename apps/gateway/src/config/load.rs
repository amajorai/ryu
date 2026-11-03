//! `GatewayConfig::load`: file plus environment overlays.

use super::*;

impl GatewayConfig {
    pub fn load() -> anyhow::Result<Self> {
        let config_path = Self::config_path();

        let mut config: GatewayConfig = if let Some(path) = config_path {
            if path.exists() {
                let content = std::fs::read_to_string(&path)?;
                Self::from_authored_str(&content)?
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

        let provider_environment = ProviderEnvironment::capture(&config.egress);
        provider_environment
            .apply(&mut config)
            .map_err(anyhow::Error::msg)?;
        config.provider_environment = Some(provider_environment);

        load_auth_env(&mut config)?;
        load_service_env(&mut config);
        load_channel_env(&mut config);
        load_runtime_env(&mut config);
        load_credits_env(&mut config);

        // Fleet mode (managed-cloud WS2). Any replica behind a co-located load
        // balancer or reverse proxy, hosted or self-hosted, sets this so the
        // admin gate stops trusting loopback peers (an external caller through
        // the proxy looks like 127.0.0.1). It hardens exposure only and is not a
        // custody signal. Config-file (`fleet = true`) is primary; this env
        // override flips it per deployment.
        if let Ok(raw) = std::env::var("RYU_GATEWAY_FLEET") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.fleet = enabled;
            }
        }

        if config.credits.enabled && !config.credits.is_active() {
            anyhow::bail!(
                "credit billing is enabled but requires a non-empty control-plane URL and RYU_CREDITS_INTERNAL_SECRET"
            );
        }
        if config.fleet && config.credits.enabled && !config.credits.fail_closed {
            anyhow::bail!(
                "refusing to start a managed gateway fleet with credit debit fail-open; +set GATEWAY_CREDITS_FAIL_CLOSED=true"
            );
        }

        // Money config is validated at BOOT, not at first debit: a gateway that
        // starts and silently gives away metered surfaces is the failure mode
        // this whole check exists to prevent.
        config.credits.validate_metered_rates()?;
        crate::web_config::validate_web_prices(&config.credits.web_service_prices, &config.credits)
            .map_err(anyhow::Error::msg)?;

        Ok(config)
    }
}

/// Master, admin, relay and Core proof credentials.
pub(super) fn load_auth_env(config: &mut GatewayConfig) -> anyhow::Result<()> {
    // Auth master key
    if let Ok(key) = std::env::var("GATEWAY_MASTER_KEY") {
        config.auth.master_key = Some(key);
        config.auth.require_auth = true;
    }

    // Core-owned admin and relay credentials have distinct authority.
    if config.auth.master_key.is_none() {
        if let Ok(key) = std::env::var("GATEWAY_ADMIN_KEY") {
            ryu_gw_credentials::validate(&key)?;
            config.auth.master_key = Some(key);
        }
    }
    for (variable, name, trusted) in [
        ("GATEWAY_CORE_RELAY_KEY", "local-core", true),
        ("GATEWAY_RELAY_KEY", "local-inference", false),
    ] {
        if let Ok(key) = std::env::var(variable) {
            config.auth.add_relay(key, name, trusted)?;
            // A managed child never inherits an old anonymous local setting.
            config.auth.require_auth = true;
        }
    }
    if let Ok(proof_key) = std::env::var("GATEWAY_CORE_PROOF_KEY") {
        ryu_gw_credentials::validate(&proof_key)?;
        if config.auth.master_key.as_deref() == Some(proof_key.as_str())
            || config
                .auth
                .api_keys
                .iter()
                .any(|entry| entry.key == proof_key)
        {
            anyhow::bail!(
                "GATEWAY_CORE_PROOF_KEY must differ from every Gateway bearer credential"
            );
        }
    }
    if let Ok(master) = std::env::var("GATEWAY_CORE_PROOF_MASTER_KEY") {
        ryu_gw_credentials::validate(&master)?;
        if config.auth.master_key.as_deref() == Some(master.as_str())
            || config.auth.api_keys.iter().any(|entry| entry.key == master)
        {
            anyhow::bail!(
                "GATEWAY_CORE_PROOF_MASTER_KEY must differ from every Gateway bearer credential"
            );
        }
    }
    Ok(())
}

/// Prompt cache, node routing, Composio, Treg, firewall and control-plane overrides.
pub(super) fn load_service_env(config: &mut GatewayConfig) {
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
    if let Some(limit) = first_non_empty_env(&["RYU_TREG_MAX_RESPONSE_BYTES"])
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|limit| *limit > 0)
    {
        config.treg.max_response_bytes = limit;
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
}
