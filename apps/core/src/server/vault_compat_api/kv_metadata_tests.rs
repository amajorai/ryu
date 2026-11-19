//! KV v2 listing and metadata authorization.

use super::fixture_test::*;

#[tokio::test]
async fn listing_and_metadata_require_list_and_reads_are_all_or_nothing() {
    let fixture = fixture(vec![
        all_caps("default/app/**"),
        rule("default/app/db/HIDDEN", &[Capability::Read], true),
        rule(
            "default/wo/**",
            &[Capability::Write, Capability::Use],
            false,
        ),
    ])
    .await;
    let token = login(&fixture).await;
    let app = &fixture.app;
    for (uri, data) in [
        ("/v1/secret/data/app/db", json!({ "USER": "svc" })),
        (
            "/v1/secret/data/app/nested/cache",
            json!({ "URL": "redis://x" }),
        ),
        ("/v1/secret/data/wo/sink", json!({ "TOKEN": "t" })),
    ] {
        let (status, body) = put(app, &token, uri, json!({ "data": data })).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {body}");
    }

    let (status, body) = call(app, "LIST", "/v1/secret/metadata/app", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["keys"], json!(["db", "nested/"]));
    for (method, uri) in [
        ("GET", "/v1/secret/metadata?list=true"),
        ("GET", "/v1/secret/metadata/?list=true"),
        ("LIST", "/v1/secret/metadata"),
    ] {
        let (status, body) = call(app, method, uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{method} {uri}: {body}");
        // `wo/` holds keys the caller may write but not list.
        assert_eq!(body["data"]["keys"], json!(["app/"]), "{method} {uri}");
    }

    // Write/use without list or read: no listing, metadata, or data.
    let (status, _) = call(app, "LIST", "/v1/secret/metadata/wo", Some(&token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for uri in ["/v1/secret/metadata/wo/sink", "/v1/secret/data/wo/sink"] {
        let (status, body) = call(app, "GET", uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
    }

    // One unreadable key denies the whole secret instead of returning
    // a partial key set a later full replace would drop.
    native_write(fixture.store, "default", "/app/db", "HIDDEN").await;
    let (status, body) = call(app, "GET", "/v1/secret/data/app/db", Some(&token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(!body.to_string().contains("svc"));
}

#[test]
fn list_pages_follow_openbao_after_and_limit() {
    use super::kv_metadata::ListPage;
    let keys = || {
        ["a", "b/", "c", "d"]
            .into_iter()
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>()
    };
    let page = |after: Option<&str>, limit: Option<&str>| {
        ListPage::parse(after.map(str::to_owned), limit)
            .ok()
            .unwrap()
            .apply(keys())
    };
    assert_eq!(page(None, None), ["a", "b/", "c", "d"]);
    assert_eq!(page(Some("b/"), None), ["c", "d"]);
    assert_eq!(page(Some("a"), Some("2")), ["b/", "c"]);
    // A key that is not listed still bounds the page by sort order.
    assert_eq!(page(Some("bb"), Some("1")), ["c"]);
    // Zero, negative and empty limits mean no limit; an empty `after` is none.
    for limit in ["0", "-3", ""] {
        assert_eq!(
            page(Some(""), Some(limit)),
            ["a", "b/", "c", "d"],
            "{limit}"
        );
    }
    assert!(ListPage::parse(None, Some("ten")).is_err());
    assert!(ListPage::parse(None, Some("1.5")).is_err());
}

#[tokio::test]
async fn listings_page_with_after_and_limit_on_every_list_form() {
    let fixture = fixture(vec![all_caps("default/app/**")]).await;
    let token = login(&fixture).await;
    let app = &fixture.app;
    for name in ["alpha", "beta", "gamma", "delta"] {
        let uri = format!("/v1/secret/data/app/{name}");
        let (status, body) = put(app, &token, &uri, json!({ "data": { "K": "v" } })).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {body}");
    }
    for (method, uri) in [
        ("LIST", "/v1/secret/metadata/app?after=beta&limit=2"),
        (
            "GET",
            "/v1/secret/metadata/app?list=true&after=beta&limit=2",
        ),
    ] {
        let (status, body) = call(app, method, uri, Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{method} {uri}: {body}");
        assert_eq!(
            body["data"]["keys"],
            json!(["delta", "gamma"]),
            "{method} {uri}"
        );
    }
    let (status, body) = call(
        app,
        "GET",
        "/v1/secret/metadata?list=true&limit=1",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["keys"], json!(["app/"]));
    // Past the last key the page is empty, which reads as not found.
    let (status, _) = call(
        app,
        "LIST",
        "/v1/secret/metadata/app?after=gamma",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = call(
        app,
        "LIST",
        "/v1/secret/metadata/app?limit=many",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}
