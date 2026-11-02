//! English sources for the cloud-task and plan-run status messages Core saves
//! into a conversation, and for the routing notices a task start returns.
//!
//! Same shape as the templates in [`super`]. A saved status message keeps its
//! English rendering as the message body (older clients, bots and exports read
//! that) and carries these sources plus their values in a `data-ryu-cloud-task`
//! part, so a client renders it in the reader's language. A count sentence has
//! a `*_ONE_MESSAGE` form for a count of 1, since the renderer has no ICU
//! `plural` support.
#![allow(clippy::useless_format)]

use super::Template;

// ---- Ryu Box runs ---------------------------------------------------------------

pub const CLOUD_RUN_NO_OUTPUT_MESSAGE: Template = |_| format!("The agent finished without output.");
pub const CLOUD_RUN_ENDED_EARLY_MESSAGE: Template =
    |arg| format!("The run ended early ({reason}).", reason = arg("reason"));
pub const CLOUD_RUN_EXIT_CODE_MESSAGE: Template =
    |arg| format!("Exit code {code}.", code = arg("code"));

// ---- Ryu Box finish -------------------------------------------------------------

pub const CLOUD_FINISH_PUSHED_MESSAGE: Template = |arg| {
    format!(
        "Pushed branch {branch} ({files} files changed, +{insertions} -{deletions}).",
        branch = arg("branch"),
        files = arg("files"),
        insertions = arg("insertions"),
        deletions = arg("deletions")
    )
};
pub const CLOUD_FINISH_PUSHED_ONE_MESSAGE: Template = |arg| {
    format!(
        "Pushed branch {branch} ({files} file changed, +{insertions} -{deletions}).",
        branch = arg("branch"),
        files = arg("files"),
        insertions = arg("insertions"),
        deletions = arg("deletions")
    )
};
pub const CLOUD_FINISH_PUSH_FAILED_MESSAGE: Template = |arg| {
    format!(
        "Committed the changes ({files} files changed, +{insertions} -{deletions}), but pushing {branch} failed ({error}). The cloud box was kept so no work is lost.",
        files = arg("files"),
        insertions = arg("insertions"),
        deletions = arg("deletions"),
        branch = arg("branch"),
        error = arg("error")
    )
};
pub const CLOUD_FINISH_PUSH_FAILED_ONE_MESSAGE: Template = |arg| {
    format!(
        "Committed the changes ({files} file changed, +{insertions} -{deletions}), but pushing {branch} failed ({error}). The cloud box was kept so no work is lost.",
        files = arg("files"),
        insertions = arg("insertions"),
        deletions = arg("deletions"),
        branch = arg("branch"),
        error = arg("error")
    )
};
pub const CLOUD_FINISH_DONE_MESSAGE: Template = |arg| {
    format!(
        "Finished the cloud task ({files} files changed, +{insertions} -{deletions}).",
        files = arg("files"),
        insertions = arg("insertions"),
        deletions = arg("deletions")
    )
};
pub const CLOUD_FINISH_DONE_ONE_MESSAGE: Template = |arg| {
    format!(
        "Finished the cloud task ({files} file changed, +{insertions} -{deletions}).",
        files = arg("files"),
        insertions = arg("insertions"),
        deletions = arg("deletions")
    )
};
pub const CLOUD_FINISH_PR_OPENED_MESSAGE: Template = |arg| {
    format!(
        "Opened pull request #{number}: {url}",
        number = arg("number"),
        url = arg("url")
    )
};
pub const CLOUD_FINISH_PR_FAILED_MESSAGE: Template = |arg| {
    format!(
        "Opening a pull request failed ({error}). Open one here: {url}",
        error = arg("error"),
        url = arg("url")
    )
};
pub const CLOUD_FINISH_PR_LINK_MESSAGE: Template =
    |arg| format!("Open a pull request: {url}", url = arg("url"));
pub const CLOUD_BOX_DESTROYED_MESSAGE: Template = |_| format!("The cloud box was destroyed.");
pub const CLOUD_BOX_KEPT_MESSAGE: Template =
    |_| format!("The cloud box is still running until it expires or is stopped.");

// ---- plan runs: the start reply and the result --------------------------------

pub const CLOUD_PLAN_RUNNING_MESSAGE: Template = |arg| {
    format!(
        "Running in {cliName} on your {planName} plan, on branch {branch}. Follow it in the task panel. This task does not use Ryu credits.",
        cliName = arg("cliName"),
        planName = arg("planName"),
        branch = arg("branch")
    )
};
pub const CLOUD_PLAN_SENT_MESSAGE: Template = |arg| {
    format!(
        "Sent to {cliName} on your {planName} plan. Follow it at {url}. This task does not use Ryu credits.",
        cliName = arg("cliName"),
        planName = arg("planName"),
        url = arg("url")
    )
};
pub const CLOUD_PLAN_SENT_NO_LINK_MESSAGE: Template = |arg| {
    format!(
        "Sent to {cliName} on your {planName} plan. Follow it at the provider's site. This task does not use Ryu credits.",
        cliName = arg("cliName"),
        planName = arg("planName")
    )
};
pub const CLOUD_PLAN_COMPLETED_MESSAGE: Template = |_| format!("The task completed.");
pub const CLOUD_PLAN_FAILED_MESSAGE: Template = |_| format!("The task failed.");
pub const CLOUD_PLAN_STOPPED_MESSAGE: Template = |_| format!("The task was stopped.");
pub const CLOUD_PLAN_READY_MESSAGE: Template = |_| format!("The task is ready.");
pub const CLOUD_PLAN_FINISHED_MESSAGE: Template = |_| format!("The task finished.");

// ---- routing notices (why a preferred plan was skipped) -------------------------

pub const PLAN_NOTICE_NOT_INSTALLED_MESSAGE: Template = |arg| {
    format!(
        "{cliName} is not installed on this node.",
        cliName = arg("cliName")
    )
};
pub const PLAN_NOTICE_SIGNED_OUT_MESSAGE: Template = |arg| {
    format!(
        "{cliName} is not signed in on this node. Sign in from Settings to use your {planName} plan.",
        cliName = arg("cliName"),
        planName = arg("planName")
    )
};
pub const PLAN_NOTICE_WRONG_SIGN_IN_MESSAGE: Template = |arg| {
    format!(
        "{cliName} is signed in with an API key, not your {planName} plan.",
        cliName = arg("cliName"),
        planName = arg("planName")
    )
};
pub const PLAN_NOTICE_NO_CHECKOUT_MESSAGE: Template = |arg| {
    format!(
        "This environment has no local checkout set for your {planName} plan.",
        planName = arg("planName")
    )
};
pub const PLAN_NOTICE_NO_CODEX_ENVIRONMENT_MESSAGE: Template = |arg| {
    format!(
        "This environment has no Codex environment ID set for your {planName} plan.",
        planName = arg("planName")
    )
};
pub const PLAN_NOTICE_COOLING_DOWN_MESSAGE: Template = |arg| {
    format!(
        "Your {planName} plan hit its usage limit recently, so this task did not use it.",
        planName = arg("planName")
    )
};
pub const PLAN_NOTICE_COOLING_DOWN_NEXT_ACCOUNT_MESSAGE: Template = |arg| {
    format!(
        "Your {planName} plan ({account}) hit its usage limit recently, so Ryu uses the next account you listed.",
        planName = arg("planName"),
        account = arg("account")
    )
};
pub const PLAN_NOTICE_QUOTA_FALLBACK_MESSAGE: Template = |arg| {
    format!(
        "Your {planName} plan ({account}) reached its usage or rate limit. Ryu tries the next option: another account only if you listed it, otherwise a Ryu Box, which uses Ryu credits.",
        planName = arg("planName"),
        account = arg("account")
    )
};
pub const PLAN_NOTICE_ACCOUNT_SIGNED_OUT_MESSAGE: Template = |arg| {
    format!(
        "{cliName} is not signed in to your {planName} plan ({account}) on this node.",
        cliName = arg("cliName"),
        planName = arg("planName"),
        account = arg("account")
    )
};
pub const PLAN_NOTICE_START_FAILED_MESSAGE: Template = |arg| {
    format!(
        "{cliName} could not start the task: {reason}",
        cliName = arg("cliName"),
        reason = arg("reason")
    )
};
pub const PLAN_NOTICE_NOT_RUNNABLE_MESSAGE: Template = |arg| {
    format!(
        "{cliName} could not start the task because it could not be run.",
        cliName = arg("cliName")
    )
};
pub const PLAN_NOTICE_NO_WORKTREE_MESSAGE: Template = |arg| {
    format!(
        "Ryu could not make a worktree of this environment's checkout: {reason}",
        reason = arg("reason")
    )
};

/// Every template in this module, for the catalog round-trip test; add each
/// new `*_MESSAGE` here too.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    CLOUD_RUN_NO_OUTPUT_MESSAGE,
    CLOUD_RUN_ENDED_EARLY_MESSAGE,
    CLOUD_RUN_EXIT_CODE_MESSAGE,
    CLOUD_FINISH_PUSHED_MESSAGE,
    CLOUD_FINISH_PUSHED_ONE_MESSAGE,
    CLOUD_FINISH_PUSH_FAILED_MESSAGE,
    CLOUD_FINISH_PUSH_FAILED_ONE_MESSAGE,
    CLOUD_FINISH_DONE_MESSAGE,
    CLOUD_FINISH_DONE_ONE_MESSAGE,
    CLOUD_FINISH_PR_OPENED_MESSAGE,
    CLOUD_FINISH_PR_FAILED_MESSAGE,
    CLOUD_FINISH_PR_LINK_MESSAGE,
    CLOUD_BOX_DESTROYED_MESSAGE,
    CLOUD_BOX_KEPT_MESSAGE,
    CLOUD_PLAN_RUNNING_MESSAGE,
    CLOUD_PLAN_SENT_MESSAGE,
    CLOUD_PLAN_SENT_NO_LINK_MESSAGE,
    CLOUD_PLAN_COMPLETED_MESSAGE,
    CLOUD_PLAN_FAILED_MESSAGE,
    CLOUD_PLAN_STOPPED_MESSAGE,
    CLOUD_PLAN_READY_MESSAGE,
    CLOUD_PLAN_FINISHED_MESSAGE,
    PLAN_NOTICE_NOT_INSTALLED_MESSAGE,
    PLAN_NOTICE_SIGNED_OUT_MESSAGE,
    PLAN_NOTICE_WRONG_SIGN_IN_MESSAGE,
    PLAN_NOTICE_NO_CHECKOUT_MESSAGE,
    PLAN_NOTICE_NO_CODEX_ENVIRONMENT_MESSAGE,
    PLAN_NOTICE_COOLING_DOWN_MESSAGE,
    PLAN_NOTICE_COOLING_DOWN_NEXT_ACCOUNT_MESSAGE,
    PLAN_NOTICE_QUOTA_FALLBACK_MESSAGE,
    PLAN_NOTICE_ACCOUNT_SIGNED_OUT_MESSAGE,
    PLAN_NOTICE_START_FAILED_MESSAGE,
    PLAN_NOTICE_NOT_RUNNABLE_MESSAGE,
    PLAN_NOTICE_NO_WORKTREE_MESSAGE,
];
