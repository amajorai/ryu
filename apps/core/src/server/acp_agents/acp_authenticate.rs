//! ACP agent config, accounts, sessions, updates and capability overrides: `acp_authenticate` through `pi_provider_accounts`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/agents/:id/authenticate` — run the ACP Authentication flow for an
/// agent using one of the methods it advertised (e.g. a subscription/OAuth
/// login). The agent subprocess owns the login UX; this issues the ACP
/// `authenticate` request and waits for completion, then invalidates the cached
/// `acp-config` so the now-unlocked session config is re-read.
///
/// **A successful RPC is not a successful login.** Agents may advertise methods
/// that merely *describe* how to log in — pi-acp's `pi_terminal_login` ("start pi
/// in an interactive terminal") answers `authenticate` in about a second having
/// done nothing — and reporting that as success is how the desktop came to toast
/// "Connected" for a login that never happened. So when the caller names a
/// subscription `provider_id`, this compares Pi's stored credential before and
/// after the call and reports what it OBSERVED:
///
/// - `authenticated` — a credential is now present (the only claim worth making).
/// - `agentAccepted` — the ACP request itself returned without error.
/// - `verified` — whether this agent's credential ground truth was checked.
///   Unverified RPC acceptance never reports authentication or creates an account.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/authenticate",
    tag = "Agents",
    summary = "Authenticate to an ACP agent (login)",
    params(("id" = String, Path, description = "Agent id")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn acp_authenticate(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
    Json(body): Json<AcpAuthRequest>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let Some(spawn_cmd) = spawn_cmd else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not an ACP agent" })),
        )
            .into_response();
    };
    match crate::pi_config::native_accounts::for_spawn(&spawn_cmd) {
        Ok(Some(_)) => {
            return Json(json!({"authenticated":false,"verified":false,
            "nativeAccounts":true,"code":"native_account_login_required",
            "error":"Create or reconnect an isolated native account to complete device sign-in."}))
            .into_response();
        }
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":error.to_string()})),
            )
                .into_response();
        }
        Ok(None) => {}
    }
    // Pi's credential store can verify only the managed Pi that owns it.
    // An external agent naming a Pi provider must not inherit that evidence.
    let verification_provider =
        acp_login_verification_provider(&spawn_cmd, &agent_id, body.provider_id.as_deref());
    let before = verification_provider.and_then(crate::pi_config::subscription_login_present);
    if let Err(e) =
        crate::sidecar::adapters::acp::authenticate_acp(spawn_cmd.clone(), body.method_id).await
    {
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "authenticated": false,
                "agentAccepted": false,
                "verified": before.is_some(),
                "error": e.to_string(),
            })),
        )
            .into_response();
    }
    let Some(was_present) = before else {
        // RPC acceptance cannot prove a connection or create a saved sign-in.
        return Json(serde_json::json!({
            "authenticated": false,
            "agentAccepted": true,
            "verified": false,
            "verificationRequired": true,
            "code": "auth_verification_required",
            "error": "The agent accepted the authentication request, but its sign-in has not been verified. Complete or verify the vendor login before using this connection.",
        }))
        .into_response();
    };
    let now_present = verification_provider
        .and_then(crate::pi_config::subscription_login_present)
        .unwrap_or(false);
    if now_present {
        crate::pi_config::record_acp_account(&spawn_cmd, verification_provider);
        return Json(serde_json::json!({
            "authenticated": true,
            "agentAccepted": true,
            "verified": true,
            // Distinguishes "this call logged you in" from "you already were".
            "changed": !was_present,
        }))
        .into_response();
    }
    // The agent accepted the request and no credential appeared: the advertised
    // method does not perform a login on its own. 200, not an error status — the
    // request was handled correctly; the LOGIN is what did not happen.
    Json(serde_json::json!({
        "authenticated": false,
        "agentAccepted": true,
        "verified": true,
        "error": "The agent accepted the request but no credential was stored, so you are not signed in. This agent's login method has to be completed outside the app.",
    }))
    .into_response()
}

pub(in crate::server) fn acp_login_verification_provider<'a>(
    spawn_cmd: &str,
    agent_id: &str,
    provider_id: Option<&'a str>,
) -> Option<&'a str> {
    // Only Ryu's own managed Pi config holds the credential being verified; a
    // limited custom agent's Pi reads the credential-free limited config.
    ((agent_id == "ryu" || crate::agents::runs_on_ryu_engine(agent_id))
        && crate::sidecar::adapters::acp::is_managed_pi_extension(spawn_cmd, agent_id))
    .then_some(provider_id)
    .flatten()
}

/// `POST /api/agents/:id/logout` — end an ACP agent's authenticated session (ACP
/// `logout`). Inverse of `authenticate`: the agent drops its credentials so the
/// next `session/new` requires re-login. Best-effort; agents that don't support
/// the `logout` capability return an error.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/logout",
    tag = "Agents",
    summary = "Log out of an ACP agent",
    params(("id" = String, Path, description = "Agent id")),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn acp_logout(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let Some(spawn_cmd) = spawn_cmd else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not an ACP agent" })),
        )
            .into_response();
    };
    match crate::pi_config::native_accounts::for_spawn(&spawn_cmd) {
        Ok(Some(native)) => {
            let launch = match native.capture_active() {
                Ok(launch) => launch,
                Err(error) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":error.to_string()})),
                    )
                        .into_response();
                }
            };
            native_accounts::cancel_account(&agent_id, &launch.affinity.account_id).await;
            return match native.logout(&launch.affinity.account_id).await {
                Ok(()) => Json(json!({"loggedOut":true})).into_response(),
                Err(error) => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"loggedOut":false,"error":error.to_string()})),
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
        Ok(None) => {}
    }
    match crate::sidecar::adapters::acp::logout_acp(spawn_cmd).await {
        Ok(()) => Json(serde_json::json!({ "loggedOut": true })).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "loggedOut": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Where a provider account should become active. `self` keeps the account in
/// the current Ryu/Pi session; `gateway` installs an API-key account in the
/// shared Gateway and therefore requires `gateway.configure` on org-bound nodes.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(in crate::server) enum AccountActionTarget {
    #[serde(rename = "self")]
    SelfTarget,
    Gateway,
}

impl Default for AccountActionTarget {
    fn default() -> Self {
        Self::SelfTarget
    }
}

/// Body for the provider/agent account switch + remove routes.
#[derive(serde::Deserialize)]
pub(in crate::server) struct AccountAction {
    /// The vault `accountId` to switch to / remove.
    #[serde(rename = "accountId")]
    pub(in crate::server) account_id: String,
    /// The provider an ACP account belongs to (required for managed-Pi agent
    /// accounts, which live in a provider scope).
    #[serde(default)]
    pub(in crate::server) provider: Option<String>,
    /// `self` (default) or `gateway` for a provider account switch.
    #[serde(default)]
    pub(in crate::server) target: AccountActionTarget,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct AccountLabelChange {
    pub(in crate::server) account_id: String,
    pub(in crate::server) label: String,
}

/// `GET /api/pi-config/providers/:id/accounts` — the accounts a provider holds
/// in the sealed vault (labels, kinds, active flag — NEVER a credential).
#[utoipa::path(
    get,
    path = "/api/pi-config/providers/{id}/accounts",
    tag = "Agents",
    summary = "List a Pi provider's accounts",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn pi_provider_accounts(
    Path(provider_id): Path<String>,
) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "accounts": crate::pi_config::list_provider_accounts(&provider_id),
    }))
}
