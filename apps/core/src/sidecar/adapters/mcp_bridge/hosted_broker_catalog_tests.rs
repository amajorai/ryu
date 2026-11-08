//! `tool_search` and `describe` for the hosted broker tools.

use super::*;
use axum::http::{HeaderMap, HeaderValue};

fn with_session() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        hosted_mcp::BROKER_SESSION_HEADER,
        HeaderValue::from_static("rvb_any"),
    );
    headers
}

async fn meta_call(
    allowlist: Option<Vec<String>>,
    headers: &HeaderMap,
    name: &str,
    arguments: Value,
) -> Value {
    let message = json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    serve_http_jsonrpc_versioned_with_headers(
        Arc::new(McpRegistry::empty()),
        "ryu".to_owned(),
        allowlist,
        Vec::new(),
        &message,
        false,
        headers,
    )
    .await
    .unwrap()["result"]
        .clone()
}

async fn search_ids(
    allowlist: Option<Vec<String>>,
    headers: &HeaderMap,
    args: Value,
) -> Vec<String> {
    let result = meta_call(allowlist, headers, "tool_search", args).await;
    assert_eq!(result["isError"], false, "{result}");
    let envelope: Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    envelope["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect()
}

fn tool(name: &str) -> hosted_mcp::HostedTool {
    hosted_mcp::tools()
        .into_iter()
        .find(|tool| tool.name == name)
        .unwrap()
}

#[test]
fn score_counts_the_query_words_a_tool_mentions() {
    let propose = tool(hosted_mcp::PROPOSE);
    assert_eq!(score(&propose, "propose a broker service"), Some(1.0));
    assert_eq!(score(&propose, "broker weather"), Some(0.5));
    assert_eq!(score(&propose, "weather forecast"), None);
    // Stopwords alone are not a match, and an empty query lists everything.
    assert_eq!(score(&propose, "the and for"), None);
    assert_eq!(score(&propose, "  "), Some(0.0));
}

#[test]
fn describe_carries_the_schema_and_read_only_flag() {
    let discover = described(&tool(hosted_mcp::DISCOVER));
    assert!(discover.read_only);
    assert_eq!(discover.kind, ToolKind::Builtin);
    assert_eq!(discover.args.len(), 1);
    assert_eq!(discover.args[0].name, "environment");
    let propose = described(&tool(hosted_mcp::PROPOSE));
    assert!(!propose.read_only);
    assert!(propose
        .args
        .iter()
        .any(|arg| arg.name == "message" && arg.required));
    assert!(propose.parameters.is_some());
}

#[tokio::test]
async fn tool_search_finds_the_broker_tools_only_with_a_broker_credential() {
    let query = json!({ "query": "propose broker credentials after a 403" });
    let found = search_ids(None, &with_session(), query.clone()).await;
    assert_eq!(found.first().map(String::as_str), Some(hosted_mcp::PROPOSE));
    assert!(
        found.iter().any(|id| id == hosted_mcp::DISCOVER),
        "{found:?}"
    );

    let without = search_ids(None, &HeaderMap::new(), query).await;
    assert!(
        !without.iter().any(|id| hosted_mcp::is_tool(id)),
        "{without:?}"
    );
}

#[tokio::test]
async fn tool_search_respects_the_allowlist_kind_and_limit() {
    let headers = with_session();
    let query = json!({ "query": "broker" });
    let narrow = search_ids(
        Some(vec![
            "tool_search".to_owned(),
            hosted_mcp::DISCOVER.to_owned(),
        ]),
        &headers,
        query.clone(),
    )
    .await;
    // The registry's own rows are not allowlist-scoped here; among the broker
    // tools only the allowlisted one is found, and it leads.
    let broker: Vec<&String> = narrow.iter().filter(|id| hosted_mcp::is_tool(id)).collect();
    assert_eq!(broker, [hosted_mcp::DISCOVER]);
    assert_eq!(
        narrow.first().map(String::as_str),
        Some(hosted_mcp::DISCOVER)
    );

    let composio = search_ids(
        None,
        &headers,
        json!({ "query": "broker", "kind": "composio" }),
    )
    .await;
    assert!(
        !composio.iter().any(|id| hosted_mcp::is_tool(id)),
        "{composio:?}"
    );

    let one = search_ids(None, &headers, json!({ "query": "broker", "limit": 1 })).await;
    assert_eq!(one.len(), 1);
}

#[tokio::test]
async fn describe_answers_for_an_offered_broker_tool_only() {
    let args = json!({ "id": hosted_mcp::PROPOSAL });
    let result = meta_call(None, &with_session(), "describe", args.clone()).await;
    assert_eq!(result["isError"], false, "{result}");
    let described: Value =
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(described["id"], hosted_mcp::PROPOSAL);
    assert_eq!(described["args"][0]["name"], "id");
    assert_eq!(described["args"][0]["required"], true);

    // No credential: the registry answers, and it does not know the id.
    let refused = meta_call(None, &HeaderMap::new(), "describe", args.clone()).await;
    assert_eq!(refused["isError"], true, "{refused}");
    // An allowlist that does not name the tool hides it the same way.
    let hidden = meta_call(
        Some(vec!["describe".to_owned()]),
        &with_session(),
        "describe",
        args,
    )
    .await;
    assert_eq!(hidden["isError"], true, "{hidden}");
}
