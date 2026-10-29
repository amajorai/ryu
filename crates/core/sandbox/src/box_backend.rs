//! Ryu Box API backend.
//!
//! The Box service is intentionally outside Core. It owns durable box state,
//! snapshots, provider drivers, and its public REST API. This adapter only
//! translates the extracted [`super::Sandbox`] contract to that API, which lets
//! the same service be sold and used by non-Ryu clients.
//!
//! Configuration:
//!
//! - `RYU_SANDBOX_BOX_URL` — service base URL, including `/v1` (default:
//!   `http://127.0.0.1:8090/v1`)
//! - `RYU_SANDBOX_BOX_TOKEN` — scoped Box API key
//! - `RYU_SANDBOX_BOX_SIZE` — `small`, `default`, or `large`
//! - `RYU_SANDBOX_BOX_TIMEOUT_SECS` — request timeout (default: 30)
//! - `RYU_SANDBOX_BOX_SUBSCRIPTION_PASSTHROUGH` — skip Ryu wallet metering when
//!   the configured Box credential is an upstream subscription (default: false)

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Deserialize;
use serde_json::{json, Value};

use super::spec::SandboxSpec;
use super::{BoxFuture, ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::box_types::BoxSize;

pub const ENV_BOX_URL: &str = "RYU_SANDBOX_BOX_URL";
pub const ENV_BOX_TOKEN: &str = "RYU_SANDBOX_BOX_TOKEN";
pub const ENV_BOX_SIZE: &str = "RYU_SANDBOX_BOX_SIZE";
pub const ENV_BOX_TIMEOUT_SECS: &str = "RYU_SANDBOX_BOX_TIMEOUT_SECS";
pub const ENV_BOX_SUBSCRIPTION_PASSTHROUGH: &str = "RYU_SANDBOX_BOX_SUBSCRIPTION_PASSTHROUGH";

const DEFAULT_BOX_URL: &str = "http://127.0.0.1:8090/v1";
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// `POST /boxes` attempts. Only a transport failure (connect error or timeout)
/// is retried, with the same Idempotency-Key and body, so the service returns
/// the box a timed-out first attempt may already have created.
const CREATE_ATTEMPTS: u32 = 2;
const CREATE_RETRY_DELAY: Duration = Duration::from_millis(500);

/// A Box request that failed before any HTTP status arrived. Kept as a typed
/// error so `create` can tell a lost request apart from a service rejection.
#[derive(Debug)]
struct BoxTransportError(reqwest::Error);

impl std::fmt::Display for BoxTransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Box API request failed: {}", self.0)
    }
}

impl std::error::Error for BoxTransportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

/// Whether a failed request may be re-sent: the request never reached the
/// service (connect) or its outcome was lost (timeout). HTTP status errors and
/// malformed responses are never retried.
fn is_retryable_transport(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<BoxTransportError>()
        .is_some_and(|transport| transport.0.is_connect() || transport.0.is_timeout())
}

pub(crate) fn box_base_url() -> String {
    std::env::var(ENV_BOX_URL)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_BOX_URL.to_owned())
}

pub(crate) fn box_token() -> Option<String> {
    std::env::var(ENV_BOX_TOKEN)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(crate) fn request_timeout() -> Duration {
    std::env::var(ENV_BOX_TIMEOUT_SECS)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_TIMEOUT_SECS))
}

pub(crate) fn box_size() -> &'static str {
    configured_size().as_str()
}

/// The Box size `RYU_SANDBOX_BOX_SIZE` selects for the generic [`BoxSandbox`]
/// path (`default` when unset or unknown). Session Boxes never read it: they
/// carry their size on `DisposableBoxSpec` and meter with [`spec_for`].
pub fn configured_size() -> BoxSize {
    std::env::var(ENV_BOX_SIZE)
        .ok()
        .and_then(|value| value.parse::<BoxSize>().ok())
        .unwrap_or(BoxSize::Default)
}

/// Whether the configured Box credential owns its own upstream subscription.
/// Subscription passthrough preserves that provider billing and therefore does
/// not register a second Ryu wallet meter for the same machine time.
pub fn subscription_passthrough() -> bool {
    std::env::var(ENV_BOX_SUBSCRIPTION_PASSTHROUGH)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "on" | "yes"
            )
        })
        .unwrap_or(false)
}

/// Confirm that the configured endpoint is the Ryu Box service's
/// subscription-backed mode before Core disables its own heartbeat billing.
/// A direct upstream Box API or an unavailable health endpoint fails closed to
/// normal Ryu metering.
pub async fn subscription_passthrough_active() -> bool {
    if !subscription_passthrough() {
        return false;
    }
    let Ok(client) = BoxClient::from_env() else {
        return false;
    };
    client.subscription_health_mode().await.unwrap_or(false)
}

/// The resource shape metered for a Box of `size`: the one table shared with
/// the Box service's `SIZE_LIMITS` (see [`crate::box_types::spec_for`]).
pub use crate::box_types::spec_for;

/// The resource shape charged for the env-configured Box size. Only the
/// generic [`BoxSandbox`] path uses it; a session Box is metered with
/// [`spec_for`] of the size it was created with, whatever the env says.
pub fn configured_spec() -> SandboxSpec {
    spec_for(configured_size())
}

/// A Box created for Core, with the lifetime the Box service reported for it.
#[derive(Debug, Clone)]
pub struct CreatedBox {
    pub workspace: WorkspaceId,
    /// The Box's time to live, measured by the service from creation. The Ryu
    /// Box service gives every Box a finite TTL (24 hours unless the request
    /// sets one) and destroys it at the deadline, so Core must stop metering
    /// the run then. `None` when the service reports no TTL.
    pub lifetime: Option<Duration>,
}

/// Read the effective TTL from a Box create or read response (`box.ttlSeconds`).
fn reported_lifetime(value: &Value) -> Option<Duration> {
    value
        .get("box")?
        .get("ttlSeconds")?
        .as_u64()
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    Available,
    Unavailable(String),
}

/// Credential-only detection. It never provisions a Box or makes a network
/// request, so Core can call it from backend discovery without side effects.
pub async fn detect() -> DetectResult {
    if box_token().is_some() {
        DetectResult::Available
    } else {
        DetectResult::Unavailable(format!("no Box API token configured (set {ENV_BOX_TOKEN})"))
    }
}

struct BoxClient {
    base: String,
    token: String,
    timeout: Duration,
    http: reqwest::Client,
}

impl BoxClient {
    fn from_env() -> Result<Self> {
        let token = box_token()
            .ok_or_else(|| anyhow!("Box backend requires an API token ({ENV_BOX_TOKEN})"))?;
        Ok(Self {
            base: box_base_url(),
            token,
            timeout: request_timeout(),
            http: reqwest::Client::new(),
        })
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token)
            .timeout(self.timeout);
        if let Some(idempotency_key) = idempotency_key {
            request = request.header("Idempotency-Key", idempotency_key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| anyhow::Error::new(BoxTransportError(error)))?;
        let status = response.status();
        let text = crate::capture::response_text(response).await?;
        if !status.is_success() {
            let detail = text.chars().take(512).collect::<String>();
            return Err(anyhow!("Box API returned HTTP {status}: {detail}"));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|error| anyhow!("Box API returned invalid JSON: {error}"))
    }

    async fn subscription_health_mode(&self) -> Result<bool> {
        let base = self.base.trim_end_matches("/v1").trim_end_matches('/');
        let response = self
            .http
            .get(format!("{base}/health"))
            .bearer_auth(&self.token)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|error| anyhow!("Box health request failed: {error}"))?;
        if !response.status().is_success() {
            return Ok(false);
        }
        let body: Value = serde_json::from_str(&crate::capture::response_text(response).await?)?;
        Ok(body.get("mode").and_then(Value::as_str) == Some("subscription_passthrough"))
    }

    async fn create(&self, _capabilities: &SandboxCapabilities) -> Result<CreatedBox> {
        // One key and one body for every attempt: a retry after a lost response
        // must resolve to the same box, never provision a second billable one.
        let idempotency_key = format!("ryu-{}", uuid::Uuid::new_v4().simple());
        let body = json!({
            "name": idempotency_key.as_str(),
            "noEnv": true,
            "type": box_size(),
            "ttlSeconds": null,
        });
        let mut attempt = 1;
        let value = loop {
            match self
                .request(
                    reqwest::Method::POST,
                    "/boxes",
                    Some(body.clone()),
                    Some(&idempotency_key),
                )
                .await
            {
                Err(error) if attempt < CREATE_ATTEMPTS && is_retryable_transport(&error) => {
                    tracing::warn!(error = %error, "Box create request was lost; retrying with the same idempotency key");
                    attempt += 1;
                    tokio::time::sleep(CREATE_RETRY_DELAY).await;
                }
                result => break result?,
            }
        };
        let id = value
            .get("box")
            .and_then(|box_value| box_value.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow!("Box create response did not contain box.id"))?;
        let lifetime = reported_lifetime(&value);
        let workspace = WorkspaceId(id.to_owned());
        // The box exists from here on. A failed readiness check must delete it:
        // the caller never receives the id, so nothing else could.
        if let Err(error) = self.wait_until_ready(id).await {
            if let Err(cleanup) = self.destroy(&workspace).await {
                tracing::warn!(box_id = %id, error = %cleanup, "Box cleanup after failed readiness failed");
            }
            return Err(error);
        }
        Ok(CreatedBox {
            workspace,
            lifetime,
        })
    }

    async fn wait_until_ready(&self, id: &str) -> Result<()> {
        for _ in 0..120 {
            let value = self
                .request(reqwest::Method::GET, &format!("/boxes/{id}"), None, None)
                .await?;
            let state = value
                .get("box")
                .and_then(|box_value| box_value.get("state").or_else(|| box_value.get("status")))
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("Box {id} response did not contain a state"))?;
            match state {
                "ready" | "idle" => return Ok(()),
                "error" | "archived" | "deleted" | "stopped" => {
                    return Err(anyhow!("Box {id} is not runnable: {state}"))
                }
                _ => tokio::time::sleep(Duration::from_millis(250)).await,
            }
        }
        Err(anyhow!("Box {id} did not become ready before the timeout"))
    }

    async fn exec(&self, id: &WorkspaceId, spec: &ExecSpec) -> Result<ExecOutput> {
        let timeout_secs = spec.timeout_secs.unwrap_or(120);
        if timeout_secs > 600 {
            return Err(anyhow!("Box command timeout cannot exceed 600 seconds"));
        }
        let command = if spec.args.is_empty() {
            spec.command.clone()
        } else {
            let mut parts = Vec::with_capacity(spec.args.len() + 1);
            parts.push(shell_escape(&spec.command));
            parts.extend(spec.args.iter().map(|arg| shell_escape(arg)));
            parts.join(" ")
        };
        let value = self
            .request(
                reqwest::Method::POST,
                &format!("/boxes/{}/commands", id.0),
                Some(json!({
                    "command": command,
                    "cwd": ".",
                    "timeoutSeconds": timeout_secs,
                })),
                None,
            )
            .await?;
        let result_value = value.get("result").cloned().unwrap_or(value);
        let result: BoxExecResult = serde_json::from_value(result_value)
            .map_err(|error| anyhow!("Box command result was invalid: {error}"))?;
        Ok(ExecOutput {
            exit_code: result
                .exit_code
                .ok_or_else(|| anyhow!("Box command response did not contain exitCode"))?,
            stdout: result.stdout.into_bytes(),
            stderr: result.stderr.into_bytes(),
        })
    }

    async fn destroy(&self, id: &WorkspaceId) -> Result<()> {
        let response = self
            .http
            .delete(format!("{}/boxes/{}", self.base, id.0))
            .bearer_auth(&self.token)
            .header("X-Ascii-Confirm-Delete", &id.0)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|error| anyhow!("Box destroy request failed: {error}"))?;
        if response.status().is_success() || response.status().as_u16() == 404 {
            return Ok(());
        }
        let status = response.status();
        let detail = crate::capture::response_text(response).await?;
        Err(anyhow!(
            "Box destroy returned HTTP {status}: {}",
            detail.chars().take(512).collect::<String>()
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoxExecResult {
    #[serde(default)]
    exit_code: Option<i32>,
    stderr: String,
    stdout: String,
    #[allow(dead_code)]
    duration_ms: u64,
}

fn shell_escape(value: &str) -> String {
    if value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "_./:@%+,-".contains(character))
    {
        return value.to_owned();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Clone)]
pub struct BoxSandbox;

impl BoxSandbox {
    pub fn new() -> Self {
        Self
    }

    pub fn spec(&self) -> SandboxSpec {
        configured_spec()
    }

    /// Create a persistent workspace and report the lifetime the service gave
    /// it, so the session manager can stop metering when the Box expires.
    pub async fn create_workspace_with_lifetime(
        &self,
        capabilities: SandboxCapabilities,
    ) -> Result<CreatedBox> {
        BoxClient::from_env()?.create(&capabilities).await
    }
}

impl Default for BoxSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Sandbox for BoxSandbox {
    fn name(&self) -> &'static str {
        "box"
    }

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            let client = BoxClient::from_env()?;
            let id = client.create(&spec.capabilities).await?.workspace;
            let result = client.exec(&id, &spec).await;
            if let Err(error) = client.destroy(&id).await {
                tracing::warn!(box_id = %id.0, error = %error, "Box ephemeral cleanup failed");
            }
            result
        })
    }

    fn create_workspace(
        &self,
        capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            Ok(BoxClient::from_env()?
                .create(&capabilities)
                .await?
                .workspace)
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let id = id.clone();
        Box::pin(async move { BoxClient::from_env()?.exec(&id, &spec).await })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let id = id.clone();
        Box::pin(async move { BoxClient::from_env()?.destroy(&id).await })
    }
}

#[cfg(test)]
pub(crate) mod test_env;
#[cfg(test)]
mod tests;
