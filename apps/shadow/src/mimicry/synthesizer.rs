use anyhow::{Context, Result};

use ghost_core::learning::LearnedEvent;

use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};
use crate::mimicry::types::{ProcedureStep, ProcedureTemplate, StepFailureAction};
use crate::utils::{extract_json, wall_micros};

/// Converts a recorded `LearnedEvent` sequence into a reusable `ProcedureTemplate`
/// by asking the LLM to generalize the raw actions into parameterized steps.
pub struct ProcedureSynthesizer;

impl ProcedureSynthesizer {
    /// Synthesize a `ProcedureTemplate` from a list of recorded events.
    ///
    /// Requires at least 2 events. Falls back to heuristic synthesis when the
    /// LLM is unavailable or returns unparseable output.
    pub async fn synthesize(
        events: &[LearnedEvent],
        orchestrator: &LlmOrchestrator,
    ) -> Result<ProcedureTemplate> {
        if events.len() < 2 {
            anyhow::bail!("Need at least 2 events to synthesize a procedure");
        }

        let descriptions = events_to_descriptions(events);
        let inferred_app = events
            .iter()
            .filter_map(|e| e.app_name.as_deref())
            .next()
            .unwrap_or("")
            .to_string();

        let prompt = build_synthesis_prompt(&descriptions, &inferred_app);

        let resp = orchestrator
            .generate(LlmRequest {
                messages: vec![LlmMessage::user(prompt)],
                temperature: 0.2,
                max_tokens: 1024,
                ..Default::default()
            })
            .await;

        match resp {
            Ok(r) if r.content.is_some() => {
                let text = r.content.unwrap();
                match parse_template(&text, events, &inferred_app) {
                    Some(t) => Ok(t),
                    None => {
                        tracing::warn!("LLM synthesis parse failed; falling back to heuristic");
                        Ok(heuristic_synthesis(events, &inferred_app))
                    }
                }
            }
            _ => {
                tracing::warn!("LLM unavailable for synthesis; using heuristic");
                Ok(heuristic_synthesis(events, &inferred_app))
            }
        }
    }
}

// ---- helpers ----------------------------------------------------------------

fn events_to_descriptions(events: &[LearnedEvent]) -> Vec<String> {
    events.iter().map(|e| describe_event(e)).collect()
}

fn describe_event(e: &LearnedEvent) -> String {
    let app = e.app_name.as_deref().unwrap_or("app");
    match e.event_type.as_str() {
        "click" => {
            let label = e
                .element_name
                .as_deref()
                .or(e.element_id.as_deref())
                .unwrap_or("element");
            let role = e.element_role.as_deref().unwrap_or("control");
            format!("Clicked '{}' {} in {}", label, role, app)
        }
        "type" => {
            let text = e.key.as_deref().unwrap_or("text");
            format!("Typed '{}' in {}", text, app)
        }
        "hotkey" => {
            let key = e.key.as_deref().unwrap_or("key");
            format!("Pressed hotkey {} in {}", key, app)
        }
        "scroll" => format!("Scrolled in {}", app),
        "app_switch" => {
            format!("Switched to {}", app)
        }
        other => format!("{} in {}", other, app),
    }
}

fn build_synthesis_prompt(descriptions: &[String], app: &str) -> String {
    let steps_text = descriptions
        .iter()
        .enumerate()
        .map(|(i, d)| format!("{}. {}", i + 1, d))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "Convert these recorded actions in {app} into a generalized, reusable procedure.\n\
         Replace specific values (search queries, file names, email addresses) with \
         {{{{PLACEHOLDER}}}} parameters.\n\
         Respond with JSON only (no markdown fences):\n\
         {{\"name\":\"...\",\"description\":\"...\",\"steps\":[\
         {{\"tool_name\":\"ax_click|ax_type|ax_hotkey|ax_scroll|ax_wait|ax_focus_app\",\
         \"description\":\"...\",\"tool_args\":{{...}},\
         \"on_failure\":\"abort|skip|retry|escalate\"}}]}}\n\n\
         Recorded actions:\n{steps_text}",
        app = app,
        steps_text = steps_text,
    )
}

fn parse_template(
    text: &str,
    events: &[LearnedEvent],
    inferred_app: &str,
) -> Option<ProcedureTemplate> {
    let json_str = extract_json(text)?;
    let v: serde_json::Value = serde_json::from_str(&json_str).ok()?;

    let name = v["name"].as_str()?.to_string();
    let description = v["description"].as_str().unwrap_or(&name).to_string();
    let steps_arr = v["steps"].as_array()?;

    let steps: Vec<ProcedureStep> = steps_arr
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let tool_name = s["tool_name"].as_str()?.to_string();
            let desc = s["description"].as_str().unwrap_or("step").to_string();
            let tool_args = s["tool_args"].clone();
            let on_failure = match s["on_failure"].as_str().unwrap_or("abort") {
                "skip" => StepFailureAction::Skip,
                "retry" => StepFailureAction::Retry,
                "escalate" => StepFailureAction::Escalate,
                _ => StepFailureAction::Abort,
            };
            Some(ProcedureStep {
                step_number: (i + 1) as u32,
                description: desc,
                tool_name,
                tool_args,
                verification: None,
                on_failure,
            })
        })
        .collect();

    if steps.is_empty() {
        return None;
    }

    Some(ProcedureTemplate {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        app_name: inferred_app.to_string(),
        description,
        steps,
        preconditions: vec![],
        success_count: 0,
        failure_count: 0,
        last_used: wall_micros(),
        created_at: wall_micros(),
    })
}

/// Fallback: build a template directly from events without LLM.
fn heuristic_synthesis(events: &[LearnedEvent], inferred_app: &str) -> ProcedureTemplate {
    let steps: Vec<ProcedureStep> = events
        .iter()
        .enumerate()
        .map(|(i, e)| {
            let (tool_name, tool_args) = event_to_tool(e);
            ProcedureStep {
                step_number: (i + 1) as u32,
                description: describe_event(e),
                tool_name,
                tool_args,
                verification: None,
                on_failure: StepFailureAction::Skip,
            }
        })
        .collect();

    let name = format!(
        "Recorded procedure in {}",
        events
            .first()
            .and_then(|e| e.app_name.as_deref())
            .unwrap_or("app")
    );

    ProcedureTemplate {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.clone(),
        app_name: inferred_app.to_string(),
        description: name,
        steps,
        preconditions: vec![],
        success_count: 0,
        failure_count: 0,
        last_used: wall_micros(),
        created_at: wall_micros(),
    }
}

fn event_to_tool(e: &LearnedEvent) -> (String, serde_json::Value) {
    match e.event_type.as_str() {
        "click" => {
            let mut args = serde_json::json!({});
            if let Some(name) = &e.element_name {
                args["query"] = serde_json::json!(name);
            } else if let (Some(x), Some(y)) = (e.x, e.y) {
                args["x"] = serde_json::json!(x);
                args["y"] = serde_json::json!(y);
            }
            ("ax_click".to_string(), args)
        }
        "type" => {
            let text = e.key.as_deref().unwrap_or("");
            ("ax_type".to_string(), serde_json::json!({"text": text}))
        }
        "hotkey" => {
            let key = e.key.as_deref().unwrap_or("");
            ("ax_hotkey".to_string(), serde_json::json!({"keys": key}))
        }
        "scroll" => (
            "ax_scroll".to_string(),
            serde_json::json!({"direction": "down"}),
        ),
        "app_switch" => {
            let app = e.app_name.as_deref().unwrap_or("app");
            ("ax_focus_app".to_string(), serde_json::json!({"app": app}))
        }
        _ => ("ax_wait".to_string(), serde_json::json!({"ms": 500})),
    }
}
