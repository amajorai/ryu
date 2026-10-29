//! Core-side activity glue.
//!
//! The activity **primitive** (the [`ryu_activity::ActivityItem`] contract and the
//! SQLite-backed [`ryu_activity::ActivityStore`]) lives in the extracted
//! `ryu-activity` crate. What stays here is [`ingest`] — the per-engine event
//! *mappers* and their subscribe-loops — because they consume Core types
//! (monitors/approvals/meetings/quests) and cannot move into the crate without it
//! depending back on `apps/core`.

pub mod ingest;
pub mod sealed_store;

/// Whether a feed item carries approval content: the request's title, summary,
/// agent, and conversation (see [`ingest::from_approval_event`]). Such items are
/// shown only to a caller who holds `approvals.view`; every other reader of the
/// shared feed gets the feed without them. Matches on either field, ignoring
/// case, so an item recorded by another writer under the same labels is held
/// back too.
pub fn is_approval_derived(item: &ryu_activity::ActivityItem) -> bool {
    item.source.eq_ignore_ascii_case("approvals") || item.kind.eq_ignore_ascii_case("approval")
}

/// Drop approval-derived items unless the reader may view approvals.
pub fn visible_items(
    items: Vec<ryu_activity::ActivityItem>,
    may_view_approvals: bool,
) -> Vec<ryu_activity::ActivityItem> {
    if may_view_approvals {
        return items;
    }
    items
        .into_iter()
        .filter(|item| !is_approval_derived(item))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_activity::ActivityItem;

    fn approval_item() -> ActivityItem {
        let event = crate::approvals::ApprovalEvent::Created {
            request: crate::approvals::ApprovalRequest::for_scheduled_job(
                &crate::scheduler::store::ScheduledJob {
                    id: "job".to_owned(),
                    name: "secret routine".to_owned(),
                    schedule: crate::scheduler::store::Schedule::Every {
                        interval: "1h".to_owned(),
                    },
                    target: crate::scheduler::store::JobTarget::Agent {
                        agent_id: "a".to_owned(),
                        prompt: "p".to_owned(),
                        model: None,
                        conversation_id: None,
                    },
                    enabled: true,
                    require_approval: true,
                    owner_app: None,
                    owner_user_id: None,
                    org_id: None,
                    created_at: "t".to_owned(),
                    updated_at: "t".to_owned(),
                    last_run_at: None,
                    last_outcome: None,
                    history: Vec::new(),
                },
            ),
        };
        ingest::from_approval_event(&event)
    }

    #[test]
    fn ingested_approval_events_are_approval_derived() {
        assert!(is_approval_derived(&approval_item()));
        assert!(is_approval_derived(&ActivityItem::new(
            "Approval", "manual", "x"
        )));
        assert!(is_approval_derived(&ActivityItem::new(
            "note",
            "Approvals",
            "x"
        )));
        assert!(!is_approval_derived(&ActivityItem::new(
            "monitor_alert",
            "monitors",
            "x"
        )));
    }

    #[test]
    fn approval_items_are_withheld_from_readers_without_approvals_view() {
        let items = vec![
            approval_item(),
            ActivityItem::new("monitor_alert", "monitors", "disk full"),
        ];
        let hidden = visible_items(items.clone(), false);
        assert_eq!(hidden.len(), 1);
        assert_eq!(hidden[0].source, "monitors");
        assert_eq!(visible_items(items, true).len(), 2);
    }
}
