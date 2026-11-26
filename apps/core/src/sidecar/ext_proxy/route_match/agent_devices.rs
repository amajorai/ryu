//! App routes that address one agent (`/bots/:agent_id/...`).
//!
//! An app route is normally checked on the app's own resource kind (the plugin
//! id), so its ids can never collide with the kernel's. A route that names a
//! kernel agent level (`agent.view`, `agent.run`, ...) and captures an AGENT id
//! needs the opposite: an administrator's rule for an agent is stored under the
//! kernel kind `agent`. Checked on the app's kind, that rule was never read, and
//! every member of the organization could reach any agent's surface in the app
//! (its virtual desktop, for one) on the role base alone.
//!
//! The rule names no app. It is keyed on two fields of the matched route, its
//! permission and its resource param, so it applies to whichever app declares
//! such a route. It moves the check to the agent's own rules: an administrator's
//! deny on the agent refuses, and an allow on the agent grants.

use axum::http::StatusCode;

use crate::identity_verify::{permissions, VerifiedCaller};
use crate::plugin_manifest::schema::{RouteAuth, RouteSpec};
use crate::plugin_manifest::PluginManifest;
use crate::server::ServerState;

#[cfg(test)]
mod tests;

/// The param an agent route captures the agent id with.
const AGENT_PARAM: &str = "agent_id";

/// Whether `route` addresses one agent: it captures [`AGENT_PARAM`] as its
/// resource and demands a level of the kernel kind `agent`.
pub(in crate::sidecar::ext_proxy) fn is_agent_route(route: &RouteSpec) -> bool {
    route.resource_param.as_deref() == Some(AGENT_PARAM)
        && route
            .permission
            .as_deref()
            .is_some_and(|level| permissions::AGENT_LEVELS.contains(&level))
}

/// How the permission gate checks one matched route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::sidecar::ext_proxy) enum RouteScope {
    /// The plugin id is the resource kind. Every route but an agent route.
    App,
    /// The route's level is checked on kind `agent` and the captured id.
    ///
    /// `node_lane` is a second level, demanded on the app itself when the id is
    /// the node's default agent: the level of the app's own route for the same
    /// request with the agent segment removed (`/bots/<default>/screen` takes
    /// `/screen`'s). An app may serve that id from the node's own surface, so the
    /// request must also clear the level that guards that surface. `None` when the
    /// app declares no such route; the default id is then refused.
    Agent { node_lane: Option<String> },
}

/// The scope of `route`, which `sub_path` and `method` matched in `manifest`.
/// Resolved while the manifest guard is held, since the gate runs after it is
/// dropped.
pub(in crate::sidecar::ext_proxy) fn route_scope(
    manifest: &PluginManifest,
    route: &RouteSpec,
    sub_path: &str,
    method: &str,
) -> RouteScope {
    if !is_agent_route(route) {
        return RouteScope::App;
    }
    RouteScope::Agent {
        node_lane: node_lane_level(manifest, route, sub_path, method),
    }
}

/// The request path with everything up to and including the agent segment
/// removed: `/bots/ryu/screen` on `/bots/:agent_id/screen` gives `/screen`.
/// `None` when nothing follows the agent segment.
fn path_after_agent_segment(pattern: &str, sub_path: &str) -> Option<String> {
    let marker = format!(":{AGENT_PARAM}");
    let index = pattern
        .trim_start_matches('/')
        .split('/')
        .position(|segment| segment == marker)?;
    let rest: Vec<&str> = sub_path
        .trim_start_matches('/')
        .split('/')
        .skip(index + 1)
        .collect();
    if rest.iter().all(|segment| segment.is_empty()) {
        return None;
    }
    Some(format!("/{}", rest.join("/")))
}

/// The level the app itself demands for the node's own surface behind an agent
/// route. It is read with the one resolver the proxy uses, from the same sidecar,
/// and only from a protected route that is checked on the whole app. Anything
/// else is `None`, so the default id is refused instead of being checked on a
/// guess. A route that ends in the agent segment has no such route: it must not
/// fall to `/`.
fn node_lane_level(
    manifest: &PluginManifest,
    route: &RouteSpec,
    sub_path: &str,
    method: &str,
) -> Option<String> {
    let own_path = path_after_agent_segment(&route.path, sub_path)?;
    let (_, http, own_route) = super::resolve_route(manifest, &own_path, method)?;
    let same_sidecar = http
        .routes
        .iter()
        .any(|declared| std::ptr::eq(declared, route));
    if !same_sidecar
        || own_route.auth != RouteAuth::Protected
        || own_route.resource_param.is_some()
        || is_agent_route(own_route)
    {
        return None;
    }
    own_route.permission.clone()
}

/// What the gate checks for one request on an agent route.
#[derive(Debug, PartialEq, Eq)]
pub(in crate::sidecar::ext_proxy) enum AgentCheck {
    /// Not an id Core will name to the sidecar.
    Refuse,
    /// The node's default agent: the agent's rule and the app's own level, both.
    NodeLane,
    /// An agent: the route's level on kind `agent` and this id.
    Agent,
}

/// The check for `agent_id` on an agent route. Pure.
///
/// An id that holds a percent sign, or starts or ends with white space, is
/// refused. Core forwards the path it matched, the sidecar decodes it once more,
/// and such an id would be checked under one name and served under another.
pub(in crate::sidecar::ext_proxy) fn agent_check(agent_id: &str) -> AgentCheck {
    if agent_id.is_empty() || agent_id.contains('%') || agent_id.trim() != agent_id {
        return AgentCheck::Refuse;
    }
    if agent_id == crate::registry::DEFAULT_AGENT_ID {
        return AgentCheck::NodeLane;
    }
    AgentCheck::Agent
}

/// The permission gate of both proxy lanes. Every route but an agent route takes
/// the unchanged path: the plugin id is the resource kind.
pub(in crate::sidecar::ext_proxy) async fn enforce_route_permission(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    permission: &str,
    plugin_id: &str,
    resource_id: &str,
    scope: &RouteScope,
) -> Result<(), StatusCode> {
    let RouteScope::Agent { node_lane } = scope else {
        return crate::server::enforce_permission_on(
            state,
            caller,
            permission,
            plugin_id,
            resource_id,
        )
        .await;
    };
    match agent_check(resource_id) {
        AgentCheck::Refuse => Err(StatusCode::NOT_FOUND),
        AgentCheck::NodeLane => {
            let Some(level) = node_lane else {
                return Err(StatusCode::NOT_FOUND);
            };
            enforce_on_default_agent(state, caller, permission, resource_id).await?;
            crate::server::enforce_permission_on(state, caller, level, plugin_id, plugin_id).await
        }
        AgentCheck::Agent => enforce_on_agent(state, caller, permission, resource_id).await,
    }
}

/// The agent's part of the check for the node's default agent: availability,
/// then the per-agent rule. There is no existence check: the default agent is
/// built in, and this lane must not depend on its row in the agent store.
async fn enforce_on_default_agent(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    permission: &str,
    agent_id: &str,
) -> Result<(), StatusCode> {
    if !crate::fleet::is_agent_available(agent_id) {
        return Err(StatusCode::NOT_FOUND);
    }
    crate::server::enforce_permission_on(
        state,
        caller,
        permission,
        crate::acl::KIND_AGENT,
        agent_id,
    )
    .await
}

/// The same order as the kernel's own agent route (`agent_catalog::agent_crud`):
/// availability, then the per-agent rule, then existence. The store lookup is the
/// existence check; `fleet::is_agent_available` answers `true` for any id on a
/// node without agent assignments.
async fn enforce_on_agent(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    permission: &str,
    agent_id: &str,
) -> Result<(), StatusCode> {
    if !crate::fleet::is_agent_available(agent_id) {
        return Err(StatusCode::NOT_FOUND);
    }
    crate::server::enforce_permission_on(
        state,
        caller,
        permission,
        crate::acl::KIND_AGENT,
        agent_id,
    )
    .await?;
    match state.agent_store.get(agent_id).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(error) => {
            tracing::warn!(%error, "ext proxy: agent lookup for an agent route failed");
            Err(StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
