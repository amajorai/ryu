//! Core-owned persistence for Shadow's non-secret computer-use settings.
//!
//! Saving must not start Shadow: starting it also starts capture. Core stores
//! the config under the same data directory Shadow reads at startup, then
//! applies it over the authenticated sidecar API only when that process is live.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;

mod endpoint;
use endpoint::{is_loopback_base_url, is_loopback_host, validate_endpoint};

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_COMPUTER_USE_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024;
const SETTINGS_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Planner {
    Native,
    Jev,
    Local,
    Laya,
}

impl Default for Planner {
    fn default() -> Self {
        Self::Native
    }
}

/// camelCase is canonical on disk and on the HTTP response. Snake-case aliases
/// read files written by the first Shadow computer-use settings implementation.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    planner: Planner,
    #[serde(default = "default_jev_url", alias = "jev_url")]
    jev_url: String,
    #[serde(default = "default_jev_model", alias = "jev_model")]
    jev_model: String,
    #[serde(default = "default_laya_url", alias = "laya_url")]
    laya_url: String,
    #[serde(default, alias = "local_plugin_id")]
    local_plugin_id: String,
    #[serde(default, alias = "local_model_id")]
    local_model_id: String,
    #[serde(default = "default_max_steps", alias = "max_steps")]
    max_steps: u8,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            planner: Planner::default(),
            jev_url: default_jev_url(),
            jev_model: default_jev_model(),
            laya_url: default_laya_url(),
            local_plugin_id: String::new(),
            local_model_id: String::new(),
            max_steps: default_max_steps(),
        }
    }
}

impl Settings {
    fn validate(&self) -> Result<(), &'static str> {
        if self.version != SETTINGS_VERSION {
            return Err("unsupported computer-use settings version");
        }
        validate_endpoint(&self.jev_url, false)?;
        validate_endpoint(&self.laya_url, true)?;
        if self.jev_model.trim().is_empty() || self.jev_model.len() > 128 {
            return Err("jevModel must be 1..=128 characters");
        }
        if matches!(self.planner, Planner::Local) {
            crate::plugin_manifest::validate_plugin_id(&self.local_plugin_id)
                .map_err(|_| "localPluginId must be a valid Ryu plugin id")?;
            if self.local_model_id.trim().is_empty()
                || self.local_model_id.len() > 256
                || self.local_model_id.chars().any(char::is_control)
            {
                return Err("localModelId must be 1..=256 printable characters");
            }
        }
        if !(1..=20).contains(&self.max_steps) {
            return Err("maxSteps must be between 1 and 20");
        }
        Ok(())
    }

    fn sidecar_update(&self) -> serde_json::Value {
        json!({
            "planner": self.planner,
            "jevUrl": self.jev_url,
            "jevModel": self.jev_model,
            "layaUrl": self.laya_url,
            "localPluginId": self.local_plugin_id,
            "localModelId": self.local_model_id,
            "maxSteps": self.max_steps,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsUpdate {
    planner: Planner,
    jev_url: String,
    jev_model: String,
    laya_url: String,
    #[serde(default)]
    local_plugin_id: String,
    #[serde(default)]
    local_model_id: String,
    max_steps: u8,
}

impl From<SettingsUpdate> for Settings {
    fn from(update: SettingsUpdate) -> Self {
        Self {
            version: SETTINGS_VERSION,
            planner: update.planner,
            jev_url: update.jev_url,
            jev_model: update.jev_model,
            laya_url: update.laya_url,
            local_plugin_id: update.local_plugin_id,
            local_model_id: update.local_model_id,
            max_steps: update.max_steps,
        }
    }
}

fn default_version() -> u32 {
    SETTINGS_VERSION
}

// The Jev and Laya endpoints are user settings persisted in `computer-use.json`;
// these are only the values a fresh install starts from.
fn default_jev_url() -> String {
    "https://api.typesafe.ai/v1/systemone".to_owned()
}

fn default_jev_model() -> String {
    "jev-latest".to_owned()
}

fn default_laya_url() -> String {
    let core_url = std::env::var("RYU_CORE_URL")
        .ok()
        .filter(|url| is_loopback_base_url(url))
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::profile::port(7980)));
    format!(
        "{}/api/ext/@ryu/laya/predict",
        core_url.trim_end_matches('/')
    )
}

fn default_max_steps() -> u8 {
    12
}

fn settings_path() -> std::path::PathBuf {
    crate::sidecar::tools::shadow::data_dir().join("computer-use.json")
}

fn read_settings(path: &Path) -> std::io::Result<Settings> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Settings::default());
        }
        Err(error) => return Err(error),
    };
    if bytes.len() as u64 > MAX_FILE_BYTES {
        tracing::warn!("ignoring oversized Shadow computer-use settings");
        return Ok(Settings::default());
    }
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(settings) if settings.validate().is_ok() => Ok(settings),
        Ok(_) | Err(_) => {
            tracing::warn!("ignoring invalid Shadow computer-use settings");
            Ok(Settings::default())
        }
    }
}

fn write_settings(data_dir: &Path, settings: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join("computer-use.json");
    let temp = data_dir.join(format!(
        "computer-use.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let bytes = serde_json::to_vec_pretty(settings).map_err(std::io::Error::other)?;
        std::fs::write(&temp, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&temp, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn local_shadow_url(path: &str) -> Option<url::Url> {
    let mut url = url::Url::parse(&crate::sidecar::tools::shadow::base_url()).ok()?;
    if !is_loopback_host(url.host_str().unwrap_or_default())
        || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    url.set_path(path);
    Some(url)
}

fn response_json(settings: &Settings, key_configured: bool, applied: bool) -> serde_json::Value {
    json!({
        "planner": settings.planner,
        "jevUrl": settings.jev_url,
        "jevModel": settings.jev_model,
        "layaUrl": settings.laya_url,
        "localPluginId": settings.local_plugin_id,
        "localModelId": settings.local_model_id,
        "maxSteps": settings.max_steps,
        "jevApiKeyConfigured": key_configured,
        "applied": applied,
    })
}

async fn jev_key_configured() -> bool {
    if std::env::var("SHADOW_JEV_API_KEY")
        .ok()
        .is_some_and(|key| !key.trim().is_empty())
    {
        return true;
    }
    let Some(secrets) = crate::plugin_secrets::global() else {
        return false;
    };
    match secrets.get("@ryu/shadow", "SHADOW_JEV_API_KEY").await {
        Ok(Some(key)) => !key.trim().is_empty(),
        Ok(None) => false,
        Err(error) => {
            tracing::warn!("Shadow Jev credential status unavailable: {error:#}");
            false
        }
    }
}

async fn shadow_settings_applied(settings: &Settings) -> bool {
    let Some(url) = local_shadow_url("computer-use/config") else {
        return false;
    };
    let Some(token) = crate::sidecar::tools::shadow::verified_api_token().await else {
        return false;
    };
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(350))
        .timeout(std::time::Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    let Ok(mut response) = client.get(url).bearer_auth(token).send().await else {
        return false;
    };
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > MAX_COMPUTER_USE_RESPONSE_BYTES as u64)
    {
        return false;
    }
    let mut bytes = Vec::new();
    loop {
        let Ok(chunk) = response.chunk().await else {
            return false;
        };
        let Some(chunk) = chunk else {
            break;
        };
        if bytes.len() + chunk.len() > MAX_COMPUTER_USE_RESPONSE_BYTES {
            return false;
        }
        bytes.extend_from_slice(&chunk);
    }
    let Ok(live) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    let Ok(planner) = serde_json::to_value(settings.planner) else {
        return false;
    };
    live.get("planner") == Some(&planner)
        && live.get("jevUrl") == Some(&json!(settings.jev_url))
        && live.get("jevModel") == Some(&json!(settings.jev_model))
        && live.get("layaUrl") == Some(&json!(settings.laya_url))
        && live.get("localPluginId") == Some(&json!(settings.local_plugin_id))
        && live.get("localModelId") == Some(&json!(settings.local_model_id))
        && live.get("maxSteps") == Some(&json!(settings.max_steps))
}

async fn validate_local_model_selection(
    state: &super::ServerState,
    settings: &Settings,
) -> Result<(), String> {
    if !matches!(settings.planner, Planner::Local) {
        return Ok(());
    }
    let advertised = {
        let manifests = state.app_manifests.read().await;
        manifests
            .iter()
            .find(|manifest| manifest.id == settings.local_plugin_id)
            .and_then(|manifest| manifest.contributes.as_ref())
            .is_some_and(|contributes| {
                contributes
                    .computer_use_planners
                    .iter()
                    .any(|planner| planner.model_id == settings.local_model_id)
            })
    };
    if !advertised {
        return Err("the selected model is not advertised by the selected Ryu plugin".to_owned());
    }
    let records = state
        .app_store
        .list()
        .await
        .map_err(|_| "could not verify the selected local model plugin".to_owned())?;
    if !records
        .iter()
        .any(|record| record.id == settings.local_plugin_id && record.enabled)
    {
        return Err("enable the selected local model plugin before choosing it".to_owned());
    }
    Ok(())
}

async fn get() -> Response {
    let settings = match read_settings(&settings_path()) {
        Ok(settings) => settings,
        Err(error) => {
            tracing::error!("could not read Shadow computer-use settings: {error}");
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "computer_use_settings_read_failed",
                "could not read computer-use settings",
            );
        }
    };
    if let Err(message) = settings.validate() {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid_computer_use_settings",
            message,
        );
    }
    let key_configured = jev_key_configured().await;
    let applied = shadow_settings_applied(&settings).await;
    Json(response_json(&settings, key_configured, applied)).into_response()
}

async fn post(state: &super::ServerState, body: Body) -> Response {
    let bytes = match axum::body::to_bytes(body, MAX_REQUEST_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "computer_use_settings_too_large",
                "computer-use settings body is too large",
            );
        }
    };
    let update = match serde_json::from_slice::<SettingsUpdate>(&bytes) {
        Ok(update) => update,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_computer_use_config",
                "computer-use settings have an invalid shape",
            );
        }
    };
    let settings = Settings::from(update);
    if let Err(message) = settings.validate() {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_computer_use_config",
            message,
        );
    }
    if let Err(message) = validate_local_model_selection(state, &settings).await {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_computer_use_config",
            &message,
        );
    }
    let data_dir = crate::sidecar::tools::shadow::data_dir();
    if let Err(error) = write_settings(&data_dir, &settings) {
        tracing::error!("could not persist Shadow computer-use settings: {error}");
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "computer_use_settings_save_failed",
            "could not save computer-use settings",
        );
    }
    let applied = apply(&settings).await;
    let key_configured = jev_key_configured().await;
    Json(response_json(&settings, key_configured, applied)).into_response()
}

async fn apply(settings: &Settings) -> bool {
    let Some(url) = local_shadow_url("computer-use/config") else {
        return false;
    };
    let Some(token) = crate::sidecar::tools::shadow::verified_api_token().await else {
        return false;
    };
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(350))
        .timeout(std::time::Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    match client
        .post(url)
        .bearer_auth(token)
        .json(&settings.sidecar_update())
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            tracing::debug!(
                "Shadow computer-use settings saved but not applied (HTTP {})",
                response.status()
            );
            false
        }
        Err(error) => {
            tracing::debug!("Shadow computer-use settings saved for next start: {error}");
            false
        }
    }
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

pub(super) async fn handle(state: &super::ServerState, request: Request) -> Response {
    match request.method().clone() {
        Method::GET => get().await,
        Method::POST => {
            let (_, body) = request.into_parts();
            post(state, body).await
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests;
