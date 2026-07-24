//! Composio connect — proactively connect a user's account to a toolkit so the
//! Marketplace → Connections tab can authorize ahead of tool execution.
//!
//! **Why this exists.** Historically Ryu connected Composio accounts *lazily*:
//! the first time an agent ran a Composio action against an un-connected account,
//! [`crate::sidecar::mcp::composio`]'s `dispatch` detected the
//! connection-required response and surfaced a `__ryu_elicitation__` connect URL
//! (see [`crate::identity::source::manual::ComposioSource`]). That path still
//! exists for execution-time recovery. This module adds the **proactive** path:
//! a user browses the catalog and connects Gmail/Slack/… up front, before any
//! agent run.
//!
//! **Placement (CLAUDE.md §1).** Discovering "what's available" and managing the
//! user's own connections is catalog/orchestration → Core, mirroring
//! [`crate::composio_catalog`]. The gateway still owns *execution*. The key is
//! resolved via [`crate::composio_auth`] (preferences-first, env fallback).
//!
//! **Wire surface.** The connect endpoints live under `/api/v3` (the catalog
//! browses `/api/v3.1`); same host, so the egress allowlist is unchanged. The
//! flow, per Composio's REST docs (Composio-managed OAuth, recommended `link`):
//!   1. ensure a Composio-managed **auth config** exists for the toolkit
//!      (`GET/POST /api/v3/auth_configs`),
//!   2. **initiate** a connected account
//!      (`POST /api/v3/connected_accounts/link` → `{ redirect_url, id }`),
//!   3. **poll** the connected account (`GET /api/v3/connected_accounts/{id}`)
//!      until `status == ACTIVE`.
//! List existing connections with
//! `GET /api/v3/connected_accounts?user_ids=&toolkit_slugs=`.
//!
//! Composio churns its surface, so every response is read defensively (multiple
//! field fallbacks) exactly like [`crate::composio_catalog`].

use std::time::Duration;

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::{json, Value};

/// Env that selects the default Composio entity (end-user id) for the local,
/// single-principal Core when no explicit user is supplied. Mirrors the execute
/// path's `COMPOSIO_ENTITY_ID` so browse-connect and execute share one entity.
const ENTITY_ENV: &str = "COMPOSIO_ENTITY_ID";

/// Resolve the Composio entity (end-user id) for connect/list. Single-principal
/// Core uses the env override or `"default"`; matches
/// [`crate::sidecar::mcp::composio`]'s `resolve_entity` fallback so a connection
/// made here is the same one execution later reuses.
pub fn entity() -> String {
    std::env::var(ENTITY_ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// The Composio `/api/v3` base, derived from the catalog's swappable host so a
/// `COMPOSIO_BASE_URL` override (and the host allowlist it enforces) governs both
/// browse and connect. The catalog base is versioned (`…/api/v3.1`); the connect
/// endpoints are `…/api/v3`, so we rebuild the path from the validated host.
fn connect_base_url() -> Result<String> {
    let catalog_base = crate::catalog::base_url();
    let url =
        url::Url::parse(&catalog_base).map_err(|e| anyhow!("invalid Composio base URL: {e}"))?;
    if url.scheme() != "https" {
        return Err(anyhow!("Composio base URL must be https"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("Composio base URL has no host"))?;
    // Pin to the same allowlist the catalog/execute paths use; an off-policy
    // host override must never receive the user's key.
    const ALLOWED_HOSTS: &[&str] = &["backend.composio.dev", "api.composio.dev"];
    if !ALLOWED_HOSTS.iter().any(|h| host.eq_ignore_ascii_case(h)) {
        return Err(anyhow!("Composio host '{host}' is not allowlisted"));
    }
    Ok(format!("https://{host}/api/v3"))
}

/// A redirect-free client so a 3xx from the allowlisted host can't bounce the
/// request (carrying `x-api-key`) to an inner host. Falls back to the shared
/// client if the dedicated one can't be built.
fn no_redirect_client(shared: &Client) -> Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| shared.clone())
}

/// GET `{v3}{path}` with the user's Composio key, returning parsed JSON.
async fn get_json(client: &Client, path: &str, query: &[(&str, &str)]) -> Result<Value> {
    let key =
        crate::auth::key().ok_or_else(|| anyhow!("Composio API key not set (Gateway → Keys)"))?;
    let url = format!("{}{}", connect_base_url()?, path);
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

/// POST `{v3}{path}` with a JSON body and the user's Composio key.
async fn post_json(client: &Client, path: &str, body: &Value) -> Result<Value> {
    let key =
        crate::auth::key().ok_or_else(|| anyhow!("Composio API key not set (Gateway → Keys)"))?;
    let url = format!("{}{}", connect_base_url()?, path);
    let resp = no_redirect_client(client)
        .post(&url)
        .header("x-api-key", key)
        .header("Content-Type", "application/json")
        .header("accept", "application/json")
        .json(body)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| anyhow!("Composio request failed: {e}"))?;
    let status = resp.status();
    let parsed: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = parsed
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| parsed.get("message").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| parsed.to_string());
        return Err(anyhow!("Composio API {status}: {msg}"));
    }
    Ok(parsed)
}

/// First non-empty string among `keys`, also checking a nested `meta` object —
/// matches [`crate::composio_catalog`]'s tolerance for shape drift.
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

/// Pull the result array out of a list response (`items`, `data`, or bare array).
fn items_of(v: &Value) -> Vec<Value> {
    for key in ["items", "data", "connected_accounts", "accounts"] {
        if let Some(a) = v.get(key).and_then(Value::as_array) {
            return a.clone();
        }
    }
    v.as_array().cloned().unwrap_or_default()
}

/// True when a Composio connection status string means "ready to use".
fn is_active_status(status: &str) -> bool {
    status.eq_ignore_ascii_case("ACTIVE")
}

/// Normalize one connected-account record to `{ id, toolkit, status, active }`.
fn normalize_connection(item: &Value) -> Value {
    let status = str_field(item, &["status", "state", "connectionStatus"]).unwrap_or_default();
    let toolkit = str_field(
        item,
        &[
            "toolkit_slug",
            "toolkit",
            "app_name",
            "appName",
            "appUniqueId",
        ],
    )
    .or_else(|| {
        item.get("toolkit")
            .and_then(|t| t.get("slug"))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
    .unwrap_or_default();
    json!({
        "id": str_field(item, &["id", "connected_account_id", "nanoid"]).unwrap_or_default(),
        "toolkit": toolkit,
        "status": status,
        "active": is_active_status(&status),
    })
}

/// List the user's connected accounts, optionally filtered to one toolkit.
/// Returns `{ object: "list", data: [{ id, toolkit, status, active }] }`.
pub async fn list_connections(client: &Client, toolkit: &str) -> Result<Value> {
    let entity = entity();
    let raw = get_json(
        client,
        "/connected_accounts",
        &[("user_ids", entity.as_str()), ("toolkit_slugs", toolkit)],
    )
    .await?;
    let data: Vec<Value> = items_of(&raw)
        .iter()
        .map(normalize_connection)
        .filter(|c| !c["id"].as_str().unwrap_or("").is_empty())
        .collect();
    Ok(json!({ "object": "list", "data": data }))
}

/// Find an existing Composio-managed auth config for a toolkit, or create one.
///
/// An auth config is a reusable, per-toolkit blueprint (one per toolkit, shared
/// across the local user's connections). We prefer `use_composio_managed_auth`
/// so the user does not have to register their own OAuth app for prototyping.
async fn ensure_auth_config(client: &Client, toolkit: &str) -> Result<String> {
    // Reuse an existing config if one is already present for this toolkit.
    if let Ok(existing) = get_json(client, "/auth_configs", &[("toolkit_slug", toolkit)]).await {
        if let Some(id) = items_of(&existing)
            .iter()
            .find_map(|c| str_field(c, &["id", "nanoid", "auth_config_id"]))
        {
            return Ok(id);
        }
    }
    // None yet — create a managed-auth config. Body is sent defensively with both
    // the nested-toolkit and flat shapes Composio has used across versions.
    let created = post_json(
        client,
        "/auth_configs",
        &json!({
            "toolkit": { "slug": toolkit },
            "auth_config": { "type": "use_composio_managed_auth" },
        }),
    )
    .await?;
    // The created config id can surface at the top level or nested under
    // `auth_config`/`data`.
    let scopes = [
        Some(&created),
        created.get("auth_config"),
        created.get("data"),
    ];
    for scope in scopes.into_iter().flatten() {
        if let Some(id) = str_field(scope, &["id", "nanoid", "auth_config_id"]) {
            return Ok(id);
        }
    }
    Err(anyhow!(
        "Composio auth config created but no id was returned"
    ))
}

/// Initiate a connection for a toolkit. Ensures an auth config exists, then calls
/// the recommended Composio-managed `link` endpoint. Returns
/// `{ connection_id, redirect_url, status }` — the caller opens `redirect_url`
/// in the browser and polls [`connection_status`] until `active`.
pub async fn initiate(client: &Client, toolkit: &str) -> Result<Value> {
    if toolkit.trim().is_empty() {
        return Err(anyhow!("toolkit is required to connect"));
    }
    let auth_config_id = ensure_auth_config(client, toolkit).await?;
    let body = json!({
        "auth_config_id": auth_config_id,
        "user_id": entity(),
    });
    let resp = post_json(client, "/connected_accounts/link", &body).await?;
    // The redirect URL and connection id can appear at the top level or nested
    // under `connection_data`/`connectionData`/`data`.
    let url_keys = &["redirect_url", "redirectUrl", "auth_url", "authUrl"];
    let id_keys = &["id", "connected_account_id", "connectedAccountId", "nanoid"];
    let scopes = [
        Some(&resp),
        resp.get("connection_data"),
        resp.get("connectionData"),
        resp.get("data"),
    ];
    let mut redirect_url: Option<String> = None;
    let mut connection_id: Option<String> = None;
    for scope in scopes.into_iter().flatten() {
        if redirect_url.is_none() {
            redirect_url = str_field(scope, url_keys).filter(|s| s.starts_with("http"));
        }
        if connection_id.is_none() {
            connection_id = str_field(scope, id_keys);
        }
    }
    let redirect_url = redirect_url.ok_or_else(|| {
        anyhow!("Composio did not return a redirect URL for the connection (toolkit '{toolkit}')")
    })?;
    Ok(json!({
        "connection_id": connection_id.unwrap_or_default(),
        "redirect_url": redirect_url,
        "status": str_field(&resp, &["status", "state"]).unwrap_or_else(|| "INITIATED".into()),
    }))
}

/// Poll a single connection's status by id. Returns
/// `{ id, toolkit, status, active }`.
pub async fn connection_status(client: &Client, id: &str) -> Result<Value> {
    if id.trim().is_empty() {
        return Err(anyhow!("connection id is required"));
    }
    let raw = get_json(client, &format!("/connected_accounts/{id}"), &[]).await?;
    // The account can be wrapped under `account_details`/`data` or be top-level.
    let record = raw
        .get("account_details")
        .or_else(|| raw.get("data"))
        .unwrap_or(&raw);
    let mut normalized = normalize_connection(record);
    // Preserve the queried id if the body omitted it.
    if normalized["id"].as_str().unwrap_or("").is_empty() {
        normalized["id"] = json!(id);
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entity_defaults_to_default() {
        // COMPOSIO_ENTITY_ID is process-global and set by sibling tests; take the
        // shared env lock so this reads a stable value, and restore it after.
        let _lock = crate::auth::test_env_lock();
        let prev = std::env::var(ENTITY_ENV).ok();
        std::env::remove_var(ENTITY_ENV);
        assert_eq!(entity(), "default");
        match prev {
            Some(v) => std::env::set_var(ENTITY_ENV, v),
            None => std::env::remove_var(ENTITY_ENV),
        }
    }

    #[test]
    fn entity_reads_env_override() {
        let _lock = crate::auth::test_env_lock();
        let prev = std::env::var(ENTITY_ENV).ok();
        std::env::set_var(ENTITY_ENV, "  member-9  ");
        assert_eq!(entity(), "member-9");
        // A whitespace-only override falls back to the default.
        std::env::set_var(ENTITY_ENV, "   ");
        assert_eq!(entity(), "default");
        match prev {
            Some(v) => std::env::set_var(ENTITY_ENV, v),
            None => std::env::remove_var(ENTITY_ENV),
        }
    }

    #[test]
    fn connect_base_is_v3_on_allowlisted_host() {
        let _lock = crate::auth::test_env_lock();
        let prev = std::env::var("COMPOSIO_BASE_URL").ok();
        std::env::remove_var("COMPOSIO_BASE_URL");
        // Default catalog base is …/api/v3.1 → connect base is …/api/v3.
        assert_eq!(
            connect_base_url().unwrap(),
            "https://backend.composio.dev/api/v3"
        );
        match prev {
            Some(v) => std::env::set_var("COMPOSIO_BASE_URL", v),
            None => std::env::remove_var("COMPOSIO_BASE_URL"),
        }
    }

    #[test]
    fn connect_base_url_rejects_off_policy_override() {
        let _lock = crate::auth::test_env_lock();
        let prev = std::env::var("COMPOSIO_BASE_URL").ok();
        // Non-https catalog base → connect base build fails.
        std::env::set_var("COMPOSIO_BASE_URL", "http://backend.composio.dev/api/v3.1");
        assert!(connect_base_url().is_err());
        // Off-allowlist host over https → fails (key must never leave for it).
        std::env::set_var("COMPOSIO_BASE_URL", "https://evil.example.com/api/v3.1");
        assert!(connect_base_url().is_err());
        match prev {
            Some(v) => std::env::set_var("COMPOSIO_BASE_URL", v),
            None => std::env::remove_var("COMPOSIO_BASE_URL"),
        }
    }

    #[test]
    fn is_active_status_only_for_active() {
        assert!(is_active_status("ACTIVE"));
        assert!(is_active_status("active"));
        assert!(!is_active_status("INITIATED"));
        assert!(!is_active_status("FAILED"));
    }

    #[test]
    fn normalize_connection_reads_nested_toolkit() {
        let item = json!({
            "id": "ca_123",
            "status": "ACTIVE",
            "toolkit": { "slug": "github" },
        });
        let n = normalize_connection(&item);
        assert_eq!(n["id"], "ca_123");
        assert_eq!(n["toolkit"], "github");
        assert_eq!(n["active"], true);
    }

    #[test]
    fn normalize_connection_reads_flat_toolkit_slug() {
        let item = json!({
            "id": "ca_456",
            "status": "INITIATED",
            "toolkit_slug": "slack",
        });
        let n = normalize_connection(&item);
        assert_eq!(n["toolkit"], "slack");
        assert_eq!(n["active"], false);
    }

    #[test]
    fn normalize_connection_reads_camel_appname_and_alt_status_and_id_keys() {
        let item = json!({
            "connected_account_id": "ca_789",
            "connectionStatus": "active",
            "appName": "notion",
        });
        let n = normalize_connection(&item);
        assert_eq!(n["id"], "ca_789");
        assert_eq!(n["toolkit"], "notion");
        assert_eq!(n["status"], "active");
        assert_eq!(n["active"], true);
    }

    #[test]
    fn normalize_connection_missing_fields_default_empty_and_inactive() {
        let n = normalize_connection(&json!({}));
        assert_eq!(n["id"], "");
        assert_eq!(n["toolkit"], "");
        assert_eq!(n["status"], "");
        assert_eq!(n["active"], false);
    }

    #[test]
    fn items_of_reads_connection_specific_keys() {
        // The connect module additionally recognises connected_accounts / accounts.
        assert_eq!(
            items_of(&json!({ "connected_accounts": [{"id":"a"}] })).len(),
            1
        );
        assert_eq!(items_of(&json!({ "accounts": [{"id":"b"},{"id":"c"}] })).len(), 2);
        // Falls through to items/data and bare arrays too.
        assert_eq!(items_of(&json!({ "items": [{"id":"d"}] })).len(), 1);
        assert_eq!(items_of(&json!([{"id":"e"}])).len(), 1);
        assert!(items_of(&json!({ "nope": 1 })).is_empty());
    }

    #[test]
    fn str_field_meta_fallback() {
        let item = json!({ "id": "", "meta": { "id": "from-meta" } });
        assert_eq!(str_field(&item, &["id"]).as_deref(), Some("from-meta"));
        assert!(str_field(&item, &["missing"]).is_none());
    }

    #[tokio::test]
    async fn initiate_rejects_empty_toolkit() {
        let http = Client::new();
        let err = initiate(&http, "   ")
            .await
            .expect_err("empty toolkit must error before any HTTP");
        assert!(err.to_string().contains("toolkit is required"));
    }

    #[tokio::test]
    async fn connection_status_rejects_empty_id() {
        let http = Client::new();
        let err = connection_status(&http, "  ")
            .await
            .expect_err("empty id must error before any HTTP");
        assert!(err.to_string().contains("connection id is required"));
    }
}
