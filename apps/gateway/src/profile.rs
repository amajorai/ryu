//! `RYU_PROFILE` — profile-aware bind/config for the gateway (mirrors
//! `apps/core/src/profile.rs`).
//!
//! When Core spawns the gateway it passes an explicit `--bind` and sets
//! `GATEWAY_CONFIG`, both already profile-offset by Core. This module makes a
//! **standalone** gateway run (`ryu-gateway` launched directly with
//! `RYU_PROFILE=dev`) land on the same offset port and its own config file, so a
//! dev gateway never collides with or reads a release gateway's state.
//!
//! `RYU_PROFILE` defaults to `"release"` — byte-identical to today: offset 0, the
//! original `0.0.0.0:7981` bind, and `<config>/ryu/gateway.toml`.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Env var naming the active profile. Unset / empty ⇒ `"release"`.
pub const RYU_PROFILE_ENV: &str = "RYU_PROFILE";

/// The canonical release profile — zero offset, no suffix.
pub const RELEASE_PROFILE: &str = "release";

/// Port offset applied for any non-release profile. Kept in lockstep with
/// `apps/core/src/profile.rs::DEV_PORT_OFFSET`.
pub const DEV_PORT_OFFSET: u16 = 1000;

fn resolve() -> String {
    std::env::var(RYU_PROFILE_ENV)
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| RELEASE_PROFILE.to_owned())
}

static PROFILE: OnceLock<String> = OnceLock::new();

/// The active profile, resolved once and cached.
pub fn profile() -> &'static str {
    PROFILE.get_or_init(resolve)
}

fn is_release() -> bool {
    profile() == RELEASE_PROFILE
}

/// Port offset for the active profile (0 on release, [`DEV_PORT_OFFSET`] else).
pub fn port_offset() -> u16 {
    if is_release() {
        0
    } else {
        DEV_PORT_OFFSET
    }
}

/// `base + offset` (saturating). The single offset source, matching Core.
pub fn port(base: u16) -> u16 {
    base.saturating_add(port_offset())
}

/// Data-dir / config-dir suffix (`""` on release, `-<profile>` otherwise).
pub fn suffix() -> String {
    if is_release() {
        String::new()
    } else {
        format!("-{}", profile())
    }
}

/// The profile-aware default bind used by `config.rs::default_bind` for a
/// standalone gateway (release `0.0.0.0:7981`, dev `0.0.0.0:8981`, …).
pub fn default_bind() -> String {
    format!("0.0.0.0:{}", port(7981))
}

/// The profile-aware fallback config path (`<config>/ryu{suffix}/gateway.toml`)
/// used by `config.rs::config_path` when `GATEWAY_CONFIG` is unset. Matches Core's
/// `gateway_config_path` reader per profile.
pub fn default_config_path() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join(format!("ryu{}", suffix())).join("gateway.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // These assert relationships that hold regardless of which profile the test
    // process resolved to (RYU_PROFILE is process-global + cached in a OnceLock, so
    // we never set it here — we pin the offset invariants instead).

    #[test]
    fn dev_offset_is_a_thousand() {
        assert_eq!(DEV_PORT_OFFSET, 1000);
    }

    #[test]
    fn offset_is_zero_or_dev_offset() {
        let off = port_offset();
        assert!(off == 0 || off == DEV_PORT_OFFSET);
    }

    #[test]
    fn port_adds_the_active_offset_and_saturates() {
        assert_eq!(port(0), port_offset());
        assert_eq!(port(7981), 7981u16.saturating_add(port_offset()));
        // Never wraps past the u16 ceiling.
        assert_eq!(port(u16::MAX), u16::MAX);
    }

    #[test]
    fn suffix_is_empty_iff_offset_is_zero() {
        assert_eq!(suffix().is_empty(), port_offset() == 0);
    }

    #[test]
    fn default_bind_targets_the_offset_gateway_port() {
        assert_eq!(default_bind(), format!("0.0.0.0:{}", port(7981)));
    }

    #[test]
    fn default_config_path_ends_at_the_gateway_toml() {
        if let Some(path) = default_config_path() {
            assert!(path.ends_with("gateway.toml"));
            let parent = path.parent().unwrap().file_name().unwrap().to_string_lossy();
            assert_eq!(parent, format!("ryu{}", suffix()));
        }
    }
}
