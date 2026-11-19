//! PKI routes: intermediates, issuer import, signing intermediates, and tidy.

use super::*;
use crate::vault::pki::{KeySpec, PkiKeyType};

// ── PKI ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateBody {
    common_name: String,
    /// `ec` (default), `rsa`, or `ed25519`.
    #[serde(default)]
    key_type: PkiKeyType,
    /// `ec`: 256 (default) or 384; `rsa`: 2048 (default), 3072, or 4096;
    /// none for `ed25519`.
    #[serde(default)]
    key_bits: Option<u32>,
}

/// POST /api/vault/pki/issuers/{name}/intermediate/generate returns a CSR.
#[utoipa::path(post, path = "/api/vault/pki/issuers/{name}/intermediate/generate", tag = "Vault",
    summary = "Generate an intermediate issuer key and return its CSR (admin; keyType ec, rsa, or ed25519)",
    description = "The body takes `commonName`, and optionally `keyType` (`ec`, the default, \
        `rsa`, or `ed25519`) and `keyBits` (`ec`: 256 or 384; `rsa`: 2048, 3072, or 4096; none \
        for `ed25519`). The issuer stays pending until its signed certificate is installed.",
    params(("name" = String, Path, description = "Issuer name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "The pending issuer with its CSR", body = serde_json::Value),
        (status = 400, description = "An invalid name, common name, key type or size"),
    ))]
pub async fn pki_generate_intermediate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<IntermediateBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, issuer_key(&name), Capability::Admin);
    generate_intermediate(who.store(), &name, &body, &who.actor()).await
}

/// Validate the body's key type and size, then generate the intermediate.
pub(super) async fn generate_intermediate(
    store: &PluginSecretStore,
    name: &str,
    body: &IntermediateBody,
    actor: &AuditActor,
) -> Response {
    let spec = match KeySpec::new(body.key_type, body.key_bits) {
        Ok(spec) => spec,
        Err(error) => return vault_error(error),
    };
    ok_or(
        store
            .pki_generate_intermediate_with(name, &body.common_name, spec, actor)
            .await,
        "issuer",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSignedBody {
    certificate: String,
    #[serde(default)]
    ca_chain: Option<String>,
}

/// POST /api/vault/pki/issuers/{name}/intermediate/set-signed.
#[utoipa::path(post, path = "/api/vault/pki/issuers/{name}/intermediate/set-signed", tag = "Vault",
    summary = "Install the signed certificate for a pending intermediate issuer",
    params(("name" = String, Path, description = "Issuer name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn pki_set_signed(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<SetSignedBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, issuer_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .pki_set_signed(
                &name,
                &body.certificate,
                body.ca_chain.as_deref(),
                &who.actor(),
            )
            .await,
        "issuer",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportIssuerBody {
    certificate: String,
    private_key: String,
    #[serde(default)]
    ca_chain: Option<String>,
}

/// POST /api/vault/pki/issuers/{name}/import.
#[utoipa::path(post, path = "/api/vault/pki/issuers/{name}/import", tag = "Vault",
    summary = "Import an external issuer certificate and key",
    params(("name" = String, Path, description = "Issuer name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn pki_import_issuer(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<ImportIssuerBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, issuer_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .pki_import_issuer(
                &name,
                &body.certificate,
                &body.private_key,
                body.ca_chain.as_deref(),
                &who.actor(),
            )
            .await,
        "issuer",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignIntermediateBody {
    csr: String,
    common_name: String,
    #[serde(default)]
    ttl_secs: Option<i64>,
}

/// POST /api/vault/pki/issuers/{name}/sign-intermediate.
#[utoipa::path(post, path = "/api/vault/pki/issuers/{name}/sign-intermediate", tag = "Vault",
    summary = "Sign an intermediate CSR with an issuer",
    params(("name" = String, Path, description = "Signing issuer name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn pki_sign_intermediate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<SignIntermediateBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, issuer_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .pki_sign_intermediate(
                &name,
                &body.csr,
                &body.common_name,
                body.ttl_secs,
                &who.actor(),
            )
            .await,
        "certificate",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyBody {
    #[serde(default)]
    safety_buffer_secs: Option<i64>,
}

/// POST /api/vault/pki/tidy.
#[utoipa::path(post, path = "/api/vault/pki/tidy", tag = "Vault",
    summary = "Remove expired certificates and revocation entries from the PKI store",
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn pki_tidy(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    body: Option<Json<TidyBody>>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, PKI_TIDY_KEY, Capability::Admin);
    let buffer = body
        .and_then(|Json(body)| body.safety_buffer_secs)
        .unwrap_or(crate::vault::pki::DEFAULT_TIDY_BUFFER_SECS);
    ok_or(who.store().pki_tidy(buffer, &who.actor()).await, "removed")
}

#[cfg(test)]
#[path = "pki_tests.rs"]
mod tests;
