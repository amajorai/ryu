//! Agent optimizer HTTP surface (`/api/agents/:id/optimizations*`).
//!
//! Core owns the orchestration because every input is kernel state: the agent's
//! conversations and trace spans (what it did), its configuration (what may
//! change), and the agent update path (how a change is applied and versioned).
//! Measurement stays with the Gateway: model candidates are replayed through its
//! `/v1/evals/run` runner, which meters, budgets, and audits every call. The
//! decision logic lives in the network-free `ryu-optimizer` crate.
//!
//! Nothing is applied automatically. An analysis only records recommendations;
//! applying one goes through [`AgentStore::update`], so the agent's version
//! history can restore the previous configuration.
//!
//! [`AgentStore::update`]: crate::agents::AgentStore::update

use std::path::PathBuf;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::Utc;
use ryu_optimizer::{
    Analysis, Change, PricedModel, Readiness, RecommendationStatus, Session, Turn,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::conversations::ConversationSummary;
use super::{enforce_permission_on, json_error, tenancy_filter_args, ServerState};
use crate::agents::{AgentRecord, AgentUpdateConflict, UpdateAgent, NO_AGENT_CAPABILITIES};
use crate::identity_verify::{permissions, VerifiedCaller};

/// Replays are `models × cases` provider calls plus one judge call each.
const EVAL_TIMEOUT: Duration = Duration::from_secs(600);
/// Models priced per analysis when choosing candidates automatically.
const MAX_PRICED_MODELS: usize = 80;
/// Explicit candidates a caller may ask for in one analysis.
const MAX_REQUESTED_CANDIDATES: usize = 4;

type Caller = Option<VerifiedCaller>;

pub fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/agents/:id/optimizations", get(get_optimizations))
        .route(
            "/api/agents/:id/optimizations/analyze",
            post(analyze_optimizations),
        )
        .route(
            "/api/agents/:id/optimizations/:rec_id/apply",
            post(apply_optimization),
        )
        .route(
            "/api/agents/:id/optimizations/:rec_id/dismiss",
            post(dismiss_optimization),
        )
}

fn store_path() -> PathBuf {
    #[cfg(test)]
    if let Ok(path) = tests::STORE_PATH.try_with(Clone::clone) {
        return path;
    }
    crate::paths::state_path("agent-optimizer.json")
}

// Apply, dismiss and analysis publication share one per-agent admission lock.
// Evals run before taking this lock so a long replay cannot hold up a user action.
fn mutation_lock(path: &std::path::Path, agent_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    type Locks =
        std::collections::HashMap<(PathBuf, String), std::sync::Arc<tokio::sync::Mutex<()>>>;
    static LOCKS: std::sync::OnceLock<std::sync::Mutex<Locks>> = std::sync::OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    locks
        .entry((path.to_owned(), agent_id.to_owned()))
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

async fn authorize(
    state: &ServerState,
    caller: &Caller,
    perm: &str,
    agent_id: &str,
) -> Result<(), Response> {
    enforce_permission_on(state, caller, perm, crate::acl::KIND_AGENT, agent_id)
        .await
        .map_err(|status| json_error(status, format!("insufficient permissions: {perm}")))
}

async fn load_agent(state: &ServerState, agent_id: &str) -> Result<AgentRecord, Response> {
    match state.agent_store.get(agent_id).await {
        Ok(Some(agent)) => Ok(agent),
        Ok(None) => Err(json_error(
            StatusCode::NOT_FOUND,
            format!("agent '{agent_id}' not found"),
        )),
        Err(error) => Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        )),
    }
}

fn current_model(agent: &AgentRecord) -> Option<String> {
    agent
        .chat_model
        .as_ref()
        .and_then(|slot| slot.model_id.clone())
        .or_else(|| agent.model.clone())
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty())
}

/// ACP agents (Claude Code, Codex, a custom `acp-exec:` command) choose and call
/// their model themselves, so a Gateway replay would not measure what they run.
fn replays_through_gateway(agent: &AgentRecord) -> bool {
    let engine = agent
        .chat_model
        .as_ref()
        .and_then(|slot| slot.engine.as_deref())
        .or(agent.engine.as_deref())
        .unwrap_or_default();
    !(agent.id.starts_with("acp:") || engine.starts_with("acp:") || engine.starts_with("acp-exec:"))
}

/// The caller-visible conversations this agent took part in, newest first.
async fn agent_conversations(
    state: &ServerState,
    caller: &Caller,
    agent_id: &str,
) -> anyhow::Result<Vec<ConversationSummary>> {
    let (user_id, org_id, team_ids_json, node_bound) = tenancy_filter_args(caller);
    let mut rows: Vec<ConversationSummary> = state
        .conversations
        .list_conversations_visible_for_teams(
            user_id.as_deref(),
            org_id.as_deref(),
            node_bound,
            team_ids_json.as_deref(),
        )
        .await?
        .into_iter()
        .filter(|row| {
            row.message_count >= 2
                && (row.agent_id.as_deref() == Some(agent_id)
                    || row.participants.iter().any(|p| p == agent_id))
        })
        .collect();
    rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    rows.truncate(ryu_optimizer::MAX_SESSIONS);
    Ok(rows)
}

/// Read each conversation's user → agent turns and its recorded tool calls.
async fn gather_sessions(
    state: &ServerState,
    agent_id: &str,
    rows: &[ConversationSummary],
) -> Vec<Session> {
    let mut sessions = Vec::with_capacity(rows.len());
    for row in rows {
        let Ok(messages) = state.conversations.get_active_messages(&row.id).await else {
            continue;
        };
        let mut turns = Vec::new();
        let mut prompt: Option<String> = None;
        for message in messages {
            match message.role.as_str() {
                "user" => prompt = Some(message.content),
                "assistant" if message.agent_id.as_deref().is_none_or(|id| id == agent_id) => {
                    if let Some(prompt) = prompt.take() {
                        turns.push(Turn {
                            prompt,
                            reference: message.content,
                            tools: message
                                .parts
                                .as_ref()
                                .map(ryu_optimizer::tools_from_parts)
                                .unwrap_or_default(),
                        });
                    }
                }
                _ => {}
            }
        }
        let tool_calls = state
            .traces
            .get_spans(&row.id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|span| span.normalized_kind() == Some(ryu_tracing::SpanKind::ToolCall))
            .map(|span| span.name)
            .collect();
        sessions.push(Session {
            id: row.id.clone(),
            turns,
            tool_calls,
        });
    }
    sessions
}

fn state_body(readiness: Readiness, optimizations: ryu_optimizer::AgentOptimizations) -> Value {
    json!({
        "readiness": readiness,
        "recommendations": optimizations.recommendations,
        "lastAnalysis": optimizations.last_analysis,
        "recoveryRecommendations": [],
    })
}

/// `GET /api/agents/:id/optimizations` — readiness, recommendations, and the
/// latest analysis for one agent.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/optimizations",
    tag = "Agents",
    summary = "Get an agent's optimization recommendations",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_optimizations(
    State(state): State<ServerState>,
    Extension(caller): Extension<Caller>,
    Path(agent_id): Path<String>,
) -> Response {
    if let Err(response) = authorize(&state, &caller, permissions::AGENT_VIEW, &agent_id).await {
        return response;
    }
    if let Err(response) = load_agent(&state, &agent_id).await {
        return response;
    }
    // Readiness from summaries alone: no transcript is decrypted to render it.
    let sessions = match agent_conversations(&state, &caller, &agent_id).await {
        Ok(rows) => rows.len(),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let readiness = Readiness {
        sessions,
        required: ryu_optimizer::MIN_SESSIONS,
        ready: sessions >= ryu_optimizer::MIN_SESSIONS,
    };
    let mut recoveries = Vec::new();
    // Historical apply payloads need current edit permission, not merely view.
    if authorize(&state, &caller, permissions::AGENT_EDIT, &agent_id)
        .await
        .is_ok()
    {
        let receipts = match state
            .agent_store
            .unacknowledged_operations(&agent_id, "optimizer:", 64)
            .await
        {
            Ok(receipts) => receipts,
            Err(_) => {
                return json_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not read outstanding optimization acknowledgements.".to_string(),
                )
            }
        };
        for receipt in receipts {
            let rec_id = receipt
                .operation_id
                .strip_prefix("optimizer:")
                .unwrap_or_default();
            let rec = match recommendation_from_receipt(&receipt, &agent_id, rec_id) {
                Ok(rec) => rec,
                Err(response) => return response,
            };
            recoveries.push(rec);
        }
    }
    let (optimizations, history_unavailable) = match ryu_optimizer::load(&store_path(), &agent_id) {
        Ok(optimizations) => (optimizations, false),
        Err(_) if !recoveries.is_empty() => (
            ryu_optimizer::AgentOptimizations {
                recommendations: Vec::new(),
                last_analysis: None,
            },
            true,
        ),
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Optimization history is unavailable. Retry when its store is available."
                    .to_string(),
            )
        }
    };
    let mut body = state_body(readiness, optimizations);
    body["recoveryRecommendations"] = json!(recoveries);
    body["historyUnavailable"] = json!(history_unavailable);
    Json(body).into_response()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeRequest {
    /// Models to compare against the current one. Empty chooses cheaper models
    /// the Gateway can route to, using list prices.
    #[serde(default)]
    candidate_models: Vec<String>,
    /// How far below the current model's judged quality a candidate may score.
    #[serde(default)]
    quality_tolerance: Option<f64>,
}

/// `POST /api/agents/:id/optimizations/analyze` — read the agent's recent
/// sessions, replay a sample on cheaper models through the Gateway, and record
/// model and tool recommendations. Spends provider tokens; changes nothing.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/optimizations/analyze",
    tag = "Agents",
    summary = "Analyze an agent for cost optimizations",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn analyze_optimizations(
    State(state): State<ServerState>,
    Extension(caller): Extension<Caller>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    body: Option<Json<AnalyzeRequest>>,
) -> Response {
    // Analysis spends the node's provider budget, so it needs edit rights.
    if let Err(response) = authorize(&state, &caller, permissions::AGENT_EDIT, &agent_id).await {
        return response;
    }
    let agent = match load_agent(&state, &agent_id).await {
        Ok(agent) => agent,
        Err(response) => return response,
    };
    let request = body.map(|Json(request)| request).unwrap_or_default();
    let rows = match agent_conversations(&state, &caller, &agent_id).await {
        Ok(rows) => rows,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let sessions = gather_sessions(&state, &agent_id, &rows).await;
    let readiness = ryu_optimizer::readiness(&sessions);
    let at = now();
    let mut analysis = Analysis {
        agent_id: agent_id.clone(),
        at: at.clone(),
        sessions: readiness.sessions,
        cases: 0,
        candidates: Vec::new(),
        notes: Vec::new(),
        recommendation_ids: Vec::new(),
    };
    let mut recommendations = Vec::new();

    if !readiness.ready {
        analysis.notes.push(format!(
            "The agent has {} of the {} sessions needed before its history is worth analyzing.",
            readiness.sessions, readiness.required
        ));
    } else {
        match ryu_optimizer::recommend_tools(&agent_id, &agent.tools, &sessions, &at) {
            Some(rec) => recommendations.push(rec),
            None => analysis.notes.push(
                "Tools: every allowed tool was used, or the agent may use all tools.".to_owned(),
            ),
        }
        match analyze_model(&state, &headers, &agent, &sessions, &request, &mut analysis).await {
            Ok(Some(rec)) => recommendations.push(rec),
            Ok(None) => {}
            Err(note) => analysis.notes.push(note),
        }
    }

    let path = store_path();
    let lock = mutation_lock(&path, &agent_id);
    let _guard = lock.lock().await;
    match ryu_optimizer::record_analysis(&path, analysis, recommendations) {
        Ok(optimizations) => Json(state_body(readiness, optimizations)).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// The model half of an analysis. `Err` carries a user-facing note; `Ok(None)`
/// means the comparison ran and no candidate cleared the bar (noted inside).
async fn analyze_model(
    state: &ServerState,
    headers: &HeaderMap,
    agent: &AgentRecord,
    sessions: &[Session],
    request: &AnalyzeRequest,
    analysis: &mut Analysis,
) -> Result<Option<ryu_optimizer::Recommendation>, String> {
    if !replays_through_gateway(agent) {
        return Err(
            "Model: this agent runs on an external engine whose model the Gateway cannot replay."
                .to_owned(),
        );
    }
    let current = current_model(agent)
        .ok_or_else(|| "Model: the agent has no chat model set to compare against.".to_owned())?;
    let cases = ryu_optimizer::replay_cases(sessions, ryu_optimizer::MAX_REPLAY_CASES);
    analysis.cases = cases.len();
    if cases.len() < ryu_optimizer::MIN_REPLAY_CASES {
        return Err(format!(
            "Model: only {} recent turns can be replayed without tools; {} are needed.",
            cases.len(),
            ryu_optimizer::MIN_REPLAY_CASES
        ));
    }
    let requested: Vec<String> = request
        .candidate_models
        .iter()
        .map(|model| model.trim().to_owned())
        .filter(|model| !model.is_empty() && *model != current)
        .take(MAX_REQUESTED_CANDIDATES)
        .collect();
    let candidates = if requested.is_empty() {
        let needs_tools = sessions.iter().any(|session| {
            !session.tool_calls.is_empty() || session.turns.iter().any(|t| !t.tools.is_empty())
        });
        auto_candidates(state, headers, &current, needs_tools).await
    } else {
        requested
    };
    analysis.candidates = candidates.clone();
    if candidates.is_empty() {
        return Err(format!(
            "Model: no cheaper model with a known price is available to compare with {current}."
        ));
    }

    let mut models = vec![current.clone()];
    models.extend(candidates);
    let eval = ryu_optimizer::eval_request(
        &agent.id,
        agent.system_prompt.as_deref(),
        &cases,
        &models,
        &current,
    );
    let response = run_gateway_eval(state, headers, &eval).await?;
    let scores = ryu_optimizer::model_scores(&response);
    let tolerance = request
        .quality_tolerance
        .filter(|value| (0.0..=0.5).contains(value))
        .unwrap_or(ryu_optimizer::DEFAULT_QUALITY_TOLERANCE);
    let rec = ryu_optimizer::recommend_model(
        &agent.id,
        &current,
        &scores,
        tolerance,
        analysis.sessions,
        &analysis.at,
    );
    if rec.is_none() {
        analysis.notes.push(format!(
            "Model: no candidate matched {current}'s quality at a meaningfully lower cost."
        ));
    }
    Ok(rec)
}

fn gateway_request(
    state: &ServerState,
    headers: &HeaderMap,
    method: reqwest::Method,
    path: &str,
) -> reqwest::RequestBuilder {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};
    let base = gateway_url();
    let mut request = state
        .client
        .request(method, format!("{}{path}", base.trim_end_matches('/')));
    // Same credential order as the eval proxy: the Gateway token when Core has
    // one, else the caller's own key so per-key budgets still apply.
    if let Some(token) = gateway_admin_key() {
        request = request.bearer_auth(token);
    } else if let Some(auth) = headers.get("authorization").and_then(|v| v.to_str().ok()) {
        request = request.header("authorization", auth);
    }
    request
}

async fn run_gateway_eval(
    state: &ServerState,
    headers: &HeaderMap,
    body: &Value,
) -> Result<Value, String> {
    let response = gateway_request(state, headers, reqwest::Method::POST, "/v1/evals/run")
        .timeout(EVAL_TIMEOUT)
        .json(body)
        .send()
        .await
        .map_err(|error| format!("Model: the Gateway eval runner was unreachable ({error})."))?;
    let status = response.status();
    let value: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let detail = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("no detail");
        return Err(format!(
            "Model: the Gateway eval run failed ({status}: {detail})."
        ));
    }
    Ok(value)
}

/// Cheaper models the Gateway can route to, priced from the model catalog.
async fn auto_candidates(
    state: &ServerState,
    headers: &HeaderMap,
    current: &str,
    needs_tools: bool,
) -> Vec<String> {
    let Some(current_meta) = crate::model_catalog::models_dev::meta_for(current, None).await else {
        return Vec::new();
    };
    let listed: Value = match gateway_request(state, headers, reqwest::Method::GET, "/v1/models")
        .timeout(Duration::from_secs(20))
        .send()
        .await
    {
        Ok(response) => response.json().await.unwrap_or_else(|_| json!({})),
        Err(_) => return Vec::new(),
    };
    let entries = listed
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut available = Vec::new();
    // Media, embedding, and rerank rows cannot replace a chat model.
    let chat_entries = entries.iter().filter(|entry| {
        entry
            .get("modality")
            .and_then(Value::as_str)
            .is_none_or(|modality| modality == "chat")
    });
    for entry in chat_entries.take(MAX_PRICED_MODELS) {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let provider = entry.get("owned_by").and_then(Value::as_str);
        if let Some(meta) = crate::model_catalog::models_dev::meta_for(id, provider).await {
            available.push(priced(id, &meta));
        }
    }
    ryu_optimizer::pick_candidates(
        &priced(current, &current_meta),
        &available,
        needs_tools,
        ryu_optimizer::MAX_CANDIDATES,
    )
}

fn priced(id: &str, meta: &crate::model_catalog::models_dev::ModelMeta) -> PricedModel {
    PricedModel {
        id: id.to_owned(),
        input_per_1m: meta.cost_input_per_1m,
        output_per_1m: meta.cost_output_per_1m,
        tool_call: meta.tool_call,
    }
}

/// The agent patch a recommendation makes, checked against the agent as it is
/// now. A recommendation made against an older configuration is refused rather
/// than applied over the user's later edits.
fn patch_for(agent: &AgentRecord, change: &Change) -> Result<UpdateAgent, String> {
    let patch = match change {
        Change::SetModel { from, to } => {
            if current_model(agent).as_deref() != Some(from.as_str()) {
                return Err(format!(
                    "The agent no longer uses {from}. Run a new analysis."
                ));
            }
            let engine = agent
                .chat_model
                .as_ref()
                .and_then(|slot| slot.engine.clone());
            let mut patch = json!({ "chat_model": { "model_id": to, "engine": engine } });
            if agent.model.is_some() {
                patch["model"] = Value::String(to.clone());
            }
            patch
        }
        Change::RemoveTools { remove, .. } => {
            if let Some(missing) = remove.iter().find(|tool| !agent.tools.contains(tool)) {
                return Err(format!(
                    "{missing} is no longer in the agent's tools. Run a new analysis."
                ));
            }
            let mut tools: Vec<String> = agent
                .tools
                .iter()
                .filter(|tool| !remove.contains(tool))
                .cloned()
                .collect();
            if tools.is_empty() {
                tools.push(NO_AGENT_CAPABILITIES.to_owned());
            }
            json!({ "tools": tools })
        }
    };
    serde_json::from_value(patch).map_err(|error| error.to_string())
}

/// `POST /api/agents/:id/optimizations/:rec_id/apply` — apply one pending
/// recommendation through the normal agent update path.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/optimizations/{rec_id}/apply",
    tag = "Agents",
    summary = "Apply an optimization recommendation",
    params(("id" = String, Path), ("rec_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn apply_optimization(
    State(state): State<ServerState>,
    Extension(caller): Extension<Caller>,
    Path((agent_id, rec_id)): Path<(String, String)>,
) -> Response {
    if let Err(response) = authorize(&state, &caller, permissions::AGENT_EDIT, &agent_id).await {
        return response;
    }
    let path = store_path();
    let lock = mutation_lock(&path, &agent_id);
    let _guard = lock.lock().await;
    let operation_id = format!("optimizer:{rec_id}");
    match state
        .agent_store
        .operation_receipt(&agent_id, &operation_id)
        .await
    {
        Ok(Some(receipt)) => {
            return project_receipt(&state, &path, &agent_id, &rec_id, receipt).await
        }
        Ok(None) => {}
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read the saved optimization operation.".to_string(),
            )
        }
    }
    let rec = match ryu_optimizer::pending(&path, &agent_id, &rec_id) {
        Ok(rec) => rec,
        Err(error) => {
            let message = error.to_string();
            if message == "recommendation not found"
                || message == "recommendation is no longer pending"
            {
                return json_error(StatusCode::NOT_FOUND, message);
            }
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read the optimization suggestions. Retry when the store is available."
                    .to_string(),
            );
        }
    };
    let agent = match load_agent(&state, &agent_id).await {
        Ok(agent) => agent,
        Err(response) => return response,
    };
    #[cfg(test)]
    if let Ok(rendezvous) = tests::APPLY_RENDEZVOUS.try_with(std::sync::Arc::clone) {
        rendezvous.loaded.notify_one();
        rendezvous.resume.notified().await;
    }
    let mut patch = match patch_for(&agent, &rec.change) {
        Ok(patch) => patch,
        Err(reason) => return json_error(StatusCode::CONFLICT, reason),
    };
    patch.expected_updated_at = agent.updated_at.clone();
    let payload = match serde_json::to_value(&rec) {
        Ok(payload) => payload,
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not prepare the optimization operation.".to_string(),
            )
        }
    };
    let updated = match state
        .agent_store
        .update_with_receipt(&agent_id, patch, &operation_id, &payload)
        .await
    {
        Ok(Some(agent)) => agent,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("agent '{agent_id}' not found"),
            )
        }
        Err(error) => {
            let message = error.to_string();
            let status = if error.downcast_ref::<AgentUpdateConflict>().is_some()
                || message.contains("locked")
            {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            return json_error(
                status,
                if status == StatusCode::CONFLICT {
                    message
                } else {
                    "Could not save the optimization. The operation was not committed.".to_owned()
                },
            );
        }
    };
    match state.agent_store.operation_receipt(&agent_id, &operation_id).await {
        Ok(Some(receipt)) => project_receipt(&state, &path, &agent_id, &rec_id, receipt).await,
        _ => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": "The agent was updated, but its optimization acknowledgement could not be read. Retry this suggestion to recover.",
            "agentUpdated": true, "recoveryRequired": true, "recommendationId": rec_id,
            "appliedAgent": updated,
        }))).into_response(),
    }
}

fn recommendation_from_receipt(
    receipt: &crate::agents::AgentOperationReceipt,
    agent_id: &str,
    rec_id: &str,
) -> Result<ryu_optimizer::Recommendation, Response> {
    let recommendation: ryu_optimizer::Recommendation =
        serde_json::from_value(receipt.payload.clone()).map_err(|_| {
            json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The saved optimization acknowledgement is invalid.".to_string(),
            )
        })?;
    if receipt.operation_id != format!("optimizer:{rec_id}")
        || receipt.agent.id != agent_id
        || recommendation.id != rec_id
        || recommendation.agent_id != agent_id
        || recommendation.status != RecommendationStatus::Pending
        || recommendation.decided_at.is_some()
    {
        return Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The saved optimization acknowledgement has a different identity.".to_string(),
        ));
    }
    Ok(recommendation)
}

async fn project_receipt(
    state: &ServerState,
    path: &std::path::Path,
    agent_id: &str,
    rec_id: &str,
    receipt: crate::agents::AgentOperationReceipt,
) -> Response {
    let recommendation = match recommendation_from_receipt(&receipt, agent_id, rec_id) {
        Ok(rec) => rec,
        Err(response) => return response,
    };
    let current = match load_agent(state, agent_id).await {
        Ok(agent) => agent,
        Err(response) => return response,
    };
    let Some(committed_at) = receipt.agent.updated_at.as_deref() else {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The saved optimization acknowledgement has no revision.".to_string(),
        );
    };
    match ryu_optimizer::project_applied_receipt(path, &recommendation, committed_at) {
        Ok(rec) => {
            if state
                .agent_store
                .acknowledge_operation(&receipt, committed_at)
                .await
                .is_ok()
            {
                return Json(json!({ "recommendation": rec, "agent": current, "appliedAgent": receipt.agent })).into_response();
            }
            recovery_response(&current, &receipt, rec_id)
        }
        Err(_) => recovery_response(&current, &receipt, rec_id),
    }
}

fn recovery_response(
    current: &AgentRecord,
    receipt: &crate::agents::AgentOperationReceipt,
    rec_id: &str,
) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "error": "The agent was updated, but the suggestion acknowledgement could not be saved. Retry this suggestion to finish recording it; the agent will not be changed again.",
            "agentUpdated": true, "recoveryRequired": true, "recommendationId": rec_id,
            "agent": current, "appliedAgent": receipt.agent,
        }))).into_response()
}

/// `POST /api/agents/:id/optimizations/:rec_id/dismiss` — decline one pending
/// recommendation. The agent is unchanged.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/optimizations/{rec_id}/dismiss",
    tag = "Agents",
    summary = "Dismiss an optimization recommendation",
    params(("id" = String, Path), ("rec_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn dismiss_optimization(
    State(state): State<ServerState>,
    Extension(caller): Extension<Caller>,
    Path((agent_id, rec_id)): Path<(String, String)>,
) -> Response {
    if let Err(response) = authorize(&state, &caller, permissions::AGENT_EDIT, &agent_id).await {
        return response;
    }
    let path = store_path();
    let lock = mutation_lock(&path, &agent_id);
    let _guard = lock.lock().await;
    let operation_id = format!("optimizer:{rec_id}");
    match state
        .agent_store
        .operation_receipt(&agent_id, &operation_id)
        .await
    {
        Ok(Some(receipt)) => {
            return project_receipt(&state, &path, &agent_id, &rec_id, receipt).await
        }
        Ok(None) => {}
        Err(_) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read the saved optimization operation.".to_string(),
            )
        }
    }
    match ryu_optimizer::decide(
        &path,
        &agent_id,
        &rec_id,
        RecommendationStatus::Dismissed,
        &now(),
    ) {
        Ok(rec) => Json(json!({ "recommendation": rec })).into_response(),
        Err(error) => json_error(StatusCode::NOT_FOUND, error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::ModelSlot;

    // Task-local seams cannot stall unrelated requests or redirect their stores.
    tokio::task_local! {
        pub(super) static STORE_PATH: PathBuf;
        pub(super) static APPLY_RENDEZVOUS: std::sync::Arc<ApplyRendezvous>;
    }

    pub(super) struct ApplyRendezvous {
        pub(super) loaded: tokio::sync::Notify,
        pub(super) resume: tokio::sync::Notify,
    }

    fn handler_state(directory: &std::path::Path) -> ServerState {
        use std::sync::Arc;
        use tokio::sync::{Mutex, RwLock};

        let manager = crate::sidecar::SidecarManager::new_noop();
        let agents = Arc::new(crate::sidecar::adapters::AcpAgentRegistry::new());
        let client = reqwest::Client::new();
        ServerState {
            setup: Arc::new(crate::sidecar::onboarding::SetupManager::new()),
            manager,
            install_status: Arc::new(crate::sidecar::install_state::InstallStatusStore::new()),
            catalog: Arc::new(crate::catalog::CatalogManager::new()),
            client: client.clone(),
            auth: Arc::new(Mutex::new(crate::auth::AuthState::new())),
            agent_store: crate::agents::AgentStore::open(&agents).expect("durable agent store"),
            agents,
            safe_actions: crate::safe_actions::SafeActionsService::new(
                crate::safe_actions::SafeActionsStore::open_in_memory().unwrap(),
            ),
            conversations: super::super::conversations::ConversationStore::open_in_memory()
                .unwrap(),
            memory: ryu_memory::MemoryStore::open_in_memory().unwrap(),
            mcp: Arc::new(crate::sidecar::mcp::McpRegistry::empty()),
            spaces: ryu_spaces::SpaceStore::open_in_memory().unwrap(),
            media: super::super::media::MediaStore::open(directory.join("media")).unwrap(),
            gateway: Arc::new(crate::sidecar::gateway::GatewayManager::new()),
            headroom: Arc::new(crate::sidecar::headroom::HeadroomManager::new()),
            retrieval: ryu_rag::RetrievalStore::open_in_memory(8, "fixture".into()).unwrap(),
            worktree_diffs: Arc::new(Mutex::new(std::collections::HashMap::new())),
            app_manifests: Arc::new(RwLock::new(Vec::new())),
            incompatible_manifests: Arc::new(RwLock::new(Vec::new())),
            app_store: crate::plugins::PluginStore::open_in_memory().unwrap(),
            catalog_client: Arc::new(crate::plugins::catalog::PluginCatalogClient::new()),
            skills: ryu_skills::SkillRegistry::empty(),
            app_contrib: crate::plugins::app_contrib::AppContribRegistry::new(),
            plugin_runtime: crate::plugins::runtime::PluginRuntime::new(),
            traces: ryu_tracing::TraceStore::open_in_memory().unwrap(),
            preferences: super::super::preferences::PreferencesStore::open(
                directory.join("preferences.db"),
            )
            .unwrap(),
            subscription_costs: None,
            support_audit: crate::support_access::SupportAccessStore::open_in_memory().unwrap(),
            catalog_sources: Arc::new(crate::catalog_source::CatalogSourceRegistry::new()),
            downloads: crate::downloads::DownloadCenter::with_default_client(),
            approvals: crate::approvals::ApprovalEngine::new(
                crate::approvals::store::ApprovalStore::open_in_memory().unwrap(),
                client,
            ),
            activity: ryu_activity::ActivityStore::open(directory.join("activity.db")).unwrap(),
            mesh: ryu_mesh::MeshHandle::new(),
            connections: crate::connections::ConnectionRegistry::new(),
            hardware: ryu_hardware::DeviceStore::open(directory.join("hardware.db")).unwrap(),
            realtime: ryu_realtime::RoomRegistry::new(),
            collab: ryu_collab::DocRegistry::new(Arc::new(
                ryu_collab::CollabStore::open_in_memory().unwrap(),
            )),
            experience: ryu_learning::ExperienceStore::open(directory.join("experience.db"))
                .unwrap(),
            improvements: ryu_improvement::ImprovementStore::open_in_memory().unwrap(),
            agent_ui_templates:
                super::super::agent_ui_templates::AgentUiTemplateStore::open_in_memory().unwrap(),
            node_token: None,
        }
    }

    fn record_model_recommendation(
        path: &std::path::Path,
        agent_id: &str,
        id: &str,
        from: &str,
        to: &str,
    ) {
        let at = "2026-10-05T00:00:00Z".to_owned();
        ryu_optimizer::record_analysis(
            path,
            Analysis {
                agent_id: agent_id.into(),
                at: at.clone(),
                sessions: 20,
                cases: 10,
                candidates: vec![to.into()],
                notes: Vec::new(),
                recommendation_ids: Vec::new(),
            },
            vec![ryu_optimizer::Recommendation {
                id: id.into(),
                agent_id: agent_id.into(),
                kind: ryu_optimizer::RecommendationKind::Model,
                status: RecommendationStatus::Pending,
                title: "Use a cheaper model".into(),
                summary: "Finite stored recommendation".into(),
                change: Change::SetModel {
                    from: from.into(),
                    to: to.into(),
                },
                evidence: ryu_optimizer::Evidence::default(),
                created_at: at,
                decided_at: None,
            }],
        )
        .expect("recommendation persists through the real optimizer store");
    }

    #[tokio::test]
    async fn optimizer_apply_refuses_concurrent_save_and_preserves_pending_decision_until_reanalysis(
    ) {
        use crate::agents::{AgentStore, CreateAgent};
        use std::sync::Arc;

        // Run this exact test in a fresh headless process: cached paths/crypto keys
        // must never adopt the developer's normal profile or another suite's DB.
        assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
        let configured = PathBuf::from(std::env::var_os("RYU_DIR").expect("isolated RYU_DIR"));
        assert!(
            configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp")
        );
        assert_eq!(crate::paths::ryu_dir(), configured);
        let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
        assert!(!crate::sidecar::control_plane::is_managed_node());
        assert!(crate::sidecar::control_plane::registered_org().is_none());
        let directory = tempfile::tempdir().unwrap();
        let state = handler_state(directory.path());
        let original = state
            .agent_store
            .create(CreateAgent {
                name: "Optimizer concurrent-save fixture".into(),
                chat_model: Some(ModelSlot {
                    model_id: Some("big".into()),
                    engine: Some("gateway".into()),
                }),
                tools: vec!["search.web".into(), "slack.post".into()],
                ..Default::default()
            })
            .await
            .unwrap();
        let path = directory.path().join("agent-optimizer.json");
        record_model_recommendation(&path, &original.id, "stale-model", "big", "small");
        let rendezvous = Arc::new(ApplyRendezvous {
            loaded: tokio::sync::Notify::new(),
            resume: tokio::sync::Notify::new(),
        });
        STORE_PATH
            .scope(path.clone(), async {
                let apply = APPLY_RENDEZVOUS.scope(
                    rendezvous.clone(),
                    apply_optimization(
                        State(state.clone()),
                        Extension(None),
                        Path((original.id.clone(), "stale-model".into())),
                    ),
                );
                let save = async {
                    tokio::time::timeout(Duration::from_secs(5), rendezvous.loaded.notified())
                        .await
                        .expect("handler reaches the post-load rendezvous");
                    // Explicit distinct revisions, independent of timestamp resolution.
                    while now() == original.updated_at.clone().unwrap_or_default() {
                        tokio::task::yield_now().await;
                    }
                    let newer = state
                        .agent_store
                        .update(
                            &original.id,
                            UpdateAgent {
                                expected_updated_at: original.updated_at.clone(),
                                chat_model: Some(ModelSlot {
                                    model_id: Some("newer".into()),
                                    engine: Some("gateway".into()),
                                }),
                                description: Some("The user's newer configuration".into()),
                                tools: Some(vec!["search.web".into(), "calendar.read".into()]),
                                ..Default::default()
                            },
                        )
                        .await
                        .unwrap()
                        .unwrap();
                    assert_ne!(newer.updated_at, original.updated_at);
                    rendezvous.resume.notify_one();
                    newer
                };
                let (response, newer) = tokio::time::timeout(Duration::from_secs(10), async {
                    tokio::join!(apply, save)
                })
                .await
                .expect("finite handler/save interleaving completes");
                assert_eq!(response.status(), StatusCode::CONFLICT);
                let bytes = axum::body::to_bytes(response.into_body(), 65536)
                    .await
                    .unwrap();
                let error: Value = serde_json::from_slice(&bytes).unwrap();
                assert!(error.to_string().contains("revision conflict"));
                let reopened = AgentStore::open(&state.agents).unwrap();
                let stored = reopened.get(&original.id).await.unwrap().unwrap();
                assert_eq!(
                    serde_json::to_value(&stored).unwrap(),
                    serde_json::to_value(&newer).unwrap()
                );
                let decision = ryu_optimizer::pending(&path, &original.id, "stale-model").unwrap();
                assert_eq!(decision.status, RecommendationStatus::Pending);
                assert_eq!(decision.decided_at, None);

                let retry = apply_optimization(
                    State(state.clone()),
                    Extension(None),
                    Path((original.id.clone(), "stale-model".into())),
                )
                .await;
                assert_eq!(retry.status(), StatusCode::CONFLICT);
                assert_eq!(
                    current_model(&reopened.get(&original.id).await.unwrap().unwrap()).as_deref(),
                    Some("newer")
                );
                assert_eq!(
                    ryu_optimizer::pending(&path, &original.id, "stale-model")
                        .unwrap()
                        .decided_at,
                    None
                );

                // A new recommendation based on the current model can be applied;
                // its response, durable agent readback and durable decision agree.
                record_model_recommendation(
                    &path,
                    &original.id,
                    "current-model",
                    "newer",
                    "cheaper-newer",
                );
                let applied = apply_optimization(
                    State(state.clone()),
                    Extension(None),
                    Path((original.id.clone(), "current-model".into())),
                )
                .await;
                assert_eq!(applied.status(), StatusCode::OK);
                let body = axum::body::to_bytes(applied.into_body(), 65536)
                    .await
                    .unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["recommendation"]["status"], "applied");
                assert_eq!(body["agent"]["chat_model"]["model_id"], "cheaper-newer");
                let persisted = reopened.get(&original.id).await.unwrap().unwrap();
                assert_eq!(persisted.tools, newer.tools);
                assert_eq!(persisted.description, newer.description);
                assert_eq!(current_model(&persisted).as_deref(), Some("cheaper-newer"));
                let decisions = ryu_optimizer::load(&path, &original.id).unwrap();
                let decided = decisions
                    .recommendations
                    .iter()
                    .find(|item| item.id == "current-model")
                    .unwrap();
                assert_eq!(decided.status, RecommendationStatus::Applied);
                assert!(decided.decided_at.is_some());
                assert_eq!(serde_json::to_value(persisted).unwrap(), body["agent"]);
            })
            .await;
    }

    // Insert inside optimizer_api::tests; reuses actual handler_state, STORE_PATH,
    // APPLY_RENDEZVOUS and record_model_recommendation. No alternate decision writer.
    #[tokio::test]
    async fn optimizer_decision_store_refusal_reports_committed_receipt_and_recovers_without_rewriting(
    ) {
        use crate::agents::{AgentStore, CreateAgent};
        use std::sync::Arc;

        assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
        let configured =
            PathBuf::from(std::env::var_os("RYU_DIR").expect("fresh isolated RYU_DIR"));
        assert!(
            configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp")
        );
        assert_eq!(crate::paths::ryu_dir(), configured);
        let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
        assert!(!crate::sidecar::control_plane::is_managed_node());
        assert!(crate::sidecar::control_plane::registered_org().is_none());
        let directory = tempfile::tempdir().unwrap();
        let state = handler_state(directory.path());
        let original = state
            .agent_store
            .create(CreateAgent {
                name: "Optimizer decision refusal fixture".into(),
                chat_model: Some(ModelSlot {
                    model_id: Some("big".into()),
                    engine: Some("gateway".into()),
                }),
                description: Some("The last confirmed configuration".into()),
                tools: vec!["search.web".into()],
                ..Default::default()
            })
            .await
            .unwrap();
        let path = directory.path().join("agent-optimizer.json");
        let protected = directory.path().join("agent-optimizer.preserved.json");
        record_model_recommendation(&path, &original.id, "decision-refusal", "big", "small");
        let original_decisions = std::fs::read(&path).unwrap();
        let rendezvous = Arc::new(ApplyRendezvous {
            loaded: tokio::sync::Notify::new(),
            resume: tokio::sync::Notify::new(),
        });
        STORE_PATH
            .scope(path.clone(), async {
                let apply = APPLY_RENDEZVOUS.scope(
                    rendezvous.clone(),
                    apply_optimization(
                        State(state.clone()),
                        Extension(None),
                        Path((original.id.clone(), "decision-refusal".into())),
                    ),
                );
                let refuse = async {
                    tokio::time::timeout(Duration::from_secs(5), rendezvous.loaded.notified())
                        .await
                        .expect("handler loaded the actual durable pending decision and agent");
                    // JSON stores atomically replace files; a directory at this exact
                    // path refuses real reads/replacement independently of uid/chmod.
                    std::fs::rename(&path, &protected).unwrap();
                    std::fs::create_dir(&path).unwrap();
                    rendezvous.resume.notify_one();
                };
                let (response, ()) = tokio::time::timeout(Duration::from_secs(10), async {
                    tokio::join!(apply, refuse)
                })
                .await
                .expect("actual handler returns after deterministic datastore refusal");
                let unavailable_history = get_optimizations(
                    State(state.clone()),
                    Extension(None),
                    Path(original.id.clone()),
                )
                .await;
                let unavailable_status = unavailable_history.status();
                let unavailable_body = axum::body::to_bytes(unavailable_history.into_body(), 65536)
                    .await
                    .unwrap();
                // Restore before any observational assertion, leaving the authored
                // store bytes intact even if the product assertions below fail.
                std::fs::remove_dir(&path).unwrap();
                std::fs::rename(&protected, &path).unwrap();
                assert_eq!(std::fs::read(&path).unwrap(), original_decisions);
                assert_eq!(unavailable_status, StatusCode::OK);
                let unavailable: Value = serde_json::from_slice(&unavailable_body).unwrap();
                assert_eq!(unavailable["historyUnavailable"], true);
                assert_eq!(
                    unavailable["recoveryRecommendations"]
                        .as_array()
                        .unwrap()
                        .len(),
                    1
                );
                assert_eq!(
                    unavailable["recoveryRecommendations"][0]["id"],
                    "decision-refusal"
                );
                assert!(unavailable.get("agent").is_none());
                assert!(unavailable.get("appliedAgent").is_none());
                assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
                let bytes = axum::body::to_bytes(response.into_body(), 65536)
                    .await
                    .unwrap();
                let error: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(error["agentUpdated"], true);
                assert_eq!(error["recoveryRequired"], true);
                assert_eq!(error["recommendationId"], "decision-refusal");
                assert!(error["error"]
                    .as_str()
                    .unwrap()
                    .contains("agent was updated"));
                assert!(!error
                    .to_string()
                    .contains(directory.path().to_str().unwrap()));
                let reopened = AgentStore::open(&state.agents).unwrap();
                let stored = reopened.get(&original.id).await.unwrap().unwrap();
                assert_eq!(current_model(&stored).as_deref(), Some("small"));
                assert_eq!(error["agent"], serde_json::to_value(&stored).unwrap());
                assert_eq!(
                    error["appliedAgent"],
                    serde_json::to_value(&stored).unwrap()
                );
                let receipt = reopened
                    .operation_receipt(&original.id, "optimizer:decision-refusal")
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(&receipt.agent).unwrap(),
                    serde_json::to_value(&stored).unwrap()
                );
                let authored: ryu_optimizer::Recommendation =
                    serde_json::from_value(receipt.payload.clone()).unwrap();
                assert_eq!(authored.id, "decision-refusal");
                assert_eq!(authored.status, RecommendationStatus::Pending);
                assert_eq!(authored.agent_id, original.id);
                let newer = reopened
                    .update(
                        &original.id,
                        UpdateAgent {
                            expected_updated_at: stored.updated_at.clone(),
                            chat_model: Some(ModelSlot {
                                model_id: Some("user-newer".into()),
                                engine: Some("gateway".into()),
                            }),
                            description: Some("An independent newer save after the refusal".into()),
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap()
                    .unwrap();
                let versions_before = reopened.list_config_versions(&original.id).await.unwrap();
                assert!(
                    !versions_before.is_empty(),
                    "real saved history must exist before asserting no duplicates"
                );
                let pending =
                    ryu_optimizer::pending(&path, &original.id, "decision-refusal").unwrap();
                assert_eq!(pending.status, RecommendationStatus::Pending);
                assert_eq!(pending.decided_at, None);
                record_model_recommendation(
                    &path,
                    &original.id,
                    "newer-analysis",
                    "user-newer",
                    "newer-cheaper",
                );
                let discovery = get_optimizations(
                    State(state.clone()),
                    Extension(None),
                    Path(original.id.clone()),
                )
                .await;
                assert_eq!(discovery.status(), StatusCode::OK);
                let discovery = axum::body::to_bytes(discovery.into_body(), 65536)
                    .await
                    .unwrap();
                let discovery: Value = serde_json::from_slice(&discovery).unwrap();
                assert_eq!(
                    discovery["recoveryRecommendations"][0]["id"],
                    "decision-refusal"
                );
                assert_eq!(discovery["recommendations"][0]["id"], "newer-analysis");

                let retry = apply_optimization(
                    State(state.clone()),
                    Extension(None),
                    Path((original.id.clone(), "decision-refusal".into())),
                )
                .await;
                assert_eq!(retry.status(), StatusCode::OK);
                let bytes = axum::body::to_bytes(retry.into_body(), 65536)
                    .await
                    .unwrap();
                let retry_body: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(retry_body["agent"]["chat_model"]["model_id"], "user-newer");
                assert_eq!(retry_body["agent"], serde_json::to_value(&newer).unwrap());
                assert_eq!(
                    retry_body["appliedAgent"],
                    serde_json::to_value(&stored).unwrap()
                );
                assert_eq!(retry_body["recommendation"]["status"], "applied");
                let readback = reopened.get(&original.id).await.unwrap().unwrap();
                assert_eq!(
                    serde_json::to_value(&readback).unwrap(),
                    retry_body["agent"]
                );
                assert_eq!(readback.tools, original.tools);
                assert_eq!(readback.description, newer.description);
                assert_eq!(
                    serde_json::to_value(&readback).unwrap(),
                    serde_json::to_value(&newer).unwrap()
                );
                let decisions = ryu_optimizer::load(&path, &original.id).unwrap();
                assert_eq!(decisions.recommendations.len(), 2);
                assert_eq!(decisions.recommendations[0].id, "newer-analysis");
                assert_eq!(
                    decisions.recommendations[0].status,
                    RecommendationStatus::Pending
                );
                assert_eq!(decisions.recommendations[1].id, "decision-refusal");
                assert_eq!(
                    decisions.recommendations[1].status,
                    RecommendationStatus::Applied
                );
                assert_eq!(decisions.recommendations[1].decided_at, stored.updated_at);
                let (duplicate, concurrent_duplicate) = tokio::join!(
                    apply_optimization(
                        State(state.clone()),
                        Extension(None),
                        Path((original.id.clone(), "decision-refusal".into()))
                    ),
                    apply_optimization(
                        State(state.clone()),
                        Extension(None),
                        Path((original.id.clone(), "decision-refusal".into()))
                    )
                );
                assert_eq!(duplicate.status(), StatusCode::OK);
                assert_eq!(concurrent_duplicate.status(), StatusCode::OK);
                for response in [duplicate, concurrent_duplicate] {
                    let bytes = axum::body::to_bytes(response.into_body(), 65536)
                        .await
                        .unwrap();
                    let body: Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(body["agent"], serde_json::to_value(&newer).unwrap());
                    assert_eq!(body["appliedAgent"], serde_json::to_value(&stored).unwrap());
                }
                let versions_after = reopened.list_config_versions(&original.id).await.unwrap();
                assert_eq!(
                    versions_after
                        .iter()
                        .map(|version| &version.id)
                        .collect::<Vec<_>>(),
                    versions_before
                        .iter()
                        .map(|version| &version.id)
                        .collect::<Vec<_>>()
                );
                assert_eq!(
                    serde_json::to_value(
                        reopened
                            .operation_receipt(&original.id, "optimizer:decision-refusal")
                            .await
                            .unwrap()
                            .unwrap()
                    )
                    .unwrap(),
                    serde_json::to_value(receipt).unwrap()
                );
                assert_eq!(
                    serde_json::to_value(reopened.get(&original.id).await.unwrap().unwrap())
                        .unwrap(),
                    serde_json::to_value(readback).unwrap()
                );
                assert_eq!(ryu_optimizer::load(&path, &original.id).unwrap(), decisions);
                assert!(reopened
                    .unacknowledged_operations(&original.id, "optimizer:", 64)
                    .await
                    .unwrap()
                    .is_empty());
                let completed_discovery = get_optimizations(
                    State(state.clone()),
                    Extension(None),
                    Path(original.id.clone()),
                )
                .await;
                assert_eq!(completed_discovery.status(), StatusCode::OK);
                let body = axum::body::to_bytes(completed_discovery.into_body(), 65536)
                    .await
                    .unwrap();
                let completed: Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(completed["recoveryRecommendations"], json!([]));
            })
            .await;
    }

    #[tokio::test]
    async fn optimizer_receipt_sql_refusal_rolls_back_and_forbidden_retry_discloses_nothing() {
        use crate::agents::{AgentStore, CreateAgent};
        use crate::identity_verify::{OrgRole, VerifiedCaller};

        assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
        let configured = PathBuf::from(std::env::var_os("RYU_DIR").expect("isolated RYU_DIR"));
        assert!(
            configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp")
        );
        assert_eq!(crate::paths::ryu_dir(), configured);
        let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
        assert!(!crate::sidecar::control_plane::is_managed_node());
        assert!(crate::sidecar::control_plane::registered_org().is_none());
        let directory = tempfile::tempdir().unwrap();
        let state = handler_state(directory.path());
        let original = state
            .agent_store
            .create(CreateAgent {
                name: "Private optimizer receipt fixture".into(),
                chat_model: Some(ModelSlot {
                    model_id: Some("big".into()),
                    engine: Some("gateway".into()),
                }),
                ..Default::default()
            })
            .await
            .unwrap();
        let path = directory.path().join("agent-optimizer.json");
        record_model_recommendation(&path, &original.id, "sql-refusal", "big", "small");
        let authored = std::fs::read(&path).unwrap();
        let operation_id = "optimizer:sql-refusal";
        let versions_before = state
            .agent_store
            .list_config_versions(&original.id)
            .await
            .unwrap();
        assert!(!versions_before.is_empty());
        let connection = rusqlite::Connection::open(crate::paths::db_path("agents.db")).unwrap();
        // Generated IDs are safe literals; refuse only this fixture's receipt.
        assert!(original
            .id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '_'));
        connection.execute_batch(&format!(
            "CREATE TRIGGER optimizer_fixture_refuse_receipt BEFORE INSERT ON agent_operation_receipts
             WHEN NEW.agent_id = '{}' BEGIN SELECT RAISE(ABORT, 'finite receipt refusal'); END;", original.id
        )).unwrap();
        STORE_PATH.scope(path.clone(), async {
            let refused = apply_optimization(State(state.clone()), Extension(None),
                Path((original.id.clone(), "sql-refusal".into()))).await;
            connection.execute_batch("DROP TRIGGER optimizer_fixture_refuse_receipt;").unwrap();
            assert_eq!(refused.status(), StatusCode::INTERNAL_SERVER_ERROR);
            let body = axum::body::to_bytes(refused.into_body(), 65536).await.unwrap();
            let error: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(error["error"], "Could not save the optimization. The operation was not committed.");
            assert!(error.get("agent").is_none());
            assert!(error.get("agentUpdated").is_none());
            let reopened = AgentStore::open(&state.agents).unwrap();
            assert_eq!(serde_json::to_value(reopened.get(&original.id).await.unwrap().unwrap()).unwrap(),
                serde_json::to_value(&original).unwrap());
            assert!(reopened.operation_receipt(&original.id, operation_id).await.unwrap().is_none());
            assert_eq!(std::fs::read(&path).unwrap(), authored);
            assert_eq!(reopened.list_config_versions(&original.id).await.unwrap().iter().map(|version| &version.id).collect::<Vec<_>>(),
                versions_before.iter().map(|version| &version.id).collect::<Vec<_>>());

            let (retry, concurrent_apply) = tokio::join!(
                apply_optimization(State(state.clone()), Extension(None), Path((original.id.clone(), "sql-refusal".into()))),
                apply_optimization(State(state.clone()), Extension(None), Path((original.id.clone(), "sql-refusal".into())))
            );
            assert_eq!(retry.status(), StatusCode::OK);
            assert_eq!(concurrent_apply.status(), StatusCode::OK);
            let retry_body = axum::body::to_bytes(retry.into_body(), 65536).await.unwrap();
            let concurrent_body = axum::body::to_bytes(concurrent_apply.into_body(), 65536).await.unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&retry_body).unwrap(), serde_json::from_slice::<Value>(&concurrent_body).unwrap());
            assert_eq!(state.agent_store.list_config_versions(&original.id).await.unwrap().len(), versions_before.len() + 1);
            let persisted = reopened.get(&original.id).await.unwrap().unwrap();
            assert_eq!(current_model(&persisted).as_deref(), Some("small"));
            let receipt = reopened.operation_receipt(&original.id, operation_id).await.unwrap().unwrap();
            assert_eq!(serde_json::to_value(&receipt.agent).unwrap(), serde_json::to_value(&persisted).unwrap());
            let exact_receipt = serde_json::to_string(&receipt).unwrap();
            let projected_before_denial = std::fs::read(&path).unwrap();
            // A forbidden caller must be rejected before parsing a historical
            // receipt, even when that receipt's stored representation is invalid.
            connection.execute("UPDATE agent_operation_receipts SET receipt = ?1 WHERE agent_id = ?2 AND operation_id = ?3",
                rusqlite::params!["{invalid", original.id, operation_id]).unwrap();
            let previous = std::env::var_os("RYU_MANAGED_NODE");
            std::env::set_var("RYU_MANAGED_NODE", "1");
            let forbidden = apply_optimization(State(state.clone()), Extension(Some(VerifiedCaller {
                user_id: "other-user".into(), email: None, email_verified: false, org_id: None,
                role: OrgRole::Viewer, teams: Vec::new(),
            })), Path((original.id.clone(), "sql-refusal".into()))).await;
            let forbidden_discovery = get_optimizations(State(state.clone()), Extension(Some(VerifiedCaller {
                user_id: "other-user".into(), email: None, email_verified: false, org_id: None,
                role: OrgRole::Viewer, teams: Vec::new(),
            })), Path(original.id.clone())).await;
            match previous {
                Some(value) => std::env::set_var("RYU_MANAGED_NODE", value),
                None => std::env::remove_var("RYU_MANAGED_NODE"),
            }
            connection.execute("UPDATE agent_operation_receipts SET receipt = ?1 WHERE agent_id = ?2 AND operation_id = ?3",
                rusqlite::params![exact_receipt, original.id, operation_id]).unwrap();
            assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
            assert_eq!(forbidden_discovery.status(), StatusCode::FORBIDDEN);
            let discovery = axum::body::to_bytes(forbidden_discovery.into_body(), 65536).await.unwrap();
            let discovery: Value = serde_json::from_slice(&discovery).unwrap();
            assert!(discovery.get("recoveryRecommendations").is_none());
            assert!(!discovery.to_string().contains("Private optimizer receipt fixture"));
            let body = axum::body::to_bytes(forbidden.into_body(), 65536).await.unwrap();
            let denied: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(denied["error"], "insufficient permissions: agent.edit");
            assert!(denied.get("agent").is_none());
            assert!(denied.get("appliedAgent").is_none());
            assert!(denied.get("recommendation").is_none());
            assert!(!denied.to_string().contains("Private optimizer receipt fixture"));
            assert_eq!(std::fs::read(&path).unwrap(), projected_before_denial);
            assert_eq!(serde_json::to_value(reopened.operation_receipt(&original.id, operation_id).await.unwrap().unwrap()).unwrap(),
                serde_json::to_value(receipt).unwrap());
            assert_eq!(serde_json::to_value(reopened.get(&original.id).await.unwrap().unwrap()).unwrap(),
                serde_json::to_value(persisted).unwrap());
        }).await;
    }

    fn agent(tools: &[&str], model: Option<&str>) -> AgentRecord {
        let mut record: AgentRecord = serde_json::from_value(json!({
            "id": "agent-1",
            "name": "Support",
        }))
        .expect("minimal agent record");
        record.tools = tools.iter().map(|tool| (*tool).to_owned()).collect();
        record.chat_model = model.map(|model| ModelSlot {
            model_id: Some(model.to_owned()),
            engine: Some("gateway".to_owned()),
        });
        record
    }

    #[test]
    fn model_patch_keeps_the_engine_and_refuses_stale_recommendations() {
        let change = Change::SetModel {
            from: "big".into(),
            to: "small".into(),
        };
        let patch = patch_for(&agent(&[], Some("big")), &change).expect("current model matches");
        let slot = patch.chat_model.expect("chat slot patched");
        assert_eq!(slot.model_id.as_deref(), Some("small"));
        assert_eq!(slot.engine.as_deref(), Some("gateway"));
        assert!(patch.model.is_none());
        assert!(patch_for(&agent(&[], Some("other")), &change).is_err());
    }

    #[test]
    fn external_engines_are_not_replayed() {
        assert!(replays_through_gateway(&agent(&[], Some("big"))));
        let mut acp = agent(&[], Some("sonnet"));
        acp.chat_model = Some(ModelSlot {
            model_id: Some("sonnet".to_owned()),
            engine: Some("acp:claude".to_owned()),
        });
        assert!(!replays_through_gateway(&acp));
        let mut custom = agent(&[], None);
        custom.engine = Some("acp-exec:my-agent --stdio".to_owned());
        assert!(!replays_through_gateway(&custom));
    }

    #[test]
    fn tool_patch_removes_only_named_tools_and_never_widens_to_all() {
        let change = Change::RemoveTools {
            remove: vec!["slack.post".into()],
            keep: vec!["search.web".into()],
        };
        let patch = patch_for(&agent(&["search.web", "slack.post"], None), &change).unwrap();
        assert_eq!(patch.tools, Some(vec!["search.web".to_owned()]));

        let only = patch_for(&agent(&["slack.post"], None), &change).unwrap();
        assert_eq!(only.tools, Some(vec![NO_AGENT_CAPABILITIES.to_owned()]));

        assert!(patch_for(&agent(&["search.web"], None), &change).is_err());
    }
}
