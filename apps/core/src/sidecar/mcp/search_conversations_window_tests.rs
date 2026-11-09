//! Tests for the `around_message_id` transcript-window mode of
//! `search_conversations.search`: visibility (a message the caller cannot read
//! looks exactly like a missing one), window bounds, and argument validation.

use super::super::{dispatch, dispatch_scoped, tools};
use super::*;
use crate::server::conversations::Tenancy;

const ORG: &str = "org1";

fn owned(user: &str) -> Tenancy {
    Tenancy::Owned {
        user_id: user.to_owned(),
        org_id: Some(ORG.to_owned()),
    }
}

fn principal(user: &str) -> ToolPrincipal {
    ToolPrincipal::Owned {
        user_id: user.to_owned(),
        org_id: Some(ORG.to_owned()),
    }
}

/// Chat memory on; `count` turns `m0..` in `conv`, owned by `tenancy`.
async fn seeded(conv: &str, tenancy: Tenancy, count: usize) -> (ConversationStore, Vec<String>) {
    let store = ConversationStore::open_in_memory().expect("store");
    store.set_chat_memory_enabled(true).await.unwrap();
    store
        .ensure_conversation(conv, None, Some("Q3 planning"), tenancy.clone())
        .await
        .unwrap();
    let mut ids = Vec::new();
    for n in 0..count {
        let role = if n % 2 == 0 { "user" } else { "assistant" };
        ids.push(
            store
                .append_message_at(
                    conv,
                    role,
                    &format!("m{n}"),
                    None,
                    None,
                    None,
                    tenancy.clone(),
                    Some(1_000 + n as i64),
                )
                .await
                .unwrap(),
        );
    }
    (store, ids)
}

async fn read(store: &ConversationStore, args: Value, who: &ToolPrincipal) -> Value {
    dispatch("search", args, store, who)
        .await
        .expect("dispatch")
}

fn contents(out: &Value) -> Vec<String> {
    out["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .map(|m| m["content"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn schema_lists_the_window_arguments_and_query_is_no_longer_required() {
    let tools = tools();
    let schema = tools[0].input_schema.as_ref().expect("schema");
    assert_eq!(schema["properties"]["around_message_id"]["type"], "string");
    assert_eq!(schema["properties"]["before"]["maximum"], json!(MAX_SIDE));
    assert_eq!(schema["properties"]["after"]["minimum"], json!(0));
    assert!(schema["properties"]["query"].is_object());
    assert!(schema.get("required").is_none());
}

#[tokio::test]
async fn the_owner_reads_the_window_around_a_message() {
    let (store, ids) = seeded("alice-thread", owned("alice"), 7).await;
    let out = read(
        &store,
        json!({ "around_message_id": ids[3], "before": 1, "after": 2 }),
        &principal("alice"),
    )
    .await;
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["conversation_id"], "alice-thread");
    assert_eq!(out["conversation_title"], "Q3 planning");
    assert_eq!(contents(&out), vec!["m2", "m3", "m4", "m5"]);
    assert_eq!(out["count"], json!(4));
    assert_eq!(out["has_earlier"], json!(true));
    assert_eq!(out["has_later"], json!(true));
    let messages = out["messages"].as_array().unwrap();
    assert_eq!(messages[1]["message_id"], json!(ids[3]));
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["created_at"], json!(1_003));
    assert_eq!(messages[1]["target"], json!(true));
    assert!(messages[0].get("target").is_none());
}

#[tokio::test]
async fn defaults_and_clamps_bound_the_window() {
    let (store, ids) = seeded("long", Tenancy::Unattributed, 30).await;
    let out = read(
        &store,
        json!({ "around_message_id": ids[15] }),
        &ToolPrincipal::Unrestricted,
    )
    .await;
    assert_eq!(out["count"], json!(DEFAULT_SIDE * 2 + 1));

    let out = read(
        &store,
        json!({ "around_message_id": ids[15], "before": 500, "after": 500 }),
        &ToolPrincipal::Unrestricted,
    )
    .await;
    assert_eq!(out["count"], json!(MAX_SIDE * 2 + 1));
    assert_eq!(out["has_earlier"], json!(true));
    assert_eq!(out["has_later"], json!(true));

    let out = read(
        &store,
        json!({ "around_message_id": ids[0], "before": 4, "after": 0 }),
        &ToolPrincipal::Unrestricted,
    )
    .await;
    assert_eq!(contents(&out), vec!["m0"]);
    assert_eq!(out["has_earlier"], json!(false));
}

#[tokio::test]
async fn a_cross_owner_message_looks_exactly_like_a_missing_one() {
    let (store, ids) = seeded("alice-thread", owned("alice"), 3).await;
    store
        .ensure_conversation("bob-thread", None, None, owned("bob"))
        .await
        .unwrap();
    let missing = read(
        &store,
        json!({ "around_message_id": "no-such-message" }),
        &principal("bob"),
    )
    .await;
    assert_eq!(missing["ok"], json!(false));
    assert_eq!(missing["messages"], json!([]));

    let cross_owner = read(
        &store,
        json!({ "around_message_id": ids[1] }),
        &principal("bob"),
    )
    .await;
    assert_eq!(cross_owner, missing);

    // Naming Alice's conversation explicitly does not widen Bob's access.
    let named = read(
        &store,
        json!({ "around_message_id": ids[1], "conversation_ids": ["alice-thread"] }),
        &principal("bob"),
    )
    .await;
    assert_eq!(named, missing);

    // A bound node with no resolvable principal reads nothing.
    let unresolved = read(
        &store,
        json!({ "around_message_id": ids[1] }),
        &ToolPrincipal::Unresolved,
    )
    .await;
    assert_eq!(unresolved, missing);
}

#[tokio::test]
async fn a_long_conversation_returns_bounded_windows_at_both_edges_and_not_to_others() {
    let (store, ids) = seeded("alice-long", owned("alice"), 60).await;
    let first = read(
        &store,
        json!({ "around_message_id": ids[0], "before": 5, "after": 2 }),
        &principal("alice"),
    )
    .await;
    assert_eq!(contents(&first), vec!["m0", "m1", "m2"]);
    assert_eq!(first["messages"][0]["target"], json!(true));
    assert_eq!(first["has_earlier"], json!(false));
    assert_eq!(first["has_later"], json!(true));

    let last = read(
        &store,
        json!({ "around_message_id": ids[59], "before": 2, "after": 5 }),
        &principal("alice"),
    )
    .await;
    assert_eq!(contents(&last), vec!["m57", "m58", "m59"]);
    assert_eq!(last["messages"][2]["target"], json!(true));
    assert_eq!(last["has_earlier"], json!(true));
    assert_eq!(last["has_later"], json!(false));

    let middle = read(
        &store,
        json!({ "around_message_id": ids[30], "before": 500, "after": 500 }),
        &principal("alice"),
    )
    .await;
    assert_eq!(middle["count"], json!(MAX_SIDE * 2 + 1));
    assert_eq!(contents(&middle).first().map(String::as_str), Some("m20"));
    assert_eq!(contents(&middle).last().map(String::as_str), Some("m40"));

    let missing = read(
        &store,
        json!({ "around_message_id": "no-such-message" }),
        &principal("bob"),
    )
    .await;
    let cross_owner = read(
        &store,
        json!({ "around_message_id": ids[30] }),
        &principal("bob"),
    )
    .await;
    assert_eq!(missing["error"], "message not found");
    assert_eq!(cross_owner, missing);
}

#[tokio::test]
async fn caller_and_server_scopes_narrow_what_the_owner_can_read() {
    let (store, ids) = seeded("alice-thread", owned("alice"), 3).await;
    store
        .ensure_conversation("alice-other", None, None, owned("alice"))
        .await
        .unwrap();
    let outside_requested = read(
        &store,
        json!({ "around_message_id": ids[1], "conversation_ids": ["alice-other"] }),
        &principal("alice"),
    )
    .await;
    assert_eq!(outside_requested["error"], "message not found");

    let scope = vec!["alice-other".to_owned()];
    let outside_scope = dispatch_scoped(
        "search",
        json!({ "around_message_id": ids[1] }),
        &store,
        &principal("alice"),
        Some(&scope),
    )
    .await
    .expect("dispatch");
    assert_eq!(outside_scope["error"], "message not found");
}

#[tokio::test]
async fn disabled_chat_memory_reports_unavailable() {
    let (store, ids) = seeded("thread", Tenancy::Unattributed, 2).await;
    store.set_chat_memory_enabled(false).await.unwrap();
    let out = read(
        &store,
        json!({ "around_message_id": ids[0] }),
        &ToolPrincipal::Unrestricted,
    )
    .await;
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["available"], json!(false));
}

#[tokio::test]
async fn malformed_window_arguments_are_errors() {
    let (store, ids) = seeded("thread", Tenancy::Unattributed, 2).await;
    for args in [
        json!({ "around_message_id": 7 }),
        json!({ "around_message_id": ids[0], "before": -1 }),
        json!({ "around_message_id": ids[0], "after": "two" }),
    ] {
        assert!(
            dispatch("search", args.clone(), &store, &ToolPrincipal::Unrestricted)
                .await
                .is_err(),
            "{args}"
        );
    }
}

#[test]
fn long_messages_are_truncated_on_a_char_boundary() {
    let long = "é".repeat(MESSAGE_MAX_CHARS + 5);
    let cut = truncate(&long);
    assert_eq!(cut.chars().count(), MESSAGE_MAX_CHARS + 1);
    assert!(cut.ends_with('…'));
    assert_eq!(truncate("short"), "short");
}
