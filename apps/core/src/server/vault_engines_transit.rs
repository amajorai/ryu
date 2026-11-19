//! Transit engine routes: named encryption keys and the operations that use them.
//!
//! Split out of [`super`]; the handlers are re-exported there so their
//! public paths (and OpenAPI `__path_*` items) stay stable.
//!
//! test-exempt: handlers moved verbatim out of `vault_engines_api.rs`; covered by
//! vault_public_routes_auth_test.rs, vault_engine_roles_tests.rs, and the vault engine tests.

use super::*;

// ── Transit ───────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitCreateBody {
    name: String,
    #[serde(rename = "type", default = "default_transit_type")]
    key_type: TransitKeyType,
    /// `derived`, `convergent`, `exportable`, `allowPlaintextBackup`,
    /// `autoRotatePeriodSecs`.
    #[serde(flatten)]
    options: TransitKeyOptions,
}

fn default_transit_type() -> TransitKeyType {
    TransitKeyType::Aes256Gcm96
}

/// GET /api/vault/transit/keys.
#[utoipa::path(get, path = "/api/vault/transit/keys", tag = "Vault",
    summary = "List transit keys (metadata only)",
    responses((status = 200, description = "Keys", body = serde_json::Value)))]
pub async fn transit_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    let keys = match who.store().transit_list().await {
        Ok(keys) => keys,
        Err(error) => return vault_error(error),
    };
    let visible: Vec<_> = keys
        .into_iter()
        .filter(|key| {
            !who.sys_caps(&format!("sys/transit/{}", key.name))
                .is_empty()
        })
        .collect();
    respond(json!({ "keys": visible }))
}

/// POST /api/vault/transit/keys creates a key.
#[utoipa::path(post, path = "/api/vault/transit/keys", tag = "Vault",
    summary = "Create a transit key (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn transit_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<TransitCreateBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/transit/{}", body.name), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .transit_create_with(&body.name, body.key_type, &body.options, &who.actor())
            .await,
        "key",
    )
}

/// PATCH /api/vault/transit/keys/{name} updates configuration; DELETE removes.
#[utoipa::path(patch, path = "/api/vault/transit/keys/{name}", tag = "Vault",
    summary = "Configure a transit key (admin)",
    params(("name" = String, Path, description = "Key name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Updated", body = serde_json::Value)))]
pub async fn transit_configure(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<TransitConfigUpdate>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/transit/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .transit_update_config(&name, &body, &who.actor())
            .await,
        "key",
    )
}

#[derive(Debug, Default, Deserialize)]
pub struct TransitDeleteQuery {
    /// Opt in to a recoverable soft delete instead of the default permanent
    /// delete.
    #[serde(default)]
    soft: bool,
    /// Accepted for compatibility; a permanent delete is already the default.
    /// It wins over `soft` when both are set.
    #[serde(default)]
    purge: bool,
}

/// DELETE /api/vault/transit/keys/{name}: permanent delete (`?soft=true`
/// soft deletes, recoverable until the scheduler purges it).
#[utoipa::path(delete, path = "/api/vault/transit/keys/{name}", tag = "Vault",
    summary = "Delete a transit key (admin; deletionAllowed must be set)",
    params(
        ("name" = String, Path, description = "Key name"),
        ("soft" = Option<bool>, Query, description = "Soft delete (recoverable) instead of the default permanent delete"),
        ("purge" = Option<bool>, Query, description = "Permanent delete (the default; overrides soft)"),
    ),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn transit_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<TransitDeleteQuery>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/transit/{name}"), Capability::Admin) {
        return response;
    }
    let store = who.store();
    let result = if query.soft && !query.purge {
        store.transit_delete(&name, &who.actor()).await
    } else {
        store.transit_purge(&name, &who.actor()).await
    };
    ok_or(result.map(|()| true), "deleted")
}

/// Body for transit operations. The fields are crate-visible so the batch
/// handler and the Vault-compatible `/v1/transit/*` surface (which builds one
/// from Vault's snake_case fields) can read them.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitOpBody {
    #[serde(default)]
    pub(in crate::server) plaintext: Option<String>,
    #[serde(default)]
    pub(in crate::server) ciphertext: Option<String>,
    #[serde(default)]
    pub(in crate::server) context: Option<String>,
    #[serde(default)]
    pub(in crate::server) input: Option<String>,
    #[serde(default)]
    pub(in crate::server) signature: Option<String>,
    /// For `verify` of an HMAC produced by `hmac`.
    #[serde(default)]
    pub(in crate::server) hmac: Option<String>,
    #[serde(default)]
    pub(in crate::server) associated_data: Option<String>,
    #[serde(default)]
    pub(in crate::server) key_version: Option<u32>,
    #[serde(default)]
    pub(in crate::server) signature_algorithm: Option<String>,
    /// For `cmac-verify` (or `verify`) of a CMAC produced by `cmac`.
    #[serde(default)]
    pub(in crate::server) cmac: Option<String>,
    /// `cmac`: tag length in bytes (1-16, default 16).
    #[serde(default)]
    pub(in crate::server) mac_length: Option<u32>,
    /// Many items through one operation (see [`transit_batch_op`]).
    #[serde(default)]
    pub(in crate::server) batch_input: Option<Vec<TransitBatchItem>>,
}

/// Why [`transit_run`] produced no result. Each surface renders these in its
/// own error format; the policy check and the store call are shared.
pub(in crate::server) enum TransitFailure {
    /// The caller lacks the capability; carries the native refusal.
    Denied(Response),
    /// A required body field is missing.
    Missing(&'static str),
    /// Not a transit operation.
    UnknownOp,
    /// The store refused or failed.
    Store(anyhow::Error),
}

fn transit_field<T: serde::Serialize>(
    key: &str,
    result: anyhow::Result<T>,
) -> Result<Value, TransitFailure> {
    result
        .map(|value| json!({ key: value }))
        .map_err(TransitFailure::Store)
}

/// Authorize and run one transit operation: `use` on `sys/transit/<name>`
/// (`admin` for `rotate`), then the store call. The result is the native
/// response object (`{"ciphertext": …}`, `{"valid": …}`, …). Shared by the
/// native routes and `/v1/transit/*`.
pub(in crate::server) async fn transit_run(
    who: &Who,
    op: &str,
    name: &str,
    body: TransitOpBody,
) -> Result<Value, TransitFailure> {
    let key = format!("sys/transit/{name}");
    let capability = if op == "rotate" {
        Capability::Admin
    } else {
        Capability::Use
    };
    who.require(&key, capability)
        .map_err(TransitFailure::Denied)?;
    let store = who.store();
    let actor = who.actor();
    let options = TransitOpOptions {
        context: body.context.clone(),
        associated_data: body.associated_data.clone(),
        key_version: body.key_version,
        signature_algorithm: body.signature_algorithm.clone(),
    };
    let missing = TransitFailure::Missing;
    match op {
        "encrypt" => {
            let plaintext = body.plaintext.as_deref().ok_or(missing("plaintext"))?;
            transit_field(
                "ciphertext",
                store
                    .transit_encrypt_with(name, plaintext, &options, &actor)
                    .await,
            )
        }
        "decrypt" => {
            let ciphertext = body.ciphertext.as_deref().ok_or(missing("ciphertext"))?;
            transit_field(
                "plaintext",
                store
                    .transit_decrypt_with(name, ciphertext, &options, &actor)
                    .await,
            )
        }
        "rewrap" => {
            let ciphertext = body.ciphertext.as_deref().ok_or(missing("ciphertext"))?;
            transit_field(
                "ciphertext",
                store
                    .transit_rewrap_with(name, ciphertext, &options, &actor)
                    .await,
            )
        }
        "datakey" => {
            let (plaintext, ciphertext) = store
                .transit_datakey_with(name, &options, &actor)
                .await
                .map_err(TransitFailure::Store)?;
            Ok(json!({ "plaintext": plaintext, "ciphertext": ciphertext }))
        }
        "sign" => {
            let input = body.input.as_deref().ok_or(missing("input"))?;
            transit_field(
                "signature",
                store.transit_sign_with(name, input, &options, &actor).await,
            )
        }
        "cmac" => {
            let input = body.input.as_deref().ok_or(missing("input"))?;
            transit_field(
                "cmac",
                store
                    .transit_cmac(name, input, body.key_version, body.mac_length, &actor)
                    .await,
            )
        }
        "verify" | "cmac-verify" if body.cmac.is_some() => {
            match (body.input.as_deref(), body.cmac.as_deref()) {
                (Some(input), Some(cmac)) if body.signature.is_none() && body.hmac.is_none() => {
                    transit_field(
                        "valid",
                        store.transit_verify_cmac(name, input, cmac, &actor).await,
                    )
                }
                _ => Err(missing("input and exactly one of signature, hmac, or cmac")),
            }
        }
        "cmac-verify" => Err(missing("input and cmac")),
        "verify" => match (
            body.input.as_deref(),
            body.signature.as_deref(),
            body.hmac.as_deref(),
        ) {
            (Some(input), Some(signature), None) => transit_field(
                "valid",
                store
                    .transit_verify_with(name, input, signature, &options, &actor)
                    .await,
            ),
            (Some(input), None, Some(hmac)) => transit_field(
                "valid",
                store.transit_verify_hmac(name, input, hmac, &actor).await,
            ),
            _ => Err(missing("input and exactly one of signature or hmac")),
        },
        "hmac" => {
            let input = body.input.as_deref().ok_or(missing("input"))?;
            transit_field(
                "hmac",
                store.transit_hmac_with(name, input, &options, &actor).await,
            )
        }
        "rotate" => transit_field("key", store.transit_rotate(name, &actor).await),
        _ => Err(TransitFailure::UnknownOp),
    }
}

pub(in crate::server) async fn transit_op(
    who: &Who,
    op: &str,
    name: &str,
    mut body: TransitOpBody,
) -> Response {
    if let Some(items) = body.batch_input.take() {
        // One policy check covers the batch, the same check `transit_run` makes.
        let capability = if op == "rotate" {
            Capability::Admin
        } else {
            Capability::Use
        };
        if let Err(response) = who.require(&format!("sys/transit/{name}"), capability) {
            return response;
        }
        return transit_batch_op(who, op, name, &items, &body).await;
    }
    match transit_run(who, op, name, body).await {
        Ok(result) => respond(result),
        Err(TransitFailure::Denied(response)) => response,
        Err(TransitFailure::Missing(field)) => invalid_request(&format!("`{field}` is required")),
        Err(TransitFailure::UnknownOp) => json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: unknown transit operation".to_owned(),
        ),
        Err(TransitFailure::Store(error)) => vault_error(error),
    }
}

/// POST /api/vault/transit/{op}/{name}: `encrypt`, `decrypt`, `rewrap`,
/// `datakey`, `sign`, `verify`, `hmac`, `cmac`, `cmac-verify`, `rotate`.
/// `batchInput` runs a batchable operation once per item.
#[utoipa::path(post, path = "/api/vault/transit/{op}/{name}", tag = "Vault",
    summary = "Run a transit operation (use; rotate needs admin)",
    params(
        ("op" = String, Path, description = "encrypt, decrypt, rewrap, datakey, sign, verify, hmac, cmac, cmac-verify, rotate"),
        ("name" = String, Path, description = "Key name"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn transit_operation(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((op, name)): Path<(String, String)>,
    body: Option<Json<TransitOpBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    transit_op(
        &who,
        &op,
        &name,
        body.map(|Json(body)| body).unwrap_or_default(),
    )
    .await
}
