use tauri::{
	image::Image,
	menu::{Menu, MenuItem, PredefinedMenuItem},
	tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
	Emitter, Manager, Runtime,
};
use tauri_plugin_store::StoreExt;

/// Stable id so the tray handle can be looked up again after creation to toggle
/// its visibility at runtime (see `set_hide_tray_icon`).
const TRAY_ID: &str = "main";
/// Local desktop-process settings file (tauri-plugin-store). Read synchronously
/// at startup before Core is guaranteed to be up, so the tray pref lives here
/// rather than in Core's `/api/preferences` KV.
const SETTINGS_FILE: &str = "settings.json";
/// When `true`, the tray / menu bar icon is hidden. Absent/false = shown.
const HIDE_TRAY_KEY: &str = "hide-tray-icon";

/// Loopback control server the Electron island exposes (see
/// `island/src/main/control.ts`). The island has no tray of its own anymore — the
/// menu-bar presence is unified here — so we drive its window + lifecycle through
/// this surface. The port is profile-aware (dev variant → 8989) and honours an
/// explicit `ISLAND_CONTROL_PORT` env override, matching the island side.
fn island_control_url() -> String {
	format!(
		"http://127.0.0.1:{}/control",
		crate::profile::island_control_port()
	)
}

/// Shadow capture-control endpoint (device-bound local sidecar). Toggling capture
/// is a Shadow concern, so the desktop tray talks to it directly rather than
/// proxying through the island. Profile-aware port (release 3030, dev 4030),
/// matching Core's spawn side; the request carries Shadow's shared-secret
/// bearer (see `shadow_auth`) because every non-`/health` route is gated.
fn shadow_capture_url() -> String {
	format!(
		"http://127.0.0.1:{}/capture/control",
		crate::profile::port(3030)
	)
}

/// Local sidecars answer fast or not at all; keep tray actions snappy.
const CONTROL_TIMEOUT_SECS: u64 = 2;

fn control_client() -> Option<reqwest::Client> {
	reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(CONTROL_TIMEOUT_SECS))
		.build()
		.ok()
}

/// Bring the main window forward (creating focus) before running a webview action.
fn focus_main<R: Runtime>(app: &tauri::AppHandle<R>) {
	if let Some(window) = app.get_webview_window("main") {
		let _ = window.show();
		let _ = window.set_focus();
	}
}

/// Send a control action ("toggle" | "show" | "hide" | "quit") to the island.
/// Best-effort: the island may not be running, in which case we silently no-op.
async fn island_control(action: &'static str) {
	let Some(client) = control_client() else {
		return;
	};
	let _ = client
		.post(island_control_url())
		.json(&serde_json::json!({ "action": action }))
		.send()
		.await;
}

/// Flip Shadow's capture pause state and return the new `paused` value (or `None`
/// when Shadow is unreachable / the response is malformed).
async fn toggle_shadow_capture() -> Option<bool> {
	let client = control_client()?;
	let url = shadow_capture_url();
	let current = crate::shadow_auth::with_auth(client.get(&url))
		.send()
		.await
		.ok()?
		.json::<serde_json::Value>()
		.await
		.ok()?;
	let paused = current
		.get("paused")
		.and_then(|v| v.as_bool())
		.unwrap_or(false);
	let next = !paused;
	let updated = crate::shadow_auth::with_auth(client.post(&url))
		.json(&serde_json::json!({ "paused": next }))
		.send()
		.await
		.ok()?
		.json::<serde_json::Value>()
		.await
		.ok()?;
	Some(
		updated
			.get("paused")
			.and_then(|v| v.as_bool())
			.unwrap_or(next),
	)
}

/// Read the persisted "hide tray icon" preference. Defaults to `false` (shown)
/// whenever the store is missing, unreadable, or the key is unset.
fn read_hide_tray<R: Runtime, M: Manager<R>>(app: &M) -> bool {
	app.store(SETTINGS_FILE)
		.ok()
		.and_then(|store| store.get(HIDE_TRAY_KEY))
		.and_then(|value| value.as_bool())
		.unwrap_or(false)
}

pub fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
	let show = MenuItem::with_id(app, "show", "Show Ryu", true, None::<&str>)?;
	// The island (companion overlay) and its capture pipeline are driven from here
	// now that the island has no menu-bar icon of its own.
	let companion = MenuItem::with_id(app, "companion", "Show/Hide Companion", true, None::<&str>)?;
	let capture = MenuItem::with_id(app, "capture", "Pause Capture", true, None::<&str>)?;
	let timeline = MenuItem::with_id(app, "timeline", "Open Timeline", true, None::<&str>)?;
	let palette = MenuItem::with_id(app, "palette", "Search Everything…", true, None::<&str>)?;
	let sep1 = PredefinedMenuItem::separator(app)?;
	let sep2 = PredefinedMenuItem::separator(app)?;
	let sep3 = PredefinedMenuItem::separator(app)?;
	let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
	let menu = Menu::with_items(
		app,
		&[
			&show, &sep1, &companion, &capture, &sep2, &timeline, &palette, &sep3, &quit,
		],
	)?;

	// On macOS the menu bar recolors a "template" image automatically for the
	// active light/dark appearance, using only its alpha channel. We rasterize
	// the transparent ghost SVG to `tray-template.png` and hand it over as a
	// template so it tracks the system theme. On Windows/Linux template recolor
	// does not exist and a transparent ghost would be near-invisible on a light
	// taskbar, so we keep the self-contained app icon there.
	let is_mac = cfg!(target_os = "macos");
	let tray_icon = if is_mac {
		Image::from_bytes(include_bytes!("../icons/tray-template.png"))?
	} else {
		app.default_window_icon().unwrap().clone()
	};

	// Held so the "capture" item's label can flip between Pause/Resume after a
	// toggle round-trips to Shadow. Cloned into the menu-event closure below.
	let capture_item = capture.clone();

	let tray = TrayIconBuilder::with_id(TRAY_ID)
		.icon(tray_icon)
		.icon_as_template(is_mac)
		.menu(&menu)
		.on_menu_event(move |app, event| match event.id.as_ref() {
			"show" => {
				focus_main(app);
			}
			// Toggle the Electron island overlay via its loopback control server.
			"companion" => {
				tauri::async_runtime::spawn(island_control("toggle"));
			}
			// Pause/resume Shadow capture, then reflect the new state in the label.
			"capture" => {
				let item = capture_item.clone();
				tauri::async_runtime::spawn(async move {
					if let Some(paused) = toggle_shadow_capture().await {
						let label = if paused {
							"Resume Capture"
						} else {
							"Pause Capture"
						};
						let _ = item.set_text(label);
					}
				});
			}
			// Bring the window forward, then ask the webview to open the timeline
			// tab / command palette (mirrors the `nodes-changed` event pattern).
			"timeline" => {
				focus_main(app);
				let _ = app.emit("tray-open-timeline", ());
			}
			"palette" => {
				focus_main(app);
				let _ = app.emit("tray-open-palette", ());
			}
			// Stop the companion island too, then exit — the unified tray owns both
			// lifecycles, and the island has no other quit affordance.
			"quit" => {
				let handle = app.clone();
				tauri::async_runtime::spawn(async move {
					island_control("quit").await;
					handle.exit(0);
				});
			}
			_ => {}
		})
		.on_tray_icon_event(|tray, event| {
			if let TrayIconEvent::Click {
				button: MouseButton::Left,
				button_state: MouseButtonState::Up,
				..
			} = event
			{
				let app = tray.app_handle();
				if let Some(window) = app.get_webview_window("main") {
					let _ = window.show();
					let _ = window.set_focus();
				}
			}
		})
		.build(app)?;

	// Honor the persisted preference: start hidden if the user disabled the
	// tray. Built-then-hidden (rather than skipped) keeps a single code path so
	// the runtime toggle just flips visibility on the retained handle.
	if read_hide_tray(app) {
		let _ = tray.set_visible(false);
	}

	Ok(())
}

/// Current "hide tray icon" preference, for the settings UI to seed its toggle.
#[tauri::command]
pub fn get_hide_tray_icon(app: tauri::AppHandle) -> bool {
	read_hide_tray(&app)
}

/// Persist the "hide tray icon" preference and apply it to the live tray icon
/// immediately. `hidden = true` removes the icon from the tray / menu bar.
#[tauri::command]
pub fn set_hide_tray_icon(app: tauri::AppHandle, hidden: bool) -> Result<(), String> {
	let store = app.store(SETTINGS_FILE).map_err(|e| e.to_string())?;
	store.set(HIDE_TRAY_KEY, serde_json::json!(hidden));
	store.save().map_err(|e| e.to_string())?;

	if let Some(tray) = app.tray_by_id(TRAY_ID) {
		tray.set_visible(!hidden).map_err(|e| e.to_string())?;
	}
	Ok(())
}
