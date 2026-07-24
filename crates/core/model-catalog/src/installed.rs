//! Tracks which catalog models the user has downloaded, so the catalog can show
//! an "Installed" badge and an installed-only filter without re-deriving the
//! mapping from bare filenames on disk.
//!
//! Backed by `~/.ryu/installed-models.json`. Each record links a downloaded GGUF
//! file (stored at `~/.ryu/models/<stem>.gguf` by the shared [`GgufDownloader`])
//! back to its Hugging Face repo id and original filename. The on-disk GGUF is
//! still the source of truth for "is it really there"; this index just records
//! provenance so the catalog UI can group files under their model card.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use ryu_model_format::{engines_for_format, ModelFormat};

/// One downloaded model's provenance record. A record is either a single GGUF
/// file (`format = Gguf`, lives at `~/.ryu/models/<stem>.gguf`) or a multi-file
/// repo snapshot (`format = Safetensors | Mlx`, lives in the directory
/// `~/.ryu/models/<stem>/`, where `stem` is the slugified repo id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledModel {
    /// Hugging Face repo id, e.g. `"unsloth/gemma-4-E2B-it-GGUF"`.
    pub repo_id: String,
    /// For GGUF: the original filename within the repo. For a snapshot: the repo
    /// id (there is no single file to name).
    pub filename: String,
    /// Local key. GGUF: file stem under `~/.ryu/models/<stem>.gguf`. Snapshot:
    /// the slugified repo id, used as the directory `~/.ryu/models/<stem>/`.
    pub stem: String,
    /// Size in bytes when known (summed across shards for a snapshot).
    pub size_bytes: Option<u64>,
    /// Weight format. Defaulted to GGUF so legacy records (written before this
    /// field existed) deserialize cleanly instead of vanishing — see the note
    /// on the lenient loader in [`load_present`]/[`record`].
    #[serde(default)]
    pub format: ModelFormat,
    /// For a GGUF vision model: the original filename of the multimodal
    /// projector (`mmproj-*.gguf`) auto-installed alongside the weights, stored
    /// on disk at [`mmproj_file_path`] (`~/.ryu/models/<stem>.mmproj.gguf`).
    /// `None` for text-only models. Informational/provenance only — the launch
    /// path resolves the adapter by the on-disk convention so a vision model
    /// loads its projector even when this field is absent (legacy records).
    #[serde(default)]
    pub mmproj: Option<String>,
    /// When this model was produced by merging a fine-tune adapter into a GGUF
    /// (the Unsloth path), the base model it was trained from (a HF repo id).
    /// `None` for ordinary catalog installs. Lets the catalog mark a model as
    /// "fine-tuned" and show its lineage without re-deriving it from job history.
    #[serde(default)]
    pub finetune_base: Option<String>,
}

/// A resolved active-model selection persisted in the preferences KV under
/// [`ACTIVE_MODEL_PREF`], JSON-encoded. Carries enough to (a) pick the engine
/// and (b) tell that engine which weights to serve.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveModel {
    /// Chosen local engine, e.g. `"llamacpp"` | `"vllm"`. Written from the
    /// `set_active_local_engine` result (never independently computed) so it
    /// cannot drift from the authoritative active-engine store.
    pub engine: String,
    /// Weight format of the selected model.
    pub format: ModelFormat,
    /// GGUF: the local stem (resolves to `~/.ryu/models/<stem>.gguf`).
    /// Snapshot: the HF repo id (the engine resolves it from
    /// `~/.ryu/models/<slug>/`).
    pub r#ref: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct InstalledModelsFile {
    /// Keyed by local stem so re-installing the same file is idempotent.
    #[serde(default)]
    models: HashMap<String, InstalledModel>,
}

/// Serializes writes to `installed-models.json` to avoid clobbering on
/// concurrent installs (mirrors the version store's lock discipline).
static LOCK: Mutex<()> = Mutex::new(());

fn store_path() -> PathBuf {
    crate::ryu_dir().join("installed-models.json")
}

fn models_dir() -> PathBuf {
    crate::ryu_dir().join("models")
}

/// Load every recorded install whose GGUF still exists on disk. Records whose
/// file was deleted out-of-band are silently dropped so the catalog never shows
/// a phantom "installed".
pub fn load_present() -> Vec<InstalledModel> {
    let raw = match std::fs::read_to_string(store_path()) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let parsed: InstalledModelsFile = serde_json::from_str(&raw).unwrap_or_default();
    parsed
        .models
        .into_values()
        .filter(|m| install_is_present(m))
        .collect()
}

/// Whether a record's weights are actually on disk: GGUF needs its single file;
/// a snapshot needs its directory to exist and be non-empty.
fn install_is_present(m: &InstalledModel) -> bool {
    match m.format {
        ModelFormat::Gguf => model_file_path(&m.stem).exists(),
        ModelFormat::Safetensors | ModelFormat::Mlx => {
            let dir = model_snapshot_dir(&m.stem);
            std::fs::read_dir(&dir)
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false)
        }
    }
}

/// Set of repo ids that have at least one installed file present on disk.
pub fn installed_repo_ids() -> std::collections::HashSet<String> {
    load_present().into_iter().map(|m| m.repo_id).collect()
}

/// Record a freshly downloaded model file. Idempotent on `stem`.
pub fn record(model: InstalledModel) -> anyhow::Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = store_path();
    let mut file: InstalledModelsFile = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    file.models.insert(model.stem.clone(), model);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&file)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Preferences-KV key holding the user-selected active local chat model. The
/// value is a JSON-encoded [`ActiveModel`] (`{engine, format, ref}`). For
/// backward-compat the reader also accepts a bare stem string (the legacy
/// format = GGUF) — see [`parse_active_pref`]. When set and the weights are
/// present on disk, the resolved engine serves the selection instead of the
/// registry default; this is how a deep link / "Use this model" action switches
/// the served model at runtime without recompiling or editing `registry.json`.
/// Empty or absent means "use the registry default" (nothing hardcoded, fully
/// swappable).
pub const ACTIVE_MODEL_PREF: &str = "local-chat-model";

/// Preferences-KV key holding the user-selected active diffusion model. The
/// value is the plain local stem of a GGUF diffusion file installed at
/// `~/.ryu/models/<stem>.gguf`. When set, `sd-server` is started with this
/// model instead of the default bundled one. Mirrors [`ACTIVE_MODEL_PREF`] for
/// the chat-engine swap but is independent of it — a diffusion model does not
/// enter the `LOCAL_ENGINES` swap pool (sd-server runs alongside a chat engine).
pub const ACTIVE_DIFFUSION_MODEL_PREF: &str = "local-diffusion-model";

/// Absolute path of an installed GGUF given its local stem
/// (`~/.ryu/models/<stem>.gguf`). Mirrors the layout the shared
/// `GgufDownloader` writes to.
pub fn model_file_path(stem: &str) -> PathBuf {
    models_dir().join(format!("{stem}.gguf"))
}

/// Absolute path of the multimodal projector ("vision adapter") that pairs with
/// the installed GGUF at this `stem` (`~/.ryu/models/<stem>.mmproj.gguf`). The
/// adapter is stored beside its model under a deterministic name so the launch
/// path can find it without consulting the provenance index — the binding is
/// the filename, not a JSON field. A text-only model simply has no file here.
pub fn mmproj_file_path(stem: &str) -> PathBuf {
    models_dir().join(format!("{stem}.mmproj.gguf"))
}

/// Absolute path of an installed repo snapshot's directory
/// (`~/.ryu/models/<slug>/`), where `slug` is the slugified repo id (also the
/// record's `stem`). vLLM/sglang/MLX engines serve weights from here.
pub fn model_snapshot_dir(slug: &str) -> PathBuf {
    models_dir().join(slug)
}

/// Turn an HF repo id (`owner/name`) into a filesystem-safe directory slug.
/// Keeps `[A-Za-z0-9._-]`; every other character (including `/`) becomes `_`.
pub fn slugify_repo(repo_id: &str) -> String {
    repo_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Parse the raw [`ACTIVE_MODEL_PREF`] value into a structured [`ActiveModel`].
/// Tries JSON first; on failure treats the raw value as a legacy bare GGUF stem
/// and synthesizes a GGUF selection whose engine is the first GGUF engine in the
/// capability table (data-driven, not hardcoded). Empty input yields `None`
/// (= use the registry default).
pub fn parse_active_pref(raw: &str) -> Option<ActiveModel> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<ActiveModel>(trimmed) {
        return Some(parsed);
    }
    // Legacy bare-stem fallback: GGUF, default engine = first GGUF engine.
    let engine = engines_for_format(ModelFormat::Gguf)
        .first()
        .copied()
        .unwrap_or("llamacpp")
        .to_string();
    Some(ActiveModel {
        engine,
        format: ModelFormat::Gguf,
        r#ref: trimmed.to_string(),
    })
}

/// Encode an [`ActiveModel`] for storage in [`ACTIVE_MODEL_PREF`].
pub fn encode_active_pref(active: &ActiveModel) -> String {
    serde_json::to_string(active).unwrap_or_else(|_| active.r#ref.clone())
}

/// Resolve an install identifier — either a local stem or a Hugging Face
/// `repo_id` (as carried by a `ryu://models/...` deep link) — to the local
/// stem of an installed file that is actually present on disk. Returns `None`
/// when nothing installed matches, so callers can refuse to "switch" to a model
/// the user never downloaded. When a repo has multiple installed quants, the
/// first present record wins.
pub fn resolve_to_stem(id: &str) -> Option<String> {
    let present = load_present();
    if present.iter().any(|m| m.stem == id) {
        return Some(id.to_string());
    }
    present
        .into_iter()
        .find(|m| m.repo_id == id)
        .map(|m| m.stem)
}

/// Resolve an install identifier — a local stem or a Hugging Face `repo_id` — to
/// the structured selection for an install that is actually present on disk.
/// Returns `None` when nothing installed matches (callers refuse to "switch" to
/// a model the user never downloaded). The returned [`ActiveModel`]'s `engine`
/// is left empty: the caller fills it from `pick_engine` /
/// `set_active_local_engine` so the engine record never drifts from the
/// authoritative active-engine store. `r#ref` is the stem for GGUF and the repo
/// id for a snapshot — what each engine needs to locate the weights.
pub fn resolve_active(id: &str) -> Option<ActiveModel> {
    let present = load_present();
    let found = present
        .iter()
        .find(|m| m.stem == id)
        .or_else(|| present.iter().find(|m| m.repo_id == id))?;
    let r#ref = match found.format {
        ModelFormat::Gguf => found.stem.clone(),
        ModelFormat::Safetensors | ModelFormat::Mlx => found.repo_id.clone(),
    };
    Some(ActiveModel {
        engine: String::new(),
        format: found.format,
        r#ref,
    })
}

/// Reverse of [`resolve_to_stem`]: the Hugging Face `repo_id` a present stem was
/// installed from, when known.
pub fn repo_for_stem(stem: &str) -> Option<String> {
    load_present()
        .into_iter()
        .find(|m| m.stem == stem)
        .map(|m| m.repo_id)
}

/// Drop a model's provenance record by local stem. Idempotent — a missing
/// record is a no-op success, so uninstalling a file with no recorded origin
/// (e.g. one dropped into the models dir by hand) still succeeds.
pub fn remove(stem: &str) -> anyhow::Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = store_path();
    let mut file: InstalledModelsFile = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if file.models.remove(stem).is_none() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&file)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_present_empty_when_no_file() {
        crate::ensure_test_host();
        // Even if a stray file exists in this dev env, the call must not panic.
        let _ = load_present();
        let _ = installed_repo_ids();
    }

    #[test]
    fn legacy_record_without_format_deserializes_to_gguf() {
        // Upgrade-safety: a record written before the `format` field existed must
        // deserialize cleanly (defaulting to GGUF), not error — otherwise the
        // lenient loader would drop every install and reset the active selection.
        let legacy = r#"{
            "repo_id": "unsloth/gemma-4-E2B-it-GGUF",
            "filename": "gemma-4-E2B-it-Q4_K_M.gguf",
            "stem": "gemma-4-E2B-it-Q4_K_M",
            "size_bytes": 123
        }"#;
        let parsed: InstalledModel = serde_json::from_str(legacy).expect("legacy record parses");
        assert_eq!(parsed.format, ModelFormat::Gguf);
        assert_eq!(parsed.stem, "gemma-4-E2B-it-Q4_K_M");
    }

    #[test]
    fn active_pref_json_and_legacy_stem_both_parse() {
        // Structured JSON round-trips.
        let active = ActiveModel {
            engine: "vllm".to_string(),
            format: ModelFormat::Safetensors,
            r#ref: "org/repo".to_string(),
        };
        let encoded = encode_active_pref(&active);
        let back = parse_active_pref(&encoded).expect("json parses");
        assert_eq!(back.engine, "vllm");
        assert_eq!(back.format, ModelFormat::Safetensors);
        assert_eq!(back.r#ref, "org/repo");

        // A legacy bare stem is treated as a GGUF selection.
        let legacy = parse_active_pref("my-model-Q4_K_M").expect("legacy stem parses");
        assert_eq!(legacy.format, ModelFormat::Gguf);
        assert_eq!(legacy.r#ref, "my-model-Q4_K_M");

        // Empty/whitespace clears the selection.
        assert!(parse_active_pref("   ").is_none());
    }

    #[test]
    fn slugify_repo_replaces_unsafe_chars() {
        assert_eq!(slugify_repo("acme/My.Model-1_x"), "acme_My.Model-1_x");
        assert_eq!(slugify_repo("a b/c:d"), "a_b_c_d");
    }

    #[test]
    fn record_load_resolve_remove_roundtrip() {
        crate::ensure_test_host();
        let stem = "inst-test-gguf-unique-b1";
        let path = model_file_path(stem);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"gguf-bytes").unwrap();
        record(InstalledModel {
            repo_id: "acme/inst-test-b1".into(),
            filename: format!("{stem}.gguf"),
            stem: stem.into(),
            size_bytes: Some(10),
            format: ModelFormat::Gguf,
            mmproj: None,
            finetune_base: None,
        })
        .unwrap();

        // Present on disk → appears in load_present + installed_repo_ids.
        assert!(load_present().iter().any(|m| m.stem == stem));
        assert!(installed_repo_ids().contains("acme/inst-test-b1"));

        // Resolve by stem and by repo id; a miss returns None.
        assert_eq!(resolve_to_stem(stem).as_deref(), Some(stem));
        assert_eq!(resolve_to_stem("acme/inst-test-b1").as_deref(), Some(stem));
        assert!(resolve_to_stem("inst-test-nope-b1").is_none());

        // GGUF resolve_active → ref is the stem, engine left blank for the caller.
        let active = resolve_active("acme/inst-test-b1").expect("resolves");
        assert_eq!(active.format, ModelFormat::Gguf);
        assert_eq!(active.r#ref, stem);
        assert!(active.engine.is_empty());

        // Reverse lookup.
        assert_eq!(repo_for_stem(stem).as_deref(), Some("acme/inst-test-b1"));

        // Remove drops the record; a second remove is an idempotent no-op success.
        remove(stem).unwrap();
        assert!(load_present().iter().all(|m| m.stem != stem));
        remove(stem).unwrap();

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_present_filters_records_with_no_file_on_disk() {
        crate::ensure_test_host();
        let stem = "inst-test-phantom-unique-b2";
        // Record WITHOUT creating the file → must be filtered from load_present.
        record(InstalledModel {
            repo_id: "acme/phantom-b2".into(),
            filename: format!("{stem}.gguf"),
            stem: stem.into(),
            size_bytes: None,
            format: ModelFormat::Gguf,
            mmproj: None,
            finetune_base: None,
        })
        .unwrap();
        assert!(
            load_present().iter().all(|m| m.stem != stem),
            "a record with no on-disk file must not show as installed"
        );
        remove(stem).unwrap();
    }

    #[test]
    fn snapshot_present_only_when_dir_nonempty_and_ref_is_repo_id() {
        crate::ensure_test_host();
        let repo = "acme/snap-test-unique-b3";
        let slug = slugify_repo(repo);
        let dir = model_snapshot_dir(&slug);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("model.safetensors"), b"weights").unwrap();
        record(InstalledModel {
            repo_id: repo.into(),
            filename: repo.into(),
            stem: slug.clone(),
            size_bytes: Some(7),
            format: ModelFormat::Safetensors,
            mmproj: None,
            finetune_base: None,
        })
        .unwrap();

        assert!(load_present().iter().any(|m| m.stem == slug));
        // A snapshot resolve_active carries the repo id as its ref (not the slug).
        let active = resolve_active(&slug).expect("resolves");
        assert_eq!(active.format, ModelFormat::Safetensors);
        assert_eq!(active.r#ref, repo);

        remove(&slug).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_snapshot_dir_counts_as_absent() {
        crate::ensure_test_host();
        let slug = "inst-test-empty-snap-unique-b4";
        let dir = model_snapshot_dir(slug);
        std::fs::create_dir_all(&dir).unwrap();
        record(InstalledModel {
            repo_id: "acme/empty-b4".into(),
            filename: "acme/empty-b4".into(),
            stem: slug.into(),
            size_bytes: None,
            format: ModelFormat::Mlx,
            mmproj: None,
            finetune_base: None,
        })
        .unwrap();
        assert!(
            load_present().iter().all(|m| m.stem != slug),
            "an empty snapshot directory is not a present install"
        );
        remove(slug).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
