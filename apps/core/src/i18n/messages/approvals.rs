//! English sources for approval cards, questions and tool-intent labels.
//!
//! Same shape as the templates in [`super`]: each `*_MESSAGE` is a
//! [`Template`](crate::i18n::Template) built with `format!` and one named
//! argument per placeholder, written as a whole sentence. They are re-exported
//! from [`super`], so callers keep using `i18n::messages::NAME_MESSAGE`.
//!
//! Arguments are raw values (tool ids, job and workflow names, addresses,
//! subjects) and are never translated. The approval card composes these with
//! the agent's own text in `approvals::text`.
#![allow(clippy::useless_format)]

use super::Template;

// ---- app sends a message as the user ---------------------------------------

pub const APPROVAL_APP_SEND_TITLE_MESSAGE: Template = |arg| {
    format!(
        "{plugin} wants to send a message as you",
        plugin = arg("plugin")
    )
};
pub const APPROVAL_APP_SEND_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "The {plugin} app is asking to post the message below to an agent on your behalf, which will spend usage on your account.",
        plugin = arg("plugin")
    )
};

// ---- gated tool call (generic card) -----------------------------------------

pub const APPROVAL_CALL_TITLE_MESSAGE: Template =
    |arg| format!("Tool call: {tool}", tool = arg("tool"));
pub const APPROVAL_CALL_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "An agent wants to run the tool \"{tool}\", which is configured to require your approval before it executes.",
        tool = arg("tool")
    )
};
pub const APPROVAL_CALL_QUESTION_MESSAGE: Template =
    |arg| format!("Can I run \"{tool}\" now?", tool = arg("tool"));

// ---- scheduled job -----------------------------------------------------------

pub const APPROVAL_SCHEDULED_TITLE_MESSAGE: Template =
    |arg| format!("Scheduled run: {job}", job = arg("job"));
pub const APPROVAL_SCHEDULED_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "The automation \"{job}\" is due. It will wait in your Inbox until you approve this run.",
        job = arg("job")
    )
};
pub const APPROVAL_SCHEDULED_QUESTION_MESSAGE: Template =
    |arg| format!("Run \"{job}\" now?", job = arg("job"));
pub const APPROVAL_SCHEDULED_APP_QUESTION_MESSAGE: Template = |arg| {
    format!(
        "Run \"{job}\" ({plugin}) now?",
        job = arg("job"),
        plugin = arg("plugin")
    )
};

// ---- workflow gate -----------------------------------------------------------

pub const APPROVAL_WORKFLOW_GATE_TITLE_MESSAGE: Template =
    |arg| format!("Workflow gate: {workflow}", workflow = arg("workflow"));
pub const APPROVAL_WORKFLOW_GATE_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "Workflow \"{workflow}\" is paused, awaiting your approval to continue.",
        workflow = arg("workflow")
    )
};

// ---- learned skill -----------------------------------------------------------

pub const APPROVAL_SKILL_TITLE_MESSAGE: Template =
    |arg| format!("Learned skill: {name}", name = arg("name"));
pub const APPROVAL_SKILL_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "Ryu distilled a reusable skill (\"{name}\") from one of your conversations. Approve to add it to your skill library so future chats can use it.",
        name = arg("name")
    )
};
pub const APPROVAL_SKILL_NOTE_MESSAGE: Template = |_| {
    format!(
        "Ryu distilled this reusable skill from one of your conversations. Approve to add it to your skill library."
    )
};

/// The inbox result once an approved learned skill is written: a new skill.
pub const APPROVAL_SKILL_ADDED_MESSAGE: Template = |arg| {
    format!(
        "Added the skill \"{slug}\" to your library.",
        slug = arg("slug")
    )
};
/// The inbox result when the approved skill replaced one already in the
/// library (an approved revision).
pub const APPROVAL_SKILL_UPDATED_MESSAGE: Template = |arg| {
    format!(
        "Updated the skill \"{slug}\" in your library.",
        slug = arg("slug")
    )
};

// ---- self-healing ------------------------------------------------------------

pub const APPROVAL_HEAL_RUN_TITLE_MESSAGE: Template = |_| format!("Auto-fix a failed run");
pub const APPROVAL_HEAL_RUN_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "A run failed and Ryu proposed a fix. Diagnosis: {diagnosis}",
        diagnosis = arg("diagnosis")
    )
};
pub const APPROVAL_HEAL_RUN_APPROVE_MESSAGE: Template =
    |_| format!("Approve to re-run it with the corrected instruction.");
pub const APPROVAL_HEAL_WORKFLOW_TITLE_MESSAGE: Template =
    |_| format!("Auto-fix a failed workflow");
pub const APPROVAL_HEAL_WORKFLOW_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "A workflow run failed and Ryu proposed a fix. Diagnosis: {diagnosis}",
        diagnosis = arg("diagnosis")
    )
};
pub const APPROVAL_HEAL_WORKFLOW_APPROVE_MESSAGE: Template =
    |_| format!("Approve to re-run the workflow.");
pub const APPROVAL_HEAL_EXHAUSTED_TITLE_MESSAGE: Template =
    |_| format!("A failing run needs your attention");
pub const APPROVAL_HEAL_EXHAUSTED_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "Ryu tried to auto-fix a failed run but gave up. {note}",
        note = arg("note")
    )
};
/// The summary when the healer reports how many attempts it used (Core has no
/// plural selector, so the count is a `label: {count}` value).
pub const APPROVAL_HEAL_EXHAUSTED_ATTEMPTS_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "Ryu tried to auto-fix a failed run but gave up. Auto-fix attempts used: {count}. Review it manually.",
        count = arg("count")
    )
};

// ---- agent inbox: claim an address -------------------------------------------

pub const APPROVAL_CLAIM_TITLE_MESSAGE: Template = |_| format!("Claim an email address");
pub const APPROVAL_CLAIM_ADDRESS_TITLE_MESSAGE: Template =
    |arg| format!("Claim email address: {address}", address = arg("address"));
pub const APPROVAL_CLAIM_QUESTION_MESSAGE: Template =
    |arg| format!("Claim an email address for {owner}?", owner = arg("owner"));
pub const APPROVAL_CLAIM_THIS_AGENT_QUESTION_MESSAGE: Template =
    |_| format!("Claim an email address for this agent?");
pub const APPROVAL_CLAIM_ADDRESS_QUESTION_MESSAGE: Template = |arg| {
    format!(
        "Claim {address} for {owner}?",
        address = arg("address"),
        owner = arg("owner")
    )
};
pub const APPROVAL_CLAIM_ADDRESS_THIS_AGENT_QUESTION_MESSAGE: Template =
    |arg| format!("Claim {address} for this agent?", address = arg("address"));
pub const APPROVAL_CLAIM_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "{owner} wants to claim a hosted email address.",
        owner = arg("owner")
    )
};
pub const APPROVAL_CLAIM_THIS_AGENT_SUMMARY_MESSAGE: Template =
    |_| format!("This agent wants to claim a hosted email address.");
pub const APPROVAL_ALIAS_PERMANENCE_MESSAGE: Template =
    |_| format!("Agent email addresses are permanent and never reissued.");
pub const APPROVAL_UNRESOLVED_ADDRESS_MESSAGE: Template = |arg| {
    format!(
        "{local}@(your organization's agent mail host)",
        local = arg("local")
    )
};

// ---- agent inbox: send an email -----------------------------------------------

pub const APPROVAL_SEND_TITLE_MESSAGE: Template =
    |arg| format!("Send email: {subject}", subject = arg("subject"));
pub const APPROVAL_SEND_NO_SUBJECT_TITLE_MESSAGE: Template =
    |_| format!("Send an email with no subject");
pub const APPROVAL_SEND_QUESTION_MESSAGE: Template = |arg| {
    format!(
        "Send \"{subject}\" to {recipients}?",
        subject = arg("subject"),
        recipients = arg("recipients")
    )
};
pub const APPROVAL_SEND_NO_SUBJECT_QUESTION_MESSAGE: Template = |arg| {
    format!(
        "Send an email with no subject to {recipients}?",
        recipients = arg("recipients")
    )
};
pub const APPROVAL_SEND_NO_RECIPIENTS_QUESTION_MESSAGE: Template = |arg| {
    format!(
        "Send \"{subject}\" with no recipients?",
        subject = arg("subject")
    )
};
pub const APPROVAL_SEND_EMPTY_QUESTION_MESSAGE: Template =
    |_| format!("Send an email with no subject and no recipients?");
pub const APPROVAL_SEND_SUMMARY_MESSAGE: Template =
    |arg| format!("{sender} wants to send an email.", sender = arg("sender"));
pub const APPROVAL_SEND_ANONYMOUS_SUMMARY_MESSAGE: Template =
    |_| format!("An agent wants to send an email.");
pub const APPROVAL_SEND_TO_MESSAGE: Template =
    |arg| format!("Send to: {recipients}", recipients = arg("recipients"));
pub const APPROVAL_SEND_NO_RECIPIENTS_MESSAGE: Template =
    |_| format!("The email has no recipients.");
pub const APPROVAL_SEND_CC_MESSAGE: Template =
    |arg| format!("Copy to: {recipients}", recipients = arg("recipients"));
pub const APPROVAL_SEND_REPLY_TO_MESSAGE: Template = |arg| {
    format!(
        "Replies go to: {recipients}",
        recipients = arg("recipients")
    )
};
pub const APPROVAL_SEND_SUBJECT_MESSAGE: Template =
    |arg| format!("Email subject: {subject}", subject = arg("subject"));
pub const APPROVAL_SEND_NO_SUBJECT_MESSAGE: Template = |_| format!("The email has no subject.");
pub const APPROVAL_MORE_RECIPIENTS_MESSAGE: Template = |arg| {
    format!(
        "{shown} and {rest} more not listed here",
        shown = arg("shown"),
        rest = arg("rest")
    )
};
pub const APPROVAL_BODY_HIDDEN_MESSAGE: Template = |arg| {
    format!(
        "{hidden} more characters of the message are not shown here.",
        hidden = arg("hidden")
    )
};

// ---- agent inbox: reply to an email -------------------------------------------

pub const APPROVAL_REPLY_TITLE_MESSAGE: Template = |_| format!("Reply to an email");
pub const APPROVAL_REPLY_ALL_TITLE_MESSAGE: Template = |_| format!("Reply all to an email");
pub const APPROVAL_REPLY_QUESTION_MESSAGE: Template = |arg| {
    format!(
        "Send this reply to {recipients}?",
        recipients = arg("recipients")
    )
};
pub const APPROVAL_REPLY_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "{sender} wants to reply to {recipients}.",
        sender = arg("sender"),
        recipients = arg("recipients")
    )
};
pub const APPROVAL_REPLY_ANONYMOUS_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "An agent wants to reply to {recipients}.",
        recipients = arg("recipients")
    )
};
pub const APPROVAL_REPLY_TO_MESSAGE_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "{sender} wants to reply to {recipients} (message {message}).",
        sender = arg("sender"),
        recipients = arg("recipients"),
        message = arg("message")
    )
};
pub const APPROVAL_REPLY_TO_MESSAGE_ANONYMOUS_SUMMARY_MESSAGE: Template = |arg| {
    format!(
        "An agent wants to reply to {recipients} (message {message}).",
        recipients = arg("recipients"),
        message = arg("message")
    )
};
pub const APPROVAL_REPLY_SENDER_MESSAGE: Template = |_| format!("the sender of the message");
pub const APPROVAL_REPLY_EVERYONE_MESSAGE: Template =
    |_| format!("the sender and everyone else on the message");

// ---- activity feed row for a decided request --------------------------------
// `{title}` is the request's own title, already in the reader's language.

pub const APPROVAL_ACTIVITY_APPROVED_MESSAGE: Template =
    |arg| format!("Request approved: {title}", title = arg("title"));
pub const APPROVAL_ACTIVITY_REJECTED_MESSAGE: Template =
    |arg| format!("Request rejected: {title}", title = arg("title"));
pub const APPROVAL_ACTIVITY_EXPIRED_MESSAGE: Template = |arg| {
    format!(
        "Request expired without a decision: {title}",
        title = arg("title")
    )
};
pub const APPROVAL_ACTIVITY_CANCELLED_MESSAGE: Template =
    |arg| format!("Request cancelled: {title}", title = arg("title"));

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    APPROVAL_APP_SEND_TITLE_MESSAGE,
    APPROVAL_APP_SEND_SUMMARY_MESSAGE,
    APPROVAL_CALL_TITLE_MESSAGE,
    APPROVAL_CALL_SUMMARY_MESSAGE,
    APPROVAL_CALL_QUESTION_MESSAGE,
    APPROVAL_SCHEDULED_TITLE_MESSAGE,
    APPROVAL_SCHEDULED_SUMMARY_MESSAGE,
    APPROVAL_SCHEDULED_QUESTION_MESSAGE,
    APPROVAL_SCHEDULED_APP_QUESTION_MESSAGE,
    APPROVAL_WORKFLOW_GATE_TITLE_MESSAGE,
    APPROVAL_WORKFLOW_GATE_SUMMARY_MESSAGE,
    APPROVAL_SKILL_TITLE_MESSAGE,
    APPROVAL_SKILL_SUMMARY_MESSAGE,
    APPROVAL_SKILL_NOTE_MESSAGE,
    APPROVAL_SKILL_ADDED_MESSAGE,
    APPROVAL_SKILL_UPDATED_MESSAGE,
    APPROVAL_HEAL_RUN_TITLE_MESSAGE,
    APPROVAL_HEAL_RUN_SUMMARY_MESSAGE,
    APPROVAL_HEAL_RUN_APPROVE_MESSAGE,
    APPROVAL_HEAL_WORKFLOW_TITLE_MESSAGE,
    APPROVAL_HEAL_WORKFLOW_SUMMARY_MESSAGE,
    APPROVAL_HEAL_WORKFLOW_APPROVE_MESSAGE,
    APPROVAL_HEAL_EXHAUSTED_TITLE_MESSAGE,
    APPROVAL_HEAL_EXHAUSTED_SUMMARY_MESSAGE,
    APPROVAL_HEAL_EXHAUSTED_ATTEMPTS_SUMMARY_MESSAGE,
    APPROVAL_CLAIM_TITLE_MESSAGE,
    APPROVAL_CLAIM_ADDRESS_TITLE_MESSAGE,
    APPROVAL_CLAIM_QUESTION_MESSAGE,
    APPROVAL_CLAIM_THIS_AGENT_QUESTION_MESSAGE,
    APPROVAL_CLAIM_ADDRESS_QUESTION_MESSAGE,
    APPROVAL_CLAIM_ADDRESS_THIS_AGENT_QUESTION_MESSAGE,
    APPROVAL_CLAIM_SUMMARY_MESSAGE,
    APPROVAL_CLAIM_THIS_AGENT_SUMMARY_MESSAGE,
    APPROVAL_ALIAS_PERMANENCE_MESSAGE,
    APPROVAL_UNRESOLVED_ADDRESS_MESSAGE,
    APPROVAL_SEND_TITLE_MESSAGE,
    APPROVAL_SEND_NO_SUBJECT_TITLE_MESSAGE,
    APPROVAL_SEND_QUESTION_MESSAGE,
    APPROVAL_SEND_NO_SUBJECT_QUESTION_MESSAGE,
    APPROVAL_SEND_NO_RECIPIENTS_QUESTION_MESSAGE,
    APPROVAL_SEND_EMPTY_QUESTION_MESSAGE,
    APPROVAL_SEND_SUMMARY_MESSAGE,
    APPROVAL_SEND_ANONYMOUS_SUMMARY_MESSAGE,
    APPROVAL_SEND_TO_MESSAGE,
    APPROVAL_SEND_NO_RECIPIENTS_MESSAGE,
    APPROVAL_SEND_CC_MESSAGE,
    APPROVAL_SEND_REPLY_TO_MESSAGE,
    APPROVAL_SEND_SUBJECT_MESSAGE,
    APPROVAL_SEND_NO_SUBJECT_MESSAGE,
    APPROVAL_MORE_RECIPIENTS_MESSAGE,
    APPROVAL_BODY_HIDDEN_MESSAGE,
    APPROVAL_REPLY_TITLE_MESSAGE,
    APPROVAL_REPLY_ALL_TITLE_MESSAGE,
    APPROVAL_REPLY_QUESTION_MESSAGE,
    APPROVAL_REPLY_SUMMARY_MESSAGE,
    APPROVAL_REPLY_ANONYMOUS_SUMMARY_MESSAGE,
    APPROVAL_REPLY_TO_MESSAGE_SUMMARY_MESSAGE,
    APPROVAL_REPLY_TO_MESSAGE_ANONYMOUS_SUMMARY_MESSAGE,
    APPROVAL_REPLY_SENDER_MESSAGE,
    APPROVAL_REPLY_EVERYONE_MESSAGE,
    APPROVAL_ACTIVITY_APPROVED_MESSAGE,
    APPROVAL_ACTIVITY_REJECTED_MESSAGE,
    APPROVAL_ACTIVITY_EXPIRED_MESSAGE,
    APPROVAL_ACTIVITY_CANCELLED_MESSAGE,
];
