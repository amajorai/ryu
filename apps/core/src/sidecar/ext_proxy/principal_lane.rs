//! The verified principal on a capability call between apps.
//!
//! An app serving a member's request hands back the principal proof Core
//! stamped on it ([`PRINCIPAL_HEADER`]) when it calls a capability, and the
//! broker forwards that member to the provider. Derived app-API tool calls
//! carry no member principal: they stay refused on org-bound nodes.
//!
//! [`PRINCIPAL_HEADER`]: crate::sidecar::deferred_authorization::PRINCIPAL_HEADER

use super::*;
use crate::identity_verify::VerifiedCaller;

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, Response> {
    let mut values = headers.get_all(name).iter();
    let Some(first) = values.next() else {
        return Ok(None);
    };
    match (first.to_str(), values.next()) {
        (Ok(value), None) if !value.trim().is_empty() => Ok(Some(value.trim())),
        _ => Err((
            StatusCode::BAD_REQUEST,
            "a principal proof must be sent exactly once",
        )
            .into_response()),
    }
}

/// The member a capability call from `caller_plugin` carries, when it hands
/// back the principal proof Core stamped on the request it serves. `Ok(None)`
/// with no proof, or for an unbound owner.
pub(super) fn capability_principal(
    headers: &HeaderMap,
    caller_plugin: &str,
) -> Result<Option<VerifiedCaller>, Response> {
    let Some(proof) = single_header(
        headers,
        crate::sidecar::deferred_authorization::PRINCIPAL_HEADER,
    )?
    else {
        return Ok(None);
    };
    crate::sidecar::deferred_authorization::verify_forwarded_principal(proof, caller_plugin)
        .map_err(|_| {
            (
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "principal proof is invalid or expired" })),
            )
                .into_response()
        })
}
