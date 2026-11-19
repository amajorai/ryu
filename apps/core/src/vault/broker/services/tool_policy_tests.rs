use serde_json::json;

use super::*;

const JSON: Option<&str> = Some("application/json");

fn policy(allow: Option<&[&str]>, deny: &[&str]) -> McpToolPolicy {
    McpToolPolicy {
        allow: allow.map(|list| list.iter().map(|s| (*s).to_owned()).collect()),
        deny: deny.iter().map(|s| (*s).to_owned()).collect(),
    }
    .normalize()
    .unwrap()
}

#[test]
fn deny_wins_and_an_absent_allow_permits_the_rest() {
    let open = policy(None, &["delete_*", "drop_table"]);
    assert!(open.permits("create_issue"));
    assert!(!open.permits("delete_repo"));
    assert!(!open.permits("drop_table"));
    assert!(open.permits("drop_tables"));

    let listed = policy(Some(&["search", "get_*"]), &["get_secret"]);
    assert!(listed.permits("search"));
    assert!(listed.permits("get_issue"));
    assert!(!listed.permits("get_secret"));
    assert!(!listed.permits("create_issue"));

    let closed = policy(Some(&[]), &[]);
    assert!(!closed.permits("search"));
}

#[test]
fn patterns_are_checked_and_deduplicated() {
    for bad in ["", "a*b", "*x*", "with space", "ta\tb"] {
        let result = McpToolPolicy {
            allow: None,
            deny: vec![bad.to_owned()],
        }
        .normalize();
        assert!(result.is_err(), "{bad:?}");
    }
    let too_many = McpToolPolicy {
        allow: Some((0..=MAX_PATTERNS).map(|i| format!("t{i}")).collect()),
        deny: Vec::new(),
    };
    assert!(too_many.normalize().is_err());
    let normalized = policy(Some(&[" b ", "a", "b"]), &["*"]);
    assert_eq!(normalized.allow, Some(vec!["a".to_owned(), "b".to_owned()]));
    assert!(!normalized.permits("a"), "a lone `*` denies every tool");
}

#[test]
fn every_message_of_a_batch_is_read_past_the_logging_cap() {
    let mut batch: Vec<Value> = (0..40)
        .map(|id| json!({"jsonrpc": "2.0", "id": id, "method": "ping"}))
        .collect();
    batch.push(
        json!({"jsonrpc": "2.0", "id": "late", "method": "tools/call",
        "params": {"name": "delete_repo", "arguments": {"token": "__T__"}}}),
    );
    let body = serde_json::to_vec(&batch).unwrap();
    let calls = tool_calls(JSON, None, &body).unwrap();
    assert_eq!(
        calls,
        vec![ToolCall {
            id: Some(json!("late")),
            name: Some("delete_repo".into()),
        }]
    );
    assert_eq!(message_ids(&body).len(), 41);
}

#[test]
fn ids_keep_their_json_type_and_odd_names_stay_raw() {
    let body = br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"a\nb"}}"#;
    let calls = tool_calls(JSON, None, body).unwrap();
    assert_eq!(calls[0].id, Some(json!(7)));
    assert_eq!(calls[0].name.as_deref(), Some("a\nb"));
    let unnamed = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":5}}"#;
    assert_eq!(tool_calls(JSON, None, unnamed).unwrap()[0].name, None);
}

#[test]
fn bodies_that_cannot_be_read_are_refused() {
    let call = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}"#;
    assert_eq!(
        tool_calls(JSON, Some("gzip"), call),
        Err(Uninspectable::Encoded)
    );
    assert_eq!(
        tool_calls(Some("text/plain"), None, call),
        Err(Uninspectable::NotJson)
    );
    assert_eq!(tool_calls(None, None, call), Err(Uninspectable::NotJson));
    assert_eq!(
        tool_calls(JSON, None, b"{not json"),
        Err(Uninspectable::NotJson)
    );
    assert_eq!(
        tool_calls(JSON, None, b"[1, 2]"),
        Err(Uninspectable::NotJsonRpc)
    );
    assert_eq!(
        tool_calls(JSON, None, br#"{"method": 3}"#),
        Err(Uninspectable::NotJsonRpc)
    );
    let mut huge = b"[".to_vec();
    huge.extend(vec![b' '; MAX_INSPECT_BYTES]);
    huge.push(b']');
    assert_eq!(tool_calls(JSON, None, &huge), Err(Uninspectable::TooLarge));
    // Nothing to read and responses to server requests carry no call.
    assert_eq!(tool_calls(None, Some("gzip"), b"  "), Ok(Vec::new()));
    let response = br#"{"jsonrpc":"2.0","id":3,"result":{}}"#;
    assert_eq!(tool_calls(JSON, Some("identity"), response), Ok(Vec::new()));
}
