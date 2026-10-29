//! Codex subscription usage. Reads the OAuth token the `codex` CLI stores in
//! `auth.json` and calls `GET https://chatgpt.com/backend-api/wham/usage` — the
//! same endpoint Codex's own usage view uses — then maps:
//!
//! - `rate_limit.primary_window` / `secondary_window` into the Session (5h) and
//!   Weekly windows. They are classified by each window's own
//!   `limit_window_seconds` rather than by which slot it arrived in: Codex can
//!   temporarily drop one limit and move the remaining *weekly* window into the
//!   `primary_window` slot, which the naive slot mapping would have mislabeled
//!   "Session". The historical slot order stays as the fallback for payloads
//!   that report no recognizable duration.
//! - `additional_rate_limits` → the Spark / Spark Weekly model limits (the
//!   GPT-5.3-Codex-Spark pair), which reuse the same window shape. Accounts
//!   without the limit simply carry no entry.
//! - `rate_limit_reset_credits` → the **banked on-demand rate-limit resets**,
//!   reported as a count. The count alone comes with the usage body; each
//!   credit's *own* expiry date needs the dedicated
//!   `…/wham/rate-limit-reset-credits` endpoint, which we call best-effort and
//!   fall back from to the embedded count.
//! - `credits` → the flex-credit balance, surfaced as both dollars and a credit
//!   count (1 credit = 4¢, the rate the Codex CLI itself prices them at).
//!
//! We deliberately do NOT implement the sibling
//! `…/rate-limit-reset-credits/consume` call that spends a banked reset:
//! claiming one is irreversible, and this crate is read-only by construction.
//!
//! Endpoint + field names were reconstructed from the openusage reference
//! implementation; verify against one live response before trusting blindly.

use std::path::PathBuf;

use serde::Deserialize;

use super::{
    http_client, jwt_exp_unix, read_file, reason_for_status, retry_after_seconds, UsageMeter,
    UsageSnapshot, UsageUnavailable, UsageValue, UsageValueKind,
};

const USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

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

/// The dedicated banked-reset-credits endpoint — the only source that carries a
/// per-credit expiry list. Same `#[cfg(test)]` override seam as [`usage_url`].
#[cfg(not(test))]
fn reset_credits_url() -> String {
    RESET_CREDITS_URL.to_string()
}
#[cfg(test)]
fn reset_credits_url() -> String {
    std::env::var("RYU_USAGE_CODEX_RESETS_URL").unwrap_or_else(|_| RESET_CREDITS_URL.to_string())
}

/// The user's home directory, which holds the `~/.config/codex` and `~/.codex`
/// default homes. Production always asks [`dirs::home_dir`]; the `#[cfg(test)]`
/// variant honours `RYU_USAGE_CODEX_USER_HOME` so tests can point it at an empty
/// directory. Redirecting `HOME` is not enough: on Windows `dirs::home_dir`
/// reads the profile folder from the OS and ignores `HOME`.
#[cfg(not(test))]
fn user_home() -> Option<PathBuf> {
    dirs::home_dir()
}
#[cfg(test)]
fn user_home() -> Option<PathBuf> {
    match std::env::var_os("RYU_USAGE_CODEX_USER_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir(),
    }
}

/// Refresh the access token within this slack of its JWT `exp` (same window the
/// `codex` CLI uses) — so we skip a call that's about to 401.
const EXPIRY_SLACK_SECS: i64 = 5 * 60;
/// The 5-hour rolling window, in seconds — the duration that identifies a
/// `*_window` as the Session meter regardless of which slot it arrived in.
const SESSION_WINDOW_SECS: i64 = 5 * 60 * 60;
/// The 7-day window, in seconds — likewise for the Weekly meter.
const WEEKLY_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;
/// One Codex flex credit is worth 4¢ (the `CREDIT_USD_RATE` the Codex CLI and
/// its plugin price them at), so the balance can read as dollars too.
const CREDIT_USD_RATE: f64 = 0.04;

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
    if let Some(home) = user_home() {
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

/// Adapt one managed Pi OAuth entry to the Codex CLI auth shape consumed by this
/// reader.
fn auth_from_ryu_entry(entry: &serde_json::Value) -> Option<AuthFile> {
    let access_token = entry
        .get("access")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            entry
                .get("access_token")
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|token| !token.is_empty())?
        .to_string();
    let account_id = entry
        .get("account_id")
        .or_else(|| entry.get("accountId"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    Some(AuthFile {
        tokens: Some(Tokens {
            access_token: Some(access_token),
            account_id,
        }),
        api_key: None,
    })
}

/// Read the managed Pi OAuth entry for Ryu's ChatGPT subscription provider and
/// adapt it to the Codex CLI auth shape consumed by this reader.
fn auth_from_ryu_json(root: &serde_json::Value) -> Option<AuthFile> {
    auth_from_ryu_entry(root.get("openai-codex")?)
}

fn load_ryu_auth() -> Option<AuthFile> {
    let path = super::host()?.ryu_pi_auth_path()?;
    let text = read_file(&path)?;
    let root = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    auth_from_ryu_json(&root)
}

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    fetch_from_auth(agent_id, load_auth()).await
}

pub(super) async fn fetch_ryu(agent_id: &str) -> UsageSnapshot {
    fetch_from_auth(agent_id, load_ryu_auth()).await
}

pub(super) async fn fetch_ryu_with_credential(
    agent_id: &str,
    credential: Option<serde_json::Value>,
) -> UsageSnapshot {
    fetch_from_auth(agent_id, credential.as_ref().and_then(auth_from_ryu_entry)).await
}

async fn fetch_from_auth(agent_id: &str, auth: Option<AuthFile>) -> UsageSnapshot {
    let unavailable =
        |reason: UsageUnavailable| UsageSnapshot::unavailable(agent_id, "codex", reason);

    let Some(auth) = auth else {
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

    let token = access_token.trim();
    let account_id = tokens.account_id.as_deref().filter(|a| !a.is_empty());

    let resp = match get(&usage_url(), token, account_id, false).await {
        Ok(r) => r,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    if !resp.status().is_success() {
        let reason = reason_for_status(resp.status());
        let retry_after = retry_after_seconds(resp.headers());
        let mut snapshot = unavailable(reason);
        snapshot.retry_after_seconds = retry_after;
        return snapshot;
    }
    // Percentages can also ride in response headers, so read them off before the
    // body is consumed — they fill a window whose own `used_percent` is absent.
    let header_percents = (
        header_number(resp.headers(), "x-codex-primary-used-percent"),
        header_number(resp.headers(), "x-codex-secondary-used-percent"),
    );
    let header_credits = header_number(resp.headers(), "x-codex-credits-balance");
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return unavailable(UsageUnavailable::Error);
    };

    // The dedicated banked-reset endpoint is the ONLY source of each credit's own
    // expiry date, but it is strictly best-effort: a failure here must never cost
    // us the windows we already have, so we fall back to the count embedded in
    // the usage body (which carries no expiries).
    let reset_credits_body = match get(&reset_credits_url(), token, account_id, true).await {
        Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
        _ => None,
    };

    let now = chrono::Utc::now();
    let mut snapshot = UsageSnapshot::available(
        agent_id,
        "codex",
        body.get("plan_type").and_then(format_plan),
    );

    snapshot.windows = classified_windows(
        body.get("rate_limit"),
        ("Session", "Weekly"),
        header_percents,
        now,
    );
    // The Spark model limits (GPT-5.3-Codex-Spark) reuse the same window shape
    // inside `additional_rate_limits`, so they classify identically.
    snapshot
        .windows
        .extend(spark_windows(body.get("additional_rate_limits"), now));

    if let Some(resets) = reset_credits(&body, reset_credits_body.as_ref()) {
        snapshot.meters.push(
            UsageMeter::new(
                "Rate limit resets",
                vec![UsageValue::new(
                    resets.count,
                    UsageValueKind::Count,
                    Some("available"),
                )],
            )
            .with_expiries(resets.expiries),
        );
    }
    if let Some(balance) = credits_balance(&body, header_credits) {
        snapshot
            .meters
            .push(UsageMeter::new("Credits", credit_values(balance)));
    }

    snapshot
}

/// One GET against a Codex backend endpoint. `codex_client_headers` adds the two
/// headers the reset-credits endpoint expects from the Codex desktop client (the
/// plain usage endpoint doesn't need them).
async fn get(
    url: &str,
    access_token: &str,
    account_id: Option<&str>,
    codex_client_headers: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut req = http_client()
        .get(url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/json")
        .header("User-Agent", "Ryu");
    if codex_client_headers {
        req = req
            .header("OpenAI-Beta", "codex-1")
            .header("originator", "Codex Desktop");
    }
    if let Some(account_id) = account_id {
        req = req.header("ChatGPT-Account-Id", account_id);
    }
    req.send().await
}

/// A numeric response header, or `None` when absent/unparseable.
fn header_number(headers: &reqwest::header::HeaderMap, name: &str) -> Option<f64> {
    headers
        .get(name)?
        .to_str()
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
}

mod windows;

use windows::{
    classified_windows, credit_values, credits_balance, format_plan, reset_credits, spark_windows,
};

#[cfg(test)]
mod tests;
