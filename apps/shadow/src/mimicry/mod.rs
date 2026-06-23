pub mod executor;
pub mod matcher;
pub mod planner;
pub mod procedure;
pub mod synthesizer;
pub mod types;
pub mod undo_manager;

pub use matcher::ProcedureMatcher;
pub use procedure::ProcedureStore;
pub use synthesizer::ProcedureSynthesizer;
pub use types::{MimicryProgress, MimicryResult, ProcedureTemplate, TaskPlan};
pub use undo_manager::ExecutionUndoManager;

use anyhow::Result;
use std::sync::Arc;
use tokio_stream::wrappers::UnboundedReceiverStream;

use crate::intelligence::context::{ContextSynthesizer, EpisodeStore};
use crate::intelligence::safety::SafetyGate;
use crate::llm::orchestrator::LlmOrchestrator;
use crate::utils::wall_micros;
use executor::LocalExecutor;
use planner::CloudPlanner;

/// Orchestrates planning + execution of computer tasks.
pub struct MimicryCoordinator {
    planner: CloudPlanner,
    executor: LocalExecutor,
    procedure_store: Arc<std::sync::Mutex<ProcedureStore>>,
    context_synth: ContextSynthesizer,
}

impl MimicryCoordinator {
    pub fn new(
        orchestrator: Arc<LlmOrchestrator>,
        procedure_store: Arc<std::sync::Mutex<ProcedureStore>>,
        safety_gate: Arc<SafetyGate>,
        episode_store: Option<Arc<std::sync::Mutex<EpisodeStore>>>,
    ) -> Self {
        let context_synth = match episode_store {
            Some(store) => ContextSynthesizer::with_store(store, Arc::clone(&orchestrator)),
            None => ContextSynthesizer::new(),
        };
        Self {
            planner: CloudPlanner::new(Arc::clone(&orchestrator)),
            executor: LocalExecutor::new(safety_gate),
            procedure_store,
            context_synth,
        }
    }

    /// Run a task description through plan → execute → learn cycle.
    pub fn run(
        self: Arc<Self>,
        task_description: String,
    ) -> UnboundedReceiverStream<MimicryProgress> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();

        tokio::spawn(async move {
            let tx2 = tx.clone();
            if let Err(e) = self.run_inner(task_description, tx).await {
                let _ = tx2.send(MimicryProgress::Error {
                    message: e.to_string(),
                });
            }
        });

        UnboundedReceiverStream::new(rx)
    }

    async fn run_inner(
        &self,
        task: String,
        tx: tokio::sync::mpsc::UnboundedSender<MimicryProgress>,
    ) -> Result<()> {
        let start = std::time::Instant::now();

        // 1. Gather context
        let episodes = self.context_synth.get_recent_episodes(10)?;
        let context = episodes
            .iter()
            .map(|e| format!("- {} ({})", e.app_name, e.summary))
            .collect::<Vec<_>>()
            .join("\n");

        // Check for an existing high-confidence procedure template.
        // If one is found, skip the LLM planner and execute the stored steps directly.
        let matched_template = {
            if let Ok(store) = self.procedure_store.lock() {
                store
                    .find_similar(&task, 1)
                    .unwrap_or_default()
                    .into_iter()
                    .next()
                    .filter(|p| p.success_count > 0)
            } else {
                None
            }
        };

        // 2. Plan (skip planner if a proven template matched)
        let (plan, reused_template_id) = if let Some(template) = matched_template {
            tracing::info!(
                "Reusing procedure template '{}' (success_count={})",
                template.name,
                template.success_count
            );
            let plan = TaskPlan {
                task_description: task.clone(),
                steps: template.steps.clone(),
                preconditions: template.preconditions.clone(),
                estimated_duration_s: 0,
            };
            (plan, Some(template.id))
        } else {
            // Gather similar procedure names as hints for the LLM planner
            let hints: Vec<String> = {
                if let Ok(store) = self.procedure_store.lock() {
                    // Use ProcedureMatcher for context-aware scoring + keyword fallback
                    let current_app = episodes.first().map(|e| e.app_name.as_str()).unwrap_or("");
                    let window = episodes
                        .first()
                        .map(|e| e.window_title.as_str())
                        .unwrap_or("");
                    let recent: Vec<String> = episodes.iter().map(|e| e.app_name.clone()).collect();
                    let matched =
                        ProcedureMatcher::match_context(current_app, window, &recent, &store);
                    if !matched.is_empty() {
                        matched
                            .iter()
                            .map(|(p, _)| format!("{}: {}", p.name, p.description))
                            .collect()
                    } else {
                        store
                            .find_similar(&task, 5)
                            .unwrap_or_default()
                            .iter()
                            .map(|p| format!("{}: {}", p.name, p.description))
                            .collect()
                    }
                } else {
                    vec![]
                }
            };
            let plan = self.planner.plan(&task, &context, &hints).await?;
            (plan, None)
        };

        let total_steps = plan.steps.len() as u32;
        let _ = tx.send(MimicryProgress::PlanReady { plan: plan.clone() });

        // 3. Execute
        let completed = match self.executor.execute_plan(&plan.steps, &tx).await {
            Ok(n) => n,
            Err(e) => {
                let result = MimicryResult {
                    task_description: task.clone(),
                    success: false,
                    steps_completed: 0,
                    steps_total: total_steps,
                    error: Some(e.to_string()),
                    procedure_id: None,
                    duration_ms: start.elapsed().as_millis() as u64,
                };
                let _ = tx.send(MimicryProgress::Done { result });
                return Ok(());
            }
        };

        // 4. On success: increment existing template's count, or save a new one
        let procedure_id = if completed == total_steps {
            if let Ok(store) = self.procedure_store.lock() {
                if let Some(ref id) = reused_template_id {
                    store.record_success(id).ok();
                    Some(id.clone())
                } else {
                    let proc = ProcedureTemplate {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: task.clone(),
                        app_name: episodes
                            .first()
                            .map(|e| e.app_name.clone())
                            .unwrap_or_default(),
                        description: task.clone(),
                        steps: plan.steps.clone(),
                        preconditions: plan.preconditions.clone(),
                        success_count: 1,
                        failure_count: 0,
                        last_used: wall_micros(),
                        created_at: wall_micros(),
                    };
                    let proc_id = proc.id.clone();
                    store.save(&proc).ok();
                    Some(proc_id)
                }
            } else {
                None
            }
        } else {
            // Record failure against the reused template if it was the one that ran
            if let Some(ref id) = reused_template_id {
                if let Ok(store) = self.procedure_store.lock() {
                    store.record_failure(id).ok();
                }
            }
            None
        };

        let result = MimicryResult {
            task_description: task,
            success: completed == total_steps,
            steps_completed: completed,
            steps_total: total_steps,
            error: None,
            procedure_id,
            duration_ms: start.elapsed().as_millis() as u64,
        };

        let _ = tx.send(MimicryProgress::Done { result });
        Ok(())
    }
}
