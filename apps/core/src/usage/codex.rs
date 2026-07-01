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
    paths.push(crate::codex_config::codex_home().join("auth.json"));
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
        .get(USAGE_URL)
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
        Some(first) => first.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase(),
        None => String::new(),
    }
}
