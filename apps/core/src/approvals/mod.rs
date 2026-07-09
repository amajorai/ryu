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

pub mod policy;
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
    /// A skill the continual-learning loop distilled from a conversation, awaiting
    /// the user's OK before it joins the active skill library.
    SkillSynthesis,
    /// A fix the self-healing loop proposed for a failed run, awaiting the user's
    /// OK before it re-runs (unless auto-decide is on). A terminal "attempts
    /// exhausted" review item is the same kind with no attached action.
    HealFix,
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
    /// Add a learning-synthesized skill to the library on approve. Carries the
    /// full validated `SKILL.md` so the write is deferred until approve — a
    /// rejected suggestion never touches the skill library.
    ActivateSkill { slug: String, skill_md: String },
    /// Re-run a failed run with the self-healing loop's corrected prompt on
    /// approve. Executes on a fresh `healrun_`-prefixed conversation (the
    /// never-heal-a-heal marker) via the same agent runner the original used.
    HealRerun {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        prompt: String,
    },
    /// Re-run a failed workflow from scratch on approve (self-healing). Carries the
    /// failed run's id; the workflow + inputs are re-derived from it and dispatched
    /// under a fresh `healrun_` run.
    HealWorkflowRerun { run_id: String },
    /// Execute a gated agent tool call on approve. Captures the full re-dispatch
    /// context so the approved run is identical to the one that was gated; run
    /// through the registry's no-gate entry so it never re-raises an approval.
    ToolCall {
        tool_id: String,
        arguments: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allowlist: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user_id: Option<String>,
        #[serde(default)]
        profile_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
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
    /// Populated with an approved tool call's output (bounded preview) so the
    /// inbox shows what running it returned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
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
            result: None,
            action,
            created_at: now,
            decided_at: None,
            expires_at: None,
        }
    }

    /// Build a request for a gated agent tool call (slice 2). `risk_tags` come
    /// from the policy classifier; `action` carries the re-dispatch context.
    pub fn for_tool_call(tool_id: &str, risk_tags: Vec<String>, action: PendingAction) -> Self {
        let mut req = Self::new(
            ApprovalKind::ToolCall,
            format!("Tool call: {tool_id}"),
            format!("An agent wants to run the tool `{tool_id}`, which is configured to require your approval before it executes."),
            Some(action),
        );
        req.source_ref = Some(tool_id.to_owned());
        req.risk_tags = risk_tags;
        req
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

    /// Build a request for a skill the continual-learning loop synthesized. The
    /// full validated `skill_md` rides in the action so approve materializes it
    /// and reject discards it — the library is untouched until the user says yes.
    /// The `auto` tag mirrors Hermes' `[auto]` origin marker (an autonomously
    /// proposed skill, not a user-requested one).
    pub fn for_skill_synthesis(
        slug: &str,
        name: &str,
        description: &str,
        conversation_id: &str,
        skill_md: String,
    ) -> Self {
        let summary = if description.is_empty() {
            format!(
                "Ryu distilled a reusable skill (\"{name}\") from one of your conversations. Approve to add it to your skill library so future chats can use it."
            )
        } else {
            format!(
                "{description}\n\nRyu distilled this reusable skill from one of your conversations. Approve to add it to your skill library."
            )
        };
        let mut req = Self::new(
            ApprovalKind::SkillSynthesis,
            format!("Learned skill: {name}"),
            summary,
            Some(PendingAction::ActivateSkill {
                slug: slug.to_owned(),
                skill_md,
            }),
        );
        // Dedup on the skill slug so re-synthesizing the same conversation can't
        // pile up duplicate pending suggestions for one skill.
        req.source_ref = Some(format!("skill:{slug}"));
        req.conversation_id = Some(conversation_id.to_owned());
        req.risk_tags = vec!["learning".to_owned(), "skill".to_owned(), "auto".to_owned()];
        req
    }

    /// Build a request for a self-healing fix: re-run a failed conversation with a
    /// corrected prompt. `diagnosis` is the LLM's read of why it failed (shown as
    /// the summary); the corrected prompt rides in the action so it only runs on
    /// approve. Deduped on the source conversation id so one failed run can't pile
    /// up duplicate heal requests.
    pub fn for_heal_fix(
        conversation_id: &str,
        agent_id: Option<String>,
        diagnosis: &str,
        corrected_prompt: String,
    ) -> Self {
        let mut req = Self::new(
            ApprovalKind::HealFix,
            "Auto-fix a failed run".to_owned(),
            format!(
                "A run failed and Ryu proposed a fix. Diagnosis: {diagnosis}\n\nApprove to re-run it with the corrected instruction."
            ),
            Some(PendingAction::HealRerun {
                agent_id: agent_id.clone(),
                prompt: corrected_prompt,
            }),
        );
        req.source_ref = Some(conversation_id.to_owned());
        req.conversation_id = Some(conversation_id.to_owned());
        req.agent_id = agent_id;
        req.risk_tags = vec!["heal".to_owned(), "auto".to_owned()];
        req
    }

    /// Build a request for a self-healing workflow fix: re-run a failed workflow
    /// from scratch. The `run_id` of the failed run rides in the action; the
    /// diagnosis is the summary. Deduped on the failed run id.
    pub fn for_heal_workflow(run_id: &str, diagnosis: &str) -> Self {
        let mut req = Self::new(
            ApprovalKind::HealFix,
            "Auto-fix a failed workflow".to_owned(),
            format!(
                "A workflow run failed and Ryu proposed a fix. Diagnosis: {diagnosis}\n\nApprove to re-run the workflow."
            ),
            Some(PendingAction::HealWorkflowRerun {
                run_id: run_id.to_owned(),
            }),
        );
        req.source_ref = Some(run_id.to_owned());
        req.risk_tags = vec!["heal".to_owned(), "workflow".to_owned(), "auto".to_owned()];
        req
    }

    /// Build a terminal "attempts exhausted" review item for a run the self-healing
    /// loop gave up on. Same kind as [`Self::for_heal_fix`] but with **no action** —
    /// it's a notice for manual review, never an auto-re-run.
    pub fn for_heal_exhausted(conversation_id: &str, note: &str) -> Self {
        let mut req = Self::new(
            ApprovalKind::HealFix,
            "A failing run needs your attention".to_owned(),
            format!("Ryu tried to auto-fix a failed run but gave up. {note}"),
            None,
        );
        req.source_ref = Some(format!("heal-exhausted:{conversation_id}"));
        req.conversation_id = Some(conversation_id.to_owned());
        req.risk_tags = vec!["heal".to_owned(), "exhausted".to_owned()];
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
    /// The MCP registry, used to *execute* an approved [`PendingAction::ToolCall`]
    /// on approve (re-dispatching through the no-gate entry so it doesn't re-gate).
    /// Optional so the engine works in tests without a registry.
    registry: Option<std::sync::Arc<crate::sidecar::mcp::McpRegistry>>,
    /// Preferences store, read for the global `approval-mode` (Layer B).
    preferences: Option<crate::server::preferences::PreferencesStore>,
    /// Skills registry (cloned — shares the inner `Arc`), used to *materialize* an
    /// approved [`PendingAction::ActivateSkill`]: write the deferred `SKILL.md`,
    /// flip it active, and hot-reload. Optional so the engine works in tests.
    skills: Option<crate::skills::SkillRegistry>,
}

impl ApprovalEngine {
    pub fn new(store: ApprovalStore, http: reqwest::Client) -> Self {
        Self {
            store,
            http,
            monitors: None,
            registry: None,
            preferences: None,
            skills: None,
        }
    }

    /// Attach the monitors store so approval notifications reuse its registered
    /// Expo push tokens (the mobile-push fan-out). Builder-style; no-op if unset.
    pub fn with_monitors(mut self, monitors: crate::monitors::store::MonitorStore) -> Self {
        self.monitors = Some(monitors);
        self
    }

    /// Attach the MCP registry so an approved tool call can be executed on
    /// approve. Builder-style; without it a `ToolCall` approval can't run.
    pub fn with_registry(
        mut self,
        registry: std::sync::Arc<crate::sidecar::mcp::McpRegistry>,
    ) -> Self {
        self.registry = Some(registry);
        self
    }

    /// Attach the preferences store so the global approval mode (Layer B) is
    /// readable. Builder-style; without it the mode resolves to `Off`.
    pub fn with_preferences(
        mut self,
        preferences: crate::server::preferences::PreferencesStore,
    ) -> Self {
        self.preferences = Some(preferences);
        self
    }

    /// Attach the skills registry so an approved learning-synthesized skill can be
    /// written + activated + hot-reloaded. Builder-style; without it an
    /// `ActivateSkill` approval fails with a clear error on approve.
    pub fn with_skills(mut self, skills: crate::skills::SkillRegistry) -> Self {
        self.skills = Some(skills);
        self
    }

    /// The current global approval mode (Layer B), read from the `approval-mode`
    /// preference. Resolves to `Off` when unset or no preferences store attached.
    pub async fn approval_mode(&self) -> policy::ApprovalMode {
        let Some(prefs) = &self.preferences else {
            return policy::ApprovalMode::Off;
        };
        let raw = prefs
            .get(policy::APPROVAL_MODE_PREF)
            .await
            .ok()
            .flatten()
            .unwrap_or_default();
        policy::ApprovalMode::from_pref(&raw)
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
        // Fast-path idempotency: anything already decided/expired is returned
        // as-is (the authoritative guard is the atomic CAS below).
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

        // ATOMIC compare-and-swap from Pending: exactly one of N concurrent
        // deciders wins. Only the winner runs side effects, so a double-approve
        // (double-click / phone+desktop) can never double-execute the action.
        // The status is flipped durably BEFORE the action runs (crash-safety: a
        // crash mid-execute leaves an Approved row whose action was lost, never
        // double-run).
        if !self.store.try_transition(&req).await? {
            // Someone else decided it first — return the current persisted state.
            return Ok(self.store.get(id).await?);
        }

        if approve {
            // Run the approved action in the background so the decide call (and the
            // HTTP approve handler) returns immediately rather than blocking for the
            // whole workflow/agent run. Success (a tool result) / failure is
            // recorded back onto the row + re-broadcast so the inbox shows it.
            if let Some(action) = req.action.clone() {
                let engine = self.clone();
                let id = req.id.clone();
                tokio::spawn(async move {
                    match engine.execute_action(&action).await {
                        Ok(Some(result)) => engine.record_action_result(&id, result).await,
                        Ok(None) => {}
                        Err(e) => {
                            let msg = format!("{e:#}");
                            tracing::warn!("approval {id}: action failed: {msg}");
                            engine.record_action_error(&id, msg).await;
                        }
                    }
                });
            }
        } else if let Some(action) = req.action.clone() {
            // Reject teardown (fail a suspended workflow gate). Only the winner
            // reaches here, so it runs exactly once.
            reject_action(&action).await;
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

    /// Record an approved action's result (a tool call's output) onto the row so
    /// the inbox shows what the approved call returned. Best-effort.
    async fn record_action_result(&self, id: &str, result: String) {
        if let Ok(Some(mut req)) = self.store.get(id).await {
            // Bound the stored preview so a large tool result can't bloat the row
            // (char-based so a multi-byte codepoint is never split).
            const MAX: usize = 4000;
            req.result = Some(if result.chars().count() > MAX {
                let mut s: String = result.chars().take(MAX).collect();
                s.push('…');
                s
            } else {
                result
            });
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
        // CAS so a cancel racing an approve can't both act.
        if !self.store.try_transition(&req).await? {
            return Ok(self.store.get(id).await?);
        }
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
            // CAS from Pending: only expire (and tear down) if we win the race
            // against a concurrent approve/reject — otherwise the decider owns it.
            if self.store.try_transition(&req).await.unwrap_or(false) {
                // A rejected/expired workflow gate must fail its run so it doesn't
                // hang suspended forever.
                if let Some(action) = req.action.clone() {
                    reject_action(&action).await;
                }
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

impl ApprovalEngine {
    /// Execute an approved action. Each arm proxies the existing engine the
    /// corresponding source already uses, so an approved run is identical to the
    /// autonomous run it replaced. Returns `Some(result)` for a tool call (the
    /// tool's output, recorded onto the row for the inbox), `None` otherwise.
    async fn execute_action(&self, action: &PendingAction) -> anyhow::Result<Option<String>> {
        match action {
            PendingAction::ScheduledJob { target } => {
                crate::scheduler::run_target(target)
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?;
                Ok(None)
            }
            PendingAction::WorkflowResume { run_id } => {
                crate::workflow::resume_run(run_id, r#"{"approved":true}"#.to_owned())
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?;
                Ok(None)
            }
            PendingAction::TriggerWorkflow {
                workflow_id,
                payload_json,
            } => {
                crate::composio_triggers::run_workflow_for_trigger(workflow_id, payload_json)
                    .await?;
                Ok(None)
            }
            PendingAction::TriggerAgent { agent_id, prompt } => {
                let run_id = format!("approvalrun_{}", uuid::Uuid::new_v4().simple());
                if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                    runner
                        .run(Some(agent_id.clone()), run_id, prompt.clone())
                        .await?;
                }
                Ok(None)
            }
            PendingAction::HealRerun { agent_id, prompt } => {
                // The `healrun_` prefix is the never-heal-a-heal marker: the heal
                // engine drops any failed event on a conversation with this prefix,
                // so a heal-run that itself fails cannot trigger another heal.
                let run_id = format!("healrun_{}", uuid::Uuid::new_v4().simple());
                if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                    runner.run(agent_id.clone(), run_id, prompt.clone()).await?;
                }
                Ok(None)
            }
            PendingAction::HealWorkflowRerun { run_id } => {
                crate::workflow::rerun_run(run_id)
                    .await
                    .map_err(|e| anyhow::anyhow!("re-running failed workflow {run_id}: {e}"))?;
                Ok(None)
            }
            PendingAction::ActivateSkill { slug, skill_md } => {
                let skills = self.skills.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("no skills registry attached; cannot activate approved skill")
                })?;
                // Deferred write happens now (on approve) so a rejected suggestion
                // never landed on disk. Then flip active + hot-reload the registry.
                crate::learning::write_synthesized_skill(slug, skill_md)
                    .await
                    .map_err(|e| anyhow::anyhow!("writing approved skill `{slug}`: {e}"))?;
                crate::skills::set_active(slug, true);
                skills.reload();
                Ok(Some(format!("Added the skill \"{slug}\" to your library.")))
            }
            PendingAction::ToolCall {
                tool_id,
                arguments,
                allowlist,
                user_id,
                profile_ids,
                session_id,
            } => {
                let registry = self.registry.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("no MCP registry attached; cannot run approved tool call")
                })?;
                // Re-dispatch through the NO-GATE entry so the approved call runs
                // exactly once and does not re-raise an approval (infinite loop).
                let result = registry
                    .call_tool_with_identity_no_gate(
                        tool_id,
                        arguments.clone(),
                        allowlist.as_deref(),
                        user_id.as_deref(),
                        profile_ids,
                        session_id.clone(),
                    )
                    .await?;
                // The no-gate path can still return an identity `__ryu_elicitation__`
                // envelope (a bound domain is NEEDS_AUTH). That is NOT a successful
                // run — the tool did not execute and no plane will consume the
                // envelope here — so surface it as an error on the row rather than a
                // false "result", telling the user the connection needs a login.
                if result.get("__ryu_elicitation__").is_some() {
                    return Err(anyhow::anyhow!(
                        "the approved tool `{tool_id}` needs an account connection that isn't logged in; connect it, then re-issue the request"
                    ));
                }
                Ok(Some(serde_json::to_string(&result).unwrap_or_default()))
            }
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

/// Layer-B approval gate at the tool-dispatch chokepoint. If the global approval
/// mode gates `tool_id`, mint a `ToolCall` approval capturing the full
/// re-dispatch context and return `Some(err)` — the caller returns that error
/// **instead of dispatching** the tool. Returning an error (not a plain
/// "pending" value) is deliberate: every plane treats a tool error as
/// not-done, so a gated call can never masquerade as a completed side effect
/// (a sandbox program's `await tool()` throws rather than silently continuing;
/// the chat/ACP model sees "approval required"). The engine runs the tool for
/// real on approve.
///
/// Returns `None` when nothing gates the call — the default `off` mode ⇒ every
/// call is `None` ⇒ zero behavior change.
///
/// **Fail-closed:** if the approval cannot be persisted, this still returns
/// `Some(err)` so the risky action is NOT run when its required approval could
/// not be recorded.
///
/// Layer A (per-agent `approval_tools`) is not fed here yet — the chokepoint has
/// no agent record — so this is Layer B only for now; the policy composes A too
/// once agent context is threaded.
pub async fn gate_tool_call(
    tool_id: &str,
    arguments: &serde_json::Value,
    allowlist: Option<&[String]>,
    user_id: Option<&str>,
    profile_ids: &[String],
    session_id: Option<String>,
) -> Option<anyhow::Error> {
    // Composio owns its own connection-required path; leave it to that flow.
    if tool_id.starts_with("composio__") {
        return None;
    }
    let engine = global_engine()?;
    let mode = engine.approval_mode().await;
    let tags = policy::should_require_approval_local(&[], tool_id, mode)?;

    let action = PendingAction::ToolCall {
        tool_id: tool_id.to_owned(),
        arguments: arguments.clone(),
        allowlist: allowlist.map(<[String]>::to_vec),
        user_id: user_id.map(str::to_owned),
        profile_ids: profile_ids.to_vec(),
        session_id,
    };
    let req = ApprovalRequest::for_tool_call(tool_id, tags, action);
    match engine.request(req).await {
        Ok(created) => Some(anyhow::anyhow!(
            "This action (`{tool_id}`) requires your approval before it runs. It has been queued in your Approvals inbox (id {}) and will run once you approve it.",
            created.id
        )),
        // Fail CLOSED: could not queue the approval ⇒ do NOT run the tool.
        Err(e) => Some(anyhow::anyhow!(
            "This action (`{tool_id}`) requires approval, but the approval could not be queued ({e}); it was not run."
        )),
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
    async fn approval_mode_defaults_off_without_preferences() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        assert_eq!(engine.approval_mode().await, policy::ApprovalMode::Off);
    }

    #[test]
    fn for_tool_call_carries_kind_source_and_action() {
        let action = PendingAction::ToolCall {
            tool_id: "gmail__send_email".to_owned(),
            arguments: serde_json::json!({ "to": "x" }),
            allowlist: None,
            user_id: None,
            profile_ids: Vec::new(),
            session_id: None,
        };
        let req =
            ApprovalRequest::for_tool_call("gmail__send_email", vec!["send".to_owned()], action);
        assert_eq!(req.kind, ApprovalKind::ToolCall);
        assert_eq!(req.source_ref.as_deref(), Some("gmail__send_email"));
        assert!(matches!(req.action, Some(PendingAction::ToolCall { .. })));
        assert!(req.risk_tags.iter().any(|t| t == "send"));
    }

    #[test]
    fn for_skill_synthesis_defers_write_and_dedups_on_slug() {
        let req = ApprovalRequest::for_skill_synthesis(
            "summarize-arxiv",
            "Summarize arXiv papers",
            "Fetch and condense a paper by id.",
            "conv_123",
            "---\nname: Summarize arXiv papers\n---\nsteps".to_owned(),
        );
        assert_eq!(req.kind, ApprovalKind::SkillSynthesis);
        // Dedup key is the slug so re-synthesis can't pile up duplicates.
        assert_eq!(req.source_ref.as_deref(), Some("skill:summarize-arxiv"));
        assert_eq!(req.conversation_id.as_deref(), Some("conv_123"));
        // The `auto` tag mirrors Hermes' `[auto]` origin marker.
        assert!(req.risk_tags.iter().any(|t| t == "auto"));
        // The full SKILL.md rides in the action so nothing is written until approve.
        match req.action {
            Some(PendingAction::ActivateSkill {
                ref slug,
                ref skill_md,
            }) => {
                assert_eq!(slug, "summarize-arxiv");
                assert!(skill_md.contains("Summarize arXiv papers"));
            }
            _ => panic!("expected an ActivateSkill action carrying the deferred skill"),
        }
    }

    #[test]
    fn for_heal_fix_defers_rerun_and_dedups_on_conversation() {
        let req = ApprovalRequest::for_heal_fix(
            "conv_42",
            Some("ryu".to_owned()),
            "the tool call used a bad path",
            "Retry, but read ./data/report.md with an absolute path.".to_owned(),
        );
        assert_eq!(req.kind, ApprovalKind::HealFix);
        // Dedup + correlation both key on the source conversation.
        assert_eq!(req.source_ref.as_deref(), Some("conv_42"));
        assert_eq!(req.conversation_id.as_deref(), Some("conv_42"));
        match req.action {
            Some(PendingAction::HealRerun { ref agent_id, ref prompt }) => {
                assert_eq!(agent_id.as_deref(), Some("ryu"));
                assert!(prompt.contains("absolute path"));
            }
            _ => panic!("expected a HealRerun action carrying the corrected prompt"),
        }
    }

    #[test]
    fn for_heal_workflow_carries_run_id_and_rerun_action() {
        let req = ApprovalRequest::for_heal_workflow("wfrun_9", "a step timed out");
        assert_eq!(req.kind, ApprovalKind::HealFix);
        assert_eq!(req.source_ref.as_deref(), Some("wfrun_9"));
        match req.action {
            Some(PendingAction::HealWorkflowRerun { ref run_id }) => {
                assert_eq!(run_id, "wfrun_9");
            }
            _ => panic!("expected a HealWorkflowRerun action"),
        }
        assert!(req.risk_tags.iter().any(|t| t == "workflow"));
    }

    #[test]
    fn for_heal_exhausted_has_no_action() {
        let req = ApprovalRequest::for_heal_exhausted("conv_42", "gave up after 2 tries");
        assert_eq!(req.kind, ApprovalKind::HealFix);
        // Terminal review item — never auto-runs anything.
        assert!(req.action.is_none());
        assert!(req.risk_tags.iter().any(|t| t == "exhausted"));
    }

    #[tokio::test]
    async fn activate_skill_without_registry_is_a_clear_error() {
        // Approving a skill-synthesis request with no skills registry attached must
        // fail loudly (recorded as the row's error), never silently swallow it.
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        let action = PendingAction::ActivateSkill {
            slug: "x".to_owned(),
            skill_md: "---\nname: X\n---\n".to_owned(),
        };
        let err = engine.execute_action(&action).await.unwrap_err();
        assert!(err.to_string().contains("no skills registry"));
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
    async fn try_transition_only_first_winner_succeeds() {
        // The CAS that prevents a concurrent double-approve from double-executing:
        // exactly one transition out of Pending reports success.
        let store = ApprovalStore::open_in_memory().unwrap();
        let mut req = pending_req();
        store.insert(&req).await.unwrap();

        req.status = ApprovalStatus::Approved;
        assert!(
            store.try_transition(&req).await.unwrap(),
            "first transition out of Pending must win"
        );

        let mut req2 = req.clone();
        req2.status = ApprovalStatus::Rejected;
        assert!(
            !store.try_transition(&req2).await.unwrap(),
            "second transition must lose (row is no longer Pending) — no double-execute"
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
