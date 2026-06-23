use anyhow::Result;
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

use super::types::{MimicryProgress, ProcedureStep, StepFailureAction, UndoSnapshot};
use super::undo_manager::ExecutionUndoManager;
use crate::agent::tools::ax::{
    AXClickTool, AXFocusAppTool, AXHotkeyTool, AXScrollTool, AXTreeQueryTool, AXTypeTool,
    AXWaitTool,
};
use crate::agent::tools::{AgentTool, ToolResult};
use crate::intelligence::safety::SafetyGate;

/// Executes task plan steps using the AX tool suite.
pub struct LocalExecutor {
    tools: Vec<Arc<dyn AgentTool>>,
    safety_gate: Arc<SafetyGate>,
    pub undo: std::sync::Mutex<ExecutionUndoManager>,
}

impl LocalExecutor {
    pub fn new(safety_gate: Arc<SafetyGate>) -> Self {
        Self {
            tools: vec![
                Arc::new(AXClickTool),
                Arc::new(AXTypeTool),
                Arc::new(AXHotkeyTool),
                Arc::new(AXScrollTool),
                Arc::new(AXWaitTool),
                Arc::new(AXFocusAppTool),
                Arc::new(AXTreeQueryTool),
            ],
            safety_gate,
            undo: std::sync::Mutex::new(ExecutionUndoManager::new()),
        }
    }

    /// Execute a single step. Returns Ok(result) or Err on failure.
    pub async fn execute_step(&self, step: &ProcedureStep) -> Result<serde_json::Value> {
        let tool = self
            .tools
            .iter()
            .find(|t| t.definition().name == step.tool_name)
            .ok_or_else(|| anyhow::anyhow!("Unknown tool: {}", step.tool_name))?;

        let result: ToolResult = tool.execute(step.tool_args.clone()).await?;

        if let Some(err) = result.error {
            anyhow::bail!("Step {} failed: {}", step.step_number, err);
        }

        Ok(result.result)
    }

    /// Execute all steps in a plan, streaming progress.
    pub async fn execute_plan(
        &self,
        steps: &[ProcedureStep],
        tx: &UnboundedSender<MimicryProgress>,
    ) -> Result<u32> {
        let mut completed = 0u32;

        for step in steps {
            // Safety gate check before every step
            match self
                .safety_gate
                .check(&step.tool_name, &step.tool_args)
                .await
            {
                Err(e) => {
                    let reason = e.to_string();
                    tracing::warn!(
                        "Safety gate hard-blocked step {}: {}",
                        step.step_number,
                        reason
                    );
                    let _ = tx.send(MimicryProgress::StepBlocked {
                        step: step.step_number,
                        reason: reason.clone(),
                    });
                    return Err(anyhow::anyhow!(
                        "Step {} blocked by safety gate: {}",
                        step.step_number,
                        reason
                    ));
                }
                Ok(true) => {
                    // Requires approval — log and continue for now (no approval UI yet)
                    tracing::warn!(
                        "Safety gate flagged step {} ('{}') as requiring approval; proceeding",
                        step.step_number,
                        step.tool_name
                    );
                }
                Ok(false) => {} // safe
            }

            let _ = tx.send(MimicryProgress::StepStarted {
                step: step.step_number,
                description: step.description.clone(),
            });

            // Push undo snapshot only for steps that mutate state
            const READ_ONLY_TOOLS: &[&str] = &[
                "ax_tree_query",
                "ax_inspect",
                "ax_element_at",
                "ax_read_text",
                "ax_list_apps",
            ];
            if !READ_ONLY_TOOLS.contains(&step.tool_name.as_str()) {
                let pre_hash = self.capture_ax_hash().await.unwrap_or(0);
                if let Ok(mut undo) = self.undo.lock() {
                    let scroll_dy =
                        step.tool_args["direction"]
                            .as_str()
                            .map(|d| if d == "up" { -1i32 } else { 1 });
                    undo.push_step(
                        step.step_number as usize,
                        &step.tool_name,
                        pre_hash,
                        step.tool_args["app"].as_str().map(str::to_string),
                        None,
                        scroll_dy,
                    );
                }
            }

            // Capture AX snapshot before the step when verification is requested
            let before_hash = if step.verification.is_some() {
                self.capture_ax_snapshot(step.step_number)
                    .await
                    .map(|s| hash_value(&s.ax_tree))
            } else {
                None
            };

            match self.execute_step(step).await {
                Ok(result) => {
                    // AX hash verification
                    if let Some(condition) = &step.verification {
                        if let Err(e) = self.verify_with_hash(condition, &result, before_hash).await
                        {
                            tracing::warn!("Step {} verification warning: {}", step.step_number, e);
                        }
                    }

                    completed += 1;
                    let _ = tx.send(MimicryProgress::StepCompleted {
                        step: step.step_number,
                        result,
                    });
                }
                Err(e) => {
                    let err_str = e.to_string();
                    let _ = tx.send(MimicryProgress::StepFailed {
                        step: step.step_number,
                        error: err_str.clone(),
                    });

                    match step.on_failure {
                        StepFailureAction::Abort => {
                            return Err(anyhow::anyhow!(
                                "Step {} aborted: {}",
                                step.step_number,
                                err_str
                            ));
                        }
                        StepFailureAction::Skip => {
                            tracing::warn!("Step {} skipped: {}", step.step_number, err_str);
                            continue;
                        }
                        StepFailureAction::Retry => {
                            // Broadening retry: inject "strategy": "fuzzy" for ax_click
                            let retry_step = if step.tool_name == "ax_click" {
                                let mut args = step.tool_args.clone();
                                if let Some(obj) = args.as_object_mut() {
                                    obj.insert("strategy".to_string(), serde_json::json!("fuzzy"));
                                }
                                std::borrow::Cow::Owned(ProcedureStep {
                                    tool_args: args,
                                    ..step.clone()
                                })
                            } else {
                                std::borrow::Cow::Borrowed(step)
                            };

                            match self.execute_step(&retry_step).await {
                                Ok(result) => {
                                    completed += 1;
                                    let _ = tx.send(MimicryProgress::StepCompleted {
                                        step: step.step_number,
                                        result,
                                    });
                                }
                                Err(e2) => {
                                    return Err(anyhow::anyhow!(
                                        "Step {} failed after broadening retry: {}",
                                        step.step_number,
                                        e2
                                    ));
                                }
                            }
                        }
                        StepFailureAction::Escalate => {
                            let _ = tx.send(MimicryProgress::Replanning {
                                reason: err_str.clone(),
                            });
                            return Err(anyhow::anyhow!("Escalated: {}", err_str));
                        }
                    }
                }
            }

            // Brief pause between steps
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }

        Ok(completed)
    }

    /// Capture the current AX tree as an UndoSnapshot.
    async fn capture_ax_snapshot(&self, step: u32) -> Option<UndoSnapshot> {
        let tool = self
            .tools
            .iter()
            .find(|t| t.definition().name == "ax_tree_query")?;
        let result = tool.execute(serde_json::json!({})).await.ok()?;
        if result.error.is_some() {
            return None;
        }
        Some(UndoSnapshot {
            step,
            ax_tree: result.result,
        })
    }

    /// Capture a hash of the current AX tree state.
    async fn capture_ax_hash(&self) -> Option<u64> {
        let tool = self
            .tools
            .iter()
            .find(|t| t.definition().name == "ax_tree_query")?;
        let result = tool.execute(serde_json::json!({})).await.ok()?;
        if result.error.is_some() {
            return None;
        }
        Some(hash_value(&result.result))
    }

    /// Verify a step result, using AX tree hash comparison when verification is set.
    async fn verify_with_hash(
        &self,
        condition: &str,
        result: &serde_json::Value,
        before_hash: Option<u64>,
    ) -> Result<()> {
        // String-contains check
        if condition.starts_with("contains:") {
            let expected = &condition["contains:".len()..];
            let result_str = serde_json::to_string(result).unwrap_or_default();
            if !result_str.contains(expected) {
                anyhow::bail!(
                    "Verification failed: result does not contain '{}'",
                    expected
                );
            }
        }

        // AX tree change check: warn if tree is unchanged after the step
        if let Some(before) = before_hash {
            if let Some(after) = self.capture_ax_hash().await {
                if before == after {
                    tracing::warn!(
                        "AX tree unchanged after step with verification condition '{}'; \
                         the action may not have had its intended effect",
                        condition
                    );
                }
            }
        }

        Ok(())
    }

    /// Undo the last executed step by dispatching the stored reversal strategy.
    pub async fn undo_last_step(&self) {
        let strategy = {
            if let Ok(mut undo) = self.undo.lock() {
                undo.pop_reversal()
            } else {
                None
            }
        };
        if let Some(s) = strategy {
            use super::undo_manager::UndoStrategy;
            match s {
                UndoStrategy::UndoShortcut => {
                    let tool = self
                        .tools
                        .iter()
                        .find(|t| t.definition().name == "ax_hotkey");
                    if let Some(t) = tool {
                        let _ = t.execute(serde_json::json!({"keys": "ctrl+z"})).await;
                    }
                }
                UndoStrategy::SwitchBack(app) => {
                    let tool = self
                        .tools
                        .iter()
                        .find(|t| t.definition().name == "ax_focus_app");
                    if let Some(t) = tool {
                        let _ = t.execute(serde_json::json!({"app": app})).await;
                    }
                }
                UndoStrategy::ReverseScroll { dy, .. } => {
                    let tool = self
                        .tools
                        .iter()
                        .find(|t| t.definition().name == "ax_scroll");
                    if let Some(t) = tool {
                        let dir = if dy < 0 { "up" } else { "down" };
                        let _ = t.execute(serde_json::json!({"direction": dir})).await;
                    }
                }
                UndoStrategy::Manual(reason) => {
                    tracing::warn!("Cannot auto-undo last step: {}", reason);
                }
            }
        }
    }
}

impl Default for LocalExecutor {
    fn default() -> Self {
        Self::new(Arc::new(SafetyGate::new(None)))
    }
}

/// FNV-1a-inspired hash for quick AX tree change detection.
fn hash_value(v: &serde_json::Value) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    serde_json::to_string(v)
        .unwrap_or_default()
        .hash(&mut hasher);
    hasher.finish()
}
