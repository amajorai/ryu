//! `POST /v1/budget/charge` routing and `GET /v1/budget/spend` scope filtering.

use super::*;
use std::collections::HashMap;

#[tokio::test]
async fn composio_charge_prices_deliveries_premium_and_zdr_on_the_trusted_route() {
    let mut state = crate::state::AppState::new_for_test_default();
    state.config.composio.billing.zero_data_retention = true;
    state.auth.write().unwrap().master_key = Some("billing-test-master".to_owned());
    let state = std::sync::Arc::new(state);
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        "Bearer billing-test-master".parse().unwrap(),
    );
    for (usage, units, expected) in [
        (
            json!({"kind":"toolCall","authSource":"managedApp","directExecution":true,"premiumChargeMicroUsd":8000}),
            1,
            8700,
        ),
        (
            json!({"kind":"triggerEvent","authSource":"managedApp"}),
            2,
            10000,
        ),
        (json!({"kind":"meta","authSource":"managedApp"}), 1, 0),
    ] {
        let body = serde_json::from_value(json!({"tool_calls":units,"org_id":"org-a","provider":"composio","composioUsage":usage})).unwrap();
        let Json(result) = charge_tool(
            State(std::sync::Arc::clone(&state)),
            headers.clone(),
            Json(body),
        )
        .await
        .unwrap();
        assert_eq!(result["cost_micro_usd"], expected);
        assert_eq!(result["composioCharge"]["totalMicroUsd"], expected);
    }
}

#[tokio::test]
async fn composio_receipt_outage_marks_only_the_bound_wallet_unavailable() {
    let state = crate::state::AppState::new_for_test_default();
    state.auth.write().unwrap().master_key = Some("billing-test-master".to_owned());
    let state = std::sync::Arc::new(state);
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        "Bearer billing-test-master".parse().unwrap(),
    );
    let body = serde_json::from_value(json!({"tool_calls":1,"org_id":"org-a","provider":"composio","composioAccountingUnavailable":true})).unwrap();
    assert!(
        charge_tool(State(std::sync::Arc::clone(&state)), headers, Json(body))
            .await
            .is_err()
    );
    assert!(state.wallet.is_org_accounting_unavailable("org-a"));
    assert!(!state.wallet.is_org_accounting_unavailable("org-b"));
}

#[test]
fn filter_scope_narrows_to_single_id() {
    let mut m = HashMap::new();
    m.insert("a".to_string(), 10u64);
    m.insert("b".to_string(), 20u64);
    // No filter ⇒ full map.
    let full = filter_scope(m.clone(), &None);
    assert_eq!(full.len(), 2);
    // Filter ⇒ only the requested id.
    let one = filter_scope(m, &Some("a".to_string()));
    assert_eq!(one.len(), 1);
    assert_eq!(one.get("a"), Some(&10));
}

#[test]
fn filter_scope_missing_id_is_empty() {
    let mut m = HashMap::new();
    m.insert("a".to_string(), 10u64);
    let none = filter_scope(m, &Some("zzz".to_string()));
    assert!(none.is_empty());
}

#[test]
fn legacy_charge_defaults_to_composio() {
    assert_eq!(normalized_tool_provider(None), Ok("composio"));
    assert_eq!(normalized_tool_provider(Some("  ")), Ok("composio"));
    assert_eq!(normalized_tool_provider(Some("composio")), Ok("composio"));
}

#[test]
fn treg_charge_is_accepted_and_unknown_provider_is_rejected() {
    assert_eq!(normalized_tool_provider(Some("treg")), Ok("treg"));
    assert_eq!(
        normalized_tool_provider(Some("other")),
        Err("unsupported external tool provider")
    );
}

#[test]
fn an_inference_bearer_cannot_authorize_budget_charges() {
    let mut ctx = crate::pipeline::test_support::plain_request_context();
    ctx.org_id = Some("org-1".to_owned());
    ctx.agent_id = Some("agent-1".to_owned());
    ctx.key_config = None;
    assert!(!may_accept_tool_charge(&ctx, false, false));
    assert!(may_accept_tool_charge(&ctx, false, true));

    ctx.is_master_key = true;
    assert!(may_accept_tool_charge(&ctx, false, false));
}
