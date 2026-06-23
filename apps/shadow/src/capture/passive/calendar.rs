//! Calendar capture — surfaces upcoming calendar events (track 11).
//!
//! Portable + nothing-hardcoded: point `SHADOW_CALENDAR_ICS` at an iCalendar
//! (`.ics`) file — the format every major calendar (Google, Apple, Outlook,
//! Fastmail) can export or sync to disk. This source polls it and emits one event
//! per upcoming meeting (today/tomorrow), deduped by UID+start so a meeting is not
//! re-emitted every poll. No native calendar API or extra crate required.

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_secs(10 * 60);

struct VEvent {
    uid: String,
    summary: String,
    start: String, // raw DTSTART value (YYYYMMDD[THHMMSS[Z]])
}

/// Unfold folded lines (continuations begin with a space/tab) then collect VEVENTs.
fn parse_ics(text: &str) -> Vec<VEvent> {
    let mut unfolded: Vec<String> = Vec::new();
    for line in text.lines() {
        if (line.starts_with(' ') || line.starts_with('\t')) && !unfolded.is_empty() {
            unfolded.last_mut().unwrap().push_str(line.trim_start());
        } else {
            unfolded.push(line.to_string());
        }
    }

    let mut events = Vec::new();
    let mut cur: Option<VEvent> = None;
    for line in unfolded {
        if line.starts_with("BEGIN:VEVENT") {
            cur = Some(VEvent {
                uid: String::new(),
                summary: String::new(),
                start: String::new(),
            });
        } else if line.starts_with("END:VEVENT") {
            if let Some(ev) = cur.take() {
                if !ev.start.is_empty() {
                    events.push(ev);
                }
            }
        } else if let Some(ev) = cur.as_mut() {
            // Property name is everything before the first ':' (params use ';').
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let key = name.split(';').next().unwrap_or(name);
            match key {
                "UID" => ev.uid = value.to_string(),
                "SUMMARY" => ev.summary = value.to_string(),
                "DTSTART" => ev.start = value.to_string(),
                _ => {}
            }
        }
    }
    events
}

/// Extract the `YYYYMMDD` date prefix from a DTSTART value.
fn date_prefix(start: &str) -> Option<String> {
    let digits: String = start.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 8 {
        Some(digits[..8].to_string())
    } else {
        None
    }
}

fn ics_path() -> Option<PathBuf> {
    std::env::var("SHADOW_CALENDAR_ICS")
        .ok()
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Start calendar monitoring on a dedicated thread (no-op unless an ICS path is set).
pub fn start() {
    let Some(path) = ics_path() else {
        tracing::info!(
            "Calendar capture idle on track {} — set SHADOW_CALENDAR_ICS to an .ics file to enable",
            super::TRACK_CALENDAR
        );
        return;
    };

    std::thread::Builder::new()
        .name("shadow-calendar".into())
        .spawn(move || {
            tracing::info!("Calendar capture started ({})", path.display());
            let mut seen: HashSet<String> = HashSet::new();
            loop {
                if !crate::server::is_capture_paused() {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        let today = chrono::Local::now().format("%Y%m%d").to_string();
                        let tomorrow = (chrono::Local::now() + chrono::Duration::days(1))
                            .format("%Y%m%d")
                            .to_string();
                        for ev in parse_ics(&text) {
                            let Some(day) = date_prefix(&ev.start) else {
                                continue;
                            };
                            if day != today && day != tomorrow {
                                continue;
                            }
                            let dedup = format!("{}|{}", ev.uid, ev.start);
                            if !seen.insert(dedup) {
                                continue;
                            }
                            let summary = if ev.summary.is_empty() {
                                "(untitled event)".to_string()
                            } else {
                                ev.summary.clone()
                            };
                            let text = format!("{} @ {}", summary, ev.start);
                            super::emit(
                                super::TRACK_CALENDAR,
                                "calendar_event",
                                "Calendar",
                                &super::truncate(&text, 512),
                                vec![
                                    ("summary", rmpv::Value::from(summary)),
                                    ("start", rmpv::Value::from(ev.start.clone())),
                                    ("uid", rmpv::Value::from(ev.uid)),
                                ],
                            );
                        }
                        // Keep the dedup set from growing without bound across days.
                        if seen.len() > 4096 {
                            seen.clear();
                        }
                    }
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        })
        .ok();
}
