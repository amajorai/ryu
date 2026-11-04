//! English sources of the notifications Core renders per locale.
//!
//! Each `*_MESSAGE` is a [`Template`]: `format!` with one named argument per
//! placeholder, the argument named after it (`status = arg("status")`), so the
//! i18n extractor catalogs the ICU source (`"Unexpected HTTP {status}."`) that
//! [`super::Message::new`] reproduces. `tools/generate-core-i18n.mjs --check`
//! fails when a template breaks that shape or the extractor would skip it.
//! Topic-specific templates live in the sibling modules (`approvals`, `acp`,
//! `chat_turns`, `cloud_tasks`, `consent`, `notifications`, `context`, `import`, `providers`, `routing`, `update`,
//! `voice`) and are re-exported here.
//! Every message is a whole sentence; never assemble one from fragments.
#![allow(clippy::useless_format)]

use super::Template;

mod acp;
mod approvals;
mod chat_turns;
mod cloud_tasks;
mod consent;
mod context;
mod import;
mod notifications;
mod providers;
mod routing;
mod update;
mod voice;

// A topic module may still be empty, so its glob re-export imports nothing.
#[allow(unused_imports)]
pub use acp::*;
#[allow(unused_imports)]
pub use approvals::*;
#[allow(unused_imports)]
pub use chat_turns::*;
#[allow(unused_imports)]
pub use cloud_tasks::*;
#[allow(unused_imports)]
pub use consent::*;
#[allow(unused_imports)]
pub use context::*;
#[allow(unused_imports)]
pub use import::*;
#[allow(unused_imports)]
pub use notifications::*;
#[allow(unused_imports)]
pub use providers::*;
#[allow(unused_imports)]
pub use routing::*;
#[allow(unused_imports)]
pub use update::*;
#[allow(unused_imports)]
pub use voice::*;

// ---- approvals (mobile push) ----------------------------------------------

pub const APPROVAL_NEEDED_TITLE_MESSAGE: Template = |_| format!("Approval needed");
pub const APPROVAL_WAITING_BODY_MESSAGE: Template =
    |_| format!("A request is waiting for a decision. Open Ryu to review it.");

// ---- finished runs (mobile push) ------------------------------------------

pub const RUN_FAILED_BODY_MESSAGE: Template =
    |_| format!("The run failed. Tap to see what happened.");
pub const RUN_FINISHED_BODY_MESSAGE: Template = |_| format!("Finished replying. Tap to read it.");

// ---- policy alert titles ---------------------------------------------------

pub const POLICY_BUDGET_TITLE_MESSAGE: Template = |_| format!("Budget limit reached");
pub const POLICY_SESSION_BUDGET_TITLE_MESSAGE: Template =
    |_| format!("Session budget limit reached");
pub const POLICY_WALLET_TITLE_MESSAGE: Template = |_| format!("Wallet balance depleted");
pub const POLICY_FIREWALL_TITLE_MESSAGE: Template = |_| format!("Firewall policy triggered");
pub const POLICY_GENERIC_TITLE_MESSAGE: Template = |_| format!("Policy alert");
pub const POLICY_SOURCE_TITLE_MESSAGE: Template =
    |arg| format!("Policy alert: {source}", source = arg("source"));

// ---- policy alert bodies: usage against a limit ----------------------------

pub const POLICY_USED_USER_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} for user {subject}.",
        used = arg("used"),
        limit = arg("limit"),
        subject = arg("subject")
    )
};
pub const POLICY_USED_AGENT_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} for agent {subject}.",
        used = arg("used"),
        limit = arg("limit"),
        subject = arg("subject")
    )
};
pub const POLICY_USED_SESSION_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} for session {subject}.",
        used = arg("used"),
        limit = arg("limit"),
        subject = arg("subject")
    )
};
pub const POLICY_USED_REQUEST_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} for request {subject}.",
        used = arg("used"),
        limit = arg("limit"),
        subject = arg("subject")
    )
};
pub const POLICY_USED_THIS_USER_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} for this user.",
        used = arg("used"),
        limit = arg("limit")
    )
};
pub const POLICY_USED_THIS_AGENT_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} for this agent.",
        used = arg("used"),
        limit = arg("limit")
    )
};
pub const POLICY_USED_THIS_SESSION_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} for this session.",
        used = arg("used"),
        limit = arg("limit")
    )
};
pub const POLICY_USED_THIS_REQUEST_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} for this request.",
        used = arg("used"),
        limit = arg("limit")
    )
};
pub const POLICY_USED_SCOPE_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit} ({scope}).",
        used = arg("used"),
        limit = arg("limit"),
        scope = arg("scope")
    )
};
pub const POLICY_USED_MESSAGE: Template = |arg| {
    format!(
        "Used {used} of {limit}.",
        used = arg("used"),
        limit = arg("limit")
    )
};

// ---- policy alert bodies: triggered without a limit ------------------------

pub const POLICY_TRIGGERED_USER_MESSAGE: Template =
    |arg| format!("Triggered for user {subject}.", subject = arg("subject"));
pub const POLICY_TRIGGERED_AGENT_MESSAGE: Template =
    |arg| format!("Triggered for agent {subject}.", subject = arg("subject"));
pub const POLICY_TRIGGERED_SESSION_MESSAGE: Template =
    |arg| format!("Triggered for session {subject}.", subject = arg("subject"));
pub const POLICY_TRIGGERED_REQUEST_MESSAGE: Template =
    |arg| format!("Triggered for request {subject}.", subject = arg("subject"));
pub const POLICY_TRIGGERED_THIS_USER_MESSAGE: Template = |_| format!("Triggered for this user.");
pub const POLICY_TRIGGERED_THIS_AGENT_MESSAGE: Template = |_| format!("Triggered for this agent.");
pub const POLICY_TRIGGERED_THIS_SESSION_MESSAGE: Template =
    |_| format!("Triggered for this session.");
pub const POLICY_TRIGGERED_THIS_REQUEST_MESSAGE: Template =
    |_| format!("Triggered for this request.");
pub const POLICY_TRIGGERED_SCOPE_MESSAGE: Template =
    |arg| format!("Triggered for {scope}.", scope = arg("scope"));
pub const POLICY_TRIGGERED_MESSAGE: Template = |_| format!("Policy triggered.");

// ---- policy alert bodies: what the Gateway did -----------------------------

pub const POLICY_ACTION_NOTIFY_MESSAGE: Template = |_| format!("Action: alert only.");
pub const POLICY_ACTION_DOWNGRADE_MESSAGE: Template =
    |_| format!("Action: requests were downgraded.");
pub const POLICY_ACTION_RESTRICT_MESSAGE: Template =
    |_| format!("Action: requests were restricted.");
pub const POLICY_ACTION_STOP_MESSAGE: Template = |_| format!("Action: requests were stopped.");
pub const POLICY_ACTION_BLOCK_MESSAGE: Template = |_| format!("Action: the request was blocked.");
pub const POLICY_ACTION_OTHER_MESSAGE: Template = |arg| {
    format!(
        "Action taken: {enforcement}.",
        enforcement = arg("enforcement")
    )
};

// ---- Marketplace license revoked (inbox, desktop toast, push) -------------

pub const LICENSE_REVOKED_TITLE_MESSAGE: Template =
    |arg| format!("Marketplace license revoked for {item}", item = arg("item"));
pub const LICENSE_DISABLED_TITLE_MESSAGE: Template = |arg| {
    format!(
        "Disabled {item} because its Marketplace license was revoked",
        item = arg("item")
    )
};
pub const LICENSE_DISABLE_FAILED_MESSAGE: Template = |arg| {
    format!(
        "It could not be disabled automatically ({error}). Disable it from Settings.",
        error = arg("error")
    )
};
pub const LICENSE_REFUNDED_MESSAGE: Template = |arg| {
    format!(
        "The Marketplace purchase of {item} was refunded, so its license is revoked. Buy it again to enable it.",
        item = arg("item")
    )
};
pub const LICENSE_DISPUTED_MESSAGE: Template = |arg| {
    format!(
        "The Marketplace purchase of {item} is disputed, so its license is suspended.",
        item = arg("item")
    )
};
pub const LICENSE_EXPIRED_MESSAGE: Template = |arg| {
    format!(
        "The Marketplace license for {item} has expired. Renew it to enable the item.",
        item = arg("item")
    )
};
pub const LICENSE_REFUSED_MESSAGE: Template = |arg| {
    format!(
        "The Marketplace license for {item} was refused.",
        item = arg("item")
    )
};
pub const LICENSE_OFFLINE_GRACE_ENDED_MESSAGE: Template = |arg| {
    format!(
        "The Marketplace license for {item} could not be re-checked ({reason}) and the offline grace period has ended. Reconnect and sign in to enable this paid item.",
        item = arg("item"),
        reason = arg("reason")
    )
};

// ---- OAuth callback page (the browser tab an MCP sign-in returns to) -------

pub const OAUTH_CONNECTED_TITLE_MESSAGE: Template = |_| format!("Connection complete");
pub const OAUTH_CONNECTED_DETAIL_MESSAGE: Template =
    |_| format!("You can close this window and return to Ryu.");
pub const OAUTH_FAILED_TITLE_MESSAGE: Template = |_| format!("Connection failed");
pub const OAUTH_FAILED_DETAIL_MESSAGE: Template =
    |_| format!("Return to Ryu for details and try connecting again.");

/// Every template in this file; [`all`] adds the sibling modules' lists.
#[cfg(test)]
const ALL: &[Template] = &[
    APPROVAL_NEEDED_TITLE_MESSAGE,
    APPROVAL_WAITING_BODY_MESSAGE,
    RUN_FAILED_BODY_MESSAGE,
    RUN_FINISHED_BODY_MESSAGE,
    POLICY_BUDGET_TITLE_MESSAGE,
    POLICY_SESSION_BUDGET_TITLE_MESSAGE,
    POLICY_WALLET_TITLE_MESSAGE,
    POLICY_FIREWALL_TITLE_MESSAGE,
    POLICY_GENERIC_TITLE_MESSAGE,
    POLICY_SOURCE_TITLE_MESSAGE,
    POLICY_USED_USER_MESSAGE,
    POLICY_USED_AGENT_MESSAGE,
    POLICY_USED_SESSION_MESSAGE,
    POLICY_USED_REQUEST_MESSAGE,
    POLICY_USED_THIS_USER_MESSAGE,
    POLICY_USED_THIS_AGENT_MESSAGE,
    POLICY_USED_THIS_SESSION_MESSAGE,
    POLICY_USED_THIS_REQUEST_MESSAGE,
    POLICY_USED_SCOPE_MESSAGE,
    POLICY_USED_MESSAGE,
    POLICY_TRIGGERED_USER_MESSAGE,
    POLICY_TRIGGERED_AGENT_MESSAGE,
    POLICY_TRIGGERED_SESSION_MESSAGE,
    POLICY_TRIGGERED_REQUEST_MESSAGE,
    POLICY_TRIGGERED_THIS_USER_MESSAGE,
    POLICY_TRIGGERED_THIS_AGENT_MESSAGE,
    POLICY_TRIGGERED_THIS_SESSION_MESSAGE,
    POLICY_TRIGGERED_THIS_REQUEST_MESSAGE,
    POLICY_TRIGGERED_SCOPE_MESSAGE,
    POLICY_TRIGGERED_MESSAGE,
    POLICY_ACTION_NOTIFY_MESSAGE,
    POLICY_ACTION_DOWNGRADE_MESSAGE,
    POLICY_ACTION_RESTRICT_MESSAGE,
    POLICY_ACTION_STOP_MESSAGE,
    POLICY_ACTION_BLOCK_MESSAGE,
    POLICY_ACTION_OTHER_MESSAGE,
    LICENSE_REVOKED_TITLE_MESSAGE,
    LICENSE_DISABLED_TITLE_MESSAGE,
    LICENSE_DISABLE_FAILED_MESSAGE,
    LICENSE_REFUNDED_MESSAGE,
    LICENSE_DISPUTED_MESSAGE,
    LICENSE_EXPIRED_MESSAGE,
    LICENSE_REFUSED_MESSAGE,
    LICENSE_OFFLINE_GRACE_ENDED_MESSAGE,
    OAUTH_CONNECTED_TITLE_MESSAGE,
    OAUTH_CONNECTED_DETAIL_MESSAGE,
    OAUTH_FAILED_TITLE_MESSAGE,
    OAUTH_FAILED_DETAIL_MESSAGE,
];

/// Every Core template, for the catalog round-trip test.
#[cfg(test)]
pub(super) fn all() -> impl Iterator<Item = &'static Template> {
    [
        ALL,
        acp::ALL,
        approvals::ALL,
        chat_turns::ALL,
        cloud_tasks::ALL,
        consent::ALL,
        context::ALL,
        import::ALL,
        notifications::ALL,
        providers::ALL,
        routing::ALL,
        voice::ALL,
    ]
    .into_iter()
    .flatten()
}
