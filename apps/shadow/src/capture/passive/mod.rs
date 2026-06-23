//! Passive capture sources — clipboard, filesystem, git, terminal, notifications,
//! and calendar. These complement the always-on AV/input/window streams owned by
//! [`crate::capture_engine::CaptureEngine`].
//!
//! Each source runs as an independent, non-fatal background task: a failure in one
//! (e.g. no clipboard access, calendar unsupported on the platform) warns and is
//! skipped without affecting the others or blocking chat. Every source emits the
//! same v2 MessagePack envelope used elsewhere (`shadow_core::write_event`) on its
//! own track, so events flow into the raw log + timeline index automatically.
//!
//! Track allocation (1=visual, 2=input, 3=window, 4=audio, 5=AX are pre-existing):
//! - 6  clipboard
//! - 7  filesystem
//! - 8  git
//! - 9  terminal (ingested via the shell hook → `/ingest`)
//! - 10 notifications
//! - 11 calendar

pub mod calendar;
pub mod clipboard;
pub mod fs;
pub mod git;
pub mod notifications;
pub mod terminal;

use std::collections::HashMap;
use std::path::PathBuf;

pub const TRACK_CLIPBOARD: u8 = 6;
pub const TRACK_FILESYSTEM: u8 = 7;
pub const TRACK_GIT: u8 = 8;
pub const TRACK_TERMINAL: u8 = 9;
pub const TRACK_NOTIFICATION: u8 = 10;
pub const TRACK_CALENDAR: u8 = 11;

/// Start every passive capture source. Each is independently fault-isolated; this
/// never returns an error so a missing capability cannot abort startup.
pub fn start_all(data_dir: PathBuf) {
    clipboard::start();
    fs::start();
    git::start();
    terminal::start(&data_dir);
    notifications::start();
    calendar::start();
    tracing::info!(
        "✓ Passive capture sources started (clipboard/fs/git/terminal/notifications/calendar)"
    );
}

/// Current wall-clock time in Unix microseconds (the `ts` unit used by all events).
pub fn now_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

/// Truncate `text` to at most `max` characters (not bytes), appending an ellipsis
/// when cut. Keeps event payloads bounded for noisy sources like the clipboard.
pub fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// Emit a passive-capture event on `track`.
///
/// `source` is stored as `app_name` (the timeline/search "lane" label) and `text`
/// as `window_title` — both fields the timeline index already persists for every
/// track and the search indexer reads, so the event is timeline-visible and
/// full-text searchable with no schema change. `extra` carries source-specific
/// structured fields. Respects the global capture-pause flag.
pub fn emit(
    track: u8,
    event_type: &str,
    source: &str,
    text: &str,
    extra: Vec<(&'static str, rmpv::Value)>,
) {
    if crate::server::is_capture_paused() {
        return;
    }
    let mut map: HashMap<&str, rmpv::Value> = HashMap::new();
    map.insert("ts", rmpv::Value::from(now_micros()));
    map.insert("v", rmpv::Value::from(2u8));
    map.insert("track", rmpv::Value::from(track));
    map.insert("type", rmpv::Value::from(event_type));
    map.insert("app_name", rmpv::Value::from(source));
    if !text.is_empty() {
        map.insert("window_title", rmpv::Value::from(text));
    }
    for (k, v) in extra {
        map.insert(k, v);
    }
    if let Ok(data) = rmp_serde::to_vec(&map) {
        let _ = shadow_core::write_event(data);
    }
}
