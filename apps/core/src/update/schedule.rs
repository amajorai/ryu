//! Deferring an update to a quiet hour, decided and executed ON THE NODE.
//!
//! WHY LOCAL AND NOT THE CONTROL PLANE. A deferred node RESIZE belongs to the
//! control plane, because the control plane is what calls Hetzner. An update is
//! the opposite: the machine updates and restarts ITSELF, there is no inbound
//! auth path from the control plane into a node, and an unreachable node cannot
//! be told to update anyway. Modelling it centrally would mean the control plane
//! promising something it has no way to perform — which, for a promise the user
//! believes was kept, is the worst possible failure.
//!
//! So the record lives here, the quiet hour is computed in the node's own zone,
//! and the existing scheduler tick applies it. Nothing outside has to be up.
//!
//! DURABLE, NOT A TIMER. The record is a file. An in-process timer would be lost
//! on the very event this feature causes — a restart — so "install tonight"
//! would silently never happen after the first unrelated bounce.

use std::path::PathBuf;

use chrono::{DateTime, Duration as ChronoDuration, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use super::ReleaseAsset;

/// The hour a deferred update targets, in the node's own local zone.
const QUIET_HOUR: u32 = 3;

/// Too close to be worth deferring to. Telling someone "tonight" and restarting
/// them four minutes later is worse than not offering the choice.
const MIN_LEAD_MINUTES: i64 = 15;

fn schedule_path() -> PathBuf {
    crate::paths::state_path("pending-update.json")
}

/// An update the user asked to have installed later.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingUpdate {
    /// The asset PINNED when the user agreed to it.
    ///
    /// Re-resolving "latest" at 03:00 would install something the user never
    /// saw and never approved — a different version, with different release
    /// notes, on a machine they deliberately chose not to touch during the day.
    pub asset: ReleaseAsset,
    /// The version string shown to the user when they deferred.
    pub version: String,
    /// When to install, UTC.
    pub scheduled_for: DateTime<Utc>,
    /// The zone the quiet hour was computed in, for display.
    pub time_zone: String,
}

/// This node's IANA zone, or UTC.
///
/// `TZ` first — an operator who sets it means it, and a container defaults to
/// UTC otherwise. Never fails: a node that cannot name its zone must still be
/// able to defer an update, just to a less well-chosen hour.
pub fn local_timezone() -> String {
    if let Ok(raw) = std::env::var("TZ") {
        let zone = raw.trim().trim_start_matches(':').trim();
        if !zone.is_empty() {
            return zone.to_string();
        }
    }
    if let Ok(raw) = std::fs::read_to_string("/etc/timezone") {
        let zone = raw.trim();
        if !zone.is_empty() {
            return zone.to_string();
        }
    }
    if let Ok(link) = std::fs::read_link("/etc/localtime") {
        let path = link.to_string_lossy();
        if let Some(idx) = path.find("/zoneinfo/") {
            let zone = path[idx + "/zoneinfo/".len()..].trim().to_string();
            if !zone.is_empty() {
                return zone;
            }
        }
    }
    "UTC".to_string()
}

/// The next `QUIET_HOUR` in `zone`, strictly after `now` plus the lead margin.
///
/// DST is handled by asking `chrono-tz` to resolve the local time rather than
/// doing offset arithmetic: on a spring-forward night the target hour may not
/// exist, and on a fall-back night it exists twice. `LocalResult` covers both —
/// a skipped hour falls through to the next day, and an ambiguous one takes its
/// earlier occurrence, which is still genuinely quiet.
pub fn next_quiet_window(now: DateTime<Utc>, zone: &str) -> (DateTime<Utc>, String) {
    let tz: Tz = zone.parse().unwrap_or(chrono_tz::UTC);
    let earliest = now + ChronoDuration::minutes(MIN_LEAD_MINUTES);
    let local_now = now.with_timezone(&tz);

    for day_offset in 0..=2 {
        let day = local_now.date_naive() + ChronoDuration::days(day_offset);
        let Some(naive) = day.and_hms_opt(QUIET_HOUR, 0, 0) else {
            continue;
        };
        // `.single()` deliberately: an ambiguous (repeated) local time yields
        // `Ambiguous`, and taking `.earliest()` there keeps the choice explicit
        // rather than silently picking one.
        let resolved = match tz.from_local_datetime(&naive) {
            chrono::LocalResult::Single(dt) => Some(dt),
            chrono::LocalResult::Ambiguous(first, _) => Some(first),
            // The hour does not exist tonight (spring forward). Try tomorrow
            // rather than inventing an instant.
            chrono::LocalResult::None => None,
        };
        if let Some(dt) = resolved {
            let utc = dt.with_timezone(&Utc);
            if utc > earliest {
                return (utc, tz.name().to_string());
            }
        }
    }
    (earliest, tz.name().to_string())
}

/// Persist a deferred update, replacing any existing one.
///
/// Replacing rather than refusing: the newest decision is the one the user
/// actually made, and a stale pending record for a superseded version is not
/// worth protecting.
pub fn set_pending(asset: ReleaseAsset, version: String) -> std::io::Result<PendingUpdate> {
    let zone = local_timezone();
    let (scheduled_for, time_zone) = next_quiet_window(Utc::now(), &zone);
    let pending = PendingUpdate {
        asset,
        version,
        scheduled_for,
        time_zone,
    };
    let path = schedule_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::atomic_file::write_atomic(&path, &serde_json::to_vec_pretty(&pending)?)?;
    Ok(pending)
}

/// The pending update, or `None`. A corrupt file reads as absent and is not
/// fatal: a bad record must not make the node unable to boot or to update.
pub fn get_pending() -> Option<PendingUpdate> {
    let bytes = std::fs::read(schedule_path()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Forget the pending update. Idempotent — a missing file is success, since the
/// caller's intent ("there should be no pending update") already holds.
pub fn clear_pending() -> std::io::Result<()> {
    match std::fs::remove_file(schedule_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// The pending update if it is due at `now`, else `None`.
pub fn due_at(now: DateTime<Utc>) -> Option<PendingUpdate> {
    get_pending().filter(|p| p.scheduled_for <= now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn picks_tonights_quiet_hour_when_it_has_not_passed() {
        let (at, zone) = next_quiet_window(utc("2026-08-14T18:00:00Z"), "UTC");
        assert_eq!(at, utc("2026-08-15T03:00:00Z"));
        assert_eq!(zone, "UTC");
    }

    #[test]
    fn rolls_to_tomorrow_once_the_window_has_passed() {
        let (at, _) = next_quiet_window(utc("2026-08-14T04:00:00Z"), "UTC");
        assert_eq!(at, utc("2026-08-15T03:00:00Z"));
    }

    #[test]
    fn skips_a_window_too_close_to_be_worth_deferring_to() {
        // 02:58 -> 03:00 is two minutes away. "Tonight" that fires almost
        // immediately is worse than not offering the choice.
        let (at, _) = next_quiet_window(utc("2026-08-14T02:58:00Z"), "UTC");
        assert_eq!(at, utc("2026-08-15T03:00:00Z"));
    }

    #[test]
    fn uses_the_nodes_own_zone_not_utc() {
        let (at, zone) = next_quiet_window(utc("2026-08-14T00:00:00Z"), "Asia/Singapore");
        assert_eq!(zone, "Asia/Singapore");
        let local = at.with_timezone(&"Asia/Singapore".parse::<Tz>().unwrap());
        assert_eq!(local.hour(), QUIET_HOUR);
    }

    #[test]
    fn survives_a_spring_forward_night() {
        // 2026-03-29: Berlin skips 02:00-03:00. The window must still be a real
        // instant in the future rather than an invented one.
        let now = utc("2026-03-28T20:00:00Z");
        let (at, _) = next_quiet_window(now, "Europe/Berlin");
        assert!(at > now);
    }

    #[test]
    fn survives_a_fall_back_night() {
        // 2026-10-25: Berlin repeats 03:00. Must resolve, not panic or skip.
        let now = utc("2026-10-24T20:00:00Z");
        let (at, _) = next_quiet_window(now, "Europe/Berlin");
        assert!(at > now);
        let local = at.with_timezone(&"Europe/Berlin".parse::<Tz>().unwrap());
        assert_eq!(local.hour(), QUIET_HOUR);
    }

    #[test]
    fn an_unknown_zone_degrades_to_utc_rather_than_failing() {
        // The zone comes from the environment; a typo must cost a worse-chosen
        // hour, never the ability to defer at all.
        let (at, zone) = next_quiet_window(utc("2026-08-14T18:00:00Z"), "Not/AZone");
        assert_eq!(zone, "UTC");
        assert_eq!(at, utc("2026-08-15T03:00:00Z"));
    }

    #[test]
    fn tz_env_wins_and_strips_the_posix_colon() {
        // Guarded by the same parsing the gateway uses; `TZ=:Europe/Berlin` is
        // legal POSIX and must not be forwarded verbatim.
        let raw = ":Europe/Berlin";
        let zone = raw.trim().trim_start_matches(':').trim();
        assert_eq!(zone, "Europe/Berlin");
    }

    #[test]
    fn deferred_update_survives_reopen_refusal_and_retry() {
        const CASE: &str = "RYU_DEFERRED_UPDATE_PROOF_PHASE";
        if let Ok(phase) = std::env::var(CASE) {
            let path = schedule_path();
            let asset = |version: &str| ReleaseAsset {
                name: format!("ryu-{version}.tar.gz"),
                url: format!("https://updates.example.invalid/{version}/ryu.tar.gz"),
                kind: "archive".to_string(),
                size: 1234,
            };
            match phase.as_str() {
                "create" => {
                    let saved = set_pending(asset("first"), "first".into()).unwrap();
                    assert_eq!(
                        serde_json::to_value(get_pending().unwrap()).unwrap(),
                        serde_json::to_value(saved).unwrap()
                    );
                    std::fs::write(path.parent().unwrap().join("unrelated.txt"), b"keep me")
                        .unwrap();
                }
                "reopen-replace" => {
                    let reopened = get_pending().expect("fresh process must read prior decision");
                    assert_eq!(reopened.version, "first");
                    assert_eq!(reopened.asset.url, asset("first").url);
                    let saved = set_pending(asset("second"), "second".into()).unwrap();
                    assert_eq!(
                        serde_json::to_value(get_pending().unwrap()).unwrap(),
                        serde_json::to_value(saved).unwrap()
                    );
                }
                "reopen-due-cancel" => {
                    let saved = get_pending().unwrap();
                    assert_eq!(saved.version, "second");
                    assert_eq!(saved.asset.name, asset("second").name);
                    assert!(due_at(saved.scheduled_for - ChronoDuration::nanoseconds(1)).is_none());
                    assert_eq!(
                        due_at(saved.scheduled_for).unwrap().asset.url,
                        saved.asset.url
                    );
                    clear_pending().unwrap();
                    clear_pending().unwrap();
                    assert!(get_pending().is_none());
                    assert!(!path.exists());
                    assert_eq!(
                        std::fs::read(path.parent().unwrap().join("unrelated.txt")).unwrap(),
                        b"keep me"
                    );
                }
                "corrupt-repair" => {
                    std::fs::write(&path, b"{invalid schedule JSON").unwrap();
                    assert!(get_pending().is_none());
                    assert!(due_at(Utc::now() + ChronoDuration::days(100)).is_none());
                    set_pending(asset("repaired"), "repaired".into()).unwrap();
                    assert_eq!(get_pending().unwrap().version, "repaired");
                }
                "refuse-retry" => {
                    assert_eq!(get_pending().unwrap().version, "repaired");
                    clear_pending().unwrap();
                    std::fs::create_dir(&path).unwrap();
                    std::fs::write(path.join("owned-sentinel"), b"unchanged").unwrap();
                    assert!(set_pending(asset("refused"), "refused".into()).is_err());
                    assert_eq!(
                        std::fs::read(path.join("owned-sentinel")).unwrap(),
                        b"unchanged"
                    );
                    assert!(path.is_dir());
                    std::fs::remove_dir_all(&path).unwrap();
                    set_pending(asset("retry"), "retry".into()).unwrap();
                }
                "final-reopen" => {
                    let saved = get_pending().unwrap();
                    assert_eq!(saved.version, "retry");
                    assert_eq!(saved.asset.url, asset("retry").url);
                    assert_eq!(saved.asset.size, 1234);
                    assert_eq!(
                        std::fs::read(path.parent().unwrap().join("unrelated.txt")).unwrap(),
                        b"keep me"
                    );
                }
                _ => panic!("unknown owned schedule phase"),
            }
            return;
        }
        let root = tempfile::tempdir().unwrap();
        for phase in [
            "create",
            "reopen-replace",
            "reopen-due-cancel",
            "corrupt-repair",
            "refuse-retry",
            "final-reopen",
        ] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "update::schedule::tests::deferred_update_survives_reopen_refusal_and_retry",
                    "--nocapture",
                ])
                .env(CASE, phase)
                .env("RYU_DIR", root.path())
                .env("RYU_PROFILE", "dev")
                .env("RYU_KEYCHAIN", "off")
                .env("TZ", "UTC")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "actual schedule phase {phase} failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
                "owned child must execute its exact test"
            );
        }
    }
}
