use std::time::Duration;

use serde_json::json;

use super::*;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::broker::proposals::{CredentialRequest, CredentialUse, ProposalInput};
use crate::vault::broker::services::test_service;

fn audit_row(action: &str, outcome: &str, details: Value) -> AuditRow {
    AuditRow {
        seq: 1,
        at: "2026-01-01T00:00:00Z".into(),
        actor: AuditActor::system(),
        action: action.into(),
        outcome: outcome.into(),
        scope: None,
        scope_id: None,
        environment: Some("default".into()),
        path: None,
        name: None,
        details,
        request_id: None,
    }
}

fn proposal(services: &[&str], credentials: &[&str]) -> Proposal {
    Proposal {
        id: "bp_1".into(),
        environment: "prod".into(),
        status: ProposalStatus::Pending,
        message: "please add sk_live_should_never_leave_the_node".into(),
        services: services
            .iter()
            .map(|host| test_service("svc", host, None, "/"))
            .collect(),
        credentials: credentials
            .iter()
            .map(|reference| CredentialRequest {
                reference: (*reference).into(),
                description: String::new(),
                obtain_instructions: String::new(),
            })
            .collect(),
        requested_by: "broker_session:bvs_1".into(),
        created_at: 0,
        expires_at: 0,
        decided_by: None,
        decided_at: None,
        note: String::new(),
        credential_use: None,
    }
}

fn credential_use(subject: &str) -> Proposal {
    Proposal {
        credential_use: Some(CredentialUse {
            reference: "op://work@dev/GitHub/token".into(),
            account_id: "pma_1".into(),
            account: "work".into(),
            provider: "1password-connect".into(),
            subject: subject.into(),
        }),
        ..proposal(&[], &[])
    }
}

fn session(minted_by: &str) -> BrokerSession {
    BrokerSession {
        id: "bvs_1".into(),
        environment: "prod".into(),
        services: Vec::new(),
        label: String::new(),
        minted_by: minted_by.into(),
        created_at: 0,
        expires_at: 0,
        revoked_at: None,
        minted_token: None,
        minter_scope: None,
    }
}

#[test]
fn only_filed_proposals_and_pending_credential_uses_are_observed() {
    let filed = audit_row(
        "broker.proposal.create",
        "ok",
        json!({ "proposal": "bp_1" }),
    );
    assert_eq!(filed_proposal(&filed).as_deref(), Some("bp_1"));
    let pending = audit_row("pm.resolve", "pending", json!({ "approval": "bp_2" }));
    assert_eq!(filed_proposal(&pending).as_deref(), Some("bp_2"));
    // A resolved use, a refused filing, a decision, and an empty id are not.
    for row in [
        audit_row("pm.resolve", "ok", json!({ "approval": "bp_2" })),
        audit_row(
            "broker.proposal.create",
            "denied",
            json!({ "proposal": "bp_1" }),
        ),
        audit_row(
            "broker.proposal.approve",
            "ok",
            json!({ "proposal": "bp_1" }),
        ),
        audit_row("broker.proposal.create", "ok", json!({ "proposal": "" })),
    ] {
        assert_eq!(filed_proposal(&row), None, "{}", row.action);
    }
}

#[test]
fn a_proposal_notice_names_hosts_and_references_but_never_the_message() {
    let notice = notice(&proposal(&["api.linear.app"], &["secret:LINEAR"]));
    assert_eq!(notice.title, "Agent proposal waiting for approval");
    assert_eq!(
        notice.body,
        "An agent asks for 1 service (api.linear.app) and 1 credential (secret:LINEAR) in prod."
    );
    assert_eq!(notice.link, "/vault?tab=broker&proposal=bp_1");
    assert!(!notice.body.contains("sk_live"));
}

#[test]
fn long_lists_and_long_names_are_shortened() {
    let long = "a".repeat(200);
    let notice = notice(&proposal(&["one.test", "two.test", "three.test", &long], &[]));
    assert_eq!(
        notice.body,
        "An agent asks for 4 services (one.test, two.test, three.test, 1 more) in prod."
    );
    let notice = super::notice(&proposal(&[&long], &[]));
    assert!(notice.body.contains(&format!("{}…", "a".repeat(80))));
    assert!(!notice.body.contains(&"a".repeat(81)));
    let empty = super::notice(&proposal(&[], &[]));
    assert_eq!(empty.body, "An agent asks for a broker change in prod.");
}

#[test]
fn a_credential_use_notice_names_the_consumer_reference_and_account() {
    let notice = notice(&credential_use("broker:user:u1"));
    assert_eq!(notice.title, "Credential use waiting for approval");
    assert_eq!(
        notice.body,
        "A broker session minted by user:u1 asks to use op://work@dev/GitHub/token from the work account."
    );
    assert_eq!(notice.link, approval_link("bp_1"));
}

#[test]
fn the_recipient_is_the_person_behind_the_request() {
    assert_eq!(
        recipient(&credential_use("broker:user:u1"), None).as_deref(),
        Some("u1")
    );
    assert_eq!(
        recipient(&credential_use("runtime:github:user:u2"), None).as_deref(),
        Some("u2")
    );
    assert_eq!(
        recipient(&credential_use("read:operator"), None),
        None,
        "the operator has no user id"
    );
    let filed = proposal(&["api.test"], &[]);
    assert_eq!(
        recipient(&filed, Some(&session("user:u3"))).as_deref(),
        Some("u3")
    );
    assert_eq!(recipient(&filed, Some(&session("operator"))), None);
    assert_eq!(recipient(&filed, Some(&session("machine:m1"))), None);
    assert_eq!(recipient(&filed, None), None);
}

#[test]
fn each_proposal_notifies_once_and_memory_stays_bounded() {
    let mut remembered = Remembered::default();
    assert!(remembered.first_time("bp_1"));
    assert!(!remembered.first_time("bp_1"));
    for index in 0..REMEMBERED {
        assert!(remembered.first_time(&format!("bp_x{index}")));
    }
    assert_eq!(remembered.order.len(), REMEMBERED);
    assert_eq!(remembered.seen.len(), REMEMBERED);
    // The oldest id was forgotten, so it would notify again.
    assert!(remembered.first_time("bp_1"));
}

#[tokio::test]
async fn a_filed_proposal_raises_one_linked_notification() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let mut events = crate::events::subscribe();
    spawn(store);
    let mut input = ProposalInput::default();
    input.services = vec![test_service("notify-test", "notify.example.test", None, "/")];
    let filed = {
        let conn = store.conn.lock().await;
        proposals::create(&conn, input, "default", "machine:m1", "machine:m1").unwrap()
    };
    let entry = AuditEntry::new(&AuditActor::system(), "broker.proposal.create", "ok")
        .details(json!({ "proposal": filed.id }));
    // Filed twice (a retried audit append): one notification.
    store.audit(&entry).await;
    store.audit(&entry).await;
    let link = approval_link(&filed.id);
    let matching = |event: &crate::events::DesktopNotification| {
        event.link.as_deref() == Some(link.as_str())
    };
    let first = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if matching(&event) {
                return event;
            }
        }
    })
    .await
    .expect("a notification for the filed proposal");
    assert_eq!(first.title, "Agent proposal waiting for approval");
    assert!(first.body.unwrap_or_default().contains("notify.example.test"));
    // No second notification for the same proposal.
    let again = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            let event = events.recv().await.unwrap();
            if matching(&event) {
                return event;
            }
        }
    })
    .await;
    assert!(again.is_err(), "the proposal notified twice");
}

#[test]
fn the_unmatched_host_refusal_tells_the_agent_how_to_propose() {
    let hint = crate::vault::broker::proxy::proposal_hint("api.example.test");
    assert_eq!(hint["endpoint"], crate::vault::broker::proxy::PROPOSALS_ENDPOINT);
    assert_eq!(
        hint["cli"],
        "ryu-cli secrets broker propose --host api.example.test --message \"<why>\""
    );
    assert_eq!(hint["mcpTools"][1], "ryu_broker_propose");
}
