//! The evals API: `GET /v1/evals`, `GET /v1/evals/online`, `POST /v1/evals/run`
//! and `POST /v1/evals/score`, plus the online-eval job scorer. Each submodule
//! owns one responsibility; this root re-exports what the router and the
//! online worker name, so `crate::api::evals::*` paths are unchanged.

mod assertion_vars;
mod case;
mod dataset;
mod evaluators;
mod heuristics;
mod judge;
mod limits;
mod llm_evaluator;
mod request;
mod run;
mod score_online;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    evals::{
        aggregate_scores, apply_assertion_options as apply_eval_assertion_options,
        build_judge_prompt, builtin_dataset, eval_assertion_deterministic,
        eval_assertion_deterministic_with_metrics, judge_pass, judge_reply_text, parse_judge_reply,
        render_template, resolve_judge_model, score_case, set_measurement_availability,
        truncate_chars, Assertion, AssertionMetrics, AssertionOptions, AssertionResult, CaseScore,
        EvalCase, EvalRunAggregate, EvaluatorScore,
    },
    evaluators::{EvaluatorImpl, EvaluatorRegistry, EvaluatorTarget},
    pipeline,
    state::SharedState,
};

use self::assertion_vars::{assertion_options, render_assertion_vars};
use self::case::run_eval_case;
use self::dataset::{
    apply_builtin_output_transform, apply_builtin_vars_transform, case_model, expanded_dataset,
    precomputed_response, render_case_prompt, response_cost_micro_usd,
};
use self::evaluators::{errored_case_evaluators, score_evaluators, union_evaluator_ids, JudgeCtx};
use self::heuristics::{score_builtin, score_heuristic, score_regex};
use self::judge::{
    assertion_kind, has_reference_context, judge_call, run_llm_judge, skipped_assertion_result,
    JudgeOutcome,
};
use self::limits::{
    model_graded_assertion_count, validate_assertion_tree, validate_eval_request,
    DEFAULT_EVAL_TIMEOUT_MS, MAX_EVAL_ASSERTIONS_PER_CASE, MAX_EVAL_CASES,
    MAX_EVAL_EVALUATORS_PER_CASE, MAX_EVAL_MAP_ENTRIES, MAX_EVAL_REPEAT, MAX_EVAL_TEXT_CHARS,
    MAX_ONLINE_RESPONSE_BYTES,
};
pub use self::limits::{MAX_EVAL_REQUEST_BYTES, MAX_ONLINE_SCORE_REQUEST_BYTES};
use self::llm_evaluator::score_llm_judge_evaluator;
pub(crate) use self::request::{
    configured_default_model, configured_judge_model, EVAL_FEATURE, ONLINE_EVAL_FEATURE,
};
use self::request::{
    online_score_needs_judge, resolve_request_model, tag_eval_context, UNNAMED_ONLINE_SCORE_MODEL,
};
pub use self::request::{OnlineScoreRequest, RunEvalsRequest};
pub use self::run::run_evals;
use self::run::EvalExecutionOptions;
pub use self::score_online::score_online;
// Reached only by the test modules (`use super::*`).
#[cfg(test)]
use self::{evaluators::score_offline_deterministic, judge::judge_outcome, run::RunEvalsResponse};

/// GET /v1/evals
///
/// Returns the current eval configuration and per-provider rolling scores.
/// When evals are disabled the endpoint returns `enabled: false` and an empty
/// providers map — it never panics and never returns a non-200 for a healthy
/// gateway.
pub async fn get_evals(State(state): State<SharedState>) -> Json<Value> {
    let cfg = &state.config.evals;

    let online = online_summary(&state);
    if !cfg.enabled {
        return Json(json!({
            "enabled": false,
            "sample_rate": cfg.sample_rate,
            "max_latency_ms": cfg.max_latency_ms,
            "providers": {},
            "online": online,
        }));
    }

    let providers = state.evals.all_provider_scores();

    Json(json!({
        "enabled": true,
        "sample_rate": cfg.sample_rate,
        "max_latency_ms": cfg.max_latency_ms,
        "providers": providers,
        "online": online,
    }))
}

/// Online-eval configuration + counters, as reported by `GET /v1/evals` and
/// `GET /v1/evals/online`.
fn online_summary(state: &SharedState) -> Value {
    let online = &state.config.evals.online;
    json!({
        "enabled": online.enabled,
        "running": state.online_evals.is_running(),
        "sample_rate": online.sample_rate,
        "evaluators": online.evaluators,
        "judge_model": online
            .judge_model
            .clone()
            .or_else(|| configured_judge_model(&state.config)),
        "max_judge_calls_per_minute": online.max_judge_calls_per_minute,
        "tenants": online.tenants.keys().collect::<Vec<_>>(),
        "stats": state.online_evals.stats(),
    })
}

/// GET /v1/evals/online
///
/// Recent scores for sampled production requests, newest first. Filter with
/// `request_id`, `trace_id`, `tenant`, `agent_id`, `evaluator`, `failed_only`
/// and `limit` (default 100, max 1000). Admin/observability-gated like
/// `GET /v1/evals`.
pub async fn get_online_evals(
    State(state): State<SharedState>,
    axum::extract::Query(query): axum::extract::Query<crate::evals::online::OnlineEvalQuery>,
) -> Json<Value> {
    Json(json!({
        "online": online_summary(&state),
        "records": state.online_evals.query(&query),
    }))
}

/// Score one sampled production request (the online-eval worker's unit of
/// work). LLM-judge evaluators run through the governed pipeline under the
/// original request's tenant context, tagged `online-eval` so they are never
/// re-sampled, and each judge call first takes a slot from the tenant's
/// per-minute judge budget. The judge model resolves as: the evaluator's own
/// `offline.judgeModel` → the tenant's `[evals.online]` `judge_model` →
/// `[evals].judge_model` → `[evals].default_model` / pinned chat model → the
/// model that served the request.
pub(crate) async fn score_online_job(
    state: SharedState,
    job: crate::evals::online::OnlineEvalJob<pipeline::RequestContext>,
) -> crate::evals::online::OnlineEvalRecord {
    let registry = state.evaluator_registry();
    let configured_judge = job
        .judge_model
        .clone()
        .or_else(|| configured_judge_model(&state.config))
        .or_else(|| configured_default_model(&state.config));
    let mut ctx = job.context.clone();
    ctx.feature = Some(ONLINE_EVAL_FEATURE.to_owned());
    ctx.request_id = uuid::Uuid::new_v4().to_string();
    let online = Arc::clone(&state.online_evals);
    let tenant = job.tenant.clone();
    let limit = job.max_judge_calls_per_minute;
    let gate: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
        online.try_acquire_judge(&tenant, limit, chrono::Utc::now().timestamp_millis())
    });
    let judge_ctx = JudgeCtx {
        state: Arc::clone(&state),
        ctx,
        request_judge_model: configured_judge.clone(),
        fallback_model: job.model.clone(),
        request_evaluators: Vec::new(),
        judge_gate: Some(gate),
    };
    let case = EvalCase {
        id: Some(job.request_id.clone()),
        prompt: job.prompt.clone(),
        evaluators: job.evaluators.clone(),
        ..Default::default()
    };
    let scores = score_evaluators(&case, &job.response, &registry, &judge_ctx).await;
    // Report the judge the first LLM-judge evaluator actually resolved to
    // (its own `offline.judgeModel` wins over the configured judge).
    let judge_model = job
        .evaluators
        .iter()
        .filter_map(|id| registry.get(id))
        .find(|evaluator| matches!(evaluator.impl_, EvaluatorImpl::LlmJudge { .. }))
        .map(|evaluator| {
            resolve_judge_model(
                evaluator
                    .offline
                    .as_ref()
                    .and_then(|offline| offline.judge_model.as_deref()),
                configured_judge.as_deref(),
                &job.model,
            )
        });
    let mut record = crate::evals::online::OnlineEvalRecord::from_job(
        &job,
        scores,
        chrono::Utc::now().timestamp_millis(),
    );
    record.judge_model = judge_model;
    record
}

#[cfg(test)]
#[path = "evals_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "evals_run_tests.rs"]
mod run_evals_tests;

#[cfg(test)]
#[path = "evals_case_options_tests.rs"]
mod case_options_tests;

#[cfg(test)]
#[path = "evals_online_tests.rs"]
mod online_tests;

#[cfg(test)]
#[path = "evals_config_tests.rs"]
mod config_tests;
