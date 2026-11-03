//! The managed sidecar binaries (Core, Gateway, CLI): where each installs, its
//! version marker, and how Desktop decides one is already installed.

use std::path::PathBuf;

use tauri::AppHandle;

/// The running desktop app's version (e.g. `"0.0.8"`), used to stamp downloaded
/// sidecars and to decide whether an already-installed one is stale. The release
/// hub publishes core/gateway/etc under `/releases/latest/download`, so their
/// contents track this same train — a mismatch means the app self-updated (via
/// the Tauri updater) while a sidecar from the old version lingered in
/// `~/.ryu/bin/`, and must be re-fetched.
pub(super) fn app_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Path to the version marker written next to an installed binary:
/// `~/.ryu/bin/<bin_name>.version`. Records which app version installed it so a
/// later launch can detect and replace a stale binary.
pub(super) fn version_marker_path(bin_name: &str) -> Option<PathBuf> {
    install_path(bin_name).map(|path| {
        let mut marker = path.into_os_string();
        marker.push(".version");
        PathBuf::from(marker)
    })
}

/// Whether the managed `~/.ryu/bin/<bin>` was installed by the currently-running
/// app version. A missing marker (legacy binary predating this scheme) counts as
/// a mismatch, so it is re-downloaded once and gains a marker.
pub(super) fn installed_version_matches(bin_name: &str, expected: &str) -> bool {
    version_marker_path(bin_name)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|v| v.trim() == expected)
        .unwrap_or(false)
}

/// Whether the managed `~/.ryu/bin/<bin>` exists but was installed by a *different*
/// app version — i.e. it should be re-downloaded. An explicit `RYU_<X>_BIN`
/// override is user-managed, so it is never treated as stale. A binary that isn't
/// in `~/.ryu/bin/` at all returns `false` here (that's an "install", not an
/// "upgrade" — handled by [`is_installed`] / the `None` path in `lib.rs`).
pub(super) fn is_managed_stale(spec: &SidecarBinary, expected: &str) -> bool {
    if std::env::var(spec.env_var)
        .ok()
        .map(PathBuf::from)
        .is_some_and(|p| p.exists())
    {
        return false;
    }
    match install_path(spec.bin_name) {
        Some(p) if p.exists() => !installed_version_matches(spec.bin_name, expected),
        _ => false,
    }
}

/// Whether a stale managed `ryu-core` is sitting in `~/.ryu/bin/` (installed by an
/// older app version). Called from `lib.rs`'s core-start path to trigger a
/// re-download after the app self-updates. Kept public since `CORE` is private.
pub fn is_managed_core_stale(app: &AppHandle) -> bool {
    is_managed_stale(&CORE, &app_version(app))
}

/// A binary this module can install: the release-asset base name (before the
/// `-<os>-<arch>` platform suffix), the file name to write under `~/.ryu/bin/`, and
/// the env var Core reads to override the binary path (kept in sync with Core's own
/// resolvers so [`is_installed`] agrees with what Core will actually spawn).
#[derive(Clone, Copy)]
pub(super) struct SidecarBinary {
    /// File name written under `~/.ryu/bin/`, e.g. `"ryu-gateway"` (`.exe` on
    /// Windows added by [`install_path`]). This is the bare command name Core
    /// resolves on PATH.
    pub(super) bin_name: &'static str,
    /// Env var Core reads to override the binary path (e.g. `RYU_GATEWAY_BIN`);
    /// `RYU_CORE_BIN` for core. If set to an existing file, the binary counts as
    /// installed and we skip the download.
    pub(super) env_var: &'static str,
}

pub(super) const CORE: SidecarBinary = SidecarBinary {
    bin_name: "ryu-core",
    env_var: "RYU_CORE_BIN",
};
pub(super) const GATEWAY: SidecarBinary = SidecarBinary {
    bin_name: "ryu-gateway",
    env_var: "RYU_GATEWAY_BIN",
};
pub(super) const CLI: SidecarBinary = SidecarBinary {
    bin_name: "ryu-cli",
    env_var: "RYU_CLI_BIN",
};
// NOTE: the per-app opt-in sidecar consts (MAIL/TEAMS/RESEARCH/… ) and the
// `OPTIONAL_SIDECARS` boot-prefetch that used to live here have been REMOVED. The
// desktop no longer downloads app bins up-front; Core now fetches each app's
// `ryu-<app>` binary on-demand the first time the app is *enabled* (and removes it
// on uninstall) — see `apps/core/src/sidecar/manifest_sidecar.rs`
// (`ensure_local_sidecar_present` / `remove_local_sidecar_binaries`) and
// `plans/019-sidecar-binary-lifecycle.md`. Only the REQUIRED core+gateway bins below
// are installed by this desktop layer.
//
// `ryu-browser` was likewise never prefetched (Electron bundle, not a single-file
// spawnable) and still resolves only when already on PATH via `RYU_BROWSER_BIN`.

/// Destination for an installed binary: `~/.ryu{profile}/bin/<bin_name>[.exe]`. This
/// is the second path Core's resolvers probe (after the env override), so a download
/// here is picked up on the next spawn. Profile-aware so a dev app installs its OWN
/// binaries under `~/.ryu-dev/bin` instead of overwriting the release app's `~/.ryu/bin`.
pub(super) fn install_path(bin_name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{bin_name}.exe")
    } else {
        bin_name.to_string()
    };
    let root = ryu_sidecar_runtime::layout::bin_dir(&crate::profile::ryu_home_dir());
    ryu_runtime_install::RuntimeGenerations::new(root)
        .active_dir()
        .ok()
        .map(|directory| directory.join(file))
}

pub(crate) fn managed_core_path() -> Option<PathBuf> {
    install_path(CORE.bin_name).filter(|path| path.is_file())
}

pub(crate) fn managed_gateway_path() -> Option<PathBuf> {
    install_path(GATEWAY.bin_name).filter(|path| path.is_file())
}

/// Whether `spec` already resolves to a real file — mirroring how Core resolves it
/// (env override → `~/.ryu/bin/<bin>` → bare name on PATH). Used to skip a redundant
/// download on every launch. `~/.ryu/bin` is on the PATH Core builds, so the
/// `~/.ryu/bin` and PATH checks usually coincide; both are kept for env-less setups.
pub(super) fn resolved_installed_path(
    spec: &SidecarBinary,
    expected_version: &str,
) -> Option<PathBuf> {
    // 1. Explicit env override pointing at an existing file — user-managed, so we
    //    respect it regardless of version.
    if let Some(path) = std::env::var(spec.env_var)
        .ok()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    {
        return Some(path);
    }
    // 2. Our install target under ~/.ryu/bin. Only "installed" when its version
    //    marker matches the running app: a binary left over from an older app
    //    version is treated as absent so it is re-downloaded (and NOT rescued by
    //    the PATH check below, since ~/.ryu/bin is on PATH — this branch returns).
    let p = install_path(spec.bin_name)?;
    if p.exists() {
        return installed_version_matches(spec.bin_name, expected_version).then_some(p);
    }
    // 3. Anywhere else on PATH — an external install we don't manage; respect it.
    //    EXCEPT another profile's install: `~/.ryu/bin` and `~/.ryu-dev/bin` are both
    //    on PATH, so counting the release binary as "installed" here is what leaves a
    //    dev profile with no `ryu-core` of its own (and silently running the release
    //    one against `~/.ryu-dev`). Treat it as absent so it gets downloaded — this
    //    must stay in lockstep with the same rejection in `resolve_core_binary`.
    which::which(spec.bin_name)
        .ok()
        .filter(|hit| !crate::profile::is_foreign_profile_bin(hit))
        .filter(|hit| {
            !hit.starts_with(ryu_sidecar_runtime::layout::bin_dir(
                &crate::profile::ryu_home_dir(),
            ))
        })
}

pub(super) fn is_installed(spec: &SidecarBinary, expected_version: &str) -> bool {
    resolved_installed_path(spec, expected_version).is_some()
}
