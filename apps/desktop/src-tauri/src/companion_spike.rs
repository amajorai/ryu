/// M7 Companion Spike — issue #194
///
/// Validates three primitives needed for the context companion:
///   1. A second always-on-top transparent WebviewWindow can be created inside the
///      existing Tauri app without touching the main window.
///   2. tauri-plugin-global-shortcut 2.3.2 can register a hotkey that toggles it.
///   3. Shadow :3030 /proactive and /context/recent are reachable from the Tauri
///      backend and return well-typed JSON.
///
/// When the `companion-spike` feature is OFF (the default), this module compiles to
/// zero-cost stubs. The feature gate is enforced in Cargo.toml.
///
/// To run the spike:
///   cd apps/desktop && cargo tauri dev --features companion-spike

// ── Overlay window label / constants (shared for test assertions) ──────────────
#[allow(dead_code)]
pub const OVERLAY_LABEL: &str = "companion-overlay";
#[allow(dead_code)]
pub const DEFAULT_HOTKEY: &str = "Alt+Space";
#[allow(dead_code)]
const SHADOW_BASE: &str = "http://127.0.0.1:3030";
#[allow(dead_code)]
const SHADOW_TIMEOUT_SECS: u64 = 2;

// ── Setup: create overlay window + register global shortcut ───────────────────
// Called from lib.rs setup() when the feature is active.

#[cfg(feature = "companion-spike")]
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
	use tauri::{WebviewUrl, WebviewWindowBuilder};
	use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

	// 1. Create the always-on-top transparent overlay (hidden on start).
	let _overlay =
		WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("/companion".into()))
			.title("Ryu Companion")
			.inner_size(420.0, 640.0)
			.always_on_top(true)
			.decorations(false)
			.transparent(true)
			.skip_taskbar(true)
			.visible(false)
			.build()?;

	tracing::info!("[companion-spike] overlay window created (hidden)");

	// 2. macOS: use Accessory activation policy so the overlay does not
	//    appear in the Dock or menu-bar switcher.
	#[cfg(target_os = "macos")]
	{
		use tauri::ActivationPolicy;
		app.set_activation_policy(ActivationPolicy::Accessory);
		tracing::info!("[companion-spike] macOS ActivationPolicy::Accessory set");
	}

	// 3. Register the global hotkey.
	let handle = app.handle().clone();
	app.handle().plugin(
		tauri_plugin_global_shortcut::Builder::new()
			.with_shortcut(DEFAULT_HOTKEY)?
			.with_handler(move |_app, _shortcut, event| {
				if event.state == ShortcutState::Pressed {
					toggle_overlay(&handle);
				}
			})
			.build(),
	)?;

	tracing::info!(
		"[companion-spike] global shortcut registered: {}",
		DEFAULT_HOTKEY
	);

	Ok(())
}

// ── Toggle helper ──────────────────────────────────────────────────────────────

#[cfg(feature = "companion-spike")]
fn toggle_overlay(app: &tauri::AppHandle) {
	use tauri::Manager;
	if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
		let visible = win.is_visible().unwrap_or(false);
		if visible {
			let _ = win.hide();
			tracing::info!("[companion-spike] overlay hidden");
		} else {
			let _ = win.show();
			let _ = win.set_focus();
			tracing::info!("[companion-spike] overlay shown");
		}
	} else {
		tracing::warn!("[companion-spike] overlay window not found");
	}
}

// ── Tauri commands ─────────────────────────────────────────────────────────────
//
// The commands below are registered in lib.rs invoke_handler when the feature is
// active. When the feature is off they compile to unreachable no-ops so the
// generate_handler! list stays valid.

#[allow(dead_code)]
fn build_shadow_client() -> Result<reqwest::Client, String> {
	reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(SHADOW_TIMEOUT_SECS))
		.build()
		.map_err(|e| e.to_string())
}

/// Returns the most-recent proactive suggestions from Shadow's ProactiveStore.
///
/// Response shape (when Shadow is running):
/// ```json
/// { "suggestions": [ { "id", "suggestion_type", "content", "confidence",
///                       "priority", "created_at", "expires_at",
///                       "context_snapshot", "delivered", "dismissed" } ] }
/// ```
/// Returns `{ "suggestions": [], "error": "..." }` when Shadow is unreachable.
#[tauri::command]
pub async fn companion_get_proactive() -> Result<serde_json::Value, String> {
	#[cfg(not(feature = "companion-spike"))]
	return Err("companion-spike feature not enabled".to_string());

	#[cfg(feature = "companion-spike")]
	{
		let client = build_shadow_client()?;
		let url = format!("{SHADOW_BASE}/proactive");
		match client.get(&url).send().await {
			Ok(resp) => resp
				.json::<serde_json::Value>()
				.await
				.map_err(|e| format!("shadow parse error: {e}")),
			Err(e) => {
				tracing::warn!("[companion-spike] shadow /proactive unreachable: {e}");
				Ok(serde_json::json!({ "suggestions": [], "error": e.to_string() }))
			}
		}
	}
}

/// Returns recent context timeline entries from Shadow.
///
/// `minutes` — look-back window (default 10).
///
/// Response shape:
/// ```json
/// { "entries": [ { "id", "ts", "category", "app", "title", "text",
///                   "embedding" } ],
///   "count": 42,
///   "window_minutes": 10 }
/// ```
#[tauri::command]
pub async fn companion_get_context(minutes: Option<u64>) -> Result<serde_json::Value, String> {
	#[cfg(not(feature = "companion-spike"))]
	return Err("companion-spike feature not enabled".to_string());

	#[cfg(feature = "companion-spike")]
	{
		let mins = minutes.unwrap_or(10);
		let client = build_shadow_client()?;
		let url = format!("{SHADOW_BASE}/context/recent?q={mins}");
		match client.get(&url).send().await {
			Ok(resp) => resp
				.json::<serde_json::Value>()
				.await
				.map_err(|e| format!("shadow parse error: {e}")),
			Err(e) => {
				tracing::warn!("[companion-spike] shadow /context/recent unreachable: {e}");
				Ok(serde_json::json!({
					"entries": [],
					"count": 0,
					"window_minutes": minutes.unwrap_or(10),
					"error": e.to_string()
				}))
			}
		}
	}
}

/// Toggle the companion overlay from a Tauri command (usable from the frontend
/// as a fallback when the global shortcut is not available).
#[tauri::command]
pub async fn companion_toggle(app: tauri::AppHandle) {
	#[cfg(feature = "companion-spike")]
	toggle_overlay(&app);

	#[cfg(not(feature = "companion-spike"))]
	{
		let _ = app;
		tracing::warn!("[companion-spike] companion_toggle called but feature is not enabled");
	}
}

// ── Tests (cargo test --features companion-spike) ─────────────────────────────

#[cfg(all(test, feature = "companion-spike"))]
mod tests {
	/// Verify the Shadow API contracts by hitting a live Shadow instance on :3030.
	/// Run with: cargo test --features companion-spike -- --nocapture
	///
	/// If Shadow is not running the test is skipped gracefully (not failed).
	#[tokio::test]
	async fn shadow_api_proactive_shape() {
		let client = reqwest::Client::builder()
			.timeout(std::time::Duration::from_secs(2))
			.build()
			.unwrap();

		let resp = match client.get("http://127.0.0.1:3030/proactive").send().await {
			Ok(r) => r,
			Err(_) => {
				eprintln!("[spike-test] Shadow not running — skipping proactive shape test");
				return;
			}
		};

		assert!(resp.status().is_success(), "expected 200 from /proactive");
		let body: serde_json::Value = resp.json().await.expect("JSON parse");
		assert!(
			body.get("suggestions").is_some(),
			"expected 'suggestions' key in /proactive response"
		);
		eprintln!(
			"[spike-test] /proactive OK — suggestions count: {}",
			body["suggestions"].as_array().map(|a| a.len()).unwrap_or(0)
		);
	}

	#[tokio::test]
	async fn shadow_api_context_recent_shape() {
		let client = reqwest::Client::builder()
			.timeout(std::time::Duration::from_secs(2))
			.build()
			.unwrap();

		let resp = match client
			.get("http://127.0.0.1:3030/context/recent?q=10")
			.send()
			.await
		{
			Ok(r) => r,
			Err(_) => {
				eprintln!("[spike-test] Shadow not running — skipping context/recent shape test");
				return;
			}
		};

		assert!(
			resp.status().is_success(),
			"expected 200 from /context/recent"
		);
		let body: serde_json::Value = resp.json().await.expect("JSON parse");
		assert!(
			body.get("entries").is_some(),
			"expected 'entries' key in /context/recent response"
		);
		assert!(
			body.get("count").is_some(),
			"expected 'count' key in /context/recent response"
		);
		assert!(
			body.get("window_minutes").is_some(),
			"expected 'window_minutes' key in /context/recent response"
		);
		eprintln!(
			"[spike-test] /context/recent OK — entries: {}, window_minutes: {}",
			body["count"].as_u64().unwrap_or(0),
			body["window_minutes"].as_u64().unwrap_or(0)
		);
	}
}
