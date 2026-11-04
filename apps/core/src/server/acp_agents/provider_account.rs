//! ACP agent config, accounts, sessions, updates and capability overrides: `pi_provider_account_switch` through `acp_accounts`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/pi-config/providers/:id/accounts/switch` — make another stored
/// account active for the current Ryu session, or install an API-key account in
/// the shared Gateway when `target` is `gateway`.
#[utoipa::path(
    post,
    path = "/api/pi-config/providers/{id}/accounts/switch",
    tag = "Agents",
    summary = "Switch a Pi provider's active account",
    description = "Switches the account for the current Ryu session by default. Set target to gateway to install a gateway-compatible BYOK account in the shared Gateway; that target requires the gateway.configure permission.",
    params(("id" = String, Path, description = "Provider id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn pi_provider_account_switch(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(provider_id): Path<String>,
    Json(body): Json<AccountAction>,
) -> axum::response::Response {
    if matches!(body.target, AccountActionTarget::Gateway) {
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
                Json(serde_json::json!({
                    "switched": false,
                    "error": "insufficient permissions: gateway.configure",
                })),
            )
                .into_response();
        }
        let Some(gateway_provider) = crate::pi_config::gateway_provider_slug(&provider_id) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "switched": false,
                    "error": "this provider account cannot be installed in the Gateway",
                })),
            )
                .into_response();
        };
        let api_key =
            match crate::pi_config::provider_account_api_key(&provider_id, &body.account_id) {
                Ok(key) => key,
                Err(error) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "switched": false,
                            "error": error.to_string(),
                        })),
                    )
                        .into_response();
                }
            };
        let (status, Json(result)) = gateway_set_provider(
            State(state.clone()),
            Extension(caller.clone()),
            Json(SetProviderBody {
                provider: gateway_provider.to_owned(),
                api_key: Some(api_key),
                account_action: None,
                account_index: None,
                account_id: None,
                account_policy: None,
                sdk_context: None,
                allow_environment: None,
                expected_revision: None,
            }),
        )
        .await;
        if !status.is_success() || result.get("success") != Some(&serde_json::Value::Bool(true)) {
            return (status, Json(result)).into_response();
        }
        return match crate::pi_config::set_provider_gateway_active(&provider_id, &body.account_id) {
            Ok(true) => Json(crate::pi_config::catalog()).into_response(),
            Ok(false) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "switched": false,
                    "error": "the Gateway account marker could not be updated",
                })),
            )
                .into_response(),
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "switched": false,
                    "error": error.to_string(),
                })),
            )
                .into_response(),
        };
    }
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "switched": false,
                "error": "insufficient permissions: agent.run",
            })),
        )
            .into_response();
    }
    match crate::pi_config::switch_provider_account(&provider_id, &body.account_id) {
        Ok(catalog) => Json(catalog).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "switched": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/pi-config/providers/:id/accounts/rename` — change a saved
/// account's display label without touching its credential or selection.
#[utoipa::path(
    post,
    path = "/api/pi-config/providers/{id}/accounts/rename",
    tag = "Agents",
    summary = "Rename a Pi provider account",
    params(("id" = String, Path, description = "Provider id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn pi_provider_account_rename(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(provider_id): Path<String>,
    Json(body): Json<AccountLabelChange>,
) -> axum::response::Response {
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "renamed": false,
                "error": "insufficient permissions: agent.run",
            })),
        )
            .into_response();
    }

    match crate::pi_config::rename_provider_account(&provider_id, &body.account_id, &body.label) {
        Ok(catalog) => Json(catalog).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "renamed": false, "error": error.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/pi-config/providers/:id/accounts/remove` — remove an account.
/// If it was active, the newest remaining account takes over.
#[utoipa::path(
    post,
    path = "/api/pi-config/providers/{id}/accounts/remove",
    tag = "Agents",
    summary = "Remove a Pi provider account",
    params(("id" = String, Path, description = "Provider id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn pi_provider_account_remove(
    Path(provider_id): Path<String>,
    Json(body): Json<AccountAction>,
) -> axum::response::Response {
    let _native_session_guard = if provider_id == crate::pi_config::CHATGPT_PLAN_PROVIDER_ID {
        Some(crate::pi_config::OAUTH_REFRESH_LOCK.lock().await)
    } else {
        None
    };
    let revocation = if provider_id == crate::pi_config::CHATGPT_PLAN_PROVIDER_ID {
        use crate::pi_config::{
            accounts,
            chatgpt_plan::{RevocationStatus, StoredAccount},
            CHATGPT_PLAN_AUTH_KEY,
        };
        let saved = accounts::global()
            .and_then(|vault| {
                vault
                    .credential(
                        &accounts::provider_scope(CHATGPT_PLAN_AUTH_KEY),
                        &body.account_id,
                    )
                    .ok()
            })
            .flatten()
            .and_then(|value| StoredAccount::from_value(&value).ok());
        Some(match saved {
            Some(saved) => crate::pi_config::chatgpt_plan::revoke(&saved)
                .await
                .unwrap_or(RevocationStatus::Unconfirmed),
            None => RevocationStatus::Unconfirmed,
        })
    } else {
        None
    };
    match crate::pi_config::remove_provider_account(&provider_id, &body.account_id) {
        Ok(mut catalog) => {
            if let Some(revocation) = revocation {
                catalog["sessionRevocationStatus"] = json!(revocation);
            }
            Json(catalog).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "removed": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/agents/:id/accounts` — the accounts an ACP agent holds (labels
/// only). For the managed Pi these are its provider accounts, tagged with their
/// provider; for any other agent they are its opaque sign-ins.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/accounts",
    tag = "Agents",
    summary = "List an ACP agent's accounts",
    params(("id" = String, Path, description = "Agent id")),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent view permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn acp_accounts(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let accounts = match spawn_cmd {
        Some(spawn_cmd) => match crate::pi_config::native_accounts::for_spawn(&spawn_cmd) {
            Ok(Some(native)) => {
                return match native.list() {
                    Ok(accounts) => {
                        Json(json!({"accounts":accounts,"nativeAccounts":true})).into_response()
                    }
                    Err(error) => (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":error.to_string()})),
                    )
                        .into_response(),
                };
            }
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":error.to_string()})),
                )
                    .into_response();
            }
            Ok(None) => crate::pi_config::list_acp_accounts(&spawn_cmd),
        },
        None => Vec::new(),
    };
    Json(serde_json::json!({ "accounts": accounts })).into_response()
}
