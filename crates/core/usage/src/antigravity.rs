//! Antigravity subscription usage through the running IDE's local language server.
//!
//! This reader never accesses Google's OAuth credentials or refresh endpoint.
//! Core discovers the process-scoped CSRF token and port, then this module only
//! sends Connect JSON requests to the numeric loopback address.

use serde_json::Value;
use std::collections::HashSet;

use super::{
    host, read_json_limited, AntigravityLocalServer, UsageSnapshot, UsageUnavailable, UsageWindow,
};

const SERVICE: &str = "exa.language_server_pb.LanguageServerService";
const METADATA: &str = r#"{"metadata":{"ideName":"antigravity","extensionName":"antigravity","ideVersion":"unknown","locale":"en"}}"#;
const GEMINI_5H: &str = "gemini-5h";
const GEMINI_WEEKLY: &str = "gemini-weekly";
const THIRD_PARTY_5H: &str = "3p-5h";
const THIRD_PARTY_WEEKLY: &str = "3p-weekly";

pub(super) async fn fetch(agent_id: &str) -> UsageSnapshot {
    let unavailable = |reason| UsageSnapshot::unavailable(agent_id, "antigravity", reason);
    let Some(host) = host() else {
        return unavailable(UsageUnavailable::NotLoggedIn);
    };
    let servers = match tokio::task::spawn_blocking(move || host.antigravity_local_servers()).await
    {
        Ok(servers) => servers,
        Err(_) => return unavailable(UsageUnavailable::Error),
    };
    if servers.is_empty() {
        return unavailable(UsageUnavailable::NotLoggedIn);
    }
    for server in &servers {
        if let Some(snapshot) = fetch_from_server(agent_id, server).await {
            return snapshot;
        }
    }
    unavailable(UsageUnavailable::Error)
}

async fn fetch_from_server(
    agent_id: &str,
    server: &AntigravityLocalServer,
) -> Option<UsageSnapshot> {
    let mut endpoints = Vec::new();
    if let (Some(port), Some(csrf)) = (server.https_port, server.https_csrf_token.as_deref()) {
        endpoints.push(("https", port, csrf));
    }
    if let (Some(port), Some(csrf)) = (server.http_port, server.http_csrf_token.as_deref()) {
        endpoints.push(("http", port, csrf));
    }

    for (scheme, port, csrf) in endpoints {
        if let Some(response) =
            call_language_server(scheme, port, csrf, "RetrieveUserQuotaSummary").await
        {
            if response.status().is_success() {
                let body = read_json_limited(response).await.ok()?;
                if let Some(windows) =
                    parse_quota_summary(&body).filter(|windows| !windows.is_empty())
                {
                    let plan = match call_language_server(scheme, port, csrf, "GetUserStatus").await
                    {
                        Some(response) if response.status().is_success() => {
                            read_json_limited(response)
                                .await
                                .ok()
                                .and_then(|body| parse_plan(&body))
                        }
                        _ => None,
                    };
                    let mut snapshot = UsageSnapshot::available(agent_id, "antigravity", plan);
                    snapshot.windows = windows;
                    return Some(snapshot);
                }
            } else if response.status().as_u16() != 404 {
                continue;
            }
        }

        if let Some(response) = call_language_server(scheme, port, csrf, "GetUserStatus").await {
            if response.status().is_success() {
                let body = read_json_limited(response).await.ok()?;
                if let Some(snapshot) = map_legacy_status(agent_id, &body) {
                    return Some(snapshot);
                }
            }
        }
    }
    None
}

async fn call_language_server(
    scheme: &str,
    port: u16,
    csrf: &str,
    method: &str,
) -> Option<reqwest::Response> {
    // Host discovery returns only a bounded u16 port from an Antigravity process.
    // The URL host is hard-coded to loopback, redirects are disabled, and the
    // certificate exception is used only for this local self-signed server.
    let url = format!("{scheme}://127.0.0.1:{port}/{SERVICE}/{method}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .danger_accept_invalid_certs(true)
        .build()
        .ok()?;
    client
        .post(url)
        .header("Connect-Protocol-Version", "1")
        .header("Content-Type", "application/json")
        .header("x-codeium-csrf-token", csrf)
        .body(METADATA)
        .send()
        .await
        .ok()
}

fn parse_quota_summary(body: &Value) -> Option<Vec<UsageWindow>> {
    let groups = body
        .pointer("/response/groups")
        .or_else(|| body.get("groups"))?
        .as_array()?;
    let mut windows = Vec::new();
    let mut seen_buckets = HashSet::new();
    for group in groups {
        let Some(buckets) = group.get("buckets").and_then(Value::as_array) else {
            continue;
        };
        for bucket in buckets {
            let Some(id) = bucket.get("bucketId").and_then(Value::as_str) else {
                continue;
            };
            if !seen_buckets.insert(id) {
                continue;
            }
            let (label, seconds) = match id {
                GEMINI_5H => ("Session", Some(5 * 60 * 60)),
                GEMINI_WEEKLY => ("Weekly", Some(7 * 24 * 60 * 60)),
                THIRD_PARTY_5H => ("Claude", Some(5 * 60 * 60)),
                THIRD_PARTY_WEEKLY => ("Claude Weekly", Some(7 * 24 * 60 * 60)),
                _ => continue,
            };
            let Some(remaining) = bucket
                .get("remainingFraction")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
            else {
                continue;
            };
            let resets_at = bucket
                .get("resetTime")
                .and_then(Value::as_str)
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&chrono::Utc).to_rfc3339());
            windows.push(UsageWindow {
                label: label.to_owned(),
                used_percent: super::clamp_percent((1.0 - remaining.clamp(0.0, 1.0)) * 100.0)
                    .round(),
                resets_at,
                window_seconds: seconds,
                model: None,
            });
        }
    }
    windows.sort_by_key(|window| match window.label.as_str() {
        "Session" => 0,
        "Weekly" => 1,
        "Claude" => 2,
        "Claude Weekly" => 3,
        _ => 4,
    });
    Some(windows)
}

fn parse_plan(body: &Value) -> Option<String> {
    let status = body.get("userStatus")?;
    let raw = status
        .get("userTier")
        .and_then(|tier| tier.get("name"))
        .and_then(Value::as_str)
        .or_else(|| {
            status
                .pointer("/planStatus/planInfo/planName")
                .and_then(Value::as_str)
        })?
        .trim();
    if raw.is_empty() {
        return None;
    }
    let normalized = raw.strip_prefix("Google AI ").unwrap_or(raw);
    Some(normalized.to_owned())
}

fn map_legacy_status(agent_id: &str, body: &Value) -> Option<UsageSnapshot> {
    let status = body.get("userStatus")?;
    let plan = parse_plan(body);
    let configs = status
        .pointer("/cascadeModelConfigData/clientModelConfigs")?
        .as_array()?;
    let mut pools: std::collections::BTreeMap<&'static str, (f64, Option<String>)> =
        std::collections::BTreeMap::new();
    for config in configs {
        let label = config
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let model_id = config
            .pointer("/modelOrAlias/model")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if label.trim().is_empty() && model_id.trim().is_empty() {
            continue;
        }
        let identity = format!("{label} {model_id}").to_ascii_lowercase();
        let pool = if identity.contains("gemini") {
            "Session"
        } else {
            "Claude"
        };
        let Some(remaining) = config
            .pointer("/quotaInfo/remainingFraction")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
        else {
            continue;
        };
        let reset = config
            .pointer("/quotaInfo/resetTime")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&chrono::Utc).to_rfc3339());
        let used = remaining.clamp(0.0, 1.0);
        if pools.get(pool).is_none_or(|(current, _)| used < *current) {
            pools.insert(pool, (used, reset));
        }
    }
    if pools.is_empty() {
        return None;
    }
    let mut snapshot = UsageSnapshot::available(agent_id, "antigravity", plan);
    snapshot.windows = pools
        .into_iter()
        .map(|(label, (remaining, reset))| UsageWindow {
            label: label.to_owned(),
            used_percent: super::clamp_percent((1.0 - remaining) * 100.0).round(),
            resets_at: reset,
            window_seconds: Some(5 * 60 * 60),
            model: None,
        })
        .collect();
    snapshot
        .windows
        .sort_by_key(|window| match window.label.as_str() {
            "Session" => 0,
            "Claude" => 1,
            _ => 2,
        });
    Some(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::spawn_loopback;

    #[tokio::test]
    async fn reads_quota_summary_from_loopback_without_google_credentials() {
        let url = spawn_loopback(
            "200 OK",
            r#"{"response":{"groups":[{"buckets":[{"bucketId":"gemini-5h","remainingFraction":0.72,"resetTime":"2026-09-23T15:00:00Z"},{"bucketId":"gemini-weekly","remainingFraction":0.51,"resetTime":"2026-09-28T00:00:00Z"},{"bucketId":"3p-5h","remainingFraction":0.8,"resetTime":"2026-09-23T15:00:00Z"},{"bucketId":"unknown","remainingFraction":0.1}] }]}}"#,
        );
        let port = reqwest::Url::parse(&url).unwrap().port().unwrap();
        let server = AntigravityLocalServer {
            http_port: Some(port),
            http_csrf_token: Some("abcdefgh-1234".to_owned()),
            https_port: None,
            https_csrf_token: None,
        };

        let snapshot = fetch_from_server("acp:gemini", &server).await.unwrap();

        assert!(snapshot.available);
        assert_eq!(snapshot.engine, "antigravity");
        assert_eq!(snapshot.windows.len(), 3);
        assert_eq!(snapshot.windows[0].label, "Session");
        assert_eq!(snapshot.windows[0].used_percent, 28.0);
        assert_eq!(snapshot.windows[1].label, "Weekly");
        assert_eq!(snapshot.windows[1].used_percent, 49.0);
        assert_eq!(snapshot.windows[2].label, "Claude");
        assert_eq!(snapshot.windows[2].used_percent, 20.0);
    }

    #[test]
    fn quota_summary_ignores_unknown_buckets_and_malformed_fractions() {
        let body = serde_json::json!({
            "groups": [{
                "buckets": [
                    {"bucketId": "gemini-5h", "remainingFraction": "unknown"},
                    {"bucketId": "future-window", "remainingFraction": 0.5}
                ]
            }]
        });
        assert!(parse_quota_summary(&body).is_some_and(|windows| windows.is_empty()));
    }

    #[test]
    fn plan_parser_prefers_antigravity_user_tier() {
        let body = serde_json::json!({
            "userStatus": {
                "userTier": {"name": "Google AI Ultra"},
                "planStatus": {"planInfo": {"planName": "Pro"}}
            }
        });
        assert_eq!(parse_plan(&body).as_deref(), Some("Ultra"));
    }

    #[test]
    fn legacy_status_does_not_invent_a_pool_for_an_unidentified_model() {
        let body = serde_json::json!({
            "userStatus": {
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {
                            "label": "",
                            "modelOrAlias": {"model": ""},
                            "quotaInfo": {"remainingFraction": 0.1}
                        },
                        {
                            "label": "Gemini 3 Pro",
                            "modelOrAlias": {"model": "gemini-3-pro"},
                            "quotaInfo": {"remainingFraction": 0.8}
                        }
                    ]
                }
            }
        });

        let snapshot = map_legacy_status("acp:gemini", &body).unwrap();

        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.windows[0].label, "Session");
    }
}
