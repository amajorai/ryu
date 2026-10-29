//! User presence as the desktop reports it, resolved for Core-side policy.
//!
//! The desktop owns availability (AFK detection needs window focus and input
//! events), but only Core can decide whether an agent's question blocks the turn.
//! The desktop therefore heartbeats its resolved status here, and Core resolves
//! the effective status for question routing:
//!
//! - never reported (headless, CLI, TUI): **online**, which keeps the historical
//!   blocking behaviour for clients that never opted into presence;
//! - reported but stale (desktop closed or asleep): **away**, since nobody is
//!   there to answer a blocking question;
//! - otherwise the reported status, with Core-detected gaming and streaming layered on top.
//!
//! Every desktop window reports separately (each has its own idle clock), so an
//! idle second window cannot mark the user away while they work in the first.
//! Fresh reports merge by availability: a manual choice (do-not-disturb, streaming, gaming)
//! is shared by every window, and otherwise any window that is online wins.
//!
//! Precedence: do-not-disturb > streaming > gaming > online > away. Streaming
//! detection also activates a separate Connect-suggestion privacy guard, even
//! when Do not disturb remains the displayed status.

#[path = "streaming.rs"]
pub mod streaming;

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// A report older than this no longer counts as "someone is here". The desktop
/// heartbeats well inside it.
pub const REPORT_TTL: Duration = Duration::from_secs(150);

/// Upper bound on remembered clients, so an unbounded stream of client ids
/// cannot grow the map forever. The oldest report is evicted first.
const MAX_CLIENTS: usize = 32;

/// Client id used when a report does not name its window.
const DEFAULT_CLIENT: &str = "default";

/// Availability states shared with the desktop's `AgentAvailabilityStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PresenceStatus {
    Online,
    Away,
    DoNotDisturb,
    Gaming,
    Streaming,
}

impl PresenceStatus {
    /// Merge priority across windows; lower wins.
    fn merge_rank(self) -> u8 {
        match self {
            Self::DoNotDisturb => 0,
            Self::Streaming => 1,
            Self::Gaming => 2,
            Self::Online => 3,
            Self::Away => 4,
        }
    }
}

/// Where the effective status came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PresenceSource {
    /// No client has reported presence yet.
    Default,
    /// The desktop's latest report.
    Reported,
    /// The desktop stopped reporting; treated as away.
    Stale,
    /// Core detected a running game.
    Game,
    /// Core detected a configured streaming app.
    Stream,
}

#[derive(Debug, Clone, Copy)]
struct Report {
    status: PresenceStatus,
    at: Instant,
}

static REPORTS: RwLock<Option<HashMap<String, Report>>> = RwLock::new(None);
/// Shared nodes cannot use user presence to defer questions, but a desktop's
/// Streaming choice still enables the node-wide Connect privacy shield.
static STREAMING_PRIVACY_REPORTS: RwLock<Option<HashMap<String, Instant>>> = RwLock::new(None);

fn normalized_client_id(client_id: Option<&str>) -> String {
    client_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or(DEFAULT_CLIENT)
        .chars()
        .take(64)
        .collect()
}

/// Effective presence plus gaming and streaming details behind it.
#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PresenceSnapshot {
    pub status: PresenceStatus,
    pub source: PresenceSource,
    /// Agent questions are non-blocking right now.
    pub questions_deferred: bool,
    pub gaming: crate::gaming::GamingSnapshot,
    pub streaming: streaming::StreamingSnapshot,
}

/// Record one desktop window's resolved status. Returns the new snapshot.
pub fn report(client_id: Option<&str>, status: PresenceStatus) -> PresenceSnapshot {
    let now = Instant::now();
    let previous = merged_report(now);
    let client = normalized_client_id(client_id);
    if let Ok(mut guard) = REPORTS.write() {
        let reports = guard.get_or_insert_with(HashMap::new);
        reports.retain(|_, report| now.saturating_duration_since(report.at) < REPORT_TTL);
        if !reports.contains_key(&client) && reports.len() >= MAX_CLIENTS {
            if let Some(oldest) = reports
                .iter()
                .min_by_key(|(_, report)| report.at)
                .map(|(id, _)| id.clone())
            {
                reports.remove(&oldest);
            }
        }
        reports.insert(client, Report { status, at: now });
    }
    if merged_report(now) != previous {
        crate::gaming::notify_changed();
    }
    snapshot()
}

/// Record a Streaming privacy signal from a desktop on a shared node. This does
/// not affect question routing or the merged presence status.
pub fn report_streaming_privacy(client_id: Option<&str>, active: bool) {
    let now = Instant::now();
    let client = normalized_client_id(client_id);
    if let Ok(mut guard) = STREAMING_PRIVACY_REPORTS.write() {
        let reports = guard.get_or_insert_with(HashMap::new);
        reports.retain(|_, at| now.saturating_duration_since(*at) < REPORT_TTL);
        if active {
            if !reports.contains_key(&client) && reports.len() >= MAX_CLIENTS {
                if let Some(oldest) = reports
                    .iter()
                    .min_by_key(|(_, at)| *at)
                    .map(|(id, _)| id.clone())
                {
                    reports.remove(&oldest);
                }
            }
            reports.insert(client, now);
        } else {
            reports.remove(&client);
        }
    }
}

/// Merge every window's report. `None` = nobody ever reported (or every report
/// was evicted); `Some((status, fresh))` otherwise.
fn merged_report(now: Instant) -> Option<(PresenceStatus, bool)> {
    let guard = REPORTS.read().ok()?;
    let reports = guard.as_ref()?;
    merge_reports(reports.values().copied(), now)
}

fn merge_reports(
    reports: impl Iterator<Item = Report>,
    now: Instant,
) -> Option<(PresenceStatus, bool)> {
    let mut any = false;
    let mut best: Option<PresenceStatus> = None;
    for report in reports {
        any = true;
        if now.saturating_duration_since(report.at) >= REPORT_TTL {
            continue;
        }
        if best.is_none_or(|current| report.status.merge_rank() < current.merge_rank()) {
            best = Some(report.status);
        }
    }
    match best {
        Some(status) => Some((status, true)),
        None if any => Some((PresenceStatus::Away, false)),
        None => None,
    }
}

/// The desktop's fresh reports chose Gaming.
pub fn reported_gaming() -> bool {
    merged_report(Instant::now()) == Some((PresenceStatus::Gaming, true))
}

/// Whether any fresh desktop window has manually selected Streaming.
pub fn reported_streaming() -> bool {
    let now = Instant::now();
    let status_report = REPORTS.read().ok().is_some_and(|guard| {
        guard.as_ref().is_some_and(|reports| {
            reports.values().any(|report| {
                report.status == PresenceStatus::Streaming
                    && now.saturating_duration_since(report.at) < REPORT_TTL
            })
        })
    });
    status_report
        || STREAMING_PRIVACY_REPORTS.read().ok().is_some_and(|guard| {
            guard.as_ref().is_some_and(|reports| {
                reports
                    .values()
                    .any(|at| now.saturating_duration_since(*at) < REPORT_TTL)
            })
        })
}

/// Whether Connect suggestions must be generic and their event data withheld
/// from model analysis.
pub fn streaming_privacy_active() -> bool {
    streaming::detected_app().is_some() || reported_streaming()
}

/// Resolve the effective status. Pure over its inputs so precedence is testable.
fn resolve(
    report: Option<(PresenceStatus, bool)>,
    game_detected: bool,
    streaming_detected: bool,
) -> (PresenceStatus, PresenceSource) {
    let base = match report {
        None => (PresenceStatus::Online, PresenceSource::Default),
        Some((_, false)) => (PresenceStatus::Away, PresenceSource::Stale),
        Some((status, true)) => (status, PresenceSource::Reported),
    };
    if base.0 == PresenceStatus::DoNotDisturb {
        return base;
    }
    if base.0 == PresenceStatus::Streaming {
        return base;
    }
    if streaming_detected {
        return (PresenceStatus::Streaming, PresenceSource::Stream);
    }
    if game_detected {
        return (PresenceStatus::Gaming, PresenceSource::Game);
    }
    base
}

/// Current effective presence.
pub fn snapshot() -> PresenceSnapshot {
    let (status, source) = resolve(
        merged_report(Instant::now()),
        crate::gaming::detected_game().is_some(),
        streaming::detected_app().is_some(),
    );
    PresenceSnapshot {
        status,
        source,
        questions_deferred: status != PresenceStatus::Online,
        gaming: crate::gaming::snapshot(),
        streaming: streaming::snapshot(),
    }
}

/// Whether an agent question should be asynchronous right now: nobody is
/// available to answer, so blocking the turn would only stall the agent.
pub fn questions_deferred() -> bool {
    snapshot().questions_deferred
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(status: PresenceStatus, age: Duration, now: Instant) -> Report {
        Report {
            status,
            at: now.checked_sub(age).unwrap_or(now),
        }
    }

    #[test]
    fn unreported_presence_keeps_blocking_questions() {
        assert_eq!(
            resolve(None, false, false),
            (PresenceStatus::Online, PresenceSource::Default)
        );
    }

    #[test]
    fn stale_report_counts_as_away() {
        assert_eq!(
            resolve(Some((PresenceStatus::Online, false)), false, false),
            (PresenceStatus::Away, PresenceSource::Stale)
        );
    }

    #[test]
    fn detected_game_overrides_online_and_away_but_not_dnd() {
        assert_eq!(
            resolve(Some((PresenceStatus::Online, true)), true, false).0,
            PresenceStatus::Gaming
        );
        assert_eq!(
            resolve(Some((PresenceStatus::Away, true)), true, false).0,
            PresenceStatus::Gaming
        );
        assert_eq!(
            resolve(Some((PresenceStatus::DoNotDisturb, true)), true, false).0,
            PresenceStatus::DoNotDisturb
        );
    }

    #[test]
    fn an_idle_second_window_does_not_mark_the_user_away() {
        let now = Instant::now();
        let merged = merge_reports(
            [
                at(PresenceStatus::Away, Duration::from_secs(5), now),
                at(PresenceStatus::Online, Duration::from_secs(40), now),
            ]
            .into_iter(),
            now,
        );
        assert_eq!(merged, Some((PresenceStatus::Online, true)));
    }

    #[test]
    fn stale_windows_are_ignored_and_all_stale_means_away() {
        let now = Instant::now();
        let merged = merge_reports(
            [
                at(
                    PresenceStatus::Online,
                    REPORT_TTL + Duration::from_secs(1),
                    now,
                ),
                at(PresenceStatus::Away, Duration::from_secs(1), now),
            ]
            .into_iter(),
            now,
        );
        assert_eq!(merged, Some((PresenceStatus::Away, true)));
        let all_stale = merge_reports(
            [at(PresenceStatus::Online, REPORT_TTL, now)].into_iter(),
            now,
        );
        assert_eq!(all_stale, Some((PresenceStatus::Away, false)));
    }

    #[test]
    fn status_wire_names_match_the_desktop() {
        assert_eq!(
            serde_json::to_value(PresenceStatus::DoNotDisturb).unwrap(),
            serde_json::json!("do-not-disturb")
        );
        assert_eq!(
            serde_json::from_value::<PresenceStatus>(serde_json::json!("gaming")).unwrap(),
            PresenceStatus::Gaming
        );
        assert_eq!(
            serde_json::to_value(PresenceStatus::Streaming).unwrap(),
            serde_json::json!("streaming")
        );
    }

    #[test]
    fn streaming_detection_overrides_gaming_but_not_do_not_disturb_display() {
        assert_eq!(
            resolve(Some((PresenceStatus::Gaming, true)), true, true),
            (PresenceStatus::Streaming, PresenceSource::Stream)
        );
        assert_eq!(
            resolve(Some((PresenceStatus::DoNotDisturb, true)), false, true),
            (PresenceStatus::DoNotDisturb, PresenceSource::Reported)
        );
        assert_eq!(
            resolve(Some((PresenceStatus::Away, true)), false, true),
            (PresenceStatus::Streaming, PresenceSource::Stream)
        );
        assert_eq!(
            resolve(Some((PresenceStatus::Streaming, true)), false, false),
            (PresenceStatus::Streaming, PresenceSource::Reported)
        );
    }

    #[test]
    fn streaming_report_wins_across_windows_below_do_not_disturb() {
        let now = Instant::now();
        let reports = [
            at(PresenceStatus::Online, Duration::from_secs(3), now),
            at(PresenceStatus::Gaming, Duration::from_secs(2), now),
            at(PresenceStatus::Streaming, Duration::from_secs(1), now),
        ];
        assert_eq!(
            merge_reports(reports.into_iter(), now),
            Some((PresenceStatus::Streaming, true))
        );
        let with_dnd = [
            at(PresenceStatus::Streaming, Duration::from_secs(1), now),
            at(PresenceStatus::DoNotDisturb, Duration::from_secs(2), now),
        ];
        assert_eq!(
            merge_reports(with_dnd.into_iter(), now),
            Some((PresenceStatus::DoNotDisturb, true))
        );
    }
}
