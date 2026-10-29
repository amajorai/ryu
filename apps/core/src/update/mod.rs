//! Unified update service — the single source of truth for "what version is
//! installed, what is the latest, and is an update available" across every Ryu
//! surface (desktop, cli, gateway, extension, island, mobile).
//!
//! Placement note (Core vs Gateway, per CLAUDE.md §1): deciding *what runs* —
//! including which build of the binaries runs — is a Core responsibility. The
//! Gateway governs what is *allowed/measured/paid*, not the install lifecycle.
//! So the version/update verdict lives here, and every client reads Core's
//! verdict instead of each re-implementing GitHub-release polling.
//!
//! Versioning model: **single release train**. One Ryu release tag bundles all
//! binaries, so `core`, `gateway`, `cli`, and `desktop` ship the same version.
//! `current_version()` is Core's own `CARGO_PKG_VERSION`, which is the canonical
//! Ryu version because the whole workspace is released together. `/api/version`
//! reports the release plus the per-component build list; `/api/update/check`
//! compares that tag against the latest GitHub release.
//!
//! The install *mechanism* is necessarily each platform's native updater
//! (tauri-plugin-updater, electron-updater, expo-updates) — Core owns the
//! *verdict, the toggle, and the binary self-update* for the headless surfaces
//! (core/gateway/cli) that have no native updater of their own.

use serde::{Deserialize, Serialize};

pub mod apply;
pub mod schedule;

/// The canonical Ryu GitHub repository releases are published to.
pub const RYU_REPO: &str = "amajorai/ryu";

/// Preference key (in the cross-surface KV store) holding the auto-update
/// toggle. Every client reads/writes this so the setting is shared across
/// desktop, island, cli, etc. Value is the JSON blob `{ "enabled": bool }`.
pub const AUTO_UPDATE_PREF_KEY: &str = "auto-updates";

/// One built component in the release train.
#[derive(Clone, Serialize)]
pub struct ComponentVersion {
    pub name: String,
    pub version: String,
}

/// Response for `GET /api/version`.
#[derive(Clone, Serialize)]
pub struct VersionInfo {
    /// The canonical Ryu release version (single release train).
    pub ryu_version: String,
    /// Per-component builds. In the single release train these match
    /// `ryu_version`, but the field is kept explicit so a future per-component
    /// model is a data change, not an API change.
    pub components: Vec<ComponentVersion>,
    /// `os-arch` of the running Core (e.g. `windows-x86_64`). Clients use this
    /// to pick the right release asset.
    pub platform: String,
    /// Behaviour a client must confirm before relying on it, so a newer client can
    /// refuse to talk to an older Core instead of guessing from version strings.
    /// See [`CORE_FEATURES`].
    pub features: Vec<String>,
}

/// The web tier forwards a signed-in browser's `/api/ext/*` call only to a Core
/// that runs the web-delegated admission (`sidecar::ext_proxy`). An older Core reads
/// the web tier's node token as the owner and would run the request with owner
/// authority, so the web tier checks this flag on `GET /api/version` first.
pub const FEATURE_WEB_DELEGATED_EXT: &str = "web_delegated_ext";

/// Every feature flag [`VersionInfo::features`] advertises.
pub const CORE_FEATURES: &[&str] = &[FEATURE_WEB_DELEGATED_EXT];

/// A downloadable release asset matched to the running platform.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    /// Best-effort installer kind inferred from the file extension
    /// (`msi`/`exe`/`dmg`/`appimage`/`deb`/`archive`/`unknown`).
    pub kind: String,
    pub size: u64,
}

/// Response for `GET /api/update/check`.
#[derive(Clone, Serialize)]
pub struct UpdateCheck {
    /// Currently installed Ryu version.
    pub current: String,
    /// Latest published release tag (normalised, leading `v` stripped).
    pub latest: String,
    /// The release channel this verdict was computed on (`stable` / `beta` /
    /// `nightly` / `canary`). Defaults to the channel the running build is on,
    /// derived from its own version. Comparisons are scoped WITHIN this channel.
    pub channel: String,
    /// `true` when `latest` is strictly newer than `current` by semver.
    pub update_available: bool,
    /// Release notes (the GitHub release body), if any.
    pub notes: Option<String>,
    /// Link to the human-readable release page.
    pub html_url: Option<String>,
    /// The asset matching the running platform, when one could be resolved.
    pub asset: Option<ReleaseAsset>,
    /// The git tag of the release `latest` names. A tag is NOT derivable from
    /// `latest`: rolling channels use a fixed pointer tag (`nightly`) while their
    /// version lives in the release title (see `release_version`). A client that
    /// wants to address a SPECIFIC release — e.g. to pin an install to it — must
    /// use this, never `v{latest}`.
    pub tag: Option<String>,
    /// RFC-3339 publish timestamp of the release `latest` names, when GitHub
    /// reported one. Lets a client reason about release DATES, which version
    /// strings alone cannot express.
    pub published_at: Option<String>,
    /// The newest release on the channel IGNORING any `updates_until` cutoff.
    /// Equal to `latest` when no cutoff applied.
    ///
    /// SOURCE NOTE: on the unclamped path this is GitHub's own `latest` pointer;
    /// on the clamped path it is the semver maximum of the listing. Those can
    /// disagree if a maintainer re-points `latest` by hand. It is advisory copy
    /// only — it never decides which build is offered or installed.
    pub latest_unrestricted: String,
    /// True when an `updates_until` cutoff held `latest` back from
    /// `latest_unrestricted`. DELIBERATELY distinct from `update_available:
    /// false`, which the handler's fail-open arm also returns for a network error
    /// — a client must be able to tell "your window lapsed" from "GitHub is down".
    ///
    /// Can be true AT THE SAME TIME as `cutoff_waived_for_security`: that pair
    /// means "we handed you a security release published after your window, and
    /// it is still older than the absolute latest".
    pub restricted_by_cutoff: bool,
    /// True when the offered release is a SECURITY release published after the
    /// cutoff, deliberately handed over anyway.
    pub cutoff_waived_for_security: bool,
    /// True when a cutoff was supplied but NO eligible release could be resolved —
    /// the single releases page did not reach back far enough. `latest` is then a
    /// placeholder equal to `current` and asserts nothing about entitlement, so a
    /// client must NOT tell the user "this is the newest build your window
    /// covers". Not an error, and not a clamp: a third state.
    pub cutoff_unresolved: bool,
}

/// Set once a self-update asks Core to restart onto its new binary.
static RESTART_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static RESTART_NOTIFY: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Exit code Core uses after a restart-for-update shutdown: `EX_TEMPFAIL`, non-zero
/// so `Restart=on-failure` (systemd) restarts it as well as `always` policies.
pub const RESTART_EXIT_CODE: i32 = 75;

/// Ask the running Core to shut down gracefully so a supervisor restarts it on
/// the binary a self-update just installed.
pub fn request_restart() {
    RESTART_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
    RESTART_NOTIFY.notify_waiters();
    RESTART_NOTIFY.notify_one();
}

/// Resolves once [`request_restart`] has been called.
pub async fn restart_requested() {
    if RESTART_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    RESTART_NOTIFY.notified().await;
}

/// Whether a restart was requested (checked after the graceful shutdown).
pub fn restart_was_requested() -> bool {
    RESTART_REQUESTED.load(std::sync::atomic::Ordering::SeqCst)
}

/// The current Ryu version (single release train = Core's own crate version).
pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The `releases/download/<tag>` base of the release this Core was built for.
///
/// Assets that must match the running build (app sidecars, version-pinned mesh
/// clients) come from here rather than `releases/latest`, which serves whatever
/// stable release is newest. Every release publishes under a versioned tag
/// (`v<version>`, rolling channels included).
pub fn own_release_download_base() -> String {
    format!(
        "https://github.com/{RYU_REPO}/releases/download/v{}",
        current_version()
    )
}

/// `os-arch` string for the running Core.
pub fn platform_tag() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Build the `/api/version` payload.
///
/// `gateway` is passed in because it is the one component Core can actually
/// observe: it spawns the Gateway and can read the `version` out of its `/health`.
/// Everything else is left at Core's own version, which is honest for the single
/// release train (one tag ships every binary) and is all Core can know — `cli` and
/// `desktop` are separate installs Core never talks to.
///
/// This used to stamp Core's version onto ALL FOUR components unconditionally, so
/// a stale Gateway binary reported itself as up to date and no mismatch could ever
/// be detected. The struct doc on [`ComponentVersion`] anticipated exactly this
/// fix as "a data change, not an API change" — the shape is unchanged.
pub fn version_info_with(gateway_version: Option<&str>) -> VersionInfo {
    let v = current_version();
    let components = ["core", "gateway", "cli", "desktop"]
        .iter()
        .map(|name| ComponentVersion {
            name: (*name).to_string(),
            version: match *name {
                "gateway" => gateway_version.unwrap_or(&v).to_string(),
                _ => v.clone(),
            },
        })
        .collect();
    VersionInfo {
        ryu_version: v,
        components,
        platform: platform_tag(),
        features: CORE_FEATURES
            .iter()
            .map(|feature| (*feature).to_owned())
            .collect(),
    }
}

/// [`version_info_with`] with no observed Gateway — every component reports Core's
/// version. Kept for callers with no Gateway handle (and for tests).
pub fn version_info() -> VersionInfo {
    version_info_with(None)
}

/// Whether an observed component version disagrees with Core's own.
///
/// Core and the Gateway ship from ONE release train (`bump-version.sh` stamps every
/// `Cargo.toml` in a single pass), so any drift means a stale binary — most often a
/// Gateway left behind in `~/.ryu/bin` after the app self-updated. Compared as
/// strings, deliberately: a channel suffix is part of the identity here, so
/// `0.0.18` and `0.0.18-nightly.3` are a genuine mismatch, not equal patch levels.
pub fn version_disagrees(core: &str, other: &str) -> bool {
    core.trim() != other.trim()
}

/// Normalise a release tag to a bare semver string (`v1.2.3` → `1.2.3`).
fn normalise_tag(tag: &str) -> &str {
    tag.trim().trim_start_matches(['v', 'V'])
}

/// Parse a version with FULL semver 2.0 precedence, including the prerelease
/// suffix. `None` for anything unparseable.
///
/// WHY THE PRERELEASE MUST BE KEPT: this function used to return only the
/// `(major, minor, patch)` triple, discarding `-beta.1` / `-nightly.20260728.932`
/// entirely. That silently disabled the entire rolling-channel train in two ways:
///
///   * two nightlies (`0.0.13-nightly.20260728.932` and `…20260729.940`) both
///     parsed to `(0,0,13)`, compared EQUAL, so the updater could never move a
///     user from one nightly to the next; and
///   * a nightly compared EQUAL to its own stable `0.0.13`, so a prerelease user
///     was never offered the finished release.
///
/// `semver::Version` implements §11 precedence (numeric identifiers compare
/// numerically, numeric ranks below alphanumeric, a shorter identifier list ranks
/// lower, and any prerelease ranks below its stable). Build metadata is ignored
/// for ordering per §10, which is why the release version carries the commit in
/// its title rather than as `+sha`.
///
/// Leniency: a two-component version (`1.2`) is padded to `1.2.0` so this stays
/// compatible with the looser parser it replaces.
fn parse_version(version: &str) -> Option<semver::Version> {
    let raw = normalise_tag(version);
    if let Ok(v) = semver::Version::parse(raw) {
        return Some(v);
    }
    // Lenient pad: `1` → `1.0.0`, `1.2` → `1.2.0`. Only the numeric core is
    // padded; anything with a suffix that strict parsing rejected stays rejected.
    let core_len = raw
        .split(['-', '+'])
        .next()
        .unwrap_or(raw)
        .split('.')
        .count();
    if (1..3).contains(&core_len) {
        let padded = match core_len {
            1 => format!("{raw}.0.0"),
            _ => format!("{raw}.0"),
        };
        return semver::Version::parse(&padded).ok();
    }
    None
}

/// The release channel a version belongs to: its first prerelease identifier, or
/// `"stable"` when it has none.
///
/// This makes a build SELF-DESCRIBING — a Core running `0.0.13-nightly.20260728.932`
/// knows it is on the nightly channel without any stored preference. That is what
/// lets `/api/update/check` return the right verdict by default; the desktop's
/// user-chosen channel is an explicit override on top (`?channel=`).
pub fn channel_of(version: &str) -> String {
    match parse_version(version) {
        Some(v) if !v.pre.is_empty() => v
            .pre
            .as_str()
            .split('.')
            .next()
            .unwrap_or(STABLE_CHANNEL)
            .to_string(),
        _ => STABLE_CHANNEL.to_string(),
    }
}

/// Pick the version a listing should install for a given release channel.
///
/// `versions` is the published tag list — each entry the raw tag, which is what
/// the Versions tab carries verbatim.
///
/// Takes the SEMVER MAXIMUM within the channel, not the first match, matching
/// [`select_release`] so the two paths cannot disagree about what "newest on a
/// channel" means. List order is GitHub's publish order, not semver order: a
/// patch cut from an old branch and published later sorts first, and picking by
/// position would hand it back as the newest.
///
/// This is the same model Core uses for its own builds — a version is
/// self-describing, so a channel is read off the tag rather than stored — applied
/// to marketplace listings so a plugin can ship nightly/canary/beta trains the way
/// the app does.
///
/// Two rules, both chosen so a channel can never make things worse:
///
///   - A channel selects only its OWN builds. Asking for `beta` never hands back a
///     nightly, even when the nightly is newer. Blending them is how a "beta"
///     subscriber silently ends up on the least-tested train.
///   - `stable` means exactly "no prerelease suffix". A tag like `1.2.0-rc.1` is
///     NOT stable, however finished it looks.
///
/// Returns `None` when the channel has no build yet, which the caller must treat
/// as "stay where you are" rather than falling back to another channel — a silent
/// fallback is how someone on `canary` quietly gets moved to stable.
pub fn pick_version_for_channel<'a>(versions: &[&'a str], channel: &str) -> Option<&'a str> {
    let want = channel.trim().to_ascii_lowercase();
    let want = if want.is_empty() {
        STABLE_CHANNEL
    } else {
        &want
    };
    versions
        .iter()
        .filter(|tag| channel_of(tag) == want)
        // A tag that will not parse as semver cannot be compared, so it loses to
        // any that does — but is still eligible when it is all the channel has,
        // which is why the fold keeps the first-seen rather than dropping it.
        .copied()
        .fold(None::<&'a str>, |best, tag| match best {
            None => Some(tag),
            Some(current) => match (parse_version(tag), parse_version(current)) {
                (Some(a), Some(b)) if a > b => Some(tag),
                (Some(_), None) => Some(tag),
                _ => Some(current),
            },
        })
}

/// Every channel a listing actually publishes, newest-first order preserved.
///
/// Drives the channel picker: offering a channel with no builds would let someone
/// select one and then be told there is nothing there.
pub fn channels_available(versions: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in versions {
        let channel = channel_of(tag);
        if !out.contains(&channel) {
            out.push(channel);
        }
    }
    out
}

/// The channel name for a build with no prerelease suffix.
pub const STABLE_CHANNEL: &str = "stable";

/// `true` when `latest` is strictly newer than `current` by semver precedence.
///
/// Fail-safe preserved from the original: an unparseable `latest` NEVER claims to
/// be newer, so a malformed or hand-edited tag cannot trigger an update. The
/// converse is allowed — a real release IS newer than an unparseable installed
/// version, so a corrupt install can still recover onto a good build.
pub fn is_newer(current: &str, latest: &str) -> bool {
    // Build metadata MUST NOT affect precedence (semver §10), but the `semver`
    // crate's `Ord` compares it anyway — so two builds differing only by a `+sha`
    // would falsely read as an update. Clear it before comparing. (Parsing keeps
    // it, so the version can still be DISPLAYED in full.)
    let strip_build = |mut v: semver::Version| {
        v.build = semver::BuildMetadata::EMPTY;
        v
    };
    match (
        parse_version(current).map(strip_build),
        parse_version(latest).map(strip_build),
    ) {
        (Some(current), Some(latest)) => latest > current,
        // Malformed `latest` never wins.
        (_, None) => false,
        // Malformed `current` — any real release is an upgrade.
        (None, Some(_)) => true,
    }
}

/// The release asset name of THIS platform's standalone Core binary — the
/// `ryu-core-{platform_tag}{ext}` contract `.github/workflows/release.yml`
/// ("Stage + rename assets") publishes, e.g. `ryu-core-linux-x86_64` or
/// `ryu-core-windows-x86_64.exe`.
pub fn core_asset_name() -> String {
    format!(
        "ryu-core-{}{}",
        platform_tag(),
        std::env::consts::EXE_SUFFIX
    )
}

/// Infer an installer kind from an asset filename.
fn asset_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    // The bare Core binary carries no extension off Windows, so the suffix table
    // below cannot classify it; it is still a raw executable.
    if lower == core_asset_name().to_ascii_lowercase() {
        return "exe";
    }
    if lower.ends_with(".msi") {
        "msi"
    } else if lower.ends_with(".exe") {
        "exe"
    } else if lower.ends_with(".dmg") {
        "dmg"
    } else if lower.ends_with(".appimage") {
        "appimage"
    } else if lower.ends_with(".deb") {
        "deb"
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".zip") {
        "archive"
    } else {
        "unknown"
    }
}

/// A single GitHub release asset as returned by the releases API.
#[derive(Clone, Serialize, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

/// The subset of the GitHub release payload we consume.
#[derive(Clone, Default, Serialize, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    /// RFC-3339 publish instant. GitHub sends it on both `/releases/latest` and
    /// the listing, but omits it for a draft — hence `Option`, never a default
    /// "now" that would silently place an undated release inside every window.
    #[serde(default)]
    published_at: Option<String>,
    /// `/releases/latest` excludes drafts and prereleases for free; the LISTING
    /// endpoint does not, so these two are what let the listing path reproduce
    /// that exclusion (see `release_is_on_channel`).
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// The version a release advertises.
///
/// Two shapes exist, and the tag is now the primary source for BOTH:
///
///   * **Versioned tags** (`v0.0.13`, `v0.0.13-beta.1`, and since 2026-08-04 the
///     rolling channels too — `v0.1.2-canary.20260804.36`) — the tag IS the version.
///   * **Title fallback** — until 2026-08-04 `canary`/`nightly` published to a fixed
///     rolling tag carrying no version, so the version had to be read out of the
///     release TITLE (`Nightly 0.0.13-nightly.20260728.932 (f1a68ac9b05c)`). Those
///     workflows now stamp a versioned tag per build and keep a bounded window of
///     history instead of deleting the previous one (docs/RELEASING.md §11), but the
///     title scan stays: it still parses every release published before the change,
///     and it is the safety net for a hand-made tag.
///
/// So: try the tag, then scan the title for the first semver-shaped token. Both
/// sources are workflow-controlled. `None` when neither yields a version.
fn release_version(release: &GhRelease) -> Option<String> {
    if let Some(v) = parse_version(&release.tag_name) {
        return Some(v.to_string());
    }
    // STRICT parse for the title scan — deliberately not the lenient `parse_version`.
    // Lenient parsing pads short versions (`2` -> `2.0.0`), so a human-edited title
    // like "Nightly build 2 — 0.0.13-nightly.20260728.932" would match the bare `2`
    // first and report the version as `2.0.0`. Requiring a full major.minor.patch
    // means only a real version token can win.
    release
        .name
        .as_deref()?
        .split_whitespace()
        .find_map(|token| {
            semver::Version::parse(normalise_tag(token.trim_matches(['(', ')', ',', ';'])))
                .ok()
                .map(|v| v.to_string())
        })
}

/// A release's publish instant, when GitHub gave us a parseable one.
///
/// `None` for a draft (GitHub omits the field) and for anything unparseable. Both
/// are treated as "we do not know when this shipped", never as "now" — see
/// [`select_release`] for what the callers do with that.
fn release_published_at(release: &GhRelease) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(release.published_at.as_deref()?).ok()
}

/// Whether a release belongs on `channel` and is publicly published.
///
/// The draft/prerelease guards exist because the LISTING endpoint returns both,
/// while `/releases/latest` filters them for free. A maintainer host that happens
/// to hold a `GITHUB_TOKEN` sees unpublished drafts in the listing, and without
/// this would be offered one as an update.
fn release_is_on_channel(release: &GhRelease, channel: &str) -> bool {
    if release.draft {
        return false;
    }
    // Only stable rejects prereleases: every build on beta/nightly/canary IS one.
    if channel == STABLE_CHANNEL && release.prerelease {
        return false;
    }
    release_version(release).is_some_and(|version| channel_of(&version) == channel)
}

/// The newest release on `channel`, optionally clamped to those published at or
/// before `published_at_or_before` (the caller's updates window).
///
/// ORDER IS LOAD-BEARING: filter by channel, then by the cutoff, THEN take the
/// semver maximum. Taking the maximum first would pick a release the cutoff
/// excludes and then resolve to nothing at all.
///
/// A release with no parseable publish date PASSES the cutoff filter. That is the
/// module's fail-open posture: a missing fact about our own release metadata must
/// not withhold a build from someone entitled to it.
fn select_release<'a>(
    releases: &'a [GhRelease],
    channel: &str,
    published_at_or_before: Option<chrono::DateTime<chrono::FixedOffset>>,
) -> Option<&'a GhRelease> {
    releases
        .iter()
        .filter(|release| release_is_on_channel(release, channel))
        .filter(|release| {
            match (published_at_or_before, release_published_at(release)) {
                (Some(cutoff), Some(published)) => published <= cutoff,
                // No cutoff, or no known date: keep it.
                _ => true,
            }
        })
        .filter_map(|release| Some((parse_version(&release_version(release)?)?, release)))
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, release)| release)
}

/// The newest SECURITY-marked release on `channel` published strictly after
/// `published_after` — the escape hatch that lets a fix reach an owner whose
/// updates window has already lapsed.
///
/// WHY THE MAXIMUM OF *MARKED* RELEASES AND NOT SIMPLY THE ABSOLUTE LATEST: a
/// marked release stays in the listing forever, so waiving to the absolute latest
/// would mean one security fix in March permanently hands every later feature
/// release to every lapsed owner. Resolving to the marked release delivers the fix
/// and self-limits — once the owner is on it, `is_newer` is false.
///
/// Unlike [`select_release`] this REQUIRES a parseable publish date: the waiver is
/// an override of the paid boundary, so it only fires on a positively dated,
/// positively marked release.
fn newest_security_release<'a>(
    releases: &'a [GhRelease],
    channel: &str,
    published_after: chrono::DateTime<chrono::FixedOffset>,
) -> Option<&'a GhRelease> {
    releases
        .iter()
        .filter(|release| release_is_on_channel(release, channel))
        .filter(|release| {
            release
                .body
                .as_deref()
                .is_some_and(|body| body.contains(SECURITY_CRITICAL_MARKER))
        })
        .filter(|release| {
            release_published_at(release).is_some_and(|published| published > published_after)
        })
        .filter_map(|release| Some((parse_version(&release_version(release)?)?, release)))
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, release)| release)
}

/// An optional GitHub token used only to raise the release-API rate limit.
///
/// Read from the usual env names so a CI runner or a self-hosted node picks one
/// up without extra configuration. Never required: the update check works
/// unauthenticated, it just shares the 60/hr per-IP budget with everything else
/// on that address.
fn github_token() -> Option<String> {
    ["RYU_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]
        .iter()
        .find_map(|key| {
            std::env::var(key)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

/// How long a fetched release stays fresh.
///
/// Without this every `/api/update/check` was a live GitHub call, so N surfaces
/// × M launches burned the unauthenticated budget and then failed open to "no
/// update" for the rest of the hour. Releases change on the order of days;
/// minutes of staleness costs nothing.
const RELEASE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Marker a release body carries to opt OUT of updates-window clamping. A
/// security fix must reach every installed build, including one whose owner's
/// updates window has lapsed — withholding it is worse than giving away a
/// feature release. Emitted by `.github/workflows/mirror-releases.yml`.
const SECURITY_CRITICAL_MARKER: &str = "<!-- ryu:security-critical -->";

/// Releases requested per listing call. There is no pagination: once versioned
/// releases exceed this, a deep-past cutoff can find nothing eligible and the
/// verdict reports `cutoff_unresolved` rather than guessing.
const PER_PAGE: u32 = 100;

/// Deadline for a GitHub call. `ServerState.client` is a bare `reqwest::Client`
/// with no timeout of its own, and an update check must never be able to hang a
/// launch — least of all on the listing endpoint, whose payload is two orders of
/// magnitude larger than a single release.
const GITHUB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Per-channel cache of the last successfully fetched release.
static RELEASE_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, GhRelease)>>,
> = std::sync::OnceLock::new();

const RELEASE_DISK_CACHE_DIR: &str = "update-releases";

#[derive(Serialize, Deserialize)]
struct ReleaseDiskCache<T> {
    fetched_at: u64,
    value: T,
}

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn release_cache_path(name: &str) -> std::path::PathBuf {
    let safe = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    crate::paths::cache_dir()
        .join(RELEASE_DISK_CACHE_DIR)
        .join(format!("{safe}.json"))
}

fn read_release_disk_cache<T>(path: &std::path::Path) -> Option<ReleaseDiskCache<T>>
where
    T: serde::de::DeserializeOwned,
{
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_release_disk_cache<T>(path: &std::path::Path, value: &T)
where
    T: Serialize,
{
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let envelope = ReleaseDiskCache {
        fetched_at: now_unix_seconds(),
        value,
    };
    let Ok(json) = serde_json::to_vec(&envelope) else {
        return;
    };
    let temporary = path.with_extension("json.tmp");
    if std::fs::write(&temporary, json).is_ok() {
        let _ = std::fs::rename(temporary, path);
    }
}

fn cached_release(channel: &str, allow_stale: bool) -> Option<GhRelease> {
    let cache = RELEASE_CACHE.get_or_init(Default::default);
    let guard = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((fetched_at, release)) = guard.get(channel) {
        return (allow_stale || fetched_at.elapsed() < RELEASE_CACHE_TTL).then(|| release.clone());
    }
    drop(guard);

    let disk = read_release_disk_cache::<GhRelease>(&release_cache_path(channel))?;
    let age = now_unix_seconds().saturating_sub(disk.fetched_at);
    if age > RELEASE_CACHE_TTL.as_secs() {
        return allow_stale.then_some(disk.value);
    }
    let fetched_at = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(age))
        .unwrap_or_else(std::time::Instant::now);
    let release = disk.value;
    let mut guard = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.insert(channel.to_string(), (fetched_at, release.clone()));
    (allow_stale || fetched_at.elapsed() < RELEASE_CACHE_TTL).then_some(release)
}

fn cache_release(channel: &str, release: &GhRelease) {
    let cache = RELEASE_CACHE.get_or_init(Default::default);
    {
        let mut guard = cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.insert(
            channel.to_string(),
            (std::time::Instant::now(), release.clone()),
        );
    }
    write_release_disk_cache(&release_cache_path(channel), release);
}

/// Fetch the release that represents the newest build on `channel`.
///
/// Stable uses `/releases/latest`, which GitHub defines to EXCLUDE prereleases —
/// exactly the semantics stable wants, and the reason a stable node can never
/// auto-update onto a nightly.
///
/// Every other channel MUST NOT use that endpoint, for the same reason: a nightly
/// or beta release is a prerelease and is therefore invisible there. This was the
/// second half of why the channel picker was inert. Instead, list releases and pick
/// the highest-precedence one whose version belongs to `channel`.
async fn fetch_channel_release(
    client: &reqwest::Client,
    channel: &str,
) -> anyhow::Result<GhRelease> {
    if let Some(release) = cached_release(channel, false) {
        return Ok(release);
    }
    match fetch_channel_release_remote(client, channel).await {
        Ok(release) => {
            cache_release(channel, &release);
            Ok(release)
        }
        // A release we saw earlier beats failing open to "no update" for the
        // rest of the hour — GitHub's unauthenticated budget is 60/hr per IP,
        // and every surface checks on launch.
        Err(err) => cached_release(channel, true).ok_or(err),
    }
}

/// One GitHub GET, with the headers, the optional token and the deadline every
/// release call needs.
///
/// GitHub allows 60 unauthenticated calls per hour PER IP. Every surface checks on
/// launch, so a shared IP (or a dev machine running the stack a few times)
/// exhausts that and every check fails open to "no update" — the app-update row
/// then silently never appears. A token, when the host has one, raises the ceiling
/// to 5000/hr. Optional by design: no token still works, it is just rate-limited.
pub(crate) async fn github_get(
    client: &reqwest::Client,
    url: String,
) -> reqwest::Result<reqwest::Response> {
    let mut req = client
        .get(url)
        .header("User-Agent", "ryu-core/1.0")
        .header("Accept", "application/vnd.github+json")
        .timeout(GITHUB_TIMEOUT);
    if let Some(token) = github_token() {
        req = req.bearer_auth(token);
    }
    req.send().await
}

async fn fetch_channel_release_remote(
    client: &reqwest::Client,
    channel: &str,
) -> anyhow::Result<GhRelease> {
    if channel == STABLE_CHANNEL {
        let url = format!("https://api.github.com/repos/{RYU_REPO}/releases/latest");
        return Ok(github_get(client, url)
            .await?
            .error_for_status()?
            .json()
            .await?);
    }

    // One page is ample: rolling channels keep a single release, and betas are
    // few. Sorted newest-first by GitHub, but we order by semver precedence
    // ourselves rather than trusting publish order.
    //
    // Deliberately NOT routed through `select_release`: that adds draft/prerelease
    // filtering, and every build on a rolling channel IS a prerelease. This is the
    // historical unclamped path and stays byte-identical.
    let url = format!("https://api.github.com/repos/{RYU_REPO}/releases?per_page={PER_PAGE}");
    let releases: Vec<GhRelease> = github_get(client, url)
        .await?
        .error_for_status()?
        .json()
        .await?;

    releases
        .into_iter()
        .filter_map(|release| {
            let version = release_version(&release)?;
            (channel_of(&version) == channel).then_some((parse_version(&version)?, release))
        })
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, release)| release)
        .ok_or_else(|| anyhow::anyhow!("no release found on the '{channel}' channel"))
}

/// Cache of the last successfully fetched release LISTING.
///
/// Separate from [`RELEASE_CACHE`] and deliberately NOT keyed by channel: the
/// listing URL carries no channel, so one fetch serves every channel and every
/// cutoff. Only the clamped path needs it — an unclamped check never pays for it.
static RELEASE_LIST_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<CachedReleaseList>>> =
    std::sync::OnceLock::new();

/// `(fetched_at, releases)` as held by [`RELEASE_LIST_CACHE`]. The `Arc` is what
/// lets a cache hit hand the whole page to a caller without cloning it.
type CachedReleaseList = (std::time::Instant, std::sync::Arc<Vec<GhRelease>>);

fn cached_release_list(allow_stale: bool) -> Option<std::sync::Arc<Vec<GhRelease>>> {
    let cache = RELEASE_LIST_CACHE.get()?;
    let guard = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (fetched_at, releases) = guard.as_ref()?;
    (allow_stale || fetched_at.elapsed() < RELEASE_CACHE_TTL).then(|| releases.clone())
}

fn cache_release_list(releases: &std::sync::Arc<Vec<GhRelease>>) {
    let cache = RELEASE_LIST_CACHE.get_or_init(Default::default);
    let mut guard = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *guard = Some((std::time::Instant::now(), releases.clone()));
}

/// Fetch one page of releases across all channels.
///
/// Same TTL, same poison tolerance and same stale-on-error fallback as
/// [`fetch_channel_release`]: an old listing beats failing open to "no update" for
/// the rest of the hour.
async fn fetch_all_releases(
    client: &reqwest::Client,
) -> anyhow::Result<std::sync::Arc<Vec<GhRelease>>> {
    if let Some(releases) = cached_release_list(false) {
        return Ok(releases);
    }
    let url = format!("https://api.github.com/repos/{RYU_REPO}/releases?per_page={PER_PAGE}");
    let fetched: anyhow::Result<Vec<GhRelease>> = async {
        Ok(github_get(client, url)
            .await?
            .error_for_status()?
            .json()
            .await?)
    }
    .await;
    match fetched {
        Ok(releases) => {
            let releases = std::sync::Arc::new(releases);
            cache_release_list(&releases);
            Ok(releases)
        }
        Err(err) => cached_release_list(true).ok_or(err),
    }
}

/// The asset a node installs to update ITSELF: this platform's standalone Core
/// binary, matched by its exact published name.
///
/// Matched exactly rather than scored by OS/arch substrings. One release carries
/// Core, the Gateway, the CLI, every app sidecar (all `<bin>-<platform>`), their
/// `.sha256` files and the desktop installers, so a fuzzy "best match for this
/// platform" tied across dozens of assets and resolved to whichever came last —
/// a sidecar, a checksum file, or (on Windows, where any `.exe` matched) another
/// binary that `apply` would then swap in as Core. `None` when the release does
/// not publish this platform's Core binary.
fn best_asset(release: &GhRelease) -> Option<ReleaseAsset> {
    let wanted = core_asset_name();
    release
        .assets
        .iter()
        .find(|a| a.name == wanted)
        .map(|a| ReleaseAsset {
            kind: asset_kind(&a.name).to_string(),
            name: a.name.clone(),
            url: a.browser_download_url.clone(),
            size: a.size,
        })
}

/// Optional constraints on which release a check may resolve to.
#[derive(Clone, Copy, Default)]
pub struct UpdateCheckOptions<'a> {
    pub channel: Option<&'a str>,
    /// RFC-3339 instant. Clamp the verdict to the newest release published at
    /// or before it. `None` (the default) is the historical unclamped path and
    /// stays byte-identical. ADVISORY ONLY: this endpoint is unauthenticated,
    /// so the value is caller-supplied and trivially omitted.
    pub updates_until: Option<&'a str>,
}

/// Query the latest release on the channel this build belongs to and produce an
/// [`UpdateCheck`] verdict.
///
/// Fails open at the call site: callers treat a network/API error as "no update
/// known" rather than blocking launch.
pub async fn check_for_update(client: &reqwest::Client) -> anyhow::Result<UpdateCheck> {
    check_for_update_with(client, UpdateCheckOptions::default()).await
}

/// The full check: an explicit channel, optionally clamped to a caller's updates
/// window.
///
/// `channel: None` means "the channel this build is already on", derived from the
/// running version itself ([`channel_of`]) — a nightly build checks the nightly
/// channel without any stored preference. The desktop passes its user-chosen
/// channel explicitly so the picker can move a user between channels.
///
/// NOTE ON CROSS-CHANNEL COMPARISON: verdicts are scoped WITHIN a channel by
/// design. Semver orders prerelease identifiers alphabetically, which would rank
/// `beta < canary < nightly` — not a risk ordering, and meaningless as an update
/// path. Moving between channels is a channel switch, not an update.
///
/// With no `updates_until` this is the historical path, unchanged down to the
/// endpoint it calls. With one, it switches to the releases LISTING so it can
/// reason about publish dates, and reports which of the four outcomes applied via
/// `restricted_by_cutoff` / `cutoff_waived_for_security` / `cutoff_unresolved` —
/// a clamp, a security waiver, an exhausted page and a network failure must stay
/// distinguishable from each other.
pub async fn check_for_update_with(
    client: &reqwest::Client,
    opts: UpdateCheckOptions<'_>,
) -> anyhow::Result<UpdateCheck> {
    let current = current_version();
    let channel = opts
        .channel
        .map(str::to_string)
        .unwrap_or_else(|| channel_of(&current));

    let cutoff = opts.updates_until.and_then(|raw| {
        chrono::DateTime::parse_from_rfc3339(raw)
            .inspect_err(|_| {
                // A FIXED message that does not echo the caller-supplied value:
                // this route is public, so echoing it would let a LAN caller forge
                // log lines with newlines/ANSI. The parsed value is not logged
                // either — it is the user's licence-window fact.
                tracing::warn!("update check: unparseable updates_until, ignoring");
            })
            .ok()
    });

    if let Some(check) = fake_update_check(&current, &channel, cutoff) {
        return Ok(check);
    }

    let Some(cutoff) = cutoff else {
        // Unclamped: the historical path, byte-identical for every caller that
        // sends no cutoff — including GitHub's own draft/prerelease exclusion on
        // `/releases/latest`.
        let release = fetch_channel_release(client, &channel).await?;
        let latest = release_version(&release)
            .unwrap_or_else(|| normalise_tag(&release.tag_name).to_string());
        return Ok(UpdateCheck {
            update_available: is_newer(&current, &latest),
            current,
            latest_unrestricted: latest.clone(),
            latest,
            channel,
            notes: release.body.clone(),
            html_url: release.html_url.clone(),
            asset: best_asset(&release),
            tag: Some(release.tag_name.clone()),
            published_at: release.published_at.clone(),
            restricted_by_cutoff: false,
            cutoff_waived_for_security: false,
            cutoff_unresolved: false,
        });
    };

    let releases = fetch_all_releases(client).await?;
    let unrestricted = select_release(&releases, &channel, None)
        .ok_or_else(|| anyhow::anyhow!("no release found on the '{channel}' channel"))?;
    let unrestricted_version = release_version(unrestricted)
        .unwrap_or_else(|| normalise_tag(&unrestricted.tag_name).to_string());

    let clamped = select_release(&releases, &channel, Some(cutoff));
    let security = newest_security_release(&releases, &channel, cutoff);
    // The waiver resolves to the SECURITY release, not to the absolute latest, and
    // only when it actually outranks what the window already covers.
    //
    // Compared with `parse_version` directly rather than `is_newer`: this ranks two
    // RELEASES against each other, not a release against the installed build, and
    // `is_newer`'s build-metadata stripping is irrelevant because a Ryu release
    // version never carries `+sha` — the commit lives in the release title (see
    // `release_version`). Do not "fix" this into `is_newer`.
    let waived = match (
        clamped
            .and_then(release_version)
            .as_deref()
            .and_then(parse_version),
        security
            .and_then(release_version)
            .as_deref()
            .and_then(parse_version),
    ) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(covered), Some(fix)) => fix > covered,
    };
    let offered = if waived { security } else { clamped };

    let Some(offered) = offered else {
        // The page did not reach back far enough. NOT an error and NOT a clamp: a
        // third state. `latest` is a placeholder, so no surface may present it as
        // "the newest build your window covers".
        tracing::warn!(
            "update check: no release on '{channel}' falls inside the supplied updates window (page size {PER_PAGE})"
        );
        return Ok(UpdateCheck {
            latest: current.clone(),
            current,
            channel,
            update_available: false,
            notes: None,
            html_url: unrestricted.html_url.clone(),
            asset: None,
            tag: None,
            published_at: None,
            latest_unrestricted: unrestricted_version,
            restricted_by_cutoff: true,
            cutoff_waived_for_security: false,
            cutoff_unresolved: true,
        });
    };

    let latest =
        release_version(offered).unwrap_or_else(|| normalise_tag(&offered.tag_name).to_string());
    Ok(UpdateCheck {
        update_available: is_newer(&current, &latest),
        restricted_by_cutoff: latest != unrestricted_version,
        current,
        latest,
        channel,
        notes: offered.body.clone(),
        html_url: offered.html_url.clone(),
        asset: best_asset(offered),
        tag: Some(offered.tag_name.clone()),
        published_at: offered.published_at.clone(),
        latest_unrestricted: unrestricted_version,
        cutoff_waived_for_security: waived,
        cutoff_unresolved: false,
    })
}

/// Verification / dev hook: force a "latest" version without a published release.
/// Lets the desktop/cli update flow — including the LAPSED-WINDOW flow, which
/// otherwise needs a year of real releases to exercise — be driven end-to-end
/// before the release CI has produced real assets. Never set in production.
///
/// `RYU_UPDATE_FAKE_PUBLISHED_AT` dates the simulated release; when it falls after
/// the cutoff the verdict is the clamped one. There is deliberately no env var for
/// the OFFERED release's own date, so the hook exercises the clamp and the
/// manual-download fallback, not the pinned install.
fn fake_update_check(
    current: &str,
    channel: &str,
    cutoff: Option<chrono::DateTime<chrono::FixedOffset>>,
) -> Option<UpdateCheck> {
    let fake = std::env::var("RYU_UPDATE_FAKE_LATEST").ok()?;
    let latest = normalise_tag(&fake).to_string();
    let published_at = std::env::var("RYU_UPDATE_FAKE_PUBLISHED_AT")
        .ok()
        .filter(|raw| !raw.trim().is_empty());
    let published = published_at
        .as_deref()
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok());
    let restricted =
        matches!((cutoff, published), (Some(cutoff), Some(published)) if published > cutoff);
    let tag = std::env::var("RYU_UPDATE_FAKE_TAG")
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .or_else(|| {
            Some(format!(
                "v{}",
                if restricted { current } else { latest.as_str() }
            ))
        });

    Some(UpdateCheck {
        update_available: !restricted && is_newer(current, &latest),
        current: current.to_string(),
        latest: if restricted {
            current.to_string()
        } else {
            latest.clone()
        },
        channel: channel.to_string(),
        notes: Some(format!(
            "Simulated release {latest} (RYU_UPDATE_FAKE_LATEST)."
        )),
        html_url: Some(format!("https://github.com/{RYU_REPO}/releases")),
        asset: None,
        tag,
        published_at: (!restricted).then_some(published_at).flatten(),
        latest_unrestricted: latest,
        restricted_by_cutoff: restricted,
        cutoff_waived_for_security: false,
        cutoff_unresolved: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_tags() {
        assert_eq!(normalise_tag("v1.2.3"), "1.2.3");
        assert_eq!(normalise_tag("V0.1.0"), "0.1.0");
        assert_eq!(normalise_tag(" 2.0.0 "), "2.0.0");
    }

    #[test]
    fn parses_semver_with_suffixes() {
        let v = parse_version("1.2.3").expect("plain semver parses");
        assert_eq!((v.major, v.minor, v.patch), (1, 2, 3));
        assert!(v.pre.is_empty());

        // The prerelease is now RETAINED (it used to be discarded).
        let pre = parse_version("1.2.3-beta.1").expect("prerelease parses");
        assert_eq!(pre.pre.as_str(), "beta.1");

        // Build metadata parses and is kept out of ordering.
        assert!(parse_version("1.2.3+build5").is_some());

        // Lenient padding for short versions, strict rejection of junk.
        let short = parse_version("1.2").expect("two-component version pads");
        assert_eq!((short.major, short.minor, short.patch), (1, 2, 0));
        assert!(parse_version("garbage").is_none());
    }

    #[test]
    fn channel_of_reads_the_first_prerelease_identifier() {
        // A build is self-describing: its own version names its channel.
        assert_eq!(channel_of("0.0.13"), "stable");
        assert_eq!(channel_of("v0.0.13"), "stable");
        assert_eq!(channel_of("0.0.13-beta.1"), "beta");
        assert_eq!(channel_of("0.0.13-nightly.20260728.932"), "nightly");
        assert_eq!(channel_of("0.0.13-canary.20260728.932"), "canary");
        // Unparseable falls back to stable rather than inventing a channel.
        assert_eq!(channel_of("garbage"), "stable");
    }

    #[test]
    fn detects_newer_versions() {
        assert!(is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.1.0", "v0.1.1"));
        assert!(is_newer("1.0.0", "2.0.0"));
        assert!(!is_newer("0.2.0", "0.1.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        // Malformed latest never claims to be newer.
        assert!(!is_newer("0.1.0", "garbage"));
        // ...but a real release still rescues a corrupt installed version.
        assert!(is_newer("garbage", "0.1.0"));
    }

    // ── Prerelease precedence ────────────────────────────────────────────────
    //
    // These mirror `scripts/release/next-version.test.mjs`. The generator and this
    // comparator MUST agree: the script decides what version a build carries, this
    // decides whether that build is an update. A divergence ships a wrong verdict.

    #[test]
    fn prerelease_ranks_below_its_own_stable() {
        // The bug this replaced: the suffix was discarded, so these compared EQUAL
        // and a nightly user was never offered the finished 0.0.13.
        assert!(is_newer("0.0.13-nightly.20260728.932", "0.0.13"));
        assert!(is_newer("0.0.13-beta.1", "0.0.13"));
        assert!(!is_newer("0.0.13", "0.0.13-nightly.20260728.932"));
    }

    #[test]
    fn nightlies_order_by_date_then_build_number() {
        // The other half of the bug: every nightly parsed identically, so the
        // channel could never advance.
        assert!(is_newer(
            "0.0.13-nightly.20260728.932",
            "0.0.13-nightly.20260729.940"
        ));
        assert!(!is_newer(
            "0.0.13-nightly.20260729.940",
            "0.0.13-nightly.20260728.932"
        ));
        // Same day, later run number.
        assert!(is_newer(
            "0.0.13-nightly.20260728.932",
            "0.0.13-nightly.20260728.933"
        ));
    }

    #[test]
    fn numeric_identifiers_compare_numerically_not_lexically() {
        // Lexically "10" < "9"; numerically 10 > 9. Getting this wrong stalls the
        // beta channel at beta.9.
        assert!(is_newer("0.0.13-beta.9", "0.0.13-beta.10"));
        assert!(is_newer(
            "0.0.13-nightly.20260728.99",
            "0.0.13-nightly.20260728.100"
        ));
    }

    #[test]
    fn canonical_semver_precedence_chain_holds() {
        let ascending = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ];
        for pair in ascending.windows(2) {
            assert!(
                is_newer(pair[0], pair[1]),
                "{} should precede {}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    fn build_metadata_is_ignored_for_precedence() {
        assert!(!is_newer("1.0.0+aaa", "1.0.0+zzz"));
        assert!(!is_newer("1.0.0+zzz", "1.0.0+aaa"));
    }

    #[test]
    fn core_triple_dominates_the_prerelease() {
        assert!(is_newer("0.0.12", "0.0.13-nightly.20260728.1"));
        assert!(!is_newer("0.2.0-beta.1", "0.1.0"));
    }

    #[test]
    fn release_version_prefers_the_tag_then_the_title() {
        // Versioned tag: the tag IS the version.
        let tagged = GhRelease {
            tag_name: "v0.0.13-beta.1".to_string(),
            name: Some("Ryu v0.0.13-beta.1".to_string()),
            ..Default::default()
        };
        assert_eq!(release_version(&tagged).as_deref(), Some("0.0.13-beta.1"));

        // Rolling tag: the tag is a pointer, so the version comes from the title
        // the workflow writes. The trailing `(sha)` must not be mistaken for it.
        let rolling = GhRelease {
            tag_name: "nightly".to_string(),
            name: Some("Nightly 0.0.13-nightly.20260728.932 (f1a68ac9b05c)".to_string()),
            ..Default::default()
        };
        assert_eq!(
            release_version(&rolling).as_deref(),
            Some("0.0.13-nightly.20260728.932")
        );

        // Neither source carries a version.
        let bare = GhRelease {
            tag_name: "nightly".to_string(),
            name: Some("Nightly build".to_string()),
            ..Default::default()
        };
        assert_eq!(release_version(&bare), None);

        // A bare number earlier in a human-edited title must NOT be mistaken for the
        // version. The lenient parser pads `2` to `2.0.0`; the title scan is strict
        // precisely so that cannot happen.
        let edited = GhRelease {
            tag_name: "nightly".to_string(),
            name: Some("Nightly build 2 — 0.0.13-nightly.20260728.932".to_string()),
            ..Default::default()
        };
        assert_eq!(
            release_version(&edited).as_deref(),
            Some("0.0.13-nightly.20260728.932")
        );
    }

    #[test]
    fn infers_asset_kind() {
        assert_eq!(asset_kind("Ryu_0.2.0_x64.msi"), "msi");
        assert_eq!(asset_kind("ryu-cli-windows.exe"), "exe");
        assert_eq!(asset_kind("Ryu_0.2.0_aarch64.dmg"), "dmg");
        assert_eq!(asset_kind("ryu-0.2.0.AppImage"), "appimage");
        assert_eq!(asset_kind("ryu-core-linux-x86_64.tar.gz"), "archive");
    }

    #[test]
    fn version_info_is_single_release_train() {
        let info = version_info();
        assert_eq!(info.components.len(), 4);
        for c in &info.components {
            assert_eq!(c.version, info.ryu_version);
        }
    }

    // ── extra coverage ───────────────────────────────────────────────────────

    /// Serialize the `RYU_UPDATE_FAKE_*` env mutations across tests here.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn asset_kind_covers_deb_zip_and_unknown() {
        assert_eq!(asset_kind("ryu_0.2.0_amd64.deb"), "deb");
        assert_eq!(asset_kind("ryu-core-windows-x86_64.zip"), "archive");
        assert_eq!(asset_kind("checksums.txt"), "unknown");
        // Case-insensitive extension match.
        assert_eq!(asset_kind("Ryu.DMG"), "dmg");
    }

    #[test]
    fn best_asset_is_this_platforms_core_binary_and_nothing_else() {
        let core = core_asset_name();
        let ext = std::env::consts::EXE_SUFFIX;
        let platform = platform_tag();
        let asset = |name: &str| GhAsset {
            name: name.to_string(),
            browser_download_url: format!(
                "https://github.com/{RYU_REPO}/releases/download/v1.0.0/{name}"
            ),
            size: 10,
        };
        // Every other per-platform binary, its checksum, and the desktop
        // installers share the platform tokens; listing Core FIRST proves the
        // pick is not "whichever tied asset came last".
        let release = GhRelease {
            tag_name: "v1.0.0".into(),
            assets: vec![
                asset(&core),
                asset(&format!("ryu-gateway-{platform}{ext}")),
                asset(&format!("ryu-mail-{platform}{ext}")),
                asset(&format!("{core}.sha256")),
                asset("Ryu_1.0.0_x64-setup.exe"),
                asset("Ryu_1.0.0_aarch64.dmg"),
                asset("Ryu_1.0.0_amd64.AppImage"),
            ],
            ..GhRelease::default()
        };
        let picked = best_asset(&release).expect("core binary is published");
        assert_eq!(picked.name, core);
        assert_eq!(picked.kind, "exe");

        let without_core = GhRelease {
            assets: release.assets[1..].to_vec(),
            ..release
        };
        assert!(best_asset(&without_core).is_none());
    }

    #[tokio::test]
    async fn check_for_update_honours_fake_latest_env() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // A far-future fake version is reported as an available update, no network.
        std::env::set_var("RYU_UPDATE_FAKE_LATEST", "v999.0.0");
        let client = reqwest::Client::new();
        let check = check_for_update(&client).await.unwrap();
        assert_eq!(check.latest, "999.0.0");
        assert!(check.update_available);
        assert!(check.notes.as_deref().unwrap().contains("999.0.0"));
        // With no cutoff in play, none of the clamp signals may fire.
        assert_eq!(check.latest_unrestricted, "999.0.0");
        assert_eq!(check.tag.as_deref(), Some("v999.0.0"));
        assert!(check.published_at.is_none());
        assert!(!check.restricted_by_cutoff);
        assert!(!check.cutoff_waived_for_security);
        assert!(!check.cutoff_unresolved);
        std::env::remove_var("RYU_UPDATE_FAKE_LATEST");
    }

    #[tokio::test]
    async fn check_for_update_fake_latest_not_newer_when_equal() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Faking the CURRENT version must not claim an update is available.
        std::env::set_var("RYU_UPDATE_FAKE_LATEST", current_version());
        let client = reqwest::Client::new();
        let check = check_for_update(&client).await.unwrap();
        assert!(!check.update_available);
        assert_eq!(check.latest_unrestricted, current_version());
        assert!(!check.restricted_by_cutoff);
        assert!(!check.cutoff_unresolved);
        std::env::remove_var("RYU_UPDATE_FAKE_LATEST");
    }

    // ── Cutoff-clamped release selection ─────────────────────────────────────
    //
    // The whole clamp is pure: fixtures in, a chosen release out. No env lock, no
    // network, no runtime.

    /// A published, non-draft release with a versioned tag and a publish date.
    fn rel(tag: &str, published_at: &str) -> GhRelease {
        GhRelease {
            tag_name: tag.to_string(),
            published_at: Some(published_at.to_string()),
            ..Default::default()
        }
    }

    /// As [`rel`], but its body carries the security marker among ordinary prose —
    /// the marker must be found anywhere in the body, not only alone on a line.
    fn sec(tag: &str, published_at: &str) -> GhRelease {
        GhRelease {
            body: Some(format!(
                "## Fixes\n{SECURITY_CRITICAL_MARKER}\nPatches a sandbox escape."
            )),
            ..rel(tag, published_at)
        }
    }

    fn at(rfc3339: &str) -> chrono::DateTime<chrono::FixedOffset> {
        chrono::DateTime::parse_from_rfc3339(rfc3339).expect("test timestamp parses")
    }

    fn chosen(release: Option<&GhRelease>) -> Option<String> {
        release.map(|r| r.tag_name.clone())
    }

    #[test]
    fn select_release_takes_the_semver_maximum_in_channel() {
        let releases = [
            rel("v0.1.0", "2026-01-01T00:00:00Z"),
            rel("v0.2.0", "2026-06-01T00:00:00Z"),
            rel("v0.2.0-beta.1", "2026-05-01T00:00:00Z"),
        ];
        assert_eq!(
            chosen(select_release(&releases, STABLE_CHANNEL, None)).as_deref(),
            Some("v0.2.0")
        );
    }

    #[test]
    fn select_release_clamps_to_the_newest_release_at_or_before_the_cutoff() {
        let releases = [
            rel("v0.1.0", "2026-01-01T00:00:00Z"),
            rel("v0.2.0", "2026-06-01T00:00:00Z"),
            rel("v0.3.0", "2027-01-01T00:00:00Z"),
        ];
        let picked = select_release(&releases, STABLE_CHANNEL, Some(at("2026-12-31T00:00:00Z")));
        assert_eq!(chosen(picked).as_deref(), Some("v0.2.0"));
    }

    #[test]
    fn select_release_filters_the_cutoff_before_taking_the_maximum() {
        // Guards the ORDER: taking the maximum first would pick v9.0.0 and then
        // find it excluded, resolving to nothing.
        let releases = [
            rel("v1.0.0", "2026-01-01T00:00:00Z"),
            rel("v9.0.0", "2027-06-01T00:00:00Z"),
        ];
        let picked = select_release(&releases, STABLE_CHANNEL, Some(at("2026-06-01T00:00:00Z")));
        assert_eq!(chosen(picked).as_deref(), Some("v1.0.0"));
    }

    #[test]
    fn select_release_treats_the_cutoff_boundary_as_inclusive() {
        let releases = [rel("v1.0.0", "2026-06-01T12:00:00Z")];
        let picked = select_release(&releases, STABLE_CHANNEL, Some(at("2026-06-01T12:00:00Z")));
        assert_eq!(chosen(picked).as_deref(), Some("v1.0.0"));
    }

    #[test]
    fn select_release_skips_drafts_and_stable_prereleases() {
        // `/releases/latest` filters both for free; the listing does not, so the
        // clamped path has to do it explicitly.
        let releases = [
            rel("v0.2.0", "2026-01-01T00:00:00Z"),
            GhRelease {
                draft: true,
                ..rel("v0.9.0", "2026-02-01T00:00:00Z")
            },
            GhRelease {
                prerelease: true,
                ..rel("v0.8.0", "2026-03-01T00:00:00Z")
            },
        ];
        assert_eq!(
            chosen(select_release(&releases, STABLE_CHANNEL, None)).as_deref(),
            Some("v0.2.0")
        );
    }

    #[test]
    fn select_release_keeps_a_release_with_no_publish_date_under_a_cutoff() {
        // Fail open: a missing fact about our own release metadata must not
        // withhold a build from someone entitled to it.
        let releases = [GhRelease {
            tag_name: "v1.0.0".to_string(),
            ..Default::default()
        }];
        let picked = select_release(&releases, STABLE_CHANNEL, Some(at("2020-01-01T00:00:00Z")));
        assert_eq!(chosen(picked).as_deref(), Some("v1.0.0"));
    }

    #[test]
    fn select_release_returns_none_when_every_release_is_after_the_cutoff() {
        let releases = [
            rel("v1.0.0", "2027-01-01T00:00:00Z"),
            rel("v2.0.0", "2027-06-01T00:00:00Z"),
        ];
        assert!(
            select_release(&releases, STABLE_CHANNEL, Some(at("2026-01-01T00:00:00Z"))).is_none()
        );
    }

    #[test]
    fn select_release_scopes_to_the_requested_channel() {
        let releases = [
            rel("v0.2.0", "2026-01-01T00:00:00Z"),
            GhRelease {
                prerelease: true,
                ..rel("v0.3.0-nightly.20260601.1", "2026-06-01T00:00:00Z")
            },
        ];
        assert_eq!(
            chosen(select_release(&releases, STABLE_CHANNEL, None)).as_deref(),
            Some("v0.2.0")
        );
        assert_eq!(
            chosen(select_release(&releases, "nightly", None)).as_deref(),
            Some("v0.3.0-nightly.20260601.1")
        );
    }

    #[test]
    fn newest_security_release_finds_only_marked_releases_after_the_cutoff() {
        // The UNMARKED v0.4.0 is newer, but the waiver resolves to the marked
        // release so one fix cannot hand over every later feature release.
        let releases = [
            rel("v0.4.0", "2027-03-01T00:00:00Z"),
            sec("v0.3.0", "2027-02-01T00:00:00Z"),
        ];
        let picked = newest_security_release(&releases, STABLE_CHANNEL, at("2027-01-01T00:00:00Z"));
        assert_eq!(chosen(picked).as_deref(), Some("v0.3.0"));
    }

    #[test]
    fn newest_security_release_ignores_a_marked_release_inside_the_cutoff() {
        // Already covered by the window — the waiver has nothing to add.
        let releases = [sec("v0.3.0", "2026-02-01T00:00:00Z")];
        assert!(
            newest_security_release(&releases, STABLE_CHANNEL, at("2027-01-01T00:00:00Z"))
                .is_none()
        );
    }

    #[test]
    fn newest_security_release_is_none_when_nothing_is_marked() {
        let releases = [
            rel("v0.3.0", "2027-02-01T00:00:00Z"),
            rel("v0.4.0", "2027-03-01T00:00:00Z"),
        ];
        assert!(
            newest_security_release(&releases, STABLE_CHANNEL, at("2027-01-01T00:00:00Z"))
                .is_none()
        );
    }

    #[test]
    fn release_published_at_parses_rfc3339_and_tolerates_garbage() {
        assert!(release_published_at(&rel("v1.0.0", "2026-06-01T00:00:00Z")).is_some());
        assert!(release_published_at(&rel("v1.0.0", "")).is_none());
        assert!(release_published_at(&rel("v1.0.0", "not-a-date")).is_none());
        assert!(release_published_at(&GhRelease {
            tag_name: "v1.0.0".to_string(),
            ..Default::default()
        })
        .is_none());
    }

    #[tokio::test]
    async fn check_for_update_fake_latest_clamps_against_a_cutoff() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // A simulated release published AFTER the window: the verdict must report
        // the clamp rather than the bare "no update" a network failure returns.
        std::env::set_var("RYU_UPDATE_FAKE_LATEST", "v999.0.0");
        std::env::set_var("RYU_UPDATE_FAKE_PUBLISHED_AT", "2027-06-01T00:00:00Z");
        let client = reqwest::Client::new();
        let check = check_for_update_with(
            &client,
            UpdateCheckOptions {
                channel: None,
                updates_until: Some("2026-06-01T00:00:00Z"),
            },
        )
        .await
        .unwrap();
        assert_eq!(check.latest, current_version());
        assert!(!check.update_available);
        assert_eq!(check.latest_unrestricted, "999.0.0");
        assert!(check.restricted_by_cutoff);
        assert!(!check.cutoff_unresolved);
        assert!(!check.cutoff_waived_for_security);
        std::env::remove_var("RYU_UPDATE_FAKE_PUBLISHED_AT");
        std::env::remove_var("RYU_UPDATE_FAKE_LATEST");
    }

    #[tokio::test]
    async fn check_for_update_ignores_an_unparseable_cutoff() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Fail open: junk in `updates_until` must behave exactly like no cutoff.
        std::env::set_var("RYU_UPDATE_FAKE_LATEST", "v999.0.0");
        std::env::set_var("RYU_UPDATE_FAKE_PUBLISHED_AT", "2027-06-01T00:00:00Z");
        let client = reqwest::Client::new();
        let check = check_for_update_with(
            &client,
            UpdateCheckOptions {
                channel: None,
                updates_until: Some("not-a-date"),
            },
        )
        .await
        .unwrap();
        assert_eq!(check.latest, "999.0.0");
        assert!(check.update_available);
        assert!(!check.restricted_by_cutoff);
        std::env::remove_var("RYU_UPDATE_FAKE_PUBLISHED_AT");
        std::env::remove_var("RYU_UPDATE_FAKE_LATEST");
    }
}

#[cfg(test)]
mod version_gate_tests {
    use super::*;

    /// A listing publishing several trains at once — the case the feature exists
    /// for. Newest-first, as `fetch_releases` returns them.
    const MIXED: [&str; 6] = [
        "v1.3.0-nightly.20260803.7",
        "v1.3.0-canary.2",
        "v1.2.0",
        "v1.2.0-rc.1",
        "v1.1.0-beta.4",
        "v1.1.0",
    ];

    #[test]
    fn a_channel_selects_only_its_own_builds() {
        // The rule that matters: asking for beta must never hand back the nightly,
        // even though the nightly is newer. Blending trains is how a "beta"
        // subscriber silently lands on the least-tested one.
        let v: Vec<&str> = MIXED.to_vec();
        assert_eq!(pick_version_for_channel(&v, "beta"), Some("v1.1.0-beta.4"));
        assert_eq!(
            pick_version_for_channel(&v, "nightly"),
            Some("v1.3.0-nightly.20260803.7")
        );
        assert_eq!(
            pick_version_for_channel(&v, "canary"),
            Some("v1.3.0-canary.2")
        );
        assert_eq!(pick_version_for_channel(&v, "rc"), Some("v1.2.0-rc.1"));
    }

    /// GitHub returns releases in PUBLISH order, not semver order. A patch cut
    /// from an old branch and published later sorts first, so picking by position
    /// would hand it back as "newest". `select_release` already takes the semver
    /// maximum; this must agree with it.
    #[test]
    fn newest_on_a_channel_is_the_semver_maximum_not_the_first_listed() {
        let out_of_order: Vec<&str> = vec!["v1.0.1", "v2.0.0", "v1.0.0"];
        assert_eq!(
            pick_version_for_channel(&out_of_order, "stable"),
            Some("v2.0.0")
        );

        let betas: Vec<&str> = vec!["v1.0.0-beta.2", "v1.5.0-beta.1"];
        assert_eq!(
            pick_version_for_channel(&betas, "beta"),
            Some("v1.5.0-beta.1")
        );
    }

    #[test]
    fn stable_means_no_prerelease_suffix_at_all() {
        let v: Vec<&str> = MIXED.to_vec();
        // Newest STABLE, not newest overall — the nightly and canary above it are
        // deliberately skipped.
        assert_eq!(pick_version_for_channel(&v, "stable"), Some("v1.2.0"));
        // An rc looks finished and is not stable.
        assert_eq!(pick_version_for_channel(&["v2.0.0-rc.1"], "stable"), None);
        // An empty channel means stable rather than "anything".
        assert_eq!(pick_version_for_channel(&v, ""), Some("v1.2.0"));
        assert_eq!(pick_version_for_channel(&v, "  STABLE "), Some("v1.2.0"));
    }

    #[test]
    fn an_empty_channel_never_falls_back_to_another_one() {
        // Returning a stable build to someone on `canary` would silently move them
        // off the train they chose. The caller must render "nothing published yet".
        let stable_only: Vec<&str> = vec!["v1.0.0", "v0.9.0"];
        assert_eq!(pick_version_for_channel(&stable_only, "canary"), None);
        assert_eq!(pick_version_for_channel(&stable_only, "beta"), None);
        assert_eq!(pick_version_for_channel(&[], "stable"), None);
    }

    #[test]
    fn only_channels_that_actually_publish_are_offered() {
        // Offering an empty channel lets someone pick one and then be told there is
        // nothing there.
        let v: Vec<&str> = MIXED.to_vec();
        assert_eq!(
            channels_available(&v),
            vec!["nightly", "canary", "stable", "rc", "beta"]
        );
        assert_eq!(channels_available(&["v1.0.0"]), vec!["stable"]);
        assert!(channels_available(&[]).is_empty());
    }

    /// The regression this replaces: `/api/version` stamped Core's own version onto
    /// every component, so a stale Gateway always reported itself as current and no
    /// mismatch was detectable.
    #[test]
    fn an_observed_gateway_version_is_reported_not_overwritten() {
        let info = version_info_with(Some("0.0.1-stale"));
        let gw = info
            .components
            .iter()
            .find(|c| c.name == "gateway")
            .expect("gateway component");
        assert_eq!(gw.version, "0.0.1-stale");

        // Core still reports its own, and is never taken from the Gateway.
        let core = info
            .components
            .iter()
            .find(|c| c.name == "core")
            .expect("core component");
        assert_eq!(core.version, current_version());
    }

    /// With nothing observed we fall back to the single-release-train assumption
    /// rather than inventing a version or omitting the component.
    #[test]
    fn an_unobserved_gateway_falls_back_to_cores_version() {
        let info = version_info_with(None);
        for c in &info.components {
            assert_eq!(c.version, current_version(), "{} drifted", c.name);
        }
        assert_eq!(info.components.len(), 4);
    }

    #[test]
    fn a_channel_suffix_counts_as_a_mismatch() {
        assert!(!version_disagrees("0.0.18", "0.0.18"));
        assert!(!version_disagrees(" 0.0.18 ", "0.0.18"));
        // A stable Core against a nightly Gateway is exactly the skew we want to
        // surface, even though the numeric parts are identical.
        assert!(version_disagrees("0.0.18", "0.0.18-nightly.20260802.23"));
        assert!(version_disagrees("0.0.18", "0.0.17"));
    }

    #[test]
    fn channel_is_derived_from_the_version_alone() {
        assert_eq!(channel_of("0.0.18"), "stable");
        assert_eq!(channel_of("0.0.18-nightly.20260802.23"), "nightly");
        assert_eq!(channel_of("0.0.18-canary.4"), "canary");
        assert_eq!(channel_of("0.0.18-beta.1"), "beta");
    }
}
