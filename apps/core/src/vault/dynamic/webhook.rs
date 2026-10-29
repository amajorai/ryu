//! Webhook dynamic credentials.
//!
//! For systems Ryu has no built-in provider for, the operator runs a small
//! HTTPS endpoint. Core POSTs JSON `{action, role, leaseId?, ttlSecs,
//! revokeData?}` with `x-ryu-signature: sha256=<hex HMAC of the body>` and
//! `x-ryu-timestamp` (included in the signed payload as `<timestamp>.<body>`),
//! so the endpoint can reject forged or replayed calls. `issue` must answer
//! `{data: {..string values..}, revokeData?: any, ttlSecs?: number}`; `renew`
//! and `revoke` must answer 2xx.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

use super::Issued;

/// Webhook provider configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookConfig {
    /// HTTPS endpoint (`http://` only for loopback).
    pub url: String,
    /// Shared HMAC secret (at least 16 characters).
    pub signing_secret: String,
}

impl WebhookConfig {
    pub(super) fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.url).map_err(|_| anyhow!("url is not a URL"))?;
        let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
            bail!("url must be https (http is allowed only for loopback)");
        }
        if self.signing_secret.len() < 16 {
            bail!("signingSecret must be at least 16 characters");
        }
        Ok(())
    }
}

/// `sha256=<hex>` over `<timestamp>.<body>`.
pub(crate) fn signature(secret: &str, timestamp: &str, body: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("any key length");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body.as_bytes());
    format!("sha256={}", hex::encode(mac.finalize().into_bytes()))
}

pub(super) async fn call(config: &WebhookConfig, payload: Value) -> Result<Value> {
    let body = payload.to_string();
    let timestamp = chrono::Utc::now().timestamp().to_string();
    let response = reqwest::Client::new()
        .post(&config.url)
        .timeout(std::time::Duration::from_secs(15))
        .header("content-type", "application/json")
        .header("x-ryu-timestamp", &timestamp)
        .header(
            "x-ryu-signature",
            signature(&config.signing_secret, &timestamp, &body),
        )
        .body(body)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        bail!("webhook returned {status}");
    }
    Ok(response.json().await.unwrap_or(Value::Null))
}

pub(super) async fn issue(config: &WebhookConfig, role: &str, ttl_secs: i64) -> Result<Issued> {
    let answer = call(
        config,
        json!({ "action": "issue", "role": role, "ttlSecs": ttl_secs }),
    )
    .await?;
    let data: BTreeMap<String, String> = answer
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("webhook issue response has no data object"))?
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect();
    if data.is_empty() {
        bail!("webhook issue response has no string fields");
    }
    Ok(Issued {
        data,
        revoke_data: answer.get("revokeData").cloned().unwrap_or(Value::Null),
        ttl_cap_secs: answer.get("ttlSecs").and_then(Value::as_i64),
    })
}

pub(super) async fn renew(
    config: &WebhookConfig,
    role: &str,
    lease_id: &str,
    revoke_data: &Value,
    ttl_secs: i64,
) -> Result<()> {
    call(
        config,
        json!({ "action": "renew", "role": role, "leaseId": lease_id,
                "revokeData": revoke_data, "ttlSecs": ttl_secs }),
    )
    .await
    .map(|_| ())
}

pub(super) async fn revoke(
    config: &WebhookConfig,
    role: &str,
    lease_id: &str,
    revoke_data: &Value,
) -> Result<()> {
    call(
        config,
        json!({ "action": "revoke", "role": role, "leaseId": lease_id, "revokeData": revoke_data }),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_loopback_http_is_accepted() {
        let ok = WebhookConfig {
            url: "https://creds.example.com/hook".into(),
            // Built at runtime: any 16-byte value passes, and a literal here
            // trips repository secret scanners.
            signing_secret: "x".repeat(16),
        };
        ok.validate().unwrap();
        let local = WebhookConfig {
            url: "http://127.0.0.1:9000/hook".into(),
            ..ok.clone()
        };
        local.validate().unwrap();
        let plain = WebhookConfig {
            url: "http://example.com/hook".into(),
            ..ok.clone()
        };
        assert!(plain.validate().is_err());
        let weak = WebhookConfig {
            signing_secret: "short".into(),
            ..ok
        };
        assert!(weak.validate().is_err());
    }

    #[test]
    fn signatures_cover_the_timestamp() {
        let a = signature("secret-secret-secret", "1", "{}");
        let b = signature("secret-secret-secret", "2", "{}");
        assert!(a.starts_with("sha256="));
        assert_ne!(a, b);
    }
}
