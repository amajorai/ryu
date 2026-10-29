use super::windows::*;
use super::*;
use crate::epoch_secs_to_rfc3339;
use crate::tests::{spawn_loopback, spawn_loopback_with_headers};

// CODEX_HOME + RYU_USAGE_CODEX_URL are process-global; serialize env-touching
// tests. A crafted auth.json under CODEX_HOME is the FIRST auth candidate, so
// it deterministically wins over any real ~/.codex on the dev machine.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn write_auth(dir: &std::path::Path, body: &str) {
    std::env::set_var("CODEX_HOME", dir);
    std::fs::write(dir.join("auth.json"), body).unwrap();
}

fn clear_env() {
    std::env::remove_var("CODEX_HOME");
    std::env::remove_var("RYU_USAGE_CODEX_URL");
    std::env::remove_var("RYU_USAGE_CODEX_RESETS_URL");
    std::env::remove_var("RYU_USAGE_CODEX_USER_HOME");
}

fn jwt_with_exp(exp: i64) -> String {
    use base64::Engine as _;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(format!(r#"{{"exp":{exp}}}"#).as_bytes());
    format!("h.{payload}.s")
}

/// Point the reset-credits fetch at a closed port so it fails fast and the
/// embedded-count fallback is what a test observes.
fn disable_reset_endpoint() {
    std::env::set_var("RYU_USAGE_CODEX_RESETS_URL", "http://127.0.0.1:1/resets");
}

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}

// ── pure helpers ─────────────────────────────────────────────────────────

#[test]
fn format_plan_maps_opaque_codex_tiers() {
    let plan = |raw: &str| format_plan(&serde_json::json!(raw));
    assert_eq!(plan("prolite").as_deref(), Some("Pro 5x"));
    assert_eq!(plan("pro").as_deref(), Some("Pro 20x"));
    assert_eq!(plan("PRO").as_deref(), Some("Pro 20x"));
    assert_eq!(plan("plus").as_deref(), Some("Plus"));
    assert_eq!(plan(" team ").as_deref(), Some("Team"));
    assert_eq!(plan("business_plus").as_deref(), Some("Business Plus"));
    assert!(plan("").is_none());
    assert!(format_plan(&serde_json::json!(7)).is_none());
}

#[test]
fn window_uses_absolute_reset_at() {
    let rate_limit = serde_json::json!({
        "primary_window": { "used_percent": 30.0, "reset_at": 1_800_000_000i64 }
    });
    let windows = classified_windows(
        Some(&rate_limit),
        ("Session", "Weekly"),
        (None, None),
        now(),
    );
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].label, "Session");
    assert_eq!(windows[0].used_percent, 30.0);
    assert_eq!(
        windows[0].resets_at.as_deref(),
        epoch_secs_to_rfc3339(1_800_000_000).as_deref()
    );
}

#[test]
fn window_falls_back_to_relative_reset_after_seconds() {
    let at = now();
    let rate_limit = serde_json::json!({
        "secondary_window": { "used_percent": 12.0, "reset_after_seconds": 3600i64 }
    });
    let windows = classified_windows(Some(&rate_limit), ("Session", "Weekly"), (None, None), at);
    assert_eq!(windows[0].label, "Weekly");
    assert_eq!(
        windows[0].resets_at.as_deref(),
        Some((at + chrono::Duration::seconds(3600)).to_rfc3339().as_str())
    );
}

#[test]
fn window_without_used_percent_or_rate_limit_is_skipped() {
    assert!(classified_windows(None, ("Session", "Weekly"), (None, None), now()).is_empty());
    let rate_limit = serde_json::json!({ "primary_window": { "reset_at": 1_800_000_000i64 } });
    assert!(classified_windows(
        Some(&rate_limit),
        ("Session", "Weekly"),
        (None, None),
        now()
    )
    .is_empty());
}

/// The classification fix: a *weekly* window sitting in the primary slot must
/// read "Weekly", not "Session".
#[test]
fn window_classified_by_duration_not_slot() {
    let rate_limit = serde_json::json!({
        "primary_window": {
            "used_percent": 44.0,
            "limit_window_seconds": WEEKLY_WINDOW_SECS,
            "reset_at": 1_800_000_000i64
        }
    });
    let windows = classified_windows(
        Some(&rate_limit),
        ("Session", "Weekly"),
        (None, None),
        now(),
    );
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].label, "Weekly");
    assert_eq!(windows[0].used_percent, 44.0);
    assert_eq!(windows[0].window_seconds, Some(WEEKLY_WINDOW_SECS));
}

#[test]
fn window_unrecognized_duration_keeps_slot_fallback() {
    let rate_limit = serde_json::json!({
        "primary_window": { "used_percent": 5.0, "limit_window_seconds": 999i64 }
    });
    let windows = classified_windows(
        Some(&rate_limit),
        ("Session", "Weekly"),
        (None, None),
        now(),
    );
    assert_eq!(windows[0].label, "Session");
    assert_eq!(windows[0].window_seconds, Some(999));
}

#[test]
fn window_percent_comes_from_header_when_body_omits_it() {
    let rate_limit = serde_json::json!({ "primary_window": { "reset_at": 1_800_000_000i64 } });
    let windows = classified_windows(
        Some(&rate_limit),
        ("Session", "Weekly"),
        (Some(66.0), None),
        now(),
    );
    assert_eq!(windows[0].used_percent, 66.0);
}

#[test]
fn window_percent_clamps_out_of_range() {
    let rate_limit = serde_json::json!({ "primary_window": { "used_percent": 140.0 } });
    let windows = classified_windows(
        Some(&rate_limit),
        ("Session", "Weekly"),
        (None, None),
        now(),
    );
    assert_eq!(windows[0].used_percent, 100.0);
}

// ── Spark ────────────────────────────────────────────────────────────────

#[test]
fn spark_windows_read_the_named_entry() {
    let additional = serde_json::json!([
        { "limit_name": "some-other-model", "rate_limit": { "primary_window": { "used_percent": 1.0 } } },
        { "limit_name": "GPT-5.3-Codex-Spark", "rate_limit": {
            "primary_window": { "used_percent": 20.0, "limit_window_seconds": SESSION_WINDOW_SECS },
            "secondary_window": { "used_percent": 40.0, "limit_window_seconds": WEEKLY_WINDOW_SECS }
        } }
    ]);
    let windows = spark_windows(Some(&additional), now());
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0].label, "Spark");
    assert_eq!(windows[0].used_percent, 20.0);
    assert_eq!(windows[1].label, "Spark weekly");
    assert_eq!(windows[1].used_percent, 40.0);
}

/// The Spark pair must be attributable to its model; Session/Weekly must not
/// be. Without that distinction a client can only guess from the label, and
/// would hang an account-wide quota off whichever model shared a word.
#[test]
fn spark_windows_carry_their_model_and_core_windows_do_not() {
    let additional = serde_json::json!([
        { "limit_name": "GPT-5.3-Codex-Spark", "rate_limit": {
            "primary_window": { "used_percent": 20.0, "limit_window_seconds": SESSION_WINDOW_SECS }
        } }
    ]);
    let spark = spark_windows(Some(&additional), now());
    assert_eq!(spark[0].model.as_deref(), Some("GPT-5.3-Codex-Spark"));

    let rate_limit = serde_json::json!({ "primary_window": { "used_percent": 5.0 } });
    let core = classified_windows(
        Some(&rate_limit),
        ("Session", "Weekly"),
        (None, None),
        now(),
    );
    assert!(core[0].model.is_none(), "Session is account-wide");
}

#[test]
fn spark_windows_fall_back_to_the_meter_name_without_an_entry_name() {
    let additional = serde_json::json!([
        { "metered_feature": "   ", "limit_name": "spark", "rate_limit": {
            "primary_window": { "used_percent": 1.0 }
        } }
    ]);
    let spark = spark_windows(Some(&additional), now());
    assert_eq!(spark[0].model.as_deref(), Some("spark"));
}

#[test]
fn spark_windows_matches_metered_feature_and_skips_non_objects() {
    let additional = serde_json::json!([
        "garbage",
        { "metered_feature": "codex_SPARK_tokens", "rate_limit": { "primary_window": { "used_percent": 7.0 } } }
    ]);
    let windows = spark_windows(Some(&additional), now());
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].label, "Spark");
}

#[test]
fn spark_windows_empty_without_spark_entry() {
    assert!(spark_windows(None, now()).is_empty());
    let additional = serde_json::json!([{ "limit_name": "other" }]);
    assert!(spark_windows(Some(&additional), now()).is_empty());
}

// ── banked rate-limit resets ─────────────────────────────────────────────

#[test]
fn reset_credits_prefers_dedicated_payload_with_per_credit_expiries() {
    let body = serde_json::json!({ "rate_limit_reset_credits": { "available_count": 1 } });
    let dedicated = serde_json::json!({
        "available_count": 2,
        "credits": [
            { "status": "available", "expires_at": "2026-08-02T17:30:00Z" },
            { "status": "available", "expires_at": "2026-07-31T09:00:00Z" },
            { "status": "consumed", "expires_at": "2026-07-30T09:00:00Z" }
        ]
    });
    let resets = reset_credits(&body, Some(&dedicated)).expect("resets read");
    assert_eq!(resets.count, 2.0);
    // Soonest-first, and the consumed credit is dropped.
    assert_eq!(resets.expiries.len(), 2);
    assert!(resets.expiries[0].starts_with("2026-07-31"));
    assert!(resets.expiries[1].starts_with("2026-08-02"));
}

#[test]
fn reset_credits_keeps_credits_without_a_status() {
    let dedicated = serde_json::json!({
        "available_count": 1,
        "credits": [{ "expires_at": 1_800_000_000i64 }]
    });
    let resets = reset_credits(&serde_json::json!({}), Some(&dedicated)).expect("resets read");
    assert_eq!(resets.expiries.len(), 1);
}

#[test]
fn reset_credits_falls_back_to_embedded_count_when_dedicated_count_is_null() {
    let body = serde_json::json!({ "rate_limit_reset_credits": { "available_count": 3 } });
    let dedicated = serde_json::json!({ "available_count": serde_json::Value::Null });
    let resets = reset_credits(&body, Some(&dedicated)).expect("resets read");
    assert_eq!(resets.count, 3.0);
    assert!(resets.expiries.is_empty());
}

#[test]
fn reset_credits_reports_a_real_zero_but_skips_a_missing_count() {
    let zero = serde_json::json!({ "rate_limit_reset_credits": { "available_count": 0 } });
    assert_eq!(reset_credits(&zero, None).expect("zero read").count, 0.0);
    assert!(reset_credits(&serde_json::json!({}), None).is_none());
    let malformed = serde_json::json!({ "rate_limit_reset_credits": { "available_count": "two" } });
    assert!(reset_credits(&malformed, None).is_none());
}

// ── flex credits ─────────────────────────────────────────────────────────

#[test]
fn credits_balance_reads_body_then_header() {
    let body = serde_json::json!({ "credits": { "balance": 821.7 } });
    assert_eq!(credits_balance(&body, None), Some(821.7));
    let exhausted = serde_json::json!({ "credits": { "has_credits": false } });
    assert_eq!(credits_balance(&exhausted, None), Some(0.0));
    assert_eq!(
        credits_balance(&serde_json::json!({}), Some(12.0)),
        Some(12.0)
    );
    assert!(credits_balance(&serde_json::json!({}), None).is_none());
}

#[test]
fn credit_values_floor_before_pricing_and_clamp_negatives() {
    let values = credit_values(821.7);
    assert_eq!(values[1].number, 821.0);
    // 821 × 4¢ — floored first, so this agrees with Codex's own dollar figure.
    assert!((values[0].number - 32.84).abs() < 1e-9);
    let exhausted = credit_values(-5.0);
    assert_eq!(exhausted[0].number, 0.0);
    assert_eq!(exhausted[1].number, 0.0);
}

mod fetch;
