//! OpenCode Go subscription usage from the OpenCode CLI's existing auth file.
//!
//! The reader uses only the `opencode-go` API key and performs a read-only GET
//! to OpenCode's fixed usage endpoint. It does not refresh or persist credentials.

use std::path::PathBuf;

use serde_json::Value;

use super::{
    credential_http_client, read_file_limited, read_json_limited, reason_for_status,
    retry_after_seconds, UsageSnapshot, UsageUnavailable, UsageWindow,
};

const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const MAX_CREDENTIAL_BYTES: u64 = 128 * 1024;

#[cfg(not(test))]
fn usage_url() -> String {
    USAGE_URL.to_owned()
}

#[cfg(test)]
fn usage_url() -> String {
    std::env::var("RYU_USAGE_OPENCODE_URL").unwrap_or_else(|_| USAGE_URL.to_owned())
}

fn auth_paths() -> Vec<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = std::env::var_os("RYU_USAGE_OPENCODE_DIR") {
        let dir = PathBuf::from(dir);
        if !dir.as_os_str().is_empty() {
            return vec![dir.join("auth.json")];
        }
    }

    let mut paths = Vec::new();
    if let Some(data_dir) = std::env::var_os("OPENCODE_DATA_DIR") {
        let data_dir = PathBuf::from(data_dir);
        if !data_dir.as_os_str().is_empty() {
            paths.push(data_dir.join("auth.json"));
        }
    }
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        let data_home = PathBuf::from(data_home);
        if !data_home.as_os_str().is_empty() {
            paths.push(data_home.join("opencode/auth.json"));
        }
    }
    if cfg!(windows) {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let local_app_data = PathBuf::from(local_app_data);
            if !local_app_data.as_os_str().is_empty() {
                paths.push(local_app_data.join("opencode/auth.json"));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/share/opencode/auth.json"));
    }
    paths
}

fn load_api_key() -> Option<String> {
    for path in auth_paths() {
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_BYTES {
            continue;
        }
        let Some(text) = read_file_limited(&path, MAX_CREDENTIAL_BYTES) else {
            continue;
        };
        let Ok(auth) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(entry) = auth.get("opencode-go") else {
            continue;
        };
        let Some(api_key) = entry
            .as_str()
            .or_else(|| entry.get("key").and_then(Value::as_str))
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
    let unavailable = |reason| UsageSnapshot::unavailable(agent_id, "opencode", reason);
    let Some(api_key) = load_api_key() else {
        return unavailable(UsageUnavailable::NotLoggedIn);
    };
    let client = match credential_http_client() {
        Ok(client) => client,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    let response = match client
        .get(usage_url())
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        // Identify honestly as Ryu reading the user's own quota, never as the
        // OpenCode client.
        .header("User-Agent", "Ryu")
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
    let usage = body
        .get("usage")
        .and_then(Value::as_object)
        .ok_or(UsageUnavailable::Error)?;
    let mut snapshot = UsageSnapshot::available(agent_id, "opencode", Some("Go".to_owned()));
    for (field, label) in [
        ("rolling", "Session"),
        ("weekly", "Weekly"),
        ("monthly", "Monthly"),
    ] {
        let Some(raw_window) = usage.get(field) else {
            continue;
        };
        if raw_window.is_null() {
            continue;
        }
        let window = raw_window.as_object().ok_or(UsageUnavailable::Error)?;
        let Some(percent) = window.get("percent").filter(|value| !value.is_null()) else {
            continue;
        };
        let used_percent = percent
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or(UsageUnavailable::Error)?;
        let resets_at = match window.get("resetsAt") {
            None | Some(Value::Null) => None,
            Some(value) => {
                Some(super::timestamp_to_rfc3339(Some(value)).ok_or(UsageUnavailable::Error)?)
            }
        };
        snapshot.windows.push(UsageWindow {
            label: label.to_owned(),
            used_percent: super::clamp_percent(used_percent),
            resets_at,
            window_seconds: None,
            model: None,
        });
    }
    if snapshot.windows.is_empty() {
        return Err(UsageUnavailable::NoPlan);
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{spawn_loopback, spawn_loopback_with_headers};

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn clear_env() {
        std::env::remove_var("RYU_USAGE_OPENCODE_DIR");
        std::env::remove_var("RYU_USAGE_OPENCODE_URL");
    }

    fn write_auth(dir: &std::path::Path, body: &str) {
        std::fs::write(dir.join("auth.json"), body).unwrap();
        std::env::set_var("RYU_USAGE_OPENCODE_DIR", dir);
    }

    #[tokio::test]
    async fn fetches_all_go_windows_without_exposing_key() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        clear_env();
        let dir = tempfile::tempdir().unwrap();
        write_auth(
            dir.path(),
            r#"{"opencode-go":{"type":"api","key":"opencode-secret-fixture"}}"#,
        );
        std::env::set_var(
            "RYU_USAGE_OPENCODE_URL",
            spawn_loopback(
                "200 OK",
                r#"{"usage":{"rolling":{"status":"ok","percent":17,"resetsAt":"2026-09-23T12:00:00Z"},"weekly":{"status":"ok","percent":7,"resetsAt":"2026-09-28T00:00:00Z"},"monthly":{"status":"ok","percent":3,"resetsAt":"2026-10-01T00:00:00Z"}}}"#,
            ),
        );

        let snapshot = fetch("acp:opencode").await;

        assert!(snapshot.available);
        assert_eq!(snapshot.plan.as_deref(), Some("Go"));
        assert_eq!(snapshot.windows.len(), 3);
        assert_eq!(snapshot.windows[0].label, "Session");
        assert_eq!(snapshot.windows[0].used_percent, 17.0);
        assert_eq!(snapshot.windows[1].label, "Weekly");
        assert_eq!(snapshot.windows[1].used_percent, 7.0);
        assert_eq!(snapshot.windows[2].label, "Monthly");
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("opencode-secret-fixture"));
        clear_env();
    }

    /// One-shot loopback server that hands back the raw request head.
    fn spawn_capturing(body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("addr");
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buf = [0u8; 4096];
            let read = stream.read(&mut buf).unwrap_or(0);
            let _ = sender.send(String::from_utf8_lossy(&buf[..read]).into_owned());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });
        (format!("http://{addr}/usage"), receiver)
    }

    #[tokio::test]
    async fn identifies_as_ryu_and_never_as_the_opencode_client() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        clear_env();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"opencode-go":{"key":"fixture-key"}}"#);
        let (url, requests) = spawn_capturing(r#"{"usage":{"weekly":{"percent":5}}}"#);
        std::env::set_var("RYU_USAGE_OPENCODE_URL", url);

        let snapshot = fetch("acp:opencode").await;
        let head = requests
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("captured request")
            .to_ascii_lowercase();

        assert!(snapshot.available);
        assert!(head.contains("\r\nuser-agent: ryu\r\n"), "{head}");
        assert!(!head.contains("opencode/"), "{head}");
        assert!(!head.contains("x-opencode-"), "{head}");
        clear_env();
    }

    #[tokio::test]
    async fn only_reads_the_opencode_go_credential() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        clear_env();
        let dir = tempfile::tempdir().unwrap();
        write_auth(
            dir.path(),
            r#"{"opencode":{"type":"api","key":"not-a-go-key"},"openai":{"key":"unrelated-key"}}"#,
        );

        let snapshot = fetch("acp:opencode").await;

        assert!(!snapshot.available);
        assert!(matches!(
            snapshot.reason,
            Some(UsageUnavailable::NotLoggedIn)
        ));
        clear_env();
    }

    #[tokio::test]
    async fn provider_auth_failures_are_reported_without_retrying_credentials() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        clear_env();
        let dir = tempfile::tempdir().unwrap();
        write_auth(dir.path(), r#"{"opencode-go":{"key":"fixture-key"}}"#);
        std::env::set_var(
            "RYU_USAGE_OPENCODE_URL",
            spawn_loopback_with_headers("401 Unauthorized", "", "{}"),
        );

        let snapshot = fetch("acp:opencode").await;

        assert!(matches!(
            snapshot.reason,
            Some(UsageUnavailable::TokenExpired)
        ));
        clear_env();
    }

    #[test]
    fn malformed_usage_percent_is_refused() {
        let body = serde_json::json!({
            "usage": {"rolling": {"percent": "unknown"}}
        });

        assert!(matches!(
            map_response("acp:opencode", &body),
            Err(UsageUnavailable::Error)
        ));
    }

    #[test]
    fn null_window_percent_does_not_hide_other_valid_windows() {
        let body = serde_json::json!({
            "usage": {
                "rolling": {"percent": null},
                "weekly": {"percent": 12}
            }
        });

        let snapshot = map_response("acp:opencode", &body).unwrap();

        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.windows[0].label, "Weekly");
        assert_eq!(snapshot.windows[0].used_percent, 12.0);
    }
}
