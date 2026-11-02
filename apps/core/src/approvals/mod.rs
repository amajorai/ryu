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

pub mod chat_grants;
pub mod exfiltration_guard;
pub mod policy;
pub mod store;
pub mod text;
pub mod tool_intent;

mod engine;
mod execute;
mod gate;
mod push;
mod request;

use execute::reject_action;
#[cfg(test)]
pub(crate) use gate::gate_tool_call_with_engine;
pub use gate::{execute_app_send_turn, gate_tool_call};
#[cfg(test)]
use push::{approval_push_message, push_shows_approval_content, ApprovalPushAudience};

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

/// How long a decided (approved, rejected, expired or cancelled) request stays
/// in the inbox history before the background sweep deletes it.
pub const APPROVAL_HISTORY_RETENTION_DAYS: i64 = 90;

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
        /// New requests carry the source job id so approval execution updates
        /// that job's durable history instead of running an untracked copy.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        job_id: Option<String>,
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
    /// Post a turn on the user's behalf, requested by an APP through the
    /// `chat.startTurn` kernel capability (see `server::host_chat`).
    ///
    /// Unlike [`PendingAction::TriggerAgent`] directly above — which runs with
    /// `persist = false` and leaves no conversation — this writes a real thread the
    /// user can open, because "send this message for me" that produces nothing to
    /// read is not a send.
    ///
    /// `plugin_id` is carried for the inbox row and the audit trail: an approval
    /// that says only "a message will be sent" does not let anyone decide, and
    /// which app asked is the whole basis for deciding.
    AppSendTurn {
        plugin_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        conversation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// Execute a gated agent tool call on approve. Captures the full re-dispatch
    /// context so the approved run is identical to the one that was gated; run
    /// through the registry's no-gate entry so it never re-raises an approval.
    ToolCall {
        tool_id: String,
        arguments: serde_json::Value,
        /// The agent whose governed call created this approval. Keeping this
        /// identity across the queue prevents approval re-dispatch from
        /// bypassing lifecycle and safety checks.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allowlist: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user_id: Option<String>,
        #[serde(default)]
        profile_ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        /// The SERVER-DERIVED host conversation this gated tool call ran on behalf
        /// of. Carried across the approval so the re-dispatch resolves the SAME
        /// `ToolPrincipal` the original call would have — an approval must not
        /// silently widen (or narrow) what the tool can reach. `None` on an
        /// approval queued before this field existed ⇒ `Unresolved` ⇒ fail closed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host_conversation_id: Option<String>,
        /// Optional selected Composio accounts for a scoped profile run.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        composio_connection_scope: Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
        /// Optional conversation ids that a scoped profile run may search.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation_scope: Option<Vec<String>>,
        /// True only when the interactive Core bridge already obtained the
        /// dedicated permission for this exact configuration call. Persist it
        /// with a queued approval so the approved re-dispatch keeps that proof.
        #[serde(default)]
        configure_approved: bool,
    },
}

/// One queued approval request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub kind: ApprovalKind,
    /// Short human title ("Scheduled run: Morning digest").
    pub title: String,
    /// First-person question shown above the summary in an approval card.
    /// Optional for older/non-tool requests that do not have a tool intent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    /// One or two sentences describing what will run and why it is gated.
    pub summary: String,
    /// The title, question and summary as Core messages
    /// ([`text::ApprovalText::to_wire`]), so clients render them in the
    /// reader's locale. `title`/`question`/`summary` stay the English
    /// fallback; rows written before this field existed have none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n: Option<serde_json::Value>,
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
    /// Borrowed from the kernel notify store for push-token reuse (mobile push).
    /// Optional so the engine works headless / in tests with no notify store.
    push_store: Option<crate::notify::NotifyStore>,
    /// The MCP registry, used to *execute* an approved [`PendingAction::ToolCall`]
    /// on approve (re-dispatching through the no-gate entry so it doesn't re-gate).
    /// Optional so the engine works in tests without a registry.
    registry: Option<std::sync::Arc<crate::sidecar::mcp::McpRegistry>>,
    /// Preferences store, read for the global `approval-mode` (Layer B).
    preferences: Option<crate::server::preferences::PreferencesStore>,
    /// Skills registry (cloned — shares the inner `Arc`), used to *materialize* an
    /// approved [`PendingAction::ActivateSkill`]: write the deferred `SKILL.md`,
    /// flip it active, and hot-reload. Optional so the engine works in tests.
    skills: Option<ryu_skills::SkillRegistry>,
}

#[cfg(test)]
mod engine_test;
#[cfg(test)]
mod gate_test;

#[cfg(test)]
mod scheduler_execution_runtime_test;
