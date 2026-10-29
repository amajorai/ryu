//! Devin subscription usage, using the API key already stored by Devin CLI.
//!
//! Devin exposes quota fields through its Connect JSON `GetUserStatus` RPC.
//! Ryu sends the key only to Devin's fixed HTTPS endpoint and never refreshes
//! or writes it back to the CLI credential file.

use std::path::PathBuf;

use serde_json::Value;

use super::{
    credential_http_client, read_file_limited, read_json_limited, reason_for_status,
    retry_after_seconds, UsageMeter, UsageSnapshot, UsageUnavailable, UsageValue, UsageValueKind,
    UsageWindow,
};

const USAGE_URL: &str =
    "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const IDE_VERSION: &str = "1.108.2";
const DAY_SECONDS: i64 = 24 * 60 * 60;
const WEEK_SECONDS: i64 = 7 * DAY_SECONDS;
const MAX_CREDENTIAL_BYTES: u64 = 64 * 1024;

#[cfg(not(test))]
fn usage_url() -> String {
    USAGE_URL.to_owned()
}

#[cfg(test)]
fn usage_url() -> String {
    std::env::var("RYU_USAGE_DEVIN_URL").unwrap_or_else(|_| USAGE_URL.to_owned())
}

fn credential_paths() -> Vec<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = std::env::var_os("RYU_USAGE_DEVIN_DIR") {
        let dir = PathBuf::from(dir);
        if !dir.as_os_str().is_empty() {
            return vec![dir.join("credentials.toml")];
        }
    }

    let mut paths = Vec::new();
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        let data_home = PathBuf::from(data_home);
        if !data_home.as_os_str().is_empty() {
            paths.push(data_home.join("devin/credentials.toml"));
        }
    }
    if cfg!(windows) {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let local_app_data = PathBuf::from(local_app_data);
            if !local_app_data.as_os_str().is_empty() {
                paths.push(local_app_data.join("Devin/credentials.toml"));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/share/devin/credentials.toml"));
    }
    paths
}

fn load_api_key() -> Option<String> {
    for path in credential_paths() {
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_BYTES {
            continue;
        }
        let Some(text) = read_file_limited(&path, MAX_CREDENTIAL_BYTES) else {
            continue;
        };
        let Ok(credentials) = toml::from_str::<toml::Value>(&text) else {
            continue;
        };
        let Some(api_key) = credentials
            .get("windsurf_api_key")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        return Some(api_key.to_owned());
    }
    None
}

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    let unavailable = |reason| UsageSnapshot::unavailable(agent_id, "devin", reason);
    let Some(api_key) = load_api_key() else {
        return unavailable(UsageUnavailable::NotLoggedIn);
    };

    let request_body = serde_json::json!({
        "metadata": {
            "apiKey": api_key,
            "ideName": "devin",
            "ideVersion": IDE_VERSION,
            "extensionName": "devin",
            "extensionVersion": IDE_VERSION,
            "locale": "en"
        }
    });
    let client = match credential_http_client() {
        Ok(client) => client,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    let response = match client
        .post(usage_url())
        .header("Connect-Protocol-Version", "1")
        .header("Accept", "application/json")
        .json(&request_body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    if !response.status().is_success() {
        let reason = reason_for_status(response.status());
        let retry_after = retry_after_seconds(response.headers());
        let mut snapshot = unavailable(reason);
        snapshot.retry_after_seconds = retry_after;
        return snapshot;
    }

    let body = match read_json_limited(response).await {
        Ok(body) => body,
        Err(()) => return unavailable(UsageUnavailable::Error),
    };
    match map_response(agent_id, &body) {
        Ok(snapshot) => snapshot,
        Err(reason) => unavailable(reason),
    }
}

fn map_response(agent_id: &str, body: &Value) -> Result<UsageSnapshot, UsageUnavailable> {
    let user_status = body
        .get("userStatus")
        .and_then(Value::as_object)
        .ok_or(UsageUnavailable::Error)?;
    let plan_status = user_status
        .get("planStatus")
        .and_then(Value::as_object)
        .ok_or(UsageUnavailable::Error)?;
    let plan_info = plan_status.get("planInfo").and_then(Value::as_object);

    let hide_daily = match plan_info.and_then(|info| info.get("hideDailyQuota")) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(UsageUnavailable::Error),
    };
    let daily_remaining = optional_number(plan_status.get("dailyQuotaRemainingPercent"))?;
    let weekly_remaining = optional_number(plan_status.get("weeklyQuotaRemainingPercent"))?;
    let extra_balance_micros = optional_number(plan_status.get("overageBalanceMicros"))?;

    let mut snapshot = UsageSnapshot::available(
        agent_id,
        "devin",
        plan_info
            .and_then(|info| info.get("planName"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
    );

    if !hide_daily {
        if let Some(remaining) = daily_remaining {
            snapshot.windows.push(UsageWindow {
                label: "Daily quota".to_owned(),
                used_percent: super::clamp_percent(100.0 - remaining),
                resets_at: optional_epoch_seconds(plan_status.get("dailyQuotaResetAtUnix"))?,
                window_seconds: Some(DAY_SECONDS),
                model: None,
            });
        }
    }
    let weekly_reset = optional_epoch_seconds(plan_status.get("weeklyQuotaResetAtUnix"))?;
    if let Some(remaining) = weekly_remaining {
        snapshot.windows.push(UsageWindow {
            label: "Weekly quota".to_owned(),
            used_percent: super::clamp_percent(100.0 - remaining),
            resets_at: weekly_reset,
            window_seconds: Some(WEEK_SECONDS),
            model: None,
        });
    } else if weekly_reset.is_some() {
        snapshot.windows.push(UsageWindow {
            label: "Weekly quota".to_owned(),
            used_percent: 100.0,
            resets_at: weekly_reset,
            window_seconds: Some(WEEK_SECONDS),
            model: None,
        });
    } else if let Some(remaining) = daily_remaining {
        snapshot.windows.push(UsageWindow {
            label: "Weekly quota".to_owned(),
            used_percent: super::clamp_percent(100.0 - remaining),
            resets_at: None,
            window_seconds: Some(WEEK_SECONDS),
            model: None,
        });
    }

    if let Some(micros) = extra_balance_micros {
        snapshot.meters.push(UsageMeter::new(
            "Extra usage balance",
            vec![UsageValue::new(
                (micros / 1_000_000.0).max(0.0),
                UsageValueKind::Dollars,
                None,
            )],
        ));
    }

    if snapshot.windows.is_empty() && snapshot.meters.is_empty() {
        return Err(UsageUnavailable::NoPlan);
    }
    Ok(snapshot)
}

fn optional_number(value: Option<&Value>) -> Result<Option<f64>, UsageUnavailable> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or(UsageUnavailable::Error),
        Some(Value::String(text)) => text
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(Some)
            .ok_or(UsageUnavailable::Error),
        Some(_) => Err(UsageUnavailable::Error),
    }
}

fn optional_epoch_seconds(value: Option<&Value>) -> Result<Option<String>, UsageUnavailable> {
    let Some(seconds) = optional_number(value)? else {
        return Ok(None);
    };
    if seconds < i64::MIN as f64 || seconds > i64::MAX as f64 {
        return Err(UsageUnavailable::Error);
    }
    chrono::DateTime::from_timestamp(seconds.trunc() as i64, 0)
        .map(|timestamp| Some(timestamp.to_rfc3339()))
        .ok_or(UsageUnavailable::Error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{spawn_loopback, spawn_loopback_with_headers};

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn clear_env() {
        std::env::remove_var("RYU_USAGE_DEVIN_DIR");
        std::env::remove_var("RYU_USAGE_DEVIN_URL");
    }

    fn write_credentials(dir: &std::path::Path, body: &str) {
        std::fs::write(dir.join("credentials.toml"), body).unwrap();
        std::env::set_var("RYU_USAGE_DEVIN_DIR", dir);
    }

    #[tokio::test]
    async fn fetches_daily_weekly_and_extra_balance_without_exposing_key() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        clear_env();
        let dir = tempfile::tempdir().unwrap();
        write_credentials(dir.path(), "windsurf_api_key = \"devin-secret-fixture\"\n");
        std::env::set_var(
            "RYU_USAGE_DEVIN_URL",
            spawn_loopback(
                "200 OK",
                r#"{"userStatus":{"planStatus":{"planInfo":{"planName":"Max"},"dailyQuotaRemainingPercent":72,"weeklyQuotaRemainingPercent":"48","dailyQuotaResetAtUnix":"1790150400","weeklyQuotaResetAtUnix":1790550000,"overageBalanceMicros":"12500000"}}}"#,
            ),
        );

        let snapshot = fetch("acp:devin").await;

        assert!(snapshot.available);
        assert_eq!(snapshot.plan.as_deref(), Some("Max"));
        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].label, "Daily quota");
        assert_eq!(snapshot.windows[0].used_percent, 28.0);
        assert_eq!(snapshot.windows[1].label, "Weekly quota");
        assert_eq!(snapshot.windows[1].used_percent, 52.0);
        assert_eq!(snapshot.meters[0].label, "Extra usage balance");
        assert_eq!(snapshot.meters[0].values[0].number, 12.5);
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("devin-secret-fixture"));
        clear_env();
    }

    #[tokio::test]
    async fn uses_daily_quota_as_weekly_when_provider_hides_daily_quota() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        clear_env();
        let dir = tempfile::tempdir().unwrap();
        write_credentials(dir.path(), "windsurf_api_key = \"fixture-key\"\n");
        std::env::set_var(
            "RYU_USAGE_DEVIN_URL",
            spawn_loopback(
                "200 OK",
                r#"{"userStatus":{"planStatus":{"planInfo":{"hideDailyQuota":true},"dailyQuotaRemainingPercent":25}}}"#,
            ),
        );

        let snapshot = fetch("acp:devin").await;

        assert!(snapshot.available);
        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.windows[0].label, "Weekly quota");
        assert_eq!(snapshot.windows[0].used_percent, 75.0);
        clear_env();
    }

    #[test]
    fn missing_weekly_percent_with_a_reset_means_weekly_quota_is_exhausted() {
        let body = serde_json::json!({
            "userStatus": {
                "planStatus": {
                    "planInfo": {"planName": "Max"},
                    "weeklyQuotaResetAtUnix": 1790550000
                }
            }
        });

        let snapshot = map_response("acp:devin", &body).unwrap();

        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.windows[0].label, "Weekly quota");
        assert_eq!(snapshot.windows[0].used_percent, 100.0);
        assert!(snapshot.windows[0].resets_at.is_some());
    }

    #[test]
    fn missing_weekly_percent_and_reset_reuses_daily_quota_for_weekly() {
        let body = serde_json::json!({
            "userStatus": {
                "planStatus": {
                    "planInfo": {"planName": "Max"},
                    "dailyQuotaRemainingPercent": 25
                }
            }
        });

        let snapshot = map_response("acp:devin", &body).unwrap();

        assert_eq!(snapshot.windows.len(), 2);
        assert_eq!(snapshot.windows[0].label, "Daily quota");
        assert_eq!(snapshot.windows[1].label, "Weekly quota");
        assert_eq!(snapshot.windows[1].used_percent, 75.0);
        assert_eq!(snapshot.windows[1].resets_at, None);
    }

    #[tokio::test]
    async fn missing_cli_credentials_are_not_logged_in() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        clear_env();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("RYU_USAGE_DEVIN_DIR", dir.path());

        let snapshot = fetch("acp:devin").await;

        assert!(!snapshot.available);
        assert!(matches!(
            snapshot.reason,
            Some(UsageUnavailable::NotLoggedIn)
        ));
        clear_env();
    }

    #[tokio::test]
    async fn rate_limit_preserves_retry_after() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        clear_env();
        let dir = tempfile::tempdir().unwrap();
        write_credentials(dir.path(), "windsurf_api_key = \"fixture-key\"\n");
        std::env::set_var(
            "RYU_USAGE_DEVIN_URL",
            spawn_loopback_with_headers("429 Too Many Requests", "Retry-After: 45\r\n", "{}"),
        );

        let snapshot = fetch("acp:devin").await;

        assert!(matches!(
            snapshot.reason,
            Some(UsageUnavailable::RateLimited)
        ));
        assert_eq!(snapshot.retry_after_seconds, Some(45));
        clear_env();
    }

    #[test]
    fn malformed_quota_value_is_refused() {
        let body = serde_json::json!({
            "userStatus": {
                "planStatus": {
                    "planInfo": {"planName": "Max"},
                    "weeklyQuotaRemainingPercent": "unknown"
                }
            }
        });

        assert!(matches!(
            map_response("acp:devin", &body),
            Err(UsageUnavailable::Error)
        ));
    }
}
