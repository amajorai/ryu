//! The on-disk layout of the Ryu data dir — the single place that decides what
//! lives where under `<data dir>`.
//!
//! Every process that touches the data dir (Core, Gateway, Desktop, satellite
//! sidecars) builds paths through these functions instead of joining literal
//! names onto the root, so the tree stays one consistent hierarchy:
//!
//! ```text
//! <data dir>/
//! ├── models/<modality>/…        weights only (chat, embedding, image, video, speech-to-text, …)
//! │   ├── hf/  torch/            shared HF_HOME / TORCH_HOME for every Python runtime
//! ├── engines/<group>/<engine>/  inference servers + their shared libraries
//! ├── bin/                       Core/Gateway runtime generations and small CLI tools
//! ├── plugins/<dir>/             installed plugin packages
//! ├── plugin-data/<dir>/         each plugin's/app's own data (dbs, prefs, media)
//! ├── runtimes/<name>/           agent/tool runtimes (pi, acp-npm, codex-home, …)
//! ├── services/<name>/           first-party service state (ghost, shadow, mesh, …)
//! ├── db/                        Core SQLite databases
//! ├── state/                     Core JSON state and structured state dirs
//! ├── files/                     user content (blobs, media, voice, source-history)
//! ├── secrets/                   keys, tokens, credentials
//! ├── cache/                     regenerable caches
//! ├── logs/                      log files
//! └── tmp/<owner>/               scratch / download staging
//! ```
//!
//! Functions take the resolved root explicitly so they are pure and testable;
//! callers pass `ryu_dir()` (or Core's `paths::ryu_dir()`).

use std::path::{Path, PathBuf};

/// Top-level directory names. Exposed so reset/backup/relocation code can name
/// them without re-spelling literals.
pub mod top {
    pub const MODELS: &str = "models";
    pub const ENGINES: &str = "engines";
    pub const BIN: &str = "bin";
    pub const PLUGINS: &str = "plugins";
    pub const PLUGIN_DATA: &str = "plugin-data";
    pub const RUNTIMES: &str = "runtimes";
    pub const SERVICES: &str = "services";
    pub const DB: &str = "db";
    pub const STATE: &str = "state";
    pub const FILES: &str = "files";
    pub const SECRETS: &str = "secrets";
    pub const CACHE: &str = "cache";
    pub const LOGS: &str = "logs";
    pub const TMP: &str = "tmp";
}

/// Env var Core sets on every plugin sidecar: that plugin's own data dir.
pub const RYU_PLUGIN_DATA_DIR_ENV: &str = "RYU_PLUGIN_DATA_DIR";
/// Env var Core sets on every plugin sidecar: the shared `models/` root.
pub const RYU_MODELS_DIR_ENV: &str = "RYU_MODELS_DIR";

/// What a set of weights is *for*. Each modality is its own folder under
/// `models/`, so a scan of one modality can never pick up another's files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Modality {
    /// Chat / instruct LLMs served by a chat engine (GGUF files + `snapshots/`).
    Chat,
    /// Embedding models.
    Embedding,
    /// Reranker models.
    Rerank,
    /// Small classifier / router models.
    Classifier,
    /// Text-to-image weights (diffusion model, its VAE and text encoder).
    Image,
    /// Text-to-video weights.
    Video,
    /// Speech recognition.
    SpeechToText,
    /// Speech synthesis.
    TextToSpeech,
    /// Voice-activity detection.
    Vad,
    /// Speaker diarization.
    Diarization,
    /// Tool-routing models (Needle).
    ToolRouting,
    /// Vision / screen-understanding models.
    Vision,
    /// Fine-tuned adapters (LoRA outputs).
    Adapters,
}

impl Modality {
    #[must_use]
    pub const fn dir_name(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Embedding => "embedding",
            Self::Rerank => "rerank",
            Self::Classifier => "classifier",
            Self::Image => "image",
            Self::Video => "video",
            Self::SpeechToText => "speech-to-text",
            Self::TextToSpeech => "text-to-speech",
            Self::Vad => "vad",
            Self::Diarization => "diarization",
            Self::ToolRouting => "tool-routing",
            Self::Vision => "vision",
            Self::Adapters => "adapters",
        }
    }
}

/// Which kind of inference server an engine is. Engines are grouped the same
/// way models are, so `engines/chat/llamacpp` serves `models/chat/*`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EngineGroup {
    /// Text LLM servers (llama.cpp, Ollama, mesh-llm, mlx-serve, …).
    Chat,
    /// Image/video diffusion servers (sd.cpp).
    Image,
    /// Speech servers (whisper.cpp, audio.cpp, the Python TTS runtime).
    Audio,
    /// Tool-routing runtimes (Needle).
    ToolRouting,
}

impl EngineGroup {
    #[must_use]
    pub const fn dir_name(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Image => "image",
            Self::Audio => "audio",
            Self::ToolRouting => "tool-routing",
        }
    }
}

// ── models/ ──────────────────────────────────────────────────────────────────

/// `<root>/models`.
#[must_use]
pub fn models_root(root: &Path) -> PathBuf {
    root.join(top::MODELS)
}

/// `<root>/models/<modality>`.
#[must_use]
pub fn models_dir(root: &Path, modality: Modality) -> PathBuf {
    models_root(root).join(modality.dir_name())
}

/// `<root>/models/<modality>/<name>` — a model family/engine subfolder.
#[must_use]
pub fn model_family_dir(root: &Path, modality: Modality, family: &str) -> PathBuf {
    models_dir(root, modality).join(family)
}

/// `<root>/models/chat/snapshots` — multi-file (safetensors / MLX) chat models,
/// one `<slug>/` per Hub repo.
#[must_use]
pub fn chat_snapshots_dir(root: &Path) -> PathBuf {
    models_dir(root, Modality::Chat).join("snapshots")
}

/// `<root>/models/hf` — the one shared `HF_HOME` for every Python runtime, so
/// Hub downloads never land in `~/.cache/huggingface`.
#[must_use]
pub fn hf_home(root: &Path) -> PathBuf {
    models_root(root).join("hf")
}

/// `<root>/models/torch` — the shared `TORCH_HOME`.
#[must_use]
pub fn torch_home(root: &Path) -> PathBuf {
    models_root(root).join("torch")
}

/// Folder name of the Parakeet TDT v3 int8 ONNX bundle. Core downloads it and
/// the meetings/subtitles sidecars read it, so both sides use this constant.
pub const PARAKEET_V3_INT8_DIR: &str = "parakeet-tdt-0.6b-v3-int8";

/// `<root>/models/speech-to-text/parakeet/parakeet-tdt-0.6b-v3-int8`.
#[must_use]
pub fn parakeet_v3_dir(root: &Path) -> PathBuf {
    model_family_dir(root, Modality::SpeechToText, "parakeet").join(PARAKEET_V3_INT8_DIR)
}

// ── engines/ ─────────────────────────────────────────────────────────────────

/// `<root>/engines`.
#[must_use]
pub fn engines_root(root: &Path) -> PathBuf {
    root.join(top::ENGINES)
}

/// `<root>/engines/<group>/<engine>` — one folder per engine; its archive is
/// extracted inside so two engines' shared libraries never mix.
#[must_use]
pub fn engine_dir(root: &Path, group: EngineGroup, engine: &str) -> PathBuf {
    engines_root(root).join(group.dir_name()).join(engine)
}

// ── bin/ ─────────────────────────────────────────────────────────────────────

/// `<root>/bin` — Core/Gateway runtime generations and small standalone tools.
#[must_use]
pub fn bin_dir(root: &Path) -> PathBuf {
    root.join(top::BIN)
}

// ── plugins ──────────────────────────────────────────────────────────────────

/// On-disk directory name for a plugin id: `@ryu/meetings` → `@ryu+meetings`.
/// Same flattening as `plugin_dir_name` in the kernel contracts.
#[must_use]
pub fn plugin_dir_name(plugin_id: &str) -> String {
    plugin_id.replace('/', "+")
}

/// `<root>/plugins` — installed plugin packages.
#[must_use]
pub fn plugins_dir(root: &Path) -> PathBuf {
    root.join(top::PLUGINS)
}

/// `<root>/plugin-data`.
#[must_use]
pub fn plugin_data_root(root: &Path) -> PathBuf {
    root.join(top::PLUGIN_DATA)
}

/// `<root>/plugin-data/<dir>` — the data dir owned by one plugin/app. Deleted
/// by uninstall-with-data.
#[must_use]
pub fn plugin_data_dir(root: &Path, plugin_id: &str) -> PathBuf {
    plugin_data_root(root).join(plugin_dir_name(plugin_id))
}

// ── runtimes/ services/ ──────────────────────────────────────────────────────

/// `<root>/runtimes/<name>` — agent/tool runtimes (pi, acp-npm, codex-home, …).
#[must_use]
pub fn runtime_dir(root: &Path, name: &str) -> PathBuf {
    root.join(top::RUNTIMES).join(name)
}

/// `<root>/services/<name>` — first-party service state (ghost, shadow, mesh, …).
#[must_use]
pub fn service_dir(root: &Path, name: &str) -> PathBuf {
    root.join(top::SERVICES).join(name)
}

// ── Core stores ──────────────────────────────────────────────────────────────

/// `<root>/db`.
#[must_use]
pub fn db_dir(root: &Path) -> PathBuf {
    root.join(top::DB)
}

/// `<root>/db/<file>` — a Core SQLite database (e.g. `conversations.db`).
#[must_use]
pub fn db_file(root: &Path, file: &str) -> PathBuf {
    db_dir(root).join(file)
}

/// `<root>/state`.
#[must_use]
pub fn state_dir(root: &Path) -> PathBuf {
    root.join(top::STATE)
}

/// `<root>/state/<rel>` — Core JSON state or a structured state subdir.
#[must_use]
pub fn state_path(root: &Path, rel: &str) -> PathBuf {
    state_dir(root).join(rel)
}

/// `<root>/files/<rel>` — user content (blobs, media, voice, source-history).
#[must_use]
pub fn files_path(root: &Path, rel: &str) -> PathBuf {
    root.join(top::FILES).join(rel)
}

/// `<root>/secrets`.
#[must_use]
pub fn secrets_dir(root: &Path) -> PathBuf {
    root.join(top::SECRETS)
}

/// `<root>/secrets/<file>` — a key, token or credential file.
#[must_use]
pub fn secret_path(root: &Path, file: &str) -> PathBuf {
    secrets_dir(root).join(file)
}

/// `<root>/cache`.
#[must_use]
pub fn cache_dir(root: &Path) -> PathBuf {
    root.join(top::CACHE)
}

/// `<root>/cache/<rel>`.
#[must_use]
pub fn cache_path(root: &Path, rel: &str) -> PathBuf {
    cache_dir(root).join(rel)
}

/// `<root>/logs`.
#[must_use]
pub fn logs_dir(root: &Path) -> PathBuf {
    root.join(top::LOGS)
}

/// `<root>/tmp`.
#[must_use]
pub fn tmp_dir(root: &Path) -> PathBuf {
    root.join(top::TMP)
}

/// `<root>/tmp/<owner>` — scratch space owned by one component.
#[must_use]
pub fn tmp_dir_for(root: &Path, owner: &str) -> PathBuf {
    tmp_dir(root).join(owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_are_grouped_by_modality() {
        let root = Path::new("/d");
        assert_eq!(
            models_dir(root, Modality::Chat),
            Path::new("/d/models/chat")
        );
        assert_eq!(
            model_family_dir(root, Modality::SpeechToText, "parakeet"),
            Path::new("/d/models/speech-to-text/parakeet")
        );
        assert_eq!(
            chat_snapshots_dir(root),
            Path::new("/d/models/chat/snapshots")
        );
        assert_eq!(hf_home(root), Path::new("/d/models/hf"));
    }

    #[test]
    fn engines_are_grouped_like_models() {
        assert_eq!(
            engine_dir(Path::new("/d"), EngineGroup::Chat, "llamacpp"),
            Path::new("/d/engines/chat/llamacpp")
        );
    }

    #[test]
    fn plugin_data_uses_the_flattened_plugin_dir_name() {
        assert_eq!(
            plugin_data_dir(Path::new("/d"), "@ryu/meetings"),
            Path::new("/d/plugin-data/@ryu+meetings")
        );
    }

    #[test]
    fn modality_dir_names_are_unique() {
        let all = [
            Modality::Chat,
            Modality::Embedding,
            Modality::Rerank,
            Modality::Classifier,
            Modality::Image,
            Modality::Video,
            Modality::SpeechToText,
            Modality::TextToSpeech,
            Modality::Vad,
            Modality::Diarization,
            Modality::ToolRouting,
            Modality::Vision,
            Modality::Adapters,
        ];
        let mut names: Vec<_> = all.iter().map(|m| m.dir_name()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), all.len());
    }
}
