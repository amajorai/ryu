//! Server state, the remote-auth gate, route policy and the `require_auth` middleware: `enforce_remote_auth` through `reaches_operator_role_gate`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Fail-closed auth policy under mesh / remote bind (#478, security HIGH).
///
/// When the node is reachable beyond loopback — the mesh is on **or** the bind is
/// non-loopback — running without an auth token leaves every protected route open
/// to the tailnet/LAN. A log warning is not a control, so this **refuses** (Err)
/// rather than silently allowing. Returns the (possibly unchanged) token to use.
///
/// Since Core now MINTS a token on first boot ([`crate::node_token`]), the
/// "exposed with no token at all" case is rare — but it is still reachable (an
/// unwritable home directory yields `None`), and it is the one case that would put
/// an unauthenticated Core on a public IP. It stays a hard refusal.
///
/// Any **strong, non-placeholder** token satisfies the gate — including one this
/// machine minted for itself. A 256-bit random token secures the node's protected
/// routes perfectly well; provenance is irrelevant to that guarantee. The mesh's
/// SHARED-fleet assumption (every node runs the same `RYU_TOKEN` so peers admit
/// each other) is NOT enforced here: a node running a self-minted token still
/// exposes a secure node, and the peer-bearer seam (`ryu_mesh::resolve_mesh_bearer`
/// fed by `node_token::shared_fleet_token`) already reports that state HONESTLY —
/// `GET /api/mesh/peers` answers `bearer_source:"none"` with a note naming the
/// shared token to provision, instead of offering a bearer peers would reject. The
/// old "refuse to start on a self-minted token" branch was dropped because that
/// silent-failure rationale is obsolete (peer-add is no longer silent) and it made
/// the desktop's pref-driven mesh enable unusable on a default install, where the
/// token is always minted.
///
/// Pure + unit-testable: callers pass the resolved token, its provenance, whether
/// a tunnel is active, and the non-loopback-bind flag.
pub(crate) fn enforce_remote_auth(
    auth_token: Option<String>,
    _token_source: Option<crate::node_token::TokenSource>,
    remote_tunnel_enabled: bool,
    bind_non_loopback: bool,
) -> Result<Option<String>, String> {
    let exposed = remote_tunnel_enabled || bind_non_loopback;
    if exposed {
        let token = auth_token.as_deref().map(str::trim).unwrap_or("");
        if token.is_empty() {
            return Err(
                "refusing to start: a network tunnel or non-loopback RYU_BIND exposes this Core \
                 beyond loopback, but no RYU_TOKEN is set and none could be minted (check that the \
                 Ryu data directory is writable). Set RYU_TOKEN to a strong secret so protected \
                 routes are authenticated."
                    .to_owned(),
            );
        }
        // The node-admittance placeholder check is anchored in `ryu-mesh` (the
        // fail-closed shared-mesh-token model consults the same predicate), so both
        // the peer-bearer resolver and this startup gate agree on one signal.
        if ryu_mesh::is_insecure_auth_token_placeholder(token) {
            return Err(
                "refusing to start: RYU_TOKEN is still a known placeholder. Generate a strong \
                 random token before exposing Core beyond loopback."
                    .to_owned(),
            );
        }
        if ryu_mesh::is_weak_auth_token(token) {
            return Err(
                "refusing to start: RYU_TOKEN is too short or contains non-printable bytes. \
                 Use at least 32 printable random bytes before exposing Core beyond loopback."
                    .to_owned(),
            );
        }
    }
    Ok(auth_token)
}

/// Constant-time string equality — no early return on the first differing byte, so
/// comparing an attacker-supplied bearer against the shared `RYU_TOKEN` leaks no
/// timing signal about how many leading bytes matched. Length mismatch short-circuits
/// (token length is not secret). Used because Core supports non-loopback binds
/// (`RYU_BIND`/mesh), where a naive `==` is a remotely-observable side channel.
pub(crate) fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// A loopback socket is local only when Core is not behind its own Tailcat
/// forwarding listener. Tailcat re-originates remote streams as loopback TCP
/// connections, so its active state must override the otherwise useful
/// loopback shortcut.
pub(in crate::server) fn is_trusted_local_peer(
    peer: std::net::IpAddr,
    forwarding_proxy_active: bool,
) -> bool {
    peer.is_loopback() && !forwarding_proxy_active
}

/// Whether an ANONYMOUS caller of the current request may act as the single
/// local principal of an unbound node.
///
/// This is the HTTP twin of the realtime gateway's loopback discriminator
/// (`realtime_ws::decide_access`): an unbound node has exactly one owner, and the
/// only anonymous request that can be that owner is one from this machine. A
/// remote holder of the node token or a paired token who drops (or never had) a
/// user JWT must not read rows that a signed-in user created. In-process callers
/// that are not serving an HTTP request keep full trust.
pub(crate) fn anonymous_request_is_local() -> bool {
    REQUEST_PEER_IS_LOCAL
        .try_with(|local| *local)
        .unwrap_or(true)
}

/// Whether the HTTP request currently being served came from a trusted local
/// peer, for checks that use locality as proof. Unlike
/// [`anonymous_request_is_local`], work outside an HTTP request counts as
/// remote, so such a check fails closed.
pub(crate) fn request_is_from_trusted_local_peer() -> bool {
    REQUEST_PEER_IS_LOCAL
        .try_with(|local| *local)
        .unwrap_or(false)
}

/// Whether a request was admitted with this node's owner token
/// (`node-auth.token`, which lives in this machine's data directory). The CLI
/// and Desktop on the node's own machine present it; a browser page cannot:
/// a script on a CORS-allowed origin can mint a user JWT from the session
/// cookie and send that as its bearer, but never the owner token.
pub(in crate::server) fn presents_owner_token(
    context: &crate::authorization::AuthorizationContext,
) -> bool {
    matches!(
        context.credential,
        crate::authorization::CredentialKind::OwnerRecoveryToken
    )
}

/// Whether the HTTP request currently being served comes from a trusted local
/// peer AND was admitted with this node's owner token, for checks that use
/// "the node's own operator, at this machine" as proof. Work outside an HTTP
/// request fails closed.
pub(crate) fn request_is_from_local_owner() -> bool {
    request_is_from_trusted_local_peer() && request_presents_owner_token()
}

/// Whether the HTTP request currently being served was admitted with this
/// node's owner token ([`presents_owner_token`]), wherever it came from. Work
/// outside an HTTP request answers false.
pub(crate) fn request_presents_owner_token() -> bool {
    REQUEST_PRESENTS_OWNER_TOKEN
        .try_with(|owner| *owner)
        .unwrap_or(false)
}

/// Whether the request was admitted by a bearer that is a verified user JWT
/// (`resolve_managed_user_jwt`). Every other admitting bearer (the owner
/// token, a paired token, a node delegation, a hosted OAuth token, a workload
/// or plugin grant) is a node-local secret that must never travel upstream.
pub(in crate::server) fn bearer_is_user_jwt(
    context: &crate::authorization::AuthorizationContext,
) -> bool {
    matches!(
        context.credential,
        crate::authorization::CredentialKind::ManagedUserJwt
    )
}

/// Whether the bearer on the HTTP request currently being served is the
/// verified user JWT that admitted it, so it may be forwarded to the control
/// plane as the caller's identity. Work outside an HTTP request answers false.
pub(crate) fn request_bearer_is_user_jwt() -> bool {
    REQUEST_BEARER_IS_USER_JWT
        .try_with(|user_jwt| *user_jwt)
        .unwrap_or(false)
}

/// Resolve the peer locality of `req`. A request without connect info never
/// reaches the production listener (`main.rs` always installs it), so the
/// in-process router used by tests keeps the historic local behavior.
pub(in crate::server) fn request_peer_is_local(req: &Request<axum::body::Body>) -> bool {
    req.extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .is_none_or(|info| {
            is_trusted_local_peer(info.0.ip(), crate::sidecar::forwarding_tunnel_active())
        })
}

#[derive(Clone)]
pub(crate) struct ResolvedAuthorization {
    pub(in crate::server) context: crate::authorization::AuthorizationContext,
    pub(in crate::server) bindings: crate::authorization::RequestBindings,
    pub(in crate::server) caller: Option<crate::identity_verify::VerifiedCaller>,
    pub(in crate::server) verified_user_jwt: Option<String>,
}
impl std::fmt::Debug for ResolvedAuthorization {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedAuthorization")
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub(crate) struct VerifiedUserJwt(pub(in crate::server) Option<String>);

pub(in crate::server) fn path_has_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

pub(in crate::server) fn credential_route_policy(
    method: &Method,
    path: &str,
    context: &crate::authorization::AuthorizationContext,
    has_verified_caller: bool,
) -> crate::authorization::RoutePolicy {
    use crate::authorization::{Capability, CredentialKind, RoutePolicy};
    // Managed identities still reach the exact agent ACL, which can grant edit
    // through custom roles or resource overwrites absent from their base role.
    // Paired credentials must carry management authority independently of that
    // ACL's anonymous admission on unbound personal nodes.
    if matches!(*method, Method::GET | Method::HEAD)
        && has_verified_caller
        && matches!(
            context.credential,
            CredentialKind::ManagedUserJwt | CredentialKind::ManagedDelegation
        )
        && path
            .strip_prefix("/api/agents/")
            .and_then(|suffix| suffix.split_once('/'))
            .is_some_and(|(_, operation)| operation == "acp-settings")
    {
        return RoutePolicy::requires([Capability::AgentsRead]);
    }
    // Live traffic and budget counters name every member's requests, models,
    // and spend. Their handlers gate on the caller's organization role
    // (`audit.view` / `gateway.configure`), but a scoped credential carries its
    // signer's role with a narrower client scope: an OAuth or MCP client that an
    // admin authorized for `gateway:route` alone, or a device paired for
    // routing, must not inherit that role's view of everyone's traffic. Only
    // the owner token and a member's own signed-in session reach the role gate.
    if is_gateway_operator_read_path(path) && !reaches_operator_role_gate(context) {
        return RoutePolicy::OwnerOnly;
    }
    if is_member_voice_path(path) && !is_owner_or_member_session(context) {
        return RoutePolicy::OwnerOnly;
    }
    if crate::server::node_lifecycle_routes::is_role_gated_lifecycle_mutation(method, path)
        && !is_owner_or_member_session(context)
    {
        return RoutePolicy::OwnerOnly;
    }
    route_policy(method, path)
}

/// The voice HTTP routes [`route_policy`] opens to managed members.
pub(in crate::server) fn is_member_voice_path(path: &str) -> bool {
    matches!(
        path,
        "/api/voice/transcribe"
            | "/api/voice/speak"
            | "/api/voice/tts-engines"
            | "/api/voice/tts-models"
    )
}

/// Gateway reads whose handlers apply an organization-role gate that a scoped
/// credential must not satisfy with its signer's role (see
/// [`credential_route_policy`]).
pub(in crate::server) fn is_gateway_operator_read_path(path: &str) -> bool {
    path_has_prefix(path, "/api/gateway/traffic") || path_has_prefix(path, "/api/gateway/budget")
}

/// Whether a credential speaks for a member's own signed-in session, so its
/// organization role may answer an operator read: the owner token, a managed
/// user JWT, or the node-list delegation the control plane mints for that
/// session (how Desktop and the CLI reach managed nodes). Hosted OAuth and MCP
/// client delegations, paired devices, and every other kind fail closed.
pub(in crate::server) fn reaches_operator_role_gate(
    context: &crate::authorization::AuthorizationContext,
) -> bool {
    use crate::authorization::CredentialKind;
    match &context.credential {
        CredentialKind::OwnerRecoveryToken | CredentialKind::ManagedUserJwt => true,
        CredentialKind::ManagedDelegation => {
            context.constraints.client_id.as_deref()
                == Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID)
        }
        _ => false,
    }
}
