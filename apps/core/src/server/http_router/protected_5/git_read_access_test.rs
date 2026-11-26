//! The read-only git routes refuse a caller without `agent.view`, a network
//! path on Windows, and on a shared node a folder outside the node home.
//!
//! Identity is inserted at the post-verification seam, the way
//! `gateway_operator_reads_permission_test` does it; no JWT or control-plane
//! network is simulated.
use super::*;
use axum::body::Body;
use axum::http::Request;
use axum::routing::get;
use axum::Router;
use tower::ServiceExt;

async fn get_json(router: &Router, path: &str) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

struct RestoreManagedNode(Option<std::ffi::OsString>);

impl Drop for RestoreManagedNode {
    fn drop(&mut self) {
        match &self.0 {
            Some(value) => std::env::set_var("RYU_MANAGED_NODE", value),
            None => std::env::remove_var("RYU_MANAGED_NODE"),
        }
    }
}

#[tokio::test]
async fn a_managed_node_refuses_anonymous_status_and_branches() {
    let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
    let directory = tempfile::tempdir().unwrap();
    let router = Router::new()
        .route("/api/git/status", get(git_status_authorized))
        .route("/api/git/branches", get(git_branches_authorized))
        .layer(Extension(None::<VerifiedCaller>))
        .with_state(crate::server::isolated_plugin_hook_test_state(
            directory.path(),
        ));

    let restore_managed_node = RestoreManagedNode(std::env::var_os("RYU_MANAGED_NODE"));
    std::env::set_var("RYU_MANAGED_NODE", "1");
    assert!(crate::sidecar::control_plane::is_managed_node());
    // Without the gate both handlers answer 200 for any folder, so these 403
    // bodies prove the permission check ran before any git call.
    let status = get_json(&router, "/api/git/status?cwd=/").await;
    let branches = get_json(&router, "/api/git/branches?cwd=/").await;
    drop(restore_managed_node);

    let denied = (
        StatusCode::FORBIDDEN,
        json!({ "success": false, "error": "insufficient permissions: agent.view" }),
    );
    assert_eq!(status, denied);
    assert_eq!(branches, denied);
}

#[test]
fn network_paths_are_recognised_and_local_ones_are_not() {
    for network in [
        r"\\host\share",
        r"\\host\share\repo",
        "//host/share/repo",
        r"\\?\UNC\host\share",
        r"\\?\unc\host\share",
        r"\\.\UNC\host\share",
        r"\/host/share",
    ] {
        assert!(is_network_path(network), "{network}");
    }
    for local in [
        r"C:\Users\someone\repo",
        "C:/Users/someone/repo",
        r"\\?\C:\Users\someone\repo",
        r"\\.\C:\repo",
        "/home/someone/repo",
        r"\repo",
        "repo",
        "",
    ] {
        assert!(!is_network_path(local), "{local}");
    }
}

#[test]
fn a_network_path_is_refused_on_windows_only() {
    assert_eq!(
        check_cwd(r"\\host\share\repo", true, false),
        Err("cwd must be a local path".to_string())
    );
    assert_eq!(check_cwd("//host/share/repo", true, false).is_err(), true);
    // Elsewhere two leading slashes name a local folder.
    assert_eq!(check_cwd("//host/share/repo", false, false), Ok(()));
}

#[test]
fn a_shared_node_keeps_cwd_inside_the_node_home() {
    let Some(home) = dirs::home_dir().filter(|home| home.is_dir()) else {
        return;
    };
    let Some(root) = home.ancestors().last().filter(|root| *root != home) else {
        return;
    };
    let home = home.to_string_lossy().into_owned();
    let root = root.to_string_lossy().into_owned();

    assert_eq!(check_cwd(&home, false, true), Ok(()));
    assert_eq!(
        check_cwd(&root, false, true),
        Err("cwd must stay inside the node home directory".to_string())
    );
    // A personal machine reads workspaces anywhere.
    assert_eq!(check_cwd(&root, false, false), Ok(()));
    // A missing folder is the handler's `is_repo: false` answer, not a refusal.
    let missing = Path::new(&root).join("ryu-no-such-folder-for-git-read-access");
    assert_eq!(check_cwd(&missing.to_string_lossy(), false, true), Ok(()));
}
