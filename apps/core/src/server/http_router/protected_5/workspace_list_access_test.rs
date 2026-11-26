//! `GET /api/workspace/list` refuses network and device paths on Windows
//! before any filesystem call, and keeps listing local folders.
//!
//! No test here opens a network path: the route test runs the refusal only,
//! and the pure checks never touch the filesystem.
use super::*;
use axum::body::Body;
use axum::http::Request;
use axum::routing::get;
use axum::Router;
use tower::ServiceExt;

const REFUSED: &str = "path must be a local folder";

#[test]
fn network_and_device_paths_are_refused_on_windows() {
    for refused in [
        r"\\host\share",
        r"\\host\share\repo",
        r"\\host@SSL@443\share",
        "//host/share/repo",
        r"\/host/share",
        r"/\host\share",
        r"\\?\UNC\host\share",
        r"\\?\unc\host\share",
        r"\\.\UNC\host\share",
        r"\??\UNC\host\share",
        r"\\.\pipe\name",
        r"\\.\C:\repo",
        r"\\?\GLOBALROOT\Device\Mup\host\share",
        r"\\?\Volume{00000000-0000-0000-0000-000000000000}\",
        r"  \\host\share  ",
    ] {
        assert_eq!(
            check_list_path(refused, true),
            Err(REFUSED.to_string()),
            "{refused}"
        );
    }
}

#[test]
fn local_paths_pass_on_windows() {
    for local in [
        r"C:\Users\someone\repo",
        "C:/Users/someone/repo",
        r"\\?\C:\Users\someone\repo",
        r"\\?\C:",
        r"~\repo",
        "~",
        "",
        "::this-pc",
        "/home/someone/repo",
        "repo",
    ] {
        assert_eq!(check_list_path(local, true), Ok(()), "{local}");
    }
}

#[test]
fn other_platforms_keep_double_slash_paths() {
    // Elsewhere two leading slashes name a local folder.
    assert_eq!(check_list_path("//srv/data", false), Ok(()));
    assert_eq!(check_list_path(r"\\host\share", false), Ok(()));
}

async fn get_status_and_json(path_and_query: &str) -> (StatusCode, serde_json::Value) {
    let router = Router::new().route("/api/workspace/list", get(list_directory_checked));
    let response = router
        .oneshot(
            Request::builder()
                .uri(path_and_query)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

#[cfg(windows)]
#[tokio::test]
async fn the_route_refuses_a_unc_path_before_listing() {
    // `.invalid` never resolves, and the refusal comes first anyway.
    for query in [
        "path=%5C%5Cryu-test.invalid%5Cshare",
        "path=%2F%2Fryu-test.invalid%2Fshare",
        "path=%5C%5C%3F%5CUNC%5Cryu-test.invalid%5Cshare",
        // A second `path` key cannot carry the network path past the check.
        "path=~&path=%5C%5Cryu-test.invalid%5Cshare",
        "path=%5C%5Cryu-test.invalid%5Cshare&path=~",
    ] {
        let (status, body) = get_status_and_json(&format!("/api/workspace/list?{query}")).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{query}");
        assert_eq!(body, json!({ "error": REFUSED }), "{query}");
    }
}

#[tokio::test]
async fn the_route_still_lists_the_home_folder() {
    let Some(home) = dirs::home_dir().filter(|home| home.is_dir()) else {
        return;
    };
    let (status, body) = get_status_and_json("/api/workspace/list?path=~").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["entries"].is_array());
    assert!(body["home"].is_string(), "{home:?}");
}
