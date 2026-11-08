//! Hosted broker tools over the network JSON-RPC transport.

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::broker::sessions;
use axum::http::{HeaderMap, HeaderValue};

const SESSION_HEADER: &str = hosted_mcp::BROKER_SESSION_HEADER;

fn registry() -> Arc<McpRegistry> {
    Arc::new(McpRegistry::empty())
}

async fn mint() -> String {
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    let store = crate::plugin_secrets::global().unwrap();
    let conn = store.conn.lock().await;
    sessions::mint(
        &conn,
        sessions::MintRequest {
            environment: "default".into(),
            services: vec![format!(
                "svc-{}",
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            )],
            label: String::new(),
            ttl_secs: None,
            minted_by: format!("user:{}", uuid::Uuid::new_v4()),
            not_after: None,
            minted_token: None,
            minter_scope: None,
        },
    )
    .unwrap()
    .0
}

fn with_session(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(SESSION_HEADER, HeaderValue::from_str(token).unwrap());
    headers
}

async fn listed(
    mcp: Arc<McpRegistry>,
    allowlist: Option<Vec<String>>,
    headers: &HeaderMap,
) -> Vec<String> {
    listed_as(mcp, "ryu", allowlist, headers).await
}

async fn listed_as(
    mcp: Arc<McpRegistry>,
    agent_id: &str,
    allowlist: Option<Vec<String>>,
    headers: &HeaderMap,
) -> Vec<String> {
    let list = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
    let response = serve_http_jsonrpc_versioned_with_headers(
        mcp,
        agent_id.to_owned(),
        allowlist,
        Vec::new(),
        &list,
        false,
        headers,
    )
    .await
    .unwrap();
    response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap().to_owned())
        .collect()
}

async fn call(headers: &HeaderMap, name: &str, arguments: Value) -> Value {
    let message = json!({
        "jsonrpc": "2.0", "id": 7, "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    serve_http_jsonrpc_versioned_with_headers(
        registry(),
        "ryu".to_owned(),
        None,
        Vec::new(),
        &message,
        false,
        headers,
    )
    .await
    .unwrap()
}

fn broker_tools(names: &[String]) -> Vec<&str> {
    names
        .iter()
        .map(String::as_str)
        .filter(|name| name.starts_with("ryu_broker_"))
        .collect()
}

#[tokio::test]
async fn broker_tools_are_listed_only_with_a_broker_credential() {
    let none = listed(registry(), None, &HeaderMap::new()).await;
    assert!(broker_tools(&none).is_empty(), "{none:?}");
    // The meta-tools are still there: the list was extended, not replaced.
    assert!(none.iter().any(|name| name == "tool_search"));

    let with = listed(registry(), None, &with_session("rvb_any")).await;
    assert_eq!(
        broker_tools(&with),
        [
            "ryu_broker_discover",
            "ryu_broker_proposal",
            "ryu_broker_propose"
        ]
    );
    assert!(with.iter().any(|name| name == "tool_search"));
    let mut sorted = with.clone();
    sorted.sort();
    assert_eq!(with, sorted, "the merged list stays sorted");
}

#[tokio::test]
async fn an_explicit_allowlist_must_name_each_broker_tool() {
    let headers = with_session("rvb_any");
    let narrow = listed(
        registry(),
        Some(vec!["threads.list_threads".to_owned()]),
        &headers,
    )
    .await;
    assert!(broker_tools(&narrow).is_empty(), "{narrow:?}");
    let one = listed(
        registry(),
        Some(vec!["ryu_broker_discover".to_owned()]),
        &headers,
    )
    .await;
    assert_eq!(broker_tools(&one), ["ryu_broker_discover"]);
    let all = listed(registry(), Some(vec!["*".to_owned()]), &headers).await;
    assert_eq!(broker_tools(&all).len(), 3);

    let message = json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": "ryu_broker_propose", "arguments": { "message": "x" } },
    });
    let refused = serve_http_jsonrpc_versioned_with_headers(
        registry(),
        "ryu".to_owned(),
        Some(vec!["ryu_broker_discover".to_owned()]),
        Vec::new(),
        &message,
        false,
        &headers,
    )
    .await
    .unwrap();
    assert_eq!(refused["result"]["isError"], true);
    assert!(refused["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("not allowed"));
}

#[tokio::test]
async fn an_unknown_agent_record_is_offered_no_broker_tools() {
    let agents = crate::agents::AgentStore::open_in_memory(
        &crate::sidecar::adapters::AcpAgentRegistry::new(),
    )
    .unwrap();
    let mcp = Arc::new(McpRegistry::empty().with_agent_store(agents));
    let names = listed_as(mcp, "ghost-agent", None, &with_session("rvb_any")).await;
    assert!(broker_tools(&names).is_empty(), "{names:?}");
}

#[tokio::test]
async fn calls_need_the_broker_credential_not_the_node_bearer() {
    let mut node_only = HeaderMap::new();
    node_only.insert(
        axum::http::header::AUTHORIZATION,
        HeaderValue::from_static("Bearer node-token"),
    );
    let refused = call(&node_only, "ryu_broker_discover", json!({})).await;
    assert_eq!(refused["id"], 7);
    assert_eq!(refused["result"]["isError"], true);
    let text = refused["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains(SESSION_HEADER), "{text}");
    assert!(!text.contains("node-token"), "{text}");
}

#[tokio::test]
async fn a_brokered_agent_discovers_and_files_a_proposal_over_hosted_mcp() {
    let token = mint().await;
    let headers = with_session(&token);
    let discovered = call(&headers, "ryu_broker_discover", json!({})).await;
    assert_eq!(discovered["result"]["isError"], false, "{discovered}");
    let text = discovered["result"]["content"][0]["text"].as_str().unwrap();
    let document: Value = serde_json::from_str(text).unwrap();
    assert_eq!(document["environment"], "default");

    let filed = call(
        &headers,
        "ryu_broker_propose",
        json!({
            "message": "need the Linear token",
            "credentials": [{ "ref": "secret:HOSTED_BRIDGE_LINEAR" }],
        }),
    )
    .await;
    assert_eq!(filed["result"]["isError"], false, "{filed}");
    let text = filed["result"]["content"][0]["text"].as_str().unwrap();
    assert!(!text.contains(&token), "the session token is never echoed");
    let proposal: Value = serde_json::from_str(text).unwrap();
    assert_eq!(proposal["proposal"]["status"], "pending");
}

#[tokio::test]
async fn other_tool_calls_still_reach_the_registry() {
    let answer = call(&with_session("rvb_any"), "nope.missing", json!({})).await;
    assert_eq!(answer["result"]["isError"], true);
    let text = answer["result"]["content"][0]["text"].as_str().unwrap();
    assert!(!text.contains(SESSION_HEADER), "{text}");
}

async fn call_as(mcp: Arc<McpRegistry>, agent_id: &str, name: &str, arguments: Value) -> Value {
    let message = json!({
        "jsonrpc": "2.0", "id": 9, "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    serve_http_jsonrpc_versioned_with_headers(
        mcp,
        agent_id.to_owned(),
        None,
        Vec::new(),
        &message,
        false,
        &with_session("rvb_any"),
    )
    .await
    .unwrap()
}

fn refused_as_not_allowed(answer: &Value) -> bool {
    answer["result"]["isError"] == true
        && answer["result"]["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("not allowed"))
}

#[tokio::test]
async fn the_agents_posture_gates_each_broker_tool() {
    use crate::agents::{AgentLifecycleStatus, AgentSafetyProfile, CreateAgent, UpdateAgent};
    let agents = crate::agents::AgentStore::open_in_memory(
        &crate::sidecar::adapters::AcpAgentRegistry::new(),
    )
    .unwrap();
    let create = |name: &str| {
        let agents = agents.clone();
        let name = name.to_owned();
        async move {
            agents
                .create(CreateAgent {
                    name,
                    ..CreateAgent::default()
                })
                .await
                .unwrap()
        }
    };
    let activate = |id: String, profile: AgentSafetyProfile| {
        let agents = agents.clone();
        async move {
            let record = agents
                .update(
                    &id,
                    UpdateAgent {
                        lifecycle_status: Some(AgentLifecycleStatus::Active),
                        safety_profile: Some(profile),
                        ..UpdateAgent::default()
                    },
                )
                .await
                .unwrap()
                .unwrap();
            assert_eq!(record.lifecycle_status, AgentLifecycleStatus::Active);
            assert_eq!(record.safety_profile, profile);
            record.id
        }
    };
    let trial = create("Trial broker").await;
    assert_eq!(trial.lifecycle_status, AgentLifecycleStatus::Trial);
    let read_only = activate(
        create("Read-only broker").await.id,
        AgentSafetyProfile::ReadOnly,
    )
    .await;
    let plan_only = activate(
        create("Plan-only broker").await.id,
        AgentSafetyProfile::VerifiedPlanOnly,
    )
    .await;
    let autonomous = activate(
        create("Autonomous broker").await.id,
        AgentSafetyProfile::Autonomous,
    )
    .await;
    let mcp = Arc::new(McpRegistry::empty().with_agent_store(agents.clone()));
    let headers = with_session("rvb_any");
    let names = |agent: String| {
        let mcp = Arc::clone(&mcp);
        let headers = headers.clone();
        async move { listed_as(mcp, &agent, None, &headers).await }
    };

    // A verified-plan-only agent is offered and served none of the tools.
    let listed = names(plan_only.clone()).await;
    assert!(broker_tools(&listed).is_empty(), "{listed:?}");
    for tool in [
        "ryu_broker_discover",
        "ryu_broker_propose",
        "ryu_broker_proposal",
    ] {
        let answer = call_as(
            Arc::clone(&mcp),
            &plan_only,
            tool,
            json!({ "id": "x", "message": "m" }),
        )
        .await;
        assert!(refused_as_not_allowed(&answer), "{tool}: {answer}");
    }

    // Read-only and trial agents may discover and poll, never propose.
    for agent in [read_only, trial.id] {
        let listed = names(agent.clone()).await;
        assert_eq!(
            broker_tools(&listed),
            ["ryu_broker_discover", "ryu_broker_proposal"],
            "{agent}"
        );
        let answer = call_as(
            Arc::clone(&mcp),
            &agent,
            "ryu_broker_propose",
            json!({ "message": "need a token" }),
        )
        .await;
        assert!(refused_as_not_allowed(&answer), "{agent}: {answer}");
    }

    // An autonomous agent is offered all three.
    let listed = names(autonomous).await;
    assert_eq!(broker_tools(&listed).len(), 3, "{listed:?}");
}
