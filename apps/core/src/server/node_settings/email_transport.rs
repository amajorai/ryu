//! Email transport (BYO SMTP sink config).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// -- Email transport (BYO SMTP sink config) --------------------------------------

/// Non-secret transport config exchanged with the desktop SMTP card. The password
/// is write-only (`password`, never returned); `passwordSet` reports whether one
/// is stored so the card can show a "configured" state without revealing it.
#[derive(serde::Deserialize)]
pub(in crate::server) struct EmailTransportBody {
    #[serde(default)]
    pub(in crate::server) host: String,
    #[serde(default = "default_smtp_port")]
    pub(in crate::server) port: u16,
    #[serde(default)]
    pub(in crate::server) username: String,
    #[serde(default)]
    pub(in crate::server) from: String,
    #[serde(default = "default_true_bool")]
    pub(in crate::server) starttls: bool,
    /// Optional secret. When present + non-empty it is persisted; an omitted /
    /// empty value leaves the stored password untouched.
    #[serde(default)]
    pub(in crate::server) password: Option<String>,
}

pub(in crate::server) fn default_smtp_port() -> u16 {
    587
}

pub(in crate::server) fn default_true_bool() -> bool {
    true
}

/// `GET /api/email/transport` - the current non-secret SMTP transport config plus
/// a `passwordSet` flag. Never returns the password.
#[utoipa::path(
    get,
    path = "/api/email/transport",
    tag = "Notifications",
    summary = "Get the SMTP transport config (never the password)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_email_transport(
    State(_state): State<ServerState>,
) -> axum::response::Response {
    let prefs = ryu_email_send::current_transport_prefs();
    let password_set = crate::smtp_auth::password().is_some();
    let body = match prefs {
        Some(t) => json!({
            "host": t.host,
            "port": t.port,
            "username": t.username,
            "from": t.from,
            "starttls": t.starttls,
            "passwordSet": password_set,
        }),
        None => json!({
            "host": "",
            "port": default_smtp_port(),
            "username": "",
            "from": "",
            "starttls": true,
            "passwordSet": password_set,
        }),
    };
    (StatusCode::OK, Json(body)).into_response()
}

/// `PUT /api/email/transport` - persist the non-secret transport config (and,
/// when supplied, the password) and apply both to the in-process sink without a
/// restart.
#[utoipa::path(
    put,
    path = "/api/email/transport",
    tag = "Notifications",
    summary = "Set the SMTP transport config",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn put_email_transport(
    State(state): State<ServerState>,
    Json(body): Json<EmailTransportBody>,
) -> axum::response::Response {
    let transport = ryu_email_send::TransportPrefs {
        host: body.host.clone(),
        port: body.port,
        username: body.username.clone(),
        from: body.from.clone(),
        starttls: body.starttls,
    };
    let json = match serde_json::to_string(&transport) {
        Ok(j) => j,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
                .into_response();
        }
    };
    if let Err(e) = state
        .preferences
        .set(ryu_email_send::SMTP_TRANSPORT_PREF_KEY, &json)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response();
    }
    ryu_email_send::set_transport(
        &body.host,
        body.port,
        &body.username,
        &body.from,
        body.starttls,
    );

    // Persist the password only when supplied + non-empty (a blank/omitted value
    // leaves the stored secret intact).
    if let Some(password) = body.password.as_deref() {
        if !password.trim().is_empty() {
            if let Err(e) = state
                .preferences
                .set(crate::smtp_auth::SMTP_PASSWORD_PREF_KEY, password)
                .await
            {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                )
                    .into_response();
            }
            crate::smtp_auth::set_password(password);
        }
    }

    (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
}

/// Body for `POST /api/email/test`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct EmailTestBody {
    pub(in crate::server) to: String,
}

/// `POST /api/email/test` - send a test email over the currently-configured
/// transport, surfacing any [`ryu_email_send::EmailError`] to the caller.
#[utoipa::path(
    post,
    path = "/api/email/test",
    tag = "Notifications",
    summary = "Send a test email through the configured transport",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn post_email_test(
    State(_state): State<ServerState>,
    Json(body): Json<EmailTestBody>,
) -> axum::response::Response {
    let Some(cfg) = ryu_email_send::resolve_transport() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "email transport is not configured" })),
        )
            .into_response();
    };
    // Rendered in the node's language, like the real alert emails it previews.
    let (subject, text) =
        crate::i18n::messages::email_test_text(crate::i18n::locale::node_locale().await);
    match ryu_email_send::send_email_alert(&cfg, body.to.trim(), &subject, &text).await {
        Ok(id) => (StatusCode::OK, Json(json!({ "ok": true, "messageId": id }))).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}
