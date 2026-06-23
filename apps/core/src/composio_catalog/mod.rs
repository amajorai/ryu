//! Composio catalog — browse the user's available Composio toolkits, tools
//! (actions), and trigger types using their configured Composio API key.
//!
//! **All logic lives here in Core** (mirroring [`crate::model_catalog`] and
//! [`crate::skills_catalog`]) so every surface reuses one HTTP API; clients are
//! thin GUI layers. The catalog only *browses* descriptors — the gateway still
//! owns Composio *execution* (`apps/gateway/src/composio`). This module never
//! runs an action.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): discovering *which*
//! tools/triggers exist for the user's connected accounts is "what's available"
//! — catalog/orchestration — so it belongs in Core. The key is resolved via
//! [`crate::composio_auth`] (preferences-first, env fallback).
//!
//! The Composio REST base is a swappable const/env ([`base_url`]). Composio has
//! churned its API surface (v1 → v3 → v3.1); the response shapes are read
//! defensively (multiple field fallbacks + `items`/`data`/top-level array) so a
//! minor schema change degrades to fewer fields rather than an error.

use std::time::Duration;

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::{json, Value};

/// Default Composio REST base (v3.1, current as of 2026-06). Override with the
/// `COMPOSIO_BASE_URL` env so a future surface change is one env, not a rebuild.
const DEFAULT_BASE_URL: &str = "https://backend.composio.dev/api/v3.1";

/// Query-parameter name used to filter tools/triggers by toolkit. Kept as a
/// const because the exact spelling (`toolkit_slug` vs `toolkits`) is the most
/// likely thing to drift; change it in one place if a fetch returns everything.
const TOOLKIT_FILTER_PARAM: &str = "toolkit_slug";

/// The active Composio REST base URL (no trailing slash).
pub fn base_url() -> String {
    std::env::var("COMPOSIO_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// Hosts permitted for `COMPOSIO_BASE_URL`. Pinning prevents a stray/hostile env
/// from redirecting the user's Composio key to an attacker host. Mirrors the
/// execute-side guard in [`crate::sidecar::mcp::composio`] so browse and execute
/// share one egress policy (#474 security: the key must never leave for an
/// unexpected host on either path).
const ALLOWED_HOSTS: &[&str] = &["backend.composio.dev", "api.composio.dev"];

/// Require https + a pinned Composio host for a base URL before the key is sent.
fn validate_base_url(base: &str) -> Result<()> {
    let url = url::Url::parse(base).map_err(|e| anyhow!("invalid COMPOSIO_BASE_URL: {e}"))?;
    if url.scheme() != "https" {
        return Err(anyhow!("COMPOSIO_BASE_URL must be https"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("COMPOSIO_BASE_URL has no host"))?;
    if !ALLOWED_HOSTS.iter().any(|h| host.eq_ignore_ascii_case(h)) {
        return Err(anyhow!(
            "COMPOSIO_BASE_URL host '{host}' is not allowlisted"
        ));
    }
    Ok(())
}

/// GET `{base}{path}` with the user's Composio key, returning parsed JSON.
async fn get_json(client: &Client, path: &str, query: &[(&str, &str)]) -> Result<Value> {
    let key = crate::composio_auth::key()
        .ok_or_else(|| anyhow!("Composio API key not set (Settings → Integrations)"))?;
    let base = base_url();
    // Validate before attaching the key so an off-policy override can't exfiltrate
    // it (the search path now reaches this with the key, same as execute).
    validate_base_url(&base)?;
    let url = format!("{}{}", base, path);
    // Drop empty query values so we don't send `?toolkit_slug=` etc.
    let pairs: Vec<(&str, &str)> = query
        .iter()
        .copied()
        .filter(|(_, v)| !v.is_empty())
        .collect();
    let resp = client
        .get(&url)
        .query(&pairs)
        .header("x-api-key", key)
        .header("accept", "application/json")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| anyhow!("Composio request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Composio API {status}: {body}"));
    }
    resp.json::<Value>()
        .await
        .map_err(|e| anyhow!("Composio response parse error: {e}"))
}

/// Pull the result array out of a Composio list response, tolerant of shape
/// (`items`, `data`, or a bare top-level array).
fn items_of(v: &Value) -> Vec<Value> {
    if let Some(a) = v.get("items").and_then(Value::as_array) {
        return a.clone();
    }
    if let Some(a) = v.get("data").and_then(Value::as_array) {
        return a.clone();
    }
    if let Some(a) = v.as_array() {
        return a.clone();
    }
    Vec::new()
}

/// First non-empty string among `keys`, also checking a nested `meta` object.
fn str_field(item: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = item.get(*k).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
        if let Some(s) = item
            .get("meta")
            .and_then(|m| m.get(*k))
            .and_then(Value::as_str)
        {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Browse the user's available Composio toolkits.
pub async fn list_toolkits(client: &Client) -> Result<Value> {
    let raw = get_json(client, "/toolkits", &[]).await?;
    let data: Vec<Value> = items_of(&raw)
        .iter()
        .map(|t| {
            json!({
                "slug": str_field(t, &["slug", "key", "name"]).unwrap_or_default(),
                "name": str_field(t, &["name", "display_name", "slug"]).unwrap_or_default(),
                "description": str_field(t, &["description", "desc"]),
                "logo": str_field(t, &["logo", "logo_url", "icon"]),
                "categories": t.get("categories").cloned().unwrap_or(Value::Null),
            })
        })
        .filter(|t| !t["slug"].as_str().unwrap_or("").is_empty())
        .collect();
    Ok(json!({ "object": "list", "data": data }))
}

/// List the actions (tools) for a toolkit, with an optional search query.
pub async fn list_actions(
    client: &Client,
    toolkit: &str,
    query: &str,
    limit: usize,
) -> Result<Value> {
    let limit_s = limit.to_string();
    let raw = get_json(
        client,
        "/tools",
        &[
            (TOOLKIT_FILTER_PARAM, toolkit),
            ("search", query),
            ("limit", &limit_s),
        ],
    )
    .await?;
    let data: Vec<Value> = items_of(&raw)
        .iter()
        .map(|a| {
            json!({
                "name": str_field(a, &["slug", "name", "enum"]).unwrap_or_default(),
                "display_name": str_field(a, &["display_name", "name", "slug"]).unwrap_or_default(),
                "description": str_field(a, &["description", "desc"]),
                "toolkit": str_field(a, &["toolkit_slug", "toolkit", "app_name"])
                    .unwrap_or_else(|| toolkit.to_string()),
                "no_auth": a.get("no_auth").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .filter(|a| !a["name"].as_str().unwrap_or("").is_empty())
        .collect();
    Ok(json!({ "object": "list", "toolkit": toolkit, "data": data }))
}

/// List the trigger types for a toolkit (used by the agent "On a Composio event"
/// trigger picker).
pub async fn list_triggers(client: &Client, toolkit: &str) -> Result<Value> {
    let raw = get_json(
        client,
        "/triggers_types",
        &[(TOOLKIT_FILTER_PARAM, toolkit)],
    )
    .await?;
    let data: Vec<Value> = items_of(&raw)
        .iter()
        .map(|t| {
            json!({
                "name": str_field(t, &["slug", "name", "enum"]).unwrap_or_default(),
                "display_name": str_field(t, &["display_name", "name", "slug"]).unwrap_or_default(),
                "description": str_field(t, &["description", "desc"]),
                "toolkit": str_field(t, &["toolkit_slug", "toolkit", "app_name"])
                    .unwrap_or_else(|| toolkit.to_string()),
                "config": t.get("config").cloned().unwrap_or(Value::Null),
            })
        })
        .filter(|t| !t["name"].as_str().unwrap_or("").is_empty())
        .collect();
    Ok(json!({ "object": "list", "toolkit": toolkit, "data": data }))
}
