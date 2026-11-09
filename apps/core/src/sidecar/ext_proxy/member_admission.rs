//! Member credentials on an app's protected routes.
//!
//! A protected ext-proxy route has always demanded the node bearer. A route
//! that also declares a manifest permission level can now be reached with a
//! member's own credential instead, because the per-route permission check
//! then has a person to evaluate:
//!
//! - the member's signed-in session: a verified user JWT, or the control
//!   plane's node-list delegation for that member;
//! - a short-lived, path-scoped app route delegation the member minted
//!   (`POST /api/app-delegations`, see [`crate::server::app_route_delegation`]).
//!
//! A route with no permission level stays node-bearer only: admitting a member
//! there would hand them whatever the app serves to the node owner. Scoped
//! credentials (paired devices, OAuth or MCP clients) are never admitted.

use super::*;
use crate::identity_verify::VerifiedCaller;

/// Who passed a protected route's bearer check.
#[derive(Debug)]
pub(super) enum Admission {
    /// The node bearer, or no node token configured: the historic path, whose
    /// caller is still read from the optional user-JWT header.
    NodeToken,
    /// A member credential; `None` is the owner of an unbound node acting
    /// through a delegation they minted.
    Member(Option<VerifiedCaller>),
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

/// Admit a request on a protected route. `route_declares_permission` is
/// whether the matched route names a permission level.
pub(super) async fn admit_protected(
    headers: &HeaderMap,
    plugin_id: &str,
    sub_path: &str,
    method: &str,
    route_declares_permission: bool,
) -> Result<Admission, StatusCode> {
    let Some(expected) = crate::node_token::active_token() else {
        return Ok(Admission::NodeToken);
    };
    let provided = bearer(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    if crate::server::ct_eq(provided, &expected) {
        return Ok(Admission::NodeToken);
    }
    if !route_declares_permission {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if provided.starts_with(crate::server::app_route_delegation::TOKEN_PREFIX) {
        return crate::server::app_route_delegation::verify_request(
            provided, plugin_id, sub_path, method,
        )
        .map(Admission::Member)
        .map_err(|_| StatusCode::UNAUTHORIZED);
    }
    crate::server::member_session_caller(provided, headers)
        .await
        .map(|caller| Admission::Member(Some(caller)))
        .ok_or(StatusCode::UNAUTHORIZED)
}
