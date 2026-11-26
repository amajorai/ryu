//! The one table of credential failover rules.
//!
//! A provider request is tried with one credential at a time. This module says
//! what each kind of answer means for the credential that was used:
//!
//! | Answer                         | What happens                                     |
//! |--------------------------------|--------------------------------------------------|
//! | 2xx                            | Served. The credential stays in use.             |
//! | 429 (usage or rate limit)      | Put aside for the provider's wait hint, else 60 s (at most 32 days). The next credential is tried. |
//! | 401 or 403                     | Marked as failing for 5 minutes. The next credential is tried. |
//! | No answer (network error)      | The same credential is tried once more, then the error is returned. The credential is not put aside. |
//! | Anything else (a refusal, a bad request, a server error) | Returned as it is. No switch. |
//!
//! A decision is always made on the status line and headers, before any byte
//! of the body is passed on, so a stream that has started never changes
//! credential. The switch applies to the next call.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How long a limited credential rests when the provider gave no wait hint.
pub(crate) const DEFAULT_COOLDOWN: Duration = Duration::from_secs(60);
/// The longest rest a wait hint may ask for.
pub(crate) const MAX_COOLDOWN: Duration = Duration::from_secs(32 * 24 * 60 * 60);
/// How long a credential the provider refused (401 or 403) rests before one
/// request tries it again.
pub(crate) const FAILING_COOLDOWN: Duration = Duration::from_secs(5 * 60);
/// How many times a request that got no answer is sent again with the same
/// credential before the error is returned.
pub(crate) const SAME_CREDENTIAL_RETRIES: usize = 1;

/// What one attempt with one credential ended in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// The provider answered with success.
    Served,
    /// The credential is at its usage or rate limit (429).
    Limited,
    /// The provider refused the credential itself (401 or 403).
    Rejected,
    /// No answer arrived (connection or transport error).
    Unreachable,
    /// Any other answer: a refusal, a bad request, a server error.
    Other,
}

/// Why a credential is resting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Rest {
    Limited,
    Rejected,
}

/// What to do after one attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    /// Return this answer. Keep the credential as it is.
    Done,
    /// Send the same request again with the same credential.
    RetrySame,
    /// Rest this credential and try the next one.
    NextCredential { rest: Rest, retry_in: Duration },
}

/// Classify an HTTP status.
pub(crate) fn outcome(status: u16) -> Outcome {
    match status {
        200..=399 => Outcome::Served,
        429 => Outcome::Limited,
        401 | 403 => Outcome::Rejected,
        _ => Outcome::Other,
    }
}

/// Whether an answer means "this credential cannot serve now, try another".
pub(crate) fn moves_on(status: u16) -> bool {
    matches!(outcome(status), Outcome::Limited | Outcome::Rejected)
}

/// The rule table. `attempts` counts the tries already made with this
/// credential for this request, including the one that produced `outcome`.
pub(crate) fn step(outcome: Outcome, wait_hint: Option<Duration>, attempts: usize) -> Step {
    match outcome {
        Outcome::Served | Outcome::Other => Step::Done,
        Outcome::Limited => Step::NextCredential {
            rest: Rest::Limited,
            retry_in: wait_hint
                .filter(|wait| !wait.is_zero())
                .unwrap_or(DEFAULT_COOLDOWN)
                .min(MAX_COOLDOWN),
        },
        Outcome::Rejected => Step::NextCredential {
            rest: Rest::Rejected,
            retry_in: FAILING_COOLDOWN,
        },
        Outcome::Unreachable if attempts <= SAME_CREDENTIAL_RETRIES => Step::RetrySame,
        Outcome::Unreachable => Step::Done,
    }
}

/// The provider's wait hint: `retry-after` in whole seconds, else the latest of
/// the given RFC 3339 reset times. `None` when neither can be read.
pub(crate) fn wait_hint(
    retry_after: Option<&str>,
    reset_times: &[&str],
    now: chrono::DateTime<chrono::Utc>,
) -> Option<Duration> {
    if let Some(seconds) = retry_after.and_then(|value| value.trim().parse::<u64>().ok()) {
        return Some(Duration::from_secs(seconds));
    }
    reset_times
        .iter()
        .filter_map(|value| chrono::DateTime::parse_from_rfc3339(value.trim()).ok())
        .filter_map(|deadline| (deadline.with_timezone(&chrono::Utc) - now).to_std().ok())
        .max()
}

struct Resting {
    rest: Rest,
    until: Instant,
}

/// Which credentials are resting, by account id. Kept in memory only: a
/// restart tries every credential again.
#[derive(Default)]
pub(crate) struct Health {
    resting: HashMap<String, Resting>,
}

impl Health {
    /// Rest `account_id` for `retry_in`, counted from `now`.
    pub(crate) fn rest(&mut self, account_id: &str, rest: Rest, retry_in: Duration, now: Instant) {
        let until = now
            .checked_add(retry_in.min(MAX_COOLDOWN))
            .unwrap_or(now + DEFAULT_COOLDOWN);
        self.resting
            .insert(account_id.to_owned(), Resting { rest, until });
    }

    /// Why `account_id` is resting at `now`, or `None` when it can be used.
    pub(crate) fn resting(&self, account_id: &str, now: Instant) -> Option<Rest> {
        self.resting
            .get(account_id)
            .filter(|entry| entry.until > now)
            .map(|entry| entry.rest)
    }

    /// Whether `account_id` can be used at `now`.
    pub(crate) fn usable(&self, account_id: &str, now: Instant) -> bool {
        self.resting(account_id, now).is_none()
    }

    /// A served request ends the credential's rest.
    pub(crate) fn clear(&mut self, account_id: &str) {
        self.resting.remove(account_id);
    }

    /// Forget rests that are over and accounts that no longer exist.
    pub(crate) fn prune(&mut self, known: &[&str], now: Instant) {
        self.resting
            .retain(|id, entry| entry.until > now && known.contains(&id.as_str()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_the_documented_outcomes() {
        assert_eq!(outcome(200), Outcome::Served);
        assert_eq!(outcome(204), Outcome::Served);
        assert_eq!(outcome(429), Outcome::Limited);
        assert_eq!(outcome(401), Outcome::Rejected);
        assert_eq!(outcome(403), Outcome::Rejected);
        for status in [400, 404, 409, 413, 422, 500, 502, 503, 529] {
            assert_eq!(outcome(status), Outcome::Other, "{status}");
            assert!(!moves_on(status), "{status}");
        }
        for status in [401, 403, 429] {
            assert!(moves_on(status), "{status}");
        }
        assert!(!moves_on(200));
    }

    #[test]
    fn a_limit_moves_on_and_rests_for_the_wait_hint_or_sixty_seconds() {
        assert_eq!(
            step(Outcome::Limited, Some(Duration::from_secs(900)), 1),
            Step::NextCredential {
                rest: Rest::Limited,
                retry_in: Duration::from_secs(900),
            }
        );
        assert_eq!(
            step(Outcome::Limited, None, 1),
            Step::NextCredential {
                rest: Rest::Limited,
                retry_in: DEFAULT_COOLDOWN,
            }
        );
        // A zero hint would try the limited credential again at once.
        assert_eq!(
            step(Outcome::Limited, Some(Duration::ZERO), 1),
            Step::NextCredential {
                rest: Rest::Limited,
                retry_in: DEFAULT_COOLDOWN,
            }
        );
        assert_eq!(
            step(Outcome::Limited, Some(Duration::from_secs(u64::MAX)), 1),
            Step::NextCredential {
                rest: Rest::Limited,
                retry_in: MAX_COOLDOWN,
            }
        );
    }

    #[test]
    fn a_refused_credential_is_marked_failing_for_five_minutes_and_moves_on() {
        assert_eq!(
            step(Outcome::Rejected, Some(Duration::from_secs(3)), 1),
            Step::NextCredential {
                rest: Rest::Rejected,
                retry_in: Duration::from_secs(300),
            }
        );
    }

    #[test]
    fn a_network_error_retries_the_same_credential_once_and_never_moves_on() {
        assert_eq!(step(Outcome::Unreachable, None, 1), Step::RetrySame);
        assert_eq!(step(Outcome::Unreachable, None, 2), Step::Done);
    }

    #[test]
    fn a_refusal_a_bad_request_and_a_success_never_switch_credential() {
        assert_eq!(step(Outcome::Other, None, 1), Step::Done);
        assert_eq!(
            step(Outcome::Other, Some(Duration::from_secs(5)), 1),
            Step::Done
        );
        assert_eq!(step(Outcome::Served, None, 1), Step::Done);
    }

    #[test]
    fn the_wait_hint_prefers_retry_after_then_the_latest_reset_time() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-18T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            wait_hint(Some("30"), &["2026-11-18T13:00:00Z"], now),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            wait_hint(None, &["2026-11-18T12:01:00Z", "2026-11-18T12:10:00Z"], now),
            Some(Duration::from_secs(600))
        );
        // A date form of retry-after and a reset time in the past give no hint.
        assert_eq!(
            wait_hint(Some("Wed, 18 Nov 2026 12:05:00 GMT"), &[], now),
            None
        );
        assert_eq!(wait_hint(None, &["2026-11-18T11:00:00Z"], now), None);
        assert_eq!(wait_hint(None, &["soon"], now), None);
    }

    #[test]
    fn a_resting_credential_is_tried_again_after_its_cool_down() {
        let start = Instant::now();
        let mut health = Health::default();
        assert!(health.usable("first", start));
        health.rest("first", Rest::Limited, Duration::from_secs(60), start);
        assert_eq!(
            health.resting("first", start + Duration::from_secs(59)),
            Some(Rest::Limited)
        );
        assert!(health.usable("second", start));
        assert!(health.usable("first", start + Duration::from_secs(60)));
        health.rest("first", Rest::Rejected, FAILING_COOLDOWN, start);
        assert_eq!(
            health.resting("first", start + Duration::from_secs(299)),
            Some(Rest::Rejected)
        );
        assert!(health.usable("first", start + FAILING_COOLDOWN));
    }

    #[test]
    fn a_served_request_and_a_removed_account_end_the_rest() {
        let start = Instant::now();
        let mut health = Health::default();
        health.rest("first", Rest::Limited, Duration::from_secs(600), start);
        health.rest("gone", Rest::Rejected, Duration::from_secs(600), start);
        health.prune(&["first"], start);
        assert!(health.usable("gone", start));
        assert!(!health.usable("first", start));
        health.clear("first");
        assert!(health.usable("first", start));
    }
}
