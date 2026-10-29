//! Mounted Gateway operator reads deny callers without the matching org
//! permission before Core contacts the Gateway.
//!
//! Live traffic needs `audit.view` and budget spend needs `gateway.configure`.
//! Identity is inserted at the post-verification seam; no JWT or control-plane
//! network is simulated. The route-layer refusal of scoped `gateway:route`
//! credentials is covered by `gateway_audit_route_policy_tests`.
use super::*;
use axum::body::Body;
use axum::http::Request;
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
async fn managed_node_denies_anonymous_traffic_and_spend_reads_before_the_gateway() {
    let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
    let directory = tempfile::tempdir().unwrap();
    let router = Router::new()
        .route("/api/gateway/traffic", get(gateway_traffic))
        .route("/api/gateway/budget/spend", get(gateway_budget_spend))
        .layer(Extension(None::<crate::identity_verify::VerifiedCaller>))
        .with_state(isolated_plugin_hook_test_state(directory.path()));

    let restore_managed_node = RestoreManagedNode(std::env::var_os("RYU_MANAGED_NODE"));
    std::env::set_var("RYU_MANAGED_NODE", "1");
    assert!(crate::sidecar::control_plane::is_managed_node());
    // Without the gates both handlers answer 200 (a stream, or the fail-soft
    // `{ reachable: false }` body), so these exact 403 bodies prove the
    // permission check ran before any Gateway request.
    let traffic = get_json(&router, "/api/gateway/traffic").await;
    let spend = get_json(&router, "/api/gateway/budget/spend?user_id=someone-else").await;
    drop(restore_managed_node);

    assert_eq!(
        traffic,
        (
            StatusCode::FORBIDDEN,
            json!({ "error": "insufficient permissions: audit.view" })
        )
    );
    assert_eq!(
        spend,
        (
            StatusCode::FORBIDDEN,
            json!({ "error": "insufficient permissions: gateway.configure" })
        )
    );
}
