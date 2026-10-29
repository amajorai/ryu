//! A desktop-app update the user asked to have installed later, and the only
//! place that record is stored.
//!
//! WHY THIS EXISTS SEPARATELY FROM CORE'S. `apps/core/src/update/schedule.rs`
//! defers a NODE's update: a server that is genuinely up at 03:00, whose own
//! 30s scheduler tick applies the record. This is the other half of the same
//! idea for the app bundle, and the difference in what can be PROMISED is the
//! whole design:
//!
//!   * A node is awake at the quiet hour, so "installs at 03:00" is true there.
//!   * A laptop is asleep, or quit, or both. Nothing in this bundle registers a
//!     calendar or wake launch — `tauri-plugin-autostart` is launch-at-LOGIN,
//!     not launch-at-a-TIME — so the app cannot promise to be running then.
//!
//! So the honest promise is "the next time you open Ryu after the window", with
//! an immediate install if the app does happen to be running and awake at the
//! hour. `due_at` is a WALL-CLOCK comparison for exactly that reason: a
//! monotonic timer does not advance across system sleep, so only comparing the
//! stored instant against the current time survives a closed lid. Late is fine;
//! never is not.
//!
//! WHERE THE RECORD LIVES, and the two directories it must not be in — the same
//! reasoning as `midnight_wipe.rs`:
//!
//!   * NOT `profile::ryu_home_dir()` (`~/.ryu{suffix}`). That is Core's data
//!     dir, and Core's own record is `state/pending-update.json` inside it. A
//!     desktop record there would collide with Core's on a local node — two
//!     different deferrals, one file, and whichever wrote last wins.
//!   * NOT localStorage. Every channel ships the same bundle identifier
//!     (`ai.amajor.ryu.desktop`), so a webview store is shared with the stable
//!     install rather than scoped to canary — and it is also inside the folder
//!     the midnight wipe deletes.
//!
//! So: a small JSON file in the OS config dir, profile-suffixed, with a
//! basename that cannot be confused with Core's.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Deliberately NOT `pending-update.json` — that is Core's, in a directory the
/// desktop can also resolve. The distinct basename is the collision guard.
pub const STATE_FILE: &str = "pending-app-update.json";

/// `<os-config>/ryu{suffix}/` — the mirror of Core's `paths::config_dir()`, and
/// the same directory `midnight_wipe.rs` writes to.
///
/// `None` when the OS config dir cannot be resolved. There is deliberately no
/// fallback to the data dir: that is the one location this record must not be
/// in, so a machine without a config dir simply cannot defer, and the caller is
/// told so rather than being handed a record that silently collides.
fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(format!("ryu{}", crate::profile::suffix())))
}

fn state_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(STATE_FILE))
}

/// An app update booked for the machine's next quiet hour.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAppUpdate {
    /// The whole update verdict the user was shown, PINNED verbatim.
    ///
    /// Opaque here on purpose — this side stores it, the webview interprets it —
    /// but storing the WHOLE verdict rather than just a version string is what
    /// makes the pin real. Re-checking at the window would resolve the static
    /// feed to whatever is newest THEN, which is a different build with different
    /// release notes on a machine the user deliberately chose not to touch.
    pub verdict: serde_json::Value,
    /// The version named to the user when they deferred. Duplicated out of the
    /// verdict so the row can render without parsing it.
    pub version: String,
    /// The instant to install at, epoch milliseconds UTC.
    ///
    /// Computed by the caller, in the machine's own local zone. Stored as an
    /// absolute instant rather than "03:00" so a DST change between booking and
    /// the window cannot move it, and so the comparison below needs no timezone
    /// database on this side.
    pub scheduled_for_ms: i64,
    /// The zone the quiet hour was computed in, for display only.
    pub time_zone: String,
}

/// Wall-clock now, epoch milliseconds. Returns 0 if the system clock is before
/// the Unix epoch, which reads as "nothing is due yet" — the safe direction.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The booked update, or `None`.
///
/// A corrupt or unreadable file reads as absent and is never fatal: a bad
/// record must not be able to stop the app from launching or from updating
/// normally.
#[tauri::command]
pub fn get_pending_app_update() -> Option<PendingAppUpdate> {
    let path = state_path()?;
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Persist a booked update, replacing any existing one.
///
/// Replacing rather than refusing: the newest decision is the one the user
/// actually made, and a stale record for a superseded version is not worth
/// protecting. (Core's `set_pending` makes the same choice for the same reason.)
#[tauri::command]
pub fn set_pending_app_update(
    window: tauri::Window,
    pending: PendingAppUpdate,
) -> Result<PendingAppUpdate, String> {
    crate::app_update::require_update_window(window.label())?;
    if pending.scheduled_for_ms <= 0
        || pending.version.trim().is_empty()
        || pending.time_zone.trim().is_empty()
    {
        return Err("Invalid deferred update time, version, or time zone".into());
    }
    let path = state_path().ok_or_else(|| {
		"could not resolve this machine's config directory, so a deferred update has nowhere to live"
			.to_string()
	})?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    ryu_runtime_install::handoff::write_json(&path, &pending).map_err(|e| e.to_string())?;
    Ok(pending)
}

/// Forget the booked update. Idempotent — a missing file is success, because
/// the caller's intent ("there should be no pending update") already holds.
///
/// CLEARED BEFORE THE INSTALL, NEVER AFTER. Installing replaces the running
/// bundle and relaunches, so no "clear on success" line ever executes. A record
/// that survived its own install would come due again on the next launch and
/// reinstall forever. Clearing first costs a genuine failure one missed window
/// instead of a restart loop — the same trade Core's scheduler makes.
#[tauri::command]
pub fn clear_pending_app_update(window: tauri::Window) -> Result<(), String> {
    crate::app_update::require_update_window(window.label())?;
    let Some(path) = state_path() else {
        return Ok(());
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// The booked update if its window has passed, else `None`.
///
/// `<=`, not `==` or a tolerance band: the app is usually NOT running at the
/// quiet hour, so a due record is normally noticed hours late at the next
/// launch. Anything that required the check to land near the instant would mean
/// the deferral simply never happened on a laptop.
#[tauri::command]
pub fn due_app_update() -> Option<PendingAppUpdate> {
    get_pending_app_update().filter(|p| p.scheduled_for_ms <= now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(scheduled_for_ms: i64) -> PendingAppUpdate {
        PendingAppUpdate {
            verdict: serde_json::json!({ "latest": "0.1.5", "tag": "v0.1.5" }),
            version: "0.1.5".to_string(),
            scheduled_for_ms,
            time_zone: "Europe/Berlin".to_string(),
        }
    }

    /// The collision this basename exists to prevent. Core's record is
    /// `paths::state_path("pending-update.json")`, and the desktop can
    /// resolve that same directory — so sharing the name would mean a local
    /// node's Core deferral and the app's own deferral overwriting each other.
    #[test]
    fn the_record_cannot_collide_with_cores() {
        assert_ne!(STATE_FILE, "pending-update.json");
        assert_eq!(STATE_FILE, "pending-app-update.json");
        let Some(path) = state_path() else {
            return; // No config dir on this machine; nothing to assert.
        };
        assert!(
            !path.starts_with(crate::profile::ryu_home_dir()),
            "the record must not live in Core's data folder"
        );
    }

    /// Profile-suffixed like every other cross-surface file, so a canary install
    /// does not book an update for the stable one.
    #[test]
    fn the_record_is_scoped_to_this_profile() {
        let Some(path) = state_path() else {
            return;
        };
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(STATE_FILE));
        let parent = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str());
        assert_eq!(
            parent,
            Some(format!("ryu{}", crate::profile::suffix()).as_str())
        );
    }

    /// The pin has to survive the round trip: what installs at the window is the
    /// verdict the user agreed to, not a re-resolved one.
    #[test]
    fn the_pinned_verdict_survives_serialization() {
        let pending = sample(1_800_000_000_000);
        let bytes = serde_json::to_vec(&pending).expect("serializes");
        let back: PendingAppUpdate = serde_json::from_slice(&bytes).expect("round-trips");
        assert_eq!(back.version, "0.1.5");
        assert_eq!(back.scheduled_for_ms, 1_800_000_000_000);
        assert_eq!(back.time_zone, "Europe/Berlin");
        assert_eq!(back.verdict["tag"], "v0.1.5");
    }

    /// A record whose file is garbage must read as absent. The alternative — a
    /// hard error at launch — would make a corrupt byte able to stop the app.
    #[test]
    fn a_corrupt_record_reads_as_absent() {
        let parsed: Result<PendingAppUpdate, _> = serde_json::from_slice(b"{ not json");
        assert!(parsed.is_err());
        let as_option: Option<PendingAppUpdate> = parsed.ok();
        assert!(as_option.is_none());
    }

    /// Late is due. The app is normally not running at the quiet hour, so the
    /// overwhelmingly common case is noticing the record hours or days after the
    /// instant it names.
    #[test]
    fn a_window_that_passed_long_ago_is_still_due() {
        let now = now_ms();
        let long_past = sample(now - 3 * 24 * 60 * 60 * 1000);
        assert!(long_past.scheduled_for_ms <= now);
        let future = sample(now + 60 * 60 * 1000);
        assert!(future.scheduled_for_ms > now);
    }
}
