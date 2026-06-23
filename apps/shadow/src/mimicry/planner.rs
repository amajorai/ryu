use anyhow::Result;
use std::sync::Arc;

use super::types::{ProcedureStep, StepFailureAction, TaskPlan};
use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};

/// Generates task plans from task descriptions using the LLM.
pub struct CloudPlanner {
    orchestrator: Arc<LlmOrchestrator>,
}

impl CloudPlanner {
    pub fn new(orchestrator: Arc<LlmOrchestrator>) -> Self {
        Self { orchestrator }
    }

    pub async fn plan(
        &self,
        task: &str,
        context: &str,
        similar_procedures: &[String],
    ) -> Result<TaskPlan> {
        let similar_hints = if similar_procedures.is_empty() {
            String::new()
        } else {
            format!(
                "\nSimilar learned procedures:\n{}",
                similar_procedures.join("\n")
            )
        };

        let available_tools = crate::agent::tools::ax::AVAILABLE_TOOLS_HINT;

        let prompt = format!(
            "You are planning how to automate a computer task.\n\
             Task: {}\n\
             Current context:\n{}{}\n\n\
             Available tools: {}\n\n\
             Generate a step-by-step plan. Each step must specify:\n\
             - description: what to do\n\
             - tool_name: ax_click|ax_type|ax_hotkey|ax_scroll|ax_wait|ax_focus_app\n\
             - tool_args: JSON arguments for that tool\n\
             - verification: optional check after step\n\
             - on_failure: abort|skip|retry|escalate\n\n\
             Respond with JSON:\n\
             {{\n\
               \"task_description\": \"...\",\n\
               \"steps\": [\n\
                 {{\"step_number\":1,\"description\":\"...\",\"tool_name\":\"...\",\"tool_args\":{{...}},\"verification\":null,\"on_failure\":\"abort\"}}\n\
               ],\n\
               \"preconditions\": [],\n\
               \"estimated_duration_s\": 30\n\
             }}",
            task, context, similar_hints, available_tools
        );

        let response = self
            .orchestrator
            .generate(LlmRequest {
                messages: vec![LlmMessage::user(prompt)],
                temperature: 0.1,
                max_tokens: 1024,
                ..Default::default()
            })
            .await?;

        let content = response.content.unwrap_or_default();
        let json_str = extract_json_object(&content).unwrap_or_else(|| "{}".to_string());
        let parsed: serde_json::Value = serde_json::from_str(&json_str)?;

        let steps: Vec<ProcedureStep> = parsed["steps"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .enumerate()
            .map(|(i, s)| ProcedureStep {
                step_number: s["step_number"].as_u64().unwrap_or(i as u64 + 1) as u32,
                description: s["description"].as_str().unwrap_or("").to_string(),
                tool_name: s["tool_name"].as_str().unwrap_or("ax_click").to_string(),
                tool_args: s["tool_args"].clone(),
                verification: s["verification"].as_str().map(|s| s.to_string()),
                on_failure: parse_failure_action(s["on_failure"].as_str().unwrap_or("abort")),
            })
            .collect();

        let preconditions: Vec<String> = parsed["preconditions"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect();

        Ok(TaskPlan {
            task_description: task.to_string(),
            steps,
            preconditions,
            estimated_duration_s: parsed["estimated_duration_s"].as_u64().unwrap_or(30) as u32,
        })
    }
}

fn parse_failure_action(s: &str) -> StepFailureAction {
    match s {
        "skip" => StepFailureAction::Skip,
        "retry" => StepFailureAction::Retry,
        "escalate" => StepFailureAction::Escalate,
        _ => StepFailureAction::Abort,
    }
}

fn extract_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let bytes = s[start..].as_bytes();
    let mut depth = 0i32;
    let mut end = start;
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    if end > start {
        Some(s[start..=end].to_string())
    } else {
        None
    }
}
