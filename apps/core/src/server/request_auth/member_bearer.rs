//! A member's own session presented as a bearer outside `require_auth`.
//!
//! The ext-proxy runs on the public router and checks its own bearer. For a
//! permission-gated app route it may admit a member's signed-in session
//! instead of the node token (see `sidecar::ext_proxy::member_admission`).
//! This is the one place that decides what counts as that session, using the
//! same verification `require_auth` applies, so the two can never disagree.

use crate::server::*;

/// The member a bearer belongs to, when it is their own signed-in session: a
/// verified user JWT for this managed node, or the control plane's node-list
/// delegation for that member. Every other credential (the owner token, a
/// paired device, an OAuth or MCP client's delegation) answers `None`.
pub(crate) async fn member_session_caller(
    token: &str,
    headers: &axum::http::HeaderMap,
) -> Option<crate::identity_verify::VerifiedCaller> {
    let now = crate::pairing::now_secs();
    if let Some(resolved) = resolve_managed_user_jwt(token, headers, None, now).await {
        return resolved
            .caller
            .filter(|_| is_owner_or_member_session(&resolved.context));
    }
    let verified = crate::authorization::delegation::verify(token, now).ok()?;
    let member_session = matches!(
        verified.context.credential,
        crate::authorization::CredentialKind::ManagedDelegation
    ) && is_owner_or_member_session(&verified.context);
    member_session.then_some(verified.caller)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_owner_token_and_garbage_are_not_member_sessions() {
        let headers = axum::http::HeaderMap::new();
        assert!(member_session_caller("not-a-credential", &headers)
            .await
            .is_none());
        assert!(member_session_caller("a.b.c", &headers).await.is_none());
        if let Some(owner) = crate::node_token::active_token() {
            assert!(member_session_caller(&owner, &headers).await.is_none());
        }
    }
}
