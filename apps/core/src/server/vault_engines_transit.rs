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

/// Body for transit operations.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitOpBody {
    #[serde(default)]
    plaintext: Option<String>,
    #[serde(default)]
    ciphertext: Option<String>,
    #[serde(default)]
    context: Option<String>,
    #[serde(default)]
    input: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    /// For `verify` of an HMAC produced by `hmac`.
    #[serde(default)]
    hmac: Option<String>,
    #[serde(default)]
    associated_data: Option<String>,
    #[serde(default)]
    key_version: Option<u32>,
    #[serde(default)]
    signature_algorithm: Option<String>,
}

pub(super) async fn transit_op(who: &Who, op: &str, name: &str, body: TransitOpBody) -> Response {
    let key = format!("sys/transit/{name}");
    let capability = if op == "rotate" {
        Capability::Admin
    } else {
        Capability::Use
    };
    if let Err(response) = who.require(&key, capability) {
        return response;
    }
    let store = who.store();
    let actor = who.actor();
    let options = TransitOpOptions {
        context: body.context.clone(),
        associated_data: body.associated_data.clone(),
        key_version: body.key_version,
        signature_algorithm: body.signature_algorithm.clone(),
    };
    let missing = |field: &str| invalid_request(&format!("`{field}` is required"));
    match op {
        "encrypt" => match body.plaintext.as_deref() {
            Some(plaintext) => ok_or(
                store
                    .transit_encrypt_with(name, plaintext, &options, &actor)
                    .await,
                "ciphertext",
            ),
            None => missing("plaintext"),
        },
        "decrypt" => match body.ciphertext.as_deref() {
            Some(ciphertext) => ok_or(
                store
                    .transit_decrypt_with(name, ciphertext, &options, &actor)
                    .await,
                "plaintext",
            ),
            None => missing("ciphertext"),
        },
        "rewrap" => match body.ciphertext.as_deref() {
            Some(ciphertext) => ok_or(
                store
                    .transit_rewrap_with(name, ciphertext, &options, &actor)
                    .await,
                "ciphertext",
            ),
            None => missing("ciphertext"),
        },
        "datakey" => match store.transit_datakey_with(name, &options, &actor).await {
            Ok((plaintext, ciphertext)) => {
                respond(json!({ "plaintext": plaintext, "ciphertext": ciphertext }))
            }
            Err(error) => vault_error(error),
        },
        "sign" => match body.input.as_deref() {
            Some(input) => ok_or(
                store.transit_sign_with(name, input, &options, &actor).await,
                "signature",
            ),
            None => missing("input"),
        },
        "verify" => match (
            body.input.as_deref(),
            body.signature.as_deref(),
            body.hmac.as_deref(),
        ) {
            (Some(input), Some(signature), None) => ok_or(
                store
                    .transit_verify_with(name, input, signature, &options, &actor)
                    .await,
                "valid",
            ),
            (Some(input), None, Some(hmac)) => ok_or(
                store.transit_verify_hmac(name, input, hmac, &actor).await,
                "valid",
            ),
            _ => missing("input and exactly one of signature or hmac"),
        },
        "hmac" => match body.input.as_deref() {
            Some(input) => ok_or(
                store.transit_hmac_with(name, input, &options, &actor).await,
                "hmac",
            ),
            None => missing("input"),
        },
        "rotate" => ok_or(store.transit_rotate(name, &actor).await, "key"),
        _ => json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: unknown transit operation".to_owned(),
        ),
    }
}

/// POST /api/vault/transit/{op}/{name}: `encrypt`, `decrypt`, `rewrap`,
/// `datakey`, `sign`, `verify`, `hmac`, `rotate`.
#[utoipa::path(post, path = "/api/vault/transit/{op}/{name}", tag = "Vault",
    summary = "Run a transit operation (use; rotate needs admin)",
    params(
        ("op" = String, Path, description = "encrypt, decrypt, rewrap, datakey, sign, verify, hmac, rotate"),
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
