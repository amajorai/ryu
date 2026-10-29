//! Secret Vault engine routes: transit, PKI, SSH certificates, dynamic
//! secrets and leases, machine identities, and machine-authenticated agent
//! routes.
//!
//! Human routes sit under `/api/vault/*` behind the node bearer (plus an
//! optional user JWT) and authorize against `sys/<engine>/<name>` policy keys:
//! configuration managers and the unbound local operator hold every
//! capability; anyone else needs a policy. Managing an engine object needs
//! `admin`; using it (encrypt, sign, issue) needs `use`.
//!
//! Machine routes are public mounts (`/api/vault/auth/*`, `/api/vault/agent/*`)
//! because CI runners and services have no node bearer. Login exchanges an
//! AppRole secret id or an OIDC JWT for a short-lived vault token; agent routes
//! accept only `x-ryu-vault-token` and authorize purely by the token's
//! policies (no baseline). Machines read node-scoped values.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{
    denied, invalid_request, login_token_response, parse_body, respond, store, vault_error, Ctx,
};
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;
use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretResolutionContext, SecretScope,
};
use crate::vault::audit::AuditActor;
use crate::vault::dynamic::ProviderConfig;
use crate::vault::machine::{AuthMethod, TokenPrincipal};
use crate::vault::pki::PkiRole;
use crate::vault::policy::{Capability, CapabilitySet, Policy};
use crate::vault::ssh::SshRole;
use crate::vault::transit::{
    TransitConfigUpdate, TransitKeyOptions, TransitKeyType, TransitOpOptions,
};
use crate::vault::{dotenv, ROOT_PATH};

/// Header carrying a machine vault token.
pub const VAULT_TOKEN_HEADER: &str = "x-ryu-vault-token";

/// Who is calling an engine route. Shared with the Vault-compatible
/// `/v1/*` surface in [`super::vault_compat_api`].
pub(super) enum Who {
    Human(Ctx),
    Machine {
        store: &'static PluginSecretStore,
        principal: TokenPrincipal,
        policies: Vec<Policy>,
    },
}

impl Who {
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

    pub(super) fn issued_to(&self) -> String {
        let actor = self.actor();
        format!("{}:{}", actor.kind, actor.id.unwrap_or_default())
    }

    pub(super) fn sys_caps(&self, key: &str) -> CapabilitySet {
        match self {
            Self::Human(ctx) => ctx.sys_caps(key),
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

    /// Whether a control group gates `read` on `key` for this caller. Machine
    /// tokens cannot open control-group requests, so a gated value is denied.
    pub(super) fn read_gated(&self, key: &str) -> bool {
        match self {
            Self::Human(ctx) => {
                ctx.caller.is_some()
                    && crate::vault::policy_ext::control_group_for(
                        &ctx.policies,
                        key,
                        Capability::Read,
                        &ctx.template_context(),
                    )
                    .is_some()
            }
            Self::Machine {
                policies,
                principal,
                ..
            } => crate::vault::policy_ext::control_group_for(
                policies,
                key,
                Capability::Read,
                &crate::vault::policy_ext::TemplateContext::from_subjects(&[principal.subject()]),
            )
            .is_some(),
        }
    }

    /// The first parameter-constraint violation a write of `value` to the
    /// policy key `key` would commit, if any. Same parameter extraction as
    /// `Ctx::write_parameters_violation`: a JSON-object value contributes its
    /// top-level keys; any other value is the single parameter `value`.
    pub(super) fn write_parameters_violation(&self, key: &str, value: &str) -> Option<String> {
        let (policies, context) = match self {
            Self::Human(ctx) => (&ctx.policies, ctx.template_context()),
            Self::Machine {
                policies,
                principal,
                ..
            } => (
                policies,
                crate::vault::policy_ext::TemplateContext::from_subjects(&[principal.subject()]),
            ),
        };
        let parameters: std::collections::BTreeMap<String, serde_json::Value> =
            match serde_json::from_str::<serde_json::Value>(value) {
                Ok(serde_json::Value::Object(map)) => map.into_iter().collect(),
                _ => std::collections::BTreeMap::from([(
                    "value".to_owned(),
                    serde_json::Value::String(value.to_owned()),
                )]),
            };
        crate::vault::policy_ext::check_parameters(
            policies.iter(),
            key,
            Capability::Write,
            &context,
            &parameters,
        )
        .err()
    }

    pub(super) fn require(&self, key: &str, capability: Capability) -> Result<(), Response> {
        if self.sys_caps(key).contains(&capability) {
            Ok(())
        } else {
            Err(denied(capability, key))
        }
    }
}

pub(super) async fn human(
    state: &ServerState,
    caller: Option<VerifiedCaller>,
    headers: &HeaderMap,
) -> Result<Who, Response> {
    Ctx::load(state, caller, headers).await.map(Who::Human)
}

pub(super) async fn machine(headers: &HeaderMap) -> Result<Who, Response> {
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
    machine_who(store, principal).await
}

/// Build a machine caller from a live token principal. `principal.policies`
/// already holds the identity's policies and its live `machine:<id>`
/// bindings, narrowed for child tokens, so exactly those names resolve.
/// Machines have no baseline capabilities.
pub(super) async fn machine_who(
    store: &'static PluginSecretStore,
    principal: TokenPrincipal,
) -> Result<Who, Response> {
    let policies = {
        let conn = store.conn.lock().await;
        crate::vault::policy::list_policies(&conn)
            .map_err(vault_error)?
            .into_iter()
            .filter(|policy| principal.policies.contains(&policy.name))
            .collect()
    };
    Ok(Who::Machine {
        store,
        principal,
        policies,
    })
}

macro_rules! who {
    ($expr:expr) => {
        match $expr {
            Ok(who) => who,
            Err(response) => return response,
        }
    };
}

/// A listing reduced to the entries the caller holds any capability on, so
/// engine configuration (targets, ARNs, principals) is not enumerable by
/// callers without a grant on it.
fn visible_listing<T: serde::Serialize>(
    who: &Who,
    result: anyhow::Result<Vec<T>>,
    key: &str,
    resource: impl Fn(&T) -> String,
) -> Response {
    match result {
        Ok(items) => {
            let visible: Vec<T> = items
                .into_iter()
                .filter(|item| !who.sys_caps(&resource(item)).is_empty())
                .collect();
            respond(json!({ key: visible }))
        }
        Err(error) => vault_error(error),
    }
}

fn ok_or<T: serde::Serialize>(result: anyhow::Result<T>, key: &str) -> Response {
    match result {
        Ok(value) => respond(json!({ key: value })),
        Err(error) => vault_error(error),
    }
}

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

async fn transit_op(who: &Who, op: &str, name: &str, body: TransitOpBody) -> Response {
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

// ── PKI ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuerBody {
    name: String,
    common_name: String,
    #[serde(default)]
    ttl_secs: Option<i64>,
}

/// GET /api/vault/pki/issuers.
#[utoipa::path(get, path = "/api/vault/pki/issuers", tag = "Vault",
    summary = "List certificate authorities (certificates only)",
    responses((status = 200, description = "Issuers", body = serde_json::Value)))]
pub async fn pki_issuers(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    ok_or(who.store().pki_list_issuers().await, "issuers")
}

/// POST /api/vault/pki/issuers creates a root CA.
#[utoipa::path(post, path = "/api/vault/pki/issuers", tag = "Vault",
    summary = "Create a root certificate authority (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Issuer", body = serde_json::Value)))]
pub async fn pki_create_issuer(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<IssuerBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/pki/issuers/{}", body.name), Capability::Admin)
    {
        return response;
    }
    ok_or(
        who.store()
            .pki_create_root(
                &body.name,
                &body.common_name,
                body.ttl_secs.unwrap_or(10 * 365 * 86_400),
                &who.actor(),
            )
            .await,
        "issuer",
    )
}

/// GET /api/vault/pki/roles.
#[utoipa::path(get, path = "/api/vault/pki/roles", tag = "Vault",
    summary = "List PKI roles",
    responses((status = 200, description = "Roles", body = serde_json::Value)))]
pub async fn pki_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    visible_listing(&who, who.store().pki_list_roles().await, "roles", |role| {
        format!("sys/pki/{}", role.name)
    })
}

/// PUT /api/vault/pki/roles/{name}.
#[utoipa::path(put, path = "/api/vault/pki/roles/{name}", tag = "Vault",
    summary = "Create or replace a PKI role (admin)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn pki_put_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/pki/{name}"), Capability::Admin) {
        return response;
    }
    if let Some(object) = body.as_object_mut() {
        object.insert("name".into(), json!(name));
    }
    let role: PkiRole = match parse_body(body) {
        Ok(role) => role,
        Err(response) => return response,
    };
    ok_or(
        who.store()
            .pki_put_role(&role, &who.actor())
            .await
            .map(|()| role),
        "role",
    )
}

/// DELETE /api/vault/pki/roles/{name}.
#[utoipa::path(delete, path = "/api/vault/pki/roles/{name}", tag = "Vault",
    summary = "Delete a PKI role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn pki_delete_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/pki/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store().pki_delete_role(&name, &who.actor()).await,
        "deleted",
    )
}

/// Body for issuing or signing a certificate.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueBody {
    common_name: String,
    #[serde(default)]
    alt_names: Vec<String>,
    #[serde(default)]
    ip_sans: Vec<String>,
    #[serde(default)]
    ttl_secs: Option<i64>,
    /// For `sign`: a PEM certificate signing request.
    #[serde(default)]
    csr: Option<String>,
}

async fn pki_op(who: &Who, op: &str, role: &str, body: IssueBody) -> Response {
    if let Err(response) = who.require(&format!("sys/pki/{role}"), Capability::Use) {
        return response;
    }
    let store = who.store();
    let actor = who.actor();
    let result = match op {
        "issue" => {
            store
                .pki_issue(
                    role,
                    &body.common_name,
                    &body.alt_names,
                    &body.ip_sans,
                    body.ttl_secs,
                    &actor,
                )
                .await
        }
        "sign" => {
            let Some(csr) = body.csr.as_deref() else {
                return invalid_request("`csr` is required");
            };
            store
                .pki_sign_csr(
                    role,
                    csr,
                    &body.common_name,
                    &body.alt_names,
                    &body.ip_sans,
                    body.ttl_secs,
                    &actor,
                )
                .await
        }
        _ => {
            return json_error(
                StatusCode::NOT_FOUND,
                "vault_not_found: unknown PKI operation".to_owned(),
            )
        }
    };
    ok_or(result, "certificate")
}

/// POST /api/vault/pki/{op}/{role}: `issue` (new key pair) or `sign` (CSR).
#[utoipa::path(post, path = "/api/vault/pki/{op}/{role}", tag = "Vault",
    summary = "Issue a certificate or sign a CSR under a PKI role (use)",
    params(
        ("op" = String, Path, description = "`issue` or `sign`"),
        ("role" = String, Path, description = "Role name"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Certificate (and private key for issue, shown once)", body = serde_json::Value)))]
pub async fn pki_operation(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((op, role)): Path<(String, String)>,
    Json(body): Json<IssueBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    pki_op(&who, &op, &role, body).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeBody {
    serial: String,
}

/// POST /api/vault/pki/revoke.
#[utoipa::path(post, path = "/api/vault/pki/revoke", tag = "Vault",
    summary = "Revoke a certificate by serial (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Revoked record", body = serde_json::Value)))]
pub async fn pki_revoke(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<RevokeBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/pki/revoke", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store().pki_revoke(&body.serial, &who.actor()).await,
        "certificate",
    )
}

/// GET /api/vault/pki/issuers/{name}/certs.
#[utoipa::path(get, path = "/api/vault/pki/issuers/{name}/certs", tag = "Vault",
    summary = "List certificates issued by a CA",
    params(("name" = String, Path, description = "Issuer name")),
    responses((status = 200, description = "Certificate records", body = serde_json::Value)))]
pub async fn pki_certs(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    // Issued certificate names are visible only with a grant on the issuer.
    let issuer = format!("sys/pki/issuers/{name}");
    visible_listing(
        &who,
        who.store().pki_list_certs(&name).await,
        "certificates",
        |_| issuer.clone(),
    )
}

/// GET /api/vault/pki/issuers/{name}/crl returns the signed CRL (PEM).
#[utoipa::path(get, path = "/api/vault/pki/issuers/{name}/crl", tag = "Vault",
    summary = "Current certificate revocation list (PEM)",
    params(("name" = String, Path, description = "Issuer name")),
    responses((status = 200, description = "PEM CRL", body = String)))]
pub async fn pki_crl(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    match who.store().pki_crl(&name).await {
        Ok(pem) => ([("content-type", "application/x-pem-file")], pem).into_response(),
        Err(error) => vault_error(error),
    }
}

// ── SSH ───────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct NameBody {
    name: String,
}

/// GET /api/vault/ssh/cas lists SSH CAs with their public keys.
#[utoipa::path(get, path = "/api/vault/ssh/cas", tag = "Vault",
    summary = "List SSH certificate authorities (public keys)",
    responses((status = 200, description = "CAs", body = serde_json::Value)))]
pub async fn ssh_cas(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    match who.store().ssh_list_cas().await {
        Ok(cas) => respond(json!({
            "cas": cas.into_iter().map(|(name, public_key)| json!({ "name": name, "publicKey": public_key })).collect::<Vec<_>>()
        })),
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/ssh/cas creates an Ed25519 SSH CA.
#[utoipa::path(post, path = "/api/vault/ssh/cas", tag = "Vault",
    summary = "Create an SSH certificate authority (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "CA public key", body = serde_json::Value)))]
pub async fn ssh_create_ca(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<NameBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/ssh/cas/{}", body.name), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store().ssh_create_ca(&body.name, &who.actor()).await,
        "publicKey",
    )
}

/// GET /api/vault/ssh/roles.
#[utoipa::path(get, path = "/api/vault/ssh/roles", tag = "Vault",
    summary = "List SSH roles",
    responses((status = 200, description = "Roles", body = serde_json::Value)))]
pub async fn ssh_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    visible_listing(&who, who.store().ssh_list_roles().await, "roles", |role| {
        format!("sys/ssh/{}", role.name)
    })
}

/// PUT /api/vault/ssh/roles/{name}.
#[utoipa::path(put, path = "/api/vault/ssh/roles/{name}", tag = "Vault",
    summary = "Create or replace an SSH role (admin)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved", body = serde_json::Value)))]
pub async fn ssh_put_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/ssh/{name}"), Capability::Admin) {
        return response;
    }
    if let Some(object) = body.as_object_mut() {
        object.insert("name".into(), json!(name));
    }
    let role: SshRole = match parse_body(body) {
        Ok(role) => role,
        Err(response) => return response,
    };
    ok_or(
        who.store()
            .ssh_put_role(&role, &who.actor())
            .await
            .map(|()| role),
        "role",
    )
}

/// DELETE /api/vault/ssh/roles/{name}.
#[utoipa::path(delete, path = "/api/vault/ssh/roles/{name}", tag = "Vault",
    summary = "Delete an SSH role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn ssh_delete_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/ssh/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store().ssh_delete_role(&name, &who.actor()).await,
        "deleted",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSignBody {
    public_key: String,
    #[serde(default)]
    principals: Vec<String>,
    #[serde(default)]
    ttl_secs: Option<i64>,
    #[serde(default)]
    key_id: Option<String>,
}

async fn ssh_sign_op(who: &Who, role: &str, body: SshSignBody) -> Response {
    if let Err(response) = who.require(&format!("sys/ssh/{role}"), Capability::Use) {
        return response;
    }
    let key_id = body.key_id.unwrap_or_else(|| who.issued_to());
    ok_or(
        who.store()
            .ssh_sign(
                role,
                &body.public_key,
                &body.principals,
                body.ttl_secs,
                Some(&key_id),
                &who.actor(),
            )
            .await,
        "certificate",
    )
}

/// POST /api/vault/ssh/sign/{role} signs a public key.
#[utoipa::path(post, path = "/api/vault/ssh/sign/{role}", tag = "Vault",
    summary = "Sign an SSH public key into a short-lived certificate (use)",
    params(("role" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OpenSSH certificate", body = serde_json::Value)))]
pub async fn ssh_sign(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(role): Path<String>,
    Json(body): Json<SshSignBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    ssh_sign_op(&who, &role, body).await
}

// ── Dynamic secrets and leases ────────────────────────────────────────────

/// GET /api/vault/dynamic/roles.
#[utoipa::path(get, path = "/api/vault/dynamic/roles", tag = "Vault",
    summary = "List dynamic-secret roles (provider credentials redacted)",
    responses((status = 200, description = "Roles", body = serde_json::Value)))]
pub async fn dynamic_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    visible_listing(
        &who,
        who.store().dynamic_list_roles().await,
        "roles",
        |role| format!("sys/dynamic/{}", role.name),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicRoleBody {
    provider: ProviderConfig,
    #[serde(default)]
    default_ttl_secs: Option<i64>,
    #[serde(default)]
    max_ttl_secs: Option<i64>,
}

/// PUT /api/vault/dynamic/roles/{name}.
#[utoipa::path(put, path = "/api/vault/dynamic/roles/{name}", tag = "Vault",
    summary = "Create or replace a dynamic-secret role (admin)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved (redacted)", body = serde_json::Value)))]
pub async fn dynamic_put_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<DynamicRoleBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/dynamic/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .dynamic_put_role(
                &name,
                &body.provider,
                body.default_ttl_secs,
                body.max_ttl_secs,
                &who.actor(),
            )
            .await,
        "role",
    )
}

/// DELETE /api/vault/dynamic/roles/{name}.
#[utoipa::path(delete, path = "/api/vault/dynamic/roles/{name}", tag = "Vault",
    summary = "Delete a dynamic-secret role with no live leases (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn dynamic_delete_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/dynamic/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .dynamic_delete_role(&name, &who.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

/// POST /api/vault/dynamic/roles/{name}/revoke-all.
#[utoipa::path(post, path = "/api/vault/dynamic/roles/{name}/revoke-all", tag = "Vault",
    summary = "Revoke every live lease of a role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Revoked count", body = serde_json::Value)))]
pub async fn dynamic_revoke_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/dynamic/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store().dynamic_revoke_role(&name, &who.actor()).await,
        "revoked",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtlBody {
    #[serde(default)]
    ttl_secs: Option<i64>,
}

async fn dynamic_issue_op(who: &Who, role: &str, ttl_secs: Option<i64>) -> Response {
    if let Err(response) = who.require(&format!("sys/dynamic/{role}"), Capability::Use) {
        return response;
    }
    let issued_to = who.issued_to();
    ok_or(
        who.store()
            .dynamic_issue(role, ttl_secs, Some(&issued_to), &who.actor())
            .await,
        "credential",
    )
}

/// POST /api/vault/dynamic/issue/{role} mints a credential under a lease.
#[utoipa::path(post, path = "/api/vault/dynamic/issue/{role}", tag = "Vault",
    summary = "Issue a dynamic credential (use); the value is returned once",
    params(("role" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Credential and lease", body = serde_json::Value)))]
pub async fn dynamic_issue(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(role): Path<String>,
    body: Option<Json<TtlBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    dynamic_issue_op(&who, &role, body.and_then(|Json(body)| body.ttl_secs)).await
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseQuery {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    include_revoked: Option<bool>,
}

/// GET /api/vault/leases.
#[utoipa::path(get, path = "/api/vault/leases", tag = "Vault",
    summary = "List dynamic-secret leases (admin)",
    params(
        ("role" = Option<String>, Query, description = "Role filter"),
        ("includeRevoked" = Option<bool>, Query, description = "Include revoked leases"),
    ),
    responses((status = 200, description = "Leases", body = serde_json::Value)))]
pub async fn leases(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<LeaseQuery>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/leases", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .lease_list(
                query.role.as_deref(),
                query.include_revoked.unwrap_or(false),
            )
            .await,
        "leases",
    )
}

async fn lease_op(who: &Who, id: &str, op: &str, ttl_secs: Option<i64>) -> Response {
    let lease = match who.store().lease_get(id).await {
        Ok(lease) => lease,
        Err(error) => return vault_error(error),
    };
    // The holder may renew or revoke its own lease; otherwise admin on the role.
    let own = lease.issued_to.as_deref() == Some(who.issued_to().as_str());
    if !own {
        if let Err(response) =
            who.require(&format!("sys/dynamic/{}", lease.role), Capability::Admin)
        {
            return response;
        }
    }
    let actor = who.actor();
    match op {
        "renew" => ok_or(
            who.store().dynamic_renew(id, ttl_secs, &actor).await,
            "lease",
        ),
        "revoke" => ok_or(who.store().dynamic_revoke(id, &actor).await, "lease"),
        _ => json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: unknown lease operation".to_owned(),
        ),
    }
}

/// POST /api/vault/leases/{id}/{op}: `renew` or `revoke`.
#[utoipa::path(post, path = "/api/vault/leases/{id}/{op}", tag = "Vault",
    summary = "Renew or revoke a lease (holder or admin)",
    params(
        ("id" = String, Path, description = "Lease id"),
        ("op" = String, Path, description = "`renew` or `revoke`"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Lease", body = serde_json::Value)))]
pub async fn lease_operation(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((id, op)): Path<(String, String)>,
    body: Option<Json<TtlBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    lease_op(&who, &id, &op, body.and_then(|Json(body)| body.ttl_secs)).await
}

// ── Machine identities ────────────────────────────────────────────────────

/// GET /api/vault/machines.
#[utoipa::path(get, path = "/api/vault/machines", tag = "Vault",
    summary = "List machine identities (admin)",
    responses((status = 200, description = "Identities", body = serde_json::Value)))]
pub async fn machines(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(who.store().machine_list().await, "machines")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineBody {
    name: String,
    auth: AuthMethod,
    #[serde(default)]
    policies: Vec<String>,
    #[serde(default)]
    token_ttl_secs: Option<i64>,
}

/// POST /api/vault/machines creates an AppRole or JWT identity.
#[utoipa::path(post, path = "/api/vault/machines", tag = "Vault",
    summary = "Create a machine identity (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Identity", body = serde_json::Value)))]
pub async fn machine_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<MachineBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .machine_create(
                &body.name,
                body.auth,
                body.policies,
                body.token_ttl_secs,
                &who.actor(),
            )
            .await,
        "machine",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePatch {
    #[serde(default)]
    policies: Option<Vec<String>>,
    #[serde(default)]
    token_ttl_secs: Option<i64>,
    #[serde(default)]
    disabled: Option<bool>,
}

/// PATCH /api/vault/machines/{id}.
#[utoipa::path(patch, path = "/api/vault/machines/{id}", tag = "Vault",
    summary = "Update a machine identity; disabling revokes its tokens (admin)",
    params(("id" = String, Path, description = "Identity id or name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Identity", body = serde_json::Value)))]
pub async fn machine_update(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<MachinePatch>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .machine_update(
                &id,
                body.policies,
                body.token_ttl_secs,
                body.disabled,
                &who.actor(),
            )
            .await,
        "machine",
    )
}

/// DELETE /api/vault/machines/{id}.
#[utoipa::path(delete, path = "/api/vault/machines/{id}", tag = "Vault",
    summary = "Delete a machine identity and its tokens (admin)",
    params(("id" = String, Path, description = "Identity id or name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn machine_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .machine_delete(&id, &who.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretIdBody {
    #[serde(default)]
    ttl_secs: Option<i64>,
    #[serde(default)]
    uses: Option<i64>,
    /// Client CIDRs allowed to log in with the secret id.
    #[serde(default)]
    cidr_list: Vec<String>,
    /// CIDRs bound to tokens issued with the secret id.
    #[serde(default)]
    token_bound_cidrs: Vec<String>,
}

/// GET or POST /api/vault/machines/{id}/secret-ids.
#[utoipa::path(post, path = "/api/vault/machines/{id}/secret-ids", tag = "Vault",
    summary = "Issue an AppRole secret id (admin); the value is returned once",
    params(("id" = String, Path, description = "Identity id or name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Secret id", body = serde_json::Value)))]
pub async fn machine_issue_secret_id(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<SecretIdBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    match who
        .store()
        .machine_issue_secret_id_with(
            &id,
            crate::vault::tokens::SecretIdOptions {
                ttl_secs: body.ttl_secs,
                uses: body.uses,
                cidr_list: body.cidr_list,
                token_bound_cidrs: body.token_bound_cidrs,
            },
            &who.actor(),
        )
        .await
    {
        Ok((secret_id, info)) => respond(json!({ "secretId": secret_id, "info": info })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/machines/{id}/secret-ids.
#[utoipa::path(get, path = "/api/vault/machines/{id}/secret-ids", tag = "Vault",
    summary = "List AppRole secret ids (metadata only, admin)",
    params(("id" = String, Path, description = "Identity id or name")),
    responses((status = 200, description = "Secret id metadata", body = serde_json::Value)))]
pub async fn machine_secret_ids(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(who.store().machine_list_secret_ids(&id).await, "secretIds")
}

/// DELETE /api/vault/secret-ids/{accessor}.
#[utoipa::path(delete, path = "/api/vault/secret-ids/{accessor}", tag = "Vault",
    summary = "Destroy an AppRole secret id (admin)",
    params(("accessor" = String, Path, description = "Secret id accessor")),
    responses((status = 200, description = "Destroyed", body = serde_json::Value)))]
pub async fn machine_revoke_secret_id(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .machine_revoke_secret_id(&accessor, &who.actor())
            .await
            .map(|()| true),
        "revoked",
    )
}

/// POST /api/vault/tokens/{accessor}/revoke.
#[utoipa::path(post, path = "/api/vault/tokens/{accessor}/revoke", tag = "Vault",
    summary = "Revoke a machine vault token by accessor (admin)",
    params(("accessor" = String, Path, description = "Token accessor")),
    responses((status = 200, description = "Revoked", body = serde_json::Value)))]
pub async fn token_revoke(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .token_revoke(&accessor, &who.actor())
            .await
            .map(|()| true),
        "revoked",
    )
}

// ── Public machine login ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRoleLogin {
    role_id: String,
    secret_id: String,
}

/// POST /api/vault/auth/approle/login (public).
#[utoipa::path(post, path = "/api/vault/auth/approle/login", tag = "Vault",
    summary = "Exchange an AppRole role id and secret id for a vault token",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault token (shown once)", body = serde_json::Value),
        (status = 403, description = "Invalid credentials", body = serde_json::Value),
    ))]
pub async fn approle_login(Json(body): Json<AppRoleLogin>) -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    ok_or(
        store.approle_login(&body.role_id, &body.secret_id).await,
        "token",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtLogin {
    identity: String,
    jwt: String,
}

/// POST /api/vault/auth/jwt/login (public).
#[utoipa::path(post, path = "/api/vault/auth/jwt/login", tag = "Vault",
    summary = "Exchange an OIDC/JWT (for example a GitHub Actions token) for a vault token",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault token (shown once)", body = serde_json::Value),
        (status = 403, description = "JWT rejected", body = serde_json::Value),
    ))]
pub async fn jwt_login(Json(body): Json<JwtLogin>) -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    login_token_response(store.jwt_login(&body.identity, &body.jwt).await)
}

// ── Agent routes (x-ryu-vault-token) ──────────────────────────────────────

/// GET /api/vault/agent/self describes the presented token.
#[utoipa::path(get, path = "/api/vault/agent/self", tag = "Vault",
    summary = "Describe the presented machine token",
    responses((status = 200, description = "Token principal", body = serde_json::Value)))]
pub async fn agent_self(headers: HeaderMap) -> Response {
    match who!(machine(&headers).await) {
        Who::Machine { principal, .. } => respond(json!({ "token": principal })),
        Who::Human(_) => unreachable!("machine() only returns machines"),
    }
}

/// POST /api/vault/agent/self/revoke revokes the presented token.
#[utoipa::path(post, path = "/api/vault/agent/self/revoke", tag = "Vault",
    summary = "Revoke the presented machine token",
    responses((status = 200, description = "Revoked", body = serde_json::Value)))]
pub async fn agent_revoke_self(headers: HeaderMap) -> Response {
    let who = who!(machine(&headers).await);
    let Who::Machine {
        store, principal, ..
    } = &who
    else {
        unreachable!("machine() only returns machines")
    };
    ok_or(
        store
            .token_revoke(&principal.accessor, &principal.actor())
            .await
            .map(|()| true),
        "revoked",
    )
}

fn node_coords(
    node_id: &str,
    environment: &str,
    path: &str,
    name: &str,
) -> Result<SecretCoords, Response> {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: node_id.to_owned(),
        environment: environment.to_owned(),
        path: path.to_owned(),
        binding: None,
        name: name.to_owned(),
    }
    .normalize()
    .map_err(|error| invalid_request(&error.to_string()))
}

pub(super) fn local_node_id() -> String {
    crate::sidecar::control_plane::registered_node()
        .map(|node| node.node_id)
        .unwrap_or_else(crate::server::agent_sync::local_node_id)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExportBody {
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    names: Option<Vec<String>>,
    #[serde(default)]
    k8s_name: Option<String>,
    #[serde(default)]
    k8s_namespace: Option<String>,
}

/// POST /api/vault/agent/export renders the node values the token may read.
#[utoipa::path(post, path = "/api/vault/agent/export", tag = "Vault",
    summary = "Export node-scoped values the machine token may read",
    request_body = serde_json::Value,
    responses((status = 200, description = "Rendered content", body = serde_json::Value)))]
pub async fn agent_export(headers: HeaderMap, body: Option<Json<AgentExportBody>>) -> Response {
    let who = who!(machine(&headers).await);
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let format = match body.format.as_deref().map(dotenv::Format::parse) {
        None => dotenv::Format::Dotenv,
        Some(Some(format)) => format,
        Some(None) => return invalid_request("unknown format"),
    };
    let environment = body
        .environment
        .unwrap_or_else(crate::vault::active_environment);
    let path = body.path.unwrap_or_else(|| ROOT_PATH.to_owned());
    let context = SecretResolutionContext {
        environment: Some(environment.clone()),
        ..SecretResolutionContext::node_only(local_node_id(), Vec::new())
    };
    let values = match who
        .store()
        .effective_local_values(&context, &environment, &path, |coords| {
            coords.scope == SecretScope::Node
                && who
                    .sys_caps(&coords.policy_key())
                    .contains(&Capability::Read)
                && !who.read_gated(&coords.policy_key())
        })
        .await
    {
        Ok(values) => values,
        Err(error) => return vault_error(error),
    };
    let mut rendered: std::collections::BTreeMap<String, String> = values
        .into_iter()
        .map(|(name, (_, value))| (name, value))
        .collect();
    if let Some(names) = &body.names {
        rendered.retain(|name, _| names.contains(name));
    }
    if !who
        .store()
        .audit(
            &crate::vault::audit::AuditEntry::new(&who.actor(), "vault.export", "ok").details(
                json!({
                    "environment": environment, "path": path, "count": rendered.len(),
                    "names": rendered.keys().collect::<Vec<_>>(),
                }),
            ),
        )
        .await
    {
        return vault_error(crate::vault::VaultError::AuditUnavailable.into());
    }
    let k8s = dotenv::K8sOptions {
        name: body.k8s_name,
        namespace: body.k8s_namespace,
    };
    match dotenv::serialize(&rendered, format, &k8s) {
        Ok(content) => respond(json!({
            "format": format, "contentType": format.content_type(), "count": rendered.len(),
            "environment": environment, "path": path, "content": content,
        })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSecretQuery {
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    /// A specific version; the current one when absent.
    #[serde(default)]
    version: Option<i64>,
}

/// GET /api/vault/agent/secrets/{name} reveals one node-scoped value.
#[utoipa::path(get, path = "/api/vault/agent/secrets/{name}", tag = "Vault",
    summary = "Read one node-scoped value with a machine token (read)",
    params(
        ("name" = String, Path, description = "Secret name"),
        ("environment" = Option<String>, Query, description = "Environment (default: node's active)"),
        ("path" = Option<String>, Query, description = "Folder (default /)"),
    ),
    responses((status = 200, description = "Value", body = serde_json::Value)))]
pub async fn agent_secret(
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<AgentSecretQuery>,
) -> Response {
    let who = who!(machine(&headers).await);
    let environment = query
        .environment
        .unwrap_or_else(crate::vault::active_environment);
    let coords = match node_coords(
        &local_node_id(),
        &environment,
        query.path.as_deref().unwrap_or(ROOT_PATH),
        &name,
    ) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    if let Err(response) = who.require(&coords.policy_key(), Capability::Read) {
        return response;
    }
    if who.read_gated(&coords.policy_key()) {
        return json_error(
            axum::http::StatusCode::FORBIDDEN,
            format!(
                "vault_control_group_required: `{}` needs control-group approval, which machine tokens cannot request",
                coords.policy_key()
            ),
        );
    }
    ok_or(
        who.store()
            .reveal(&coords, query.version, &who.actor())
            .await,
        "value",
    )
}

/// POST /api/vault/agent/dynamic/{role}.
#[utoipa::path(post, path = "/api/vault/agent/dynamic/{role}", tag = "Vault",
    summary = "Issue a dynamic credential with a machine token (use)",
    params(("role" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Credential and lease", body = serde_json::Value)))]
pub async fn agent_dynamic_issue(
    headers: HeaderMap,
    Path(role): Path<String>,
    body: Option<Json<TtlBody>>,
) -> Response {
    let who = who!(machine(&headers).await);
    dynamic_issue_op(&who, &role, body.and_then(|Json(body)| body.ttl_secs)).await
}

/// POST /api/vault/agent/leases/{id}/{op}.
#[utoipa::path(post, path = "/api/vault/agent/leases/{id}/{op}", tag = "Vault",
    summary = "Renew or revoke the machine's own lease",
    params(
        ("id" = String, Path, description = "Lease id"),
        ("op" = String, Path, description = "`renew` or `revoke`"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Lease", body = serde_json::Value)))]
pub async fn agent_lease_operation(
    headers: HeaderMap,
    Path((id, op)): Path<(String, String)>,
    body: Option<Json<TtlBody>>,
) -> Response {
    let who = who!(machine(&headers).await);
    lease_op(&who, &id, &op, body.and_then(|Json(body)| body.ttl_secs)).await
}

/// POST /api/vault/agent/transit/{op}/{name}.
#[utoipa::path(post, path = "/api/vault/agent/transit/{op}/{name}", tag = "Vault",
    summary = "Run a transit operation with a machine token (use)",
    params(
        ("op" = String, Path, description = "encrypt, decrypt, rewrap, datakey, sign, verify, hmac"),
        ("name" = String, Path, description = "Key name"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn agent_transit(
    headers: HeaderMap,
    Path((op, name)): Path<(String, String)>,
    body: Option<Json<TransitOpBody>>,
) -> Response {
    let who = who!(machine(&headers).await);
    transit_op(
        &who,
        &op,
        &name,
        body.map(|Json(body)| body).unwrap_or_default(),
    )
    .await
}

/// POST /api/vault/agent/pki/{op}/{role}.
#[utoipa::path(post, path = "/api/vault/agent/pki/{op}/{role}", tag = "Vault",
    summary = "Issue a certificate or sign a CSR with a machine token (use)",
    params(
        ("op" = String, Path, description = "`issue` or `sign`"),
        ("role" = String, Path, description = "Role name"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Certificate", body = serde_json::Value)))]
pub async fn agent_pki(
    headers: HeaderMap,
    Path((op, role)): Path<(String, String)>,
    Json(body): Json<IssueBody>,
) -> Response {
    let who = who!(machine(&headers).await);
    pki_op(&who, &op, &role, body).await
}

/// POST /api/vault/agent/ssh/sign/{role}.
#[utoipa::path(post, path = "/api/vault/agent/ssh/sign/{role}", tag = "Vault",
    summary = "Sign an SSH public key with a machine token (use)",
    params(("role" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OpenSSH certificate", body = serde_json::Value)))]
pub async fn agent_ssh_sign(
    headers: HeaderMap,
    Path(role): Path<String>,
    Json(body): Json<SshSignBody>,
) -> Response {
    let who = who!(machine(&headers).await);
    ssh_sign_op(&who, &role, body).await
}

/// Public machine routes (in-handler token auth).
pub fn public_routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route("/api/vault/auth/approle/login", post(approle_login))
        .route("/api/vault/auth/jwt/login", post(jwt_login))
        .route("/api/vault/agent/self", get(agent_self))
        .route(
            "/api/vault/agent/events",
            get(super::vault_audit_events_api::agent_events),
        )
        .route("/api/vault/agent/self/revoke", post(agent_revoke_self))
        .route("/api/vault/agent/export", post(agent_export))
        .route("/api/vault/agent/secrets/:name", get(agent_secret))
        .route("/api/vault/agent/dynamic/:role", post(agent_dynamic_issue))
        .route(
            "/api/vault/agent/leases/:id/:op",
            post(agent_lease_operation),
        )
        .route("/api/vault/agent/transit/:op/:name", post(agent_transit))
        .route("/api/vault/agent/pki/:op/:role", post(agent_pki))
        .route("/api/vault/agent/ssh/sign/:role", post(agent_ssh_sign))
        .layer(limit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn login_failures_do_not_reveal_identity_names_or_methods() {
        use crate::vault::VaultError;
        let body = |response: Response| async move {
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
                .await
                .unwrap();
            (status, String::from_utf8_lossy(&bytes).into_owned())
        };
        let mut seen = Vec::new();
        for error in [
            VaultError::NotFound("machine identity `ci`".into()),
            VaultError::Invalid("identity does not use JWT login".into()),
            VaultError::Denied("identity is disabled".into()),
            VaultError::Denied("JWT rejected: bad audience".into()),
            VaultError::Conflict("busy".into()),
        ] {
            let (status, text) = body(login_token_response::<String>(Err(error.into()))).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
            seen.push(text);
        }
        assert!(seen.windows(2).all(|pair| pair[0] == pair[1]), "{seen:?}");
        assert!(!seen[0].contains("ci") && !seen[0].contains("JWT"));
        let (status, _) = body(login_token_response::<String>(Err(
            VaultError::Sealed.into()
        )))
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        let (status, text) = body(login_token_response(Ok("t".to_owned()))).await;
        assert_eq!(status, StatusCode::OK, "{text}");
    }

    #[tokio::test]
    async fn machine_principals_have_no_baseline() {
        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let principal = TokenPrincipal {
            accessor: "rva_x".into(),
            identity_id: "mid_x".into(),
            identity_name: "ci".into(),
            policies: vec!["ci".into()],
            expires_at: i64::MAX,
        };
        let policy = Policy {
            name: "ci".into(),
            description: String::new(),
            rules: vec![crate::vault::policy::PolicyRule {
                path: "sys/transit/payments".into(),
                capabilities: vec![Capability::Use],
                deny: false,
                ..Default::default()
            }],
        };
        let who = Who::Machine {
            store,
            principal,
            policies: vec![policy],
        };
        assert!(who.require("sys/transit/payments", Capability::Use).is_ok());
        assert!(who
            .require("sys/transit/payments", Capability::Admin)
            .is_err());
        assert!(who.require("sys/transit/other", Capability::Use).is_err());
        assert!(who.require("default/API_KEY", Capability::Read).is_err());
        assert_eq!(who.issued_to(), "machine:mid_x");
    }
}
