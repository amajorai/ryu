//! Run trace reads: the per-run span list / tree (`GET /api/runs/:id/trace`)
//! and trace search across runs (`GET /api/traces`).
//!
//! Spans record *what ran* (Core). Token counts and cost stay in Gateway audit;
//! a viewer joins them through each model-call span's `session_id`.
//!
//! Authorization: a trace has no owner of its own. Every read is bounded by
//! the caller's readable conversations, exactly like `/api/runs`, so a trace
//! whose conversation is gone (for example a temporary eval run) is never
//! readable.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use super::{json_error, require_resource_read, tenancy_filter_args, ServerState};

/// Query for `GET /api/runs/:id/trace`.
#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct RunTraceParams {
    /// `flat` (default): `{ "spans": [...] }` in write order. `tree`: the run's
    /// spans nested by parent with waterfall offsets.
    #[serde(default)]
    pub format: Option<String>,
}

/// The two response shapes of the run trace route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TraceFormat {
    Flat,
    Tree,
}

fn parse_format(value: Option<&str>) -> Option<TraceFormat> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Some(TraceFormat::Flat),
        Some(value) if value.eq_ignore_ascii_case("flat") => Some(TraceFormat::Flat),
        Some(value) if value.eq_ignore_ascii_case("tree") => Some(TraceFormat::Tree),
        Some(_) => None,
    }
}

/// `GET /api/runs/:id/trace` — the spans for a run (M4 / issue #178).
///
/// `:id` is the `conversation_id` used as the run key. The default response is
/// `{ "spans": [...] }` (every v1 field plus the hierarchical `trace_id`,
/// `span_id`, `parent_span_id`, `status`, `agent_id`, and `attributes`).
/// `?format=tree` returns `{ "format": "tree", "run_id", "started_at",
/// "ended_at", "duration_ms", "span_count", "error_count", "roots": [...] }`,
/// where each node adds `normalized_kind`, `depth`, `offset_ms`,
/// `duration_ms`, and `children`. A run with no spans yet returns an empty
/// list / forest (not 404) so the desktop can poll during an active run.
#[utoipa::path(
    get,
    path = "/api/runs/{id}/trace",
    tag = "Conversations",
    summary = "Get a run's trace spans",
    params(("id" = String, Path), RunTraceParams),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Unknown format"),
        (status = 404, description = "Run not found")
    )
)]
pub async fn get_run_trace_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(run_id): Path<String>,
    Query(params): Query<RunTraceParams>,
) -> axum::response::Response {
    let Some(format) = parse_format(params.format.as_deref()) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "format must be `flat` or `tree`".to_owned(),
        );
    };
    // Per-resource ACL: spans carry the run's tool fingerprints and, under
    // content capture, its payloads.
    match state.conversations.get_access_meta(&run_id).await {
        Ok(Some(tenancy)) => {
            if let Err(resp) =
                require_resource_read(Ok(Some(tenancy)), caller.as_ref(), "run not found")
            {
                return resp;
            }
        }
        Ok(None) => {
            // A trace without its owning conversation has no durable tenant
            // binding. In particular, temporary plugin-eval traces are deleted
            // after grading and must never become a bearer-readable orphan.
            let _ = state.traces.delete_spans(&run_id).await;
            return json_error(StatusCode::NOT_FOUND, "run not found".to_owned());
        }
        Err(error) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("resource access lookup failed: {error}"),
            );
        }
    }
    match format {
        TraceFormat::Flat => match state.traces.get_spans(&run_id).await {
            Ok(spans) => Json(json!({ "spans": spans })).into_response(),
            Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        },
        TraceFormat::Tree => match state.traces.get_tree(&run_id).await {
            Ok(tree) => {
                let mut body = serde_json::to_value(tree).unwrap_or_else(|_| json!({}));
                if let Some(object) = body.as_object_mut() {
                    object.insert("format".to_owned(), json!("tree"));
                }
                Json(body).into_response()
            }
            Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        },
    }
}

/// Query for `GET /api/traces`.
#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TraceListParams {
    /// Only traces whose root ran under this agent.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// `running`, `ok`, `error`, or `cancelled` (the root span's status).
    #[serde(default)]
    pub status: Option<String>,
    /// Root kind, e.g. `agent_run` or `workflow_run`.
    #[serde(default)]
    pub kind: Option<String>,
    /// Lower bound on the root start: Unix milliseconds or RFC 3339.
    #[serde(default)]
    pub since: Option<String>,
    /// Upper bound on the root start: Unix milliseconds or RFC 3339.
    #[serde(default)]
    pub until: Option<String>,
    /// Substring of the root name, or an exact run id / trace id.
    #[serde(default)]
    pub q: Option<String>,
    /// Only this run (conversation).
    #[serde(default)]
    pub run_id: Option<String>,
    /// Page size, 1–500 (default 50).
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

/// Parse a time bound given as Unix milliseconds or an RFC 3339 timestamp.
fn parse_time_bound(value: Option<&str>) -> Result<Option<i64>, String> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if let Ok(ms) = value.parse::<i64>() {
        return Ok(Some(ms));
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|time| Some(time.timestamp_millis()))
        .map_err(|_| format!("`{value}` is not Unix milliseconds or an RFC 3339 time"))
}

/// Validate list parameters into a store query (run visibility added later).
fn build_query(params: &TraceListParams) -> Result<ryu_tracing::TraceQuery, String> {
    let status = match params.status.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => Some(
            ryu_tracing::SpanStatus::parse(value)
                .ok_or_else(|| format!("unknown status `{value}`"))?,
        ),
    };
    let kind = match params.kind.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => Some(
            ryu_tracing::SpanKind::parse(value).ok_or_else(|| format!("unknown kind `{value}`"))?,
        ),
    };
    Ok(ryu_tracing::TraceQuery {
        run_ids: None,
        agent_id: params
            .agent_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        status,
        kind,
        since: parse_time_bound(params.since.as_deref())?,
        until: parse_time_bound(params.until.as_deref())?,
        search: params.q.clone(),
        limit: params.limit.unwrap_or(50).clamp(1, 500),
        offset: params.offset.unwrap_or(0),
    })
}

/// `GET /api/traces` — list and search run traces.
///
/// Returns traces (one per agent run or workflow run) across the caller's
/// readable runs, newest first. Each item carries the root span's `trace_id`,
/// `run_id`, `kind`, `name`, `agent_id`, `status`, timing, `span_count`, and
/// `error_count`. Filter by `agent_id`, `status`, `kind`, `since`/`until`,
/// `run_id`, or `q`.
#[utoipa::path(
    get,
    path = "/api/traces",
    tag = "Conversations",
    summary = "List and search run traces",
    params(TraceListParams),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "Invalid filter")
    )
)]
pub async fn list_traces_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(params): Query<TraceListParams>,
) -> axum::response::Response {
    let mut query = match build_query(&params) {
        Ok(query) => query,
        Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
    };
    let (user_id, org_id, team_ids_json, node_bound) = tenancy_filter_args(&caller);
    let visible = match state
        .conversations
        .visible_conversation_ids_for_teams(
            user_id.as_deref(),
            org_id.as_deref(),
            node_bound,
            team_ids_json.as_deref(),
        )
        .await
    {
        Ok(ids) => ids,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    query.run_ids = Some(match params.run_id.as_deref().map(str::trim) {
        Some(run_id) if !run_id.is_empty() => {
            visible.into_iter().filter(|id| id == run_id).collect()
        }
        _ => visible,
    });
    match state.traces.list_traces(&query).await {
        Ok(traces) => Json(json!({
            "traces": traces,
            "limit": query.limit,
            "offset": query.offset,
        }))
        .into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_defaults_to_flat_and_rejects_unknown_values() {
        assert_eq!(parse_format(None), Some(TraceFormat::Flat));
        assert_eq!(parse_format(Some(" ")), Some(TraceFormat::Flat));
        assert_eq!(parse_format(Some("TREE")), Some(TraceFormat::Tree));
        assert_eq!(parse_format(Some("waterfall")), None);
    }

    #[test]
    fn time_bounds_accept_millis_and_rfc3339() {
        assert_eq!(parse_time_bound(None), Ok(None));
        assert_eq!(
            parse_time_bound(Some("1700000000000")),
            Ok(Some(1_700_000_000_000))
        );
        assert_eq!(
            parse_time_bound(Some("2023-11-14T22:13:20Z")),
            Ok(Some(1_700_000_000_000))
        );
        assert!(parse_time_bound(Some("yesterday")).is_err());
    }

    #[test]
    fn list_filters_are_validated() {
        let query = build_query(&TraceListParams {
            agent_id: Some(" a1 ".into()),
            status: Some("failed".into()),
            kind: Some("workflow-run".into()),
            limit: Some(10_000),
            ..TraceListParams::default()
        })
        .unwrap();
        assert_eq!(query.agent_id.as_deref(), Some("a1"));
        assert_eq!(query.status, Some(ryu_tracing::SpanStatus::Error));
        assert_eq!(query.kind, Some(ryu_tracing::SpanKind::WorkflowRun));
        assert_eq!(query.limit, 500);
        assert!(query.run_ids.is_none());
        assert!(build_query(&TraceListParams {
            status: Some("maybe".into()),
            ..TraceListParams::default()
        })
        .is_err());
        assert!(build_query(&TraceListParams {
            kind: Some("chain".into()),
            ..TraceListParams::default()
        })
        .is_err());
    }
}
