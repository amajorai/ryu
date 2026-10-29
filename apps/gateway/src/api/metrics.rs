use std::sync::atomic::Ordering;

use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::state::SharedState;

pub async fn get_metrics(State(state): State<SharedState>) -> Json<Value> {
    let runtime = state.provider_runtime.snapshot();
    let cfg = &state.config.evals;
    let scores = state.evals.all_provider_scores();
    let sampled = state.evals.sampled_count();

    let evals_arg = Some((&scores, cfg.enabled, cfg.sample_rate, sampled));
    let mut circuits = state.circuit_breaker.snapshot();
    let provider_health = runtime
        .providers
        .available_providers()
        .into_iter()
        .filter_map(|provider| {
            circuits
                .remove(&runtime.epoch.circuit_key(&provider))
                .map(|health| (provider, health))
        })
        .collect();
    let mut snapshot = state
        .metrics
        .snapshot_with_evals_and_health(evals_arg, Some(&provider_health));
    // Per-provider upstream quota / rate-limit countdowns (#3) for the desktop
    // cost/quota dashboard. Additive: absent when no provider has reported yet.
    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("provider_quota".to_string(), runtime.quota.snapshot());
        obj.insert("cache_backends".to_string(), cache_backends(&state));
    }
    Json(snapshot)
}

/// Active cache backends and, where a backend keeps them, its own counters
/// (hits, misses, stores, evictions, errors, and size for the embedding store).
fn cache_backends(state: &crate::state::AppState) -> Value {
    let semantic = state.semantic_cache.active().map(|backend| {
        json!({
            "backend": state.config.backends.semantic_cache,
            "stats": backend.stats(),
        })
    });
    json!({
        "exact": {
            "backend": state.cache.active_id(),
            "stats": state.cache.stats(),
        },
        "semantic": semantic,
        "embedding": state.embedding_cache.as_ref().map(ryu_gw_cache::EmbeddingCache::stats),
    })
}

/// Public, ungated community-savings aggregate (mirrors `/metrics` registration
/// but exposes ONLY safe totals — no per-provider maps, no quota, no keys).
/// Core's community-stats beacon reads this to fan out anonymous savings to the
/// control plane. Opt-out on the Core side; the gateway endpoint itself is public.
pub async fn community_savings(State(state): State<SharedState>) -> Json<Value> {
    let m = &state.metrics;
    let requests = m.total_requests.load(Ordering::Relaxed);
    let malicious_calls_blocked = m.firewall_blocked.load(Ordering::Relaxed);
    let hits = m.cache_hits.load(Ordering::Relaxed);
    let misses = m.cache_misses.load(Ordering::Relaxed);
    let total_cache = hits + misses;
    let cache_hit_rate = if total_cache == 0 {
        0.0_f64
    } else {
        hits as f64 / total_cache as f64
    };

    Json(json!({
        "requests":      requests,
        // Every request admitted to the Gateway pipeline is inspected by its
        // configured rate-limit, routing, and policy stages.
        "api_calls_protected": requests,
        // This counter covers firewall, policy, and evaluator blocks. It is
        // intentionally a safe aggregate with no rule names or request content.
        "malicious_calls_blocked": malicious_calls_blocked,
        "input_tokens":  m.total_input_tokens.load(Ordering::Relaxed),
        "output_tokens": m.total_output_tokens.load(Ordering::Relaxed),
        "tokens_saved":  m.compression_tokens_saved.load(Ordering::Relaxed),
        "cache_hit_rate": cache_hit_rate,
    }))
}

/// Live admission-queue depth for the gated local engine — in-flight vs queued
/// (with interactive/background split). The router applies the shared admin
/// gate used by `/metrics`. Core proxies "N/M slots busy · K queued" in the
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    #[tokio::test]
    async fn get_metrics_includes_provider_quota_snapshot() {
        let state = Arc::new(AppState::new_for_test_default());
        let Json(body) = get_metrics(State(state)).await;
        // The quota map is always spliced in (empty until a provider reports).
        assert!(body.get("provider_quota").is_some());
    }

    #[tokio::test]
    async fn metrics_projects_only_current_epoch_circuits_and_quota() {
        let mut state = AppState::new_for_test_default();
        state
            .provider_runtime
            .register_for_test(Arc::new(crate::providers::LocalProvider::new(
                reqwest::Client::new(),
                "http://localhost:1".into(),
            )));
        let runtime = state.provider_runtime.snapshot();
        state.circuit_breaker.record_failure("stale-epoch:local");
        state.circuit_breaker.record_failure("local");
        state
            .circuit_breaker
            .record_success(&runtime.epoch.circuit_key("local"));
        runtime.quota.record_success(
            "local",
            &ryu_gw_providers::RateLimitInfo {
                remaining: Some(7),
                ..Default::default()
            },
        );

        let Json(body) = get_metrics(State(Arc::new(state))).await;
        assert_eq!(body["provider_health"]["local"]["circuit"], "closed");
        assert_eq!(body["provider_health"].as_object().unwrap().len(), 1);
        assert_eq!(body["provider_quota"]["local"]["remaining"], 7);
    }

    #[tokio::test]
    async fn community_savings_exposes_only_safe_totals() {
        let state = Arc::new(AppState::new_for_test_default());
        let Json(body) = community_savings(State(state)).await;
        // Fresh state: zero requests, zero cache traffic ⇒ rate defaults to 0.0.
        assert_eq!(body["requests"], 0);
        assert_eq!(body["api_calls_protected"], 0);
        assert_eq!(body["malicious_calls_blocked"], 0);
        assert_eq!(body["cache_hit_rate"], 0.0);
        // Must NOT leak per-provider maps / quota / keys.
        assert!(body.get("provider_quota").is_none());
        assert!(body.get("api_keys").is_none());
    }

    #[tokio::test]
    async fn get_concurrency_reports_configured_limits() {
        let state = Arc::new(AppState::new_for_test_default());
        let Json(body) = get_concurrency(State(Arc::clone(&state))).await;
        assert_eq!(body["enabled"], state.config.concurrency.enabled);
        assert_eq!(
            body["local_max_in_flight"],
            state.config.concurrency.local_max_in_flight
        );
        assert!(body["gates"].is_object() || body["gates"].is_array());
    }
}
