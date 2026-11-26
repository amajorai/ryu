//! An app route that names a kernel agent level and captures an agent id is
//! checked on the agent, whichever app declares it.
//!
//! The end to end tests drive the real HTTP lane (`proxy_for_plugin`) and the
//! real WebSocket router against a stub sidecar on an organization-bound node.
//! No desktop session, display server or input tool is started.

use super::{agent_check, is_agent_route, route_scope, AgentCheck, RouteScope};
use crate::acl::store::{ResourceKey, StoredOverwrite};
use crate::identity_verify::{permissions, OrgRole, VerifiedCaller};
use crate::server::multiplayer_journey_tests::TestIdentityProvider;
use crate::sidecar::capability_consumer::test_support::{
    register_sidecar_for, reserve_port, serve,
};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::sidecar::ext_proxy::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

mod end_to_end;

const APP: &str = "@acme/agent-screens";
const ORG: &str = "org-agent-devices";

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: ORG.to_owned(),
            name: ORG.to_owned(),
            slug: None,
        },
        node_id: "node-agent-devices".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

/// An app with the route shape of `apps-store/desktop/manifest.json`: its own
/// routes for the node's surface, and one agent route for each of them. The rows
/// after those are agent routes with no usable own route behind them: none at
/// all (`/files`), nothing after the agent segment, a per-object one (`/tabs/:id`)
/// and a public one (`/hook`). The sidecar is one the stub can stand in for.
fn app_manifest(port: u16) -> crate::plugin_manifest::PluginManifest {
    serde_json::from_value(json!({
        "id": APP, "name": "Agent Screens", "version": "1.0.0",
        "runnables": [],
        "sidecars": [{ "name": "engine", "port": port,
            "process": { "kind": "local", "command": "true" },
            "http": { "routes": [
                { "path": "/", "permission": "screens.view" },
                { "path": "/screen", "permission": "screens.view" },
                { "path": "/ws", "permission": "screens.control" },
                { "path": "/input", "permission": "screens.control" },
                { "path": "/tabs/:id", "permission": "screens.view",
                  "resource_param": "id" },
                { "path": "/hook", "auth": "public", "permission": "screens.view" },
                { "path": "/bots/:agent_id/screen", "permission": "agent.view",
                  "resource_param": "agent_id" },
                { "path": "/bots/:agent_id/ws", "permission": "agent.run",
                  "resource_param": "agent_id" },
                { "path": "/bots/:agent_id/input", "permission": "agent.run",
                  "resource_param": "agent_id" },
                { "path": "/bots/:agent_id/settings", "permission": "agent.edit",
                  "resource_param": "agent_id" },
                { "path": "/bots/:agent_id/files", "permission": "agent.view",
                  "resource_param": "agent_id" },
                { "path": "/bots/:agent_id", "permission": "agent.view",
                  "resource_param": "agent_id" },
                { "path": "/bots/:agent_id/tabs/:id", "permission": "agent.view",
                  "resource_param": "agent_id" },
                { "path": "/bots/:agent_id/hook", "permission": "agent.view",
                  "resource_param": "agent_id" }
            ] } }],
    }))
    .expect("app fixture parses")
}

fn route_row(row: serde_json::Value) -> crate::plugin_manifest::schema::RouteSpec {
    serde_json::from_value(row).expect("route parses")
}

/// One member's overwrite on one resource, as an administrator stores it.
/// Cleared when dropped.
struct Rule(ResourceKey);

impl Rule {
    fn set(key: ResourceKey, user_id: &str, allow: &[&str], deny: &[&str]) -> Self {
        let owned = |levels: &[&str]| levels.iter().map(|level| (*level).to_owned()).collect();
        crate::acl::store::set_overwrites(
            &key,
            vec![StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: user_id.to_owned(),
                allow: owned(allow),
                deny: owned(deny),
            }],
        )
        .expect("persist the ACL fixture");
        Self(key)
    }

    fn on_agent(agent_id: &str, user_id: &str, allow: &[&str], deny: &[&str]) -> Self {
        let key = ResourceKey::new(crate::acl::KIND_AGENT, agent_id);
        Self::set(key, user_id, allow, deny)
    }

    /// Deny `agent.view` and `agent.run` on `agent_id` to `user_id`.
    fn deny_agent(agent_id: &str, user_id: &str) -> Self {
        let levels = [permissions::AGENT_VIEW, permissions::AGENT_RUN];
        Self::on_agent(agent_id, user_id, &[], &levels)
    }

    /// Grant `level` on the app `app` itself, the resource of a route without a
    /// `resource_param`.
    fn allow_on_the_app(app: &str, user_id: &str, level: &str) -> Self {
        Self::set(ResourceKey::new(app, app), user_id, &[level], &[])
    }
}

impl Drop for Rule {
    fn drop(&mut self) {
        let _ = crate::acl::store::set_overwrites(&self.0, Vec::new());
    }
}

/// A state with the app enabled and one real agent in the agent store.
async fn app_state(directory: &std::path::Path, port: u16) -> (ServerState, String) {
    let state = crate::server::isolated_plugin_hook_test_state(directory);
    state.app_manifests.write().await.push(app_manifest(port));
    state.app_store.insert(APP, "1.0.0").await.unwrap();
    state.app_store.set_enabled(APP, &[]).await.unwrap();
    let agent_id = state
        .agent_store
        .create(crate::agents::CreateAgent {
            name: "Agent with a desktop".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap()
        .id;
    (state, agent_id)
}

/// A stub sidecar that answers 200 to everything and counts what reaches it.
async fn stub_sidecar(port: u16) -> (tokio::task::JoinHandle<()>, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let router = Router::new().fallback(move || {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            "stub"
        }
    });
    (serve(port, router).await, hits)
}

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// A request as a member's own session sends it. The JWT rides both as the
/// bearer (a node with a token admits the member by it) and as the user header
/// (a node without a token reads the caller from it).
fn member_request(app: &str, method: &str, jwt: &str) -> Request {
    Request::builder()
        .method(method)
        .uri(format!("/api/ext/{app}/bots/agent/route"))
        .header("authorization", format!("Bearer {jwt}"))
        .header("x-ryu-user-jwt", jwt)
        .body(Body::from("{}"))
        .unwrap()
}

async fn status_of(state: &ServerState, method: &str, sub_path: &str, jwt: &str) -> StatusCode {
    status_on(state, APP, method, sub_path, jwt).await
}

async fn status_on(
    state: &ServerState,
    app: &str,
    method: &str,
    sub_path: &str,
    jwt: &str,
) -> StatusCode {
    with_test_node_binding(
        true,
        Some(org_node()),
        proxy_for_plugin(state, app, sub_path, None, member_request(app, method, jwt)),
    )
    .await
    .status()
}

fn shipped_desktop_manifest() -> crate::plugin_manifest::PluginManifest {
    serde_json::from_str(include_str!(
        "../../../../../../../generated/ryu-runtime/apps-store/desktop/manifest.json"
    ))
    .expect("manifest parses")
}

/// A state with the shipped Desktop manifest enabled, its routes and levels
/// exactly as shipped, on a sidecar the stub can stand in for. Returns the app id
/// the manifest carries. Its levels are declared, so they can be granted.
async fn shipped_state(directory: &std::path::Path, port: u16) -> (ServerState, String) {
    let state = crate::server::isolated_plugin_hook_test_state(directory);
    let mut manifest = shipped_desktop_manifest();
    let app = manifest.id.clone();
    let version = manifest.version.clone();
    let sidecar = manifest
        .sidecars
        .iter_mut()
        .find(|sidecar| sidecar.http.is_some())
        .expect("the manifest proxies a sidecar");
    sidecar.name = "engine".to_owned();
    sidecar.port = port;
    {
        let mut manifests = state.app_manifests.write().await;
        manifests.retain(|existing| existing.id != app);
        manifests.push(manifest);
    }
    // The record may exist already when the test state seeds built-in apps.
    let _ = state.app_store.insert(&app, &version).await;
    let enabled = state
        .app_store
        .set_enabled(&app, &Vec::<String>::new())
        .await
        .expect("enable the app");
    assert!(enabled.is_some_and(|record| record.enabled));
    (state, app)
}

#[test]
fn an_agent_route_names_a_kernel_agent_level_and_captures_the_agent_id() {
    let manifest = app_manifest(1);
    let routes = &manifest.sidecars[0].http.as_ref().expect("http").routes;
    let matched: Vec<&str> = routes
        .iter()
        .filter(|route| is_agent_route(route))
        .map(|route| route.path.as_str())
        .collect();
    assert_eq!(
        matched,
        vec![
            "/bots/:agent_id/screen",
            "/bots/:agent_id/ws",
            "/bots/:agent_id/input",
            "/bots/:agent_id/settings",
            "/bots/:agent_id/files",
            "/bots/:agent_id",
            "/bots/:agent_id/tabs/:id",
            "/bots/:agent_id/hook"
        ]
    );
    assert_eq!(
        permissions::AGENT_LEVELS,
        [
            permissions::AGENT_VIEW,
            permissions::AGENT_RUN,
            permissions::AGENT_EDIT,
            permissions::AGENT_DELETE
        ]
    );
    for level in permissions::AGENT_LEVELS {
        let row = json!({ "path": "/x/:agent_id", "permission": level,
            "resource_param": "agent_id" });
        assert!(is_agent_route(&route_row(row)), "{level}");
    }
    // The app's own level on an agent id, a kernel level on the whole app, a
    // kernel level on another param, and an ungated row keep the app's own kind.
    for row in [
        json!({ "path": "/bots/:agent_id/screen", "permission": "screens.view",
            "resource_param": "agent_id" }),
        json!({ "path": "/bots/:agent_id/screen", "permission": "agent.view" }),
        json!({ "path": "/bots/:id/screen", "permission": "agent.view",
            "resource_param": "id" }),
        json!({ "path": "/bots/:agent_id/screen" }),
    ] {
        assert!(!is_agent_route(&route_row(row.clone())), "{row}");
    }
}

/// The scope the proxy lanes resolve for one request, as they call it.
fn scope_of(
    manifest: &crate::plugin_manifest::PluginManifest,
    method: &str,
    sub_path: &str,
) -> RouteScope {
    let (_, _, route) =
        super::super::resolve_route(manifest, sub_path, method).expect("the route resolves");
    route_scope(manifest, route, sub_path, method)
}

fn node_lane(level: &str) -> RouteScope {
    RouteScope::Agent {
        node_lane: Some(level.to_owned()),
    }
}

/// The second level for the node's default agent is the app's own route's
/// level, read from the manifest with the request's method.
#[test]
fn the_node_lane_takes_the_level_of_the_apps_own_route() {
    let manifest = app_manifest(1);
    assert_eq!(scope_of(&manifest, "GET", "/screen"), RouteScope::App);
    assert_eq!(
        scope_of(&manifest, "GET", "/bots/ryu/screen"),
        node_lane("screens.view")
    );
    assert_eq!(
        scope_of(&manifest, "GET", "/bots/ryu/ws"),
        node_lane("screens.control")
    );
    assert_eq!(
        scope_of(&manifest, "POST", "/bots/ryu/input"),
        node_lane("screens.control")
    );
}

/// An agent route has no node lane when the app declares no own route for it,
/// when nothing follows the agent segment (it must not fall to `/`), when the own
/// route is per-object or public, or when the own route is on another sidecar.
#[test]
fn an_agent_route_without_a_usable_own_route_has_no_node_lane() {
    let manifest = app_manifest(1);
    let none = RouteScope::Agent { node_lane: None };
    for sub_path in [
        "/bots/ryu/files",
        "/bots/ryu",
        "/bots/ryu/tabs/7",
        "/bots/ryu/hook",
    ] {
        assert_eq!(scope_of(&manifest, "GET", sub_path), none, "{sub_path}");
    }

    let sidecar = |name: &str, routes: serde_json::Value| {
        json!({ "name": name, "port": 1,
            "process": { "kind": "local", "command": "true" },
            "http": { "routes": routes } })
    };
    let two_sidecars: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
        "id": APP, "name": "Agent Screens", "version": "1.0.0",
        "runnables": [],
        "sidecars": [
            sidecar("engine", json!([
                { "path": "/bots/:agent_id/logs", "permission": "agent.view",
                  "resource_param": "agent_id" }
            ])),
            sidecar("other", json!([
                { "path": "/logs", "permission": "screens.view" }
            ]))
        ],
    }))
    .expect("two sidecar fixture parses");
    assert_eq!(scope_of(&two_sidecars, "GET", "/bots/ryu/logs"), none);
}

/// The shipped Desktop manifest is the one app that declares agent routes today.
/// Its three rows must stay agent routes, and the node's default agent must keep
/// the levels of the app's own `/screen`, `/ws` and `/input`. If a row is renamed
/// there, this fails instead of the rule going quiet.
#[test]
fn the_shipped_manifest_rows_are_agent_routes_with_their_node_lane_levels() {
    let manifest = shipped_desktop_manifest();
    let routes = &manifest.sidecars[0].http.as_ref().expect("http").routes;
    let mut agent_rows = 0;
    for route in routes {
        let names_agent_level = matches!(
            route.permission.as_deref(),
            Some(permissions::AGENT_VIEW | permissions::AGENT_RUN)
        );
        assert_eq!(
            is_agent_route(route),
            names_agent_level,
            "{} must be checked on the agent exactly when it names an agent level",
            route.path
        );
        agent_rows += usize::from(names_agent_level);
    }
    assert_eq!(agent_rows, 3);
    let default_agent = crate::registry::DEFAULT_AGENT_ID;
    for (method, surface, level) in [
        ("GET", "screen", "desktop.view"),
        ("GET", "ws", "desktop.control"),
        ("POST", "input", "desktop.control"),
    ] {
        let sub_path = format!("/bots/{default_agent}/{surface}");
        assert_eq!(
            scope_of(&manifest, method, &sub_path),
            node_lane(level),
            "{sub_path}"
        );
    }
}

#[test]
fn the_check_for_an_agent_id() {
    assert_eq!(agent_check("agent_1"), AgentCheck::Agent);
    assert_eq!(agent_check("büro agent"), AgentCheck::Agent);
    // The node's default agent stands for the node itself.
    assert_eq!(
        agent_check(crate::registry::DEFAULT_AGENT_ID),
        AgentCheck::NodeLane
    );
    assert_eq!(agent_check("ryu"), AgentCheck::NodeLane);
    // An id the sidecar would decode or trim into another one.
    for alias in ["%78", "agent%201", " agent_1", "agent_1 ", "ryu ", ""] {
        assert_eq!(agent_check(alias), AgentCheck::Refuse, "{alias:?}");
    }
}
