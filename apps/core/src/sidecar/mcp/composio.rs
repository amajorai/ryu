//! Composio dispatch for the unified tool catalog (#474).
//!
//! Composio is **searchable, not listed**: it is never added to
//! [`super::McpRegistry::list_all_tools`]. Instead [`super::McpRegistry::search`]
//! pulls a capped slice of Composio actions live (via
//! [`crate::composio_catalog::list_actions`]) when a key is configured, and the
//! model executes a chosen action by its fully-qualified id `composio__<slug>`.
//!
//! Placement (CLAUDE.md §1): running a Composio action is *what runs* → Core.
//! The allowlist verdict / budget / audit is *what's allowed/measured* → Gateway
//! (the unified [`super::McpRegistry::call_tool_with_user`] path emits those).
//!
//! This module mirrors the gateway's execute() request shape
//! (`apps/gateway/src/composio/mod.rs`): v3.1 `POST /tools/execute/{slug}` with a
//! `{ arguments, user_id, entity_id }` body — and ADDS connection/auth-required
//! detection that returns the `__ryu_elicitation__` envelope (a hard P4
//! dependency: without it the HITL pause cannot fire).

use std::time::Duration;

use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::{json, Value};

/// Server name for Composio tools. A fully-qualified Composio tool id is
/// `composio__<slug>`. Not registered as an MCP server; resolved by id prefix.
pub const SERVER_NAME: &str = "composio";

/// Env that selects the default Composio entity when no per-request `user_id` is
/// supplied. Used ONLY as a fallback — never when a `user_id` is present.
const ENTITY_ENV: &str = "COMPOSIO_ENTITY_ID";

/// Hosts permitted for `COMPOSIO_BASE_URL` in managed mode. Pinning prevents a
/// stray env from redirecting the user's key to an attacker host.
const ALLOWED_HOSTS: &[&str] = &["backend.composio.dev", "api.composio.dev"];

/// True when a Composio key is configured (preferences or env).
pub fn is_configured() -> bool {
    crate::composio_auth::is_configured()
}

/// The Composio execute base URL (no trailing slash), reusing the catalog's
/// swappable [`crate::composio_catalog::base_url`]. Validated to be https + on
/// the host allowlist; an off-policy override is rejected so the key is never
/// sent to an unexpected host.
fn execute_base_url() -> Result<String> {
    let base = crate::composio_catalog::base_url();
    validate_base_url(&base)?;
    Ok(base)
}

/// Require https + a pinned Composio host. Returns the input on success.
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

/// Resolve the Composio entity for this call. A non-empty `user_id` always wins;
/// the env / `"default"` is the fallback only.
///
/// **Trust boundary (CLAUDE.md §1):** Core does NOT authenticate `user_id` — it
/// trusts the injected value. Core is single-principal and local-first; deciding
/// "what is allowed / who may act as whom" is *Gateway / control-plane* scope,
/// not Core's (Core must never enforce policy inline). Cross-tenant isolation
/// (binding `user_id` to an authenticated session so user A cannot act on user
/// B's connected accounts) is therefore the responsibility of the authenticating
/// proxy in front of Core, NOT this function.
fn resolve_entity(user_id: Option<&str>) -> String {
    if let Some(u) = user_id {
        let t = u.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    std::env::var(ENTITY_ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// Execute a Composio action (`tool` = the action slug, e.g. `GITHUB_CREATE_ISSUE`).
///
/// Replicates the gateway execute() request shape and ADDS connection-required
/// detection. On a connection/auth-required result, returns the
/// `__ryu_elicitation__` envelope as the Ok value (so the PTC invoker can pause)
/// instead of a bare Err.
pub async fn dispatch(
    http: &Client,
    tool: &str,
    arguments: Value,
    user_id: Option<&str>,
) -> Result<Value> {
    let key = crate::composio_auth::key()
        .ok_or_else(|| anyhow!("Composio API key not set (Settings → Integrations)"))?;
    let entity = resolve_entity(user_id);
    let url = format!("{}/tools/execute/{tool}", execute_base_url()?);

    // Use a no-redirect client: the host allowlist only screens the *initial*
    // URL, so a 3xx from the allowlisted host could otherwise bounce the request
    // (carrying `x-api-key`) to an inner host. Fall back to the shared client if
    // the dedicated one can't be built.
    let no_redirect = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build();
    let client = no_redirect.as_ref().unwrap_or(http);

    let resp = client
        .post(&url)
        .header("x-api-key", key)
        .header("Content-Type", "application/json")
        .header("accept", "application/json")
        .json(&json!({
            "arguments": arguments,
            "user_id": entity,
            "entity_id": entity,
        }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| anyhow!("Composio request failed: {e}"))?;

    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);

    // Connection/auth-required → elicitation envelope (both error AND success
    // shapes can signal it; Composio has churned the surface).
    if let Some(envelope) = detect_elicitation(status.as_u16(), &body) {
        return Ok(envelope);
    }

    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(Value::as_str)
            .or_else(|| body.get("message").and_then(Value::as_str))
            .map(|s| s.to_string())
            .unwrap_or_else(|| body.to_string());
        return Err(anyhow!("Composio action {tool} failed: {status}: {msg}"));
    }

    // Composio wraps results in a `data` field; unwrap when present.
    Ok(body.get("data").cloned().unwrap_or(body))
}

/// Phrases that, when present in an error/message string, indicate the user has
/// not connected the relevant account yet (so we should elicit a connect URL).
const CONNECTION_PHRASES: &[&str] = &[
    "no connected account",
    "not connected",
    "no connection",
    "connection not found",
    "connected account",
    "needs to be connected",
    "please connect",
    "active connection",
    "no active connection",
    "auth config",
    "requires authentication",
];

/// Detect a Composio connection/auth-required response and build the
/// `__ryu_elicitation__` envelope. Returns `None` when the response is a normal
/// result or an unrelated error.
///
/// Defensive across shapes (mirrors `composio_catalog`'s multi-field style):
///   - any body carrying a redirect/auth URL (`redirect_url`, `auth_url`,
///     `redirectUrl`, nested under `data`/`connection`) → `kind:"url"`;
///   - a 4xx/error whose message mentions a connection phrase → `kind:"url"`;
///   - `successful:false` / `error` with a connection phrase → `kind:"url"`.
///
/// The exact Composio wire shape for the unconnected case is unverified from the
/// repo; this is a defensive heuristic (see report open_questions).
fn detect_elicitation(status: u16, body: &Value) -> Option<Value> {
    let url = find_connect_url(body);
    let text = error_text(body).map(|s| s.to_lowercase());
    let mentions_connection = text
        .as_deref()
        .is_some_and(|t| CONNECTION_PHRASES.iter().any(|p| t.contains(p)));

    let is_failure = status >= 400
        || body
            .get("successful")
            .and_then(Value::as_bool)
            .is_some_and(|ok| !ok)
        || body.get("error").is_some();

    if url.is_some() || (is_failure && mentions_connection) {
        let message = text
            .as_deref()
            .map(|t| {
                // Use the original-cased message when available, not lowercased.
                error_text(body).unwrap_or_else(|| t.to_string())
            })
            .unwrap_or_else(|| {
                "This action requires connecting your account. Open the link to connect, then retry."
                    .to_string()
            });
        // Reuse the shared envelope builder (Unit 3) so the `__ryu_elicitation__`
        // shape stays identical across the Composio (HTTP-response) detector and
        // the domain-keyed (vault) detector. `kind` is always `"url"`; `url` is
        // emitted only when present — byte-identical to the prior hand-rolled
        // `json!`.
        let elicit = crate::tool_exec::Elicitation {
            kind: "url".to_owned(),
            message,
            url,
            requested_schema: None,
        };
        return Some(crate::identity::to_envelope(&elicit));
    }
    None
}

/// Pull a connect/redirect URL out of a Composio response across known shapes.
fn find_connect_url(body: &Value) -> Option<String> {
    const URL_KEYS: &[&str] = &[
        "redirect_url",
        "redirectUrl",
        "auth_url",
        "authUrl",
        "connect_url",
    ];
    // Top level, then a couple of common nestings.
    let scopes = [
        Some(body),
        body.get("data"),
        body.get("connection"),
        body.get("data").and_then(|d| d.get("connection")),
    ];
    for scope in scopes.into_iter().flatten() {
        for k in URL_KEYS {
            if let Some(s) = scope.get(*k).and_then(Value::as_str) {
                if s.starts_with("http") {
                    return Some(s.to_string());
                }
            }
        }
    }
    None
}

/// Best-effort human-readable error/message string from a Composio body.
fn error_text(body: &Value) -> Option<String> {
    for k in ["error", "message", "detail", "errorMessage"] {
        if let Some(s) = body.get(k).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clear_key_env() {
        std::env::remove_var("RYU_COMPOSIO_API_KEY");
        std::env::remove_var("COMPOSIO_API_KEY");
    }

    #[test]
    fn resolve_entity_prefers_user_id() {
        assert_eq!(resolve_entity(Some("user-42")), "user-42");
        assert_eq!(resolve_entity(Some("  user-42  ")), "user-42");
    }

    #[test]
    fn resolve_entity_falls_back_to_default_when_no_user() {
        std::env::remove_var(ENTITY_ENV);
        assert_eq!(resolve_entity(None), "default");
        assert_eq!(resolve_entity(Some("   ")), "default");
    }

    #[test]
    fn validate_base_url_pins_https_and_host() {
        assert!(validate_base_url("https://backend.composio.dev/api/v3.1").is_ok());
        assert!(validate_base_url("http://backend.composio.dev").is_err());
        assert!(validate_base_url("https://evil.example.com").is_err());
    }

    #[test]
    fn detect_elicitation_on_redirect_url() {
        let body = json!({
            "successful": false,
            "redirect_url": "https://composio.dev/connect/abc",
            "error": "no connected account for github",
        });
        let env = detect_elicitation(400, &body).expect("elicitation");
        let inner = &env["__ryu_elicitation__"];
        assert_eq!(inner["kind"], "url");
        assert_eq!(inner["url"], "https://composio.dev/connect/abc");
        assert!(inner["message"]
            .as_str()
            .unwrap()
            .contains("connected account"));
    }

    #[test]
    fn detect_elicitation_on_connection_phrase_without_url() {
        let body = json!({ "error": "User needs to be connected to Slack first" });
        let env = detect_elicitation(403, &body).expect("elicitation");
        assert_eq!(env["__ryu_elicitation__"]["kind"], "url");
        // No URL present → no url key.
        assert!(env["__ryu_elicitation__"].get("url").is_none());
    }

    #[test]
    fn detect_elicitation_none_on_normal_success() {
        let body = json!({ "successful": true, "data": { "issue": 1 } });
        assert!(detect_elicitation(200, &body).is_none());
    }

    #[test]
    fn detect_elicitation_none_on_unrelated_error() {
        let body = json!({ "error": "invalid argument: title is required" });
        assert!(detect_elicitation(422, &body).is_none());
    }

    #[test]
    fn is_configured_false_without_key() {
        crate::composio_auth::set_key("");
        clear_key_env();
        assert!(!is_configured());
    }
}
