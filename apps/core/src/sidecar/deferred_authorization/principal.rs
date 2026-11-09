//! Carrying a verified principal across a capability call between apps.
//!
//! A capability call from one app to another reaches the broker without the
//! member's own credential. The calling app hands back the principal proof
//! Core stamped on the request it is serving ([`super::PRINCIPAL_HEADER`]),
//! and the broker accepts it only for that same app
//! ([`verify_forwarded_principal`]). The proxy then forwards the member as the
//! verified caller, so the provider receives `x-ryu-caller-user-id` and scopes
//! its data to that person.

use super::verify;
use crate::identity_verify::VerifiedCaller;

const FORWARDED_PRINCIPAL_PURPOSE: &str = "principal";

/// The caller Core forwards for an attested member. The role is the lowest
/// tier: every permission check resolves that person's current effective set
/// from the control plane, so nothing here is granted on the role alone.
fn attested_caller(user_id: &str, org_id: Option<String>) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id,
        role: crate::identity_verify::OrgRole::Viewer,
        teams: Vec::new(),
    }
}

pub(super) fn verify_forwarded_principal_with(
    proof: &str,
    plugin: &str,
    key: &str,
) -> Result<Option<VerifiedCaller>, &'static str> {
    let envelope = verify(proof, key, plugin, FORWARDED_PRINCIPAL_PURPOSE)?;
    Ok(envelope
        .user
        .filter(|user| !user.trim().is_empty())
        .map(|user| attested_caller(&user, envelope.org)))
}

/// The member a principal proof Core stamped on a request to `plugin` names,
/// when `plugin` hands it back on a capability call. `Ok(None)` is the owner
/// of an unbound node (the proof names nobody).
pub fn verify_forwarded_principal(
    proof: &str,
    plugin: &str,
) -> Result<Option<VerifiedCaller>, &'static str> {
    let key = crate::node_token::active_token().ok_or("authorization unavailable")?;
    verify_forwarded_principal_with(proof, plugin, &key)
}

#[cfg(test)]
#[path = "principal_tests.rs"]
mod tests;
