use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use tracing::debug;

use crate::{
    budget::BudgetDecision,
    config::{BudgetAction, ProviderKind},
    error::GatewayError,
    pipeline::{self, authenticate, AuthInputs},
    state::SharedState,
};

/// Read an optional non-empty header value as an owned string.
fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Stable lowercase label for a budget action (response header value).
fn budget_action_label(action: BudgetAction) -> &'static str {
    match action {
        BudgetAction::Notify => "notify",
        BudgetAction::Downgrade => "downgrade",
        BudgetAction::Restrict => "restrict",
        BudgetAction::Stop => "stop",
    }
}

/// Attach `x-budget-*` headers so the client can observe budget state and the
/// action that was taken (U21 acceptance criterion: observable to the client).
fn apply_budget_headers(hdrs: &mut HeaderMap, budget: &BudgetDecision) {
    hdrs.insert(
        "x-budget-scope",
        HeaderValue::from_static(budget.scope.as_str()),
    );
    hdrs.insert(
        "x-budget-action",
        HeaderValue::from_static(budget_action_label(budget.action)),
    );
    if let Ok(v) = HeaderValue::from_str(&budget.used.to_string()) {
        hdrs.insert("x-budget-used", v);
    }
    if let Ok(v) = HeaderValue::from_str(&budget.limit.to_string()) {
        hdrs.insert("x-budget-limit", v);
    }
}

pub async fn chat_completions(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());

    // Caller identity for per-user / per-agent budgets (U21).
    let user_id = header_string(&headers, "x-ryu-user-id");
    let agent_id = header_string(&headers, "x-ryu-agent-id");
    // Active skill ids for attribution (M3 / #145 AC3).
    let skill_ids = header_string(&headers, "x-ryu-skill-ids");
    // Per-agent egress tool allowlist (#475 C7). CSV of FQ tool ids forwarded by
    // Core; scopes this request's unified tool loop to the agent's selected
    // tools. Reads `x-ryu-tools` with a legacy fallback to the old
    // `x-ryu-composio-actions` header (new wins) during migration.
    //
    // `tools_header_present` captures whether the NEW header was literally there
    // BEFORE folding in the legacy fallback. The unified loop triggers only on
    // the new header (or `x-ryu-tool-search`), so a bare Composio agent (legacy
    // header only) keeps its fast stream + legacy Composio loop; the folded
    // `tool_actions` still feeds the allowlist for migration.
    let tools_header = header_string(&headers, "x-ryu-tools");
    let tools_header_present = tools_header.is_some();
    let tool_actions = tools_header.or_else(|| header_string(&headers, "x-ryu-composio-actions"));
    // Explicit opt-in to the unified search-based tool loop (#475). `on`/`true`/`1`
    // flips the chat path to the buffered tool loop even without an allowlist
    // header (so the model can discover tools via `tool_search`). Core's ACP
    // forwarder never sets this → no double tool surface on ACP egress.
    let tool_search_requested = headers
        .get("x-ryu-tool-search")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            matches!(v.as_str(), "on" | "true" | "1" | "yes")
        })
        .unwrap_or(false);
    // Per-agent chat slot override (M3 / #164). For chat requests the chat slot
    // model can override what the gateway's model map would select. The chat
    // slot provider is stored on the context but run/run_stream currently use
    // model-based routing; the model override is forwarded via body["model"] by
    // Core so the gateway's existing model routing picks it up.
    let slot_provider = header_string(&headers, "x-ryu-slot-chat-provider")
        .and_then(|s| s.parse::<ProviderKind>().ok());
    let slot_model = header_string(&headers, "x-ryu-slot-chat-model");
    // Core conversation/session id for per-run audit correlation (M4 / #176).
    let session_id = header_string(&headers, "x-ryu-session-id");
    // Product surface that originated this request (profiles / usage-points):
    // `chat` | `island` | `predict` | `agent`. Recorded on the audit row so the
    // reporter can build the per-feature daily usage breakdown. Absent on
    // self-hosted / legacy callers.
    let feature = header_string(&headers, "x-ryu-feature");
    // Companion-sourced flag (M7 / #199): true when Core has tagged this request as
    // originating from the screen-capture companion path. Triggers unconditional
    // Gateway DLP/PII redaction before the provider call.
    let companion_source = headers
        .get("x-ryu-companion-source")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false);
    // Local-engine admission priority (#queue): Core marks fan-out / scheduled /
    // monitor work as `background` so an interactive chat turn jumps ahead of it
    // when the resident engine's batch slots are full. Unset ⇒ interactive.
    let priority = crate::concurrency::Priority::from_header(
        headers.get("x-ryu-priority").and_then(|v| v.to_str().ok()),
    );
    // Named tool-policy profile (#473 profiles). Core forwards the agent's
    // selected profile name; the gateway resolves it to an allowlist preset in
    // `effective_tool_allowlist`. Absent or unknown ⇒ today's allowlist path.
    let tool_profile = header_string(&headers, "x-ryu-tool-profile");
    // Raw tool passthrough (SDK-side agent loops). When `on`/`true`/`1`, the
    // gateway suppresses BOTH managed tool loops (unified + legacy Composio) and
    // takes the plain branch, so the caller's own `tools` and `tool_calls` pass
    // through untouched. Set by `@ryu/sdk`'s agent runtime so its in-process loop
    // owns tool calling even against a Composio-on node.
    let raw_tools = headers
        .get("x-ryu-raw-tools")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            matches!(v.as_str(), "on" | "true" | "1" | "yes")
        })
        .unwrap_or(false);

    let ctx = authenticate(
        &state,
        AuthInputs {
            raw_api_key: raw_key,
            user_id,
            agent_id,
            skill_ids,
            tool_actions,
            tools_header_present,
            slot_provider,
            slot_model,
            session_id,
            feature,
            companion_source,
            tool_search_requested,
            priority,
            tool_profile,
            raw_tools,
        },
    )
    .await?;
    debug!(request_id = %ctx.request_id, "chat_completions: authenticated");

    let is_stream = body["stream"].as_bool().unwrap_or(false);

    if is_stream {
        let output = pipeline::run_stream(state, ctx, body).await?;

        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .header("x-request-id", &output.context.request_id)
            .header("x-provider", output.provider_used)
            .body(output.body)
            .map_err(|e| GatewayError::Internal(anyhow::anyhow!("response build error: {e}")))?;

        if let Ok(v) = HeaderValue::from_str(&output.model_used) {
            response.headers_mut().insert("x-routed-model", v);
        }
        if let Some(ref budget) = output.budget {
            apply_budget_headers(response.headers_mut(), budget);
        }
        if let Some(ref degraded) = output.degraded {
            if let Ok(v) = HeaderValue::from_str(&degraded.header_value()) {
                response.headers_mut().insert("x-degraded", v);
            }
        }
        // Ok-path policy-alert stamp: stash on the RESPONSE extensions so the
        // router's `map_response` layer writes `x-ryu-policy-alert`. Inserting on
        // the response (not the request) is the F1 correctness fix.
        if let Some(alert) = output.policy_alert {
            response.extensions_mut().insert(alert);
        }

        Ok(response)
    } else {
        let output = pipeline::run(state, ctx, body).await?;

        let budget = output.budget.clone();
        let degraded = output.degraded.clone();
        let policy_alert = output.policy_alert.clone();
        let mut response = Json(output.response).into_response();
        let hdrs = response.headers_mut();
        if let Ok(v) = HeaderValue::from_str(&output.context.request_id) {
            hdrs.insert("x-request-id", v);
        }
        hdrs.insert("x-provider", HeaderValue::from_static(output.provider_used));
        if let Ok(v) = HeaderValue::from_str(&output.model_used) {
            hdrs.insert("x-routed-model", v);
        }
        hdrs.insert(
            "x-cache",
            HeaderValue::from_static(if output.cache_hit { "HIT" } else { "MISS" }),
        );
        if let Some(ref budget) = budget {
            apply_budget_headers(hdrs, budget);
        }
        if let Some(score) = output.eval_score {
            if let Ok(v) = HeaderValue::from_str(&format!("{score:.4}")) {
                hdrs.insert("x-eval-score", v);
            }
        }
        // AC1 (#218): emit x-degraded header when the request was served by a
        // fallback provider because the primary circuit was open.
        if let Some(ref d) = degraded {
            if let Ok(v) = HeaderValue::from_str(&d.header_value()) {
                hdrs.insert("x-degraded", v);
            }
        }
        // Ok-path policy-alert stamp (see the streaming branch): stash on the
        // response extensions for the router's `map_response` layer.
        if let Some(alert) = policy_alert {
            response.extensions_mut().insert(alert);
        }

        Ok(response)
    }
}
