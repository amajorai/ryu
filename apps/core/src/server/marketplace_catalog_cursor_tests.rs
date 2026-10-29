//! Route-level contract for Ryu Marketplace search paging through Core: a
//! `cursor` reaches the source, and one the Marketplace could not have issued is
//! the caller's error (400), not an upstream failure (502).
use super::*;

#[tokio::test]
async fn marketplace_catalog_routes_reject_a_cursor_the_marketplace_never_issued() {
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    // Knowledge's default active source is the hosted Marketplace, and the cursor
    // is validated before any request, so this needs no network.
    for bad in ["abc", "-1", "5001"] {
        let params = std::collections::HashMap::from([
            ("query".to_owned(), "notes".to_owned()),
            ("cursor".to_owned(), bad.to_owned()),
        ]);
        let (status, Json(body)) =
            knowledge_catalog_list(State(state.clone()), axum::extract::Query(params)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "cursor {bad}");
        assert!(body["error"]
            .as_str()
            .is_some_and(|error| error.contains("next_cursor")));
        assert_eq!(body["concepts"], json!([]));
    }
}

#[test]
fn catalog_search_errors_split_caller_mistakes_from_upstream_failures() {
    let invalid = anyhow::Error::new(crate::catalog_source::InvalidCatalogCursor);
    assert_eq!(
        catalog_search_error_status(&invalid),
        StatusCode::BAD_REQUEST
    );
    let upstream = anyhow::anyhow!("Ryu Marketplace returned status 503");
    assert_eq!(
        catalog_search_error_status(&upstream),
        StatusCode::BAD_GATEWAY
    );
}
