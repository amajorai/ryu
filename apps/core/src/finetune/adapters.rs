//! Trained-output (adapter) catalog (`~/.ryu/installed-adapters.json`).
//!
//! Mirrors [`crate::model_catalog::installed`] but for LoRA adapters produced by
//! fine-tune jobs. An adapter is a directory under `~/.ryu/models/<stem>/`
//! (`adapter_config.json` + `adapter_model.safetensors`); this index records its
//! provenance (base model, the job that produced it) so the desktop can list and
//! merge it. Recording is idempotent on `stem`; the loader drops records whose
//! directory was deleted out-of-band so the catalog never shows a phantom.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// One installed adapter as Core records it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledAdapter {
    /// Local key — the directory name under `~/.ryu/models/<stem>/`.
    pub stem: String,
    /// HF repo id of the base model this adapter was tuned from.
    pub base_model: String,
    /// The fine-tune job that produced it.
    pub job_id: String,
    /// Absolute on-disk path of the adapter directory.
    pub path: String,
    pub created_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AdaptersFile {
    /// Keyed by `stem` so re-recording the same output is idempotent.
    #[serde(default)]
    adapters: HashMap<String, InstalledAdapter>,
}

// Serializes concurrent read-modify-write of the JSON store.
static LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> PathBuf {
    crate::paths::ryu_dir().join("installed-adapters.json")
}

/// Record a freshly-produced adapter. Idempotent on `stem`. Atomic (tmp+rename).
pub fn record(adapter: InstalledAdapter) -> Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = store_path();
    let mut file: AdaptersFile = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    file.adapters.insert(adapter.stem.clone(), adapter);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&file)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Load every recorded adapter whose directory still exists on disk.
pub fn load_present() -> Vec<InstalledAdapter> {
    let raw = match std::fs::read_to_string(store_path()) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let parsed: AdaptersFile = serde_json::from_str(&raw).unwrap_or_default();
    parsed
        .adapters
        .into_values()
        .filter(|a| PathBuf::from(&a.path).exists())
        .collect()
}
