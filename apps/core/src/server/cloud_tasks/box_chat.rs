//! The Ryu Box status messages saved into a task's conversation: a finished
//! run's summary and the finish (push, pull request, teardown). See
//! [`crate::server::subscription_cloud::chat_event`] for how they are stored.

use super::FinishSummary;
use crate::i18n::{messages, Message, Template};
use crate::server::subscription_cloud::chat_event::ChatEvent;

/// A finished run: the agent's own summary, then why it ended when it ended badly.
pub(in crate::server::cloud_tasks) fn run_event(
    summary: Option<&str>,
    exit_code: Option<i32>,
    reason: Option<&str>,
) -> ChatEvent {
    let mut event = ChatEvent::new("run")
        .fact("exitCode", exit_code)
        .fact("reason", reason)
        .lead(summary);
    if !event.has_lead() {
        event = event.say(Message::new(messages::CLOUD_RUN_NO_OUTPUT_MESSAGE));
    }
    if let Some(reason) = reason {
        event.say(Message::new(messages::CLOUD_RUN_ENDED_EARLY_MESSAGE).text("reason", reason))
    } else if let Some(code) = exit_code.filter(|code| *code != 0) {
        event
            .say(Message::new(messages::CLOUD_RUN_EXIT_CODE_MESSAGE).text("code", code.to_string()))
    } else {
        event
    }
}

/// A branch name as inline Markdown code, the way the message shows it.
fn code(branch: &str) -> String {
    format!("`{branch}`")
}

/// The finish: what was pushed, the pull request, and whether the Box is gone.
pub(in crate::server::cloud_tasks) fn finish_event(summary: &FinishSummary) -> ChatEvent {
    let one = summary.files == 1;
    let pick = |many: Template, single: Template| if one { single } else { many };
    let headline = match (&summary.branch, summary.pushed, &summary.push_error) {
        (Some(branch), true, _) => Message::new(pick(
            messages::CLOUD_FINISH_PUSHED_MESSAGE,
            messages::CLOUD_FINISH_PUSHED_ONE_MESSAGE,
        ))
        .text("branch", code(branch)),
        (Some(branch), false, Some(error)) => Message::new(pick(
            messages::CLOUD_FINISH_PUSH_FAILED_MESSAGE,
            messages::CLOUD_FINISH_PUSH_FAILED_ONE_MESSAGE,
        ))
        .text("branch", code(branch))
        .text("error", error.as_str()),
        _ => Message::new(pick(
            messages::CLOUD_FINISH_DONE_MESSAGE,
            messages::CLOUD_FINISH_DONE_ONE_MESSAGE,
        )),
    }
    .number("files", summary.files as f64, 0, 0)
    .number("insertions", summary.insertions as f64, 0, 0)
    .number("deletions", summary.deletions as f64, 0, 0);
    let pull_request = if let Some(pull_request) = &summary.pull_request {
        Some(
            Message::new(messages::CLOUD_FINISH_PR_OPENED_MESSAGE)
                .text("number", pull_request.number.to_string())
                .text("url", pull_request.url.as_str()),
        )
    } else if let Some(url) = &summary.compare_url {
        Some(match &summary.pull_request_error {
            Some(error) => Message::new(messages::CLOUD_FINISH_PR_FAILED_MESSAGE)
                .text("error", error.as_str())
                .text("url", url.as_str()),
            None => Message::new(messages::CLOUD_FINISH_PR_LINK_MESSAGE).text("url", url.as_str()),
        })
    } else {
        None
    };
    let teardown = if summary.teardown == "destroyed" {
        messages::CLOUD_BOX_DESTROYED_MESSAGE
    } else {
        messages::CLOUD_BOX_KEPT_MESSAGE
    };
    let mut event = ChatEvent::new("finish")
        .fact("branch", summary.branch.clone())
        .fact("pushed", summary.pushed)
        .fact("pushError", summary.push_error.clone())
        .fact("files", summary.files)
        .fact("insertions", summary.insertions)
        .fact("deletions", summary.deletions)
        .fact(
            "prUrl",
            summary.pull_request.as_ref().map(|pr| pr.url.clone()),
        )
        .fact(
            "prNumber",
            summary.pull_request.as_ref().map(|pr| pr.number),
        )
        .fact("prError", summary.pull_request_error.clone())
        .fact("compareUrl", summary.compare_url.clone())
        .fact("teardown", summary.teardown.clone())
        .say(headline);
    if let Some(pull_request) = pull_request {
        event = event.say(pull_request);
    }
    event.say(Message::new(teardown))
}

#[cfg(test)]
#[path = "box_chat_tests.rs"]
mod tests;
