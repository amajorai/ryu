mod core;
mod hardware;
mod nodes;
mod permissions;
mod profile;
mod secrets;
mod shadow_auth;
mod tray;
mod win_process;
// M7 companion spike — compiled only when companion-spike feature is active.
mod companion_spike;

use std::sync::Mutex;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::core::process::RyuCoreProcess;

/// Restore the macOS native title-bar buttons so decorum can reposition them.
///
/// Our windows use `decorations: false` so Windows/Linux can draw decorum's
/// custom HTML window controls. On macOS, though, a borderless window has no
/// close/miniaturize/zoom buttons, so decorum's traffic-light positioner
/// dereferences nil (`close.superview()`) and the process aborts with
/// "null pointer dereference" in cocoa's appkit. We re-add the titled style
/// mask (which brings back the native buttons) and hide the title bar's title
/// and background, yielding the standard "transparent title bar with inset
/// traffic lights" look — exactly what the positioner expects.
///
/// This must run for every window *before* decorum's own `on_window_ready`
/// positioner fires, so it is wired up as a plugin registered ahead of
/// decorum (see `macos_titlebar_plugin`). `ns_window` is the raw `NSWindow`
/// pointer from `Window::ns_window()` / `WebviewWindow::ns_window()`.
/// Shared traffic-light inset for every window: x from the left edge, and a
/// y chosen so decorum centers the buttons ~30.7px from the window top (it
/// places them at y/2 + 11). That is the tab strip's natural centerline —
/// the h-12 titlebar sits in the SidebarInset main area (m-2), so its items
/// center at mt-2 + h-12/2 = 30.72px — shared by the back/forward/sidebar
/// cluster (top-4 + h-8) and the sidebar node selector, so tabs, lights,
/// cluster, and selector read as one line.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS_INSET: (f32, f32) = (28.0, 39.4);

#[cfg(target_os = "macos")]
fn apply_macos_titlebar_mask(ns_window: *mut std::ffi::c_void) {
	use cocoa::appkit::{NSWindow, NSWindowStyleMask, NSWindowTitleVisibility};
	use cocoa::base::{id, YES};

	if ns_window.is_null() {
		return;
	}
	let ns_window = ns_window as id;
	// SAFETY: `ns_window` is the live `NSWindow` owned by this Tauri window, and
	// window-ready callbacks run on the main thread.
	unsafe {
		let mask = NSWindowStyleMask::NSTitledWindowMask
			| NSWindowStyleMask::NSClosableWindowMask
			| NSWindowStyleMask::NSMiniaturizableWindowMask
			| NSWindowStyleMask::NSResizableWindowMask
			| NSWindowStyleMask::NSFullSizeContentViewWindowMask;
		ns_window.setStyleMask_(mask);
		ns_window.setTitlebarAppearsTransparent_(YES);
		ns_window.setTitleVisibility_(NSWindowTitleVisibility::NSWindowTitleHidden);
	}
}

/// Tauri plugin that restores the native macOS title bar mask on every window
/// as soon as it is ready. Registered *before* `tauri_plugin_decorum` so its
/// `on_window_ready` runs first — otherwise decorum's auto-positioner hits the
/// borderless window's nil traffic-light buttons and aborts. See
/// [`apply_macos_titlebar_mask`].
#[cfg(target_os = "macos")]
fn macos_titlebar_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
	tauri::plugin::Builder::new("ryu-macos-titlebar")
		.on_window_ready(|win| {
			if let Ok(ns_window) = win.ns_window() {
				apply_macos_titlebar_mask(ns_window);
			}
		})
		.build()
}

struct CoreState {
	process: Mutex<Option<RyuCoreProcess>>,
}

pub(crate) struct HttpClient(pub reqwest::Client);

fn resolve_core_binary() -> Option<std::path::PathBuf> {
	let bin_name = if cfg!(windows) {
		"ryu-core.exe"
	} else {
		"ryu-core"
	};

	// 1. Explicit env var override
	std::env::var("RYU_CORE_BIN")
		.ok()
		.map(std::path::PathBuf::from)
		.filter(|p| p.exists())
		// 2. ~/.ryu{profile}/bin (installed) — profile-aware so a dev app resolves its
		//    OWN binary under ~/.ryu-dev/bin, never the release app's ~/.ryu/bin exe.
		.or_else(|| {
			Some(profile::ryu_home_dir().join("bin").join(bin_name)).filter(|p| p.exists())
		})
		// 3. PATH
		.or_else(|| which::which(bin_name.strip_suffix(".exe").unwrap_or(bin_name)).ok())
		// 4. Dev build: navigate from exe to workspace root
		.or_else(|| {
			if !cfg!(debug_assertions) {
				return None;
			}
			std::env::current_exe().ok().and_then(|exe| {
				// exe: <workspace>/apps/desktop/src-tauri/target/debug/<app>
				// go up 6 levels to reach workspace root
				let workspace = exe
					.parent()? // debug/
					.parent()? // target/
					.parent()? // src-tauri/
					.parent()? // desktop/
					.parent()? // apps/
					.parent()?; // workspace root
				let core = workspace
					.join("apps")
					.join("core")
					.join("target")
					.join("debug")
					.join(bin_name);
				Some(core).filter(|p| p.exists())
			})
		})
}

#[tauri::command]
async fn start_ryu_core(state: tauri::State<'_, CoreState>) -> Result<String, String> {
	// In dev builds, ryu-core is owned by the `core#dev` turbo task (`cargo run`).
	// Spawning it here would lock the binary and block recompilation.
	// The frontend's health-poll loop will detect when core comes online.
	#[cfg(debug_assertions)]
	return Ok("connecting".to_string());

	// Check if we already have a running process
	#[allow(unreachable_code)]
	{
		let mut guard = state.process.lock().map_err(|e| e.to_string())?;
		if let Some(ref mut process) = *guard {
			if process.is_running() {
				return Ok("already running".to_string());
			}
		}
	}

	let binary = match resolve_core_binary() {
        Some(p) => p,
        None => return Err("Could not find ryu-core binary. Install it to ~/.ryu/bin/ or set RYU_CORE_BIN env var.".to_string()),
    };

	// Create new process manager
	let mut process = RyuCoreProcess::new(binary);

	// Start the process (will connect to existing instance if already running)
	match process.start().await {
		Ok(()) => {
			// Check if we connected to an existing instance
			let message = if process.has_child() {
				"started".to_string()
			} else {
				"already running".to_string()
			};

			// Store the process in state
			let mut guard = state.process.lock().map_err(|e| e.to_string())?;
			*guard = Some(process);

			Ok(message)
		}
		Err(e) => Err(format!("Failed to start Ryu Core: {}", e)),
	}
}

/// Ensure the `ryu-core` binary is installed, downloading it from the release hub
/// if missing. Returns the binary path. A no-op in dev (turbo owns the binary).
#[tauri::command]
async fn ensure_core_installed(app: tauri::AppHandle) -> Result<String, String> {
	#[cfg(debug_assertions)]
	{
		let _ = app;
		return Ok("dev".to_string());
	}
	#[cfg(not(debug_assertions))]
	{
		if let Some(p) = resolve_core_binary() {
			return Ok(p.to_string_lossy().to_string());
		}
		let p = crate::core::install::download_core_binary(&app).await?;
		Ok(p.to_string_lossy().to_string())
	}
}

/// Ensure the Island Electron companion is installed under `~/.ryu/island/`, then
/// launch it, returning the launched bundle path. Dev is a no-op (`"dev"`): turbo
/// owns Island in development (`bun run dev` starts electron-vite), so downloading a
/// release build would fight it — same `debug_assertions` gate as
/// [`ensure_core_installed`]. Invoked from the node selector's Island row ("Install /
/// Launch" when the local island isn't reachable) and from onboarding.
#[tauri::command]
async fn install_and_launch_island(app: tauri::AppHandle) -> Result<String, String> {
	#[cfg(debug_assertions)]
	{
		let _ = app;
		return Ok("dev".to_string());
	}
	#[cfg(not(debug_assertions))]
	{
		let path = crate::core::install::ensure_island_installed(&app).await?;
		crate::core::install::launch_island()?;
		Ok(path.to_string_lossy().to_string())
	}
}

#[tauri::command]
async fn get_ryu_status() -> String {
	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(2))
		.build()
		.unwrap_or_else(|_| reqwest::Client::new());

	match client
		.get(format!("{}/api/health", profile::core_base_url()))
		.send()
		.await
	{
		Ok(response) if response.status().is_success() => "running".to_string(),
		_ => "stopped".to_string(),
	}
}

#[tauri::command]
async fn stop_ryu_core(state: tauri::State<'_, CoreState>) -> Result<(), String> {
	// Extract the process from the state to avoid holding lock across await
	let process = {
		let mut guard = state.process.lock().map_err(|e| e.to_string())?;
		guard.take()
	};

	if let Some(mut process) = process {
		process
			.stop()
			.await
			.map_err(|e| format!("Failed to stop Ryu Core: {}", e))?;
	}

	Ok(())
}

#[tauri::command]
fn get_ryu_core_url() -> String {
	profile::core_localhost_url()
}

/// Build/runtime profile for the frontend badge. `dev = true` when this is the
/// dev variant (RYU_PROFILE=dev or the `dev-variant` build), so the sidebar can
/// show a "Dev" badge. Release builds return `false`.
#[derive(serde::Serialize)]
struct BuildProfile {
	dev: bool,
}

#[tauri::command]
fn get_build_profile() -> BuildProfile {
	BuildProfile {
		dev: profile::is_dev(),
	}
}

/// Install an update from a non-stable release channel's own updater feed.
///
/// The JS `@tauri-apps/plugin-updater` can only read the single static endpoint
/// baked into `tauri.conf.json` (the Stable `latest.json`). To make channel
/// switching change *which feed the updater checks*, this rebuilds the updater at
/// runtime pointed at `<channel>/latest.json`, checks it, and installs if an
/// update is there. Returns `Ok(true)` when a build was installed (the caller then
/// relaunches), `Ok(false)` when the channel feed reports nothing newer.
#[tauri::command]
async fn install_update_from_channel(
	app: tauri::AppHandle,
	channel: String,
) -> Result<bool, String> {
	use tauri_plugin_updater::UpdaterExt;

	// Per-channel feed under the same release hub as the Stable endpoint in
	// tauri.conf.json (`.../latest/download/latest.json`). GitHub release asset
	// names are FLAT (no slashes), so a channel maps to `latest-<channel>.json`,
	// e.g. `latest-nightly.json`. The release CI must publish these assets for the
	// non-stable channels — until it does, `check()` returns None (Ok(false)).
	// Stable is the default JS path and never reaches here.
	let url = format!(
		"https://github.com/amajorai/ryu/releases/latest/download/latest-{}.json",
		channel
	);
	let endpoint = url
		.parse()
		.map_err(|e| format!("bad channel feed url: {e}"))?;

	let updater = app
		.updater_builder()
		.endpoints(vec![endpoint])
		.map_err(|e| e.to_string())?
		.build()
		.map_err(|e| e.to_string())?;

	let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
		return Ok(false);
	};

	update
		.download_and_install(|_, _| {}, || {})
		.await
		.map_err(|e| e.to_string())?;
	Ok(true)
}

// ── Data folder relocation / import (offline, runs while Core is stopped) ─────────

/// Stop the Core we manage, then wait until its HTTP server is actually down.
/// Refuses (rather than copying a live database) if Core stays up — this covers
/// dev, where Core is owned by the `core#dev` turbo task and we can't stop it.
async fn stop_core_and_wait(state: &tauri::State<'_, CoreState>) -> Result<(), String> {
	let process = {
		let mut guard = state.process.lock().map_err(|e| e.to_string())?;
		guard.take()
	};
	if let Some(mut process) = process {
		process.stop().await.map_err(|e| e.to_string())?;
	}

	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(1))
		.build()
		.map_err(|e| e.to_string())?;
	for _ in 0..8 {
		let up = client
			.get(format!("{}/api/health", profile::core_base_url()))
			.send()
			.await
			.map(|r| r.status().is_success())
			.unwrap_or(false);
		if !up {
			return Ok(());
		}
		tokio::time::sleep(std::time::Duration::from_secs(1)).await;
	}
	Err("Ryu Core is still running and could not be stopped. In dev, stop the core dev task before relocating the data folder.".to_string())
}

/// Run `ryu-core data-path …`, forwarding `@@PROGRESS {json}` lines to the
/// `data-folder-progress` frontend event. Returns the subcommand's stderr on
/// failure.
async fn run_data_path_subcommand(
	app: &tauri::AppHandle,
	binary: &std::path::Path,
	args: &[String],
) -> Result<(), String> {
	use tokio::io::{AsyncBufReadExt, BufReader};
	use tokio::process::Command;

	use crate::win_process::NoWindow;

	let mut child = Command::new(binary)
		.args(args)
		.stdout(std::process::Stdio::piped())
		.stderr(std::process::Stdio::piped())
		.no_window()
		.spawn()
		.map_err(|e| format!("failed to launch ryu-core: {e}"))?;

	if let Some(stdout) = child.stdout.take() {
		let mut lines = BufReader::new(stdout).lines();
		while let Ok(Some(line)) = lines.next_line().await {
			if let Some(rest) = line.strip_prefix("@@PROGRESS ") {
				if let Ok(value) = serde_json::from_str::<serde_json::Value>(rest) {
					let _ = app.emit("data-folder-progress", value);
				}
			}
		}
	}

	let status = child.wait().await.map_err(|e| e.to_string())?;
	if status.success() {
		return Ok(());
	}
	let mut err = String::new();
	if let Some(stderr) = child.stderr.take() {
		let mut lines = BufReader::new(stderr).lines();
		while let Ok(Some(line)) = lines.next_line().await {
			err.push_str(&line);
			err.push('\n');
		}
	}
	Err(if err.trim().is_empty() {
		format!("ryu-core exited with {status}")
	} else {
		err.trim().to_string()
	})
}

/// Copy-relocate the data folder to `to`, then restart the app to apply.
#[tauri::command]
async fn migrate_data_folder(
	app: tauri::AppHandle,
	state: tauri::State<'_, CoreState>,
	to: String,
	move_source: bool,
) -> Result<(), String> {
	let binary =
		resolve_core_binary().ok_or_else(|| "Could not find ryu-core binary.".to_string())?;
	stop_core_and_wait(&state).await?;
	let mut args = vec![
		"data-path".to_string(),
		"migrate".to_string(),
		"--to".to_string(),
		to,
	];
	if move_source {
		args.push("--move".to_string());
	}
	run_data_path_subcommand(&app, &binary, &args).await?;
	app.restart();
}

/// Restore the data folder from a backup zip, then restart the app to apply.
#[tauri::command]
async fn import_data_folder(
	app: tauri::AppHandle,
	state: tauri::State<'_, CoreState>,
	archive: String,
	to: Option<String>,
) -> Result<(), String> {
	let binary =
		resolve_core_binary().ok_or_else(|| "Could not find ryu-core binary.".to_string())?;
	stop_core_and_wait(&state).await?;
	let mut args = vec![
		"data-path".to_string(),
		"import".to_string(),
		"--archive".to_string(),
		archive,
	];
	if let Some(to) = to {
		args.push("--to".to_string());
		args.push(to);
	}
	run_data_path_subcommand(&app, &binary, &args).await?;
	app.restart();
}

/// Open a URL with the OS default handler. Only web/mail schemes are allowed:
/// callers pass backend-supplied URLs, and a hand-rolled command bypasses the
/// shell plugin's scope validation, so a `file://`/`smb://` URL from a spoofed
/// backend must never reach the opener.
#[tauri::command]
async fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
	use tauri_plugin_shell::ShellExt;
	let parsed = tauri::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
	if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
		return Err(format!(
			"Refusing to open URL with disallowed scheme '{}'.",
			parsed.scheme()
		));
	}
	app.shell().open(&url, None).map_err(|e| e.to_string())
}

fn command_exists(command: &str) -> bool {
	let Some(paths) = std::env::var_os("PATH") else {
		return false;
	};
	std::env::split_paths(&paths).any(|dir| {
		let candidate = dir.join(command);
		if candidate.is_file() {
			return true;
		}
		#[cfg(windows)]
		{
			let candidate = dir.join(format!("{command}.exe"));
			if candidate.is_file() {
				return true;
			}
		}
		false
	})
}

#[cfg(target_os = "macos")]
fn mac_app_exists(name: &str) -> bool {
	[
		format!("/Applications/{name}.app"),
		format!("/System/Applications/{name}.app"),
		format!("/System/Applications/Utilities/{name}.app"),
	]
	.iter()
	.any(|path| std::path::Path::new(path).exists())
}

fn editor_is_available(editor: &str) -> bool {
	match editor {
		"vscode" => {
			command_exists("code") || {
				#[cfg(target_os = "macos")]
				{
					mac_app_exists("Visual Studio Code")
				}
				#[cfg(not(target_os = "macos"))]
				{
					false
				}
			}
		}
		"zed" => {
			command_exists("zed") || {
				#[cfg(target_os = "macos")]
				{
					mac_app_exists("Zed")
				}
				#[cfg(not(target_os = "macos"))]
				{
					false
				}
			}
		}
		"cursor" => {
			command_exists("cursor") || {
				#[cfg(target_os = "macos")]
				{
					mac_app_exists("Cursor")
				}
				#[cfg(not(target_os = "macos"))]
				{
					false
				}
			}
		}
		"terminal" => {
			if cfg!(windows) {
				command_exists("wt") || command_exists("cmd")
			} else if cfg!(target_os = "macos") {
				true
			} else {
				command_exists("x-terminal-emulator")
			}
		}
		"gitbash" => {
			if cfg!(windows) {
				std::path::Path::new("C:\\Program Files\\Git\\bin\\bash.exe").exists()
					|| command_exists("bash")
			} else {
				command_exists("bash")
			}
		}
		"powershell" => cfg!(windows) && (command_exists("powershell") || command_exists("pwsh")),
		"cmd" => cfg!(windows) && command_exists("cmd"),
		"explorer" | "finder" => true,
		_ => false,
	}
}

#[derive(serde::Serialize)]
struct EditorAvailability {
	id: String,
	available: bool,
}

#[tauri::command]
async fn get_editor_availability(editors: Vec<String>) -> Result<Vec<EditorAvailability>, String> {
	Ok(editors
		.into_iter()
		.map(|id| {
			let available = editor_is_available(&id);
			EditorAvailability { id, available }
		})
		.collect())
}

/// Open a project folder in an external editor or file manager.
/// `editor` is one of: vscode, zed, cursor, terminal, gitbash, explorer/finder.
/// `path` defaults to "." when omitted.
#[tauri::command]
async fn open_in_editor(
	app: tauri::AppHandle,
	editor: String,
	path: Option<String>,
) -> Result<(), String> {
	use tauri_plugin_shell::ShellExt;
	let raw_path = path.as_deref().unwrap_or(".");

	// Reject flag-like paths (argument injection) and URL-scheme paths (e.g. javascript:, file://).
	if raw_path.starts_with('-') {
		return Err("Invalid path: must not start with '-'".to_string());
	}
	if raw_path.contains("://") {
		return Err("Invalid path: URL schemes are not allowed".to_string());
	}

	// Canonicalize so symlinks and `..` traversal are resolved to an absolute path.
	// Fall back to the raw value only for paths that don't exist yet (e.g. ".").
	let owned;
	let path = match std::fs::canonicalize(raw_path) {
		Ok(p) => {
			owned = p.to_string_lossy().into_owned();
			owned.as_str()
		}
		Err(_) => raw_path,
	};

	let result = match editor.as_str() {
		// `--` terminates option parsing for editors that support it (code, zed, cursor).
		"vscode" => app
			.shell()
			.command("code")
			.args(["--", path])
			.spawn()
			.or_else(|_| {
				if cfg!(target_os = "macos") {
					app.shell()
						.command("open")
						.args(["-a", "Visual Studio Code", path])
						.spawn()
				} else {
					app.shell().command("code").args(["--", path]).spawn()
				}
			}),
		"zed" => app
			.shell()
			.command("zed")
			.args(["--", path])
			.spawn()
			.or_else(|_| {
				if cfg!(target_os = "macos") {
					app.shell()
						.command("open")
						.args(["-a", "Zed", path])
						.spawn()
				} else {
					app.shell().command("zed").args(["--", path]).spawn()
				}
			}),
		"cursor" => app
			.shell()
			.command("cursor")
			.args(["--", path])
			.spawn()
			.or_else(|_| {
				if cfg!(target_os = "macos") {
					app.shell()
						.command("open")
						.args(["-a", "Cursor", path])
						.spawn()
				} else {
					app.shell().command("cursor").args(["--", path]).spawn()
				}
			}),
		"terminal" => {
			if cfg!(windows) {
				app.shell()
					.command("wt")
					.args(["-d", path])
					.spawn()
					.or_else(|_| {
						app.shell()
							.command("cmd")
							.args(["/c", "start", "cmd"])
							.spawn()
					})
			} else if cfg!(target_os = "macos") {
				app.shell()
					.command("open")
					.args(["-a", "Terminal", path])
					.spawn()
			} else {
				app.shell().command("x-terminal-emulator").spawn()
			}
		}
		"gitbash" => {
			if cfg!(windows) {
				app.shell()
					.command("C:\\Program Files\\Git\\bin\\bash.exe")
					.args(["--login", "-i"])
					.spawn()
					.or_else(|_| app.shell().command("bash").args(["--login", "-i"]).spawn())
			} else {
				app.shell().command("bash").args(["--login"]).spawn()
			}
		}
		// New console windows must be launched via `start`; a bare `cmd`/`powershell`
		// spawned by Tauri has no attached console. The new window inherits the parent
		// working directory, so set it via `current_dir` rather than embedding the path
		// in the command string (avoids quoting/space/injection issues).
		"powershell" => {
			if cfg!(windows) {
				app.shell()
					.command("cmd")
					.args(["/c", "start", "powershell"])
					.current_dir(path)
					.spawn()
			} else {
				return Err("PowerShell launcher is only available on Windows".to_string());
			}
		}
		"cmd" => {
			if cfg!(windows) {
				app.shell()
					.command("cmd")
					.args(["/c", "start", "cmd"])
					.current_dir(path)
					.spawn()
			} else {
				return Err("Command Prompt is only available on Windows".to_string());
			}
		}
		"explorer" | "finder" => {
			if cfg!(windows) {
				app.shell().command("explorer").args([path]).spawn()
			} else if cfg!(target_os = "macos") {
				app.shell().command("open").args([path]).spawn()
			} else {
				app.shell().command("xdg-open").args([path]).spawn()
			}
		}
		_ => return Err(format!("Unknown editor: {editor}")),
	};

	result.map(|_| ()).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct ShellOutput {
	stdout: String,
	stderr: String,
	code: i32,
}

/// Execute a shell command and return its stdout/stderr/exit code.
/// Used by the embedded terminal panel in the desktop UI.
///
/// SECURITY: This is an intentional full-shell exec primitive — a terminal emulator
/// requires shell semantics (pipes, redirects, compound commands). Mitigations in place:
/// 1. cwd is canonicalized to a real existing directory before use.
/// 2. The iframe panels that load external URLs run with `sandbox="allow-scripts
///    allow-forms allow-popups"` (no `allow-same-origin`), so iframe scripts cannot
///    reach `window.parent.__TAURI__` and call this command across the iframe boundary.
/// 3. Tauri's webview does not navigate to external URLs; the renderer is trusted
///    local content only.
/// Resolve a caller-requested shell name to a concrete (binary, command-flag)
/// pair through a FIXED ALLOWLIST. The caller's string is NEVER passed through
/// as the binary directly — that would be arbitrary-binary execution. Any
/// unrecognized, empty, or absent value falls back to the OS default (the
/// historical behaviour), so a garbage value can never spawn something outside
/// this list.
fn resolve_shell(requested: Option<&str>) -> (&'static str, &'static str) {
	match requested.map(str::trim).filter(|s| !s.is_empty()) {
		Some("bash") => ("bash", "-c"),
		Some("zsh") => ("zsh", "-c"),
		Some("sh") => ("sh", "-c"),
		Some("fish") => ("fish", "-c"),
		Some("powershell") => ("powershell", "-Command"),
		Some("pwsh") => ("pwsh", "-Command"),
		Some("cmd") => ("cmd", "/C"),
		// None or any unrecognized value → the OS default (today's behavior).
		_ => {
			if cfg!(windows) {
				("powershell", "-Command")
			} else {
				("bash", "-c")
			}
		}
	}
}

#[tauri::command]
async fn shell_execute(
	app: tauri::AppHandle,
	command: String,
	cwd: Option<String>,
	shell: Option<String>,
) -> Result<ShellOutput, String> {
	use tauri_plugin_shell::ShellExt;

	let (shell, flag) = resolve_shell(shell.as_deref());

	// Canonicalize cwd: reject non-existent paths and resolve symlinks / `..` traversal.
	let resolved_cwd: Option<std::path::PathBuf> = if let Some(ref dir) = cwd {
		let canonical =
			std::fs::canonicalize(dir).map_err(|_| format!("Invalid working directory: {dir}"))?;
		if !canonical.is_dir() {
			return Err(format!("Working directory is not a directory: {dir}"));
		}
		Some(canonical)
	} else {
		None
	};

	let mut cmd = app.shell().command(shell).args([flag, command.as_str()]);
	if let Some(ref dir) = resolved_cwd {
		cmd = cmd.current_dir(dir);
	}

	let output = cmd.output().await.map_err(|e| e.to_string())?;

	Ok(ShellOutput {
		stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
		stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
		code: output.status.code().unwrap_or(1),
	})
}

/// Create the companion overlay window if it does not exist, then show it.
/// If it already exists and is visible, hide it (toggle behaviour).
fn toggle_companion_window(app: &tauri::AppHandle) {
	match app.get_webview_window("companion") {
		Some(win) => {
			let visible = win.is_visible().unwrap_or(false);
			if visible {
				win.hide().ok();
			} else {
				win.show().ok();
				win.set_focus().ok();
			}
		}
		None => {
			// Companion window URL: the React app detects the window label and renders
			// the overlay shell. In dev we load from the Vite dev server; in production
			// from the embedded dist bundle.
			let url = if cfg!(debug_assertions) {
				WebviewUrl::External(
					"http://localhost:5173"
						.parse()
						.expect("companion dev URL is valid"),
				)
			} else {
				WebviewUrl::App("index.html".into())
			};

			// Center the companion horizontally on the primary monitor. Display
			// widths vary widely (MacBook panels are 1512/1728/1800 wide, not
			// 1920), so a hardcoded 1920 mis-centers the window on most Macs.
			// Monitor size is in physical pixels but `position` is logical, so
			// divide by the scale factor. Fall back to the 1920 assumption if the
			// monitor can't be queried, anchoring near top-center either way.
			const COMPANION_WIDTH: f64 = 400.0;
			let companion_x = app
				.primary_monitor()
				.ok()
				.flatten()
				.map(|monitor| {
					let logical_width = monitor.size().width as f64 / monitor.scale_factor();
					(logical_width - COMPANION_WIDTH) / 2.0
				})
				.unwrap_or((1920.0 - COMPANION_WIDTH) / 2.0);

			match WebviewWindowBuilder::new(app, "companion", url)
				.title("Ryu Companion")
				.inner_size(COMPANION_WIDTH, 80.0)
				.position(companion_x, 40.0)
				.decorations(false)
				.transparent(true)
				.always_on_top(true)
				.skip_taskbar(true)
				.resizable(false)
				.build()
			{
				Ok(win) => {
					win.show().ok();
					win.set_focus().ok();
				}
				Err(e) => {
					tracing::error!("Failed to create companion window: {}", e);
				}
			}
		}
	}
}

/// Monotonic counter for tear-off window labels, unique for the lifetime of the
/// process. A new window per increment (`tab-1`, `tab-2`, …) — labels must be
/// unique and Tauri rejects reuse of a live one.
static TAB_WINDOW_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Percent-encode a query-param value (UTF-8 bytes → %XX for anything outside the
/// RFC 3986 unreserved set). Dependency-free; the renderer's `URLSearchParams`
/// decodes it back to the original UTF-8 string.
fn encode_param(s: &str) -> String {
	let mut out = String::with_capacity(s.len());
	for b in s.bytes() {
		match b {
			b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
				out.push(b as char);
			}
			_ => out.push_str(&format!("%{b:02X}")),
		}
	}
	out
}

/// Open a tab in a separate OS window ("Move tab to new window", browser-style).
/// The new window loads the same app shell; the `window=tab` query seeds a single
/// tab focused on `conversation_id` and pinned to `node` (so a tab targeting a
/// remote node keeps targeting it). Conversation state is server-side, so the new
/// window simply re-fetches history by id. Closing this window never stops Core —
/// that is gated to the `main` window label in `on_window_event`.
#[tauri::command]
async fn open_tab_window(
	app: tauri::AppHandle,
	path: Option<String>,
	conversation_id: Option<String>,
	node: Option<String>,
	title: Option<String>,
) -> Result<(), String> {
	use std::sync::atomic::Ordering;

	let n = TAB_WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
	let label = format!("tab-{n}");

	let mut params: Vec<String> = vec!["window=tab".to_string()];
	if let Some(ref p) = path {
		params.push(format!("path={}", encode_param(p)));
	}
	if let Some(ref c) = conversation_id {
		params.push(format!("conv={}", encode_param(c)));
	}
	if let Some(ref nd) = node {
		params.push(format!("node={}", encode_param(nd)));
	}
	if let Some(ref t) = title {
		params.push(format!("title={}", encode_param(t)));
	}
	let query = params.join("&");

	// Dev loads the Vite server (same origin as the main window, so the bearer
	// token in localStorage carries over); production loads the bundled shell.
	let url = if cfg!(debug_assertions) {
		let raw = format!("http://localhost:5173/?{query}");
		WebviewUrl::External(raw.parse().map_err(|e| format!("bad tab url: {e}"))?)
	} else {
		WebviewUrl::App(format!("index.html?{query}").into())
	};

	let win = WebviewWindowBuilder::new(&app, &label, url)
		.title(title.as_deref().unwrap_or("Ryu"))
		.inner_size(1100.0, 780.0)
		.min_inner_size(800.0, 600.0)
		.center()
		.decorations(false)
		.transparent(true)
		// Let the webview's own HTML5 drag-and-drop work (tab reordering in the
		// title bar) instead of Tauri intercepting it — mirrors the main window's
		// `dragDropEnabled: false` in tauri.conf.json.
		.disable_drag_drop_handler()
		.build()
		.map_err(|e| e.to_string())?;

	// Mirror the main window's frameless overlay window controls so the tear-off
	// is closable/minimizable like any other window.
	win.create_overlay_titlebar().map_err(|e| e.to_string())?;
	#[cfg(target_os = "macos")]
	{
		// Must run before `set_traffic_lights_inset` — restores the native
		// buttons a borderless macOS window otherwise lacks. The titlebar
		// plugin also does this on window-ready, but that may land after this
		// synchronous call for a freshly built window, so apply it here too.
		if let Ok(ns_window) = win.ns_window() {
			apply_macos_titlebar_mask(ns_window);
		}
		win.set_traffic_lights_inset(TRAFFIC_LIGHTS_INSET.0, TRAFFIC_LIGHTS_INSET.1)
			.map_err(|e| e.to_string())?;
	}

	Ok(())
}

/// Read a UTF-8 text file by absolute path — backs the in-app markdown editor
/// opening project files from the active workspace folder.
#[tauri::command]
async fn read_project_file(path: String) -> Result<String, String> {
	std::fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Write a UTF-8 text file by absolute path — the markdown editor's autosave.
#[tauri::command]
async fn write_project_file(path: String, content: String) -> Result<(), String> {
	std::fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))
}

/// List markdown files under a folder (bounded recursion) for the file picker.
#[tauri::command]
async fn list_project_markdown(folder: String) -> Result<Vec<String>, String> {
	fn walk(dir: &std::path::Path, out: &mut Vec<String>, depth: usize) {
		if depth > 6 || out.len() >= 1000 {
			return;
		}
		let Ok(entries) = std::fs::read_dir(dir) else {
			return;
		};
		for entry in entries.flatten() {
			let path = entry.path();
			let name = entry.file_name();
			let name = name.to_string_lossy();
			if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist"
			{
				continue;
			}
			if path.is_dir() {
				walk(&path, out, depth + 1);
			} else if path
				.extension()
				.and_then(|e| e.to_str())
				.is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
			{
				if let Some(s) = path.to_str() {
					out.push(s.to_owned());
				}
			}
		}
	}
	let mut out = Vec::new();
	walk(std::path::Path::new(&folder), &mut out, 0);
	out.sort();
	Ok(out)
}

pub fn run() {
	let mut builder = tauri::Builder::default()
		.manage(CoreState {
			process: Mutex::new(None),
		})
		.manage(HttpClient(
			reqwest::Client::builder()
				.timeout(std::time::Duration::from_secs(5))
				.build()
				.unwrap_or_else(|_| reqwest::Client::new()),
		))
		// Single-instance MUST be the first plugin. On Windows/Linux a `ryu://`
		// link spawns a second process; this forwards the URL to the live
		// instance (the deep-link plugin's `onOpenUrl` fires there) and the
		// callback just surfaces the existing window. We do not hand-parse argv.
		.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
			if let Some(win) = app.get_webview_window("main") {
				let _ = win.show();
				let _ = win.unminimize();
				let _ = win.set_focus();
			}
		}))
		.plugin(tauri_plugin_deep_link::init())
		.plugin(tauri_plugin_log::Builder::default().build())
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_fs::init())
		.plugin(tauri_plugin_store::Builder::new().build());

	// macOS only: restore native traffic-light buttons before decorum's own
	// positioner runs. MUST be registered ahead of decorum so its
	// `on_window_ready` fires first; otherwise decorum dereferences the
	// borderless window's nil window buttons and the app aborts.
	#[cfg(target_os = "macos")]
	{
		builder = builder.plugin(macos_titlebar_plugin());
	}

	builder = builder
		.plugin(tauri_plugin_decorum::init())
		.plugin(tauri_plugin_global_shortcut::Builder::new().build())
		// Auto-update: tauri-plugin-updater is the install mechanism; the
		// update *verdict* + the auto-update toggle live in Core. plugin-process
		// provides `relaunch()` after a successful install.
		.plugin(tauri_plugin_updater::Builder::new().build())
		.plugin(tauri_plugin_process::init());

	// MCP bridge (Tauri MCP server) is a dev/test-only tool — never ship in release.
	#[cfg(debug_assertions)]
	{
		builder = builder.plugin(tauri_plugin_mcp_bridge::init());
	}

	builder.setup(|app| {
            let win = app.get_webview_window("main").unwrap();
            win.create_overlay_titlebar().unwrap();
            #[cfg(target_os = "macos")]
            {
                // The titlebar plugin already restored the native buttons on
                // window-ready; re-apply defensively before positioning.
                if let Ok(ns_window) = win.ns_window() {
                    apply_macos_titlebar_mask(ns_window);
                }
                win.set_traffic_lights_inset(TRAFFIC_LIGHTS_INSET.0, TRAFFIC_LIGHTS_INSET.1)
                    .unwrap();
            }

            tray::setup_tray(app)?;

            // Register the `ryu://` scheme with the OS at runtime. Production
            // Windows builds register it via the NSIS installer (from the
            // tauri.conf.json scheme list), but dev builds and Linux need a
            // runtime call. Non-fatal: a registration failure must not abort
            // startup (the app still runs, deep links just won't route).
            #[cfg(any(debug_assertions, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    eprintln!("warning: failed to register ryu:// deep-link scheme: {err}");
                }
            }

            // Register global hotkey to toggle the companion overlay window.
            // Default: Ctrl+Shift+Space (all platforms). Readable via settings in future units.
            let companion_shortcut = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT),
                Code::Space,
            );
            let shortcut_handle = app.handle().clone();
            // Non-fatal: another app (e.g. the Island companion) may already own this
            // hotkey. Log and continue rather than aborting the whole setup hook.
            if let Err(err) = app.global_shortcut().on_shortcut(
                companion_shortcut,
                move |_app, _shortcut, _event| {
                    let handle = shortcut_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        toggle_companion_window(&handle);
                    });
                },
            ) {
                eprintln!(
                    "warning: failed to register companion hotkey (Ctrl+Shift+Space), it may already be in use: {err}"
                );
            }

            // Watch <ryu-home>/nodes.json and emit "nodes-changed" when it changes.
            // Profile-aware so the dev variant watches ~/.ryu-dev/nodes.json.
            let watcher_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let path = profile::ryu_home_dir().join("nodes.json");

                // Seed the baseline so the first poll doesn't fire spuriously on startup.
                let mut last_modified: Option<std::time::SystemTime> =
                    std::fs::metadata(&path).ok().and_then(|m| m.modified().ok());

                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if let Ok(meta) = std::fs::metadata(&path) {
                        let modified = meta.modified().ok();
                        if modified != last_modified {
                            last_modified = modified;
                            watcher_handle.emit("nodes-changed", ()).ok();
                        }
                    }
                }
            });

            // Auto-start Ryu Core on app launch
            let handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                #[allow(unused_mut)]
                let mut binary = resolve_core_binary();
                // Production only: fetch the core binary from the public release hub
                // into ~/.ryu/bin/ when it is missing OR when a stale copy from an
                // older app version is sitting there. The app self-updates via the
                // Tauri updater, but the out-of-process ryu-core sidecar is separate:
                // without this staleness check a 0.0.3 core lingered forever after the
                // app moved to 0.0.8. In dev the binary is owned by turbo
                // (`bun run dev:core`), so we never download — resolve_core_binary's
                // dev fallback finds the debug build.
                #[cfg(not(debug_assertions))]
                if binary.is_none() || crate::core::install::is_managed_core_stale(&handle) {
                    match crate::core::install::download_core_binary(&handle).await {
                        Ok(p) => binary = Some(p),
                        // Keep whatever resolve_core_binary found on failure: a download
                        // error should degrade to the old-but-working core, not strand it.
                        Err(e) => tracing::error!("Failed to auto-install/upgrade Ryu Core: {}", e),
                    }
                }
                // Ensure the ryu-gateway sidecar is on disk BEFORE Core starts: Core
                // spawns it as a managed sidecar at boot and hands it every model
                // call, so a missing gateway degrades chat with no auto-retry. A
                // failure here is loud but non-fatal — the app still opens.
                #[cfg(not(debug_assertions))]
                if let Err(e) = crate::core::install::ensure_gateway_installed(&handle).await {
                    tracing::error!(
                        "Failed to auto-install ryu-gateway (chat will be degraded until it is installed to ~/.ryu/bin/ or RYU_GATEWAY_BIN is set): {}",
                        e
                    );
                }
                if let Some(binary) = binary {
                    let mut process = RyuCoreProcess::new(binary);
                    if let Err(e) = process.start().await {
                        tracing::error!("Failed to auto-start Ryu Core: {}", e);
                    } else {
                        // Store the process in state after successful start
                        let state = handle.state::<CoreState>();
                        if let Ok(mut guard) = state.process.lock() {
                            *guard = Some(process);
                        }
                        tracing::info!("Ryu Core auto-started successfully");
                    }
                } else {
                    tracing::warn!("Ryu Core binary not found — install to ~/.ryu/bin/ or set RYU_CORE_BIN");
                }

                // NOTE: the desktop no longer prefetches the opt-in app sidecar bins
                // (mail/teams/research/…) at boot. Those binaries are now downloaded
                // by Core on-demand the first time their app is *enabled* (and removed
                // on uninstall) — see `apps/core/src/sidecar/manifest_sidecar.rs`
                // (`ensure_local_sidecar_present`) and `plans/019-sidecar-binary-lifecycle.md`.
                // A fresh install therefore ships only core + gateway; an app's binary
                // arrives when the user turns the app on, not before.

                // Island (the Electron companion overlay, loopback :7989) — install
                // it and launch it, best-effort, in its own detached task so it never
                // delays app open. Island is a companion, not required for the app to
                // function, so a failure (unsupported platform, asset not published
                // yet, launch error) is silent like the optional sidecars. Island
                // self-guards with an Electron single-instance lock, so re-launching on
                // a restart where it is already running self-exits. Dev is owned by
                // turbo, same gate as the sidecars.
                //
                // v1: island autostart is DISABLED to shrink the shippable
                // surface (the Electron island is deferred out of the first
                // release). The install+launch code below is left intact and
                // still referenced, so nothing here goes stale. The tray toggle
                // and the `install_and_launch_island` command still work if a
                // user opts in manually — this only removes the boot autostart.
                // TO RE-ENABLE: flip ISLAND_AUTOSTART to `true`.
                #[cfg(not(debug_assertions))]
                {
                    const ISLAND_AUTOSTART: bool = false;
                    if ISLAND_AUTOSTART {
                        let island_handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            match crate::core::install::ensure_island_installed(&island_handle).await
                            {
                                Ok(_) => {
                                    if let Err(e) = crate::core::install::launch_island() {
                                        tracing::debug!("Ryu Island not launched: {}", e);
                                    }
                                }
                                Err(e) => {
                                    tracing::debug!("Ryu Island not installed (companion): {}", e)
                                }
                            }
                        });
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_ryu_core,
            stop_ryu_core,
            ensure_core_installed,
            install_and_launch_island,
            get_ryu_status,
            get_ryu_core_url,
            get_build_profile,
            install_update_from_channel,
            migrate_data_folder,
            import_data_folder,
            open_external,
            get_editor_availability,
            open_in_editor,
            open_tab_window,
            tray::get_hide_tray_icon,
            tray::set_hide_tray_icon,
            shell_execute,
            read_project_file,
            write_project_file,
            list_project_markdown,
            hardware::get_hardware_info,
            hardware::get_system_usage,
            nodes::list_nodes,
            nodes::add_node,
            nodes::remove_node,
            nodes::set_default_node,
            nodes::test_node,
            nodes::test_all_nodes,
            nodes::discover_lan_nodes,
            nodes::get_lan_ip,
            secrets::set_provider_key,
            secrets::get_provider_key,
            secrets::delete_provider_key,
            permissions::check_accessibility_permission,
            permissions::request_accessibility_permission,
            permissions::check_screen_recording_permission,
            permissions::request_screen_recording_permission,
            permissions::check_input_monitoring_permission,
            permissions::request_input_monitoring_permission,
            permissions::automation_permissions_required,
            // M7 companion spike commands (return Err when feature is off)
            companion_spike::companion_get_proactive,
            companion_spike::companion_get_context,
            companion_spike::companion_toggle,
        ])
        .on_window_event(|window, event| {
            // decorum's swizzled windowDidResize delegate re-applies its own
            // hardcoded default pad (12, 16) on every live-resize frame,
            // yanking the traffic lights back into the window corner and off
            // the titlebar row. Tao emits `Resized` after that delegate runs,
            // so re-applying our inset here always lands last in the frame.
            #[cfg(target_os = "macos")]
            if matches!(event, WindowEvent::Resized(_)) {
                if let Some(win) = window.app_handle().get_webview_window(window.label()) {
                    let _ = win
                        .set_traffic_lights_inset(TRAFFIC_LIGHTS_INSET.0, TRAFFIC_LIGHTS_INSET.1);
                }
            }
            if let WindowEvent::Destroyed = event {
                // Only stop Ryu Core when the main window is destroyed.
                // Destroying the companion overlay must not kill the backend.
                if window.label() != "main" {
                    return;
                }
                let state = window.state::<CoreState>();
                if let Ok(mut guard) = state.process.lock() {
                    if let Some(ref mut process) = *guard {
                        if let Err(e) = process.try_stop() {
                            tracing::error!("Failed to stop Ryu Core: {}", e);
                        }
                    }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
