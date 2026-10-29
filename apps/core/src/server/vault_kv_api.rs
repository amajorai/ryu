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
//! are not supported by these routes yet and answer `501`.

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, patch, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{
    coords_for, invalid_request, parse_body, protected_denied, protected_environment, respond,
    to_wire, vault_error, CoordsBody, CoordsQuery, Ctx, MAX_REQUEST_BODY_BYTES,
};
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

/// Load the principal and resolve local coordinates, or answer early.
async fn local_coords(
    state: &ServerState,
    caller: Option<VerifiedCaller>,
    headers: &HeaderMap,
    name: &str,
    body: CoordsBody,
) -> Result<(Ctx, SecretCoords), Response> {
    let ctx = Ctx::load(state, caller, headers).await?;
    if ctx.shared_remote(body.scope) {
        return Err(shared_unsupported());
    }
    let coords = coords_for(&ctx, name, body)?;
    Ok((ctx, coords))
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
    let (ctx, coords) = match local_coords(&state, caller, &headers, &name, query.into()).await {
        Ok(found) => found,
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
    let (ctx, coords) = match local_coords(&state, caller, &headers, &name, body.coords).await {
        Ok(found) => found,
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
    let (ctx, coords) = match local_coords(&state, caller, &headers, &name, body.coords).await {
        Ok(found) => found,
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
    let (ctx, coords) = match local_coords(&state, caller, &headers, &name, query.into()).await {
        Ok(found) => found,
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
    let (ctx, coords) = match local_coords(&state, caller, &headers, &name, body.coords).await {
        Ok(found) => found,
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
mod tests {
    use super::*;

    #[test]
    fn custom_metadata_bypasses_timestamp_conversion() {
        let mut body = json!({
            "metadata": {
                "expiresAt": "2030-01-01T00:00:00Z",
                "customMetadata": { "reviewedAt": "last week" },
            },
        });
        let custom = take_custom_metadata(&mut body);
        let converted = super::super::vault_api::millis_fields(body).unwrap();
        assert!(converted["metadata"]["expiresAt"].is_i64());
        let mut metadata = converted.get("metadata").cloned();
        restore_custom_metadata(&mut metadata, custom);
        assert_eq!(
            metadata.unwrap()["customMetadata"]["reviewedAt"],
            json!("last week")
        );
        let mut none = None;
        restore_custom_metadata(&mut none, None);
        assert!(none.is_none());
    }

    #[test]
    fn routes_merge_beside_the_existing_secret_action_routes() {
        // Router construction panics on an overlapping path or method.
        let _router = super::super::vault_routes();
    }

    // ── Handler-level authorization ──────────────────────────────────────

    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    use crate::identity_verify::OrgRole;
    use crate::plugin_secrets::kv::Environment;
    use crate::plugin_secrets::kv::WriteRequest;
    use crate::plugin_secrets::{
        PluginSecretStore, SecretMetadataPatch, SecretScope, VersionSource,
    };
    use crate::vault::audit::AuditActor;
    use crate::vault::policy::{Policy, PolicyRule};

    fn member(user_id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: None,
            role: OrgRole::Member,
            teams: Vec::new(),
        }
    }

    fn router(caller: Option<VerifiedCaller>, directory: &std::path::Path) -> Router {
        super::super::vault_routes()
            .layer(Extension(caller))
            .with_state(super::super::isolated_plugin_hook_test_state(directory))
    }

    async fn call(
        router: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, String) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(match body {
                Some(body) => Body::from(serde_json::to_vec(&body).unwrap()),
                None => Body::empty(),
            })
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Bind `user:<user>` to a policy denying `capabilities` under `environment`.
    async fn deny(
        store: &PluginSecretStore,
        user: &str,
        environment: &str,
        capabilities: Vec<Capability>,
    ) {
        let conn = store.conn.lock().await;
        let name = format!("deny-{user}");
        crate::vault::policy::put_policy(
            &conn,
            &Policy {
                name: name.clone(),
                description: String::new(),
                rules: vec![PolicyRule {
                    path: format!("{environment}/**"),
                    capabilities,
                    deny: true,
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        crate::vault::policy::bind(&conn, &name, &format!("user:{user}"), None, None).unwrap();
    }

    async fn seed(store: &PluginSecretStore, environment: &str, protected: bool) {
        let actor = AuditActor::new("operator", None);
        store
            .put_environment(
                &Environment {
                    slug: environment.to_owned(),
                    name: environment.to_owned(),
                    protected,
                    required_approvals: 1,
                    position: 50,
                    cas_required: false,
                },
                &actor,
            )
            .await
            .unwrap();
        let coords = SecretCoords {
            scope: SecretScope::Node,
            scope_id: crate::server::agent_sync::local_node_id(),
            environment: environment.to_owned(),
            path: "/".to_owned(),
            binding: None,
            name: "DB".to_owned(),
        };
        for value in [r#"{"user":"app"}"#, r#"{"user":"app2"}"#] {
            store
                .write_secret(WriteRequest {
                    coords: coords.clone(),
                    value: Some(value),
                    patch: SecretMetadataPatch::default(),
                    actor: &actor,
                    source: VersionSource::Write,
                    expected_version: None,
                })
                .await
                .unwrap();
        }
    }

    /// Every KV v2 route, as (method, path suffix, body) for value `DB`.
    fn kv_requests(environment: &str) -> Vec<(&'static str, String, Option<Value>)> {
        let query = format!("?scope=node&environment={environment}");
        let coords = json!({ "scope": "node", "environment": environment });
        let with = |extra: Value| {
            let mut body = coords.clone();
            if let (Some(body), Value::Object(extra)) = (body.as_object_mut(), extra) {
                body.extend(extra);
            }
            Some(body)
        };
        vec![
            (
                "GET",
                format!("/api/vault/secrets/DB/metadata{query}"),
                None,
            ),
            ("GET", format!("/api/vault/secrets/DB/subkeys{query}"), None),
            (
                "PATCH",
                "/api/vault/secrets/DB/metadata".to_owned(),
                with(json!({ "metadata": { "description": "x" } })),
            ),
            (
                "PATCH",
                "/api/vault/secrets/DB/data".to_owned(),
                with(json!({ "patch": { "user": "x" }, "expectedVersion": 2 })),
            ),
            (
                "POST",
                "/api/vault/secrets/DB/versions/delete".to_owned(),
                with(json!({ "versions": [1] })),
            ),
            (
                "POST",
                "/api/vault/secrets/DB/versions/undelete".to_owned(),
                with(json!({ "versions": [1] })),
            ),
        ]
    }

    #[tokio::test]
    async fn kv_routes_enforce_capabilities_protection_and_metadata_cas() {
        let _managed = crate::sidecar::gateway::lock_managed_node_env();
        assert!(crate::sidecar::control_plane::registered_node().is_none());
        crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
        let store = crate::plugin_secrets::global().expect("a published store");
        let directory = tempfile::tempdir().unwrap();
        let tag = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let open_env = format!("kvr-{tag}");
        let protected_env = format!("kvp-{tag}");
        seed(store, &open_env, false).await;
        seed(store, &protected_env, true).await;

        // Each capability, denied alone, refuses exactly the routes that need it.
        let needs: [(Capability, &[usize]); 4] = [
            (Capability::List, &[0]),
            (Capability::Read, &[1]),
            (Capability::Write, &[2, 3, 5]),
            (Capability::Delete, &[4]),
        ];
        for (capability, routes) in needs {
            let user = format!("kv-{}-{tag}", capability.as_str());
            deny(store, &user, &open_env, vec![capability]).await;
            let router = router(Some(member(&user)), directory.path());
            for (index, (method, uri, body)) in kv_requests(&open_env).into_iter().enumerate() {
                let (status, text) = call(&router, method, &uri, body).await;
                if routes.contains(&index) {
                    assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {text}");
                    assert!(text.contains(capability.as_str()), "{text}");
                } else {
                    assert_ne!(status, StatusCode::FORBIDDEN, "{method} {uri}: {text}");
                }
            }
        }

        // Write without admin in a protected environment: reads pass, every
        // mutation is refused.
        let writer = format!("kv-writer-{tag}");
        deny(store, &writer, &protected_env, vec![Capability::Admin]).await;
        let router_writer = router(Some(member(&writer)), directory.path());
        for (index, (method, uri, body)) in kv_requests(&protected_env).into_iter().enumerate() {
            let (status, text) = call(&router_writer, method, &uri, body).await;
            if index < 2 {
                assert_eq!(status, StatusCode::OK, "{method} {uri}: {text}");
            } else {
                assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {text}");
                assert!(text.contains("protected environment"), "{text}");
            }
        }

        // Metadata check-and-set: stale is 409, current succeeds. The routes
        // above may have changed the metadata, so read the counter first.
        let operator = router(None, directory.path());
        let (status, text) = call(
            &operator,
            "GET",
            &format!("/api/vault/secrets/DB/metadata?scope=node&environment={open_env}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}");
        let current = serde_json::from_str::<Value>(&text).unwrap()["secret"]["metadataVersion"]
            .as_i64()
            .expect("metadataVersion");
        let patch = |expected: i64| {
            Some(json!({
                "scope": "node",
                "environment": open_env,
                "metadata": { "description": "rotated monthly" },
                "expectedMetadataVersion": expected,
            }))
        };
        let (status, text) = call(
            &operator,
            "PATCH",
            "/api/vault/secrets/DB/metadata",
            patch(current + 5),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{text}");
        let (status, text) = call(
            &operator,
            "PATCH",
            "/api/vault/secrets/DB/metadata",
            patch(current),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}");

        // Version summaries are only served for a bounded page.
        let (status, text) = call(&operator, "GET", "/api/vault/secrets?detailed=true", None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");
        let (status, text) = call(
            &operator,
            "GET",
            &format!("/api/vault/secrets?detailed=true&limit=10&environment={open_env}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}");
        let listed: Value = serde_json::from_str(&text).unwrap();
        let versions = listed["secrets"][0]["versions"]
            .as_array()
            .expect("versions");
        assert!(versions.len() >= 2, "{text}");
        assert_eq!(versions[0]["current"], json!(true));

        // Parameter constraints gate the merged value of a data patch, and a
        // control group on read gates subkeys.
        let constrained = format!("kv-params-{tag}");
        {
            let conn = store.conn.lock().await;
            let name = format!("params-{constrained}");
            crate::vault::policy::put_policy(
                &conn,
                &Policy {
                    name: name.clone(),
                    description: String::new(),
                    rules: vec![PolicyRule {
                        path: format!("{open_env}/**"),
                        capabilities: vec![Capability::Read, Capability::Write],
                        deny: false,
                        allowed_parameters: Some(std::collections::BTreeMap::from([(
                            "user".to_owned(),
                            vec!["app*".to_owned()],
                        )])),
                        required_parameters: vec!["user".to_owned()],
                        control_group: Some(crate::vault::policy_ext::ControlGroupSpec {
                            ttl_secs: None,
                            factors: vec![crate::vault::policy_ext::ControlGroupFactor {
                                name: "security".into(),
                                approvers: vec!["user:bob".into()],
                                approvals: 1,
                            }],
                        }),
                        ..Default::default()
                    }],
                },
            )
            .unwrap();
            crate::vault::policy::bind(&conn, &name, &format!("user:{constrained}"), None, None)
                .unwrap();
        }
        let router_constrained = router(Some(member(&constrained)), directory.path());
        let data_patch = |patch: Value| {
            Some(json!({ "scope": "node", "environment": open_env, "patch": patch }))
        };
        for refused in [json!({ "user": "root" }), json!({ "user": null })] {
            let (status, text) = call(
                &router_constrained,
                "PATCH",
                "/api/vault/secrets/DB/data",
                data_patch(refused.clone()),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{refused}: {text}");
            assert!(text.contains("vault_denied"), "{text}");
        }
        let (status, text) = call(
            &router_constrained,
            "PATCH",
            "/api/vault/secrets/DB/data",
            data_patch(json!({ "user": "app9" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{text}");
        let (status, text) = call(
            &router_constrained,
            "GET",
            &format!("/api/vault/secrets/DB/subkeys?scope=node&environment={open_env}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
        assert!(text.contains("vault_control_group_required"), "{text}");
    }

    #[test]
    fn version_bodies_require_a_versions_list() {
        assert!(serde_json::from_value::<VersionsBody>(json!({ "versions": [1, 2] })).is_ok());
        assert!(serde_json::from_value::<VersionsBody>(json!({})).is_err());
        assert!(serde_json::from_value::<DataPatchBody>(json!({ "scope": "user" })).is_err());
    }
}
