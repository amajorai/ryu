//! Kubernetes service-account tokens.
//!
//! The role stores a bearer token for an account Ryu acts as and one of two
//! modes:
//!
//! * `serviceAccountName`: a `TokenRequest` for that existing account. Bound
//!   tokens cannot be revoked one by one, so revocation ends the lease and the
//!   token expires on its own (at least 10 minutes, a Kubernetes minimum);
//! * `kubernetesRoleName`: a fresh service account per lease, bound to that
//!   `Role` or `ClusterRole` (a `RoleBinding` in the namespace, or a
//!   `ClusterRoleBinding` with `clusterRoleBinding: true`), and a token for
//!   it. Revocation deletes the binding and the account, which invalidates
//!   the token at once.
//!
//! Tokens have a fixed expiry, so leases are not renewable.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::http::{self, HttpCall};
use super::naming;
use super::target_guard::TargetEgress;
use super::Issued;

/// Kubernetes enforces a 10-minute minimum on requested token lifetimes.
const MIN_TOKEN_SECS: i64 = 600;
const MANAGED_BY: &str = "app.kubernetes.io/managed-by";
const RBAC: &str = "rbac.authorization.k8s.io";

/// The kind of role a generated account is bound to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum KubernetesRoleType {
    #[default]
    Role,
    ClusterRole,
}

/// Kubernetes provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesConfig {
    /// API server, e.g. `https://k8s.example.com:6443`.
    pub host: String,
    /// Bearer token of the account Ryu acts as (needs `create` on
    /// `serviceaccounts/token`, plus service accounts and bindings when it
    /// generates accounts).
    pub service_account_jwt: String,
    /// PEM CA for the API server (configuration managers only).
    #[serde(default)]
    pub ca_pem: Option<String>,
    pub namespace: String,
    /// Mint tokens for this existing account.
    #[serde(default)]
    pub service_account_name: Option<String>,
    /// Or generate an account per lease bound to this role.
    #[serde(default)]
    pub kubernetes_role_name: Option<String>,
    #[serde(default)]
    pub kubernetes_role_type: KubernetesRoleType,
    /// Bind with a `ClusterRoleBinding` (needs a `ClusterRole`).
    #[serde(default)]
    pub cluster_role_binding: bool,
    /// Token audiences (default: the API server's).
    #[serde(default)]
    pub audiences: Vec<String>,
    /// Generated account prefix (default `ryu`; `_` becomes `-`).
    #[serde(default)]
    pub username_prefix: Option<String>,
    /// How connections are made (set from the role's writer; never stored).
    #[serde(skip)]
    pub(crate) egress: TargetEgress,
}

/// A DNS-1123 label (namespaces, service accounts).
fn is_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

/// A role name (`system:` cluster roles carry colons).
fn is_role_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.' | b':')
        })
}

impl KubernetesConfig {
    pub(super) fn validate(&self) -> Result<()> {
        http::check_https(&self.host, "host")?;
        if self.service_account_jwt.trim().is_empty() {
            bail!("serviceAccountJwt is required");
        }
        if !is_label(&self.namespace) {
            bail!("namespace must be a DNS label");
        }
        match (&self.service_account_name, &self.kubernetes_role_name) {
            (Some(name), None) if is_label(name) => {}
            (Some(_), None) => bail!("serviceAccountName must be a DNS label"),
            (None, Some(name)) if is_role_name(name) => {}
            (None, Some(_)) => bail!("kubernetesRoleName is invalid"),
            _ => bail!("set exactly one of serviceAccountName and kubernetesRoleName"),
        }
        if self.cluster_role_binding && self.kubernetes_role_type != KubernetesRoleType::ClusterRole
        {
            bail!("clusterRoleBinding needs kubernetesRoleType ClusterRole");
        }
        if let Some(pem) = &self.ca_pem {
            reqwest::Certificate::from_pem(pem.as_bytes())
                .map_err(|_| anyhow::anyhow!("caPem is not a PEM certificate"))?;
        }
        if self.audiences.iter().any(|aud| aud.trim().is_empty()) {
            bail!("audiences must not be empty strings");
        }
        naming::validate_prefix(self.username_prefix.as_deref())
    }

    /// Non-secret summary for listings.
    pub(super) fn summary(&self) -> Value {
        json!({
            "host": http::check_https(&self.host, "host")
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_else(|_| "invalid".into()),
            "namespace": self.namespace,
            "serviceAccountName": self.service_account_name,
            "kubernetesRoleName": self.kubernetes_role_name,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.host.trim().trim_end_matches('/'))
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        allow: &[u16],
    ) -> Result<Value> {
        let mut call = HttpCall::new(method, self.url(path))
            .bearer(&self.service_account_jwt)
            .ca(self.ca_pem.as_deref());
        if let Some(body) = body {
            call = call.json(body);
        }
        Ok(http::json(call, self.egress, "the Kubernetes API", allow)
            .await?
            .1)
    }

    async fn token(&self, account: &str, ttl_secs: i64) -> Result<(String, String, i64)> {
        let seconds = ttl_secs.max(MIN_TOKEN_SECS);
        let mut spec = json!({ "expirationSeconds": seconds });
        if !self.audiences.is_empty() {
            spec["audiences"] = json!(self.audiences);
        }
        let answer = self
            .call(
                "POST",
                &format!(
                    "/api/v1/namespaces/{}/serviceaccounts/{account}/token",
                    self.namespace
                ),
                Some(&json!({
                    "apiVersion": "authentication.k8s.io/v1",
                    "kind": "TokenRequest",
                    "spec": spec,
                })),
                &[],
            )
            .await?;
        Ok((
            http::field(&answer, "/status/token", "TokenRequest")?,
            http::field(&answer, "/status/expirationTimestamp", "TokenRequest")?,
            seconds,
        ))
    }

    fn binding_path(&self, name: Option<&str>) -> String {
        let base = if self.cluster_role_binding {
            format!("/apis/{RBAC}/v1/clusterrolebindings")
        } else {
            format!("/apis/{RBAC}/v1/namespaces/{}/rolebindings", self.namespace)
        };
        match name {
            Some(name) => format!("{base}/{name}"),
            None => base,
        }
    }

    async fn create_account(&self, name: &str, role_name: &str) -> Result<()> {
        let metadata = json!({ "name": name, "labels": { MANAGED_BY: "ryu" } });
        self.call(
            "POST",
            &format!("/api/v1/namespaces/{}/serviceaccounts", self.namespace),
            Some(&json!({ "apiVersion": "v1", "kind": "ServiceAccount", "metadata": metadata })),
            &[],
        )
        .await?;
        let kind = match self.kubernetes_role_type {
            KubernetesRoleType::Role => "Role",
            KubernetesRoleType::ClusterRole => "ClusterRole",
        };
        let binding = json!({
            "apiVersion": format!("{RBAC}/v1"),
            "kind": if self.cluster_role_binding { "ClusterRoleBinding" } else { "RoleBinding" },
            "metadata": metadata,
            "roleRef": { "apiGroup": RBAC, "kind": kind, "name": role_name },
            "subjects": [{ "kind": "ServiceAccount", "name": name, "namespace": self.namespace }],
        });
        self.call("POST", &self.binding_path(None), Some(&binding), &[])
            .await?;
        Ok(())
    }

    async fn delete_account(&self, name: &str) -> Result<()> {
        self.call("DELETE", &self.binding_path(Some(name)), None, &[404])
            .await?;
        self.call(
            "DELETE",
            &format!(
                "/api/v1/namespaces/{}/serviceaccounts/{name}",
                self.namespace
            ),
            None,
            &[404],
        )
        .await?;
        Ok(())
    }
}

fn issued(
    token: String,
    account: &str,
    namespace: &str,
    expiration: String,
) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("token".to_owned(), token),
        ("serviceAccountName".to_owned(), account.to_owned()),
        ("serviceAccountNamespace".to_owned(), namespace.to_owned()),
        ("expiration".to_owned(), expiration),
    ])
}

pub(super) async fn issue(config: &KubernetesConfig, role: &str, ttl_secs: i64) -> Result<Issued> {
    if let Some(account) = &config.service_account_name {
        let (token, expiration, seconds) = config.token(account, ttl_secs).await?;
        return Ok(Issued {
            data: issued(token, account, &config.namespace, expiration),
            revoke_data: Value::Null,
            ttl_cap_secs: Some(seconds),
        });
    }
    let Some(role_name) = &config.kubernetes_role_name else {
        bail!("the role names neither a service account nor a Kubernetes role");
    };
    let prefix = config
        .username_prefix
        .as_deref()
        .unwrap_or("ryu")
        .replace('_', "-");
    let name = naming::generated_name(&prefix, role, '-', 63);
    let created = match config.create_account(&name, role_name).await {
        Ok(()) => config.token(&name, ttl_secs).await,
        Err(error) => Err(error),
    };
    let (token, expiration, seconds) = match created {
        Ok(token) => token,
        Err(error) => {
            // Without a lease nothing would ever delete a half-made account.
            let cleanup = config.delete_account(&name).await;
            return Err(match cleanup {
                Ok(()) => anyhow::anyhow!("{error:#} (service account `{name}`; cleanup ran)"),
                Err(cleanup) => anyhow::anyhow!(
                    "{error:#} (service account `{name}`; cleanup failed: {cleanup:#})"
                ),
            });
        }
    };
    Ok(Issued {
        data: issued(token, &name, &config.namespace, expiration),
        revoke_data: json!({ "serviceAccount": name }),
        ttl_cap_secs: Some(seconds),
    })
}

pub(super) async fn revoke(config: &KubernetesConfig, revoke_data: &Value) -> Result<()> {
    let Some(name) = revoke_data.get("serviceAccount").and_then(Value::as_str) else {
        // A token for an existing account expires on its own.
        return Ok(());
    };
    if !is_label(name) || !naming::is_generated_name(name, b'-') {
        bail!("lease service account is malformed");
    }
    config.delete_account(name).await
}

#[cfg(test)]
#[path = "kubernetes_test.rs"]
mod tests;
