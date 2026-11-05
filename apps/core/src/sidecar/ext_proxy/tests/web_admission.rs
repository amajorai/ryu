use super::*;

/// End to end through `proxy_for_plugin`: the marker refuses before the
/// registration/wake gate (403, nothing dialed or woken), while the same request
/// WITHOUT the marker is unchanged and reaches that gate (503: no sidecar is
/// registered in this isolated state). The refusal is the same on an annotated
/// and an unannotated route.
#[tokio::test]
async fn web_delegated_requests_are_refused_before_the_sidecar_gate() {
    const APP: &str = "@acme/target";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state
        .app_store
        .set_enabled(APP, &["app:http".to_owned()])
        .await
        .unwrap();
    state
        .app_manifests
        .write()
        .await
        .push(web_app(APP, Some("full"), true, &["app:http"]));

    let request = |path: &str, web: bool| {
        let mut builder = Request::builder()
            .method("GET")
            .uri(format!("/api/ext/{APP}{path}"));
        if web {
            builder = builder
                .header(HDR_WEB_DELEGATION, "1")
                .header(HDR_APP_CALLER, APP);
        }
        builder.body(Body::empty()).unwrap()
    };

    for path in ["/items", "/open"] {
        let refused = proxy_for_plugin(&state, APP, path, None, request(path, true)).await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN, "web {path}");

        let unchanged = proxy_for_plugin(&state, APP, path, None, request(path, false)).await;
        assert_eq!(
            unchanged.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "a request without the marker must reach the registration gate ({path})"
        );
    }
    assert!(
        !state.manager.is_wake_eligible("@acme/target/svc"),
        "nothing was registered or woken"
    );
}

fn org_member(user: &str, org: &str) -> crate::identity_verify::VerifiedCaller {
    crate::identity_verify::VerifiedCaller {
        user_id: user.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(org.to_owned()),
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    }
}

/// On a bound node the admission admits a member of the node's org on exactly the
/// reviewed edge (`app:http` for the caller's own app, `app:http:<target>` for
/// another), and refuses a caller from another org even when every fact holds.
#[tokio::test]
async fn web_delegated_admission_admits_a_bound_org_member_on_the_exact_edge() {
    const CALLER: &str = "@acme/webcaller";
    const TARGET: &str = "@acme/webtarget";
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    state.app_manifests.write().await.push(web_app(
        CALLER,
        Some("full"),
        true,
        &["app:http", "app:http:@acme/webtarget"],
    ));
    state.app_store.insert(CALLER, "1.0.0").await.unwrap();
    state
        .app_store
        .set_enabled(CALLER, &["app:http".to_owned()])
        .await
        .unwrap();
    let facts = WebDelegationFacts {
        route_declares_permission: true,
        target_supports_web: true,
        caller_app: Some(WebCallerApp {
            id: CALLER.to_owned(),
            supports_web: true,
            has_companion: true,
        }),
    };

    crate::sidecar::control_plane::with_test_node_binding(
        true,
        Some(org_bound_node("org1")),
        async {
            let member = Some(org_member("alice", "org1"));
            assert_eq!(
                web_delegated_admission(&state, CALLER, &member, &facts).await,
                Ok(()),
                "own app under app:http"
            );
            assert_eq!(
                web_delegated_admission(&state, TARGET, &member, &facts).await,
                Err(StatusCode::NOT_FOUND),
                "app:http never reaches another app"
            );
            let outsider = Some(org_member("mallory", "org2"));
            assert_eq!(
                web_delegated_admission(&state, CALLER, &outsider, &facts).await,
                Err(StatusCode::FORBIDDEN),
                "a caller from another org"
            );

            state
                .app_store
                .set_enabled(CALLER, &["app:http:@acme/webtarget".to_owned()])
                .await
                .unwrap();
            assert_eq!(
                web_delegated_admission(&state, TARGET, &member, &facts).await,
                Ok(()),
                "another app under its exact app:http:<target> edge"
            );
            assert_eq!(
                web_delegated_admission(&state, TARGET, &outsider, &facts).await,
                Err(StatusCode::FORBIDDEN)
            );
        },
    )
    .await;
}

/// End to end through `proxy_for_plugin` on a bound node, with real signed user
/// JWTs and a registered fake sidecar: an admitted web request reaches the sidecar
/// and is marked admitted; the same request without the marker is not marked; the
/// route permission still applies to an admitted caller; an unannotated route and
/// another org's caller are refused before the sidecar is dialed.
#[tokio::test]
async fn an_admitted_web_request_reaches_the_sidecar_and_is_marked_admitted() {
    use crate::server::multiplayer_journey_tests::TestIdentityProvider;
    use crate::sidecar::capability_consumer::test_support::{
        register_sidecar_for, reserve_port, serve,
    };
    const APP: &str = "@acme/webforward";
    const ORG: &str = "org-webforward";

    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let port = reserve_port();
    let mut manifest = web_app(APP, Some("full"), true, &["app:http"]);
    let sidecar = &mut manifest.sidecars[0];
    sidecar.name = "engine".to_owned();
    sidecar.port = port;
    // A kernel permission a member holds and a viewer does not.
    sidecar.http.as_mut().expect("fixture http").routes[0].permission =
        Some(crate::identity_verify::permissions::SPACE_WRITE.to_owned());
    state.app_manifests.write().await.push(manifest);
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state
        .app_store
        .set_enabled(APP, &["app:http".to_owned()])
        .await
        .unwrap();
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
    let reached = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = reached.clone();
    let router = Router::new()
        .route(
            "/api/svc/items",
            get(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Json(json!({ "items": ["a"] }))
                }
            }),
        )
        .route(
            "/api/svc/open",
            get(|| async { Json(json!({ "open": true })) }),
        );
    let server = serve(port, router).await;

    let identity = TestIdentityProvider::start().await;
    let member = identity.mint("web-member", ORG, "member", &[]);
    let viewer = identity.mint("web-viewer", ORG, "viewer", &[]);
    let outsider = identity.mint("web-outsider", "org-elsewhere", "member", &[]);
    let request = |path: &str, jwt: &str, web: bool| {
        let mut builder = Request::builder()
            .method("GET")
            .uri(format!("/api/ext/{APP}{path}"))
            .header("x-ryu-user-jwt", jwt);
        if web {
            builder = builder
                .header(HDR_WEB_DELEGATION, "1")
                .header(HDR_APP_CALLER, APP);
        }
        builder.body(Body::empty()).unwrap()
    };

    crate::sidecar::control_plane::with_test_node_binding(true, Some(org_bound_node(ORG)), async {
        let admitted = proxy_for_plugin(
            &state,
            APP,
            "/items",
            None,
            request("/items", &member, true),
        )
        .await;
        assert_eq!(admitted.status(), StatusCode::OK);
        assert_eq!(
            admitted.headers().get(HDR_WEB_DELEGATION).unwrap(),
            WEB_DELEGATION_ADMITTED
        );
        let body = axum::body::to_bytes(admitted.into_body(), 1024)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({ "items": ["a"] })
        );
        assert_eq!(reached.load(std::sync::atomic::Ordering::SeqCst), 1);

        let direct = proxy_for_plugin(
            &state,
            APP,
            "/items",
            None,
            request("/items", &member, false),
        )
        .await;
        assert_eq!(direct.status(), StatusCode::OK);
        assert!(
            direct.headers().get(HDR_WEB_DELEGATION).is_none(),
            "only a web-delegated forward is marked admitted"
        );
        assert_eq!(reached.load(std::sync::atomic::Ordering::SeqCst), 2);

        for (jwt, path, expected, why) in [
            (&viewer, "/items", StatusCode::FORBIDDEN, "route permission"),
            (&outsider, "/items", StatusCode::FORBIDDEN, "another org"),
            (&member, "/open", StatusCode::NOT_FOUND, "unannotated route"),
        ] {
            let refused = proxy_for_plugin(&state, APP, path, None, request(path, jwt, true)).await;
            assert_eq!(refused.status(), expected, "{why}");
            assert!(refused.headers().get(HDR_WEB_DELEGATION).is_none(), "{why}");
        }
        assert_eq!(
            reached.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "no refused request reached the sidecar"
        );
    })
    .await;
    server.abort();
}

/// The web tier forwards only to a Core whose `GET /api/version` advertises the
/// admission this module runs.
#[test]
fn version_advertises_the_web_delegated_admission() {
    assert!(crate::update::version_info()
        .features
        .iter()
        .any(|feature| feature == crate::update::FEATURE_WEB_DELEGATED_EXT));
}
