//! Tracks which catalog models the user has downloaded, so the catalog can show
//! an "Installed" badge and an installed-only filter without re-deriving the
//! mapping from bare filenames on disk.
//!
//! Backed by `<data dir>/state/installed-models.json`. Each record links a
//! downloaded GGUF file (stored at `<data dir>/models/chat/<stem>.gguf` by the
//! catalog install path) back to its Hugging Face repo id and original filename. The on-disk GGUF is
//! still the source of truth for "is it really there"; this index just records
//! provenance so the catalog UI can group files under their model card.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use ryu_model_format::{engines_for_format, ModelFormat};
use ryu_sidecar_runtime::layout::{self, Modality};

/// One downloaded model's provenance record. A record is either a single GGUF
/// file (`format = Gguf`, lives at `models/chat/<stem>.gguf` — or, for the
/// bundled defaults, `models/embedding/` / `models/rerank/`) or a multi-file repo
/// snapshot (`format = Safetensors | Mlx`, lives in the directory
/// `models/chat/snapshots/<stem>/`, where `stem` is the slugified repo id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledModel {
    /// Hugging Face repo id, e.g. `"unsloth/gemma-4-E2B-it-GGUF"`.
    pub repo_id: String,
    /// For GGUF: the original filename within the repo. For a snapshot: the repo
    /// id (there is no single file to name).
    pub filename: String,
    /// Local key. GGUF: file stem (`models/chat/<stem>.gguf`). Snapshot: the
    /// slugified repo id, used as the directory `models/chat/snapshots/<stem>/`.
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
    /// on disk at [`mmproj_file_path`] (`models/chat/<stem>.mmproj.gguf`).
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
    /// GGUF: the local stem (resolves via [`model_file_path`]).
    /// Snapshot: the HF repo id (the engine resolves it from
    /// `models/chat/snapshots/<slug>/`, see [`present_snapshot_dir`]).
    pub r#ref: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct InstalledModelsFile {
    /// Keyed by local stem so re-installing the same file is idempotent.
    #[serde(default)]
    models: HashMap<String, InstalledModel>,
}

fn store_path() -> PathBuf {
    layout::state_path(&crate::ryu_dir(), "installed-models.json")
}

/// `<data dir>/models/chat` — where catalog GGUF installs (and their vision
/// adapters) land.
pub fn chat_models_dir() -> PathBuf {
    layout::models_dir(&crate::ryu_dir(), Modality::Chat)
}

/// The modality folders whose GGUFs the catalog lists as installed models: chat
/// models, plus the bundled default embedding and reranker models (which the
/// installed view deliberately shows under their Hugging Face repo). Speech,
/// image, video, VAD and other weights live in their own `models/<modality>/`
/// folders and are never scanned, so they can never surface as a chat card.
pub const CATALOG_GGUF_MODALITIES: [Modality; 3] =
    [Modality::Chat, Modality::Embedding, Modality::Rerank];

/// The directories [`CATALOG_GGUF_MODALITIES`] name, in lookup order.
pub fn catalog_gguf_dirs() -> Vec<PathBuf> {
    let root = crate::ryu_dir();
    CATALOG_GGUF_MODALITIES
        .iter()
        .map(|m| layout::models_dir(&root, *m))
        .collect()
}

/// Load every recorded install whose GGUF still exists on disk. Records whose
/// file was deleted out-of-band are silently dropped so the catalog never shows
/// a phantom "installed".
pub fn load_present() -> Vec<InstalledModel> {
    let parsed: InstalledModelsFile = match ryu_json_store::read_or_default(&store_path()) {
        Ok(file) => file,
        Err(error) => {
            tracing::error!(error = %error, "installed-model provenance store is corrupt");
            return Vec::new();
        }
    };
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
    let path = store_path();
    ryu_json_store::mutate(&path, move |file: &mut InstalledModelsFile| {
        let mut model = model;
        // An unknown size never erases a known one: update detection compares
        // against the recorded size and skips a model that has none.
        if model.size_bytes.is_none() {
            model.size_bytes = file
                .models
                .get(&model.stem)
                .and_then(|previous| previous.size_bytes);
        }
        file.models.insert(model.stem.clone(), model);
        Ok(())
    })
}

/// Preferences-KV key holding the user-selected active local chat model. The
/// value is a JSON-encoded [`ActiveModel`] (`{engine, format, ref}`). For
/// backward-compat the reader also accepts a bare stem string (the legacy
/// format = GGUF) — see [`parse_active_pref`]. When set and the weights are
/// present on disk, the resolved engine serves the selection instead of the
/// registry default; this is how a deep link / "Use this model" action switches
/// the served model at runtime without recompiling or restarting with a different
/// `RYU_LOCAL_CHAT_MODEL_ID` (the registry default is env-only — `registry.json`
/// carries no `local_chat_model_*` key).
/// Empty or absent means "use the registry default" (nothing hardcoded, fully
/// swappable).
pub const ACTIVE_MODEL_PREF: &str = "local-chat-model";

/// Preferences-KV key holding the user-selected active diffusion model. The
/// value is the plain local stem of a GGUF diffusion file — the engine looks for
/// it in its own `models/image/` and `models/video/` folders, then in
/// `models/chat/` (a diffusion GGUF installed through the catalog). When set, `sd-server` is started with this
/// model instead of the default bundled one. Mirrors [`ACTIVE_MODEL_PREF`] for
/// the chat-engine swap but is independent of it — a diffusion model does not
/// enter the `LOCAL_ENGINES` swap pool (sd-server runs alongside a chat engine).
pub const ACTIVE_DIFFUSION_MODEL_PREF: &str = "local-diffusion-model";

/// Absolute path of an installed GGUF given its local stem: the first of
/// [`catalog_gguf_dirs`] that holds `<stem>.gguf`, or `models/chat/<stem>.gguf`
/// (where a catalog install writes it) when none does.
pub fn model_file_path(stem: &str) -> PathBuf {
    let file = format!("{stem}.gguf");
    catalog_gguf_dirs()
        .into_iter()
        .map(|dir| dir.join(&file))
        .find(|p| p.exists())
        .unwrap_or_else(|| chat_models_dir().join(file))
}

/// Absolute path of the multimodal projector ("vision adapter") that pairs with
/// the installed GGUF at this `stem` (`models/chat/<stem>.mmproj.gguf`). The
/// adapter is stored beside its model under a deterministic name so the launch
/// path can find it without consulting the provenance index — the binding is
/// the filename, not a JSON field. A text-only model simply has no file here.
pub fn mmproj_file_path(stem: &str) -> PathBuf {
    chat_models_dir().join(format!("{stem}.mmproj.gguf"))
}

/// Absolute path of an installed repo snapshot's directory
/// (`models/chat/snapshots/<slug>/`), where `slug` is the slugified repo id
/// (also the record's `stem`). vLLM/SGLang/MLX engines serve weights from here.
pub fn model_snapshot_dir(slug: &str) -> PathBuf {
    layout::chat_snapshots_dir(&crate::ryu_dir()).join(slug)
}

/// The local snapshot directory for a snapshot model ref — an HF repo id (the
/// form an [`ActiveModel`] carries) or its slug — when that snapshot is
/// installed and non-empty. Python engines pass this local path as their model
/// argument instead of the repo id, so they serve the installed copy rather than
/// re-downloading it from the Hub. `None` for anything not installed (the engine
/// then falls back to the repo id).
pub fn present_snapshot_dir(model_ref: &str) -> Option<PathBuf> {
    let trimmed = model_ref.trim();
    if trimmed.is_empty() {
        return None;
    }
    let dir = model_snapshot_dir(&slugify_repo(trimmed));
    let non_empty = std::fs::read_dir(&dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    non_empty.then_some(dir)
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
    let path = store_path();
    ryu_json_store::mutate(&path, |file: &mut InstalledModelsFile| {
        file.models.remove(stem);
        Ok(())
    })
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
    fn stores_live_in_their_layout_dirs() {
        crate::ensure_test_host();
        assert!(store_path().ends_with("state/installed-models.json"));
        assert!(model_file_path("layout-probe-unique-b5")
            .ends_with("models/chat/layout-probe-unique-b5.gguf"));
        assert!(mmproj_file_path("x").ends_with("models/chat/x.mmproj.gguf"));
        assert!(model_snapshot_dir("acme_x").ends_with("models/chat/snapshots/acme_x"));
    }

    #[test]
    fn present_snapshot_dir_resolves_repo_ids_only_when_installed() {
        crate::ensure_test_host();
        let repo = "acme/present-snap-unique-b6";
        assert!(present_snapshot_dir(repo).is_none());
        let dir = model_snapshot_dir(&slugify_repo(repo));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(
            present_snapshot_dir(repo).is_none(),
            "empty dir is not installed"
        );
        std::fs::write(dir.join("config.json"), b"{}").unwrap();
        assert_eq!(present_snapshot_dir(repo).as_deref(), Some(dir.as_path()));
        assert!(present_snapshot_dir("  ").is_none());
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
