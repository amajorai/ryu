//! Recall marks are paid at the turn's finish, not at dispatch: a turn that
//! fails leaves every recalled fact's `recall_count` untouched, and a turn that
//! completes bumps it. Covered on both finishes — the shared reply persister
//! (OpenAI-compatible, local-engine, SDK-app and A2A planes) and the ACP
//! completion task.

use super::*;

const CONVERSATION: &str = "recall-finish";

async fn one_fact() -> (MemoryStore, String) {
    let memory = MemoryStore::open_in_memory().unwrap();
    let id = memory
        .record(LOCAL_USER, "default", "prefers metric units")
        .await
        .unwrap()
        .unwrap();
    (memory, id)
}

async fn conversation_store() -> ConversationStore {
    let conversations = ConversationStore::open_in_memory().unwrap();
    conversations
        .ensure_conversation(
            CONVERSATION,
            None,
            None,
            Tenancy::Owned {
                user_id: LOCAL_USER.to_owned(),
                org_id: None,
            },
        )
        .await
        .unwrap();
    conversations
}

async fn recall_count(memory: &MemoryStore, id: &str) -> i64 {
    memory.get(id).await.unwrap().unwrap().recall_count
}

/// The persister pays its marks off the reply's path; wait for them to land.
async fn wait_for_recall_count(memory: &MemoryStore, id: &str, expected: i64) {
    for _ in 0..500 {
        if recall_count(memory, id).await == expected {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("recall_count never reached {expected}");
}

async fn run_status(conversations: &ConversationStore) -> Option<String> {
    conversations
        .get_run_summary(CONVERSATION)
        .await
        .unwrap()
        .and_then(|summary| summary.run_status)
}

#[tokio::test]
async fn only_a_completed_outcome_pays_the_marks() {
    let (memory, id) = one_fact().await;
    let marks = TurnRecallMarks::new(&memory, vec![id.clone()]);

    marks.clone().settle("failed").await;
    assert_eq!(recall_count(&memory, &id).await, 0);

    marks.settle("completed").await;
    let entry = memory.get(&id).await.unwrap().unwrap();
    assert_eq!(entry.recall_count, 1);
    assert!(entry.last_recalled_at.is_some());
}

#[tokio::test]
async fn the_reply_persister_marks_recall_only_for_a_completed_turn() {
    let (memory, id) = one_fact().await;
    let conversations = conversation_store().await;
    let persister = |marks: TurnRecallMarks| {
        turn_reply_persister(
            conversations.clone(),
            Some(CONVERSATION.to_owned()),
            None,
            Vec::new(),
            None,
            marks,
        )
    };

    // A turn that fails mid-stream still persists what it streamed...
    let failed = persister(TurnRecallMarks::new(&memory, vec![id.clone()]));
    assert!(failed("half an ans".into(), "failed", Vec::new())
        .await
        .is_some());
    assert_eq!(run_status(&conversations).await.as_deref(), Some("failed"));
    // ...but the facts it recalled are not counted as used.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(recall_count(&memory, &id).await, 0);

    let completed = persister(TurnRecallMarks::new(&memory, vec![id.clone()]));
    assert!(
        completed("the whole answer".into(), "completed", Vec::new())
            .await
            .is_some()
    );
    assert_eq!(
        run_status(&conversations).await.as_deref(),
        Some("completed")
    );
    wait_for_recall_count(&memory, &id, 1).await;
}

/// Drive the detached ACP completion task over `events`, to its end.
async fn run_acp_turn(
    conversations: &ConversationStore,
    marks: TurnRecallMarks,
    events: Vec<acp::AcpEvent>,
) {
    let (acp_tx, acp_rx) = tokio::sync::mpsc::unbounded_channel();
    for event in events {
        acp_tx.send(event).unwrap();
    }
    drop(acp_tx);
    let (ui_tx, _ui_rx) = tokio::sync::mpsc::unbounded_channel();
    run_acp_completion(AcpCompletionCtx {
        worktree_guard: None,
        conversation_id: Some(CONVERSATION.to_owned()),
        traces: TraceStore::open_in_memory().unwrap(),
        live_stream: None,
        ui_tx,
        agent_id: "codex".to_owned(),
        memory_citations: Vec::new(),
        agent_control_applied: None,
        compaction_summary: None,
        acp_rx,
        persist_store: conversations.clone(),
        persist_conversation_id: Some(CONVERSATION.to_owned()),
        persist_agent_id: None,
        watch: crate::routing_policy::reactive::TurnWatch::off(),
        watch_model: None,
        history_turn: crate::usage_history::live::TurnHistory::new(
            "codex",
            None,
            None,
            Some(CONVERSATION.to_owned()),
        ),
        conversation_generation: None,
        cwd: std::env::temp_dir(),
        harness_session_id: None,
        cost_attribution: None,
        plugin_flags: std::collections::HashMap::new(),
        worktree_diffs: crate::server::WorktreeDiffStore::default(),
        recall_marks: marks,
        device_offer: None,
    })
    .await;
}

#[tokio::test]
async fn an_acp_turn_that_errors_leaves_recall_untouched() {
    let (memory, id) = one_fact().await;
    let conversations = conversation_store().await;
    let failure = acp::AcpFailure {
        code: "agent_error".to_owned(),
        title: "The agent failed".to_owned(),
        message: "connection lost".to_owned(),
        i18n: None,
    };
    run_acp_turn(
        &conversations,
        TurnRecallMarks::new(&memory, vec![id.clone()]),
        vec![
            acp::AcpEvent::Text("half an ans".to_owned()),
            acp::AcpEvent::Error(failure),
        ],
    )
    .await;

    assert_eq!(run_status(&conversations).await.as_deref(), Some("failed"));
    let entry = memory.get(&id).await.unwrap().unwrap();
    assert_eq!(entry.recall_count, 0);
    assert_eq!(entry.last_recalled_at, None);
}

#[tokio::test]
async fn an_acp_turn_that_completes_marks_what_it_recalled() {
    let (memory, id) = one_fact().await;
    let conversations = conversation_store().await;
    run_acp_turn(
        &conversations,
        TurnRecallMarks::new(&memory, vec![id.clone()]),
        vec![acp::AcpEvent::Text("the whole answer".to_owned())],
    )
    .await;

    assert_eq!(
        run_status(&conversations).await.as_deref(),
        Some("completed")
    );
    let messages = conversations.get_messages(CONVERSATION).await.unwrap();
    assert!(messages
        .iter()
        .any(|message| message.content == "the whole answer"));
    assert_eq!(recall_count(&memory, &id).await, 1);
}
