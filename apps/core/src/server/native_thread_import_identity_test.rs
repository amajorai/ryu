//! Actual native JSONL reader → production import handler → reopened SQLite.
//! Process isolation owns native-history environment; no external agent runs.
use super::*;
use serde_json::{json, Value};
const CHILD: &str = "RYU_NATIVE_IMPORT_IDENTITY_PROOF_CHILD";
const EXACT: &str = "server::native_thread_import_identity_test::listed_claude_session_without_metadata_imports_once_per_tenancy";

async fn import(state: &ServerState, locator: &str, user: &str) -> Value {
    let caller = Some(crate::identity_verify::VerifiedCaller {
        user_id: user.into(),
        email: None,
        email_verified: false,
        org_id: Some("import-org".into()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    });
    let response = import_agent_thread_inner(
        state,
        &caller,
        "acp:claude".into(),
        ImportThreadBody {
            thread_id: locator.into(),
            dry_run: false,
        },
        Some(conversations::Tenancy::Owned {
            user_id: user.into(),
            org_id: Some("import-org".into()),
        }),
    )
    .await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

#[tokio::test]
async fn listed_claude_session_without_metadata_imports_once_per_tenancy() {
    if std::env::var_os(CHILD).is_none() {
        let root = tempfile::tempdir().unwrap();
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .env_clear()
            .args(["--exact", EXACT, "--nocapture"])
            .env(CHILD, "1")
            .env("HOME", root.path())
            // Windows resolves the temp dir from TEMP/TMP; with a cleared env
            // it falls back to the unwritable Windows directory. SystemRoot is
            // forwarded below for the same reason.
            .env("TEMP", root.path())
            .env("TMP", root.path())
            .env("RYU_DIR", root.path().join("core"))
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("CLAUDE_CONFIG_DIR", root.path().join("claude"));
        for key in ["PATH", "LD_LIBRARY_PATH", "SystemRoot"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "native import child failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        return;
    }
    let root = std::path::PathBuf::from(std::env::var_os("CLAUDE_CONFIG_DIR").unwrap());
    let project = root.join("projects/-owned-workspace");
    std::fs::create_dir_all(&project).unwrap();
    let session = "11111111-2222-3333-4444-555555555555";
    let transcript = project.join(format!("{session}.jsonl"));
    let original = [json!({"type":"user","message":{"role":"user","content":"Persist real imported question"}}),
        json!({"type":"assistant","message":{"role":"assistant","content":"Persist real imported response"}})]
        .iter().map(Value::to_string).collect::<Vec<_>>().join("\n")+"\n";
    std::fs::write(&transcript, &original).unwrap();
    let listed = crate::native_history::list_threads("claude", None).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].native_session_id.as_deref(), Some(session));
    let locator = &listed[0].id;
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("conversations.db");
    let mut state = isolated_plugin_hook_test_state(directory.path());
    state.conversations =
        conversations::ConversationStore::open_hook_test_file(database.clone()).unwrap();
    let first = import(&state, locator, "alice").await;
    let second = import(&state, locator, "alice").await;
    assert_eq!(
        second["conversation_id"], first["conversation_id"],
        "same listed locator must reuse its persisted conversation"
    );
    assert_eq!(second["already_imported"], true);
    assert_eq!(second["messages_added"], 0);
    let id = first["conversation_id"].as_str().unwrap();
    assert_eq!(state.conversations.get_messages(id).await.unwrap().len(), 2);
    let other_owner = import(&state, locator, "bob").await;
    assert_ne!(other_owner["conversation_id"], first["conversation_id"]);
    assert_eq!(other_owner["already_imported"], false);
    let new_line =
        json!({"type":"user","message":{"role":"user","content":"Later persisted tail"}})
            .to_string();
    std::fs::write(&transcript, format!("{original}{new_line}\n")).unwrap();
    let synced = import(&state, locator, "alice").await;
    assert_eq!(synced["conversation_id"], first["conversation_id"]);
    assert_eq!(synced["messages_added"], 1);
    let reopened = conversations::ConversationStore::open_hook_test_file(database).unwrap();
    let messages = reopened.get_messages(id).await.unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages.last().unwrap().content, "Later persisted tail");
    let tenant = conversations::Tenancy::Owned {
        user_id: "alice".into(),
        org_id: Some("import-org".into()),
    };
    assert_eq!(
        reopened
            .find_imported_conversation("import:claude", session, &tenant)
            .await
            .unwrap()
            .as_deref(),
        Some(id)
    );
    assert_eq!(
        reopened
            .get_messages(other_owner["conversation_id"].as_str().unwrap())
            .await
            .unwrap()
            .len(),
        2
    );
}
