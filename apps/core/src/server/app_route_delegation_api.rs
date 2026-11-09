//! `POST /api/app-delegations`: mint a short-lived delegation to a slice of one
//! app's routes (see [`super::app_route_delegation`]).
//!
//! Reachable with the owner token or a member's own signed-in session only
//! (`credential_route_policy`); a paired device, an OAuth or MCP client, or a
//! delegation cannot mint one. The route is deliberately not in the OpenAPI
//! document, so it is never lowered into an agent tool.

use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::app_route_delegation::{
    node_binding, normalize_methods, pattern_reaches_prefix, prefix_is_valid, sign_with, Claims,
    DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS, MIN_TTL_SECONDS,
};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;

/// Body of `POST /api/app-delegations`.
#[derive(Debug, Deserialize)]
pub struct MintRequest {
    /// The app whose routes the delegation reaches (`@ryu/meetings`).
    pub plugin_id: String,
    /// A literal sub-path prefix under the app's ext mount (`/recaps/<id>`).
    pub path_prefix: String,
    /// The HTTP methods the delegation may use.
    pub methods: Vec<String>,
    /// Lifetime in seconds; defaults to one hour, at most four.
    #[serde(default)]
    pub ttl_seconds: Option<u64>,
}

type Reply = (StatusCode, Json<Value>);

fn refuse(status: StatusCode, error: &str) -> Reply {
    (status, Json(json!({ "error": error })))
}

/// Whether the app declares at least one permission-gated route that a
/// request at or below `prefix` with one of `methods` can reach. A delegation
/// to a slice with no such route could never be admitted, so it is refused at
/// mint time rather than handed out to fail later.
pub(crate) fn prefix_has_gated_route(
    manifest: &crate::plugin_manifest::PluginManifest,
    prefix: &str,
    methods: &[String],
) -> bool {
    manifest
        .sidecars
        .iter()
        .filter_map(|sidecar| sidecar.http.as_ref())
        .flat_map(|http| http.routes.iter())
        .any(|route| {
            route.permission.is_some()
                && pattern_reaches_prefix(&route.path, prefix)
                && route
                    .method
                    .as_deref()
                    .is_none_or(|declared| methods.iter().any(|m| m.eq_ignore_ascii_case(declared)))
        })
}

/// Who a new delegation acts for: on an org-bound or managed node, the
/// verified member who asked (refused without one); on an unbound node, that
/// member when signed in, else the node owner (`None`).
pub(crate) fn delegation_subject(
    bound: bool,
    node_org: Option<String>,
    caller: Option<&VerifiedCaller>,
) -> Result<(Option<String>, Option<String>), &'static str> {
    match (bound, caller) {
        (true, None) => Err("a signed-in member is required on a shared node"),
        (true, Some(caller)) if node_org.is_some() && caller.org_id != node_org => {
            Err("the caller is not a member of this node's organization")
        }
        (true, Some(caller)) => Ok((Some(caller.user_id.clone()), node_org)),
        (false, caller) => Ok((caller.map(|caller| caller.user_id.clone()), None)),
    }
}

/// `POST /api/app-delegations` body `{ plugin_id, path_prefix, methods,
/// ttl_seconds? }` → `{ token, expires_at, plugin_id, path_prefix, methods }`.
pub async fn mint(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(request): Json<MintRequest>,
) -> Reply {
    let Some(methods) = normalize_methods(&request.methods) else {
        return refuse(
            StatusCode::BAD_REQUEST,
            "methods must be known HTTP methods",
        );
    };
    let prefix = request.path_prefix.trim();
    if !prefix_is_valid(prefix) {
        return refuse(
            StatusCode::BAD_REQUEST,
            "path_prefix must be a literal sub-path",
        );
    }
    let ttl = request.ttl_seconds.unwrap_or(DEFAULT_TTL_SECONDS);
    if !(MIN_TTL_SECONDS..=MAX_TTL_SECONDS).contains(&ttl) {
        return refuse(StatusCode::BAD_REQUEST, "ttl_seconds is out of range");
    }
    let plugin_id = request.plugin_id.trim();
    match state.app_store.get(plugin_id).await {
        Ok(Some(record)) if record.enabled => {}
        Ok(_) => return refuse(StatusCode::NOT_FOUND, "app not enabled"),
        Err(error) => {
            tracing::warn!(%error, "app-delegations: app lookup failed");
            return refuse(StatusCode::INTERNAL_SERVER_ERROR, "app lookup failed");
        }
    }
    let gated = state
        .app_manifests
        .read()
        .await
        .iter()
        .find(|manifest| manifest.id == plugin_id)
        .is_some_and(|manifest| prefix_has_gated_route(manifest, prefix, &methods));
    if !gated {
        return refuse(
            StatusCode::BAD_REQUEST,
            "the app declares no permission-gated route under path_prefix",
        );
    }
    let node_org = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let bound = node_org.is_some() || crate::sidecar::control_plane::is_managed_node();
    let (user, org) = match delegation_subject(bound, node_org, caller.as_ref()) {
        Ok(subject) => subject,
        Err(error) => return refuse(StatusCode::FORBIDDEN, error),
    };
    let Some(key) = crate::node_token::active_token() else {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "no node token to sign with",
        );
    };
    let now = crate::pairing::now_secs();
    let claims = Claims {
        plugin: plugin_id.to_owned(),
        prefix: prefix.to_owned(),
        methods: methods.clone(),
        user,
        org,
        node: node_binding(),
        iat: now,
        exp: now + ttl,
        jti: uuid::Uuid::new_v4().simple().to_string(),
    };
    let Some(token) = sign_with(&claims, &key) else {
        return refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not sign the delegation",
        );
    };
    (
        StatusCode::OK,
        Json(json!({
            "token": token,
            "expires_at": claims.exp,
            "plugin_id": claims.plugin,
            "path_prefix": claims.prefix,
            "methods": methods,
        })),
    )
}

#[cfg(test)]
#[path = "app_route_delegation_api_tests.rs"]
mod tests;
