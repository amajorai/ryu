//! The installed-app projection, plugin doctor and plugin eval runs: `grade_plugin_eval_grader` through `eval_target_agent`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) async fn grade_plugin_eval_grader(
    state: &ServerState,
    grader: &crate::plugin_evals::ParsedGrader,
    prompt: &str,
    response: &str,
    spans: &[ryu_tracing::Span],
) -> PluginEvalGraderResult {
    match &grader.spec {
        crate::plugin_evals::GraderSpec::Regex {
            pattern,
            flags,
            match_mode,
            target,
        } => {
            if target != "last_message" {
                return eval_grader_result(
                    grader,
                    "skipped",
                    None,
                    false,
                    format!("regex target '{target}' is not available; use last_message"),
                );
            }
            match crate::plugin_evals::grade_regex(pattern, flags, match_mode, response) {
                Ok((pass, score, detail)) => eval_grader_result(
                    grader,
                    if pass { "pass" } else { "fail" },
                    Some(score),
                    true,
                    detail,
                ),
                Err(error) => eval_grader_result(grader, "skipped", None, false, error),
            }
        }
        crate::plugin_evals::GraderSpec::ToolUsed {
            tool,
            input_match,
            min,
            max,
        } => {
            if input_match.is_some() {
                return eval_grader_result(
                    grader,
                    "skipped",
                    None,
                    false,
                    "tool input matching is unavailable because Core stores privacy-safe argument hashes only",
                );
            }
            let count = spans
                .iter()
                .filter(|span| {
                    span.normalized_kind() == Some(ryu_tracing::SpanKind::ToolCall)
                        && span.name == *tool
                })
                .count();
            let pass = count >= *min && max.is_none_or(|limit| count <= limit);
            eval_grader_result(
                grader,
                if pass { "pass" } else { "fail" },
                Some(if pass { 1.0 } else { 0.0 }),
                true,
                format!("tool '{tool}' was called {count} time(s)"),
            )
        }
        crate::plugin_evals::GraderSpec::ToolOrder { before, after } => {
            let names = span_tool_names(spans);
            let before_index = names.iter().position(|name| name == before);
            let after_index = names.iter().position(|name| name == after);
            let pass =
                before_index.is_some_and(|left| after_index.is_some_and(|right| left < right));
            eval_grader_result(
                grader,
                if pass { "pass" } else { "fail" },
                Some(if pass { 1.0 } else { 0.0 }),
                true,
                format!("expected '{before}' before '{after}'"),
            )
        }
        crate::plugin_evals::GraderSpec::Llm {
            criteria,
            focus,
            model,
        } => {
            if focus != "last_message" {
                return eval_grader_result(
                    grader,
                    "skipped",
                    None,
                    false,
                    format!("llm focus '{focus}' is not available; use last_message"),
                );
            }
            let body = json!({
                "model": model.as_deref().unwrap_or("gpt-4o-mini"),
                "prompt": prompt,
                "response": { "choices": [{ "message": { "content": response } }] },
                "assertions": [{ "kind": "llm_rubric", "rubric": criteria }]
            });
            let base = crate::sidecar::gateway::gateway_url();
            let mut request = state
                .client
                .post(format!("{}/v1/evals/score", base.trim_end_matches('/')))
                .timeout(std::time::Duration::from_secs(120))
                .json(&body);
            if let Some(token) = crate::sidecar::gateway::gateway_admin_key() {
                request = request.bearer_auth(token);
            }
            let response = match request.send().await {
                Ok(response) => response,
                Err(error) => {
                    return eval_grader_result(
                        grader,
                        "skipped",
                        None,
                        false,
                        format!("judge unavailable: {error}"),
                    );
                }
            };
            let status_code = response.status();
            let payload = match response.json::<Value>().await {
                Ok(payload) => payload,
                Err(error) => {
                    return eval_grader_result(
                        grader,
                        "skipped",
                        None,
                        false,
                        format!("judge returned invalid JSON: {error}"),
                    );
                }
            };
            if !status_code.is_success() {
                return eval_grader_result(
                    grader,
                    "skipped",
                    None,
                    false,
                    format!("judge returned HTTP {}", status_code.as_u16()),
                );
            }
            let assertion = payload
                .get("score")
                .and_then(|value| value.get("assertions"))
                .and_then(Value::as_array)
                .and_then(|values| values.first());
            let Some(assertion) = assertion else {
                return eval_grader_result(
                    grader,
                    "skipped",
                    None,
                    false,
                    "judge response did not contain an assertion result",
                );
            };
            let executed = assertion
                .get("executed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let score = assertion
                .get("score")
                .and_then(Value::as_f64)
                .map(|value| value as f32);
            let pass = assertion
                .get("pass")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let detail = assertion
                .get("detail")
                .and_then(Value::as_str)
                .unwrap_or("judge completed")
                .to_owned();
            eval_grader_result(
                grader,
                if executed && pass {
                    "pass"
                } else if executed {
                    "fail"
                } else {
                    "skipped"
                },
                score,
                executed,
                detail,
            )
        }
        crate::plugin_evals::GraderSpec::Unsupported { reason } => {
            eval_grader_result(grader, "skipped", None, false, reason.clone())
        }
    }
}

pub(in crate::server) fn eval_target_agent(
    manifest: &crate::plugin_manifest::PluginManifest,
    requested: Option<&str>,
) -> Result<String, String> {
    if let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        let requested_id = requested.strip_prefix("app__").unwrap_or(requested);
        let Some(runnable) = manifest
            .runnables
            .iter()
            .find(|entry| entry.id == requested_id)
        else {
            return Err(format!(
                "runnable '{requested}' is not declared by this plugin"
            ));
        };
        if runnable.kind == crate::runnable::RunnableKind::Agent {
            return Ok(format!("app__{}", runnable.id));
        }
        // A tool/skill/workflow case is driven by the default Ryu agent. The
        // target plugin remains loaded and its registered contribution is what
        // the prompt is exercising; the case's runnable is an explicit hint,
        // not a second execution transport.
        return Ok("ryu".to_owned());
    }
    if let Some(runnable) = manifest
        .runnables
        .iter()
        .find(|entry| entry.kind == crate::runnable::RunnableKind::Agent)
    {
        return Ok(format!("app__{}", runnable.id));
    }
    if manifest.runnables.iter().any(|entry| {
        matches!(
            entry.kind,
            crate::runnable::RunnableKind::Tool
                | crate::runnable::RunnableKind::Skill
                | crate::runnable::RunnableKind::Workflow
        )
    }) {
        return Ok("ryu".to_owned());
    }
    Err(
        "the plugin has no agent, tool, skill, or workflow runnable to drive a prompt case"
            .to_owned(),
    )
}
