use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware,
    routing::get,
    Router,
};
use tower::ServiceExt;

/// A stand-in protected router wired exactly like `create_router`'s tail,
/// with the live token source injected into the private middleware helper so
/// these tests do not race the process-wide token resolver.
fn router(expected: Option<&str>) -> Router {
    let expected = expected.map(str::to_owned);
    Router::new()
        .route("/x", get(|| async { "protected ok" }))
        .route("/api/sandboxes", get(|| async { "sandboxes ok" }))
        .route(
            "/api/pi-config/claude/v1/messages",
            get(|| async { "claude proxy ok" }),
        )
        .route(
            "/api/pi-config/kiro/v1/chat/completions",
            get(|| async { "kiro proxy ok" }),
        )
        .route(
            "/api/pi-config/kiro/v1/models",
            get(|| async { "kiro models ok" }),
        )
        .layer(middleware::from_fn(move |request, next| {
            let expected = expected.clone();
            async move { crate::server::require_auth_with_token(request, next, expected).await }
        }))
}

async fn get_status(expected: Option<&str>, path: &str, bearer: Option<&str>) -> StatusCode {
    let mut builder = Request::builder().method("GET").uri(path);
    if let Some(t) = bearer {
        builder = builder.header("authorization", format!("Bearer {t}"));
    }
    router(expected)
        .oneshot(builder.body(Body::empty()).expect("request builds"))
        .await
        .expect("router is infallible")
        .status()
}

#[tokio::test]
async fn no_configured_token_fails_closed() {
    // A protected route must not become owner-authorized when secure token
    // persistence fails during startup.
    assert_eq!(
        get_status(None, "/x", None).await,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        get_status(None, "/x", Some("anything")).await,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn a_proven_self_call_runs_as_the_named_person_and_a_forged_one_is_refused() {
    use crate::self_api::{self_call_proof, SELF_CALL_PROOF_HEADER, SELF_CALL_USER_HEADER};
    let router = Router::new()
        .route(
            "/who",
            get(
                |axum::Extension(resolved): axum::Extension<
                    crate::server::ResolvedAuthorization,
                >| async move {
                    resolved.caller.map_or_else(
                        || "owner".to_owned(),
                        |caller| format!("{}:{}", caller.user_id, caller.role.label()),
                    )
                },
            ),
        )
        .layer(middleware::from_fn(|request, next| async move {
            crate::server::require_auth_with_token(request, next, Some("node-secret".to_owned()))
                .await
        }));
    let call = |bearer: &str, proof: Option<&str>, user: Option<&str>| {
        let mut request = Request::builder()
            .uri("/who")
            .header("authorization", format!("Bearer {bearer}"));
        if let Some(proof) = proof {
            request = request.header(SELF_CALL_PROOF_HEADER, proof);
        }
        if let Some(user) = user {
            request = request.header(SELF_CALL_USER_HEADER, user);
        }
        router.clone().oneshot(request.body(Body::empty()).unwrap())
    };
    let body = |response: axum::response::Response| async move {
        String::from_utf8(
            axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    };

    // The node token alone is the node owner, as before.
    let response = call("node-secret", None, None).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await, "owner");

    // With the in-process proof it runs as that person, at the lowest tier.
    let response = call("node-secret", Some(self_call_proof()), Some("member-1"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await, "member-1:viewer");

    // A guessed proof, or a proof naming nobody, is refused outright rather
    // than falling back to owner power.
    for (proof, user) in [
        ("not-the-proof", Some("member-1")),
        (self_call_proof(), None),
    ] {
        let response = call("node-secret", Some(proof), user).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // The proof never stands in for the node token.
    let response = call("wrong", Some(self_call_proof()), Some("member-1"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn correct_bearer_token_is_admitted() {
    assert_eq!(
        get_status(Some("s3cret"), "/x", Some("s3cret")).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn wrong_or_absent_bearer_is_unauthorized() {
    // Wrong token ⇒ 401.
    assert_eq!(
        get_status(Some("s3cret"), "/x", Some("nope")).await,
        StatusCode::UNAUTHORIZED
    );
    // No Authorization header at all ⇒ 401 (not a silent pass).
    assert_eq!(
        get_status(Some("s3cret"), "/x", None).await,
        StatusCode::UNAUTHORIZED
    );
    // A prefix/near-miss must not satisfy the constant-time compare.
    assert_eq!(
        get_status(Some("s3cret"), "/x", Some("s3cre")).await,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn node_init_requires_owner_bearer_before_persisting_identity() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().expect("isolated node identity directory");
    let token_path = directory.path().join("core.token");
    let handler_path = token_path.clone();
    let router = Router::new()
        .route(
            "/api/node/init",
            axum::routing::post(move || {
                let token_path = handler_path.clone();
                async move { crate::server::node_init_at(&token_path) }
            }),
        )
        .layer(middleware::from_fn(|request, next| async move {
            crate::server::require_auth_with_token(
                request,
                next,
                Some("node-init-owner-secret".to_owned()),
            )
            .await
        }));
    for bearer in [None, Some("wrong-node-init-secret")] {
        let mut request = Request::builder().method("POST").uri("/api/node/init");
        if let Some(bearer) = bearer {
            request = request.header("authorization", format!("Bearer {bearer}"));
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(
            !token_path.exists(),
            "denied request must not initialize node identity"
        );
    }
    let authorized = || {
        Request::builder()
            .method("POST")
            .uri("/api/node/init")
            .header("authorization", "Bearer node-init-owner-secret")
            .body(Body::empty())
            .unwrap()
    };
    let response = router.clone().oneshot(authorized()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let persisted = std::fs::read_to_string(&token_path).unwrap();
    assert_eq!(payload["success"], true);
    let token = payload["token"].as_str().unwrap();
    // Only the sealed envelope reaches disk, and it opens to the value
    // returned once.
    assert!(
        persisted.starts_with("enc:v1:"),
        "core.token must be sealed"
    );
    assert!(!persisted.contains(token), "raw identity token on disk");
    assert_eq!(ryu_crypto::open_str(&persisted).unwrap(), token);
    let response = router.oneshot(authorized()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(std::fs::read_to_string(&token_path).unwrap(), persisted);
}

#[tokio::test]
async fn claude_proxy_accepts_node_token_header_and_rejects_bad_tokens() {
    for (token, expected_status) in [
        (Some("s3cret"), StatusCode::OK),
        (Some("wrong"), StatusCode::UNAUTHORIZED),
        (None, StatusCode::UNAUTHORIZED),
    ] {
        let mut request = Request::builder()
            .method("GET")
            .uri("/api/pi-config/claude/v1/messages");
        if let Some(token) = token {
            request = request.header("x-ryu-node-token", token);
        }
        let response = router(Some("s3cret"))
            .oneshot(request.body(Body::empty()).expect("request builds"))
            .await
            .expect("router is infallible");
        assert_eq!(response.status(), expected_status);
    }
}

#[tokio::test]
async fn kiro_proxy_accepts_only_valid_node_token_on_exact_routes() {
    for path in [
        "/api/pi-config/kiro/v1/chat/completions",
        "/api/pi-config/kiro/v1/models",
    ] {
        for (token, status) in [
            (Some("s3cret"), StatusCode::OK),
            (Some("wrong"), StatusCode::UNAUTHORIZED),
            (None, StatusCode::UNAUTHORIZED),
        ] {
            let mut request = Request::builder()
                .uri(path)
                .header("authorization", "Bearer ryu-local-proxy");
            if let Some(token) = token {
                request = request.header("x-ryu-node-token", token);
            }
            let response = router(Some("s3cret"))
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
    }
}

/// The bearer a managed Pi (and any workspace code it runs) inherits as
/// `RYU_PI_NODE_TOKEN` reaches Core's provider proxies, but is never the
/// node owner bearer anywhere else.
#[tokio::test]
async fn managed_pi_provider_bearer_is_admitted_only_on_provider_routes() {
    let env = crate::pi_config::secret_env::secret_env();
    let pi_bearer = env
        .iter()
        .find_map(|(name, value)| {
            (name == crate::pi_config::secret_env::NODE_TOKEN_ENV).then_some(value.as_str())
        })
        .expect("managed Pi receives a provider bearer");
    assert_ne!(pi_bearer, "s3cret");

    let mut request = Request::builder()
        .uri("/api/pi-config/claude/v1/messages")
        .header("x-ryu-node-token", pi_bearer);
    let response = router(Some("s3cret"))
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    request = Request::builder()
        .uri("/api/pi-config/kiro/v1/models")
        .header("authorization", "Bearer ryu-local-proxy")
        .header("x-ryu-node-token", pi_bearer);
    let response = router(Some("s3cret"))
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    for path in ["/x", "/api/sandboxes"] {
        assert_eq!(
            get_status(Some("s3cret"), path, Some(pi_bearer)).await,
            StatusCode::UNAUTHORIZED,
            "{path} must not accept the managed Pi's bearer"
        );
    }
}
