//! Human-in-the-loop approval inbox.
//!
//! A unified queue of *pending actions awaiting the user's go-ahead*, raised by
//! agents, workflows, and automations that were **explicitly configured** to
//! require approval. Nothing enters this queue unless a user opted that source
//! into human-in-the-loop (a scheduler job flagged `require_approval`, a workflow
//! `Awakeable` gate, a gated tool — slice 2). The inverse of an autonomous run:
//! the system does everything up to the decision point, parks the action here,
//! notifies the user, and resumes (or runs) on approve. Modeled in spirit on
//! Hermes' approval modes (manual/smart/off) and pause→notify→approve→continue.
//!
//! ## Placement (Core vs Gateway)
//!
//! The **queue** and the **resume/dispatch machinery** decide *what runs*, so they
//! are Core (this module). Whether an action *required* approval is the policy
//! question — for the deferred sources it is a plain user-set config flag
//! (legitimately Core orchestration config); the tool-risk-tag layer (slice 2)
//! routes that decision through a Gateway consult, mirroring how the `Guardrails`
//! workflow node defers to the firewall. Core never classifies risk inline.
//!
//! ## Resolution styles
//!
//! - **Deferred re-dispatch** (scheduled jobs, triggers): the request stores a
//!   [`PendingAction`]; the firing site returns immediately (it never holds a
//!   scheduler permit), and the decide-handler executes the action on approve.
//! - **Suspend/resume** (workflow `Awakeable`): the run is already suspended to
//!   `AwaitingInput`; entering that state mints a row pointing at the run, and
//!   approve resumes it (reject fails it).
//! - **Tool-call** (slice 2): an `approval`-kind elicitation envelope at the tool
//!   dispatch chokepoint, so PTC parks and chat/ACP surface it. Not in slice 1.

pub mod store;

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use store::ApprovalStore;

static ENGINE: OnceLock<ApprovalEngine> = OnceLock::new();

/// Publish the process-global approval engine (called once at startup) so the
/// state-free scheduler + workflow executor can raise requests without threading
/// a handle through every call site.
pub fn set_global_engine(engine: ApprovalEngine) {
    let _ = ENGINE.set(engine);
}

/// The process-global approval engine, if initialized.
pub fn global_engine() -> Option<&'static ApprovalEngine> {
    ENGINE.get()
}

/// What kind of action is awaiting approval (drives the inbox icon + grouping).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    /// An agent's gated tool call (slice 2).
    ToolCall,
    /// A workflow suspended at an `Awakeable` human-in-the-loop gate.
    WorkflowGate,
    /// A scheduled automation flagged `require_approval` before each run.
    ScheduledRun,
    /// An externally-triggered run (Composio / webhook) flagged for approval.
    TriggerRun,
}

/// The lifecycle of a request. Only `Pending` ever transitions (idempotency).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Rejected,
    /// Auto-rejected after `expires_at` elapsed with no decision.
    Expired,
    /// Withdrawn programmatically (e.g. the source run was deleted).
    Cancelled,
}

impl ApprovalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalStatus::Pending => "pending",
            ApprovalStatus::Approved => "approved",
            ApprovalStatus::Rejected => "rejected",
            ApprovalStatus::Expired => "expired",
            ApprovalStatus::Cancelled => "cancelled",
        }
    }
}

/// What executes when a request is approved. Stored inside the request JSON; it
/// can carry an agent prompt / job target, so it is surfaced read-only in the
/// inbox for transparency ("here is exactly what will run") but never carries a
/// secret in slice 1 (deferred sources have none).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PendingAction {
    /// Run a scheduler job target (the job was flagged `require_approval`).
    ScheduledJob {
        target: crate::scheduler::store::JobTarget,
    },
    /// Resume a workflow run suspended at its `Awakeable` gate.
    WorkflowResume { run_id: String },
    /// Run a workflow from a fired trigger's payload.
    TriggerWorkflow {
        workflow_id: String,
        payload_json: String,
    },
    /// Run an agent prompt from a fired trigger.
    TriggerAgent { agent_id: String, prompt: String },
}

/// One queued approval request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub kind: ApprovalKind,
    /// Short human title ("Scheduled run: Morning digest").
    pub title: String,
    /// One or two sentences describing what will run and why it is gated.
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Opaque source correlation (job id / workflow run id / tool id). Used for
    /// pending-dedup so the same source can't pile up duplicate requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    /// Risk tags (e.g. `["scheduled"]`, or `["send","email"]` once classified).
    #[serde(default)]
    pub risk_tags: Vec<String>,
    pub status: ApprovalStatus,
    /// Optional note the deciding user attached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Populated when an approved action failed to execute (surfaced in the inbox).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// What runs on approve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<PendingAction>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

impl ApprovalRequest {
    fn new(
        kind: ApprovalKind,
        title: String,
        summary: String,
        action: Option<PendingAction>,
    ) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            id: format!("appr_{}", uuid::Uuid::new_v4().simple()),
            kind,
            title,
            summary,
            agent_id: None,
            conversation_id: None,
            source_ref: None,
            risk_tags: Vec::new(),
            status: ApprovalStatus::Pending,
            note: None,
            error: None,
            action,
            created_at: now,
            decided_at: None,
            expires_at: None,
        }
    }

    /// Build a request for a scheduled job flagged `require_approval`.
    pub fn for_scheduled_job(job: &crate::scheduler::store::ScheduledJob) -> Self {
        let mut req = Self::new(
            ApprovalKind::ScheduledRun,
            format!("Scheduled run: {}", job.name),
            format!(
                "The automation \"{}\" is due and is configured to require approval before each run.",
                job.name
            ),
            Some(PendingAction::ScheduledJob {
                target: job.target.clone(),
            }),
        );
        req.source_ref = Some(job.id.clone());
        req.risk_tags = vec!["scheduled".to_owned()];
        if let crate::scheduler::store::JobTarget::Agent { agent_id, .. } = &job.target {
            req.agent_id = Some(agent_id.clone());
        }
        req
    }

    /// Build a request for a workflow suspended at an `Awakeable` gate.
    pub fn for_workflow_gate(run_id: &str, workflow_name: &str, prompt: Option<&str>) -> Self {
        let summary = prompt.map(|p| p.to_owned()).unwrap_or_else(|| {
            format!("Workflow \"{workflow_name}\" is paused, awaiting your approval to continue.")
        });
        let mut req = Self::new(
            ApprovalKind::WorkflowGate,
            format!("Workflow gate: {workflow_name}"),
            summary,
            Some(PendingAction::WorkflowResume {
                run_id: run_id.to_owned(),
            }),
        );
        req.source_ref = Some(run_id.to_owned());
        req.risk_tags = vec!["workflow".to_owned()];
        req
    }
}

/// Events fanned out to SSE subscribers.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApprovalEvent {
    Created { request: ApprovalRequest },
    Decided { request: ApprovalRequest },
}

/// The approval engine: owns the store and the decision/execution logic.
#[derive(Clone)]
pub struct ApprovalEngine {
    pub store: ApprovalStore,
    http: reqwest::Client,
    /// Borrowed from the monitors engine for push-token reuse (mobile push).
    /// Optional so the engine works headless / in tests with no monitors store.
    monitors: Option<crate::monitors::store::MonitorStore>,
}

impl ApprovalEngine {
    pub fn new(store: ApprovalStore, http: reqwest::Client) -> Self {
        Self {
            store,
            http,
            monitors: None,
        }
    }

    /// Attach the monitors store so approval notifications reuse its registered
    /// Expo push tokens (the mobile-push fan-out). Builder-style; no-op if unset.
    pub fn with_monitors(mut self, monitors: crate::monitors::store::MonitorStore) -> Self {
        self.monitors = Some(monitors);
        self
    }

    /// Raise a pending approval request (deferred, non-blocking). Persists +
    /// broadcasts (via the store) + fans out notifications. Returns the request.
    pub async fn request(&self, req: ApprovalRequest) -> anyhow::Result<ApprovalRequest> {
        self.store.insert(&req).await?;
        self.notify_created(&req).await;
        Ok(req)
    }

    /// Like [`request`](Self::request) but a no-op when a Pending request already
    /// exists for `source_ref` (prevents a scheduled job from piling up a fresh
    /// approval on every tick). Returns the new request, or `None` if deduped.
    pub async fn request_deduped(
        &self,
        req: ApprovalRequest,
    ) -> anyhow::Result<Option<ApprovalRequest>> {
        if let Some(src) = req.source_ref.as_deref() {
            if self.store.has_pending_for_source(src).await? {
                return Ok(None);
            }
        }
        Ok(Some(self.request(req).await?))
    }

    /// Decide a request. **Idempotent**: only a `Pending` request transitions, so
    /// a double-approve (or approve-after-expire) never re-runs the action. On
    /// approve the status is flipped *durably first*, then the action executes —
    /// so a crash mid-execute fails safe (the action is lost, never double-run).
    /// Returns the updated request, or `None` if no such id.
    pub async fn decide(
        &self,
        id: &str,
        approve: bool,
        note: Option<String>,
    ) -> anyhow::Result<Option<ApprovalRequest>> {
        let Some(mut req) = self.store.get(id).await? else {
            return Ok(None);
        };
        // Idempotency guard: anything already decided/expired is returned as-is.
        if req.status != ApprovalStatus::Pending {
            return Ok(Some(req));
        }
        req.status = if approve {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        req.note = note;
        req.decided_at = Some(chrono::Utc::now().to_rfc3339());

        // Reject teardown is quick (a file write) — do it inline so the row's
        // final state is settled before we return.
        if !approve {
            if let Some(action) = req.action.clone() {
                reject_action(&action).await;
            }
        }

        // Flip the status durably FIRST (idempotency + crash-safety: a crash now
        // leaves an Approved row whose action never ran — lost, never double-run).
        self.store.update(&req).await?;

        // Run the approved action in the background so the decide call (and the
        // HTTP approve handler) returns immediately rather than blocking for the
        // whole workflow/agent run. Any execution error is recorded back onto the
        // row + re-broadcast so the inbox shows it.
        if approve {
            if let Some(action) = req.action.clone() {
                let engine = self.clone();
                let id = req.id.clone();
                tokio::spawn(async move {
                    if let Err(e) = execute_action(&action).await {
                        let msg = format!("{e:#}");
                        tracing::warn!("approval {id}: action failed: {msg}");
                        engine.record_action_error(&id, msg).await;
                    }
                });
            }
        }

        Ok(Some(req))
    }

    /// Record that an approved action failed to execute, onto the row (so the
    /// inbox surfaces the failure). Best-effort: a missing row is ignored.
    async fn record_action_error(&self, id: &str, msg: String) {
        if let Ok(Some(mut req)) = self.store.get(id).await {
            req.error = Some(msg);
            let _ = self.store.update(&req).await;
        }
    }

    /// Cancel a pending request programmatically (e.g. its source run was deleted).
    pub async fn cancel(&self, id: &str) -> anyhow::Result<Option<ApprovalRequest>> {
        let Some(mut req) = self.store.get(id).await? else {
            return Ok(None);
        };
        if req.status != ApprovalStatus::Pending {
            return Ok(Some(req));
        }
        req.status = ApprovalStatus::Cancelled;
        req.decided_at = Some(chrono::Utc::now().to_rfc3339());
        self.store.update(&req).await?;
        Ok(Some(req))
    }

    /// Expire any pending requests past their `expires_at`. Called periodically by
    /// the background sweep. Returns the number expired.
    pub async fn sweep_expired(&self) -> anyhow::Result<usize> {
        let now = chrono::Utc::now().to_rfc3339();
        let stale = self.store.pending_expired(&now).await?;
        let mut n = 0;
        for mut req in stale {
            req.status = ApprovalStatus::Expired;
            req.decided_at = Some(now.clone());
            // A rejected/expired workflow gate must fail its run so it doesn't
            // hang suspended forever.
            if let Some(action) = req.action.clone() {
                reject_action(&action).await;
            }
            if self.store.update(&req).await.is_ok() {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Fan a freshly-created request out to mobile push (best-effort). The
    /// desktop/island surface it over SSE (handled by the store broadcast); this
    /// adds Expo push so a phone learns about a pending decision while away.
    async fn notify_created(&self, req: &ApprovalRequest) {
        let Some(monitors) = &self.monitors else {
            return;
        };
        let tokens = match monitors.push_tokens().await {
            Ok(t) if !t.is_empty() => t,
            _ => return,
        };
        let messages: Vec<_> = tokens
            .iter()
            .map(|t| {
                serde_json::json!({
                    "to": t,
                    "title": "Approval needed",
                    "body": req.title,
                    "sound": "default",
                    "data": { "approval_id": req.id, "kind": req.kind },
                })
            })
            .collect();
        let result = self
            .http
            .post("https://exp.host/--/api/v2/push/send")
            .json(&messages)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await;
        if let Err(e) = result {
            tracing::warn!("approvals: expo push notify failed: {e}");
        }
    }
}

/// Execute an approved action. Each arm proxies the existing engine the
/// corresponding source already uses, so an approved run is identical to the
/// autonomous run it replaced.
async fn execute_action(action: &PendingAction) -> anyhow::Result<()> {
    match action {
        PendingAction::ScheduledJob { target } => {
            crate::scheduler::run_target(target)
                .await
                .map_err(|e| anyhow::anyhow!(e))?;
            Ok(())
        }
        PendingAction::WorkflowResume { run_id } => {
            crate::workflow::resume_run(run_id, r#"{"approved":true}"#.to_owned())
                .await
                .map_err(|e| anyhow::anyhow!(e))?;
            Ok(())
        }
        PendingAction::TriggerWorkflow {
            workflow_id,
            payload_json,
        } => {
            crate::composio_triggers::run_workflow_for_trigger(workflow_id, payload_json).await?;
            Ok(())
        }
        PendingAction::TriggerAgent { agent_id, prompt } => {
            let run_id = format!("approvalrun_{}", uuid::Uuid::new_v4().simple());
            if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                runner
                    .run(Some(agent_id.clone()), run_id, prompt.clone())
                    .await?;
            }
            Ok(())
        }
    }
}

/// React to a rejected/expired action. Most kinds simply don't run; a workflow
/// gate, however, must fail its suspended run so it doesn't hang forever.
async fn reject_action(action: &PendingAction) {
    if let PendingAction::WorkflowResume { run_id } = action {
        if let Err(e) = crate::workflow::fail_run(run_id, "approval rejected by user").await {
            tracing::warn!("approvals: failed to fail rejected workflow run {run_id}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_req() -> ApprovalRequest {
        ApprovalRequest::new(
            ApprovalKind::TriggerRun,
            "test".to_owned(),
            "a test request".to_owned(),
            None,
        )
    }

    #[tokio::test]
    async fn request_then_list_pending() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        let req = engine.request(pending_req()).await.unwrap();
        let pending = engine
            .store
            .list(Some(ApprovalStatus::Pending))
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, req.id);
        assert_eq!(pending[0].status, ApprovalStatus::Pending);
    }

    #[tokio::test]
    async fn decide_is_idempotent() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        let req = engine.request(pending_req()).await.unwrap();

        // First reject transitions to Rejected.
        let r1 = engine
            .decide(&req.id, false, Some("no".to_owned()))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(r1.status, ApprovalStatus::Rejected);
        assert_eq!(r1.note.as_deref(), Some("no"));

        // Second decide (approve) must NOT flip it — already decided.
        let r2 = engine.decide(&req.id, true, None).await.unwrap().unwrap();
        assert_eq!(
            r2.status,
            ApprovalStatus::Rejected,
            "a decided request must not re-transition (idempotency)"
        );
    }

    #[tokio::test]
    async fn dedup_skips_second_pending_for_same_source() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        let mut a = pending_req();
        a.source_ref = Some("job-1".to_owned());
        let mut b = pending_req();
        b.source_ref = Some("job-1".to_owned());

        assert!(engine.request_deduped(a).await.unwrap().is_some());
        // Second pending for the same source is deduped away.
        assert!(engine.request_deduped(b).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn decide_unknown_id_returns_none() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        assert!(engine.decide("nope", true, None).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn cancel_pending_transitions_to_cancelled() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        let req = engine.request(pending_req()).await.unwrap();
        let c = engine.cancel(&req.id).await.unwrap().unwrap();
        assert_eq!(c.status, ApprovalStatus::Cancelled);
    }
}
