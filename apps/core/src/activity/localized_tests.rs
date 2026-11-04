//! Unit tests for the localized approval activity rows.

use super::*;
use crate::approvals::ApprovalEvent;

fn gate(status: ApprovalStatus) -> ApprovalRequest {
    let mut request = ApprovalRequest::for_workflow_gate("run_1", "nightly", None);
    request.status = status;
    request
}

const DECIDED: [(ApprovalStatus, &str); 4] = [
    (
        ApprovalStatus::Approved,
        "Request approved: Workflow gate: nightly",
    ),
    (
        ApprovalStatus::Rejected,
        "Request rejected: Workflow gate: nightly",
    ),
    (
        ApprovalStatus::Expired,
        "Request expired without a decision: Workflow gate: nightly",
    ),
    (
        ApprovalStatus::Cancelled,
        "Request cancelled: Workflow gate: nightly",
    ),
];

#[test]
fn a_raised_request_is_shown_under_its_own_title_in_the_node_locale() {
    let request = gate(ApprovalStatus::Pending);
    let (title, body) = approval_activity_text(&request, "en");
    assert_eq!(title, "Workflow gate: nightly");
    assert_eq!(
        body,
        "Workflow \"nightly\" is paused, awaiting your approval to continue."
    );
    let (title, body) = approval_activity_text(&request, "ja");
    assert_eq!(title, "ワークフローの承認ゲート: nightly");
    assert_eq!(
        body,
        "ワークフロー「nightly」は一時停止中で、続行の承認を待っています。"
    );
}

#[test]
fn each_decided_status_is_one_whole_sentence_per_locale() {
    for (status, english) in DECIDED {
        let request = gate(status);
        let (title, _) = approval_activity_text(&request, "en");
        assert_eq!(title, english, "{status:?}");
        let (japanese, body) = approval_activity_text(&request, "ja");
        assert_ne!(japanese, english, "{status:?}");
        assert!(
            japanese.contains("ワークフローの承認ゲート: nightly"),
            "{japanese}"
        );
        assert!(!japanese.contains("Approval "), "{japanese}");
        assert!(body.starts_with("ワークフロー"), "{body}");
    }
}

#[test]
fn an_unknown_locale_or_a_row_without_messages_falls_back_to_english() {
    for (status, english) in DECIDED {
        let (title, _) = approval_activity_text(&gate(status), "xx-unknown");
        assert_eq!(title, english);
    }
    let mut legacy = gate(ApprovalStatus::Approved);
    legacy.i18n = None;
    legacy.title = "Legacy title".to_owned();
    legacy.summary = "Legacy summary".to_owned();
    let (title, body) = approval_activity_text(&legacy, "en");
    assert_eq!(title, "Request approved: Legacy title");
    assert_eq!(body, "Legacy summary");
    let (title, body) = approval_activity_text(&legacy, "ja");
    assert!(title.contains("Legacy title"), "{title}");
    assert_eq!(body, "Legacy summary");
}

#[test]
fn the_ingested_feed_row_uses_the_localized_wording() {
    let request = gate(ApprovalStatus::Rejected);
    let event = ApprovalEvent::Decided { request };
    let item = super::super::ingest::from_approval_event(&event, "en");
    assert_eq!(item.title, "Request rejected: Workflow gate: nightly");
    assert_eq!(item.level, ryu_activity::ActivityLevel::Warning);
    let item = super::super::ingest::from_approval_event(&event, "ja");
    assert_eq!(
        item.title,
        approval_activity_text(&gate(ApprovalStatus::Rejected), "ja").0
    );
    // A raised request is always still pending when Core emits `Created`.
    let created = ApprovalEvent::Created {
        request: gate(ApprovalStatus::Pending),
    };
    let item = super::super::ingest::from_approval_event(&created, "ja");
    assert_eq!(item.title, "ワークフローの承認ゲート: nightly");
}
