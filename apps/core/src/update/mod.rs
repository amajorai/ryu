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
}

/// A downloadable release asset matched to the running platform.
#[derive(Clone, Serialize, Deserialize)]
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
    /// `true` when `latest` is strictly newer than `current` by semver.
    pub update_available: bool,
    /// Release notes (the GitHub release body), if any.
    pub notes: Option<String>,
    /// Link to the human-readable release page.
    pub html_url: Option<String>,
    /// The asset matching the running platform, when one could be resolved.
    pub asset: Option<ReleaseAsset>,
}

/// The current Ryu version (single release train = Core's own crate version).
pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// `os-arch` string for the running Core.
pub fn platform_tag() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Build the `/api/version` payload. The component list is the single release
/// train: every binary ships at `current_version()`.
pub fn version_info() -> VersionInfo {
    let v = current_version();
    let components = ["core", "gateway", "cli", "desktop"]
        .iter()
        .map(|name| ComponentVersion {
            name: (*name).to_string(),
            version: v.clone(),
        })
        .collect();
    VersionInfo {
        ryu_version: v,
        components,
        platform: platform_tag(),
    }
}

/// Normalise a release tag to a bare semver string (`v1.2.3` → `1.2.3`).
fn normalise_tag(tag: &str) -> &str {
    tag.trim().trim_start_matches(['v', 'V'])
}

/// Parse a `major.minor.patch` prefix, ignoring any `-pre`/`+build` suffix.
/// Returns `(0, 0, 0)` for unparseable input so a malformed tag never claims to
/// be newer than a real version.
fn parse_semver(version: &str) -> (u64, u64, u64) {
    let core = version.split(['-', '+']).next().unwrap_or(version);
    let mut parts = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// `true` when `latest` is strictly newer than `current`.
pub fn is_newer(current: &str, latest: &str) -> bool {
    parse_semver(normalise_tag(latest)) > parse_semver(normalise_tag(current))
}

/// Infer an installer kind from an asset filename.
fn asset_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
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

/// Score how well an asset name matches the running platform. Higher is better;
/// `None` means the asset is for a different OS and should be skipped.
fn platform_match_score(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;

    // OS gate: the asset must be plausibly for this OS.
    let os_ok = match os {
        "windows" => {
            lower.contains("windows")
                || lower.contains("win")
                || lower.ends_with(".msi")
                || lower.ends_with(".exe")
        }
        "macos" => {
            lower.contains("darwin")
                || lower.contains("macos")
                || lower.contains("mac")
                || lower.ends_with(".dmg")
        }
        "linux" => {
            lower.contains("linux") || lower.ends_with(".appimage") || lower.ends_with(".deb")
        }
        _ => false,
    };
    if !os_ok {
        return None;
    }

    let mut score = 1;
    // Arch bonus — prefer an exact arch match, also accept common aliases.
    let arch_aliases: &[&str] = match arch {
        "x86_64" => &["x86_64", "amd64", "x64"],
        "aarch64" => &["aarch64", "arm64"],
        _ => &[],
    };
    if arch_aliases.iter().any(|a| lower.contains(a)) {
        score += 2;
    }
    Some(score)
}

/// A single GitHub release asset as returned by the releases API.
#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

/// The subset of the GitHub release payload we consume.
#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

/// Query the latest GitHub release and produce an [`UpdateCheck`] verdict.
///
/// Fails open at the call site: callers treat a network/API error as "no update
/// known" rather than blocking launch.
pub async fn check_for_update(client: &reqwest::Client) -> anyhow::Result<UpdateCheck> {
    // Verification / dev hook: force a "latest" version without a published
    // release. Lets the desktop/cli update flow be exercised end-to-end before
    // the release CI has produced real assets. Never set in production.
    if let Ok(fake) = std::env::var("RYU_UPDATE_FAKE_LATEST") {
        let current = current_version();
        let latest = normalise_tag(&fake).to_string();
        return Ok(UpdateCheck {
            update_available: is_newer(&current, &latest),
            current,
            latest: latest.clone(),
            notes: Some(format!(
                "Simulated release {latest} (RYU_UPDATE_FAKE_LATEST)."
            )),
            html_url: Some(format!("https://github.com/{RYU_REPO}/releases")),
            asset: None,
        });
    }

    let url = format!("https://api.github.com/repos/{RYU_REPO}/releases/latest");
    let release: GhRelease = client
        .get(&url)
        .header("User-Agent", "ryu-core/1.0")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let current = current_version();
    let latest = normalise_tag(&release.tag_name).to_string();
    let update_available = is_newer(&current, &latest);

    // Pick the best-matching asset for this platform.
    let asset = release
        .assets
        .into_iter()
        .filter_map(|a| platform_match_score(&a.name).map(|score| (score, a)))
        .max_by_key(|(score, _)| *score)
        .map(|(_, a)| ReleaseAsset {
            kind: asset_kind(&a.name).to_string(),
            name: a.name,
            url: a.browser_download_url,
            size: a.size,
        });

    Ok(UpdateCheck {
        current,
        latest,
        update_available,
        notes: release.body,
        html_url: release.html_url,
        asset,
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
        assert_eq!(parse_semver("1.2.3"), (1, 2, 3));
        assert_eq!(parse_semver("1.2.3-beta.1"), (1, 2, 3));
        assert_eq!(parse_semver("1.2.3+build5"), (1, 2, 3));
        assert_eq!(parse_semver("garbage"), (0, 0, 0));
        assert_eq!(parse_semver("1.2"), (1, 2, 0));
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
}
