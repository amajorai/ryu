//! Regression tests: an installed third-party manifest cannot claim a Core route
//! prefix through `http.public_mount`, and a non-literal mount never reaches axum.

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::routing::{any, get, put};
use axum::Router;
use tower::ServiceExt;

use super::public_mount_routes;
use crate::plugin_manifest::{PluginManifest, PluginManifestLoader};
use crate::server::ServerState;

/// A copy of a real compiled manifest re-labelled as a community package that
/// claims `mount` as its public prefix.
fn community_manifest(id: &str, mount: &str) -> PluginManifest {
    let mut manifest = PluginManifestLoader::load_builtins()
        .into_iter()
        .find(|m| m.id == "@ryu/mail")
        .expect("@ryu/mail is compiled in");
    manifest.id = id.to_owned();
    for sidecar in &mut manifest.sidecars {
        if let Some(http) = sidecar.http.as_mut() {
            http.public_mount = Some(mount.to_owned());
        }
    }
    manifest
}

/// Stand-ins for Core's own routes, merged with the public-mount router exactly as
/// `create_router` does.
fn core_router(installed: &[PluginManifest], directory: &std::path::Path) -> Router {
    let manifests = PluginManifestLoader::for_router(installed);
    let mounts = public_mount_routes(&manifests, Some("tok".to_owned())).expect("unique mounts");
    Router::<ServerState>::new()
        .route("/api/vault/secrets/:name", put(|| async { "core-vault" }))
        .route("/api/health", get(|| async { "core-health" }))
        .route("/api/ext/:plugin_id/*rest", any(|| async { "core-ext" }))
        .merge(mounts)
        .with_state(crate::server::isolated_plugin_hook_test_state(directory))
}

async fn send(router: &Router, method: Method, uri: &str) -> (StatusCode, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(r#"{"value":"sk-secret"}"#))
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

#[tokio::test]
async fn community_mount_cannot_capture_a_core_vault_secret_route() {
    let directory = tempfile::tempdir().unwrap();
    let evil = community_manifest("community.evil", "/api/vault/secrets/OPENAI_API_KEY");
    let router = core_router(&[evil], directory.path());
    let (status, body) = send(&router, Method::PUT, "/api/vault/secrets/OPENAI_API_KEY").await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "core-vault"));
}

#[tokio::test]
async fn community_mount_cannot_add_methods_to_a_core_path() {
    let directory = tempfile::tempdir().unwrap();
    let evil = community_manifest("community.evil", "/api/health");
    let router = core_router(&[evil], directory.path());
    let (status, _) = send(&router, Method::POST, "/api/health").await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    let (status, body) = send(&router, Method::GET, "/api/health").await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "core-health"));
}

#[tokio::test]
async fn conflicting_or_pattern_mounts_do_not_panic_router_construction() {
    let directory = tempfile::tempdir().unwrap();
    let installed = [
        community_manifest("community.pattern", "/x/*y"),
        community_manifest("community.ext", "/api/ext"),
    ];
    let router = core_router(&installed, directory.path());
    let (status, body) = send(&router, Method::GET, "/api/ext/some-plugin/a").await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, "core-ext"));
    let (status, _) = send(&router, Method::GET, "/x/anything/a").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[test]
fn non_literal_mount_is_skipped_instead_of_panicking() {
    // Even a manifest handed straight to the route builder cannot inject syntax.
    let manifest = community_manifest("community.pattern", "/x/*y");
    let router = public_mount_routes(&[manifest], None);
    assert!(router.is_ok());
}
