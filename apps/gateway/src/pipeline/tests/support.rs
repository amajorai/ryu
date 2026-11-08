//! Shared helpers for the pipeline test modules.

use super::*;

/// Minimal `RequestContext` for signal-gate tests.
pub(super) fn signal_ctx(
    tool_actions: Option<&str>,
    header_present: bool,
    search: bool,
) -> RequestContext {
    RequestContext {
        org_limits: None,
        identity: None,
        standing: None,
        enforcement: None,
        host_conversation: None,
        authorized_operation: crate::config::ApiKeyOperation::Inference,
        provider_snapshot: None,
        request_id: "t".into(),
        api_key: "k".into(),
        owner_binding: ryu_gw_credentials::fingerprint("k"),
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
        tool_actions: tool_actions.map(str::to_string),
        tools_header_present: header_present,
        capability_hints: None,
        slot_provider: None,
        slot_model: None,
        own_supply_route: None,
        violation_attempt: Default::default(),
        session_id: None,
        feature: None,
        purpose: None,
        companion_source: false,
        tool_search_requested: search,
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

/// An `AppState` whose credits config is exactly what a reservation test
/// needs: reservations on, a known floor, and a known flat token rate.
pub(super) fn reserve_state(min_reserve_micro_usd: u64, cost_per_1k_micro_usd: u64) -> AppState {
    let mut config = crate::GatewayConfig::default();
    config.credits.reserve_enabled = true;
    config.credits.min_reserve_micro_usd = min_reserve_micro_usd;
    config.control_plane.cost_per_1k_micro_usd = cost_per_1k_micro_usd;
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

/// A managed-tenant context with a known unrestricted balance.
pub(super) fn managed_ctx(balance_micro_usd: i64) -> RequestContext {
    let mut ctx = signal_ctx(None, false, false);
    ctx.org_id = Some("o1".to_string());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(balance_micro_usd);
    ctx
}

/// Run the clamp over a chat body and hand back what it became.
pub(super) fn clamped(state: &AppState, ctx: &RequestContext, mut body: Value) -> Value {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    clamp_output_ceiling(state, ctx, &mut body, &model, None, OutputCeiling::Clamp)
        .expect("the balance covers some output");
    body
}

/// A state whose price table knows one expensive model.
pub(super) fn priced_state(
    min_reserve_micro_usd: u64,
    flat_per_1k: u64,
    model: &str,
    output_per_1k: u64,
) -> AppState {
    let mut config = crate::GatewayConfig::default();
    config.credits.reserve_enabled = true;
    config.credits.min_reserve_micro_usd = min_reserve_micro_usd;
    config.control_plane.cost_per_1k_micro_usd = flat_per_1k;
    config.control_plane.model_pricing.insert(
        model.to_string(),
        crate::config::ModelPrice {
            input_per_1k_micro_usd: 3000,
            output_per_1k_micro_usd: output_per_1k,
        },
    );
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

/// A chat body whose prompt estimates to `prompt_tokens` (4 chars/token).
pub(super) fn prompt_body(prompt_tokens: usize, max_tokens: Option<u64>) -> Value {
    let mut body = json!({
        "messages": [{ "role": "user", "content": "a".repeat(prompt_tokens * 4) }]
    });
    if let Some(max_tokens) = max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    body
}

pub(super) fn admit_chat(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
) -> Result<BudgetOutcome, GatewayError> {
    let mut decision = RouteDecision {
        provider: ProviderId::from("openai"),
        model: "unpriced".to_owned(),
    };
    enforce_budget(
        state,
        ctx,
        body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )
}

/// Let the clock move, so the next wallet observation is strictly newer.
pub(super) fn tick() {
    std::thread::sleep(std::time::Duration::from_millis(2));
}

/// A ToolsConfig with `always_on` containing a single tool named `name`.
pub(super) fn cfg_with_always_on(name: &str) -> ToolsConfig {
    ToolsConfig {
        always_on: vec![json!({"type":"function","function":{"name": name}})],
        ..ToolsConfig::default()
    }
}

pub(super) fn offered_tool_names(body: &Value) -> Vec<String> {
    body["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn sanitize_scanner() -> FirewallScanner {
    FirewallScanner::new(FirewallConfig {
        policy: FirewallPolicy::Sanitize,
        ..FirewallConfig::default()
    })
}

pub(super) fn binding(id: &str, enabled: bool, action: Option<FirewallPolicy>) -> EvaluatorBinding {
    EvaluatorBinding {
        id: id.into(),
        enabled,
        inline_action: action,
        offline: None,
        locked: false,
    }
}

/// A custom input-target WASM policy evaluator declaration.
pub(super) fn wasm_evaluator(id: &str, wat: &str, fail_open: bool) -> Evaluator {
    Evaluator {
        id: id.to_string(),
        name: format!("wasm {id}"),
        description: "e2e wasm policy".to_string(),
        category: crate::evaluators::EvaluatorCategory::Security,
        target: EvaluatorTarget::Input,
        capabilities: crate::evaluators::Capabilities {
            inline: true,
            offline: false,
        },
        impl_: EvaluatorImpl::Wasm {
            module_base64: wasm_b64(wat),
            fail_open,
        },
        inline: Some(crate::evaluators::InlineConfig {
            action: FirewallPolicy::Block,
        }),
        offline: None,
        builtin: false,
        enforced: true,
        higher_is_better: true,
    }
}

pub(super) fn wasm_state(evaluator: Evaluator) -> Arc<AppState> {
    let config = crate::config::GatewayConfig {
        custom_evaluators: vec![evaluator],
        ..crate::config::GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    Arc::new(AppState::new_for_test(config, audit, evals))
}

pub(super) fn wasm_ctx() -> RequestContext {
    signal_ctx(None, false, false)
}

/// Run the input inline-evaluator stage with one enabled binding for `eval_id`
/// at `action`, returning the pipeline result.
pub(super) async fn run_input_wasm(
    state: &Arc<AppState>,
    eval_id: &str,
    action: FirewallPolicy,
) -> Result<Option<PolicyAlert>, GatewayError> {
    let scanner = scanner_with_bindings(vec![binding(eval_id, true, Some(action))]);
    let ctx = wasm_ctx();
    let mut body = serde_json::json!({ "model": "gpt-4o", "messages": [] });
    apply_inline_input_evaluators(state, &ctx, &mut body, &scanner, "hello there").await
}
