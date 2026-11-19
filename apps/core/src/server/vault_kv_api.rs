//! KV v2 metadata routes for vault values (HashiCorp Vault / OpenBao parity).
//!
//! * `GET   /api/vault/secrets/{name}/metadata`: detailed metadata (`list`);
//! * `PATCH /api/vault/secrets/{name}/metadata`: JSON merge patch of the
//!   metadata, no new value version, `expectedMetadataVersion` CAS (`write`);
//! * `PATCH /api/vault/secrets/{name}/data`: JSON merge patch of a
//!   JSON-object value, written as a new version under CAS (`write`);
//! * `GET   /api/vault/secrets/{name}/subkeys`: the value's key structure
//!   with `null` leaves (`read`; the value itself is never returned). It
//!   decrypts the value, so a scoped OAuth client needs vault-write consent
//!   for it, as for `reveal` (see `route_policy`);
//! * `POST  /api/vault/secrets/{name}/versions/delete|undelete`: per-version
//!   soft delete (`delete`) and undelete (`write`).
//!
//! Authorization reuses [`super::vault_api::Ctx`] per `ENV/folder/NAME` key.
//! Mutations in a protected environment need `admin` there, like the other
//! version operations, because change requests cover writes and deletes only.
//! Values that live in the control plane (team/org values on a managed node)
//! are forwarded there (`super::vault_kv_shared`), except the detailed
//! metadata read: the control plane does not serve it, so Core answers `501`.

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, patch, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{
    coords_for, invalid_request, parse_body, protected_denied, protected_environment, respond,
    shared_value, to_wire, vault_error, CoordsBody, CoordsQuery, Ctx, MAX_REQUEST_BODY_BYTES,
};
use super::vault_kv_shared::{self as forward, send};
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::SecretCoords;
use crate::vault::policy::Capability;

/// KV v2 metadata routes (node bearer).
pub fn routes() -> Router<ServerState> {
    let body = || DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES);
    Router::new()
        .route(
            "/api/vault/secrets/:name/metadata",
            get(get_metadata).patch(patch_metadata).layer(body()),
        )
        .route(
            "/api/vault/secrets/:name/data",
            patch(patch_data).layer(body()),
        )
        .route("/api/vault/secrets/:name/subkeys", get(subkeys))
        .route(
            "/api/vault/secrets/:name/versions/delete",
            post(delete_versions).layer(body()),
        )
        .route(
            "/api/vault/secrets/:name/versions/undelete",
            post(undelete_versions).layer(body()),
        )
}

// ── Wire helpers ──────────────────────────────────────────────────────────

/// Remove `metadata.customMetadata` from a request body before the RFC 3339
/// `…At` conversion: its keys are user-defined, so a key such as
/// `reviewedAt` must stay a plain string.
pub(super) fn take_custom_metadata(body: &mut Value) -> Option<Value> {
    body.get_mut("metadata")
        .and_then(Value::as_object_mut)
        .and_then(|metadata| metadata.remove("customMetadata"))
}

/// Put back what [`take_custom_metadata`] removed.
pub(super) fn restore_custom_metadata(metadata: &mut Option<Value>, custom: Option<Value>) {
    let Some(custom) = custom else {
        return;
    };
    if let Some(object) = metadata.get_or_insert_with(|| json!({})).as_object_mut() {
        object.insert("customMetadata".into(), custom);
    }
}

fn shared_unsupported() -> Response {
    json_error(
        StatusCode::NOT_IMPLEMENTED,
        "vault_unsupported: this operation is not available for control-plane shared values yet"
            .to_owned(),
    )
}

/// Where a request goes: this node's store, or the control plane for a
/// team or org value on a managed node.
enum Target {
    Local(Ctx, SecretCoords),
    Shared(Ctx, CoordsBody),
}

/// Load the principal and decide the target, or answer early. The name is
/// checked on both paths ([`shared_value`]).
async fn target(
    state: &ServerState,
    caller: Option<VerifiedCaller>,
    headers: &HeaderMap,
    name: &str,
    body: CoordsBody,
) -> Result<Target, Response> {
    let ctx = Ctx::load(state, caller, headers).await?;
    if shared_value(&ctx, name, body.scope)? {
        return Ok(Target::Shared(ctx, body));
    }
    let coords = coords_for(&ctx, name, body)?;
    Ok(Target::Local(ctx, coords))
}

/// `capability` on the value, plus `admin` in a protected environment.
async fn require_mutation(
    ctx: &Ctx,
    coords: &SecretCoords,
    capability: Capability,
) -> Result<(), Response> {
    ctx.require(coords, capability)?;
    match protected_environment(ctx, &coords.environment).await? {
        Some(_) if !ctx.caps(coords).contains(&Capability::Admin) => {
            Err(protected_denied(&coords.environment))
        }
        _ => Ok(()),
    }
}

// ── Metadata ──────────────────────────────────────────────────────────────

/// GET /api/vault/secrets/{name}/metadata returns detailed metadata.
#[utoipa::path(
    get,
    path = "/api/vault/secrets/{name}/metadata",
    tag = "Vault",
    summary = "Detailed metadata and version summaries for one value (never the value)",
    params(("name" = String, Path, description = "Secret name")),
    responses(
        (status = 200, description = "Metadata, metadataVersion, and versions", body = serde_json::Value),
        (status = 404, description = "No such value", body = serde_json::Value),
    )
)]
pub async fn get_metadata(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<CoordsQuery>,
) -> Response {
    let (ctx, coords) = match target(&state, caller, &headers, &name, query.into()).await {
        Ok(Target::Local(ctx, coords)) => (ctx, coords),
        Ok(Target::Shared(..)) => return shared_unsupported(),
        Err(response) => return response,
    };
    if let Err(response) = ctx.require(&coords, Capability::List) {
        return response;
    }
    let info = match ctx.store.secret_info(&coords).await {
        Ok(Some(info)) => info,
        Ok(None) => return vault_error(crate::vault::VaultError::NotFound("secret".into()).into()),
        Err(error) => return vault_error(error),
    };
    match ctx.store.list_versions(&coords).await {
        Ok(versions) => respond(json!({
            "secret": to_wire(&ctx, info),
            "versions": versions,
        })),
        Err(error) => vault_error(error),
    }
}

/// Body of `PATCH /api/vault/secrets/{name}/metadata`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataPatchBody {
    #[serde(flatten)]
    coords: CoordsBody,
    /// RFC 7386 merge patch over the metadata object.
    #[serde(default)]
    metadata: Option<Value>,
    #[serde(default)]
    expected_metadata_version: Option<i64>,
}

/// PATCH /api/vault/secrets/{name}/metadata merge-patches metadata.
#[utoipa::path(
    patch,
    path = "/api/vault/secrets/{name}/metadata",
    tag = "Vault",
    summary = "JSON merge patch of a value's metadata without writing a new version",
    params(("name" = String, Path, description = "Secret name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Updated metadata", body = serde_json::Value),
        (status = 409, description = "expectedMetadataVersion is stale", body = serde_json::Value),
    )
)]
pub async fn patch_metadata(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let custom = take_custom_metadata(&mut body);
    let mut body: MetadataPatchBody = match parse_body(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    restore_custom_metadata(&mut body.metadata, custom);
    let Some(patch) = body.metadata.filter(Value::is_object) else {
        return invalid_request("metadata must be a JSON object (an RFC 7386 merge patch)");
    };
    let (ctx, coords) = match target(&state, caller, &headers, &name, body.coords).await {
        Ok(Target::Local(ctx, coords)) => (ctx, coords),
        Ok(Target::Shared(ctx, coords)) => {
            let scope_id = ctx.shared_scope_id(&coords);
            let expected = body.expected_metadata_version;
            let request = forward::metadata_patch(&scope_id, &name, &coords, patch, expected);
            return send(&ctx, request).await;
        }
        Err(response) => return response,
    };
    if let Err(response) = require_mutation(&ctx, &coords, Capability::Write).await {
        return response;
    }
    match ctx
        .store
        .patch_metadata(coords, &patch, body.expected_metadata_version, &ctx.actor())
        .await
    {
        Ok(info) => respond(json!({ "ok": true, "secret": to_wire(&ctx, info) })),
        Err(error) => vault_error(error),
    }
}

// ── JSON values ───────────────────────────────────────────────────────────

/// Body of `PATCH /api/vault/secrets/{name}/data`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataPatchBody {
    #[serde(flatten)]
    coords: CoordsBody,
    /// RFC 7386 merge patch over the stored JSON object.
    patch: Value,
    #[serde(default)]
    expected_version: Option<i64>,
}

/// PATCH /api/vault/secrets/{name}/data merge-patches a JSON-object value.
#[utoipa::path(
    patch,
    path = "/api/vault/secrets/{name}/data",
    tag = "Vault",
    summary = "JSON merge patch of a JSON-object value, written as a new version (value never returned)",
    params(("name" = String, Path, description = "Secret name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "New version metadata", body = serde_json::Value),
        (status = 400, description = "The stored value is not a JSON object", body = serde_json::Value),
        (status = 409, description = "expectedVersion is stale", body = serde_json::Value),
    )
)]
pub async fn patch_data(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    // Value keys are user data: no `…At` timestamp conversion.
    let body: DataPatchBody = match serde_json::from_value(body) {
        Ok(body) => body,
        Err(error) => return invalid_request(&error.to_string()),
    };
    if !body.patch.is_object() {
        return invalid_request("patch must be a JSON object (an RFC 7386 merge patch)");
    }
    let (ctx, coords) = match target(&state, caller, &headers, &name, body.coords).await {
        Ok(Target::Local(ctx, coords)) => (ctx, coords),
        Ok(Target::Shared(ctx, coords)) => {
            let scope_id = ctx.shared_scope_id(&coords);
            let expected = body.expected_version;
            let request = forward::data_patch(&scope_id, &name, &coords, body.patch, expected);
            return send(&ctx, request).await;
        }
        Err(response) => return response,
    };
    if let Err(response) = require_mutation(&ctx, &coords, Capability::Write).await {
        return response;
    }
    // Parameter constraints apply to the merged value, as for a full write
    // (a patch can set a disallowed key or remove a required one).
    let constrained = ctx.write_parameters_constrained(&coords);
    let checked = coords.clone();
    let check = |merged: &str| match constrained {
        true => ctx
            .write_parameters_violation(&checked, merged)
            .map_or(Ok(()), |message| {
                Err(format!("{message} on `{}`", checked.policy_key()))
            }),
        false => Ok(()),
    };
    match ctx
        .store
        .patch_value_checked(
            coords,
            &body.patch,
            body.expected_version,
            &ctx.actor(),
            check,
        )
        .await
    {
        Ok(info) => respond(json!({ "ok": true, "secret": to_wire(&ctx, info) })),
        Err(error) => vault_error(error),
    }
}

/// Query of `GET /api/vault/secrets/{name}/subkeys`.
#[derive(Debug, Default, Deserialize)]
pub struct SubkeysQuery {
    /// Maximum nesting depth; `0` (default) is unlimited.
    #[serde(default)]
    depth: Option<usize>,
}

/// GET /api/vault/secrets/{name}/subkeys returns a value's key structure.
#[utoipa::path(
    get,
    path = "/api/vault/secrets/{name}/subkeys",
    tag = "Vault",
    summary = "Key structure of a JSON-object value with null leaves (requires read; audited)",
    params(
        ("name" = String, Path, description = "Secret name"),
        ("depth" = Option<usize>, Query, description = "Maximum depth; 0 is unlimited"),
    ),
    responses(
        (status = 200, description = "Version and subkeys", body = serde_json::Value),
        (status = 400, description = "The stored value is not a JSON object", body = serde_json::Value),
    )
)]
pub async fn subkeys(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<CoordsQuery>,
    Query(depth): Query<SubkeysQuery>,
) -> Response {
    let (ctx, coords) = match target(&state, caller, &headers, &name, query.into()).await {
        Ok(Target::Local(ctx, coords)) => (ctx, coords),
        Ok(Target::Shared(ctx, coords)) => {
            let scope_id = ctx.shared_scope_id(&coords);
            let request = forward::subkeys(&scope_id, &name, &coords, depth.depth);
            return send(&ctx, request).await;
        }
        Err(response) => return response,
    };
    if let Err(response) = ctx.require(&coords, Capability::Read) {
        return response;
    }
    // The key structure is derived from the plaintext, so a control group on
    // the value gates it like /reveal (which opens the request).
    if let Err(response) = ctx.require_ungated_read(&coords.policy_key()) {
        return response;
    }
    match ctx
        .store
        .subkeys(&coords, depth.depth.unwrap_or(0), &ctx.actor())
        .await
    {
        Ok((version, subkeys)) => respond(json!({ "version": version, "subkeys": subkeys })),
        Err(error) => vault_error(error),
    }
}

// ── Per-version soft delete ───────────────────────────────────────────────

/// Body of the per-version delete/undelete routes.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionsBody {
    #[serde(flatten)]
    coords: CoordsBody,
    versions: Vec<i64>,
}

async fn version_state(
    state: ServerState,
    caller: Option<VerifiedCaller>,
    headers: HeaderMap,
    name: String,
    body: Value,
    delete: bool,
) -> Response {
    let body: VersionsBody = match serde_json::from_value(body) {
        Ok(body) => body,
        Err(error) => return invalid_request(&error.to_string()),
    };
    let (ctx, coords) = match target(&state, caller, &headers, &name, body.coords).await {
        Ok(Target::Local(ctx, coords)) => (ctx, coords),
        Ok(Target::Shared(ctx, coords)) => {
            let scope_id = ctx.shared_scope_id(&coords);
            let request = forward::versions(&scope_id, &name, &coords, &body.versions, delete);
            return send(&ctx, request).await;
        }
        Err(response) => return response,
    };
    let capability = if delete {
        Capability::Delete
    } else {
        Capability::Write
    };
    if let Err(response) = require_mutation(&ctx, &coords, capability).await {
        return response;
    }
    let actor = ctx.actor();
    let result = if delete {
        ctx.store
            .delete_versions(coords, &body.versions, &actor)
            .await
    } else {
        ctx.store
            .undelete_versions(coords, &body.versions, &actor)
            .await
    };
    match result {
        Ok(changed) => respond(json!({ "ok": true, "versions": changed })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/secrets/{name}/versions/delete soft-deletes versions.
#[utoipa::path(
    post,
    path = "/api/vault/secrets/{name}/versions/delete",
    tag = "Vault",
    summary = "Soft-delete chosen non-current versions (restorable)",
    params(("name" = String, Path, description = "Secret name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Versions that changed", body = serde_json::Value))
)]
pub async fn delete_versions(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    version_state(state, caller, headers, name, body, true).await
}

/// POST /api/vault/secrets/{name}/versions/undelete restores versions.
#[utoipa::path(
    post,
    path = "/api/vault/secrets/{name}/versions/undelete",
    tag = "Vault",
    summary = "Undelete soft-deleted versions (destroyed versions stay destroyed)",
    params(("name" = String, Path, description = "Secret name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Versions that changed", body = serde_json::Value))
)]
pub async fn undelete_versions(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    version_state(state, caller, headers, name, body, false).await
}

#[cfg(test)]
#[path = "vault_kv_api_tests.rs"]
pub(super) mod tests;
