//! Production-only auto-install of the out-of-process Ryu sidecar binaries from the
//! public download hub (amajorai/ryu) into `~/.ryu/bin/`. In dev the binaries are
//! owned by turbo (`bun run dev:core` / `dev:gateway`), so this path never runs
//! there — `lib.rs` gates every call on `not(debug_assertions)`.
//!
//! The binaries are resolved by Core the same way (env override else bare command
//! name on a PATH that includes `~/.ryu/bin`), split into two policy classes:
//!
//! **Required (loud on failure):**
//!   - `ryu-core`     — the orchestration engine (auto-installed since day one).
//!   - `ryu-gateway`  — the control layer Core spawns as a managed sidecar.
//!                      Core hands every model call to it (`sidecar/gateway.rs`,
//!                      `DEFAULT_GATEWAY_BIN = "ryu-gateway"`, resolved on PATH). Nothing
//!                      installed it before this module — that was the real gap.
//!
//! **App sidecars (opt-in feature backends) are NOT installed here.** This desktop
//! layer only fetches the two required bins above. Each apps-store app's `ryu-<app>`
//! binary (mail/teams/research/clips/finetune/quests/healing/meetings/recipes/
//! dashboards/monitors) is downloaded by **Core on-demand the first time the app is
//! enabled**, and removed on uninstall — tying the binary to the app lifecycle
//! instead of a blanket boot-prefetch. See
//! `apps/core/src/sidecar/manifest_sidecar.rs` (`ensure_local_sidecar_present` /
//! `remove_local_sidecar_binaries`) and `plans/019-sidecar-binary-lifecycle.md`.
//! (`ryu-browser` is an Electron bundle, never a single-file spawnable, and still
//! resolves only when already on PATH via `RYU_BROWSER_BIN`.)

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

const RELEASE_BASE: &str = "https://github.com/amajorai/ryu/releases/latest/download";

/// The running desktop app's version (e.g. `"0.0.8"`), used to stamp downloaded
/// sidecars and to decide whether an already-installed one is stale. The release
/// hub publishes core/gateway/etc under `/releases/latest/download`, so their
/// contents track this same train — a mismatch means the app self-updated (via
/// the Tauri updater) while a sidecar from the old version lingered in
/// `~/.ryu/bin/`, and must be re-fetched.
fn app_version(app: &AppHandle) -> String {
	app.package_info().version.to_string()
}

/// Path to the version marker written next to an installed binary:
/// `~/.ryu/bin/<bin_name>.version`. Records which app version installed it so a
/// later launch can detect and replace a stale binary.
fn version_marker_path(bin_name: &str) -> Option<PathBuf> {
	install_path(bin_name).map(|p| p.with_extension("version"))
}

/// Whether the managed `~/.ryu/bin/<bin>` was installed by the currently-running
/// app version. A missing marker (legacy binary predating this scheme) counts as
/// a mismatch, so it is re-downloaded once and gains a marker.
fn installed_version_matches(bin_name: &str, expected: &str) -> bool {
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
fn is_managed_stale(spec: &SidecarBinary, expected: &str) -> bool {
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
struct SidecarBinary {
	/// Release-asset base, e.g. `"ryu-gateway"`. The platform suffix + any `.exe`
	/// is appended by [`platform_asset`].
	asset_base: &'static str,
	/// File name written under `~/.ryu/bin/`, e.g. `"ryu-gateway"` (`.exe` on
	/// Windows added by [`install_path`]). This is the bare command name Core
	/// resolves on PATH.
	bin_name: &'static str,
	/// Env var Core reads to override the binary path (e.g. `RYU_GATEWAY_BIN`);
	/// `RYU_CORE_BIN` for core. If set to an existing file, the binary counts as
	/// installed and we skip the download.
	env_var: &'static str,
}

const CORE: SidecarBinary = SidecarBinary {
	asset_base: "ryu-core",
	bin_name: "ryu-core",
	env_var: "RYU_CORE_BIN",
};
const GATEWAY: SidecarBinary = SidecarBinary {
	asset_base: "ryu-gateway",
	bin_name: "ryu-gateway",
	env_var: "RYU_GATEWAY_BIN",
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

/// The `<os>-<arch>` fragment shared by every asset name, or `None` on an
/// unsupported platform. Matches the published release assets: `linux-x86_64`,
/// `macos-aarch64`, `windows-x86_64`.
fn platform_slug() -> Option<&'static str> {
	match (std::env::consts::OS, std::env::consts::ARCH) {
		("linux", "x86_64") => Some("linux-x86_64"),
		("macos", "aarch64") => Some("macos-aarch64"),
		("windows", "x86_64") => Some("windows-x86_64"),
		_ => None,
	}
}

/// The release asset name for `base` on the running platform, or `None` if no
/// prebuilt is published for it. e.g. `ryu-gateway` → `ryu-gateway-macos-aarch64`
/// (or `ryu-gateway-windows-x86_64.exe` on Windows). The `.exe` matches how the
/// release publishes Windows executables (see the core asset naming).
fn platform_asset(base: &str) -> Option<String> {
	let slug = platform_slug()?;
	let ext = if cfg!(windows) { ".exe" } else { "" };
	Some(format!("{base}-{slug}{ext}"))
}

/// Destination for an installed binary: `~/.ryu{profile}/bin/<bin_name>[.exe]`. This
/// is the second path Core's resolvers probe (after the env override), so a download
/// here is picked up on the next spawn. Profile-aware so a dev app installs its OWN
/// binaries under `~/.ryu-dev/bin` instead of overwriting the release app's `~/.ryu/bin`.
fn install_path(bin_name: &str) -> Option<PathBuf> {
	let file = if cfg!(windows) {
		format!("{bin_name}.exe")
	} else {
		bin_name.to_string()
	};
	Some(crate::profile::ryu_home_dir().join("bin").join(file))
}

/// Whether `spec` already resolves to a real file — mirroring how Core resolves it
/// (env override → `~/.ryu/bin/<bin>` → bare name on PATH). Used to skip a redundant
/// download on every launch. `~/.ryu/bin` is on the PATH Core builds, so the
/// `~/.ryu/bin` and PATH checks usually coincide; both are kept for env-less setups.
fn is_installed(spec: &SidecarBinary, expected_version: &str) -> bool {
	// 1. Explicit env override pointing at an existing file — user-managed, so we
	//    respect it regardless of version.
	if std::env::var(spec.env_var)
		.ok()
		.map(PathBuf::from)
		.is_some_and(|p| p.exists())
	{
		return true;
	}
	// 2. Our install target under ~/.ryu/bin. Only "installed" when its version
	//    marker matches the running app: a binary left over from an older app
	//    version is treated as absent so it is re-downloaded (and NOT rescued by
	//    the PATH check below, since ~/.ryu/bin is on PATH — this branch returns).
	if let Some(p) = install_path(spec.bin_name) {
		if p.exists() {
			return installed_version_matches(spec.bin_name, expected_version);
		}
	}
	// 3. Anywhere else on PATH — an external install we don't manage; respect it.
	which::which(spec.bin_name).is_ok()
}

/// Download `asset` from the release hub into `~/.ryu/bin/<dest_file>` and return
/// its path. Writes to a temp path then renames, so an interrupted download never
/// leaves a truncated binary that looks installed; sets `0o755` on unix. Emits
/// `<event>` progress events with a `phase` of
/// `downloading` | `installing` | `done` | `error` so the UI can show status.
///
/// This is the shared core of every installer — `download_core_binary` and the
/// gateway/optional-app installers all funnel through it, parameterised by
/// (`asset`, `dest_file`, `event`).
async fn download_release_binary(
	app: &AppHandle,
	asset: &str,
	dest: PathBuf,
	event: &str,
) -> Result<PathBuf, String> {
	let url = format!("{RELEASE_BASE}/{asset}");

	let _ = app.emit(
		event,
		serde_json::json!({ "phase": "downloading", "asset": asset }),
	);

	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(600))
		.build()
		.map_err(|e| e.to_string())?;
	let resp = client
		.get(&url)
		.send()
		.await
		.map_err(|e| format!("download {url}: {e}"))?;
	if !resp.status().is_success() {
		let err = format!("download {url}: HTTP {}", resp.status());
		let _ = app.emit(event, serde_json::json!({ "phase": "error", "error": err }));
		return Err(err);
	}
	let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

	let _ = app.emit(event, serde_json::json!({ "phase": "installing" }));

	if let Some(parent) = dest.parent() {
		std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
	}
	// Write to a temp path then rename, so an interrupted download never leaves a
	// truncated binary that looks installed.
	let tmp = dest.with_extension("download");
	std::fs::write(&tmp, &bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;

	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
			.map_err(|e| format!("chmod {}: {e}", tmp.display()))?;
	}
	std::fs::rename(&tmp, &dest).map_err(|e| format!("install {}: {e}", dest.display()))?;

	let _ = app.emit(
		event,
		serde_json::json!({ "phase": "done", "path": dest.to_string_lossy() }),
	);
	Ok(dest)
}

/// Resolve `(asset, dest)` for `spec`, then download it. Shared by every named
/// installer below; returns a clear error on an unsupported platform or missing
/// home dir so callers can decide whether the miss is fatal.
async fn install_sidecar(
	app: &AppHandle,
	spec: &SidecarBinary,
	event: &str,
) -> Result<PathBuf, String> {
	let asset = platform_asset(spec.asset_base).ok_or_else(|| {
		format!(
			"no prebuilt {} for {}-{}",
			spec.asset_base,
			std::env::consts::OS,
			std::env::consts::ARCH
		)
	})?;
	let dest = install_path(spec.bin_name).ok_or("could not resolve home directory")?;
	let path = download_release_binary(app, &asset, dest, event).await?;
	// Stamp the version so a future launch can tell whether this binary is stale
	// after the app self-updates. Best-effort: a missing marker just forces one
	// redundant re-download next time, never a broken install.
	if let Some(marker) = version_marker_path(spec.bin_name) {
		let _ = std::fs::write(marker, app_version(app));
	}
	Ok(path)
}

/// Download the platform `ryu-core` binary into `~/.ryu/bin/` and return its path.
/// Emits `core-install-progress` events. (Signature preserved — called from
/// `lib.rs` first-launch orchestration and `ensure_core_installed`.)
pub async fn download_core_binary(app: &AppHandle) -> Result<PathBuf, String> {
	install_sidecar(app, &CORE, "core-install-progress").await
}

/// Download the platform `ryu-gateway` binary into `~/.ryu/bin/` and return its
/// path. **Required**: Core spawns `ryu-gateway` as a managed sidecar and hands it
/// every model call, so a missing gateway degrades chat. Emits
/// `gateway-install-progress` events. The caller treats a failure as loud-but-non-fatal
/// (warn, still let the app open) and — critically — awaits this *before* starting
/// Core so the gateway is on disk when Core's spawn resolves it on PATH.
pub async fn download_gateway_binary(app: &AppHandle) -> Result<PathBuf, String> {
	install_sidecar(app, &GATEWAY, "gateway-install-progress").await
}

/// Ensure `ryu-gateway` is installed, downloading it if absent. Skips the download
/// when it already resolves. **Required** sidecar — the caller awaits this *before*
/// starting Core (Core spawns the gateway at boot) and logs a loud warning on
/// failure, but the app still opens (degraded chat beats no app).
pub async fn ensure_gateway_installed(app: &AppHandle) -> Result<PathBuf, String> {
	if is_installed(&GATEWAY, &app_version(app)) {
		return install_path(GATEWAY.bin_name).ok_or("could not resolve home directory".to_string());
	}
	download_gateway_binary(app).await
}

// The opt-in app-sidecar prefetch (`progress_event`, `ensure_optional_installed`,
// `spawn_optional_sidecar_installs`) was REMOVED — Core now downloads each app's
// `ryu-<app>` binary on-demand at enable-time (see the note by the const block above
// and `plans/019-sidecar-binary-lifecycle.md`). Only core + gateway are installed by
// this desktop layer; `install_sidecar` / `is_installed` / `install_path` remain,
// shared by the required-bin installers above.

// ---------------------------------------------------------------------------
// Island (the Electron companion overlay)
// ---------------------------------------------------------------------------
//
// Island is NOT a `SidecarBinary`: its release assets follow electron-builder's
// naming, not the `<base>-<slug>[.exe]` scheme every single-file sidecar shares,
// and it installs into its OWN directory (`~/.ryu/island/`, kept apart from the
// `~/.ryu/bin/` sidecars so the bundle — a whole `.app` on macOS — never mingles
// with the flat command binaries). So it gets a dedicated resolver + installer +
// launcher below rather than an entry in the sidecar tables.
//
// The tray already drives an *already-running* island through its loopback
// control server (`tray::island_control`); this module supplies the missing
// "download it and start it in the first place" half. Island self-guards with an
// Electron single-instance lock (`app.requestSingleInstanceLock()` in
// `apps/island/src/main/index.ts`), so a redundant `launch_island` on a restart
// where island is already up self-exits — the launch path can stay unconditional.

/// The Island release-asset name for the running platform, or `None` on an
/// unsupported one. These names come straight from `apps/island/electron-builder.yml`
/// (`ryu-island-${os}-${arch}[-portable].${ext}`, with electron-builder's `os`/`arch`
/// spellings — `win`/`mac`, `x64`/`arm64`/`x86_64`), which differ from the sidecar
/// slug (`windows-x86_64`, `macos-aarch64`, bare `.exe`), so [`platform_asset`] would
/// resolve a URL that 404s. Windows uses the *portable* single-exe target (it
/// self-extracts on launch, no installer step); Linux the AppImage; macOS the `.zip`
/// carrying `Ryu Island.app` (electron-updater needs the zip, not just the dmg).
fn island_asset() -> Option<&'static str> {
	match (std::env::consts::OS, std::env::consts::ARCH) {
		("windows", "x86_64") => Some("ryu-island-win-x64-portable.exe"),
		("linux", "x86_64") => Some("ryu-island-linux-x86_64.AppImage"),
		("macos", "aarch64") => Some("ryu-island-mac-arm64.zip"),
		_ => None,
	}
}

/// The dedicated install directory for Island: `~/.ryu/island/`. Separate from the
/// `~/.ryu/bin/` sidecars because the Electron bundle is more than one file (a whole
/// `.app` tree on macOS) and should not clutter the flat command-binary dir.
fn island_dir() -> Option<PathBuf> {
	Some(crate::profile::ryu_home_dir().join("island"))
}

/// The installed Island launch target under `~/.ryu/island/`:
///   - Windows: `ryu-island.exe` (the renamed portable single-exe)
///   - Linux:   `ryu-island.AppImage`
///   - macOS:   `Ryu Island.app` (a bundle *directory*, launched via `open`)
fn island_install_path() -> Option<PathBuf> {
	let dir = island_dir()?;
	let file = if cfg!(target_os = "windows") {
		"ryu-island.exe"
	} else if cfg!(target_os = "macos") {
		"Ryu Island.app"
	} else {
		"ryu-island.AppImage"
	};
	Some(dir.join(file))
}

/// Version marker for the installed Island bundle: `~/.ryu/island/.version`. Mirrors
/// the sidecar markers — records which app version installed it so a later launch can
/// re-download after the app self-updates and leaves a stale bundle behind.
fn island_version_marker() -> Option<PathBuf> {
	island_dir().map(|d| d.join(".version"))
}

/// Whether the installed Island bundle was placed by the currently-running app
/// version. A missing/mismatched marker counts as stale (re-download once).
fn island_version_matches(expected: &str) -> bool {
	island_version_marker()
		.and_then(|p| std::fs::read_to_string(p).ok())
		.map(|v| v.trim() == expected)
		.unwrap_or(false)
}

/// Whether Island is installed AND matches the running app version. A bundle left by
/// an older app version is treated as absent so [`ensure_island_installed`] re-fetches
/// it. Unlike the sidecars there is no env override — Island has no `RYU_*_BIN` hook.
fn is_island_installed(expected: &str) -> bool {
	match island_install_path() {
		Some(p) if p.exists() => island_version_matches(expected),
		_ => false,
	}
}

/// Download the macOS Island `.zip` into `~/.ryu/island/`, extract it, and return the
/// extracted `.app` bundle path. `ditto -x -k` is the macOS-native unarchiver (it
/// preserves the bundle's resource-fork / code-signing metadata better than `unzip`);
/// `unzip -o` is the fallback. Only compiled on macOS — the single-file Win/Linux
/// artifacts never take this path.
#[cfg(target_os = "macos")]
async fn install_island_macos(
	app: &AppHandle,
	asset: &str,
	dir: &std::path::Path,
	event: &str,
) -> Result<PathBuf, String> {
	// Download the archive itself (NOT the final launch target) via the shared
	// helper: its temp-then-rename keeps a partial download from ever looking
	// complete, and the `0o755` it stamps on the `.zip` is harmless.
	let zip = dir.join("ryu-island.zip");
	download_release_binary(app, asset, zip.clone(), event).await?;

	let _ = app.emit(event, serde_json::json!({ "phase": "installing" }));
	let extracted_ok = std::process::Command::new("ditto")
		.arg("-x")
		.arg("-k")
		.arg(&zip)
		.arg(dir)
		.status()
		.map(|s| s.success())
		.unwrap_or(false)
		|| std::process::Command::new("unzip")
			.arg("-o")
			.arg(&zip)
			.arg("-d")
			.arg(dir)
			.status()
			.map(|s| s.success())
			.unwrap_or(false);
	if !extracted_ok {
		let err = "failed to extract Ryu Island .zip".to_string();
		let _ = app.emit(event, serde_json::json!({ "phase": "error", "error": err }));
		return Err(err);
	}
	// The archive is only a staging artifact; drop it once extracted.
	let _ = std::fs::remove_file(&zip);

	// Locate the extracted `.app`: prefer the canonical `Ryu Island.app`, else the
	// first `*.app` in the dir (in case the archive's top-level name ever drifts).
	let bundle = island_install_path()
		.filter(|p| p.exists())
		.or_else(|| {
			std::fs::read_dir(dir).ok().and_then(|entries| {
				entries
					.filter_map(|e| e.ok())
					.map(|e| e.path())
					.find(|p| p.extension().and_then(|x| x.to_str()) == Some("app"))
			})
		})
		.ok_or("no .app found in extracted Ryu Island archive")?;
	let _ = app.emit(
		event,
		serde_json::json!({ "phase": "done", "path": bundle.to_string_lossy() }),
	);
	Ok(bundle)
}

/// Ensure the Island companion is installed under `~/.ryu/island/`, downloading (and,
/// on macOS, extracting) it if absent or stale. Skips when the version marker already
/// matches the running app. Emits `island-install-progress` events (same `phase`
/// vocabulary as the sidecars). Errors on an unsupported platform or a failed
/// download/extract so the caller can decide the miss is non-fatal.
pub async fn ensure_island_installed(app: &AppHandle) -> Result<PathBuf, String> {
	let expected = app_version(app);
	if is_island_installed(&expected) {
		return island_install_path().ok_or("could not resolve home directory".to_string());
	}

	let asset = island_asset().ok_or_else(|| {
		format!(
			"no prebuilt Ryu Island for {}-{}",
			std::env::consts::OS,
			std::env::consts::ARCH
		)
	})?;
	let dir = island_dir().ok_or("could not resolve home directory")?;
	std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

	let event = "island-install-progress";
	// macOS ships a `.zip` (extract + locate the `.app`); Windows/Linux are single-file
	// spawnables that download straight to the launch target (`download_release_binary`
	// chmod +x's the AppImage on unix), exactly like `ryu-core`. cfg on the `let`
	// statement (not on a tail block expr, which is unstable) so only the platform's
	// branch compiles.
	#[cfg(target_os = "macos")]
	let installed = install_island_macos(app, asset, &dir, event).await?;
	#[cfg(not(target_os = "macos"))]
	let installed = {
		let dest = island_install_path().ok_or("could not resolve home directory")?;
		download_release_binary(app, asset, dest, event).await?
	};

	// Stamp the version so a later launch can detect a stale bundle after the app
	// self-updates. Best-effort, like the sidecar markers.
	if let Some(marker) = island_version_marker() {
		let _ = std::fs::write(marker, &expected);
	}
	Ok(installed)
}

/// Launch the installed Island companion DETACHED, so it runs as an independent
/// process that outlives this call. Returns `Err` (loudly) when Island isn't
/// installed. Island self-guards with an Electron single-instance lock, so calling
/// this while an island is already running self-exits — safe to call unconditionally
/// on startup.
pub fn launch_island() -> Result<(), String> {
	let target = island_install_path().ok_or("could not resolve home directory")?;
	if !target.exists() {
		return Err(format!("Ryu Island not installed at {}", target.display()));
	}

	#[cfg(target_os = "macos")]
	{
		// `open` launches the `.app` bundle detached and returns immediately.
		std::process::Command::new("open")
			.arg(&target)
			.spawn()
			.map_err(|e| format!("launch Ryu Island: {e}"))?;
	}
	#[cfg(not(target_os = "macos"))]
	{
		use crate::win_process::NoWindow;
		// Windows portable `.exe` self-extracts on launch; the Linux AppImage runs
		// directly. Spawn and drop the child handle — it runs detached. `no_window()`
		// suppresses a stray console window on Windows (no-op elsewhere).
		std::process::Command::new(&target)
			.no_window()
			.spawn()
			.map_err(|e| format!("launch Ryu Island: {e}"))?;
	}
	Ok(())
}
