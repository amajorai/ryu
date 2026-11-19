//! Transit key lifecycle routes: BYOK import, export, backup and restore, trim, recovery.
// test-exempt: moved verbatim out of server/vault_crypto_api.rs; covered by vault_crypto_api/tests.rs, the vault public-route auth suite and the OpenAPI spec test.

use super::*;

// ── Transit ───────────────────────────────────────────────────────────────

/// GET /api/vault/transit/wrapping-key: the RSA public key BYOK material is
/// wrapped with (generated on first use).
#[utoipa::path(get, path = "/api/vault/transit/wrapping-key", tag = "Vault",
    summary = "RSA public key used to wrap imported transit key material (admin)",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_wrapping_key(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, WRAPPING_KEY_KEY, Capability::Admin);
    ok_or(who.store().transit_wrapping_key().await, "publicKey")
}

/// GET /api/vault/transit/deleted: soft-deleted keys still recoverable.
#[utoipa::path(get, path = "/api/vault/transit/deleted", tag = "Vault",
    summary = "Soft-deleted transit keys that can still be recovered",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_deleted(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    match who.store().transit_list_deleted().await {
        Ok(keys) => {
            let visible: Vec<_> = keys
                .into_iter()
                .filter(|key| {
                    who.caps(&transit_key(&key.name))
                        .contains(&Capability::Admin)
                })
                .collect();
            respond(json!({ "keys": visible }))
        }
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitImportBody {
    #[serde(rename = "type", default)]
    key_type: Option<TransitKeyType>,
    /// Base64 `RSA-OAEP-SHA256(wrapping key, AES-256 key) || AES-KWP(material)`.
    ciphertext: String,
    #[serde(flatten)]
    options: TransitKeyOptions,
}

/// POST /api/vault/transit/keys/{name}/import creates a key from wrapped
/// external material.
#[utoipa::path(post, path = "/api/vault/transit/keys/{name}/import", tag = "Vault",
    summary = "Create a transit key from wrapped external key material",
    params(("name" = String, Path, description = "Transit key name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<TransitImportBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, transit_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .transit_import(
                &name,
                body.key_type.unwrap_or(TransitKeyType::Aes256Gcm96),
                &body.ciphertext,
                &body.options,
                &who.actor(),
            )
            .await,
        "key",
    )
}

/// POST /api/vault/transit/keys/{name}/import-version adds a wrapped version.
#[utoipa::path(post, path = "/api/vault/transit/keys/{name}/import-version", tag = "Vault",
    summary = "Add a wrapped external key version to a transit key",
    params(("name" = String, Path, description = "Transit key name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_import_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<TransitImportBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, transit_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .transit_import_version(&name, &body.ciphertext, &who.actor())
            .await,
        "key",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimBody {
    min_available_version: u32,
}

/// POST /api/vault/transit/keys/{name}/trim drops versions below
/// `minAvailableVersion` for good.
#[utoipa::path(post, path = "/api/vault/transit/keys/{name}/trim", tag = "Vault",
    summary = "Permanently drop transit key versions below minAvailableVersion",
    params(("name" = String, Path, description = "Transit key name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_trim(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<TrimBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, transit_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .transit_trim(&name, body.min_available_version, &who.actor())
            .await,
        "key",
    )
}

/// POST /api/vault/transit/keys/{name}/recover undoes a soft delete.
#[utoipa::path(post, path = "/api/vault/transit/keys/{name}/recover", tag = "Vault",
    summary = "Recover a soft-deleted transit key",
    params(("name" = String, Path, description = "Transit key name")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_recover(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, transit_key(&name), Capability::Admin);
    ok_or(
        who.store().transit_recover(&name, &who.actor()).await,
        "key",
    )
}

pub(super) async fn export(who: &Caller, kind: &str, name: &str, version: Option<u32>) -> Response {
    let Some(kind) = TransitExportKind::parse(kind) else {
        return invalid_request(
            "export type must be encryption-key, signing-key, hmac-key, or public-key",
        );
    };
    let capability = if kind == TransitExportKind::PublicKey {
        Capability::Use
    } else {
        Capability::Admin
    };
    require!(who, transit_key(name), capability);
    ok_or(
        who.store()
            .transit_export(name, kind, version, &who.actor())
            .await,
        "export",
    )
}

/// GET /api/vault/transit/export/{kind}/{name}: every available version.
#[utoipa::path(get, path = "/api/vault/transit/export/{kind}/{name}", tag = "Vault",
    summary = "Export every available version of an exportable transit key",
    params(("kind" = String, Path, description = "Export kind (encryption-key, signing-key, hmac-key, or public-key)"), ("name" = String, Path, description = "Transit key name")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_export_all(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((kind, name)): Path<(String, String)>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    export(&who, &kind, &name, None).await
}

/// GET /api/vault/transit/export/{kind}/{name}/{version}.
#[utoipa::path(get, path = "/api/vault/transit/export/{kind}/{name}/{version}", tag = "Vault",
    summary = "Export one version of an exportable transit key",
    params(("kind" = String, Path, description = "Export kind (encryption-key, signing-key, hmac-key, or public-key)"), ("name" = String, Path, description = "Transit key name"), ("version" = String, Path, description = "Key version or latest")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_export_version(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((kind, name, version)): Path<(String, String, u32)>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    export(&who, &kind, &name, Some(version)).await
}

/// GET /api/vault/transit/backup/{name}.
#[utoipa::path(get, path = "/api/vault/transit/backup/{name}", tag = "Vault",
    summary = "Back up a transit key that allows plaintext backup",
    params(("name" = String, Path, description = "Transit key name")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_backup(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, transit_key(&name), Capability::Admin);
    ok_or(
        who.store().transit_backup(&name, &who.actor()).await,
        "backup",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreBody {
    backup: String,
    /// Restore under this name instead of the backed-up one.
    #[serde(default)]
    name: Option<String>,
    /// Replace an existing key of that name.
    #[serde(default)]
    force: bool,
}

/// The key name a backup restores to (needed before authorizing).
pub(super) fn backup_name(backup: &str) -> Option<String> {
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(backup.trim())
        .ok()?;
    let value: Value = serde_json::from_slice(&raw).ok()?;
    value.get("name")?.as_str().map(str::to_owned)
}

/// POST /api/vault/transit/restore.
#[utoipa::path(post, path = "/api/vault/transit/restore", tag = "Vault",
    summary = "Restore a transit key from a backup",
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_restore(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<RestoreBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    let Some(target) = body.name.clone().or_else(|| backup_name(&body.backup)) else {
        return invalid_request("backup is not a transit backup");
    };
    require!(who, transit_key(&target), Capability::Admin);
    ok_or(
        who.store()
            .transit_restore(&body.backup, Some(&target), body.force, &who.actor())
            .await,
        "key",
    )
}
