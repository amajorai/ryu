//! The routing notices: why a preferred plan was skipped for a task.
//!
//! Each is one Core message ([`crate::i18n::messages`]) with its values, sent as
//! the notice's `i18n` next to the English `message`, so the desktop shows the
//! toast in the reader's language.

use super::routing::Notice;
use super::CloudTaskBackend;
use crate::i18n::{messages, Message, Template};

const UNAVAILABLE: &str = "subscription_unavailable";
const SIGNED_OUT: &str = "subscription_signed_out";
const NOT_CONFIGURED: &str = "subscription_not_configured";
const COOLING_DOWN: &str = "subscription_cooling_down";
const QUOTA_FALLBACK: &str = "subscription_quota_fallback";

/// A message naming the backend's CLI and plan.
fn about(template: Template, backend: CloudTaskBackend) -> Message {
    Message::new(template)
        .text("cliName", backend.cli_name())
        .text("planName", backend.plan_name())
}

impl Notice {
    /// The backend's CLI is not installed on this node.
    pub(crate) fn not_installed(backend: CloudTaskBackend) -> Self {
        let message = Message::new(messages::PLAN_NOTICE_NOT_INSTALLED_MESSAGE)
            .text("cliName", backend.cli_name());
        Self::new(UNAVAILABLE, backend, message)
    }

    /// The CLI is not signed in on this node.
    pub(crate) fn signed_out(backend: CloudTaskBackend) -> Self {
        let message = about(messages::PLAN_NOTICE_SIGNED_OUT_MESSAGE, backend);
        Self::new(SIGNED_OUT, backend, message)
    }

    /// The CLI is signed in with an API key or another provider, not the plan.
    pub(crate) fn wrong_sign_in(backend: CloudTaskBackend) -> Self {
        let message = about(messages::PLAN_NOTICE_WRONG_SIGN_IN_MESSAGE, backend);
        Self::new(SIGNED_OUT, backend, message)
    }

    /// This environment lacks the backend's setting (a checkout or a Codex environment).
    pub(crate) fn not_configured(backend: CloudTaskBackend) -> Self {
        let template = if backend == CloudTaskBackend::OpenaiSubscriptionCli {
            messages::PLAN_NOTICE_NO_CODEX_ENVIRONMENT_MESSAGE
        } else {
            messages::PLAN_NOTICE_NO_CHECKOUT_MESSAGE
        };
        let message = Message::new(template).text("planName", backend.plan_name());
        Self::new(NOT_CONFIGURED, backend, message)
    }

    /// The plan hit its usage limit recently.
    pub(crate) fn cooling_down(backend: CloudTaskBackend) -> Self {
        let message = Message::new(messages::PLAN_NOTICE_COOLING_DOWN_MESSAGE)
            .text("planName", backend.plan_name());
        Self::new(COOLING_DOWN, backend, message)
    }

    /// The account hit its usage limit recently; the next listed account stands in.
    pub(crate) fn cooling_down_next_account(backend: CloudTaskBackend, account: &str) -> Self {
        let message = Message::new(messages::PLAN_NOTICE_COOLING_DOWN_NEXT_ACCOUNT_MESSAGE)
            .text("planName", backend.plan_name())
            .text("account", account);
        Self::new(COOLING_DOWN, backend, message)
    }

    /// The account reached its usage or rate limit while starting the task.
    pub(crate) fn quota_fallback(backend: CloudTaskBackend, account: &str) -> Self {
        let message = Message::new(messages::PLAN_NOTICE_QUOTA_FALLBACK_MESSAGE)
            .text("planName", backend.plan_name())
            .text("account", account);
        Self::new(QUOTA_FALLBACK, backend, message)
    }

    /// The CLI is not signed in to this account's plan.
    pub(crate) fn account_signed_out(backend: CloudTaskBackend, account: &str) -> Self {
        let message = about(messages::PLAN_NOTICE_ACCOUNT_SIGNED_OUT_MESSAGE, backend)
            .text("account", account);
        Self::new(SIGNED_OUT, backend, message)
    }

    /// The CLI refused to start the task; `reason` is its own (scrubbed) words.
    pub(crate) fn start_failed(backend: CloudTaskBackend, reason: &str) -> Self {
        let message = Message::new(messages::PLAN_NOTICE_START_FAILED_MESSAGE)
            .text("cliName", backend.cli_name())
            .text("reason", reason);
        Self::new(UNAVAILABLE, backend, message)
    }

    /// The CLI could not be run at all.
    pub(crate) fn not_runnable(backend: CloudTaskBackend) -> Self {
        let message = Message::new(messages::PLAN_NOTICE_NOT_RUNNABLE_MESSAGE)
            .text("cliName", backend.cli_name());
        Self::new(UNAVAILABLE, backend, message)
    }

    /// Ryu could not make a worktree of the environment's checkout.
    pub(crate) fn no_worktree(backend: CloudTaskBackend, reason: &str) -> Self {
        let message =
            Message::new(messages::PLAN_NOTICE_NO_WORKTREE_MESSAGE).text("reason", reason);
        Self::new(NOT_CONFIGURED, backend, message)
    }
}

#[cfg(test)]
#[path = "notices_tests.rs"]
mod tests;
