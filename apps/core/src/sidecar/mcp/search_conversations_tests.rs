//! Tests for the `search_conversations.search` agent tool: tenancy, modes,
//! exact + semantic fusion, time filters, and conversation titles.

use super::*;
use crate::server::conversations::Tenancy;

#[test]
fn lists_search_tool_with_qualified_id() {
    let tools = tools();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].id, "search_conversations.search");
    assert_eq!(tools[0].server, SERVER_NAME);
    let schema = tools[0].input_schema.as_ref().expect("schema");
    assert_eq!(
        schema["properties"]["mode"]["enum"],
        json!(["all", "exact", "semantic"])
    );
    assert!(schema["properties"]["since"].is_object());
    assert!(schema["properties"]["until"].is_object());
}

#[tokio::test]
async fn missing_query_is_an_error() {
    let store = ConversationStore::open_in_memory().expect("store");
    assert!(
        dispatch("search", json!({}), &store, &ToolPrincipal::Unrestricted)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn unknown_tool_is_an_error() {
    let store = ConversationStore::open_in_memory().expect("store");
    assert!(dispatch(
        "nope",
        json!({ "query": "x" }),
        &store,
        &ToolPrincipal::Unrestricted
    )
    .await
    .is_err());
}

#[tokio::test]
async fn unavailable_index_returns_graceful_envelope() {
    // open_in_memory wires no message index, so search reports unavailable.
    let store = ConversationStore::open_in_memory().expect("store");
    let out = dispatch(
        "search",
        json!({ "query": "hello" }),
        &store,
        &ToolPrincipal::Unrestricted,
    )
    .await
    .expect("dispatch ok");
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["available"], json!(false));
}

#[tokio::test]
async fn enabled_memory_without_any_index_is_unavailable() {
    let store = ConversationStore::open_in_memory().expect("store");
    store.set_chat_memory_enabled(true).await.unwrap();
    store
        .append_message("c1", "user", "hello", None, None, None)
        .await
        .unwrap();
    let out = dispatch(
        "search",
        json!({ "query": "hello", "mode": "all" }),
        &store,
        &ToolPrincipal::Unrestricted,
    )
    .await
    .expect("dispatch ok");
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["available"], json!(false));
}

// ══════════════════════════════════════════════════════════════════════════
// THE SEMANTIC-SEARCH LEAK. `search_messages` took a CALLER-SUPPLIED
// `conversation_ids` and applied NO tenancy filter, while its REST twin
// (`search_conversations_handler`) filtered via `visible_conversation_ids`.
// That asymmetry WAS the bug: "search my past conversations for the Q3
// numbers" ran across every user's messages.
// ══════════════════════════════════════════════════════════════════════════

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

/// A store with chat memory on and BOTH the exact (FTS) and semantic (local
/// hashing) message indexes wired.
async fn indexed_store() -> ConversationStore {
    let store = ConversationStore::open_in_memory()
        .expect("store")
        .with_message_index(crate::search_host::in_memory_message_index().unwrap())
        .with_message_fts_index(ryu_search::MessageFtsIndex::open_in_memory().unwrap());
    store.set_chat_memory_enabled(true).await.unwrap();
    store
}

async fn add(store: &ConversationStore, conv: &str, text: &str, tenancy: Tenancy, at: i64) {
    store
        .append_message_at(conv, "user", text, None, None, None, tenancy, Some(at))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_caller_supplied_conversation_id_is_intersected_never_widened() {
    let store = indexed_store().await;
    add(
        &store,
        "alice-thread",
        "q3 revenue numbers",
        owned("alice"),
        1_000,
    )
    .await;
    store
        .ensure_conversation("bob-thread", None, None, owned("bob"))
        .await
        .unwrap();

    // Bob's agent explicitly NAMES Alice's conversation. The intersection empties
    // the id set, so the search short-circuits to zero results — it must never
    // fall through to an UNFILTERED (`None`) search, in any mode.
    for mode in ["all", "exact", "semantic"] {
        let out = dispatch(
            "search",
            json!({ "query": "q3 revenue", "mode": mode, "conversation_ids": ["alice-thread"] }),
            &store,
            &principal("bob"),
        )
        .await
        .expect("dispatch");
        assert_eq!(out["ok"], json!(true), "mode {mode}");
        assert_eq!(out["count"], json!(0), "mode {mode}");
        assert_eq!(out["results"], json!([]), "mode {mode}");
    }
}

#[tokio::test]
async fn an_empty_visible_set_returns_nothing_even_with_indexed_messages() {
    let store = indexed_store().await;
    add(
        &store,
        "alice-thread",
        "q3 revenue numbers",
        owned("alice"),
        1_000,
    )
    .await;
    // Carol owns nothing, so her visible set is empty: no hits from Alice's chat.
    let out = dispatch(
        "search",
        json!({ "query": "q3 revenue" }),
        &store,
        &principal("carol"),
    )
    .await
    .expect("dispatch");
    assert_eq!(out["count"], json!(0));
    assert_eq!(out["results"], json!([]));
}

/// FAIL CLOSED on a bound node with no resolvable principal.
#[tokio::test]
async fn an_unresolved_principal_searches_nothing() {
    let store = indexed_store().await;
    add(
        &store,
        "alice-thread",
        "anything at all",
        owned("alice"),
        1_000,
    )
    .await;
    let out = dispatch(
        "search",
        json!({ "query": "anything" }),
        &store,
        &ToolPrincipal::Unresolved,
    )
    .await
    .expect("dispatch");
    assert_eq!(out["count"], json!(0));
}

#[tokio::test]
async fn mode_is_validated() {
    let store = indexed_store().await;
    for mode in ["all", "exact", "semantic", "EXACT"] {
        let out = dispatch(
            "search",
            json!({ "query": "hello", "mode": mode }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await
        .unwrap_or_else(|e| panic!("mode {mode} rejected: {e}"));
        assert_eq!(out["ok"], json!(true), "mode {mode}");
    }
    for bad in [json!("fuzzy"), json!(3)] {
        let result = dispatch(
            "search",
            json!({ "query": "hello", "mode": bad }),
            &store,
            &ToolPrincipal::Unrestricted,
        )
        .await;
        assert!(result.is_err(), "mode {bad} should be rejected");
    }
}

#[tokio::test]
async fn exact_identifier_is_found_and_ranked_first_with_title() {
    let store = indexed_store().await;
    let me = owned("alice");
    add(
        &store,
        "build",
        "the borrow checker raised E0499 in parser.rs",
        me.clone(),
        1_000,
    )
    .await;
    store
        .set_title("build", "Parser build failure")
        .await
        .unwrap();
    for (i, text) in [
        "we discussed the database schema migration plan",
        "lunch options near the office",
        "notes on the quarterly roadmap review",
    ]
    .iter()
    .enumerate()
    {
        add(&store, &format!("other-{i}"), text, me.clone(), 2_000).await;
    }

    // Exact mode returns only the message that literally contains the token.
    let exact = dispatch(
        "search",
        json!({ "query": "E0499", "mode": "exact" }),
        &store,
        &principal("alice"),
    )
    .await
    .unwrap();
    assert_eq!(exact["count"], json!(1));
    assert_eq!(exact["results"][0]["conversation_id"], json!("build"));
    assert_eq!(exact["results"][0]["matched_by"], json!("exact"));
    assert_eq!(
        exact["results"][0]["conversation_title"],
        json!("Parser build failure")
    );

    // The default (all) mode fuses both lists; the literal match leads.
    let all = dispatch(
        "search",
        json!({ "query": "E0499", "limit": 1 }),
        &store,
        &principal("alice"),
    )
    .await
    .unwrap();
    assert_eq!(all["sources"], json!({ "exact": true, "semantic": true }));
    assert_eq!(all["count"], json!(1));
    assert_eq!(all["results"][0]["conversation_id"], json!("build"));
    assert!(all["results"][0]["snippet"]
        .as_str()
        .unwrap()
        .contains("E0499"));
}

#[tokio::test]
async fn since_and_until_filter_by_message_time() {
    let store = indexed_store().await;
    let me = owned("alice");
    // 2026-01-01T00:00:00Z and 2026-06-01T00:00:00Z in unix millis.
    let january = 1_767_225_600_000;
    let june = 1_780_272_000_000;
    add(
        &store,
        "old",
        "deploy checklist for kubernetes",
        me.clone(),
        january,
    )
    .await;
    add(
        &store,
        "new",
        "deploy checklist for kubernetes v2",
        me.clone(),
        june,
    )
    .await;

    let search = |args: Value| {
        let store = store.clone();
        async move {
            dispatch("search", args, &store, &principal("alice"))
                .await
                .unwrap()
        }
    };
    let ids = |out: &Value| -> Vec<String> {
        out["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["conversation_id"].as_str().unwrap().to_owned())
            .collect()
    };

    let both = search(json!({ "query": "deploy checklist" })).await;
    assert_eq!(both["count"], json!(2));

    let since = search(json!({ "query": "deploy checklist", "since": "2026-03-01" })).await;
    assert_eq!(ids(&since), vec!["new".to_owned()]);

    let until =
        search(json!({ "query": "deploy checklist", "until": "2026-03-01T00:00:00Z" })).await;
    assert_eq!(ids(&until), vec!["old".to_owned()]);

    // Unix seconds work too; the bounds are inclusive.
    let exact_second = search(json!({
        "query": "deploy checklist",
        "since": june / 1000,
        "until": june / 1000
    }))
    .await;
    assert_eq!(ids(&exact_second), vec!["new".to_owned()]);

    let bad = dispatch(
        "search",
        json!({ "query": "deploy", "since": "last tuesday" }),
        &store,
        &principal("alice"),
    )
    .await;
    assert!(bad.is_err());
}

fn hit(id: &str, conv: &str, at: i64) -> MessageSearchHit {
    MessageSearchHit {
        conversation_id: conv.to_owned(),
        message_id: id.to_owned(),
        role: "user".to_owned(),
        content: format!("message {id}"),
        created_at: at,
        score: 0.5,
    }
}

#[test]
fn merge_ranks_a_hit_found_by_both_searches_first() {
    let exact = vec![hit("m1", "c1", 1), hit("m2", "c1", 1)];
    let semantic = vec![hit("m3", "c2", 1), hit("m2", "c1", 1)];
    let fused = merge_hits(Some(exact), Some(semantic), None, TimeWindow::default(), 10);
    let order: Vec<&str> = fused.iter().map(|f| f.hit.message_id.as_str()).collect();
    assert_eq!(order, vec!["m2", "m1", "m3"]);
    assert_eq!(fused[0].matched_by, "both");
    assert_eq!(fused[1].matched_by, "exact");
    assert_eq!(fused[2].matched_by, "semantic");
    assert!(fused[0].score > fused[1].score);
}

#[test]
fn merge_drops_hits_outside_the_allowed_set_and_window() {
    let exact = vec![hit("m1", "mine", 50), hit("m2", "theirs", 50)];
    let semantic = vec![hit("m3", "mine", 5), hit("m4", "mine", 500)];
    let allowed = vec!["mine".to_owned()];
    let window = TimeWindow {
        since: Some(10),
        until: Some(100),
    };
    let fused = merge_hits(Some(exact), Some(semantic), Some(&allowed), window, 10);
    let order: Vec<&str> = fused.iter().map(|f| f.hit.message_id.as_str()).collect();
    assert_eq!(order, vec!["m1"]);
}

#[test]
fn merge_with_a_single_list_keeps_its_order_score_and_limit() {
    let semantic = vec![hit("a", "c", 1), hit("b", "c", 1), hit("c", "c", 1)];
    let fused = merge_hits(None, Some(semantic), None, TimeWindow::default(), 2);
    let order: Vec<&str> = fused.iter().map(|f| f.hit.message_id.as_str()).collect();
    assert_eq!(order, vec!["a", "b"]);
    assert!(fused.iter().all(|f| f.matched_by == "semantic"));
    assert!((fused[0].score - 0.5).abs() < f32::EPSILON);
}

#[test]
fn time_bounds_accept_rfc3339_dates_and_unix_values() {
    let parse = |v: Value| parse_time_bound(&json!({ "t": v }), "t").unwrap();
    assert_eq!(parse(json!("2026-01-01")), Some(1_767_225_600_000));
    assert_eq!(
        parse(json!("2026-01-01T00:00:00Z")),
        Some(1_767_225_600_000)
    );
    assert_eq!(
        parse(json!("2026-01-01T01:00:00+01:00")),
        Some(1_767_225_600_000)
    );
    assert_eq!(parse(json!(1_767_225_600)), Some(1_767_225_600_000));
    assert_eq!(parse(json!("1767225600")), Some(1_767_225_600_000));
    assert_eq!(parse(json!(1_767_225_600_000_i64)), Some(1_767_225_600_000));
    assert_eq!(parse(Value::Null), None);
    assert!(parse_time_bound(&json!({ "t": "soon" }), "t").is_err());
    assert!(parse_time_bound(&json!({ "t": true }), "t").is_err());
}
