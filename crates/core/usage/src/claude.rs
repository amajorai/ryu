//! Claude Code subscription usage. Reads the OAuth credential the `claude` CLI
//! stores — `~/.claude/.credentials.json` on Windows/Linux, or the login
//! Keychain (generic password, service `Claude Code-credentials`) on macOS,
//! where the CLI keeps the same JSON blob instead of an on-disk file — and calls
//! `GET https://api.anthropic.com/api/oauth/usage` — the same endpoint Claude
//! Code's own `/usage` uses — then maps `five_hour` / `seven_day` /
//! `extra_usage` and the model-scoped `limits[]` windows into normalized meters.
//!
//! Anthropic moved the per-model weekly windows off the legacy top-level
//! `seven_day_<model>` keys (which now come back null) and into a `limits` array
//! whose `kind: "weekly_scoped"` entries name their model in
//! `scope.model.display_name`. So the array is the primary path — which makes the
//! per-model labels *data* ("Sonnet", "Opus", "Fable", whatever ships next)
//! rather than a closed set baked into this file — and the legacy
//! `seven_day_sonnet` key stays as a fallback for accounts still served the old
//! shape.
//!
//! The endpoint shape + required `anthropic-beta: oauth-2025-04-20` header were
//! reconstructed from the openusage reference implementation; verify against one
//! live response before trusting blindly (the contract can drift).

use std::path::PathBuf;

use serde::Deserialize;

use super::{
    clamp_percent, read_file, reason_for_status, retry_after_seconds, vendor_http_client,
    UsageMeter, UsageSnapshot, UsageUnavailable, UsageValue, UsageValueKind, UsageWindow,
};

/// The 5-hour session window, in seconds — reported to the client so it can label
/// the meter from the data rather than from the English label.
const SESSION_WINDOW_SECS: i64 = 5 * 60 * 60;
/// The 7-day window, in seconds.
const WEEKLY_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

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

/// Translate one Pi OAuth entry into the Claude CLI credential shape the rest of
/// this reader already understands. Pi stores expiry in unix seconds; Claude's
/// usage credential uses epoch milliseconds.
fn ryu_credentials_from_entry(entry: &serde_json::Value) -> Option<String> {
    let access = entry
        .get("access")
        .and_then(serde_json::Value::as_str)
        .or_else(|| entry.get("accessToken").and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|token| !token.is_empty())?;
    let expiry = ["expires_at", "expires", "expiresAt"]
        .iter()
        .find_map(|key| entry.get(*key).and_then(serde_json::Value::as_f64))
        .map(|value| {
            if value < 100_000_000_000.0 {
                value * 1000.0
            } else {
                value
            }
        });
    let oauth = serde_json::json!({
        "accessToken": access,
        "expiresAt": expiry,
        "subscriptionType": entry.get("subscriptionType").cloned(),
        "rateLimitTier": entry.get("rateLimitTier").cloned(),
        "scopes": entry.get("scopes").cloned(),
    });
    Some(serde_json::json!({ "claudeAiOauth": oauth }).to_string())
}

/// Translate the managed Pi auth file's Claude entry into the CLI shape.
fn ryu_credentials_from_auth(root: &serde_json::Value) -> Option<String> {
    ryu_credentials_from_entry(root.get("anthropic")?)
}

/// Read the managed Pi auth entry for the Ryu Claude subscription provider.
fn read_ryu_credentials() -> Option<String> {
    let path = super::host()?.ryu_pi_auth_path()?;
    let text = read_file(&path)?;
    let root = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    ryu_credentials_from_auth(&root)
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
    fetch_from_credentials(agent_id, read_credentials).await
}

pub(super) async fn fetch_ryu(agent_id: &str) -> UsageSnapshot {
    fetch_from_credentials(agent_id, read_ryu_credentials).await
}

pub(super) async fn fetch_ryu_with_credential(
    agent_id: &str,
    credential: Option<serde_json::Value>,
) -> UsageSnapshot {
    fetch_from_text(
        agent_id,
        credential.as_ref().and_then(ryu_credentials_from_entry),
    )
    .await
}

async fn fetch_from_credentials(agent_id: &str, reader: fn() -> Option<String>) -> UsageSnapshot {
    let text = match tokio::task::spawn_blocking(reader).await {
        Ok(text) => text,
        Err(_) => return UsageSnapshot::unavailable(agent_id, "claude", UsageUnavailable::Error),
    };
    fetch_from_text(agent_id, text).await
}

async fn fetch_from_text(agent_id: &str, text: Option<String>) -> UsageSnapshot {
    let unavailable =
        |reason: UsageUnavailable| UsageSnapshot::unavailable(agent_id, "claude", reason);

    let text = match text {
        Some(text) => text,
        None => return unavailable(UsageUnavailable::NotLoggedIn),
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

    let Ok(client) = vendor_http_client("claude") else {
        return unavailable(UsageUnavailable::Error);
    };
    let resp = client
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
        let reason = reason_for_status(resp.status());
        let retry_after = retry_after_seconds(resp.headers());
        let mut snapshot = unavailable(reason);
        snapshot.retry_after_seconds = retry_after;
        return snapshot;
    }
    let Ok(body) = resp.json::<serde_json::Value>().await else {
        return unavailable(UsageUnavailable::Error);
    };

    let mut snapshot = UsageSnapshot::available(agent_id, "claude", plan);

    if let Some(w) = window(&body, "five_hour", "Session", SESSION_WINDOW_SECS) {
        snapshot.windows.push(w);
    }
    if let Some(w) = window(&body, "seven_day", "Weekly", WEEKLY_WINDOW_SECS) {
        snapshot.windows.push(w);
    }
    // Per-model weekly windows: the `limits[]` array is where Anthropic reports
    // them now, so it wins; the legacy `seven_day_sonnet` key is only consulted
    // when the array yielded nothing (an account still on the old shape).
    let scoped = scoped_weekly_windows(&body);
    if scoped.is_empty() {
        if let Some(w) = window(&body, "seven_day_sonnet", "Sonnet", WEEKLY_WINDOW_SECS) {
            snapshot.windows.push(w);
        }
    } else {
        snapshot.windows.extend(scoped);
    }

    snapshot.extra_usage_usd = extra_usage_usd(&body);
    if let Some(meter) = extra_usage_meter(&body) {
        snapshot.meters.push(meter);
    }

    snapshot
}

/// Map one `{ utilization, resets_at }` object into a normalized window.
/// `utilization` is already a 0–100 percent.
fn window(
    body: &serde_json::Value,
    key: &str,
    label: &str,
    window_seconds: i64,
) -> Option<UsageWindow> {
    let obj = body.get(key)?;
    let used_percent = obj.get("utilization").and_then(serde_json::Value::as_f64)?;
    Some(UsageWindow {
        label: label.to_string(),
        used_percent: clamp_percent(used_percent),
        resets_at: resets_at(obj),
        window_seconds: Some(window_seconds),
        model: None,
    })
}

/// A window object's `resets_at`, when it carries a non-empty one.
fn resets_at(obj: &serde_json::Value) -> Option<String> {
    obj.get("resets_at")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The model-scoped weekly windows from the `limits` array: every entry with
/// `kind: "weekly_scoped"` becomes its own meter labelled with the model's
/// `scope.model.display_name` ("Sonnet", "Opus", "Fable", …), so a model
/// Anthropic adds later shows up without a code change. `percent` is 0–100.
///
/// An entry missing its display name or percent is skipped rather than dropping
/// its valid siblings.
fn scoped_weekly_windows(body: &serde_json::Value) -> Vec<UsageWindow> {
    let Some(limits) = body.get("limits").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    limits
        .iter()
        .filter(|entry| {
            entry.get("kind").and_then(serde_json::Value::as_str) == Some("weekly_scoped")
        })
        .filter_map(|entry| {
            let label = entry
                .get("scope")
                .and_then(|scope| scope.get("model"))
                .and_then(|model| model.get("display_name"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())?;
            let used_percent = entry.get("percent").and_then(serde_json::Value::as_f64)?;
            Some(UsageWindow {
                label: label.to_string(),
                used_percent: clamp_percent(used_percent),
                resets_at: resets_at(entry),
                window_seconds: Some(WEEKLY_WINDOW_SECS),
                // The display name IS the model, so a client can hang this quota
                // off the right model row without guessing from the label.
                model: Some(label.to_string()),
            })
        })
        .collect()
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

/// The extra-usage row: dollars spent this month and, when the plan carries a
/// `monthly_limit`, the cap they run against — so the client can show "$3 of $25"
/// instead of a bare number. Both figures are cents upstream.
fn extra_usage_meter(body: &serde_json::Value) -> Option<UsageMeter> {
    let used = extra_usage_usd(body)?;
    let mut values = vec![UsageValue::new(
        used,
        UsageValueKind::Dollars,
        Some("spent"),
    )];
    if let Some(limit) = body
        .get("extra_usage")
        .and_then(|obj| obj.get("monthly_limit"))
        .and_then(serde_json::Value::as_f64)
        .filter(|cents| cents.is_finite() && *cents > 0.0)
    {
        values.push(UsageValue::new(
            limit / 100.0,
            UsageValueKind::Dollars,
            Some("cap"),
        ));
    }
    Some(UsageMeter::new("Extra usage", values))
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

/// Lowercase-then-capitalize each whitespace/underscore-separated word. Thin
/// wrapper over the crate-shared helper so every vendor's plan label is cased the
/// same way.
fn title_case(s: &str) -> String {
    super::title_case(s, &[' ', '\t', '\n', '_'])
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
        assert_eq!(format_plan(Some("pro"), Some("ax")).as_deref(), Some("Pro"));
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
        let w = window(&body, "five_hour", "Session", SESSION_WINDOW_SECS).unwrap();
        assert_eq!(w.label, "Session");
        assert_eq!(w.used_percent, 42.5);
        assert_eq!(w.resets_at.as_deref(), Some("2026-07-23T05:00:00Z"));
        assert_eq!(w.window_seconds, Some(SESSION_WINDOW_SECS));
        // The account-wide windows are NOT model-scoped.
        assert!(w.model.is_none());
    }

    #[test]
    fn window_empty_resets_at_is_dropped() {
        let body = serde_json::json!({ "k": { "utilization": 3.0, "resets_at": "" } });
        let w = window(&body, "k", "L", WEEKLY_WINDOW_SECS).unwrap();
        assert!(w.resets_at.is_none());
    }

    #[test]
    fn window_none_without_utilization() {
        let body = serde_json::json!({ "k": { "resets_at": "x" } });
        assert!(window(&body, "k", "L", WEEKLY_WINDOW_SECS).is_none());
        // Missing key entirely.
        assert!(window(&body, "absent", "L", WEEKLY_WINDOW_SECS).is_none());
    }

    // ── model-scoped weekly limits (the `limits[]` array) ────────────────────

    #[test]
    fn scoped_weekly_windows_label_from_the_model_display_name() {
        let body = serde_json::json!({ "limits": [
            { "kind": "weekly_scoped", "percent": 12.0, "resets_at": "2026-08-01T00:00:00Z",
              "scope": { "model": { "display_name": "Sonnet" } } },
            { "kind": "weekly_scoped", "percent": 88.0,
              "scope": { "model": { "display_name": "Opus" } } },
            // A non-scoped entry, and a scoped one missing its percent: skipped
            // without discarding the valid siblings.
            { "kind": "five_hour", "percent": 5.0, "scope": { "model": { "display_name": "X" } } },
            { "kind": "weekly_scoped", "scope": { "model": { "display_name": "Fable" } } }
        ]});
        let windows = scoped_weekly_windows(&body);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "Sonnet");
        assert_eq!(windows[0].used_percent, 12.0);
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some("2026-08-01T00:00:00Z")
        );
        assert_eq!(windows[0].window_seconds, Some(WEEKLY_WINDOW_SECS));
        // Scoped windows name their model so a client can attach the quota to the
        // right model row instead of inferring it from the label.
        assert_eq!(windows[0].model.as_deref(), Some("Sonnet"));
        // A model Anthropic adds later needs no code change here.
        assert_eq!(windows[1].label, "Opus");
        assert_eq!(windows[1].used_percent, 88.0);
    }

    #[test]
    fn scoped_weekly_windows_empty_without_a_usable_array() {
        assert!(scoped_weekly_windows(&serde_json::json!({})).is_empty());
        assert!(scoped_weekly_windows(&serde_json::json!({ "limits": {} })).is_empty());
        // Scoped entry with a blank display name → nothing to label it with.
        let blank = serde_json::json!({ "limits": [
            { "kind": "weekly_scoped", "percent": 1.0, "scope": { "model": { "display_name": " " } } }
        ]});
        assert!(scoped_weekly_windows(&blank).is_empty());
    }

    #[test]
    fn extra_usage_meter_carries_the_monthly_cap_when_there_is_one() {
        let capped = serde_json::json!({
            "extra_usage": { "is_enabled": true, "used_credits": 250, "monthly_limit": 2500 }
        });
        let meter = extra_usage_meter(&capped).expect("meter");
        assert_eq!(meter.label, "Extra usage");
        assert_eq!(meter.values.len(), 2);
        assert_eq!(meter.values[0].number, 2.5);
        assert_eq!(meter.values[0].unit.as_deref(), Some("spent"));
        assert_eq!(meter.values[1].number, 25.0);
        assert_eq!(meter.values[1].unit.as_deref(), Some("cap"));

        // Uncapped: spend alone, no fabricated denominator.
        let uncapped = serde_json::json!({
            "extra_usage": { "is_enabled": true, "used_credits": 250, "monthly_limit": 0 }
        });
        assert_eq!(extra_usage_meter(&uncapped).unwrap().values.len(), 1);
        // Disabled extra usage has no row at all.
        let disabled = serde_json::json!({ "extra_usage": { "is_enabled": false } });
        assert!(extra_usage_meter(&disabled).is_none());
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
        let no_credits = serde_json::json!({ "extra_usage": { "is_enabled": true } });
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
        // The legacy `seven_day_sonnet` fallback: this fixture carries no
        // `limits[]` array, so the old key is what supplies the Sonnet meter.
        assert_eq!(snap.windows[2].label, "Sonnet");
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

    #[test]
    fn ryu_auth_entry_maps_to_claude_credentials() {
        let root = serde_json::json!({
            "anthropic": {
                "type": "oauth",
                "access": "pi-access",
                "refresh": "pi-refresh",
                "expires_at": 1_800_000_000_u64,
            }
        });
        let text = ryu_credentials_from_auth(&root).expect("oauth entry");
        let parsed: CredentialsFile = serde_json::from_str(&text).expect("claude shape");
        let oauth = parsed.oauth.expect("oauth payload");
        assert_eq!(oauth.access_token.as_deref(), Some("pi-access"));
        assert_eq!(oauth.expires_at, Some(1_800_000_000_000.0));
    }
}
