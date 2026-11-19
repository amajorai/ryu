//! One-time share links and inbound secret-request links
//! ([`crate::vault::shared::links`]).
//!
//! * `POST /api/vault/shares` shares a vault value (`read`; never one behind
//!   a control group) or a wrapping token's response (consuming the token).
//! * `POST /api/vault/share-requests` asks someone for a value to be written
//!   to a vault key (`write` on it now; the claim re-checks through the
//!   normal write path).
//! * `POST /api/vault/credential-requests` asks someone for an agent's
//!   sign-in to one site ([`credential`]); its claim saves an agent account.
//! * `GET /api/vault/shares`, `GET …/{id}`, `POST …/{id}/claim`,
//!   `DELETE …/{id}` list, inspect, claim, and revoke the caller's links
//!   (configuration managers see every link).
//!
//! Team, organization and project values live on the control plane and can't
//! be shared through a link yet.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::identity_verify::VerifiedCaller;
use crate::server::vault_api::{
    control_group_required, coords_for, invalid_request, respond, vault_error, CoordsBody, Ctx,
};
use crate::server::{json_error, ServerState};
use crate::vault::policy::Capability;
use crate::vault::shared::links::{self as sharing, client::ControlPlane, ShareLinkInfo};
use crate::vault::VaultError;

/// The sharing routes (merged into the protected vault router).
pub fn sharing_routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    let body =
        || axum::extract::DefaultBodyLimit::max(crate::server::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route(
            "/api/vault/shares",
            get(share_list).post(share_create).layer(body()),
        )
        .route(
            "/api/vault/share-requests",
            post(share_request_create).layer(body()),
        )
        .route("/api/vault/shares/:id", get(share_get).delete(share_revoke))
        .route("/api/vault/shares/:id/claim", post(share_claim))
        .route(
            "/api/vault/credential-requests",
            post(credential::credential_request_create).layer(body()),
        )
}

#[path = "credential_request_routes.rs"]
pub(crate) mod credential;

fn cloud() -> Result<ControlPlane, Response> {
    ControlPlane::current().map_err(|error| {
        json_error(
            StatusCode::CONFLICT,
            format!("vault_share_unavailable: {error}"),
        )
    })
}

/// A Ryu Cloud failure is a gateway problem, not the caller's.
fn link_error(error: anyhow::Error) -> Response {
    if error.downcast_ref::<VaultError>().is_some() {
        return vault_error(error);
    }
    json_error(
        StatusCode::BAD_GATEWAY,
        format!("vault_share_unavailable: {error:#}"),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(flatten)]
    coords: CoordsBody,
    #[serde(default)]
    version: Option<i64>,
    /// Share a wrapping token's response instead of a vault value.
    #[serde(default)]
    wrap_token: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    ttl_secs: Option<i64>,
}

/// POST /api/vault/shares.
#[utoipa::path(post, path = "/api/vault/shares", tag = "Vault",
    summary = "Create a one-time share link for a vault value (read) or a wrapping token",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "The link, returned once (its #fragment is the key)", body = serde_json::Value),
        (status = 409, description = "This node is not connected to Ryu Cloud", body = serde_json::Value),
    ))]
pub async fn share_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<ShareLinkBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let actor = ctx.actor();
    // Authorize first, and reach Ryu Cloud before revealing a value or
    // consuming a wrapping token, so a refusal costs nothing.
    let coords = match (&body.wrap_token, &body.name) {
        (Some(_), None) => None,
        (None, Some(name)) => {
            if ctx.shared_remote(body.coords.scope) {
                return invalid_request(
                    "team, organization, and project values can't be shared through a link yet",
                );
            }
            let coords = match coords_for(&ctx, name, body.coords) {
                Ok(coords) => coords,
                Err(response) => return response,
            };
            if let Err(response) = ctx.require(&coords, Capability::Read) {
                return response;
            }
            if ctx.read_control_group(&coords).is_some() {
                return control_group_required(&coords.policy_key());
            }
            Some(coords)
        }
        _ => return invalid_request("give exactly one of name and wrapToken"),
    };
    let cloud = match cloud() {
        Ok(cloud) => cloud,
        Err(response) => return response,
    };
    let (name, secret) = match (coords, &body.wrap_token) {
        (Some(coords), _) => match ctx.store.reveal(&coords, body.version, &actor).await {
            Ok(value) => (Some(coords.name.clone()), Value::String(value)),
            Err(error) => return vault_error(error),
        },
        (None, Some(token)) => match ctx.store.wrap_unwrap(token.trim()).await {
            Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => (None, value),
                Err(error) => return vault_error(error.into()),
            },
            Err(error) => return vault_error(error),
        },
        (None, None) => return invalid_request("give exactly one of name and wrapToken"),
    };
    match sharing::share(
        ctx.store,
        &cloud,
        (name.as_deref(), secret),
        (body.label.as_deref(), body.ttl_secs),
        &actor,
    )
    .await
    {
        Ok(link) => respond(json!({ "link": link })),
        Err(error) => link_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRequestBody {
    name: String,
    #[serde(flatten)]
    coords: CoordsBody,
    label: String,
    #[serde(default)]
    ttl_secs: Option<i64>,
}

/// POST /api/vault/share-requests.
#[utoipa::path(post, path = "/api/vault/share-requests", tag = "Vault",
    summary = "Create a one-time link that asks someone for a value (write on the target)",
    request_body = serde_json::Value,
    responses((status = 200, description = "The link", body = serde_json::Value)))]
pub async fn share_request_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<ShareRequestBody>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if ctx.shared_remote(body.coords.scope) {
        return invalid_request(
            "team, organization, and project values can't be requested through a link yet",
        );
    }
    let coords = match coords_for(&ctx, &body.name, body.coords) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    if let Err(response) = ctx.require(&coords, Capability::Write) {
        return response;
    }
    let cloud = match cloud() {
        Ok(cloud) => cloud,
        Err(response) => return response,
    };
    let target = json!({
        "name": coords.name,
        "scope": coords.scope,
        "scopeId": coords.scope_id,
        "binding": coords.binding,
        "environment": coords.environment,
        "path": coords.path,
    });
    match sharing::request(
        ctx.store,
        &cloud,
        target,
        (&body.label, body.ttl_secs),
        &ctx.actor(),
    )
    .await
    {
        Ok(link) => respond(json!({ "link": link })),
        Err(error) => link_error(error),
    }
}

/// The caller's own links, or all of them for a configuration manager.
fn visible(ctx: &Ctx, link: &ShareLinkInfo) -> bool {
    ctx.manager || link.created_by == ctx.actor().id
}

async fn own_link(ctx: &Ctx, id: &str) -> Result<ShareLinkInfo, Response> {
    let (link, _) = ctx.store.share_link_get(id).await.map_err(vault_error)?;
    if !visible(ctx, &link) {
        return Err(vault_error(
            VaultError::NotFound(format!("share link `{id}`")).into(),
        ));
    }
    Ok(link)
}

/// GET /api/vault/shares.
#[utoipa::path(get, path = "/api/vault/shares", tag = "Vault",
    summary = "List share and request links (never their keys or answers)",
    responses((status = 200, description = "Links", body = serde_json::Value)))]
pub async fn share_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let creator = if ctx.manager { None } else { ctx.actor().id };
    match ctx.store.share_link_list(creator.as_deref()).await {
        Ok(links) => respond(json!({ "links": links })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/shares/{id}.
#[utoipa::path(get, path = "/api/vault/shares/{id}", tag = "Vault",
    summary = "One link with its state at Ryu Cloud",
    params(("id" = String, Path, description = "Link id")),
    responses((status = 200, description = "Link", body = serde_json::Value)))]
pub async fn share_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    let link = match own_link(&ctx, &id).await {
        Ok(link) => link,
        Err(response) => return response,
    };
    let remote = match cloud() {
        Ok(cloud) => sharing::client::status(&cloud, &id).await.ok(),
        Err(_) => None,
    };
    respond(json!({ "link": link, "remote": remote }))
}

/// POST /api/vault/shares/{id}/claim.
#[utoipa::path(post, path = "/api/vault/shares/{id}/claim", tag = "Vault",
    summary = "Write a request's answer to its vault key (through the normal write path)",
    params(("id" = String, Path, description = "Request link id")),
    responses(
        (status = 200, description = "Written (or a change request was opened)", body = serde_json::Value),
        (status = 409, description = "Not answered yet, or already claimed", body = serde_json::Value),
    ))]
pub async fn share_claim(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller.clone(), &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = own_link(&ctx, &id).await {
        return response;
    }
    let cloud = match cloud() {
        Ok(cloud) => cloud,
        Err(response) => return response,
    };
    let actor = ctx.actor();
    let (link, answer) = match sharing::collect_answer(ctx.store, &cloud, &id, &actor).await {
        Ok(Some(found)) => found,
        Ok(None) => {
            return json_error(
                StatusCode::CONFLICT,
                "vault_share_pending: nobody has answered this request yet".to_owned(),
            )
        }
        Err(error) => return link_error(error),
    };
    if let Some(target) = sharing::credential::target_of(link.target.as_ref()) {
        return credential::claim_credential(&state, &ctx, (&link, target), &answer).await;
    }
    let mut body = link.target.clone().unwrap_or_else(|| json!({}));
    let Some(name) = body.get("name").and_then(Value::as_str).map(str::to_owned) else {
        return invalid_request("the request has no target");
    };
    body["value"] = json!(answer.as_str());
    let written = crate::server::vault_api::put_secret(
        State(state),
        Extension(caller),
        headers,
        Path(name),
        Json(body),
    )
    .await;
    if !written.status().is_success() {
        // The answer stays sealed here, so fixing access and claiming again
        // still works.
        return written;
    }
    if let Err(error) = sharing::finish_claim(ctx.store, &id, &actor).await {
        return vault_error(error);
    }
    written.into_response()
}

/// DELETE /api/vault/shares/{id}.
#[utoipa::path(delete, path = "/api/vault/shares/{id}", tag = "Vault",
    summary = "Revoke an unused link",
    params(("id" = String, Path, description = "Link id")),
    responses((status = 200, description = "Revoked", body = serde_json::Value)))]
pub async fn share_revoke(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let ctx = match Ctx::load(&state, caller, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Err(response) = own_link(&ctx, &id).await {
        return response;
    }
    let cloud = match cloud() {
        Ok(cloud) => cloud,
        Err(response) => return response,
    };
    match sharing::revoke(ctx.store, &cloud, &id, &ctx.actor()).await {
        Ok(revoked) => respond(json!({ "revoked": revoked })),
        Err(error) => link_error(error),
    }
}

#[cfg(test)]
#[path = "share_routes_tests.rs"]
mod tests;
