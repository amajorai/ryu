//! Actual MCP registry dispatch → sealed inline JS → HostBridge → disk/room.
//! Isolated process owns the one-shot learning state; no provider/model inference.
use super::McpRegistry;
use serde_json::{json, Value};
use std::sync::Arc;

const CHILD: &str = "RYU_AGENT_REACT_REGISTRY_PROOF_CHILD";
const EXACT: &str = "sidecar::mcp::agent_react_registry_runtime_test::agent_react_registry_dispatch_binds_actor_and_conversation";

#[tokio::test]
async fn agent_react_registry_dispatch_binds_actor_and_conversation() {
    if std::env::var_os(CHILD).is_none() {
        let root = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .env_clear()
            .args(["--exact", EXACT, "--nocapture"])
            .env(CHILD, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            // The cleared env drops the runner's stack size; give the child
            // the 16 MiB Core's runtime workers use, as the other runtime
            // child tests do.
            .env("RUST_MIN_STACK", "16777216")
            .env("RYU_DIR", root.path())
            .env("HOME", root.path())
            // Windows resolves the temp dir from TEMP/TMP; with a cleared env
            // it falls back to the unwritable Windows directory. SystemRoot is
            // forwarded below for the same reason.
            .env("TEMP", root.path())
            .env("TMP", root.path())
            .env("XDG_CONFIG_HOME", root.path().join("config"));
        for key in ["PATH", "LD_LIBRARY_PATH", "SystemRoot"] {
            if let Some(value) = std::env::var_os(key) {
                child.env(key, value);
            }
        }
        let output = child
            .output()
            .expect("start isolated real registry process");
        assert!(
            output.status.success(),
            "registry child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
            "exact child must actually execute its registry assertion"
        );
        return;
    }
    assert!(
        crate::tool_exec::is_available(),
        "the JS sandbox is required"
    );
    assert!(
        crate::learning::global_state().is_none(),
        "process must own fresh learning state"
    );
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("conversations.db");
    let rooms = ryu_realtime::RoomRegistry::new();
    let mut state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.conversations =
        crate::server::conversations::ConversationStore::open_hook_test_file(database.clone())
            .unwrap()
            .with_realtime(rooms.clone());
    for id in ["registry-current", "registry-other"] {
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
            "registry-current",
            "assistant",
            "Peer message",
            Some("peer-agent"),
            None,
            None,
        )
        .await
        .unwrap();
    let other = state
        .conversations
        .append_message(
            "registry-other",
            "assistant",
            "Foreign message",
            Some("foreign-agent"),
            None,
            None,
        )
        .await
        .unwrap();
    let manifests = crate::plugin_manifest::PluginManifestLoader::load();
    let reactions = manifests
        .iter()
        .find(|manifest| manifest.id == crate::plugins::builtins::REACTIONS_PLUGIN_ID)
        .unwrap()
        .clone();
    for manifest in [&reactions] {
        state
            .app_store
            .insert(&manifest.id, &manifest.version)
            .await
            .unwrap();
        state
            .app_store
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap()
            .unwrap();
    }
    *state.app_manifests.write().await = vec![reactions.clone()];
    let reviewer = state
        .agent_store
        .create_with_id(
            "reviewer-agent".into(),
            crate::agents::CreateAgent {
                name: "Installed reviewer".into(),
                tools: vec!["agents.react".into()],
                safety_profile: crate::agents::AgentSafetyProfile::Autonomous,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        reviewer.lifecycle_status,
        crate::agents::AgentLifecycleStatus::Trial
    );
    crate::learning::set_global_state(state.clone());
    let registry = McpRegistry::empty()
        .with_self_build(
            state.app_manifests.clone(),
            Arc::new(state.app_store.clone()),
        )
        .with_conversations(state.conversations.clone())
        .with_agent_store(state.agent_store.clone());
    registry.register_app_tool("agents.react".into(), "React to a Message".into(), None);
    let allowed = vec!["agents.react".to_owned()];
    let mut receiver = rooms.get_or_create("registry-current").subscribe();
    let mut foreign_receiver = rooms.get_or_create("registry-other").subscribe();
    let args = json!({"message_id":peer,"emoji":"✅","agent_id":"forged-agent",
        "conversation_id":"registry-other","from":"forged-agent"});
    // A real installed Trial agent must hit the registry lifecycle gate before
    // any inline sandbox reaction can persist. Promotion uses the actual store.
    let refused = invoke(&registry, args.clone(), &allowed).await.unwrap_err();
    assert!(refused.to_string().contains("read-only"), "{refused}");
    assert!(state
        .conversations
        .list_reactions("registry-current", "human-user")
        .await
        .unwrap()
        .is_empty());
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    let promoted = state
        .agent_store
        .update(
            &reviewer.id,
            crate::agents::UpdateAgent {
                lifecycle_status: Some(crate::agents::AgentLifecycleStatus::Active),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        promoted.lifecycle_status,
        crate::agents::AgentLifecycleStatus::Active
    );
    let result = invoke(&registry, args.clone(), &allowed).await.unwrap();
    assert_eq!(
        result,
        json!({"ok":true,"conversation_id":"registry-current",
        "message_id":peer,"emoji":"✅","from":"reviewer-agent"})
    );
    let event = ryu_realtime::Event::decode(&receiver.try_recv().unwrap()).unwrap();
    assert_eq!(event.name, "conversation.reaction");
    assert_eq!(
        event.payload,
        json!({"type":"reaction","conversation_id":"registry-current",
        "message_id":peer,"emoji":"✅","user_id":"agent:reviewer-agent","op":"add"})
    );
    invoke(&registry, args, &allowed).await.unwrap();
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    // Registered-tool allowlist is enforced before another emoji can persist.
    let denied = invoke(&registry, json!({"message_id":peer,"emoji":"👀"}), &[])
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("allowlist"), "{denied}");
    let denied = invoke(
        &registry,
        json!({"message_id":other,"emoji":"👀"}),
        &allowed,
    )
    .await
    .unwrap_err();
    assert!(
        denied.to_string().contains("current conversation"),
        "{denied}"
    );
    state
        .app_store
        .set_disabled(&reactions.id)
        .await
        .unwrap()
        .unwrap();
    // Message Reactions owns `agents.react`, so disabling it takes the tool away
    // before dispatch: the inline body never runs and nothing can persist.
    let denied = invoke(&registry, json!({"message_id":peer,"emoji":"👀"}), &allowed)
        .await
        .unwrap_err();
    assert!(
        !denied.to_string().is_empty(),
        "a disabled owner must refuse the call"
    );
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    assert!(matches!(
        foreign_receiver.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
    let sql = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(
        sql.query_row("SELECT COUNT(*) FROM message_reactions", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        sql.query_row("SELECT user_id FROM message_reactions", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "agent:reviewer-agent"
    );
    let reopened =
        crate::server::conversations::ConversationStore::open_hook_test_file(database).unwrap();
    let rows = reopened
        .list_reactions("registry-current", "human-user")
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].count, 1);
    assert!(!rows[0].reacted_by_me);
    assert_eq!(rows[0].message_id, peer);
    assert!(reopened
        .list_reactions("registry-other", "human-user")
        .await
        .unwrap()
        .is_empty());
}

async fn invoke(registry: &McpRegistry, args: Value, allowed: &[String]) -> anyhow::Result<Value> {
    registry
        .call_tool_with_identity(
            Some("reviewer-agent"),
            "agents.react",
            args,
            Some(allowed),
            Some("model-supplied-user-not-an-actor"),
            &[],
            Some("registry-session".into()),
            Some("registry-current"),
        )
        .await
}
