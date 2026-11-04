//! The App route gate.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── The App route gate ────────────────────────────────────────────────────────

/// Layer state for [`require_app_enabled`]: the app-lifecycle store plus the App
/// that owns the routes being gated.
///
/// Deliberately holds ONLY the [`PluginStore`], not the whole [`ServerState`] —
/// the gate needs nothing else, and a narrow state makes it testable against an
/// in-memory store without standing up a Core. This mirrors the
/// `from_fn_with_state(connections, track_connection)` precedent: the layer owns
/// its own state, independent of the router's.
#[derive(Clone)]
pub(crate) struct AppGate {
    pub(in crate::server) store: PluginStore,
    /// The manifest id of the owning App (e.g. `@ryu/meetings`).
    pub(in crate::server) app_id: &'static str,
    /// Display name for the refusal message ("Enable the **Meetings** app").
    pub(in crate::server) label: &'static str,
}

impl AppGate {
    pub(crate) fn new(store: &PluginStore, app_id: &'static str, label: &'static str) -> Self {
        Self {
            store: store.clone(),
            app_id,
            label,
        }
    }
}

/// The refusal body. Machine-readable (`error` + `app`) so the desktop can offer a
/// one-click "Enable" without string-parsing, plus a human `message` for surfaces
/// that just render it.
pub(in crate::server) fn app_disabled_response(gate: &AppGate) -> axum::response::Response {
    let body = json!({
        "error": "app_disabled",
        "app": gate.app_id,
        "message": format!("Enable the {} app", gate.label),
    })
    .to_string();
    axum::response::Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response())
}

/// The ONE route gate: refuse a feature's routes while the App that owns them is
/// disabled.
///
/// This is the extension point that makes a feature *pluginizable without moving
/// it*. The implementation stays in-crate (`meetings_api.rs` keeps calling
/// `state.spaces` directly); what changes is that the App record now **governs**
/// it — install / enable / disable / dependency-resolve — and this gate is where
/// "disabled" acquires teeth. Any future feature becomes an App by declaring a
/// manifest and wrapping its existing routes in one `route_layer`:
///
/// ```ignore
/// .merge(
///     Router::new()
///         .route("/api/thing", get(list_things))
///         .route_layer(middleware::from_fn_with_state(
///             AppGate::new(&state.app_store, THING_PLUGIN_ID, "Thing"),
///             require_app_enabled,
///         )),
/// )
/// ```
///
/// Generic over the app id, so there is exactly one of these — never a per-feature
/// copy. It is a `route_layer`, so it runs only on *matched* routes: an unknown
/// path still 404s normally rather than reporting "app disabled".
///
/// # Why 503, when [`plugin_ui_bundle`] returns 404
///
/// The two gates answer different questions, so they diverge on purpose.
///
/// `plugin_ui_bundle` is a **secrecy** gate: a disabled plugin's *code* must not be
/// served, and 404 is right because it must not even confirm the bundle exists.
///
/// This is an **availability** gate on a first-party, OpenAPI-documented route. The
/// resource plainly exists; it is temporarily unavailable because its App is off.
/// 404 would be actively harmful here: a client could not distinguish "this Core is
/// too old to have Meetings" (a genuine 404) from "Meetings is installed but
/// disabled" (actionable — show an Enable button). 503 states exactly that: the
/// route is real, the capability is off, and the fix is a config change the caller
/// can make. It is also honestly retryable — enable the App and the same request
/// succeeds.
pub(in crate::server) async fn require_app_enabled(
    State(gate): State<AppGate>,
    req: Request<axum::body::Body>,
    next: middleware::Next,
) -> axum::response::Response {
    let enabled = match gate.store.get(gate.app_id).await {
        Ok(Some(rec)) => rec.enabled,
        // No record at all — the App is not installed, so its routes are not live.
        // Fail closed, exactly as a disabled record does.
        Ok(None) => false,
        Err(e) => {
            tracing::warn!("app gate: lookup of '{}' failed: {e:#}", gate.app_id);
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };
    if !enabled {
        return app_disabled_response(&gate);
    }
    next.run(req).await
}

/// Header carrying the Better Auth **user** JWT (Phase 0 of the multi-user
/// epic). This is distinct from `authorization` (the shared `RYU_TOKEN`
/// node-admittance bearer enforced by [`require_auth`]): a remote client presents
/// BOTH — the bearer admits the node, this JWT carries the verified human
/// identity. Lower-case per the HTTP header-name convention.
pub(in crate::server) const USER_JWT_HEADER: &str = "x-ryu-user-jwt";

/// Resolve the verified caller from the optional user JWT on the request.
///
/// Returns `None` (anonymous) when the header is absent OR the token fails
/// verification — failure is NEVER an error to the request, because node or
/// managed admission is a separate gate and a missing/invalid user identity
/// must simply be absent, never
/// spoofable-as-privileged. Managed direct requests carry the JWT in
/// `x-ryu-user-jwt`; the Authorization fallback supports the same verified JWT
/// on the read-only managed sandbox fan-out. The JWT is verified entirely offline
/// (`crate::identity_verify`) and narrowed to THIS node's bound org.
pub(crate) async fn verified_caller_from_headers(
    headers: &axum::http::HeaderMap,
) -> Option<crate::identity_verify::VerifiedCaller> {
    let token = header_str(headers, USER_JWT_HEADER).or_else(|| {
        header_str(headers, "authorization")
            .and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned))
    })?;
    verified_caller_from_token(&token).await
}

/// Resolve the verified caller and the validated JWT expiry for a connection
/// that may remain open after this HTTP request completes. Callers must retain
/// the expiry and enforce it for the lifetime of the connection.
pub(crate) async fn verified_caller_with_expiry_from_headers(
    headers: &axum::http::HeaderMap,
) -> Option<(crate::identity_verify::VerifiedCaller, i64)> {
    let token = header_str(headers, USER_JWT_HEADER).or_else(|| {
        header_str(headers, "authorization")
            .and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned))
    })?;
    verified_caller_with_expiry_from_token(&token).await
}

/// Verify a raw user-JWT string and narrow it to THIS node's org, returning the
/// anonymous case (`None`) on any failure — never an error. Factored out of
/// [`verified_caller_from_headers`] so non-REST transports can reuse the exact
/// same Phase 0 verification and org-narrowing path after an HTTP ticket
/// exchange.
pub(crate) async fn verified_caller_from_token(
    token: &str,
) -> Option<crate::identity_verify::VerifiedCaller> {
    verified_caller_with_expiry_from_token(token)
        .await
        .map(|(caller, _)| caller)
}

pub(crate) async fn verified_caller_with_expiry_from_token(
    token: &str,
) -> Option<(crate::identity_verify::VerifiedCaller, i64)> {
    match crate::identity_verify::verify_jwt_with_expiry(token).await {
        Ok((claims, expires_at)) => {
            // This node's org binding (managed-node registration result). When the
            // node is unbound (local/dev), fall back to the user's sole membership
            // if they have exactly one — a single-org user has no ambiguity. With
            // zero or many memberships and no node binding, the caller has no org
            // context (org_id = None), which fails closed for org-scoped checks.
            // TODO: resolve node org binding for unmanaged nodes more precisely
            // once a node↔org config exists for self-hosted multi-user.
            let node_org = crate::sidecar::control_plane::registered_org()
                .map(|o| o.id)
                .or_else(|| match claims.orgs.as_slice() {
                    [single] => Some(single.id.clone()),
                    _ => None,
                });
            Some((
                crate::identity_verify::to_caller_for_org(&claims, node_org.as_deref()),
                expires_at,
            ))
        }
        Err(e) => {
            tracing::debug!("user JWT verification failed (treated as anonymous): {e}");
            None
        }
    }
}

/// Middleware that attaches the OPTIONAL verified user identity to the request.
///
/// Layered INSIDE [`require_auth`] (so only node-admitted requests do JWT work)
/// and ALWAYS inserts an `Option<VerifiedCaller>` extension — `Some` when a valid
/// user JWT is present, `None` otherwise. It never rejects: a missing/invalid JWT
/// yields the anonymous (single-tenant/loopback) flow unchanged. Requests without
/// the `x-ryu-user-jwt` header short-circuit before any verification, so this is
/// zero-overhead on the common single-tenant path.
pub(in crate::server) async fn attach_verified_caller(
    mut req: Request<axum::body::Body>,
    next: middleware::Next,
) -> axum::response::Response {
    let resolved = req.extensions().get::<ResolvedAuthorization>().cloned();
    let (caller, user_jwt) = match resolved {
        Some(resolved) => (resolved.caller, resolved.verified_user_jwt),
        None => verified_header_identity(req.headers()).await,
    };
    // A signed-in caller whose JWT carries no claim for this node's org is
    // refused by every org-scoped check below with a bare 403. Say why, once,
    // here, instead of in each of those handlers.
    let org_claim_missing_here = caller.as_ref().is_some_and(|caller| {
        crate::sidecar::control_plane::registered_node()
            .is_some_and(|node| org_claim_missing(&node, caller))
    });
    req.extensions_mut().insert(caller);
    // Keep the verified raw token available only to the server-owned ACP spawn
    // path. It is never deserialized from the request body or returned to a
    // client; an invalid token is discarded with the anonymous caller state.
    req.extensions_mut().insert(VerifiedUserJwt(user_jwt));
    let response = next.run(req).await;
    if org_claim_missing_here && is_bare_forbidden(&response) {
        return org_access_not_in_session_response();
    }
    response
}

/// Org/team RBAC gate for a REST handler. Enforcement is keyed on whether THIS
/// node is bound to an org (a managed / shared "company brain" node) or is a
/// truly unbound local/dev node — because per-user RBAC only makes sense on a
/// node many people share, and the local-first single-user flow must never be
/// degraded on someone's own machine.
///
/// GATING RULE (fail-closed on shared/managed nodes, full-trust only when unbound):
///   - Node UNBOUND (`registered_org() == None`): the shared `RYU_TOKEN` already
///     implies a single trusted operator. ALWAYS ALLOW — for both an anonymous
///     caller and any signed-in user (including a multi-org user with no single
///     resolvable org, who must NOT be forced read-only on their own machine).
///     A node flagged managed is not considered unbound while registration is
///     unresolved; it denies until its org binding is available.
///   - Node ORG-BOUND (`registered_org() == Some(org)`):
///       - `None` caller (no / invalid user JWT) → DENY. A tokenless caller must
///         not inherit full trust, or any holder of the shared node token bypasses
///         RBAC entirely.
///       - `Some(caller)` NOT a member of `org` (`org_id != org`) → DENY ALL. A
///         non-member holds nothing here, matching the control plane's fail-closed
///         `[]` for non-members; this closes the cross-org read leak where a valid
///         JWT for a DIFFERENT org was narrowed to a Viewer with default reads.
///       - `Some(caller)` who IS a member → ALLOW iff the permission is in their
///         EFFECTIVE set: the built-in role tier (`permissions_for_role`) UNION any
///         custom-role grant resolved from the control plane. The role tier is
///         checked first (no network on the common path); a control-plane
///         resolution failure falls back to the role tier alone, never full access.
pub(crate) async fn enforce_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    perm: &str,
) -> Result<(), StatusCode> {
    match enforce_permission_or_unavailable(state, caller, perm).await {
        Err(StatusCode::SERVICE_UNAVAILABLE) => Err(StatusCode::FORBIDDEN),
        decided => decided,
    }
}
