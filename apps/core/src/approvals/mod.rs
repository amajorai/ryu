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
pub mod tool_intent;

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
            question: None,
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

    /// Build a request for an APP that wants to post a turn on the user's behalf
    /// (the `chat.startTurn` kernel capability).
    ///
    /// The summary carries the app id and the message itself, truncated. Both are
    /// load-bearing: "an app wants to send a message" is not a decidable prompt —
    /// which app, and saying what, is the entire basis for approving or refusing.
    pub fn for_app_send(plugin_id: &str, text: &str, action: PendingAction) -> Self {
        /// How much of the message the inbox row shows. Long enough to recognise
        /// what is being sent, short enough not to turn the row into a transcript.
        const SUMMARY_CHARS: usize = 200;
        // Truncate on a CHAR boundary — `text` is arbitrary user input, and slicing
        // a multi-byte grapheme by byte index panics.
        let preview: String = if text.chars().count() > SUMMARY_CHARS {
            let head: String = text.chars().take(SUMMARY_CHARS).collect();
            format!("{head}…")
        } else {
            text.to_owned()
        };
        let mut req = Self::new(
            ApprovalKind::TriggerRun,
            format!("{plugin_id} wants to send a message as you"),
            format!(
                "The {plugin_id} app is asking to post this message to an agent on your behalf, \
                 which will spend usage on your account:\n\n{preview}"
            ),
            Some(action),
        );
        req.source_ref = Some(plugin_id.to_owned());
        req
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
        req.question = Some(format!("Can I run `{tool_id}` now?"));
        req.source_ref = Some(tool_id.to_owned());
        req.risk_tags = risk_tags;
        req
    }

    /// Replace the generic tool-call wording with what the call actually does
    /// (see [`tool_intent`]). Kind, source, tags and action are unchanged.
    pub fn apply_tool_intent(&mut self, intent: tool_intent::ToolIntent) {
        self.title = intent.title;
        self.question = Some(intent.question);
        self.summary = intent.summary;
    }

    /// Build a request for a scheduled job flagged `require_approval`.
    pub fn for_scheduled_job(job: &crate::scheduler::store::ScheduledJob) -> Self {
        let mut req = Self::new(
            ApprovalKind::ScheduledRun,
            format!("Scheduled run: {}", job.name),
            format!(
                "The automation \"{}\" is due. It will wait in your Inbox until you approve this run.",
                job.name
            ),
            Some(PendingAction::ScheduledJob {
                target: job.target.clone(),
                job_id: Some(job.id.clone()),
            }),
        );
        req.question = Some(match &job.target {
            // Name the app: an app job's name is the app's own text, so the app id
            // is what tells the user who is asking.
            crate::scheduler::store::JobTarget::AppJob { plugin_id, .. } => {
                format!("Run \"{}\" ({plugin_id}) now?", job.name)
            }
            _ => format!("Run \"{}\" now?", job.name),
        });
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
    /// The `auto` tag mirrors Hermes' `[auto]` origin marker (proposed by the
    /// learning loop rather than installed by hand); every synthesis — including
    /// a user-requested `force` synth — now flows through this gate, and the
    /// `skill_md` front-matter carries the precise provenance (source
    /// conversation/agent, requester, `origin: user-requested|auto`).
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

impl ApprovalEngine {
    pub fn new(store: ApprovalStore, http: reqwest::Client) -> Self {
        Self {
            store,
            http,
            push_store: None,
            registry: None,
            preferences: None,
            skills: None,
        }
    }

    /// Attach the kernel notify store so approval notifications reuse its
    /// registered Expo push tokens (the mobile-push fan-out). Builder-style;
    /// no-op if unset.
    pub fn with_push_store(mut self, push_store: crate::notify::NotifyStore) -> Self {
        self.push_store = Some(push_store);
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
    /// readable. Builder-style; without it the mode resolves to the fail-safe
    /// `Smart` default (only an explicit `off` pref disables Layer B).
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
    pub fn with_skills(mut self, skills: ryu_skills::SkillRegistry) -> Self {
        self.skills = Some(skills);
        self
    }

    /// The raw `approval-mode` preference value, if any. `None` = no preferences
    /// store attached or the key is unset; `Some("off")` = the explicit escape
    /// hatch. The CoreApi-mutation gate (Layer B′) needs to tell an unset pref
    /// from an explicit `off`, which the collapsed [`policy::ApprovalMode`] loses.
    pub async fn approval_mode_pref(&self) -> Option<String> {
        let prefs = self.preferences.as_ref()?;
        prefs.get(policy::APPROVAL_MODE_PREF).await.ok().flatten()
    }

    /// The current global approval mode (Layer B), read from the `approval-mode`
    /// preference. Resolves to the `Smart` default when unset or no preferences
    /// store attached; only an explicit `off` disables Layer B.
    pub async fn approval_mode(&self) -> policy::ApprovalMode {
        let raw = self.approval_mode_pref().await;
        policy::ApprovalMode::from_pref(raw.as_deref().unwrap_or_default())
    }

    /// Raise a pending approval request (deferred, non-blocking). Persists +
    /// broadcasts (via the store) + fans out notifications. Returns the request.
    pub async fn request(&self, req: ApprovalRequest) -> anyhow::Result<ApprovalRequest> {
        self.store.insert(&req).await?;
        // The push fan-out may wait on per-member permission lookups and on
        // Expo, so it runs beside the caller rather than delaying the request.
        if self.push_store.is_some() {
            let (engine, created) = (self.clone(), req.clone());
            tokio::spawn(async move { engine.notify_created(&created).await });
        }
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

    /// Delete decided requests older than [`APPROVAL_HISTORY_RETENTION_DAYS`].
    /// Called by the same background sweep as [`Self::sweep_expired`]; pending
    /// requests are never pruned. Returns the number removed.
    pub async fn prune_history(&self) -> anyhow::Result<usize> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(APPROVAL_HISTORY_RETENTION_DAYS);
        self.store.prune_decided_before(&cutoff.to_rfc3339()).await
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
    ///
    /// Every registered device is told that a decision is waiting, but only a
    /// device whose registering member may read the inbox (`approvals.view`
    /// under the node's binding, see [`approval_push_audience`]) gets the
    /// request's title and kind. Any other device, or a failed permission
    /// lookup, gets the content-free message.
    async fn notify_created(&self, req: &ApprovalRequest) {
        let Some(push_store) = &self.push_store else {
            return;
        };
        let tokens = match push_store.push_tokens_with_owners().await {
            Ok(t) if !t.is_empty() => t,
            _ => return,
        };
        let audience = approval_push_audience();
        let mut decided: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
        let mut messages = Vec::with_capacity(tokens.len());
        for (token, owner) in &tokens {
            let show = match (&audience, owner.as_deref()) {
                (ApprovalPushAudience::Members, Some(user)) => {
                    if let Some(known) = decided.get(user) {
                        *known
                    } else {
                        let allowed = member_may_view_approvals(&self.http, user).await;
                        decided.insert(user.to_owned(), allowed);
                        allowed
                    }
                }
                (audience, owner) => push_shows_approval_content(audience, owner),
            };
            messages.push(approval_push_message(token, req, show));
        }
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

/// Which registered devices may receive an approval's content in a push,
/// mirroring how `approvals.view` is enforced on this node.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ApprovalPushAudience {
    /// Unbound, unmanaged node: any device registered with a verified user
    /// identity. A device registered without one (a node-token or paired
    /// client, owner `None`) is refused by the inbox here too.
    Unbound,
    /// Managed node with no organization binding: Core refuses every caller.
    Nobody,
    /// Personal node: only its owner's devices.
    Owner(Option<String>),
    /// Organization or team node: members whose effective permissions,
    /// resolved by the control plane, include `approvals.view`.
    Members,
}

fn approval_push_audience() -> ApprovalPushAudience {
    use crate::sidecar::control_plane as cp;
    if let Some(node) = cp::registered_node() {
        if node.scope == cp::NodeScope::Personal {
            return ApprovalPushAudience::Owner(node.owner_user_id);
        }
        return ApprovalPushAudience::Members;
    }
    if cp::registered_org().is_some() {
        return ApprovalPushAudience::Members;
    }
    if cp::is_managed_node() {
        return ApprovalPushAudience::Nobody;
    }
    ApprovalPushAudience::Unbound
}

/// The decision for every audience that needs no control-plane lookup.
///
/// A device registered without a user identity never qualifies, on any node,
/// unbound ones included. The approval routes refuse a caller with no verified
/// identity before any binding check (`require_permission` in
/// `server/approvals_api.rs`), so the generic rule that admits anonymous
/// callers on an unbound node does not apply to the inbox. A push must not
/// show what the inbox would refuse.
/// [`ApprovalPushAudience::Members`] is decided by
/// [`member_may_view_approvals`]; here it is `false`.
fn push_shows_approval_content(audience: &ApprovalPushAudience, owner: Option<&str>) -> bool {
    match (audience, owner) {
        (_, None) => false,
        (ApprovalPushAudience::Unbound, Some(_)) => true,
        (ApprovalPushAudience::Owner(node_owner), Some(user)) => {
            node_owner.as_deref() == Some(user)
        }
        (ApprovalPushAudience::Nobody | ApprovalPushAudience::Members, Some(_)) => false,
    }
}

/// Whether the control plane grants `user` `approvals.view` on this node's
/// organization (and team, for a team node). The answer includes the member's
/// built-in role tier. An outage or a refusal is `false`.
async fn member_may_view_approvals(http: &reqwest::Client, user: &str) -> bool {
    crate::sidecar::control_plane::try_resolve_permission_context(http, user)
        .await
        .is_ok_and(|resolved| {
            resolved
                .permissions
                .contains(crate::identity_verify::permissions::APPROVALS_VIEW)
        })
}

/// One Expo push message for a new approval. Without `show_content` it says
/// only that a decision is waiting, plus the opaque request id the app opens
/// through the permission-checked inbox.
fn approval_push_message(
    token: &str,
    req: &ApprovalRequest,
    show_content: bool,
) -> serde_json::Value {
    if show_content {
        serde_json::json!({
            "to": token,
            "title": "Approval needed",
            "body": req.title,
            "sound": "default",
            "data": { "approval_id": req.id, "kind": req.kind },
        })
    } else {
        serde_json::json!({
            "to": token,
            "title": "Approval needed",
            "body": "A request is waiting for a decision. Open Ryu to review it.",
            "sound": "default",
            "data": { "approval_id": req.id },
        })
    }
}

impl ApprovalEngine {
    /// Execute an approved action. Each arm proxies the existing engine the
    /// corresponding source already uses, so an approved run is identical to the
    /// autonomous run it replaced. Returns `Some(result)` for a tool call (the
    /// tool's output, recorded onto the row for the inbox), `None` otherwise.
    async fn execute_action(&self, action: &PendingAction) -> anyhow::Result<Option<String>> {
        match action {
            PendingAction::ScheduledJob { target, job_id } => {
                if let Some(job_id) = job_id {
                    let job = crate::scheduler::store::load_job(job_id).map_err(|_| {
                        anyhow::anyhow!("scheduled routine '{job_id}' no longer exists")
                    })?;
                    if &job.target != target {
                        return Err(anyhow::anyhow!(
                            "scheduled routine '{job_id}' target changed since approval; request a new approval"
                        ));
                    }
                    // An approved app job waits for the same budget slot a scheduled
                    // run needs, so it never overlaps one of the same job.
                    let _budget_slot = crate::scheduler::admit_manual_run_waiting(
                        &job.id,
                        &job.target,
                        crate::scheduler::APPROVED_RUN_SLOT_WAIT,
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!(error))?;
                    // Never overlap a scheduled firing or a manual run of this job
                    // (any target, not only the budgeted app-backed ones).
                    let _in_flight =
                        crate::scheduler::claim_in_flight(&job.id).ok_or_else(|| {
                            anyhow::anyhow!("scheduled routine '{job_id}' is already running")
                        })?;
                    let claim = crate::scheduler::store::capture_execution(&job)
                        .await
                        .map_err(|error| {
                            anyhow::anyhow!("scheduled routine changed before execution: {error}")
                        })?;
                    let started_at = chrono::Utc::now().to_rfc3339();
                    let result = crate::scheduler::run_target_for_job(&job).await;
                    let finished_at = chrono::Utc::now().to_rfc3339();
                    let (outcome, run_id, error) = match result {
                        Ok(run_id) => (crate::scheduler::store::ExecOutcome::Success, run_id, None),
                        Err(error) => (
                            crate::scheduler::store::ExecOutcome::Failure,
                            None,
                            Some(error),
                        ),
                    };
                    crate::scheduler::store::append_execution_claim(
                        claim,
                        crate::scheduler::store::ExecRecord {
                            started_at,
                            finished_at,
                            outcome,
                            run_id,
                            error: error.clone(),
                        },
                    )
                    .await
                    .map_err(|save_error| {
                        anyhow::anyhow!("saving scheduled routine history: {save_error}")
                    })?;
                    if let Some(error) = error {
                        return Err(anyhow::anyhow!(error));
                    }
                } else {
                    // Backward compatibility for approvals persisted before the
                    // source job id was added. Budgeted under the job that now holds
                    // this target, when one does.
                    let budgeted = matches!(
                        target,
                        crate::scheduler::store::JobTarget::AppJob { .. }
                            | crate::scheduler::store::JobTarget::Quest { .. }
                    );
                    let budget_id = budgeted
                        .then(|| {
                            crate::scheduler::store::list_jobs()
                                .into_iter()
                                .find(|job| &job.target == target)
                        })
                        .flatten()
                        .map_or_else(
                            || format!("approval:{}", uuid::Uuid::new_v4().simple()),
                            |job| job.id,
                        );
                    let _budget_slot = crate::scheduler::admit_manual_run_waiting(
                        &budget_id,
                        target,
                        crate::scheduler::APPROVED_RUN_SLOT_WAIT,
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!(error))?;
                    crate::scheduler::run_target(target)
                        .await
                        .map_err(|e| anyhow::anyhow!(e))?;
                }
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
                crate::composio_host::run_workflow_for_trigger(workflow_id, payload_json).await?;
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
                // so a heal-run that itself fails cannot trigger another heal. This
                // is the DEFAULT heal path (`healing.auto-decide` is off — propose,
                // the user disposes), so the prefix comes from the shared contract
                // and not a literal: the engine reading it back lives in a separate
                // binary, where a drift is an infinite heal loop, not a parse error.
                let run_id = format!(
                    "{}{}",
                    ryu_healing_contracts::HEAL_PREFIX,
                    uuid::Uuid::new_v4().simple()
                );
                if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                    runner.run(agent_id.clone(), run_id, prompt.clone()).await?;
                }
                Ok(None)
            }
            PendingAction::AppSendTurn { .. } => {
                execute_app_send_turn(action).await?;
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
                ryu_learning::write_synthesized_skill(slug, skill_md)
                    .await
                    .map_err(|e| anyhow::anyhow!("writing approved skill `{slug}`: {e}"))?;
                ryu_skills::set_active(slug, true);
                skills.reload();
                Ok(Some(format!("Added the skill \"{slug}\" to your library.")))
            }
            PendingAction::ToolCall {
                tool_id,
                arguments,
                agent_id,
                allowlist,
                user_id,
                profile_ids,
                session_id,
                host_conversation_id,
                composio_connection_scope,
                conversation_scope,
                configure_approved,
            } => {
                let registry = self.registry.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("no MCP registry attached; cannot run approved tool call")
                })?;
                // Re-dispatch through the NO-GATE entry so the approved call runs
                // exactly once and does not re-raise an approval (infinite loop).
                let result = registry
                    .call_tool_with_identity_after_approval_scoped(
                        agent_id.as_deref(),
                        tool_id,
                        arguments.clone(),
                        allowlist.as_deref(),
                        user_id.as_deref(),
                        profile_ids,
                        session_id.clone(),
                        host_conversation_id.as_deref(),
                        composio_connection_scope.as_deref(),
                        conversation_scope.as_deref(),
                        *configure_approved,
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
/// Returns `None` when nothing gates the call (e.g. a non-risky tool under the
/// default `smart` mode, or an explicit operator `approval-mode=off`).
///
/// **Fail-closed:** if the approval cannot be persisted, this still returns
/// `Some(err)` so the risky action is NOT run when its required approval could
/// not be recorded.
///
/// `agent_approval_tools` is Layer A — the calling agent's configured
/// `approval_tools` list (pass `&[]` for agent-less callers). Composio tools are
/// NOT exempt: the connection flow is authentication, not approval, so a risky
/// `composio.*` action (send/delete/pay across 250+ SaaS apps) gates like any
/// other tool; only its connect/consent elicitation runs ungated (that path
/// returns an `__ryu_elicitation__` envelope instead of executing).
#[allow(clippy::too_many_arguments)]
/// Run an app-requested turn, persisted into a conversation the user can open.
///
/// A free function, and the ONE implementation of an app send: both the
/// approval-gated path (via [`ApprovalEngine::execute_action`]) and the
/// gate-off path in `server::host_chat` call exactly this, so an approved send and
/// an unattended one cannot drift into behaving differently.
///
/// `run_worker` rather than `run` because it is the `persist = true` primitive —
/// both the user instruction and the reply are written to history. `isolate =
/// false` and no `cwd`: a message the user asked to be sent belongs in an ordinary
/// conversation, not in a coordinator's throwaway git worktree.
pub async fn execute_app_send_turn(action: &PendingAction) -> anyhow::Result<()> {
    let PendingAction::AppSendTurn {
        agent_id,
        conversation_id,
        cwd,
        text,
        ..
    } = action
    else {
        return Err(anyhow::anyhow!("not an app send"));
    };
    let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() else {
        // No runner ⇒ nothing can answer. Reported rather than swallowed: the
        // caller marked a queued message as dispatched on the strength of this.
        return Err(anyhow::anyhow!(
            "no agent runner is published on this node; the message was not sent"
        ));
    };
    runner
        .run_worker(
            agent_id.clone(),
            conversation_id.clone(),
            text.clone(),
            cwd.clone(),
            false,
        )
        .await
        .map(|_reply| ())
}

pub async fn gate_tool_call(
    policy_tool_id: &str,
    dispatch_tool_id: &str,
    arguments: &serde_json::Value,
    agent_id: Option<&str>,
    agent_approval_tools: &[String],
    allowlist: Option<&[String]>,
    user_id: Option<&str>,
    profile_ids: &[String],
    session_id: Option<String>,
    host_conversation_id: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    configure_approved: bool,
    chat_grants_honored: bool,
) -> Option<anyhow::Error> {
    let engine = global_engine()?;
    gate_tool_call_with_engine(
        engine,
        policy_tool_id,
        dispatch_tool_id,
        arguments,
        agent_id,
        agent_approval_tools,
        allowlist,
        user_id,
        profile_ids,
        session_id,
        host_conversation_id,
        composio_connection_scope,
        conversation_scope,
        configure_approved,
        chat_grants_honored,
    )
    .await
}

/// `chat_grants_honored` is `false` for a call the exfiltration guard holds
/// ([`exfiltration_guard`]): an in-chat "Allow" was given for the tool, not for
/// sending out data a program read, so such a call always goes to the inbox.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn gate_tool_call_with_engine(
    engine: &ApprovalEngine,
    policy_tool_id: &str,
    dispatch_tool_id: &str,
    arguments: &serde_json::Value,
    agent_id: Option<&str>,
    agent_approval_tools: &[String],
    allowlist: Option<&[String]>,
    user_id: Option<&str>,
    profile_ids: &[String],
    session_id: Option<String>,
    host_conversation_id: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    configure_approved: bool,
    chat_grants_honored: bool,
) -> Option<anyhow::Error> {
    // Layer C: the organization's tool policy is consulted first. A denial is
    // final and is never queued, so approving cannot override the admin.
    let org_policy = crate::org_policy::current();
    if let Some(reason) = policy::org_policy_denial(
        org_policy.as_deref().map(|snapshot| &snapshot.rules),
        policy_tool_id,
    ) {
        crate::org_policy::record_denial("org_policy.tool_denied", dispatch_tool_id, &reason);
        return Some(anyhow::anyhow!(
            "This action (`{dispatch_tool_id}`) was not run: {reason}. It cannot be approved locally; ask an organization admin to change the tool policy."
        ));
    }
    let raw_pref = engine.approval_mode_pref().await;
    let mode = policy::ApprovalMode::from_pref(raw_pref.as_deref().unwrap_or_default());
    let tags = policy::should_require_approval_local(
        agent_approval_tools,
        policy_tool_id,
        mode,
        raw_pref.as_deref(),
    )?;
    // The user already allowed this exact call (or this tool for the whole
    // conversation) in the chat that raised it. See `chat_grants`.
    if chat_grants_honored
        && host_conversation_id.is_some_and(|conversation_id| {
            chat_grants::take(conversation_id, policy_tool_id, arguments)
        })
    {
        return None;
    }

    let action = PendingAction::ToolCall {
        tool_id: dispatch_tool_id.to_owned(),
        arguments: arguments.clone(),
        agent_id: agent_id.map(str::to_owned),
        allowlist: allowlist.map(<[String]>::to_vec),
        user_id: user_id.map(str::to_owned),
        profile_ids: profile_ids.to_vec(),
        session_id,
        host_conversation_id: host_conversation_id.map(str::to_owned),
        composio_connection_scope: composio_connection_scope
            .map(<[crate::sidecar::adapters::ComposioConnectionBinding]>::to_vec),
        conversation_scope: conversation_scope.map(<[String]>::to_vec),
        configure_approved,
    };
    let mut req = ApprovalRequest::for_tool_call(dispatch_tool_id, tags, action);
    if let Some(intent) = tool_intent::resolve(policy_tool_id, arguments, agent_id).await {
        req.apply_tool_intent(intent);
    }
    match engine.request(req).await {
        Ok(created) => Some(anyhow::anyhow!(
            "This action (`{dispatch_tool_id}`) requires your approval before it runs. It has been queued in your Approvals inbox (id {}) and will run once you approve it.",
            created.id
        )),
        // Fail CLOSED: could not queue the approval ⇒ do NOT run the tool.
        Err(e) => Some(anyhow::anyhow!(
            "This action (`{dispatch_tool_id}`) requires approval, but the approval could not be queued ({e}); it was not run."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn configuration_approval_preserves_alias_scope_and_executes_only_after_decision() {
        let directory = tempfile::tempdir().unwrap();
        let preferences = crate::server::preferences::PreferencesStore::open(
            directory.path().join("preferences.db"),
        )
        .unwrap();
        preferences
            .set(policy::APPROVAL_MODE_PREF, "off")
            .await
            .unwrap();
        let agents = crate::agents::AgentStore::open_in_memory(
            &crate::sidecar::adapters::AcpAgentRegistry::new(),
        )
        .unwrap();
        let target = agents
            .create(crate::agents::CreateAgent {
                name: "Original".to_owned(),
                ..Default::default()
            })
            .await
            .unwrap();
        let registry = crate::sidecar::mcp::McpRegistry::empty().with_agent_store(agents.clone());
        let alias = "app.agent_builder.configure_agent";
        registry.register_app_tool(
            alias.to_owned(),
            "agent_builder.configure_agent".to_owned(),
            None,
        );
        let registry = std::sync::Arc::new(registry);
        let arguments = serde_json::json!({"agent_id": target.id, "name": "Changed"});
        let allowlist = vec![alias.to_owned()];
        // Inbox approval cannot manufacture a calling-agent identity or the
        // configuration grant obtained separately by the interactive bridge.
        for (caller, granted, expected) in [
            (
                None,
                true,
                "tool 'agent_builder.configure_agent' requires a verified calling agent",
            ),
            (
                Some("ryu"),
                false,
                "agent_builder.configure_agent requires interactive permission",
            ),
        ] {
            let error = registry
                .call_tool_with_identity_after_approval_scoped(
                    caller,
                    alias,
                    arguments.clone(),
                    Some(&allowlist),
                    None,
                    &[],
                    None,
                    None,
                    None,
                    None,
                    granted,
                )
                .await
                .expect_err("approval replay must retain configuration authorization");
            assert_eq!(error.to_string(), expected);
            assert_eq!(
                agents.get(&target.id).await.unwrap().unwrap().name,
                "Original"
            );
        }
        let approvals = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(approvals.clone(), reqwest::Client::new())
            .with_preferences(preferences)
            .with_registry(registry);
        assert!(gate_tool_call_with_engine(
            &engine,
            crate::runnable::agent_configuration_policy::TOOL_ID,
            alias,
            &arguments,
            Some("ryu"),
            &[],
            Some(&allowlist),
            None,
            &[],
            None,
            None,
            None,
            None,
            true,
            true
        )
        .await
        .is_some());
        assert_eq!(
            agents.get(&target.id).await.unwrap().unwrap().name,
            "Original"
        );
        let pending = approvals.list(Some(ApprovalStatus::Pending)).await.unwrap();
        assert_eq!(pending.len(), 1);
        let Some(PendingAction::ToolCall {
            tool_id,
            arguments: captured,
            allowlist: captured_allowlist,
            agent_id: captured_agent,
            configure_approved: captured_grant,
            ..
        }) = pending[0].action.as_ref()
        else {
            panic!("configuration must queue the actual tool action")
        };
        assert_eq!(tool_id, alias);
        assert_eq!(captured, &arguments);
        assert_eq!(captured_allowlist.as_ref(), Some(&allowlist));
        assert_eq!(captured_agent.as_deref(), Some("ryu"));
        assert!(*captured_grant);
        engine.decide(&pending[0].id, true, None).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if agents.get(&target.id).await.unwrap().unwrap().name == "Changed" {
                    break;
                }
                if let Some(row) = approvals.get(&pending[0].id).await.unwrap() {
                    assert!(
                        row.error.is_none(),
                        "approved alias failed: {:?}",
                        row.error
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("approved configuration must execute");
        engine.decide(&pending[0].id, true, None).await.unwrap();
        assert_eq!(
            agents.get(&target.id).await.unwrap().unwrap().name,
            "Changed"
        );
    }

    #[tokio::test]
    async fn gated_agent_inbox_send_card_names_recipients_and_subject() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        let arguments = serde_json::json!({
            "to": ["buyer@example.com"],
            "subject": "Your quote",
            "text": "Attached.",
        });
        let refusal = gate_tool_call_with_engine(
            &engine,
            "agent_inbox.send",
            "agent_inbox.send",
            &arguments,
            None,
            &[],
            None,
            None,
            &[],
            None,
            None,
            None,
            None,
            false,
            true,
        )
        .await;
        assert!(
            refusal.is_some(),
            "agent_inbox.send must gate in smart mode"
        );
        let pending = engine
            .store
            .list(Some(ApprovalStatus::Pending))
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].question.as_deref(),
            Some("Send \"Your quote\" to buyer@example.com?")
        );
        assert!(pending[0].summary.contains("Subject: Your quote"));
        assert_eq!(pending[0].source_ref.as_deref(), Some("agent_inbox.send"));
    }

    fn pending_req() -> ApprovalRequest {
        ApprovalRequest::new(
            ApprovalKind::TriggerRun,
            "test".to_owned(),
            "a test request".to_owned(),
            None,
        )
    }

    /// A push reveals an approval's title only to a device whose registering
    /// member may read the inbox on this node.
    #[test]
    fn approval_push_content_follows_the_inbox_permission() {
        use ApprovalPushAudience::{Members, Nobody, Owner, Unbound};

        // Anonymous registrations never see content.
        for audience in [Unbound, Nobody, Members, Owner(Some("alice".to_owned()))] {
            assert!(
                !push_shows_approval_content(&audience, None),
                "{audience:?}"
            );
        }
        assert!(push_shows_approval_content(&Unbound, Some("alice")));
        assert!(!push_shows_approval_content(&Nobody, Some("alice")));
        let personal = Owner(Some("alice".to_owned()));
        assert!(push_shows_approval_content(&personal, Some("alice")));
        assert!(!push_shows_approval_content(&personal, Some("bob")));
        assert!(!push_shows_approval_content(&Owner(None), Some("alice")));
        // Organization nodes need the control-plane lookup, never a default yes.
        assert!(!push_shows_approval_content(&Members, Some("alice")));
    }

    /// On an unbound node the push rule for a device registered without a user
    /// identity matches what the inbox answers that same caller. The inbox
    /// refuses it, so the push carries no title; if the inbox ever admits such
    /// callers, this fails and the push rule must follow.
    #[tokio::test]
    async fn unbound_anonymous_push_matches_the_inbox_answer() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(dir.path());
        let inbox_admits =
            crate::server::approvals_api::caller_may_view_approvals(&state, &None).await;
        assert!(
            !inbox_admits,
            "the approval inbox refuses anonymous callers"
        );
        assert_eq!(
            push_shows_approval_content(&ApprovalPushAudience::Unbound, None),
            inbox_admits
        );
        // A verified user on the same unbound node keeps the title.
        assert!(push_shows_approval_content(
            &ApprovalPushAudience::Unbound,
            Some("alice")
        ));
    }

    /// The content-free message is what an unbound node sends an anonymous
    /// registration, and what an org-bound node sends a member without
    /// `approvals.view`.
    #[test]
    fn approval_push_message_follows_the_audience_decision() {
        let mut req = pending_req();
        req.title = "Delete production database".to_owned();
        for (audience, owner) in [
            (ApprovalPushAudience::Unbound, None),
            (ApprovalPushAudience::Members, Some("bob")),
            (ApprovalPushAudience::Nobody, Some("bob")),
        ] {
            let show = push_shows_approval_content(&audience, owner);
            let message = approval_push_message("tok", &req, show);
            assert!(
                !message.to_string().contains("production"),
                "{audience:?} {owner:?}"
            );
        }
        let show = push_shows_approval_content(&ApprovalPushAudience::Unbound, Some("alice"));
        assert_eq!(approval_push_message("tok", &req, show)["body"], req.title);
    }

    #[test]
    fn content_free_approval_push_omits_title_and_kind() {
        let mut req = pending_req();
        req.title = "Wire $40,000 to acct 1234".to_owned();
        let full = approval_push_message("tok", &req, true);
        assert_eq!(full["body"], req.title);
        assert!(full["data"].get("kind").is_some());

        let bare = approval_push_message("tok", &req, false);
        let text = bare.to_string();
        assert!(!text.contains("40,000"), "{text}");
        assert!(bare["data"].get("kind").is_none());
        assert_eq!(bare["data"]["approval_id"], req.id);
        assert_eq!(bare["to"], "tok");
    }

    #[tokio::test]
    async fn approval_mode_defaults_smart_without_preferences() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store, reqwest::Client::new());
        // Fail-safe: no preferences store ⇒ Smart, never Off.
        assert_eq!(engine.approval_mode().await, policy::ApprovalMode::Smart);
    }

    #[test]
    fn for_tool_call_carries_kind_source_and_action() {
        let action = PendingAction::ToolCall {
            tool_id: "gmail.send_email".to_owned(),
            arguments: serde_json::json!({ "to": "x" }),
            agent_id: None,
            allowlist: None,
            user_id: None,
            profile_ids: Vec::new(),
            session_id: None,
            host_conversation_id: None,
            composio_connection_scope: None,
            conversation_scope: None,
            configure_approved: false,
        };
        let req =
            ApprovalRequest::for_tool_call("gmail.send_email", vec!["send".to_owned()], action);
        assert_eq!(req.kind, ApprovalKind::ToolCall);
        assert_eq!(
            req.question.as_deref(),
            Some("Can I run `gmail.send_email` now?")
        );
        assert_eq!(req.source_ref.as_deref(), Some("gmail.send_email"));
        assert!(matches!(req.action, Some(PendingAction::ToolCall { .. })));
        assert!(req.risk_tags.iter().any(|t| t == "send"));
    }

    #[test]
    fn queued_configuration_permission_survives_serialization_and_legacy_defaults_to_denied() {
        let mut saved = serde_json::json!({
            "type": "tool_call",
            "tool_id": "agent_builder.configure_agent",
            "arguments": {"agent_id": "custom", "name": "Approved"},
            "configure_approved": true
        });
        let approved: PendingAction = serde_json::from_value(saved.clone()).unwrap();
        assert!(matches!(
            approved,
            PendingAction::ToolCall {
                configure_approved: true,
                ..
            }
        ));
        assert_eq!(
            serde_json::to_value(&approved).unwrap()["configure_approved"],
            true
        );

        saved.as_object_mut().unwrap().remove("configure_approved");
        let legacy: PendingAction = serde_json::from_value(saved).unwrap();
        assert!(matches!(
            legacy,
            PendingAction::ToolCall {
                configure_approved: false,
                ..
            }
        ));
    }

    #[test]
    fn for_scheduled_job_uses_inbox_language_and_dedup_key() {
        let job = crate::scheduler::store::ScheduledJob {
            id: "job-morning-digest".to_owned(),
            name: "Morning digest".to_owned(),
            schedule: crate::scheduler::store::Schedule::Every {
                interval: "1h".to_owned(),
            },
            target: crate::scheduler::store::JobTarget::Agent {
                agent_id: "ryu".to_owned(),
                prompt: "Summarize the inbox".to_owned(),
                model: None,
                conversation_id: None,
            },
            enabled: true,
            require_approval: true,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: "2026-08-20T00:00:00Z".to_owned(),
            updated_at: "2026-08-20T00:00:00Z".to_owned(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        };

        let req = ApprovalRequest::for_scheduled_job(&job);
        assert_eq!(req.kind, ApprovalKind::ScheduledRun);
        assert_eq!(req.question.as_deref(), Some("Run \"Morning digest\" now?"));
        assert!(req.summary.contains("Inbox"));
        assert_eq!(req.source_ref.as_deref(), Some("job-morning-digest"));
        assert_eq!(req.agent_id.as_deref(), Some("ryu"));
        assert!(req.risk_tags.iter().any(|tag| tag == "scheduled"));
        assert!(matches!(
            req.action,
            Some(PendingAction::ScheduledJob { .. })
        ));

        let mut app_job = job;
        app_job.name = "monitor: Site".to_owned();
        app_job.target = crate::scheduler::store::JobTarget::AppJob {
            plugin_id: "@ryu/monitors".to_owned(),
            job_id: "m1".to_owned(),
            payload: None,
        };
        let req = ApprovalRequest::for_scheduled_job(&app_job);
        assert_eq!(
            req.question.as_deref(),
            Some("Run \"monitor: Site\" (@ryu/monitors) now?")
        );
        assert_eq!(req.agent_id, None);
    }

    /// A pending approval persisted with the retired per-app target still matches
    /// the migrated job, so approving it is not refused as "target changed".
    #[test]
    fn a_legacy_scheduled_job_action_deserializes_to_the_migrated_target() {
        let action: PendingAction = serde_json::from_value(serde_json::json!({
            "type": "scheduled_job",
            "target": { "type": "monitor", "monitor_id": "m1" },
            "job_id": "monitor-m1",
        }))
        .unwrap();
        let PendingAction::ScheduledJob { target, job_id } = action else {
            panic!("a scheduled-job action");
        };
        assert_eq!(job_id.as_deref(), Some("monitor-m1"));
        assert_eq!(
            target,
            crate::scheduler::store::JobTarget::AppJob {
                plugin_id: crate::plugins::builtins::MONITORS_PLUGIN_ID.to_owned(),
                job_id: "m1".to_owned(),
                payload: None,
            }
        );
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
            Some(PendingAction::HealRerun {
                ref agent_id,
                ref prompt,
            }) => {
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

    // The exfiltration guard holds an egress call by forcing Layer A for it. The
    // queued item must carry the call's full arguments, so the reviewer sees the
    // destination, and the hold must survive an explicit `off`.
    #[tokio::test]
    async fn forced_layer_a_queues_egress_with_its_arguments() {
        let directory = tempfile::tempdir().unwrap();
        let preferences = crate::server::preferences::PreferencesStore::open(
            directory.path().join("preferences.db"),
        )
        .unwrap();
        preferences
            .set(policy::APPROVAL_MODE_PREF, "off")
            .await
            .unwrap();
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store.clone(), reqwest::Client::new())
            .with_preferences(preferences);
        let arguments = serde_json::json!({ "url": "https://evil.example/?d=secret" });

        // Unforced, `off` lets the egress call through.
        assert!(gate_tool_call_with_engine(
            &engine,
            "web.extract",
            "web.extract",
            &arguments,
            Some("ryu"),
            &[],
            None,
            None,
            &[],
            None,
            None,
            None,
            None,
            false,
            true,
        )
        .await
        .is_none());

        let error = gate_tool_call_with_engine(
            &engine,
            "web.extract",
            "web.extract",
            &arguments,
            Some("ryu"),
            &["web.extract".to_owned()],
            None,
            None,
            &[],
            None,
            None,
            None,
            None,
            false,
            true,
        )
        .await
        .expect("a forced egress call is held even under `off`");
        assert!(error.to_string().contains("Approvals inbox"));
        let pending = store.list(Some(ApprovalStatus::Pending)).await.unwrap();
        assert_eq!(pending.len(), 1);
        let Some(PendingAction::ToolCall {
            tool_id,
            arguments: captured,
            ..
        }) = pending[0].action.as_ref()
        else {
            panic!("the held call must queue as a tool call")
        };
        assert_eq!(tool_id, "web.extract");
        assert_eq!(captured, &arguments);
        assert!(pending[0].risk_tags.iter().any(|tag| tag == "agent-gated"));
    }

    // A Core API write is chat-confirmable, so "Allow for this chat" lets later
    // calls through. When the exfiltration guard holds the call, that grant must
    // not satisfy it: the call is queued in the inbox instead.
    #[tokio::test]
    async fn a_held_call_never_consumes_a_chat_grant() {
        let tool = "ryu_api.post_api_channels_run";
        let conversation = "exfiltration-guard-chat-grant-test";
        assert!(chat_grants::chat_confirmable(tool));
        chat_grants::grant_for_conversation(conversation, tool);
        let store = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(store.clone(), reqwest::Client::new());
        let arguments = serde_json::json!({ "body": { "text": "secret" } });
        let gate = |chat_grants_honored| {
            gate_tool_call_with_engine(
                &engine,
                tool,
                tool,
                &arguments,
                Some("ryu"),
                &[],
                None,
                None,
                &[],
                None,
                Some(conversation),
                None,
                None,
                false,
                chat_grants_honored,
            )
        };

        assert!(gate(true).await.is_none(), "the chat grant applies");
        let error = gate(false)
            .await
            .expect("a held call ignores the chat grant");
        assert!(error.to_string().contains("Approvals inbox"), "{error}");
        assert_eq!(
            store
                .list(Some(ApprovalStatus::Pending))
                .await
                .unwrap()
                .len(),
            1
        );
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

    // ── In-chat consent grants at the approval gate ─────────────────────────
    //
    // `chat_grants` is process-global, so every test keys its grants by a
    // conversation id nobody else uses. The engine is local (the global one is a
    // `OnceLock` that would gate every other test in this binary).

    const LAUNCH_TOOL: &str = "ryu_api.put_api_models_id_launch_config";
    const QUEUED_NOTICE: &str = "queued in your Approvals inbox";

    fn unique_conversation(prefix: &str) -> String {
        format!("{prefix}-{}", uuid::Uuid::new_v4())
    }

    struct GateFixture {
        engine: ApprovalEngine,
        approvals: ApprovalStore,
        preferences: crate::server::preferences::PreferencesStore,
        _directory: tempfile::TempDir,
    }

    impl GateFixture {
        async fn with_mode(mode: &str) -> Self {
            let directory = tempfile::tempdir().unwrap();
            let preferences = crate::server::preferences::PreferencesStore::open(
                directory.path().join("preferences.db"),
            )
            .unwrap();
            preferences
                .set(policy::APPROVAL_MODE_PREF, mode)
                .await
                .unwrap();
            let approvals = ApprovalStore::open_in_memory().unwrap();
            let engine = ApprovalEngine::new(approvals.clone(), reqwest::Client::new())
                .with_preferences(preferences.clone());
            Self {
                engine,
                approvals,
                preferences,
                _directory: directory,
            }
        }

        async fn gate(
            &self,
            tool_id: &str,
            arguments: &serde_json::Value,
            host_conversation_id: Option<&str>,
        ) -> Option<anyhow::Error> {
            gate_tool_call_with_engine(
                &self.engine,
                tool_id,
                tool_id,
                arguments,
                Some("ryu"),
                &[],
                None,
                None,
                &[],
                None,
                host_conversation_id,
                None,
                None,
                false,
                true,
            )
            .await
        }

        /// What the gate queued, as `(tool, arguments, host conversation)`, sorted.
        async fn queued(&self) -> Vec<(String, String, Option<String>)> {
            let mut rows = self
                .approvals
                .list(Some(ApprovalStatus::Pending))
                .await
                .unwrap()
                .into_iter()
                .map(|row| {
                    let Some(PendingAction::ToolCall {
                        tool_id,
                        arguments,
                        host_conversation_id,
                        ..
                    }) = row.action
                    else {
                        panic!("the gate only queues tool calls");
                    };
                    (tool_id, arguments.to_string(), host_conversation_id)
                })
                .collect::<Vec<_>>();
            rows.sort();
            rows
        }
    }

    fn expect_queued(outcome: Option<anyhow::Error>) {
        let error = outcome.expect("the gate must stop a call that has no grant");
        assert!(
            error.to_string().contains(QUEUED_NOTICE),
            "the refusal must say the call was queued: {error}"
        );
    }

    #[tokio::test]
    async fn an_allow_once_grant_passes_one_identical_call_and_queues_nothing() {
        let fixture = GateFixture::with_mode("smart").await;
        let conversation = unique_conversation("gate-once");
        let elsewhere = unique_conversation("gate-once-other");
        let granted = serde_json::json!({ "id": "llama", "body": { "ctx_size": 8192 } });
        let other_arguments = serde_json::json!({ "id": "llama", "body": { "ctx_size": 4096 } });
        chat_grants::grant_once(&conversation, LAUNCH_TOOL, &granted);

        // Anything that is not exactly the approved call is queued, and does not
        // burn the grant it did not match.
        expect_queued(
            fixture
                .gate(LAUNCH_TOOL, &other_arguments, Some(&conversation))
                .await,
        );
        expect_queued(fixture.gate(LAUNCH_TOOL, &granted, None).await);
        expect_queued(fixture.gate(LAUNCH_TOOL, &granted, Some(&elsewhere)).await);
        assert_eq!(fixture.queued().await.len(), 3);

        // The approved call goes through and queues nothing further.
        assert!(
            fixture
                .gate(LAUNCH_TOOL, &granted, Some(&conversation))
                .await
                .is_none(),
            "the exact call the user allowed in chat must not be queued again"
        );
        assert_eq!(fixture.queued().await.len(), 3);

        // The grant covered one call: its twin is queued like any other.
        expect_queued(
            fixture
                .gate(LAUNCH_TOOL, &granted, Some(&conversation))
                .await,
        );
        let mut expected = vec![
            (
                LAUNCH_TOOL.to_owned(),
                other_arguments.to_string(),
                Some(conversation.clone()),
            ),
            (LAUNCH_TOOL.to_owned(), granted.to_string(), None),
            (
                LAUNCH_TOOL.to_owned(),
                granted.to_string(),
                Some(elsewhere.clone()),
            ),
            (
                LAUNCH_TOOL.to_owned(),
                granted.to_string(),
                Some(conversation.clone()),
            ),
        ];
        expected.sort();
        assert_eq!(fixture.queued().await, expected);
    }

    #[tokio::test]
    async fn an_allow_session_grant_covers_every_argument_set_in_that_conversation_only() {
        let fixture = GateFixture::with_mode("smart").await;
        let conversation = unique_conversation("gate-session");
        let elsewhere = unique_conversation("gate-session-other");
        chat_grants::grant_for_conversation(&conversation, LAUNCH_TOOL);

        for context in [2048, 4096, 8192] {
            let arguments = serde_json::json!({ "id": "llama", "body": { "ctx_size": context } });
            assert!(
                fixture
                    .gate(LAUNCH_TOOL, &arguments, Some(&conversation))
                    .await
                    .is_none(),
                "a conversation grant is not consumed by the calls it covers"
            );
        }
        assert!(fixture.queued().await.is_empty());

        let arguments = serde_json::json!({ "id": "llama", "body": { "ctx_size": 2048 } });
        expect_queued(
            fixture
                .gate(LAUNCH_TOOL, &arguments, Some(&elsewhere))
                .await,
        );
        expect_queued(fixture.gate(LAUNCH_TOOL, &arguments, None).await);
        expect_queued(
            fixture
                .gate(
                    "ryu_api.put_api_preferences_key",
                    &serde_json::json!({ "key": "approval-mode", "body": { "value": "off" } }),
                    Some(&conversation),
                )
                .await,
        );
        assert_eq!(fixture.queued().await.len(), 3);
    }

    #[tokio::test]
    async fn chat_grants_cannot_open_the_gate_for_tools_the_chat_cannot_confirm() {
        let fixture = GateFixture::with_mode("smart").await;
        let conversation = unique_conversation("gate-unconfirmable");
        for tool in ["agent_builder.configure_agent", "research.run"] {
            let arguments = serde_json::json!({ "agent_id": "ryu" });
            chat_grants::grant_once(&conversation, tool, &arguments);
            chat_grants::grant_for_conversation(&conversation, tool);
            expect_queued(fixture.gate(tool, &arguments, Some(&conversation)).await);
        }
        assert_eq!(fixture.queued().await.len(), 2);
    }

    #[tokio::test]
    async fn changing_ryu_needs_a_grant_in_every_mode_including_explicit_off() {
        let fixture = GateFixture::with_mode("off").await;
        let conversation = unique_conversation("gate-off");
        let arguments = serde_json::json!({ "id": "llama", "body": { "ctx_size": 8192 } });
        for tool in [LAUNCH_TOOL, chat_grants::SWITCH_INTERFACE_TOOL_ID] {
            expect_queued(fixture.gate(tool, &arguments, Some(&conversation)).await);
        }
        assert_eq!(fixture.queued().await.len(), 2);

        // The in-chat "Allow once" is what lets the call through, under `off`
        // exactly as under `smart`.
        for tool in [LAUNCH_TOOL, chat_grants::SWITCH_INTERFACE_TOOL_ID] {
            chat_grants::grant_once(&conversation, tool, &arguments);
            assert!(
                fixture
                    .gate(tool, &arguments, Some(&conversation))
                    .await
                    .is_none(),
                "the person allowed {tool} in this chat"
            );
        }
        assert_eq!(fixture.queued().await.len(), 2);
    }
}

#[cfg(test)]
mod scheduler_execution_runtime_test;
