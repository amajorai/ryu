//! Claude Code subscription usage. Reads `~/.claude/.credentials.json` (the
//! OAuth credential the `claude` CLI stores) and calls
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

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    let unavailable =
        |reason: UsageUnavailable| UsageSnapshot::unavailable(agent_id, "claude", reason);

    let Some(text) = read_file(&credentials_path()) else {
        return unavailable(UsageUnavailable::NotLoggedIn);
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
        .get(USAGE_URL)
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
            .find(|seg| seg.ends_with('x') && seg[..seg.len() - 1].chars().all(|c| c.is_ascii_digit()))
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
                Some(first) => first.to_ascii_uppercase().to_string() + &chars.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
