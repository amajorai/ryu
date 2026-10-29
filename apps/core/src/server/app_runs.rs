//! The **run-recovery** kernel capabilities (`approvals.request`,
//! `runs.rerunAgent`, `workflows.rerun`).
//!
//! These are the Core-side half of the Self-Healing extraction
//! (`docs/app-boundary-extraction-plan.md` §3 step 4). Core used to await the
//! Healing sidecar's `HealVerdict` and apply it itself (`healing_client.rs`). Now
//! Core only raises `core#run.failed` ([`crate::run_failures`]), and a subscriber
//! acts on its own decision by calling these three operations through
//! `POST /api/host/capability/<cap>` (rows in `sidecar::ext_proxy`'s
//! `KERNEL_CAPABILITIES`). Each is gated by its reviewed Gateway grant, declared in
//! the caller's `sidecars[].host_api.grants` and approved (the broker checks the
//! intersection before dispatching here):
//!
//! | Capability | Grant | Effect |
//! |---|---|---|
//! | `approvals.request` | `approvals:request` | queue a heal approval (`heal_fix` / `heal_workflow` / `heal_exhausted`), deduped on the source |
//! | `runs.rerunAgent` | `runs:rerun-agent` | re-run an agent with a corrected prompt under a Core-minted `healrun_` id |
//! | `workflows.rerun` | `workflows:runstate` | re-run a FAILED workflow run from scratch (`workflow::rerun_run`) |
//!
//! The semantics are the ones `CoreHealingHost` had: the same approval
//! constructors (so the same `HealFix` kind and deferred `PendingAction`s), the same
//! never-heal-a-heal run-id prefix, and the same rerun. Core still decides the
//! shape of everything it executes: an approval is built from a closed set of
//! kinds, and a re-run id is minted here, never taken from the caller (a chosen id
//! could collide with a real conversation, and the prefix is what stops a failing
//! heal from being healed again).
//!
//! Re-runs are started detached and answered `202`: an agent turn or a workflow can
//! take minutes, and a caller blocking on one would hold a broker connection open.

use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use ryu_healing_contracts::HEAL_PREFIX;

use super::ServerState;
use crate::approvals::ApprovalRequest;

/// Queue a heal approval in the Approvals inbox.
pub(crate) const GRANT_APPROVALS_REQUEST: &str = "approvals:request";
/// Re-run a failed agent run.
pub(crate) const GRANT_RERUN_AGENT: &str = "runs:rerun-agent";
/// Re-run a failed workflow run: the existing reviewed workflow run-state grant
/// (`workflows.run` / `workflows.resume` already ride it).
pub(crate) const GRANT_WORKFLOW_RUNSTATE: &str = "workflows:runstate";

/// Upper bound on any free-text field (diagnosis, corrected prompt, note).
const MAX_TEXT_BYTES: usize = 16 * 1024;
/// Upper bound on a source / agent id.
const MAX_ID_BYTES: usize = 256;

/// Why an operation was refused or could not run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunOpError {
    /// The request body is malformed or out of bounds (400).
    Invalid(String),
    /// The named run does not exist (404).
    NotFound(String),
    /// The named run is not in a state this operation applies to (409).
    Conflict(String),
    /// The Core subsystem is not running on this node (503).
    Unavailable(String),
}

impl RunOpError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Invalid(m) => (StatusCode::BAD_REQUEST, m),
            Self::NotFound(m) => (StatusCode::NOT_FOUND, m),
            Self::Conflict(m) => (StatusCode::CONFLICT, m),
            Self::Unavailable(m) => (StatusCode::SERVICE_UNAVAILABLE, m),
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

/// The Core subsystems these operations drive. A trait only so the handlers are
/// testable without the process-global approval engine, agent runner, and
/// workflow store; production always uses [`CoreRunRecovery`].
#[async_trait::async_trait]
pub(crate) trait RunRecoveryHost: Send + Sync {
    /// Persist + announce `request` unless one is already pending for its source.
    /// `Ok(None)` when deduped.
    async fn request_approval(
        &self,
        request: ApprovalRequest,
    ) -> Result<Option<String>, RunOpError>;
    /// Start (detached) one agent turn under `run_id`.
    fn start_agent_rerun(
        &self,
        agent_id: Option<String>,
        run_id: String,
        prompt: String,
    ) -> Result<(), RunOpError>;
    /// Start (detached) a fresh run of the failed workflow run `source_id`.
    fn start_workflow_rerun(&self, source_id: String) -> Result<(), RunOpError>;
}

/// The production host: Core's process-global approval engine, agent runner and
/// workflow executor.
pub(crate) struct CoreRunRecovery;

#[async_trait::async_trait]
impl RunRecoveryHost for CoreRunRecovery {
    async fn request_approval(
        &self,
        request: ApprovalRequest,
    ) -> Result<Option<String>, RunOpError> {
        let engine = crate::approvals::global_engine()
            .ok_or_else(|| RunOpError::Unavailable("approvals are not running".to_owned()))?;
        engine
            .request_deduped(request)
            .await
            .map(|created| created.map(|r| r.id))
            .map_err(|e| RunOpError::Unavailable(format!("approval request failed: {e:#}")))
    }

    fn start_agent_rerun(
        &self,
        agent_id: Option<String>,
        run_id: String,
        prompt: String,
    ) -> Result<(), RunOpError> {
        let runner = crate::sidecar::agent_runner::global_agent_runner()
            .ok_or_else(|| RunOpError::Unavailable("the agent runner is not running".to_owned()))?;
        let rerun = async move {
            if let Err(e) = runner.run(agent_id, run_id.clone(), prompt).await {
                tracing::warn!("runs.rerunAgent: re-run {run_id} failed: {e:#}");
            }
        };
        // A re-run started by a tool call is a sub-turn of the calling turn.
        let attribution = crate::profile_activity::current_attribution();
        tokio::spawn(crate::profile_activity::with_attribution(
            attribution,
            rerun,
        ));
        Ok(())
    }

    fn start_workflow_rerun(&self, source_id: String) -> Result<(), RunOpError> {
        let run = crate::workflow::store::load_run(&source_id)
            .map_err(|_| RunOpError::NotFound(format!("workflow run '{source_id}' not found")))?;
        if run.status != crate::workflow::store::RunStatus::Failed {
            return Err(RunOpError::Conflict(format!(
                "workflow run '{source_id}' has not failed"
            )));
        }
        let rerun = async move {
            if let Err(e) = crate::workflow::rerun_run(&source_id).await {
                tracing::warn!("workflows.rerun: re-run of {source_id} failed: {e}");
            }
        };
        let attribution = crate::profile_activity::current_attribution();
        tokio::spawn(crate::profile_activity::with_attribution(
            attribution,
            rerun,
        ));
        Ok(())
    }
}

#[cfg(test)]
tokio::task_local! {
    /// Test override for [`host`], scoped with `TEST_HOST.scope(..)`.
    pub(crate) static TEST_HOST: std::sync::Arc<dyn RunRecoveryHost>;
}

/// The host the handlers use: [`CoreRunRecovery`], or a test's scoped override.
fn host() -> std::sync::Arc<dyn RunRecoveryHost> {
    #[cfg(test)]
    if let Ok(host) = TEST_HOST.try_with(std::sync::Arc::clone) {
        return host;
    }
    std::sync::Arc::new(CoreRunRecovery)
}

/// Body of `approvals.request`. `kind` picks the approval constructor; Core never
/// takes a title, summary or action from the caller.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ApprovalRequestBody {
    /// Re-run a failed agent run with a corrected instruction, on approve.
    HealFix {
        source_id: String,
        #[serde(default)]
        agent_id: Option<String>,
        diagnosis: String,
        corrected: String,
    },
    /// Re-run a failed workflow run, on approve.
    HealWorkflow {
        source_id: String,
        diagnosis: String,
    },
    /// A terminal review notice with no action.
    HealExhausted { source_id: String, note: String },
}

/// Body of `runs.rerunAgent`.
#[derive(Debug, Deserialize)]
pub(crate) struct RerunAgentBody {
    #[serde(default)]
    agent_id: Option<String>,
    prompt: String,
}

/// Body of `workflows.rerun`.
#[derive(Debug, Deserialize)]
pub(crate) struct RerunWorkflowBody {
    source_id: String,
}

fn check_id(field: &str, value: &str) -> Result<(), RunOpError> {
    if value.trim().is_empty() || value.len() > MAX_ID_BYTES {
        return Err(RunOpError::Invalid(format!(
            "{field} must be 1..={MAX_ID_BYTES} bytes"
        )));
    }
    Ok(())
}

fn check_text(field: &str, value: &str) -> Result<(), RunOpError> {
    if value.len() > MAX_TEXT_BYTES {
        return Err(RunOpError::Invalid(format!(
            "{field} must be at most {MAX_TEXT_BYTES} bytes"
        )));
    }
    Ok(())
}

fn approval_for(body: ApprovalRequestBody) -> Result<ApprovalRequest, RunOpError> {
    match body {
        ApprovalRequestBody::HealFix {
            source_id,
            agent_id,
            diagnosis,
            corrected,
        } => {
            check_id("source_id", &source_id)?;
            if let Some(agent) = &agent_id {
                check_id("agent_id", agent)?;
            }
            check_text("diagnosis", &diagnosis)?;
            check_text("corrected", &corrected)?;
            if corrected.trim().is_empty() {
                return Err(RunOpError::Invalid(
                    "corrected must not be empty".to_owned(),
                ));
            }
            Ok(ApprovalRequest::for_heal_fix(
                &source_id, agent_id, &diagnosis, corrected,
            ))
        }
        ApprovalRequestBody::HealWorkflow {
            source_id,
            diagnosis,
        } => {
            check_id("source_id", &source_id)?;
            check_text("diagnosis", &diagnosis)?;
            Ok(ApprovalRequest::for_heal_workflow(&source_id, &diagnosis))
        }
        ApprovalRequestBody::HealExhausted { source_id, note } => {
            check_id("source_id", &source_id)?;
            check_text("note", &note)?;
            Ok(ApprovalRequest::for_heal_exhausted(&source_id, &note))
        }
    }
}

fn parse<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, RunOpError> {
    serde_json::from_value(body).map_err(|e| RunOpError::Invalid(format!("invalid body: {e}")))
}

async fn run_op(cap: &str, body: Value) -> Result<(StatusCode, Value), RunOpError> {
    match cap {
        "approvals.request" => {
            let request = approval_for(parse(body)?)?;
            let id = host().request_approval(request).await?;
            Ok(approval_reply(id))
        }
        "runs.rerunAgent" => {
            let body: RerunAgentBody = parse(body)?;
            if let Some(agent) = &body.agent_id {
                check_id("agent_id", agent)?;
            }
            check_text("prompt", &body.prompt)?;
            if body.prompt.trim().is_empty() {
                return Err(RunOpError::Invalid("prompt must not be empty".to_owned()));
            }
            // Minted here, never taken from the caller: the prefix is the
            // never-heal-a-heal marker, and a chosen id could collide with a real
            // conversation.
            let run_id = format!("{HEAL_PREFIX}{}", uuid::Uuid::new_v4().simple());
            host().start_agent_rerun(body.agent_id, run_id.clone(), body.prompt)?;
            Ok((StatusCode::ACCEPTED, json!({ "run_id": run_id })))
        }
        "workflows.rerun" => {
            let body: RerunWorkflowBody = parse(body)?;
            check_id("source_id", &body.source_id)?;
            let source_id = body.source_id.clone();
            host().start_workflow_rerun(body.source_id)?;
            Ok((
                StatusCode::ACCEPTED,
                json!({ "accepted": true, "source_id": source_id }),
            ))
        }
        other => Err(RunOpError::Invalid(format!(
            "'{other}' is not a run-recovery capability"
        ))),
    }
}

fn approval_reply(id: Option<String>) -> (StatusCode, Value) {
    match id {
        Some(id) => (StatusCode::OK, json!({ "queued": true, "approval_id": id })),
        None => (StatusCode::OK, json!({ "queued": false, "deduped": true })),
    }
}

/// Kernel-capability entry point for the three run-recovery rows. The broker has
/// already checked the row's grant (declared ∩ approved); this re-authenticates the
/// caller, per the kernel-capability contract, before acting.
pub(crate) async fn host_run_recovery(
    cap: &str,
    state: &ServerState,
    headers: &HeaderMap,
    body: Value,
) -> Response {
    if let Err((status, msg)) =
        crate::sidecar::ext_proxy::authenticate_sidecar(state, headers).await
    {
        return (status, Json(json!({ "error": msg }))).into_response();
    }
    match run_op(cap, body).await {
        Ok((status, value)) => (status, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_bodies_map_onto_the_heal_constructors() {
        let fix = approval_for(
            parse(
                json!({ "kind": "heal_fix", "source_id": "conv-1", "agent_id": "a",
                          "diagnosis": "d", "corrected": "try again" }),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(fix.kind, crate::approvals::ApprovalKind::HealFix);
        assert_eq!(fix.source_ref.as_deref(), Some("conv-1"));
        assert!(matches!(
            fix.action,
            Some(crate::approvals::PendingAction::HealRerun { ref prompt, .. }) if prompt == "try again"
        ));

        let workflow = approval_for(
            parse(json!({ "kind": "heal_workflow", "source_id": "run-9", "diagnosis": "d" }))
                .unwrap(),
        )
        .unwrap();
        assert!(matches!(
            workflow.action,
            Some(crate::approvals::PendingAction::HealWorkflowRerun { ref run_id }) if run_id == "run-9"
        ));

        let exhausted = approval_for(
            parse(json!({ "kind": "heal_exhausted", "source_id": "conv-2", "note": "gave up" }))
                .unwrap(),
        )
        .unwrap();
        assert!(exhausted.action.is_none());
        assert_eq!(
            exhausted.source_ref.as_deref(),
            Some("heal-exhausted:conv-2")
        );
    }

    #[test]
    fn approval_bodies_are_closed_and_bounded() {
        assert!(parse::<ApprovalRequestBody>(json!({ "kind": "tool_call" })).is_err());
        assert!(matches!(
            approval_for(
                parse(
                    json!({ "kind": "heal_fix", "source_id": "", "diagnosis": "d",
                              "corrected": "c" })
                )
                .unwrap()
            ),
            Err(RunOpError::Invalid(_))
        ));
        assert!(matches!(
            approval_for(
                parse(json!({ "kind": "heal_exhausted", "source_id": "s",
                              "note": "x".repeat(MAX_TEXT_BYTES + 1) }))
                .unwrap()
            ),
            Err(RunOpError::Invalid(_))
        ));
    }
}
