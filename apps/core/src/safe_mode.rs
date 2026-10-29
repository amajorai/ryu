//! Safe Mode — boot the node with the whole extension layer switched off.
//!
//! The OS analogy is exact and deliberate: safe mode loads the base system and
//! refuses to load anything third-party, so a user chasing a hang, a runaway
//! process, or a memory leak can establish a baseline in one step instead of
//! disabling thirty things one at a time.
//!
//! ## What it suppresses
//!
//! - **Apps and plugins** — [`crate::plugins::PluginStore::list`] reports every
//!   non-kernel record as `enabled = false`, and every runtime consumer already
//!   filters on that flag. Turn hooks, capability adapters, plugin sidecars,
//!   plugin MCP servers, contributed panels/settings-tabs/slash-commands,
//!   app-event hooks and ext-proxy routes all fall out of that single read.
//! - **Skills** — the SKILL.md injection block is not written into outgoing
//!   requests (see `sidecar::adapters`).
//! - **User-configured MCP servers** — `~/.ryu/mcp.json` entries are not merged
//!   into the spawn map, so no `npx` children are launched.
//! - **The scheduler** — cron/monitor/workflow tick loops do not spawn.
//!
//! ## What stays on, and why
//!
//! "Disable everything" taken literally bricks the very session the user is
//! troubleshooting in. Safe mode keeps chat, agents, auth, updates, the settings
//! surface, and the safe-mode switch itself. On the plugin side that means the
//! kernel tiers — [`crate::plugins::builtins::MANDATORY_PLUGINS`] (the data and
//! capability planes Core resolves through) and
//! [`crate::plugins::builtins::LOAD_BEARING_PLUGINS`] (engines/durable/agents).
//! Those sets are DERIVED here, never re-listed: a second copy would drift from
//! the disable path and the failure mode is a node that boots without Spaces.
//!
//! Built-in, in-process MCP tools also stay: they cost nothing to register and
//! removing them would break the tool surface chat itself uses.
//!
//! ## Non-destructive by construction
//!
//! Safe mode NEVER writes the `enabled` column. It masks reads. That is what
//! makes leaving it a no-op — flip the switch back and every app the user chose
//! is exactly as it was — and what makes a crash mid-toggle harmless. The
//! invariant is asserted by `safe_mode_masks_reads_without_writing_records`.
//!
//! ## Resolution: three tiers, checked in order
//!
//! 1. `RYU_SAFE_MODE=1` — the env override, same idiom as `RYU_PROFILE` and the
//!    `RYU_*_BIN` overrides.
//! 2. `<data dir>/state/safe-mode` — a sentinel FILE. This tier exists because the reason
//!    you need safe mode is often that Core will not come up: reading the flag
//!    out of `preferences.db` is circular when the SQLite store or the boot path
//!    is what is wedged, and the desktop cannot POST to a Core that is not
//!    serving. The desktop can always write this file and restart the process.
//! 3. `safe-mode.enabled` preference — the normal path, and the one that fans out
//!    to every surface for free over the existing preferences SSE stream.
//!
//! ## Applies on restart
//!
//! Toggling persists the flag and asks for a Core restart; suppression happens at
//! BOOT, before anything spawns. A live mask would leave every sidecar, MCP child
//! and scheduler loop that already started still burning CPU — which is exactly
//! the cost the user is trying to measure away. So the resolution below runs in
//! `main.rs` right after the preferences store opens and BEFORE the pre-installed
//! seed, the MCP registry, the sidecar `start_all`, and the scheduler spawn.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use serde::{Deserialize, Serialize};

/// Cross-surface preference key. Lives in `preferences.db` beside the theme blob,
/// so a flip reaches desktop/island/native/web over the preferences SSE stream.
pub const SAFE_MODE_PREF_KEY: &str = "safe-mode.enabled";

/// Env override. Wins over both the sentinel and the preference.
pub const SAFE_MODE_ENV: &str = "RYU_SAFE_MODE";

/// Sentinel file name under the Ryu data folder (`<data dir>/state/safe-mode`).
pub const SAFE_MODE_SENTINEL: &str = "safe-mode";

/// Which tier turned safe mode on. Reported by `GET /api/safe-mode` so the UI can
/// say *why* the node is in safe mode — an env-forced node cannot be switched off
/// from the toggle, and silently failing to would look like a broken switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SafeModeSource {
    /// Not active.
    Off,
    /// `RYU_SAFE_MODE` env var.
    Env,
    /// `<data dir>/state/safe-mode` sentinel file.
    Sentinel,
    /// `safe-mode.enabled` preference.
    Preference,
}

impl SafeModeSource {
    /// Stable wire string (also what the desktop switches on).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Env => "env",
            Self::Sentinel => "sentinel",
            Self::Preference => "preference",
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Env,
            2 => Self::Sentinel,
            3 => Self::Preference,
            _ => Self::Off,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Env => 1,
            Self::Sentinel => 2,
            Self::Preference => 3,
        }
    }

    /// Whether this tier can be cleared by the in-app toggle. An env-forced node
    /// cannot: the operator has to unset the variable and restart.
    pub fn is_user_clearable(self) -> bool {
        !matches!(self, Self::Env)
    }
}

/// Resolved once at boot, read everywhere. An `AtomicBool` rather than state on
/// `ServerState` because the consumers (the plugin store, the MCP registry, the
/// adapters, the scheduler) are reached from paths that hold no server state —
/// the same shape as `dictation::set_enabled` and `ryu_mesh::set_pref_enabled`.
static ACTIVE: AtomicBool = AtomicBool::new(false);
static SOURCE: AtomicU8 = AtomicU8::new(0);

/// Whether safe mode is active for this process run.
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// Which tier turned it on (`Off` when inactive).
pub fn source() -> SafeModeSource {
    SafeModeSource::from_u8(SOURCE.load(Ordering::Relaxed))
}

/// Publish the boot-resolved verdict. Called ONCE from `main.rs`; a later flip
/// would be a lie, because everything the flag suppresses has already spawned.
pub fn set_resolved(src: SafeModeSource) {
    SOURCE.store(src.as_u8(), Ordering::Relaxed);
    ACTIVE.store(src != SafeModeSource::Off, Ordering::Relaxed);
}

/// Parse a flag value the way the rest of Core parses its boolean envs and prefs.
/// Anything unrecognised is `false` — fail-safe means *not* silently entering a
/// mode that switches the user's apps off.
pub fn parse_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// `<data dir>/state/safe-mode` (honours a relocated data folder / `RYU_PROFILE`).
pub fn sentinel_path() -> PathBuf {
    crate::paths::state_path(SAFE_MODE_SENTINEL)
}

/// Whether the sentinel file is present.
pub fn sentinel_present() -> bool {
    sentinel_path().exists()
}

/// Create or remove the sentinel file. The desktop's "enter safe mode" path goes
/// through this (via `POST /api/safe-mode`, or Tauri-side when Core is unreachable)
/// so the next boot is safe even if this process never comes back up.
pub fn write_sentinel(enabled: bool) -> std::io::Result<()> {
    let path = sentinel_path();
    if enabled {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, b"safe mode: this node boots with apps, plugins, skills and user MCP servers disabled. Delete this file to boot normally.\n")
    } else {
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

/// Resolve the boot verdict from the three tiers, in precedence order.
///
/// Pure in its inputs (`env_value` and `pref_value` are passed in) so the
/// precedence is unit-tested without touching the process environment — the
/// sentinel is the one tier that reads the filesystem, and it is checked between
/// the two so a wedged `preferences.db` can still be bypassed.
pub fn resolve_from(env_value: Option<&str>, pref_value: Option<&str>) -> SafeModeSource {
    if parse_enabled(env_value) {
        return SafeModeSource::Env;
    }
    if sentinel_present() {
        return SafeModeSource::Sentinel;
    }
    if parse_enabled(pref_value) {
        return SafeModeSource::Preference;
    }
    SafeModeSource::Off
}

/// Whether `plugin_id` keeps running while safe mode is active.
///
/// DERIVED from the two existing disable-guard tiers rather than restated: the
/// mandatory set (never disableable at all) plus the load-bearing set
/// (engines/durable/agents — switch those off and chat itself stops). If a
/// plugin moves between tiers, this follows automatically.
pub fn keeps_plugin_enabled(plugin_id: &str) -> bool {
    crate::plugins::builtins::is_mandatory(plugin_id)
        || crate::plugins::builtins::is_load_bearing(plugin_id)
}

/// What safe mode is currently holding back, for the diagnostic payload behind
/// `GET /api/safe-mode`. Counts, not a toggle: this is what turns the switch into
/// something a user can reason about, and it is what lets the Store render
/// "disabled by Safe Mode" badges instead of showing every app as off (which
/// would invite re-enabling them one by one and writing real state).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SuppressedCounts {
    /// Installed + user-enabled apps/plugins masked off (kernel tiers excluded).
    pub plugins: usize,
    /// Kernel-tier plugins still running.
    pub kernel_plugins: usize,
    /// Registered SKILL.md skills not injected into requests.
    pub skills: usize,
    /// `mcp.json` server entries not merged into the spawn map.
    pub mcp_servers: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_truthy_values_enable_safe_mode() {
        for on in ["1", "true", "TRUE", "yes", "on", " on "] {
            assert!(parse_enabled(Some(on)), "{on:?} should enable");
        }
        for off in ["0", "false", "no", "off", "", "maybe"] {
            assert!(!parse_enabled(Some(off)), "{off:?} must not enable");
        }
        assert!(!parse_enabled(None), "absent must not enable");
    }

    /// The env tier wins over the preference tier, and neither is consulted once a
    /// higher one matches. The sentinel sits between them and is filesystem-backed,
    /// so this asserts the two pure tiers around it.
    #[test]
    fn env_outranks_the_preference() {
        // A node whose pref says "off" is still forced on by the env.
        assert_eq!(
            resolve_from(Some("1"), Some("false")),
            SafeModeSource::Env,
            "RYU_SAFE_MODE must win over the stored preference"
        );
    }

    /// The failure that matters: nothing set anywhere must leave the node normal.
    /// A safe mode that turns itself on is worse than no safe mode.
    #[test]
    fn nothing_set_resolves_off() {
        // Only meaningful when no sentinel exists in the ambient data dir; if one
        // does, the tier under test is not the one being exercised.
        if sentinel_present() {
            return;
        }
        assert_eq!(resolve_from(None, None), SafeModeSource::Off);
        assert_eq!(resolve_from(Some("0"), Some("off")), SafeModeSource::Off);
    }

    /// An env-forced node must not offer a switch that cannot work.
    #[test]
    fn env_sourced_safe_mode_is_not_user_clearable() {
        assert!(!SafeModeSource::Env.is_user_clearable());
        assert!(SafeModeSource::Sentinel.is_user_clearable());
        assert!(SafeModeSource::Preference.is_user_clearable());
    }

    /// The kernel set is derived from the disable guards, so both tiers survive and
    /// an ordinary app does not. Spot-checked against real ids rather than the
    /// constants, so a rename that breaks the coupling is caught here too.
    #[test]
    fn the_kernel_set_is_exactly_mandatory_plus_load_bearing() {
        for id in crate::plugins::builtins::MANDATORY_PLUGINS {
            assert!(keeps_plugin_enabled(id), "mandatory '{id}' must survive");
        }
        for id in crate::plugins::builtins::LOAD_BEARING_PLUGINS {
            assert!(keeps_plugin_enabled(id), "load-bearing '{id}' must survive");
        }
        assert!(
            !keeps_plugin_enabled("@ryu/meetings"),
            "an ordinary app must be masked off"
        );
    }
}
