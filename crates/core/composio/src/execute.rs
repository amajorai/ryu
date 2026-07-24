//! Composio dispatch for the unified tool catalog (#474).
//!
//! Composio is **searchable, not listed**: it is never added to
//! [`super::McpRegistry::list_all_tools`]. Instead [`super::McpRegistry::search`]
//! pulls a capped slice of Composio actions live (via
//! [`crate::catalog::list_actions`]) when a key is configured, and the
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
    crate::auth::is_configured()
}

/// The Composio execute base URL (no trailing slash), reusing the catalog's
/// swappable [`crate::catalog::base_url`]. Validated to be https + on
/// the host allowlist; an off-policy override is rejected so the key is never
/// sent to an unexpected host.
fn execute_base_url() -> Result<String> {
    let base = crate::catalog::base_url();
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

/// The outcome of a Composio action execution.
///
/// The crate does the composio-specific detection and returns a *typed* result;
/// the Core-side MCP adapter turns [`ExecOutcome::NeedsConnection`] into the
/// shared `__ryu_elicitation__` envelope (the one identity-vault builder), so the
/// envelope shape stays single-sourced in Core and no Core type crosses this
/// crate boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecOutcome {
    /// A normal successful result payload (Composio's `data` unwrapped).
    Ok(Value),
    /// The user has not connected the relevant account yet: carries the message
    /// and, when present, the connect/redirect URL.
    NeedsConnection {
        message: String,
        url: Option<String>,
    },
}

/// Execute a Composio action (`tool` = the action slug, e.g. `GITHUB_CREATE_ISSUE`).
///
/// Replicates the gateway execute() request shape and ADDS connection-required
/// detection. On a connection/auth-required result, returns
/// [`ExecOutcome::NeedsConnection`] (so the Core adapter can build the pause
/// elicitation) instead of a bare Err.
pub async fn dispatch(
    http: &Client,
    tool: &str,
    arguments: Value,
    user_id: Option<&str>,
) -> Result<ExecOutcome> {
    let key = crate::auth::key()
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

    // Connection/auth-required → NeedsConnection (both error AND success
    // shapes can signal it; Composio has churned the surface).
    if let Some(outcome) = detect_elicitation(status.as_u16(), &body) {
        return Ok(outcome);
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
    Ok(ExecOutcome::Ok(body.get("data").cloned().unwrap_or(body)))
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

/// Detect a Composio connection/auth-required response. Returns
/// [`ExecOutcome::NeedsConnection`] carrying the message + optional connect URL,
/// or `None` when the response is a normal result or an unrelated error.
///
/// Defensive across shapes (mirrors `catalog`'s multi-field style):
///   - any body carrying a redirect/auth URL (`redirect_url`, `auth_url`,
///     `redirectUrl`, nested under `data`/`connection`) → connect;
///   - a 4xx/error whose message mentions a connection phrase → connect;
///   - `successful:false` / `error` with a connection phrase → connect.
///
/// The exact Composio wire shape for the unconnected case is unverified from the
/// repo; this is a defensive heuristic (see report open_questions). The
/// Core-side adapter turns the result into the shared `__ryu_elicitation__`
/// envelope (`kind:"url"`), byte-identical to the prior hand-rolled `json!`.
fn detect_elicitation(status: u16, body: &Value) -> Option<ExecOutcome> {
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
        return Some(ExecOutcome::NeedsConnection { message, url });
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
        match detect_elicitation(400, &body).expect("elicitation") {
            ExecOutcome::NeedsConnection { message, url } => {
                assert_eq!(url.as_deref(), Some("https://composio.dev/connect/abc"));
                assert!(message.contains("connected account"));
            }
            other => panic!("expected NeedsConnection, got {other:?}"),
        }
    }

    #[test]
    fn detect_elicitation_on_connection_phrase_without_url() {
        let body = json!({ "error": "User needs to be connected to Slack first" });
        match detect_elicitation(403, &body).expect("elicitation") {
            ExecOutcome::NeedsConnection { url, .. } => {
                // No URL present → None.
                assert!(url.is_none());
            }
            other => panic!("expected NeedsConnection, got {other:?}"),
        }
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
        // Serialize against every test that mutates the composio auth cache / key
        // env (process-global) so the "no key" state holds for this body.
        let _lock = crate::auth::test_env_lock();
        crate::auth::set_key("");
        clear_key_env();
        assert!(!is_configured());
    }

    #[test]
    fn resolve_entity_reads_env_fallback() {
        let _lock = crate::auth::test_env_lock();
        let prev = std::env::var(ENTITY_ENV).ok();
        std::env::set_var(ENTITY_ENV, "  ent-77  ");
        // No user id → the (trimmed) env entity is used.
        assert_eq!(resolve_entity(None), "ent-77");
        // A present user id still wins over the env.
        assert_eq!(resolve_entity(Some("u-1")), "u-1");
        // A blank env value is filtered → "default".
        std::env::set_var(ENTITY_ENV, "   ");
        assert_eq!(resolve_entity(None), "default");
        match prev {
            Some(v) => std::env::set_var(ENTITY_ENV, v),
            None => std::env::remove_var(ENTITY_ENV),
        }
    }

    #[test]
    fn execute_base_url_validates_override() {
        let _lock = crate::auth::test_env_lock();
        let prev = std::env::var("COMPOSIO_BASE_URL").ok();
        std::env::remove_var("COMPOSIO_BASE_URL");
        assert_eq!(
            execute_base_url().unwrap(),
            "https://backend.composio.dev/api/v3.1"
        );
        // An off-policy override is rejected before the key is sent.
        std::env::set_var("COMPOSIO_BASE_URL", "https://evil.example.com");
        assert!(execute_base_url().is_err());
        std::env::set_var("COMPOSIO_BASE_URL", "http://backend.composio.dev");
        assert!(execute_base_url().is_err());
        match prev {
            Some(v) => std::env::set_var("COMPOSIO_BASE_URL", v),
            None => std::env::remove_var("COMPOSIO_BASE_URL"),
        }
    }

    #[test]
    fn find_connect_url_scans_nested_scopes_and_requires_http() {
        // Top-level camelCase key.
        assert_eq!(
            find_connect_url(&json!({ "redirectUrl": "https://c/1" })).as_deref(),
            Some("https://c/1")
        );
        // Nested under data.connection.
        assert_eq!(
            find_connect_url(&json!({
                "data": { "connection": { "auth_url": "https://c/2" } }
            }))
            .as_deref(),
            Some("https://c/2")
        );
        // A non-http value is ignored (must start with "http").
        assert!(find_connect_url(&json!({ "connect_url": "ftp://x" })).is_none());
        // Nothing anywhere → None.
        assert!(find_connect_url(&json!({ "unrelated": true })).is_none());
    }

    #[test]
    fn error_text_first_nonempty_key() {
        assert_eq!(
            error_text(&json!({ "error": "boom" })).as_deref(),
            Some("boom")
        );
        // Empty `error` is skipped in favour of `message`.
        assert_eq!(
            error_text(&json!({ "error": "", "message": "second" })).as_deref(),
            Some("second")
        );
        assert_eq!(
            error_text(&json!({ "detail": "d" })).as_deref(),
            Some("d")
        );
        assert!(error_text(&json!({ "nope": 1 })).is_none());
    }

    #[test]
    fn detect_elicitation_url_alone_triggers_on_success_status() {
        // A URL present is sufficient even on a 2xx with no error text.
        let body = json!({ "connection": { "redirect_url": "https://connect/x" } });
        match detect_elicitation(200, &body).expect("elicitation") {
            ExecOutcome::NeedsConnection { message, url } => {
                assert_eq!(url.as_deref(), Some("https://connect/x"));
                // No message in the body → the default guidance is used.
                assert!(message.contains("requires connecting"));
            }
            other => panic!("expected NeedsConnection, got {other:?}"),
        }
    }

    #[test]
    fn detect_elicitation_failure_flag_with_phrase() {
        // successful:false + a connection phrase, no explicit URL.
        let body = json!({
            "successful": false,
            "message": "No active connection for Gmail",
        });
        match detect_elicitation(200, &body).expect("elicitation") {
            ExecOutcome::NeedsConnection { message, url } => {
                assert!(url.is_none());
                // Original casing is preserved in the surfaced message.
                assert!(message.contains("No active connection"));
            }
            other => panic!("expected NeedsConnection, got {other:?}"),
        }
    }

    #[test]
    fn detect_elicitation_none_when_failure_but_unrelated() {
        // 4xx / error present but the phrase does not match and no URL → None.
        assert!(detect_elicitation(500, &json!({ "error": "internal" })).is_none());
        // successful:true with no url and no phrase → None.
        assert!(detect_elicitation(200, &json!({ "successful": true })).is_none());
    }

    #[tokio::test]
    async fn dispatch_errors_without_key() {
        let _lock = crate::auth::test_env_lock();
        let prev_r = std::env::var("RYU_COMPOSIO_API_KEY").ok();
        let prev_c = std::env::var("COMPOSIO_API_KEY").ok();
        crate::auth::set_key("");
        clear_key_env();
        let http = Client::new();
        let err = dispatch(&http, "GITHUB_CREATE_ISSUE", json!({}), None)
            .await
            .expect_err("must error without a key");
        assert!(err.to_string().contains("Composio API key not set"));
        match prev_r {
            Some(v) => std::env::set_var("RYU_COMPOSIO_API_KEY", v),
            None => std::env::remove_var("RYU_COMPOSIO_API_KEY"),
        }
        match prev_c {
            Some(v) => std::env::set_var("COMPOSIO_API_KEY", v),
            None => std::env::remove_var("COMPOSIO_API_KEY"),
        }
    }
}
