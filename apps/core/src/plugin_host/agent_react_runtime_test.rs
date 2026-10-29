//! Sealed inline tool → real JS sandbox → production HostBridge → SQLite/room.
//! This does not exercise MCP registry/global-state dispatch or provider inference.
use super::*;
use serde_json::{json, Value};
use std::sync::Arc;

async fn call(
    state: crate::server::ServerState,
    code: &str,
    arguments: Value,
    grants: &[&str],
    agent: Option<&str>,
    conversation: Option<&str>,
) -> Result<Value, String> {
    assert!(
        tool_exec::is_available(),
        "the JS sandbox is required for the agents.react proof"
    );
    let actual = bridge::PluginHookBridge::new_for_agent_tool(
        crate::plugins::builtins::REACTIONS_PLUGIN_ID.into(),
        grants.iter().map(|grant| (*grant).to_owned()).collect(),
        state,
        agent,
        conversation,
    );
    let caller = json!({"agent_id": agent, "conversation_id": conversation});
    match tool_exec::run_sandboxed(
        tool_exec::build_inline_tool_program(&arguments, &caller, code),
        Arc::new(SandboxToolInvoker::bridge(Arc::new(actual))),
        "ryu",
    )
    .await
    {
        ExecOutcome::Completed {
            result,
            is_error,
            error,
            ..
        } => {
            if is_error {
                Err(error.unwrap_or_else(|| format!("sandbox refused: {result:?}")))
            } else {
                Ok(result.unwrap_or(Value::Null))
            }
        }
        ExecOutcome::Paused { .. } => panic!("reaction tool cannot pause"),
    }
}

#[tokio::test]
async fn sealed_agent_react_actual_host_actor_refusals_retry_reopen_and_room() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("conversations.db");
    let rooms = ryu_realtime::RoomRegistry::new();
    let mut state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.conversations =
        crate::server::conversations::ConversationStore::open_hook_test_file(database.clone())
            .unwrap()
            .with_realtime(rooms.clone());
    for id in ["agent-reaction-current", "agent-reaction-other"] {
        state
            .conversations
            .ensure_conversation(
                id,
                None,
                None,
                crate::server::conversations::Tenancy::Unattributed,
            )
            .await
            .unwrap();
    }
    let peer = state
        .conversations
        .append_message(
            "agent-reaction-current",
            "assistant",
            "Peer review",
            Some("peer-agent"),
            None,
            None,
        )
        .await
        .unwrap();
    let other = state
        .conversations
        .append_message(
            "agent-reaction-other",
            "assistant",
            "Other chat",
            Some("other-agent"),
            None,
            None,
        )
        .await
        .unwrap();
    let reactions = crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .find(|manifest| manifest.id == crate::plugins::builtins::REACTIONS_PLUGIN_ID)
        .unwrap();
    state
        .app_store
        .insert(&reactions.id, &reactions.version)
        .await
        .unwrap();
    state
        .app_store
        .set_enabled(&reactions.id, &reactions.permission_grants)
        .await
        .unwrap()
        .unwrap();
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../../generated/ryu-runtime/plugins-store/plugins/reactions/manifest.json"
    ))
    .unwrap();
    let config = &manifest["runnables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["config"]["slug"] == "agents.react")
        .unwrap()["config"];
    let code = config["code"].as_str().unwrap();
    let grants = ["conversation:reactions"];
    let mut receiver = rooms.get_or_create("agent-reaction-current").subscribe();
    let mut other_receiver = rooms.get_or_create("agent-reaction-other").subscribe();
    let arguments = json!({"message_id": peer, "emoji": " ✅ ",
        "agent_id": "forged-agent", "conversation_id": "agent-reaction-other", "from": "forged-agent"});
    let value = call(
        state.clone(),
        code,
        arguments.clone(),
        &grants,
        Some("reviewer-agent"),
        Some("agent-reaction-current"),
    )
    .await
    .unwrap();
    assert_eq!(
        value,
        json!({"ok": true,"conversation_id":"agent-reaction-current",
        "message_id":peer,"emoji":"✅","from":"reviewer-agent"})
    );
    let frame = receiver
        .try_recv()
        .expect("successful actual write broadcasts synchronously");
    let event = ryu_realtime::Event::decode(&frame).unwrap();
    assert_eq!(event.name, "conversation.reaction");
    assert_eq!(
        event.payload,
        json!({"type":"reaction", "conversation_id":"agent-reaction-current",
        "message_id":peer,"emoji":"✅","user_id":"agent:reviewer-agent","op":"add"})
    );
    assert!(other_receiver.try_recv().is_err());
    call(
        state.clone(),
        code,
        arguments.clone(),
        &grants,
        Some("reviewer-agent"),
        Some("agent-reaction-current"),
    )
    .await
    .unwrap();
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    let sql = rusqlite::Connection::open(&database).unwrap();
    let rows = || {
        sql.query_row("SELECT COUNT(*) FROM message_reactions", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap()
    };
    assert_eq!(rows(), 1);
    assert_eq!(
        sql.query_row("SELECT user_id FROM message_reactions", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "agent:reviewer-agent"
    );
    let human_view = state
        .conversations
        .list_reactions("agent-reaction-current", "human-reader")
        .await
        .unwrap();
    assert_eq!(human_view.len(), 1);
    assert_eq!(human_view[0].emoji, "✅");
    assert_eq!(human_view[0].count, 1);
    assert!(
        !human_view[0].reacted_by_me,
        "agent membership must not claim the human owns it"
    );
    let agent_view = state
        .conversations
        .list_reactions("agent-reaction-current", "agent:reviewer-agent")
        .await
        .unwrap();
    assert_eq!(agent_view.len(), 1);
    assert!(agent_view[0].reacted_by_me);

    // Genuine bridge refusal paths must leave both durable state and room unchanged.
    for (input, allowed, agent, conversation) in [
        (
            json!({"message_id":other,"emoji":"👀"}),
            &grants[..],
            Some("reviewer-agent"),
            Some("agent-reaction-current"),
        ),
        (
            json!({"message_id":"streaming-client-id","emoji":"👀"}),
            &grants[..],
            Some("reviewer-agent"),
            Some("agent-reaction-current"),
        ),
        (
            json!({"message_id":peer,"emoji":"👀"}),
            &[][..],
            Some("reviewer-agent"),
            Some("agent-reaction-current"),
        ),
        (
            json!({"message_id":peer,"emoji":"👀"}),
            &grants[..],
            None,
            Some("agent-reaction-current"),
        ),
        (
            json!({"message_id":peer,"emoji":"👀"}),
            &grants[..],
            Some("reviewer-agent"),
            None,
        ),
    ] {
        assert!(
            call(state.clone(), code, input, allowed, agent, conversation)
                .await
                .is_err()
        );
        assert_eq!(rows(), 1);
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));
    }
    let next = json!({"message_id":peer,"emoji":"👀"});
    state
        .app_store
        .set_disabled(&reactions.id)
        .await
        .unwrap()
        .unwrap();
    let error = call(
        state.clone(),
        code,
        next.clone(),
        &grants,
        Some("reviewer-agent"),
        Some("agent-reaction-current"),
    )
    .await
    .unwrap_err();
    assert!(error.contains("Message Reactions plugin"), "{error}");
    assert_eq!(rows(), 1);
    state
        .app_store
        .set_enabled(&reactions.id, &reactions.permission_grants)
        .await
        .unwrap()
        .unwrap();
    sql.execute_batch("CREATE TRIGGER refuse_reaction BEFORE INSERT ON message_reactions BEGIN SELECT RAISE(ABORT, 'actual reaction write refused'); END;").unwrap();
    let error = call(
        state.clone(),
        code,
        next.clone(),
        &grants,
        Some("reviewer-agent"),
        Some("agent-reaction-current"),
    )
    .await
    .unwrap_err();
    assert!(error.contains("could not persist reaction"), "{error}");
    assert_eq!(rows(), 1);
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    sql.execute_batch("DROP TRIGGER refuse_reaction;").unwrap();
    call(
        state.clone(),
        code,
        next,
        &grants,
        Some("reviewer-agent"),
        Some("agent-reaction-current"),
    )
    .await
    .unwrap();
    let event = ryu_realtime::Event::decode(&receiver.try_recv().unwrap()).unwrap();
    assert_eq!(event.payload["emoji"], "👀");
    assert_eq!(event.payload["user_id"], "agent:reviewer-agent");
    let reopened =
        crate::server::conversations::ConversationStore::open_hook_test_file(database).unwrap();
    let restored = reopened
        .list_reactions("agent-reaction-current", "agent:reviewer-agent")
        .await
        .unwrap();
    assert_eq!(restored.len(), 2);
    assert!(restored.iter().all(|reaction| reaction.count == 1
        && reaction.reacted_by_me
        && reaction.message_id == peer));
    assert!(reopened
        .list_reactions("agent-reaction-other", "agent:reviewer-agent")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn sealed_agent_react_without_message_id_acknowledges_the_latest_user_message() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.conversations = crate::server::conversations::ConversationStore::open_hook_test_file(
        directory.path().join("conversations.db"),
    )
    .unwrap();
    let conversation = "agent-reaction-ack";
    state
        .conversations
        .ensure_conversation(
            conversation,
            None,
            None,
            crate::server::conversations::Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let reactions = crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .find(|manifest| manifest.id == crate::plugins::builtins::REACTIONS_PLUGIN_ID)
        .unwrap();
    state
        .app_store
        .insert(&reactions.id, &reactions.version)
        .await
        .unwrap();
    state
        .app_store
        .set_enabled(&reactions.id, &reactions.permission_grants)
        .await
        .unwrap()
        .unwrap();
    let code = reactions
        .runnables
        .iter()
        .filter_map(|runnable| runnable.config.as_ref())
        .find(|config| config["slug"] == "agents.react")
        .and_then(|config| config["code"].as_str().map(str::to_owned))
        .expect("the reactions plugin ships the sealed agents.react body");
    let grants = ["conversation:reactions"];

    // No user turn yet: an acknowledgement has nothing to land on.
    let error = call(
        state.clone(),
        &code,
        json!({"emoji": "👍"}),
        &grants,
        Some("ryu"),
        Some(conversation),
    )
    .await
    .unwrap_err();
    assert!(error.contains("no user message"), "{error}");

    let append = |role: &'static str, text: &'static str, agent: Option<&'static str>| {
        let store = state.conversations.clone();
        async move {
            store
                .append_message(conversation, role, text, agent, None, None)
                .await
                .unwrap()
        }
    };
    append("user", "since we already followed up via email", None).await;
    append("assistant", "Saved.", Some("ryu")).await;
    let latest = append("user", "yea find useful ones for ryu", None).await;

    let value = call(
        state.clone(),
        &code,
        json!({"emoji": " 👍 "}),
        &grants,
        Some("ryu"),
        Some(conversation),
    )
    .await
    .unwrap();
    assert_eq!(
        value,
        json!({"ok": true, "conversation_id": conversation,
        "message_id": latest, "emoji": "👍", "from": "ryu"})
    );
    assert_eq!(
        state
            .conversations
            .agent_reactions_on_latest_user_message(conversation)
            .await
            .unwrap(),
        vec!["👍".to_owned()]
    );
}
