use serde_json::json;

use super::*;

const JSON: Option<&str> = Some("application/json");

fn deny(tools: &[&str]) -> McpToolPolicy {
    McpToolPolicy {
        allow: None,
        deny: tools.iter().map(|s| (*s).to_owned()).collect(),
    }
}

async fn body_json(refusal: Refusal) -> (StatusCode, Value) {
    let status = refusal.response.status();
    let bytes = refusal
        .response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn permitted_calls_and_other_methods_pass() {
    let policy = deny(&["delete_*"]);
    let body = br#"[{"jsonrpc":"2.0","id":1,"method":"tools/list"},
        {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search"}}]"#;
    assert_eq!(decide(&policy, JSON, None, body), Ok(()));
    assert_eq!(decide(&policy, None, None, b""), Ok(()));
}

#[tokio::test]
async fn a_denied_call_gets_a_json_rpc_error_with_its_own_id() {
    let policy = deny(&["delete_*"]);
    let body = br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"delete_repo","arguments":{"t":"__X__"}}}"#;
    let denial = decide(&policy, JSON, None, body).unwrap_err();
    assert_eq!(denial.tools(), vec!["delete_repo".to_owned()]);
    let refusal = denial.refusal(body);
    assert_eq!(refusal.outcome, "mcp_tool_denied");
    assert_eq!(
        refusal.response.headers().get(ERROR_HEADER).unwrap(),
        "mcp_tool_denied"
    );
    let (status, value) = body_json(refusal).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["id"], json!(7));
    assert_eq!(value["error"]["code"], json!(TOOL_DENIED_CODE));
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("delete_repo"));
    assert!(!value.to_string().contains("__X__"));
}

#[tokio::test]
async fn a_batch_with_a_denied_call_is_refused_whole() {
    let policy = McpToolPolicy {
        allow: Some(vec!["search".into()]),
        deny: Vec::new(),
    };
    let body = br#"[{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"search"}},
        {"jsonrpc":"2.0","method":"notifications/initialized"},
        {"jsonrpc":"2.0","id":"b","method":"tools/call","params":{"name":"write"}}]"#;
    let denial = decide(&policy, JSON, None, body).unwrap_err();
    let (status, value) = body_json(denial.refusal(body)).await;
    assert_eq!(status, StatusCode::OK);
    let errors = value.as_array().unwrap();
    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0]["id"], json!("a"));
    assert!(errors[0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("batch"));
    assert_eq!(errors[1]["id"], json!("b"));
    assert!(errors[1]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("`write`"));
}

#[tokio::test]
async fn unreadable_bodies_and_unnamed_calls_are_refused_under_a_policy() {
    let policy = deny(&[]);
    let call = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}"#;
    let denial = decide(&policy, JSON, Some("gzip"), call).unwrap_err();
    assert_eq!(denial, Denial::Uninspectable(Uninspectable::Encoded));
    let (status, _) = body_json(denial.refusal(call)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let unnamed = br#"{"jsonrpc":"2.0","method":"tools/call","params":{"name":{"x":1}}}"#;
    let denial = decide(&policy, JSON, None, unnamed).unwrap_err();
    assert_eq!(denial.tools(), vec!["<invalid>".to_owned()]);
    // A notification has no id to answer, so the refusal is a plain 403.
    let (status, value) = body_json(denial.refusal(unnamed)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(value["error"], json!("mcp_tool_denied"));
}

#[test]
fn upgrades_are_refused_only_for_services_with_a_policy() {
    let mut service = BrokerService {
        input: crate::vault::broker::services::test_service("svc", "example.com", None, "/"),
        created_at: 0,
        updated_at: 0,
    };
    assert!(Broker::refuse_policy_upgrade(Some(&service)).is_ok());
    assert!(Broker::refuse_policy_upgrade(None).is_ok());
    service.input.mcp_tools = Some(deny(&["x"]));
    assert!(Broker::refuse_policy_upgrade(Some(&service)).is_err());
}
