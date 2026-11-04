//! The text Core itself writes into a workflow-as-agent or team chat turn,
//! rendered once in the owner's locale when the turn is written.
//!
//! Both the streamed reply and the persisted row carry this text, so it is
//! plain markdown in one language (the node's `ui-language`, see
//! [`crate::i18n::locale::node_locale`]). A raw executor or member error never
//! reaches the turn: it is logged here and the turn gets a generic sentence.

use chrono::{DateTime, Local, NaiveDateTime};

use crate::i18n::{messages, Message};

/// `**Workflow paused — waiting for input.**`, plus the gate's prompt.
pub(crate) fn workflow_paused_input_text(locale: &str, prompt: Option<&str>) -> String {
    let heading = Message::new(messages::WORKFLOW_PAUSED_INPUT_MESSAGE).render(locale);
    match prompt {
        Some(prompt) if !prompt.trim().is_empty() => format!("**{heading}**\n\n{prompt}"),
        _ => format!("**{heading}**"),
    }
}

/// `**Workflow paused — a provider limit was reached.** It resumes …`, with
/// the resume time in the node's local zone (or "soon" when it is unknown).
pub(crate) fn workflow_paused_limit_text(locale: &str, resume_at: Option<&str>) -> String {
    let resume = resume_at
        .and_then(|value| DateTime::parse_from_rfc3339(value.trim()).ok())
        .map(|at| at.with_timezone(&Local).naive_local());
    workflow_paused_limit_text_at(locale, resume)
}

/// [`workflow_paused_limit_text`] for a resume time already in local time.
pub(crate) fn workflow_paused_limit_text_at(locale: &str, resume: Option<NaiveDateTime>) -> String {
    let heading = Message::new(messages::WORKFLOW_PAUSED_LIMIT_MESSAGE).render(locale);
    let when = match resume {
        Some(at) => Message::new(messages::WORKFLOW_RESUMES_AT_MESSAGE)
            .text("time", at.format("%H:%M").to_string())
            .date("date", at.date())
            .render(locale),
        None => Message::new(messages::WORKFLOW_RESUMES_SOON_MESSAGE).render(locale),
    };
    format!("**{heading}** {when}")
}

/// `_The workflow failed. …_`; the run's own error goes to the log only.
pub(crate) fn workflow_failed_text(locale: &str, run_id: &str, detail: Option<&str>) -> String {
    tracing::warn!(
        run_id,
        detail = detail.unwrap_or("unknown error"),
        "workflow chat run failed"
    );
    format!(
        "_{}_",
        Message::new(messages::WORKFLOW_FAILED_MESSAGE).render(locale)
    )
}

/// `_The workflow could not start._`; the executor's refusal goes to the log.
pub(crate) fn workflow_start_failed_text(
    locale: &str,
    workflow_id: &str,
    error: &dyn std::fmt::Display,
) -> String {
    tracing::warn!(workflow_id, "workflow chat run failed to start: {error:#}");
    format!(
        "_{}_",
        Message::new(messages::WORKFLOW_START_FAILED_MESSAGE).render(locale)
    )
}

/// `_The workflow could not start because its run stopped unexpectedly._`
pub(crate) fn workflow_executor_terminated_text(locale: &str) -> String {
    format!(
        "_{}_",
        Message::new(messages::WORKFLOW_EXECUTOR_TERMINATED_MESSAGE).render(locale)
    )
}

/// `_(The workflow completed with no output.)_`
pub(crate) fn workflow_no_output_text(locale: &str) -> String {
    format!(
        "_({})_",
        Message::new(messages::WORKFLOW_NO_OUTPUT_MESSAGE).render(locale)
    )
}

/// One member's reply as the team turn shows it: the text, `_(No response.)_`
/// for an empty reply, or a generic sentence for a failed one (the error is
/// logged with the member id, never written into the turn).
pub(crate) fn team_member_reply_text<E: std::fmt::Display>(
    locale: &str,
    member_id: &str,
    result: Result<String, E>,
) -> String {
    match result {
        Ok(text) if !text.trim().is_empty() => text,
        Ok(_) => parenthesized(locale, messages::TEAM_NO_RESPONSE_MESSAGE),
        Err(error) => {
            tracing::warn!(member_id, "team member reply failed: {error:#}");
            parenthesized(locale, messages::TEAM_MEMBER_ERROR_MESSAGE)
        }
    }
}

/// The lead's synthesis, normalised like [`team_member_reply_text`].
pub(crate) fn team_synthesis_text<E: std::fmt::Display>(
    locale: &str,
    lead_id: &str,
    result: Result<String, E>,
) -> String {
    match result {
        Ok(text) if !text.trim().is_empty() => text,
        Ok(_) => parenthesized(locale, messages::TEAM_NO_SYNTHESIS_MESSAGE),
        Err(error) => {
            tracing::warn!(lead_id, "team synthesis failed: {error:#}");
            parenthesized(locale, messages::TEAM_SYNTHESIS_ERROR_MESSAGE)
        }
    }
}

/// "Synthesis by Lead", the header of the lead's block.
pub(crate) fn team_synthesis_label(locale: &str, lead_name: &str) -> String {
    Message::new(messages::TEAM_SYNTHESIS_LABEL_MESSAGE)
        .text("agent", lead_name)
        .render(locale)
}

/// "Routed to Member", the header of the routed member's block.
pub(crate) fn team_routed_label(locale: &str, member_name: &str) -> String {
    Message::new(messages::TEAM_ROUTED_LABEL_MESSAGE)
        .text("agent", member_name)
        .render(locale)
}

fn parenthesized(locale: &str, template: crate::i18n::Template) -> String {
    format!("_({})_", Message::new(template).render(locale))
}

#[cfg(test)]
#[path = "chat_turn_text_tests.rs"]
mod tests;
