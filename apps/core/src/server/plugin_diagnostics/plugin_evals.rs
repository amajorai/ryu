//! The installed-app projection, plugin doctor and plugin eval runs: `plugin_evals_run` through `plugin_evals_run`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/plugins/evals/run` — run package eval cases through the enabled
/// artifact's normal Core agent path. The run is intentionally explicit: the
/// doctor never executes package code, and this endpoint refuses an uninstalled
/// or disabled artifact before it starts a model call.
#[utoipa::path(
    post,
    path = "/api/plugins/evals/run",
    tag = "Plugins",
    summary = "Run a plugin or app eval suite",
    request_body = serde_json::Value,
    responses((status = 200, description = "Eval report", body = serde_json::Value))
)]
pub(in crate::server) async fn plugin_evals_run(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(request): Json<PluginEvalRunRequest>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.run".to_owned(),
        );
    }
    let plugin_id = request.id.trim();
    if plugin_id.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "id is required".to_owned());
    }
    let Json(payload) = list_apps_projection(&state, None, true).await;
    let app = payload
        .get("apps")
        .and_then(Value::as_array)
        .and_then(|apps| {
            apps.iter().find(|app| {
                app.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id == plugin_id)
            })
        });
    let Some(app) = app else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("plugin or app '{plugin_id}' is not installed"),
        );
    };
    if !app_is_installed(app) {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("plugin or app '{plugin_id}' is not installed"),
        );
    }
    if !app_is_enabled(app) {
        return json_error(
            StatusCode::CONFLICT,
            format!("plugin or app '{plugin_id}' is disabled; enable it before running evals"),
        );
    }
    let Some(manifest) = find_loaded_plugin(&state, plugin_id).await else {
        return json_error(
            StatusCode::CONFLICT,
            format!("plugin or app '{plugin_id}' is not active in this Core runtime"),
        );
    };
    let artifact_kind = plugin_artifact_kind(app);
    let parsed = inspect_plugin_evals(plugin_id, artifact_kind);
    if parsed.overview.suite.status == "not_configured" {
        return Json(json!({
            "schemaVersion": crate::plugin_evals::SCHEMA_VERSION,
            "rulesetVersion": crate::plugin_evals::RULESET_VERSION,
            "runId": Value::Null,
            "pluginId": plugin_id,
            "artifactKind": artifact_kind,
            "status": "not_configured",
            "evidenceLevel": "none",
            "suite": parsed.overview.suite,
            "cases": [],
            "baseline": { "status": "not_run", "reason": "no package eval suite" }
        }))
        .into_response();
    }
    if parsed.overview.suite.status == "invalid" {
        return Json(json!({
            "schemaVersion": crate::plugin_evals::SCHEMA_VERSION,
            "rulesetVersion": crate::plugin_evals::RULESET_VERSION,
            "runId": Value::Null,
            "pluginId": plugin_id,
            "artifactKind": artifact_kind,
            "status": "invalid",
            "evidenceLevel": "none",
            "suite": parsed.overview.suite,
            "cases": [],
            "baseline": { "status": "not_run", "reason": "suite validation failed" }
        }))
        .into_response();
    }

    let requested_case = request
        .case
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let selected_cases: Vec<&crate::plugin_evals::ParsedCase> = parsed
        .cases
        .iter()
        .filter(|case| {
            requested_case.is_none_or(|requested| {
                case.summary.id == requested
                    || case.summary.name == requested
                    || case.summary.path == requested
            })
        })
        .collect();
    if selected_cases.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            requested_case.map_or_else(
                || "the eval suite has no runnable cases".to_owned(),
                |value| format!("eval case '{value}' was not found"),
            ),
        );
    }
    let total_attempts = selected_cases.iter().try_fold(0usize, |total, case| {
        total.checked_add(
            request
                .runs
                .unwrap_or(case.summary.runs)
                .clamp(1, crate::plugin_evals::MAX_RUNS),
        )
    });
    if total_attempts.is_none_or(|total| total > MAX_PLUGIN_EVAL_ATTEMPTS) {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "plugin eval requests are limited to {MAX_PLUGIN_EVAL_ATTEMPTS} total attempts"
            ),
        );
    }
    let threshold = request.threshold.unwrap_or(1.0).clamp(0.0, 1.0);
    let started_at = chrono::Utc::now().to_rfc3339();
    let run_id = format!("plugin_eval_{}", uuid::Uuid::new_v4().simple());
    let mut case_results = Vec::with_capacity(selected_cases.len());

    for case in selected_cases {
        let run_count = request
            .runs
            .unwrap_or(case.summary.runs)
            .clamp(1, crate::plugin_evals::MAX_RUNS);
        let agent_id = match eval_target_agent(&manifest, case.summary.runnable.as_deref()) {
            Ok(agent_id) => Some(agent_id),
            Err(error) => {
                case_results.push(PluginEvalCaseResult {
                    id: case.summary.id.clone(),
                    name: case.summary.name.clone(),
                    status: "unavailable".to_owned(),
                    score: None,
                    passed: 0,
                    failed: 0,
                    skipped: run_count,
                    runs: (0..run_count)
                        .map(|index| PluginEvalAttempt {
                            id: format!("{run_id}-{}", index + 1),
                            status: "skipped".to_owned(),
                            score: None,
                            duration_ms: 0,
                            response_preview: None,
                            tool_calls: Vec::new(),
                            graders: case
                                .graders
                                .iter()
                                .map(|grader| {
                                    eval_grader_result(
                                        grader,
                                        "skipped",
                                        None,
                                        false,
                                        error.clone(),
                                    )
                                })
                                .collect(),
                            error: Some(error.clone()),
                        })
                        .collect(),
                });
                continue;
            }
        };
        let agent_id = agent_id.expect("eval target resolution always returns Some");
        if !crate::fleet::is_agent_available(&agent_id) {
            return json_error(
                StatusCode::FORBIDDEN,
                "eval agent is unavailable under organization policy".to_owned(),
            );
        }
        if let Err(response) = enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_RUN,
            &agent_id,
        )
        .await
        {
            return response;
        }
        let mut attempts = Vec::with_capacity(run_count);
        for index in 0..run_count {
            let attempt_id = format!("{run_id}-{}", index + 1);
            let conversation_id = format!("{attempt_id}-trace");
            let attempt_started = std::time::Instant::now();
            let outcome = match tokio::time::timeout(
                std::time::Duration::from_secs(case.summary.timeout_seconds),
                run_reply_text(
                    conversation_id.clone(),
                    Some(agent_id.clone()),
                    case.prompt.clone(),
                    None,
                    Arc::clone(&state.agents),
                    state.conversations.clone(),
                    state.agent_store.clone(),
                    Arc::clone(&state.manager),
                    state.memory.clone(),
                    Arc::clone(&state.worktree_diffs),
                    Arc::clone(&state.mcp),
                    state.skills.clone(),
                    state.traces.clone(),
                ),
            )
            .await
            {
                Ok(outcome) => outcome,
                Err(_) => Err(anyhow::anyhow!(
                    "eval case timed out after {}s",
                    case.summary.timeout_seconds
                )),
            };
            let spans = state
                .traces
                .get_spans(&conversation_id)
                .await
                .unwrap_or_default();
            // The conversation is only a temporary eval harness. Trace spans are
            // retained as privacy-safe execution evidence; conversation content
            // and any durable assistant messages are removed after grading.
            if let Err(error) = delete_conversation_with_residue(&state, &conversation_id).await {
                tracing::warn!("could not delete an eval conversation: {error:#}");
            }
            let duration_ms = attempt_started.elapsed().as_millis() as u64;
            let (status, score, response_preview, graders, error) = match outcome {
                Ok(reply_result) => {
                    let reply = reply_result.reply;
                    let graders =
                        futures_util::future::join_all(case.graders.iter().map(|grader| {
                            grade_plugin_eval_grader(&state, grader, &case.prompt, &reply, &spans)
                        }))
                        .await;
                    let executed: Vec<&PluginEvalGraderResult> = graders
                        .iter()
                        .filter(|grader| grader.executed && grader.score.is_some())
                        .collect();
                    let score = (!executed.is_empty()).then(|| {
                        executed
                            .iter()
                            .filter_map(|grader| grader.score)
                            .sum::<f32>()
                            / executed.len() as f32
                    });
                    let status = match score {
                        Some(value) if value >= threshold => "passed",
                        Some(_) => "failed",
                        None => "unavailable",
                    };
                    (
                        status.to_owned(),
                        score,
                        Some(short_eval_text(&reply, 800)),
                        graders,
                        None,
                    )
                }
                Err(error) => (
                    "error".to_owned(),
                    None,
                    None,
                    case.graders
                        .iter()
                        .map(|grader| {
                            eval_grader_result(
                                grader,
                                "skipped",
                                None,
                                false,
                                "the agent run did not produce a reply",
                            )
                        })
                        .collect(),
                    Some(error.to_string()),
                ),
            };
            let _ = state.traces.delete_spans(&conversation_id).await;
            attempts.push(PluginEvalAttempt {
                id: attempt_id,
                status,
                score,
                duration_ms,
                response_preview,
                tool_calls: span_tool_names(&spans),
                graders,
                error,
            });
        }
        let scored: Vec<f32> = attempts
            .iter()
            .filter_map(|attempt| attempt.score)
            .collect();
        let score = (!scored.is_empty()).then(|| scored.iter().sum::<f32>() / scored.len() as f32);
        let passed = attempts
            .iter()
            .filter(|attempt| attempt.status == "passed")
            .count();
        let failed = attempts
            .iter()
            .filter(|attempt| matches!(attempt.status.as_str(), "failed" | "error"))
            .count();
        let skipped = attempts
            .iter()
            .filter(|attempt| attempt.status == "unavailable" || attempt.status == "skipped")
            .count();
        let status = match score {
            Some(value) if value >= threshold => "passed",
            Some(_) => "failed",
            None => "unavailable",
        };
        case_results.push(PluginEvalCaseResult {
            id: case.summary.id.clone(),
            name: case.summary.name.clone(),
            status: status.to_owned(),
            score,
            passed,
            failed,
            skipped,
            runs: attempts,
        });
    }

    let scores: Vec<f32> = case_results.iter().filter_map(|case| case.score).collect();
    let suite_score =
        (!scores.is_empty()).then(|| scores.iter().sum::<f32>() / scores.len() as f32);
    let status = if case_results.iter().any(|case| case.status == "failed") {
        "failed"
    } else if case_results.iter().any(|case| case.status == "unavailable") {
        if suite_score.is_some() {
            "partial"
        } else {
            "unavailable"
        }
    } else if suite_score.is_some_and(|score| score >= threshold) {
        "passed"
    } else {
        "failed"
    };
    Json(json!({
        "schemaVersion": crate::plugin_evals::SCHEMA_VERSION,
        "rulesetVersion": crate::plugin_evals::RULESET_VERSION,
        "runId": run_id,
        "pluginId": plugin_id,
        "artifactKind": artifact_kind,
        "status": status,
        "evidenceLevel": "plugin-agent",
        "threshold": threshold,
        "score": suite_score,
        "startedAt": started_at,
        "finishedAt": chrono::Utc::now().to_rfc3339(),
        "suite": parsed.overview.suite,
        "cases": case_results,
        "baseline": {
            "status": "not_run",
            "reason": "Ryu never disables a live installation to manufacture a no-plugin baseline; use the doctor and an explicit disabled run when you need ablation evidence."
        }
    }))
    .into_response()
}
