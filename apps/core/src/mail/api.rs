//! Axum routes for self-host inboxes. The shared REST contract mirrors the
//! managed mail router (`packages/api/src/routers/mail.ts`) so one desktop/web
//! client drives both planes.
//!
//! All routes except inbound are `RYU_TOKEN`-gated by the protected router. The
//! inbound webhook is public but HMAC-authed with the inbox's `inbound_secret`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;

use super::send::{self, SendRequest};
use super::store::MailStore;
use super::{mime, EmailMessage, InboxProvider};
use crate::server::ServerState;

/// Max inbound body we accept (25 MiB) — a forwarder posting a huge MIME blob
/// must not exhaust memory.
const MAX_INBOUND_BYTES: usize = 26_214_400;

/// Protected (RYU_TOKEN) mail routes.
pub fn protected_routes() -> Router<ServerState> {
    Router::new()
        .route("/api/mail/status", get(status))
        .route("/api/mail/inboxes", get(list_inboxes).post(create_inbox))
        .route(
            "/api/mail/inboxes/:id",
            get(get_inbox).patch(patch_inbox).delete(delete_inbox),
        )
        .route("/api/mail/inboxes/:id/rotate-secret", post(rotate_secret))
        .route("/api/mail/inboxes/:id/messages", get(list_messages))
        .route("/api/mail/inboxes/:id/send", post(send_message))
        .route("/api/mail/messages/:id", get(get_message))
        .route("/api/mail/attachments/:id", get(download_attachment))
}

/// Public, HMAC-authed inbound webhook.
pub fn public_routes() -> Router<ServerState> {
    Router::new().route("/api/mail/inbound/:id", post(inbound))
}

fn store(state: &ServerState) -> &MailStore {
    &state.mail
}

async fn status(State(state): State<ServerState>) -> Response {
    let send_configured = crate::email::resolve_transport().is_some();
    let count = store(&state).list_inboxes().await.map(|v| v.len()).unwrap_or(0);
    (
        StatusCode::OK,
        Json(json!({
            "configured": true,
            "domainMode": "byo",
            "sendConfigured": send_configured,
            "inbound": "webhook",
            "inboxCount": count,
        })),
    )
        .into_response()
}

async fn list_inboxes(State(state): State<ServerState>) -> Response {
    match store(&state).list_inboxes().await {
        Ok(v) => (StatusCode::OK, Json(json!({ "inboxes": v }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[derive(Deserialize)]
struct CreateInboxBody {
    name: String,
    address: String,
    #[serde(default)]
    provider: Option<String>,
}

async fn create_inbox(
    State(state): State<ServerState>,
    Json(body): Json<CreateInboxBody>,
) -> Response {
    let provider = match body.provider.as_deref() {
        Some("imap") => InboxProvider::Imap,
        _ => InboxProvider::Webhook,
    };
    if body.address.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "address is required");
    }
    match store(&state)
        .create_inbox(body.name.trim(), body.address.trim(), provider)
        .await
    {
        Ok(inbox) => (StatusCode::OK, Json(json!({ "inbox": inbox }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn get_inbox(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    match store(&state).get_inbox(&id).await {
        Ok(Some(inbox)) => (StatusCode::OK, Json(json!({ "inbox": inbox }))).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "inbox not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[derive(Deserialize)]
struct PatchInboxBody {
    name: Option<String>,
}

async fn patch_inbox(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<PatchInboxBody>,
) -> Response {
    if let Some(name) = body.name.as_deref() {
        if let Err(e) = store(&state).rename_inbox(&id, name.trim()).await {
            return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    }
    match store(&state).get_inbox(&id).await {
        Ok(Some(inbox)) => (StatusCode::OK, Json(json!({ "inbox": inbox }))).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "inbox not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn rotate_secret(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    match store(&state).rotate_secret(&id).await {
        Ok(secret) => (StatusCode::OK, Json(json!({ "inboundSecret": secret }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn delete_inbox(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    match store(&state).delete_inbox(&id).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn list_messages(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    match store(&state).list_messages(&id, 200).await {
        Ok(v) => (StatusCode::OK, Json(json!({ "messages": v }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn get_message(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    match store(&state).get_message(&id).await {
        Ok(Some(m)) => (StatusCode::OK, Json(json!({ "message": m }))).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "message not found"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[derive(Deserialize)]
struct SendBody {
    to: Vec<String>,
    #[serde(default)]
    cc: Vec<String>,
    subject: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    html: Option<String>,
    #[serde(default, rename = "inReplyTo")]
    in_reply_to: Option<String>,
}

async fn send_message(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<SendBody>,
) -> Response {
    if body.to.is_empty() {
        return err(StatusCode::BAD_REQUEST, "at least one recipient is required");
    }
    let req = SendRequest {
        to: body.to,
        cc: body.cc,
        subject: body.subject,
        text: body.text,
        html: body.html,
        in_reply_to: body.in_reply_to,
    };
    match send::send_from_inbox(store(&state), &id, req).await {
        Ok(m) => (StatusCode::OK, Json(json!({ "message": m }))).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, &e.to_string()),
    }
}

/// Public inbound webhook. HMAC-authed with the inbox's `inbound_secret` over the
/// raw body (`X-Ryu-Signature: sha256=<hex>`).
async fn inbound(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if body.len() > MAX_INBOUND_BYTES {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "message too large");
    }
    let inbox = match store(&state).get_inbox(&id).await {
        Ok(Some(inbox)) => inbox,
        Ok(None) => return err(StatusCode::NOT_FOUND, "inbox not found"),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };

    let provided = headers
        .get("x-ryu-signature")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().trim_start_matches("sha256=").to_string())
        .unwrap_or_default();
    let expected =
        crate::composio_triggers::hmac_sha256_hex(inbox.inbound_secret.as_bytes(), &body);
    if !ct_eq(provided.as_bytes(), expected.as_bytes()) {
        return err(StatusCode::UNAUTHORIZED, "invalid signature");
    }

    let Some(parsed) = mime::parse_raw(&body) else {
        return err(StatusCode::BAD_REQUEST, "unparseable message");
    };
    let msg = EmailMessage {
        id: uuid::Uuid::new_v4().to_string(),
        inbox_id: id,
        direction: "inbound".to_string(),
        message_id: parsed.message_id,
        in_reply_to: parsed.in_reply_to,
        from_addr: parsed.from_addr,
        to_addrs: parsed.to_addrs,
        cc_addrs: parsed.cc_addrs,
        subject: parsed.subject,
        text: parsed.text,
        html: parsed.html,
        provider_message_id: None,
        attachments: Vec::new(),
        created_at: Utc::now().to_rfc3339(),
    };
    match store(&state).insert_message(msg, parsed.attachments).await {
        Ok(m) => (StatusCode::OK, Json(json!({ "id": m.id }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// Serve an attachment as a forced download. The stored (attacker-controlled)
/// content-type is NOT used for the header — always `application/octet-stream`
/// with `Content-Disposition: attachment` so untrusted MIME never renders inline.
async fn download_attachment(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> Response {
    let Some((meta, path)) = store(&state).attachment_path(&id).await.ok().flatten() else {
        return err(StatusCode::NOT_FOUND, "attachment not found");
    };
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return err(StatusCode::NOT_FOUND, "attachment blob missing");
    };
    let safe_name = meta.filename.replace(['"', '\r', '\n'], "_");
    (
        StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{safe_name}\""),
            ),
        ],
        bytes,
    )
        .into_response()
}

/// Constant-time byte comparison (avoid leaking the HMAC via early-exit timing).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn err(code: StatusCode, message: &str) -> Response {
    (code, Json(json!({ "error": message }))).into_response()
}
