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

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    bin_dir, build_http_client, extract_binary_with_libs, fetch_sibling_sha256, ryu_dir,
    sha256_sibling_url, VersionStore,
};

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
pub const TAILSCALE_TARGET_VERSION: &str = "1.102.2";

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

/// The upstream asset name for this host, e.g. `tailscale_1.102.2_arm64.tgz`.
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

fn ryu_asset_url(binary: &str, platform: &str) -> String {
    let extension = if platform.starts_with("windows-") {
        ".exe"
    } else {
        ""
    };
    format!(
        "{}/{}-{TAILSCALE_TARGET_VERSION}-{platform}{extension}",
        ryu_release_base().trim_end_matches('/'),
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

/// Downloads (or brews) the official Tailscale client into the profile's bin dir.
pub struct TailscaleDownloader {
    client: reqwest::Client,
}

impl Default for TailscaleDownloader {
    fn default() -> Self {
        Self::new()
    }
}

impl TailscaleDownloader {
    pub fn new() -> Self {
        Self {
            client: build_http_client(),
        }
    }

    /// Ensure a usable `tailscaled` + `tailscale` pair exists on this node,
    /// returning the version string recorded in `versions.json`.
    ///
    /// Routes by asset reality, not by uniformity: the override (any platform) and
    /// Linux take the pinned upstream archive leg; clean macOS/Windows hosts take
    /// the Ryu release-owned userspace binaries; macOS Homebrew remains a fallback
    /// for an older release that has no Ryu mesh assets yet.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        if url_override().is_some() {
            return self.install_from_archive(downloads).await;
        }
        #[cfg(target_os = "linux")]
        {
            return self.install_from_archive(downloads).await;
        }
        #[cfg(target_os = "macos")]
        {
            if ryu_platform().is_some() {
                match self.install_from_ryu_release(downloads).await {
                    Ok(version) => return Ok(version),
                    Err(error) if super::binary_resolves("brew") => {
                        tracing::warn!(
                            "Ryu mesh client asset unavailable; falling back to Homebrew: {error:#}"
                        );
                        return ensure_installed_via_brew().await;
                    }
                    Err(error) => return Err(error),
                }
            }
            let _ = downloads;
            return ensure_installed_via_brew().await;
        }
        #[cfg(target_os = "windows")]
        {
            return self.install_from_ryu_release(downloads).await;
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        {
            let _ = downloads;
            anyhow::bail!(
                "Ryu cannot install the Tailscale client automatically on {}. Upstream \
                 publishes only an MSI/EXE installer here, and running it would register a \
                 root-privileged system service that collides with Ryu's userspace daemon. \
                 Install the official client from https://tailscale.com/download, or set \
                 {RELEASE_URL_ENV} to an archive containing `{}` and `{}`.",
                std::env::consts::OS,
                exe_name(DAEMON_BIN),
                exe_name(CLI_BIN),
            );
        }
    }

    /// The pinned-archive leg: download `tailscale_<ver>_<goarch>.tgz`, verify it
    /// against its sibling `.sha256`, and extract BOTH binaries into the profile's
    /// bin dir.
    async fn install_from_archive(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        let (url, is_override) = archive_url()?;
        // An override may point at any build, so claiming the pin for it would be a
        // lie the catalog would later repeat. Record a sentinel instead — and use
        // the SAME string in the fast path, so an override install is not
        // re-downloaded on every mesh enable.
        let record_version = if is_override {
            "unknown"
        } else {
            TAILSCALE_TARGET_VERSION
        };

        // Fast path: the recorded version matches AND both binaries are actually on
        // disk. Presence is checked as well as the record because `uninstall`
        // removes the binaries, and a stale row would otherwise claim an install
        // that is gone.
        let recorded = VersionStore::load().versions.get("tailscale").cloned();
        if recorded.as_deref() == Some(record_version) && managed_pair_present() {
            tracing::info!("tailscale {record_version} already installed — skipping");
            return Ok(record_version.to_owned());
        }

        // Integrity. `pkgs.tailscale.com` publishes a `.sha256` next to EVERY asset
        // (verified on every asset probed, including old pins), so a missing digest
        // there means something is wrong and we FAIL CLOSED — this artifact is a
        // network daemon Ryu then executes, and enabling the mesh neutralizes
        // loopback-admin trust gates elsewhere in Core.
        //
        // The override leg warns and continues instead, the same asymmetry ghost's
        // downloader documents: `RYU_TAILSCALE_RELEASE_URL`'s whole purpose is a
        // self-built or pre-release archive that has no sibling digest, so failing
        // closed there would make the documented knob unusable. The warning says
        // "unverified" in as many words; it must never read as though verification
        // happened. (`fetch_sibling_sha256` is https-only, so a plaintext override
        // lands here too — a digest fetched over http next to an http archive is
        // verification theatre.)
        let sha256 = fetch_sibling_sha256(&self.client, &url).await;
        if sha256.is_none() {
            if is_override {
                tracing::warn!(
                    "tailscale: no usable .sha256 at {} — downloading UNVERIFIED because \
                     {RELEASE_URL_ENV} is set",
                    sha256_sibling_url(&url)
                );
            } else {
                anyhow::bail!(
                    "tailscale: no usable checksum at {}. Upstream publishes one next to \
                     every asset, so refusing rather than executing unverified bytes for a \
                     network daemon. Retry, or set {RELEASE_URL_ENV} deliberately.",
                    sha256_sibling_url(&url)
                );
            }
        }

        tracing::info!("downloading the Tailscale client from {url}");
        // The temp name carries the version (or `override`) because `DownloadCenter`
        // resumes from a `<dest>.part`: a single shared filename would let a partial
        // pinned archive be resumed as an override's bytes, or vice versa, and the
        // result is a checksum mismatch nobody can explain.
        let is_zip = url.ends_with(".zip");
        let archive_ext = if is_zip { "zip" } else { "tgz" };
        let archive_dest = ryu_dir().join("tmp").join(if is_override {
            format!("tailscale-override.{archive_ext}")
        } else {
            format!("tailscale-{TAILSCALE_TARGET_VERSION}.{archive_ext}")
        });
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Tool,
                role: crate::downloads::DownloadRole::Tool,
                label: "Tailscale".to_string(),
                url: url.clone(),
                dest: archive_dest,
                sha256,
                // Recorded below instead: the row must land only after BOTH
                // binaries are extracted and made executable, or a failed
                // extraction would leave `versions.json` claiming an install.
                version_record: None,
            })
            .await
            // Name the exact asset in the 404 case, in ghost's style — a bare
            // "HTTP 404" is a worse diagnosis than "this architecture has no
            // published build".
            .with_context(|| {
                format!(
                    "downloading the Tailscale archive from {url}. If this is a 404, upstream \
                     publishes no `{}` for this architecture ({}) — install the official \
                     client from https://tailscale.com/download, or set {RELEASE_URL_ENV} to \
                     an archive containing `{DAEMON_BIN}` and `{CLI_BIN}`.",
                    goarch().map_or_else(|| "tailscale_<ver>_<arch>.tgz".to_owned(), artifact_name),
                    std::env::consts::ARCH,
                )
            })?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading the downloaded Tailscale archive")?;

        // ONE `spawn_blocking` for both binaries: the archive is ~38 MB and two
        // calls would each need an owned copy and would gunzip the whole stream a
        // second time. `extract_binary_with_libs` flattens the archive's
        // `tailscale_<ver>_<arch>/` prefix, and its filters skip everything else
        // (the `systemd/` units are neither the wanted binary nor a shared lib).
        // The two names cannot cross-match: `is_wanted_binary` is exact-match plus
        // `.exe`, so `tailscaled` never satisfies `tailscale` or vice versa.
        let extract_dir = bin_dir();
        let extracted = tokio::task::spawn_blocking(move || -> Result<(PathBuf, PathBuf)> {
            let daemon = extract_binary_with_libs(&archive_data, DAEMON_BIN, &extract_dir, is_zip)?;
            let cli = extract_binary_with_libs(&archive_data, CLI_BIN, &extract_dir, is_zip)?;
            Ok((daemon, cli))
        })
        .await
        .context("spawn_blocking for Tailscale archive extraction")??;

        // MANDATORY, not hygiene: `extract_binary_with_libs` writes through
        // `std::fs::write`, which leaves default (non-executable) permissions. Skip
        // this and the only symptom is a "Permission denied" at spawn time, far
        // from here.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&extracted.0, &extracted.1] {
                let mut perms = std::fs::metadata(path)
                    .with_context(|| format!("stat {}", path.display()))?
                    .permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(path, perms)
                    .with_context(|| format!("chmod 0755 {}", path.display()))?;
            }
        }

        VersionStore::set_version_persisted("tailscale", record_version)
            .context("writing versions.json")?;

        // The binaries are in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        // DELIBERATELY no `PathManager::add_to_path()`, unlike every other
        // downloader here. The mesh reaches its binaries by ABSOLUTE path
        // (`resolve_mesh_pair`), so appending `~/.ryu/bin` to the user's shell
        // profile buys nothing locally — and doing it for an infra daemon is a
        // global, persistent edit to a file the user owns. It would also put a
        // second `tailscale` on their interactive PATH, shadowing whichever client
        // they meant to use. Do not "fix" this back.
        tracing::info!(
            daemon = %extracted.0.display(),
            cli = %extracted.1.display(),
            "tailscale client installed"
        );
        Ok(record_version.to_owned())
    }

    /// Download the two direct, userspace binaries Ryu publishes for clean
    /// macOS/Windows hosts. The release workflow emits a sibling checksum for
    /// each binary, so this path is verified before either file is used.
    async fn install_from_ryu_release(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        let platform = ryu_platform().ok_or_else(|| {
            anyhow::anyhow!(
                "Ryu publishes no managed Tailscale userspace binaries for {}/{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        })?;

        for binary in [DAEMON_BIN, CLI_BIN] {
            let url = ryu_asset_url(binary, platform);
            let checksum = fetch_sibling_sha256(&self.client, &url)
                .await
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "no usable checksum published for the Ryu Tailscale asset at {}",
                        sha256_sibling_url(&url)
                    )
                })?;
            let temporary = ryu_dir().join("tmp").join(format!(
                "tailscale-{TAILSCALE_TARGET_VERSION}-{platform}-{binary}.download"
            ));
            let downloaded = downloads
                .download_blocking(crate::downloads::DownloadSpec {
                    kind: crate::downloads::DownloadKind::Tool,
                    role: crate::downloads::DownloadRole::Tool,
                    label: "Tailscale".to_owned(),
                    url,
                    dest: temporary,
                    sha256: Some(checksum),
                    version_record: None,
                })
                .await
                .with_context(|| format!("downloading the managed Tailscale {binary} binary"))?;
            install_raw_binary(&downloaded, &managed_path(binary)).await?;
        }

        VersionStore::set_version_persisted("tailscale", TAILSCALE_TARGET_VERSION)
            .context("writing the managed Tailscale version")?;
        Ok(TAILSCALE_TARGET_VERSION.to_owned())
    }
}

async fn install_raw_binary(source: &std::path::Path, destination: &std::path::Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let staged = destination.with_extension("download-tmp");
    tokio::fs::copy(source, &staged)
        .await
        .with_context(|| format!("staging {}", destination.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&staged)?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&staged, permissions)?;
    }
    #[cfg(target_os = "windows")]
    if destination.exists() {
        tokio::fs::remove_file(destination)
            .await
            .with_context(|| format!("replacing {}", destination.display()))?;
    }
    tokio::fs::rename(&staged, destination)
        .await
        .with_context(|| format!("installing {}", destination.display()))?;
    let _ = tokio::fs::remove_file(source).await;
    Ok(())
}

/// Install the mesh client through the download overlay, picking the progress
/// shape the active leg can actually honour.
///
/// THE one install entry point. Three callers need identical behaviour and used
/// to have none: `POST /api/setup/tailscale/install` (the explicit button),
/// `POST /api/mesh/config` (turning the mesh ON now installs, rather than
/// reporting a missing client), and Core's boot self-heal for a node whose mesh
/// pref is already on. Keeping the leg choice here means a new leg is added once.
///
/// The brew leg emits no byte counts, so it registers as an INDETERMINATE task
/// (like `apfel`); release assets stream real bytes through `DownloadCenter`.
pub async fn install_mesh_client(downloads: &crate::downloads::DownloadCenter) -> Result<String> {
    let dl = TailscaleDownloader::new();
    if is_brew_leg() {
        downloads
            .register_indeterminate(
                "tool:tailscale".to_string(),
                crate::downloads::DownloadKind::Tool,
                "Tailscale".to_string(),
                dl.ensure_installed(downloads),
            )
            .await
    } else {
        dl.ensure_installed(downloads).await
    }
}

/// macOS leg: adopt an existing pair, else `brew install tailscale`.
///
/// Modelled on `providers/apfel/installer.rs` for the same reason it exists there —
/// the artifact is distributed through Homebrew, not as a downloadable archive (see
/// the module doc). Brew's `tailscale` formula ships BOTH `tailscale` and
/// `tailscaled`; the GUI `Tailscale-<ver>-macos.zip` ships neither in a form we can
/// extract.
///
/// Records the **`"brew"` sentinel** rather than a real version, and that is
/// load-bearing rather than laziness: `registry::SENTINEL_VERSIONS` contains
/// `"brew"`, and `is_comparable_version` uses that list to suppress update
/// comparisons. `github::fetch_latest_version` returns `tag_name` VERBATIM
/// (`"v1.102.2"`, with the `v`), while `tailscale version` prints `1.102.2` — so the
/// moment someone "improves" this to record the real version, the two differ
/// forever and the entry shows a permanent "Update available" with a button that
/// cannot possibly clear it.
#[cfg(target_os = "macos")]
pub async fn ensure_installed_via_brew() -> Result<String> {
    use crate::win_process::NoWindow;
    use tokio::process::Command;

    const SENTINEL: &str = "brew";

    // Adopt first — the user may already have the client, and re-brewing it would
    // be a pointless (and slow) mutation of a machine we do not own.
    if super::resolve_mesh_pair().is_ok() {
        tracing::info!("tailscale: an existing client pair is already resolvable — adopting");
        if let Err(e) = VersionStore::set_version_persisted("tailscale", SENTINEL) {
            tracing::warn!("could not persist the tailscale version marker: {e}");
        }
        return Ok(SENTINEL.to_owned());
    }

    let brew_ok = Command::new("brew")
        .arg("--version")
        .no_window()
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !brew_ok {
        anyhow::bail!(
            "the Tailscale client is not installed and Homebrew was not found. Upstream's \
             macOS download is the GUI app bundle, which ships no `{DAEMON_BIN}` for Ryu's \
             userspace daemon — so Homebrew is the install route here. Install Homebrew \
             (https://brew.sh) then run `brew install tailscale`, or install the client \
             yourself and point RYU_TAILSCALED_BIN/RYU_TAILSCALE_BIN at it."
        );
    }

    tracing::info!("installing the Tailscale client via `brew install tailscale`");
    let status = Command::new("brew")
        .args(["install", "tailscale"])
        .no_window()
        .status()
        .await
        .context("running `brew install tailscale`")?;
    if !status.success() {
        anyhow::bail!("`brew install tailscale` failed with {status}");
    }

    // NEVER `brew services start tailscale` — see the module doc. Ryu spawns its
    // own userspace daemon against its own socket; brew's service block requires
    // root and binds the default one.
    if super::resolve_mesh_pair().is_err() {
        anyhow::bail!(
            "`brew install tailscale` succeeded but no complete `{DAEMON_BIN}` + `{CLI_BIN}` \
             pair is resolvable on PATH. If Homebrew's prefix is not on this process's PATH, \
             point RYU_TAILSCALED_BIN/RYU_TAILSCALE_BIN at the installed binaries."
        );
    }
    if let Err(e) = VersionStore::set_version_persisted("tailscale", SENTINEL) {
        tracing::warn!("could not persist the tailscale version marker: {e}");
    }
    Ok(SENTINEL.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    // `RELEASE_URL_ENV` is process-global and `cargo test` runs test fns in
    // parallel, so every test that touches it takes this lock (the same shape
    // `super`'s test module uses for its own env vars).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    struct EnvGuard {
        prev: Option<String>,
    }
    impl EnvGuard {
        fn set(val: &str) -> Self {
            let prev = std::env::var(RELEASE_URL_ENV).ok();
            std::env::set_var(RELEASE_URL_ENV, val);
            Self { prev }
        }
        fn clear() -> Self {
            let prev = std::env::var(RELEASE_URL_ENV).ok();
            std::env::remove_var(RELEASE_URL_ENV);
            Self { prev }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(RELEASE_URL_ENV, v),
                None => std::env::remove_var(RELEASE_URL_ENV),
            }
        }
    }

    #[test]
    fn goarch_maps_rust_arch_names_to_upstream_go_names() {
        // The published filenames use GOARCH, not Rust's `target_arch`. `x86_64` →
        // `amd64` is the one everybody gets wrong, and the symptom is a 404 that
        // reads like an outage rather than like a naming bug.
        assert_eq!(goarch_of("x86_64"), Some("amd64"));
        assert_eq!(goarch_of("aarch64"), Some("arm64"));
        assert_eq!(goarch_of("x86"), Some("386"));
        assert_eq!(goarch_of("arm"), Some("arm"));
        assert_eq!(goarch_of("riscv64"), Some("riscv64"));
        // An architecture the upstream index does not list must be `None` so
        // `archive_url` refuses instead of synthesizing a URL that 404s. Note the
        // Rust spellings are NOT passed through verbatim — that is the whole point.
        assert_eq!(goarch_of("powerpc64"), None);
        assert_eq!(goarch_of("amd64"), None, "a GOARCH name is not a Rust arch");
        // And the host's own arch resolves through the same table.
        assert_eq!(goarch(), goarch_of(std::env::consts::ARCH));
    }

    #[test]
    fn artifact_name_carries_the_pin_and_the_go_arch() {
        assert_eq!(
            artifact_name("arm64"),
            format!("tailscale_{TAILSCALE_TARGET_VERSION}_arm64.tgz")
        );
        // A `.tgz`, because the archive leg EXTRACTS binaries out of it. The macOS
        // `.zip` is a GUI app bundle and is deliberately not what we fetch.
        assert!(artifact_name("amd64").ends_with(".tgz"));
    }

    #[test]
    fn archive_url_defaults_to_the_pinned_upstream_asset() {
        let _lock = lock_env();
        let _g = EnvGuard::clear();
        let Some(arch) = goarch() else {
            // No published build for this architecture — `archive_url` must refuse
            // rather than synthesize a URL that cannot exist.
            assert!(archive_url().is_err());
            return;
        };
        let (url, is_override) = archive_url().expect("a url");
        assert!(!is_override);
        assert_eq!(
            url,
            format!(
                "https://pkgs.tailscale.com/stable/tailscale_{TAILSCALE_TARGET_VERSION}_{arch}.tgz"
            ),
            "got: {url}"
        );
    }

    #[test]
    fn the_pinned_asset_and_its_digest_come_from_one_constant() {
        // THE trap this module is built around: a version-pinned asset next to a
        // digest resolved some other way produces a checksum mismatch that never
        // self-heals (the `/resolve/main/`-beside-a-frozen-SHA scar). Assert that
        // the digest URL is literally the asset URL plus `.sha256`, so the two
        // cannot be derived from different versions.
        let _lock = lock_env();
        let _g = EnvGuard::clear();
        let Ok((url, _)) = archive_url() else {
            return;
        };
        assert!(url.contains(TAILSCALE_TARGET_VERSION), "got: {url}");
        let digest = sha256_sibling_url(&url);
        assert_eq!(digest, format!("{url}.sha256"));
        assert!(digest.contains(TAILSCALE_TARGET_VERSION), "got: {digest}");
    }

    #[test]
    fn archive_url_uses_the_env_override_verbatim_and_trimmed() {
        // The override carries a FULL URL, not a base to append an asset name to —
        // the same contract as `RYU_GHOST_RELEASE_URL`.
        let _lock = lock_env();
        let _g = EnvGuard::set("  https://mirror.test/ts.tgz  ");
        let (url, is_override) = archive_url().expect("a url");
        assert_eq!(url, "https://mirror.test/ts.tgz");
        assert!(
            is_override,
            "the override must be flagged: it is the ONLY leg \
                              allowed to download without a verified checksum"
        );
    }

    #[test]
    fn blank_override_falls_back_to_the_pinned_default() {
        // A blank value is "unset", not "an empty URL" — otherwise
        // `RYU_TAILSCALE_RELEASE_URL=` in an env file would make the mesh
        // uninstallable.
        let _lock = lock_env();
        let _g = EnvGuard::set("   ");
        assert!(url_override().is_none());
        if goarch().is_some() {
            let (url, is_override) = archive_url().expect("a url");
            assert!(!is_override);
            assert!(
                url.starts_with("https://pkgs.tailscale.com/stable/"),
                "got: {url}"
            );
        }
    }

    #[test]
    fn an_override_makes_every_platform_installable() {
        // Including Windows, which uses the Ryu release-owned userspace assets.
        // desktop's offer-vs-advise branch, so it must answer true exactly when a
        // route exists.
        let _lock = lock_env();
        let _g = EnvGuard::set("https://mirror.test/ts.tgz");
        assert!(can_install());
    }

    #[test]
    fn clean_host_release_assets_cover_supported_non_linux_targets() {
        assert_eq!(ryu_platform_for("macos", "aarch64"), Some("macos-arm64"));
        assert_eq!(ryu_platform_for("macos", "x86_64"), Some("macos-x86_64"));
        assert_eq!(
            ryu_platform_for("windows", "x86_64"),
            Some("windows-x86_64")
        );
        assert_eq!(
            ryu_platform_for("windows", "aarch64"),
            Some("windows-aarch64")
        );
        assert_eq!(ryu_platform_for("linux", "x86_64"), None);
    }

    #[test]
    fn clean_host_release_asset_names_keep_windows_extensions() {
        assert_eq!(
            ryu_asset_url("tailscaled", "macos-arm64"),
            format!("{DEFAULT_RYU_RELEASE_BASE}/tailscaled-{TAILSCALE_TARGET_VERSION}-macos-arm64")
        );
        assert_eq!(
            ryu_asset_url("tailscale", "windows-x86_64"),
            format!(
                "{DEFAULT_RYU_RELEASE_BASE}/tailscale-{TAILSCALE_TARGET_VERSION}-windows-x86_64.exe"
            )
        );
    }

    #[test]
    fn managed_paths_live_under_the_profile_bin_dir() {
        // Profile-awareness comes from `bin_dir()` → `crate::paths::ryu_dir()`, so a
        // `RYU_PROFILE=dev` Core installs into `~/.ryu-dev/bin`. Never
        // `dirs::home_dir()` directly.
        let daemon = managed_path(DAEMON_BIN);
        assert_eq!(daemon.parent().unwrap(), bin_dir());
        assert!(daemon.ends_with(exe_name(DAEMON_BIN)));
        assert_eq!(managed_path(CLI_BIN).parent().unwrap(), bin_dir());
    }

    #[test]
    fn the_two_binary_names_cannot_cross_match() {
        // `extract_binary_with_libs` matches on exact basename (plus `.exe`), which
        // is what lets one archive yield both binaries with two passes. A prefix
        // match would extract `tailscaled` as `tailscale` and the mesh would spawn
        // the CLI as its daemon.
        assert_ne!(DAEMON_BIN, CLI_BIN);
        assert!(DAEMON_BIN.starts_with(CLI_BIN), "the trap this guards");
    }
}
