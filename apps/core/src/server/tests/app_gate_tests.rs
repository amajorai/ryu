use crate::plugins::{
    builtins::{MEETINGS_PLUGIN_ID, SPACES_PLUGIN_ID},
    PluginStore,
};
use crate::server::{require_app_enabled, AppGate};
use axum::{
    body::Body,
    http::{Request, StatusCode},
    routing::get,
    Router,
};
use tower::ServiceExt;

/// A stand-in for `meetings_routes` / `spaces_routes`: same gate, same middleware,
/// trivial handler. Parameterized over the App, because the gate is generic over
/// it — there is ONE `require_app_enabled`, and every gated feature (Meetings
/// today, Spaces here, anything tomorrow) is the same three lines with a different
/// id. Testing it per-App would be the copy the gate exists to avoid.
fn gated_router(store: &PluginStore, app_id: &'static str, label: &'static str) -> Router {
    Router::new()
        .route("/api/meetings", get(|| async { "meetings ok" }))
        .route("/api/spaces", get(|| async { "spaces ok" }))
        .route_layer(axum::middleware::from_fn_with_state(
            AppGate::new(store, app_id, label),
            require_app_enabled,
        ))
}

/// The Meetings gate (the default subject of these tests).
async fn call(store: &PluginStore, path: &str) -> (StatusCode, String) {
    call_gated(store, MEETINGS_PLUGIN_ID, "Meetings", path).await
}

async fn call_gated(
    store: &PluginStore,
    app_id: &'static str,
    label: &'static str,
    path: &str,
) -> (StatusCode, String) {
    let res = gated_router(store, app_id, label)
        .oneshot(
            Request::builder()
                .uri(path)
                .body(Body::empty())
                .expect("request builds"),
        )
        .await
        .expect("the router is infallible");
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .expect("body reads");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// THE gate: with the App disabled, its routes are refused with a body the
/// desktop can act on (`app_disabled` + the id it must enable).
#[tokio::test]
async fn a_disabled_app_refuses_its_routes_with_an_actionable_503() {
    let store = PluginStore::open_in_memory().unwrap();
    // Installed but never enabled — the lifecycle store's install-disabled default.
    store.insert(MEETINGS_PLUGIN_ID, "1.0.0").await.unwrap();

    let (status, body) = call(&store, "/api/meetings").await;

    // 503, not 404: the route exists and the fix is a config change the caller
    // can make. A 404 would be indistinguishable from "this Core is too old".
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    let json: serde_json::Value = serde_json::from_str(&body).expect("the refusal is JSON");
    assert_eq!(json["error"], "app_disabled");
    assert_eq!(json["app"], MEETINGS_PLUGIN_ID);
    assert_eq!(json["message"], "Enable the Meetings app");
}

/// Fail-closed: an App with no record at all is not installed, so its routes are
/// not live either. Same refusal as a disabled one.
#[tokio::test]
async fn an_uninstalled_app_refuses_too() {
    let store = PluginStore::open_in_memory().unwrap();

    let (status, body) = call(&store, "/api/meetings").await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("app_disabled"), "{body}");
}

/// The other half: an ENABLED App's routes pass straight through. Without this,
/// a gate that refused everything would still pass the test above.
#[tokio::test]
async fn an_enabled_app_serves_its_routes_normally() {
    let store = PluginStore::open_in_memory().unwrap();
    store.insert(MEETINGS_PLUGIN_ID, "1.0.0").await.unwrap();
    store.set_enabled(MEETINGS_PLUGIN_ID, &[]).await.unwrap();

    let (status, body) = call(&store, "/api/meetings").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "meetings ok");
}

/// `route_layer`, not `layer`: the gate runs only on MATCHED routes, so an
/// unknown path stays a plain 404 instead of being mislabelled "app disabled".
#[tokio::test]
async fn an_unknown_path_is_still_a_plain_404() {
    let store = PluginStore::open_in_memory().unwrap();
    // App disabled — if the gate ran on the fallback, this would 503.
    store.insert(MEETINGS_PLUGIN_ID, "1.0.0").await.unwrap();

    let (status, body) = call(&store, "/api/not-a-route").await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.contains("app_disabled"), "{body}");
}

/// Spaces is gated by the SAME layer (`spaces_routes` wires this exact
/// `AppGate` + `require_app_enabled` pair over `/api/spaces/*`).
///
/// This is what makes the Spaces `enabled` bit real rather than decorative: the
/// Store renders a live Switch for it (it is not a `SYSTEM_PLUGINS` built-in), and
/// the dependency graph refuses to disable it under Meetings/Whiteboard/Canvas —
/// both of which would be theatre if flipping the Switch off still served every
/// `/api/spaces/*` route.
#[tokio::test]
async fn the_spaces_app_is_gated_by_the_same_layer() {
    let store = PluginStore::open_in_memory().unwrap();
    store.insert(SPACES_PLUGIN_ID, "1.0.0").await.unwrap();

    // Disabled → refused, naming Spaces (not a hardcoded "Meetings").
    let (status, body) = call_gated(&store, SPACES_PLUGIN_ID, "Spaces", "/api/spaces").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    let json: serde_json::Value = serde_json::from_str(&body).expect("the refusal is JSON");
    assert_eq!(json["error"], "app_disabled");
    assert_eq!(json["app"], SPACES_PLUGIN_ID);
    assert_eq!(json["message"], "Enable the Spaces app");

    // Enabled → straight through.
    store.set_enabled(SPACES_PLUGIN_ID, &[]).await.unwrap();
    let (status, body) = call_gated(&store, SPACES_PLUGIN_ID, "Spaces", "/api/spaces").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "spaces ok");
}
