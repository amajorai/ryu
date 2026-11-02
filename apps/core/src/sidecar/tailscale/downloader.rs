//! Mesh binary installer — the in-product way to get `tailscaled` + `tailscale`.
//!
//! Until this module existed the mesh was PATH-adopt-or-nothing: `start()` failed
//! with an actionable sentence and the user had to go install the official client
//! themselves. PATH adoption still WINS (see [`super::resolve_mesh_pair`]) — this
//! is strictly the fallback for a machine that has no client at all.
//!
//! ## Why this is per-platform rather than one uniform downloader
//!
//! Upstream does not publish a uniform three-platform binary archive, and
//! pretending otherwise is how this repo earned its `.zip`-that-should-have-been-
//! `.tar.gz` scar. What `pkgs.tailscale.com/stable/?mode=json` actually offers:
//!
//! - **Linux**: `tailscale_<ver>_<goarch>.tgz` — static Go binaries, containing
//!   BOTH `tailscale` and `tailscaled` (plus `systemd/` units we skip), with a
//!   sibling `.sha256`. This is a real archive and is the leg implemented here.
//! - **macOS**: `Tailscale-<ver>-macos.zip` is the `macsys` GUI **app bundle** with
//!   a Network Extension. It contains no entry named `tailscaled` at all, so there
//!   is nothing for an archive downloader to extract. Ryu release assets therefore
//!   carry the two userspace binaries built from the pinned upstream source; an
//!   existing Homebrew/PATH pair is still adopted first.
//! - **Windows**: MSI/EXE **installers** only. An installer that registers a
//!   root-privileged system service is precisely what Ryu's userspace, no-root
//!   design must not run. Ryu release assets therefore carry the two userspace
//!   binaries built from the pinned upstream source.
//!
//! ## Never `brew services start tailscale`
//!
//! The formula's service block declares `require_root: true` and binds the default
//! socket. Ryu must keep spawning its OWN `tailscaled` in userspace mode against
//! `~/.ryu/mesh/tailscaled.sock` (see [`super`]); starting brew's service would put
//! a root daemon on the default socket, colliding with the user's own Tailscale.

use std::path::PathBuf;

use anyhow::Result;

use crate::sidecar::download_manager::bin_dir;

#[cfg(target_os = "macos")]
mod brew;
mod install;
#[cfg(test)]
mod tests;

#[cfg(target_os = "macos")]
pub use brew::ensure_installed_via_brew;
pub use install::install_mesh_client;
#[allow(unused_imports)] // public path kept stable; no in-crate caller today
pub use install::TailscaleDownloader;

/// The upstream release this Core installs, pinned at compile time.
///
/// Pinning matches `llamacpp`/`whispercpp`/`sdcpp`: the mesh moves when Ryu ships
/// a new pin, i.e. it rides the app release train, and the version we advertise is
/// therefore the version an install can actually DELIVER. Old assets persist on
/// `pkgs.tailscale.com` (`_1.70.0_` and `_1.80.0_` still answer 200), so the pin
/// will not rot into a 404 the way a `latest`-shaped URL would rot into a mismatch.
///
/// The trap this constant exists to avoid is the one that bit the model weights:
/// a *floating* asset URL next to a *frozen* digest (or the reverse) produces a
/// checksum mismatch that never self-heals. [`archive_url`] and its `.sha256`
/// sibling are both derived from this ONE constant, and a unit test asserts it.
///
/// Cost of pinning, stated plainly: a Tailscale security release does not reach
/// users until the next Ryu release. The alternative — resolving version, filename
/// and digest together from `?mode=json` in a single fetch — is the only other
/// safe shape; a floating version against a pinned digest is not.
pub const TAILSCALE_TARGET_VERSION: &str = "1.104.4";

/// Env carrying a FULL per-platform archive URL (not a base directory), mirroring
/// `RYU_GHOST_RELEASE_URL`. It is the escape hatch for a self-built archive, a
/// pre-release, or an internal mirror. When it is set, the archive leg runs on
/// every platform.
const RELEASE_URL_ENV: &str = "RYU_TAILSCALE_RELEASE_URL";

/// Env overriding the Ryu release base carrying clean-host mesh binaries.
const RYU_RELEASE_BASE_ENV: &str = "RYU_TAILSCALE_RELEASE_BASE";
const DEFAULT_RYU_RELEASE_BASE: &str = "https://github.com/amajorai/ryu/releases/latest/download";

/// The two binaries the mesh needs. Both must be present for the mesh to run at
/// all: `tailscaled` is the daemon, `tailscale` the CLI that enrolls and queries
/// it, and half a pair is the failure mode [`super::resolve_mesh_pair`] exists to
/// refuse.
pub(crate) const DAEMON_BIN: &str = "tailscaled";
pub(crate) const CLI_BIN: &str = "tailscale";

/// `name` with the platform's executable extension.
pub(crate) fn exe_name(name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

/// Where a Ryu-managed mesh binary lives: the PROFILE-AWARE bin dir. `bin_dir()`
/// resolves through `crate::paths::ryu_dir()` (`RYU_DIR` → pointer file →
/// `~/.ryu<profile-suffix>`), so a `RYU_PROFILE=dev` Core installs into
/// `~/.ryu-dev/bin` and never touches the release profile's install.
pub(crate) fn managed_path(name: &str) -> PathBuf {
    bin_dir().join(exe_name(name))
}

/// Whether a complete Ryu-managed pair is on disk.
pub(crate) fn managed_pair_present() -> bool {
    managed_path(DAEMON_BIN).is_file() && managed_path(CLI_BIN).is_file()
}

/// The operator's archive URL override, trimmed; `None` when unset or blank.
///
/// Blank is treated as unset — otherwise `RYU_TAILSCALE_RELEASE_URL=` in an env
/// file would make the mesh uninstallable rather than default.
fn url_override() -> Option<String> {
    std::env::var(RELEASE_URL_ENV)
        .ok()
        .map(|u| u.trim().to_owned())
        .filter(|u| !u.is_empty())
}

/// Tailscale's Go architecture name for this host, or `None` when the upstream
/// index lists no static build for it.
///
/// These are the `GOARCH` values in the published filenames, not Rust's
/// `target_arch` spellings — `x86_64` is `amd64` upstream, and getting that
/// mapping wrong yields a 404 that looks like an outage.
fn goarch() -> Option<&'static str> {
    goarch_of(std::env::consts::ARCH)
}

/// The table behind [`goarch`], split out so it is testable for architectures
/// this build is not running on — a mapping asserted only against the host arch
/// is a mapping asserted against one row.
fn goarch_of(rust_arch: &str) -> Option<&'static str> {
    match rust_arch {
        "x86_64" => Some("amd64"),
        "aarch64" => Some("arm64"),
        "x86" => Some("386"),
        "arm" => Some("arm"),
        "riscv64" => Some("riscv64"),
        _ => None,
    }
}

/// The upstream asset name for this host, e.g. `tailscale_1.104.4_arm64.tgz`.
/// Derived from [`TAILSCALE_TARGET_VERSION`] + [`goarch`] so neither the URL nor
/// the failure message can name an asset that was never published.
fn artifact_name(goarch: &str) -> String {
    format!("tailscale_{TAILSCALE_TARGET_VERSION}_{goarch}.tgz")
}

/// Resolve the archive URL: the [`RELEASE_URL_ENV`] override verbatim when set,
/// otherwise the pinned upstream static build for this architecture.
///
/// Returns the URL and whether it came from the override, because the two differ
/// in exactly one security-relevant way — see the fail-closed rule in
/// [`TailscaleDownloader::install_from_archive`].
fn archive_url() -> Result<(String, bool)> {
    if let Some(url) = url_override() {
        return Ok((url, true));
    }
    let arch = goarch().ok_or_else(|| {
        anyhow::anyhow!(
            "Tailscale publishes no static build for this architecture ({}). Install the \
             official client yourself (https://tailscale.com/download) or point \
             {RELEASE_URL_ENV} at an archive containing `{DAEMON_BIN}` and `{CLI_BIN}`.",
            std::env::consts::ARCH
        )
    })?;
    Ok((
        format!("https://pkgs.tailscale.com/stable/{}", artifact_name(arch)),
        false,
    ))
}

/// Whether THIS node has any route to install the mesh binaries.
///
/// Surfaced to the desktop as `can_install` on `POST /api/mesh/config` so the
/// failure is either an offer ("install it") or advice ("here is how to install it
/// yourself") — never a dead-end toast. It must be honest in the negative
/// direction: offering an install that is guaranteed to bail is worse than not
/// offering one.
///
/// Cheap and synchronous on purpose (a PATH probe, no subprocess), because
/// [`super::ensure_mesh_binaries`] is a pure boot-time check.
pub(crate) fn can_install() -> bool {
    // The override drives the archive leg on every platform, Windows included.
    if url_override().is_some() {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        goarch().is_some()
    }
    #[cfg(target_os = "macos")]
    {
        // A clean Mac uses Ryu's release-owned userspace binaries. Homebrew stays
        // a fallback for older releases that predate those assets.
        ryu_platform().is_some() || super::binary_resolves("brew")
    }
    #[cfg(target_os = "windows")]
    {
        ryu_platform().is_some()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

fn ryu_platform_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x86_64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("windows", "aarch64") => Some("windows-aarch64"),
        _ => None,
    }
}

fn ryu_platform() -> Option<&'static str> {
    ryu_platform_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn ryu_release_base() -> String {
    super::env_bin(RYU_RELEASE_BASE_ENV).unwrap_or_else(|| DEFAULT_RYU_RELEASE_BASE.to_owned())
}

/// The release bases to try for the version-named mesh assets, in order.
///
/// The asset names carry Tailscale's version, and each Ryu release publishes
/// only its own pin. `releases/latest` therefore stops serving this Core's pin
/// the moment a later release bumps it, so the running Core's OWN release comes
/// first; `latest` stays as the fallback for a build whose release does not
/// exist (a locally built version). An operator override is used alone.
fn ryu_release_bases() -> Vec<String> {
    if let Some(base) = super::env_bin(RYU_RELEASE_BASE_ENV) {
        return vec![base];
    }
    vec![
        crate::update::own_release_download_base(),
        DEFAULT_RYU_RELEASE_BASE.to_owned(),
    ]
}

fn ryu_asset_url(binary: &str, platform: &str) -> String {
    ryu_asset_url_in(&ryu_release_base(), binary, platform)
}

fn ryu_asset_url_in(base: &str, binary: &str, platform: &str) -> String {
    let extension = if platform.starts_with("windows-") {
        ".exe"
    } else {
        ""
    };
    format!(
        "{}/{}-{TAILSCALE_TARGET_VERSION}-{platform}{extension}",
        base.trim_end_matches('/'),
        binary
    )
}

/// Whether [`TailscaleDownloader::ensure_installed`] will take the Homebrew leg on
/// this node. Supported clean Macs use the Ryu release asset first; this is only
/// the fallback for an unsupported architecture.
///
/// Exists so the install route can pick its progress shape: brew emits no byte
/// counts, so that leg registers as an INDETERMINATE task in the download overlay
/// (exactly like `apfel`), while the archive leg streams through `DownloadCenter`
/// and reports real bytes.
pub(crate) fn is_brew_leg() -> bool {
    cfg!(target_os = "macos") && url_override().is_none() && ryu_platform().is_none()
}
