//! The installed-app projection, plugin doctor and plugin eval runs: `PluginEvalQuery` through `span_tool_names`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[derive(Debug, Default, serde::Deserialize)]
pub(in crate::server) struct PluginEvalQuery {
    pub(in crate::server) id: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct PluginEvalRunRequest {
    pub(in crate::server) id: String,
    #[serde(default)]
    pub(in crate::server) case: Option<String>,
    #[serde(default)]
    pub(in crate::server) runs: Option<usize>,
    #[serde(default)]
    pub(in crate::server) threshold: Option<f32>,
}

/// A package eval request is an explicit model-execution operation. Keep its
/// total attempts bounded even when a package declares many cases or the caller
/// asks for the maximum per-case repeat count.
pub(in crate::server) const MAX_PLUGIN_EVAL_ATTEMPTS: usize = 100;

pub(in crate::server) fn app_is_installed(app: &serde_json::Value) -> bool {
    app.get("installed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        || app
            .get("built_in")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
}

pub(in crate::server) fn app_is_enabled(app: &serde_json::Value) -> bool {
    app.get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub(in crate::server) async fn find_loaded_plugin(
    state: &ServerState,
    plugin_id: &str,
) -> Option<crate::plugin_manifest::PluginManifest> {
    state
        .app_manifests
        .read()
        .await
        .iter()
        .find(|manifest| manifest.id == plugin_id)
        .cloned()
}

/// `GET /api/plugins/evals` — inspect the package-local Claude-compatible eval
/// suite for one installed plugin/app, or return every installed artifact's
/// suite summary when `id` is omitted. This route is read-only and never starts
/// a model, sidecar, tool, or companion.
#[utoipa::path(
    get,
    path = "/api/plugins/evals",
    tag = "Plugins",
    params(("id" = Option<String>, Query, description = "Inspect one installed app/plugin")),
    summary = "Inspect a plugin or app eval suite",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_evals(
    State(state): State<ServerState>,
    Query(query): Query<PluginEvalQuery>,
) -> axum::response::Response {
    let Json(payload) = list_apps_projection(&state, None, true).await;
    let apps = payload
        .get("apps")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let requested_id = query
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(id) = requested_id {
        let Some(app) = apps.iter().find(|app| {
            app.get("id")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|candidate| candidate == id)
                && app_is_installed(app)
        }) else {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("plugin or app '{id}' is not installed"),
            );
        };
        let overview = inspect_plugin_evals(id, plugin_artifact_kind(app)).overview;
        return Json(overview).into_response();
    }

    let plugins = apps
        .iter()
        .filter(|app| app_is_installed(app))
        .filter_map(|app| {
            let id = app.get("id").and_then(serde_json::Value::as_str)?;
            Some(inspect_plugin_evals(id, plugin_artifact_kind(app)).overview)
        })
        .collect::<Vec<_>>();
    Json(json!({ "plugins": plugins })).into_response()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct PluginEvalGraderResult {
    pub(in crate::server) id: String,
    pub(in crate::server) r#type: String,
    pub(in crate::server) status: String,
    pub(in crate::server) score: Option<f32>,
    pub(in crate::server) executed: bool,
    pub(in crate::server) detail: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct PluginEvalAttempt {
    pub(in crate::server) id: String,
    pub(in crate::server) status: String,
    pub(in crate::server) score: Option<f32>,
    pub(in crate::server) duration_ms: u64,
    pub(in crate::server) response_preview: Option<String>,
    pub(in crate::server) tool_calls: Vec<String>,
    pub(in crate::server) graders: Vec<PluginEvalGraderResult>,
    pub(in crate::server) error: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct PluginEvalCaseResult {
    pub(in crate::server) id: String,
    pub(in crate::server) name: String,
    pub(in crate::server) status: String,
    pub(in crate::server) score: Option<f32>,
    pub(in crate::server) passed: usize,
    pub(in crate::server) failed: usize,
    pub(in crate::server) skipped: usize,
    pub(in crate::server) runs: Vec<PluginEvalAttempt>,
}

pub(in crate::server) fn short_eval_text(text: &str, max_chars: usize) -> String {
    let mut output: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        output.push('…');
    }
    output
}

pub(in crate::server) fn eval_grader_result(
    grader: &crate::plugin_evals::ParsedGrader,
    status: &str,
    score: Option<f32>,
    executed: bool,
    detail: impl Into<String>,
) -> PluginEvalGraderResult {
    PluginEvalGraderResult {
        id: grader.id.clone(),
        r#type: grader.kind.clone(),
        status: status.to_owned(),
        score,
        executed,
        detail: detail.into(),
    }
}

pub(in crate::server) fn span_tool_names(spans: &[ryu_tracing::Span]) -> Vec<String> {
    spans
        .iter()
        .filter(|span| span.normalized_kind() == Some(ryu_tracing::SpanKind::ToolCall))
        .map(|span| span.name.clone())
        .collect()
}
