use super::*;

/// The hop carries the verified email from the signed identity token, never a
/// caller-chosen copy, and omits the header when the token has no email or
/// does not mark it `email_verified` (a forged copy is still stripped then).
#[tokio::test]
async fn forward_stamps_the_verified_caller_email_over_a_forged_copy() {
    use axum::routing::get;
    use axum::Router;
    use std::sync::Arc;

    let seen = Arc::new(tokio::sync::Mutex::new(Vec::<Option<String>>::new()));
    let captured = seen.clone();
    let app = Router::new().route(
        "/who",
        get(move |headers: HeaderMap| {
            let captured = captured.clone();
            async move {
                captured.lock().await.push(
                    headers
                        .get(HDR_CALLER_EMAIL)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                );
                "ok"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let mut forged = HeaderMap::new();
    forged.insert(HDR_CALLER_EMAIL, "victim@example.com".parse().unwrap());
    let caller =
        |email: Option<&str>, email_verified: bool| crate::identity_verify::VerifiedCaller {
            user_id: "member-a".to_owned(),
            email: email.map(str::to_owned),
            email_verified,
            org_id: Some("org-1".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        };
    let verified = caller(Some("member@example.com"), true);
    // A valid session whose identity provider never proved the mailbox: the
    // address must not satisfy a sidecar's email-addressed grant.
    let unverified = caller(Some("unproven@example.com"), false);
    let without_email = caller(None, true);
    // (caller, manifest opted in): only an opted-in sidecar receives the
    // verified email, and the forged copy never crosses any hop.
    for (current, opted_in) in [
        (Some(&verified), true),
        (Some(&verified), false),
        (Some(&unverified), true),
        (Some(&without_email), true),
        (None, true),
    ] {
        let response = forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: "/who",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &forged,
            body: Vec::new(),
            hop_plugin_id: "com.test.caller-email",
            forward_payment_authorization: false,
            forward_cookie_names: &[],
            forward_caller_email: opted_in,
            caller: current,
            caller_resource_ids: None,
            caller_rate_subject: None,
            caller_agent_id: None,
            caller_agent_egress_allowlist: None,
            caller_agent_restricted: false,
            event_delivery: None,
            trusted_first_party: false,
        })
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    assert_eq!(
        *seen.lock().await,
        vec![
            Some("member@example.com".to_owned()),
            None,
            None,
            None,
            None
        ],
        "only an opted-in sidecar receives Core's verified email"
    );
    server.abort();
}

fn agent_lane_request(uri: &str, headers: &[(&str, &str)]) -> Request {
    let mut builder = axum::http::Request::builder().method("POST").uri(uri);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(axum::body::Body::empty()).unwrap()
}

/// Any app learns its calling agent from a header signed over the exact
/// request. A named agent without a valid proof is refused, never
/// downgraded to an agent-less call.
#[test]
fn non_browser_agent_lane_requires_a_proof_for_the_exact_request() {
    let uri = "/api/ext/@ryu/social/posts?workspace_id=w1";
    let path_and_query = "/api/ext/@ryu/social/posts?workspace_id=w1";
    let proof = sign_agent_lane("agent-1", "POST", path_and_query)
        .expect("an isolated test node has a token");

    let signed = agent_lane_request(
        uri,
        &[
            (HDR_CALLER_AGENT_ID, "agent-1"),
            (HDR_CALLER_AGENT_PROOF, &proof),
        ],
    );
    assert_eq!(
        verified_agent_lane(&signed, "@ryu/social").ok().flatten(),
        Some("agent-1".to_owned())
    );

    let anonymous = agent_lane_request(uri, &[]);
    assert_eq!(
        verified_agent_lane(&anonymous, "@ryu/social").ok(),
        Some(None)
    );

    for headers in [
        vec![(HDR_CALLER_AGENT_ID, "agent-1")],
        vec![
            (HDR_CALLER_AGENT_ID, "agent-2"),
            (HDR_CALLER_AGENT_PROOF, proof.as_str()),
        ],
        vec![
            (HDR_CALLER_AGENT_ID, "agent-1"),
            (HDR_CALLER_AGENT_PROOF, "00"),
        ],
    ] {
        let response = verified_agent_lane(&agent_lane_request(uri, &headers), "@ryu/social")
            .expect_err("a bad agent lane is refused");
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{headers:?}");
    }
    // The proof covers the query, so it cannot be moved to another request.
    let moved = agent_lane_request(
        "/api/ext/@ryu/social/posts?workspace_id=w2",
        &[
            (HDR_CALLER_AGENT_ID, "agent-1"),
            (HDR_CALLER_AGENT_PROOF, &proof),
        ],
    );
    assert!(verified_agent_lane(&moved, "@ryu/social").is_err());
    let twice = agent_lane_request(
        uri,
        &[
            (HDR_CALLER_AGENT_ID, "agent-1"),
            (HDR_CALLER_AGENT_ID, "agent-1"),
            (HDR_CALLER_AGENT_PROOF, &proof),
        ],
    );
    assert_eq!(
        verified_agent_lane(&twice, "@ryu/social")
            .expect_err("a repeated agent header is refused")
            .status(),
        StatusCode::BAD_REQUEST
    );
    // The Browser keeps its query lane: a header alone names no lane there.
    assert_eq!(
        verified_agent_lane(
            &agent_lane_request(
                "/api/ext/@ryu/browser/sessions",
                &[(HDR_CALLER_AGENT_ID, "agent-1")]
            ),
            "@ryu/browser"
        )
        .ok(),
        Some(None)
    );
}

/// A verified calling agent reaches the app with a Core-signed grant bound
/// to that app, which the app hands back on `providers.call`.
#[tokio::test]
async fn forward_stamps_an_agent_grant_bound_to_the_hop_plugin() {
    use axum::routing::get;
    use axum::Router;
    use std::sync::Arc;

    let seen = Arc::new(tokio::sync::Mutex::new(Vec::<(
        Option<String>,
        Option<String>,
    )>::new()));
    let captured = seen.clone();
    let app = Router::new().route(
        "/who",
        get(move |headers: HeaderMap| {
            let captured = captured.clone();
            async move {
                let read = |name: &str| {
                    headers
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned)
                };
                captured.lock().await.push((
                    read(HDR_CALLER_AGENT_ID),
                    read(crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER),
                ));
                "ok"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let mut forged = HeaderMap::new();
    forged.insert(
        crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
        "forged-grant".parse().unwrap(),
    );
    for agent in [Some("agent-1"), None] {
        let response = forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: "/who",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &forged,
            body: Vec::new(),
            hop_plugin_id: "@ryu/social",
            forward_payment_authorization: false,
            forward_cookie_names: &[],
            forward_caller_email: false,
            caller: None,
            caller_resource_ids: None,
            caller_rate_subject: None,
            caller_agent_id: agent,
            caller_agent_egress_allowlist: None,
            caller_agent_restricted: agent.is_some(),
            event_delivery: None,
            trusted_first_party: false,
        })
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    server.abort();
    let seen = seen.lock().await;
    let (agent, grant) = &seen[0];
    assert_eq!(agent.as_deref(), Some("agent-1"));
    let grant = grant.as_deref().expect("a calling agent gets a grant");
    assert_eq!(
        crate::sidecar::deferred_authorization::verify_agent_grant(grant, "@ryu/social"),
        Ok("agent-1".to_owned())
    );
    assert!(crate::sidecar::deferred_authorization::verify_agent_grant(grant, "@ryu/ugc").is_err());
    assert_eq!(seen[1], (None, None), "no agent, no grant, no forged copy");
}

/// While Core forwards a restricted agent's request, the app is marked as
/// serving an agent, so its grant-less `providers.call`s are refused. The
/// mark covers the whole response body and ends with it; a request with no
/// agent, or from an unrestricted agent, sets none, so the app's own work
/// (a user's widget refresh, a scheduled job) is never held up by it.
#[tokio::test]
async fn forward_marks_the_app_as_serving_an_agent_until_the_body_ends() {
    use crate::sidecar::deferred_authorization::has_active_agent_request;
    use axum::routing::get;
    use axum::Router;
    use std::sync::Arc;

    // Not an app constant: a test-only id no other test forwards to.
    let plugin: &'static str = "test.agent-context-forward";
    let seen = Arc::new(tokio::sync::Mutex::new(Vec::<bool>::new()));
    let captured = seen.clone();
    let app = Router::new().route(
        "/work",
        get(move || {
            let captured = captured.clone();
            async move {
                captured.lock().await.push(has_active_agent_request(plugin));
                "done"
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    for (agent, restricted) in [
        (Some("agent-1"), true),
        (Some("unrestricted-agent"), false),
        (None, false),
    ] {
        let response = forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: "/work",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &HeaderMap::new(),
            body: Vec::new(),
            hop_plugin_id: plugin,
            forward_payment_authorization: false,
            forward_cookie_names: &[],
            forward_caller_email: false,
            caller: None,
            caller_resource_ids: None,
            caller_rate_subject: None,
            caller_agent_id: agent,
            caller_agent_egress_allowlist: None,
            caller_agent_restricted: restricted,
            event_delivery: None,
            trusted_first_party: false,
        })
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            has_active_agent_request(plugin),
            restricted,
            "the mark lasts while the body is still unread"
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"done");
        assert!(
            !has_active_agent_request(plugin),
            "the mark ends with the body"
        );
    }
    server.abort();
    assert_eq!(*seen.lock().await, vec![true, false, false]);
}
