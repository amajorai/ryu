//! Unit tests for [`super`] (the Z.ai GLM Coding Plan usage reader).

use super::*;
use crate::tests::{spawn_loopback, spawn_loopback_with_headers};

// The API-key env vars and the URL overrides are process-global; serialize.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn clear_env() {
    for var in [
        "ZAI_API_KEY",
        "RYU_USAGE_GLM_URL",
        "RYU_USAGE_GLM_SUBSCRIPTION_URL",
    ] {
        std::env::remove_var(var);
    }
}

/// Point the plan lookup at a closed port so a test observes the
/// plan-is-best-effort path rather than the real endpoint.
fn disable_subscription() {
    std::env::set_var("RYU_USAGE_GLM_SUBSCRIPTION_URL", "http://127.0.0.1:1/plan");
}

// ── credential discovery ─────────────────────────────────────────────────

#[test]
fn load_api_key_reads_zai_env() {
    let _g = lock();
    clear_env();
    std::env::set_var("ZAI_API_KEY", "  current  ");
    assert_eq!(load_api_key().as_deref(), Some("current"));
    // A blank value doesn't count as set, so discovery falls through to the
    // on-disk key file rather than returning the blank.
    std::env::set_var("ZAI_API_KEY", "   ");
    assert_ne!(load_api_key().as_deref(), Some(""));
    clear_env();
}

// ── quota mapping ────────────────────────────────────────────────────────

fn quota_body() -> serde_json::Value {
    serde_json::json!({ "data": { "limits": [
        { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 42.0, "nextResetTime": 1_770_648_402_389i64 },
        { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 71.5, "nextResetTime": 1_770_948_402_389i64 },
        { "type": "TIME_LIMIT", "unit": 5, "number": 1, "currentValue": 120, "usage": 3000 }
    ]}})
}

#[test]
fn map_quota_classifies_windows_by_their_reported_length() {
    let quota = map_quota(&quota_body()).expect("quota");
    assert_eq!(quota.windows.len(), 2);
    // unit 3 × 5 = a 5-hour window → Session.
    assert_eq!(quota.windows[0].label, "Session");
    assert_eq!(quota.windows[0].used_percent, 42.0);
    assert_eq!(quota.windows[0].window_seconds, Some(5 * 60 * 60));
    assert!(quota.windows[0].resets_at.is_some());
    // unit 6 × 1 = a one-week window → Weekly.
    assert_eq!(quota.windows[1].label, "Weekly");
    assert_eq!(quota.windows[1].window_seconds, Some(7 * 24 * 60 * 60));

    assert_eq!(quota.meters.len(), 1);
    assert_eq!(quota.meters[0].label, "Web searches");
    assert_eq!(quota.meters[0].values[0].number, 120.0);
    assert_eq!(quota.meters[0].values[1].number, 3000.0);
}

#[test]
fn map_quota_tolerates_a_root_level_limits_array() {
    let body = serde_json::json!({ "limits": [
        { "name": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 10.0 }
    ]});
    let quota = map_quota(&body).expect("quota");
    assert_eq!(quota.windows.len(), 1);
    assert_eq!(quota.windows[0].label, "Session");
}

#[test]
fn map_quota_empty_limits_is_a_valid_no_data_state() {
    let body = serde_json::json!({ "data": { "limits": [] }});
    let quota = map_quota(&body).expect("quota");
    assert!(quota.windows.is_empty());
    assert!(quota.meters.is_empty());
}

#[test]
fn map_quota_skips_unknown_units_but_refuses_missing_values() {
    // An unfamiliar unit is skipped, not fatal — the known sibling survives.
    let mixed = serde_json::json!({ "data": { "limits": [
        { "type": "TOKENS_LIMIT", "unit": 99, "number": 1, "percentage": 5.0 },
        { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 8.0 }
    ]}});
    let quota = map_quota(&mixed).expect("quota");
    assert_eq!(quota.windows.len(), 1);
    assert_eq!(quota.windows[0].used_percent, 8.0);

    // A recognized window with no percentage is drift → refuse, don't show 0%.
    let missing = serde_json::json!({ "data": { "limits": [
        { "type": "TOKENS_LIMIT", "unit": 3, "number": 5 }
    ]}});
    assert!(map_quota(&missing).is_none());
    // Likewise a web-search entry missing its allowance.
    let no_limit = serde_json::json!({ "data": { "limits": [
        { "type": "TIME_LIMIT", "currentValue": 10 }
    ]}});
    assert!(map_quota(&no_limit).is_none());
    // No limits array at all, or a non-object `data`.
    assert!(map_quota(&serde_json::json!({ "data": {} })).is_none());
    assert!(map_quota(&serde_json::json!({ "data": 3 })).is_none());
}

#[test]
fn no_coding_plan_needs_both_the_flag_and_the_phrase() {
    let signal =
        serde_json::json!({ "success": false, "code": 500, "msg": "no active coding plan" });
    assert!(is_no_coding_plan(&signal));
    // An unrelated business failure must not be mistaken for it.
    let other = serde_json::json!({ "success": false, "msg": "internal error" });
    assert!(!is_no_coding_plan(&other));
    assert!(!is_no_coding_plan(&serde_json::json!({ "success": true })));
    assert!(!is_no_coding_plan(&quota_body()));
}

#[test]
fn plan_name_reads_the_first_product() {
    let body = serde_json::json!({ "data": [{ "productName": "GLM Coding Max" }] });
    assert_eq!(plan_name(&body).as_deref(), Some("GLM Coding Max"));
    assert!(plan_name(&serde_json::json!({ "data": [] })).is_none());
    assert!(plan_name(&serde_json::json!({ "data": [{ "productName": " " }] })).is_none());
    assert!(plan_name(&serde_json::json!({})).is_none());
}

/// A daily cap must not be labelled "Weekly" — and two windows must never
/// come out sharing one label, which is what collapsing everything ≥ a day
/// into "Weekly" would do for a plan reporting both.
#[test]
fn window_label_names_each_duration_distinctly() {
    assert_eq!(window_label(5.0 * 60.0 * 60.0 * 1000.0), "Session");
    assert_eq!(window_label(DAY_MS), "Daily");
    assert_eq!(window_label(7.0 * DAY_MS), "Weekly");
    assert_eq!(window_label(30.0 * DAY_MS), "Monthly");
    assert_eq!(window_label(3.0 * DAY_MS), "3-day");
}

#[test]
fn map_quota_keeps_a_daily_and_a_weekly_cap_apart() {
    let body = serde_json::json!({ "data": { "limits": [
        { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 10.0 },
        { "type": "TOKENS_LIMIT", "unit": 4, "number": 1, "percentage": 20.0 },
        { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 30.0 }
    ]}});
    let quota = map_quota(&body).expect("quota");
    let labels: Vec<&str> = quota.windows.iter().map(|w| w.label.as_str()).collect();
    assert_eq!(labels, vec!["Session", "Daily", "Weekly"]);
}

#[test]
fn window_millis_maps_every_known_unit() {
    let entry = |unit: i64, number: i64| serde_json::json!({ "unit": unit, "number": number });
    assert_eq!(
        window_millis(&entry(3, 5)),
        Some(5.0 * 60.0 * 60.0 * 1000.0)
    );
    assert_eq!(window_millis(&entry(4, 1)), Some(DAY_MS));
    assert_eq!(window_millis(&entry(6, 1)), Some(7.0 * DAY_MS));
    assert_eq!(window_millis(&entry(5, 1)), Some(30.0 * DAY_MS));
    assert!(window_millis(&entry(99, 1)).is_none());
    assert!(window_millis(&entry(3, 0)).is_none());
    assert!(window_millis(&serde_json::json!({ "number": 1 })).is_none());
}

// ── fetch end-to-end via loopback server ─────────────────────────────────

#[tokio::test]
async fn fetch_not_logged_in_without_a_key() {
    let _g = lock();
    clear_env();
    // HOME is redirected so the on-disk key candidate can't resolve to a real
    // one on the dev machine.
    let home = tempfile::tempdir().unwrap();
    let previous = std::env::var_os("HOME");
    std::env::set_var("HOME", home.path());
    let snap = fetch("acp:glm").await;
    assert!(!snap.available);
    assert_eq!(snap.engine, "glm");
    assert!(matches!(snap.reason, Some(UsageUnavailable::NotLoggedIn)));
    match previous {
        Some(h) => std::env::set_var("HOME", h),
        None => std::env::remove_var("HOME"),
    }
}

#[tokio::test]
async fn fetch_builds_windows_meter_and_plan() {
    let _g = lock();
    clear_env();
    std::env::set_var("ZAI_API_KEY", "zai-key");
    let url = spawn_loopback(
        "200 OK",
        r#"{"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":42.0,"nextResetTime":1770648402389},{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":71.5},{"type":"TIME_LIMIT","currentValue":120,"usage":3000}]}}"#,
    );
    std::env::set_var("RYU_USAGE_GLM_URL", &url);
    let plan = spawn_loopback("200 OK", r#"{"data":[{"productName":"GLM Coding Max"}]}"#);
    std::env::set_var("RYU_USAGE_GLM_SUBSCRIPTION_URL", &plan);

    let snap = fetch("acp:glm").await;
    assert!(snap.available, "reason={:?}", snap.reason);
    assert_eq!(snap.plan.as_deref(), Some("GLM Coding Max"));
    assert_eq!(snap.windows.len(), 2);
    assert_eq!(snap.windows[0].label, "Session");
    assert_eq!(snap.windows[1].label, "Weekly");
    assert_eq!(snap.meters[0].label, "Web searches");
    clear_env();
}

#[tokio::test]
async fn fetch_reports_no_plan_for_a_key_without_a_coding_plan() {
    let _g = lock();
    clear_env();
    std::env::set_var("ZAI_API_KEY", "zai-key");
    let url = spawn_loopback(
        "200 OK",
        r#"{"success":false,"code":500,"msg":"You have no active coding plan"}"#,
    );
    std::env::set_var("RYU_USAGE_GLM_URL", &url);
    let snap = fetch("acp:glm").await;
    assert!(!snap.available);
    assert!(matches!(snap.reason, Some(UsageUnavailable::NoPlan)));
    clear_env();
}

#[tokio::test]
async fn fetch_survives_a_failing_plan_lookup() {
    let _g = lock();
    clear_env();
    std::env::set_var("ZAI_API_KEY", "zai-key");
    let url = spawn_loopback(
        "200 OK",
        r#"{"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":9.0}]}}"#,
    );
    std::env::set_var("RYU_USAGE_GLM_URL", &url);
    disable_subscription();
    let snap = fetch("acp:glm").await;
    assert!(snap.available, "reason={:?}", snap.reason);
    assert!(snap.plan.is_none());
    assert_eq!(snap.windows.len(), 1);
    clear_env();
}

#[tokio::test]
async fn fetch_maps_401_and_429_and_bad_json() {
    let _g = lock();
    clear_env();
    std::env::set_var("ZAI_API_KEY", "zai-key");

    let url = spawn_loopback("403 Forbidden", "{}");
    std::env::set_var("RYU_USAGE_GLM_URL", &url);
    assert!(matches!(
        fetch("acp:glm").await.reason,
        Some(UsageUnavailable::TokenExpired)
    ));

    let url = spawn_loopback_with_headers("429 Too Many Requests", "Retry-After: 45\r\n", "{}");
    std::env::set_var("RYU_USAGE_GLM_URL", &url);
    let snap = fetch("acp:glm").await;
    assert!(matches!(snap.reason, Some(UsageUnavailable::RateLimited)));
    assert_eq!(snap.retry_after_seconds, Some(45));

    let url = spawn_loopback("200 OK", "definitely-not-json");
    std::env::set_var("RYU_USAGE_GLM_URL", &url);
    assert!(matches!(
        fetch("acp:glm").await.reason,
        Some(UsageUnavailable::Error)
    ));
    clear_env();
}
