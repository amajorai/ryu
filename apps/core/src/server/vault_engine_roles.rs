//! PKI and SSH role writes and SSH signing for the engine routes.
//!
//! A role names the issuer (PKI) or CA (SSH) whose key signs under it, so a
//! role grant alone must not reach that key. Writing a role needs `admin` on
//! `sys/pki/<role>` (or `sys/ssh/<role>`) **and** `use` on the issuer or CA it
//! binds, `sys/pki/issuers/<issuer>` (or `sys/ssh/cas/<ca>`). Replacing a role
//! also needs `use` on the issuer or CA it was bound to before, so a delegate
//! cannot move a role off a key they have no grant on.
//!
//! An SSH certificate's key ID is the vault-attested identity downstream
//! servers log and revoke by (`ssh-keygen -k` `id:` entries), so it is always
//! derived from the authenticated caller; a caller-chosen `keyId` is refused.

use axum::response::Response;
use serde_json::{json, Value};

use super::{ok_or, parse_body, vault_error, SshSignBody, Who};
use crate::vault::pki::PkiRole;
use crate::vault::policy::Capability;
use crate::vault::ssh::SshRole;
use crate::vault::VaultError;

/// Policy key of a PKI issuer.
fn issuer_key(issuer: &str) -> String {
    format!("sys/pki/issuers/{issuer}")
}

/// Policy key of an SSH CA.
fn ca_key(ca: &str) -> String {
    format!("sys/ssh/cas/{ca}")
}

/// Require `use` on the new binding and, when it changes, on the old one.
fn require_binding(
    who: &Who,
    key: impl Fn(&str) -> String,
    new: &str,
    previous: Option<&str>,
) -> Result<(), Response> {
    who.require(&key(new), Capability::Use)?;
    match previous {
        Some(previous) if previous != new => who.require(&key(previous), Capability::Use),
        _ => Ok(()),
    }
}

/// Body of `PUT /api/vault/pki/roles/{name}`.
pub(super) async fn pki_put_role_op(who: &Who, name: &str, mut body: Value) -> Response {
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
    let previous = match who.store().pki_list_roles().await {
        Ok(roles) => roles
            .into_iter()
            .find(|existing| existing.name == role.name)
            .map(|existing| existing.issuer),
        Err(error) => return vault_error(error),
    };
    if let Err(response) = require_binding(who, issuer_key, &role.issuer, previous.as_deref()) {
        return response;
    }
    ok_or(
        who.store()
            .pki_put_role(&role, &who.actor())
            .await
            .map(|()| role),
        "role",
    )
}

/// Body of `PUT /api/vault/ssh/roles/{name}`.
pub(super) async fn ssh_put_role_op(who: &Who, name: &str, mut body: Value) -> Response {
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
    let previous = match who.store().ssh_list_roles().await {
        Ok(roles) => roles
            .into_iter()
            .find(|existing| existing.name == role.name)
            .map(|existing| existing.ca),
        Err(error) => return vault_error(error),
    };
    if let Err(response) = require_binding(who, ca_key, &role.ca, previous.as_deref()) {
        return response;
    }
    ok_or(
        who.store()
            .ssh_put_role(&role, &who.actor())
            .await
            .map(|()| role),
        "role",
    )
}

/// Body of the human and machine SSH sign routes.
pub(super) async fn ssh_sign_op(who: &Who, role: &str, body: SshSignBody) -> Response {
    if let Err(response) = who.require(&format!("sys/ssh/{role}"), Capability::Use) {
        return response;
    }
    if body.key_id.is_some() {
        return vault_error(
            VaultError::Denied(
                "`keyId` is not accepted; the certificate key ID is the caller's identity".into(),
            )
            .into(),
        );
    }
    let key_id = who.issued_to();
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

#[cfg(test)]
#[path = "vault_engine_roles_tests.rs"]
mod tests;
