//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `set_app_grants_handler` through `set_app_grants_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/plugins/:id/grants` — set an enabled app's approved grants to an
/// explicit subset (per-grant revocation). Delegates to
/// [`crate::plugins::lifecycle::set_app_grants`], which escalation-guards against
/// the manifest's declared set, re-validates through the Gateway, and refuses on a
/// disabled app (no backdoor enable). Returns the new approved set.
#[utoipa::path(
    post,
    path = "/api/plugins/{id}/grants",
    tag = "Plugins",
    summary = "Set a plugin's permission grants",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_app_grants_handler(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<SetGrantsBody>,
) -> axum::response::Response {
    use crate::plugins::lifecycle::{set_app_grants, EnableError};
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    // Approved grants are what enable records; changing them is an enable-level
    // decision on a managed node.
    if let Err(response) = enforce_app_lifecycle_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_ENABLE,
    )
    .await
    {
        return response;
    }

    let Some(manifest) = find_manifest(&state, &id).await else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("no manifest found for app '{id}'"),
        );
    };

    match set_app_grants(
        &state.app_store,
        &manifest,
        &body.grants,
        &gateway_url(),
        gateway_token().as_deref(),
        &state.client,
    )
    .await
    {
        Ok(record) => {
            // Grants gate which contributions are live — nudge subscribed shells
            // to refetch. Lossy no-op if the room has no members (see the enable
            // handler's broadcast for the full rationale).
            state.realtime.broadcast_event(
                "system:plugins",
                "plugin.contributions.changed",
                json!({"type": "contributions_changed"}),
            );
            Json(json!({
                "success": true,
                "approved_grants": record.approved_grants,
            }))
            .into_response()
        }
        Err(EnableError::GrantsDenied { plugin, denied }) => (
            StatusCode::FORBIDDEN,
            Json(json!({
                "success": false,
                "error": "Gateway denied one or more grants",
                "plugin": plugin,
                "denied_grants": denied,
            })),
        )
            .into_response(),
        Err(EnableError::GatewayUnreachable { reason }) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "success": false,
                "error": "Gateway unreachable; grant update fails closed",
                "reason": reason,
            })),
        )
            .into_response(),
        // Unreachable in practice: editing the grants of an ALREADY-enabled plugin
        // never resolves the dependency graph (that happens on enable). Handled
        // explicitly rather than with a catch-all so a future `set_app_grants` that
        // does touch the graph cannot silently fall through to the wrong status.
        Err(EnableError::Dependency(e)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": e.to_string(),
                "dependency_error": e,
            })),
        )
            .into_response(),
        // Also unreachable here (a grants edit never resolves capability bindings)
        // but handled explicitly, for the same fail-loud reason as the Dependency arm.
        Err(EnableError::Binding { plugin, source }) => (
            StatusCode::CONFLICT,
            Json(json!({
                "success": false,
                "error": source.to_string(),
                "plugin": plugin,
                "binding_error": source.code(),
            })),
        )
            .into_response(),
        Err(EnableError::Other(e)) => json_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}
