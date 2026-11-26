//! The sub-agent's direct call behind `RYU_ALLOW_GATEWAY_FALLBACK=1` (CE-37):
//! keyless only. A stand-in endpoint on 127.0.0.1 records what it gets, and the
//! Gateway address is a local port that refuses connections. No test reaches a
//! live service.
use super::*;
use crate::sidecar::adapters::KEYED_DIRECT_HOP_REFUSAL;
use axum::extract::State;
use axum::Router;

/// What the stand-in endpoint received: one row per request.
#[derive(Clone, Default)]
struct Received(std::sync::Arc<tokio::sync::Mutex<Vec<serde_json::Value>>>);

/// Records the request and answers with one completion.
async fn record(
    State(received): State<Received>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    received.0.lock().await.push(serde_json::json!({
        "uri": uri.to_string(),
        "authorization": authorization,
        "body": body,
    }));
    let reply = serde_json::json!({"choices":[{"message":{"content":"stand-in answer"}}]});
    axum::response::Response::builder()
        .header("content-type", "application/json")
        .body(axum::body::Body::from(reply.to_string()))
        .unwrap()
}

/// A local address that refuses connections: a port that was free a moment ago.
fn closed_origin() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    origin
}

/// Sets the variables of one test and puts the old values back when dropped.
struct Environment(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl Environment {
    fn set(values: &[(&'static str, Option<&str>)]) -> Self {
        let previous = values
            .iter()
            .map(|(name, _)| (*name, std::env::var_os(name)))
            .collect();
        for (name, value) in values {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        Self(previous)
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        for (name, previous) in &self.0 {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// One delegate with the Gateway unreachable, the switch on, and the direct
/// endpoint a stand-in that is called with `api_key`. Returns the delegate's
/// result and what the stand-in received. The direct address is a registry
/// variable, so the caller holds `lock_registry_env` besides the Gateway lock.
async fn delegate_with_the_switch(
    api_key: Option<&str>,
) -> (DelegateResult, Vec<serde_json::Value>) {
    let received = Received::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let router: Router = Router::new().fallback(record).with_state(received.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let closed = closed_origin();
    let _environment = Environment::set(&[
        ("RYU_GATEWAY_URL", Some(closed.as_str())),
        ("RYU_ALLOW_GATEWAY_FALLBACK", Some("1")),
        ("RYU_DEFAULT_LLM_BASE_URL", Some(origin.as_str())),
        ("RYU_DEFAULT_LLM_API_KEY", api_key),
        ("OPENAI_API_KEY", None),
    ]);
    let spec = DelegateSpec {
        id: "ce37".into(),
        task: "summarise the CE-37 test".into(),
        agent_id: None,
        preset: PermissionPreset::Summarise,
        inline: None,
    };
    let caps = DelegationCaps {
        wall_time_secs: 30,
        ..Default::default()
    };
    let mut results = run_fanout(vec![spec], caps, 1, None)
        .await
        .expect("fan-out itself doesn't error");
    server.abort();
    assert_eq!(results.len(), 1);
    let rows = received.0.lock().await.clone();
    (results.remove(0), rows)
}

#[tokio::test]
async fn the_switch_does_not_take_a_key_around_the_gateway() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _registry = crate::registry::lock_registry_env();

    let (result, rows) = delegate_with_the_switch(Some("sk-ce37-delegate")).await;

    assert!(
        rows.is_empty(),
        "a keyed sub-agent call went around the Gateway: {rows:?}"
    );
    let error = result.error.as_deref().unwrap_or("");
    assert!(error.contains(KEYED_DIRECT_HOP_REFUSAL), "{error}");
    assert!(
        error.contains("The Gateway did not answer in time"),
        "{error}"
    );
    assert!(error.contains("Trying again may work"), "{error}");
    assert_eq!(result.output, None);
}

#[tokio::test]
async fn the_switch_still_sends_a_keyless_call() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _registry = crate::registry::lock_registry_env();

    let (result, rows) = delegate_with_the_switch(None).await;

    assert_eq!(result.error, None);
    assert_eq!(result.output.as_deref(), Some("stand-in answer"));
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["uri"], "/v1/chat/completions");
    assert!(rows[0]["authorization"].is_null(), "{rows:?}");
    assert!(rows[0]["body"]["messages"]
        .to_string()
        .contains("summarise the CE-37 test"));
}
