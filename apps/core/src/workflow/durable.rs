//! DurableEngine seam and its in-process implementation.
//!
//! # Design
//!
//! A workflow DAG executes through a swappable engine seam so the backend can be
//! changed without touching the server handler. Today there is one engine:
//!
//! - **`FallbackEngine`** — the in-process topological executor backed by
//!   `store::save_run` / `store::load_run`. It runs on every platform, requires
//!   no extra sidecar, and is durable at the node-checkpoint level: run state is
//!   rewritten to disk after every node (and after every loop iteration), so a
//!   run survives a Core restart and resumes from the last completed node.
//!
//! Restate was evaluated as a second backend and **dropped** — the in-process
//! engine already gives crash-recoverable, resumable runs without an extra
//! macOS/Linux-only sidecar, and the petgraph engine owns the loop/HITL
//! semantics directly. The seam (the [`DurableEngine`] trait + [`select_engine`])
//! is kept so a future durable backend can slot in with no server-handler churn.
//!
//! # Core-vs-Gateway
//!
//! The engine decides **what runs** (which step, in what order) — it is Core. It
//! enforces no policy; any model call within a step is routed through the Gateway
//! (`run_prompt` in `executor.rs`).

use std::collections::HashMap;
use std::pin::Pin;

use super::executor;
use super::store::{self, WorkflowRun};
use super::Workflow;

// ── Trait ───────────────────────────────────────────────────────────────────

/// Abstraction over durable-execution backends for workflow DAGs.
///
/// Object-safe: methods return `Pin<Box<dyn Future + Send + '_>>` rather than
/// `impl Future` so the trait can be used as `Box<dyn DurableEngine>` without
/// requiring `async_trait`.
pub trait DurableEngine: Send + Sync {
    /// Execute (or resume) a workflow run to completion.
    fn execute<'a>(
        &'a self,
        workflow: &'a Workflow,
        input: HashMap<String, String>,
        run_id: String,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<WorkflowRun, String>> + Send + 'a>>;

    /// Record a node checkpoint durably. The default implementation delegates to
    /// `store::save_run` so the `FallbackEngine` inherits file-backed
    /// checkpointing automatically.
    fn checkpoint<'a>(
        &'a self,
        run: &'a WorkflowRun,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(
            async move { store::save_run(run).map_err(|e| format!("checkpoint save failed: {e}")) },
        )
    }

    /// Resume a run by loading its persisted state. Returns the saved
    /// `WorkflowRun` if one exists, or `None` if the run is new.
    fn resume<'a>(
        &'a self,
        run_id: &'a str,
        workflow_id: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<WorkflowRun>> + Send + 'a>> {
        Box::pin(async move {
            match store::load_run(run_id) {
                Ok(run) if run.workflow_id == workflow_id => Some(run),
                _ => None,
            }
        })
    }
}

// ── FallbackEngine ───────────────────────────────────────────────────────────

/// In-process, petgraph-backed engine. Thin wrapper over [`executor::run_workflow`].
///
/// State is checkpointed to `~/.ryu/workflow-runs/<run_id>.json` after every node
/// (and after every `While` loop iteration) by the executor, so runs are
/// resumable on process restart.
pub struct FallbackEngine;

impl DurableEngine for FallbackEngine {
    fn execute<'a>(
        &'a self,
        workflow: &'a Workflow,
        input: HashMap<String, String>,
        run_id: String,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<WorkflowRun, String>> + Send + 'a>> {
        Box::pin(executor::run_workflow(workflow, input, run_id))
    }
}

// ── Engine selection ─────────────────────────────────────────────────────────

/// Select and construct the active durable engine.
///
/// There is one engine today — the in-process [`FallbackEngine`]. The seam is
/// retained (rather than inlined) so a future durable backend can be selected
/// here from runtime config without changing the server handler.
pub fn select_engine() -> Box<dyn DurableEngine> {
    Box::new(FallbackEngine)
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::store::{NodeRunState, NodeStatus, RunStatus};
    use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

    fn linear_workflow(id: &str) -> Workflow {
        Workflow {
            id: id.to_string(),
            name: "lin".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("text".into()),
                    },
                },
                WorkflowNode {
                    id: "up".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Transform {
                        op: "uppercase".into(),
                        template: None,
                    },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("result".into()),
                    },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "up".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "up".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        }
    }

    /// The fallback engine must pass the existing linear transform workflow test.
    /// This mirrors `executor::tests::runs_linear_transform_workflow` but routes
    /// through `FallbackEngine::execute`, proving the trait wrapper is transparent.
    #[tokio::test]
    async fn fallback_engine_runs_linear_workflow() {
        let wf_id = format!("durable-lin-{}", uuid::Uuid::new_v4().simple());
        let wf = linear_workflow(&wf_id);
        let engine = FallbackEngine;
        let mut input = HashMap::new();
        input.insert("text".to_string(), "hello".to_string());
        let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
        let run = engine
            .execute(&wf, input, run_id)
            .await
            .expect("fallback engine run ok");
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.output.get("result").map(String::as_str), Some("HELLO"));
    }

    /// Prove that a node whose checkpoint is already marked `Completed` in the
    /// persisted run is **skipped** on resume: the engine reuses the stored output
    /// rather than re-executing the node.
    ///
    /// Method:
    /// 1. Build Input → Transform(uppercase) → Output.
    /// 2. Pre-seed the `WorkflowRun` on disk with the `Transform` node marked
    ///    `Completed` and a **sentinel output** that `uppercase` would never
    ///    produce from the actual input (`"__SENTINEL__"`).
    /// 3. Run through the fallback engine with the same run_id.
    /// 4. Assert the final output carries the sentinel, proving the checkpoint
    ///    was reused and the node was not re-executed.
    #[tokio::test]
    async fn checkpointed_step_is_skipped_on_resume() {
        let wf_id = format!("durable-resume-{}", uuid::Uuid::new_v4().simple());
        let wf = linear_workflow(&wf_id);
        let run_id = format!("run-resume-{}", uuid::Uuid::new_v4().simple());

        // Pre-seed: mark the Transform node as already-completed with a sentinel.
        let mut pre_run = store::WorkflowRun::new(run_id.clone(), wf_id.clone(), {
            let mut m = HashMap::new();
            m.insert("text".to_string(), "hello".to_string());
            m
        });
        pre_run.nodes.insert(
            "up".to_string(),
            NodeRunState {
                status: NodeStatus::Completed,
                output: Some("__SENTINEL__".to_string()),
                error: None,
                attempts: 0,
                wake_at: None,
            },
        );
        store::save_run(&pre_run).expect("pre-seed save ok");

        // Resume through the fallback engine.
        let engine = FallbackEngine;
        let mut input = HashMap::new();
        input.insert("text".to_string(), "hello".to_string());
        let run = engine
            .execute(&wf, input, run_id)
            .await
            .expect("resume run ok");

        assert_eq!(run.status, RunStatus::Completed);
        // The sentinel must appear in the output, proving the checkpoint was reused.
        assert_eq!(
            run.output.get("result").map(String::as_str),
            Some("__SENTINEL__"),
            "expected sentinel from checkpoint, got actual transform output — \
             node was re-executed instead of skipped"
        );
        // The Transform node must still be marked Completed (not re-run).
        assert_eq!(
            run.nodes.get("up").map(|s| s.status),
            Some(NodeStatus::Completed)
        );
    }

    /// `select_engine` returns the in-process FallbackEngine and runs a workflow.
    #[tokio::test]
    async fn select_engine_runs_fallback() {
        let engine = select_engine();
        let wf = linear_workflow(&format!("sel-{}", uuid::Uuid::new_v4().simple()));
        let mut input = HashMap::new();
        input.insert("text".to_string(), "hi".to_string());
        let run_id = format!("sel-run-{}", uuid::Uuid::new_v4().simple());
        let run = engine
            .execute(&wf, input, run_id)
            .await
            .expect("select_engine run ok");
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.output.get("result").map(String::as_str), Some("HI"));
    }
}
