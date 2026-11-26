use super::super::channel_settings::CHANNEL_DECIDERS_PREF;
use super::super::store::ApprovalStore;
use super::*;
use crate::sidecar::control_plane::with_test_node_binding;

const CONNECTION: &str = "chan_1";
const CONVERSATION: &str = "conv-1";
const OWNER_CHAT: &str = "111";

struct Fixture {
    engine: ApprovalEngine,
    _directory: tempfile::TempDir,
}

/// An engine whose connection lets Telegram account `111`, linked to
/// `user-1`, decide from chat.
async fn fixture() -> Fixture {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let preferences =
        crate::server::preferences::PreferencesStore::open(directory.path().join("preferences.db"))
            .unwrap();
    let engine = ApprovalEngine::new(
        ApprovalStore::open_in_memory().unwrap(),
        reqwest::Client::new(),
    )
    .with_preferences(preferences);
    engine
        .save_channel_approval_settings(
            CONNECTION,
            true,
            &[("telegram".to_owned(), OWNER_CHAT.to_owned())],
            "user-1",
        )
        .await
        .unwrap();
    Fixture {
        engine,
        _directory: directory,
    }
}

fn tool_request(tool: &str, tags: &[&str]) -> ApprovalRequest {
    let action = PendingAction::ToolCall {
        tool_id: tool.to_owned(),
        arguments: serde_json::json!({ "to": "secret-recipient@example.com" }),
        agent_id: None,
        allowlist: None,
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: Some(CONVERSATION.to_owned()),
        composio_connection_scope: None,
        conversation_scope: None,
        configure_approved: false,
    };
    ApprovalRequest::for_tool_call(
        tool,
        tags.iter().map(|tag| (*tag).to_owned()).collect(),
        action,
    )
}

async fn raise(engine: &ApprovalEngine, tool: &str, tags: &[&str]) -> ApprovalRequest {
    engine.request(tool_request(tool, tags)).await.unwrap()
}

async fn one_prompt(engine: &ApprovalEngine) -> ChannelApprovalPrompt {
    let mut prompts = engine
        .channel_approval_prompts(CONNECTION, CONVERSATION, "en")
        .await;
    assert_eq!(prompts.len(), 1, "one waiting approval gives one prompt");
    prompts.remove(0)
}

fn press(token: &str, approve: bool, sender: &str) -> ChannelPress {
    ChannelPress {
        token: token.to_owned(),
        approve,
        connection: CONNECTION.to_owned(),
        conversation_id: CONVERSATION.to_owned(),
        platform: "telegram".to_owned(),
        sender_id: sender.to_owned(),
    }
}

async fn status_of(engine: &ApprovalEngine, id: &str) -> ApprovalStatus {
    engine.store.get(id).await.unwrap().unwrap().status
}

/// Run on an unbound, unmanaged node: any linked user may decide.
async fn unbound<F: std::future::Future>(fut: F) -> F::Output {
    with_test_node_binding(false, None, fut).await
}

#[tokio::test]
async fn an_approve_press_by_the_linked_account_decides_the_approval() {
    unbound(async {
        let fixture = fixture().await;
        let req = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        let prompt = one_prompt(&fixture.engine).await;
        assert_eq!(prompt.tool_name, "gmail.send_email");
        assert_eq!(prompt.token.len(), 32);
        assert!(prompt.token.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(prompt.token, req.id.trim_start_matches("appr_"));
        let wire = serde_json::to_string(&prompt).unwrap();
        assert!(!wire.contains("secret-recipient"), "no arguments: {wire}");
        assert!(!wire.contains(&req.id), "no approval id: {wire}");

        let decision = fixture
            .engine
            .decide_from_channel(&press(&prompt.token, true, OWNER_CHAT))
            .await;
        assert_eq!(decision.outcome, ChannelOutcome::Decided);
        assert_eq!(decision.status, Some(ApprovalStatus::Approved));
        let stored = fixture.engine.store.get(&req.id).await.unwrap().unwrap();
        assert_eq!(stored.status, ApprovalStatus::Approved);
        assert_eq!(stored.note.as_deref(), Some("chat:telegram"));
    })
    .await;
}

#[tokio::test]
async fn a_deny_press_rejects_the_approval() {
    unbound(async {
        let fixture = fixture().await;
        let req = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        let prompt = one_prompt(&fixture.engine).await;
        let decision = fixture
            .engine
            .decide_from_channel(&press(&prompt.token, false, OWNER_CHAT))
            .await;
        assert_eq!(decision.outcome, ChannelOutcome::Decided);
        assert_eq!(decision.status, Some(ApprovalStatus::Rejected));
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Rejected
        );
    })
    .await;
}

#[tokio::test]
async fn a_press_by_an_account_that_is_not_named_changes_nothing() {
    unbound(async {
        let fixture = fixture().await;
        let req = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        let prompt = one_prompt(&fixture.engine).await;
        for (platform, sender) in [("telegram", "999"), ("slack", OWNER_CHAT)] {
            let mut stranger = press(&prompt.token, true, sender);
            stranger.platform = platform.to_owned();
            let decision = fixture.engine.decide_from_channel(&stranger).await;
            assert_eq!(decision.outcome, ChannelOutcome::Refused);
            assert_eq!(decision.reason, "not_linked");
            assert_eq!(decision.status, None, "a stranger learns no state");
        }
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Pending
        );
    })
    .await;
}

#[tokio::test]
async fn a_linked_user_who_may_no_longer_decide_is_refused() {
    // Managed node with no organization binding: Core refuses every caller.
    with_test_node_binding(true, None, async {
        let fixture = fixture().await;
        let req = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        let prompt = one_prompt(&fixture.engine).await;
        let decision = fixture
            .engine
            .decide_from_channel(&press(&prompt.token, true, OWNER_CHAT))
            .await;
        assert_eq!(decision.outcome, ChannelOutcome::Refused);
        assert_eq!(decision.reason, "not_permitted");
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Pending
        );
    })
    .await;
}

#[test]
fn the_linked_user_is_checked_against_the_node_binding() {
    use ApprovalPushAudience::{Members, Nobody, Owner, Unbound};
    assert_eq!(audience_verdict(&Unbound, "user-1"), Some(true));
    assert_eq!(audience_verdict(&Nobody, "user-1"), Some(false));
    assert_eq!(
        audience_verdict(&Owner(Some("user-1".to_owned())), "user-1"),
        Some(true)
    );
    assert_eq!(
        audience_verdict(&Owner(Some("user-2".to_owned())), "user-1"),
        Some(false)
    );
    assert_eq!(audience_verdict(&Owner(None), "user-1"), Some(false));
    // Organization and team nodes ask the control plane.
    assert_eq!(audience_verdict(&Members, "user-1"), None);
}

#[tokio::test]
async fn a_second_press_reports_the_first_decision_and_changes_nothing() {
    unbound(async {
        let fixture = fixture().await;
        let req = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        let prompt = one_prompt(&fixture.engine).await;
        let first = fixture
            .engine
            .decide_from_channel(&press(&prompt.token, true, OWNER_CHAT))
            .await;
        assert_eq!(first.outcome, ChannelOutcome::Decided);
        for approve in [true, false] {
            let again = fixture
                .engine
                .decide_from_channel(&press(&prompt.token, approve, OWNER_CHAT))
                .await;
            assert_eq!(again.outcome, ChannelOutcome::AlreadyDecided);
            assert_eq!(again.status, Some(ApprovalStatus::Approved));
        }
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Approved
        );
    })
    .await;
}

#[tokio::test]
async fn a_press_after_the_app_decided_reports_the_app_decision() {
    unbound(async {
        let fixture = fixture().await;
        let req = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        let prompt = one_prompt(&fixture.engine).await;
        fixture.engine.decide(&req.id, false, None, None).await.unwrap();
        let decision = fixture
            .engine
            .decide_from_channel(&press(&prompt.token, true, OWNER_CHAT))
            .await;
        assert_eq!(decision.outcome, ChannelOutcome::AlreadyDecided);
        assert_eq!(decision.status, Some(ApprovalStatus::Rejected));
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Rejected
        );
    })
    .await;
}

#[tokio::test]
async fn an_expired_approval_is_not_decided() {
    unbound(async {
        let fixture = fixture().await;
        let mut request = tool_request("gmail.send_email", &["send"]);
        request.expires_at = Some("2000-01-01T00:00:00+00:00".to_owned());
        let req = fixture.engine.request(request).await.unwrap();
        let prompt = one_prompt(&fixture.engine).await;

        // Past its time but not swept yet: the press must not approve it.
        let early = fixture
            .engine
            .decide_from_channel(&press(&prompt.token, true, OWNER_CHAT))
            .await;
        assert_eq!(early.outcome, ChannelOutcome::AlreadyDecided);
        assert_eq!(early.status, Some(ApprovalStatus::Expired));
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Pending
        );

        assert_eq!(fixture.engine.sweep_expired().await.unwrap(), 1);
        let late = fixture
            .engine
            .decide_from_channel(&press(&prompt.token, true, OWNER_CHAT))
            .await;
        assert_eq!(late.outcome, ChannelOutcome::AlreadyDecided);
        assert_eq!(late.status, Some(ApprovalStatus::Expired));
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Expired
        );
    })
    .await;
}

#[tokio::test]
async fn nothing_is_offered_or_decided_while_the_setting_is_off() {
    unbound(async {
        let fixture = fixture().await;
        let req = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        // A connection nobody turned on gets no prompt.
        assert!(fixture
            .engine
            .channel_approval_prompts("chan_other", CONVERSATION, "en")
            .await
            .is_empty());
        let prompt = one_prompt(&fixture.engine).await;

        // Turned off after the buttons were posted: the press is refused.
        fixture
            .engine
            .save_channel_approval_settings(
                CONNECTION,
                false,
                &[("telegram".to_owned(), OWNER_CHAT.to_owned())],
                "user-1",
            )
            .await
            .unwrap();
        let decision = fixture
            .engine
            .decide_from_channel(&press(&prompt.token, true, OWNER_CHAT))
            .await;
        assert_eq!(decision.outcome, ChannelOutcome::Refused);
        assert_eq!(decision.reason, "setting_off");
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Pending
        );
        let second = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        assert!(fixture
            .engine
            .channel_approval_prompts(CONNECTION, CONVERSATION, "en")
            .await
            .is_empty());
        assert_eq!(
            status_of(&fixture.engine, &second.id).await,
            ApprovalStatus::Pending
        );
    })
    .await;
}

#[tokio::test]
async fn a_token_only_works_where_it_was_posted() {
    unbound(async {
        let fixture = fixture().await;
        let req = raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        let prompt = one_prompt(&fixture.engine).await;

        let mut other_connection = press(&prompt.token, true, OWNER_CHAT);
        other_connection.connection = "chan_other".to_owned();
        let mut other_conversation = press(&prompt.token, true, OWNER_CHAT);
        other_conversation.conversation_id = "conv-2".to_owned();
        for moved in [other_connection, other_conversation] {
            let decision = fixture.engine.decide_from_channel(&moved).await;
            assert_eq!(decision.outcome, ChannelOutcome::Refused);
            assert_eq!(decision.reason, "wrong_place");
        }
        // The approval id is not a token, and neither is a guess.
        for forged in [req.id.as_str(), "0123456789abcdef0123456789abcdef"] {
            let decision = fixture
                .engine
                .decide_from_channel(&press(forged, true, OWNER_CHAT))
                .await;
            assert_eq!(decision.outcome, ChannelOutcome::Expired);
        }
        assert_eq!(
            status_of(&fixture.engine, &req.id).await,
            ApprovalStatus::Pending
        );
    })
    .await;
}

#[tokio::test]
async fn an_approval_is_prompted_once_and_only_in_its_own_conversation() {
    unbound(async {
        let fixture = fixture().await;
        raise(&fixture.engine, "gmail.send_email", &["send"]).await;
        assert!(fixture
            .engine
            .channel_approval_prompts(CONNECTION, "conv-2", "en")
            .await
            .is_empty());
        one_prompt(&fixture.engine).await;
        assert!(fixture
            .engine
            .channel_approval_prompts(CONNECTION, CONVERSATION, "en")
            .await
            .is_empty());
    })
    .await;
}

#[tokio::test]
async fn app_only_approvals_are_never_offered_or_decided_from_chat() {
    unbound(async {
        let fixture = fixture().await;
        let cases: [(&str, &[&str]); 7] = [
            ("agent_inbox.send_email", &["send"]),
            ("ryu_api.put_preferences", &["core-api-mutation"]),
            ("agent_builder.configure_agent", &["agent-configuration"]),
            ("stripe.create_payment", &["pay"]),
            (
                "web.extract",
                &["agent-gated", crate::approvals::HELD_EGRESS_TAG],
            ),
            ("vault.reveal_item", &["manual-mode"]),
            ("ryu.gateway.budget.set", &["governance-mutation"]),
        ];
        for (tool, tags) in cases {
            let req = raise(&fixture.engine, tool, tags).await;
            assert!(app_only(&req), "{tool} stays in the app");
            assert!(fixture
                .engine
                .channel_approval_prompts(CONNECTION, CONVERSATION, "en")
                .await
                .is_empty());
            // Even a token for it (which Core never issues) decides nothing.
            let token = mint(&req.id, CONNECTION, CONVERSATION);
            let decision = fixture
                .engine
                .decide_from_channel(&press(&token, true, OWNER_CHAT))
                .await;
            assert_eq!(decision.outcome, ChannelOutcome::Refused, "{tool}");
            assert_eq!(decision.reason, "app_only");
            assert_eq!(
                status_of(&fixture.engine, &req.id).await,
                ApprovalStatus::Pending
            );
        }

        // Kinds other than a tool call are app-only too.
        let workflow = ApprovalRequest::for_workflow_gate("run-1", "Publish", None);
        assert!(app_only(&workflow));
        assert!(!app_only(&tool_request("gmail.send_email", &["send"])));
    })
    .await;
}

#[tokio::test]
async fn the_stored_setting_holds_no_chat_account_id() {
    unbound(async {
        let fixture = fixture().await;
        let raw = fixture
            .engine
            .preferences
            .as_ref()
            .unwrap()
            .get(CHANNEL_DECIDERS_PREF)
            .await
            .unwrap()
            .unwrap();
        assert!(raw.contains("user-1"));
        assert!(!raw.contains(&format!("\"{OWNER_CHAT}\"")), "{raw}");
    })
    .await;
}

#[test]
fn the_summary_is_one_short_line() {
    assert_eq!(short_summary("Send  an\nemail"), "Send an email");
    let long = "x".repeat(SUMMARY_CHARS + 40);
    let cut = short_summary(&long);
    assert_eq!(cut.chars().count(), SUMMARY_CHARS + 1);
    assert!(cut.ends_with('…'));
}
