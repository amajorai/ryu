//! Evaluator catalog HTTP surface.
//!
//! `GET /v1/evaluators` returns the full shared evaluator catalog (the seed
//! registry) for the desktop catalog UI. Like `firewall::firewall_check` and
//! `evals::get_evals`, this is a read-only computation over static seed data: it
//! mutates no gateway state and exposes no secret, so it is not behind the
//! master-key admin gate that `config`/`audit` use.
//!
//! Each entry carries an `enforced` flag so the UI can honestly surface which
//! evaluators are catalogued vs actually wired to execution: as of P3 the five
//! wired text detectors (pii_leakage, code_injection, prompt_injection, toxicity,
//! bias_fairness) report `enforced: true`; every other entry stays `false`. The
//! `higherIsBetter` flag exposes score polarity (negative-signal judges score a
//! BAD signal, so a high score is worse).

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::evaluators::EvaluatorRegistry;
use crate::state::SharedState;

/// GET /v1/evaluators — the full evaluator catalog: the built-in seed table merged
/// with any user-authored `config.custom_evaluators` (custom entries override a
/// built-in by `id` and always report `builtin: false`). The desktop reads this to
/// render the catalog and to read-modify-write the custom set (filter `builtin ==
/// false`).
pub async fn get_evaluators(State(state): State<SharedState>) -> Json<Value> {
    let registry = EvaluatorRegistry::from_config(&state.config);
    Json(json!({ "evaluators": registry.all() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    #[tokio::test]
    async fn get_evaluators_returns_the_seed_catalog() {
        let state = Arc::new(AppState::new_for_test_default());
        let Json(body) = get_evaluators(State(state)).await;
        let list = body["evaluators"].as_array().expect("evaluators array");
        assert!(!list.is_empty(), "the built-in seed catalog is non-empty");
        // The five wired text detectors must be catalogued and flagged enforced.
        let enforced_ids: Vec<&str> = list
            .iter()
            .filter(|e| e["enforced"] == serde_json::json!(true))
            .filter_map(|e| e["id"].as_str())
            .collect();
        assert!(enforced_ids.contains(&"prompt_injection"));
        assert!(enforced_ids.contains(&"pii_leakage"));
    }
}
