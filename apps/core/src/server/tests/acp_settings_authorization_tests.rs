use crate::authorization::{
    AuthorizationContext, Capability, CapabilitySet, CredentialKind, GrantConstraints, Principal,
    RequestBindings,
};
use axum::{body::Body, http::Request, middleware, routing::get, Json, Router};
use tower::ServiceExt;

fn paired(capabilities: CapabilitySet) -> AuthorizationContext {
    AuthorizationContext {
        credential: CredentialKind::PairedCapability {
            grant_id: "test".into(),
        },
        principal: Principal::PairedClient {
            client_id: "test".into(),
            subject_id: None,
        },
        capabilities,
        constraints: GrantConstraints::default(),
        issued_at: 0,
        expires_at: None,
    }
}

// Exercise the production policy and capability evaluator through Axum's
// GET/HEAD dispatch, before a stand-in secret-bearing settings handler.
fn router(context: AuthorizationContext) -> Router {
    Router::new()
        .route(
            "/api/agents/:id/acp-settings",
            get(|| async {
                Json(serde_json::json!({"settings":{"env":{"API_KEY":"fixture-secret"}}}))
            }),
        )
        .route("/api/agents/:id", get(|| async { "catalog" }))
        .layer(middleware::from_fn(
            move |request: Request<Body>, next: middleware::Next| {
                let context = context.clone();
                async move {
                    let policy = crate::server::credential_route_policy(
                        request.method(),
                        request.uri().path(),
                        &context,
                        false,
                    );
                    match crate::server::denial_status(context.authorize(
                        &policy,
                        &RequestBindings::default(),
                        1,
                    )) {
                        Some(status) => Err(status),
                        None => Ok(next.run(request).await),
                    }
                }
            },
        ))
}

#[tokio::test]
async fn acp_settings_reject_read_only_and_legacy_clients_before_secret_response() {
    for capabilities in [
        CapabilitySet::paired_read_only(),
        CapabilitySet::restrictive_legacy_profile(),
    ] {
        for id in ["acp:claude", "acp%3Aclaude", "custom%2Fagent"] {
            for method in [axum::http::Method::GET, axum::http::Method::HEAD] {
                let response = router(paired(capabilities.clone()))
                    .oneshot(
                        Request::builder()
                            .method(method)
                            .uri(format!("/api/agents/{id}/acp-settings"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
                let body = axum::body::to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap();
                assert!(!String::from_utf8_lossy(&body).contains("fixture-secret"));
            }
        }
        let response = router(paired(capabilities))
            .oneshot(
                Request::builder()
                    .uri("/api/agents/acp%3Aclaude")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
    }
}

#[tokio::test]
async fn acp_settings_preserve_owner_and_management_editor_response() {
    for context in [
        AuthorizationContext::owner(0),
        paired(CapabilitySet::new([Capability::AgentsManage])),
    ] {
        let response = router(context)
            .oneshot(
                Request::builder()
                    .uri("/api/agents/acp%3Aclaude/acp-settings")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["settings"]["env"]["API_KEY"], "fixture-secret");
    }
}

#[test]
fn acp_settings_managed_readers_reach_the_exact_agent_edit_acl() {
    for credential in [
        CredentialKind::ManagedUserJwt,
        CredentialKind::ManagedDelegation,
    ] {
        let mut context = paired(CapabilitySet::new([Capability::AgentsRead]));
        context.credential = credential;
        context.principal = Principal::User {
            subject_id: "member".into(),
        };
        for method in [axum::http::Method::GET, axum::http::Method::HEAD] {
            let policy = crate::server::credential_route_policy(
                &method,
                "/api/agents/acp%3Aclaude/acp-settings",
                &context,
                true,
            );
            assert!(context
                .authorize(&policy, &RequestBindings::default(), 1)
                .is_allowed());
            let missing_identity = crate::server::credential_route_policy(
                &method,
                "/api/agents/acp%3Aclaude/acp-settings",
                &context,
                false,
            );
            assert!(!context
                .authorize(&missing_identity, &RequestBindings::default(), 1)
                .is_allowed());
        }
    }
}
