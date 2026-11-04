//! Server state, the remote-auth gate, route policy and the `require_auth` middleware: `managed_user_jwt_resolution_for` through `VOICE_TICKET_CHAT_PATH`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Build the authorization context for a valid Better Auth user JWT on an
/// org-bound node. This is pure after JWT verification, which keeps the
/// high-risk role-to-capability mapping testable without a JWKS server.
pub(in crate::server) fn managed_user_jwt_resolution_for(
    caller: crate::identity_verify::VerifiedCaller,
    node: &crate::sidecar::control_plane::RegisteredNode,
    path_agent_id: Option<&str>,
    now: u64,
) -> Option<ResolvedAuthorization> {
    if caller.org_id.as_deref() != Some(node.org.id.as_str()) {
        return None;
    }

    // The organization claim is only the first boundary. Managed credentials
    // can be scoped to one team or one user's personal node; a JWT for another
    // member of the same organization must not cross either boundary. The
    // registration response is validated into this disjoint shape, but keep the
    // checks fail-closed if a malformed/legacy response ever reaches this seam.
    let in_scope = match node.scope {
        crate::sidecar::control_plane::NodeScope::Org => {
            node.team_id.is_none() && node.owner_user_id.is_none()
        }
        crate::sidecar::control_plane::NodeScope::Team => {
            node.owner_user_id.is_none()
                && node.team_id.as_deref().is_some_and(|team_id| {
                    caller
                        .teams
                        .iter()
                        .any(|team| team.id == team_id && team.org_id == node.org.id)
                })
        }
        crate::sidecar::control_plane::NodeScope::Personal => {
            node.team_id.is_none() && node.owner_user_id.as_deref() == Some(caller.user_id.as_str())
        }
    };
    if !in_scope {
        return None;
    }

    let agent_id = path_agent_id.map(str::to_owned);
    let bindings = crate::authorization::RequestBindings {
        subject_id: Some(caller.user_id.clone()),
        agent_id: agent_id.clone(),
        node_id: Some(node.node_id.clone()),
        org_id: Some(node.org.id.clone()),
        ..Default::default()
    };
    let constraints = crate::authorization::GrantConstraints {
        subject_id: Some(caller.user_id.clone()),
        agent_id,
        node_id: Some(node.node_id.clone()),
        org_id: Some(node.org.id.clone()),
        ..Default::default()
    };

    Some(ResolvedAuthorization {
        context: crate::authorization::AuthorizationContext {
            credential: crate::authorization::CredentialKind::ManagedUserJwt,
            principal: crate::authorization::Principal::User {
                subject_id: caller.user_id.clone(),
            },
            capabilities: capabilities_for_managed_user(caller.role),
            constraints,
            issued_at: now,
            expires_at: None,
        },
        bindings,
        caller: Some(caller),
        verified_user_jwt: None,
    })
}

/// Verify a Better Auth bearer used as the primary credential by a managed or
/// organization-bound node. A valid optional identity header must name the same
/// user, role, and team set so downstream handlers cannot see a different caller
/// than the admission middleware authorized.
pub(in crate::server) async fn resolve_managed_user_jwt(
    token: &str,
    headers: &axum::http::HeaderMap,
    path_agent_id: Option<&str>,
    now: u64,
) -> Option<ResolvedAuthorization> {
    if token.split('.').count() != 3 {
        return None;
    }
    let node = crate::sidecar::control_plane::registered_node()?;
    let caller = verified_caller_from_token(token).await?;
    let resolved = managed_user_jwt_resolution_for(caller.clone(), &node, path_agent_id, now)?;

    if let Some(header_token) = header_str(headers, USER_JWT_HEADER) {
        let header_caller = verified_caller_from_token(&header_token).await?;
        if !same_verified_caller(&caller, &header_caller) {
            return None;
        }
    }

    Some(ResolvedAuthorization {
        verified_user_jwt: Some(token.to_owned()),
        ..resolved
    })
}

pub(in crate::server) fn same_verified_caller(
    left: &crate::identity_verify::VerifiedCaller,
    right: &crate::identity_verify::VerifiedCaller,
) -> bool {
    left.user_id == right.user_id
        && left.org_id == right.org_id
        && left.role == right.role
        && left.teams.len() == right.teams.len()
        && left.teams.iter().all(|team| {
            right.teams.iter().any(|candidate| {
                candidate.id == team.id
                    && candidate.org_id == team.org_id
                    && candidate.role == team.role
            })
        })
}

pub(in crate::server) fn mcp_path_agent_id(path: &str) -> Option<String> {
    let encoded = path.strip_prefix("/mcp/")?;
    if encoded.is_empty() || encoded.contains('/') {
        return None;
    }
    urlencoding::decode(encoded)
        .ok()
        .map(std::borrow::Cow::into_owned)
}

pub(in crate::server) fn request_bindings(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    agent_id: Option<&str>,
) -> crate::authorization::RequestBindings {
    crate::authorization::RequestBindings {
        subject_id: caller.map(|caller| caller.user_id.clone()),
        agent_id: agent_id.map(str::to_owned),
        ..Default::default()
    }
}

pub(in crate::server) fn bind_delegation_to_route(
    mut signed: crate::authorization::RequestBindings,
    path_agent_id: Option<&str>,
) -> Option<crate::authorization::RequestBindings> {
    if let Some(path_agent_id) = path_agent_id {
        if signed.agent_id.as_deref() != Some(path_agent_id) {
            return None;
        }
        signed.agent_id = Some(path_agent_id.to_owned());
    }
    Some(signed)
}

/// The caller for an agent's self-API loopback acting for `user_id`. Core already
/// checked that person's organization and permission before dispatch, so the
/// role here is the lowest tier: a handler that checks a permission falls
/// through to the control plane's effective set for that person, and nothing
/// that reads `role` directly is granted more than a viewer would get.
pub(in crate::server) fn self_call_caller(
    user_id: String,
) -> crate::identity_verify::VerifiedCaller {
    crate::identity_verify::VerifiedCaller {
        user_id,
        email: None,
        email_verified: false,
        org_id: crate::sidecar::control_plane::registered_org().map(|org| org.id),
        role: crate::identity_verify::OrgRole::Viewer,
        teams: Vec::new(),
    }
}

pub(in crate::server) async fn verified_header_identity(
    headers: &axum::http::HeaderMap,
) -> (
    Option<crate::identity_verify::VerifiedCaller>,
    Option<String>,
) {
    let Some(token) = header_str(headers, USER_JWT_HEADER) else {
        return (None, None);
    };
    let caller = verified_caller_from_token(&token).await;
    let token = caller.as_ref().map(|_| token);
    (caller, token)
}

pub(in crate::server) fn denial_status(
    decision: crate::authorization::AuthorizationDecision,
) -> Option<StatusCode> {
    use crate::authorization::{AuthorizationDecision, DenialReason};
    match decision {
        AuthorizationDecision::Allow => None,
        AuthorizationDecision::Deny(
            DenialReason::AuthenticationRequired | DenialReason::Expired,
        ) => Some(StatusCode::UNAUTHORIZED),
        AuthorizationDecision::Deny(_) => Some(StatusCode::FORBIDDEN),
    }
}

pub(in crate::server) async fn require_auth(
    req: Request<axum::body::Body>,
    next: middleware::Next,
) -> Result<axum::response::Response, StatusCode> {
    let expected = crate::node_token::active_token().filter(|token| !token.is_empty());
    require_auth_with_token(req, next, expected).await
}

pub(in crate::server) async fn require_auth_with_token(
    mut req: Request<axum::body::Body>,
    next: middleware::Next,
    expected: Option<String>,
) -> Result<axum::response::Response, StatusCode> {
    let provided = if req
        .uri()
        .path()
        .starts_with("/api/pi-config/chatgpt/codex/")
        || req.uri().path().starts_with("/api/pi-config/chatgpt-plan/")
        || req.uri().path() == "/api/pi-config/claude/v1/messages"
        || matches!(
            req.uri().path(),
            "/api/pi-config/kiro/v1/chat/completions"
                | "/api/pi-config/kiro/v1/models"
                | "/api/pi-config/qoder/v1/chat/completions"
                | "/api/pi-config/qoder/v1/models"
                | "/api/pi-config/qoder-cn/v1/chat/completions"
                | "/api/pi-config/qoder-cn/v1/models"
        ) {
        req.headers()
            .get("x-ryu-node-token")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .or_else(|| {
                req.headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Bearer "))
                    .map(str::to_string)
            })
    } else {
        req.headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_string)
    };
    let now = crate::pairing::now_secs();
    let path_agent_id = mcp_path_agent_id(req.uri().path());
    let resolved = if let Some(expected) = expected {
        let token = provided.as_deref().ok_or(StatusCode::UNAUTHORIZED)?;
        if ct_eq(token, &expected) {
            let (caller, verified_user_jwt) =
                match crate::self_api::self_call_identity(req.headers()) {
                    crate::self_api::SelfCallIdentity::Absent => {
                        verified_header_identity(req.headers()).await
                    }
                    crate::self_api::SelfCallIdentity::Acting(user_id) => {
                        (Some(self_call_caller(user_id)), None)
                    }
                    crate::self_api::SelfCallIdentity::Invalid => {
                        return Err(StatusCode::UNAUTHORIZED)
                    }
                };
            ResolvedAuthorization {
                bindings: request_bindings(caller.as_ref(), path_agent_id.as_deref()),
                context: crate::authorization::AuthorizationContext::owner(now),
                caller,
                verified_user_jwt,
            }
        } else if let Some(resolved) =
            resolve_managed_user_jwt(token, req.headers(), path_agent_id.as_deref(), now).await
        {
            resolved
        } else {
            let (caller, verified_user_jwt) = verified_header_identity(req.headers()).await;
            let bindings = request_bindings(caller.as_ref(), path_agent_id.as_deref());
            if let Some(context) = crate::pairing::resolve_paired_token(token, &bindings) {
                ResolvedAuthorization {
                    context,
                    bindings,
                    caller,
                    verified_user_jwt,
                }
            } else {
                let Ok(verified) = crate::authorization::delegation::verify(token, now) else {
                    // A verified user JWT that lacks this node's org claim is
                    // signed in, just not admitted here: say so instead of
                    // asking for a sign-in it already has.
                    if bearer_user_jwt_lacks_node_org(token).await {
                        return Ok(org_access_not_in_session_response());
                    }
                    return Err(StatusCode::UNAUTHORIZED);
                };
                let bindings =
                    bind_delegation_to_route(verified.bindings, path_agent_id.as_deref())
                        .ok_or(StatusCode::FORBIDDEN)?;
                ResolvedAuthorization {
                    context: verified.context,
                    bindings,
                    caller: Some(verified.caller),
                    verified_user_jwt: None,
                }
            }
        }
    } else {
        // Protected routes must never become owner-authorized merely because
        // secure token persistence failed during startup.
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let policy = credential_route_policy(
        req.method(),
        req.uri().path(),
        &resolved.context,
        resolved.caller.is_some(),
    );
    if let Some(status) =
        denial_status(resolved.context.authorize(&policy, &resolved.bindings, now))
    {
        return Err(status);
    }
    // Organization feature toggles (`apps.install`, `plugins.marketplace`,
    // `engines.update`) gate the matching install/update mutations for the
    // verified caller. A no-op on unbound nodes; on an org-bound node with no
    // resolvable feature policy the gated routes fail closed.
    if let Some(reason) = crate::org_policy::route_denial(
        req.method().as_str(),
        req.uri().path(),
        req.uri().query(),
        resolved
            .caller
            .as_ref()
            .map(|caller| caller.user_id.as_str()),
    )
    .await
    {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": reason, "code": "org_feature_disabled" })),
        )
            .into_response());
    }
    let owner_token = presents_owner_token(&resolved.context);
    let user_jwt_bearer = bearer_is_user_jwt(&resolved.context);
    req.extensions_mut().insert(resolved);
    let peer_is_local = request_peer_is_local(&req);
    Ok(REQUEST_PEER_IS_LOCAL
        .scope(
            peer_is_local,
            REQUEST_PRESENTS_OWNER_TOKEN.scope(
                owner_token,
                REQUEST_BEARER_IS_USER_JWT.scope(user_jwt_bearer, next.run(req)),
            ),
        )
        .await)
}

/// The REST route whose admission a member voice-mode ticket mirrors. A voice
/// session runs ordinary chat turns, so it must never be reachable with less
/// than `POST /api/chat/stream` requires.
pub(in crate::server) const VOICE_TICKET_CHAT_PATH: &str = "/api/chat/stream";
