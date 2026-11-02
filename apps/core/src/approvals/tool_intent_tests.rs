//! Tests of the tool-intent card wording.

use serde_json::json;

use super::*;

#[test]
fn claim_names_the_exact_resolved_address_and_permanence() {
    let intent = describe(
        "agent_inbox.claim_email_alias",
        &json!({ "local_part": "Sales" }),
        Some("Nova"),
        Some("sales@acme.mail.example"),
    )
    .unwrap();
    assert_eq!(intent.question, "Claim sales@acme.mail.example for Nova?");
    assert_eq!(
        intent.summary,
        "Claim sales@acme.mail.example for Nova? Agent email addresses are permanent and never reissued."
    );
    assert_eq!(intent.title, "Claim email address: sales@acme.mail.example");
}

#[test]
fn claim_without_resolution_uses_the_folded_local_part() {
    let intent = describe(
        "agent_inbox.claim_email_alias",
        &json!({ "local_part": "  Sales Team " }),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert_eq!(
        intent.question,
        "Claim sales-team@(your organization's agent mail host) for Nova?"
    );
    assert!(intent.summary.ends_with(ALIAS_PERMANENCE));
}

#[test]
fn claim_defaults_to_display_name_then_agent_name() {
    let by_display = describe(
        "agent_inbox.claim_email_alias",
        &json!({ "display_name": "Front Desk" }),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert!(by_display.question.starts_with("Claim front-desk@"));
    let by_agent = describe(
        "agent_inbox.claim_email_alias",
        &json!({}),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert!(by_agent.question.starts_with("Claim nova@"));
}

#[test]
fn deprecated_create_ignores_display_name_and_still_states_permanence() {
    let intent = describe(
        "agent_inbox.create",
        &json!({ "display_name": "Front Desk" }),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert!(
        intent.question.starts_with("Claim nova@"),
        "{}",
        intent.question
    );
    assert!(intent.summary.contains(ALIAS_PERMANENCE));
}

#[test]
fn claim_with_nothing_to_name_still_states_permanence() {
    let intent = describe("agent_inbox.claim_email_alias", &json!({}), None, None).unwrap();
    assert_eq!(intent.question, "Claim an email address for this agent?");
    assert!(intent.summary.contains(ALIAS_PERMANENCE));
    let unusable = describe(
        "agent_inbox.claim_email_alias",
        &json!({ "local_part": "!!!" }),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert_eq!(unusable.question, "Claim an email address for Nova?");
}

#[test]
fn send_lists_recipients_subject_and_a_bounded_body() {
    // A short harmless opening cannot hide what follows it.
    let ordinary = format!("Hi there.\n{}", "y".repeat(500));
    let shown = describe(
        "agent_inbox.send",
        &json!({ "to": ["a@example.com"], "subject": "Hi", "text": ordinary }),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert!(shown.summary.ends_with(&ordinary));

    let body = "x".repeat(BODY_PREVIEW_CHARS + 50);
    let intent = describe(
        "agent_inbox.send",
        &json!({
            "to": ["a@example.com", "b@example.com"],
            "cc": ["c@example.com"],
            "subject": "Quarterly numbers",
            "text": body,
        }),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert_eq!(
        intent.question,
        "Send \"Quarterly numbers\" to a@example.com, b@example.com?"
    );
    assert!(intent
        .summary
        .contains("Send to: a@example.com, b@example.com"));
    assert!(intent.summary.contains("Copy to: c@example.com"));
    assert!(intent.summary.contains("Email subject: Quarterly numbers"));
    assert!(intent
        .summary
        .ends_with("50 more characters of the message are not shown here."));
    assert!(!intent.summary.contains(&body));
    assert_eq!(intent.title, "Send email: Quarterly numbers");
}

#[test]
fn send_shows_reply_to_so_replies_cannot_be_redirected_unseen() {
    let intent = describe(
        "agent_inbox.send",
        &json!({
            "to": ["buyer@example.com"],
            "subject": "Your quote",
            "text": "Attached.",
            "reply_to": "attacker@evil.example",
        }),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert!(intent
        .summary
        .contains("Replies go to: attacker@evil.example"));
    let without = describe(
        "agent_inbox.send",
        &json!({"to": ["buyer@example.com"], "subject": "Your quote"}),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert!(!without.summary.contains("Replies go to"));
}

#[test]
fn send_summarizes_long_recipient_lists() {
    let to: Vec<String> = (0..RECIPIENTS_SHOWN + 3)
        .map(|index| format!("r{index}@example.com"))
        .collect();
    let intent = describe(
        "agent_inbox.send",
        &json!({ "to": to, "subject": "Hi" }),
        None,
        None,
    )
    .unwrap();
    assert!(
        intent.question.contains("and 3 more"),
        "{}",
        intent.question
    );
    assert!(intent
        .summary
        .starts_with("An agent wants to send an email."));
}

#[test]
fn reply_names_who_receives_it() {
    let intent = describe(
        "agent_inbox.reply",
        &json!({ "message_id": "msg_1", "text": "Thanks!", "reply_all": true }),
        Some("Nova"),
        None,
    )
    .unwrap();
    assert_eq!(
        intent.question,
        "Send this reply to the sender and everyone else on the message?"
    );
    assert!(intent.summary.contains("msg_1"));
    assert!(intent.summary.ends_with("Thanks!"));
}

#[test]
fn other_tools_keep_the_generic_card() {
    assert_eq!(describe("agent_inbox.get", &json!({}), None, None), None);
    assert_eq!(describe("gmail.send_email", &json!({}), None, None), None);
    assert_eq!(describe("send", &json!({}), None, None), None);
}

#[test]
fn checked_address_accepts_only_a_successful_full_address() {
    assert_eq!(
        checked_address(&json!({ "ok": true, "address": "sales@acme.mail.example" })),
        Some("sales@acme.mail.example".to_owned())
    );
    assert_eq!(
        checked_address(&json!({ "ok": false, "address": "sales@acme.mail.example" })),
        None
    );
    assert_eq!(
        checked_address(&json!({ "ok": true, "address": "sales" })),
        None
    );
}

#[tokio::test]
async fn resolve_without_a_cloud_node_falls_back_to_the_local_part() {
    let intent = resolve(
        "agent_inbox.claim_email_alias",
        &json!({ "local_part": "sales" }),
        Some("agent_without_node"),
    )
    .await
    .unwrap();
    assert!(
        intent
            .question
            .starts_with("Claim sales@(your organization's agent mail host)"),
        "{}",
        intent.question
    );
}
