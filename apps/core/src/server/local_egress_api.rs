//! HTTP surface for "Route traffic through this computer".
//!
//! - `/api/local-egress/desktop` (owner only) is the desktop's own setting and
//!   per-node link status; see [`crate::local_egress::exit`].
//! - `/api/local-egress/route` and `/route/ws` live on the cloud node. The node
//!   owner (or the node token) may attach a desktop, read status, or detach;
//!   see [`crate::local_egress::entry`].
//! - `/api/local-egress/route/providers` (node owner) turns individual model
//!   providers' routes on or off; see [`crate::local_egress::providers`].

use super::{ResolvedAuthorization, ServerState};
use crate::local_egress::{
    self, entry, exit,
    providers::{self, ProviderRoute},
    AdminPolicy,
};
use axum::{
    extract::{ws::WebSocketUpgrade, Extension, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use utoipa::ToSchema;

/// Largest frame the desktop may send (a 16 KiB data chunk plus header).
const MAX_FRAME_BYTES: usize = 64 * 1024;

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": message, "code": code }))).into_response()
}

/// The node token holder, or the managed user who owns this node.
fn node_owner(auth: &ResolvedAuthorization) -> bool {
    if matches!(
        auth.context.principal,
        crate::authorization::Principal::Owner
    ) {
        return true;
    }
    let owner =
        crate::sidecar::control_plane::registered_node().and_then(|node| node.owner_user_id);
    match (owner, auth.caller.as_ref()) {
        (Some(owner), Some(caller)) => owner == caller.user_id,
        _ => false,
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopRouteConfig {
    /// Route the listed cloud nodes' web traffic through this computer.
    pub enabled: bool,
    /// Name shown on the cloud node while this computer is attached.
    #[serde(default)]
    pub device_name: Option<String>,
    /// The user's cloud nodes: `{ nodeId, url, token }`. Tokens are held in
    /// memory only and must be re-supplied after Core restarts.
    #[serde(default)]
    #[schema(value_type = Vec<Object>)]
    pub nodes: Vec<exit::ExitTarget>,
}

#[utoipa::path(
    get,
    path = "/api/local-egress/desktop",
    tag = "Nodes",
    summary = "Read this computer's traffic-routing setting and per-node link state",
    responses((status = 200, description = "Setting and link state", body = serde_json::Value))
)]
pub(crate) async fn desktop_status(State(state): State<ServerState>) -> Response {
    Json(exit::status(&state.preferences).await).into_response()
}

#[utoipa::path(
    put,
    path = "/api/local-egress/desktop",
    tag = "Nodes",
    summary = "Turn routing cloud-node traffic through this computer on or off",
    request_body = DesktopRouteConfig,
    responses(
        (status = 200, description = "Setting and link state after the change", body = serde_json::Value),
        (status = 400, description = "Invalid node list", body = serde_json::Value)
    )
)]
pub(crate) async fn desktop_configure(
    State(state): State<ServerState>,
    Json(body): Json<DesktopRouteConfig>,
) -> Response {
    if let Err(message) = exit::configure(
        &state.preferences,
        body.enabled,
        body.device_name,
        body.nodes,
    )
    .await
    {
        return error(StatusCode::BAD_REQUEST, "local_egress_invalid", &message);
    }
    Json(exit::status(&state.preferences).await).into_response()
}

#[utoipa::path(
    get,
    path = "/api/local-egress/route",
    tag = "Nodes",
    summary = "Read whether this node routes traffic through a desktop",
    responses(
        (status = 200, description = "Route status", body = serde_json::Value),
        (status = 403, description = "Only the node owner may read the route", body = serde_json::Value)
    )
)]
pub(crate) async fn route_status(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    if !node_owner(&auth) {
        return error(
            StatusCode::FORBIDDEN,
            "local_egress_owner_required",
            "Only the node owner can manage desktop routing.",
        );
    }
    Json(entry::status().await).into_response()
}

#[utoipa::path(
    delete,
    path = "/api/local-egress/route",
    tag = "Nodes",
    summary = "Stop routing through a desktop and return to the cloud network path",
    responses(
        (status = 200, description = "Route status after detaching", body = serde_json::Value),
        (status = 403, description = "Only the node owner may detach", body = serde_json::Value)
    )
)]
pub(crate) async fn route_detach(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    if !node_owner(&auth) {
        return error(
            StatusCode::FORBIDDEN,
            "local_egress_owner_required",
            "Only the node owner can manage desktop routing.",
        );
    }
    entry::detach().await;
    Json(entry::status().await).into_response()
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderRouteConfig {
    /// The provider route (`claude`).
    pub id: String,
    /// Send this provider's traffic through the routing desktop.
    pub enabled: bool,
}

async fn provider_routes_body() -> serde_json::Value {
    json!({
        "route": entry::status().await,
        "providers": providers::status(),
    })
}

#[utoipa::path(
    get,
    path = "/api/local-egress/route/providers",
    tag = "Nodes",
    summary = "Read which model providers this node routes through a desktop",
    responses(
        (status = 200, description = "Route status and provider routes", body = serde_json::Value),
        (status = 403, description = "Only the node owner may read provider routes", body = serde_json::Value),
        (status = 404, description = "This node does not support desktop routing", body = serde_json::Value)
    )
)]
pub(crate) async fn provider_routes(Extension(auth): Extension<ResolvedAuthorization>) -> Response {
    if !node_owner(&auth) {
        return error(
            StatusCode::FORBIDDEN,
            "local_egress_owner_required",
            "Only the node owner can manage desktop routing.",
        );
    }
    if !entry::status().await.supported {
        return error(
            StatusCode::NOT_FOUND,
            "local_egress_unsupported",
            "This node does not support desktop routing.",
        );
    }
    Json(provider_routes_body().await).into_response()
}

#[utoipa::path(
    put,
    path = "/api/local-egress/route/providers",
    tag = "Nodes",
    summary = "Turn routing one model provider's traffic through a desktop on or off",
    request_body = ProviderRouteConfig,
    responses(
        (status = 200, description = "Route status and provider routes after the change", body = serde_json::Value),
        (status = 400, description = "Unknown provider route", body = serde_json::Value),
        (status = 403, description = "Only the node owner may change provider routes", body = serde_json::Value),
        (status = 404, description = "This node does not support desktop routing", body = serde_json::Value)
    )
)]
pub(crate) async fn configure_provider_route(
    Extension(auth): Extension<ResolvedAuthorization>,
    Json(body): Json<ProviderRouteConfig>,
) -> Response {
    if !node_owner(&auth) {
        return error(
            StatusCode::FORBIDDEN,
            "local_egress_owner_required",
            "Only the node owner can manage desktop routing.",
        );
    }
    if !entry::status().await.supported {
        return error(
            StatusCode::NOT_FOUND,
            "local_egress_unsupported",
            "This node does not support desktop routing.",
        );
    }
    let Some(route) = ProviderRoute::from_id(body.id.trim()) else {
        return error(
            StatusCode::BAD_REQUEST,
            "local_egress_unknown_provider",
            "This provider can't be routed through a desktop.",
        );
    };
    if let Err(message) = providers::set_enabled(route, body.enabled).await {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "local_egress_provider_route_failed",
            &message,
        );
    }
    Json(provider_routes_body().await).into_response()
}

#[utoipa::path(
    get,
    path = "/api/local-egress/route/ws",
    tag = "Nodes",
    summary = "Attach a desktop as this node's network exit (WebSocket)",
    responses(
        (status = 101, description = "Switching protocols"),
        (status = 403, description = "Only the node owner may attach", body = serde_json::Value),
        (status = 404, description = "This node does not support desktop routing", body = serde_json::Value),
        (status = 423, description = "The organization has turned desktop routing off", body = serde_json::Value),
        (status = 503, description = "Organization policy could not be resolved", body = serde_json::Value)
    )
)]
pub(crate) async fn route_ws(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Extension(auth): Extension<ResolvedAuthorization>,
) -> Response {
    if !node_owner(&auth) {
        return error(
            StatusCode::FORBIDDEN,
            "local_egress_owner_required",
            "Only the node owner can route this node through a desktop.",
        );
    }
    if !entry::status().await.supported {
        return error(
            StatusCode::NOT_FOUND,
            "local_egress_unsupported",
            "This node does not support desktop routing.",
        );
    }
    match local_egress::admin_policy().await {
        AdminPolicy::Allowed => {}
        AdminPolicy::Disabled => {
            return error(
                StatusCode::from_u16(local_egress::LOCKED_STATUS).unwrap_or(StatusCode::FORBIDDEN),
                "org_feature_disabled",
                "Your team admin has turned off local traffic routing.",
            )
        }
        AdminPolicy::Unknown => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "org_policy_unavailable",
                "Organization policy is unavailable; try again shortly.",
            )
        }
    }
    let desktop = headers
        .get(local_egress::DESKTOP_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(64)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Desktop".to_owned());
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| entry::run_session(socket, desktop))
}

#[cfg(test)]
mod tests {
    use super::{node_owner, ResolvedAuthorization};
    use crate::authorization::{
        AuthorizationContext, CapabilitySet, CredentialKind, GrantConstraints, Principal,
        RequestBindings,
    };
    use crate::identity_verify::{OrgRole, VerifiedCaller};
    use crate::sidecar::control_plane::{
        with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
    };

    fn node(owner_user_id: Option<&str>) -> RegisteredNode {
        RegisteredNode {
            org: RegisteredOrg {
                id: "org-1".into(),
                name: "Org".into(),
                slug: None,
            },
            node_id: "node-1".into(),
            scope: NodeScope::Personal,
            team_id: None,
            owner_user_id: owner_user_id.map(Into::into),
        }
    }

    fn managed(user_id: Option<&str>) -> ResolvedAuthorization {
        ResolvedAuthorization {
            context: AuthorizationContext {
                credential: CredentialKind::ManagedUserJwt,
                principal: Principal::User {
                    subject_id: user_id.unwrap_or("anonymous").into(),
                },
                capabilities: CapabilitySet::default(),
                constraints: GrantConstraints::default(),
                issued_at: 0,
                expires_at: None,
            },
            bindings: RequestBindings::default(),
            caller: user_id.map(|user_id| VerifiedCaller {
                user_id: user_id.into(),
                email: None,
                email_verified: false,
                org_id: Some("org-1".into()),
                role: OrgRole::Member,
                teams: vec![],
            }),
            verified_user_jwt: None,
        }
    }

    fn owner_token() -> ResolvedAuthorization {
        ResolvedAuthorization {
            context: AuthorizationContext::owner(0),
            bindings: RequestBindings::default(),
            caller: None,
            verified_user_jwt: None,
        }
    }

    #[tokio::test]
    async fn owner_token_is_admitted_with_or_without_a_binding() {
        with_test_node_binding(true, Some(node(Some("u1"))), async {
            assert!(node_owner(&owner_token()));
        })
        .await;
        with_test_node_binding(false, None, async {
            assert!(node_owner(&owner_token()));
        })
        .await;
    }

    #[tokio::test]
    async fn only_the_owning_user_is_admitted() {
        with_test_node_binding(true, Some(node(Some("u1"))), async {
            assert!(node_owner(&managed(Some("u1"))));
            assert!(!node_owner(&managed(Some("u2"))));
        })
        .await;
    }

    #[tokio::test]
    async fn a_node_without_an_owner_admits_no_caller() {
        with_test_node_binding(true, Some(node(None)), async {
            assert!(!node_owner(&managed(Some("u1"))));
        })
        .await;
    }

    #[tokio::test]
    async fn a_request_without_a_verified_caller_is_rejected() {
        with_test_node_binding(true, Some(node(Some("u1"))), async {
            assert!(!node_owner(&managed(None)));
        })
        .await;
    }
}
