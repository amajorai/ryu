//! Control-plane calls for share and request links
//! (`packages/api/src/routers/vault-shares.ts`), authenticated with the node's
//! gateway key. Links need a node bound to Ryu Cloud, because the recipient
//! opens them in the web app.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use super::crypto::SealedAnswer;

const TIMEOUT: Duration = Duration::from_secs(15);

/// Where and as whom to call the control plane.
#[derive(Debug, Clone)]
pub struct ControlPlane {
    pub base_url: String,
    pub gateway_key: String,
}

impl ControlPlane {
    /// The bound node's control plane, or an error explaining why links are
    /// unavailable.
    pub fn current() -> Result<Self> {
        #[cfg(test)]
        if let Some(cloud) = tests::TEST_CLOUD.lock().unwrap().clone() {
            return Ok(cloud);
        }
        let gateway_key = crate::sidecar::control_plane::gateway_key()
            .ok_or_else(|| anyhow!("share links need this node to be connected to Ryu Cloud"))?;
        Ok(Self {
            base_url: crate::sidecar::control_plane::control_plane_url()
                .trim_end_matches('/')
                .to_owned(),
            gateway_key,
        })
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/api/control-plane/gateway/vault/shares{path}",
            self.base_url
        )
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<(u16, Value)> {
        let response = request
            .header("x-gateway-key", &self.gateway_key)
            .send()
            .await
            .context("reaching Ryu Cloud")?;
        let status = response.status().as_u16();
        // Hono's HTTPException answers in plain text; keep it as the message.
        let text = response.text().await.unwrap_or_default();
        let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok((status, body))
    }
}

/// A link the control plane created.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedLink {
    pub id: String,
    pub url: String,
    pub expires_at: String,
}

fn refused(status: u16, body: &Value) -> anyhow::Error {
    let message = body
        .as_str()
        .or_else(|| body.get("message").and_then(Value::as_str))
        .or_else(|| body.get("error").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .unwrap_or("request failed");
    let message: String = message.chars().take(300).collect();
    anyhow!("Ryu Cloud refused the link ({status}): {message}")
}

/// Upload a share blob or a request public key.
pub async fn create(cloud: &ControlPlane, body: Value) -> Result<CreatedLink> {
    let (status, reply) = cloud
        .send(ControlPlane::client().post(cloud.url("")).json(&body))
        .await?;
    if status != 201 {
        return Err(refused(status, &reply));
    }
    serde_json::from_value(reply).context("Ryu Cloud returned a malformed link")
}

/// The remote state of a link (`open`, `answered`, `used`, `expired`, `revoked`).
pub async fn status(cloud: &ControlPlane, id: &str) -> Result<Value> {
    let (status, reply) = cloud
        .send(ControlPlane::client().get(cloud.url(&format!("/{}", urlencoding::encode(id)))))
        .await?;
    if status != 200 {
        return Err(refused(status, &reply));
    }
    Ok(reply)
}

/// Collect a request's answer once. `None` while nobody has answered.
pub async fn collect(cloud: &ControlPlane, id: &str) -> Result<Option<SealedAnswer>> {
    let (status, reply) = cloud
        .send(
            ControlPlane::client()
                .post(cloud.url(&format!("/{}/collect", urlencoding::encode(id))))
                .json(&json!({})),
        )
        .await?;
    match status {
        200 => Ok(Some(
            serde_json::from_value(reply.get("response").cloned().unwrap_or(Value::Null))
                .context("Ryu Cloud returned a malformed answer")?,
        )),
        409 => Ok(None),
        410 => bail!("the answer to this request was already collected"),
        _ => Err(refused(status, &reply)),
    }
}

/// Revoke a link. `false` when it was already used, expired, or revoked.
pub async fn revoke(cloud: &ControlPlane, id: &str) -> Result<bool> {
    let (status, reply) = cloud
        .send(ControlPlane::client().delete(cloud.url(&format!("/{}", urlencoding::encode(id)))))
        .await?;
    if status != 200 {
        return Err(refused(status, &reply));
    }
    Ok(reply
        .get("revoked")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

#[cfg(test)]
#[path = "client_tests.rs"]
pub(crate) mod tests;
