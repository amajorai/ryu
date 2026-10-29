//! Canonical hook sandbox → production HostBridge → durable title writer.
//! Only side-model output is finite; no provider inference claim.
use super::*;
use crate::tool_exec::SandboxBridge;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct ModelFixture {
    actual: bridge::PluginHookBridge,
    calls: Mutex<Vec<(String, Value)>>,
    refuse_model: Mutex<bool>,
}
impl SandboxBridge for ModelFixture {
    fn handle(
        &self,
        path: String,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = crate::tool_exec::InvokeOutcome> + Send + '_>,
    > {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((path.clone(), args.clone()));
            if path == "host.sideModel" {
                let refuse = *self.refuse_model.lock().unwrap();
                return crate::tool_exec::InvokeOutcome::Result(
                    crate::tool_exec::ToolInvokeResult {
                        value: if refuse {
                            Value::Null
                        } else {
                            json!("Verified durable title")
                        },
                        is_error: refuse,
                        error: refuse.then(|| "finite model refusal".to_owned()),
                    },
                );
            }
            self.actual.handle(path, args).await
        })
    }
}
async fn run(
    hook: &crate::plugin_manifest::TurnHookContribution,
    ctx: &HookContext,
    fixture: Arc<ModelFixture>,
) -> ExecOutcome {
    assert!(tool_exec::is_available(), "actual sandbox runtime required");
    tool_exec::run_sandboxed(
        build_hook_program(ctx, &hook.code),
        Arc::new(SandboxToolInvoker::bridge(fixture)),
        "ryu",
    )
    .await
}
fn parsed(outcome: ExecOutcome) -> HookDirective {
    match outcome {
        ExecOutcome::Completed {
            result,
            is_error,
            error,
            ..
        } => {
            assert!(!is_error, "hook failure: {error:?}");
            parse_directive(result.as_ref())
        }
        ExecOutcome::Paused { .. } => panic!("unexpected pause"),
    }
}
fn title_snapshot(sql: &rusqlite::Connection, id: &str) -> Value {
    let row: (Option<String>, i64, i64) = sql
        .query_row(
            "SELECT title, title_custom, updated_at FROM conversations WHERE id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let history = sql.prepare("SELECT id, title, source, created_at FROM conversation_title_history WHERE conversation_id = ?1 ORDER BY created_at, id").unwrap()
        .query_map([id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?))).unwrap()
        .collect::<Result<Vec<_>, _>>().unwrap();
    json!({ "row": row, "history": history })
}
#[tokio::test]
async fn shipped_chat_title_actual_host_cadence_locked_refusal_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("conversations.db");
    let mut state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.conversations =
        crate::server::conversations::ConversationStore::open_hook_test_file(database.clone())
            .unwrap();
    for id in ["title-chat", "unrelated-chat"] {
        state
            .conversations
            .ensure_conversation(
                id,
                None,
                Some("Original title"),
                crate::server::conversations::Tenancy::Unattributed,
            )
            .await
            .unwrap();
    }
    let manifest = crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|manifest| manifest.id == "@ryu/chat-title")
        .expect("shipped title manifest");
    let hook = manifest
        .contributes
        .expect("contributions")
        .turn_hooks
        .into_iter()
        .find(|hook| hook.id == "chat-title.rename")
        .expect("hydrated title hook");
    let fixture = Arc::new(ModelFixture {
        actual: bridge::PluginHookBridge::new_for_request(
            "@ryu/chat-title".into(),
            ["preferences:read", "conversation:set-title"]
                .into_iter()
                .map(String::from)
                .collect(),
            state.clone(),
            None,
            Some("title-chat".into()),
        ),
        calls: Mutex::new(Vec::new()),
        refuse_model: Mutex::new(false),
    });
    let mut ctx = HookContext {
        conversation_id: Some("title-chat".into()),
        transcript: vec![
            HookMessage {
                role: "user".into(),
                content: "Review durable title".into(),
            },
            HookMessage {
                role: "assistant".into(),
                content: "Reviewed".into(),
            },
        ],
        ..Default::default()
    };
    let cadence = hook
        .run_when
        .as_ref()
        .and_then(|gate| gate.reply_cadence.as_ref())
        .expect("shipped host cadence");
    let grants = ["preferences:read".to_owned()].into_iter().collect();
    assert!(reply_cadence_due(&state.preferences, cadence, &ctx, &grants).await);
    parsed(run(&hook, &ctx, fixture.clone()).await);
    assert_eq!(
        state
            .conversations
            .get_summary("title-chat")
            .await
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Verified durable title")
    );
    state
        .conversations
        .set_title("title-chat", "User locked title")
        .await
        .unwrap();
    parsed(run(&hook, &ctx, fixture.clone()).await);
    assert_eq!(
        state
            .conversations
            .get_summary("title-chat")
            .await
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("User locked title")
    );
    state
        .preferences
        .set("auto-title-enabled", "false")
        .await
        .unwrap();
    assert!(!reply_cadence_due(&state.preferences, cadence, &ctx, &grants).await);
    let calls_before = fixture.calls.lock().unwrap().len();
    assert!(matches!(
        parsed(run(&hook, &ctx, fixture.clone()).await),
        HookDirective::None
    ));
    assert!(!fixture.calls.lock().unwrap()[calls_before..]
        .iter()
        .any(|(path, _)| path == "host.sideModel"));
    ctx.event = Some(json!({ "force": true }));
    let sql = rusqlite::Connection::open(&database).unwrap();
    sql.execute_batch("CREATE TRIGGER refuse_title BEFORE UPDATE OF title ON conversations BEGIN SELECT RAISE(ABORT, 'title write refused'); END;").unwrap();
    assert!(matches!(
        parsed(run(&hook, &ctx, fixture.clone()).await),
        HookDirective::None
    ));
    assert_eq!(
        state
            .conversations
            .get_summary("title-chat")
            .await
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("User locked title")
    );
    sql.execute_batch("DROP TRIGGER refuse_title;").unwrap();
    let unchanged = title_snapshot(&sql, "title-chat");
    sql.execute_batch("CREATE TRIGGER refuse_history BEFORE INSERT ON conversation_title_history BEGIN SELECT RAISE(ABORT, 'title history refused'); END;").unwrap();
    assert!(matches!(
        parsed(run(&hook, &ctx, fixture.clone()).await),
        HookDirective::None
    ));
    assert_eq!(
        title_snapshot(&sql, "title-chat"),
        unchanged,
        "failed history must roll back title, custom flag, timestamp and all history rows"
    );
    sql.execute_batch("DROP TRIGGER refuse_history;").unwrap();
    assert!(matches!(
        parsed(run(&hook, &ctx, fixture.clone()).await),
        HookDirective::Note { .. }
    ));
    let before_model_refusal = title_snapshot(&sql, "title-chat");
    let unrelated_before = title_snapshot(&sql, "unrelated-chat");
    *fixture.refuse_model.lock().unwrap() = true;
    let calls_before = fixture.calls.lock().unwrap().len();
    // This run is forced (the user asked for the rename by name), so the shipped
    // hook fails it with the model's reason instead of reporting a silent `none`.
    // The refused run must not claim a rename or mutate durable title state.
    match run(&hook, &ctx, fixture.clone()).await {
        ExecOutcome::Completed {
            is_error, error, ..
        } => {
            assert!(is_error, "a forced rename must surface the model refusal");
            assert!(
                error
                    .as_deref()
                    .is_some_and(|error| error.contains("finite model refusal")),
                "{error:?}"
            );
        }
        ExecOutcome::Paused { .. } => panic!("unexpected pause"),
    }
    {
        let calls = fixture.calls.lock().unwrap();
        let refused_calls = &calls[calls_before..];
        let model_calls: Vec<_> = refused_calls
            .iter()
            .filter(|(path, _)| path == "host.sideModel")
            .collect();
        assert_eq!(
            model_calls.len(),
            1,
            "one explicit rename makes one model request"
        );
        assert_eq!(
            model_calls[0].1["prompt"],
            json!("user: Review durable title\nassistant: Reviewed")
        );
        assert_eq!(
            model_calls[0].1["model_pref_key"],
            json!("auto-title-model")
        );
        assert!(!refused_calls
            .iter()
            .any(|(path, _)| path == "host.setConversationTitle"));
    }
    assert_eq!(
        title_snapshot(&sql, "title-chat"),
        before_model_refusal,
        "model refusal preserves title, lock, timestamp and history"
    );
    assert_eq!(title_snapshot(&sql, "unrelated-chat"), unrelated_before);
    *fixture.refuse_model.lock().unwrap() = false;
    let calls_before_retry = fixture.calls.lock().unwrap().len();
    assert!(matches!(
        parsed(run(&hook, &ctx, fixture.clone()).await),
        HookDirective::Note { .. }
    ));
    {
        let calls = fixture.calls.lock().unwrap();
        let retry_calls = &calls[calls_before_retry..];
        assert_eq!(
            retry_calls
                .iter()
                .filter(|(path, _)| path == "host.sideModel")
                .count(),
            1
        );
        let title_calls: Vec<_> = retry_calls
            .iter()
            .filter(|(path, _)| path == "host.setConversationTitle")
            .collect();
        assert_eq!(title_calls.len(), 1);
        assert_eq!(
            title_calls[0].1,
            json!({ "id": "title-chat", "title": "Verified durable title", "mode": "custom" })
        );
    }
    assert_eq!(title_snapshot(&sql, "unrelated-chat"), unrelated_before);
    let reopened =
        crate::server::conversations::ConversationStore::open_hook_test_file(database).unwrap();
    assert_eq!(
        reopened
            .get_summary("title-chat")
            .await
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Verified durable title")
    );
    assert_eq!(
        reopened
            .get_summary("unrelated-chat")
            .await
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Original title")
    );
}

#[tokio::test]
async fn chat_title_writers_history_refusal_rolls_back_and_retry_reopens_exact_state() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("title-writers.db");
    let store =
        crate::server::conversations::ConversationStore::open_hook_test_file(database.clone())
            .unwrap();
    for id in ["automatic", "manual", "unrelated"] {
        store
            .ensure_conversation(
                id,
                None,
                Some("Original"),
                crate::server::conversations::Tenancy::Unattributed,
            )
            .await
            .unwrap();
    }
    let sql = rusqlite::Connection::open(&database).unwrap();
    let before = ["automatic", "manual", "unrelated"].map(|id| title_snapshot(&sql, id));
    sql.execute_batch("CREATE TRIGGER refuse_history BEFORE INSERT ON conversation_title_history BEGIN SELECT RAISE(ABORT, 'title history refused'); END;").unwrap();
    assert!(store
        .auto_set_title("automatic", "Automatic retry title")
        .await
        .is_err());
    assert!(store
        .set_title("manual", "Manual retry title")
        .await
        .is_err());
    for (id, expected) in ["automatic", "manual", "unrelated"]
        .into_iter()
        .zip(&before)
    {
        assert_eq!(&title_snapshot(&sql, id), expected);
    }
    sql.execute_batch("DROP TRIGGER refuse_history;").unwrap();
    assert!(store
        .auto_set_title("automatic", "Automatic retry title")
        .await
        .unwrap());
    store
        .set_title("manual", "Manual retry title")
        .await
        .unwrap();
    let after = ["automatic", "manual", "unrelated"].map(|id| title_snapshot(&sql, id));
    assert_eq!(after[0]["row"][1], json!(0));
    assert_eq!(after[1]["row"][1], json!(1));
    assert_eq!(after[0]["history"].as_array().unwrap().len(), 1);
    assert_eq!(after[1]["history"].as_array().unwrap().len(), 1);
    assert_eq!(after[2], before[2]);
    drop(store);
    let reopened =
        crate::server::conversations::ConversationStore::open_hook_test_file(database).unwrap();
    assert_eq!(
        reopened
            .get_summary("automatic")
            .await
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Automatic retry title")
    );
    assert_eq!(
        reopened
            .get_summary("manual")
            .await
            .unwrap()
            .unwrap()
            .title
            .as_deref(),
        Some("Manual retry title")
    );
    assert!(!reopened
        .auto_set_title("manual", "Must not replace custom title")
        .await
        .unwrap());
    for (id, expected) in ["automatic", "manual", "unrelated"].into_iter().zip(&after) {
        assert_eq!(&title_snapshot(&sql, id), expected);
    }
}
