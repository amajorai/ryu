//! Axum routes for self-host inboxes. Tracer copy of `apps/core/src/mail/api.rs`,
//! adapted for the out-of-process sidecar:
//!   - `State<ServerState>` → `State<MailState>` (a local single-field state).
//!   - `crate::composio_triggers::hmac_sha256_hex` → inlined `hmac_sha256_hex`
//!     below (same HMAC-SHA256 construction over `sha2::Sha256`).
//!
//! The route PATHS (`/api/mail/*`) are byte-identical to Core's so Core can proxy
//! straight through.
//!
//! ## Auth (shared-secret bearer, mirrors the gateway sidecar)
//! The `protected_routes()` are guarded by [`require_mail_token`], a small
//! shared-secret bearer middleware layered in `main`: Core injects `RYU_MAIL_TOKEN`
//! into the child's spawn env (the way the gateway sidecar receives `CORE_TOKEN`)
//! and re-stamps `Authorization: Bearer <RYU_MAIL_TOKEN>` on every proxied hop, so
//! a request that did NOT come through Core (any other loopback process on a shared
//! host) is rejected with 401. The gate is **fail-closed**: with no token
//! configured every protected route rejects. The inbound webhook stays on its own
//! per-inbox HMAC (public in Core too), so it is reachable tokenless.

use axum::body::Bytes;
use axum::extract::{Path, Request, State};
use axum::http::{header::AUTHORIZATION, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;

use super::send::{self, SendRequest};
use super::store::MailStore;
use super::{mime, EmailMessage, InboxProvider};
use crate::MailState;

/// Max inbound body we accept (25 MiB).
const MAX_INBOUND_BYTES: usize = 26_214_400;

/// Shared-secret bearer gate for the protected mail routes.
///
/// `expected` is the `RYU_MAIL_TOKEN` Core resolved and injected into this child's
/// env (resolved in `main`). The request must carry `Authorization: Bearer <token>`
/// equal to it — Core re-stamps exactly this header on every proxied hop, so only
/// requests that passed through Core's own `require_auth` reach the handlers.
///
/// **Fail-closed:** `expected == None` (no token configured) rejects every request
/// with 401 rather than falling open, so a bare-run or misconfigured sidecar never
/// serves stored mail unauthenticated. (The inbound webhook is on `public_routes`
/// and is not layered with this gate, so it stays reachable via its per-inbox HMAC.)
pub(crate) async fn require_mail_token(
    req: Request,
    next: Next,
    expected: Option<&str>,
) -> Response {
    let auth = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if bearer_ok(auth, expected) {
        next.run(req).await
    } else {
        err(StatusCode::UNAUTHORIZED, "unauthorized")
    }
}

/// Pure bearer check behind [`require_mail_token`] (factored out so the auth
/// decision is unit-testable without constructing an axum `Request`/`Next`).
///
/// Returns `true` only when `expected` is a non-empty token AND `auth_header` is
/// exactly `Bearer <expected>` (constant-time compared). A `None`/empty `expected`
/// is the **fail-closed** case → always `false`.
pub(crate) fn bearer_ok(auth_header: Option<&str>, expected: Option<&str>) -> bool {
    let Some(expected) = expected.filter(|t| !t.is_empty()) else {
        return false;
    };
    let provided = auth_header
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    ct_eq(provided.as_bytes(), expected.as_bytes())
}

/// Protected (proxied-by-Core) mail routes. Layered with [`require_mail_token`] in
/// `main`; Core stays the auth front and forwards the already-authed request with a
/// re-stamped shared-secret bearer on loopback.
pub fn protected_routes() -> Router<MailState> {
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
pub fn public_routes() -> Router<MailState> {
    Router::new().route("/api/mail/inbound/:id", post(inbound))
}

fn store(state: &MailState) -> &MailStore {
    &state.mail
}

async fn status(State(state): State<MailState>) -> Response {
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

async fn list_inboxes(State(state): State<MailState>) -> Response {
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
    State(state): State<MailState>,
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

async fn get_inbox(State(state): State<MailState>, Path(id): Path<String>) -> Response {
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
    State(state): State<MailState>,
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

async fn rotate_secret(State(state): State<MailState>, Path(id): Path<String>) -> Response {
    match store(&state).rotate_secret(&id).await {
        Ok(secret) => (StatusCode::OK, Json(json!({ "inboundSecret": secret }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn delete_inbox(State(state): State<MailState>, Path(id): Path<String>) -> Response {
    match store(&state).delete_inbox(&id).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn list_messages(State(state): State<MailState>, Path(id): Path<String>) -> Response {
    match store(&state).list_messages(&id, 200).await {
        Ok(v) => (StatusCode::OK, Json(json!({ "messages": v }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn get_message(State(state): State<MailState>, Path(id): Path<String>) -> Response {
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
    State(state): State<MailState>,
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
    State(state): State<MailState>,
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
    let expected = hmac_sha256_hex(inbox.inbound_secret.as_bytes(), &body);
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

/// Serve an attachment as a forced download (always octet-stream, never inline).
async fn download_attachment(
    State(state): State<MailState>,
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

/// Inlined from `apps/core/src/composio_triggers::hmac_sha256_hex`. Standard HMAC
/// construction over `sha2::Sha256`, lowercase-hex encoded. (Uses `format!("{:x}")`
/// on the digest instead of the `hex` crate to avoid pulling a new dependency.)
fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    const BLOCK_SIZE: usize = 64;
    let mut block_key = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let hashed = Sha256::digest(key);
        block_key[..hashed.len()].copy_from_slice(&hashed);
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK_SIZE];
    let mut opad = [0x5cu8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] ^= block_key[i];
        opad[i] ^= block_key[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    format!("{:x}", outer.finalize())
}

fn err(code: StatusCode, message: &str) -> Response {
    (code, Json(json!({ "error": message }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::bearer_ok;

    #[test]
    fn bearer_ok_fails_closed_without_a_configured_token() {
        // No token configured (bare-run / misconfigured sidecar) ⇒ reject even a
        // well-formed bearer. This is the fix: the sidecar is never open.
        assert!(!bearer_ok(Some("Bearer anything"), None));
        assert!(!bearer_ok(Some("Bearer anything"), Some("")));
        // …and of course a missing header stays rejected.
        assert!(!bearer_ok(None, None));
    }

    #[test]
    fn bearer_ok_requires_the_exact_shared_secret() {
        let expected = Some("s3cret-node-token");
        // The reviewer's attack: a direct caller with no / wrong bearer is rejected.
        assert!(!bearer_ok(None, expected));
        assert!(!bearer_ok(Some(""), expected));
        assert!(!bearer_ok(Some("s3cret-node-token"), expected)); // missing "Bearer "
        assert!(!bearer_ok(Some("Bearer wrong"), expected));
        assert!(!bearer_ok(Some("Bearer s3cret-node-token-x"), expected)); // length differs
        // Only Core's re-stamped exact bearer passes.
        assert!(bearer_ok(Some("Bearer s3cret-node-token"), expected));
    }
}
