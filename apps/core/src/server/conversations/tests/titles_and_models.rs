//! Conversation store tests: titles and models.

use super::*;

#[tokio::test]
async fn conversation_title_is_encrypted_on_disk() {
    let store = ConversationStore::open_in_memory().unwrap();
    // The first user message derives the title from its content.
    store
        .append_message(
            "c1",
            "user",
            "Plan the secret acquisition",
            None,
            None,
            None,
        )
        .await
        .unwrap();

    let raw: Option<String> = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT title FROM conversations WHERE id = ?1",
            params!["c1"],
            |r| r.get(0),
        )
        .unwrap()
    };
    let raw = raw.expect("title should be set");
    assert!(
        raw.starts_with("enc:v1:"),
        "expected sealed title, got {raw}"
    );
    assert!(!raw.contains("secret acquisition"));

    // Both list and detail return the decrypted title.
    let list = store.list_conversations().await.unwrap();
    assert_eq!(
        list[0].title.as_deref(),
        Some("Plan the secret acquisition")
    );
    let detail = store.get_conversation_detail("c1").await.unwrap().unwrap();
    assert_eq!(detail.title.as_deref(), Some("Plan the secret acquisition"));
}

#[tokio::test]
async fn auto_set_title_overwrites_derived_but_not_custom() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("c1", "user", "how do I center a div", None, None, None)
        .await
        .unwrap();
    // Provisional title is the derived first message; not yet user-locked.
    assert!(!store.title_is_custom("c1").await.unwrap());

    // The auto-namer may overwrite the derived title.
    assert!(store.auto_set_title("c1", "Centering a div").await.unwrap());
    let list = store.list_conversations().await.unwrap();
    assert_eq!(list[0].title.as_deref(), Some("Centering a div"));

    // A manual rename locks the title.
    store.set_title("c1", "CSS layout help").await.unwrap();
    assert!(store.title_is_custom("c1").await.unwrap());

    // A later auto-name is a no-op once the user has chosen a title.
    assert!(!store.auto_set_title("c1", "Robot title").await.unwrap());
    let list = store.list_conversations().await.unwrap();
    assert_eq!(list[0].title.as_deref(), Some("CSS layout help"));
}

#[tokio::test]
async fn requested_auto_rename_unlocks_and_preserves_history() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("c1", "user", "how do I center a div", None, None, None)
        .await
        .unwrap();
    store.set_title("c1", "My title").await.unwrap();
    assert!(!store
        .auto_set_title("c1", "Silent overwrite")
        .await
        .unwrap());
    store
        .force_set_title("c1", "Centering a div")
        .await
        .unwrap();
    assert!(!store.title_is_custom("c1").await.unwrap());
    assert_eq!(
        store
            .get_conversation_detail("c1")
            .await
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Centering a div")
    );
    let history = store.list_title_history("c1").await.unwrap();
    assert_eq!(history.last().unwrap().title, "Centering a div");
    assert_eq!(history.last().unwrap().source, "auto");
    assert!(store.force_set_title("missing", "Ghost").await.is_err());
    assert!(store
        .list_title_history("missing")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn context_handoff_is_recorded_once_per_model_change_and_branch() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("handoff", "user", "hello", None, None, None)
        .await
        .unwrap();
    let handoff = |id: &str, head: &str, summary: &str| ConversationContextHandoff {
        id: id.to_owned(),
        model_change_id: "change-2".to_owned(),
        covered_head_id: head.to_owned(),
        outcome: ContextHandoffOutcome::Applied,
        reason: "smaller-context".to_owned(),
        from_model: Some("Big".to_owned()),
        to_model: Some("Small".to_owned()),
        from_context: Some(1_000_000),
        to_context: Some(256_000),
        summarized_count: 4,
        boundary_at: 10,
        summary: Some(summary.to_owned()),
        created_at: 20,
    };

    let first = store
        .record_context_handoff("handoff", handoff("h1", "m4", "first briefing"))
        .await
        .unwrap();
    // A racing turn for the same change and branch replays the first summary.
    let second = store
        .record_context_handoff("handoff", handoff("h2", "m4", "second briefing"))
        .await
        .unwrap();
    assert_eq!(second, first);
    assert_eq!(
        store
            .get_context_handoff("change-2", "m4")
            .await
            .unwrap()
            .and_then(|row| row.summary)
            .as_deref(),
        Some("first briefing")
    );
    // An edit before the switch puts a different head on the active thread,
    // which gets its own summary rather than the old branch's.
    let edited = store
        .record_context_handoff("handoff", handoff("h3", "m2-edit", "edited briefing"))
        .await
        .unwrap();
    assert_eq!(edited.summary.as_deref(), Some("edited briefing"));
    assert_eq!(
        store.get_context_handoff("change-2", "m3").await.unwrap(),
        None
    );
    let listed = store.list_context_handoffs("handoff").await.unwrap();
    assert_eq!(listed, vec![first, edited]);
}

#[tokio::test]
async fn model_selection_history_is_shared_ordered_and_idempotent() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("shared", "user", "hello", None, None, None)
        .await
        .unwrap();

    let (first, first_changed) = store
        .record_model_selection(
            "shared",
            ConversationModelSelectionInput {
                id: "change-alice".to_owned(),
                kind: ConversationModelChangeKind::Initial,
                provider_id: Some("openai".to_owned()),
                provider_label: Some("OpenAI".to_owned()),
                model_id: Some("gpt-4.1".to_owned()),
                model_label: Some("GPT-4.1".to_owned()),
                changed_by: Some("alice".to_owned()),
            },
        )
        .await
        .unwrap();
    assert!(first_changed);
    assert_eq!(first.kind, ConversationModelChangeKind::Initial);

    let (second, second_changed) = store
        .record_model_selection(
            "shared",
            ConversationModelSelectionInput {
                id: "change-bob".to_owned(),
                kind: ConversationModelChangeKind::Change,
                provider_id: Some("anthropic".to_owned()),
                provider_label: Some("Anthropic".to_owned()),
                model_id: Some("claude-sonnet-4".to_owned()),
                model_label: Some("Claude Sonnet 4".to_owned()),
                changed_by: Some("bob".to_owned()),
            },
        )
        .await
        .unwrap();
    assert!(second_changed);
    assert_eq!(second.kind, ConversationModelChangeKind::Change);
    assert!(second.sequence > first.sequence);

    let (replayed, replay_changed) = store
        .record_model_selection(
            "shared",
            ConversationModelSelectionInput {
                id: "change-bob".to_owned(),
                kind: ConversationModelChangeKind::Change,
                provider_id: Some("anthropic".to_owned()),
                provider_label: Some("Anthropic".to_owned()),
                model_id: Some("claude-sonnet-4".to_owned()),
                model_label: Some("Claude Sonnet 4".to_owned()),
                changed_by: Some("bob".to_owned()),
            },
        )
        .await
        .unwrap();
    assert!(!replay_changed);
    assert_eq!(replayed, second);

    let (same_selection, same_changed) = store
        .record_model_selection(
            "shared",
            ConversationModelSelectionInput {
                id: "duplicate-choice".to_owned(),
                kind: ConversationModelChangeKind::Change,
                provider_id: Some("anthropic".to_owned()),
                provider_label: Some("Anthropic".to_owned()),
                model_id: Some("claude-sonnet-4".to_owned()),
                model_label: Some("Claude Sonnet 4".to_owned()),
                changed_by: Some("carol".to_owned()),
            },
        )
        .await
        .unwrap();
    assert!(!same_changed);
    assert_eq!(same_selection, second);

    let changes = store.list_model_changes("shared").await.unwrap();
    assert_eq!(changes, vec![first, second]);
    assert_eq!(
        changes.last().map(|change| change.changed_by.as_deref()),
        Some(Some("bob"))
    );
}

/// The DEFAULT title (no plugin, no model): the first user message titles the
/// conversation the moment it is persisted, and later turns leave it alone.
#[tokio::test]
async fn first_user_message_titles_the_conversation() {
    let store = ConversationStore::open_in_memory().unwrap();

    store
        .append_message("c1", "user", "first question", None, None, None)
        .await
        .unwrap();
    let list = store.list_conversations().await.unwrap();
    assert_eq!(list[0].title.as_deref(), Some("first question"));

    // Assistant reply + a second user turn must NOT re-derive over it.
    store
        .append_message("c1", "assistant", "an answer", None, None, None)
        .await
        .unwrap();
    store
        .append_message("c1", "user", "follow-up", None, None, None)
        .await
        .unwrap();
    let list = store.list_conversations().await.unwrap();
    assert_eq!(list[0].title.as_deref(), Some("first question"));
    // The derived title is not user-chosen, so the chat-title plugin may
    // still replace it.
    assert!(!store.title_is_custom("c1").await.unwrap());

    // `get_first_user_message` returns the earliest user turn.
    assert_eq!(
        store.get_first_user_message("c1").await.unwrap().as_deref(),
        Some("first question")
    );
}

/// A text-less opener (image/file only) must not pin a placeholder: the title
/// stays NULL so the next real user turn can still name the thread.
#[tokio::test]
async fn empty_first_message_leaves_the_title_unset() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("c1", "user", "   ", None, None, None)
        .await
        .unwrap();
    let list = store.list_conversations().await.unwrap();
    assert_eq!(list[0].title, None);

    store
        .append_message("c1", "user", "now with words", None, None, None)
        .await
        .unwrap();
    let list = store.list_conversations().await.unwrap();
    assert_eq!(list[0].title.as_deref(), Some("now with words"));
}

#[tokio::test]
async fn append_and_fetch_round_trips() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-1", "user", "Hello there", Some("default"), None, None)
        .await
        .unwrap();
    store
        .append_message("conv-1", "assistant", "Hi!", Some("default"), None, None)
        .await
        .unwrap();

    let msgs = store.get_messages("conv-1").await.unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].role, "user");
    assert_eq!(msgs[0].content, "Hello there");
    assert_eq!(msgs[1].role, "assistant");
}

#[tokio::test]
async fn message_feedback_set_list_and_turn_resolution() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message(
            "conv-f",
            "user",
            "how do I reverse a string",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let asst = store
        .append_message("conv-f", "assistant", "use chars().rev()", None, None, None)
        .await
        .unwrap();

    // No feedback yet.
    assert!(store.list_feedback("conv-f").await.unwrap().is_empty());

    // Set a thumbs up.
    assert!(store
        .set_message_feedback("conv-f", &asst, Some("up"))
        .await
        .unwrap());
    let fb = store.list_feedback("conv-f").await.unwrap();
    assert_eq!(fb, vec![(asst.clone(), "up".to_string())]);

    // The turn resolves to (user prompt, assistant reply).
    let turn = store
        .get_turn_for_assistant_message("conv-f", &asst)
        .await
        .unwrap()
        .expect("turn resolves");
    assert_eq!(turn.0, "how do I reverse a string");
    assert_eq!(turn.1, "use chars().rev()");

    // Clearing removes it from the map.
    assert!(store
        .set_message_feedback("conv-f", &asst, None)
        .await
        .unwrap());
    assert!(store.list_feedback("conv-f").await.unwrap().is_empty());

    // A wrong-conversation scope is a no-op (row not found).
    assert!(!store
        .set_message_feedback("conv-other", &asst, Some("down"))
        .await
        .unwrap());
}

#[tokio::test]
async fn conversation_titles_returns_decrypted_titles_for_known_ids_only() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("c1", "user", "hello there", None, None, None)
        .await
        .unwrap();
    store.set_title("c1", "Database schema plan").await.unwrap();
    store
        .ensure_conversation("c2", None, None, Tenancy::Unattributed)
        .await
        .unwrap();

    let titles = store
        .conversation_titles(&["c1".to_owned(), "c2".to_owned(), "missing".to_owned()])
        .await
        .unwrap();
    assert_eq!(
        titles.get("c1").map(String::as_str),
        Some("Database schema plan")
    );
    // An untitled conversation and an unknown id are both absent.
    assert!(!titles.contains_key("c2"));
    assert!(!titles.contains_key("missing"));
}
