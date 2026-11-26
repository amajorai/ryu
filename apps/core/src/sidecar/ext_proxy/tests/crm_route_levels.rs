//! The CRM app's shipped route levels, as Core resolves and enforces them.
//!
//! "Can view" reads objects and records; "Can administer" changes the schema.
//! Creating, renaming and deleting an object and adding a field are schema
//! changes, so their methods must sit at the admin level while the reads on the
//! same paths stay at the view level. The pure rows below repeat
//! `tools/crm-manifest-route-levels.test.mjs`, which asserts them with a mirror
//! of this resolver, so the two cannot drift apart unnoticed.

use super::*;
use crate::plugins::builtins::CRM_PLUGIN_ID as APP;

const VIEW: &str = "crm.view";
const EDIT: &str = "crm.edit";
const ADMIN: &str = "crm.admin";

fn crm_manifest() -> crate::plugin_manifest::PluginManifest {
    serde_json::from_str(include_str!(
        "../../../../../../generated/ryu-runtime/apps-store/crm/manifest.json"
    ))
    .expect("the CRM manifest parses")
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
fn crm_object_and_field_writes_need_the_admin_level() {
    let crm = crm_manifest();
    for (method, path) in [
        ("POST", "/objects"),
        ("PATCH", "/objects/company"),
        ("DELETE", "/objects/company"),
        ("POST", "/objects/company/fields"),
    ] {
        assert_eq!(
            level(&crm, method, path).as_deref(),
            Some(ADMIN),
            "{method} {path} changes the schema and must demand the admin level"
        );
    }
    for path in ["/objects", "/objects/company", "/objects/company/fields"] {
        assert_eq!(
            level(&crm, "GET", path).as_deref(),
            Some(VIEW),
            "GET {path}"
        );
    }
    assert!(resolve_route(&crm, "/objects/company", "PUT").is_none());
}

#[test]
fn crm_record_delete_is_declared_at_the_edit_level() {
    let crm = crm_manifest();
    assert!(
        resolve_route(&crm, "/records/r1", "DELETE").is_some(),
        "DELETE /records/:record_id must match a route, or Core answers 404"
    );
    assert_eq!(level(&crm, "DELETE", "/records/r1").as_deref(), Some(EDIT));
    assert_eq!(level(&crm, "GET", "/records/r1").as_deref(), Some(VIEW));
    assert_eq!(level(&crm, "PATCH", "/records/r1").as_deref(), Some(EDIT));
}

#[test]
fn crm_view_level_routes_all_name_their_method() {
    let crm = crm_manifest();
    let open: Vec<&str> = crm
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
fn crm_write_methods_at_the_view_level_are_the_reviewed_read_queries() {
    let crm = crm_manifest();
    let mut passed = std::collections::BTreeSet::new();
    let routes = crm
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
            if level(&crm, method, &concrete).as_deref() == Some(VIEW) {
                passed.insert(format!("{method} {}", route.path));
            }
        }
    }
    let passed: Vec<&str> = passed.iter().map(String::as_str).collect();
    // Queries, reports and lookups the backend serves over POST because they
    // take a body. None of their handlers writes.
    assert_eq!(
        passed,
        [
            "POST /lists/:list_id/entries/query",
            "POST /objects/:object/duplicates",
            "POST /objects/:object/records/query",
            "POST /reports/funnel",
            "POST /reports/pipeline",
            "POST /tools/find_record",
            "POST /tools/get_record",
            "POST /tools/pipeline",
            "POST /tools/search",
            "POST /views/:view_id/run",
        ]
    );
}

/// Puts the app's overwrites back when the test ends, pass or fail.
struct RestoredCrmAcl {
    key: crate::acl::store::ResourceKey,
    previous: Vec<crate::acl::store::StoredOverwrite>,
}

impl Drop for RestoredCrmAcl {
    fn drop(&mut self) {
        let _ = crate::acl::store::set_overwrites(&self.key, self.previous.clone());
    }
}

/// Grant each `(member, level)` on the CRM app itself, the resource a route
/// without a `resource_param` is checked against.
fn grant_on_the_crm_app(grants: &[(&str, &str)]) -> RestoredCrmAcl {
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
    crate::acl::store::set_overwrites(&key, rows).expect("persist the CRM ACL fixture");
    RestoredCrmAcl { key, previous }
}

/// End to end through the proxy on an org-bound node, with the shipped manifest
/// and a stand-in for the sidecar (the real CRM backend is never started): a
/// member who holds only "Can view" on the CRM app reads an object and is
/// refused when deleting it or creating one; a member who holds "Can administer"
/// passes both.
#[tokio::test]
async fn a_view_only_member_cannot_delete_or_create_a_crm_object() {
    use crate::server::multiplayer_journey_tests::TestIdentityProvider;
    use crate::sidecar::capability_consumer::test_support::{
        register_sidecar_for, reserve_port, serve,
    };
    const ORG: &str = "org-crm-levels";
    const VIEWER: &str = "sa24-viewer";
    const ADMINISTRATOR: &str = "sa24-admin";

    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let port = reserve_port();
    let mut manifest = crm_manifest();
    let version = manifest.version.clone();
    let sidecar = manifest
        .sidecars
        .iter_mut()
        .find(|sidecar| sidecar.http.is_some())
        .expect("the CRM manifest proxies a sidecar");
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
        .expect("enable the CRM app");
    assert!(enabled.is_some_and(|record| record.enabled));
    let _sidecar = register_sidecar_for(&state.manager, APP, port).await;

    // Every forwarded request lands here, whatever its path below the mount.
    let hits = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let captured = hits.clone();
    let stand_in = move |method: axum::http::Method| {
        let captured = captured.clone();
        async move {
            captured.lock().await.push(method.to_string());
            Json(json!({ "ok": true }))
        }
    };
    let router = Router::new().fallback(stand_in);
    let server = serve(port, router).await;

    let identity = TestIdentityProvider::start().await;
    let viewer = identity.mint(VIEWER, ORG, "member", &[]);
    let administrator = identity.mint(ADMINISTRATOR, ORG, "member", &[]);
    let _acl = grant_on_the_crm_app(&[(VIEWER, VIEW), (ADMINISTRATOR, ADMIN)]);

    // The member's own session as the bearer, and the same token as the identity
    // header: the caller is that member whether or not this test process holds a
    // node token (without one, admission falls back to the identity header).
    let request = |method: &str, sub_path: &str, jwt: &str| {
        Request::builder()
            .method(method)
            .uri(format!("/api/ext/{APP}{sub_path}"))
            .header("authorization", format!("Bearer {jwt}"))
            .header("x-ryu-user-jwt", jwt)
            .body(Body::empty())
            .unwrap()
    };

    crate::sidecar::control_plane::with_test_node_binding(true, Some(org_bound_node(ORG)), async {
        const ONE: &str = "/objects/deals";
        const ALL: &str = "/objects";
        let deleted =
            proxy_for_plugin(&state, APP, ONE, None, request("DELETE", ONE, &viewer)).await;
        assert_eq!(
            deleted.status(),
            StatusCode::FORBIDDEN,
            "a view-only member reached DELETE /objects/:object of the CRM app"
        );
        let created = proxy_for_plugin(&state, APP, ALL, None, request("POST", ALL, &viewer)).await;
        assert_eq!(
            created.status(),
            StatusCode::FORBIDDEN,
            "a view-only member reached POST /objects of the CRM app"
        );
        let read = proxy_for_plugin(&state, APP, ONE, None, request("GET", ONE, &viewer)).await;
        assert_eq!(
            read.status(),
            StatusCode::OK,
            "a view-only member reads GET /objects/:object"
        );
        let removed = proxy_for_plugin(
            &state,
            APP,
            ONE,
            None,
            request("DELETE", ONE, &administrator),
        )
        .await;
        assert_eq!(
            removed.status(),
            StatusCode::OK,
            "an admin-level member deletes an object"
        );
        let implied =
            proxy_for_plugin(&state, APP, ONE, None, request("GET", ONE, &administrator)).await;
        assert_eq!(implied.status(), StatusCode::OK, "admin implies view");
    })
    .await;
    server.abort();

    // The two refused writes never reached the app.
    assert_eq!(hits.lock().await.clone(), ["GET", "DELETE", "GET"]);
}
