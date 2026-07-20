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
//! **Optional (opt-in apps, silent on failure — [`OPTIONAL_SIDECARS`]):** every
//! feature backend that waves 1-4 converted from an in-Core module into a standalone
//! out-of-process spawnable bin. Core resolves each via `RYU_<X>_BIN` else the bare
//! `ryu-<x>` on PATH, so a download into `~/.ryu/bin/` is picked up on the next spawn:
//!   - `ryu-mail` — the wave-1 single-file sidecar (Agent Inboxes). Its wave-1
//!     partner `ryu-browser` is deliberately NOT here: it ships as an Electron
//!     bundle (`ryu-browser-<os>-<arch>{.zip,.dmg,-portable.exe,.AppImage}`, with a
//!     nested `.app` exec on macOS), which the single-file download-chmod-rename path
//!     below cannot install. Its packaged-artifact install path is a separate,
//!     deferred pipeline; until it lands, `ryu-browser` is resolved only when already
//!     on PATH (`RYU_BROWSER_BIN` else `ryu-browser`).
//!   - `ryu-teams`, `ryu-research`, `ryu-clips`, `ryu-finetune`, `ryu-quests`,
//!     `ryu-healing`, `ryu-meetings`, `ryu-recipes`, `ryu-dashboards`, `ryu-monitors`
//!     — the wave-2..4 app bins. These 404 harmlessly until the release ships them.
//!
//! **Fetch policy (v1): up-front, best-effort per binary.** The clean signal for
//! "is this app enabled" lives behind Core's HTTP API, which isn't up at first
//! launch and isn't queried from the Tauri layer, so on-demand fetching would mean
//! standing up a poll-Core-for-enabled-apps loop for no v1 benefit. Instead we fetch
//! everything up-front (the task explicitly blesses this fallback), but keep failure
//! non-fatal per binary: a missing optional sidecar (e.g. mail) is silent, a
//! missing gateway warns loudly (Core needs it) — neither blocks the app opening.
//! Moving these to on-demand once an enabled-apps signal is wired is the right
//! follow-up. Today that waste is theoretical anyway — `release-local.sh` builds only
//! core+gateway, so the optional-app assets 404 and their downloads no-op cleanly
//! until the release publishes them.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter};

const RELEASE_BASE: &str = "https://github.com/amajorai/ryu/releases/latest/download";

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
const MAIL: SidecarBinary = SidecarBinary {
	asset_base: "ryu-mail",
	bin_name: "ryu-mail",
	env_var: "RYU_MAIL_BIN",
};
// NOTE: `ryu-browser` intentionally has NO entry here. It ships as an Electron
// bundle (per-platform `.zip`/`.dmg`/`-portable.exe`/`.AppImage`, `arm64` naming, a
// nested `.app/Contents/MacOS` exec on macOS), which the single-file
// download-chmod-rename installer below cannot handle. Its packaged-artifact install
// path is a separate, deferred pipeline; until then it resolves only when already on
// PATH via `RYU_BROWSER_BIN` else `ryu-browser`.
const TEAMS: SidecarBinary = SidecarBinary {
	asset_base: "ryu-teams",
	bin_name: "ryu-teams",
	env_var: "RYU_TEAMS_BIN",
};
const RESEARCH: SidecarBinary = SidecarBinary {
	asset_base: "ryu-research",
	bin_name: "ryu-research",
	env_var: "RYU_RESEARCH_BIN",
};
const CLIPS: SidecarBinary = SidecarBinary {
	asset_base: "ryu-clips",
	bin_name: "ryu-clips",
	env_var: "RYU_CLIPS_BIN",
};
const FINETUNE: SidecarBinary = SidecarBinary {
	asset_base: "ryu-finetune",
	bin_name: "ryu-finetune",
	env_var: "RYU_FINETUNE_BIN",
};
const QUESTS: SidecarBinary = SidecarBinary {
	asset_base: "ryu-quests",
	bin_name: "ryu-quests",
	env_var: "RYU_QUESTS_BIN",
};
const HEALING: SidecarBinary = SidecarBinary {
	asset_base: "ryu-healing",
	bin_name: "ryu-healing",
	env_var: "RYU_HEALING_BIN",
};
const MEETINGS: SidecarBinary = SidecarBinary {
	asset_base: "ryu-meetings",
	bin_name: "ryu-meetings",
	env_var: "RYU_MEETINGS_BIN",
};
const RECIPES: SidecarBinary = SidecarBinary {
	asset_base: "ryu-recipes",
	bin_name: "ryu-recipes",
	env_var: "RYU_RECIPES_BIN",
};
const DASHBOARDS: SidecarBinary = SidecarBinary {
	asset_base: "ryu-dashboards",
	bin_name: "ryu-dashboards",
	env_var: "RYU_DASHBOARDS_BIN",
};
const MONITORS: SidecarBinary = SidecarBinary {
	asset_base: "ryu-monitors",
	bin_name: "ryu-monitors",
	env_var: "RYU_MONITORS_BIN",
};

/// Every opt-in app sidecar auto-installed *detached, after Core start* and *silent
/// on failure*: the wave-1 `ryu-mail` plus the wave-2..4 app bins. Each is skipped
/// when already resolved and 404s harmlessly until its release asset ships, so the
/// whole set can be fetched unconditionally without an "is this app enabled" signal
/// (which lives behind Core's HTTP API, not queried from this Tauri layer).
///
/// **Format assumption:** every asset is a *portable single-file spawnable* (portable
/// `.exe` on Windows, a plain binary elsewhere), so each installs the same way —
/// download, chmod +x, rename into place — with no archive extraction. This is why
/// `ryu-browser` is excluded (Electron bundle, needs extraction + a nested exec). A
/// future `.zip` asset would carry that extension and need an extract step; deferred
/// until such an asset exists.
static OPTIONAL_SIDECARS: &[SidecarBinary] = &[
	MAIL, TEAMS, RESEARCH, CLIPS, FINETUNE, QUESTS, HEALING, MEETINGS, RECIPES, DASHBOARDS,
	MONITORS,
];

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

/// Destination for an installed binary: `~/.ryu/bin/<bin_name>[.exe]`. This is the
/// second path Core's resolvers probe (after the env override), so a download here
/// is picked up on the next spawn.
fn install_path(bin_name: &str) -> Option<PathBuf> {
	let file = if cfg!(windows) {
		format!("{bin_name}.exe")
	} else {
		bin_name.to_string()
	};
	dirs::home_dir().map(|h| h.join(".ryu").join("bin").join(file))
}

/// Whether `spec` already resolves to a real file — mirroring how Core resolves it
/// (env override → `~/.ryu/bin/<bin>` → bare name on PATH). Used to skip a redundant
/// download on every launch. `~/.ryu/bin` is on the PATH Core builds, so the
/// `~/.ryu/bin` and PATH checks usually coincide; both are kept for env-less setups.
fn is_installed(spec: &SidecarBinary) -> bool {
	// 1. Explicit env override pointing at an existing file.
	if std::env::var(spec.env_var)
		.ok()
		.map(PathBuf::from)
		.is_some_and(|p| p.exists())
	{
		return true;
	}
	// 2. Our install target under ~/.ryu/bin.
	if install_path(spec.bin_name).is_some_and(|p| p.exists()) {
		return true;
	}
	// 3. Anywhere on PATH.
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
	download_release_binary(app, &asset, dest, event).await
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
	if is_installed(&GATEWAY) {
		return install_path(GATEWAY.bin_name).ok_or("could not resolve home directory".to_string());
	}
	download_gateway_binary(app).await
}

/// Progress-event name for `spec`, matching the wave-1 naming: the asset base with
/// its `ryu-` prefix stripped, plus `-install-progress` (e.g. `ryu-mail` →
/// `mail-install-progress`, `ryu-teams` → `teams-install-progress`). Returned owned
/// so callers can pass `&event`.
fn progress_event(spec: &SidecarBinary) -> String {
	let short = spec.asset_base.strip_prefix("ryu-").unwrap_or(spec.asset_base);
	format!("{short}-install-progress")
}

/// Ensure one optional opt-in app sidecar is installed, downloading it if absent and
/// skipping when it already resolves (env override → `~/.ryu/bin/<bin>` → PATH). Used
/// for every [`OPTIONAL_SIDECARS`] entry; the caller runs it detached after Core start
/// and swallows failures silently (opt-in apps whose release asset may not exist yet).
async fn ensure_optional_installed(app: &AppHandle, spec: &SidecarBinary) -> Result<PathBuf, String> {
	if is_installed(spec) {
		return install_path(spec.bin_name).ok_or("could not resolve home directory".to_string());
	}
	install_sidecar(app, spec, &progress_event(spec)).await
}

/// Fetch every optional opt-in app sidecar ([`OPTIONAL_SIDECARS`]) into `~/.ryu/bin/`,
/// each in its own detached task so none delays the UI or Core start. Failures are
/// logged at debug and swallowed — an opt-in app whose release asset isn't published
/// yet 404s harmlessly, and one that already resolves is skipped. Call once, after
/// Core has been started; gate the call on `not(debug_assertions)` (in dev these bins
/// are owned by turbo).
pub fn spawn_optional_sidecar_installs(app: &AppHandle) {
	for spec in OPTIONAL_SIDECARS {
		let app = app.clone();
		let spec = *spec;
		tauri::async_runtime::spawn(async move {
			if let Err(e) = ensure_optional_installed(&app, &spec).await {
				tracing::debug!(
					"{} sidecar not installed (opt-in app): {}",
					spec.asset_base,
					e
				);
			}
		});
	}
}
