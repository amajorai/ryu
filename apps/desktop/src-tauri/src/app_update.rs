use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_store::StoreExt;
use tauri_plugin_updater::UpdaterExt;
use tempfile::NamedTempFile;

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
    fn enter() -> Result<Self, String> {
        RUNTIME_UPDATE_IN_PROGRESS
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .map_err(|_| "An app update is already waiting for restart".to_owned())?;
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

#[derive(Debug, Clone)]
struct PreparedUpdateCandidate {
    version: String,
    source: AppUpdateSource,
    signature: String,
}

struct PreparedUpdateStore {
    root: PathBuf,
}

impl PreparedUpdateStore {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join(MANIFEST_FILE)
    }

    fn read(&self) -> Result<Option<PreparedAppUpdate>, String> {
        let bytes = match fs::read(self.manifest_path()) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        let prepared: PreparedAppUpdate =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        self.validate_manifest(&prepared)?;
        Ok(Some(prepared))
    }

    fn validate_manifest(&self, prepared: &PreparedAppUpdate) -> Result<(), String> {
        if prepared.schema_version != CACHE_SCHEMA_VERSION {
            return Err(format!(
                "unsupported prepared update schema: {}",
                prepared.schema_version
            ));
        }
        let expected_file = artifact_file(&prepared.version)?;
        if prepared.artifact_file != expected_file {
            return Err("prepared update artifact path is invalid".to_string());
        }
        prepared.source.endpoint()?;
        let metadata = fs::metadata(self.root.join(&prepared.artifact_file))
            .map_err(|error| error.to_string())?;
        if metadata.len() != prepared.artifact_size {
            return Err("prepared update artifact size changed".to_string());
        }
        Ok(())
    }

    fn artifact_bytes(&self, prepared: &PreparedAppUpdate) -> Result<Vec<u8>, String> {
        self.validate_manifest(prepared)?;
        fs::read(self.root.join(&prepared.artifact_file)).map_err(|error| error.to_string())
    }

    fn verified_artifact(
        &self,
        prepared: &PreparedAppUpdate,
        public_key: &str,
    ) -> Result<Vec<u8>, String> {
        let bytes = self.artifact_bytes(prepared)?;
        verify_minisign(&bytes, &prepared.signature, public_key)?;
        Ok(bytes)
    }

    fn commit(
        &self,
        candidate: PreparedUpdateCandidate,
        bytes: &[u8],
    ) -> Result<PreparedAppUpdate, String> {
        self.commit_with_manifest_writer(candidate, bytes, atomic_write_manifest)
    }

    fn commit_with_manifest_writer<F>(
        &self,
        candidate: PreparedUpdateCandidate,
        bytes: &[u8],
        manifest_writer: F,
    ) -> Result<PreparedAppUpdate, String>
    where
        F: FnOnce(&Path, &[u8]) -> io::Result<()>,
    {
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let artifact_file = artifact_file(&candidate.version)?;
        let artifact_path = self.root.join(&artifact_file);

        let mut temporary_artifact =
            NamedTempFile::new_in(&self.root).map_err(|error| error.to_string())?;
        temporary_artifact
            .write_all(bytes)
            .map_err(|error| error.to_string())?;
        temporary_artifact
            .as_file()
            .sync_all()
            .map_err(|error| error.to_string())?;
        temporary_artifact
            .persist(&artifact_path)
            .map_err(|error| error.error.to_string())?;

        let prepared = PreparedAppUpdate {
            schema_version: CACHE_SCHEMA_VERSION,
            version: candidate.version,
            source: candidate.source,
            signature: candidate.signature,
            artifact_size: bytes.len() as u64,
            artifact_file,
        };
        let manifest = serde_json::to_vec_pretty(&prepared).map_err(|error| error.to_string())?;
        manifest_writer(&self.root, &manifest).map_err(|error| error.to_string())?;
        self.remove_superseded_artifacts(&prepared)?;
        Ok(prepared)
    }

    fn remove_superseded_artifacts(&self, prepared: &PreparedAppUpdate) -> Result<(), String> {
        let entries = fs::read_dir(&self.root).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if name == MANIFEST_FILE || name == prepared.artifact_file.as_str() {
                continue;
            }
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}

fn artifact_file(version: &str) -> Result<String, String> {
    let parsed = Version::parse(version.trim_start_matches('v'))
        .map_err(|error| format!("invalid update version: {error}"))?;
    Ok(format!("ryu-update-{parsed}.bin"))
}

fn atomic_write_manifest(directory: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut temporary_manifest = NamedTempFile::new_in(directory)?;
    temporary_manifest.write_all(bytes)?;
    temporary_manifest.as_file().sync_all()?;
    temporary_manifest
        .persist(directory.join(MANIFEST_FILE))
        .map_err(|error| error.error)?;
    Ok(())
}

fn decode_base64_text(value: &str) -> Result<String, String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| error.to_string())?;
    String::from_utf8(decoded).map_err(|error| error.to_string())
}

pub(crate) fn verify_minisign(
    data: &[u8],
    signature: &str,
    public_key: &str,
) -> Result<(), String> {
    let key_text = decode_base64_text(public_key)?;
    let signature_text = decode_base64_text(signature)?;
    let key = PublicKey::decode(&key_text).map_err(|error| error.to_string())?;
    let signature = Signature::decode(&signature_text).map_err(|error| error.to_string())?;
    key.verify(data, &signature, true)
        .map_err(|error| error.to_string())
}

fn download_preference(value: Option<&serde_json::Value>) -> bool {
    value.and_then(serde_json::Value::as_bool) != Some(false)
}

fn is_prepared_newer(prepared: &str, running: &str) -> bool {
    let Ok(prepared) = Version::parse(prepared.trim_start_matches('v')) else {
        return false;
    };
    let Ok(running) = Version::parse(running.trim_start_matches('v')) else {
        return false;
    };
    prepared > running
}

fn prepared_metadata_matches_feed(
    prepared_version: &str,
    prepared_signature: &str,
    offered_version: &str,
    offered_signature: &str,
) -> bool {
    let Ok(prepared_version) = parse_version(prepared_version) else {
        return false;
    };
    let Ok(offered_version) = parse_version(offered_version) else {
        return false;
    };
    prepared_version == offered_version && prepared_signature == offered_signature
}

/// Install first, then remove the prepared bytes. A transient installer failure
/// must leave the already-downloaded, signature-verified artifact available for
/// retry instead of charging the user another full download.
#[cfg(test)]
fn install_then_clear(
    store: &PreparedUpdateStore,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    install()?;
    if let Err(error) = store.clear() {
        tracing::warn!(%error, "installed app update cache cleanup failed");
    }
    Ok(())
}

async fn confirm_app_update(app: &tauri::AppHandle) -> Result<bool, String> {
    let active = crate::tray::active_local_run_count().await;
    let description = if active > 0 {
        format!("{active} local tasks are running. Installing this app update restarts Ryu and stops local chats, tools, and workflows, including work waiting for approval. Finish your work first or update now. Remote nodes continue running.")
    } else {
        "Installing this app update restarts Ryu. Any local chats, tools, and workflows running when it restarts will stop. Finish your work first or update now. Remote nodes continue running.".to_owned()
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(description)
        .title("Install update and restart Ryu?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update and restart".to_owned(),
            "Keep working".to_owned(),
        ))
        .show(move |accepted| {
            let _ = sender.send(accepted);
        });
    receiver.await.map_err(|error| error.to_string())
}

async fn stop_runtime_for_update(
    app: &tauri::AppHandle,
) -> Result<Option<crate::core::process::RyuCoreProcess>, String> {
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
            return Err(format!(
                "Could not stop the local runtime for the update: {error}"
            ));
        }
        Ok(Some(process))
    })
    .await
    .map_err(|error| error.to_string())??;
    drop(operation);
    if let Some(process) = process {
        if process.is_already_running().await {
            restore_runtime_after_update_failure(app, process).await?;
            return Err(
                "The managed runtime is still running; the app update was not started".to_owned(),
            );
        }
        return Ok(Some(process));
    }
    Ok(None)
}

async fn restore_runtime_after_update_failure(
    app: &tauri::AppHandle,
    mut process: crate::core::process::RyuCoreProcess,
) -> Result<(), String> {
    let state = app.state::<crate::CoreState>();
    let _operation = state.operation.lock().await;
    let restarted = process
        .start()
        .await
        .map_err(|error| format!("The previous runtime could not restart: {error}"));
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
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

#[cfg(test)]
mod window_tests {
    #[test]
    fn auxiliary_windows_cannot_change_app_updates() {
        assert!(super::require_update_window("main").is_ok());
        for label in ["", "capture", "settings", "main-2"] {
            assert!(super::require_update_window(label).is_err());
        }
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
) -> Result<Option<PreparedAppUpdate>, String> {
    require_update_window(window.label())?;
    let _guard = state.operation.lock().await;
    let expected_version = parse_version(&request.expected_version)?;
    let store = cache_store(&app)?;
    let public_key = updater_public_key(&app)?;

    if let Ok(Some(prepared)) = store.read() {
        if parse_version(&prepared.version).ok().as_ref() == Some(&expected_version)
            && store.verified_artifact(&prepared, &public_key).is_ok()
        {
            tracing::info!(version = %prepared.version, "app_update prepare_reused");
            crate::core::install::prepare_app_runtime(&app, &prepared.version).await?;
            return Ok(Some(prepared));
        }
    }

    tracing::info!(version = %expected_version, "app_update prepare_started");
    let updater = updater_for_source(&app, &request.source)?;
    let found = match updater.check().await {
        Ok(found) => found,
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let Some(update) = found else {
        return Ok(None);
    };
    let offered_version = parse_version(&update.version)?;
    if offered_version != expected_version {
        return Err(format!(
            "the signed feed moved from v{expected_version} to v{offered_version}; check again before downloading"
        ));
    }
    let signature = update.signature.clone();
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    verify_minisign(&bytes, &signature, &public_key)?;
    crate::core::install::prepare_app_runtime(&app, &offered_version.to_string()).await?;
    let prepared = store.commit(
        PreparedUpdateCandidate {
            version: offered_version.to_string(),
            source: request.source,
            signature,
        },
        &bytes,
    )?;
    tracing::info!(version = %prepared.version, bytes = prepared.artifact_size, "app_update prepare_ready");
    Ok(Some(prepared))
}

#[tauri::command]
pub async fn install_prepared_app_update(
    window: tauri::Window,
    app: tauri::AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<Option<bool>, String> {
    require_update_window(window.label())?;
    let _guard = state.operation.lock().await;
    let store = cache_store(&app)?;
    let Some(prepared) = store.read()? else {
        return Ok(Some(false));
    };
    if !is_prepared_newer(&prepared.version, &app.package_info().version.to_string()) {
        store.clear()?;
        return Ok(Some(false));
    }
    let public_key = updater_public_key(&app)?;
    let bytes = store.verified_artifact(&prepared, &public_key)?;
    let updater = updater_for_source(&app, &prepared.source)?;
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            store.clear()?;
            return Ok(Some(false));
        }
        Err(error) => return Err(error.to_string()),
    };
    if !prepared_metadata_matches_feed(
        &prepared.version,
        &prepared.signature,
        &update.version,
        &update.signature,
    ) {
        store.clear()?;
        return Err(
            "the prepared update no longer matches the current signed feed; download it again"
                .to_string(),
        );
    }

    crate::core::install::prepare_app_runtime(&app, &prepared.version).await?;
    let mut handoff = crate::update_handoff::prepare(&app, &prepared, &update, &bytes).await?;
    if !confirm_app_update(&app).await? {
        tracing::info!(version = %prepared.version, "app_update install_cancelled; prepared update retained");
        return Ok(None);
    }
    tracing::info!(version = %prepared.version, "app_update install_explicit");
    let mut runtime_guard = RuntimeUpdateGuard::enter()?;
    let stopped_runtime = stop_runtime_for_update(&app).await?;
    let installed =
        match crate::update_handoff::verify_quiesced(&handoff, stopped_runtime.is_some()).await {
            Ok(()) => crate::update_handoff::accept(&mut handoff).await,
            Err(error) => Err(error),
        };
    if let Err(error) = installed {
        let cleanup = ryu_runtime_install::handoff::cancel_handoff(&handoff.request).err();
        if let Some(process) = stopped_runtime {
            if let Err(recovery) = restore_runtime_after_update_failure(&app, process).await {
                return Err(format!("{error}. {recovery}"));
            }
        }
        if let Some(cleanup) = cleanup {
            return Err(format!(
                "{error}. Could not release this update's startup fence: {cleanup:#}"
            ));
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

#[cfg(test)]
mod tests {
    use std::io;

    use base64::Engine as _;

    use super::{
        download_preference, install_then_clear, is_prepared_newer, prepared_metadata_matches_feed,
        verify_minisign, AppUpdateSource, PreparedUpdateCandidate, PreparedUpdateStore,
    };

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    fn encoded(value: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(value)
    }

    fn candidate(version: &str) -> PreparedUpdateCandidate {
        PreparedUpdateCandidate {
            signature: encoded(SIGNATURE),
            source: AppUpdateSource::Stable,
            version: version.to_string(),
        }
    }

    #[test]
    fn packaged_distribution_routes_every_source_without_changing_validation() {
        let base = "https://localhost:9443/releases";
        assert_eq!(
            AppUpdateSource::Stable.endpoint_with_base(base).unwrap(),
            format!("{base}/latest/download/latest.json")
        );
        for channel in ["beta", "nightly", "canary"] {
            let expected = if channel == "beta" {
                format!("{base}/latest/download/latest-beta.json")
            } else {
                format!("{base}/download/{channel}/latest-{channel}.json")
            };
            assert_eq!(
                AppUpdateSource::Channel {
                    channel: channel.into()
                }
                .endpoint_with_base(base)
                .unwrap(),
                expected
            );
        }
        assert_eq!(
            AppUpdateSource::Tag {
                tag: "v0.4.0".into(),
                channel: "stable".into()
            }
            .endpoint_with_base(base)
            .unwrap(),
            format!("{base}/download/v0.4.0/latest.json")
        );
        assert!(AppUpdateSource::Tag {
            tag: "../v0.4.0".into(),
            channel: "stable".into()
        }
        .endpoint_with_base(base)
        .is_err());
        for channel in ["nightly", "canary"] {
            let tag = format!("v0.4.1-{channel}.20260804.36");
            assert_eq!(
                AppUpdateSource::Tag {
                    tag: tag.clone(),
                    channel: channel.into()
                }
                .endpoint_with_base(base)
                .unwrap(),
                format!("{base}/download/{tag}/latest-{channel}.json")
            );
        }
    }

    #[test]
    fn bot_build_reads_its_own_feed_family() {
        let base = "https://github.com/amajorai/ryu/releases";
        let stem = crate::distribution::feed_stem("ai.amajor.ryu.bot");
        assert_eq!(
            AppUpdateSource::Stable
                .endpoint_for_product(base, stem)
                .unwrap(),
            format!("{base}/latest/download/latest-bot.json")
        );
        assert_eq!(
            AppUpdateSource::Channel {
                channel: "beta".into()
            }
            .endpoint_for_product(base, stem)
            .unwrap(),
            format!("{base}/latest/download/latest-bot-beta.json")
        );
        assert!(AppUpdateSource::Channel {
            channel: "nightly".into()
        }
        .endpoint_for_product(base, stem)
        .is_err());
        assert_eq!(
            AppUpdateSource::Tag {
                tag: "v0.4.0".into(),
                channel: "beta".into()
            }
            .endpoint_for_product(base, stem)
            .unwrap(),
            format!("{base}/download/v0.4.0/latest-bot-beta.json")
        );
        assert!(AppUpdateSource::Tag {
            tag: "v0.4.1-canary.1".into(),
            channel: "canary".into()
        }
        .endpoint_for_product(base, stem)
        .is_err());
        assert_eq!(
            crate::distribution::feed_stem("ai.amajor.ryu.desktop"),
            "latest"
        );
    }

    #[test]
    fn update_sources_only_resolve_app_owned_https_feeds() {
        let stable = AppUpdateSource::Stable.endpoint().expect("stable endpoint");
        assert_eq!(
            stable.as_str(),
            "https://github.com/amajorai/ryu/releases/latest/download/latest.json"
        );

        let nightly = AppUpdateSource::Channel {
            channel: "nightly".to_string(),
        }
        .endpoint()
        .expect("nightly endpoint");
        assert_eq!(
            nightly.as_str(),
            "https://github.com/amajorai/ryu/releases/download/nightly/latest-nightly.json"
        );

        let pinned = AppUpdateSource::Tag {
            tag: "v0.2.1".to_string(),
            channel: "stable".to_string(),
        }
        .endpoint()
        .expect("pinned endpoint");
        assert_eq!(
            pinned.as_str(),
            "https://github.com/amajorai/ryu/releases/download/v0.2.1/latest.json"
        );
    }

    #[test]
    fn update_sources_reject_path_traversal_and_unknown_channels() {
        let traversal = AppUpdateSource::Tag {
            tag: "../v0.2.1".to_string(),
            channel: "stable".to_string(),
        };
        assert!(traversal.endpoint().is_err());

        let unknown = AppUpdateSource::Channel {
            channel: "preview".to_string(),
        };
        assert!(unknown.endpoint().is_err());

        let injected = AppUpdateSource::Tag {
            tag: "v0.2.1".to_string(),
            channel: "stable/../../nightly".to_string(),
        };
        assert!(injected.endpoint().is_err());
    }

    #[test]
    fn minisign_verification_accepts_the_signed_bytes_and_rejects_tampering() {
        let public_key = encoded(PUBLIC_KEY);
        let signature = encoded(SIGNATURE);
        assert!(verify_minisign(b"test", &signature, &public_key).is_ok());
        assert!(verify_minisign(b"Test", &signature, &public_key).is_err());
    }

    #[test]
    fn prepared_store_commits_the_manifest_last_and_preserves_the_previous_record() {
        let root = tempfile::tempdir().expect("temporary cache");
        let store = PreparedUpdateStore::new(root.path().to_path_buf());
        store
            .commit(candidate("0.2.1"), b"old artifact")
            .expect("first prepared update");

        let failed = store.commit_with_manifest_writer(
            candidate("0.2.2"),
            b"new artifact",
            |_directory, _manifest| Err(io::Error::other("simulated manifest failure")),
        );
        assert!(failed.is_err());

        let prepared = store.read().expect("read cache").expect("prepared update");
        assert_eq!(prepared.version, "0.2.1");
        assert_eq!(
            store.artifact_bytes(&prepared).expect("old artifact"),
            b"old artifact"
        );
    }

    #[test]
    fn prepared_store_keeps_only_the_committed_artifact() {
        let root = tempfile::tempdir().expect("temporary cache");
        let store = PreparedUpdateStore::new(root.path().to_path_buf());
        store
            .commit(candidate("0.2.1"), b"old artifact")
            .expect("first prepared update");
        let current = store
            .commit(candidate("0.2.2"), b"new artifact")
            .expect("replacement prepared update");

        let entries = std::fs::read_dir(root.path())
            .expect("list cache")
            .collect::<Result<Vec<_>, _>>()
            .expect("cache entries");
        assert_eq!(entries.len(), 2, "manifest plus one artifact");
        assert_eq!(
            store.artifact_bytes(&current).expect("new artifact"),
            b"new artifact"
        );
    }

    #[test]
    fn automatic_download_defaults_on_and_only_an_explicit_false_disables_it() {
        assert!(download_preference(None));
        assert!(download_preference(Some(&serde_json::json!("invalid"))));
        assert!(download_preference(Some(&serde_json::json!(true))));
        assert!(!download_preference(Some(&serde_json::json!(false))));
    }

    #[test]
    fn runtime_gate_reopens_on_failure_and_stays_closed_until_successful_relaunch() {
        assert!(!super::runtime_update_in_progress());
        {
            let _guard = super::RuntimeUpdateGuard::enter().unwrap();
            assert!(super::runtime_update_in_progress());
            assert!(super::RuntimeUpdateGuard::enter().is_err());
        }
        assert!(!super::runtime_update_in_progress());
        let mut guard = super::RuntimeUpdateGuard::enter().unwrap();
        guard.wait_for_relaunch();
        drop(guard);
        assert!(super::runtime_update_in_progress());
        super::RUNTIME_UPDATE_IN_PROGRESS.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    #[test]
    fn prepared_version_must_be_strictly_newer_than_the_running_app() {
        assert!(is_prepared_newer("0.2.1", "0.2.0"));
        assert!(!is_prepared_newer("0.2.1", "0.2.1"));
        assert!(!is_prepared_newer("0.2.0", "0.2.1"));
        assert!(!is_prepared_newer("not-semver", "0.2.0"));
    }

    #[test]
    fn prepared_metadata_must_match_the_current_signed_feed() {
        assert!(prepared_metadata_matches_feed(
            "0.2.1",
            "signature-a",
            "0.2.1",
            "signature-a"
        ));
        assert!(!prepared_metadata_matches_feed(
            "0.2.2",
            "signature-a",
            "0.2.1",
            "signature-a"
        ));
        assert!(!prepared_metadata_matches_feed(
            "0.2.1",
            "signature-a",
            "0.2.1",
            "signature-b"
        ));
        assert!(!prepared_metadata_matches_feed(
            "not-semver",
            "signature-a",
            "also-invalid",
            "signature-a"
        ));
    }

    #[test]
    fn prepared_store_rejects_bytes_changed_after_commit() {
        let root = tempfile::tempdir().expect("temporary cache");
        let store = PreparedUpdateStore::new(root.path().to_path_buf());
        let prepared = store
            .commit(candidate("0.2.1"), b"test")
            .expect("prepared update");
        assert!(store
            .verified_artifact(&prepared, &encoded(PUBLIC_KEY))
            .is_ok());

        std::fs::write(root.path().join(&prepared.artifact_file), b"Test")
            .expect("tamper artifact");
        assert!(store
            .verified_artifact(&prepared, &encoded(PUBLIC_KEY))
            .is_err());
    }

    #[test]
    fn clearing_a_prepared_update_removes_manifest_and_artifacts() {
        let root = tempfile::tempdir().expect("temporary cache");
        let store = PreparedUpdateStore::new(root.path().to_path_buf());
        store
            .commit(candidate("0.2.1"), b"test")
            .expect("prepared update");

        store.clear().expect("clear cache");

        assert!(store.read().expect("read cache").is_none());
        assert_eq!(
            std::fs::read_dir(root.path()).expect("list cache").count(),
            0
        );
    }

    #[test]
    fn failed_install_keeps_the_verified_download_available_for_retry() {
        let root = tempfile::tempdir().expect("temporary cache");
        let store = PreparedUpdateStore::new(root.path().to_path_buf());
        let prepared = store
            .commit(candidate("0.2.1"), b"test")
            .expect("prepared update");

        let error = install_then_clear(&store, || Err("simulated install failure".to_string()))
            .expect_err("install must fail");

        assert_eq!(error, "simulated install failure");
        assert_eq!(
            store.read().expect("read cache after failure"),
            Some(prepared)
        );
    }

    #[test]
    fn successful_install_clears_the_prepared_download() {
        let root = tempfile::tempdir().expect("temporary cache");
        let store = PreparedUpdateStore::new(root.path().to_path_buf());
        store
            .commit(candidate("0.2.1"), b"test")
            .expect("prepared update");

        install_then_clear(&store, || Ok(())).expect("install and clear");

        assert!(store.read().expect("read cache after install").is_none());
    }
}
