//! Codex usage body → windows and meters: the Session / Weekly windows
//! (classified by duration), the Spark model limits, the banked rate-limit
//! resets, the flex-credit balance and the plan label.

use super::{CREDIT_USD_RATE, SESSION_WINDOW_SECS, WEEKLY_WINDOW_SECS};
use crate::{
    clamp_percent, epoch_secs_to_rfc3339, timestamp_to_rfc3339, title_case, UsageValue,
    UsageValueKind, UsageWindow,
};

/// Which meter a rate-limit window belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum WindowKind {
    Session,
    Weekly,
}

/// A `*_window` object paired with the percentage to use for it and the meter it
/// would land on if its duration is unrecognizable.
pub(super) struct WindowCandidate<'a> {
    window: Option<&'a serde_json::Value>,
    used_percent: Option<f64>,
    fallback_kind: WindowKind,
}

/// The Session + Weekly windows, classified by duration.
///
/// Codex normally returns the 5-hour window as `primary_window` and the weekly
/// window as `secondary_window`, but it can move a temporarily sole weekly limit
/// into the primary slot. So we classify on each window's explicit
/// `limit_window_seconds` when present and keep the historical slot mapping only
/// as the compatibility fallback.
pub(super) fn classified_windows(
    rate_limit: Option<&serde_json::Value>,
    labels: (&str, &str),
    header_percents: (Option<f64>, Option<f64>),
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<UsageWindow> {
    let candidates: Vec<WindowCandidate> = [
        (
            rate_limit.and_then(|rl| rl.get("primary_window")),
            header_percents.0,
            WindowKind::Session,
        ),
        (
            rate_limit.and_then(|rl| rl.get("secondary_window")),
            header_percents.1,
            WindowKind::Weekly,
        ),
    ]
    .into_iter()
    .filter_map(|(window, header_percent, fallback_kind)| {
        // A header percentage alone is enough to build a meter, so a slot that
        // is entirely absent still counts as a candidate when its header is set.
        if window.is_none() && header_percent.is_none() {
            return None;
        }
        let used_percent = window
            .and_then(|w| w.get("used_percent"))
            .and_then(serde_json::Value::as_f64)
            .or(header_percent);
        Some(WindowCandidate {
            window,
            used_percent,
            fallback_kind,
        })
    })
    .collect();

    [
        (WindowKind::Session, labels.0),
        (WindowKind::Weekly, labels.1),
    ]
    .into_iter()
    .filter_map(|(kind, label)| classified_window(kind, label, &candidates, now))
    .collect()
}

/// The one candidate that belongs on `kind`'s meter: an exact duration match
/// first, then a candidate whose duration is unrecognizable but whose slot
/// historically meant this meter.
pub(super) fn classified_window(
    kind: WindowKind,
    label: &str,
    candidates: &[WindowCandidate],
    now: chrono::DateTime<chrono::Utc>,
) -> Option<UsageWindow> {
    let exact = candidates
        .iter()
        .find(|candidate| exact_kind(candidate.window) == Some(kind));
    let fallback = candidates.iter().find(|candidate| {
        exact_kind(candidate.window).is_none() && candidate.fallback_kind == kind
    });
    let candidate = exact.or(fallback)?;
    let used_percent = candidate.used_percent?;
    Some(UsageWindow {
        label: label.to_string(),
        used_percent: clamp_percent(used_percent),
        resets_at: reset_at(candidate.window, now),
        window_seconds: window_seconds(candidate.window),
        // Account-wide by default. The Spark pair reuses this builder and stamps
        // its model on afterwards (see `spark_windows`), which keeps the model
        // out of the shared Session/Weekly path entirely.
        model: None,
    })
}

/// The meter a window's reported duration identifies, or `None` when it reports
/// no duration (or an unfamiliar one — a future window length must not silently
/// masquerade as Session or Weekly).
pub(super) fn exact_kind(window: Option<&serde_json::Value>) -> Option<WindowKind> {
    match window_seconds(window)? {
        SESSION_WINDOW_SECS => Some(WindowKind::Session),
        WEEKLY_WINDOW_SECS => Some(WindowKind::Weekly),
        _ => None,
    }
}

/// A window's own `limit_window_seconds`, when reported.
pub(super) fn window_seconds(window: Option<&serde_json::Value>) -> Option<i64> {
    window?
        .get("limit_window_seconds")
        .and_then(serde_json::Value::as_f64)
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map(|seconds| seconds as i64)
}

/// When a window resets, RFC3339. `reset_at` is an absolute epoch-seconds
/// timestamp; `reset_after_seconds` is a relative fallback added to `now`.
pub(super) fn reset_at(
    window: Option<&serde_json::Value>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    let window = window?;
    window
        .get("reset_at")
        .and_then(serde_json::Value::as_i64)
        .and_then(epoch_secs_to_rfc3339)
        .or_else(|| {
            let seconds = window
                .get("reset_after_seconds")
                .and_then(serde_json::Value::as_i64)?;
            Some((now + chrono::Duration::seconds(seconds)).to_rfc3339())
        })
}

/// The Spark (GPT-5.3-Codex-Spark) model limits from `additional_rate_limits`.
/// Each array entry is a named limit whose `rate_limit` reuses the primary /
/// secondary window shape, so parsing mirrors the core Session/Weekly path
/// exactly. Only the Spark entry is surfaced; other model limits in that array
/// aren't shown. An empty result is the common case (accounts without the limit).
pub(super) fn spark_windows(
    additional: Option<&serde_json::Value>,
    now: chrono::DateTime<chrono::Utc>,
) -> Vec<UsageWindow> {
    let Some(entries) = additional.and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let Some(spark) = entries.iter().find(|entry| is_spark_entry(entry)) else {
        return Vec::new();
    };
    // The entry names the model it limits ("GPT-5.3-Codex-Spark"); carry that so a
    // client can attach these two windows to that model's row. Fall back to the
    // meter label when the entry names it in neither field — better a coarse model
    // name than losing the scoping.
    let model = ["limit_name", "metered_feature"]
        .iter()
        .filter_map(|key| spark.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .find(|name| !name.is_empty())
        .unwrap_or("Spark")
        .to_string();
    classified_windows(
        spark.get("rate_limit"),
        ("Spark", "Spark weekly"),
        (None, None),
        now,
    )
    .into_iter()
    .map(|window| UsageWindow {
        model: Some(model.clone()),
        ..window
    })
    .collect()
}

/// True when an `additional_rate_limits` entry is the Spark limit — matched on
/// either `limit_name` ("GPT-5.3-Codex-Spark") or `metered_feature`,
/// case-insensitively, so a wording change on either field still resolves it.
pub(super) fn is_spark_entry(entry: &serde_json::Value) -> bool {
    ["limit_name", "metered_feature"]
        .iter()
        .filter_map(|key| entry.get(*key).and_then(serde_json::Value::as_str))
        .any(|value| value.to_ascii_lowercase().contains("spark"))
}

/// The banked on-demand rate-limit resets: how many are available, plus each
/// still-available credit's own expiry (soonest-first).
pub(super) struct ResetCredits {
    pub(super) count: f64,
    pub(super) expiries: Vec<String>,
}

/// Read the banked resets, preferring the dedicated endpoint's payload (the only
/// source that carries the per-credit expiry list) and falling back to the usage
/// body's embedded `rate_limit_reset_credits` object (count only).
///
/// The dedicated body is only preferred when it actually carries a *numeric*
/// `available_count`: a JSON `null` is still a present field, so a bare
/// presence check would select an unusable payload and drop the row entirely
/// instead of falling back to the count we do have.
pub(super) fn reset_credits(
    body: &serde_json::Value,
    dedicated: Option<&serde_json::Value>,
) -> Option<ResetCredits> {
    let source = dedicated
        .filter(|value| available_count(value).is_some())
        .or_else(|| body.get("rate_limit_reset_credits"))?;
    let count = available_count(source)?;
    Some(ResetCredits {
        count: count.floor(),
        expiries: available_expiries(source.get("credits")),
    })
}

/// A non-negative `available_count`, or `None` when missing/null/non-numeric.
pub(super) fn available_count(source: &serde_json::Value) -> Option<f64> {
    source
        .get("available_count")
        .and_then(serde_json::Value::as_f64)
        .filter(|count| count.is_finite() && *count >= 0.0)
}

/// Every still-available credit's `expires_at`, soonest-first.
///
/// `status` is optional upstream, so a credit is kept when it's explicitly
/// `"available"` *or* carries no status at all — only an explicitly non-available
/// state (`"consumed"` / `"expired"`) is dropped. Filtering hard on
/// `== "available"` would blank the whole expiry list for responses that omit
/// status even though `available_count` reported credits.
pub(super) fn available_expiries(credits: Option<&serde_json::Value>) -> Vec<String> {
    let Some(credits) = credits.and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut expiries: Vec<String> = credits
        .iter()
        .filter(|credit| {
            credit
                .get("status")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|status| status == "available")
        })
        .filter_map(|credit| timestamp_to_rfc3339(credit.get("expires_at")))
        .collect();
    // RFC3339 in a fixed offset sorts lexicographically in time order, and every
    // value here came out of `timestamp_to_rfc3339` (always UTC), so a plain sort
    // is a chronological sort.
    expiries.sort();
    expiries
}

/// The flex-credit balance: `credits.balance`, an explicit
/// `credits.has_credits: false` (a real, measured zero), or the
/// `x-codex-credits-balance` header.
pub(super) fn credits_balance(
    body: &serde_json::Value,
    header_balance: Option<f64>,
) -> Option<f64> {
    if let Some(credits) = body.get("credits") {
        if let Some(balance) = credits
            .get("balance")
            .and_then(serde_json::Value::as_f64)
            .filter(|balance| balance.is_finite())
        {
            return Some(balance);
        }
        if credits
            .get("has_credits")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        {
            return Some(0.0);
        }
    }
    header_balance
}

/// The balance as both figures the Codex CLI shows: the floored credit count and
/// its dollar value. The count is floored *before* pricing so our dollar figure
/// agrees with Codex's own, which keeps the two mutually consistent. A negative
/// balance clamps to zero, so an exhausted balance reads a real "$0.00 · 0
/// credits" rather than nothing at all.
pub(super) fn credit_values(balance: f64) -> Vec<UsageValue> {
    let credits = balance.floor().max(0.0);
    vec![
        UsageValue::new(credits * CREDIT_USD_RATE, UsageValueKind::Dollars, None),
        UsageValue::new(credits, UsageValueKind::Count, Some("credits")),
    ]
}

/// `"plus"` → `"Plus"`, and the two plan names Codex reports opaquely:
/// `"prolite"` is the 5× Pro tier and `"pro"` the 20× one, which is what the
/// user actually recognizes.
pub(super) fn format_plan(value: &serde_json::Value) -> Option<String> {
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    match raw.to_ascii_lowercase().as_str() {
        "prolite" => Some("Pro 5x".to_string()),
        "pro" => Some("Pro 20x".to_string()),
        _ => Some(title_case(raw, &['_'])),
    }
}
