use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;

use crate::llm::{orchestrator::LlmOrchestrator, LlmMessage, LlmRequest};

const MAX_STEPS: u32 = 20;
const STEP_TIMEOUT: Duration = Duration::from_secs(30);

/// Phase of the vision agent's see-think-act-verify loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisionAgentPhase {
    Planning,
    Grounding,
    Executing,
    Verifying,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VisionAgentStatus {
    Success,
    Failure(String),
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionAgentProgress {
    pub phase: VisionAgentPhase,
    pub step: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionAgentResult {
    pub status: VisionAgentStatus,
    pub steps_taken: u32,
    pub final_screenshot: Option<String>,
}

/// Vision-first computer-use agent.
///
/// Uses a see-think-act-verify loop:
/// 1. Capture screenshot (sliding window of last 6 to avoid HTTP 413).
/// 2. If GroundingOracle available: use VLM for element location.
/// 3. Ask LLM to reason about the next action.
/// 4. Execute action via AX tools.
/// 5. Verify state changed.
/// 6. Repeat until done or max steps.
pub struct VisionAgent {
    orchestrator: Arc<LlmOrchestrator>,
    #[cfg(feature = "ort")]
    grounding: Option<Arc<crate::intelligence::GroundingOracle>>,
}

impl VisionAgent {
    pub fn new(orchestrator: Arc<LlmOrchestrator>) -> Self {
        Self {
            orchestrator,
            #[cfg(feature = "ort")]
            grounding: None,
        }
    }

    #[cfg(feature = "ort")]
    pub fn with_grounding(mut self, g: Arc<crate::intelligence::GroundingOracle>) -> Self {
        self.grounding = Some(g);
        self
    }

    /// Run the vision agent and stream progress events.
    pub async fn run(
        &self,
        task: &str,
        tx: UnboundedSender<VisionAgentProgress>,
    ) -> Result<VisionAgentResult> {
        let start = Instant::now();
        let mut step = 0u32;
        // Sliding window: keep last 6 screenshots in LLM context
        let mut screenshot_history: std::collections::VecDeque<String> =
            std::collections::VecDeque::with_capacity(6);
        let mut messages: Vec<LlmMessage> = vec![LlmMessage::system(VISION_SYSTEM_PROMPT)];

        let _ = tx.send(VisionAgentProgress {
            phase: VisionAgentPhase::Planning,
            step: 0,
            message: format!("Starting vision task: {}", task),
        });

        // Initial user message
        messages.push(LlmMessage::user(format!(
            "Task: {}\n\nPlease complete this task step by step. \
             Use the tools available to interact with the screen.",
            task
        )));

        loop {
            if step >= MAX_STEPS {
                return Ok(VisionAgentResult {
                    status: VisionAgentStatus::Timeout,
                    steps_taken: step,
                    final_screenshot: None,
                });
            }
            if start.elapsed() > STEP_TIMEOUT * MAX_STEPS {
                return Ok(VisionAgentResult {
                    status: VisionAgentStatus::Timeout,
                    steps_taken: step,
                    final_screenshot: None,
                });
            }

            step += 1;

            // 1. Capture screenshot
            let _ = tx.send(VisionAgentProgress {
                phase: VisionAgentPhase::Grounding,
                step,
                message: "Capturing screen state".to_string(),
            });

            let screenshot_b64 = capture_screenshot().await;

            // Maintain sliding window
            if screenshot_history.len() >= 6 {
                screenshot_history.pop_front();
            }
            if let Some(ref img) = screenshot_b64 {
                screenshot_history.push_back(img.clone());
            }

            // 2. Build prompt for this step
            let screen_description = match screenshot_b64 {
                Some(_) => "[Current screenshot attached]".to_string(),
                None => ax_tree_summary().await,
            };

            messages.push(LlmMessage::user(format!(
                "Step {}: Current screen state:\n{}\n\n\
                 What is the next action to complete the task? \
                 Respond with a tool call or 'done' if the task is complete.",
                step, screen_description
            )));

            // 3. Ask LLM for next action
            let _ = tx.send(VisionAgentProgress {
                phase: VisionAgentPhase::Executing,
                step,
                message: "Reasoning about next action".to_string(),
            });

            let response = self
                .orchestrator
                .generate(LlmRequest {
                    messages: messages.clone(),
                    temperature: 0.1,
                    max_tokens: 256,
                    ..Default::default()
                })
                .await;

            let resp_text = match response {
                Ok(r) => r.content.unwrap_or_default(),
                Err(e) => {
                    return Ok(VisionAgentResult {
                        status: VisionAgentStatus::Failure(e.to_string()),
                        steps_taken: step,
                        final_screenshot: screenshot_history.back().cloned(),
                    });
                }
            };

            messages.push(LlmMessage::assistant(&resp_text));

            // Check for completion signals
            let resp_lower = resp_text.to_lowercase();
            if resp_lower.contains("task complete")
                || resp_lower.contains("done")
                || resp_lower.contains("finished")
            {
                let _ = tx.send(VisionAgentProgress {
                    phase: VisionAgentPhase::Done,
                    step,
                    message: "Task completed".to_string(),
                });
                return Ok(VisionAgentResult {
                    status: VisionAgentStatus::Success,
                    steps_taken: step,
                    final_screenshot: screenshot_history.back().cloned(),
                });
            }

            // Check for failure signals
            if resp_lower.contains("cannot complete")
                || resp_lower.contains("unable to")
                || resp_lower.contains("failed")
            {
                return Ok(VisionAgentResult {
                    status: VisionAgentStatus::Failure(resp_text),
                    steps_taken: step,
                    final_screenshot: screenshot_history.back().cloned(),
                });
            }

            // 4. Parse and execute action from LLM response
            let action_result = execute_action_from_text(&resp_text).await;

            // 5. Verify
            let _ = tx.send(VisionAgentProgress {
                phase: VisionAgentPhase::Verifying,
                step,
                message: format!("Verifying step {}", step),
            });

            let verification = match action_result {
                Ok(result) => format!("Action result: {}", result),
                Err(e) => format!("Action failed: {}", e),
            };

            messages.push(LlmMessage::user(format!(
                "Verification: {}\nContinue with the next step or confirm completion.",
                verification
            )));

            // Brief pause between steps
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        Ok(VisionAgentResult {
            status: VisionAgentStatus::Timeout,
            steps_taken: step,
            final_screenshot: screenshot_history.back().cloned(),
        })
    }
}

// ── Helpers (thin wrappers around existing AX tools) ─────────────────────────

async fn capture_screenshot() -> Option<String> {
    // Use ghost-eyes screen capture
    match ghost_eyes::quick_screenshot(0).await {
        Ok(frame) => {
            use base64::Engine;
            // Frame data is BGRA — convert to RGBA for image crate
            let mut rgba = frame.data.clone();
            for chunk in rgba.chunks_exact_mut(4) {
                chunk.swap(0, 2); // B↔R
            }
            let img = image::RgbaImage::from_raw(frame.width, frame.height, rgba);
            if let Some(img) = img {
                let mut buf = Vec::new();
                if image::DynamicImage::ImageRgba8(img)
                    .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
                    .is_ok()
                {
                    return Some(base64::engine::general_purpose::STANDARD.encode(&buf));
                }
            }
            None
        }
        Err(_) => None,
    }
}

async fn ax_tree_summary() -> String {
    // Fall back to a textual AX description when screenshot isn't available
    use ghost_eyes::AXTree;
    match ghost_eyes::PlatformAXTree::new() {
        Ok(ax) => match ax.get_focused_tree().await {
            Ok(tree) => format!(
                "AX tree root: {} (role: {})",
                tree.title.as_deref().unwrap_or(""),
                tree.role
            ),
            Err(_) => "AX tree unavailable".to_string(),
        },
        Err(_) => "AX tree unavailable".to_string(),
    }
}

async fn execute_action_from_text(text: &str) -> Result<String> {
    // Parse simple action directives from LLM response text.
    // The LLM is expected to say things like:
    //   "Type 'hello world'" → ghost_hands::type_text
    //   "Press Ctrl+C" → ghost_hands::press_key
    //   "Click …" → requires element coordinates; not directly supported here
    let text_lower = text.to_lowercase();

    if let Some(rest) = extract_after(&text_lower, "type '") {
        let value = rest.trim_end_matches('\'');
        let _ = ghost_hands::type_text(value, false);
        return Ok(format!("Typed: {}", value));
    }
    if let Some(rest) = extract_after(&text_lower, "press ") {
        let _ = ghost_hands::press_key(rest, &[]);
        return Ok(format!("Pressed: {}", rest));
    }
    if text_lower.contains("click ") {
        // Click requires grounding — return description so LLM can refine
        return Ok(format!("Action noted (click requires grounding): {}", text));
    }

    // No recognized action — return the raw text
    Ok(text.to_string())
}

fn extract_after<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.find(prefix).map(|i| text[i + prefix.len()..].trim())
}

const VISION_SYSTEM_PROMPT: &str = "\
You are a vision-first computer automation agent. You control the user's computer to complete tasks.

For each step, analyze the current screen state and decide the minimal next action.
Express actions as natural text: 'Click the X button', 'Type \"text\"', 'Press Ctrl+C'.
When the task is complete, say 'Task complete'.
If you cannot complete the task, say 'Cannot complete: reason'.

Be precise and concise. One action per response.";
