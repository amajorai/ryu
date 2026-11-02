//! Constructors and helpers of [`ApprovalRequest`], one per raising source.
//!
//! Each builder describes its wording as an [`ApprovalText`]: the English
//! rendering fills `title`/`question`/`summary`, and the messages ride along
//! as `i18n` so clients show the card in their reader's locale.

use super::text::{ApprovalText, Phrase, Summary};
use super::*;
use crate::i18n::messages;

impl ApprovalRequest {
    pub(super) fn new(
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
            i18n: None,
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

    /// A request whose wording is `text`.
    fn from_text(kind: ApprovalKind, text: ApprovalText, action: Option<PendingAction>) -> Self {
        let mut req = Self::new(kind, String::new(), String::new(), action);
        req.apply_text(text);
        req
    }

    /// Replace the wording: the English rendering plus the messages.
    pub fn apply_text(&mut self, text: ApprovalText) {
        let (title, question, summary) = text.render("en");
        self.title = title;
        self.question = question;
        self.summary = summary;
        self.i18n = Some(text.to_wire());
    }

    /// The title in `locale`: the messages when the row has them, else the
    /// stored English.
    pub fn localized_title(&self, locale: &str) -> String {
        self.i18n
            .as_ref()
            .and_then(|wire| wire.get("title"))
            .and_then(|title| super::text::render_wire_phrase(title, locale))
            .unwrap_or_else(|| self.title.clone())
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
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_APP_SEND_TITLE_MESSAGE).text("plugin", plugin_id),
            Summary::default()
                .phrase(
                    Phrase::new(messages::APPROVAL_APP_SEND_SUMMARY_MESSAGE)
                        .text("plugin", plugin_id),
                )
                .paragraph(preview)
                .build(),
        );
        let mut req = Self::from_text(ApprovalKind::TriggerRun, text, Some(action));
        req.source_ref = Some(plugin_id.to_owned());
        req
    }

    /// Build a request for a gated agent tool call (slice 2). `risk_tags` come
    /// from the policy classifier; `action` carries the re-dispatch context.
    pub fn for_tool_call(tool_id: &str, risk_tags: Vec<String>, action: PendingAction) -> Self {
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_CALL_TITLE_MESSAGE).text("tool", tool_id),
            Summary::default()
                .phrase(Phrase::new(messages::APPROVAL_CALL_SUMMARY_MESSAGE).text("tool", tool_id))
                .build(),
        )
        .with_question(Phrase::new(messages::APPROVAL_CALL_QUESTION_MESSAGE).text("tool", tool_id));
        let mut req = Self::from_text(ApprovalKind::ToolCall, text, Some(action));
        req.source_ref = Some(tool_id.to_owned());
        req.risk_tags = risk_tags;
        req
    }

    /// Replace the generic tool-call wording with what the call actually does
    /// (see [`tool_intent`]). Kind, source, tags and action are unchanged.
    pub fn apply_tool_intent(&mut self, intent: tool_intent::ToolIntent) {
        self.apply_text(intent.text);
    }

    /// Build a request for a scheduled job flagged `require_approval`.
    pub fn for_scheduled_job(job: &crate::scheduler::store::ScheduledJob) -> Self {
        let question = match &job.target {
            // Name the app: an app job's name is the app's own text, so the app id
            // is what tells the user who is asking.
            crate::scheduler::store::JobTarget::AppJob { plugin_id, .. } => {
                Phrase::new(messages::APPROVAL_SCHEDULED_APP_QUESTION_MESSAGE)
                    .text("job", &job.name)
                    .text("plugin", plugin_id)
            }
            _ => Phrase::new(messages::APPROVAL_SCHEDULED_QUESTION_MESSAGE).text("job", &job.name),
        };
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_SCHEDULED_TITLE_MESSAGE).text("job", &job.name),
            Summary::default()
                .phrase(
                    Phrase::new(messages::APPROVAL_SCHEDULED_SUMMARY_MESSAGE)
                        .text("job", &job.name),
                )
                .build(),
        )
        .with_question(question);
        let mut req = Self::from_text(
            ApprovalKind::ScheduledRun,
            text,
            Some(PendingAction::ScheduledJob {
                target: job.target.clone(),
                job_id: Some(job.id.clone()),
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
        // The workflow author's own prompt is shown as written.
        let summary = match prompt {
            Some(prompt) => Summary::default().raw(prompt),
            None => Summary::default().phrase(
                Phrase::new(messages::APPROVAL_WORKFLOW_GATE_SUMMARY_MESSAGE)
                    .text("workflow", workflow_name),
            ),
        };
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_WORKFLOW_GATE_TITLE_MESSAGE)
                .text("workflow", workflow_name),
            summary.build(),
        );
        let mut req = Self::from_text(
            ApprovalKind::WorkflowGate,
            text,
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
            Summary::default()
                .phrase(Phrase::new(messages::APPROVAL_SKILL_SUMMARY_MESSAGE).text("name", name))
        } else {
            Summary::default()
                .raw(description)
                .raw("\n\n")
                .phrase(Phrase::new(messages::APPROVAL_SKILL_NOTE_MESSAGE))
        };
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_SKILL_TITLE_MESSAGE).text("name", name),
            summary.build(),
        );
        let mut req = Self::from_text(
            ApprovalKind::SkillSynthesis,
            text,
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
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_HEAL_RUN_TITLE_MESSAGE),
            Summary::default()
                .phrase(
                    Phrase::new(messages::APPROVAL_HEAL_RUN_SUMMARY_MESSAGE)
                        .text("diagnosis", diagnosis),
                )
                .raw("\n\n")
                .phrase(Phrase::new(messages::APPROVAL_HEAL_RUN_APPROVE_MESSAGE))
                .build(),
        );
        let mut req = Self::from_text(
            ApprovalKind::HealFix,
            text,
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
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_HEAL_WORKFLOW_TITLE_MESSAGE),
            Summary::default()
                .phrase(
                    Phrase::new(messages::APPROVAL_HEAL_WORKFLOW_SUMMARY_MESSAGE)
                        .text("diagnosis", diagnosis),
                )
                .raw("\n\n")
                .phrase(Phrase::new(
                    messages::APPROVAL_HEAL_WORKFLOW_APPROVE_MESSAGE,
                ))
                .build(),
        );
        let mut req = Self::from_text(
            ApprovalKind::HealFix,
            text,
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
        Self::heal_exhausted(
            conversation_id,
            Phrase::new(messages::APPROVAL_HEAL_EXHAUSTED_SUMMARY_MESSAGE).text("note", note),
        )
    }

    /// [`Self::for_heal_exhausted`] from the number of auto-fix attempts the
    /// healer used, as one whole localizable summary (a newer healer sends the
    /// count; its English `note` is only for an older Core).
    pub fn for_heal_exhausted_after(conversation_id: &str, attempts: u32) -> Self {
        Self::heal_exhausted(
            conversation_id,
            Phrase::new(messages::APPROVAL_HEAL_EXHAUSTED_ATTEMPTS_SUMMARY_MESSAGE)
                .count("count", attempts as usize),
        )
    }

    fn heal_exhausted(conversation_id: &str, summary: Phrase) -> Self {
        let text = ApprovalText::new(
            Phrase::new(messages::APPROVAL_HEAL_EXHAUSTED_TITLE_MESSAGE),
            Summary::default().phrase(summary).build(),
        );
        let mut req = Self::from_text(ApprovalKind::HealFix, text, None);
        req.source_ref = Some(format!("heal-exhausted:{conversation_id}"));
        req.conversation_id = Some(conversation_id.to_owned());
        req.risk_tags = vec!["heal".to_owned(), "exhausted".to_owned()];
        req
    }
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod tests;
