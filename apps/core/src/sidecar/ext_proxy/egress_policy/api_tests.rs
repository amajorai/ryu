//! The allowlist routes through their real handlers and the node's agent
//! store. The caller is the node owner (no verified user), whom the agent ACL
//! admits.

use super::api::write_allowlist;
use crate::agents::CreateAgent;
use axum::http::StatusCode;
use serde_json::Value;

async fn read(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[tokio::test]
async fn writes_are_normalized_validated_and_need_an_existing_agent() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let agent_id = state
        .agent_store
        .create(CreateAgent {
            name: "Egress allowlist agent".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap()
        .id;

    let hosts = strings(&["Example.com", "*.example.org"]);
    let (status, body) =
        read(write_allowlist(&state, &None, &agent_id, Some(hosts.as_slice())).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["allowlist"],
        serde_json::json!(["*.example.org", "example.com"])
    );
    assert_eq!(
        super::global().get(&agent_id).unwrap(),
        Some(strings(&["*.example.org", "example.com"]))
    );

    let bad = strings(&["example.com:443"]);
    let (status, body) =
        read(write_allowlist(&state, &None, &agent_id, Some(bad.as_slice())).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("host name"));
    assert_eq!(
        super::global().get(&agent_id).unwrap(),
        Some(strings(&["*.example.org", "example.com"])),
        "a refused write keeps the stored list"
    );

    let (status, body) = read(write_allowlist(&state, &None, &agent_id, None).await).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["allowlist"].is_null());
    assert_eq!(super::global().get(&agent_id).unwrap(), None);

    let (status, _) = read(
        write_allowlist(
            &state,
            &None,
            "egress-allowlist-no-such-agent",
            Some(hosts.as_slice()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        super::global()
            .get("egress-allowlist-no-such-agent")
            .unwrap(),
        None
    );
}
