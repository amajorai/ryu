//! Failed-run reporting: Core raises the `core#run.failed` **kernel event** for every
//! failed agent run, scheduled agent job, and workflow run
//! (`docs/app-boundary-extraction-plan.md` §3 step 4).
//!
//! This replaced `healing_client.rs`, a loopback shim that posted the failure to
//! the Self-Healing sidecar and applied the verdict it returned. Core now knows no
//! consumer: an app that wants failed runs declares
//! `subscribes: [{ event: "core#run.failed", … }]` plus the reviewed
//! `runs:failures` grant, and the generic fan-out
//! ([`crate::sidecar::event_subscribers`]) delivers to it. Whatever the consumer
//! decides to do it does through grant-gated kernel capabilities
//! (`approvals.request`, `runs.rerunAgent`, `workflows.rerun`, see
//! [`crate::server::app_runs`]).
//!
//! # Failure posture
//!
//! Reporting must never slow, block, or fail the run that failed. Every entry point
//! here is synchronous, never awaits a subscriber ([`emit_kernel_event`] only queues),
//! swallows its own errors into a debug log, and is a no-op outside a Tokio runtime.
//! No subscriber, a disabled subscriber, or a subscriber without the grant all mean
//! the event is dropped silently.
//!
//! [`emit_kernel_event`]: crate::sidecar::event_subscribers::emit_kernel_event

use serde_json::{json, Value};

use ryu_healing_contracts::{truncate_context, SOURCE_KIND_AGENT, SOURCE_KIND_WORKFLOW};

use crate::server::conversations::ConversationSummary;
use crate::server::ServerState;

/// The kernel event id this module raises (a row of
/// `ryu_kernel_contracts::KERNEL_EVENTS`).
pub const RUN_FAILED_EVENT: &str = "core#run.failed";

/// Which kernel surface failed. Selects the payload's `kind` (spelled by the shared
/// `ryu-healing-contracts` constants, which the Healing sidecar parses).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailedRun {
    /// A chat / agent / scheduled-agent run.
    Agent { agent_id: Option<String> },
    /// A workflow run.
    Workflow,
}

/// The `core#run.failed` payload. Both free-text halves are truncated with the
/// shared context policy, so a payload stays far below the kernel-event size cap.
#[must_use]
pub fn run_failed_payload(
    source_id: &str,
    run: &FailedRun,
    instruction: &str,
    failure: &str,
) -> Value {
    let (kind, agent_id) = match run {
        FailedRun::Agent { agent_id } => (SOURCE_KIND_AGENT, agent_id.clone()),
        FailedRun::Workflow => (SOURCE_KIND_WORKFLOW, None),
    };
    json!({
        "source_id": source_id,
        "kind": kind,
        "agent_id": agent_id,
        "instruction": truncate_context(instruction),
        "failure": truncate_context(failure),
    })
}

/// Raise `core#run.failed`. Best-effort and non-blocking (see the module docs).
pub fn report_run_failed(source_id: &str, run: FailedRun, instruction: &str, failure: &str) {
    if tokio::runtime::Handle::try_current().is_err() {
        return;
    }
    let payload = run_failed_payload(source_id, &run, instruction, failure);
    if let Err(error) =
        crate::sidecar::event_subscribers::emit_kernel_event(RUN_FAILED_EVENT, payload)
    {
        tracing::debug!(source_id, "run.failed not raised: {error}");
    }
}

/// Scheduler path: a scheduled job failed. Only agent jobs are reported (a
/// corrected-prompt re-run is meaningful only for them); the source id is
/// `job:<id>`, as it always was.
pub fn report_job_failure(job: &crate::scheduler::store::ScheduledJob, error: &str) {
    if let crate::scheduler::store::JobTarget::Agent {
        agent_id, prompt, ..
    } = &job.target
    {
        report_run_failed(
            &format!("job:{}", job.id),
            FailedRun::Agent {
                agent_id: Some(agent_id.clone()),
            },
            prompt,
            error,
        );
    }
}

/// Workflow path: `workflow::executor::fail_run` failed a run.
pub fn report_workflow_failure(run_id: &str, error: &str) {
    report_run_failed(
        run_id,
        FailedRun::Workflow,
        &format!("Workflow run {run_id} failed."),
        error,
    );
}

/// The last user instruction and the last assistant output of a conversation,
/// from its `(role, content)` turns in order.
fn context_from_turns<'a>(turns: impl IntoIterator<Item = (&'a str, &'a str)>) -> (String, String) {
    let mut instruction = "";
    let mut failure = "";
    for (role, content) in turns {
        match role {
            "user" => instruction = content,
            "assistant" => failure = content,
            _ => {}
        }
    }
    (instruction.to_owned(), failure.to_owned())
}

/// Bus path for one failed conversation run, given its turns. A run with no user
/// instruction has nothing to act on and is not reported.
fn report_conversation_failure<'a>(
    run_id: &str,
    agent_id: Option<String>,
    turns: impl IntoIterator<Item = (&'a str, &'a str)>,
) {
    let (instruction, failure) = context_from_turns(turns);
    if instruction.trim().is_empty() {
        tracing::debug!("run.failed: {run_id} has no instruction; not reported");
        return;
    }
    report_run_failed(
        run_id,
        FailedRun::Agent { agent_id },
        &instruction,
        &failure,
    );
}

/// Read a failed run's turns from the kernel conversation store and report it.
async fn handle_failed(state: &ServerState, run: ConversationSummary) {
    let Ok(messages) = state.conversations.get_messages(&run.id).await else {
        return;
    };
    report_conversation_failure(
        &run.id,
        run.agent_id,
        messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str())),
    );
}

/// Subscribe the run-status bus and report every failed chat/agent run. A lagged or
/// closed bus only means a run is not reported, never a wedge. Spawned once from
/// `main.rs`.
pub fn spawn_bus_listener(state: ServerState) {
    tokio::spawn(async move {
        let mut rx = crate::server::conversations::subscribe_run_events();
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if event.run.run_status.as_deref() == Some("failed") {
                        let state = state.clone();
                        // Off the recv path so a slow store read never stalls the bus.
                        tokio::spawn(async move { handle_failed(&state, event.run).await });
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("run.failed: lagged {n} run events (not reported)");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::event_subscribers::test_capture::emitted_for;

    #[test]
    fn payload_carries_kind_agent_and_truncated_context() {
        let long = "x".repeat(ryu_healing_contracts::MAX_CONTEXT_CHARS + 50);
        let payload = run_failed_payload(
            "conv-1",
            &FailedRun::Agent {
                agent_id: Some("a1".into()),
            },
            &long,
            "boom",
        );
        assert_eq!(payload["source_id"], "conv-1");
        assert_eq!(payload["kind"], SOURCE_KIND_AGENT);
        assert_eq!(payload["agent_id"], "a1");
        assert_eq!(payload["failure"], "boom");
        assert_eq!(
            payload["instruction"].as_str().unwrap().chars().count(),
            ryu_healing_contracts::MAX_CONTEXT_CHARS + 1
        );
        let workflow = run_failed_payload("wf-1", &FailedRun::Workflow, "i", "f");
        assert_eq!(workflow["kind"], SOURCE_KIND_WORKFLOW);
        assert!(workflow["agent_id"].is_null());
    }

    #[test]
    fn reporting_outside_a_runtime_is_a_silent_no_op() {
        let source = format!("no-runtime-{}", uuid::Uuid::new_v4().simple());
        report_run_failed(&source, FailedRun::Workflow, "i", "f");
        assert!(emitted_for(&source).is_empty());
    }

    #[tokio::test]
    async fn bus_path_reports_the_last_instruction_and_output() {
        let run_id = format!("conv-{}", uuid::Uuid::new_v4().simple());
        report_conversation_failure(
            &run_id,
            Some("agent-7".into()),
            [
                ("user", "first"),
                ("assistant", "partial"),
                ("user", "do the thing"),
                ("tool", "ignored"),
                ("assistant", "it broke"),
            ],
        );
        let emitted = emitted_for(&run_id);
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["kind"], SOURCE_KIND_AGENT);
        assert_eq!(emitted[0]["agent_id"], "agent-7");
        assert_eq!(emitted[0]["instruction"], "do the thing");
        assert_eq!(emitted[0]["failure"], "it broke");

        // No instruction ⇒ nothing to act on ⇒ not reported.
        let silent = format!("conv-{}", uuid::Uuid::new_v4().simple());
        report_conversation_failure(&silent, None, [("assistant", "x")]);
        assert!(emitted_for(&silent).is_empty());
    }

    #[tokio::test]
    async fn scheduler_path_reports_agent_jobs_only() {
        use crate::scheduler::store::{JobTarget, Schedule, ScheduledJob};
        let id = format!("job-{}", uuid::Uuid::new_v4().simple());
        let mut job = ScheduledJob {
            id: id.clone(),
            name: "nightly".to_owned(),
            schedule: Schedule::Every {
                interval: "1h".to_owned(),
            },
            target: JobTarget::Agent {
                agent_id: "researcher".to_owned(),
                prompt: "summarise".to_owned(),
                model: None,
                conversation_id: None,
            },
            enabled: true,
            require_approval: false,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: "now".to_owned(),
            updated_at: "now".to_owned(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        };
        report_job_failure(&job, "gateway down");
        let emitted = emitted_for(&format!("job:{id}"));
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["agent_id"], "researcher");
        assert_eq!(emitted[0]["instruction"], "summarise");
        assert_eq!(emitted[0]["failure"], "gateway down");

        job.id = format!("job-{}", uuid::Uuid::new_v4().simple());
        job.target = JobTarget::Workflow {
            workflow_id: "wf".to_owned(),
            input: Default::default(),
        };
        report_job_failure(&job, "x");
        assert!(emitted_for(&format!("job:{}", job.id)).is_empty());
    }
}
