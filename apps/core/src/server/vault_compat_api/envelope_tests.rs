//! The Vault error envelope and the refusals that use it.

use super::fixture_test::*;

#[tokio::test]
async fn errors_use_vault_envelope_and_policies_are_enforced() {
    let fixture = fixture(vec![PolicyRule {
        path: "default/app/**".into(),
        capabilities: vec![Capability::Read],
        deny: false,
        ..Default::default()
    }])
    .await;
    let app = &fixture.app;

    let (status, body) = call(app, "GET", "/v1/secret/data/app/db", None, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({ "errors": ["permission denied"] }));
    let (status, body) = call(
        app,
        "GET",
        "/v1/secret/data/app/db",
        Some("rvt_not_a_real_token"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!body.to_string().contains("rvt_not_a_real_token"));

    let token = login(&fixture).await;
    // Read-only policy: writes are denied without leaking the value.
    let (status, body) = call(
        app,
        "PUT",
        "/v1/secret/data/app/db",
        Some(&token),
        Some(json!({ "data": { "PASSWORD": "topsecret" } })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({ "errors": ["permission denied"] }));

    // Outside the policy path: 403 whether or not the secret exists, and
    // a version probe reveals nothing either.
    let (status, _) = call(app, "GET", "/v1/secret/data/other/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    fixture
        .store
        .write_secret(WriteRequest {
            coords: SecretCoords {
                scope: SecretScope::Node,
                scope_id: NODE.into(),
                environment: "default".into(),
                path: "/other/db".into(),
                binding: None,
                name: "KEY".into(),
            },
            value: Some("v"),
            patch: Default::default(),
            actor: &AuditActor::system(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    let (status, body) = call(app, "GET", "/v1/secret/data/other/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    for uri in [
        "/v1/secret/data/other/db?version=1",
        "/v1/secret/data/other/db?version=7",
        "/v1/secret/metadata/other/db",
        "/v1/secret/metadata/other/missing",
    ] {
        let (status, body) = call(app, "GET", uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
    }

    // Invalid key names and malformed JSON.
    let (status, body) = call(
        app,
        "PUT",
        "/v1/secret/data/app/db",
        Some(&token),
        Some(json!({ "data": { "not-env-shaped": "x" } })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["errors"].is_array());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/v1/secret/data/app/db")
                .header("X-Vault-Token", &token)
                .body(Body::from("{not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let (status, body) = call(app, "PATCH", "/v1/secret/data/app/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(body["errors"].is_array());
}
