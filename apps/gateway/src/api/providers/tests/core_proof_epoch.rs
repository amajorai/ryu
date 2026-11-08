//! A Core proof key derived at a retired node-root epoch no longer grants
//! Core's trusted-forwarder role to a dynamic `rgw_`: a removed admin who
//! copied a node's proof key cannot run managed provider calls or post wallet
//! charges for the org.
//!
//! `org-retired` (bearer `rgw_retired`) is at epoch 1 in the mock control
//! plane, so the shared proof key these tests present (accepted only at epoch
//! 0 on a multi-org Gateway) is retired for it while `org-alpha` keeps it.

use super::*;
use crate::api::budget::charge_tool;

fn charge_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    headers.insert(
        "x-ryu-core-key",
        HeaderValue::from_static("gwcore_proof_test_0123456789abcdef"),
    );
    headers
}

#[tokio::test]
async fn a_retired_proof_key_cannot_run_managed_provider_calls() {
    let _env = proof_key_env().await;
    let (state, mut executions, mut debits, servers) = managed_gateway(|_| {}).await;

    let refused = call(
        &state,
        "rgw_retired",
        None,
        "execute",
        "GMAIL_GET_PROFILE",
        None,
        "retired-call",
    )
    .await;
    assert!(
        matches!(refused, Err(GatewayError::Unauthorized(_))),
        "{refused:?}"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), executions.recv())
            .await
            .is_err(),
        "the vendor must not be called"
    );
    assert!(debits.try_recv().is_err(), "nothing may be debited");

    // An org still at epoch 0 keeps Core's trusted path.
    let _ = call(
        &state,
        "rgw_alpha",
        None,
        "execute",
        "GMAIL_GET_PROFILE",
        None,
        "current-call",
    )
    .await
    .unwrap();
    assert!(executions.recv().await.is_some());
    servers.iter().for_each(|server| server.abort());
}

#[tokio::test]
async fn a_retired_proof_key_cannot_charge_or_freeze_the_wallet() {
    let _env = proof_key_env().await;
    let (state, _executions, mut debits, servers) = managed_gateway(|_| {}).await;

    for body in [
        json!({"tool_calls": 1, "provider": "treg", "cost_micro_usd": 1_000_000}),
        json!({"tool_calls": 1, "provider": "composio", "composioAccountingUnavailable": true}),
    ] {
        let body = serde_json::from_value(body).unwrap();
        let refused = charge_tool(
            State(Arc::clone(&state)),
            charge_headers("rgw_retired"),
            Json(body),
        )
        .await;
        assert!(
            matches!(refused, Err(GatewayError::Unauthorized(_))),
            "{refused:?}"
        );
    }
    assert!(!state.wallet.is_org_accounting_unavailable("org-retired"));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), debits.recv())
            .await
            .is_err(),
        "nothing may be debited"
    );

    // The same outage report from an org at its current epoch is accepted.
    let body = serde_json::from_value(
        json!({"tool_calls": 1, "provider": "composio", "composioAccountingUnavailable": true}),
    )
    .unwrap();
    let reported = charge_tool(
        State(Arc::clone(&state)),
        charge_headers("rgw_alpha"),
        Json(body),
    )
    .await;
    assert!(
        matches!(reported, Err(GatewayError::ProviderError(..))),
        "{reported:?}"
    );
    assert!(state.wallet.is_org_accounting_unavailable("org-alpha"));
    servers.iter().for_each(|server| server.abort());
}
