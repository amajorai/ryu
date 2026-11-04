//! Auth handlers.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Auth handlers ─────────────────────────────────────────────────────────────

pub(in crate::server) fn append_return_to_query(uri: &str, return_to: &str) -> String {
    match url::Url::parse(uri) {
        Ok(mut url) => {
            url.query_pairs_mut().append_pair("return_to", return_to);
            url.to_string()
        }
        Err(_) => uri.to_string(),
    }
}

#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct AuthLoginBody {
    #[serde(rename = "backendUrl")]
    pub(in crate::server) backend_url: Option<String>,
    #[serde(rename = "returnTo")]
    pub(in crate::server) return_to: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/auth/login",
    tag = "Auth",
    summary = "Start the device authorization flow",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn auth_login(
    State(state): State<ServerState>,
    body: Option<Json<AuthLoginBody>>,
) -> Json<serde_json::Value> {
    tracing::info!("auth_login: starting device authorization flow");
    let body = body.map(|b| b.0).unwrap_or_default();
    let backend_url = body
        .backend_url
        .or_else(|| std::env::var("RYU_BACKEND_URL").ok())
        .unwrap_or_else(|| "http://localhost:3000".to_string());
    let return_to = body.return_to;
    tracing::info!("auth_login: backend={backend_url}");

    match crate::auth::start_device_login(Arc::clone(&state.auth), &backend_url).await {
        Ok(mut info) => {
            if let Some(return_to) = return_to {
                info.verification_uri_complete =
                    append_return_to_query(&info.verification_uri_complete, &return_to);
            }
            Json(json!({
                "userCode": info.user_code,
                "verificationUri": info.verification_uri,
                "verificationUriComplete": info.verification_uri_complete,
            }))
        }
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}

#[utoipa::path(
    get,
    path = "/api/auth/status",
    tag = "Auth",
    summary = "Device authorization status",
    description = "Returns device authorization state. The active account bearer is included only for a trusted local client; requests forwarded through a tunnel (Tailcat, Cloudflared, OpenTunnel, or a plugin tunnel) receive status flags without the bearer. `lastFlow` reports the most recently settled device flow as `{ userCode, result: \"succeeded\" | \"failed\", error }` (or null); a client that started a flow matches its `userCode` to learn whether that flow added an account, because a failed add-account flow leaves the previously active account authenticated.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn auth_status(
    State(state): State<ServerState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> Json<serde_json::Value> {
    let s = state.auth.lock().await;
    let authenticated = matches!(s.status, crate::auth::AuthStatus::Authenticated);
    let pending = matches!(s.status, crate::auth::AuthStatus::Pending);
    tracing::debug!("auth_status: authenticated={authenticated} pending={pending}");
    // Only a genuine local peer (the local CLI/native poll) receives the cloud
    // bearer. Every tunnel backend re-originates remote traffic over loopback.
    let token = if is_trusted_local_peer(peer.ip(), crate::sidecar::forwarding_tunnel_active()) {
        s.token.clone()
    } else {
        None
    };
    Json(json!({
        "authenticated": authenticated,
        "pending": pending,
        // The desktop poll (apps/desktop/lib/oauth.ts) completes login only when
        // BOTH `authenticated` and `token` are present, then stores the bearer
        // token client-side. Dropping this field (regressed in 9b3ac61c) left the
        // app polling forever on the auth-code page despite Core being authed.
        "token": token,
        "userCode": s.user_code,
        "verificationUri": s.verification_uri,
        // The outcome of the most recently settled device flow, keyed by the
        // `userCode` `/api/auth/login` returned. A failed "add account" leaves
        // `authenticated` true (the previous account stays active), so a
        // poller must match its own code here to tell success from failure.
        "lastFlow": s.last_flow.as_ref().map(crate::auth::DeviceFlowOutcome::to_wire),
    }))
}

/// Query of `GET /api/auth/user-jwt`.
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct AuthUserJwtQuery {
    /// Mint a new token instead of reusing the cached one.
    #[serde(default)]
    pub(in crate::server) fresh: bool,
}

/// `GET /api/auth/user-jwt` — the signed-in account's short-lived user JWT.
///
/// Surfaces without a cloud session of their own (CLI, Island, browser
/// extension, Raycast) call their LOCAL Core here and present the result as
/// `x-ryu-user-jwt` to any node, so a shared node can tell which member is
/// calling. Only a trusted local peer is served, the same boundary as the raw
/// session token in [`auth_status`]: a remote node-token holder must never be
/// able to mint the owner's identity.
///
/// `?fresh=true` skips the cached token and mints a new one, so organization
/// claims the session just earned (a confirmed second factor) reach the next
/// request instead of waiting for the cached token to expire.
pub(in crate::server) async fn auth_user_jwt(
    State(state): State<ServerState>,
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Query(query): Query<AuthUserJwtQuery>,
) -> axum::response::Response {
    if !is_trusted_local_peer(peer.ip(), crate::sidecar::forwarding_tunnel_active()) {
        return json_error(
            StatusCode::FORBIDDEN,
            "user identity tokens are only issued to local clients".to_owned(),
        );
    }
    let session = state.auth.lock().await.token.clone();
    let Some(session) = session.filter(|token| !token.is_empty()) else {
        return json_error(StatusCode::UNAUTHORIZED, "not signed in".to_owned());
    };
    if query.fresh {
        crate::identity_verify::forget_minted_user_jwt().await;
    }
    match crate::identity_verify::mint_user_jwt(&session).await {
        Ok((token, expires_at)) => {
            Json(json!({ "token": token, "expiresAt": expires_at })).into_response()
        }
        Err(error) => {
            tracing::warn!("auth_user_jwt: token exchange failed: {error}");
            json_error(
                StatusCode::BAD_GATEWAY,
                "could not obtain a user identity token".to_owned(),
            )
        }
    }
}

#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct AuthLogoutBody {
    /// When true, wipe the whole vault (sign out of every account). Otherwise
    /// only the active account is removed and the next one becomes active.
    #[serde(default)]
    pub(in crate::server) all: bool,
}

#[utoipa::path(
    post,
    path = "/api/auth/logout",
    tag = "Auth",
    summary = "Sign out the active account (or all with { all: true })",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn auth_logout(
    State(state): State<ServerState>,
    body: Option<Json<AuthLogoutBody>>,
) -> Json<serde_json::Value> {
    let all = body.map(|b| b.0.all).unwrap_or(false);

    if all {
        // Clear the entire vault and the legacy token, log fully out.
        let vault = crate::auth::AccountVault::default();
        if let Err(e) = crate::auth::save_accounts(&vault) {
            tracing::warn!("Failed to clear account vault: {e}");
        }
        if let Err(e) = crate::auth::clear_token() {
            tracing::warn!("Failed to clear token from disk: {e}");
        }
        let mut s = state.auth.lock().await;
        s.status = crate::auth::AuthStatus::Idle;
        s.token = None;
        s.user_code = None;
        s.verification_uri = None;
        return Json(json!({ "success": true, "activeUserId": serde_json::Value::Null }));
    }

    // Remove just the active account, falling to the next one if present.
    let vault = crate::auth::load_accounts();
    let Some(active_id) = vault.active_user_id.clone() else {
        // No vault yet — treat as legacy single-token logout.
        if let Err(e) = crate::auth::clear_token() {
            tracing::warn!("Failed to clear token from disk: {e}");
        }
        let mut s = state.auth.lock().await;
        s.status = crate::auth::AuthStatus::Idle;
        s.token = None;
        s.user_code = None;
        s.verification_uri = None;
        return Json(json!({ "success": true, "activeUserId": serde_json::Value::Null }));
    };

    let new_active = match crate::auth::remove_account(&active_id) {
        Ok(id) => id,
        Err(e) => return Json(json!({ "success": false, "error": e.to_string() })),
    };

    let mut s = state.auth.lock().await;
    s.token = crate::auth::active_token();
    s.status = if s.token.is_some() {
        crate::auth::AuthStatus::Authenticated
    } else {
        crate::auth::AuthStatus::Idle
    };
    s.user_code = None;
    s.verification_uri = None;
    Json(json!({ "success": true, "activeUserId": new_active }))
}

#[utoipa::path(
    get,
    path = "/api/auth/accounts",
    tag = "Auth",
    summary = "List signed-in accounts (tokens never included)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn auth_accounts_list(
    State(_state): State<ServerState>,
) -> Json<serde_json::Value> {
    let vault = crate::auth::load_accounts();
    let active_id = vault.active_user_id.clone();
    let accounts: Vec<serde_json::Value> = vault
        .accounts
        .iter()
        .map(|a| {
            json!({
                "userId": a.user_id,
                "email": a.email,
                "name": a.name,
                "image": a.image,
                "active": Some(&a.user_id) == active_id.as_ref(),
            })
        })
        .collect();
    Json(json!({ "accounts": accounts, "activeUserId": active_id }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct AccountRefBody {
    #[serde(rename = "userId")]
    pub(in crate::server) user_id: String,
}

#[utoipa::path(
    post,
    path = "/api/auth/accounts/switch",
    tag = "Auth",
    summary = "Switch the active account",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn auth_accounts_switch(
    State(state): State<ServerState>,
    Json(body): Json<AccountRefBody>,
) -> Json<serde_json::Value> {
    match crate::auth::switch_account(&body.user_id) {
        Ok(_) => {
            let mut s = state.auth.lock().await;
            s.token = crate::auth::active_token();
            s.status = if s.token.is_some() {
                crate::auth::AuthStatus::Authenticated
            } else {
                crate::auth::AuthStatus::Idle
            };
            Json(json!({ "success": true }))
        }
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

#[utoipa::path(
    post,
    path = "/api/auth/accounts/remove",
    tag = "Auth",
    summary = "Sign out one account by userId",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn auth_accounts_remove(
    State(state): State<ServerState>,
    Json(body): Json<AccountRefBody>,
) -> Json<serde_json::Value> {
    match crate::auth::remove_account(&body.user_id) {
        Ok(new_active) => {
            let mut s = state.auth.lock().await;
            s.token = crate::auth::active_token();
            s.status = if s.token.is_some() {
                crate::auth::AuthStatus::Authenticated
            } else {
                crate::auth::AuthStatus::Idle
            };
            if s.token.is_none() {
                s.user_code = None;
                s.verification_uri = None;
            }
            Json(json!({ "success": true, "activeUserId": new_active }))
        }
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

pub(in crate::server) fn consume_widget_follow_up_ticket(
    req: &mut ChatStreamRequest,
) -> Result<(), &'static str> {
    let Some(ticket) = req.widget_follow_up_ticket.as_deref() else {
        return Ok(());
    };
    let Some(conversation_id) = req.conversation_id.as_deref() else {
        return Err("widget follow-up requires its bound conversation");
    };
    let prompt = req
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .map(crate::sidecar::adapters::ui_message_text)
        .unwrap_or_default();
    let provenance =
        crate::server::widgets::consume_follow_up_ticket(ticket, conversation_id, &prompt)?;
    req.widget_provenance = Some(provenance);
    Ok(())
}
