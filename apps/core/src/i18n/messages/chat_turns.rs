//! English sources for the text Core writes into a chat turn itself when a
//! workflow runs as an agent or a team answers: a paused, failed or empty
//! workflow run, and a team member's missing or failed reply plus the labels
//! of the synthesis and routed blocks.
//!
//! Same shape as the templates in [`super`]. The caller renders them once, in
//! the owner's locale, when it writes the turn; the markdown emphasis (`_`,
//! `**`) and parentheses stay in the caller's `format!`, outside the sentence.
#![allow(clippy::useless_format)]

use super::Template;

// ---- workflow as an agent -----------------------------------------------------

pub const WORKFLOW_PAUSED_INPUT_MESSAGE: Template =
    |_| format!("Workflow paused — waiting for input.");
pub const WORKFLOW_PAUSED_LIMIT_MESSAGE: Template =
    |_| format!("Workflow paused — a provider limit was reached.");
pub const WORKFLOW_RESUMES_AT_MESSAGE: Template = |arg| {
    format!(
        "It resumes on its own at {time} on {date}.",
        time = arg("time"),
        date = arg("date")
    )
};
pub const WORKFLOW_RESUMES_SOON_MESSAGE: Template = |_| format!("It resumes on its own soon.");
pub const WORKFLOW_FAILED_MESSAGE: Template =
    |_| format!("The workflow failed. Open the run for details.");
pub const WORKFLOW_START_FAILED_MESSAGE: Template = |_| format!("The workflow could not start.");
pub const WORKFLOW_EXECUTOR_TERMINATED_MESSAGE: Template =
    |_| format!("The workflow could not start because its run stopped unexpectedly.");
pub const WORKFLOW_NO_OUTPUT_MESSAGE: Template =
    |_| format!("The workflow completed with no output.");

// ---- team turns -----------------------------------------------------------------

pub const TEAM_NO_RESPONSE_MESSAGE: Template = |_| format!("No response.");
pub const TEAM_MEMBER_ERROR_MESSAGE: Template = |_| format!("This teammate could not reply.");
pub const TEAM_NO_SYNTHESIS_MESSAGE: Template = |_| format!("The lead returned no synthesis.");
pub const TEAM_SYNTHESIS_ERROR_MESSAGE: Template = |_| format!("The synthesis failed.");
pub const TEAM_SYNTHESIS_LABEL_MESSAGE: Template =
    |arg| format!("Synthesis by {agent}", agent = arg("agent"));
pub const TEAM_ROUTED_LABEL_MESSAGE: Template =
    |arg| format!("Routed to {agent}", agent = arg("agent"));

/// Every template in this module, for the catalog round-trip test.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    WORKFLOW_PAUSED_INPUT_MESSAGE,
    WORKFLOW_PAUSED_LIMIT_MESSAGE,
    WORKFLOW_RESUMES_AT_MESSAGE,
    WORKFLOW_RESUMES_SOON_MESSAGE,
    WORKFLOW_FAILED_MESSAGE,
    WORKFLOW_START_FAILED_MESSAGE,
    WORKFLOW_EXECUTOR_TERMINATED_MESSAGE,
    WORKFLOW_NO_OUTPUT_MESSAGE,
    TEAM_NO_RESPONSE_MESSAGE,
    TEAM_MEMBER_ERROR_MESSAGE,
    TEAM_NO_SYNTHESIS_MESSAGE,
    TEAM_SYNTHESIS_ERROR_MESSAGE,
    TEAM_SYNTHESIS_LABEL_MESSAGE,
    TEAM_ROUTED_LABEL_MESSAGE,
];
