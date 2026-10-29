//! The desktop half of the midnight auto-wipe: the one place the user's choice
//! is stored, and the only place it may be written.
//!
//! Core owns the behaviour (`apps/core/src/midnight_wipe.rs`) — it arms the node
//! reset at boot when a calendar day has turned. This module owns the SETTING,
//! because the setting has to live somewhere both sides can see and the wipe
//! cannot destroy:
//!
//!   * NOT `preferences.db` — that file is INSIDE the directory being wiped, so a
//!     user's "turn this off" would be erased by the next wipe it failed to stop.
//!   * NOT localStorage — every channel ships the same bundle identifier
//!     (`ai.amajor.ryu.desktop`), so a webview store is shared with the stable
//!     install rather than scoped to canary.
//!
//! So it is a small JSON file in the OS config dir, next to `data-path.json`,
//! profile-suffixed exactly like Core's `paths::config_dir()`. Core reads it; this
//! side writes `enabled` and never touches `last_wipe_date`.
//!
//! The write path is fail-closed in the direction that matters: a profile that
//! cannot be wiped (release, dev, beta — anything not canary/nightly) cannot have
//! the flag ENABLED at all. Turning it off is always allowed.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Must match `apps/core/src/midnight_wipe.rs::STATE_FILE`. Asserted literally on
/// both sides; nothing else connects the two crates.
pub const STATE_FILE: &str = "midnight-wipe.json";

/// Must match Core's `midnight_wipe::WIPE_PROFILES` — and, by construction, the
/// profiles a prerelease bundle activates for itself
/// (`profile::VERSION_ACTIVATED_PROFILES`). Core enforces this again on its own
/// side; this copy only decides whether the UI may offer the switch.
pub const WIPE_PROFILES: &[&str] = &["canary", "nightly"];

/// `<os-config>/ryu{suffix}/` — the mirror of Core's `paths::config_dir()`.
///
/// `None` when the OS config dir cannot be resolved. Core falls back to the data
/// dir in that case; this side deliberately does not, because a state file inside
/// the wiped root is exactly what Core's `StateInsideWipedRoot` guard refuses —
/// so writing one would just produce a setting that silently never applies.
fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(format!("ryu{}", crate::profile::suffix())))
}

fn state_path() -> Option<PathBuf> {
    config_dir().map(|d| d.join(STATE_FILE))
}

/// The on-disk shape. `last_wipe_date` is Core's field: it is read and written
/// back unchanged so toggling the switch never re-arms a wipe that already ran
/// today.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct MidnightWipeState {
    #[serde(default)]
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_wipe_date: Option<String>,
}

fn read_state() -> MidnightWipeState {
    let Some(path) = state_path() else {
        return MidnightWipeState::default();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return MidnightWipeState::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn write_state(state: &MidnightWipeState) -> Result<(), String> {
    let path = state_path().ok_or_else(|| {
        "could not resolve this machine's config directory, so the setting has nowhere to live"
            .to_string()
    })?;
    let parent = path
        .parent()
        .ok_or_else(|| "midnight-wipe state path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    // Core reads this file at boot and writes it atomically; an in-place write
    // here could be observed half-written (parsed as default) or, if
    // interrupted, drop Core's `last_wipe_date` so a toggle re-arms a wipe that
    // already ran today.
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut staged, &json).map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged
        .persist(&path)
        .map(|_| ())
        .map_err(|e| e.error.to_string())
}

/// True when the running build's profile is one the wipe may ever target.
fn profile_supports_wipe(profile: &str) -> bool {
    WIPE_PROFILES.contains(&profile)
}

/// What the settings row needs to render itself.
#[derive(Debug, Serialize)]
pub struct MidnightWipeStatus {
    /// Whether this build may offer the setting at all. `false` on stable and dev
    /// — the row is hidden, not merely disabled, because there is nothing it
    /// could do.
    pub supported: bool,
    /// The active profile (`canary`, `nightly`, `release`, …). The row labels
    /// itself with this rather than hardcoding "canary".
    pub profile: String,
    pub enabled: bool,
    /// The data folder that would be wiped, shown in the row's description so the
    /// user can see WHICH directory a "yes" applies to.
    pub data_dir: String,
    /// Where the flag itself is stored (outside `data_dir`).
    pub state_file: String,
    /// `YYYY-MM-DD` of the last wipe, when one has run.
    pub last_wipe_date: Option<String>,
}

fn status_from(state: &MidnightWipeState) -> MidnightWipeStatus {
    let profile = crate::profile::name();
    MidnightWipeStatus {
        supported: profile_supports_wipe(&profile),
        enabled: state.enabled,
        data_dir: crate::profile::ryu_home_dir()
            .to_string_lossy()
            .into_owned(),
        state_file: state_path()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        last_wipe_date: state.last_wipe_date.clone(),
        profile,
    }
}

#[tauri::command]
pub fn get_midnight_wipe() -> MidnightWipeStatus {
    status_from(&read_state())
}

/// Persist the flag. Refuses to ENABLE it on a profile that shares the stable
/// data folder — that is the whole point of the guard, and a Tauri command is
/// callable from anything running in the webview, so it is enforced here too and
/// not only in the UI that hides the row.
#[tauri::command]
pub fn set_midnight_wipe(enabled: bool) -> Result<MidnightWipeStatus, String> {
    let profile = crate::profile::name();
    if enabled && !profile_supports_wipe(&profile) {
        return Err(format!(
			"the daily data wipe is only available on the {} builds — the '{profile}' profile shares its data folder with your stable install",
			WIPE_PROFILES.join(" and ")
		));
    }
    let current = read_state();
    let next = MidnightWipeState {
        enabled,
        last_wipe_date: current.last_wipe_date,
    };
    write_state(&next)?;
    Ok(status_from(&next))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cross-crate contract. Core composes `<config>/ryu{suffix}/<file>` from
    /// its own constants; if either literal drifts, the desktop writes a flag Core
    /// never reads and the switch does nothing at all — silently.
    #[test]
    fn the_state_file_contract_matches_core() {
        assert_eq!(STATE_FILE, "midnight-wipe.json");
        assert_eq!(WIPE_PROFILES, &["canary", "nightly"]);
        let Some(path) = state_path() else {
            return; // No config dir on this machine; nothing to assert.
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

    /// The setting may only be offered where the profile guarantees an isolated
    /// data folder — and every profile it IS offered on must be one this bundle
    /// can actually activate from its own version.
    #[test]
    fn only_the_isolated_prerelease_profiles_support_a_wipe() {
        assert!(profile_supports_wipe("canary"));
        assert!(profile_supports_wipe("nightly"));
        for profile in ["release", "dev", "beta", "", "typo", "Canary", " canary"] {
            assert!(
                !profile_supports_wipe(profile),
                "'{profile}' must not be offered a data wipe"
            );
        }
        for profile in WIPE_PROFILES {
            assert_eq!(
				crate::profile::profile_for_version(&format!("0.1.12-{profile}.20260813.36")),
				Some(*profile),
				"a {profile} bundle must actually activate the {profile} profile, or the wipe would target ~/.ryu"
			);
        }
    }

    /// The state file must never be inside the directory the wipe deletes.
    #[test]
    fn the_state_file_lives_outside_the_data_folder() {
        let Some(path) = state_path() else {
            return;
        };
        assert!(
            !path.starts_with(crate::profile::ryu_home_dir()),
            "the wipe would delete its own off switch"
        );
    }
}
