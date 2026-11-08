//! The `@ryu/browser` query lane end to end: Core's HTTP-tool signer stamps
//! the final request, and the proxy verifies it under the agent's stored
//! egress policy before stamping that allowlist for the app.

use super::*;

use axum::extract::RawQuery;
use axum::routing::get;
use axum::Router;
use std::sync::Arc;

/// What the fake Browser saw: its query, the calling agent and the allowlist.
type Seen = Arc<tokio::sync::Mutex<Vec<(Option<String>, Option<String>, Option<String>)>>>;

/// A request built the way the HTTP-tool seam sends it: the final URL signed
/// by `sign_agent_lane_request`, then replayed into the proxy.
fn signed_through_tool_seam(path_and_query: &str, agent: &str) -> Vec<(String, String)> {
    let mut request = reqwest::Client::new()
        .get(format!("http://127.0.0.1:9{path_and_query}"))
        .build()
        .expect("request");
    crate::tool_exec::sign_agent_lane_request(&mut request, Some(agent));
    request
        .headers()
        .iter()
        .map(|(name, value)| (name.as_str().to_owned(), value.to_str().unwrap().to_owned()))
        .collect()
}

fn browser_request(path_and_query: &str, headers: &[(String, String)]) -> Request {
    let mut builder = axum::http::Request::builder()
        .method("GET")
        .uri(path_and_query);
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder.body(Body::empty()).unwrap()
}

#[tokio::test]
async fn the_browser_query_lane_carries_the_stamped_allowlist() {
    use crate::sidecar::capability_consumer::test_support::{
        register_sidecar_for, reserve_port, serve,
    };
    const APP: &str = "@ryu/browser";
    // A test-only agent id no other test writes a policy for.
    let agent = "browser-lane-e2e-agent";
    let path = format!("/api/ext/{APP}/open?agent_id={agent}");

    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let port = reserve_port();
    let mut manifest = web_app(APP, None, false, &[]);
    manifest.sidecars[0].name = "engine".to_owned();
    manifest.sidecars[0].port = port;
    state.app_manifests.write().await.push(manifest);
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state.app_store.set_enabled(APP, &[]).await.unwrap();
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
    let seen: Seen = Arc::default();
    let captured = seen.clone();
    let router = Router::new().route(
        "/api/svc/open",
        get(move |RawQuery(query): RawQuery, headers: HeaderMap| {
            let captured = captured.clone();
            async move {
                let read = |name: &str| {
                    headers
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned)
                };
                captured.lock().await.push((
                    query,
                    read(HDR_CALLER_AGENT_ID),
                    read(HDR_CALLER_EGRESS_ALLOWLIST),
                ));
                "ok"
            }
        }),
    );
    let server = serve(port, router).await;
    let send = |headers: Vec<(String, String)>| {
        let path = path.clone();
        let state = &state;
        async move {
            // Boxed: the proxy future is large, and the test thread's stack is not.
            Box::pin(proxy_for_plugin(
                state,
                APP,
                "/open",
                None,
                browser_request(&path, &headers),
            ))
            .await
            .status()
        }
    };

    let store = crate::sidecar::ext_proxy::egress_policy::global();
    store
        .set(agent, Some(["example.org".to_owned()].as_slice()))
        .unwrap();
    let first = signed_through_tool_seam(&path, agent);
    assert_eq!(send(first.clone()).await, StatusCode::OK);

    // A caller copy of the allowlist is refused on the Browser lane too.
    let mut forged = first.clone();
    forged.push((
        HDR_CALLER_EGRESS_ALLOWLIST.to_owned(),
        "evil.example".to_owned(),
    ));
    assert_eq!(send(forged).await, StatusCode::BAD_REQUEST);
    // The query alone, without Core's proof, names no lane.
    assert_eq!(send(Vec::new()).await, StatusCode::FORBIDDEN);

    // A proof minted before the policy changed no longer verifies.
    store
        .set(agent, Some(["example.net".to_owned()].as_slice()))
        .unwrap();
    assert_eq!(send(first).await, StatusCode::FORBIDDEN);
    assert_eq!(
        send(signed_through_tool_seam(&path, agent)).await,
        StatusCode::OK
    );
    store.set(agent, None).unwrap();

    server.abort();
    let query = Some(format!("agent_id={agent}"));
    let agent = Some(agent.to_owned());
    assert_eq!(
        *seen.lock().await,
        vec![
            (query.clone(), agent.clone(), Some("example.org".to_owned())),
            (query, agent, Some("example.net".to_owned())),
        ],
        "refused requests never reach the Browser"
    );
}

/// With no node token (the loopback dev posture) an agent that has an egress
/// allowlist is not sent on agent-less: it gets the proof that never verifies,
/// so the proxy refuses it. An unreadable policy is refused the same way, and
/// only an agent with no policy may go on without a lane.
#[test]
fn an_agent_with_a_policy_is_refused_when_no_token_can_sign() {
    let lane = |egress: anyhow::Result<Option<String>>, token: Option<&str>| {
        agent_lane_proof(
            token,
            egress,
            "no-token-agent",
            "GET",
            "/api/ext/@acme/a/open",
        )
    };
    let unverifiable = Some(UNVERIFIABLE_LANE_PROOF.to_owned());
    assert_eq!(lane(Ok(Some("example.org".to_owned())), None), unverifiable);
    assert_eq!(lane(Ok(Some(String::new())), None), unverifiable);
    assert_eq!(lane(Err(anyhow::anyhow!("unreadable")), None), unverifiable);
    assert_eq!(
        lane(Err(anyhow::anyhow!("unreadable")), Some("t")),
        unverifiable
    );
    assert_eq!(lane(Ok(None), None), None);

    let signed = lane(Ok(Some("example.org".to_owned())), Some("t")).expect("a token signs");
    assert_ne!(signed, UNVERIFIABLE_LANE_PROOF);
    assert!(hex::decode(&signed).is_ok());
    // The never-verifying proof is refused by the proxy rather than run unrestricted.
    let refused = verify_agent_lane(
        "no-token-agent",
        "GET",
        "/api/ext/@acme/a/open",
        UNVERIFIABLE_LANE_PROOF,
        "calling agent proof is invalid",
    )
    .expect_err("a non-hex proof is refused");
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
}
