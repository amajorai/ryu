use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::UpdaterExt;

const CACHE_SCHEMA_VERSION: u8 = 1;
const MANIFEST_FILE: &str = "manifest.json";
pub const DOWNLOAD_PREFERENCE_KEY: &str = "download-app-updates-automatically";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AppUpdateSource {
    Stable,
    Channel { channel: String },
    Tag { tag: String, channel: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAppUpdate {
    pub schema_version: u8,
    pub version: String,
    pub source: AppUpdateSource,
    pub signature: String,
    pub artifact_size: u64,
    pub artifact_file: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareAppUpdateRequest {
    pub expected_version: String,
    pub source: AppUpdateSource,
}

#[derive(Default)]
pub struct AppUpdateState {
    operation: tokio::sync::Mutex<()>,
}

static RUNTIME_UPDATE_IN_PROGRESS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn runtime_update_in_progress() -> bool {
    RUNTIME_UPDATE_IN_PROGRESS.load(std::sync::atomic::Ordering::SeqCst)
}

struct RuntimeUpdateGuard {
    release_on_drop: bool,
}

impl RuntimeUpdateGuard {
    fn enter() -> Result<Self, AppUpdateError> {
        RUNTIME_UPDATE_IN_PROGRESS
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .map_err(|_| AppUpdateError::new(Code::AlreadyWaiting))?;
        Ok(Self {
            release_on_drop: true,
        })
    }

    fn wait_for_relaunch(&mut self) {
        self.release_on_drop = false;
    }
}

impl Drop for RuntimeUpdateGuard {
    fn drop(&mut self) {
        if self.release_on_drop {
            RUNTIME_UPDATE_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
}

mod store;
#[cfg(test)]
mod tests;
#[path = "update_error.rs"]
mod update_error;

use update_error::{AppUpdateError, AppUpdateErrorCode as Code, Coded};

#[cfg(test)]
use store::install_then_clear;
pub(crate) use store::verify_minisign;
use store::{
    download_preference, is_prepared_newer, prepared_metadata_matches_feed,
    PreparedUpdateCandidate, PreparedUpdateStore,
};

async fn confirm_app_update(app: &tauri::AppHandle) -> Result<bool, AppUpdateError> {
    let active = crate::tray::active_local_run_count().await;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    crate::native_copy::show_confirm(
        app,
        crate::native_copy::update_confirmation(active),
        move |accepted| {
            let _ = sender.send(accepted);
        },
    );
    receiver.await.coded(Code::ConfirmFailed)
}

async fn stop_runtime_for_update(
    app: &tauri::AppHandle,
) -> Result<Option<crate::core::process::RyuCoreProcess>, AppUpdateError> {
    let handle = app.clone();
    let lifecycle_state = app.state::<crate::CoreState>();
    let operation = lifecycle_state.operation.lock().await;
    let process = tokio::task::spawn_blocking(move || {
        let state = handle.state::<crate::CoreState>();
        let mut guard = state.process.lock().map_err(|error| error.to_string())?;
        if !guard.as_ref().is_some_and(|process| process.owns_process()) {
            return Ok(None); // Operator-owned nodes are outside this update transaction.
        }
        let Some(mut process) = guard.take() else {
            return Ok(None);
        };
        if let Err(error) = process.try_stop() {
            *guard = Some(process);
            return Err(error.to_string());
        }
        Ok(Some(process))
    })
    .await
    .coded(Code::RuntimeStopFailed)?
    .coded(Code::RuntimeStopFailed)?;
    drop(operation);
    if let Some(process) = process {
        if process.is_already_running().await {
            restore_runtime_after_update_failure(app, process).await?;
            return Err(AppUpdateError::new(Code::RuntimeStillRunning));
        }
        return Ok(Some(process));
    }
    Ok(None)
}

async fn restore_runtime_after_update_failure(
    app: &tauri::AppHandle,
    mut process: crate::core::process::RyuCoreProcess,
) -> Result<(), AppUpdateError> {
    let state = app.state::<crate::CoreState>();
    let _operation = state.operation.lock().await;
    let restarted = process.start().await.coded(Code::RuntimeRestartFailed);
    let mut guard = state
        .process
        .lock()
        .map_err(|error| error.to_string())
        .coded(Code::RuntimeRestartFailed)?;
    *guard = Some(process);
    restarted
}

fn cache_store(app: &tauri::AppHandle) -> Result<PreparedUpdateStore, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("prepared-app-update")
        .join(crate::profile::name());
    Ok(PreparedUpdateStore::new(root))
}

fn updater_public_key(app: &tauri::AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "Tauri updater public key is not configured".to_string())
}

fn updater_for_source(
    app: &tauri::AppHandle,
    source: &AppUpdateSource,
) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = source
        .endpoint_for_app(app)?
        .parse()
        .map_err(|error| format!("invalid app-owned updater endpoint: {error}"))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())
}

fn parse_version(value: &str) -> Result<Version, String> {
    Version::parse(value.trim_start_matches('v'))
        .map_err(|error| format!("invalid update version: {error}"))
}

pub(crate) fn require_update_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Only the main application can change app updates".into())
    }
}

#[tauri::command]
pub fn get_app_update_download_preference(app: tauri::AppHandle) -> bool {
    let value = app
        .store(crate::tray::SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(DOWNLOAD_PREFERENCE_KEY));
    download_preference(value.as_ref())
}

#[tauri::command]
pub fn set_app_update_download_preference(
    window: tauri::Window,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    require_update_window(window.label())?;
    let store = app
        .store(crate::tray::SETTINGS_FILE)
        .map_err(|error| error.to_string())?;
    store.set(DOWNLOAD_PREFERENCE_KEY, serde_json::json!(enabled));
    store.save().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_prepared_app_update(
    app: tauri::AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<PreparedAppUpdate>, String> {
    let _guard = state.operation.lock().await;
    let store = cache_store(&app)?;
    let prepared = match store.read() {
        Ok(Some(prepared)) => prepared,
        Ok(None) => return Ok(None),
        Err(error) => {
            tracing::warn!(error = %error, "app_update cache_invalid");
            let _ = store.clear();
            return Ok(None);
        }
    };
    if !is_prepared_newer(&prepared.version, &app.package_info().version.to_string()) {
        let _ = store.clear();
        return Ok(None);
    }
    let public_key = updater_public_key(&app)?;
    if let Err(error) = store.verified_artifact(&prepared, &public_key) {
        tracing::warn!(version = %prepared.version, error = %error, "app_update cache_signature_invalid");
        let _ = store.clear();
        return Ok(None);
    }
    Ok(Some(prepared))
}

#[tauri::command]
pub async fn clear_prepared_app_update(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<(), String> {
    require_update_window(window.label())?;
    let _guard = state.operation.lock().await;
    cache_store(&app)?.clear()
}

#[tauri::command]
pub async fn prepare_app_update(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppUpdateState>,
    request: PrepareAppUpdateRequest,
) -> Result<Option<PreparedAppUpdate>, AppUpdateError> {
    require_update_window(window.label()).coded(Code::NotMainWindow)?;
    let _guard = state.operation.lock().await;
    let expected_version = parse_version(&request.expected_version).coded(Code::NotConfigured)?;
    let store = cache_store(&app).coded(Code::CacheFailed)?;
    let public_key = updater_public_key(&app).coded(Code::NotConfigured)?;

    if let Ok(Some(prepared)) = store.read() {
        if parse_version(&prepared.version).ok().as_ref() == Some(&expected_version)
            && store.verified_artifact(&prepared, &public_key).is_ok()
        {
            tracing::info!(version = %prepared.version, "app_update prepare_reused");
            crate::core::install::prepare_app_runtime(&app, &prepared.version)
                .await
                .coded(Code::RuntimePrepareFailed)?;
            return Ok(Some(prepared));
        }
    }

    tracing::info!(version = %expected_version, "app_update prepare_started");
    let updater = updater_for_source(&app, &request.source).coded(Code::NotConfigured)?;
    let found = match updater.check().await {
        Ok(found) => found,
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => return Ok(None),
        Err(error) => return Err(AppUpdateError::with_detail(Code::DownloadFailed, error)),
    };
    let Some(update) = found else {
        return Ok(None);
    };
    let offered_version = parse_version(&update.version).coded(Code::DownloadFailed)?;
    if offered_version != expected_version {
        return Err(AppUpdateError::feed_moved(
            expected_version,
            offered_version,
        ));
    }
    let signature = update.signature.clone();
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .coded(Code::DownloadFailed)?;
    verify_minisign(&bytes, &signature, &public_key).coded(Code::SignatureInvalid)?;
    crate::core::install::prepare_app_runtime(&app, &offered_version.to_string())
        .await
        .coded(Code::RuntimePrepareFailed)?;
    let prepared = store
        .commit(
            PreparedUpdateCandidate {
                version: offered_version.to_string(),
                source: request.source,
                signature,
            },
            &bytes,
        )
        .coded(Code::CacheFailed)?;
    tracing::info!(version = %prepared.version, bytes = prepared.artifact_size, "app_update prepare_ready");
    Ok(Some(prepared))
}

#[tauri::command]
pub async fn install_prepared_app_update(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<bool>, AppUpdateError> {
    require_update_window(window.label()).coded(Code::NotMainWindow)?;
    let _guard = state.operation.lock().await;
    let store = cache_store(&app).coded(Code::CacheFailed)?;
    let Some(prepared) = store.read().coded(Code::CacheFailed)? else {
        return Ok(Some(false));
    };
    if !is_prepared_newer(&prepared.version, &app.package_info().version.to_string()) {
        store.clear().coded(Code::CacheFailed)?;
        return Ok(Some(false));
    }
    let public_key = updater_public_key(&app).coded(Code::NotConfigured)?;
    let bytes = store
        .verified_artifact(&prepared, &public_key)
        .coded(Code::SignatureInvalid)?;
    let updater = updater_for_source(&app, &prepared.source).coded(Code::NotConfigured)?;
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            store.clear().coded(Code::CacheFailed)?;
            return Ok(Some(false));
        }
        Err(error) => return Err(AppUpdateError::with_detail(Code::DownloadFailed, error)),
    };
    if !prepared_metadata_matches_feed(
        &prepared.version,
        &prepared.signature,
        &update.version,
        &update.signature,
    ) {
        store.clear().coded(Code::CacheFailed)?;
        return Err(AppUpdateError::new(Code::PreparedMismatch));
    }

    crate::core::install::prepare_app_runtime(&app, &prepared.version)
        .await
        .coded(Code::RuntimePrepareFailed)?;
    let mut handoff = crate::update_handoff::prepare(&app, &prepared, &update, &bytes)
        .await
        .coded(Code::HandoffUnavailable)?;
    if !confirm_app_update(&app).await? {
        tracing::info!(version = %prepared.version, "app_update install_cancelled; prepared update retained");
        return Ok(None);
    }
    tracing::info!(version = %prepared.version, "app_update install_explicit");
    let mut runtime_guard = RuntimeUpdateGuard::enter()?;
    let stopped_runtime = stop_runtime_for_update(&app).await?;
    let installed =
        match crate::update_handoff::verify_quiesced(&handoff, stopped_runtime.is_some()).await {
            Ok(()) => crate::update_handoff::accept(&mut handoff)
                .await
                .coded(Code::HandoffFailed),
            Err(error) => Err(AppUpdateError::with_detail(
                Code::RuntimeStillRunning,
                error,
            )),
        };
    if let Err(error) = installed {
        let cleanup = ryu_runtime_install::handoff::cancel_handoff(&handoff.request).err();
        if let Some(process) = stopped_runtime {
            if let Err(recovery) = restore_runtime_after_update_failure(&app, process).await {
                return Err(recovery.also(error));
            }
        }
        if let Some(cleanup) = cleanup {
            return Err(error.also(format_args!("startup fence not released: {cleanup:#}")));
        }
        return Err(error);
    }
    runtime_guard.wait_for_relaunch();
    crate::tray::begin_quit();
    app.exit(0);
    Ok(Some(true))
}

impl AppUpdateSource {
    pub(crate) fn endpoint(&self) -> Result<String, String> {
        self.endpoint_with_base(crate::distribution::DEFAULT_RELEASE_BASE)
    }

    pub(crate) fn endpoint_for_app(&self, app: &tauri::AppHandle) -> Result<String, String> {
        self.endpoint_for_product(
            &crate::distribution::release_base(app)?,
            crate::distribution::feed_stem(&app.config().identifier),
        )
    }

    fn endpoint_with_base(&self, base: &str) -> Result<String, String> {
        self.endpoint_for_product(base, crate::distribution::DEFAULT_FEED_STEM)
    }

    /// The feed for this source. `stem` names the product's feed family
    /// (`latest` for Ryu, `latest-bot` for the standalone Ryu Bot build), so a
    /// product never installs another product's bundle over itself.
    fn endpoint_for_product(&self, base: &str, stem: &str) -> Result<String, String> {
        match self {
            Self::Stable => Ok(format!("{base}/latest/download/{stem}.json")),
            Self::Channel { channel } if channel == "beta" => {
                Ok(format!("{base}/latest/download/{stem}-beta.json"))
            }
            Self::Channel { channel } if matches!(channel.as_str(), "nightly" | "canary") => {
                // Only Ryu has rolling nightly/canary trains; the standalone Bot
                // build is published with stable releases (and beta, which
                // tracks stable) alone. CI no longer publishes the rolling
                // `nightly`/`canary` tags, so callers should send a `Tag` source
                // with the build's versioned tag; this form is kept for
                // previously persisted metadata.
                if stem != crate::distribution::DEFAULT_FEED_STEM {
                    return Err(format!("Ryu Bot has no {channel} builds"));
                }
                Ok(format!("{base}/download/{channel}/{stem}-{channel}.json"))
            }
            Self::Channel { channel } => Err(format!("unsupported release channel: {channel}")),
            Self::Tag { tag, channel } => {
                if !is_safe_url_segment(tag, |character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '+' | '-')
                }) || !matches!(channel.as_str(), "stable" | "beta" | "nightly" | "canary")
                {
                    return Err("invalid release tag or channel".to_string());
                }
                // Each nightly/canary build publishes `{stem}-{channel}.json` on
                // its own versioned tag (the rolling tags are retired), and only
                // Ryu ships those trains.
                if matches!(channel.as_str(), "nightly" | "canary")
                    && stem != crate::distribution::DEFAULT_FEED_STEM
                {
                    return Err(format!("Ryu Bot has no {channel} builds"));
                }
                let file = if channel == "stable" {
                    format!("{stem}.json")
                } else {
                    format!("{stem}-{channel}.json")
                };
                Ok(format!("{base}/download/{tag}/{file}"))
            }
        }
    }
}

fn is_safe_url_segment(segment: &str, allowed: impl Fn(char) -> bool) -> bool {
    const MAX_SEGMENT_LEN: usize = 64;
    !segment.is_empty()
        && segment.len() <= MAX_SEGMENT_LEN
        && !segment.starts_with('.')
        && !segment.starts_with('-')
        && !segment.contains("..")
        && segment.chars().all(allowed)
}
