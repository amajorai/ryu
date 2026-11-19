//! Azure (Microsoft Entra ID) application client secrets.
//!
//! The role stores a client secret for the application Ryu acts as (it needs
//! Microsoft Graph `Application.ReadWrite.OwnedBy` or `.All`) and the object
//! ID of a target application registration. Each issue adds a password
//! credential to the target (`addPassword`) whose end date is the lease's
//! expiry, so the secret dies on its own even if revocation never runs;
//! revocation removes it (`removePassword`). The end date is fixed, so leases
//! are not renewable. Entra ID can take a few seconds to accept a new secret.
//!
//! Calls go only to the fixed sign-in and Graph hosts of the configured cloud.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::http::{self, HttpCall};
use super::target_guard::TargetEgress;
use super::{random_suffix, Issued};

/// The Azure cloud a tenant lives in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AzureEnvironment {
    #[default]
    Public,
    UsGovernment,
    China,
}

impl AzureEnvironment {
    fn hosts(self) -> (&'static str, &'static str) {
        match self {
            Self::Public => (
                "https://login.microsoftonline.com",
                "https://graph.microsoft.com",
            ),
            Self::UsGovernment => (
                "https://login.microsoftonline.us",
                "https://graph.microsoft.us",
            ),
            Self::China => (
                "https://login.chinacloudapi.cn",
                "https://microsoftgraph.chinacloudapi.cn",
            ),
        }
    }
}

/// Test-only endpoint overrides (never deserialized).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AzureEndpoints {
    pub login: Option<String>,
    pub graph: Option<String>,
}

/// Azure provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureConfig {
    /// Directory (tenant) ID or verified domain.
    pub tenant_id: String,
    /// Client ID of the application Ryu acts as.
    pub client_id: String,
    pub client_secret: String,
    /// Object ID of the application registration that receives secrets.
    pub application_object_id: String,
    #[serde(default)]
    pub environment: AzureEnvironment,
    #[serde(skip)]
    pub(crate) egress: TargetEgress,
    #[serde(skip)]
    pub(crate) endpoints: AzureEndpoints,
}

fn is_guid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_tenant(value: &str) -> bool {
    is_guid(value)
        || (value.contains('.')
            && value.len() <= 253
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-')))
}

impl AzureConfig {
    pub(super) fn validate(&self) -> Result<()> {
        if !is_tenant(&self.tenant_id) {
            bail!("tenantId must be a directory ID or domain");
        }
        if !is_guid(&self.client_id) {
            bail!("clientId must be an application (client) ID");
        }
        if self.client_secret.trim().is_empty() {
            bail!("clientSecret is required");
        }
        if !is_guid(&self.application_object_id) {
            bail!("applicationObjectId must be an object ID");
        }
        Ok(())
    }

    pub(super) fn summary(&self) -> Value {
        json!({
            "tenantId": self.tenant_id,
            "clientId": self.client_id,
            "applicationObjectId": self.application_object_id,
            "environment": self.environment,
        })
    }

    fn graph(&self) -> String {
        let base = self
            .endpoints
            .graph
            .as_deref()
            .unwrap_or(self.environment.hosts().1);
        format!("{base}/v1.0/applications/{}", self.application_object_id)
    }

    async fn token(&self) -> Result<String> {
        let (login, graph) = self.environment.hosts();
        let login = self.endpoints.login.as_deref().unwrap_or(login);
        let scope = format!("{graph}/.default");
        let call = HttpCall::new(
            "POST",
            format!("{login}/{}/oauth2/v2.0/token", self.tenant_id),
        )
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", &self.client_id),
            ("client_secret", &self.client_secret),
            ("scope", &scope),
        ]);
        let (_, answer) = http::json(call, self.egress, "the Entra ID token endpoint", &[]).await?;
        http::field(&answer, "/access_token", "the Entra ID token endpoint")
    }
}

pub(super) async fn issue(config: &AzureConfig, role: &str, ttl_secs: i64) -> Result<Issued> {
    let token = config.token().await?;
    let (_, app) = http::json(
        HttpCall::new("GET", format!("{}?$select=appId", config.graph())).bearer(&token),
        config.egress,
        "Microsoft Graph applications",
        &[],
    )
    .await?;
    let app_id = http::field(&app, "/appId", "Microsoft Graph applications")?;
    let role_part: String = role
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(32)
        .collect();
    let end = chrono::Utc::now() + chrono::Duration::seconds(ttl_secs.max(60));
    let (_, credential) = http::json(
        HttpCall::new("POST", format!("{}/addPassword", config.graph()))
            .bearer(&token)
            .json(&json!({ "passwordCredential": {
                "displayName": format!("ryu-{role_part}-{}", random_suffix(8)),
                "endDateTime": end.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            }})),
        config.egress,
        "addPassword",
        &[],
    )
    .await?;
    let key_id = http::field(&credential, "/keyId", "addPassword")?;
    if !is_guid(&key_id) {
        bail!("addPassword returned a malformed keyId");
    }
    Ok(Issued {
        data: BTreeMap::from([
            ("clientId".to_owned(), app_id),
            (
                "clientSecret".to_owned(),
                http::field(&credential, "/secretText", "addPassword")?,
            ),
            ("tenantId".to_owned(), config.tenant_id.clone()),
            ("keyId".to_owned(), key_id.clone()),
            (
                "expiration".to_owned(),
                http::field(&credential, "/endDateTime", "addPassword")?,
            ),
        ]),
        revoke_data: json!({ "keyId": key_id }),
        ttl_cap_secs: None,
    })
}

pub(super) async fn revoke(config: &AzureConfig, revoke_data: &Value) -> Result<()> {
    let Some(key_id) = revoke_data.get("keyId").and_then(Value::as_str) else {
        bail!("lease has no keyId");
    };
    if !is_guid(key_id) {
        bail!("lease keyId is malformed");
    }
    let token = config.token().await?;
    http::json(
        HttpCall::new("POST", format!("{}/removePassword", config.graph()))
            .bearer(&token)
            .json(&json!({ "keyId": key_id })),
        config.egress,
        "removePassword",
        &[404],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "azure_test.rs"]
mod tests;
