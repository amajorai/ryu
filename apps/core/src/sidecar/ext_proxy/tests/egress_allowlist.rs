use super::*;

use axum::routing::get;
use axum::Router;
use std::sync::Arc;

/// What the fake app saw: the calling agent and the egress allowlist header.
type Seen = Arc<tokio::sync::Mutex<Vec<(Option<String>, Option<String>)>>>;

fn lane_request(path: &str, headers: &[(&str, &str)]) -> Request {
    let mut builder = axum::http::Request::builder().method("GET").uri(path);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Body::empty()).unwrap()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

/// The egress allowlist reaches an app only as Core stamps it from the
/// agent's stored policy, on a lane whose proof covers that policy. A caller
/// copy is refused before the app is reached, a proof minted under another
/// policy does not verify, and an agent-less request carries none.
#[tokio::test]
async fn an_agent_egress_allowlist_reaches_the_app_only_from_core() {
    use crate::sidecar::capability_consumer::test_support::{
        register_sidecar_for, reserve_port, serve,
    };
    const APP: &str = "@acme/egress-lane";
    // A test-only agent id no other test writes a policy for.
    let agent = "egress-e2e-agent";
    let path = format!("/api/ext/{APP}/open");

    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let port = reserve_port();
    let mut manifest = web_app(APP, None, false, &[]);
    // `register_sidecar_for` registers the sidecar named `engine`.
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
        get(move |headers: HeaderMap| {
            let captured = captured.clone();
            async move {
                let read = |name: &str| {
                    headers
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned)
                };
                captured
                    .lock()
                    .await
                    .push((read(HDR_CALLER_AGENT_ID), read(HDR_CALLER_EGRESS_ALLOWLIST)));
                "ok"
            }
        }),
    );
    let server = serve(port, router).await;

    let store = crate::sidecar::ext_proxy::egress_policy::global();
    let send = |headers: Vec<(&'static str, String)>| {
        let path = path.clone();
        let state = &state;
        async move {
            let pairs: Vec<(&str, &str)> = headers
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect();
            // Boxed: the proxy future is large, and the test thread's stack is not.
            Box::pin(proxy_for_plugin(
                state,
                APP,
                "/open",
                None,
                lane_request(&path, &pairs),
            ))
            .await
            .status()
        }
    };
    let signed = |extra: Option<&str>| {
        let proof =
            sign_agent_lane(agent, "GET", &path).expect("an isolated test node has a token");
        let mut headers = vec![
            (HDR_CALLER_AGENT_ID, agent.to_owned()),
            (HDR_CALLER_AGENT_PROOF, proof),
        ];
        if let Some(forged) = extra {
            headers.push((HDR_CALLER_EGRESS_ALLOWLIST, forged.to_owned()));
        }
        headers
    };

    store
        .set(
            agent,
            Some(strings(&["example.org", "*.Example.com"]).as_slice()),
        )
        .unwrap();
    let first = signed(None);
    assert_eq!(send(first.clone()).await, StatusCode::OK);

    // A caller copy is refused on a valid lane, even one equal to Core's.
    for forged in ["evil.example", "*.example.com,example.org", ""] {
        assert_eq!(send(signed(Some(forged))).await, StatusCode::BAD_REQUEST);
    }
    // Without an agent too: the header never means anything from a caller.
    assert_eq!(
        send(vec![(
            HDR_CALLER_EGRESS_ALLOWLIST,
            "evil.example".to_owned()
        )])
        .await,
        StatusCode::BAD_REQUEST
    );
    // A proof minted without the policy does not verify under it.
    let unbound = sign_agent_lane_under(agent, "GET", &path, None).unwrap();
    assert_eq!(
        send(vec![
            (HDR_CALLER_AGENT_ID, agent.to_owned()),
            (HDR_CALLER_AGENT_PROOF, unbound),
        ])
        .await,
        StatusCode::FORBIDDEN
    );

    // Once the policy changes, the earlier proof is refused and a fresh one
    // carries the new list. An empty list is sent as an empty value.
    store
        .set(agent, Some(strings(&["example.net"]).as_slice()))
        .unwrap();
    assert_eq!(send(first).await, StatusCode::FORBIDDEN);
    assert_eq!(send(signed(None)).await, StatusCode::OK);
    store.set(agent, Some(&[])).unwrap();
    assert_eq!(send(signed(None)).await, StatusCode::OK);
    // No policy and no agent each send no allowlist.
    store.set(agent, None).unwrap();
    assert_eq!(send(signed(None)).await, StatusCode::OK);
    assert_eq!(send(Vec::new()).await, StatusCode::OK);

    server.abort();
    let agent = Some(agent.to_owned());
    assert_eq!(
        *seen.lock().await,
        vec![
            (agent.clone(), Some("*.example.com,example.org".to_owned())),
            (agent.clone(), Some("example.net".to_owned())),
            (agent.clone(), Some(String::new())),
            (agent, None),
            (None, None),
        ],
        "refused requests never reach the app"
    );
}

/// The proof a signer hands out when the policy store is unreadable never
/// verifies, so the agent is refused rather than sent on unrestricted.
#[test]
fn the_unreadable_policy_proof_never_verifies() {
    let refused = verify_agent_lane(
        "egress-unreadable-agent",
        "GET",
        "/api/ext/@acme/egress-lane/open",
        UNVERIFIABLE_LANE_PROOF,
        "calling agent proof is invalid",
    )
    .expect_err("a non-hex proof is refused");
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
}

/// Every hop strips a caller's copy of the header; Core alone stamps it.
#[test]
fn copy_headers_strips_a_caller_egress_allowlist() {
    let mut src = HeaderMap::new();
    src.insert(HDR_CALLER_EGRESS_ALLOWLIST, "evil.example".parse().unwrap());
    src.insert("x-kept", "1".parse().unwrap());
    let mut dst = reqwest::header::HeaderMap::new();
    copy_headers(&src, &mut dst, &[]);
    assert!(dst.get(HDR_CALLER_EGRESS_ALLOWLIST).is_none());
    assert_eq!(dst.get("x-kept").unwrap(), "1");
}
