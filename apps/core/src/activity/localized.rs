//! The wording of approval rows in the activity feed, in the node's language.
//!
//! An approval row is written once, when the request is raised or decided, so
//! it is rendered in the node's `ui-language` at that moment (like the inbox
//! copy of an alert). The request's own title and summary come from its
//! `i18n` messages when it has them, else the stored English; a decided row
//! wraps the title in one whole sentence per outcome, so no status word is
//! spliced in front of it.

use crate::approvals::{ApprovalRequest, ApprovalStatus};
use crate::i18n::{messages, Message, Template};

/// The feed title and body of `request` in `locale`.
pub fn approval_activity_text(request: &ApprovalRequest, locale: &str) -> (String, String) {
    let title = request.localized_title(locale);
    let summary = localized_summary(request, locale);
    let title = match status_template(request.status) {
        Some(template) => Message::new(template).text("title", title).render(locale),
        // A pending request (the "raised" row) is shown under its own title.
        None => title,
    };
    (title, summary)
}

/// The whole-sentence message for a decided `status`; `None` while pending.
fn status_template(status: ApprovalStatus) -> Option<Template> {
    match status {
        ApprovalStatus::Approved => Some(messages::APPROVAL_ACTIVITY_APPROVED_MESSAGE),
        ApprovalStatus::Rejected => Some(messages::APPROVAL_ACTIVITY_REJECTED_MESSAGE),
        ApprovalStatus::Expired => Some(messages::APPROVAL_ACTIVITY_EXPIRED_MESSAGE),
        ApprovalStatus::Cancelled => Some(messages::APPROVAL_ACTIVITY_CANCELLED_MESSAGE),
        ApprovalStatus::Pending => None,
    }
}

/// The summary in `locale`: the request's messages when they render, else the
/// stored English.
fn localized_summary(request: &ApprovalRequest, locale: &str) -> String {
    request
        .i18n
        .as_ref()
        .and_then(|wire| crate::approvals::text::render_wire(wire, locale))
        .map_or_else(|| request.summary.clone(), |(_, _, summary)| summary)
}

#[cfg(test)]
#[path = "localized_tests.rs"]
mod tests;
