//! Every builder's wording travels as messages whose English rendering is the
//! stored English text, and renders in another locale without leaking ICU.

use super::super::text::render_wire;
use super::*;

/// The `i18n` messages render, in English, to exactly the stored text.
fn assert_round_trips(req: &ApprovalRequest) {
    let wire = req.i18n.as_ref().expect("builders attach i18n");
    let (title, question, summary) = render_wire(wire, "en").expect("well-formed i18n");
    assert_eq!(title, req.title);
    assert_eq!(question, req.question);
    assert_eq!(summary, req.summary);
    // Another locale renders every placeholder (English when untranslated).
    let (title, question, summary) = render_wire(wire, "ja").expect("renders in ja");
    for text in [Some(title), question, Some(summary)].into_iter().flatten() {
        assert!(!text.contains('{'), "unfilled placeholder in {text:?}");
    }
    assert_eq!(req.localized_title("en"), req.title);
}

fn tool_action() -> PendingAction {
    PendingAction::ToolCall {
        tool_id: "gmail.send_email".to_owned(),
        arguments: serde_json::json!({}),
        agent_id: None,
        allowlist: None,
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: None,
        composio_connection_scope: None,
        conversation_scope: None,
        configure_approved: false,
    }
}

#[test]
fn tool_call_card_keeps_its_english_and_carries_messages() {
    let req = ApprovalRequest::for_tool_call("gmail.send_email", Vec::new(), tool_action());
    assert_eq!(req.title, "Tool call: gmail.send_email");
    assert_eq!(
        req.summary,
        "An agent wants to run the tool \"gmail.send_email\", which is configured to require your approval before it executes."
    );
    assert_eq!(
        req.question.as_deref(),
        Some("Can I run \"gmail.send_email\" now?")
    );
    assert_round_trips(&req);
    let wire = req.i18n.as_ref().unwrap();
    assert_eq!(wire["title"]["message"], "Tool call: {tool}");
    // The tool id is a value, never translated.
    assert_eq!(wire["title"]["args"]["tool"], "gmail.send_email");
}

#[test]
fn app_send_card_shows_the_message_verbatim() {
    let req = ApprovalRequest::for_app_send("@ryu/notes", "Hello {there}", tool_action());
    assert_eq!(req.title, "@ryu/notes wants to send a message as you");
    assert_eq!(
        req.summary,
        "The @ryu/notes app is asking to post the message below to an agent on your behalf, which will spend usage on your account.\n\nHello {there}"
    );
    // The app's own text (braces and all) is verbatim, not a message.
    let wire = req.i18n.as_ref().unwrap();
    assert_eq!(wire["summary"][2]["text"], "Hello {there}");
    let rendered = render_wire(wire, "en").unwrap();
    assert_eq!(
        rendered,
        (req.title.clone(), req.question.clone(), req.summary.clone())
    );
}

#[test]
fn workflow_gate_shows_the_author_prompt_as_written() {
    let req = ApprovalRequest::for_workflow_gate("run_1", "Deploy", Some("Ship it?"));
    assert_eq!(req.title, "Workflow gate: Deploy");
    assert_eq!(req.summary, "Ship it?");
    assert_round_trips(&req);
    let req = ApprovalRequest::for_workflow_gate("run_1", "Deploy", None);
    assert_eq!(
        req.summary,
        "Workflow \"Deploy\" is paused, awaiting your approval to continue."
    );
    assert_round_trips(&req);
}

#[test]
fn skill_heal_and_exhausted_cards_keep_their_english() {
    let req = ApprovalRequest::for_skill_synthesis("s", "Digest", "", "c", String::new());
    assert_eq!(req.title, "Learned skill: Digest");
    assert!(req
        .summary
        .starts_with("Ryu distilled a reusable skill (\"Digest\")"));
    assert_round_trips(&req);
    let req =
        ApprovalRequest::for_skill_synthesis("s", "Digest", "Sums up mail.", "c", String::new());
    assert_eq!(
        req.summary,
        "Sums up mail.\n\nRyu distilled this reusable skill from one of your conversations. Approve to add it to your skill library."
    );
    assert_round_trips(&req);

    let req = ApprovalRequest::for_heal_fix("c", None, "a typo", "retry".to_owned());
    assert_eq!(req.title, "Auto-fix a failed run");
    assert_eq!(
        req.summary,
        "A run failed and Ryu proposed a fix. Diagnosis: a typo\n\nApprove to re-run it with the corrected instruction."
    );
    assert_round_trips(&req);
    let req = ApprovalRequest::for_heal_workflow("wf", "a timeout");
    assert_eq!(
        req.summary,
        "A workflow run failed and Ryu proposed a fix. Diagnosis: a timeout\n\nApprove to re-run the workflow."
    );
    assert_round_trips(&req);
    let req = ApprovalRequest::for_heal_exhausted("c", "Out of tries.");
    assert_eq!(req.title, "A failing run needs your attention");
    assert_eq!(
        req.summary,
        "Ryu tried to auto-fix a failed run but gave up. Out of tries."
    );
    assert_round_trips(&req);
    let req = ApprovalRequest::for_heal_exhausted_after("c", 3);
    assert_eq!(req.title, "A failing run needs your attention");
    assert_eq!(
        req.summary,
        "Ryu tried to auto-fix a failed run but gave up. Auto-fix attempts used: 3. Review it manually."
    );
    assert_eq!(req.source_ref.as_deref(), Some("heal-exhausted:c"));
    assert_round_trips(&req);
}

#[test]
fn tool_intent_replaces_the_wording_and_its_messages() {
    let mut req = ApprovalRequest::for_tool_call("agent_inbox.send", Vec::new(), tool_action());
    let intent = tool_intent::describe(
        "agent_inbox.send",
        &serde_json::json!({
            "to": ["a@example.com"],
            "cc": "c@example.com",
            "reply_to": "r@example.com",
            "subject": "Hi",
            "text": "Body",
        }),
        Some("Nova"),
        None,
    )
    .unwrap();
    req.apply_tool_intent(intent);
    assert_eq!(req.title, "Send email: Hi");
    assert_eq!(
        req.summary,
        "Nova wants to send an email.\nSend to: a@example.com\nCopy to: c@example.com\nReplies go to: r@example.com\nEmail subject: Hi\n\nBody"
    );
    assert_round_trips(&req);
    assert_eq!(
        req.i18n.as_ref().unwrap()["summary"][2]["message"],
        "Send to: {recipients}"
    );
}

#[test]
fn rows_without_messages_keep_their_stored_title() {
    let mut req = ApprovalRequest::new(
        ApprovalKind::TriggerRun,
        "Stored".to_owned(),
        "s".to_owned(),
        None,
    );
    assert_eq!(req.localized_title("ja"), "Stored");
    req.i18n = Some(serde_json::json!({ "title": { "args": {} } }));
    assert_eq!(req.localized_title("ja"), "Stored");
    // A row from before `i18n` existed deserializes without it.
    let mut legacy = serde_json::to_value(&req).unwrap();
    legacy.as_object_mut().unwrap().remove("i18n");
    let legacy: ApprovalRequest = serde_json::from_value(legacy).unwrap();
    assert!(legacy.i18n.is_none());
}
