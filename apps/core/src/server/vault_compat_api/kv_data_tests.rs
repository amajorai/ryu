//! KV v2 `data/<path>` writes, reads, check-and-set, and deletes.

use super::fixture_test::*;

#[tokio::test]
async fn kv_v2_write_read_metadata_list_and_delete() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let token = login(&fixture).await;
    let app = &fixture.app;

    let (status, body) = call(
        app,
        "POST",
        "/v1/secret/data/app/db",
        Some(&token),
        Some(json!({ "data": { "USER": "svc", "PASSWORD": "hunter2" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["version"], 1);
    assert!(!body.to_string().contains("hunter2"));

    let (status, body) = call(app, "GET", "/v1/secret/data/app/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["data"],
        json!({ "USER": "svc", "PASSWORD": "hunter2" })
    );
    assert_eq!(body["data"]["metadata"]["version"], 1);

    // Full replace with check-and-set: PASSWORD changes, USER is removed.
    let (status, body) = call(
        app,
        "PUT",
        "/v1/secret/data/app/db",
        Some(&token),
        Some(json!({ "options": { "cas": 1 }, "data": { "PASSWORD": "rotated" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["version"], 2);
    let (status, body) = call(
        app,
        "PUT",
        "/v1/secret/data/app/db",
        Some(&token),
        Some(json!({ "options": { "cas": 1 }, "data": { "PASSWORD": "stale" } })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["errors"][0]
        .as_str()
        .unwrap()
        .contains("check-and-set"));
    let (_, body) = call(app, "GET", "/v1/secret/data/app/db", Some(&token), None).await;
    assert_eq!(body["data"]["data"], json!({ "PASSWORD": "rotated" }));

    let (status, body) = call(app, "GET", "/v1/secret/metadata/app/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["current_version"], 2);

    call(
        app,
        "POST",
        "/v1/secret/data/app/nested/cache",
        Some(&token),
        Some(json!({ "data": { "URL": "redis://x" } })),
    )
    .await;
    let (status, body) = call(app, "LIST", "/v1/secret/metadata/app", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["keys"], json!(["db", "nested/"]));
    let (status, body) = call(
        app,
        "GET",
        "/v1/secret/metadata/app/?list=true",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["keys"], json!(["db", "nested/"]));

    // Soft delete: the read is gone, metadata survives.
    let (status, _) = call(app, "DELETE", "/v1/secret/data/app/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = call(app, "GET", "/v1/secret/data/app/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({ "errors": [] }));
    let (status, body) = call(app, "GET", "/v1/secret/metadata/app/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(body["data"]["versions"]["2"]["deletion_time"], "");

    // Metadata delete destroys everything.
    let (status, _) = call(
        app,
        "DELETE",
        "/v1/secret/metadata/app/db",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = call(app, "GET", "/v1/secret/metadata/app/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(fixture
        .store
        .list_vault_secrets_filtered(&ListFilter {
            path: Some("/app/db".into()),
            include_deleted: true,
            ..ListFilter::default()
        })
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn check_and_set_versions_are_monotonic() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let token = login(&fixture).await;
    let app = &fixture.app;
    let uri = "/v1/secret/data/app/cfg";

    for (cas, value) in [(0, "1"), (1, "2"), (2, "3")] {
        let (status, body) = put(
            app,
            &token,
            uri,
            json!({ "options": { "cas": cas }, "data": { "A": value } }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["version"], cas + 1);
    }

    // Removing the key that holds the highest per-key version still
    // creates a new version, so the same cas cannot win twice.
    let (status, body) = put(
        app,
        &token,
        uri,
        json!({ "options": { "cas": 3 }, "data": { "B": "x" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["version"], 4);
    let (status, body) = put(
        app,
        &token,
        uri,
        json!({ "options": { "cas": 3 }, "data": { "B": "y" } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(is_cas_error(&body));
    let (_, body) = call(app, "GET", uri, Some(&token), None).await;
    assert_eq!(body["data"]["data"], json!({ "B": "x" }));
    assert_eq!(body["data"]["metadata"]["version"], 4);

    // cas 0 is create-only, including after a soft delete.
    let (status, body) = put(
        app,
        &token,
        uri,
        json!({ "options": { "cas": 0 }, "data": { "B": "z" } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(is_cas_error(&body));
    let (status, _) = call(app, "DELETE", uri, Some(&token), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = put(
        app,
        &token,
        uri,
        json!({ "options": { "cas": 0 }, "data": { "B": "z" } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // The current version of a fully soft-deleted secret is accepted.
    let (status, body) = put(
        app,
        &token,
        uri,
        json!({ "options": { "cas": 4 }, "data": { "B": "z" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["version"], 5);

    // A direct write outside this surface also advances the version.
    native_write(fixture.store, "default", "/app/cfg", "B").await;
    let (_, body) = call(
        app,
        "GET",
        "/v1/secret/metadata/app/cfg",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(body["data"]["current_version"], 6);
    let (status, _) = put(
        app,
        &token,
        uri,
        json!({ "options": { "cas": 5 }, "data": { "B": "w" } }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // An empty write is a new (empty) version.
    let (status, body) = put(
        app,
        &token,
        uri,
        json!({ "options": { "cas": 6 }, "data": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["version"], 7);
    let (status, _) = call(app, "GET", uri, Some(&token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Metadata delete starts the secret over at version 1.
    let (status, _) = call(
        app,
        "DELETE",
        "/v1/secret/metadata/app/cfg",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = put(
        app,
        &token,
        uri,
        json!({ "options": { "cas": 0 }, "data": { "C": "c" } }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["version"], 1);
}

#[tokio::test]
async fn cas_required_environments_accept_compat_writes_that_carry_cas() {
    let fixture = fixture(vec![all_caps("strict/app/**")]).await;
    fixture
        .store
        .put_environment(
            &Environment {
                slug: "strict".into(),
                name: "strict".into(),
                protected: false,
                required_approvals: 1,
                position: 1,
                cas_required: true,
            },
            &AuditActor::new("user", Some("admin")),
        )
        .await
        .unwrap();
    let token = login(&fixture).await;
    let app = &fixture.app;
    let uri = "/v1/secret/data/app/cfg";
    let write = |body: Value| {
        call_in(
            app,
            Some("strict"),
            "PUT",
            uri,
            Some(token.as_str()),
            Some(body),
        )
    };

    let (status, body) = write(json!({ "data": { "A": "1" } })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(is_cas_error(&body), "{body}");
    let (status, body) = write(json!({ "options": { "cas": 0 }, "data": { "A": "1" } })).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = write(json!({
        "options": { "cas": 1 },
        "data": { "A": "2", "B": "new" }
    }))
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["version"], 2);
    let (status, body) = write(json!({ "data": { "A": "3", "B": "new" } })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = write(json!({ "options": { "cas": 1 }, "data": { "A": "3" } })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(is_cas_error(&body), "{body}");
}
