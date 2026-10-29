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
        eval_assertion_deterministic_with_metrics, judge_pass, parse_judge_verdict,
        render_template, resolve_judge_model, score_case, set_measurement_availability,
        truncate_chars, Assertion, AssertionMetrics, AssertionOptions, AssertionResult, CaseScore,
        EvalCase, EvalRunAggregate, EvaluatorScore,
    },
    evaluators::{EvaluatorImpl, EvaluatorRegistry, EvaluatorTarget},
    pipeline,
    state::SharedState,
};

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

// ─── POST /v1/evals/run ───────────────────────────────────────────────────────
//
// Replays a dataset through the gateway pipeline and returns per-case scores
// plus an aggregate. Every case is scored on latency / token_efficiency /
// policy_pass / optional substring_match, plus any per-case `assertions`
// (including `llm_judge`, which judges through this same pipeline) and any
// registry evaluators requested per-case or run-level in `evaluators`
// (evaluators that cannot run over a text dataset report `executed: false`).
//
// The model/provider for each replay flows through the existing router — nothing
// is hardcoded. When `dataset` is empty or absent the built-in 3-case dataset
// is used so the desktop "Run evals" panel has something meaningful on first run.

/// Request body for POST /v1/evals/run.
#[derive(Debug, Deserialize)]
pub struct RunEvalsRequest {
    /// Model to evaluate (forwarded to the gateway pipeline as-is). The router
    /// decides which provider to use — no provider is hardcoded here. When
    /// omitted (and `models` is empty) the Gateway's configured default model
    /// is used (see [`configured_default_model`]); with none configured the
    /// request is rejected with 400 rather than assuming a vendor model.
    #[serde(default)]
    pub model: String,
    /// Optional agent/app id for per-agent budget tracking. When set it is
    /// forwarded as `x-ryu-agent-id` context to the pipeline.
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    /// Dataset to replay. When empty or absent, the built-in dataset is used.
    #[serde(default)]
    pub dataset: Vec<EvalCase>,

    // ── NEW ──
    /// Run-level system prompt. When present, every case's provider request
    /// prepends `{role:"system", content:<rendered system_prompt>}`. `{{vars}}`
    /// in it are substituted per-case using that case's `vars`.
    #[serde(default)]
    #[serde(alias = "systemPrompt")]
    pub system_prompt: Option<String>,
    /// Optional run-level multi-turn prompt variant. Rendered messages are
    /// prepended before each case's messages; `system_prompt` remains the
    /// backward-compatible text form and may be combined with this list.
    #[serde(default)]
    #[serde(alias = "systemMessages")]
    pub system_messages: Vec<crate::evals::EvalMessage>,
    /// Multi-model. When non-empty, the whole dataset runs against each model
    /// and the response gains a per-model `models` breakdown. `model` (singular)
    /// stays the back-compat default and seeds the top-level cases/aggregate.
    #[serde(default)]
    pub models: Vec<String>,
    /// Optional judge model override. When set, this single fixed model judges
    /// EVERY model's output (fair cross-model compare). When unset, the first
    /// model in the run is used as the single fixed judge.
    #[serde(default)]
    #[serde(alias = "judgeModel")]
    pub judge_model: Option<String>,

    // ── NEW (P2) ──
    /// Registry evaluator ids applied to EVERY case (unioned with each case's own
    /// `evaluators`). Empty by default => today's assertion-only behavior.
    #[serde(default)]
    pub evaluators: Vec<String>,
    /// Maximum number of provider calls allowed in parallel. The runner caps
    /// this to protect the local Gateway and budgets.
    #[serde(default)]
    #[serde(alias = "maxConcurrency")]
    pub max_concurrency: Option<usize>,
    /// Per-case provider deadline in milliseconds.
    #[serde(default)]
    #[serde(alias = "timeoutMs")]
    pub timeout_ms: Option<u64>,
    /// Repeat every input case this many times (capped server-side).
    #[serde(default)]
    pub repeat: Option<usize>,
    /// Reuse identical provider inputs during this run.
    #[serde(default)]
    pub cache: bool,
    /// Run-level tags kept in the result envelope.
    #[serde(default)]
    pub tags: std::collections::HashMap<String, String>,
    /// Prompt prefix/suffix applied to single-turn case prompts.
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub suffix: Option<String>,
    /// Stable prompt variant id for result matrices.
    #[serde(default)]
    #[serde(alias = "promptId")]
    pub prompt_id: Option<String>,
}

/// The model an eval run or online score uses when the request names none, in
/// precedence order: `[evals].default_model`, then the model pinned for the
/// chat modality (`routing.modality_map.chat.model`, which already replaces the
/// caller's model on every chat request). `None` when neither is configured —
/// callers must then name a model; no vendor model is assumed.
pub(crate) fn configured_default_model(config: &crate::config::GatewayConfig) -> Option<String> {
    let pinned_chat = config
        .routing
        .modality_map
        .get(&crate::config::Modality::Chat)
        .and_then(|mapping| mapping.model.as_deref());
    [config.evals.default_model.as_deref(), pinned_chat]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|model| !model.is_empty())
        .map(str::to_owned)
}

/// The configured judge model (`[evals].judge_model`), trimmed; `None` when
/// unset so callers fall back to the model under test / that answered.
pub(crate) fn configured_judge_model(config: &crate::config::GatewayConfig) -> Option<String> {
    config
        .evals
        .judge_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
}

/// `x-ryu-feature` stamped on eval traffic (dataset replays, online-score
/// judges). Online sampling skips it so eval calls are never re-scored.
pub(crate) const EVAL_FEATURE: &str = "eval";
/// Feature stamped on the judge calls the online scorer makes.
pub(crate) const ONLINE_EVAL_FEATURE: &str = "online-eval";

fn tag_eval_context(mut ctx: pipeline::RequestContext) -> pipeline::RequestContext {
    ctx.feature = Some(EVAL_FEATURE.to_owned());
    ctx
}

const NO_DEFAULT_MODEL_ERROR: &str = "model is required: this Gateway has no default model configured. Send `model` (or `models`), or set `[evals] default_model` in the Gateway config";

/// Fill an omitted `model` from the Gateway default. `Err` carries the 400
/// message when the request names no model and none is configured.
fn resolve_request_model(
    model: &mut String,
    has_other_models: bool,
    config: &crate::config::GatewayConfig,
) -> Result<(), &'static str> {
    if has_other_models || !model.trim().is_empty() {
        return Ok(());
    }
    *model = configured_default_model(config).ok_or(NO_DEFAULT_MODEL_ERROR)?;
    Ok(())
}

/// Model label recorded on an online score that named no model, needed no judge,
/// and ran on a Gateway with no default model.
const UNNAMED_ONLINE_SCORE_MODEL: &str = "unspecified";

/// Whether scoring this already-produced response calls a judge model: any
/// model-graded assertion (at any `AssertSet` depth) or an LLM-judge evaluator.
fn online_score_needs_judge(
    assertions: &[Assertion],
    evaluators: &[String],
    registry: &EvaluatorRegistry,
) -> bool {
    assertions
        .iter()
        .any(|assertion| model_graded_assertion_count(assertion) > 0)
        || evaluators.iter().any(|id| {
            registry
                .get(id)
                .is_some_and(|evaluator| matches!(evaluator.impl_, EvaluatorImpl::LlmJudge { .. }))
        })
}

const MAX_EVAL_CASES: usize = 1_000;
const MAX_EVAL_REPEAT: usize = 20;
const MAX_EVAL_MODELS: usize = 32;
const MAX_EVAL_ASSERTIONS_PER_CASE: usize = 32;
const MAX_EVAL_ASSERTION_DEPTH: usize = 8;
const MAX_EVAL_ASSERTION_NODES: usize = 128;
const MAX_EVAL_EVALUATORS_PER_CASE: usize = 32;
const MAX_EVAL_MESSAGES_PER_CASE: usize = 32;
const MAX_EVAL_MAP_ENTRIES: usize = 128;
const MAX_EVAL_TEXT_CHARS: usize = 64 * 1024;
const MAX_EVAL_CASE_BYTES: usize = 256 * 1024;
const MAX_ONLINE_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_EVAL_REQUEST_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_ONLINE_SCORE_REQUEST_BYTES: usize = 512 * 1024;
const MAX_EVAL_PROVIDER_CALLS: usize = 2_000;
const DEFAULT_EVAL_TIMEOUT_MS: u64 = 120_000;

fn is_model_graded_assertion(assertion: &Assertion) -> bool {
    matches!(
        assertion,
        Assertion::LlmJudge { .. }
            | Assertion::LlmRubric { .. }
            | Assertion::Similar { .. }
            | Assertion::Factuality { .. }
            | Assertion::ContextFaithfulness { .. }
            | Assertion::AnswerRelevance { .. }
    )
}

/// Bound recursive assertion sets before scoring. A top-level count alone is
/// insufficient: nested `AssertSet`s can otherwise multiply deterministic work
/// exponentially and recurse until the process stack is exhausted.
fn validate_assertion_tree(
    assertions: &[Assertion],
    depth: usize,
    nodes: &mut usize,
) -> Result<(), String> {
    if depth > MAX_EVAL_ASSERTION_DEPTH {
        return Err(format!(
            "assertion nesting is limited to {MAX_EVAL_ASSERTION_DEPTH} levels"
        ));
    }
    if assertions.len() > MAX_EVAL_ASSERTIONS_PER_CASE {
        return Err(format!(
            "each assertion set may contain at most {MAX_EVAL_ASSERTIONS_PER_CASE} assertions"
        ));
    }
    for assertion in assertions {
        *nodes = nodes.saturating_add(1);
        if *nodes > MAX_EVAL_ASSERTION_NODES {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_ASSERTION_NODES} assertion nodes"
            ));
        }
        if let Assertion::AssertSet { assertions, .. } = assertion {
            validate_assertion_tree(assertions, depth + 1, nodes)?;
        }
        if depth > 0 && is_model_graded_assertion(assertion) {
            return Err(
                "model-graded assertions cannot be nested inside assert_set; move them to the case's top-level assertions"
                    .to_owned(),
            );
        }
    }
    Ok(())
}

fn validate_eval_request(
    req: &RunEvalsRequest,
    registry: &EvaluatorRegistry,
) -> Result<(), String> {
    if req.dataset.len() > MAX_EVAL_CASES {
        return Err(format!("eval dataset is limited to {MAX_EVAL_CASES} cases"));
    }
    let repeat = req.repeat.unwrap_or(1).clamp(1, MAX_EVAL_REPEAT);
    if req.dataset.len().max(1).saturating_mul(repeat) > MAX_EVAL_CASES {
        return Err(format!(
            "expanded eval dataset is limited to {MAX_EVAL_CASES} cases"
        ));
    }
    if req.models.len() > MAX_EVAL_MODELS {
        return Err(format!(
            "at most {MAX_EVAL_MODELS} models may be evaluated per request"
        ));
    }
    if req.evaluators.len() > MAX_EVAL_EVALUATORS_PER_CASE {
        return Err(format!(
            "at most {MAX_EVAL_EVALUATORS_PER_CASE} run-level evaluators are allowed"
        ));
    }
    if req.system_messages.len() > MAX_EVAL_MESSAGES_PER_CASE {
        return Err(format!(
            "at most {MAX_EVAL_MESSAGES_PER_CASE} system messages are allowed"
        ));
    }
    if req.tags.len() > MAX_EVAL_MAP_ENTRIES {
        return Err(format!(
            "at most {MAX_EVAL_MAP_ENTRIES} run tags are allowed"
        ));
    }
    for (label, value) in [
        ("model", req.model.as_str()),
        (
            "judge_model",
            req.judge_model.as_deref().unwrap_or_default(),
        ),
        (
            "system_prompt",
            req.system_prompt.as_deref().unwrap_or_default(),
        ),
        ("prefix", req.prefix.as_deref().unwrap_or_default()),
        ("suffix", req.suffix.as_deref().unwrap_or_default()),
    ] {
        let limit = if matches!(label, "model" | "judge_model") {
            256
        } else {
            MAX_EVAL_TEXT_CHARS
        };
        if value.chars().count() > limit {
            return Err(format!("{label} is limited to {limit} characters"));
        }
    }
    if req.models.is_empty() && req.model.trim().is_empty() {
        return Err("at least one model is required".to_owned());
    }
    if req
        .judge_model
        .as_deref()
        .is_some_and(|model| model.trim().is_empty())
    {
        return Err("judge_model must not be empty".to_owned());
    }
    if req
        .agent_id
        .as_deref()
        .is_some_and(|agent| agent.chars().count() > 256)
    {
        return Err("agent_id is limited to 256 characters".to_owned());
    }
    if req
        .prompt_id
        .as_deref()
        .is_some_and(|prompt_id| prompt_id.chars().count() > 256)
    {
        return Err("prompt_id is limited to 256 characters".to_owned());
    }
    if req.tags.iter().any(|(key, value)| {
        key.chars().count() > 256 || value.chars().count() > MAX_EVAL_TEXT_CHARS
    }) {
        return Err("eval tag keys are limited to 256 and values to 65536 characters".to_owned());
    }
    for message in &req.system_messages {
        if message.role.chars().count() > 64
            || message.content.chars().count() > MAX_EVAL_TEXT_CHARS
        {
            return Err(format!(
                "system message fields are limited to {MAX_EVAL_TEXT_CHARS} characters"
            ));
        }
    }
    for (index, model) in req.models.iter().enumerate() {
        if model.chars().count() > 256 {
            return Err(format!("models[{index}] is limited to 256 characters"));
        }
    }
    for (index, evaluator) in req.evaluators.iter().enumerate() {
        if evaluator.chars().count() > 256 {
            return Err(format!("evaluators[{index}] is limited to 256 characters"));
        }
    }
    for (index, case) in req.dataset.iter().enumerate() {
        if case
            .id
            .as_deref()
            .is_some_and(|id| id.chars().count() > 256)
            || case
                .provider_output_provider
                .as_deref()
                .is_some_and(|provider| provider.chars().count() > 256)
            || case
                .provider
                .as_deref()
                .is_some_and(|provider| provider.chars().count() > 256)
            || case
                .providers
                .iter()
                .any(|provider| provider.chars().count() > 256)
            || case
                .evaluators
                .iter()
                .any(|evaluator| evaluator.chars().count() > 256)
        {
            return Err(format!(
                "dataset case {index} ids are limited to 256 characters"
            ));
        }
        if case.provider_output.is_none()
            && (case.provider_output_provider.is_some()
                || case.provider_output_policy_pass.is_some()
                || case.provider_latency_ms.is_some()
                || case.provider_cost_micro_usd.is_some())
        {
            return Err(format!(
                "dataset case {index} provider output measurements require provider_output"
            ));
        }
        if case.prompt.chars().count() > MAX_EVAL_TEXT_CHARS
            || case
                .expected
                .as_deref()
                .is_some_and(|value| value.chars().count() > MAX_EVAL_TEXT_CHARS)
            || case
                .description
                .as_deref()
                .is_some_and(|value| value.chars().count() > MAX_EVAL_TEXT_CHARS)
        {
            return Err(format!(
                "dataset case {index} text is limited to {MAX_EVAL_TEXT_CHARS} characters"
            ));
        }
        if case.assertions.len() > MAX_EVAL_ASSERTIONS_PER_CASE {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_ASSERTIONS_PER_CASE} assertions"
            ));
        }
        if case.evaluators.len() > MAX_EVAL_EVALUATORS_PER_CASE {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_EVALUATORS_PER_CASE} evaluators"
            ));
        }
        if case.messages.len() > MAX_EVAL_MESSAGES_PER_CASE {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_MESSAGES_PER_CASE} messages"
            ));
        }
        if case.vars.len() > MAX_EVAL_MAP_ENTRIES || case.metadata.len() > MAX_EVAL_MAP_ENTRIES {
            return Err(format!(
                "each case may contain at most {MAX_EVAL_MAP_ENTRIES} vars and metadata entries"
            ));
        }
        let case_bytes = serde_json::to_vec(case)
            .map_err(|error| format!("dataset case {index} could not be encoded: {error}"))?;
        if case_bytes.len() > MAX_EVAL_CASE_BYTES {
            return Err(format!(
                "dataset case {index} is limited to {MAX_EVAL_CASE_BYTES} bytes"
            ));
        }
        for message in &case.messages {
            if message.role.chars().count() > 64
                || message.content.chars().count() > MAX_EVAL_TEXT_CHARS
            {
                return Err(format!(
                    "dataset case {index} message fields are limited to {MAX_EVAL_TEXT_CHARS} characters"
                ));
            }
        }
        let mut assertion_nodes = 0;
        validate_assertion_tree(&case.assertions, 0, &mut assertion_nodes)?;
    }

    // Reject unsupported modes before scheduling inference or judge calls.
    registry.validate_offline_ids(&req.evaluators)?;
    for case in &req.dataset {
        registry.validate_offline_ids(&case.evaluators)?;
    }

    let model_count = if req.models.is_empty() {
        1
    } else {
        req.models
            .iter()
            .filter(|model| !model.trim().is_empty())
            .count()
    };
    if model_count == 0 {
        return Err("at least one non-empty model is required".to_owned());
    }
    let calls_per_dataset = req
        .dataset
        .iter()
        .map(|case| {
            let ids = union_evaluator_ids(&case.evaluators, &req.evaluators);
            let judge_evaluators = ids
                .iter()
                .filter(|id| {
                    registry.get(id).is_some_and(|evaluator| {
                        matches!(evaluator.impl_, EvaluatorImpl::LlmJudge { .. })
                    })
                })
                .count();
            1usize
                .saturating_add(
                    case.assertions
                        .iter()
                        .map(model_graded_assertion_count)
                        .sum::<usize>(),
                )
                .saturating_add(judge_evaluators)
        })
        .sum::<usize>()
        .max(1);
    let total_calls = calls_per_dataset
        .saturating_mul(repeat)
        .saturating_mul(model_count);
    if total_calls > MAX_EVAL_PROVIDER_CALLS {
        return Err(format!(
            "evaluation request may execute at most {MAX_EVAL_PROVIDER_CALLS} provider calls (requested upper bound: {total_calls})"
        ));
    }
    Ok(())
}

fn model_graded_assertion_count(assertion: &Assertion) -> usize {
    match assertion {
        Assertion::AssertSet { assertions, .. } => {
            assertions.iter().map(model_graded_assertion_count).sum()
        }
        assertion if is_model_graded_assertion(assertion) => 1,
        _ => 0,
    }
}

fn expanded_dataset(cases: &[EvalCase], repeat: Option<usize>) -> Vec<EvalCase> {
    let count = repeat.unwrap_or(1).clamp(1, MAX_EVAL_REPEAT);
    if count == 1 {
        return cases.to_vec();
    }
    let mut expanded = Vec::with_capacity(cases.len().saturating_mul(count));
    for repetition in 0..count {
        for (index, case) in cases.iter().enumerate() {
            let mut copy = case.clone();
            copy.id = Some(format!(
                "{}:repeat-{}",
                case.id.as_deref().unwrap_or(&format!("case-{}", index + 1)),
                repetition + 1
            ));
            expanded.push(copy);
        }
    }
    expanded
}

fn precomputed_response(value: &Value) -> Value {
    if value.get("choices").and_then(Value::as_array).is_some() {
        return value.clone();
    }
    let output = value
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            value
                .get("output")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| value.to_string());
    json!({
        "choices": [{"message": {"content": output}}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    })
}

fn response_cost_micro_usd(response: &Value) -> Option<u64> {
    if let Some(value) = response["usage"]["cost_micro_usd"].as_u64() {
        return Some(value);
    }
    ["cost_usd", "cost"]
        .iter()
        .filter_map(|key| response["usage"][*key].as_f64())
        .find(|value| value.is_finite() && *value >= 0.0)
        .map(|value| (value * 1_000_000.0).round() as u64)
}

fn apply_builtin_output_transform(
    response: &mut Value,
    transform: Option<&str>,
) -> Result<(), String> {
    let Some(transform) = transform.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let text = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let transformed = match transform {
        "trim" => text.trim().to_owned(),
        "lower" | "lowercase" => text.to_lowercase(),
        "upper" | "uppercase" => text.to_uppercase(),
        "json" => serde_json::from_str::<Value>(&text)
            .map(|value| serde_json::to_string(&value).unwrap_or(text.clone()))
            .map_err(|error| format!("json transform failed: {error}"))?,
        other => return Err(format!("unsupported output transform '{other}'")),
    };
    response["choices"][0]["message"]["content"] = Value::String(transformed);
    Ok(())
}

fn apply_builtin_vars_transform(
    vars: &mut HashMap<String, Value>,
    transform: Option<&str>,
) -> Result<(), String> {
    let Some(transform) = transform.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    match transform {
        "identity" => Ok(()),
        "json" => {
            for value in vars.values_mut() {
                if let Value::String(text) = value {
                    *value = serde_json::from_str(text)
                        .map_err(|error| format!("json variable transform failed: {error}"))?;
                }
            }
            Ok(())
        }
        other => Err(format!("unsupported variable transform '{other}'")),
    }
}

fn render_case_prompt(
    case: &EvalCase,
    request_prefix: Option<&str>,
    request_suffix: Option<&str>,
) -> String {
    let mut rendered = render_template(&case.prompt, &case.vars);
    if let Some(prefix) = request_prefix {
        rendered = format!("{prefix}{rendered}");
    }
    if let Some(prefix) = case.options.prefix.as_deref() {
        rendered = format!("{prefix}{rendered}");
    }
    if let Some(suffix) = case.options.suffix.as_deref() {
        rendered.push_str(suffix);
    }
    if let Some(suffix) = request_suffix {
        rendered.push_str(suffix);
    }
    rendered
}

fn case_model(case: &EvalCase, fallback: &str) -> String {
    case.provider
        .as_deref()
        .or_else(|| {
            case.providers
                .iter()
                .map(String::as_str)
                .find(|value| !value.trim().is_empty())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

#[derive(Debug, Clone, Default)]
struct EvalExecutionOptions {
    cache: bool,
    prefix: Option<String>,
    suffix: Option<String>,
    system_messages: Vec<crate::evals::EvalMessage>,
    system_prompt: Option<String>,
    timeout_ms: Option<u64>,
    prompt_id: Option<String>,
    provided_cost_micro_usd: Option<u64>,
    provided_latency_ms: Option<u64>,
}

/// One model's full result block (multi-model breakdown entry).
#[derive(serde::Serialize)]
struct ModelEvalResult {
    model: String,
    cases: Vec<CaseScore>,
    aggregate: EvalRunAggregate,
}

/// Wire response for POST /v1/evals/run.
#[derive(serde::Serialize)]
struct RunEvalsResponse {
    /// Always the FIRST evaluated model's cases (back-compat).
    cases: Vec<CaseScore>,
    /// Always the FIRST evaluated model's aggregate (back-compat).
    aggregate: EvalRunAggregate,
    /// Per-model breakdown. OMITTED entirely on the single-model path.
    #[serde(skip_serializing_if = "Option::is_none")]
    models: Option<Vec<ModelEvalResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<String>,
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    tags: std::collections::HashMap<String, String>,
}

/// POST /v1/evals/run
///
/// Replays each prompt in `dataset` through the full gateway pipeline (firewall,
/// routing, provider call) and returns per-case scores plus an aggregate summary.
///
/// Scoring is independent of whether passive evals are enabled — an explicit
/// eval run always scores. Cases may run concurrently up to the request's
/// bounded `max_concurrency`, while results are restored to input order.
pub async fn run_evals(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut req): Json<RunEvalsRequest>,
) -> Response {
    // Fall back to the built-in dataset when none is provided, then expand
    // Promptfoo's repeat option into stable, separately addressable cases.
    if req.dataset.is_empty() {
        req.dataset = builtin_dataset();
    }
    if let Err(error) = resolve_request_model(&mut req.model, !req.models.is_empty(), &state.config)
    {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let registry = state.evaluator_registry();
    if let Err(error) = validate_eval_request(&req, &registry) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let dataset = expanded_dataset(&req.dataset, req.repeat);
    if dataset.len() > MAX_EVAL_CASES {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!("eval dataset is limited to {MAX_EVAL_CASES} cases")
            })),
        )
            .into_response();
    }

    // Authenticate via the same path as chat — this is a normal metered call.
    // The master key is NOT required; any valid API key (including anonymous
    // when auth is disabled) can run evals.
    let raw_key = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let ctx = match pipeline::authenticate(
        &state,
        pipeline::AuthInputs {
            raw_api_key: raw_key.as_deref(),
            agent_id: req.agent_id.clone(),
            ..Default::default()
        },
    )
    .await
    {
        Ok(ctx) => tag_eval_context(ctx),
        // Every refusal keeps its own status, catalogue code and Retry-After,
        // the same as on chat (a fleet with no platform floor answers 503
        // `screening_unavailable`, not 401).
        Err(error) => return error.into_response(),
    };

    let max_latency_ms = state.config.evals.max_latency_ms;

    // The set of models under test. Singular `model` is the back-compat default.
    let model_list: Vec<String> = if req.models.is_empty() {
        vec![req.model.trim().to_owned()]
    } else {
        req.models
            .iter()
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty())
            .take(32)
            .collect()
    };
    if model_list.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "at least one model is required" })),
        )
            .into_response();
    }

    // ONE fixed judge for the whole run (fair cross-model compare). Explicit
    // override wins; otherwise the first/primary model judges every column.
    let judge_model = req
        .judge_model
        .clone()
        .unwrap_or_else(|| model_list[0].clone());

    let multi_model = !req.models.is_empty();
    let run_id = format!("eval_{}", uuid::Uuid::new_v4().simple());
    let started_at = chrono::Utc::now().to_rfc3339();

    // Shared catalog + per-run judge context for offline registry-evaluator
    // scoring (P2). Built from config so user-authored custom evaluators are
    // resolvable by id alongside the built-ins. Cheap to build once; reused for
    // every case/model.
    let judge_ctx = JudgeCtx {
        state: Arc::clone(&state),
        ctx: ctx.clone(),
        request_judge_model: req
            .judge_model
            .clone()
            .or_else(|| configured_judge_model(&state.config)),
        fallback_model: model_list[0].clone(),
        request_evaluators: req.evaluators.clone(),
        judge_gate: None,
    };

    let execution_options = EvalExecutionOptions {
        cache: req.cache,
        prefix: req.prefix.clone(),
        suffix: req.suffix.clone(),
        system_messages: req.system_messages.clone(),
        system_prompt: req.system_prompt.clone(),
        timeout_ms: req.timeout_ms,
        prompt_id: req.prompt_id.clone(),
        provided_cost_micro_usd: None,
        provided_latency_ms: None,
    };
    // Cache is explicitly a single-run de-duplication contract. Serializing a
    // cache-enabled run prevents two identical cases from racing through the
    // miss check and both charging a provider before either stores its result.
    let cache_requested = req.cache || dataset.iter().any(|case| case.options.cache == Some(true));
    let concurrency = if cache_requested {
        1
    } else {
        req.max_concurrency.unwrap_or(1).clamp(1, 32)
    };
    let mut per_model: Vec<ModelEvalResult> = Vec::with_capacity(model_list.len());

    for model in &model_list {
        let cache = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let futures = dataset.iter().cloned().enumerate().map(|(index, case)| {
            run_eval_case(
                Arc::clone(&state),
                ctx.clone(),
                case,
                index,
                model.clone(),
                judge_model.clone(),
                registry.clone(),
                judge_ctx.clone(),
                execution_options.clone(),
                Arc::clone(&cache),
                max_latency_ms,
            )
        });
        let mut stream = stream::iter(futures).buffer_unordered(concurrency);
        let mut ordered: Vec<Option<CaseScore>> = vec![None; dataset.len()];
        while let Some((index, score)) = stream.next().await {
            ordered[index] = Some(score);
        }
        let case_scores: Vec<CaseScore> = ordered.into_iter().flatten().collect();
        let aggregate = aggregate_scores(&case_scores);
        per_model.push(ModelEvalResult {
            model: model.clone(),
            cases: case_scores,
            aggregate,
        });
    }

    // Top-level cases/aggregate mirror the FIRST model (back-compat).
    let first = &per_model[0];
    let response = RunEvalsResponse {
        cases: first.cases.clone(),
        aggregate: first.aggregate.clone(),
        models: if multi_model { Some(per_model) } else { None },
        run_id: Some(run_id),
        started_at: Some(started_at),
        finished_at: Some(chrono::Utc::now().to_rfc3339()),
        tags: req.tags,
    };

    Json(response).into_response()
}

/// Request body for POST /v1/evals/score. This is the online-scoring seam:
/// callers submit an already-completed production output and receive the same
/// deterministic/assertion/evaluator result as a dataset run without replaying
/// the provider call. Optional latency and cost measurements are preserved so
/// operational assertions remain meaningful for externally observed traces.
#[derive(Debug, Deserialize)]
pub struct OnlineScoreRequest {
    #[serde(default)]
    #[serde(alias = "agentId")]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub assertions: Vec<Assertion>,
    #[serde(default)]
    #[serde(alias = "costMicroUsd")]
    pub cost_micro_usd: Option<u64>,
    #[serde(default)]
    pub context: Option<Value>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub evaluators: Vec<String>,
    #[serde(default)]
    pub expected: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    #[serde(alias = "latencyMs")]
    pub latency_ms: Option<u64>,
    /// Optional policy result supplied with an external trace. When omitted,
    /// the policy dimension is marked unmeasured rather than assumed to pass.
    #[serde(default, alias = "policyPass")]
    pub policy_pass: Option<bool>,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    /// Model that produced `response`. When omitted the Gateway's configured
    /// default model is used; with none configured the request is rejected.
    #[serde(default)]
    pub model: String,
    /// Judge for model-graded checks. Defaults to `[evals].judge_model`, then
    /// the model that produced `response`.
    #[serde(default, alias = "judgeModel")]
    pub judge_model: Option<String>,
    #[serde(default)]
    pub prompt: String,
    pub response: Value,
    #[serde(default)]
    pub threshold: Option<f32>,
    #[serde(default)]
    pub vars: HashMap<String, Value>,
}

/// POST /v1/evals/score
///
/// Scores a production output in place. The provider is never replayed for the
/// submitted response; only model-graded assertions/evaluators that explicitly
/// need a judge make a second, visible Gateway call through the normal pipeline.
pub async fn score_online(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut req): Json<OnlineScoreRequest>,
) -> Response {
    let registry = state.evaluator_registry();
    // The response is already given, so a model is only *needed* as the judge for
    // model-graded checks. Deterministic-only scoring must keep working on a
    // Gateway with no default model, so it falls back to a neutral label.
    if online_score_needs_judge(&req.assertions, &req.evaluators, &registry) {
        if let Err(error) = resolve_request_model(&mut req.model, false, &state.config) {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
        }
    } else if req.model.trim().is_empty() {
        req.model = configured_default_model(&state.config)
            .unwrap_or_else(|| UNNAMED_ONLINE_SCORE_MODEL.to_owned());
    }
    if req.response.is_null() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "response is required" })),
        )
            .into_response();
    }
    let response_bytes = match serde_json::to_vec(&req.response) {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("response is not serializable: {error}") })),
            )
                .into_response();
        }
    };
    if response_bytes.len() > MAX_ONLINE_RESPONSE_BYTES {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": format!("response is limited to {MAX_ONLINE_RESPONSE_BYTES} bytes")
            })),
        )
            .into_response();
    }
    if req.assertions.len() > MAX_EVAL_ASSERTIONS_PER_CASE
        || req.evaluators.len() > MAX_EVAL_EVALUATORS_PER_CASE
        || req.vars.len() > MAX_EVAL_MAP_ENTRIES
        || req.metadata.len() > MAX_EVAL_MAP_ENTRIES
        || req.prompt.chars().count() > MAX_EVAL_TEXT_CHARS
        || req
            .expected
            .as_deref()
            .is_some_and(|value| value.chars().count() > MAX_EVAL_TEXT_CHARS)
        || req
            .description
            .as_deref()
            .is_some_and(|value| value.chars().count() > MAX_EVAL_TEXT_CHARS)
        || req.model.chars().count() > 256
        || req.id.as_deref().is_some_and(|id| id.chars().count() > 256)
        || req
            .agent_id
            .as_deref()
            .is_some_and(|agent| agent.chars().count() > 256)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "online score input exceeds one of the bounded limits" })),
        )
            .into_response();
    }
    if req.model.trim().is_empty() || req.evaluators.iter().any(|id| id.chars().count() > 256) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "online score model/evaluator ids are invalid" })),
        )
            .into_response();
    }
    let mut assertion_nodes = 0;
    if let Err(error) = validate_assertion_tree(&req.assertions, 0, &mut assertion_nodes) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let registry = state.evaluator_registry();
    if let Err(error) = registry.validate_offline_ids(&req.evaluators) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
    }
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let ctx = match pipeline::authenticate(
        &state,
        pipeline::AuthInputs {
            raw_api_key: raw_key.as_deref(),
            agent_id: req.agent_id.clone(),
            ..Default::default()
        },
    )
    .await
    {
        Ok(ctx) => tag_eval_context(ctx),
        // Every refusal keeps its own status, catalogue code and Retry-After,
        // the same as on chat (a fleet with no platform floor answers 503
        // `screening_unavailable`, not 401).
        Err(error) => return error.into_response(),
    };
    let model = req.model.trim().to_owned();
    if model.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "model must not be empty" })),
        )
            .into_response();
    }
    let judge_model = req
        .judge_model
        .as_deref()
        .map(str::trim)
        .filter(|judge| !judge.is_empty())
        .map(str::to_owned)
        .or_else(|| configured_judge_model(&state.config))
        .unwrap_or_else(|| model.clone());
    let judge_ctx = JudgeCtx {
        state: Arc::clone(&state),
        ctx: ctx.clone(),
        request_judge_model: Some(judge_model.clone()),
        fallback_model: model.clone(),
        request_evaluators: req.evaluators.clone(),
        judge_gate: None,
    };
    let case = EvalCase {
        id: req.id,
        description: req.description,
        prompt: req.prompt,
        expected: req.expected,
        context: req.context,
        threshold: req.threshold,
        vars: req.vars,
        assertions: req.assertions,
        evaluators: req.evaluators,
        metadata: req.metadata,
        provider_output: Some(req.response),
        provider_output_policy_pass: req.policy_pass,
        ..Default::default()
    };
    let options = EvalExecutionOptions {
        provided_cost_micro_usd: req.cost_micro_usd,
        provided_latency_ms: req.latency_ms,
        prompt_id: Some("online".to_owned()),
        ..Default::default()
    };
    let (_index, score) = run_eval_case(
        Arc::clone(&state),
        ctx,
        case,
        0,
        model,
        judge_model,
        registry,
        judge_ctx,
        options,
        Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        state.config.evals.max_latency_ms,
    )
    .await;
    Json(json!({
        "kind": "online_score",
        "scored_at": chrono::Utc::now().to_rfc3339(),
        "score": score,
    }))
    .into_response()
}

async fn run_eval_case(
    state: SharedState,
    ctx: pipeline::RequestContext,
    case: EvalCase,
    index: usize,
    model: String,
    judge_model: String,
    registry: EvaluatorRegistry,
    judge_ctx: JudgeCtx,
    options: EvalExecutionOptions,
    response_cache: Arc<tokio::sync::Mutex<HashMap<String, Value>>>,
    max_latency_ms: u64,
) -> (usize, CaseScore) {
    let mut case = case;
    let var_transform_error =
        apply_builtin_vars_transform(&mut case.vars, case.options.transform_vars.as_deref()).err();
    let selected_model = case_model(&case, &model);
    let rendered_prompt =
        render_case_prompt(&case, options.prefix.as_deref(), options.suffix.as_deref());
    let mut messages: Vec<Value> = Vec::with_capacity(case.messages.len() + 2);
    if let Some(system_prompt) = &options.system_prompt {
        messages.push(json!({
            "role": "system",
            "content": render_template(system_prompt, &case.vars)
        }));
    }
    if !options.system_messages.is_empty() {
        messages.extend(options.system_messages.iter().map(|message| {
            json!({
                "role": message.role,
                "content": render_template(&message.content, &case.vars)
            })
        }));
    }
    if case.messages.is_empty() {
        messages.push(json!({ "role": "user", "content": rendered_prompt }));
    } else {
        let mut has_user = false;
        for message in &case.messages {
            has_user |= message.role == "user";
            messages.push(json!({
                "role": message.role,
                "content": render_template(&message.content, &case.vars)
            }));
        }
        if !has_user {
            messages.push(json!({ "role": "user", "content": rendered_prompt }));
        }
    }

    let body = json!({
        "model": selected_model.clone(),
        "messages": messages
    });
    let cache_key = serde_json::to_string(&body).unwrap_or_else(|_| format!("case-{index}"));
    let use_cache = options.cache || case.options.cache == Some(true);
    let cached = if use_cache {
        response_cache.lock().await.get(&cache_key).cloned()
    } else {
        None
    };
    let start = Instant::now();
    let mut cache_hit = false;
    let mut provider_used = None;
    let mut model_used = selected_model;
    let mut output_error = var_transform_error;
    let mut response = if let Some(fixture) = case.provider_output.as_ref() {
        provider_used = Some(
            case.provider_output_provider
                .clone()
                .unwrap_or_else(|| "precomputed".to_owned()),
        );
        precomputed_response(fixture)
    } else if let Some(cached) = cached {
        cache_hit = true;
        provider_used = Some("eval-cache".to_owned());
        cached
    } else {
        let timeout_ms = case
            .options
            .timeout_ms
            .or(options.timeout_ms)
            .unwrap_or(DEFAULT_EVAL_TIMEOUT_MS)
            .clamp(100, DEFAULT_EVAL_TIMEOUT_MS);
        match tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            pipeline::run(Arc::clone(&state), ctx.clone(), body),
        )
        .await
        {
            Ok(Ok(output)) => {
                provider_used = Some(output.provider_used.to_owned());
                model_used = output.model_used.clone();
                output.response
            }
            Ok(Err(error)) => {
                output_error = Some(error.to_string());
                json!({
                    "choices": [{"message": {"content": format!("[error: {error}]")}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 0}
                })
            }
            Err(_) => {
                let error = format!("eval case timed out after {timeout_ms}ms");
                output_error = Some(error.clone());
                json!({
                    "choices": [{"message": {"content": format!("[error: {error}]")}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 0}
                })
            }
        }
    };
    let is_precomputed = case.provider_output.is_some();
    let latency_available = !is_precomputed
        || case.provider_latency_ms.is_some()
        || options.provided_latency_ms.is_some();
    let policy_available = !is_precomputed || case.provider_output_policy_pass.is_some();
    let latency_ms = case
        .provider_latency_ms
        .or(options.provided_latency_ms)
        .unwrap_or_else(|| start.elapsed().as_millis() as u64);

    if use_cache && !cache_hit && output_error.is_none() {
        response_cache
            .lock()
            .await
            .insert(cache_key, response.clone());
    }
    if let Err(error) =
        apply_builtin_output_transform(&mut response, case.options.transform.as_deref())
    {
        output_error = Some(error);
    }
    if let Some(cost_micro_usd) = options.provided_cost_micro_usd {
        response["usage"]["cost_micro_usd"] = Value::from(cost_micro_usd);
    }
    if let Some(cost_micro_usd) = response_cost_micro_usd(&response) {
        response["usage"]["cost_micro_usd"] = Value::from(cost_micro_usd);
    } else if let Some(cost_micro_usd) = case.provider_cost_micro_usd {
        response["usage"]["cost_micro_usd"] = Value::from(cost_micro_usd);
    }
    let policy_pass = case
        .provider_output_policy_pass
        .unwrap_or_else(|| !is_precomputed && output_error.is_none());
    let mut score = score_case(&case, &response, latency_ms, policy_pass, max_latency_ms);
    set_measurement_availability(&mut score, latency_available, policy_available);
    score.prompt_id = options.prompt_id;
    score.model = Some(model_used);
    score.provider = provider_used;
    score.rendered_prompt = Some(rendered_prompt);
    score.cache_hit = cache_hit;
    score.error = output_error;

    let assertion_metrics = AssertionMetrics {
        latency_ms: latency_available.then_some(latency_ms),
        cost_micro_usd: score.cost_micro_usd,
    };
    let mut assertion_results = Vec::new();
    let mut assertion_weights = Vec::new();
    if let Some(expected) = &case.expected {
        let assertion = Assertion::Contains {
            value: expected.clone(),
            options: AssertionOptions::default(),
        };
        assertion_results.push(eval_assertion_deterministic_with_metrics(
            &assertion,
            &score.response_text,
            assertion_metrics,
        ));
        assertion_weights.push(1.0);
    }
    for assertion in &case.assertions {
        let result = match assertion {
            Assertion::ContextFaithfulness { .. } if !has_reference_context(&case) => {
                skipped_assertion_result(
                    "context_faithfulness",
                    "context faithfulness requires a non-empty case context",
                )
            }
            Assertion::Factuality { .. }
                if case.expected.is_none() && !has_reference_context(&case) =>
            {
                skipped_assertion_result(
                    "factuality",
                    "factuality requires case.expected or a non-empty case context",
                )
            }
            Assertion::Similar { value, .. } if value.trim().is_empty() => {
                skipped_assertion_result(
                    "similar",
                    "similarity requires a non-empty reference value",
                )
            }
            Assertion::LlmJudge { rubric, .. }
            | Assertion::LlmRubric { rubric, .. }
            | Assertion::Factuality { rubric, .. }
            | Assertion::ContextFaithfulness { rubric, .. }
            | Assertion::AnswerRelevance { rubric, .. } => {
                let rubric_source = assertion_options(assertion)
                    .rubric_prompt
                    .as_deref()
                    .unwrap_or(rubric);
                let rubric = if matches!(
                    assertion,
                    Assertion::Factuality { .. } | Assertion::ContextFaithfulness { .. }
                ) {
                    let reference = case
                        .context
                        .as_ref()
                        .filter(|value| !value.is_null())
                        .map(|value| value.to_string())
                        .or_else(|| case.expected.clone())
                        .unwrap_or_default();
                    format!(
                        "Reference context:\n{}\n\n{}",
                        truncate_chars(&reference, 16_384),
                        rubric_source
                    )
                } else {
                    rubric_source.to_owned()
                };
                let assertion_model = assertion_options(assertion)
                    .provider
                    .as_deref()
                    .unwrap_or(&judge_model);
                run_llm_judge(
                    assertion_kind(assertion),
                    &render_template(&rubric, &case.vars),
                    &score.response_text,
                    assertion_model,
                    Arc::clone(&state),
                    ctx.clone(),
                )
                .await
            }
            Assertion::Similar { value, .. } => {
                let rubric = format!(
                    "Score semantic similarity between the output and this reference from 0 to 1: {value}"
                );
                run_llm_judge(
                    "similar",
                    &rubric,
                    &score.response_text,
                    assertion_options(assertion)
                        .provider
                        .as_deref()
                        .unwrap_or(&judge_model),
                    Arc::clone(&state),
                    ctx.clone(),
                )
                .await
            }
            _ => {
                let rendered = render_assertion_vars(assertion, &case.vars);
                eval_assertion_deterministic_with_metrics(
                    &rendered,
                    &score.response_text,
                    assertion_metrics,
                )
            }
        };
        let result = if matches!(
            assertion,
            Assertion::LlmJudge { .. }
                | Assertion::LlmRubric { .. }
                | Assertion::Similar { .. }
                | Assertion::Factuality { .. }
                | Assertion::ContextFaithfulness { .. }
                | Assertion::AnswerRelevance { .. }
        ) {
            apply_eval_assertion_options(result, assertion_options(assertion))
        } else {
            result
        };
        assertion_results.push(result);
        assertion_weights.push(assertion_options(assertion).weight.unwrap_or(1.0).max(0.0));
    }
    let assertion_score = if assertion_results.is_empty() {
        1.0
    } else {
        let total_weight = assertion_weights.iter().sum::<f32>();
        if total_weight <= f32::EPSILON {
            0.0
        } else {
            assertion_results
                .iter()
                .zip(assertion_weights.iter())
                .map(|(result, weight)| result.score * weight)
                .sum::<f32>()
                / total_weight
        }
    };
    score.assertion_score = assertion_score;
    score.assertions_pass = assertion_results.iter().all(|result| result.executed)
        && assertion_score >= case.threshold.unwrap_or(1.0).clamp(0.0, 1.0);
    score.assertions = assertion_results;
    // A provider error or timeout leaves only an `[error: ...]` placeholder as
    // the response. Scoring that text would let regex/builtin evaluators rate
    // it clean, so every evaluator reports `executed: false` instead.
    score.evaluators = if score.error.is_some() {
        errored_case_evaluators(&case, &registry, &judge_ctx)
    } else {
        score_evaluators(&case, &score.response_text, &registry, &judge_ctx).await
    };
    (index, score)
}

/// Run a single LLM-judge assertion as a second `pipeline::run` (same provider/
/// router/firewall path — nothing hardcoded). Defensive: a judge error is a
/// FAIL, never a panic.
///
/// NOTE (timeout): multi-model × llm_judge fans out `models × cases ×
/// (1 + judge_calls)` SEQUENTIAL provider calls, all under Core's 120s reqwest
/// proxy timeout. Large matrices can time out at the Core proxy even though no
/// field is dropped here — the desktop warns when the matrix is large.
async fn run_llm_judge(
    kind: &str,
    rubric: &str,
    output: &str,
    judge_model: &str,
    state: SharedState,
    ctx: pipeline::RequestContext,
) -> AssertionResult {
    let judge_prompt = build_judge_prompt(rubric, output);
    let body = json!({
        "model": judge_model,
        "messages": [{"role": "user", "content": judge_prompt}]
    });

    match pipeline::run(state, ctx, body).await {
        Ok(out) => {
            // Extract judge text inline (keep pipeline::response_to_text private).
            let text = out.response["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("");
            let (pass, score) = parse_judge_verdict(text);
            AssertionResult {
                kind: kind.to_string(),
                pass,
                score,
                detail: truncate_chars(text, 500),
                executed: true,
            }
        }
        Err(e) => AssertionResult {
            kind: kind.to_string(),
            pass: false,
            score: 0.0,
            detail: format!("judge error: {e}"),
            executed: false,
        },
    }
}

fn assertion_kind(assertion: &Assertion) -> &'static str {
    match assertion {
        Assertion::LlmJudge { .. } => "llm_judge",
        Assertion::LlmRubric { .. } => "llm_rubric",
        Assertion::Factuality { .. } => "factuality",
        Assertion::ContextFaithfulness { .. } => "context_faithfulness",
        Assertion::AnswerRelevance { .. } => "answer_relevance",
        Assertion::Similar { .. } => "similar",
        _ => "assertion",
    }
}

fn has_reference_context(case: &EvalCase) -> bool {
    case.context.as_ref().is_some_and(|value| match value {
        Value::Null => false,
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(items) => !items.is_empty(),
        Value::Bool(_) | Value::Number(_) => true,
    })
}

fn skipped_assertion_result(kind: &str, detail: &str) -> AssertionResult {
    AssertionResult {
        detail: detail.to_owned(),
        executed: false,
        kind: kind.to_owned(),
        pass: false,
        score: 0.0,
    }
}

// ─── P2: offline registry-evaluator scoring ─────────────────────────────────
//
// The active dataset runner can score any OFFLINE evaluator from the shared
// catalog over each case (in addition to the existing assertions). This is
// strictly additive: when no evaluator ids are requested, `score_evaluators`
// returns `[]` and behavior is byte-for-byte what it was before.

/// Everything `score_evaluators` needs that isn't the case itself: the pipeline
/// state + request context for LLM-judge evaluators, the judge-model precedence
/// inputs, and the run-level evaluator ids unioned into every case.
#[derive(Clone)]
struct JudgeCtx {
    state: SharedState,
    ctx: pipeline::RequestContext,
    /// Run-level `judge_model` override (2nd in precedence).
    request_judge_model: Option<String>,
    /// Final fallback judge model (the run's primary model).
    fallback_model: String,
    /// Run-level evaluator ids applied to every case (unioned with per-case ids).
    request_evaluators: Vec<String>,
    /// Admission check run before each LLM-judge evaluator call (online evals'
    /// per-tenant judge budget). `None` admits every call.
    judge_gate: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

/// Score every requested registry evaluator against one case's response.
///
/// The requested set is the union of `case.evaluators` and the run-level
/// `judge_ctx.request_evaluators` (order-preserving, de-duplicated). Each id is
/// resolved against the shared registry and dispatched on its `impl`. Evaluators
/// that cannot run offline yet (Code — P4), lack the data a text dataset provides
/// (Image/Audio), or resolve to an unknown/inline-only id are reported with
/// `executed: false` and an honest `detail` rather than an error — this never
/// panics and never fails the run.
async fn score_evaluators(
    case: &EvalCase,
    response_text: &str,
    registry: &EvaluatorRegistry,
    judge_ctx: &JudgeCtx,
) -> Vec<EvaluatorScore> {
    let ids = union_evaluator_ids(&case.evaluators, &judge_ctx.request_evaluators);
    let mut out: Vec<EvaluatorScore> = Vec::with_capacity(ids.len());

    for id in &ids {
        let ev = match registry.get(id) {
            Some(ev) => ev,
            None => {
                out.push(EvaluatorScore {
                    id: id.clone(),
                    category: "unknown".to_string(),
                    score: 0.0,
                    pass: false,
                    detail: "unknown evaluator id".to_string(),
                    executed: false,
                });
                continue;
            }
        };

        let category = ev.category.as_str().to_string();

        // Offline-only gate: never offer an inline-only evaluator here.
        if !ev.capabilities.offline {
            out.push(EvaluatorScore {
                id: id.clone(),
                category,
                score: 0.0,
                pass: false,
                detail: "evaluator is not offline-capable".to_string(),
                executed: false,
            });
            continue;
        }

        let threshold = ev.offline.as_ref().map(|o| o.threshold).unwrap_or(0.5);

        // Every impl except LlmJudge is deterministic + network-free (and unit
        // tested directly). LlmJudge returns None here and takes the async path.
        let score =
            match score_offline_deterministic(id, &category, ev, case, response_text, threshold) {
                Some(s) => s,
                None => {
                    let EvaluatorImpl::LlmJudge { rubric } = &ev.impl_ else {
                        unreachable!("only LlmJudge defers to the async judge path");
                    };
                    score_llm_judge_evaluator(
                        id,
                        &category,
                        ev,
                        rubric,
                        case,
                        response_text,
                        threshold,
                        judge_ctx,
                    )
                    .await
                }
            };

        out.push(score);
    }

    out
}

/// Evaluator rows for a case whose output never materialised (provider error,
/// timeout or failed transform): nothing was scored, so each is `executed:
/// false` and its aggregate stays unmeasured.
fn errored_case_evaluators(
    case: &EvalCase,
    registry: &EvaluatorRegistry,
    judge_ctx: &JudgeCtx,
) -> Vec<EvaluatorScore> {
    union_evaluator_ids(&case.evaluators, &judge_ctx.request_evaluators)
        .into_iter()
        .map(|id| {
            let category = registry
                .get(&id)
                .map(|ev| ev.category.as_str().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            EvaluatorScore {
                id,
                category,
                score: 0.0,
                pass: false,
                detail: "case errored before an output was produced".to_string(),
                executed: false,
            }
        })
        .collect()
}

/// Union of per-case and run-level evaluator ids, order-preserving + de-duped
/// (case ids first). Pure so back-compat (both empty ⇒ `[]` ⇒ no scoring) is
/// directly testable.
fn union_evaluator_ids(case_ids: &[String], request_ids: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for id in case_ids.iter().chain(request_ids.iter()) {
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.clone());
        }
    }
    ids
}

/// Dispatch the deterministic, network-free evaluator impls. Returns `None` only
/// for [`EvaluatorImpl::LlmJudge`], which the async caller handles. Keeping this
/// sync makes Heuristic/Regex/Code/Builtin scoring unit-testable without a live
/// provider or a constructed request context.
fn score_offline_deterministic(
    id: &str,
    category: &str,
    ev: &crate::evaluators::Evaluator,
    case: &EvalCase,
    response_text: &str,
    threshold: f32,
) -> Option<EvaluatorScore> {
    match &ev.impl_ {
        EvaluatorImpl::Heuristic => Some(score_heuristic(
            id,
            category,
            case,
            response_text,
            threshold,
        )),
        EvaluatorImpl::Regex { patterns } => Some(score_regex(
            id,
            category,
            ev.target,
            patterns,
            case,
            response_text,
        )),
        EvaluatorImpl::Code { .. } => Some(EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "sandboxed code evaluator execution is unavailable in Gateway".to_string(),
            executed: false,
        }),
        EvaluatorImpl::Builtin { detector } => Some(score_builtin(
            id,
            category,
            ev.target,
            detector,
            case,
            response_text,
        )),
        EvaluatorImpl::Wasm { .. } => Some(EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "wasm policy evaluators run inline only (offline scoring not wired)"
                .to_string(),
            executed: false,
        }),
        EvaluatorImpl::LlmJudge { .. } => None,
    }
}

/// Deterministic heuristic evaluators, dispatched by id. Only marks
/// `executed: true` when a real score was computed.
fn score_heuristic(
    id: &str,
    category: &str,
    case: &EvalCase,
    response_text: &str,
    threshold: f32,
) -> EvaluatorScore {
    match id {
        "exact_match" => match &case.expected {
            Some(expected) => {
                let matched = response_text.trim() == expected.trim();
                let score = if matched { 1.0 } else { 0.0 };
                let detail = if matched {
                    "exact match".to_string()
                } else {
                    format!("expected exactly \"{}\"", expected.trim())
                };
                EvaluatorScore {
                    id: id.to_string(),
                    category: category.to_string(),
                    score,
                    // exact_match is higher-is-better (1.0 = the reference matched).
                    pass: judge_pass(score, threshold, true),
                    detail,
                    executed: true,
                }
            }
            None => EvaluatorScore {
                id: id.to_string(),
                category: category.to_string(),
                score: 0.0,
                pass: false,
                detail: "exact_match needs a reference (case.expected); none provided".to_string(),
                executed: false,
            },
        },
        "assertions" => {
            // Deterministic assertions only; llm_judge assertions run via the
            // dedicated assertions field, not here.
            let deterministic: Vec<&Assertion> = case
                .assertions
                .iter()
                .filter(|a| {
                    !matches!(
                        a,
                        Assertion::LlmJudge { .. }
                            | Assertion::LlmRubric { .. }
                            | Assertion::Similar { .. }
                            | Assertion::Factuality { .. }
                            | Assertion::ContextFaithfulness { .. }
                            | Assertion::AnswerRelevance { .. }
                    )
                })
                .collect();
            let judge_count = case.assertions.len() - deterministic.len();

            if deterministic.is_empty() {
                return EvaluatorScore {
                    id: id.to_string(),
                    category: category.to_string(),
                    score: 0.0,
                    pass: false,
                    detail: "no deterministic assertions to evaluate".to_string(),
                    executed: false,
                };
            }

            let mut passed = 0usize;
            for assertion in &deterministic {
                let rendered = render_assertion_vars(assertion, &case.vars);
                if eval_assertion_deterministic(&rendered, response_text).pass {
                    passed += 1;
                }
            }
            let total = deterministic.len();
            let score = passed as f32 / total as f32;
            let mut detail = format!("{passed}/{total} deterministic assertions passed");
            if judge_count > 0 {
                detail.push_str(&format!(
                    "; {judge_count} llm_judge assertion(s) not evaluated here"
                ));
            }
            EvaluatorScore {
                id: id.to_string(),
                category: category.to_string(),
                score,
                pass: passed == total,
                detail,
                executed: true,
            }
        }
        // Voice/quality heuristics with no offline signal in a text dataset.
        "language" | "audio_quality" | "transcription_accuracy" => EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "requires audio/reference data not present in a text eval dataset".to_string(),
            executed: false,
        },
        _ => EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "no offline heuristic implemented for this evaluator".to_string(),
            executed: false,
        },
    }
}

/// Deterministic regex evaluators. Runs the patterns over the target text (the
/// request prompt for Input-target evaluators, the response otherwise). A match
/// is a flag: `score = 0.0` (unsafe) if flagged, `1.0` (safe) otherwise; the case
/// passes only when nothing flagged. Invalid patterns are skipped, never fatal.
fn score_regex(
    id: &str,
    category: &str,
    target: EvaluatorTarget,
    patterns: &[String],
    case: &EvalCase,
    response_text: &str,
) -> EvaluatorScore {
    let rendered_prompt;
    let target_text: &str = match target {
        EvaluatorTarget::Input => {
            rendered_prompt = render_template(&case.prompt, &case.vars);
            &rendered_prompt
        }
        _ => response_text,
    };

    let matched_pattern = crate::evaluators::exec::custom_regex_match(patterns, target_text);

    let flagged = matched_pattern.is_some();
    let detail = match matched_pattern {
        Some(p) => format!("flagged: matched /{p}/"),
        None => "no pattern matched".to_string(),
    };
    EvaluatorScore {
        id: id.to_string(),
        category: category.to_string(),
        score: if flagged { 0.0 } else { 1.0 },
        pass: !flagged,
        detail,
        executed: true,
    }
}

/// Builtin firewall detectors (`pii`, `secret`, …) scored like regex
/// evaluators: `1.0` clean, `0.0` flagged; unknown detector names are reported
/// unexecuted rather than failing the run.
fn score_builtin(
    id: &str,
    category: &str,
    target: EvaluatorTarget,
    detector: &str,
    case: &EvalCase,
    response_text: &str,
) -> EvaluatorScore {
    let rendered_prompt;
    let target_text: &str = match target {
        EvaluatorTarget::Input => {
            rendered_prompt = render_template(&case.prompt, &case.vars);
            &rendered_prompt
        }
        _ => response_text,
    };
    match crate::evaluators::exec::run_builtin_detector(detector, target_text, None) {
        Ok(found) => EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: if found.is_some() { 0.0 } else { 1.0 },
            pass: found.is_none(),
            detail: found.map_or_else(
                || format!("builtin detector '{detector}' found nothing"),
                |reason| format!("flagged: {reason}"),
            ),
            executed: true,
        },
        Err(reason) => EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: reason,
            executed: false,
        },
    }
}

/// LLM-judge evaluators. Runs the rubric through the same provider path as the
/// eval assertions (`run_llm_judge`), resolving the judge model by precedence:
/// evaluator's own `offline.judge_model` → run-level `judge_model` → primary
/// model. `pass = score >= threshold`. Image/Audio targets need media a text
/// dataset can't provide, so they are honestly skipped (`executed: false`).
async fn score_llm_judge_evaluator(
    id: &str,
    category: &str,
    ev: &crate::evaluators::Evaluator,
    rubric: &str,
    case: &EvalCase,
    response_text: &str,
    threshold: f32,
    judge_ctx: &JudgeCtx,
) -> EvaluatorScore {
    if matches!(ev.target, EvaluatorTarget::Image | EvaluatorTarget::Audio) {
        return EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "requires image/audio input not present in a text eval dataset".to_string(),
            executed: false,
        };
    }
    if matches!(ev.target, EvaluatorTarget::Trajectory)
        || (matches!(ev.target, EvaluatorTarget::Conversation) && case.messages.is_empty())
    {
        return EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: format!(
                "requires {} context not present in this text dataset",
                ev.target.as_str()
            ),
            executed: false,
        };
    }

    if judge_ctx.judge_gate.as_ref().is_some_and(|admit| !admit()) {
        return EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: "judge budget exhausted for this tenant; not scored".to_string(),
            executed: false,
        };
    }
    let judge_model = resolve_judge_model(
        ev.offline.as_ref().and_then(|o| o.judge_model.as_deref()),
        judge_ctx.request_judge_model.as_deref(),
        &judge_ctx.fallback_model,
    );
    let rendered_rubric = render_template(rubric, &case.vars);

    let result = run_llm_judge(
        id,
        &rendered_rubric,
        response_text,
        &judge_model,
        Arc::clone(&judge_ctx.state),
        judge_ctx.ctx.clone(),
    )
    .await;

    // The judge's own PASS/FAIL is ignored here: an evaluator passes on the
    // threshold + polarity, not the judge's binary verdict. For a negative-signal
    // evaluator (toxicity/bias/hallucination) a high judge score is BAD, so
    // `higher_is_better = false` inverts the threshold comparison.
    let score = result.score;
    if !result.executed {
        return EvaluatorScore {
            id: id.to_string(),
            category: category.to_string(),
            score: 0.0,
            pass: false,
            detail: result.detail,
            executed: false,
        };
    }
    let pass = judge_pass(score, threshold, ev.higher_is_better);
    let mut detail = result.detail;
    if matches!(
        ev.target,
        EvaluatorTarget::Conversation | EvaluatorTarget::Trajectory
    ) {
        detail = format!(
            "[scored on prompt+response only; full {} not available] {detail}",
            ev.target.as_str()
        );
    }

    EvaluatorScore {
        id: id.to_string(),
        category: category.to_string(),
        score,
        pass,
        detail,
        executed: true,
    }
}

/// Apply per-case `{{vars}}` to an assertion's value/rubric so the deterministic
/// "assertions" evaluator honors the same substitution the assertions path does.
fn assertion_options(assertion: &Assertion) -> &AssertionOptions {
    match assertion {
        Assertion::Contains { options, .. }
        | Assertion::NotContains { options, .. }
        | Assertion::Equals { options, .. }
        | Assertion::Regex { options, .. }
        | Assertion::Icontains { options, .. }
        | Assertion::StartsWith { options, .. }
        | Assertion::ContainsAny { options, .. }
        | Assertion::ContainsAll { options, .. }
        | Assertion::IcontainsAny { options, .. }
        | Assertion::IcontainsAll { options, .. }
        | Assertion::ContainsJson { options, .. }
        | Assertion::ContainsHtml { options, .. }
        | Assertion::ContainsXml { options, .. }
        | Assertion::ContainsSql { options, .. }
        | Assertion::Levenshtein { options, .. }
        | Assertion::Latency { options, .. }
        | Assertion::Cost { options, .. }
        | Assertion::AssertSet { options, .. }
        | Assertion::IsHtml { options }
        | Assertion::IsXml { options }
        | Assertion::IsSql { options }
        | Assertion::IsRefusal { options }
        | Assertion::Moderation { options, .. }
        | Assertion::Javascript { options, .. }
        | Assertion::Python { options, .. }
        | Assertion::Ruby { options, .. }
        | Assertion::Webhook { options, .. }
        | Assertion::IsJson { options }
        | Assertion::JsonValid { options }
        | Assertion::LlmJudge { options, .. }
        | Assertion::LlmRubric { options, .. }
        | Assertion::Similar { options, .. }
        | Assertion::Factuality { options, .. }
        | Assertion::ContextFaithfulness { options, .. }
        | Assertion::AnswerRelevance { options, .. } => options,
    }
}

fn render_assertion_vars(
    assertion: &Assertion,
    vars: &std::collections::HashMap<String, serde_json::Value>,
) -> Assertion {
    match assertion {
        Assertion::Contains { value, options } => Assertion::Contains {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::NotContains { value, options } => Assertion::NotContains {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Equals { value, options } => Assertion::Equals {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Regex { value, options } => Assertion::Regex {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Icontains { value, options } => Assertion::Icontains {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::StartsWith { value, options } => Assertion::StartsWith {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsAny { value, options } => Assertion::ContainsAny {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsAll { value, options } => Assertion::ContainsAll {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::IcontainsAny { value, options } => Assertion::IcontainsAny {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::IcontainsAll { value, options } => Assertion::IcontainsAll {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsJson { value, options } => Assertion::ContainsJson {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsHtml { value, options } => Assertion::ContainsHtml {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsXml { value, options } => Assertion::ContainsXml {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::ContainsSql { value, options } => Assertion::ContainsSql {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Levenshtein { value, options } => Assertion::Levenshtein {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Latency { value, options } => Assertion::Latency {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Cost { value, options } => Assertion::Cost {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::AssertSet {
            assertions,
            options,
        } => Assertion::AssertSet {
            assertions: assertions
                .iter()
                .map(|nested| render_assertion_vars(nested, vars))
                .collect(),
            options: options.clone(),
        },
        Assertion::IsHtml { options } => Assertion::IsHtml {
            options: options.clone(),
        },
        Assertion::IsXml { options } => Assertion::IsXml {
            options: options.clone(),
        },
        Assertion::IsSql { options } => Assertion::IsSql {
            options: options.clone(),
        },
        Assertion::IsRefusal { options } => Assertion::IsRefusal {
            options: options.clone(),
        },
        Assertion::Moderation { value, options } => Assertion::Moderation {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Javascript { value, options } => Assertion::Javascript {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Python { value, options } => Assertion::Python {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Ruby { value, options } => Assertion::Ruby {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Webhook { value, options } => Assertion::Webhook {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::IsJson { options } => Assertion::IsJson {
            options: options.clone(),
        },
        Assertion::JsonValid { options } => Assertion::JsonValid {
            options: options.clone(),
        },
        Assertion::LlmJudge { rubric, options } => Assertion::LlmJudge {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
        Assertion::LlmRubric { rubric, options } => Assertion::LlmRubric {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
        Assertion::Similar { value, options } => Assertion::Similar {
            value: render_template(value, vars),
            options: options.clone(),
        },
        Assertion::Factuality { rubric, options } => Assertion::Factuality {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
        Assertion::ContextFaithfulness { rubric, options } => Assertion::ContextFaithfulness {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
        Assertion::AnswerRelevance { rubric, options } => Assertion::AnswerRelevance {
            rubric: render_template(rubric, vars),
            options: options.clone(),
        },
    }
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
