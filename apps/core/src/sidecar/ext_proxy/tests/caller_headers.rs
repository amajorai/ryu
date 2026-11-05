use super::*;

// ── Hop-by-hop + browser-context header handling (defense-in-depth) ─────────

#[test]
fn hop_by_hop_headers_are_recognized_case_insensitively() {
    for h in [
        "host",
        "Content-Length",
        "CONNECTION",
        "transfer-encoding",
        "Keep-Alive",
        "upgrade",
    ] {
        assert!(is_hop_by_hop(h), "{h} must be treated hop-by-hop");
    }
    // End-to-end headers survive.
    for h in ["authorization", "content-type", "x-ryu-plugin-id", "accept"] {
        assert!(!is_hop_by_hop(h), "{h} must NOT be hop-by-hop");
    }
}

#[test]
fn browser_context_headers_are_origin_and_referer() {
    // These name the ORIGINAL cross-origin caller; forwarding them would make Core's
    // authenticated proxy hop indistinguishable from a drive-by browser request, so a
    // loopback sidecar's CSRF / DNS-rebind gate would 403 it.
    assert!(is_browser_context("origin"));
    assert!(is_browser_context("Referer"));
    assert!(is_browser_context("REFERER"));
    assert!(!is_browser_context("authorization"));
    assert!(!is_browser_context("content-type"));
}

#[test]
fn copy_headers_strips_hop_and_browser_context_keeps_the_rest() {
    let mut src = HeaderMap::new();
    src.insert("content-type", "application/json".parse().unwrap());
    src.insert("origin", "https://evil.example".parse().unwrap());
    src.insert("referer", "https://evil.example/p".parse().unwrap());
    src.insert("x-ryu-user-jwt", "user-jwt-secret".parse().unwrap());
    src.insert("cookie", "better-auth.session=secret".parse().unwrap());
    src.insert("host", "127.0.0.1:9999".parse().unwrap());
    src.insert("connection", "keep-alive".parse().unwrap());
    src.insert("x-ryu-plugin-id", "com.acme.app".parse().unwrap());
    src.insert(
        crate::sidecar::deferred_authorization::PRINCIPAL_HEADER,
        "forged".parse().unwrap(),
    );
    src.insert(
        HDR_FORWARDED_AUTHORIZATION,
        "Payment forged".parse().unwrap(),
    );
    src.insert(
        HDR_CALLER_RESOURCE_IDS,
        r#"["forged-conversation"]"#.parse().unwrap(),
    );

    let mut dst = reqwest::header::HeaderMap::new();
    copy_headers(&src, &mut dst, &[]);
    assert!(dst
        .get(crate::sidecar::deferred_authorization::PRINCIPAL_HEADER)
        .is_none());

    // End-to-end app headers are forwarded.
    assert_eq!(
        dst.get("content-type").map(|v| v.to_str().unwrap()),
        Some("application/json")
    );
    assert_eq!(
        dst.get("x-ryu-plugin-id").map(|v| v.to_str().unwrap()),
        Some("com.acme.app")
    );
    assert!(dst.get("x-ryu-user-jwt").is_none());
    assert!(dst.get("cookie").is_none());
    assert!(
        dst.get(HDR_CALLER_RESOURCE_IDS).is_none(),
        "caller must not forge Core's resource scope"
    );
    // Browser-context + hop-by-hop headers are dropped.
    assert!(dst.get("origin").is_none(), "Origin must be stripped");
    assert!(dst.get("referer").is_none(), "Referer must be stripped");
    assert!(dst.get("host").is_none(), "Host must be stripped");
    assert!(
        dst.get(HDR_FORWARDED_AUTHORIZATION).is_none(),
        "caller must not forge the reserved authorization hop header"
    );
    assert!(
        dst.get("connection").is_none(),
        "Connection must be stripped"
    );
}

/// A derived-index sidecar (`caller_resource_scope: "conversation"`) must receive
/// exactly the conversations the VERIFIED caller may read on a shared node: Bob
/// never sees Alice's private chat id, and a caller-forged scope header is
/// replaced, not trusted. This is the Core half of the Mission Control fix.
#[tokio::test]
async fn conversation_scope_carries_only_the_verified_callers_conversations() {
    use crate::server::conversations::Tenancy;
    use crate::server::multiplayer_journey_tests::TestIdentityProvider;
    use crate::sidecar::capability_consumer::test_support::{
        register_sidecar_for, reserve_port, serve,
    };
    const APP: &str = "@acme/derived-index";
    const ORG: &str = "org-derived";

    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let port = reserve_port();
    let mut manifest = web_app(APP, None, false, &["app:http"]);
    let sidecar = &mut manifest.sidecars[0];
    sidecar.name = "engine".to_owned();
    sidecar.port = port;
    let http = sidecar.http.as_mut().expect("fixture http");
    http.caller_resource_scope = Some("conversation".to_owned());
    http.routes[0].permission = Some(crate::identity_verify::permissions::SPACE_WRITE.to_owned());
    state.app_manifests.write().await.push(manifest);
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state
        .app_store
        .set_enabled(APP, &["app:http".to_owned()])
        .await
        .unwrap();
    for (conversation, owner) in [("alice-private", "alice"), ("bob-private", "bob")] {
        state
            .conversations
            .ensure_conversation(
                conversation,
                None,
                Some(conversation),
                Tenancy::Owned {
                    user_id: owner.to_owned(),
                    org_id: Some(ORG.to_owned()),
                },
            )
            .await
            .unwrap();
    }
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
    let seen = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<Option<String>>::new()));
    let captured = seen.clone();
    let router = Router::new().route(
        "/api/svc/items",
        get(move |headers: HeaderMap| {
            let captured = captured.clone();
            async move {
                captured.lock().await.push(
                    headers
                        .get(HDR_CALLER_RESOURCE_IDS)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                );
                Json(json!({ "items": [] }))
            }
        }),
    );
    let server = serve(port, router).await;

    let identity = TestIdentityProvider::start().await;
    let alice = identity.mint("alice", ORG, "member", &[]);
    let bob = identity.mint("bob", ORG, "member", &[]);
    let request = |jwt: &str| {
        Request::builder()
            .method("GET")
            .uri(format!("/api/ext/{APP}/items"))
            .header("x-ryu-user-jwt", jwt)
            // Forged: Bob claims Alice's conversation.
            .header(HDR_CALLER_RESOURCE_IDS, r#"["alice-private"]"#)
            .body(Body::empty())
            .unwrap()
    };

    crate::sidecar::control_plane::with_test_node_binding(true, Some(org_bound_node(ORG)), async {
        for jwt in [&bob, &alice] {
            let response = proxy_for_plugin(&state, APP, "/items", None, request(jwt)).await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        assert!(state
            .conversations
            .delete_conversation("alice-private")
            .await
            .unwrap());
        state
            .conversations
            .ensure_conversation(
                "alice-private",
                None,
                Some("alice-private"),
                Tenancy::Owned {
                    user_id: "bob".to_owned(),
                    org_id: Some(ORG.to_owned()),
                },
            )
            .await
            .unwrap();
        for jwt in [&bob, &alice] {
            let response = proxy_for_plugin(&state, APP, "/items", None, request(jwt)).await;
            assert_eq!(response.status(), StatusCode::OK);
        }
    })
    .await;
    server.abort();

    let seen = seen.lock().await.clone();
    let parse = |raw: &Option<String>| -> Vec<(String, String)> {
        let entries: Vec<String> =
            serde_json::from_str(raw.as_deref().expect("Core stamps the scope header"))
                .expect("scope header is a JSON array");
        entries
            .into_iter()
            .map(|entry| {
                let (version, id) = entry.split_once(':').expect("<version>:<id> entry");
                (id.to_owned(), version.to_owned())
            })
            .collect()
    };
    assert_eq!(seen.len(), 4);
    let bob_scope = parse(&seen[0]);
    let alice_scope = parse(&seen[1]);
    assert_eq!(bob_scope.len(), 1);
    assert_eq!(bob_scope[0].0, "bob-private");
    assert_eq!(alice_scope.len(), 1);
    assert_eq!(alice_scope[0].0, "alice-private");
    assert_eq!(alice_scope[0].1.len(), 12);

    // Re-creation: Alice's conversation is deleted, and Bob creates a new one
    // under the SAME id. Bob now sees that id, but with a different source
    // version, so a derived index keyed on the version cannot hand him
    // Alice's old digest.
    let bob_recreated = parse(&seen[2]);
    let recreated = bob_recreated
        .iter()
        .find(|(id, _)| id == "alice-private")
        .expect("bob owns the re-created id");
    assert_ne!(
        recreated.1, alice_scope[0].1,
        "a re-created conversation must not reuse the deleted one's source version"
    );
    assert!(
        parse(&seen[3]).iter().all(|(id, _)| id != "alice-private"),
        "alice no longer sees the id bob re-created"
    );
}

/// A caller who may read more conversations than fit in one header keeps a
/// working sidecar (no blanket 503): the scope is truncated to the newest ids,
/// so it can only ever NARROW what the sidecar serves.
#[test]
fn caller_resource_ids_are_bounded_by_dropping_the_oldest() {
    let ids: Vec<String> = (0..20_000)
        .map(|index| format!("{index:08}-0000-4000-8000-000000000000"))
        .collect();
    let (encoded, omitted) = encode_caller_resource_ids(
        ids.iter().map(String::as_str),
        MAX_CALLER_RESOURCE_IDS_BYTES,
    );
    assert!(encoded.len() <= MAX_CALLER_RESOURCE_IDS_BYTES);
    assert!(reqwest::header::HeaderValue::from_str(&encoded).is_ok());
    let kept: Vec<String> = serde_json::from_str(&encoded).unwrap();
    assert!(omitted > 0);
    assert_eq!(kept.len() + omitted, ids.len());
    assert_eq!(
        kept[..],
        ids[..kept.len()],
        "the newest ids are kept, in order"
    );

    let (small, none_omitted) = encode_caller_resource_ids(["a", "b"].into_iter(), 64);
    assert_eq!((small.as_str(), none_omitted), (r#"["a","b"]"#, 0));
    let (empty, _) = encode_caller_resource_ids(std::iter::empty(), 64);
    assert_eq!(empty, "[]");
}

/// The source version binds an id to the row's immutable identity: stable for
/// one row, different for a row re-created under the same id by anyone else
/// or at another time.
#[test]
fn conversation_source_version_distinguishes_a_re_created_row() {
    use crate::server::conversations::conversation_source_version;
    let original = conversation_source_version("c1", 1_000, Some("alice"), Some("org"));
    assert_eq!(original.len(), 12);
    assert_eq!(
        original,
        conversation_source_version("c1", 1_000, Some("alice"), Some("org"))
    );
    for other in [
        conversation_source_version("c1", 1_000, Some("bob"), Some("org")),
        conversation_source_version("c1", 1_001, Some("alice"), Some("org")),
        conversation_source_version("c1", 1_000, Some("alice"), Some("other-org")),
        conversation_source_version("c1", 1_000, None, None),
    ] {
        assert_ne!(original, other);
    }
}

#[test]
fn caller_resource_ids_stay_valid_header_values_for_any_id() {
    let ids = [
        "plain",
        "quote\"back\\slash",
        "café",
        "emoji-\u{1F600}",
        "tab\tnl\n",
    ];
    let (encoded, omitted) =
        encode_caller_resource_ids(ids.into_iter(), MAX_CALLER_RESOURCE_IDS_BYTES);
    assert_eq!(omitted, 0);
    assert!(encoded.is_ascii());
    assert!(reqwest::header::HeaderValue::from_str(&encoded).is_ok());
    let decoded: Vec<String> = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, ids);
}

#[test]
fn copy_headers_strips_caller_supplied_identity_headers() {
    let mut src = HeaderMap::new();
    src.insert(HDR_CALLER_USER_ID, "forged-user".parse().unwrap());
    src.insert(HDR_CALLER_ORG_ID, "forged-org".parse().unwrap());
    src.insert(HDR_CALLER_EMAIL, "owner@example.com".parse().unwrap());
    src.insert(HDR_CALLER_AGENT_ID, "forged-agent".parse().unwrap());
    src.insert(HDR_CALLER_AGENT_PROOF, "forged-proof".parse().unwrap());
    src.insert(
        crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
        "forged-grant".parse().unwrap(),
    );
    src.insert(HDR_CALLER_RATE_SUBJECT, "peer:forged".parse().unwrap());
    src.insert("content-type", "application/json".parse().unwrap());

    let mut dst = reqwest::header::HeaderMap::new();
    copy_headers(&src, &mut dst, &[]);

    for name in [
        HDR_CALLER_USER_ID,
        HDR_CALLER_ORG_ID,
        HDR_CALLER_EMAIL,
        HDR_CALLER_AGENT_ID,
        HDR_CALLER_AGENT_PROOF,
        crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
        HDR_CALLER_RATE_SUBJECT,
    ] {
        assert!(
            dst.get(name).is_none(),
            "a caller must not forge the {name} hop header"
        );
    }
    assert!(dst.get("content-type").is_some());
}
