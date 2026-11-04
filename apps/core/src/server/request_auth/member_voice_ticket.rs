//! Server state, the remote-auth gate, route policy and the `require_auth` middleware: `authorize_member_voice_ticket` through `track_connection`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Admit a managed member (not the node owner) to the voice-mode ticket issuer.
///
/// Accepts only the two credentials a managed member's own signed-in session
/// holds: a managed user JWT, or the node-list delegation the control plane
/// mints for that session. Paired devices, hosted OAuth and MCP client
/// delegations, and every other kind stay refused. The credential must pass the same route policy
/// and organization route gate as `POST /api/chat/stream`, so voice mode never
/// grants more than typed chat. Returns the verified caller and the credential's
/// expiry, which the socket enforces for the life of the connection.
pub(crate) async fn authorize_member_voice_ticket(
    headers: &axum::http::HeaderMap,
) -> Option<MemberVoiceGrant> {
    authorize_member_voice_ticket_with_token(headers, crate::node_token::active_token()).await
}

pub(in crate::server) async fn authorize_member_voice_ticket_with_token(
    headers: &axum::http::HeaderMap,
    expected: Option<String>,
) -> Option<MemberVoiceGrant> {
    // A tokenless node serves only genuine local peers; members never reach it.
    let expected = expected.filter(|token| !token.trim().is_empty())?;
    let token = header_str(headers, "authorization")
        .and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned))?;
    if ct_eq(token.trim(), expected.trim()) {
        // The owner token is the issuer's own path, never a member credential.
        return None;
    }
    let now = crate::pairing::now_secs();
    let (resolved, expires_at) =
        if let Some(resolved) = resolve_managed_user_jwt(&token, headers, None, now).await {
            let (_, expires_at) = verified_caller_with_expiry_from_token(&token).await?;
            (resolved, expires_at)
        } else {
            let verified = crate::authorization::delegation::verify(&token, now).ok()?;
            if verified.context.constraints.client_id.as_deref()
                != Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID)
            {
                return None;
            }
            let expires_at = i64::try_from(verified.context.expires_at?).ok()?;
            let bindings = bind_delegation_to_route(verified.bindings, None)?;
            (
                ResolvedAuthorization {
                    context: verified.context,
                    bindings,
                    caller: Some(verified.caller),
                    verified_user_jwt: None,
                },
                expires_at,
            )
        };
    let caller = resolved.caller.clone()?;
    let policy = credential_route_policy(
        &Method::POST,
        VOICE_TICKET_CHAT_PATH,
        &resolved.context,
        true,
    );
    if denial_status(resolved.context.authorize(&policy, &resolved.bindings, now)).is_some() {
        return None;
    }
    if crate::org_policy::route_denial(
        "POST",
        VOICE_TICKET_CHAT_PATH,
        None,
        Some(caller.user_id.as_str()),
    )
    .await
    .is_some()
    {
        return None;
    }
    Some(MemberVoiceGrant {
        caller,
        expires_at,
        user_jwt: resolved.verified_user_jwt,
    })
}

/// What a member voice ticket carries from [`authorize_member_voice_ticket`].
#[derive(Debug, Clone)]
pub(crate) struct MemberVoiceGrant {
    pub(crate) caller: crate::identity_verify::VerifiedCaller,
    /// Credential expiry (Unix seconds); the socket closes when it passes.
    pub(crate) expires_at: i64,
    /// The verified managed user JWT, when that was the credential. Carried to
    /// voice turns as `user_jwt` exactly as `chat_stream` carries it, so the
    /// Gateway attributes and budgets the member's usage. `None` for a
    /// delegation, matching typed chat.
    pub(crate) user_jwt: Option<String>,
}

/// Whether a credential is the node owner or a managed member's own signed-in
/// session (see [`authorize_member_voice_ticket`]). Voice HTTP routes admit only
/// these, so a paired device or a hosted OAuth/MCP client with `chat:write` does
/// not gain speech synthesis or transcription on the node.
pub(in crate::server) fn is_owner_or_member_session(
    context: &crate::authorization::AuthorizationContext,
) -> bool {
    use crate::authorization::CredentialKind;
    context.is_owner()
        || matches!(context.credential, CredentialKind::ManagedUserJwt)
        || (matches!(context.credential, CredentialKind::ManagedDelegation)
            && context.constraints.client_id.as_deref()
                == Some(crate::authorization::delegation::NODE_LIST_CLIENT_ID))
}

/// Read a single trimmed, non-empty header value.
pub(in crate::server) fn header_str(headers: &axum::http::HeaderMap, key: &str) -> Option<String> {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Same, but percent-decoded — for fields that may carry non-ASCII (display
/// names, emails). Clients URL-encode these so the value is always a valid HTTP
/// header value regardless of the user's locale.
pub(in crate::server) fn header_decoded(
    headers: &axum::http::HeaderMap,
    key: &str,
) -> Option<String> {
    header_str(headers, key).map(|raw| {
        urlencoding::decode(&raw)
            .map(std::borrow::Cow::into_owned)
            .unwrap_or(raw)
    })
}

/// The caller's host surface, from the self-declared `x-ryu-surface` header.
///
/// Returns `None` when the header is absent OR names a surface we don't know.
/// **`None` means "do not filter"**, never "filter everything out": a plugin's
/// `targets` list narrows where it is surfaced, and a caller that doesn't say who
/// it is must keep seeing everything (which is what every client that predates
/// the header does).
///
/// This header is self-declared and therefore spoofable. That is acceptable here
/// because `targets` is a **presentation** concern — it decides what a surface
/// *shows*, not what a caller is *allowed* to do. Authorization stays with the
/// Gateway (grants) and the node token; a client that lies about its surface only
/// changes which plugins it lists for itself.
pub(in crate::server) fn surface_from_headers(
    headers: &axum::http::HeaderMap,
) -> Option<crate::plugin_manifest::Surface> {
    header_str(headers, "x-ryu-surface")
        .as_deref()
        .and_then(crate::plugin_manifest::Surface::parse)
}

/// Parse the self-declared caller identity from request headers (see
/// [`crate::connections`]). All fields are optional except `client_id`, which is
/// what makes a request trackable at all.
pub(in crate::server) fn identity_from_headers(
    headers: &axum::http::HeaderMap,
) -> crate::connections::CallerIdentity {
    crate::connections::CallerIdentity {
        user_id: header_decoded(headers, "x-ryu-user-id"),
        user_name: header_decoded(headers, "x-ryu-user-name"),
        client_id: header_str(headers, "x-ryu-client-id").unwrap_or_default(),
        client_label: header_decoded(headers, "x-ryu-client-label"),
        surface: header_str(headers, "x-ryu-surface"),
    }
}

/// Middleware that records connected-client presence. Layered INSIDE
/// `require_auth` so only authenticated requests touch the registry (public
/// routes — health, version, auth — never pollute the "who's connected" view).
/// A request with no `x-ryu-client-id` is a no-op, so older clients that don't
/// send identity headers simply don't appear (they still work).
pub(in crate::server) async fn track_connection(
    State(registry): State<crate::connections::ConnectionRegistry>,
    req: Request<axum::body::Body>,
    next: middleware::Next,
) -> axum::response::Response {
    let identity = identity_from_headers(req.headers());
    if identity.is_trackable() {
        registry.touch(&identity);
    }
    next.run(req).await
}
