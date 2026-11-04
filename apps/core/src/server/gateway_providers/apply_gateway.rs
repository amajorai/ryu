//! The BYOK provider-key vault: `ApplyGatewayProvidersBody` through `gateway_apply_providers`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::server) struct ApplyGatewayProvidersBody {
    pub(in crate::server) revision: ryu_gw_credentials::ConfigRevision,
}

/// Retry the exact saved provider revision without mutating credential bytes.
#[utoipa::path(
    post,
    path = "/api/gateway/providers/apply",
    tag = "Gateway",
    summary = "Re-apply the saved provider settings to the running Gateway",
    request_body = serde_json::Value,
    responses((status = 200, description = "Applied", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_apply_providers(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ApplyGatewayProvidersBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    use ryu_gw_credentials::{ProviderApplyErrorCode as Code, ProviderApplyOutcome as Outcome};
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"insufficient permissions: gateway.configure"})),
        );
    }
    let observed = match gateway_config_path() {
        Some(path) => tokio::task::spawn_blocking(move || {
            let guard = ryu_gw_credentials::ConfigFileTransaction::acquire(&path)?;
            Ok::<_, ryu_gw_credentials::ConfigCommitError>((
                guard.snapshot().revision().clone(),
                guard.snapshot().exists(),
            ))
        })
        .await
        .ok()
        .and_then(Result::ok),
        None => None,
    };
    let (persisted, application) = match observed {
        Some((current, true)) if current == body.revision => (
            true,
            state.gateway.apply_provider_revision(&body.revision).await,
        ),
        Some((current, true)) => (
            false,
            Outcome::Superseded {
                requested_revision: body.revision.clone(),
                current_revision: current,
            },
        ),
        _ => (
            false,
            Outcome::Failed {
                requested_revision: body.revision.clone(),
                active_revision: None,
                code: Code::ConfigUnavailable,
            },
        ),
    };
    record_gateway_control(
        &state,
        "gateway.provider.apply",
        "gateway_provider",
        None,
        &caller,
    )
    .await;
    (
        StatusCode::OK,
        Json(
            json!({"success":true,"persisted":persisted,"configRevision":body.revision,"gateway_application":application,"gateway_restarted":false}),
        ),
    )
}
