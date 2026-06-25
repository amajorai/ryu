//! Resolving a widget's [`WidgetSource`] into a JSON value.
//!
//! Each source kind has a dedicated path:
//!   - `Static`       — returns the literal inline data.
//!   - `CoreEndpoint` — a curated **allowlist** of internal Core routes, fetched
//!     over loopback (no arbitrary base URL). The allowlist is the security
//!     boundary: the AI/user can only name an endpoint we approved.
//!   - `Monitor`      — the named monitor's latest result (via `/api/monitors`).
//!   - `Workflow`     — runs a saved workflow and reads a key from its output.
//!   - `Composio`     — executes a Composio action through the Gateway.
//!   - `Http`         — an arbitrary external GET, **SSRF-guarded** (https only,
//!     no private/loopback/link-local/metadata targets).
//!   - `Agent`        — re-runs a configured agent and parses its JSON reply.
//!
//! An optional dotted `selector` ("a.b.0.c") narrows a JSON response to one field.

use anyhow::{anyhow, Result};
use serde_json::Value;
use std::time::Duration;

use super::WidgetSource;

/// Curated allowlist: the only internal endpoints a `CoreEndpoint` widget may
/// read. Maps a stable short name (what the builder/UI uses) to its loopback
/// path. Arbitrary internal access is deliberately impossible.
pub fn core_endpoint_path(name: &str) -> Option<&'static str> {
    match name {
        "system_status" => Some("/api/system/status"),
        "sidecar_status" => Some("/api/sidecar/status"),
        "connections" => Some("/api/connections"),
        "quests" => Some("/api/quests"),
        "monitors" => Some("/api/monitors"),
        "engines" => Some("/api/engines"),
        "agents" => Some("/api/agents"),
        "workflows" => Some("/workflows"),
        "meetings" => Some("/api/meetings"),
        _ => None,
    }
}

/// The names a `CoreEndpoint` widget may use (surfaced to the builder + UI).
pub const CORE_ENDPOINT_NAMES: &[&str] = &[
    "system_status",
    "sidecar_status",
    "connections",
    "quests",
    "monitors",
    "engines",
    "agents",
    "workflows",
    "meetings",
];

/// Loopback base URL of this Core process, derived from the SAME bind chain
/// `main.rs` uses (`--bind=` arg → `RYU_BIND` env → `127.0.0.1:7980`), then forced
/// to the loopback host for self-calls. Replicating the full chain (not just
/// `RYU_BIND`) keeps CoreEndpoint widgets working under a headless `--bind=` too.
fn self_base() -> String {
    let bind = std::env::args()
        .skip(1)
        .find(|a| a.starts_with("--bind="))
        .and_then(|a| a.strip_prefix("--bind=").map(str::to_string))
        .or_else(|| std::env::var("RYU_BIND").ok())
        .unwrap_or_else(|| "127.0.0.1:7980".to_string());
    let port = bind.rsplit(':').next().unwrap_or("7980");
    format!("http://127.0.0.1:{port}")
}

/// The shared-secret token, if the node runs with one (self-calls must present it).
fn self_token() -> Option<String> {
    std::env::var("RYU_TOKEN").ok().filter(|s| !s.is_empty())
}

/// Walk a dotted path ("a.b.0.c") into a JSON value. Each segment is an object
/// key or, if numeric, an array index. Returns null when the path misses.
pub fn select(value: &Value, selector: Option<&str>) -> Value {
    let path = match selector.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => p,
        None => return value.clone(),
    };
    let mut cur = value;
    for seg in path.split('.') {
        cur = match cur {
            Value::Object(map) => match map.get(seg) {
                Some(v) => v,
                None => return Value::Null,
            },
            Value::Array(arr) => match seg.parse::<usize>().ok().and_then(|i| arr.get(i)) {
                Some(v) => v,
                None => return Value::Null,
            },
            _ => return Value::Null,
        };
    }
    cur.clone()
}

/// Resolve a source to its current value. `widget_id` scopes the per-widget agent
/// conversation so two widgets on the same agent don't share (and bleed) context.
pub async fn resolve(
    http: &reqwest::Client,
    source: &WidgetSource,
    widget_id: &str,
) -> Result<Value> {
    match source {
        WidgetSource::Static { data } => Ok(data.clone()),
        WidgetSource::CoreEndpoint { endpoint, selector } => {
            let path = core_endpoint_path(endpoint)
                .ok_or_else(|| anyhow!("'{endpoint}' is not an allowed Core endpoint"))?;
            let body = loopback_get(http, path).await?;
            Ok(select(&body, selector.as_deref()))
        }
        WidgetSource::Monitor { monitor_id } => {
            let body = loopback_get(http, "/api/monitors").await?;
            let monitors = body.get("monitors").and_then(Value::as_array);
            let found = monitors.and_then(|arr| {
                arr.iter()
                    .find(|m| m.get("id").and_then(Value::as_str) == Some(monitor_id.as_str()))
                    .cloned()
            });
            found.ok_or_else(|| anyhow!("monitor '{monitor_id}' not found"))
        }
        WidgetSource::Workflow {
            workflow_id,
            input,
            output_key,
        } => resolve_workflow(http, workflow_id, input, output_key.as_deref()).await,
        WidgetSource::Composio { action, args } => resolve_composio(http, action, args).await,
        WidgetSource::Http {
            url,
            selector,
            headers,
        } => resolve_http(url, selector.as_deref(), headers).await,
        WidgetSource::Agent { agent_id, prompt } => {
            resolve_agent(agent_id, prompt, widget_id).await
        }
    }
}

/// GET an internal path over loopback, presenting the shared token when set.
async fn loopback_get(http: &reqwest::Client, path: &str) -> Result<Value> {
    let url = format!("{}{}", self_base(), path);
    let mut req = http.get(&url).timeout(Duration::from_secs(15));
    if let Some(t) = self_token() {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("core self-call to {path} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!(
            "core self-call to {path} returned {}",
            resp.status()
        ));
    }
    resp.json()
        .await
        .map_err(|e| anyhow!("core self-call to {path} was not JSON: {e}"))
}

async fn resolve_workflow(
    http: &reqwest::Client,
    workflow_id: &str,
    input: &std::collections::HashMap<String, String>,
    output_key: Option<&str>,
) -> Result<Value> {
    let url = format!("{}/workflows/{}/run", self_base(), workflow_id);
    let mut req = http
        .post(&url)
        .timeout(Duration::from_secs(120))
        .json(&serde_json::json!({ "input": input }));
    if let Some(t) = self_token() {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("workflow run failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("workflow run returned {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("workflow run response was not JSON: {e}"))?;
    let output = body.get("run").and_then(|r| r.get("output"));
    match (output, output_key) {
        (Some(out), Some(key)) => Ok(out.get(key).cloned().unwrap_or(Value::Null)),
        (Some(out), None) => Ok(out.clone()),
        (None, _) => Ok(body),
    }
}

async fn resolve_composio(http: &reqwest::Client, action: &str, args: &Value) -> Result<Value> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};
    let url = format!("{}/tools/execute/{}", gateway_url(), action);
    let mut req = http
        .post(&url)
        .timeout(Duration::from_secs(60))
        .json(&serde_json::json!({ "arguments": args }));
    if let Some(t) = gateway_token() {
        req = req.bearer_auth(t);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("composio execute failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("composio execute returned {}", resp.status()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| anyhow!("composio response was not JSON: {e}"))?;
    // Composio wraps payloads in `data`; surface it when present.
    Ok(body.get("data").cloned().unwrap_or(body))
}

async fn resolve_agent(agent_id: &str, prompt: &str, widget_id: &str) -> Result<Value> {
    let runner = crate::sidecar::agent_runner::global_agent_runner()
        .ok_or_else(|| anyhow!("agent runner not available"))?;
    // One stable conversation PER WIDGET (not per agent) keeps each widget's
    // context across ticks without two widgets on the same agent bleeding context.
    let conv_id = format!("dashboard-widget-{widget_id}");
    let reply = runner
        .run(Some(agent_id.to_string()), conv_id, prompt.to_string())
        .await
        .map_err(|e| anyhow!("agent run failed: {e}"))?;
    Ok(parse_agent_reply(&reply))
}

/// Best-effort: pull JSON out of an agent reply (a fenced ```json block or the
/// whole string), falling back to `{ "text": reply }` for prose.
fn parse_agent_reply(reply: &str) -> Value {
    let trimmed = reply.trim();
    if let Some(start) = trimmed.find("```") {
        let after = &trimmed[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        if let Some(end) = after.find("```") {
            let inner = after[..end].trim();
            if let Ok(v) = serde_json::from_str::<Value>(inner) {
                return v;
            }
        }
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return v;
    }
    serde_json::json!({ "text": reply })
}

/// Fetch an arbitrary external HTTPS endpoint with full SSRF protection:
///   - https only;
///   - the host is resolved ONCE, every resolved IP is validated as public, and
///     the connection is **pinned** to that validated IP (`Client::resolve`) so a
///     DNS-rebind between check and connect cannot retarget an internal address;
///   - **redirects are disabled** (`Policy::none()`) so a `30x → internal` hop
///     cannot bypass the guard. A redirect surfaces as a non-2xx error.
async fn resolve_http(
    url: &str,
    selector: Option<&str>,
    headers: &std::collections::HashMap<String, String>,
) -> Result<Value> {
    let header_pairs = headers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect::<Vec<_>>();
    let (status, body) = crate::server::guarded_fetch_text_with_headers(url, &header_pairs).await?;
    if (300..400).contains(&status) {
        return Err(anyhow!("http source refused: redirects are not allowed"));
    }
    if !(200..300).contains(&status) {
        return Err(anyhow!("http GET returned {status}"));
    }
    let body: Value =
        serde_json::from_str(&body).map_err(|e| anyhow!("response was not JSON: {e}"))?;
    Ok(select(&body, selector.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_helpers_work() {
        let v = serde_json::json!({ "a": { "b": [1, 2, 3] } });
        assert_eq!(select(&v, Some("a.b.2")), serde_json::json!(3));
        assert_eq!(select(&v, Some("nope")), Value::Null);
    }
}
