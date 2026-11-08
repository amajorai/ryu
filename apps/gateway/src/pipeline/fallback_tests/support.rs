//! Shared helpers for the fallback test modules.
//!
//! test-exempt: test-only helpers (this whole module is `cfg(test)`), exercised
//! by every `fallback_tests` part.

use super::*;

/// The error a stub returns for [`Mode::SafetyRefused`].
pub(super) fn stub_safety_refusal(id: &str, scope: ryu_gw_providers::SafetyScope) -> ProviderError {
    ProviderError::SafetyRefused {
        provider: id.to_owned(),
        status: 403,
        scope,
        row: "test.stub",
        code: Some("ryu_test_signal".to_owned()),
        message: "RYU_TEST_FIXTURE upstream wording".to_owned(),
    }
}

/// Build a state whose routing pins `primary` first, then `secondary`, with the
/// firewall + circuit breaker configured for a deterministic test.
pub(super) fn chain_state(threshold: u32) -> AppState {
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary"), ProviderId::from("secondary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        circuit_breaker: CircuitBreakerConfig {
            enabled: true,
            failure_threshold: threshold,
            reset_timeout_secs: 30,
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

pub(super) fn plain_ctx() -> RequestContext {
    RequestContext {
        org_limits: None,
        identity: None,
        standing: None,
        enforcement: None,
        host_conversation: None,
        authorized_operation: crate::config::ApiKeyOperation::Inference,
        provider_snapshot: None,
        request_id: "fallback-req".to_string(),
        api_key: "sk-test".to_string(),
        owner_binding: ryu_gw_credentials::fingerprint("sk-test"),
        is_master_key: false,
        org_id: None,
        team_id: None,
        project_id: None,
        user_name: None,
        user_id: None,
        agent_id: None,
        agent_provider_access: None,
        key_config: None,
        skill_ids: None,
        tool_actions: None,
        tools_header_present: false,
        capability_hints: None,
        slot_provider: None,
        slot_model: None,
        own_supply_route: None,
        violation_attempt: Default::default(),
        session_id: None,
        feature: None,
        purpose: None,
        companion_source: false,
        tool_search_requested: false,
        untrusted_caller: false,
        priority: crate::concurrency::Priority::Interactive,
        tool_profile: None,
        raw_tools: false,
        managed_inference: false,
        openrouter_routing_enabled: false,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        credit_accounting_unavailable: false,
        budget_resolved_at: None,
        resolved_policy: None,
        prompt_cache_mode: None,
        prompt_cache_ttl: None,
        node_routing: None,
    }
}

pub(super) fn ping_body() -> Value {
    json!({ "model": "anything", "messages": [{"role": "user", "content": "ping"}] })
}

pub(super) fn own_supply_state_with(
    own: Mode,
    runtime: Option<crate::own_supply_table::OwnSupplyRuntime>,
) -> (Arc<AppState>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let mut config = GatewayConfig::default();
    config.firewall.enabled = false;
    config.routing.default_provider = ProviderId::from("openrouter");
    config.routing.fallback_chain = Vec::new();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (router, router_calls) = StubProvider::new("openrouter", Mode::Ok);
    let (slot, slot_calls) = StubProvider::new("anthropic-credits", own);
    state
        .provider_runtime
        .register_for_test(router as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(slot as Arc<dyn Provider>);
    if let Some(runtime) = runtime {
        state.own_supply = Arc::new(runtime);
    }
    (Arc::new(state), router_calls, slot_calls)
}

/// A fleet gateway's published table with one dynamically linked model
/// that has no Ryu alias (`claude-opus-4-1`).
pub(super) fn fleet_runtime_with_opus_41() -> crate::own_supply_table::OwnSupplyRuntime {
    let (table, _) = crate::own_supply_table::parse_table(&json!({
        "version": 4,
        "rows": [{
            "id": "anthropic/claude-opus-4.1",
            "slot": "anthropic-credits",
            "upstream": "claude-opus-4-1",
            "userPrice": {
                "inPer1kMicroUsd": 15000,
                "outPer1kMicroUsd": 75000,
                "cacheReadPer1kMicroUsd": 1500,
                "cacheWritePer1kMicroUsd": 18750
            }
        }],
        "poolDefaults": {}
    }))
    .unwrap();
    crate::own_supply_table::OwnSupplyRuntime::fleet_for_test(table, None)
}

pub(super) fn opus_41_body() -> Value {
    json!({
        "model": "anthropic/claude-opus-4.1",
        "messages": [{"role": "user", "content": "ping"}]
    })
}

pub(super) fn free_credit_ctx(free: i64) -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.org_id = Some("own-supply".to_owned());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(1_000_000 + free);
    ctx.unrestricted_budget_micro_usd = Some(1_000_000);
    // Granted against the pool that serves the pick (`anthropic-credits` for
    // Sonnet): separate pools, a grant pays only for its own pool's supply.
    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("anthropic-credits".to_owned(), free)]);
    ctx
}

pub(super) fn sonnet_body() -> Value {
    json!({
        "model": "anthropic/claude-sonnet-4.5",
        "messages": [{"role": "user", "content": "ping"}]
    })
}

pub(super) fn current_circuit_key(state: &AppState, provider: &str) -> String {
    state
        .provider_runtime
        .snapshot()
        .epoch
        .circuit_key(provider)
}

pub(super) fn prefs(fallback: &[&str]) -> super::super::node_routing::NodeRoutingPrefs {
    super::super::node_routing::NodeRoutingPrefs {
        fallback: fallback.iter().map(|s| (*s).to_string()).collect(),
        firewall: None,
        openrouter: None,
        openrouter_model_fallbacks: Vec::new(),
    }
}

pub(super) fn provider_access(ids: &[&str]) -> Option<Arc<std::collections::HashSet<String>>> {
    Some(Arc::new(ids.iter().map(|id| (*id).to_owned()).collect()))
}

pub(super) fn fleet_tenant_ctx() -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.org_id = Some("o1".to_owned());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(10_000);
    ctx
}

pub(super) fn billing_state() -> AppState {
    let mut config = crate::GatewayConfig::default();
    config.credits.enabled = true;
    config.credits.internal_secret = Some("debit-secret".to_owned());
    config.credits.base_url = "http://control-plane.invalid".to_owned();
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

pub(super) fn u1_ctx() -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.user_id = Some("u1".to_string());
    ctx
}

/// Build a state whose per-agent budget for `agent-a` is `rule`, with a
/// healthy `primary` provider registered. Returns `(state, primary_call_counter)`.
pub(super) fn agent_budget_state(
    rule: crate::config::BudgetRule,
) -> (Arc<AppState>, Arc<AtomicUsize>) {
    use std::collections::HashMap;
    let mut agents = HashMap::new();
    agents.insert("agent-a".to_string(), rule);
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        budgets: crate::config::BudgetConfig {
            agents,
            ..Default::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);
    // Seed usage above the rule's limit so the very next request trips it.
    state.with_budget(|b| b.record(None, Some("agent-a"), 1_000_000));
    (state, calls)
}

pub(super) fn agent_a_ctx() -> RequestContext {
    let mut ctx = plain_ctx();
    ctx.agent_id = Some("agent-a".to_string());
    ctx
}

/// Build a state with the firewall on at `policy` (+ optional alert tier) and a
/// healthy `primary` provider. Exact cache disabled so each run re-scans.
pub(super) fn firewall_state(
    policy: crate::config::FirewallPolicy,
    alert: crate::config::AlertTier,
) -> (Arc<AppState>, Arc<AtomicUsize>) {
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: true,
            scan_inbound: true,
            scan_outbound: false,
            policy,
            alert,
            ..FirewallConfig::default()
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    (Arc::new(state), calls)
}

pub(super) fn secret_body() -> serde_json::Value {
    json!({
        "model": "anything",
        "messages": [{
            "role": "user",
            "content": "Contact user@example.com or use key sk-abcdefghijklmnopqrstu"
        }]
    })
}

/// A gateway whose firewall is `firewall` and whose pipeline omits the
/// `disabled` stages, with one stub provider registered.
pub(super) fn sanitize_posture_state(
    firewall: crate::config::FirewallConfig,
    disabled: &[PipelineStage],
) -> Arc<AppState> {
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall,
        pipeline: stages::PipelineOrderConfig {
            order: Vec::new(),
            disabled: disabled.to_vec(),
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, _) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    Arc::new(state)
}

/// A firewall that is on but does not itself redact (`WarnAndContinue`), so
/// only the inspector or an inline evaluator can put the gateway in a Sanitize
/// posture. The inspector skips every turn (`min_chars`), so it never needs a
/// model.
pub(super) fn warn_only_firewall() -> crate::config::FirewallConfig {
    crate::config::FirewallConfig {
        enabled: true,
        scan_inbound: true,
        scan_outbound: false,
        policy: crate::config::FirewallPolicy::WarnAndContinue,
        alert: crate::config::AlertTier::Silent,
        inspector: crate::config::InspectorConfig {
            enabled: false,
            min_chars: usize::MAX,
            action: crate::config::FirewallPolicy::Sanitize,
            ..crate::config::InspectorConfig::default()
        },
        ..crate::config::FirewallConfig::default()
    }
}

pub(super) fn sanitize_input_binding(enabled: bool) -> crate::evaluators::EvaluatorBinding {
    crate::evaluators::EvaluatorBinding {
        // An inline INPUT evaluator whose catalog default is Block, so only
        // the binding's own Sanitize action can make it a Sanitize posture.
        id: "code_injection".to_owned(),
        enabled,
        inline_action: Some(crate::config::FirewallPolicy::Sanitize),
        offline: None,
        locked: false,
    }
}

/// Tools and an earlier turn that carry PII the newest turn does not.
pub(super) fn pii_in_prefix_body() -> serde_json::Value {
    json!({
        "model": "anything",
        "messages": [
            { "role": "user", "content": "mail jane@example.com about it" },
            { "role": "assistant", "content": "ok" },
            { "role": "user", "content": "what's new?" }
        ],
        "tools": [{ "type": "function", "function": {
            "name": "notify",
            "description": "Send mail, e.g. to jane@example.com",
            "parameters": { "type": "object" }
        } }]
    })
}

/// A managed fleet whose default route is the Ryu Router (`openrouter`)
/// slot, plus Ryu's own `anthropic-credits` slot in `own` mode.
pub(super) fn own_supply_state(own: Mode) -> (Arc<AppState>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    own_supply_state_with(own, None)
}

/// `chain_state` with a third provider in the chain, so a preference has
/// something to actually reorder.
pub(super) fn three_chain_state() -> AppState {
    // Built from config, not mutated afterwards: `AppState::new_for_test`
    // constructs the router registry from `config.routing`, so a chain widened
    // after the fact would never reach the router.
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![
                ProviderId::from("primary"),
                ProviderId::from("secondary"),
                ProviderId::from("tertiary"),
            ],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        circuit_breaker: CircuitBreakerConfig {
            enabled: true,
            failure_threshold: 10,
            reset_timeout_secs: 30,
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

/// Build a state whose per-user budget for `u1` is `rule`, with a healthy
/// `primary` provider registered. Returns `(state, primary_call_counter)`.
pub(super) fn budget_state(rule: crate::config::BudgetRule) -> (Arc<AppState>, Arc<AtomicUsize>) {
    use std::collections::HashMap;
    let mut users = HashMap::new();
    users.insert("u1".to_string(), rule);
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        budgets: crate::config::BudgetConfig {
            users,
            ..Default::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);
    // Seed usage above the rule's limit so the very next request trips it.
    state.with_budget(|b| b.record(Some("u1"), None, 1_000_000));
    (state, calls)
}
