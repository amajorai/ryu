//! Midnight auto-wipe — a daily "fresh install" for the ISOLATED prerelease
//! profiles (`canary`, `nightly`), off by default.
//!
//! # What it does
//! On the first Core start of a new calendar day, if the user turned it on, the
//! whole profile data dir is reset to a just-installed state. It exists so a
//! canary tester exercises first-run/onboarding/migration paths every day instead
//! of accumulating months of state that no real new user ever has.
//!
//! # Why a boot-time DATE COMPARE and not a timer
//! - Not the Core scheduler: it has no cron catch-up (it short-circuits before
//!   consulting `last`), its firing state is RAM-only, and it skips every tick
//!   when entitlement is inactive. Core also dies with the desktop on a local
//!   node, so "the app was closed at midnight" is the NORMAL case, not the edge.
//! - Not a millisecond timestamp: the display timezone is a user preference in
//!   shared localStorage, and any "start of today" arithmetic is off by an hour
//!   on DST transition days. Comparing two `YYYY-MM-DD` STRINGS is immune to
//!   both: if the stored day differs from today's, a midnight passed.
//! - Several missed midnights collapse to EXACTLY ONE wipe. Replaying one wipe
//!   per missed day has no defensible meaning — the data is already gone after
//!   the first.
//!
//! # Why it reuses the node reset instead of deleting anything itself
//! [`crate::paths::request_node_reset`] + [`crate::paths::apply_pending_reset`]
//! already solve the hard parts: the delete runs at the very top of `main`,
//! before any store opens a SQLite handle; it preserves the key custody files
//! (deleting them would orphan every encrypted DB with no rekey path) and the
//! Core/gateway binaries; and it is fail-CLOSED — a blocked wipe exits(75) with
//! the marker intact rather than booting onto half-deleted state. This module
//! only ARMS that mechanism, in the same boot, one line earlier.
//!
//! It deliberately does NOT route through `data_path::clean_profile_data`, which
//! computes `home.join(".ryu{suffix}")` — the DEFAULT path. On a relocated data
//! folder (`RYU_DIR` or the pointer file) that wipes a stale default directory
//! and silently misses the live one.
//!
//! # Where the state lives, and why it is not negotiable
//! Both the flag and the last-wipe date live in `<os-config>/ryu{suffix}/`, next
//! to `data-path.json` — OUTSIDE the directory being wiped. `preferences.db` is
//! *inside* it, so a setting stored there is erased by the first wipe and reverts
//! to its default; for a default-ON setting that is an unbreakable wipe loop.
//! (We ship default OFF, so the loop cannot happen, but a user's *disable* still
//! has to survive the wipe that follows it.) localStorage is wrong for a second
//! reason: every channel ships the same bundle identifier
//! (`ai.amajor.ryu.desktop`), so localStorage is not canary-scoped at all.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The state file, in `<os-config>/ryu{suffix}/`. The desktop writes the flag
/// here (`src-tauri/src/midnight_wipe.rs`); Core owns the date. The name is
/// asserted literally on both sides — nothing else ties the two together.
pub const STATE_FILE: &str = "midnight-wipe.json";

/// The only profiles this may ever arm on.
///
/// These are exactly the profiles a prerelease BUNDLE activates for itself
/// (`desktop::profile::VERSION_ACTIVATED_PROFILES`), which is what guarantees the
/// data dir being wiped is `~/.ryu-canary` / `~/.ryu-nightly` and not the user's
/// real `~/.ryu`. Note what is NOT consulted here, on purpose:
///
/// - `release-channel.ts` — a user-settable localStorage preference naming the
///   updater feed to follow. A stable user switching it to "Canary" must not arm
///   a delete on `~/.ryu`.
/// - Core's own build channel — a canary desktop runs a STABLE Core binary (the
///   installer pulls `releases/latest`; canary publishes as a prerelease), so
///   Core's `/api/health` reports channel "stable" on a canary machine.
///
/// The profile is the only signal that actually tracks the data dir.
pub const WIPE_PROFILES: &[&str] = &["canary", "nightly"];

/// The persisted state. Absent, unreadable or unparseable ⇒ [`Default`] ⇒
/// `enabled: false`, so every failure mode is "do not wipe".
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidnightWipeState {
    /// Whether the daily wipe is armed. DEFAULT OFF, and deliberately absent
    /// from the settings-sync allowlist: syncing a destructive local behaviour to
    /// another machine — on another profile — is exactly wrong.
    #[serde(default)]
    pub enabled: bool,
    /// `YYYY-MM-DD` of the last wipe this profile performed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_wipe_date: Option<String>,
}

/// `<os-config>/ryu{suffix}/midnight-wipe.json`.
pub fn state_path() -> PathBuf {
    crate::paths::config_dir().join(STATE_FILE)
}

/// Read the state, defaulting to disabled on any failure.
pub fn read_state() -> MidnightWipeState {
    let Ok(bytes) = std::fs::read(state_path()) else {
        return MidnightWipeState::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Persist the state (creating the config dir if needed).
pub fn write_state(state: &MidnightWipeState) -> std::io::Result<()> {
    let path = state_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    crate::atomic_file::write_atomic(&path, &json)
}

/// Today's local date as `YYYY-MM-DD`.
pub fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

// ── The guard (pure, so every refusal is testable) ───────────────────────────────

/// Everything the arm/skip decision depends on, passed explicitly.
///
/// Nothing in [`decide`] reads a global. That is the point: a guard that reached
/// for `profile::profile()` and `paths::ryu_dir()` inline could only ever be
/// tested on the profile the test binary happens to run under — i.e. the happy
/// path would be the ONLY reachable case, and every refusal would ship unproven.
#[derive(Debug, Clone)]
pub struct WipeInputs<'a> {
    /// The active profile name (`profile::profile()`).
    pub profile: &'a str,
    /// The active data-dir suffix (`profile::suffix()`).
    pub suffix: &'a str,
    /// The RESOLVED data dir (`paths::ryu_dir()` — honours `RYU_DIR` and the
    /// pointer file), not a path recomputed from home + suffix.
    pub data_dir: &'a Path,
    /// `~/.ryu`. `None` when home cannot be resolved.
    pub release_root: Option<&'a Path>,
    /// `~/.ryu-dev`. `None` when home cannot be resolved.
    pub dev_root: Option<&'a Path>,
    /// Where the flag + date live; must be outside `data_dir`.
    pub state_file: &'a Path,
    pub enabled: bool,
    pub last_wipe_date: Option<&'a str>,
    /// Today, `YYYY-MM-DD`.
    pub today: &'a str,
}

/// Why a wipe did not arm. Every arm of the guard is named so the log says which
/// one refused rather than "conditions not met".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// Not a canary/nightly profile — the overwhelmingly common case (every
    /// stable and dev boot), and the one that must never be overridable.
    NotAWipeProfile,
    /// A wipe profile with no data-dir suffix is a contradiction; refuse rather
    /// than resolve what it would mean.
    EmptySuffix,
    /// The data dir could not be resolved to an absolute path (unknown home).
    UnresolvedRoot,
    /// The resolved data dir IS, contains, or lives inside the release or dev
    /// root — e.g. a canary profile pointed at `~/.ryu` by `RYU_DIR` or the
    /// pointer file.
    RootIsReleaseOrDev,
    /// The state file lives inside the directory being wiped, so the flag and
    /// the date would be destroyed by the wipe they control.
    StateInsideWipedRoot,
    /// The user has not turned it on. This is the default.
    Disabled,
    /// Already wiped today. Several missed midnights collapse to one wipe.
    AlreadyWipedToday,
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotAWipeProfile => "profile is not canary/nightly",
            Self::EmptySuffix => "profile has no data-dir suffix",
            Self::UnresolvedRoot => "the profile data dir could not be resolved",
            Self::RootIsReleaseOrDev => {
                "the resolved data dir overlaps the release or dev data dir"
            }
            Self::StateInsideWipedRoot => "the wipe state file is inside the data dir",
            Self::Disabled => "the daily wipe setting is off",
            Self::AlreadyWipedToday => "already wiped today",
        }
    }

    /// Whether a refusal is worth a line on stderr. A stable build must not print
    /// a wipe breadcrumb on every boot, but on a profile that COULD wipe, every
    /// refusal is worth seeing.
    pub fn is_noteworthy(self) -> bool {
        self != Self::NotAWipeProfile
    }
}

/// `Ok(())` ⇒ arm the wipe. `Err(reason)` ⇒ do nothing, and say which guard said
/// no. ALL conditions must hold; there is deliberately no fallback path, no
/// "assume the default root", and no partial arm.
pub fn decide(input: &WipeInputs<'_>) -> Result<(), SkipReason> {
    if !WIPE_PROFILES.contains(&input.profile) {
        return Err(SkipReason::NotAWipeProfile);
    }
    // Belt-and-braces: a suffix-less non-release profile would resolve the
    // default root to `~/.ryu`. Two independent signals must both say "isolated".
    if input.suffix.is_empty() {
        return Err(SkipReason::EmptySuffix);
    }
    let (Some(release_root), Some(dev_root)) = (input.release_root, input.dev_root) else {
        // Home unknown ⇒ we cannot prove the target is not the release root.
        // Do nothing, loudly. Never guess a path.
        return Err(SkipReason::UnresolvedRoot);
    };
    if !input.data_dir.is_absolute() || input.data_dir.as_os_str().is_empty() {
        return Err(SkipReason::UnresolvedRoot);
    }
    // `paths_overlap`, not `!=`: the data dir is RESOLVED (env + pointer file), so
    // a canary profile can legitimately be pointed at `~/.ryu` or a directory
    // inside it, and either would pass a literal inequality check on every
    // candidate path while being exactly the disaster this guard exists for.
    if crate::paths::paths_overlap(input.data_dir, release_root)
        || crate::paths::paths_overlap(input.data_dir, dev_root)
    {
        return Err(SkipReason::RootIsReleaseOrDev);
    }
    if crate::paths::paths_overlap(input.state_file, input.data_dir) {
        return Err(SkipReason::StateInsideWipedRoot);
    }
    if !input.enabled {
        return Err(SkipReason::Disabled);
    }
    // String inequality on a date: DST-safe, timezone-change-safe, and it makes
    // N missed midnights fire exactly once.
    if input.last_wipe_date == Some(input.today) {
        return Err(SkipReason::AlreadyWipedToday);
    }
    Ok(())
}

// ── The boot hook ────────────────────────────────────────────────────────────────

/// Arm a node reset if today's first start of a canary/nightly profile finds the
/// setting on and no wipe recorded for today.
///
/// MUST be called from `main` after `profile::apply_env_defaults()` (so the data
/// dir resolves against the active profile) and immediately BEFORE
/// [`crate::paths::apply_pending_reset`], which consumes the marker in the same
/// boot — no restart, and no race with startup seeding, because both run
/// single-threaded before any store opens.
pub fn arm_if_due() {
    let profile = crate::profile::profile();
    let suffix = crate::profile::suffix();
    let data_dir = crate::paths::ryu_dir();
    let state_file = state_path();
    let home = dirs::home_dir();
    let release_root = home.as_ref().map(|h| {
        h.join(format!(
            ".ryu{}",
            crate::profile::suffix_for(crate::profile::RELEASE_PROFILE)
        ))
    });
    let dev_root = home
        .as_ref()
        .map(|h| h.join(format!(".ryu{}", crate::profile::suffix_for("dev"))));

    let state = read_state();
    let today = today_local();
    let decision = decide(&WipeInputs {
        profile,
        suffix: &suffix,
        data_dir: &data_dir,
        release_root: release_root.as_deref(),
        dev_root: dev_root.as_deref(),
        state_file: &state_file,
        enabled: state.enabled,
        last_wipe_date: state.last_wipe_date.as_deref(),
        today: &today,
    });

    if let Err(reason) = decision {
        if reason.is_noteworthy() {
            crate::log_rotation::write_diagnostic(format!(
                "ryu-core: midnight wipe not armed — {} (profile '{profile}', data dir {})",
                reason.as_str(),
                data_dir.display()
            ));
        }
        return;
    }

    // Record the date BEFORE arming. The state file is outside the wiped root, so
    // it survives either way — but if the wipe fails and `apply_pending_reset`
    // exits(75), the desktop restarts Core immediately, and a date written
    // afterwards would never be reached. Recording first makes the retry loop the
    // reset's own (marker-driven, bounded) rather than a fresh arm every boot.
    let next = MidnightWipeState {
        enabled: state.enabled,
        last_wipe_date: Some(today.clone()),
    };
    if let Err(e) = write_state(&next) {
        crate::log_rotation::write_diagnostic(format!(
            "ryu-core: midnight wipe NOT armed — could not record the wipe date at {} ({e}). \
             Refusing to delete data whose completion cannot be recorded.",
            state_file.display()
        ));
        return;
    }

    match crate::paths::request_node_reset() {
        Ok(()) => crate::log_rotation::write_diagnostic(format!(
            "ryu-core: midnight wipe armed for {today} — resetting the '{profile}' profile data dir {}",
            data_dir.display()
        )),
        Err(e) => crate::log_rotation::write_diagnostic(format!(
            "ryu-core: midnight wipe could not write the reset marker in {} ({e})",
            data_dir.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TODAY: &str = "2026-08-13";

    fn home() -> PathBuf {
        std::env::temp_dir().join("ryu-midnight-wipe-home")
    }

    fn release_root() -> PathBuf {
        home().join(".ryu")
    }

    fn dev_root() -> PathBuf {
        home().join(".ryu-dev")
    }

    fn canary_root() -> PathBuf {
        home().join(".ryu-canary")
    }

    fn config_state() -> PathBuf {
        home().join("config").join("ryu-canary").join(STATE_FILE)
    }

    /// A fully-armed canary setup. Each test breaks exactly one field, so the
    /// assertion names the guard under test.
    fn armed<'a>(
        data_dir: &'a Path,
        state_file: &'a Path,
        release: &'a Path,
        dev: &'a Path,
    ) -> WipeInputs<'a> {
        WipeInputs {
            profile: "canary",
            suffix: "-canary",
            data_dir,
            release_root: Some(release),
            dev_root: Some(dev),
            state_file,
            enabled: true,
            last_wipe_date: Some("2026-08-12"),
            today: TODAY,
        }
    }

    #[test]
    fn arms_on_a_canary_profile_whose_root_is_its_own() {
        let (d, s, r, v) = (canary_root(), config_state(), release_root(), dev_root());
        assert_eq!(decide(&armed(&d, &s, &r, &v)), Ok(()));
    }

    #[test]
    fn arms_on_nightly_too() {
        let (s, r, v) = (config_state(), release_root(), dev_root());
        let d = home().join(".ryu-nightly");
        let mut input = armed(&d, &s, &r, &v);
        input.profile = "nightly";
        input.suffix = "-nightly";
        assert_eq!(decide(&input), Ok(()));
    }

    /// THE test. A release profile must never arm, whatever else is set — the
    /// setting on, a date in the past, everything.
    #[test]
    fn never_arms_on_a_release_profile() {
        let (s, r, v) = (config_state(), release_root(), dev_root());
        let d = release_root();
        let mut input = armed(&d, &s, &r, &v);
        input.profile = "release";
        input.suffix = "";
        assert_eq!(decide(&input), Err(SkipReason::NotAWipeProfile));

        // ...and not on any other non-wipe profile either.
        for profile in ["dev", "beta", "", "typo", "Canary", "canary "] {
            let mut input = armed(&d, &s, &r, &v);
            input.profile = profile;
            assert_eq!(
                decide(&input),
                Err(SkipReason::NotAWipeProfile),
                "profile '{profile}' must not arm a wipe"
            );
        }
    }

    /// Belt-and-braces: even if the profile name says canary, no suffix means the
    /// default root is `~/.ryu`.
    #[test]
    fn never_arms_on_an_empty_suffix() {
        let (d, s, r, v) = (canary_root(), config_state(), release_root(), dev_root());
        let mut input = armed(&d, &s, &r, &v);
        input.suffix = "";
        assert_eq!(decide(&input), Err(SkipReason::EmptySuffix));
    }

    /// The catastrophe this guard exists for: a canary profile whose data dir was
    /// relocated onto the release root by `RYU_DIR` or the pointer file. Note a
    /// literal `!=` against `default_ryu_dir()` would NOT catch it — under the
    /// canary profile that default is `~/.ryu-canary`.
    #[test]
    fn never_arms_when_the_resolved_root_is_the_release_root() {
        let (s, r, v) = (config_state(), release_root(), dev_root());
        for relocated in [release_root(), release_root().join("nested"), dev_root()] {
            let input = armed(&relocated, &s, &r, &v);
            assert_eq!(
                decide(&input),
                Err(SkipReason::RootIsReleaseOrDev),
                "a canary profile resolving to {} must not wipe",
                relocated.display()
            );
        }
    }

    #[test]
    fn never_arms_when_home_is_unknown_or_the_root_is_relative() {
        let (d, s, r, v) = (canary_root(), config_state(), release_root(), dev_root());

        let mut no_home = armed(&d, &s, &r, &v);
        no_home.release_root = None;
        assert_eq!(decide(&no_home), Err(SkipReason::UnresolvedRoot));

        let mut no_dev = armed(&d, &s, &r, &v);
        no_dev.dev_root = None;
        assert_eq!(decide(&no_dev), Err(SkipReason::UnresolvedRoot));

        // `default_ryu_dir` falls back to `./.ryu{suffix}` when home is unknown.
        let relative = PathBuf::from(".ryu-canary");
        let input = armed(&relative, &s, &r, &v);
        assert_eq!(decide(&input), Err(SkipReason::UnresolvedRoot));
    }

    /// The state must outlive the wipe it controls, or a disable cannot survive.
    #[test]
    fn never_arms_when_the_state_file_is_inside_the_wiped_root() {
        let (d, r, v) = (canary_root(), release_root(), dev_root());
        let inside = canary_root().join(STATE_FILE);
        let input = armed(&d, &inside, &r, &v);
        assert_eq!(decide(&input), Err(SkipReason::StateInsideWipedRoot));
    }

    #[test]
    fn does_not_arm_when_the_setting_is_off() {
        let (d, s, r, v) = (canary_root(), config_state(), release_root(), dev_root());
        let mut input = armed(&d, &s, &r, &v);
        input.enabled = false;
        assert_eq!(decide(&input), Err(SkipReason::Disabled));
    }

    /// Default OFF: a missing or corrupt state file must never read as armed.
    #[test]
    fn state_defaults_to_disabled() {
        assert!(!MidnightWipeState::default().enabled);
        let parsed: MidnightWipeState = serde_json::from_str("{}").unwrap();
        assert!(!parsed.enabled);
        assert_eq!(parsed.last_wipe_date, None);
        let round: MidnightWipeState = serde_json::from_str(
            &serde_json::to_string(&MidnightWipeState {
                enabled: true,
                last_wipe_date: Some(TODAY.to_string()),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(round.enabled);
        assert_eq!(round.last_wipe_date.as_deref(), Some(TODAY));
    }

    /// One wipe per day, and exactly ONE wipe for any number of missed midnights.
    #[test]
    fn fires_once_per_day_however_many_midnights_were_missed() {
        let (d, s, r, v) = (canary_root(), config_state(), release_root(), dev_root());

        // Never wiped before ⇒ fires.
        let mut first = armed(&d, &s, &r, &v);
        first.last_wipe_date = None;
        assert_eq!(decide(&first), Ok(()));

        // Eleven days offline ⇒ still exactly one arm...
        let mut stale = armed(&d, &s, &r, &v);
        stale.last_wipe_date = Some("2026-08-02");
        assert_eq!(decide(&stale), Ok(()));

        // ...and the moment the date is recorded, the same day cannot fire again,
        // however many times Core restarts.
        let mut recorded = armed(&d, &s, &r, &v);
        recorded.last_wipe_date = Some(TODAY);
        assert_eq!(decide(&recorded), Err(SkipReason::AlreadyWipedToday));

        // A date in the FUTURE (clock moved back, or a synced file) differs from
        // today, so it fires — the compare is inequality, never ordering, so a
        // bad clock can never wedge it permanently off.
        let mut future = armed(&d, &s, &r, &v);
        future.last_wipe_date = Some("2027-01-01");
        assert_eq!(decide(&future), Ok(()));
    }

    #[test]
    fn today_is_an_iso_date_string() {
        let today = today_local();
        assert_eq!(today.len(), 10, "YYYY-MM-DD");
        let parts: Vec<&str> = today.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 4);
        assert!(today.chars().all(|c| c.is_ascii_digit() || c == '-'));
    }

    /// Both mirrors compose `<config>/ryu{suffix}/<STATE_FILE>`; the desktop side
    /// asserts the same literal (`src-tauri/src/midnight_wipe.rs`). Nothing in the
    /// type system connects the two crates.
    #[test]
    fn the_state_file_name_and_location_match_the_desktop_mirror() {
        assert_eq!(STATE_FILE, "midnight-wipe.json");
        let path = state_path();
        assert_eq!(path.file_name().and_then(|n| n.to_str()), Some(STATE_FILE));
        assert_eq!(path.parent(), Some(crate::paths::config_dir().as_path()));
        assert!(path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("ryu")));
    }

    /// The invariant the whole design rests on, asserted against the REAL paths
    /// this process resolves: the state file is not inside the data dir.
    #[test]
    fn the_real_state_file_is_outside_the_real_data_dir() {
        assert!(
            !crate::paths::paths_overlap(&state_path(), &crate::paths::ryu_dir()),
            "the wipe would delete its own enable/disable flag"
        );
    }

    /// Every profile this may wipe must be a known, non-release, suffixed profile.
    #[test]
    fn wipe_profiles_are_isolated_profiles() {
        for profile in WIPE_PROFILES {
            assert!(
                crate::profile::offset_of(profile).is_some(),
                "'{profile}' is not a known profile"
            );
            assert_ne!(*profile, crate::profile::RELEASE_PROFILE);
            assert_ne!(*profile, "dev");
            assert!(!crate::profile::suffix_for(profile).is_empty());
        }
    }
}
