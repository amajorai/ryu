//! Codex auth resolution and `fetch` (gates + loopback end-to-end). Shares the
//! parent module's `ENV_LOCK` so these never race its env-touching tests.

use super::*;

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
    write_auth(
        dir.path(),
        r#"{"tokens":{"access_token":"tok","account_id":"acc"}}"#,
    );
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
        &format!(
            r#"{{"tokens":{{"access_token":"{}"}}}}"#,
            jwt_with_exp(past)
        ),
    );
    let snap = fetch("acp:codex").await;
    assert!(matches!(snap.reason, Some(UsageUnavailable::TokenExpired)));
    clear_env();
}

// ── fetch end-to-end via loopback server ─────────────────────────────────

#[tokio::test]
async fn fetch_happy_path_builds_windows_meters_and_plan() {
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
        r#"{"plan_type":"prolite","rate_limit":{"primary_window":{"used_percent":30.0,"reset_at":1800000000,"limit_window_seconds":18000},"secondary_window":{"used_percent":12.0,"reset_after_seconds":3600,"limit_window_seconds":604800}},"credits":{"balance":821.7},"rate_limit_reset_credits":{"available_count":1}}"#,
    );
    std::env::set_var("RYU_USAGE_CODEX_URL", &url);
    let resets = spawn_loopback(
        "200 OK",
        r#"{"available_count":2,"credits":[{"status":"available","expires_at":"2026-08-02T17:30:00Z"},{"status":"available","expires_at":"2026-07-31T09:00:00Z"}]}"#,
    );
    std::env::set_var("RYU_USAGE_CODEX_RESETS_URL", &resets);

    let snap = fetch("acp:codex").await;
    assert!(snap.available, "reason={:?}", snap.reason);
    assert_eq!(snap.engine, "codex");
    assert_eq!(snap.plan.as_deref(), Some("Pro 5x"));
    assert_eq!(snap.windows.len(), 2);
    assert_eq!(snap.windows[0].label, "Session");
    assert_eq!(snap.windows[0].used_percent, 30.0);
    assert_eq!(snap.windows[0].window_seconds, Some(SESSION_WINDOW_SECS));
    assert!(snap.windows[0].resets_at.is_some());
    assert_eq!(snap.windows[1].label, "Weekly");
    assert!(snap.windows[1].resets_at.is_some());

    // The dedicated endpoint's count + per-credit expiries win over the
    // embedded count of 1.
    let banked = snap
        .meters
        .iter()
        .find(|m| m.label == "Rate limit resets")
        .expect("banked resets meter");
    assert_eq!(banked.values[0].number, 2.0);
    assert_eq!(banked.expires_at.len(), 2);
    assert!(banked.expires_at[0].starts_with("2026-07-31"));

    let credits = snap
        .meters
        .iter()
        .find(|m| m.label == "Credits")
        .expect("credits meter");
    assert_eq!(credits.values[1].number, 821.0);
    clear_env();
}

#[tokio::test]
async fn fetch_falls_back_to_embedded_reset_count_when_dedicated_call_fails() {
    let _g = lock();
    let dir = tempfile::tempdir().unwrap();
    write_auth(dir.path(), r#"{"tokens":{"access_token":"opaque"}}"#);
    let url = spawn_loopback(
        "200 OK",
        r#"{"rate_limit":{"primary_window":{"used_percent":10.0}},"rate_limit_reset_credits":{"available_count":3}}"#,
    );
    std::env::set_var("RYU_USAGE_CODEX_URL", &url);
    disable_reset_endpoint();

    let snap = fetch("acp:codex").await;
    assert!(snap.available, "reason={:?}", snap.reason);
    let banked = snap
        .meters
        .iter()
        .find(|m| m.label == "Rate limit resets")
        .expect("banked resets meter");
    assert_eq!(banked.values[0].number, 3.0);
    // No dedicated payload → no per-credit expiries to show.
    assert!(banked.expires_at.is_empty());
    clear_env();
}

#[tokio::test]
async fn fetch_reads_percent_and_credits_from_headers() {
    let _g = lock();
    let dir = tempfile::tempdir().unwrap();
    write_auth(dir.path(), r#"{"tokens":{"access_token":"opaque"}}"#);
    let url = spawn_loopback_with_headers(
        "200 OK",
        "x-codex-primary-used-percent: 77\r\nx-codex-credits-balance: 50\r\n",
        r#"{"rate_limit":{"primary_window":{"reset_at":1800000000}}}"#,
    );
    std::env::set_var("RYU_USAGE_CODEX_URL", &url);
    disable_reset_endpoint();

    let snap = fetch("acp:codex").await;
    assert!(snap.available, "reason={:?}", snap.reason);
    assert_eq!(snap.windows[0].used_percent, 77.0);
    let credits = snap
        .meters
        .iter()
        .find(|m| m.label == "Credits")
        .expect("credits meter");
    assert_eq!(credits.values[1].number, 50.0);
    clear_env();
}

#[tokio::test]
async fn fetch_maps_429_to_rate_limited_with_retry_after() {
    let _g = lock();
    let dir = tempfile::tempdir().unwrap();
    write_auth(dir.path(), r#"{"tokens":{"access_token":"opaque"}}"#);
    let url = spawn_loopback_with_headers("429 Too Many Requests", "Retry-After: 120\r\n", "{}");
    std::env::set_var("RYU_USAGE_CODEX_URL", &url);
    let snap = fetch("acp:codex").await;
    assert!(matches!(snap.reason, Some(UsageUnavailable::RateLimited)));
    assert_eq!(snap.retry_after_seconds, Some(120));
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
    // Point the user home (the `~/.config/codex` and `~/.codex` default
    // candidates) at an empty temp dir through the codex-only test seam, and
    // CODEX_HOME at another. With no auth.json on any candidate, load_auth
    // returns None => NotLoggedIn, even when the dev machine has a real ~/.codex.
    // Redirecting HOME would not do it: on Windows `dirs::home_dir` ignores HOME.
    let home = tempfile::tempdir().unwrap();
    let codex_home = tempfile::tempdir().unwrap();
    std::env::set_var("RYU_USAGE_CODEX_USER_HOME", home.path());
    std::env::set_var("CODEX_HOME", codex_home.path());

    let paths = auth_paths();
    assert!(paths.contains(&home.path().join(".codex").join("auth.json")));
    assert!(paths.contains(&home.path().join(".config").join("codex").join("auth.json")));
    assert!(load_auth().is_none(), "no auth file anywhere => None");
    let snap = fetch("acp:codex").await;
    assert!(!snap.available);
    assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));

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

#[test]
fn ryu_auth_entry_maps_to_codex_tokens() {
    let root = serde_json::json!({
        "openai-codex": {
            "type": "oauth",
            "access": "pi-access",
            "account_id": "account-1",
        }
    });
    let auth = auth_from_ryu_json(&root).expect("oauth entry");
    let tokens = auth.tokens.expect("oauth tokens");
    assert_eq!(tokens.access_token.as_deref(), Some("pi-access"));
    assert_eq!(tokens.account_id.as_deref(), Some("account-1"));
    assert!(auth.api_key.is_none());
}
