//! Agent-facing projection of a normalized usage snapshot: percent windows and
//! non-percent meters, each with a stable `targetId`.
//!
//! The `targetId` strings (`window:{label}:{model}:{window_seconds}` and
//! `meter:{label}:{kind}:{unit}`) are persisted by monitors as reset baselines,
//! so they must stay byte-identical across releases. This code moved here from
//! the `usage` MCP tool unchanged so the HTTP, bridge, MCP and monitor surfaces
//! all derive the same ids from one implementation.

use serde_json::{json, Value};

pub(crate) fn project_snapshot(provider: &str, snapshot: &Value, model: Option<&str>) -> Value {
    let (windows, model_matched) = project_windows(snapshot, model);
    json!({
        "providerId": provider,
        "agentId": snapshot.get("agent_id").cloned().unwrap_or(Value::Null),
        "engine": snapshot.get("engine").cloned().unwrap_or(Value::Null),
        "available": snapshot.get("available").and_then(Value::as_bool).unwrap_or(false),
        "plan": snapshot.get("plan").cloned().unwrap_or(Value::Null),
        "reason": snapshot.get("reason").cloned().unwrap_or(Value::Null),
        "modelMatched": model_matched,
        "windows": windows,
        "meters": project_meters(snapshot.get("meters")),
        "extraUsageUsd": snapshot.get("extra_usage_usd").cloned().unwrap_or(Value::Null),
        "retryAfterSeconds": snapshot.get("retry_after_seconds").cloned().unwrap_or(Value::Null),
    })
}

pub(crate) fn project_windows(snapshot: &Value, model: Option<&str>) -> (Vec<Value>, Option<bool>) {
    let rows = snapshot
        .get("windows")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let model_matched = model.map(|requested| {
        rows.iter().any(|row| {
            row.get("model")
                .and_then(Value::as_str)
                .is_some_and(|candidate| models_match(candidate, requested))
        })
    });

    let projected = rows
        .iter()
        .filter(|row| {
            let Some(requested) = model else {
                return true;
            };
            row.get("model")
                .and_then(Value::as_str)
                .is_none_or(|candidate| models_match(candidate, requested))
        })
        .filter_map(project_window)
        .collect();
    (projected, model_matched)
}

pub(crate) fn project_window(row: &Value) -> Option<Value> {
    let used = row
        .get("used_percent")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())?
        .clamp(0.0, 100.0);
    let label = row
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let model = row
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let window_seconds = row.get("window_seconds").and_then(Value::as_i64);
    let resets_at = row
        .get("resets_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    Some(json!({
        "targetId": format!(
            "window:{}:{}:{}",
            label,
            model.unwrap_or_default(),
            window_seconds.unwrap_or_default()
        ),
        "label": label,
        "window": short_window_label(window_seconds, label),
        "windowSeconds": window_seconds,
        "scope": if model.is_some() { "model" } else { "account" },
        "model": model,
        "usedPercent": used,
        "remainingPercent": (100.0 - used).clamp(0.0, 100.0),
        "resetsAt": resets_at,
    }))
}

pub(crate) fn project_meters(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|meters| {
            meters
                .iter()
                .filter_map(|meter| {
                    let label = meter
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let resets_at = meter.get("resets_at").cloned().unwrap_or(Value::Null);
                    let values = meter
                        .get("values")
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|value| {
                                    let number = value
                                        .get("number")
                                        .and_then(Value::as_f64)
                                        .filter(|number| number.is_finite())?;
                                    Some(json!({
                                        "targetId": format!(
                                            "meter:{}:{}:{}",
                                            label,
                                            value.get("kind").and_then(Value::as_str).unwrap_or_default(),
                                            value.get("unit").and_then(Value::as_str).unwrap_or_default()
                                        ),
                                        "number": number,
                                        "kind": value.get("kind").cloned().unwrap_or(Value::Null),
                                        "unit": value.get("unit").cloned().unwrap_or(Value::Null),
                                        "resetsAt": resets_at.clone(),
                                    }))
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(json!({
                        "label": label,
                        "values": values,
                        "expiresAt": meter.get("expires_at").cloned().unwrap_or_else(|| json!([])),
                        "resetsAt": resets_at,
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn short_window_label(seconds: Option<i64>, fallback: &str) -> String {
    let Some(seconds) = seconds.filter(|seconds| *seconds > 0) else {
        return fallback.to_owned();
    };
    const HOUR: i64 = 60 * 60;
    const DAY: i64 = 24 * HOUR;
    if seconds % DAY == 0 {
        return format!("{}d", seconds / DAY);
    }
    if seconds % HOUR == 0 {
        return format!("{}h", seconds / HOUR);
    }
    if seconds % 60 == 0 {
        return format!("{}m", seconds / 60);
    }
    format!("{seconds}s")
}

pub(crate) fn models_match(candidate: &str, requested: &str) -> bool {
    let candidate = normalized_model(candidate);
    let requested = normalized_model(requested);
    !candidate.is_empty()
        && !requested.is_empty()
        && (candidate == requested
            || candidate.contains(&requested)
            || requested.contains(&candidate))
}

pub(crate) fn normalized_model(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures and expectations carried over unchanged from the `usage` MCP
    // tool's tests: persisted monitor baselines depend on these exact ids.
    #[test]
    fn projects_remaining_percent_and_reset_time_for_account_and_model_windows() {
        let raw = json!({
            "agent_id": "acp:claude",
            "engine": "claude",
            "available": true,
            "plan": "Max 20x",
            "windows": [
                {
                    "label": "Session",
                    "used_percent": 42.5,
                    "window_seconds": 18_000,
                    "resets_at": "2026-09-17T05:00:00Z",
                    "model": null
                },
                {
                    "label": "Sonnet",
                    "used_percent": 80.0,
                    "window_seconds": 604_800,
                    "resets_at": "2026-09-20T05:00:00Z",
                    "model": "Sonnet"
                },
                {
                    "label": "Opus",
                    "used_percent": 90.0,
                    "window_seconds": 604_800,
                    "resets_at": "2026-09-20T05:00:00Z",
                    "model": "Opus"
                }
            ]
        });
        let projected = project_snapshot("claude-pro-max", &raw, Some("claude-sonnet-4"));
        assert_eq!(projected["available"], true);
        assert_eq!(projected["modelMatched"], true);
        assert_eq!(projected["windows"].as_array().unwrap().len(), 2);
        assert_eq!(projected["windows"][0]["window"], "5h");
        assert_eq!(projected["windows"][0]["remainingPercent"], 57.5);
        assert_eq!(projected["windows"][0]["scope"], "account");
        assert_eq!(projected["windows"][0]["resetsAt"], "2026-09-17T05:00:00Z");
        assert_eq!(projected["windows"][0]["targetId"], "window:Session::18000");
        assert_eq!(projected["windows"][1]["window"], "7d");
        assert_eq!(projected["windows"][1]["remainingPercent"], 20.0);
        assert_eq!(projected["windows"][1]["model"], "Sonnet");
        assert_eq!(
            projected["windows"][1]["targetId"],
            "window:Sonnet:Sonnet:604800"
        );
    }

    #[test]
    fn window_without_seconds_or_model_keeps_empty_target_segments() {
        let raw = json!({
            "available": true,
            "windows": [{ "label": "Weekly", "used_percent": 10.0 }]
        });
        let projected = project_snapshot("chatgpt", &raw, None);
        assert_eq!(projected["windows"][0]["targetId"], "window:Weekly::0");
        assert_eq!(projected["windows"][0]["window"], "Weekly");
    }

    #[test]
    fn model_query_does_not_return_an_unrelated_model_window() {
        let raw = json!({
            "available": true,
            "windows": [
                { "label": "Weekly", "used_percent": 10.0, "model": null },
                { "label": "Opus", "used_percent": 80.0, "model": "Opus" }
            ]
        });
        let projected = project_snapshot("claude-pro-max", &raw, Some("sonnet"));
        assert_eq!(projected["modelMatched"], false);
        assert_eq!(projected["windows"].as_array().unwrap().len(), 1);
        assert_eq!(projected["windows"][0]["scope"], "account");
    }

    #[test]
    fn projects_prepaid_meter_values_and_their_reset_metadata() {
        let raw = json!({
            "available": true,
            "meters": [{
                "label": "API credit",
                "values": [{ "number": 12.34, "kind": "dollars", "unit": null }],
                "expires_at": [],
                "resets_at": "2026-10-01T00:00:00Z"
            }]
        });
        let projected = project_snapshot("openrouter", &raw, None);
        assert_eq!(projected["meters"][0]["label"], "API credit");
        assert_eq!(projected["meters"][0]["values"][0]["number"], 12.34);
        assert_eq!(projected["meters"][0]["values"][0]["kind"], "dollars");
        assert_eq!(
            projected["meters"][0]["values"][0]["targetId"],
            "meter:API credit:dollars:"
        );
        assert_eq!(projected["meters"][0]["resetsAt"], "2026-10-01T00:00:00Z");
    }

    #[test]
    fn meter_target_id_includes_the_unit() {
        let raw = json!({
            "available": true,
            "meters": [{
                "label": "Credits",
                "values": [{ "number": 3.0, "kind": "count", "unit": "credits" }]
            }]
        });
        let projected = project_snapshot("openai-codex", &raw, None);
        assert_eq!(
            projected["meters"][0]["values"][0]["targetId"],
            "meter:Credits:count:credits"
        );
    }

    #[test]
    fn model_matching_accepts_provider_model_ids_and_display_names() {
        assert!(models_match("GPT-5.3-Codex-Spark", "gpt-5.3-codex-spark"));
        assert!(models_match("Sonnet", "claude-sonnet-4"));
        assert!(!models_match("Opus", "claude-sonnet-4"));
    }
}
