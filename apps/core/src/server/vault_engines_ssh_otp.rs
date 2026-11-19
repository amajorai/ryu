//! SSH OTP routes (roles, `creds`, and the public `verify` the host helper
//! calls) and SSH certificate revocation (recorded certificates, `revoke`,
//! and the CA's KRL).
//!
//! OTP roles authorize against `sys/ssh/otp/<role>`: `admin` manages a role,
//! `use` issues an OTP. Revocation needs `admin` on `sys/ssh/cas/<ca>`;
//! listing a CA's certificates needs a grant on it. The KRL, like the PKI
//! CRL, is readable by any authenticated caller. `verify` is public: the OTP
//! is the credential, it is consumed on first use, and every refusal is the
//! same `403 OTP not found`.

use crate::vault::ssh::{SshOtpRole, SshRevocation};

use super::*;

fn otp_key(role: &str) -> String {
    format!("sys/ssh/otp/{role}")
}

/// GET /api/vault/ssh/otp-roles.
#[utoipa::path(get, path = "/api/vault/ssh/otp-roles", tag = "Vault",
    summary = "List SSH OTP roles",
    responses((status = 200, description = "Roles", body = serde_json::Value)))]
pub async fn ssh_otp_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    visible_listing(
        &who,
        who.store().ssh_list_otp_roles().await,
        "roles",
        |role| otp_key(&role.name),
    )
}

/// PUT /api/vault/ssh/otp-roles/{name}.
#[utoipa::path(put, path = "/api/vault/ssh/otp-roles/{name}", tag = "Vault",
    summary = "Create or replace an SSH OTP role (admin)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved role", body = serde_json::Value)))]
pub async fn ssh_put_otp_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&otp_key(&name), Capability::Admin) {
        return response;
    }
    if let Some(object) = body.as_object_mut() {
        object.insert("name".into(), Value::String(name));
    }
    let role: SshOtpRole = match serde_json::from_value(body) {
        Ok(role) => role,
        Err(error) => return invalid_request(&format!("invalid OTP role: {error}")),
    };
    ok_or(
        who.store().ssh_put_otp_role(&role, &who.actor()).await,
        "role",
    )
}

/// DELETE /api/vault/ssh/otp-roles/{name}.
#[utoipa::path(delete, path = "/api/vault/ssh/otp-roles/{name}", tag = "Vault",
    summary = "Delete an SSH OTP role and its unused OTPs (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn ssh_delete_otp_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&otp_key(&name), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store().ssh_delete_otp_role(&name, &who.actor()).await,
        "deleted",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OtpCredsBody {
    ip: String,
    #[serde(default)]
    username: Option<String>,
}

/// POST /api/vault/ssh/creds/{role}.
#[utoipa::path(post, path = "/api/vault/ssh/creds/{role}", tag = "Vault",
    summary = "Issue a one-time SSH password for a host (use)",
    params(("role" = String, Path, description = "OTP role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OTP credential (shown once)", body = serde_json::Value)))]
pub async fn ssh_otp_creds(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(role): Path<String>,
    Json(body): Json<OtpCredsBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&otp_key(&role), Capability::Use) {
        return response;
    }
    ok_or(
        who.store()
            .ssh_create_otp(&role, &body.ip, body.username.as_deref(), &who.actor())
            .await,
        "credential",
    )
}

#[derive(Debug, Deserialize)]
pub struct OtpVerifyBody {
    otp: String,
}

/// POST /api/vault/ssh/verify (public; the target host's helper).
#[utoipa::path(post, path = "/api/vault/ssh/verify", tag = "Vault",
    summary = "Verify and consume a one-time SSH password (public)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Username, host, port and role the OTP was for", body = serde_json::Value),
        (status = 403, description = "Unknown, used, or expired OTP", body = serde_json::Value),
    ))]
pub async fn ssh_otp_verify(Json(body): Json<OtpVerifyBody>) -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let actor = AuditActor::new("ssh-helper", None);
    match store.ssh_verify_otp(&body.otp, &actor).await {
        Ok(verified) => respond(json!(verified)),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/ssh/cas/{name}/certs.
#[utoipa::path(get, path = "/api/vault/ssh/cas/{name}/certs", tag = "Vault",
    summary = "List certificates an SSH CA signed",
    params(("name" = String, Path, description = "CA name")),
    responses((status = 200, description = "Certificate records", body = serde_json::Value)))]
pub async fn ssh_certs(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    let ca = format!("sys/ssh/cas/{name}");
    visible_listing(
        &who,
        who.store().ssh_list_certs(&name).await,
        "certificates",
        |_| ca.clone(),
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRevokeBody {
    /// Decimal string or number, or `0x`-prefixed hex.
    #[serde(default)]
    serial: Option<Value>,
    #[serde(default)]
    key_id: Option<String>,
}

fn parse_serial(value: &Value) -> Option<u64> {
    match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => {
            let text = text.trim();
            match text.strip_prefix("0x") {
                Some(hex) => u64::from_str_radix(hex, 16).ok(),
                None => text.parse().ok(),
            }
        }
        _ => None,
    }
}

fn revocation(body: SshRevokeBody) -> Result<SshRevocation, Response> {
    match (body.serial, body.key_id) {
        (Some(serial), None) => parse_serial(&serial)
            .map(SshRevocation::Serial)
            .ok_or_else(|| invalid_request("`serial` must be a decimal or 0x-hex u64")),
        (None, Some(key_id)) => Ok(SshRevocation::KeyId(key_id)),
        _ => Err(invalid_request("give exactly one of `serial` or `keyId`")),
    }
}

/// POST /api/vault/ssh/cas/{name}/revoke.
#[utoipa::path(post, path = "/api/vault/ssh/cas/{name}/revoke", tag = "Vault",
    summary = "Revoke SSH certificates by serial or key ID (admin)",
    params(("name" = String, Path, description = "CA name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Revoked records", body = serde_json::Value)))]
pub async fn ssh_revoke(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<SshRevokeBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/ssh/cas/{name}"), Capability::Admin) {
        return response;
    }
    let what = match revocation(body) {
        Ok(what) => what,
        Err(response) => return response,
    };
    ok_or(
        who.store().ssh_revoke(&name, &what, &who.actor()).await,
        "certificates",
    )
}

/// GET /api/vault/ssh/cas/{name}/krl returns the binary OpenSSH KRL.
#[utoipa::path(get, path = "/api/vault/ssh/cas/{name}/krl", tag = "Vault",
    summary = "Current key revocation list of an SSH CA (OpenSSH KRL)",
    params(("name" = String, Path, description = "CA name")),
    responses((status = 200, description = "Binary KRL for sshd RevokedKeys", body = Vec<u8>, content_type = "application/octet-stream")))]
pub async fn ssh_krl(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    match who.store().ssh_krl(&name).await {
        Ok(krl) => ([("content-type", "application/octet-stream")], krl).into_response(),
        Err(error) => vault_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revocations_take_one_serial_form_or_a_key_id() {
        let body = |value: Value| serde_json::from_value::<SshRevokeBody>(value).unwrap();
        for (input, expected) in [
            (json!({ "serial": 42 }), 42u64),
            (json!({ "serial": "18446744073709551615" }), u64::MAX),
            (json!({ "serial": "0xff" }), 255),
        ] {
            assert_eq!(
                revocation(body(input)).ok(),
                Some(SshRevocation::Serial(expected))
            );
        }
        assert_eq!(
            revocation(body(json!({ "keyId": "ci" }))).ok(),
            Some(SshRevocation::KeyId("ci".into()))
        );
        for bad in [
            json!({}),
            json!({ "serial": 1, "keyId": "ci" }),
            json!({ "serial": -1 }),
            json!({ "serial": "0xzz" }),
            json!({ "serial": true }),
        ] {
            assert!(revocation(body(bad.clone())).is_err(), "{bad}");
        }
    }
}
