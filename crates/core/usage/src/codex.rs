//! Codex subscription usage. Reads the OAuth token the `codex` CLI stores in
//! `auth.json` and calls `GET https://chatgpt.com/backend-api/wham/usage` — the
//! same endpoint Codex's own usage view uses — then maps
//! `rate_limit.primary_window` (the 5h "session") and `secondary_window` (the
//! weekly window) into normalized windows.
//!
//! Endpoint + field names were reconstructed from the openusage reference
//! implementation; verify against one live response before trusting blindly.

use std::path::PathBuf;

use serde::Deserialize;

use super::{
    http_client, jwt_exp_unix, read_file, reason_for_status, UsageSnapshot, UsageUnavailable,
    UsageWindow,
};

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// The usage endpoint to call. Production always uses [`USAGE_URL`]; the
/// `#[cfg(test)]` variant lets a hermetic loopback server stand in via
/// `RYU_USAGE_CODEX_URL` so the end-to-end `fetch` path can be exercised without
/// the real vendor. Compiled out of release builds entirely.
#[cfg(not(test))]
fn usage_url() -> String {
    USAGE_URL.to_string()
}
#[cfg(test)]
fn usage_url() -> String {
    std::env::var("RYU_USAGE_CODEX_URL").unwrap_or_else(|_| USAGE_URL.to_string())
}
/// Refresh the access token within this slack of its JWT `exp` (same window the
/// `codex` CLI uses) — so we skip a call that's about to 401.
const EXPIRY_SLACK_SECS: i64 = 5 * 60;

#[derive(Debug, Deserialize)]
struct AuthFile {
    tokens: Option<Tokens>,
    #[serde(rename = "OPENAI_API_KEY")]
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Tokens {
    #[serde(rename = "access_token")]
    access_token: Option<String>,
    #[serde(rename = "account_id")]
    account_id: Option<String>,
}

/// Candidate `auth.json` locations, in priority order: the `CODEX_HOME` override
/// the CLI honours, then the two default homes, then Ryu's isolated copy (used
/// when the user only ever logged in through Ryu's gateway-passthrough path).
fn auth_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(custom) = std::env::var("CODEX_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            paths.push(PathBuf::from(trimmed).join("auth.json"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".config").join("codex").join("auth.json"));
        paths.push(home.join(".codex").join("auth.json"));
    }
    // Ryu's isolated copy (used when the user only ever logged in through Ryu's
    // gateway-passthrough path). Its path is a kernel data-dir concept, so it
    // arrives through the host seam; absent host (unit test) → skip the candidate.
    if let Some(host) = super::host() {
        paths.push(host.ryu_codex_home().join("auth.json"));
    }
    paths
}

fn load_auth() -> Option<AuthFile> {
    for path in auth_paths() {
        if let Some(text) = read_file(&path) {
            if let Ok(auth) = serde_json::from_str::<AuthFile>(&text) {
                let has_token = auth
                    .tokens
                    .as_ref()
                    .and_then(|t| t.access_token.as_ref())
                    .is_some_and(|t| !t.is_empty());
                let has_key = auth.api_key.as_ref().is_some_and(|k| !k.is_empty());
                if has_token || has_key {
                    return Some(auth);
                }
            }
        }
    }
    None
}

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    let unavailable =
        |reason: UsageUnavailable| UsageSnapshot::unavailable(agent_id, "codex", reason);

    let Some(auth) = load_auth() else {
        return unavailable(UsageUnavailable::NotLoggedIn);
    };

    // Subscription usage needs the OAuth access token. An API-key-only login has
    // no plan window to report → hide the bar.
    let Some(tokens) = auth.tokens else {
        return unavailable(UsageUnavailable::Unsupported);
    };
    let Some(access_token) = tokens.access_token.filter(|t| !t.is_empty()) else {
        return unavailable(UsageUnavailable::Unsupported);
    };

    // Local freshness check — NEVER refresh (single-use refresh tokens).
    if let Some(exp) = jwt_exp_unix(&access_token) {
        let now = chrono::Utc::now().timestamp();
        if exp - now <= EXPIRY_SLACK_SECS {
            return unavailable(UsageUnavailable::TokenExpired);
        }
    }

    let mut req = http_client()
        .get(usage_url())
        .header("Authorization", format!("Bearer {}", access_token.trim()))
        .header("Accept", "application/json")
        .header("User-Agent", "Ryu");
    if let Some(account_id) = tokens.account_id.as_ref().filter(|a| !a.is_empty()) {
        req = req.header("ChatGPT-Account-Id", account_id);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    if !resp.status().is_success() {
        return unavailable(reason_for_status(resp.status()));
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return unavailable(UsageUnavailable::Error);
    };

    let rate_limit = body.get("rate_limit");
    let now = chrono::Utc::now();
    let mut windows = Vec::new();
    if let Some(rl) = rate_limit {
        if let Some(w) = window(rl.get("primary_window"), "Session", now) {
            windows.push(w);
        }
        if let Some(w) = window(rl.get("secondary_window"), "Weekly", now) {
            windows.push(w);
        }
    }

    UsageSnapshot {
        agent_id: agent_id.to_string(),
        engine: "codex".to_string(),
        available: true,
        plan: body
            .get("plan_type")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(title_case_plan),
        reason: None,
        windows,
        extra_usage_usd: None,
    }
}

/// Map a `{ used_percent, reset_at, reset_after_seconds }` window (the wham/usage
/// shape, verified live). `reset_at` is an absolute epoch-seconds timestamp;
/// `reset_after_seconds` is a relative fallback added to `now`. Either is
/// normalized to an RFC3339 `resets_at`.
fn window(
    obj: Option<&serde_json::Value>,
    label: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<UsageWindow> {
    let obj = obj?;
    let used_percent = obj
        .get("used_percent")
        .and_then(serde_json::Value::as_f64)?;

    let resets_at = obj
        .get("reset_at")
        .and_then(serde_json::Value::as_i64)
        .and_then(|epoch| chrono::DateTime::from_timestamp(epoch, 0))
        .map(|dt| dt.to_rfc3339())
        .or_else(|| {
            let secs = obj
                .get("reset_after_seconds")
                .and_then(serde_json::Value::as_i64)?;
            Some((now + chrono::Duration::seconds(secs)).to_rfc3339())
        });

    Some(UsageWindow {
        label: label.to_string(),
        used_percent,
        resets_at,
    })
}

/// "plus" / "pro" / "team" → "Plus" / "Pro" / "Team".
fn title_case_plan(s: &str) -> String {
    let mut chars = s.trim().chars();
    match chars.next() {
        Some(first) => {
            first.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase()
        }
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::spawn_loopback;

    // CODEX_HOME + RYU_USAGE_CODEX_URL are process-global; serialize env-touching
    // tests. A crafted auth.json under CODEX_HOME is the FIRST auth candidate, so
    // it deterministically wins over any real ~/.codex on the dev machine.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write_auth(dir: &std::path::Path, body: &str) {
        std::env::set_var("CODEX_HOME", dir);
        std::fs::write(dir.join("auth.json"), body).unwrap();
    }

    fn clear_env() {
        std::env::remove_var("CODEX_HOME");
        std::env::remove_var("RYU_USAGE_CODEX_URL");
    }

    fn jwt_with_exp(exp: i64) -> String {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!(r#"{{"exp":{exp}}}"#).as_bytes());
        format!("h.{payload}.s")
    }

    // ── pure helpers ─────────────────────────────────────────────────────────

    #[test]
    fn title_case_plan_capitalizes() {
        assert_eq!(title_case_plan("plus"), "Plus");
        assert_eq!(title_case_plan("PRO"), "Pro");
        assert_eq!(title_case_plan(" team "), "Team");
        assert_eq!(title_case_plan(""), "");
    }

    #[test]
    fn window_uses_absolute_reset_at() {
        let now = chrono::Utc::now();
        let obj = serde_json::json!({ "used_percent": 30.0, "reset_at": 1_800_000_000i64 });
        let w = window(Some(&obj), "Session", now).unwrap();
        assert_eq!(w.label, "Session");
        assert_eq!(w.used_percent, 30.0);
        let expected = chrono::DateTime::from_timestamp(1_800_000_000, 0)
            .unwrap()
            .to_rfc3339();
        assert_eq!(w.resets_at.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn window_falls_back_to_relative_reset_after_seconds() {
        let now = chrono::Utc::now();
        let obj = serde_json::json!({ "used_percent": 12.0, "reset_after_seconds": 3600i64 });
        let w = window(Some(&obj), "Weekly", now).unwrap();
        let expected = (now + chrono::Duration::seconds(3600)).to_rfc3339();
        assert_eq!(w.resets_at.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn window_without_any_reset_has_no_timestamp() {
        let now = chrono::Utc::now();
        let obj = serde_json::json!({ "used_percent": 5.0 });
        let w = window(Some(&obj), "L", now).unwrap();
        assert_eq!(w.used_percent, 5.0);
        assert!(w.resets_at.is_none());
    }

    #[test]
    fn window_none_without_used_percent_or_object() {
        let now = chrono::Utc::now();
        assert!(window(None, "L", now).is_none());
        let obj = serde_json::json!({ "reset_at": 1_800_000_000i64 });
        assert!(window(Some(&obj), "L", now).is_none());
    }

    // ── auth path resolution ─────────────────────────────────────────────────

    #[test]
    fn auth_paths_prioritizes_codex_home() {
        let _g = lock();
        std::env::set_var("CODEX_HOME", "/tmp/xyz-codex");
        let paths = auth_paths();
        assert_eq!(paths[0], PathBuf::from("/tmp/xyz-codex").join("auth.json"));
        std::env::remove_var("CODEX_HOME");
        // Without the override, CODEX_HOME is not the first candidate.
        let paths = auth_paths();
        assert!(paths
            .iter()
            .all(|p| p != &PathBuf::from("/tmp/xyz-codex").join("auth.json")));
    }

    #[test]
    fn auth_paths_ignores_blank_codex_home() {
        let _g = lock();
        std::env::set_var("CODEX_HOME", "   ");
        let paths = auth_paths();
        // Blank override contributes no candidate; the default homes remain.
        assert!(paths.iter().all(|p| !p.starts_with("   ")));
        std::env::remove_var("CODEX_HOME");
    }

    #[test]
    fn load_auth_reads_oauth_token() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"tokens":{"access_token":"tok","account_id":"acc"}}"#);
        let auth = load_auth().expect("auth loaded");
        assert_eq!(
            auth.tokens.and_then(|t| t.access_token).as_deref(),
            Some("tok")
        );
        clear_env();
    }

    #[test]
    fn load_auth_reads_api_key_only_login() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"OPENAI_API_KEY":"sk-live"}"#);
        let auth = load_auth().expect("auth loaded");
        assert_eq!(auth.api_key.as_deref(), Some("sk-live"));
        assert!(auth.tokens.is_none());
        clear_env();
    }

    // ── fetch gates (no network) ─────────────────────────────────────────────

    #[tokio::test]
    async fn fetch_unsupported_for_api_key_only_login() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"OPENAI_API_KEY":"sk-live"}"#);
        let snap = fetch("acp:codex").await;
        assert!(!snap.available);
        assert_eq!(snap.engine, "codex");
        assert!(matches!(snap.reason, Some(UsageUnavailable::Unsupported)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_unsupported_when_access_token_empty() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        // has_key keeps load_auth returning this entry; the empty access_token then
        // trips the Unsupported branch inside fetch.
        write_auth(
            dir.path(),
            r#"{"tokens":{"access_token":""},"OPENAI_API_KEY":"sk"}"#,
        );
        let snap = fetch("acp:codex").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::Unsupported)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_token_expired_for_past_jwt() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        let past = chrono::Utc::now().timestamp() - 3600;
        write_auth(
            dir.path(),
            &format!(r#"{{"tokens":{{"access_token":"{}"}}}}"#, jwt_with_exp(past)),
        );
        let snap = fetch("acp:codex").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::TokenExpired)));
        clear_env();
    }

    // ── fetch end-to-end via loopback server ─────────────────────────────────

    #[tokio::test]
    async fn fetch_happy_path_builds_windows_and_plan() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        // A non-JWT opaque token => jwt_exp_unix returns None => no expiry gate =>
        // proceeds to the (loopback) network call. account_id exercises the
        // ChatGPT-Account-Id header branch.
        write_auth(
            dir.path(),
            r#"{"tokens":{"access_token":"opaque-token","account_id":"acc-1"}}"#,
        );
        let url = spawn_loopback(
            "200 OK",
            r#"{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":30.0,"reset_at":1800000000},"secondary_window":{"used_percent":12.0,"reset_after_seconds":3600}}}"#,
        );
        std::env::set_var("RYU_USAGE_CODEX_URL", &url);

        let snap = fetch("acp:codex").await;
        assert!(snap.available, "reason={:?}", snap.reason);
        assert_eq!(snap.engine, "codex");
        assert_eq!(snap.plan.as_deref(), Some("Pro"));
        assert!(snap.extra_usage_usd.is_none());
        assert_eq!(snap.windows.len(), 2);
        assert_eq!(snap.windows[0].label, "Session");
        assert_eq!(snap.windows[0].used_percent, 30.0);
        assert!(snap.windows[0].resets_at.is_some());
        assert_eq!(snap.windows[1].label, "Weekly");
        assert!(snap.windows[1].resets_at.is_some());
        clear_env();
    }

    #[tokio::test]
    async fn fetch_maps_429_to_rate_limited() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"tokens":{"access_token":"opaque"}}"#);
        let url = spawn_loopback("429 Too Many Requests", "{}");
        std::env::set_var("RYU_USAGE_CODEX_URL", &url);
        let snap = fetch("acp:codex").await;
        assert!(matches!(snap.reason, Some(UsageUnavailable::RateLimited)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_bad_json_body_is_error() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"tokens":{"access_token":"opaque"}}"#);
        let url = spawn_loopback("200 OK", "definitely-not-json");
        std::env::set_var("RYU_USAGE_CODEX_URL", &url);
        let snap = fetch("acp:codex").await;
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::Error)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_connection_refused_is_error() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"tokens":{"access_token":"opaque"}}"#);
        // Port 1 on loopback refuses immediately — exercises the reqwest send-error
        // arm without any external network.
        std::env::set_var("RYU_USAGE_CODEX_URL", "http://127.0.0.1:1/usage");
        let snap = fetch("acp:codex").await;
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::Error)));
        clear_env();
    }

    /// Route through the public entry point so the `fetch_usage` engine-dispatch
    /// arm for Codex is exercised.
    #[tokio::test]
    async fn fetch_usage_dispatches_to_codex() {
        let _g = lock();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"OPENAI_API_KEY":"sk-live"}"#);
        let snap = crate::fetch_usage("acp:codex").await;
        assert_eq!(snap.engine, "codex");
        assert!(matches!(snap.reason, Some(UsageUnavailable::Unsupported)));
        clear_env();
    }

    #[tokio::test]
    async fn fetch_not_logged_in_when_no_auth_anywhere() {
        let _g = lock();
        // Override HOME so dirs::home_dir() (used for the ~/.config/codex and
        // ~/.codex default candidates) points at an empty temp dir, and CODEX_HOME
        // at another empty temp dir. With no auth.json on any candidate, load_auth
        // returns None => NotLoggedIn — hermetic despite a real ~/.codex existing on
        // the dev machine.
        let home = tempfile::tempdir().unwrap();
        let codex_home = tempfile::tempdir().unwrap();
        let prev_home = std::env::var_os("HOME");
        std::env::set_var("HOME", home.path());
        std::env::set_var("CODEX_HOME", codex_home.path());

        assert!(load_auth().is_none(), "no auth file anywhere => None");
        let snap = fetch("acp:codex").await;
        assert!(!snap.available);
        assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));

        match prev_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        clear_env();
    }

    #[test]
    fn auth_structs_are_debug_printable() {
        // Exercises the derived Debug impls on the auth structs.
        let parsed: AuthFile = serde_json::from_str(
            r#"{"tokens":{"access_token":"t","account_id":"a"},"OPENAI_API_KEY":"k"}"#,
        )
        .unwrap();
        assert!(!format!("{parsed:?}").is_empty());
    }
}
