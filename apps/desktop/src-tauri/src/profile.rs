//! Desktop build/runtime profile — the client mirror of Core's `profile.rs`.
//!
//! A *profile* lets a **dev variant** of the desktop ("Ryu Dev") run FULLY
//! ISOLATED alongside a release install on one machine: a distinct Core port, a
//! distinct data dir (`~/.ryu-dev`), and a distinct island control port, so the
//! two stacks never bleed into each other. The distinct bundle identifier
//! (`ai.amajor.ryu.desktop.dev`, set in `tauri.dev.conf.json`) gives it its own
//! single-instance lock and app-data store for free.
//!
//! This MUST agree with `apps/core/src/profile.rs`: dev shifts every base port by
//! [`DEV_PORT_OFFSET`] (1000) and suffixes the data dir with `-<profile>`. The
//! desktop passes `RYU_PROFILE` to the Core child it spawns (see
//! `core/process.rs`), and Core's own profile module then binds the shifted port
//! and uses the shifted data dir — so there is one offset convention on both
//! sides and they can never disagree.
//!
//! The active profile comes from, in order: the `RYU_PROFILE` env var, else the
//! `dev-variant` compile feature (the packaged "Ryu Dev" build), else **the
//! channel this build's own version names** ([`profile_for_version`]), else
//! release. A stable-versioned release build with none of those is
//! **byte-identical to before**: port 7980, `~/.ryu`, the original bundle id.
//!
//! That third step is what makes a canary/nightly bundle an isolated stack. The
//! profile table below has carried `canary` and `nightly` rows since it was
//! written, but NOTHING ever activated them: only `dev` had a switch, so a
//! canary build fell through to `release` and ran against `~/.ryu` — the same
//! data folder as the user's stable install, sharing its port, its keychain slot
//! and its DBs. `scripts/release/bump-version.sh` stamps
//! `0.1.12-canary.20260813.36` into every Cargo.toml, so `CARGO_PKG_VERSION`
//! already carries the channel; reading it here is the whole activation.
//!
//! Every profile has its OWN port offset ([`PROFILE_PORT_OFFSETS`]). This used to
//! be "release ⇒ 0, anything else ⇒ dev's +1000", which gave `canary` its own data
//! dir and keychain slot but dev's listeners — two stacks that each believed they
//! were isolated while sharing one port.

use std::path::PathBuf;

/// Env var naming the active profile. Unset / empty / `release` ⇒ release.
pub const RYU_PROFILE_ENV: &str = "RYU_PROFILE";

/// Optional explicit port namespace supplied by a standalone app build. Core,
/// Gateway, and Desktop all read the same value so the host can isolate one app
/// without inventing a new profile row for every app id.
pub const RYU_PORT_OFFSET_ENV: &str = "RYU_PORT_OFFSET";

/// Port offset for the `dev` profile. Must equal Core's
/// `profile::DEV_PORT_OFFSET`.
pub const DEV_PORT_OFFSET: u16 = 1000;

/// Mirror of `apps/core/src/profile.rs::PROFILE_PORT_OFFSETS`. The desktop
/// spawns Core with this same `RYU_PROFILE` and then dials the port it computes
/// here, so a row that disagrees with Core's table means the desktop adopts a
/// port nothing is listening on.
pub const PROFILE_PORT_OFFSETS: &[(&str, u16)] = &[
    ("release", 0),
    ("dev", DEV_PORT_OFFSET),
    ("canary", 2000),
    ("nightly", 3000),
    ("beta", 4000),
];

/// The port offset for `profile`, or `None` when it is not a known profile.
pub fn offset_of(profile: &str) -> Option<u16> {
    PROFILE_PORT_OFFSETS
        .iter()
        .find(|(name, _)| *name == profile)
        .map(|(_, offset)| *offset)
}

/// The base Core HTTP port (release). `port()` shifts it per profile.
pub const CORE_BASE_PORT: u16 = 7980;

/// The base island loopback control port (release).
pub const ISLAND_CONTROL_BASE_PORT: u16 = 7989;

/// The release channels whose builds activate a profile of the same name — i.e.
/// the channels that get their OWN data root, ports and keychain slot.
///
/// `beta` is deliberately absent. Its row exists in [`PROFILE_PORT_OFFSETS`], but
/// whether a beta build should be isolated from stable or be an in-place upgrade
/// of it is an open question (task #102), and answering it by accident here would
/// silently move every beta user's data folder. An unlisted channel — `beta`,
/// `rc`, a prerelease id invented after this build shipped — resolves to
/// `release`, which is exactly today's behaviour.
///
/// Note the safety property this list must keep: every entry MUST also be a row
/// in [`PROFILE_PORT_OFFSETS`], because Core `exit(1)`s on a `RYU_PROFILE` it
/// does not know. `channel_profiles_are_known_profiles` asserts it.
const VERSION_ACTIVATED_PROFILES: &[&str] = &["canary", "nightly"];

/// The channel identifier a version string names: its FIRST prerelease
/// identifier, or `None` for a plain release version.
///
/// Mirrors Core's `update::channel_of` (and the JS `channelOfVersion`), minus the
/// `"stable"` spelling — here "no prerelease" is `None`, so the caller cannot
/// confuse it with a channel name.
fn channel_of_version(version: &str) -> Option<&str> {
    // Build metadata (`0.1.4+ci.42`) is NOT a prerelease and must never be read
    // as one, or a `+canary.1` build stamp would activate the canary profile.
    let core = version.split('+').next().unwrap_or(version);
    let (_, pre) = core.split_once('-')?;
    let ident = pre.split('.').next().unwrap_or(pre).trim();
    if ident.is_empty() {
        None
    } else {
        Some(ident)
    }
}

/// The profile a build carrying `version` runs under, or `None` when the version
/// names no isolated channel (a stable build, or a channel we deliberately do not
/// isolate — see [`VERSION_ACTIVATED_PROFILES`]).
///
/// Returns a `&'static str` from the table on purpose: the name is handed to Core
/// as `RYU_PROFILE`, and Core rejects anything not in its own table, so it must
/// come from ours rather than from the parsed version text.
pub fn profile_for_version(version: &str) -> Option<&'static str> {
    let channel = channel_of_version(version)?;
    VERSION_ACTIVATED_PROFILES
        .iter()
        .copied()
        .find(|known| *known == channel)
}

/// The profile this bundle's own version activates, if any.
pub fn build_channel_profile() -> Option<&'static str> {
    profile_for_version(env!("CARGO_PKG_VERSION"))
}

/// The active profile name, lowercased. The `RYU_PROFILE` value when set;
/// otherwise `"dev"` when built as the dev variant; otherwise the profile this
/// build's own version names (`canary`/`nightly`); otherwise `"release"`.
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
    if let Some(from_version) = build_channel_profile() {
        return from_version.to_string();
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

/// `base + offset`, saturating. release ⇒ `base`; dev ⇒ `base + 1000`; every
/// other known profile gets its own offset from [`PROFILE_PORT_OFFSETS`].
///
/// An unknown profile falls back to release's zero offset rather than dev's —
/// Core rejects the name outright at startup, so the desktop would fail to reach
/// the Core it spawned either way, and aliasing onto dev would have it dial a
/// *different, running* stack instead. Failing to connect beats connecting to
/// the wrong stack.
pub fn port(base: u16) -> u16 {
    base.saturating_add(
        std::env::var(RYU_PORT_OFFSET_ENV)
            .ok()
            .and_then(|value| value.trim().parse::<u16>().ok())
            .filter(|offset| *offset <= 50_000)
            .unwrap_or_else(|| offset_of(&name()).unwrap_or(0)),
    )
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

/// Data-dir suffix for an arbitrary profile name: `""` for release
/// (byte-identical `~/.ryu`), `-<profile>` otherwise. Mirrors Core's
/// `profile::suffix_for`. Pure, so the version → profile → data-root chain can be
/// asserted without the process actually running under that profile.
pub fn suffix_of(profile: &str) -> String {
    if profile == "release" {
        String::new()
    } else {
        format!("-{profile}")
    }
}

/// Data-dir suffix for the ACTIVE profile: `""` for release (byte-identical
/// `~/.ryu`), `-<profile>` otherwise (e.g. `~/.ryu-dev`). Matches Core's
/// `profile::suffix`.
pub fn suffix() -> String {
    suffix_of(&name())
}

/// The profile's DEFAULT data dir (`~/.ryu` release, `~/.ryu-dev` dev), ignoring
/// `RYU_DIR` and the Storage pointer. Only for callers that deliberately want the
/// unrelocated default of a named profile; everything else uses [`ryu_home_dir`].
pub fn default_data_dir_of(profile: &str) -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(format!(".ryu{}", suffix_of(profile)))
}

/// The data dir `profile` resolves to, exactly like Core: a non-empty
/// `override_dir` (the `RYU_DIR` value) > the Storage pointer
/// (`<config>/ryu<sfx>/data-path.json`) > `~/.ryu<sfx>`.
///
/// A pointer that cannot be read or parsed makes Core refuse to start; Desktop
/// logs it and uses the profile default rather than inventing a third location.
pub fn resolve_data_dir_of(profile: &str, override_dir: Option<std::ffi::OsString>) -> PathBuf {
    let paths = match ryu_runtime_install::data_paths::DataPaths::for_profile(
        profile,
        dirs::home_dir(),
        dirs::config_dir(),
    ) {
        Ok(paths) => paths,
        Err(_) => {
            return override_dir
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| default_data_dir_of(profile))
        }
    };
    paths
        .resolve_data_dir(override_dir)
        .unwrap_or_else(|error| {
            tracing::warn!(
                pointer = %paths.pointer_path.display(),
                %error,
                "Storage pointer is unreadable; using the profile default data dir"
            );
            paths.default_data_dir.clone()
        })
}

/// The Ryu data dir for the active profile, resolved exactly like Core:
/// `RYU_DIR` > Storage pointer > `~/.ryu<sfx>` (`~/.ryu` release, `~/.ryu-dev`
/// dev). Not cached: a Storage relocation rewrites the pointer at runtime.
pub fn ryu_home_dir() -> PathBuf {
    resolve_data_dir_of(&name(), std::env::var_os("RYU_DIR"))
}

/// True when `candidate` is `<home>/.ryu<suffix>/bin/<exe>` for a Ryu profile home
/// that is NOT the active one.
///
/// Installers put **both** `~/.ryu/bin` and `~/.ryu-dev/bin` on PATH, so any
/// `which("ryu-core")`-style lookup from the dev profile happily returns the
/// RELEASE binary. Every PATH fallback must run its hit through this first, or a
/// dev profile silently runs a release-build Core against `~/.ryu-dev` — a version
/// skew that shows up as routes 404-ing for no visible reason.
///
/// Both PATH fallbacks (binary resolution *and* the installed-check that decides
/// whether to download) must agree here: if only the resolver rejected the foreign
/// hit, the installed-check would still count it as present, skip the download, and
/// leave the profile with no binary at all.
pub fn is_foreign_profile_bin(candidate: &std::path::Path) -> bool {
    // <profile home>/bin/<exe> → the profile home is two levels up.
    let Some(home) = candidate.parent().and_then(std::path::Path::parent) else {
        return false;
    };
    if home == ryu_home_dir() {
        return false;
    }
    home.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == ".ryu" || n.starts_with(".ryu-"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three `PROFILE_PORT_OFFSETS` mirrors (Core, Gateway, desktop) MUST
    /// stay identical: the desktop spawns Core and Core spawns the Gateway, all
    /// with the same `RYU_PROFILE`, so one table drifting means a spawner dials a
    /// port its child never bound. Each crate asserts the SAME literal rows, so
    /// editing one mirror without the others fails here.
    #[test]
    fn the_profile_table_matches_its_mirrors() {
        assert_eq!(
            PROFILE_PORT_OFFSETS,
            &[
                ("release", 0u16),
                ("dev", 1000),
                ("canary", 2000),
                ("nightly", 3000),
                ("beta", 4000),
            ][..]
        );
    }

    /// The activation this module exists for: a canary/nightly BUNDLE must report
    /// its own profile, because that is what sends `RYU_PROFILE` to the Core child
    /// and moves the whole stack off `~/.ryu`.
    #[test]
    fn a_prerelease_version_activates_its_own_profile() {
        // The exact shape `scripts/release/bump-version.sh` stamps.
        assert_eq!(
            profile_for_version("0.1.12-canary.20260813.36"),
            Some("canary")
        );
        assert_eq!(
            profile_for_version("0.1.12-nightly.20260813.36"),
            Some("nightly")
        );
        // Prerelease + build metadata still reads the prerelease.
        assert_eq!(
            profile_for_version("0.1.12-canary.4+f1a68ac"),
            Some("canary")
        );
    }

    #[test]
    fn a_stable_version_stays_on_the_release_profile() {
        // The regression that matters most: a stable build must keep resolving
        // `~/.ryu` with zero offset, byte-identical to before this existed.
        assert_eq!(profile_for_version("0.1.12"), None);
        assert_eq!(profile_for_version("0.1.12+ci.42"), None);
        // Build metadata is not a prerelease — `+canary.1` must NOT activate it.
        assert_eq!(profile_for_version("0.1.12+canary.1"), None);
        // Junk never invents a profile.
        assert_eq!(profile_for_version(""), None);
        assert_eq!(profile_for_version("garbage"), None);
        assert_eq!(profile_for_version("0.1.12-"), None);
    }

    #[test]
    fn beta_and_unknown_channels_are_not_activated_by_version() {
        // beta has a PROFILE_PORT_OFFSETS row but is deliberately not activated
        // (task #102 owns that call); an unseen prerelease id must not either.
        assert_eq!(profile_for_version("0.1.12-beta.1"), None);
        assert_eq!(profile_for_version("0.1.12-rc.1"), None);
        assert_eq!(profile_for_version("0.1.12-experiment.7"), None);
    }

    /// The whole chain, end to end: the version a canary bundle carries resolves
    /// to a data root that is NEITHER the release default (`~/.ryu`) nor the dev
    /// one (`~/.ryu-dev`), and to a Core port nothing else binds. This is the
    /// property the midnight wipe is allowed to delete against.
    #[test]
    fn a_prerelease_bundle_resolves_a_root_that_is_not_release_or_dev() {
        for (version, profile, suffix, port) in [
            ("0.1.12-canary.20260813.36", "canary", "-canary", 9980u16),
            ("0.1.12-nightly.20260813.36", "nightly", "-nightly", 10_980),
        ] {
            let resolved = profile_for_version(version).expect("activates a profile");
            assert_eq!(resolved, profile);
            assert_eq!(suffix_of(resolved), suffix);
            assert_ne!(suffix_of(resolved), suffix_of("release"));
            assert_ne!(suffix_of(resolved), suffix_of("dev"));
            assert_eq!(
                CORE_BASE_PORT + offset_of(resolved).expect("known profile"),
                port
            );
        }
        // And the untouched baseline: a stable bundle keeps `~/.ryu` and :7980.
        assert_eq!(suffix_of("release"), "");
        assert_eq!(offset_of("release"), Some(0));
    }

    /// Core `exit(1)`s on a `RYU_PROFILE` outside its table, so anything this
    /// module can hand it must be a known row — and must not be `release` (no
    /// isolation) or `dev` (a DIFFERENT, possibly running stack's ports and data).
    #[test]
    fn channel_profiles_are_known_profiles() {
        for profile in VERSION_ACTIVATED_PROFILES {
            assert!(
                offset_of(profile).is_some(),
                "'{profile}' is not in PROFILE_PORT_OFFSETS — Core would exit(1)"
            );
            assert_ne!(*profile, "release");
            assert_ne!(*profile, "dev");
        }
    }

    #[test]
    fn canary_no_longer_shares_devs_ports() {
        // Was: every non-release profile got +1000, so a canary desktop dialled
        // the dev stack's Core.
        assert_eq!(offset_of("dev"), Some(1000));
        assert_eq!(offset_of("canary"), Some(2000));
        assert_ne!(offset_of("canary"), offset_of("dev"));
        // An unknown name resolves to release's offset, never dev's — failing to
        // connect beats connecting to a different, running stack.
        assert_eq!(offset_of("typo"), None);
    }
}
