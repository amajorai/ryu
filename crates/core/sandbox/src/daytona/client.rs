//! Minimal Daytona REST client: the three calls the backend needs.
//!
//! - create  → `POST {api}/sandbox`
//! - exec    → `POST {toolbox}/{id}/process/execute`
//! - destroy → `DELETE {api}/sandbox/{id}`
//!
//! `{toolbox}` is the sandbox's toolbox proxy URL. Daytona serves the toolbox
//! from its own host, not under the API base: the create response names it in
//! `toolboxProxyUrl`, and `GET {api}/sandbox/{id}/toolbox-proxy-url` returns it
//! for a sandbox created earlier. Nothing here hardcodes that host.

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::json;

use super::{
    daytona_base_url, daytona_token, request_timeout, ENV_DAYTONA_SNAPSHOT, ENV_DAYTONA_TARGET,
    ENV_DAYTONA_TOKEN,
};
use crate::spec::SandboxSpec;
use crate::{ExecOutput, ExecSpec};

// Covers two 4 MiB output streams plus their JSON envelope while bounding the
// provider response before deserialization.
pub(super) const MAX_DAYTONA_RESPONSE_BYTES: usize = 12 * 1024 * 1024;
pub(super) const MAX_DAYTONA_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const MAX_DAYTONA_ERROR_EXCERPT_BYTES: usize = 1024;

pub(super) fn append_response_chunk(
    body: &mut Vec<u8>,
    chunk: &[u8],
    operation: &str,
) -> Result<()> {
    if chunk.len() > MAX_DAYTONA_RESPONSE_BYTES.saturating_sub(body.len()) {
        return Err(anyhow!(
            "daytona {operation} response exceeded the 12 MiB body limit"
        ));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn read_response_capped(mut response: reqwest::Response, operation: &str) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DAYTONA_RESPONSE_BYTES as u64)
    {
        return Err(anyhow!(
            "daytona {operation} response exceeded the 12 MiB body limit"
        ));
    }

    let mut body = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or_default()
            .min(MAX_DAYTONA_RESPONSE_BYTES as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| anyhow!("daytona {operation} response read failed: {error}"))?
    {
        append_response_chunk(&mut body, &chunk, operation)?;
    }
    Ok(body)
}

fn response_excerpt(body: &[u8]) -> String {
    String::from_utf8_lossy(&body[..body.len().min(MAX_DAYTONA_ERROR_EXCERPT_BYTES)]).into_owned()
}

pub(super) fn output_bytes(
    value: &serde_json::Value,
    fields: &[&str],
    stream: &str,
) -> Result<Vec<u8>> {
    let mut selected = None;
    for field in fields {
        if let Some(value) = value.get(*field) {
            selected = Some(value);
            break;
        }
    }
    let output = selected
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if output.len() > MAX_DAYTONA_OUTPUT_BYTES {
        return Err(anyhow!("daytona {stream} exceeded the 4 MiB output limit"));
    }
    Ok(output.as_bytes().to_vec())
}

/// The create request body.
///
/// It carries no `cpu`, `memory`, `disk` or `gpu` field. Daytona boots every
/// sandbox this backend creates from a snapshot (the named one, or the
/// organization default when none is named), and it refuses the request with
/// "Cannot specify Sandbox resources when using a snapshot" when a size is sent
/// along. The snapshot decides the size and the OS.
///
/// `network` maps to `networkBlockAll`, not to `public`: `public` exposes the
/// sandbox's HTTP preview to the internet, which a run never asks for.
pub(super) fn create_body(
    network: bool,
    target: Option<&str>,
    snapshot: Option<&str>,
) -> serde_json::Value {
    let mut body = json!({
        "public": false,
        "networkBlockAll": !network,
    });
    if let Some(target) = target {
        body["target"] = json!(target);
    }
    if let Some(snapshot) = snapshot {
        body["snapshot"] = json!(snapshot);
    }
    body
}

/// Where the size Daytona gave a sandbox differs from the billed `spec`.
///
/// The snapshot decides the real size, while the heartbeat bills the env
/// configured `spec`. `None` when they agree, or when the create response names
/// no size.
pub(super) fn size_mismatch(spec: &SandboxSpec, created: &serde_json::Value) -> Option<String> {
    let pairs = [
        ("cpu", spec.vcpu),
        ("memory", spec.mem_gib),
        ("disk", spec.storage_gib),
    ];
    let differing: Vec<String> = pairs
        .iter()
        .filter_map(|(field, billed)| {
            let actual = created.get(*field)?.as_f64()?;
            ((actual - f64::from(*billed)).abs() > f64::EPSILON)
                .then(|| format!("{field} billed {billed}, sandbox has {actual}"))
        })
        .collect();
    (!differing.is_empty()).then(|| differing.join("; "))
}

/// Validate a toolbox proxy URL the API returned before the token is sent to it.
///
/// The bearer token goes to this host, so it must be HTTPS. Plain HTTP is only
/// accepted when the configured API base is itself plain HTTP (a local or
/// self-hosted deployment, and the mock servers in tests).
pub(super) fn checked_toolbox_url(api_base: &str, url: &str) -> Result<String> {
    let url = url.trim().trim_end_matches('/');
    let secure = url.starts_with("https://");
    let plain_allowed = url.starts_with("http://") && api_base.starts_with("http://");
    if url.len() <= "https://".len() || !(secure || plain_allowed) {
        return Err(anyhow!(
            "daytona returned an unusable toolbox proxy URL: {}",
            response_excerpt(url.as_bytes())
        ));
    }
    Ok(url.to_owned())
}

/// A sandbox the create call returned.
pub(super) struct CreatedSandbox {
    pub(super) id: String,
    /// The toolbox proxy URL from the create response, when it carried one.
    pub(super) toolbox: Option<String>,
}

/// A tiny typed client over the Daytona REST API. Holds only resolved config;
/// construction does no I/O.
pub(super) struct DaytonaClient {
    base: String,
    token: String,
    target: Option<String>,
    snapshot: Option<String>,
    timeout: Duration,
    http: reqwest::Client,
}

fn env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

impl DaytonaClient {
    /// Build the client from env config, erroring when no token is configured.
    pub(super) fn from_env() -> Result<Self> {
        let token = daytona_token().ok_or_else(|| {
            anyhow!("Daytona backend requires an API token ({ENV_DAYTONA_TOKEN})")
        })?;
        Ok(Self {
            base: daytona_base_url(),
            token,
            target: env_non_empty(ENV_DAYTONA_TARGET),
            snapshot: env_non_empty(ENV_DAYTONA_SNAPSHOT),
            timeout: request_timeout(),
            http: reqwest::Client::new(),
        })
    }

    /// Create a remote sandbox. `spec` is the billed shape: it is not sent, and
    /// a size the snapshot gives that differs from it is logged.
    pub(super) async fn create(&self, spec: &SandboxSpec, network: bool) -> Result<CreatedSandbox> {
        let body = create_body(network, self.target.as_deref(), self.snapshot.as_deref());
        let resp = self
            .http
            .post(format!("{}/sandbox", self.base))
            .bearer_auth(&self.token)
            .timeout(self.timeout)
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow!("daytona create request failed: {e}"))?;

        let status = resp.status();
        let body = read_response_capped(resp, "create").await?;
        if !status.is_success() {
            return Err(anyhow!(
                "daytona create failed (HTTP {status}): {}",
                response_excerpt(&body)
            ));
        }
        let value: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|e| anyhow!("daytona create returned unparseable body: {e}"))?;
        // Accept `id` or `sandboxId` for forward-compat with the provider.
        let id = value
            .get("id")
            .or_else(|| value.get("sandboxId"))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                anyhow!(
                    "daytona create response had no sandbox id: {}",
                    response_excerpt(&body)
                )
            })?;
        if let Some(mismatch) = size_mismatch(spec, &value) {
            tracing::warn!(
                sandbox_id = %id,
                %mismatch,
                "daytona: the billed spec differs from the size the snapshot gave"
            );
        }
        // A missing or unusable URL here is not fatal: exec looks it up by id.
        let toolbox = value
            .get("toolboxProxyUrl")
            .and_then(|v| v.as_str())
            .and_then(|url| checked_toolbox_url(&self.base, url).ok());
        Ok(CreatedSandbox { id, toolbox })
    }

    /// Look up the toolbox proxy URL of an existing sandbox.
    async fn toolbox_url(&self, id: &str) -> Result<String> {
        let resp = self
            .http
            .get(format!("{}/sandbox/{id}/toolbox-proxy-url", self.base))
            .bearer_auth(&self.token)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| anyhow!("daytona toolbox lookup request failed: {e}"))?;
        let status = resp.status();
        let body = read_response_capped(resp, "toolbox lookup").await?;
        if !status.is_success() {
            return Err(anyhow!(
                "daytona toolbox lookup failed (HTTP {status}): {}",
                response_excerpt(&body)
            ));
        }
        let value: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|e| anyhow!("daytona toolbox lookup returned unparseable body: {e}"))?;
        let url = value
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        checked_toolbox_url(&self.base, url)
    }

    /// Execute a command inside an existing sandbox. `toolbox` is the proxy URL
    /// when the caller already holds it; otherwise it is looked up by id.
    pub(super) async fn exec(
        &self,
        id: &str,
        toolbox: Option<&str>,
        spec: &ExecSpec,
    ) -> Result<ExecOutput> {
        // Join argv into a single shell command line; the toolbox executes it.
        let mut command = spec.command.clone();
        for arg in &spec.args {
            command.push(' ');
            command.push_str(arg);
        }
        let mut body = json!({ "command": command });
        if let Some(secs) = spec.timeout_secs {
            body["timeout"] = json!(secs);
        }

        let timeout = spec
            .timeout_secs
            .map(|s| Duration::from_secs(s).max(self.timeout))
            .unwrap_or(self.timeout);

        let toolbox = match toolbox {
            Some(url) => url.to_owned(),
            None => self.toolbox_url(id).await?,
        };
        let resp = self
            .http
            .post(format!("{toolbox}/{id}/process/execute"))
            .bearer_auth(&self.token)
            .timeout(timeout)
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow!("daytona exec request failed: {e}"))?;

        let status = resp.status();
        let body = read_response_capped(resp, "exec").await?;
        if !status.is_success() {
            return Err(anyhow!(
                "daytona exec failed (HTTP {status}): {}",
                response_excerpt(&body)
            ));
        }
        let value: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|e| anyhow!("daytona exec returned unparseable body: {e}"))?;
        let exit_code = value
            .get("exitCode")
            .or_else(|| value.get("code"))
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0) as i32;
        // The toolbox returns combined output under `result`/`output`/`stdout`.
        // Match the local process backend's per-stream cap after bounding the
        // serialized provider body above.
        let stdout = output_bytes(&value, &["result", "output", "stdout"], "stdout")?;
        let stderr = output_bytes(&value, &["stderr"], "stderr")?;
        Ok(ExecOutput {
            exit_code,
            stdout,
            stderr,
        })
    }

    /// Destroy a sandbox by id.
    pub(super) async fn destroy(&self, id: &str) -> Result<()> {
        let resp = self
            .http
            .delete(format!("{}/sandbox/{id}", self.base))
            .bearer_auth(&self.token)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| anyhow!("daytona destroy request failed: {e}"))?;
        let status = resp.status();
        // A 404 means the sandbox is already gone: treat as success (idempotent).
        if status.is_success() || status.as_u16() == 404 {
            return Ok(());
        }
        let body = read_response_capped(resp, "destroy").await?;
        Err(anyhow!(
            "daytona destroy failed (HTTP {status}): {}",
            response_excerpt(&body)
        ))
    }
}
