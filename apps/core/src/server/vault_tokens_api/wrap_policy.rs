//! Explains a refusal caused by a policy that requires response wrapping.
//!
//! [`crate::vault::policy::wrap_requirement`] drops a capability whose rule
//! requires a wrapped response the request did not ask for, so the route's
//! own check answers `403 vault_denied`. When that denial names a recorded
//! violation, this turns it into `403 vault_wrapping_required` with the TTL
//! bounds to send, and audits it. The message names the policy key and the
//! bounds, never a value.

use super::*;
use crate::vault::policy::wrap_requirement::Violation;

/// Largest refusal body this inspects; a larger one passes through unchanged.
const MAX_REFUSAL_BYTES: usize = 64 * 1024;

/// The Vault-compatible API's generic refusal body.
const COMPAT_DENIED: &str = "permission denied";

/// The `/api/vault` denial text for `violation`, as `vault_api::denied`
/// formats it.
fn denial_text(violation: &Violation) -> String {
    format!(
        "the `{}` capability is required on `{}`",
        violation.capability.as_str(),
        violation.path
    )
}

/// The violation a refusal `body` reports, and the replacement body.
pub(super) fn explain(body: &Value, violations: &[Violation]) -> Option<(Violation, Value)> {
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        let violation = violations
            .iter()
            .find(|violation| error.contains(&denial_text(violation)))?;
        let message = format!("vault_wrapping_required: {}", violation.message());
        return Some((violation.clone(), json!({ "error": message })));
    }
    let errors = body.get("errors").and_then(Value::as_array)?;
    if errors.len() != 1 || errors[0].as_str() != Some(COMPAT_DENIED) {
        return None;
    }
    let violation = violations.first()?.clone();
    let message = format!(
        "{COMPAT_DENIED}: {}; the Vault-compatible API does not wrap responses, use /api/vault routes",
        violation.message()
    );
    Some((violation, json!({ "errors": [message] })))
}

/// Replace a `403` caused by a wrapping requirement with an explanation.
pub(super) async fn explain_wrapping_refusal(
    store: &'static PluginSecretStore,
    response: Response,
    violations: &[Violation],
    path: &str,
    context: &RequestContext,
) -> Response {
    if violations.is_empty() || response.status() != StatusCode::FORBIDDEN {
        return response;
    }
    let (parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, MAX_REFUSAL_BYTES).await else {
        return json_error(
            StatusCode::FORBIDDEN,
            "vault_denied: the request was refused".to_owned(),
        );
    };
    let explained = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|body| explain(&body, violations));
    let Some((violation, replacement)) = explained else {
        return Response::from_parts(parts, axum::body::Body::from(bytes));
    };
    let actor = match context.token_accessor() {
        Some(accessor) => AuditActor::new("token", Some(&accessor)),
        None => AuditActor::new("request", None),
    };
    let entry = AuditEntry::new(&actor, "policy.wrapping_required", "denied").details(json!({
        "route": path,
        "path": violation.path,
        "capability": violation.capability.as_str(),
        "minWrappingTtlSecs": violation.bounds.min_secs,
        "maxWrappingTtlSecs": violation.bounds.max_secs,
    }));
    // Audit off the request path, like quota rejections.
    tokio::spawn(async move { store.audit(&entry).await });
    let mut response = (StatusCode::FORBIDDEN, Json(replacement)).into_response();
    response
        .headers_mut()
        .insert("x-ryu-wrapping-required", HeaderValue::from_static("true"));
    response
}
