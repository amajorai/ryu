//! Desktop build/runtime profile — the client mirror of Core's `profile.rs`.
//!
//! A *profile* lets a **dev variant** of the desktop ("Ryu Dev") run FULLY
//! ISOLATED alongside a release install on one machine: a distinct Core port, a
//! distinct data dir (`~/.ryu-dev`), and a distinct island control port, so the
//! two stacks never bleed into each other. The distinct bundle identifier
//! (`dev.ryu.desktop.dev`, set in `tauri.dev.conf.json`) gives it its own
//! single-instance lock and app-data store for free.
//!
//! This MUST agree with `apps/core/src/profile.rs`: dev shifts every base port by
//! [`DEV_PORT_OFFSET`] (1000) and suffixes the data dir with `-<profile>`. The
//! desktop passes `RYU_PROFILE` to the Core child it spawns (see
//! `core/process.rs`), and Core's own profile module then binds the shifted port
//! and uses the shifted data dir — so there is one offset convention on both
//! sides and they can never disagree.
//!
//! The active profile comes from, in order: the `RYU_PROFILE` env var (any value
//! other than `release`/empty ⇒ dev), else the `dev-variant` compile feature (the
//! packaged "Ryu Dev" build), else release. A release build with neither is
//! **byte-identical to before**: port 7980, `~/.ryu`, the original bundle id.

use std::path::PathBuf;

/// Env var naming the active profile. Unset / empty / `release` ⇒ release.
pub const RYU_PROFILE_ENV: &str = "RYU_PROFILE";

/// Port offset applied to every base port for the dev profile. Must equal Core's
/// `profile::DEV_PORT_OFFSET`.
pub const DEV_PORT_OFFSET: u16 = 1000;

/// The base Core HTTP port (release). `port()` shifts it per profile.
pub const CORE_BASE_PORT: u16 = 7980;

/// The base island loopback control port (release).
pub const ISLAND_CONTROL_BASE_PORT: u16 = 7989;

/// The active profile name, lowercased. `"release"` when unset/empty; otherwise
/// the `RYU_PROFILE` value; otherwise `"dev"` when built as the dev variant.
pub fn name() -> String {
	if let Ok(raw) = std::env::var(RYU_PROFILE_ENV) {
		let trimmed = raw.trim().to_ascii_lowercase();
		if !trimmed.is_empty() {
			return trimmed;
		}
	}
	if cfg!(feature = "dev-variant") {
		return "dev".to_string();
	}
	"release".to_string()
}

/// True for the default release profile (zero offset, no data-dir suffix).
pub fn is_release() -> bool {
	name() == "release"
}

/// True for any non-release (dev) profile.
pub fn is_dev() -> bool {
	!is_release()
}

/// `base + offset`, saturating. release ⇒ `base`; dev ⇒ `base + 1000`.
pub fn port(base: u16) -> u16 {
	if is_release() {
		base
	} else {
		base.saturating_add(DEV_PORT_OFFSET)
	}
}

/// The Core HTTP port for this profile: 7980 release, 8980 dev.
pub fn core_port() -> u16 {
	port(CORE_BASE_PORT)
}

/// `http://127.0.0.1:<core_port>` — the loopback base for health/control calls.
pub fn core_base_url() -> String {
	format!("http://127.0.0.1:{}", core_port())
}

/// `http://localhost:<core_port>` — the URL handed to the webview (matches the
/// historical spelling of `get_ryu_core_url`).
pub fn core_localhost_url() -> String {
	format!("http://localhost:{}", core_port())
}

/// The island loopback control port for this profile: 7989 release, 8989 dev.
/// An explicit `ISLAND_CONTROL_PORT` env var wins (so `bun run dev` can override
/// both sides at once); otherwise it is derived from the profile.
pub fn island_control_port() -> u16 {
	if let Ok(raw) = std::env::var("ISLAND_CONTROL_PORT") {
		if let Ok(parsed) = raw.trim().parse::<u16>() {
			return parsed;
		}
	}
	port(ISLAND_CONTROL_BASE_PORT)
}

/// Data-dir suffix: `""` for release (byte-identical `~/.ryu`), `-<profile>`
/// otherwise (e.g. `~/.ryu-dev`). Matches Core's `profile::suffix`.
pub fn suffix() -> String {
	if is_release() {
		String::new()
	} else {
		format!("-{}", name())
	}
}

/// The Ryu data/home dir for this profile: `~/.ryu` release, `~/.ryu-dev` dev.
pub fn ryu_home_dir() -> PathBuf {
	dirs::home_dir()
		.unwrap_or_else(|| PathBuf::from("."))
		.join(format!(".ryu{}", suffix()))
}
