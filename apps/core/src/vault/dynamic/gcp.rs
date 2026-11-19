//! Google Cloud service-account credentials.
//!
//! The role stores a service-account key JSON for the account Ryu acts as
//! and names a target service account. Ryu signs an OAuth JWT-bearer grant
//! with that key, then either:
//!
//! * `serviceAccountKey` (default): creates a key on the target account
//!   (`projects.serviceAccounts.keys.create`) and deletes it on revocation;
//!   renewal is lease bookkeeping, since keys never expire by themselves;
//! * `accessToken`: mints an OAuth access token for the target account
//!   (`generateAccessToken`, at most one hour). Tokens cannot be revoked, so
//!   revocation ends the lease and the token expires on its own.
//!
//! Calls go only to Google's fixed endpoints; the key file's `token_uri` must
//! be one of Google's token endpoints, so a role cannot send the signed grant
//! anywhere else.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::http::{self, HttpCall};
use super::target_guard::TargetEgress;
use super::Issued;

const IAM: &str = "https://iam.googleapis.com";
const IAM_CREDENTIALS: &str = "https://iamcredentials.googleapis.com";
const CLOUD_PLATFORM: &str = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URIS: &[&str] = &[
    "https://oauth2.googleapis.com/token",
    "https://accounts.google.com/o/oauth2/token",
    "https://www.googleapis.com/oauth2/v4/token",
];
/// `generateAccessToken` allows one hour unless an organization policy
/// extends it.
const MAX_ACCESS_TOKEN_SECS: i64 = 3600;

/// What a GCP role issues.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GcpSecretType {
    #[default]
    ServiceAccountKey,
    AccessToken,
}

/// Test-only endpoint overrides (never deserialized).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GcpEndpoints {
    pub token: Option<String>,
    pub iam: Option<String>,
    pub iam_credentials: Option<String>,
}

/// GCP provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GcpConfig {
    /// Service-account key JSON for the account Ryu acts as (needs
    /// `iam.serviceAccountKeys.create`/`delete` or
    /// `iam.serviceAccounts.getAccessToken` on the target).
    pub credentials: String,
    /// Target account, e.g. `app@project.iam.gserviceaccount.com`.
    pub service_account_email: String,
    #[serde(default)]
    pub secret_type: GcpSecretType,
    /// OAuth scopes for access tokens (default `cloud-platform`).
    #[serde(default)]
    pub token_scopes: Vec<String>,
    #[serde(skip)]
    pub(crate) egress: TargetEgress,
    #[serde(skip)]
    pub(crate) endpoints: GcpEndpoints,
}

#[derive(Deserialize)]
struct KeyFile {
    client_email: String,
    private_key: String,
    #[serde(default)]
    private_key_id: Option<String>,
    #[serde(default)]
    token_uri: Option<String>,
}

fn is_email(value: &str) -> bool {
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && value.len() <= 254
        && value.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'@' | b'.' | b'-' | b'_')
        })
}

impl GcpConfig {
    fn key_file(&self) -> Result<KeyFile> {
        let key: KeyFile = serde_json::from_str(&self.credentials)
            .context("credentials must be a service-account key JSON")?;
        if !is_email(&key.client_email) {
            bail!("credentials client_email is invalid");
        }
        if let Some(uri) = &key.token_uri {
            if !TOKEN_URIS.contains(&uri.as_str()) {
                bail!("credentials token_uri must be a Google token endpoint");
            }
        }
        Ok(key)
    }

    pub(super) fn validate(&self) -> Result<()> {
        let key = self.key_file()?;
        jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes())
            .map_err(|_| anyhow!("credentials private_key is not an RSA key"))?;
        if !is_email(&self.service_account_email) {
            bail!("serviceAccountEmail is invalid");
        }
        for scope in &self.token_scopes {
            if !scope.starts_with("https://") || scope.bytes().any(|b| b.is_ascii_whitespace()) {
                bail!("tokenScopes must be https scope URLs");
            }
        }
        Ok(())
    }

    pub(super) fn summary(&self) -> Value {
        json!({
            "serviceAccountEmail": self.service_account_email,
            "secretType": self.secret_type,
            "actingAs": self.key_file().map(|key| key.client_email).ok(),
        })
    }

    pub(super) fn renewable(&self) -> bool {
        self.secret_type == GcpSecretType::ServiceAccountKey
    }

    fn iam(&self) -> &str {
        self.endpoints.iam.as_deref().unwrap_or(IAM)
    }

    /// An access token for the acting account (JWT-bearer grant).
    async fn admin_token(&self) -> Result<String> {
        let key = self.key_file()?;
        let token_uri = key.token_uri.as_deref().unwrap_or(TOKEN_URIS[0]);
        let now = chrono::Utc::now().timestamp();
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = key.private_key_id.clone();
        let assertion = jsonwebtoken::encode(
            &header,
            &json!({
                "iss": key.client_email,
                "scope": CLOUD_PLATFORM,
                "aud": token_uri,
                "iat": now,
                "exp": now + 3600,
            }),
            &jsonwebtoken::EncodingKey::from_rsa_pem(key.private_key.as_bytes())
                .map_err(|_| anyhow!("credentials private_key is not an RSA key"))?,
        )?;
        let url = self
            .endpoints
            .token
            .clone()
            .unwrap_or_else(|| token_uri.to_owned());
        let call = HttpCall::new("POST", url).form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &assertion),
        ]);
        let (_, answer) = http::json(call, self.egress, "the Google token endpoint", &[]).await?;
        http::field(&answer, "/access_token", "the Google token endpoint")
    }
}

/// A key name Google returned: `projects/<p>/serviceAccounts/<email>/keys/<id>`.
fn check_key_name(name: &str) -> Result<()> {
    let parts: Vec<&str> = name.split('/').collect();
    let ok = parts.len() == 6
        && parts[0] == "projects"
        && parts[2] == "serviceAccounts"
        && parts[4] == "keys"
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'@' | b'.' | b'-' | b'_'))
        });
    if !ok {
        bail!("lease key name is malformed");
    }
    Ok(())
}

pub(super) async fn issue(config: &GcpConfig, ttl_secs: i64) -> Result<Issued> {
    let token = config.admin_token().await?;
    let email = &config.service_account_email;
    if config.secret_type == GcpSecretType::AccessToken {
        let seconds = ttl_secs.clamp(60, MAX_ACCESS_TOKEN_SECS);
        let scopes = if config.token_scopes.is_empty() {
            vec![CLOUD_PLATFORM.to_owned()]
        } else {
            config.token_scopes.clone()
        };
        let base = config
            .endpoints
            .iam_credentials
            .as_deref()
            .unwrap_or(IAM_CREDENTIALS);
        let call = HttpCall::new(
            "POST",
            format!("{base}/v1/projects/-/serviceAccounts/{email}:generateAccessToken"),
        )
        .bearer(&token)
        .json(&json!({ "scope": scopes, "lifetime": format!("{seconds}s") }));
        let (_, answer) = http::json(call, config.egress, "generateAccessToken", &[]).await?;
        return Ok(Issued {
            data: BTreeMap::from([
                (
                    "accessToken".to_owned(),
                    http::field(&answer, "/accessToken", "generateAccessToken")?,
                ),
                (
                    "expiration".to_owned(),
                    http::field(&answer, "/expireTime", "generateAccessToken")?,
                ),
                ("serviceAccountEmail".to_owned(), email.clone()),
            ]),
            revoke_data: Value::Null,
            ttl_cap_secs: Some(seconds),
        });
    }
    let call = HttpCall::new(
        "POST",
        format!(
            "{}/v1/projects/-/serviceAccounts/{email}/keys",
            config.iam()
        ),
    )
    .bearer(&token)
    .json(&json!({
        "privateKeyType": "TYPE_GOOGLE_CREDENTIALS_FILE",
        "keyAlgorithm": "KEY_ALG_RSA_2048",
    }));
    let (_, answer) = http::json(call, config.egress, "serviceAccounts.keys.create", &[]).await?;
    let name = http::field(&answer, "/name", "serviceAccounts.keys.create")?;
    check_key_name(&name)?;
    let data = http::field(&answer, "/privateKeyData", "serviceAccounts.keys.create")?;
    let credentials = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .ok_or_else(|| anyhow!("serviceAccounts.keys.create returned an unreadable key"))?;
    Ok(Issued {
        data: BTreeMap::from([
            ("credentials".to_owned(), credentials),
            (
                "keyId".to_owned(),
                name.rsplit('/').next().unwrap_or_default().to_owned(),
            ),
            ("serviceAccountEmail".to_owned(), email.clone()),
        ]),
        revoke_data: json!({ "keyName": name }),
        ttl_cap_secs: None,
    })
}

pub(super) async fn revoke(config: &GcpConfig, revoke_data: &Value) -> Result<()> {
    let Some(name) = revoke_data.get("keyName").and_then(Value::as_str) else {
        // Access tokens expire on their own.
        return Ok(());
    };
    check_key_name(name)?;
    let token = config.admin_token().await?;
    let call = HttpCall::new("DELETE", format!("{}/v1/{name}", config.iam())).bearer(&token);
    http::json(call, config.egress, "serviceAccounts.keys.delete", &[404]).await?;
    Ok(())
}

#[cfg(test)]
#[path = "gcp_test.rs"]
mod tests;
