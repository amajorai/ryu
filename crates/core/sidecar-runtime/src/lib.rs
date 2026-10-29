//! Small, framework-neutral helpers for Ryu-managed sidecar boundaries.
//!
//! Domain sidecars still own their routes, stores, and liveness semantics. This
//! crate keeps the repeated security/process substrate—fail-closed bearer checks,
//! Core-compatible data-directory resolution, and profile-aware sibling-sidecar
//! ports—in one place.

pub mod branding;
#[cfg(feature = "handoff")]
pub mod handoff;
pub mod layout;
pub mod mcp_protocol;
#[cfg(feature = "peer-proof")]
pub mod peer_proof;

use std::path::PathBuf;
use std::sync::OnceLock;

const RYU_DIR_ENV: &str = "RYU_DIR";
pub const RYU_PROFILE_ENV: &str = "RYU_PROFILE";
pub const RYU_PORT_OFFSET_ENV: &str = "RYU_PORT_OFFSET";
pub const RELEASE_PROFILE: &str = "release";
pub const DEV_PORT_OFFSET: u16 = 1000;
pub const PROFILE_PORT_OFFSETS: &[(&str, u16)] = &[
    (RELEASE_PROFILE, 0),
    ("dev", DEV_PORT_OFFSET),
    ("canary", 2000),
    ("nightly", 3000),
    ("beta", 4000),
];

/// Find the canonical port offset for a named Ryu profile.
#[must_use]
pub fn profile_port_offset_for(profile: &str) -> Option<u16> {
    PROFILE_PORT_OFFSETS
        .iter()
        .find(|(name, _)| *name == profile)
        .map(|(_, offset)| *offset)
}

/// Port offset for a validated profile name. Panics only for an unknown profile.
#[must_use]
pub fn profile_port_offset_for_known(profile: &str) -> u16 {
    profile_port_offset_for(profile).unwrap_or_else(|| {
        let known = PROFILE_PORT_OFFSETS
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>()
            .join(", ");
        panic!("unknown ryu profile '{profile}' (known: {known})")
    })
}

/// Return the profile-specific data/config suffix. `release` is unsuffixed.
#[must_use]
pub fn profile_suffix_for(profile: &str) -> String {
    if profile == RELEASE_PROFILE {
        String::new()
    } else {
        format!("-{profile}")
    }
}

/// Add a previously resolved profile offset to a canonical port.
#[must_use]
pub fn profiled_port_with_offset(base: u16, offset: u16) -> u16 {
    base.saturating_add(offset)
}

/// Resolve a canonical port for a named profile.
#[must_use]
pub fn profiled_port_for(base: u16, profile: &str) -> u16 {
    profiled_port_with_offset(base, profile_port_offset_for_known(profile))
}

/// Resolve the active profile's port offset, respecting an explicit
/// `RYU_PORT_OFFSET` override before the shared profile table.
#[must_use]
pub fn profile_port_offset() -> u16 {
    std::env::var(RYU_PORT_OFFSET_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|offset| *offset <= 50_000)
        .unwrap_or_else(|| {
            let profile = std::env::var(RYU_PROFILE_ENV)
                .ok()
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| RELEASE_PROFILE.to_owned());
            profile_port_offset_for_known(&profile)
        })
}

/// Return the profile-aware sidecar port used by Core's manifest-sidecar manager.
#[must_use]
pub fn profiled_port(base: u16) -> u16 {
    profiled_port_with_offset(base, profile_port_offset())
}

/// Constant-time equality for shared secrets and webhook signatures.
#[must_use]
pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right) {
        difference |= a ^ b;
    }
    difference == 0
}

/// Check a complete `Authorization` header against an expected sidecar token.
/// Missing/empty expected tokens fail closed.
#[must_use]
pub fn bearer_ok(auth_header: Option<&str>, expected: Option<&str>) -> bool {
    let provided = auth_header.and_then(|value| value.strip_prefix("Bearer "));
    token_ok(provided, expected)
}

/// Check an already-parsed bearer value against an expected sidecar token.
///
/// Fail-closed: a missing or empty expected token rejects everything, so a
/// misconfigured spawn never becomes an open loopback endpoint. Only the exact
/// token passes (no prefix or extension), compared in constant time.
#[must_use]
pub fn token_ok(provided: Option<&str>, expected: Option<&str>) -> bool {
    let Some(expected) = expected.filter(|value| !value.is_empty()) else {
        return false;
    };
    constant_time_eq(provided.unwrap_or("").as_bytes(), expected.as_bytes())
}

/// The active profile's data/config/keychain suffix (`""` on release, `"-dev"` on
/// dev), resolved from `RYU_PROFILE` exactly as Core resolves it. Standalone
/// processes use it to find the same profile-scoped keychain slot as Core.
///
/// # Panics
/// On an unknown `RYU_PROFILE`, like every other profile-aware resolver here.
#[must_use]
pub fn active_profile_suffix() -> String {
    profile_suffix()
}

fn profile_suffix() -> String {
    let profile = std::env::var(RYU_PROFILE_ENV)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| RELEASE_PROFILE.to_owned());
    profile_port_offset_for_known(&profile);
    profile_suffix_for(&profile)
}

fn default_data_dir() -> PathBuf {
    let name = format!(".ryu{}", profile_suffix());
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(name)
}

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(default_data_dir)
        .join(format!("ryu{}", profile_suffix()))
}

#[derive(Debug, Default, serde::Deserialize)]
struct DataPathPointer {
    #[serde(default)]
    data_dir: Option<String>,
}

fn resolve_data_dir() -> PathBuf {
    if let Some(value) = std::env::var_os(RYU_DIR_ENV) {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    let pointer_path = config_dir().join("data-path.json");
    if let Ok(bytes) = std::fs::read(pointer_path) {
        if let Some(value) = serde_json::from_slice::<DataPathPointer>(&bytes)
            .ok()
            .and_then(|pointer| pointer.data_dir)
        {
            let path = PathBuf::from(value);
            if !path.as_os_str().is_empty() {
                return path;
            }
        }
    }
    default_data_dir()
}

/// Resolve the same profile-aware, pointer-aware data directory Core passes to
/// its managed sidecars. The result is cached for the process lifetime.
#[must_use]
pub fn ryu_dir() -> PathBuf {
    static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
    DATA_DIR.get_or_init(resolve_data_dir).clone()
}

/// This plugin's own data dir: `RYU_PLUGIN_DATA_DIR` (set by Core on every
/// plugin sidecar), else `<ryu_dir>/plugin-data/<dir>` for a standalone run.
/// Created on first use is the caller's job.
#[must_use]
pub fn plugin_data_dir(plugin_id: &str) -> PathBuf {
    std::env::var_os(layout::RYU_PLUGIN_DATA_DIR_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| layout::plugin_data_dir(&ryu_dir(), plugin_id))
}

/// The shared `models/` root: `RYU_MODELS_DIR` (set by Core) else
/// `<ryu_dir>/models`.
#[must_use]
pub fn models_root() -> PathBuf {
    std::env::var_os(layout::RYU_MODELS_DIR_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| layout::models_root(&ryu_dir()))
}

#[cfg(test)]
mod tests {
    use super::{
        bearer_ok, constant_time_eq, profile_port_offset, profile_port_offset_for,
        profile_suffix_for, profiled_port, profiled_port_for, ryu_dir, token_ok,
    };

    #[test]
    fn bearer_checks_fail_closed_and_require_the_scheme() {
        assert!(bearer_ok(Some("Bearer secret"), Some("secret")));
        assert!(!bearer_ok(Some("secret"), Some("secret")));
        assert!(!bearer_ok(Some("Bearer wrong"), Some("secret")));
        assert!(!bearer_ok(None, None));
        assert!(!token_ok(Some("secret"), Some("")));
    }

    #[test]
    fn token_ok_accepts_only_the_exact_nonempty_token() {
        assert!(token_ok(Some("secret"), Some("secret")));
        assert!(!token_ok(Some("other"), Some("secret")));
        assert!(!token_ok(Some("secre"), Some("secret")));
        assert!(!token_ok(Some("secretx"), Some("secret")));
        assert!(!token_ok(None, Some("secret")));
        assert!(!token_ok(Some(""), Some("secret")));
        assert!(!token_ok(Some("secret"), None));
        assert!(!token_ok(Some(""), Some("")));
        assert!(!token_ok(None, None));
    }

    #[test]
    fn constant_time_equality_matches_value_and_length() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"ab", b"abc"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn data_directory_is_non_empty() {
        assert!(!ryu_dir().as_os_str().is_empty());
    }

    #[test]
    fn sibling_sidecar_ports_use_the_shared_profile_offsets() {
        assert_eq!(profiled_port_for(8087, "release"), 8087);
        assert_eq!(profiled_port_for(8087, "dev"), 9087);
        assert_eq!(profiled_port_for(8087, "canary"), 10_087);
        assert_eq!(profiled_port_for(u16::MAX, "release"), u16::MAX);
        assert_eq!(profile_port_offset_for("unknown"), None);
        assert_eq!(profile_suffix_for("release"), "");
        assert_eq!(profile_suffix_for("dev"), "-dev");
    }

    #[test]
    fn active_sidecar_port_matches_the_current_core_profile() {
        let base = 8087;
        assert_eq!(
            profiled_port(base),
            base.saturating_add(profile_port_offset())
        );
    }
}
