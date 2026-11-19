//! Kubernetes service accounts bound to a generated Role (`kubernetes-rules`).
//!
//! OpenBao's `generated_role_rules` mode: the role stores RBAC policy rules,
//! and each lease creates a `Role` (or `ClusterRole`) holding exactly those
//! rules, then a service account bound to it and a token, through the
//! [`super::kubernetes`] provider. Revocation deletes the binding and the
//! account, then the generated role. Tokens have a fixed expiry, so leases
//! are not renewable.

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::http::{self, HttpCall};
use super::kubernetes::{self, KubernetesConfig, KubernetesRoleType};
use super::naming;
use super::target_guard::TargetEgress;
use super::Issued;

const RBAC: &str = "rbac.authorization.k8s.io";
const MAX_RULES: usize = 64;
const RULE_FIELDS: [&str; 5] = [
    "apiGroups",
    "resources",
    "resourceNames",
    "verbs",
    "nonResourceURLs",
];

/// Kubernetes generated-role provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesRulesConfig {
    /// API server, e.g. `https://k8s.example.com:6443`.
    pub host: String,
    /// Bearer token of the account Ryu acts as (needs to create roles,
    /// bindings, service accounts, and tokens, and to hold every permission
    /// it grants, as RBAC escalation checks require).
    pub service_account_jwt: String,
    #[serde(default)]
    pub ca_pem: Option<String>,
    pub namespace: String,
    /// RBAC `PolicyRule` objects for the generated role.
    pub rules: Vec<Value>,
    /// Generate a `ClusterRole` instead of a `Role`.
    #[serde(default)]
    pub kubernetes_role_type: KubernetesRoleType,
    /// Bind with a `ClusterRoleBinding` (needs a `ClusterRole`).
    #[serde(default)]
    pub cluster_role_binding: bool,
    #[serde(default)]
    pub audiences: Vec<String>,
    /// Prefix for generated names (default `ryu`; `_` becomes `-`).
    #[serde(default)]
    pub username_prefix: Option<String>,
    /// How connections are made (set from the role's writer; never stored).
    #[serde(skip)]
    pub(crate) egress: TargetEgress,
}

fn check_rule(rule: &Value) -> Result<()> {
    let object = rule
        .as_object()
        .ok_or_else(|| anyhow!("each rule must be an object"))?;
    for (key, value) in object {
        if !RULE_FIELDS.contains(&key.as_str()) {
            bail!("rules may only set {}", RULE_FIELDS.join(", "));
        }
        let items = value
            .as_array()
            .ok_or_else(|| anyhow!("rule field `{key}` must be a list of strings"))?;
        if items.len() > 64
            || items.iter().any(|item| {
                item.as_str()
                    .is_none_or(|text| text.len() > 253 || text.chars().any(char::is_control))
            })
        {
            bail!("rule field `{key}` must be a list of strings");
        }
    }
    let has = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    };
    if !has("verbs") {
        bail!("each rule needs verbs");
    }
    if !has("resources") && !has("nonResourceURLs") {
        bail!("each rule needs resources or nonResourceURLs");
    }
    Ok(())
}

impl KubernetesRulesConfig {
    pub(super) fn validate(&self) -> Result<()> {
        if self.rules.is_empty() || self.rules.len() > MAX_RULES {
            bail!("rules must hold 1 to {MAX_RULES} policy rules");
        }
        for rule in &self.rules {
            check_rule(rule)?;
        }
        let non_resource = self
            .rules
            .iter()
            .any(|rule| rule.get("nonResourceURLs").is_some());
        if non_resource && self.kubernetes_role_type != KubernetesRoleType::ClusterRole {
            bail!("nonResourceURLs rules need kubernetesRoleType ClusterRole");
        }
        // The account settings are checked the way the base provider checks
        // them, against a stand-in role name.
        self.base("ryu-generated").validate()
    }

    /// Non-secret summary for listings.
    pub(super) fn summary(&self) -> Value {
        json!({
            "host": http::check_https(&self.host, "host")
                .map(|url| url.origin().ascii_serialization())
                .unwrap_or_else(|_| "invalid".into()),
            "namespace": self.namespace,
            "kubernetesRoleType": self.kubernetes_role_type,
            "rules": self.rules.len(),
        })
    }

    /// The base provider configuration that binds an account to `role_name`.
    fn base(&self, role_name: &str) -> KubernetesConfig {
        KubernetesConfig {
            host: self.host.clone(),
            service_account_jwt: self.service_account_jwt.clone(),
            ca_pem: self.ca_pem.clone(),
            namespace: self.namespace.clone(),
            service_account_name: None,
            kubernetes_role_name: Some(role_name.to_owned()),
            kubernetes_role_type: self.kubernetes_role_type,
            cluster_role_binding: self.cluster_role_binding,
            audiences: self.audiences.clone(),
            username_prefix: self.username_prefix.clone(),
            egress: self.egress,
        }
    }

    fn role_path(&self, name: Option<&str>) -> String {
        let base = match self.kubernetes_role_type {
            KubernetesRoleType::Role => {
                format!("/apis/{RBAC}/v1/namespaces/{}/roles", self.namespace)
            }
            KubernetesRoleType::ClusterRole => format!("/apis/{RBAC}/v1/clusterroles"),
        };
        match name {
            Some(name) => format!("{base}/{name}"),
            None => base,
        }
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        allow: &[u16],
    ) -> Result<()> {
        let url = format!("{}{path}", self.host.trim().trim_end_matches('/'));
        let mut call = HttpCall::new(method, url)
            .bearer(&self.service_account_jwt)
            .ca(self.ca_pem.as_deref());
        if let Some(body) = body {
            call = call.json(body);
        }
        http::json(call, self.egress, "the Kubernetes API", allow).await?;
        Ok(())
    }

    async fn create_role(&self, name: &str) -> Result<()> {
        let metadata = json!({
            "name": name,
            "labels": { "app.kubernetes.io/managed-by": "ryu" },
        });
        let kind = match self.kubernetes_role_type {
            KubernetesRoleType::Role => "Role",
            KubernetesRoleType::ClusterRole => "ClusterRole",
        };
        let body = json!({
            "apiVersion": format!("{RBAC}/v1"),
            "kind": kind,
            "metadata": metadata,
            "rules": self.rules,
        });
        self.call("POST", &self.role_path(None), Some(&body), &[])
            .await
    }

    async fn delete_role(&self, name: &str) -> Result<()> {
        self.call("DELETE", &self.role_path(Some(name)), None, &[404])
            .await
    }
}

pub(super) async fn issue(
    config: &KubernetesRulesConfig,
    role: &str,
    ttl_secs: i64,
) -> Result<Issued> {
    let prefix = config
        .username_prefix
        .as_deref()
        .unwrap_or("ryu")
        .replace('_', "-");
    let role_name = naming::generated_name(&format!("{prefix}-role"), role, '-', 63);
    let result = match config.create_role(&role_name).await {
        Ok(()) => kubernetes::issue(&config.base(&role_name), role, ttl_secs).await,
        Err(error) => Err(error),
    };
    let mut issued = match result {
        Ok(issued) => issued,
        Err(error) => {
            // The base provider already removed its half-made account.
            return Err(match config.delete_role(&role_name).await {
                Ok(()) => anyhow!("{error:#} (generated role `{role_name}`; cleanup ran)"),
                Err(cleanup) => {
                    anyhow!("{error:#} (generated role `{role_name}`; cleanup failed: {cleanup:#})")
                }
            });
        }
    };
    issued
        .data
        .insert("generatedRoleName".to_owned(), role_name.clone());
    issued.revoke_data["generatedRole"] = json!(role_name);
    Ok(issued)
}

pub(super) async fn revoke(config: &KubernetesRulesConfig, revoke_data: &Value) -> Result<()> {
    let role_name = revoke_data
        .get("generatedRole")
        .and_then(Value::as_str)
        .filter(|name| name.len() <= 63 && naming::is_generated_name(name, b'-'))
        .ok_or_else(|| anyhow!("lease generated role is malformed"))?;
    kubernetes::revoke(&config.base(role_name), revoke_data).await?;
    config.delete_role(role_name).await
}

#[cfg(test)]
#[path = "kubernetes_rules_test.rs"]
mod tests;
