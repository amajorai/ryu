//! PKI and SSH certificate engine routes: issuers, CAs, roles, issuance, and revocation.
//!
//! Split out of [`super`]; the handlers are re-exported there so their
//! public paths (and OpenAPI `__path_*` items) stay stable.
//!
//! test-exempt: handlers moved verbatim out of `vault_engines_api.rs`; covered by
//! vault_public_routes_auth_test.rs, vault_engine_roles_tests.rs, and the vault engine tests.

use super::*;

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
    Json(body): Json<Value>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    roles::pki_put_role_op(&who, &name, body).await
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

pub(super) async fn pki_op(who: &Who, op: &str, role: &str, body: IssueBody) -> Response {
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
    Json(body): Json<Value>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    roles::ssh_put_role_op(&who, &name, body).await
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
    pub(super) public_key: String,
    #[serde(default)]
    pub(super) principals: Vec<String>,
    #[serde(default)]
    pub(super) ttl_secs: Option<i64>,
    #[serde(default)]
    pub(super) key_id: Option<String>,
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
