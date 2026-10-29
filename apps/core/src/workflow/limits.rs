//! Rate-, usage-, and session-limit detection for durable work.
//!
//! A provider limit is not a failure of the work: the same step succeeds once
//! the window reopens. The workflow executor uses [`classify`] to tell such an
//! error apart from a real one, and parks the run as
//! [`RunStatus::Waiting`](super::store::RunStatus::Waiting) until
//! [`LimitHit::resume_at`] instead of failing it (see
//! [`auto_resume`](super::auto_resume) for the wake-up side).
//!
//! The signal arrives as text, because every call path between the executor and
//! a provider (gateway completions, registered agents, ACP harnesses, sub-agent
//! fan-out) reports failures as strings. [`gateway_error_message`] is the one
//! place that formats a Gateway HTTP failure, so the Gateway's typed
//! `provider_rate_limited` code and its `retry_after` / `reset_at` fields survive
//! into that text in a form [`classify`] reads back exactly.

use chrono::{DateTime, Duration, TimeZone, Utc};

/// Wait used when a limit is reported without any reset time.
pub const DEFAULT_WAIT: Duration = Duration::minutes(5);

/// Never wake sooner than this, so a provider reporting `retry-after: 0` while
/// still limited cannot spin the run.
pub const MIN_WAIT: Duration = Duration::seconds(15);

/// Never park longer than this. Weekly plan windows are the longest real limit.
pub const MAX_WAIT: Duration = Duration::days(7);

/// Slack added to a provider-reported reset so the wake lands after it.
const RESET_SLACK: Duration = Duration::seconds(5);

/// A limit reported by a provider, plan, or the Gateway.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitHit {
    /// When the work should be tried again.
    pub resume_at: DateTime<Utc>,
    /// True when `resume_at` came from the error itself rather than
    /// [`DEFAULT_WAIT`].
    pub reported: bool,
}

/// Phrases that mark an error as a limit rather than a fault. Matched
/// case-insensitively. Deliberately specific: a bare "limit" also appears in
/// "wall-time limit of 120s exceeded" and "context length limit", which are
/// real failures that waiting will not fix.
const LIMIT_MARKERS: &[&str] = &[
    "http 429",
    "status 429",
    "429 too many requests",
    "too many requests",
    "rate limit",
    "rate-limit",
    "rate_limit",
    "ratelimit",
    "provider_rate_limited",
    "usage limit",
    "usage_limit",
    "session limit",
    "weekly limit",
    "daily limit",
    "hourly limit",
    "5-hour limit",
    "quota exceeded",
    "resource_exhausted",
    "resource exhausted",
];

/// Whether `error` reports a rate, usage, or session limit.
pub fn is_limit_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    LIMIT_MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Classify `error`. `None` means it is not a limit and should be handled as an
/// ordinary failure.
pub fn classify(error: &str, now: DateTime<Utc>) -> Option<LimitHit> {
    if !is_limit_error(error) {
        return None;
    }
    let lower = error.to_ascii_lowercase();
    let reported = reset_from_text(&lower, now);
    // `reported` may sit near chrono's maximum instant, so the slack is added
    // checked; anything past the representable range is past MAX_WAIT anyway.
    let resume_at = reported.map_or(now + DEFAULT_WAIT, |at| {
        at.checked_add_signed(RESET_SLACK).unwrap_or(now + MAX_WAIT)
    });
    Some(LimitHit {
        resume_at: resume_at.clamp(now + MIN_WAIT, now + MAX_WAIT),
        reported: reported.is_some(),
    })
}

/// Format a non-2xx Gateway response for an error string. Keeps the historical
/// `"<context>: gateway returned HTTP <status>"` prefix (callers map it to 503)
/// and, for a 429, appends the Gateway's error code and reset signal as
/// `retry_after=<s>s` / `reset_at=<unix seconds>` so [`classify`] can read them.
pub fn gateway_error_message(
    context: &str,
    status: reqwest::StatusCode,
    retry_after_header: Option<&str>,
    body: &str,
) -> String {
    let mut message = format!("{context}: gateway returned HTTP {status}");
    if status != reqwest::StatusCode::TOO_MANY_REQUESTS {
        return message;
    }
    let error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("error").cloned());
    let code = error
        .as_ref()
        .and_then(|e| e.get("code").or_else(|| e.get("type")))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("rate_limit");
    message.push_str(&format!(" ({code})"));
    let retry_after = error
        .as_ref()
        .and_then(|e| e.get("retry_after"))
        .and_then(serde_json::Value::as_u64)
        .or_else(|| retry_after_header.and_then(|v| v.trim().parse::<u64>().ok()));
    if let Some(seconds) = retry_after {
        message.push_str(&format!(" retry_after={seconds}s"));
    }
    if let Some(reset_at) = error
        .as_ref()
        .and_then(|e| e.get("reset_at"))
        .and_then(serde_json::Value::as_u64)
    {
        message.push_str(&format!(" reset_at={reset_at}"));
    }
    message
}

/// Pull the soonest-stated reset instant out of an already-lowercased error.
fn reset_from_text(lower: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let mut candidates: Vec<DateTime<Utc>> = Vec::new();

    // `reset_at=<unix seconds | rfc3339>` (our own Gateway format).
    for value in values_after(lower, "reset_at=") {
        if let Some(at) = parse_instant(value) {
            candidates.push(at);
        }
    }
    // `retry_after=<n>s`, `retry-after: <n>`, `retry after <duration>`,
    // `try again in <duration>`, `resets in <duration>`.
    for key in [
        "retry_after=",
        "retry-after:",
        "retry after",
        "try again in",
        "resets in",
        "reset in",
    ] {
        for value in values_after(lower, key) {
            if let Some(at) = parse_duration(value).and_then(|d| now.checked_add_signed(d)) {
                candidates.push(at);
            }
        }
    }
    // `resets at <rfc3339>`, `reset at <rfc3339>`, `resets_at: <rfc3339>`.
    for key in ["resets at", "reset at", "resets_at", "resets "] {
        for value in values_after(lower, key) {
            if let Some(at) = parse_instant(value) {
                candidates.push(at);
            }
        }
    }
    candidates.into_iter().filter(|at| *at >= now).min()
}

/// The text following every occurrence of `key`, with separators trimmed.
fn values_after<'a>(text: &'a str, key: &str) -> Vec<&'a str> {
    text.match_indices(key)
        .map(|(index, _)| text[index + key.len()..].trim_start_matches([' ', ':', '=', '"']))
        .collect()
}

/// Parse a leading Unix-seconds or RFC3339 instant.
fn parse_instant(value: &str) -> Option<DateTime<Utc>> {
    let token: String = value
        .chars()
        .take_while(|c| !c.is_whitespace() && !matches!(c, ',' | ';' | ')' | '"' | '\''))
        .collect();
    let token = token.trim_end_matches('.');
    if token.is_empty() {
        return None;
    }
    if token.chars().all(|c| c.is_ascii_digit()) {
        let seconds: i64 = token.parse().ok()?;
        // Milliseconds are 13 digits; seconds 10. Accept both.
        let seconds = if token.len() >= 13 {
            seconds / 1000
        } else {
            seconds
        };
        return Utc.timestamp_opt(seconds, 0).single();
    }
    DateTime::parse_from_rfc3339(&token.to_ascii_uppercase())
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// Parse a leading duration such as `30`, `30s`, `90 seconds`, `1h30m`,
/// `2 hours 5 minutes`. A bare number is seconds (the `Retry-After` header unit).
fn parse_duration(value: &str) -> Option<Duration> {
    let mut total = Duration::zero();
    let mut parsed_any = false;
    let mut rest = value;
    loop {
        rest = rest.trim_start();
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            break;
        }
        let amount: i64 = digits.parse().ok()?;
        rest = rest[digits.len()..].trim_start();
        let unit: String = rest.chars().take_while(char::is_ascii_alphabetic).collect();
        // The text is an upstream error (possibly a remote response body), so
        // an absurd amount must not overflow: cap each step at MAX_WAIT, which
        // `classify` clamps to anyway, and accumulate checked.
        let step = match unit.as_str() {
            "" | "s" | "sec" | "secs" | "second" | "seconds" => Duration::try_seconds(amount),
            "m" | "min" | "mins" | "minute" | "minutes" => Duration::try_minutes(amount),
            "h" | "hr" | "hrs" | "hour" | "hours" => Duration::try_hours(amount),
            "d" | "day" | "days" => Duration::try_days(amount),
            "ms" => Duration::try_milliseconds(amount),
            _ => break,
        }
        .map_or(MAX_WAIT, |step| step.min(MAX_WAIT));
        total = total.checked_add(&step)?.min(MAX_WAIT);
        parsed_any = true;
        rest = rest[unit.len()..].trim_start_matches([',', ' ']);
        if unit.is_empty() {
            break;
        }
        // "1h30m" / "2 hours and 5 minutes"
        rest = rest.strip_prefix("and ").unwrap_or(rest);
    }
    parsed_any.then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 12, 12, 0, 0).unwrap()
    }

    #[test]
    fn ordinary_failures_are_not_limits() {
        for error in [
            "sub-agent: gateway returned HTTP 502 Bad Gateway",
            "wall-time limit of 120s exceeded",
            "prompt exceeds the model's context length limit",
            "tool 'spider.crawl' failed: not found",
        ] {
            assert_eq!(classify(error, now()), None, "{error}");
        }
    }

    #[test]
    fn gateway_rate_limit_reads_the_reported_reset() {
        let body = r#"{"error":{"message":"Upstream provider rate limit reached.","type":"provider_rate_limited","code":"provider_rate_limited","retry_after":90}}"#;
        let message = gateway_error_message(
            "prompt node",
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            None,
            body,
        );
        assert!(message.starts_with("prompt node: gateway returned HTTP 429"));
        assert!(message.contains("provider_rate_limited"));
        let hit = classify(&message, now()).expect("limit");
        assert!(hit.reported);
        assert_eq!(hit.resume_at, now() + Duration::seconds(95));
    }

    #[test]
    fn unix_reset_and_header_fallback_are_understood() {
        let reset = now() + Duration::hours(3);
        let body = format!(
            r#"{{"error":{{"code":"provider_rate_limited","reset_at":{}}}}}"#,
            reset.timestamp()
        );
        let message = gateway_error_message(
            "sub-agent",
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            Some("10"),
            &body,
        );
        // The soonest stated reset wins.
        assert_eq!(
            classify(&message, now()).unwrap().resume_at,
            now() + Duration::seconds(15)
        );
        let message = format!(
            "delegate 'x' failed: usage limit reached reset_at={}",
            reset.timestamp()
        );
        assert_eq!(
            classify(&message, now()).unwrap().resume_at,
            reset + Duration::seconds(5)
        );
    }

    #[test]
    fn plan_and_session_limit_wording_is_understood() {
        let hit = classify(
            "agent 'claude' failed: Claude usage limit reached. Your limit resets at 2026-10-12T17:00:00Z.",
            now(),
        )
        .unwrap();
        assert_eq!(
            hit.resume_at,
            Utc.with_ymd_and_hms(2026, 10, 12, 17, 0, 5).unwrap()
        );
        let hit = classify("session limit hit, try again in 1h30m", now()).unwrap();
        assert_eq!(hit.resume_at, now() + Duration::minutes(90) + RESET_SLACK);
        let hit = classify("Rate limit exceeded. Please retry after 2 minutes", now()).unwrap();
        assert_eq!(hit.resume_at, now() + Duration::minutes(2) + RESET_SLACK);
    }

    #[test]
    fn unknown_or_absurd_resets_are_bounded() {
        let hit = classify("HTTP 429 Too Many Requests", now()).unwrap();
        assert!(!hit.reported);
        assert_eq!(hit.resume_at, now() + DEFAULT_WAIT);
        let hit = classify("rate limited, retry_after=0s", now()).unwrap();
        assert_eq!(hit.resume_at, now() + MIN_WAIT);
        let hit = classify("weekly limit reached, resets in 30 days", now()).unwrap();
        assert_eq!(hit.resume_at, now() + MAX_WAIT);
        // A reset already in the past is ignored rather than trusted.
        let hit = classify("usage limit reached reset_at=1000", now()).unwrap();
        assert!(!hit.reported);
    }

    #[test]
    fn overflowing_resets_are_clamped_instead_of_panicking() {
        for error in [
            "webhook node: HTTP 429 Too Many Requests: rate limit exceeded, retry after 1760000000000000",
            "rate limit, resets in 9999999999999999 days",
            "rate limit, retry after 9223372036854775807 hours 9223372036854775807 hours",
            // An instant (in milliseconds) within RESET_SLACK of chrono's maximum.
            "usage limit reached reset_at=8210266876799000",
        ] {
            let hit = classify(error, now()).unwrap();
            assert!(hit.reported, "{error}");
            assert_eq!(hit.resume_at, now() + MAX_WAIT, "{error}");
        }
    }

    #[test]
    fn non_429_gateway_errors_keep_the_historical_message() {
        assert_eq!(
            gateway_error_message(
                "prompt node",
                reqwest::StatusCode::BAD_GATEWAY,
                Some("5"),
                "{}"
            ),
            "prompt node: gateway returned HTTP 502 Bad Gateway"
        );
    }
}
