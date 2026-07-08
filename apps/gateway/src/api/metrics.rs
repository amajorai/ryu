use axum::{extract::State, Json};
use serde_json::Value;

use crate::state::SharedState;

pub async fn get_metrics(State(state): State<SharedState>) -> Json<Value> {
    let cfg = &state.config.evals;
    let scores = state.evals.all_provider_scores();
    let sampled = state.evals.sampled_count();

    let evals_arg = Some((&scores, cfg.enabled, cfg.sample_rate, sampled));
    let provider_health = state.circuit_breaker.snapshot();
    let mut snapshot = state
        .metrics
        .snapshot_with_evals_and_health(evals_arg, Some(&provider_health));
    // Per-provider upstream quota / rate-limit countdowns (#3) for the desktop
    // cost/quota dashboard. Additive: absent when no provider has reported yet.
    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("provider_quota".to_string(), state.quota.snapshot());
    }
    Json(snapshot)
}

/// Live admission-queue depth for the gated local engine — in-flight vs queued
/// (with interactive/background split). Read-only status, ungated like
/// `/metrics`. Core proxies this to surface "N/M slots busy · K queued" in the
/// desktop engine panel (Layer 2 observability).
pub async fn get_concurrency(State(state): State<SharedState>) -> Json<Value> {
    let gates = state.admission.snapshots();
    Json(serde_json::json!({
        "enabled": state.config.concurrency.enabled,
        "local_max_in_flight": state.config.concurrency.local_max_in_flight,
        "local_max_queued": state.config.concurrency.local_max_queued,
        "gates": gates,
    }))
}
