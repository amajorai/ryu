//! Secret Vault cryptography extensions: transit key lifecycle (BYOK import,
//! export, backup/restore, trim, soft-delete recovery), PKI intermediates,
//! issuer import, and tidy, and workload identity tokens with a public OIDC
//! discovery document and JWKS.
//!
//! Human routes sit under `/api/vault/*` behind the node bearer (plus an
//! optional user JWT) and authorize against `sys/transit/<key>`,
//! `sys/pki/issuers/<name>`, `sys/pki/_tidy`, `sys/identity/<role>`, and
//! `sys/identity/_config`: managing needs `admin`; requesting an identity
//! token or reading a public key needs `use`. Machine routes under
//! `/api/vault/agent/*` accept only `x-ryu-vault-token` and authorize purely by
//! the token's policies. The discovery document and JWKS are public and
//! unauthenticated so relying parties can verify tokens.
//!
//! Key material leaves Core only through `export` and `backup`, which need
//! `admin` and keys created (or configured, one-way) as exportable.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{denied, invalid_request, parse_body, respond, store, vault_error, Ctx};
use super::vault_engines_api::VAULT_TOKEN_HEADER;
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::identity_tokens::{IdentityConfig, IdentityRole, IdentitySubject};
use crate::vault::machine::TokenPrincipal;
use crate::vault::policy::{Capability, CapabilitySet, Policy};
use crate::vault::transit::{TransitExportKind, TransitKeyOptions, TransitKeyType};

const IDENTITY_CONFIG_KEY: &str = "sys/identity/_config";
const PKI_TIDY_KEY: &str = "sys/pki/_tidy";
const WRAPPING_KEY_KEY: &str = "sys/transit/_wrapping-key";

fn transit_key(name: &str) -> String {
    format!("sys/transit/{name}")
}

fn issuer_key(name: &str) -> String {
    format!("sys/pki/issuers/{name}")
}

fn identity_key(role: &str) -> String {
    format!("sys/identity/{role}")
}

/// Who is calling: a human on the node bearer or a machine vault token.
/// Shared with the TOTP and password-policy routes in
/// [`super::vault_totp_pwpolicy_api`].
pub(super) enum Caller {
    Human(Ctx),
    Machine {
        store: &'static PluginSecretStore,
        principal: TokenPrincipal,
        policies: Vec<Policy>,
    },
}

impl Caller {
    pub(super) fn store(&self) -> &'static PluginSecretStore {
        match self {
            Self::Human(ctx) => ctx.store,
            Self::Machine { store, .. } => store,
        }
    }

    pub(super) fn actor(&self) -> AuditActor {
        match self {
            Self::Human(ctx) => ctx.actor(),
            Self::Machine { principal, .. } => principal.actor(),
        }
    }

    pub(super) fn caps(&self, key: &str) -> CapabilitySet {
        match self {
            Self::Human(ctx) => ctx.sys_caps(key),
            // Machine tokens start from no capabilities; identity templates
            // (`{{identity.machine.id}}`) expand against the token's machine.
            Self::Machine {
                policies,
                principal,
                ..
            } => crate::vault::policy::evaluate_with(
                &CapabilitySet::new(),
                policies,
                key,
                &crate::vault::policy_ext::TemplateContext::from_subjects(&[principal.subject()]),
            ),
        }
    }

    pub(super) fn require(&self, key: &str, capability: Capability) -> Result<(), Response> {
        if self.caps(key).contains(&capability) {
            Ok(())
        } else {
            Err(denied(capability, key))
        }
    }

    /// The subject an identity token is issued for. `None` for a human caller
    /// without a verified user id (node bearer only): every such caller would
    /// share the same empty-id `sub`, which relying parties cannot tell apart.
    fn subject(&self) -> Option<IdentitySubject> {
        match self {
            Self::Human(ctx) => {
                let actor = ctx.actor();
                let id = actor.id.clone().filter(|id| !id.is_empty())?;
                Some(IdentitySubject {
                    kind: actor.kind.to_string(),
                    name: id.clone(),
                    id,
                    policies: Vec::new(),
                })
            }
            Self::Machine {
                principal,
                policies,
                ..
            } => {
                let mut names = principal.policies.clone();
                for policy in policies {
                    if !names.contains(&policy.name) {
                        names.push(policy.name.clone());
                    }
                }
                Some(IdentitySubject {
                    kind: "machine".into(),
                    id: principal.identity_id.clone(),
                    name: principal.identity_name.clone(),
                    policies: names,
                })
            }
        }
    }
}

#[cfg(test)]
impl Caller {
    /// A machine caller (identity `mid_x`) holding one `ci` policy with
    /// `rules`, backed by an in-memory store.
    pub(super) fn machine_for_test(rules: Vec<crate::vault::policy::PolicyRule>) -> Self {
        Self::Machine {
            store: Box::leak(Box::new(PluginSecretStore::in_memory().unwrap())),
            principal: TokenPrincipal {
                accessor: "rva_x".into(),
                identity_id: "mid_x".into(),
                identity_name: "ci".into(),
                policies: vec!["ci".into()],
                expires_at: i64::MAX,
            },
            policies: vec![Policy {
                name: "ci".into(),
                description: String::new(),
                rules,
            }],
        }
    }
}

pub(super) async fn human(
    state: &ServerState,
    caller: Option<VerifiedCaller>,
    headers: &HeaderMap,
) -> Result<Caller, Response> {
    Ctx::load(state, caller, headers).await.map(Caller::Human)
}

/// Authenticate a machine vault token and load its policies (bound to the
/// machine subject plus the named policies on the token).
pub(super) async fn machine(headers: &HeaderMap) -> Result<Caller, Response> {
    let store = store()?;
    let token = headers
        .get(VAULT_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .unwrap_or_default();
    let unauthorized = || {
        json_error(
            StatusCode::UNAUTHORIZED,
            "vault_token_invalid: a valid x-ryu-vault-token is required".to_owned(),
        )
    };
    if token.is_empty() {
        return Err(unauthorized());
    }
    let principal = match store.token_lookup(token).await {
        Ok(Some(principal)) => principal,
        Ok(None) => return Err(unauthorized()),
        Err(error) => return Err(vault_error(error)),
    };
    let policies = {
        let conn = store.conn.lock().await;
        // Exactly the token's (possibly narrowed) policies: re-adding the
        // identity's bindings would widen a scoped child token.
        crate::vault::machine::principal_policies_locked(&conn, &principal).map_err(vault_error)?
    };
    Ok(Caller::Machine {
        store,
        principal,
        policies,
    })
}

macro_rules! caller {
    ($expr:expr) => {
        match $expr {
            Ok(caller) => caller,
            Err(response) => return response,
        }
    };
}
pub(super) use caller;

macro_rules! require {
    ($caller:expr, $key:expr, $capability:expr) => {
        if let Err(response) = $caller.require(&$key, $capability) {
            return response;
        }
    };
}
pub(super) use require;

pub(super) fn ok_or<T: serde::Serialize>(result: anyhow::Result<T>, key: &str) -> Response {
    match result {
        Ok(value) => respond(json!({ key: value })),
        Err(error) => vault_error(error),
    }
}

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

async fn export(who: &Caller, kind: &str, name: &str, version: Option<u32>) -> Response {
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
fn backup_name(backup: &str) -> Option<String> {
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

// ── PKI ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntermediateBody {
    common_name: String,
}

/// POST /api/vault/pki/issuers/{name}/intermediate/generate returns a CSR.
#[utoipa::path(post, path = "/api/vault/pki/issuers/{name}/intermediate/generate", tag = "Vault",
    summary = "Generate an intermediate issuer key and return its CSR",
    params(("name" = String, Path, description = "Issuer name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn pki_generate_intermediate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<IntermediateBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, issuer_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .pki_generate_intermediate(&name, &body.common_name, &who.actor())
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

// ── Identity tokens ───────────────────────────────────────────────────────

/// GET /api/vault/identity/config.
#[utoipa::path(get, path = "/api/vault/identity/config", tag = "Vault",
    summary = "Identity token issuer configuration",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_config(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, IDENTITY_CONFIG_KEY, Capability::Admin);
    ok_or(who.store().identity_config().await, "config")
}

/// PUT /api/vault/identity/config.
#[utoipa::path(put, path = "/api/vault/identity/config", tag = "Vault",
    summary = "Set the identity token issuer configuration (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_set_config(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<IdentityConfig>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, IDENTITY_CONFIG_KEY, Capability::Admin);
    ok_or(
        who.store().identity_set_config(&body, &who.actor()).await,
        "config",
    )
}

/// POST /api/vault/identity/keys/rotate.
#[utoipa::path(post, path = "/api/vault/identity/keys/rotate", tag = "Vault",
    summary = "Rotate the identity token signing key (admin)",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_rotate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, IDENTITY_CONFIG_KEY, Capability::Admin);
    ok_or(who.store().identity_rotate_key(&who.actor()).await, "kid")
}

/// GET /api/vault/identity/roles.
#[utoipa::path(get, path = "/api/vault/identity/roles", tag = "Vault",
    summary = "List identity token roles",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    match who.store().identity_list_roles().await {
        Ok(roles) => {
            let visible: Vec<_> = roles
                .into_iter()
                .filter(|role| !who.caps(&identity_key(&role.name)).is_empty())
                .collect();
            respond(json!({ "roles": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// PUT /api/vault/identity/roles/{name}.
#[utoipa::path(put, path = "/api/vault/identity/roles/{name}", tag = "Vault",
    summary = "Create or update an identity token role",
    params(("name" = String, Path, description = "Identity token role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_put_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, identity_key(&name), Capability::Admin);
    if let Some(object) = body.as_object_mut() {
        object.insert("name".into(), json!(name));
    }
    let role: IdentityRole = match parse_body(body) {
        Ok(role) => role,
        Err(response) => return response,
    };
    ok_or(
        who.store()
            .identity_put_role(&role, &who.actor())
            .await
            .map(|()| role),
        "role",
    )
}

/// DELETE /api/vault/identity/roles/{name}.
#[utoipa::path(delete, path = "/api/vault/identity/roles/{name}", tag = "Vault",
    summary = "Delete an identity token role",
    params(("name" = String, Path, description = "Identity token role name")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_delete_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, identity_key(&name), Capability::Admin);
    ok_or(
        who.store().identity_delete_role(&name, &who.actor()).await,
        "deleted",
    )
}

async fn issue_token(who: &Caller, role: &str) -> Response {
    require!(who, identity_key(role), Capability::Use);
    let Some(subject) = who.subject() else {
        return invalid_request("identity tokens require an authenticated user or machine token");
    };
    ok_or(
        who.store()
            .identity_token(role, &subject, &who.actor())
            .await,
        "token",
    )
}

/// POST /api/vault/identity/token/{role}.
#[utoipa::path(post, path = "/api/vault/identity/token/{role}", tag = "Vault",
    summary = "Mint a signed identity token for a role",
    params(("role" = String, Path, description = "Identity token role")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_token(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(role): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    issue_token(&who, &role).await
}

/// POST /api/vault/agent/identity/token/{role}.
#[utoipa::path(post, path = "/api/vault/agent/identity/token/{role}", tag = "Vault",
    summary = "Mint a signed identity token for a role with a machine token",
    params(("role" = String, Path, description = "Identity token role")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn agent_identity_token(headers: HeaderMap, Path(role): Path<String>) -> Response {
    let who = caller!(machine(&headers).await);
    issue_token(&who, &role).await
}

/// GET /api/vault/identity/.well-known/openid-configuration (public; plain
/// JSON without the vault envelope, as relying parties expect).
#[utoipa::path(get, path = "/api/vault/identity/.well-known/openid-configuration", tag = "Vault",
    summary = "Public OIDC discovery document for identity tokens",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_discovery() -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.identity_discovery().await {
        Ok(Some(document)) => Json(document).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: no identity issuer is configured".to_owned(),
        ),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/identity/.well-known/keys (public JWKS).
#[utoipa::path(get, path = "/api/vault/identity/.well-known/keys", tag = "Vault",
    summary = "Public JWKS for identity tokens",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_jwks() -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.identity_jwks().await {
        Ok(jwks) => Json(jwks).into_response(),
        Err(error) => vault_error(error),
    }
}

/// Node-bearer routes, merged into the vault router.
pub fn routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post, put};
    let limit = || axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route("/api/vault/transit/wrapping-key", get(transit_wrapping_key))
        .route("/api/vault/transit/deleted", get(transit_deleted))
        .route(
            "/api/vault/transit/keys/:name/import",
            post(transit_import).layer(limit()),
        )
        .route(
            "/api/vault/transit/keys/:name/import-version",
            post(transit_import_version).layer(limit()),
        )
        .route("/api/vault/transit/keys/:name/trim", post(transit_trim))
        .route(
            "/api/vault/transit/keys/:name/recover",
            post(transit_recover),
        )
        .route(
            "/api/vault/transit/export/:kind/:name",
            get(transit_export_all),
        )
        .route(
            "/api/vault/transit/export/:kind/:name/:version",
            get(transit_export_version),
        )
        .route("/api/vault/transit/backup/:name", get(transit_backup))
        .route(
            "/api/vault/transit/restore",
            post(transit_restore).layer(limit()),
        )
        .route(
            "/api/vault/pki/issuers/:name/intermediate/generate",
            post(pki_generate_intermediate),
        )
        .route(
            "/api/vault/pki/issuers/:name/intermediate/set-signed",
            post(pki_set_signed).layer(limit()),
        )
        .route(
            "/api/vault/pki/issuers/:name/import",
            post(pki_import_issuer).layer(limit()),
        )
        .route(
            "/api/vault/pki/issuers/:name/sign-intermediate",
            post(pki_sign_intermediate).layer(limit()),
        )
        .route("/api/vault/pki/tidy", post(pki_tidy))
        .route(
            "/api/vault/identity/config",
            get(identity_config).put(identity_set_config),
        )
        .route("/api/vault/identity/keys/rotate", post(identity_rotate))
        .route("/api/vault/identity/roles", get(identity_roles))
        .route(
            "/api/vault/identity/roles/:name",
            put(identity_put_role).delete(identity_delete_role),
        )
        .route("/api/vault/identity/token/:role", post(identity_token))
}

/// Public routes: the OIDC discovery document, the JWKS, and the
/// machine-token identity route (authorized by the vault token).
pub fn public_routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route(
            "/api/vault/identity/.well-known/openid-configuration",
            get(identity_discovery),
        )
        .route("/api/vault/identity/.well-known/keys", get(identity_jwks))
        .route(
            "/api/vault/agent/identity/token/:role",
            post(agent_identity_token),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_grants_expand_identity_templates() {
        let who = Caller::machine_for_test(vec![crate::vault::policy::PolicyRule {
            path: "sys/identity/{{identity.machine.id}}".into(),
            capabilities: vec![Capability::Use],
            deny: false,
            ..Default::default()
        }]);
        assert!(who.require(&identity_key("mid_x"), Capability::Use).is_ok());
        assert!(who
            .require(&identity_key("mid_y"), Capability::Use)
            .is_err());
    }

    #[test]
    fn machine_identity_tokens_need_an_explicit_use_grant() {
        let who = Caller::machine_for_test(vec![crate::vault::policy::PolicyRule {
            path: "sys/identity/aws".into(),
            capabilities: vec![Capability::Use],
            deny: false,
            ..Default::default()
        }]);
        assert!(who.require(&identity_key("aws"), Capability::Use).is_ok());
        assert!(who.require(&identity_key("gcp"), Capability::Use).is_err());
        assert!(who.require(IDENTITY_CONFIG_KEY, Capability::Admin).is_err());
        let subject = who
            .subject()
            .expect("machine callers always have a subject");
        assert_eq!(subject.kind, "machine");
        assert_eq!(subject.id, "mid_x");
        assert_eq!(subject.policies, vec!["ci".to_owned()]);
    }

    #[test]
    fn restore_targets_are_read_from_the_backup() {
        use base64::Engine as _;
        let backup = base64::engine::general_purpose::STANDARD
            .encode(br#"{"format":"ryu-transit-backup-v1","name":"orders"}"#);
        assert_eq!(backup_name(&backup).as_deref(), Some("orders"));
        assert_eq!(backup_name("not base64"), None);
    }
}
