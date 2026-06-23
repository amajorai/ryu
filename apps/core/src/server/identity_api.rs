//! HTTP API for the Identity Vault connection lifecycle (`/api/identities/*`,
//! Unit 2, #520).
//!
//! Surfaces the kernel-style `connections.*` lifecycle over the Unit 0
//! [`IdentityStore`](crate::identity::IdentityStore) global and the Unit 1
//! [`CredentialSourceRegistry`](crate::identity::CredentialSourceRegistry): list
//! profiles, create a per-domain connection, begin a login flow, poll its status,
//! import manual credential state, and delete a connection. See
//! `docs/identity-vault-spec.md` §6.
//!
//! ## Hard invariant (spec §6)
//!
//! **No response body ever contains `encrypted_state` or decrypted credentials.**
//! This holds structurally: [`ConnectionRecord`](crate::identity::ConnectionRecord)
//! `#[serde(skip)]`s `encrypted_state` and its `SealedState` is not `Serialize`,
//! so serializing a record (or a [`Profile`](crate::identity::Profile)) can never
//! emit the sealed blob (Unit 0 proves this). No handler here calls `open_state`
//! or `expose` — decryption is tool-call-time, never API-time. The one endpoint
//! that *receives* plaintext (`import`) wraps it into a `SecretState` and never
//! logs the raw body.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;
use crate::identity::{CredentialBackend, CredentialSourceRegistry, LoginKind, SecretState};

/// Uniform JSON error body for an operational failure (store unavailable,
/// connection not found, bad request).
fn err(status: StatusCode, e: impl std::fmt::Display) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": e.to_string() })))
}

/// The published Unit 0 store, or a 503 if identity is unavailable (the store
/// failed to open at startup). Off-`ServerState` published global so the
/// health-check loop and elicitation seam reach the same instance.
fn store() -> Result<&'static crate::identity::IdentityStore, (StatusCode, Json<Value>)> {
    crate::identity::global().ok_or_else(|| {
        err(
            StatusCode::SERVICE_UNAVAILABLE,
            "identity store not initialized",
        )
    })
}

/// `GET /api/identities` — list every profile with its per-domain connections
/// (status only). The sealed credential state is structurally absent from the
/// response (see the module invariant).
#[utoipa::path(
    get,
    path = "/api/identities",
    tag = "Nodes",
    summary = "List identity profiles + connections (status only, no state)",
    responses((status = 200, description = "Profiles + connections", body = serde_json::Value))
)]
pub async fn list_identities(State(_state): State<ServerState>) -> impl IntoResponse {
    let store = match store() {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    match store.list_profiles().await {
        Ok(profiles) => (StatusCode::OK, Json(json!({ "profiles": profiles }))).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Body for `POST /api/identities/connections`.
#[derive(Debug, Deserialize)]
pub struct CreateConnectionBody {
    /// The identity profile this connection belongs to (the grouping key).
    pub profile_id: String,
    /// The domain this login is for (arbitrary string; no domain is special-cased).
    pub domain: String,
    /// Which `CredentialSource` backend captures it (`manual` default when absent).
    #[serde(default)]
    pub source: Option<String>,
}

/// `POST /api/identities/connections` — create a per-domain connection, starting
/// in `NEEDS_AUTH`/`IDLE` with no credential state.
#[utoipa::path(
    post,
    path = "/api/identities/connections",
    tag = "Nodes",
    summary = "Create a per-domain connection (starts NEEDS_AUTH)",
    request_body = serde_json::Value,
    responses((status = 200, description = "The created connection", body = serde_json::Value))
)]
pub async fn create_connection(
    State(_state): State<ServerState>,
    Json(body): Json<CreateConnectionBody>,
) -> impl IntoResponse {
    if body.profile_id.is_empty() || body.domain.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "profile_id and domain are required",
        )
        .into_response();
    }
    let store = match store() {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    match store
        .create(&body.profile_id, &body.domain, body.source.as_deref())
        .await
    {
        // `connection` is leak-safe: `encrypted_state` is `#[serde(skip)]`.
        Ok(connection) => {
            (StatusCode::OK, Json(json!({ "connection": connection }))).into_response()
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `POST /api/identities/connections/:id/login` — begin a login flow for the
/// connection, returning `{flow_id, kind}`. The backend is resolved from the
/// connection's recorded `source` (falling back to the per-domain registry), so
/// nothing is hardcoded. Flips the connection's flow status to `IN_PROGRESS`.
#[utoipa::path(
    post,
    path = "/api/identities/connections/{id}/login",
    tag = "Nodes",
    params(("id" = String, Path, description = "Connection id")),
    summary = "Begin a login flow → {flow_id, kind: hosted{url} | manual}",
    responses((status = 200, description = "The started login flow", body = serde_json::Value))
)]
pub async fn begin_login(
    State(_state): State<ServerState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let store = match store() {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    let connection = match store.get(&id).await {
        Ok(Some(c)) => c,
        Ok(None) => return err(StatusCode::NOT_FOUND, "connection not found").into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };

    // Prefer the connection's recorded backend; fall back to the per-domain
    // registry (default `manual`, env-overridable) when the stored id is unknown.
    let registry = CredentialSourceRegistry::from_env();
    let backend = CredentialBackend::from_id(&connection.source)
        .unwrap_or_else(|| registry.resolve(&connection.domain));

    let flow = match backend.begin_login(&connection.domain).await {
        Ok(flow) => flow,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };

    // Mark the transient flow position; the durable status stays NEEDS_AUTH
    // until credentials are imported.
    if let Err(e) = store
        .set_flow_status(&id, crate::identity::FlowStatus::InProgress)
        .await
    {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }

    // `LoginKind`/`LoginFlow` are intentionally not `Serialize`; hand-build the
    // wire shape so the URL (advisory) lands under a stable envelope.
    let kind = match flow.kind {
        LoginKind::Hosted { url } => json!({ "kind": "hosted", "url": url }),
        LoginKind::Manual => json!({ "kind": "manual" }),
    };
    (
        StatusCode::OK,
        Json(json!({ "flow_id": flow.flow_id, "kind": kind })),
    )
        .into_response()
}

/// `GET /api/identities/connections/:id` — poll a connection's status. Returns
/// the durable store truth (`{status, flow_status}`), **not** `source.poll()`:
/// the manual backend always reports `NEEDS_AUTH`, while `import_state` flips the
/// stored status to `AUTHENTICATED`, so the store is the source of truth here.
#[utoipa::path(
    get,
    path = "/api/identities/connections/{id}",
    tag = "Nodes",
    params(("id" = String, Path, description = "Connection id")),
    summary = "Poll a connection's status (status only, no state)",
    responses((status = 200, description = "The connection status", body = serde_json::Value))
)]
pub async fn poll_connection(
    State(_state): State<ServerState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let store = match store() {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    match store.get(&id).await {
        // `connection` is leak-safe (`encrypted_state` is `#[serde(skip)]`); we
        // also surface `status`/`flow_status` at the top level for convenience.
        Ok(Some(connection)) => (
            StatusCode::OK,
            Json(json!({
                "status": connection.status,
                "flow_status": connection.flow_status,
                "connection": connection,
            })),
        )
            .into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "connection not found").into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Body for `POST /api/identities/connections/:id/import` — the user-provided
/// credential plaintext (cookie/token/session JSON). Wrapped into a `SecretState`
/// on receipt; never logged.
#[derive(Debug, Deserialize)]
pub struct ImportConnectionBody {
    /// The raw credential state to seal. Accepted as a string (the cookie/token
    /// blob); the handler immediately wraps it in a redacted `SecretState`.
    pub state: String,
}

/// `POST /api/identities/connections/:id/import` — seal user-provided credential
/// state and flip the connection to `AUTHENTICATED`/`DONE`. The plaintext is
/// sealed by `import_state` before it touches disk and never appears in the
/// response or a log line.
#[utoipa::path(
    post,
    path = "/api/identities/connections/{id}/import",
    tag = "Nodes",
    params(("id" = String, Path, description = "Connection id")),
    summary = "Import + seal manual credential state → AUTHENTICATED",
    request_body = serde_json::Value,
    responses((status = 200, description = "The updated connection status", body = serde_json::Value))
)]
pub async fn import_connection(
    State(_state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<ImportConnectionBody>,
) -> impl IntoResponse {
    if body.state.is_empty() {
        return err(StatusCode::BAD_REQUEST, "state is required").into_response();
    }
    let store = match store() {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    // Wrap the plaintext in a redacted newtype immediately; the raw body is never
    // logged. `import_state` seals + persists + flips status in one call.
    let secret = SecretState::new(body.state);
    match store.import_state(&id, &secret).await {
        Ok(true) => {}
        Ok(false) => return err(StatusCode::NOT_FOUND, "connection not found").into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
    // Re-read for the (leak-safe) updated status.
    match store.get(&id).await {
        Ok(Some(connection)) => (
            StatusCode::OK,
            Json(json!({
                "status": connection.status,
                "flow_status": connection.flow_status,
                "connection": connection,
            })),
        )
            .into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "connection not found").into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `DELETE /api/identities/connections/:id` — remove a connection (and its sealed
/// state) from the vault.
#[utoipa::path(
    delete,
    path = "/api/identities/connections/{id}",
    tag = "Nodes",
    params(("id" = String, Path, description = "Connection id")),
    summary = "Delete a connection",
    responses((status = 200, description = "Deleted", body = serde_json::Value))
)]
pub async fn delete_connection(
    State(_state): State<ServerState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let store = match store() {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    match store.delete(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "deleted": true, "id": id }))).into_response(),
        Ok(false) => err(StatusCode::NOT_FOUND, "connection not found").into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}
