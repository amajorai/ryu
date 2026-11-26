//! The Browser app's shipped route levels, as Core resolves and enforces them.
//!
//! "Can view" reads tabs; "Can control" drives pages with the browser's own
//! sign-ins. The root route `POST /` is the control bridge (navigate, click,
//! type), so it must sit at the control level. The pure rows below repeat
//! `tools/manifest-route-levels.test.mjs`, which asserts them with the generic
//! resolver the manifest guard test uses, so the two resolvers cannot drift
//! apart unnoticed.

use super::*;
use crate::plugins::builtins::BROWSER_PLUGIN_ID as APP;

const VIEW: &str = "browser.view";
const CONTROL: &str = "browser.control";

fn browser_manifest() -> crate::plugin_manifest::PluginManifest {
    serde_json::from_str(include_str!(
        "../../../../../../generated/ryu-runtime/apps-store/browser/manifest.json"
    ))
    .expect("the Browser manifest parses")
}

/// The level Core's resolver demands for one request, `None` for a 404.
fn level(
    manifest: &crate::plugin_manifest::PluginManifest,
    method: &str,
    path: &str,
) -> Option<String> {
    resolve_route(manifest, path, method).and_then(|(_, _, route)| route.permission.clone())
}

#[test]
fn browser_root_route_needs_the_control_level_to_post() {
    let browser = browser_manifest();
    assert_eq!(
        level(&browser, "POST", "/").as_deref(),
        Some(CONTROL),
        "POST / is the control bridge and must demand the control level"
    );
    assert_eq!(level(&browser, "GET", "/").as_deref(), Some(VIEW));
    for method in ["DELETE", "HEAD", "OPTIONS", "PATCH", "PUT"] {
        assert!(
            resolve_route(&browser, "/", method).is_none(),
            "{method} / must match no route"
        );
    }
}

#[test]
fn browser_view_level_routes_all_name_their_method() {
    let browser = browser_manifest();
    let open: Vec<&str> = browser
        .sidecars
        .iter()
        .filter_map(|sidecar| sidecar.http.as_ref())
        .flat_map(|http| http.routes.iter())
        .filter(|route| route.permission.as_deref() == Some(VIEW) && route.method.is_none())
        .map(|route| route.path.as_str())
        .collect();
    assert!(
        open.is_empty(),
        "routes at the view level without a method: {open:?}"
    );
}

#[test]
fn browser_write_methods_at_the_view_level_are_the_reviewed_ones() {
    let browser = browser_manifest();
    let mut passed = std::collections::BTreeSet::new();
    let routes = browser
        .sidecars
        .iter()
        .filter_map(|sidecar| sidecar.http.as_ref())
        .flat_map(|http| http.routes.iter());
    for route in routes {
        let concrete: Vec<&str> = route
            .path
            .split('/')
            .map(|segment| {
                if segment.starts_with(':') || segment.starts_with('*') {
                    "x"
                } else {
                    segment
                }
            })
            .collect();
        let concrete = concrete.join("/");
        for method in ["DELETE", "PATCH", "POST", "PUT"] {
            if route
                .method
                .as_deref()
                .is_some_and(|declared| declared != method)
            {
                continue;
            }
            // "Can view" implies no other level, so its holder passes exactly
            // the routes that resolve to the view level.
            if level(&browser, method, &concrete).as_deref() == Some(VIEW) {
                passed.insert(format!("{method} {}", route.path));
            }
        }
    }
    let passed: Vec<&str> = passed.iter().map(String::as_str).collect();
    // Three reads the sidecar serves over POST, the panel's own appearance, and
    // stopping the viewer's own screencast. Nothing here sends input to a page.
    assert_eq!(
        passed,
        [
            "DELETE /lanes/:agent/tabs/:tab/screencast",
            "POST /tabs/:id/context",
            "POST /tabs/:id/screenshot",
            "POST /tabs/:id/snapshot",
            "PUT /theme",
        ]
    );
}

#[test]
fn browser_page_driving_routes_resolve_to_the_control_level() {
    let browser = browser_manifest();
    for (method, path) in [
        ("POST", "/tabs"),
        ("DELETE", "/tabs/t1"),
        ("POST", "/tabs/t1/navigate"),
        ("POST", "/click"),
        ("POST", "/type"),
        ("POST", "/key"),
        ("POST", "/drag"),
    ] {
        assert_eq!(
            level(&browser, method, path).as_deref(),
            Some(CONTROL),
            "{method} {path}"
        );
    }
    assert_eq!(
        level(&browser, "GET", "/tabs/t1/title").as_deref(),
        Some(VIEW)
    );
    assert!(resolve_route(&browser, "/tabs/t1/title", "POST").is_none());
}

/// Puts the app's overwrites back when the test ends, pass or fail.
struct RestoredBrowserAcl {
    key: crate::acl::store::ResourceKey,
    previous: Vec<crate::acl::store::StoredOverwrite>,
}

impl Drop for RestoredBrowserAcl {
    fn drop(&mut self) {
        let _ = crate::acl::store::set_overwrites(&self.key, self.previous.clone());
    }
}

/// Grant each `(member, level)` on the Browser app itself, the resource a route
/// without a `resource_param` is checked against.
fn grant_on_the_browser_app(grants: &[(&str, &str)]) -> RestoredBrowserAcl {
    let key = crate::acl::store::ResourceKey::new(APP, APP);
    let previous = crate::acl::store::stored_for(&key);
    let rows = grants
        .iter()
        .map(|(member, level)| crate::acl::store::StoredOverwrite {
            target_type: "member".to_owned(),
            target_id: (*member).to_owned(),
            allow: vec![(*level).to_owned()],
            deny: Vec::new(),
        })
        .collect();
    crate::acl::store::set_overwrites(&key, rows).expect("persist the Browser ACL fixture");
    RestoredBrowserAcl { key, previous }
}

/// End to end through the proxy on an org-bound node, with the shipped manifest
/// and a stand-in for the sidecar (the real browser is never started): a member
/// who holds only "Can view" on the Browser app reads `GET /` and is refused on
/// `POST /`; a member who holds "Can control" passes both.
#[tokio::test]
async fn a_view_only_member_cannot_post_to_the_browser_control_bridge() {
    use crate::server::multiplayer_journey_tests::TestIdentityProvider;
    use crate::sidecar::capability_consumer::test_support::{
        register_sidecar_for, reserve_port, serve,
    };
    const ORG: &str = "org-browser-levels";
    const VIEWER: &str = "sa23-viewer";
    const DRIVER: &str = "sa23-driver";

    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let port = reserve_port();
    let mut manifest = browser_manifest();
    let version = manifest.version.clone();
    let sidecar = manifest
        .sidecars
        .iter_mut()
        .find(|sidecar| sidecar.http.is_some())
        .expect("the Browser manifest proxies a sidecar");
    // The stand-in registers as `engine` on a reserved port. Routes, methods and
    // levels stay exactly as shipped.
    sidecar.name = "engine".to_owned();
    sidecar.port = port;
    {
        let mut manifests = state.app_manifests.write().await;
        manifests.retain(|existing| existing.id != APP);
        manifests.push(manifest);
    }
    // The record may exist already when the test state seeds built-in apps.
    let _ = state.app_store.insert(APP, &version).await;
    let enabled = state
        .app_store
        .set_enabled(APP, &Vec::<String>::new())
        .await
        .expect("enable the Browser app");
    assert!(enabled.is_some_and(|record| record.enabled));
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;

    let hits = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let captured = hits.clone();
    let stand_in = move |method: axum::http::Method| {
        let captured = captured.clone();
        async move {
            captured.lock().await.push(method.to_string());
            Json(json!({ "ok": true }))
        }
    };
    let router = Router::new().route("/", axum::routing::get(stand_in.clone()).post(stand_in));
    let server = serve(port, router).await;

    let identity = TestIdentityProvider::start().await;
    let viewer = identity.mint(VIEWER, ORG, "member", &[]);
    let driver = identity.mint(DRIVER, ORG, "member", &[]);
    let _acl = grant_on_the_browser_app(&[(VIEWER, VIEW), (DRIVER, CONTROL)]);

    // The member's own session as the bearer, and the same token as the identity
    // header: the caller is that member whether or not this test process holds a
    // node token (without one, admission falls back to the identity header).
    let request = |method: &str, jwt: &str| {
        Request::builder()
            .method(method)
            .uri(format!("/api/ext/{APP}"))
            .header("authorization", format!("Bearer {jwt}"))
            .header("x-ryu-user-jwt", jwt)
            .body(Body::empty())
            .unwrap()
    };

    crate::sidecar::control_plane::with_test_node_binding(true, Some(org_bound_node(ORG)), async {
        let refused = proxy_for_plugin(&state, APP, "/", None, request("POST", &viewer)).await;
        assert_eq!(
            refused.status(),
            StatusCode::FORBIDDEN,
            "a view-only member reached POST / of the Browser app"
        );
        let read = proxy_for_plugin(&state, APP, "/", None, request("GET", &viewer)).await;
        assert_eq!(
            read.status(),
            StatusCode::OK,
            "a view-only member reads GET /"
        );
        let driven = proxy_for_plugin(&state, APP, "/", None, request("POST", &driver)).await;
        assert_eq!(
            driven.status(),
            StatusCode::OK,
            "a control member posts to /"
        );
        let implied = proxy_for_plugin(&state, APP, "/", None, request("GET", &driver)).await;
        assert_eq!(implied.status(), StatusCode::OK, "control implies view");
    })
    .await;
    server.abort();

    // The refused POST never reached the app.
    assert_eq!(hits.lock().await.clone(), ["GET", "POST", "GET"]);
}
