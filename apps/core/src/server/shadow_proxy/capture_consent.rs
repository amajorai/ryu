//! Core-owned record of the user's capture consent for Shadow.
//!
//! Shadow opens a capture device only for a kind this record turns on
//! (`apps/shadow/src/capture_engine/consent.rs` reads it at start). There are
//! four kinds, one consent each: `screen`, `microphone`, `input` (keyboard and
//! mouse) and `activity`. Core is the only writer. A missing record means
//! nothing was decided, and a record that cannot be read turns every kind off.
//!
//! A change takes effect at the device level at once: when Shadow is running
//! Core restarts it, and a Shadow that cannot be restarted is stopped. Saving
//! never starts a stopped Shadow. Turning a kind on is accepted only from this
//! device; turning a kind off is accepted from any authenticated caller.

use std::collections::BTreeMap;
use std::path::Path;

use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

const RECORD_FILE: &str = "capture-consent.json";
const RECORD_VERSION: u32 = 1;
const KINDS: [&str; 4] = ["screen", "microphone", "input", "activity"];
/// A headless node turns kinds on with a comma separated list in one of these.
const KINDS_ENV: [&str; 2] = ["SHADOW_CAPTURE_KINDS", "RYU_SHADOW_CAPTURE_KINDS"];
const MAX_REQUEST_BYTES: usize = 4 * 1024;
const MAX_FILE_BYTES: u64 = 64 * 1024;
const SHADOW: &str = "shadow";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Decision {
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    decided_at: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct RecordFile {
    version: u32,
    #[serde(default)]
    kinds: BTreeMap<String, Decision>,
}

/// What the record on disk says.
#[derive(Debug, PartialEq, Eq)]
enum Stored {
    Missing,
    Unusable,
    Decided(BTreeMap<String, Decision>),
}

impl Stored {
    fn state(&self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Unusable => "unusable",
            Self::Decided(_) => "ok",
        }
    }

    fn decision(&self, kind: &str) -> Option<&Decision> {
        match self {
            Self::Decided(kinds) => kinds.get(kind),
            Self::Missing | Self::Unusable => None,
        }
    }
}

fn record_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(RECORD_FILE)
}

fn read_record(path: &Path) -> Stored {
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Stored::Missing,
        Err(_) => return Stored::Unusable,
        Ok(meta) if !meta.is_file() || meta.len() > MAX_FILE_BYTES => return Stored::Unusable,
        Ok(_) => {}
    }
    let Ok(bytes) = std::fs::read(path) else {
        return Stored::Unusable;
    };
    match serde_json::from_slice::<RecordFile>(&bytes) {
        Ok(file) if file.version == RECORD_VERSION => Stored::Decided(file.kinds),
        Ok(_) | Err(_) => Stored::Unusable,
    }
}

fn write_record(data_dir: &Path, kinds: &BTreeMap<String, Decision>) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = record_path(data_dir);
    let temp = data_dir.join(format!(
        "capture-consent.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let file = RecordFile {
            version: RECORD_VERSION,
            kinds: kinds.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(std::io::Error::other)?;
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

/// The kinds the environment list names, in [`KINDS`] order.
fn configured_kinds(env: impl Fn(&str) -> Option<String>) -> [bool; 4] {
    let list = KINDS_ENV
        .iter()
        .filter_map(|name| env(*name))
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default();
    let mut configured = [false; 4];
    for name in list.split(',') {
        if let Some(index) = KINDS
            .iter()
            .position(|kind| kind.eq_ignore_ascii_case(name.trim()))
        {
            configured[index] = true;
        }
    }
    configured
}

/// Whether `kind` captures: a decision in the record wins, the environment list
/// applies only to a kind with no decision, and an unusable record is all off.
fn effective(stored: &Stored, configured: bool, kind: &str) -> bool {
    match stored {
        Stored::Unusable => false,
        Stored::Missing | Stored::Decided(_) => stored
            .decision(kind)
            .map_or(configured, |decision| decision.enabled),
    }
}

fn storage_json(data_dir: &Path) -> serde_json::Value {
    let shown = |parts: &[&str]| {
        parts
            .iter()
            .fold(data_dir.to_path_buf(), |dir, part| dir.join(part))
            .display()
            .to_string()
    };
    json!({
        "dataDir": data_dir.display().to_string(),
        "screen": [shown(&["media", "video"]), shown(&["media", "keyframes"]), shown(&["events"])],
        "microphone": [shown(&["media", "audio"])],
        "input": [shown(&["events"])],
        "activity": [shown(&["events"])],
    })
}

fn response_json(
    stored: &Stored,
    configured: [bool; 4],
    data_dir: &Path,
    shadow_running: bool,
    applied: Option<Applied>,
) -> serde_json::Value {
    let mut kinds = serde_json::Map::new();
    for (index, kind) in KINDS.iter().enumerate() {
        let decision = stored.decision(kind);
        kinds.insert(
            (*kind).to_owned(),
            json!({
                "enabled": effective(stored, configured[index], kind),
                "decided": decision.is_some(),
                "decidedAt": decision.and_then(|decision| decision.decided_at.clone()),
                "configured": configured[index],
            }),
        );
    }
    let mut body = json!({
        "version": RECORD_VERSION,
        "recordState": stored.state(),
        "kinds": kinds,
        "storage": storage_json(data_dir),
        "shadowRunning": shadow_running,
    });
    if let Some(applied) = applied {
        body["applied"] = json!(applied.as_str());
    }
    body
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    kind: String,
    enabled: bool,
}

/// Only a caller on this device may turn a kind on. Anyone who may call the
/// route may turn a kind off.
fn change_allowed(enabled: bool, peer_is_local: bool) -> bool {
    !enabled || peer_is_local
}

/// The record after `update`, stamped with `now`.
fn updated(
    stored: Stored,
    update: &Update,
    now: &str,
) -> Result<BTreeMap<String, Decision>, &'static str> {
    if !KINDS.contains(&update.kind.as_str()) {
        return Err("kind must be screen, microphone, input or activity");
    }
    let decision = |enabled: bool| Decision {
        enabled,
        decided_at: Some(now.to_owned()),
    };
    let mut kinds = match stored {
        Stored::Decided(kinds) => kinds,
        Stored::Missing => BTreeMap::new(),
        // Everything was off under the unusable record. Record that, so the
        // environment list cannot turn the other kinds on as a side effect.
        Stored::Unusable => KINDS
            .iter()
            .map(|kind| ((*kind).to_owned(), decision(false)))
            .collect(),
    };
    kinds.insert(update.kind.clone(), decision(update.enabled));
    Ok(kinds)
}

/// The running Shadow, as far as a consent change needs it.
#[async_trait::async_trait]
trait ShadowControl: Sync {
    fn is_running(&self) -> bool;
    async fn restart(&self) -> anyhow::Result<()>;
    async fn stop(&self) -> anyhow::Result<()>;
}

struct ManagedShadow<'a>(&'a super::ServerState);

#[async_trait::async_trait]
impl ShadowControl for ManagedShadow<'_> {
    fn is_running(&self) -> bool {
        self.0.manager.is_sidecar_running(SHADOW)
    }

    async fn restart(&self) -> anyhow::Result<()> {
        self.0.manager.restart_sidecar(SHADOW).await
    }

    async fn stop(&self) -> anyhow::Result<()> {
        self.0.manager.stop_sidecar(SHADOW).await
    }
}

/// How a saved change reached the running Shadow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Applied {
    /// Shadow is not running: nothing captures, the record applies at its next start.
    NotRunning,
    /// Shadow restarted and read the new record.
    Restarted,
    /// Shadow could not restart, so it was stopped: nothing captures.
    Stopped,
    /// Shadow could neither restart nor stop. It still runs with the old record.
    Failed,
}

impl Applied {
    fn as_str(self) -> &'static str {
        match self {
            Self::NotRunning => "not_running",
            Self::Restarted => "restarted",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
        }
    }
}

/// Make a running Shadow read the new record. Never starts a stopped Shadow.
async fn apply(shadow: &dyn ShadowControl) -> Applied {
    if !shadow.is_running() {
        return Applied::NotRunning;
    }
    let error = match shadow.restart().await {
        Ok(()) => return Applied::Restarted,
        Err(error) => error,
    };
    tracing::warn!("Shadow did not restart after a capture consent change: {error:#}");
    // It must not keep capturing with the old consent.
    match shadow.stop().await {
        Ok(()) if !shadow.is_running() => Applied::Stopped,
        Ok(()) => Applied::Failed,
        Err(error) => {
            tracing::error!("Shadow did not stop after a capture consent change: {error:#}");
            Applied::Failed
        }
    }
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn get(shadow: &dyn ShadowControl) -> Response {
    let data_dir = crate::sidecar::tools::shadow::data_dir();
    let stored = read_record(&record_path(&data_dir));
    Json(response_json(
        &stored,
        configured_kinds(env_var),
        &data_dir,
        shadow.is_running(),
        None,
    ))
    .into_response()
}

async fn post(shadow: &dyn ShadowControl, request: Request) -> Response {
    let peer_is_local = crate::server::request_peer_is_local(&request);
    let Ok(bytes) = axum::body::to_bytes(request.into_body(), MAX_REQUEST_BYTES).await else {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "capture_consent_too_large",
            "capture consent body is too large",
        );
    };
    let Ok(update) = serde_json::from_slice::<Update>(&bytes) else {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_capture_consent",
            "capture consent needs a kind and an enabled flag",
        );
    };
    if !change_allowed(update.enabled, peer_is_local) {
        return error_response(
            StatusCode::FORBIDDEN,
            "capture_consent_local_only",
            "a capture kind can only be turned on from the device it captures",
        );
    }
    let data_dir = crate::sidecar::tools::shadow::data_dir();
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let kinds = match updated(read_record(&record_path(&data_dir)), &update, &now) {
        Ok(kinds) => kinds,
        Err(message) => {
            return error_response(StatusCode::BAD_REQUEST, "invalid_capture_consent", message);
        }
    };
    if let Err(error) = write_record(&data_dir, &kinds) {
        tracing::error!("could not save the capture consent record: {error}");
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "capture_consent_save_failed",
            "could not save capture consent",
        );
    }
    tracing::info!(
        kind = update.kind.as_str(),
        enabled = update.enabled,
        "capture consent changed"
    );
    let applied = apply(shadow).await;
    Json(response_json(
        &Stored::Decided(kinds),
        configured_kinds(env_var),
        &data_dir,
        shadow.is_running(),
        Some(applied),
    ))
    .into_response()
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

pub(super) async fn handle(state: &super::ServerState, request: Request) -> Response {
    let shadow = ManagedShadow(state);
    match request.method().clone() {
        Method::GET => get(&shadow),
        Method::POST => post(&shadow, request).await,
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests;
