//! Claude Code subscription usage. Reads the OAuth credential the `claude` CLI
//! stores — `~/.claude/.credentials.json` on Windows/Linux, or the login
//! Keychain (generic password, service `Claude Code-credentials`) on macOS,
//! where the CLI keeps the same JSON blob instead of an on-disk file — and calls
//! `GET https://api.anthropic.com/api/oauth/usage` — the same endpoint Claude
//! Code's own `/usage` uses — then maps `five_hour` / `seven_day` /
//! `seven_day_sonnet` / `extra_usage` into normalized windows.
//!
//! The endpoint shape + required `anthropic-beta: oauth-2025-04-20` header were
//! reconstructed from the openusage reference implementation; verify against one
//! live response before trusting blindly (the contract can drift).

use std::path::PathBuf;

use serde::Deserialize;

use super::{
    http_client, read_file, reason_for_status, UsageSnapshot, UsageUnavailable, UsageWindow,
};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// The usage endpoint to call. In production this is always [`USAGE_URL`]; the
/// `#[cfg(test)]` variant lets a hermetic loopback server stand in via
/// `RYU_USAGE_CLAUDE_URL`, so the end-to-end `fetch` path can be exercised
/// without touching the real vendor. Compiled out of release builds entirely.
#[cfg(not(test))]
fn usage_url() -> String {
    USAGE_URL.to_string()
}
#[cfg(test)]
fn usage_url() -> String {
    std::env::var("RYU_USAGE_CLAUDE_URL").unwrap_or_else(|_| USAGE_URL.to_string())
}
/// Header value the usage endpoint expects (mirrors the `claude` CLI).
const ANTHROPIC_BETA: &str = "oauth-2025-04-20";
/// The scope the usage endpoint requires; a token without it can do inference
/// but not read subscription windows.
const USAGE_SCOPE: &str = "user:profile";
/// Refresh slack the CLI uses — treat a token within this window of expiry as
/// already needing refresh (so we don't fire a call that's about to 401).
const EXPIRY_SLACK_MS: f64 = 5.0 * 60.0 * 1000.0;

#[derive(Debug, Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    oauth: Option<Oauth>,
}

#[derive(Debug, Deserialize)]
struct Oauth {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    /// Epoch milliseconds.
    #[serde(rename = "expiresAt")]
    expires_at: Option<f64>,
    #[serde(rename = "subscriptionType")]
    subscription_type: Option<String>,
    #[serde(rename = "rateLimitTier")]
    rate_limit_tier: Option<String>,
    #[serde(default)]
    scopes: Option<Vec<String>>,
}

/// `~/.claude/.credentials.json`, honouring the `CLAUDE_CONFIG_DIR` override the
/// CLI itself uses.
fn credentials_path() -> PathBuf {
    let home = if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        let trimmed = dir.trim().to_string();
        if trimmed.is_empty() {
            default_home()
        } else {
            PathBuf::from(trimmed)
        }
    } else {
        default_home()
    };
    home.join(".credentials.json")
}

fn default_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

/// Read the Claude OAuth credentials JSON. Prefers the on-disk file (correct on
/// Windows/Linux, and when `CLAUDE_CONFIG_DIR` is set); on macOS the `claude`
/// CLI stores the same blob in the login Keychain instead, so fall back to that
/// when the file is absent/empty.
fn read_credentials() -> Option<String> {
    if let Some(text) = read_file(&credentials_path()) {
        if !text.trim().is_empty() {
            return Some(text);
        }
    }
    #[cfg(target_os = "macos")]
    {
        read_keychain()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// macOS stores the `claude` CLI OAuth blob as a login-Keychain generic
/// password (service `Claude Code-credentials`), not on disk. Shell out to the
/// signed `security` tool to read the same JSON payload. Runs off the async
/// worker (see [`fetch`]) because a first-time read can surface a Keychain
/// authorization dialog and block until the user answers.
#[cfg(target_os = "macos")]
fn read_keychain() -> Option<String> {
    const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
    // `.no_window()` (CREATE_NO_WINDOW) was dropped in the crate extraction: this
    // fn is macOS-only, and that flag is Windows-only — it was already a no-op on
    // the one platform that compiles this. Behaviour is identical.
    let output = std::process::Command::new("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    let unavailable =
        |reason: UsageUnavailable| UsageSnapshot::unavailable(agent_id, "claude", reason);

    // Off the async worker: the macOS Keychain fallback can block on an
    // authorization dialog, and the file read is sync IO either way.
    let text = match tokio::task::spawn_blocking(read_credentials).await {
        Ok(Some(text)) => text,
        Ok(None) => return unavailable(UsageUnavailable::NotLoggedIn),
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    let Ok(parsed) = serde_json::from_str::<CredentialsFile>(&text) else {
        return unavailable(UsageUnavailable::NotLoggedIn);
    };
    let Some(oauth) = parsed.oauth else {
        return unavailable(UsageUnavailable::NotLoggedIn);
    };
    let Some(access_token) = oauth.access_token.filter(|t| !t.is_empty()) else {
        return unavailable(UsageUnavailable::NotLoggedIn);
    };

    // Scope gate: a token that predates the scopes field (absent/empty) is
    // allowed (it would 403 loudly if it really lacked access); a present list
    // missing `user:profile` can't read usage.
    if let Some(scopes) = oauth.scopes.as_ref().filter(|s| !s.is_empty()) {
        if !scopes.iter().any(|s| s == USAGE_SCOPE) {
            return unavailable(UsageUnavailable::MissingScope);
        }
    }

    // Local freshness check — NEVER refresh (single-use refresh tokens).
    if let Some(expires_at) = oauth.expires_at {
        let now_ms = chrono::Utc::now().timestamp_millis() as f64;
        if expires_at - now_ms <= EXPIRY_SLACK_MS {
            return unavailable(UsageUnavailable::TokenExpired);
        }
    }

    let plan = format_plan(
        oauth.subscription_type.as_deref(),
        oauth.rate_limit_tier.as_deref(),
    );

    let resp = http_client()
        .get(usage_url())
        .header("Authorization", format!("Bearer {}", access_token.trim()))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("anthropic-beta", ANTHROPIC_BETA)
        .header("User-Agent", "claude-code/2.1.69")
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    if !resp.status().is_success() {
        return unavailable(reason_for_status(resp.status()));
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return unavailable(UsageUnavailable::Error);
    };

    let mut windows = Vec::new();
    if let Some(w) = window(&body, "five_hour", "Session") {
        windows.push(w);
    }
    if let Some(w) = window(&body, "seven_day", "Weekly") {
        windows.push(w);
    }
    if let Some(w) = window(&body, "seven_day_sonnet", "Sonnet weekly") {
        windows.push(w);
    }

    UsageSnapshot {
        agent_id: agent_id.to_string(),
        engine: "claude".to_string(),
        available: true,
        plan,
        reason: None,
        windows,
        extra_usage_usd: extra_usage_usd(&body),
    }
}

/// Map one `{ utilization, resets_at }` object into a normalized window.
/// `utilization` is already a 0–100 percent.
fn window(body: &serde_json::Value, key: &str, label: &str) -> Option<UsageWindow> {
    let obj = body.get(key)?;
    let used_percent = obj.get("utilization").and_then(serde_json::Value::as_f64)?;
    Some(UsageWindow {
        label: label.to_string(),
        used_percent,
        resets_at: obj
            .get("resets_at")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    })
}

/// Monthly pay-as-you-go "extra usage" dollars spent, when enabled. `used_credits`
/// is in cents.
fn extra_usage_usd(body: &serde_json::Value) -> Option<f64> {
    let obj = body.get("extra_usage")?;
    if obj.get("is_enabled").and_then(serde_json::Value::as_bool) != Some(true) {
        return None;
    }
    let cents = obj
        .get("used_credits")
        .and_then(serde_json::Value::as_f64)?;
    Some(cents / 100.0)
}

/// "Max" + " 20x" → "Max 20x". Title-case the subscription, append the numeric
/// multiplier from the rate-limit tier when present.
fn format_plan(subscription_type: Option<&str>, rate_limit_tier: Option<&str>) -> Option<String> {
    let raw = subscription_type?.trim();
    if raw.is_empty() {
        return None;
    }
    let base = title_case(raw);
    let multiplier = rate_limit_tier.and_then(|tier| {
        tier.split(|c: char| !c.is_ascii_alphanumeric())
            .find(|seg| {
                seg.ends_with('x') && seg[..seg.len() - 1].chars().all(|c| c.is_ascii_digit())
            })
            .filter(|seg| seg.len() > 1)
            .map(str::to_string)
    });
    match multiplier {
        Some(m) => Some(format!("{base} {m}")),
        None => Some(base),
    }
}

/// Lowercase-then-capitalize each whitespace/underscore-separated word.
fn title_case(s: &str) -> String {
    s.split(|c: char| c.is_whitespace() || c == '_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => {
                    first.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::spawn_loopback;

    // CLAUDE_CONFIG_DIR + RYU_USAGE_CLAUDE_URL are process-global; serialize every
    // env-touching test so parallel runs don't clobber each other's fixtures.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Point CLAUDE_CONFIG_DIR at `dir` and write a `.credentials.json` there.
    fn write_creds(dir: &std::path::Path, body: &str) {
        std::env::set_var("CLAUDE_CONFIG_DIR", dir);
        std::fs::write(dir.join(".credentials.json"), body).unwrap();
    }

    fn clear_env() {
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        std::env::remove_var("RYU_USAGE_CLAUDE_URL");
    }

    // ── pure helpers ─────────────────────────────────────────────────────────

    #[test]
    fn title_case_capitalizes_words() {
        assert_eq!(title_case("max"), "Max");
        assert_eq!(title_case("MAX PLAN"), "Max Plan");
        assert_eq!(title_case("pro_max"), "Pro Max");
        assert_eq!(title_case("   "), "");
    }

    #[test]
    fn format_plan_appends_multiplier() {
        assert_eq!(
            format_plan(Some("max"), Some("default_max_20x")).as_deref(),
            Some("Max 20x")
        );
        assert_eq!(
            format_plan(Some("max"), Some("something-5x-tier")).as_deref(),
            Some("Max 5x")
        );
    }

    #[test]
    fn format_plan_without_valid_multiplier() {
        // No tier => base only.
        assert_eq!(format_plan(Some("pro"), None).as_deref(), Some("Pro"));
        // Tier present but no "<digits>x" segment => base only.
        assert_eq!(
            format_plan(Some("pro"), Some("standard")).as_deref(),
            Some("Pro")
        );
        // A bare "x" segment (len == 1) is filtered out => base only.
        assert_eq!(format_plan(Some("pro"), Some("x")).as_deref(), Some("Pro"));
        // Non-numeric prefix before x is rejected => base only.
        assert_eq!(
            format_plan(Some("pro"), Some("ax")).as_deref(),
            Some("Pro")
        );
    }

    #[test]
    fn format_plan_none_for_missing_or_empty_subscription() {
        assert_eq!(format_plan(None, Some("default_max_20x")), None);
        assert_eq!(format_plan(Some("   "), None), None);
    }

    #[test]
    fn window_maps_utilization_and_resets_at() {
        let body = serde_json::json!({
            "five_hour": { "utilization": 42.5, "resets_at": "2026-07-23T05:00:00Z" }
        });
        let w = window(&body, "five_hour", "Session").unwrap();
        assert_eq!(w.label, "Session");
        assert_eq!(w.used_percent, 42.5);
        assert_eq!(w.resets_at.as_deref(), Some("2026-07-23T05:00:00Z"));
    }

    #[test]
    fn window_empty_resets_at_is_dropped() {
        let body = serde_json::json!({ "k": { "utilization": 3.0, "resets_at": "" } });
        let w = window(&body, "k", "L").unwrap();
        assert!(w.resets_at.is_none());
    }

    #[test]
    fn window_none_without_utilization() {
        let body = serde_json::json!({ "k": { "resets_at": "x" } });
        assert!(window(&body, "k", "L").is_none());
        // Missing key entirely.
        assert!(window(&body, "absent", "L").is_none());
    }

    #[test]
    fn extra_usage_usd_converts_cents_when_enabled() {
        let body = serde_json::json!({
            "extra_usage": { "is_enabled": true, "used_credits": 250 }
        });
        assert_eq!(extra_usage_usd(&body), Some(2.5));
    }

    #[test]
    fn extra_usage_usd_none_when_disabled_or_absent() {
        let disabled = serde_json::json!({
            "extra_usage": { "is_enabled": false, "used_credits": 250 }
        });
        assert_eq!(extra_usage_usd(&disabled), None);
        let no_credits =
            serde_json::json!({ "extra_usage": { "is_enabled": true } });
        assert_eq!(extra_usage_usd(&no_credits), None);
        assert_eq!(extra_usage_usd(&serde_json::json!({})), None);
    }

    // ── credential path resolution ───────────────────────────────────────────

    #[test]
    fn credentials_path_honours_override_and_default() {
        let _g = lock();
        std::env::set_var("CLAUDE_CONFIG_DIR", "/tmp/xyz-claude");
        assert_eq!(
            credentials_path(),
            PathBuf::from("/tmp/xyz-claude").join(".credentials.json")
        );
        // Whitespace-only override falls back to the default ~/.claude home.
        std::env::set_var("CLAUDE_CONFIG_DIR", "   ");
        assert_eq!(credentials_path(), default_home().join(".credentials.json"));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(credentials_path(), default_home().join(".credentials.json"));
    }

    #[test]
    fn read_credentials_prefers_nonempty_file() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), "{\"hello\":true}");
        assert_eq!(read_credentials().as_deref(), Some("{\"hello\":true}"));
        clear_env();
    }

    // ── fetch gates (no network) ─────────────────────────────────────────────

    #[tokio::test]
    async fn fetch_not_logged_in_on_empty_oauth() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        // Valid JSON but no claudeAiOauth => NotLoggedIn (and non-empty file, so
        // the macOS keychain fallback is never consulted).
        write_creds(dir.path(), "{}");
        let snap = fetch("acp:claude").await;
        assert!(!snap.available);
        assert_eq!(snap.engine, "claude");
        assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_not_logged_in_on_invalid_json() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), "this is not json");
        let snap = fetch("acp:claude").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_not_logged_in_on_empty_access_token() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), r#"{"claudeAiOauth":{"accessToken":""}}"#);
        let snap = fetch("acp:claude").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_missing_scope_when_scopes_lack_user_profile() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(
            dir.path(),
            r#"{"claudeAiOauth":{"accessToken":"tok","scopes":["user:inference"]}}"#,
        );
        let snap = fetch("acp:claude").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::MissingScope)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_token_expired_when_past_expiry() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        // expiresAt one hour in the past.
        let past = chrono::Utc::now().timestamp_millis() - 3_600_000;
        write_creds(
            dir.path(),
            &format!(r#"{{"claudeAiOauth":{{"accessToken":"tok","expiresAt":{past}}}}}"#),
        );
        let snap = fetch("acp:claude").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::TokenExpired)));
        clear_env();
    }

    // ── fetch end-to-end via loopback server ─────────────────────────────────

    fn future_expiry_creds() -> String {
        let future = chrono::Utc::now().timestamp_millis() + 3_600_000;
        format!(
            r#"{{"claudeAiOauth":{{"accessToken":"tok","expiresAt":{future},"subscriptionType":"max","rateLimitTier":"default_max_20x","scopes":["user:profile"]}}}}"#
        )
    }

    #[tokio::test]
    async fn fetch_happy_path_builds_windows_and_plan() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), &future_expiry_creds());
        let url = spawn_loopback(
            "200 OK",
            r#"{"five_hour":{"utilization":42.5,"resets_at":"2026-07-23T05:00:00Z"},"seven_day":{"utilization":10.0,"resets_at":""},"seven_day_sonnet":{"utilization":5.0},"extra_usage":{"is_enabled":true,"used_credits":250}}"#,
        );
        std::env::set_var("RYU_USAGE_CLAUDE_URL", &url);

        let snap = fetch("acp:claude").await;
        assert!(snap.available, "reason={:?}", snap.reason);
        assert_eq!(snap.engine, "claude");
        assert_eq!(snap.plan.as_deref(), Some("Max 20x"));
        assert_eq!(snap.extra_usage_usd, Some(2.5));
        assert_eq!(snap.windows.len(), 3);
        assert_eq!(snap.windows[0].label, "Session");
        assert_eq!(snap.windows[0].used_percent, 42.5);
        assert_eq!(
            snap.windows[0].resets_at.as_deref(),
            Some("2026-07-23T05:00:00Z")
        );
        assert_eq!(snap.windows[1].label, "Weekly");
        assert!(snap.windows[1].resets_at.is_none());
        assert_eq!(snap.windows[2].label, "Sonnet weekly");
        clear_env();
    }

    #[tokio::test]
    async fn fetch_maps_401_to_token_expired() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), &future_expiry_creds());
        let url = spawn_loopback("401 Unauthorized", "{}");
        std::env::set_var("RYU_USAGE_CLAUDE_URL", &url);
        let snap = fetch("acp:claude").await;
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::TokenExpired)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_maps_429_to_rate_limited() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), &future_expiry_creds());
        let url = spawn_loopback("429 Too Many Requests", "{}");
        std::env::set_var("RYU_USAGE_CLAUDE_URL", &url);
        let snap = fetch("acp:claude").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::RateLimited)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_maps_500_to_error() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), &future_expiry_creds());
        let url = spawn_loopback("500 Internal Server Error", "{}");
        std::env::set_var("RYU_USAGE_CLAUDE_URL", &url);
        let snap = fetch("acp:claude").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::Error)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_bad_json_body_is_error() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), &future_expiry_creds());
        let url = spawn_loopback("200 OK", "not-json-at-all");
        std::env::set_var("RYU_USAGE_CLAUDE_URL", &url);
        let snap = fetch("acp:claude").await;
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::Error)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_connection_refused_is_error() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), &future_expiry_creds());
        // Port 1 on loopback refuses immediately — exercises the reqwest send-error
        // arm without any external network.
        std::env::set_var("RYU_USAGE_CLAUDE_URL", "http://127.0.0.1:1/usage");
        let snap = fetch("acp:claude").await;
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::Error)));
        clear_env();
    }

    /// Route through the public entry point so the `fetch_usage` engine-dispatch
    /// arm for Claude is exercised (the other tests call `fetch` directly).
    #[tokio::test]
    async fn fetch_usage_dispatches_to_claude() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_creds(dir.path(), "{}"); // valid JSON, no oauth => NotLoggedIn
        let snap = crate::fetch_usage("acp:claude").await;
        assert_eq!(snap.engine, "claude");
        assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));
        clear_env();
    }

    #[test]
    fn credentials_deserialize_tolerates_shapes() {
        // Unknown fields are ignored; absent optionals default to None; explicit
        // nulls parse to None; a wrong-typed field is a parse error. Exercises the
        // derived Deserialize branches for each struct field.
        let all = serde_json::from_str::<CredentialsFile>(
            r#"{"unknown":1,"claudeAiOauth":{"accessToken":"t","expiresAt":null,"subscriptionType":null,"rateLimitTier":null,"scopes":null,"extra":true}}"#,
        )
        .unwrap();
        let oauth = all.oauth.unwrap();
        assert_eq!(oauth.access_token.as_deref(), Some("t"));
        assert!(oauth.expires_at.is_none());
        assert!(oauth.scopes.is_none());

        let empty = serde_json::from_str::<CredentialsFile>("{}").unwrap();
        assert!(empty.oauth.is_none());

        // Wrong type for a numeric field => Err (deserialize error path).
        assert!(serde_json::from_str::<CredentialsFile>(
            r#"{"claudeAiOauth":{"expiresAt":"not-a-number"}}"#
        )
        .is_err());
    }

    #[test]
    fn credential_structs_are_debug_printable() {
        // Exercises the derived Debug impls on the credential structs.
        let parsed: CredentialsFile = serde_json::from_str(
            r#"{"claudeAiOauth":{"accessToken":"t","expiresAt":1.0,"subscriptionType":"max","rateLimitTier":"x","scopes":["user:profile"]}}"#,
        )
        .unwrap();
        assert!(!format!("{parsed:?}").is_empty());
    }
}
