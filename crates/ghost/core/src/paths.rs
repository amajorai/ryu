//! Where Ghost keeps its state.
//!
//! Ghost is a first-party Ryu service, so everything it persists lives in the
//! Ryu data dir (`RYU_DIR`, the Storage pointer, or the profile default — see
//! `ryu_sidecar_runtime::ryu_dir`):
//!
//! - `services/ghost/` — pid file, working dir, `recipes/`, `snapshots/`;
//! - `models/vision/ghost/` — the ShowUI-2B vision model.
//!
//! Core exports `GHOST_DATA_DIR` / `GHOST_MODELS_DIR` when it spawns Ghost, so
//! a standalone run and a Core-managed run resolve the same folders.

use std::path::PathBuf;

use ryu_sidecar_runtime::layout;

/// Env override for Ghost's data dir (Core sets it to `services/ghost`).
pub const DATA_DIR_ENV: &str = "GHOST_DATA_DIR";
/// Env override for Ghost's model dir (Core sets it to `models/vision/ghost`).
pub const MODELS_DIR_ENV: &str = "GHOST_MODELS_DIR";
/// File name of the ShowUI-2B ONNX model inside [`models_dir`].
pub const SHOWUI_MODEL_FILE: &str = "showui-2b.onnx";

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// `<data dir>/services/ghost`, or `GHOST_DATA_DIR` when set.
#[must_use]
pub fn data_dir() -> PathBuf {
    env_dir(DATA_DIR_ENV)
        .unwrap_or_else(|| layout::service_dir(&ryu_sidecar_runtime::ryu_dir(), "ghost"))
}

/// `<data dir>/models/vision/ghost`, or `GHOST_MODELS_DIR` when set.
#[must_use]
pub fn models_dir() -> PathBuf {
    env_dir(MODELS_DIR_ENV).unwrap_or_else(|| {
        layout::model_family_dir(
            &ryu_sidecar_runtime::ryu_dir(),
            layout::Modality::Vision,
            "ghost",
        )
    })
}

/// The ShowUI-2B model path inside [`models_dir`].
#[must_use]
pub fn showui_model_path() -> PathBuf {
    models_dir().join(SHOWUI_MODEL_FILE)
}

/// `<ghost data dir>/recipes`.
#[must_use]
pub fn recipes_dir() -> PathBuf {
    data_dir().join("recipes")
}

/// `<ghost data dir>/snapshots`.
#[must_use]
pub fn snapshots_dir() -> PathBuf {
    data_dir().join("snapshots")
}
