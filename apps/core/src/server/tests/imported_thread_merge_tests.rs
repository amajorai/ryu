use crate::native_history::ImportedMessage;
use crate::server::conversations::StoredMessage;
use crate::server::{import_reuse_permission, json_error, missing_imported_message_tail};
use axum::http::StatusCode;

fn stored(role: &str, content: &str, created_at: i64) -> StoredMessage {
    StoredMessage {
        id: format!("{role}-{created_at}"),
        role: role.to_string(),
        content: content.to_string(),
        agent_id: None,
        author_user_id: None,
        author_name: None,
        source: None,
        widget_instance_id: None,
        origin_server: None,
        parts: None,
        metadata: None,
        parent_message_id: None,
        interrupted: false,
        sibling_index: 0,
        sibling_count: 1,
        sibling_ids: Vec::new(),
        created_at,
    }
}

fn imported(role: &str, content: &str, created_at: i64) -> ImportedMessage {
    ImportedMessage {
        role: role.to_string(),
        content: content.to_string(),
        created_at: Some(created_at),
    }
}

#[test]
fn import_reuse_only_falls_through_for_denial_or_missing_rows() {
    assert!(
        import_reuse_permission(Ok(())).expect("authorized reuse decision"),
        "an authorized existing conversation may be updated"
    );
    for status in [StatusCode::FORBIDDEN, StatusCode::NOT_FOUND] {
        assert!(
            !import_reuse_permission(Err(json_error(status, "not reusable".to_owned())))
                .expect("denied reuse decision"),
            "{status} should create a separate caller-owned import"
        );
    }
    let failure = import_reuse_permission(Err(json_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "resource metadata unavailable".to_owned(),
    )))
    .expect_err("a metadata failure must not become a successful fresh import");
    assert_eq!(failure.status(), StatusCode::INTERNAL_SERVER_ERROR);
}

#[test]
fn reimport_appends_only_new_native_messages() {
    let existing = vec![stored("user", "one", 10), stored("assistant", "two", 20)];
    let source = vec![
        imported("user", "one", 10),
        imported("assistant", "two", 20),
        imported("user", "three", 30),
        imported("assistant", "four", 40),
    ];

    let missing = missing_imported_message_tail(&existing, &source);

    assert_eq!(missing.len(), 2);
    assert_eq!(missing[0].content, "three");
    assert_eq!(missing[1].content, "four");
}

#[test]
fn ryu_only_messages_do_not_break_native_tail_detection() {
    let existing = vec![
        stored("user", "one", 10),
        stored("assistant", "two", 20),
        stored("user", "continued inside Ryu", 25),
    ];
    let source = vec![
        imported("user", "one", 10),
        imported("assistant", "two", 20),
        imported("user", "new in native thread", 30),
    ];

    let missing = missing_imported_message_tail(&existing, &source);

    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].content, "new in native thread");
}

#[test]
fn unchanged_reimport_has_no_missing_messages() {
    let existing = vec![stored("user", "one", 10), stored("assistant", "two", 20)];
    let source = vec![
        imported("user", "one", 10),
        imported("assistant", "two", 20),
    ];

    assert!(missing_imported_message_tail(&existing, &source).is_empty());
}

#[test]
fn timestamp_free_messages_can_sort_after_later_source_messages() {
    let existing = vec![
        stored("assistant", "timestamped reply", 20),
        stored("user", "prompt without timestamp", 100),
    ];
    let source = vec![
        ImportedMessage {
            role: "user".to_string(),
            content: "prompt without timestamp".to_string(),
            created_at: None,
        },
        imported("assistant", "timestamped reply", 20),
        imported("user", "new tail", 30),
    ];

    let missing = missing_imported_message_tail(&existing, &source);

    assert_eq!(missing.len(), 1);
    assert_eq!(missing[0].content, "new tail");
}

#[test]
fn import_thread_body_defaults_to_live_and_accepts_dry_run() {
    let live: crate::server::ImportThreadBody = serde_json::from_value(serde_json::json!({
        "thread_id": "thread"
    }))
    .unwrap();
    assert!(!live.dry_run);

    let preview: crate::server::ImportThreadBody = serde_json::from_value(serde_json::json!({
        "thread_id": "thread",
        "dry_run": true
    }))
    .unwrap();
    assert!(preview.dry_run);
}
