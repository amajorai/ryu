//! Unified provider/model/strategy registry for Ryu Core (spec unit U030).
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): deciding *which*
//! model or provider to use for a given role (embedding, chat, reranker …) is
//! "what runs" (orchestration choice), so this belongs in Core. The Gateway
//! governs *what is allowed/measured/paid* — routing policy and budget
//! enforcement stay there.
//!
//! Every model/provider/strategy default is a swappable config entry loaded
//! from `~/.ryu/registry.json` (or `$RYU_REGISTRY_PATH`), falling back to
//! built-in defaults when the file is absent or a field is missing. Environment
//! variables take precedence over file values; the built-in literals are the
//! last-resort fallbacks and are documented as such.
//!
//! # Precedence chain (highest → lowest)
//! 1. Environment variable (e.g. `RYU_DEFAULT_LLM_MODEL`)
//! 2. `~/.ryu/registry.json` field (or `$RYU_REGISTRY_PATH`)
//! 3. Built-in literal constant (last-resort fallback, documented below)
//!
//! # API keys
//! API keys are intentionally **not** stored in `registry.json`. Keep them in
//! environment variables (`RYU_DEFAULT_LLM_API_KEY` / `OPENAI_API_KEY`).
//! `registry.json` is config, not a secrets file.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

// ── Built-in last-resort fallbacks ────────────────────────────────────────────
//
// These literals are the absolute last resort when no env var and no file entry
// override them. Keep them here so every default is visible in one place.

/// Last-resort fallback: embedding model id.
///
/// nomic-embed-text-v1.5 — Apache-2.0, 768-dim, served locally as a GGUF by a
/// dedicated llama.cpp `--embeddings` instance (see [`Self::local_embed_model`]
/// and the `llamacpp-embed` sidecar). Swappable via `RYU_EMBED_MODEL`.
pub const DEFAULT_EMBED_MODEL: &str = "nomic-embed-text-v1.5";
/// Last-resort fallback: embedding output dimensionality (nomic-embed-text-v1.5).
pub const DEFAULT_EMBED_DIMS: usize = 768;

/// Last-resort fallback: base URL of the local embeddings server.
///
/// A dedicated llama.cpp instance runs with `--embeddings` on this loopback port
/// (distinct from the chat engine's 8080) and exposes an OpenAI-compatible
/// `/v1/embeddings` endpoint. `Embedder::from_registry` points here so RAG gets
/// real semantic embeddings on install with zero setup. Override via
/// `RYU_EMBED_BASE_URL` to use a remote endpoint instead.
pub const DEFAULT_EMBED_BASE_URL: &str = "http://127.0.0.1:8081";

/// Default local embedding model id (storage key + filename stem in `~/.ryu/models/`).
///
/// nomic-embed-text-v1.5 Q4_K_M from nomic-ai — publicly accessible without HF
/// authentication, ~84 MB, CPU-friendly. Served by the `llamacpp-embed` sidecar.
pub const DEFAULT_LOCAL_EMBED_MODEL_ID: &str = "nomic-embed-text-v1.5.Q4_K_M";

/// Default local embedding model weight URL. Override via `RYU_LOCAL_EMBED_MODEL_URL`.
pub const DEFAULT_LOCAL_EMBED_MODEL_URL: &str =
    "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf";

/// SHA-256 of the default embedding GGUF (from the HF tree API lfs oid).
/// Override via `RYU_LOCAL_EMBED_MODEL_SHA256` (empty string skips verification).
pub const DEFAULT_LOCAL_EMBED_MODEL_SHA256: &str =
    "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac";
/// Last-resort fallback: reranker model id.
pub const DEFAULT_RERANKER_MODEL: &str = "BAAI/bge-reranker";
/// Last-resort fallback: reranker output dimensionality (scalar → 1).
pub const DEFAULT_RERANKER_DIMS: usize = 1;

/// Base URL of the local reranker server. A dedicated llama.cpp instance runs
/// with `--reranking` on this loopback port (distinct from the chat engine's
/// 8080 and the embeddings server's 8081) and exposes a `/rerank` endpoint whose
/// `{results:[{index, relevance_score}]}` shape matches what `remote_rerank`
/// already parses. Spaces RAG points here for neural reranking. This server is
/// *not* auto-started (off by default); it is lazily started on first Space
/// search. Override via `RYU_RERANKER_BASE_URL`.
pub const DEFAULT_RERANKER_BASE_URL: &str = "http://127.0.0.1:8082";

/// Default local reranker model id (storage key + filename stem in `~/.ryu/models/`).
///
/// BAAI bge-reranker-v2-m3, Q4_K_M (via the gpustack GGUF conversion) — a
/// multilingual cross-encoder reranker, ~438 MB, CPU-friendly and publicly
/// reachable without HF authentication. Served by the `llamacpp-rerank` sidecar.
pub const DEFAULT_LOCAL_RERANKER_MODEL_ID: &str = "bge-reranker-v2-m3.Q4_K_M";

/// Default local reranker weight URL. Override via `RYU_LOCAL_RERANKER_MODEL_URL`.
pub const DEFAULT_LOCAL_RERANKER_MODEL_URL: &str =
    "https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q4_K_M.gguf";

/// SHA-256 of the default reranker GGUF (from the HF LFS oid / `x-linked-etag`).
/// Override via `RYU_LOCAL_RERANKER_MODEL_SHA256` (empty string skips verification).
pub const DEFAULT_LOCAL_RERANKER_MODEL_SHA256: &str =
    "e186a244ed455b4ab66ec64339ce7427a6ae13f5c0b5e544de96e50f0f8b3673";
/// Last-resort fallback: default chat provider base URL.
pub const DEFAULT_LLM_BASE_URL: &str = "https://api.openai.com";
/// Last-resort fallback: default chat model id.
pub const DEFAULT_LLM_MODEL: &str = "gpt-4o-mini";
/// Last-resort fallback: RAG strategy (vector | graph). Selects which retrieval
/// algorithm is used when a Space does not carry its own `retrieval_mode` column
/// value (e.g. older Spaces created before the GraphRAG unit).
pub const DEFAULT_RAG_STRATEGY: &str = "vector";
/// Last-resort fallback: graph entity-extraction model id. The built-in
/// deterministic extractor needs no model, but this config hook exists so
/// operators can point it at a remote LLM extractor without a recompile.
pub const DEFAULT_GRAPH_EXTRACTION_MODEL: &str = "local-cooccurrence";

/// Default local chat model id (storage key + filename stem in `~/.ryu/models/`).
///
/// Gemma 4 E2B IT Q4_K_M from unsloth — publicly accessible without HF authentication,
/// ~3.1 GB, runs well on modest hardware. Validated as publicly reachable via git-lfs
/// redirect at https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF (HTTP 302 → 200,
/// no auth required).
pub const DEFAULT_LOCAL_CHAT_MODEL_ID: &str = "gemma-4-E2B-it-Q4_K_M";

/// The agent id auto-installed and enabled on first Core start (U041).
///
/// Override via `RYU_DEFAULT_AGENT` env var or `"default_agent_id"` in
/// `~/.ryu/registry.json`. The literal fallback is `"ryu"` — the flagship
/// Pi + Gateway agent is the only agent installed by default. Every other
/// built-in (Claude Code, Codex, Gemini CLI, Pi, OpenClaw, …) is opt-in via
/// the agents catalog (onboarding detects which CLIs the user already has and
/// lets them add the matching agent). `ryu` manages its own Pi binary, so it
/// is self-sufficient and never depends on the user having Pi on PATH.
pub const DEFAULT_AGENT_ID: &str = "ryu";

/// Default local chat model weight URL. Override via `RYU_LOCAL_CHAT_MODEL_URL`.
pub const DEFAULT_LOCAL_CHAT_MODEL_URL: &str =
    "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf";

/// SHA-256 of the default GGUF weight (from git-lfs pointer metadata).
/// Override via `RYU_LOCAL_CHAT_MODEL_SHA256` (use empty string to skip verification).
pub const DEFAULT_LOCAL_CHAT_MODEL_SHA256: &str =
    "9378bc471710229ef165709b62e34bfb62231420ddaf6d729e727305b5b8672d";

// ── Entry types ───────────────────────────────────────────────────────────────

/// An embedding or reranker model entry (role-specific dimensionality).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelEntry {
    /// Model identifier (e.g. `"google/embeddinggemma-300m"`).
    pub id: String,
    /// Output dimensionality. Must match whatever the live endpoint produces.
    pub dims: usize,
}

/// A provider entry: name + base URL for an OpenAI-compatible endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderEntry {
    /// Stable identifier (e.g. `"openai"`, `"local"`, `"ollama"`).
    pub id: String,
    /// OpenAI-compatible base URL (no trailing `/v1`).
    pub base_url: String,
}

/// A strategy entry: named algorithm/approach for a pipeline step.
///
/// Examples: `{ id: "rag_strategy", value: "vector" }`,
/// `{ id: "rag_strategy", value: "graphrag" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StrategyEntry {
    /// Stable identifier for the pipeline step (e.g. `"rag_strategy"`).
    pub id: String,
    /// Chosen algorithm/value for that step.
    pub value: String,
}

/// Entry for a local GGUF weight file (chat model downloaded for llama.cpp).
///
/// The download URL and expected SHA-256 are read from the registry so the
/// bundled model is swappable via env vars (or `registry.json`) without recompiling.
/// Zero-setup headline: the default URL is publicly accessible without any API key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalModelEntry {
    /// Model identifier used to name the file in `~/.ryu/models/` and in the
    /// version store (e.g. `"gemma-3-1b-it-Q4_K_M"`).
    pub id: String,
    /// Direct HTTPS URL to the GGUF file. Must be publicly reachable without
    /// authentication (zero-setup headline: works with no API key).
    pub weight_url: String,
    /// Expected SHA-256 hex digest for the downloaded GGUF file. Empty string
    /// disables verification (not recommended for production).
    pub sha256: String,
}

impl LocalModelEntry {
    /// Resolved path for this weight inside `~/.ryu/models/<id>.gguf`.
    pub fn weight_path(&self) -> PathBuf {
        crate::paths::ryu_dir()
            .join("models")
            .join(format!("{}.gguf", self.id))
    }
}

// ── File-backed config (registry.json) ───────────────────────────────────────

/// Raw JSON shape of `~/.ryu/registry.json` (or `$RYU_REGISTRY_PATH`).
/// All fields are optional so a partial file is always valid — missing fields
/// fall through to env vars, then to built-in literals.
#[derive(Debug, Default, Deserialize)]
struct RegistryFile {
    /// Default chat provider base URL (overridden by `RYU_DEFAULT_LLM_BASE_URL`).
    #[serde(default)]
    default_llm_base_url: Option<String>,
    /// Default chat model id (overridden by `RYU_DEFAULT_LLM_MODEL`).
    #[serde(default)]
    default_llm_model: Option<String>,
    /// Embedding model id (overridden by `RYU_EMBED_MODEL`).
    #[serde(default)]
    embed_model: Option<String>,
    /// Embedding output dimensionality (overridden by `RYU_EMBED_DIMS`).
    #[serde(default)]
    embed_dims: Option<usize>,
    /// Embeddings endpoint base URL (overridden by `RYU_EMBED_BASE_URL`).
    #[serde(default)]
    embed_base_url: Option<String>,
    /// Local embedding model id for the bundled GGUF (overridden by `RYU_LOCAL_EMBED_MODEL_ID`).
    #[serde(default)]
    local_embed_model_id: Option<String>,
    /// Local embedding model weight URL (overridden by `RYU_LOCAL_EMBED_MODEL_URL`).
    #[serde(default)]
    local_embed_model_url: Option<String>,
    /// Local embedding model SHA-256 (overridden by `RYU_LOCAL_EMBED_MODEL_SHA256`).
    #[serde(default)]
    local_embed_model_sha256: Option<String>,
    /// Reranker model id (overridden by `RYU_RERANKER_MODEL`).
    #[serde(default)]
    reranker_model: Option<String>,
    /// Reranker endpoint base URL (overridden by `RYU_RERANKER_BASE_URL`).
    #[serde(default)]
    reranker_base_url: Option<String>,
    /// Local reranker model id for the bundled GGUF (overridden by `RYU_LOCAL_RERANKER_MODEL_ID`).
    #[serde(default)]
    local_reranker_model_id: Option<String>,
    /// Local reranker model weight URL (overridden by `RYU_LOCAL_RERANKER_MODEL_URL`).
    #[serde(default)]
    local_reranker_model_url: Option<String>,
    /// Local reranker model SHA-256 (overridden by `RYU_LOCAL_RERANKER_MODEL_SHA256`).
    #[serde(default)]
    local_reranker_model_sha256: Option<String>,
    /// Default RAG strategy: "vector" | "graph". Overridden by `RYU_RAG_STRATEGY`.
    /// Per-Space `retrieval_mode` column takes precedence over this global default.
    #[serde(default)]
    rag_strategy: Option<String>,
    /// Graph entity-extraction model id (overridden by `RYU_GRAPH_EXTRACTION_MODEL`).
    #[serde(default)]
    graph_extraction_model: Option<String>,
    /// Local chat model id for the bundled GGUF (overridden by `RYU_LOCAL_CHAT_MODEL_ID`).
    #[serde(default)]
    local_chat_model_id: Option<String>,
    /// Local chat model weight URL (overridden by `RYU_LOCAL_CHAT_MODEL_URL`).
    #[serde(default)]
    local_chat_model_url: Option<String>,
    /// Local chat model SHA-256 (overridden by `RYU_LOCAL_CHAT_MODEL_SHA256`).
    #[serde(default)]
    local_chat_model_sha256: Option<String>,
    /// Named provider entries (supplemental; not used by built-in routing yet).
    #[serde(default)]
    providers: Vec<ProviderEntry>,
    /// Named strategy entries (supplemental).
    #[serde(default)]
    strategies: Vec<StrategyEntry>,
    /// Default agent id to auto-install + enable on first start (U041).
    /// Overridden by `RYU_DEFAULT_AGENT` env var.
    #[serde(default)]
    default_agent_id: Option<String>,
}

impl RegistryFile {
    /// Read and deserialise from a path. Returns `None` when the file does not
    /// exist or cannot be parsed (fail-open: missing/malformed file → defaults).
    fn load(path: &std::path::Path) -> Option<Self> {
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text)
            .map_err(|e| {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "registry.json is malformed; ignoring and using defaults"
                );
                e
            })
            .ok()
    }
}

// ── Unified registry ──────────────────────────────────────────────────────────

/// Ryu's unified provider/model/strategy registry: the single source of truth
/// for every swappable default in Core.
///
/// Construct via [`ProviderRegistry::load`] (reads file + env), or
/// [`ProviderRegistry::from_file`] (test/explicit path).  The legacy
/// [`ModelRegistry`] alias remains so existing callers in `retrieval.rs` and
/// the test suite compile without changes.
#[derive(Debug, Clone)]
pub struct ProviderRegistry {
    // ── Chat defaults ─────────────────────────────────────────────────────────
    /// Default chat provider base URL (no `/v1` suffix).
    pub default_llm_base_url: String,
    /// Default chat model id.
    pub default_llm_model: String,

    // ── RAG models ────────────────────────────────────────────────────────────
    /// Embedding model used for RAG (Spaces + retrieval).
    pub embedder: ModelEntry,
    /// Base URL of the OpenAI-compatible embeddings endpoint (no `/v1` suffix).
    /// Defaults to the local `llamacpp-embed` server; `RYU_EMBED_BASE_URL` overrides.
    pub embed_base_url: String,
    /// Local embedding model: the GGUF weight served by the dedicated llama.cpp
    /// `--embeddings` instance for zero-setup semantic RAG. Swappable via env or
    /// `registry.json` like the chat model.
    pub local_embed_model: LocalModelEntry,
    /// Reranker model used to re-score top-K retrieval candidates.
    pub reranker: ModelEntry,
    /// Base URL of the OpenAI-compatible reranker endpoint (no `/v1` suffix).
    /// Defaults to the local `llamacpp-rerank` server; `RYU_RERANKER_BASE_URL`
    /// overrides to point at a remote cross-encoder scoring endpoint.
    pub reranker_base_url: String,
    /// Local reranker model: the GGUF cross-encoder served by the dedicated
    /// llama.cpp `--reranking` instance for zero-setup neural reranking of Spaces
    /// RAG. Swappable via env or `registry.json` like the embedding model.
    pub local_reranker_model: LocalModelEntry,
    /// Default RAG strategy for Spaces that have no per-Space `retrieval_mode`
    /// set. One of `"vector"` or `"graph"`. Defaults to `"vector"`.
    pub rag_strategy: String,
    /// Graph entity-extraction model id. The built-in `"local-cooccurrence"`
    /// extractor runs offline; set this to a remote model id to use an LLM.
    pub graph_extraction_model: String,

    // ── Local inference stack ─────────────────────────────────────────────────
    /// Default local chat model: the GGUF weight served by llama.cpp for zero-setup
    /// no-key chat. Overridable via env or `registry.json` so users can swap to any
    /// GGUF they prefer without recompiling.
    pub local_chat_model: LocalModelEntry,

    // ── Supplemental entries ─────────────────────────────────────────────────
    /// Named provider entries loaded from the file (supplemental).
    pub providers: Vec<ProviderEntry>,
    /// Named strategy entries loaded from the file (supplemental).
    pub strategies: Vec<StrategyEntry>,

    // ── Default agent (U041) ─────────────────────────────────────────────────
    /// Agent id that is auto-installed + enabled on first Core start.
    ///
    /// Resolution: `RYU_DEFAULT_AGENT` env > `default_agent_id` in
    /// `~/.ryu/registry.json` > built-in literal `"ryu"`.
    ///
    /// `GET /api/agents` surfaces this id with `"enabled": true` so clients
    /// can badge the default without hard-coding it.
    pub default_agent_id: String,
}

impl ProviderRegistry {
    /// Load the registry from the default path (`$RYU_REGISTRY_PATH` or
    /// `~/.ryu/registry.json`) and apply environment-variable overlays.
    ///
    /// Never panics. A missing or malformed file produces the built-in defaults.
    pub fn load() -> Self {
        let path = registry_path();
        Self::from_file_path(path.as_deref())
    }

    /// Load from an explicit file path (useful for tests). Pass `None` to skip
    /// file loading and use only env vars + built-in literals.
    pub fn from_file(path: &std::path::Path) -> Self {
        Self::from_file_path(Some(path))
    }

    fn from_file_path(path: Option<&std::path::Path>) -> Self {
        let file = path.and_then(RegistryFile::load).unwrap_or_default();
        Self::from_file_and_env(file)
    }

    fn from_file_and_env(file: RegistryFile) -> Self {
        // Precedence: env > file > literal.

        let default_llm_base_url = env_or_file_or_literal(
            "RYU_DEFAULT_LLM_BASE_URL",
            file.default_llm_base_url,
            DEFAULT_LLM_BASE_URL,
        );
        let default_llm_model = env_or_file_or_literal(
            "RYU_DEFAULT_LLM_MODEL",
            file.default_llm_model,
            DEFAULT_LLM_MODEL,
        );
        let embed_id =
            env_or_file_or_literal("RYU_EMBED_MODEL", file.embed_model, DEFAULT_EMBED_MODEL);
        let embed_dims = std::env::var("RYU_EMBED_DIMS")
            .ok()
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<usize>().ok())
            .or(file.embed_dims)
            .unwrap_or(DEFAULT_EMBED_DIMS);
        let embed_base_url = env_or_file_or_literal(
            "RYU_EMBED_BASE_URL",
            file.embed_base_url,
            DEFAULT_EMBED_BASE_URL,
        );
        let embed_model_id = env_or_file_or_literal(
            "RYU_LOCAL_EMBED_MODEL_ID",
            file.local_embed_model_id,
            DEFAULT_LOCAL_EMBED_MODEL_ID,
        );
        let embed_model_url = env_or_file_or_literal(
            "RYU_LOCAL_EMBED_MODEL_URL",
            file.local_embed_model_url,
            DEFAULT_LOCAL_EMBED_MODEL_URL,
        );
        let embed_model_sha256 = std::env::var("RYU_LOCAL_EMBED_MODEL_SHA256")
            .ok()
            .or(file.local_embed_model_sha256)
            .unwrap_or_else(|| DEFAULT_LOCAL_EMBED_MODEL_SHA256.to_owned());
        let reranker_id = env_or_file_or_literal(
            "RYU_RERANKER_MODEL",
            file.reranker_model,
            DEFAULT_RERANKER_MODEL,
        );
        let reranker_base_url = env_or_file_or_literal(
            "RYU_RERANKER_BASE_URL",
            file.reranker_base_url,
            DEFAULT_RERANKER_BASE_URL,
        );
        let reranker_model_id = env_or_file_or_literal(
            "RYU_LOCAL_RERANKER_MODEL_ID",
            file.local_reranker_model_id,
            DEFAULT_LOCAL_RERANKER_MODEL_ID,
        );
        let reranker_model_url = env_or_file_or_literal(
            "RYU_LOCAL_RERANKER_MODEL_URL",
            file.local_reranker_model_url,
            DEFAULT_LOCAL_RERANKER_MODEL_URL,
        );
        let reranker_model_sha256 = std::env::var("RYU_LOCAL_RERANKER_MODEL_SHA256")
            .ok()
            .or(file.local_reranker_model_sha256)
            .unwrap_or_else(|| DEFAULT_LOCAL_RERANKER_MODEL_SHA256.to_owned());
        let rag_strategy =
            env_or_file_or_literal("RYU_RAG_STRATEGY", file.rag_strategy, DEFAULT_RAG_STRATEGY);
        let graph_extraction_model = env_or_file_or_literal(
            "RYU_GRAPH_EXTRACTION_MODEL",
            file.graph_extraction_model,
            DEFAULT_GRAPH_EXTRACTION_MODEL,
        );

        let chat_model_id = env_or_file_or_literal(
            "RYU_LOCAL_CHAT_MODEL_ID",
            file.local_chat_model_id,
            DEFAULT_LOCAL_CHAT_MODEL_ID,
        );
        let chat_model_url = env_or_file_or_literal(
            "RYU_LOCAL_CHAT_MODEL_URL",
            file.local_chat_model_url,
            DEFAULT_LOCAL_CHAT_MODEL_URL,
        );
        // SHA256 is special: empty string is a valid value (disables verify), so we
        // preserve it even when empty; the literal default is the known good hash.
        let chat_model_sha256 = std::env::var("RYU_LOCAL_CHAT_MODEL_SHA256")
            .ok()
            .or(file.local_chat_model_sha256)
            .unwrap_or_else(|| DEFAULT_LOCAL_CHAT_MODEL_SHA256.to_owned());

        let default_agent_id =
            env_or_file_or_literal("RYU_DEFAULT_AGENT", file.default_agent_id, DEFAULT_AGENT_ID);

        Self {
            default_llm_base_url,
            default_llm_model,
            embedder: ModelEntry {
                id: embed_id,
                dims: embed_dims,
            },
            embed_base_url,
            local_embed_model: LocalModelEntry {
                id: embed_model_id,
                weight_url: embed_model_url,
                sha256: embed_model_sha256,
            },
            reranker: ModelEntry {
                id: reranker_id,
                dims: DEFAULT_RERANKER_DIMS,
            },
            reranker_base_url,
            local_reranker_model: LocalModelEntry {
                id: reranker_model_id,
                weight_url: reranker_model_url,
                sha256: reranker_model_sha256,
            },
            rag_strategy,
            graph_extraction_model,
            local_chat_model: LocalModelEntry {
                id: chat_model_id,
                weight_url: chat_model_url,
                sha256: chat_model_sha256,
            },
            providers: file.providers,
            strategies: file.strategies,
            default_agent_id,
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Pick the first non-empty value from: env var, file value, literal fallback.
fn env_or_file_or_literal(env_key: &str, file_val: Option<String>, literal: &str) -> String {
    std::env::var(env_key)
        .ok()
        .filter(|s| !s.is_empty())
        .or(file_val.filter(|s| !s.is_empty()))
        .unwrap_or_else(|| literal.to_owned())
}

/// Resolve the registry file path: `$RYU_REGISTRY_PATH` or `~/.ryu/registry.json`.
fn registry_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RYU_REGISTRY_PATH") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    Some(crate::paths::ryu_dir().join("registry.json"))
}

// ── Backward-compat alias (retrieval.rs + existing tests call ModelRegistry) ──

/// Alias kept for backward compatibility. New code should use [`ProviderRegistry`].
pub type ModelRegistry = ProviderRegistry;

impl ProviderRegistry {
    /// Backward-compat constructor mirroring the old `ModelRegistry::from_env()`.
    /// Equivalent to `ProviderRegistry::load()` except it skips file loading and
    /// reads only env vars + built-in literals. Used by retrieval tests that set
    /// env vars and expect immediate reflection.
    pub fn from_env() -> Self {
        Self::from_file_path(None)
    }

    /// Backward-compat explicit constructor (used by retrieval tests for injection).
    pub fn with_models(
        embed_id: impl Into<String>,
        embed_dims: usize,
        reranker_id: impl Into<String>,
    ) -> Self {
        let mut reg = Self::default();
        // This injection helper is used by offline retrieval tests: blank the
        // embeddings base URL so `Embedder::from_registry` stays in local-hashing
        // mode (no network), matching the helper's pre-nomic behavior.
        reg.embed_base_url = String::new();
        reg.embedder = ModelEntry {
            id: embed_id.into(),
            dims: embed_dims,
        };
        reg.reranker = ModelEntry {
            id: reranker_id.into(),
            dims: DEFAULT_RERANKER_DIMS,
        };
        reg
    }

    /// Returns the graph extraction model id from this registry.
    pub fn graph_extraction_model_id(&self) -> &str {
        self.graph_extraction_model.as_str()
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self {
            default_llm_base_url: DEFAULT_LLM_BASE_URL.to_owned(),
            default_llm_model: DEFAULT_LLM_MODEL.to_owned(),
            embedder: ModelEntry {
                id: DEFAULT_EMBED_MODEL.to_owned(),
                dims: DEFAULT_EMBED_DIMS,
            },
            embed_base_url: DEFAULT_EMBED_BASE_URL.to_owned(),
            local_embed_model: LocalModelEntry {
                id: DEFAULT_LOCAL_EMBED_MODEL_ID.to_owned(),
                weight_url: DEFAULT_LOCAL_EMBED_MODEL_URL.to_owned(),
                sha256: DEFAULT_LOCAL_EMBED_MODEL_SHA256.to_owned(),
            },
            reranker: ModelEntry {
                id: DEFAULT_RERANKER_MODEL.to_owned(),
                dims: DEFAULT_RERANKER_DIMS,
            },
            reranker_base_url: DEFAULT_RERANKER_BASE_URL.to_owned(),
            local_reranker_model: LocalModelEntry {
                id: DEFAULT_LOCAL_RERANKER_MODEL_ID.to_owned(),
                weight_url: DEFAULT_LOCAL_RERANKER_MODEL_URL.to_owned(),
                sha256: DEFAULT_LOCAL_RERANKER_MODEL_SHA256.to_owned(),
            },
            rag_strategy: DEFAULT_RAG_STRATEGY.to_owned(),
            graph_extraction_model: DEFAULT_GRAPH_EXTRACTION_MODEL.to_owned(),
            local_chat_model: LocalModelEntry {
                id: DEFAULT_LOCAL_CHAT_MODEL_ID.to_owned(),
                weight_url: DEFAULT_LOCAL_CHAT_MODEL_URL.to_owned(),
                sha256: DEFAULT_LOCAL_CHAT_MODEL_SHA256.to_owned(),
            },
            providers: Vec::new(),
            strategies: Vec::new(),
            default_agent_id: DEFAULT_AGENT_ID.to_owned(),
        }
    }
}

impl ProviderRegistry {
    /// Resolve the RAG strategy for a given Space.
    ///
    /// Priority - highest first:
    /// 1. Explicit per-Space `retrieval_mode` column value (when `space_mode`
    ///    is `Some` and not empty)
    /// 2. Registry default (`rag_strategy` field, driven by `RYU_RAG_STRATEGY`
    ///    env var or `registry.json` `rag_strategy` key)
    /// 3. Built-in literal `DEFAULT_RAG_STRATEGY` ("vector")
    pub fn resolve_rag_strategy<'a>(&'a self, space_mode: Option<&'a str>) -> &'a str {
        if let Some(m) = space_mode.filter(|s| !s.is_empty()) {
            return m;
        }
        self.rag_strategy.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes every test that reads or mutates the process-global registry
    /// env vars (all consumed by `ProviderRegistry::from_env`). cargo runs tests
    /// in one process in parallel, so two `from_env` tests can otherwise read each
    /// other's transient overrides. Poison-tolerant.
    static REGISTRY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_registry_env() -> std::sync::MutexGuard<'static, ()> {
        REGISTRY_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    const REGISTRY_ENV: &[&str] = &[
        "RYU_EMBED_MODEL",
        "RYU_EMBED_DIMS",
        "RYU_RERANKER_MODEL",
        "RYU_DEFAULT_LLM_BASE_URL",
        "RYU_DEFAULT_LLM_MODEL",
        "RYU_LOCAL_CHAT_MODEL_ID",
        "RYU_LOCAL_CHAT_MODEL_URL",
        "RYU_LOCAL_CHAT_MODEL_SHA256",
        "RYU_DEFAULT_AGENT",
    ];

    /// Snapshot + clear the registry env vars, restoring them on drop so a test
    /// that mutates process env never leaks into the others.
    struct RegistryEnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
    }
    impl RegistryEnvGuard {
        fn capture() -> Self {
            let saved = REGISTRY_ENV
                .iter()
                .map(|n| (*n, std::env::var(n).ok()))
                .collect();
            for n in REGISTRY_ENV {
                std::env::remove_var(n);
            }
            Self { saved }
        }
    }
    impl Drop for RegistryEnvGuard {
        fn drop(&mut self) {
            for (n, v) in &self.saved {
                match v {
                    Some(val) => std::env::set_var(n, val),
                    None => std::env::remove_var(n),
                }
            }
        }
    }

    #[test]
    fn defaults_are_spec_models() {
        let reg = ProviderRegistry::default();
        assert_eq!(reg.embedder.id, "nomic-embed-text-v1.5");
        assert_eq!(reg.embedder.dims, 768);
        assert_eq!(reg.embed_base_url, DEFAULT_EMBED_BASE_URL);
        assert_eq!(reg.local_embed_model.id, DEFAULT_LOCAL_EMBED_MODEL_ID);
        assert!(reg
            .local_embed_model
            .weight_url
            .contains("nomic-embed-text"));
        assert!(!reg.local_embed_model.sha256.is_empty());
        assert_eq!(reg.reranker.id, "BAAI/bge-reranker");
        assert_eq!(reg.default_llm_base_url, DEFAULT_LLM_BASE_URL);
        assert_eq!(reg.default_llm_model, DEFAULT_LLM_MODEL);
    }

    #[test]
    fn default_local_chat_model_is_set() {
        let reg = ProviderRegistry::default();
        assert_eq!(reg.local_chat_model.id, DEFAULT_LOCAL_CHAT_MODEL_ID);
        assert_eq!(reg.local_chat_model.id, "gemma-4-E2B-it-Q4_K_M");
        assert!(!reg.local_chat_model.weight_url.is_empty());
        assert!(reg.local_chat_model.weight_url.contains("gemma-4-E2B"));
        assert!(!reg.local_chat_model.sha256.is_empty());
        // weight_path resolves to ~/.ryu/models/<id>.gguf
        let path = reg.local_chat_model.weight_path();
        assert!(path.to_string_lossy().contains("models"));
        assert!(path.to_string_lossy().ends_with(".gguf"));
    }

    #[test]
    fn from_env_falls_back_to_defaults_when_unset() {
        let _lock = lock_registry_env();
        // Guard clears all registry env vars (the "unset" baseline) and restores.
        let _g = RegistryEnvGuard::capture();
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.embedder.id, DEFAULT_EMBED_MODEL);
        assert_eq!(reg.embedder.dims, DEFAULT_EMBED_DIMS);
        assert_eq!(reg.reranker.id, DEFAULT_RERANKER_MODEL);
        assert_eq!(reg.default_llm_base_url, DEFAULT_LLM_BASE_URL);
        assert_eq!(reg.default_llm_model, DEFAULT_LLM_MODEL);
        assert_eq!(reg.local_chat_model.id, DEFAULT_LOCAL_CHAT_MODEL_ID);
        assert_eq!(
            reg.local_chat_model.weight_url,
            DEFAULT_LOCAL_CHAT_MODEL_URL
        );
        assert_eq!(reg.local_chat_model.sha256, DEFAULT_LOCAL_CHAT_MODEL_SHA256);
    }

    #[test]
    fn from_env_reads_overrides() {
        let _lock = lock_registry_env();
        // Guard restores every registry env var on exit (no manual cleanup leak).
        let _g = RegistryEnvGuard::capture();
        std::env::set_var("RYU_EMBED_MODEL", "custom/embed-model");
        std::env::set_var("RYU_EMBED_DIMS", "512");
        std::env::set_var("RYU_RERANKER_MODEL", "custom/reranker");
        std::env::set_var("RYU_LOCAL_CHAT_MODEL_ID", "my-custom-model");
        std::env::set_var("RYU_LOCAL_CHAT_MODEL_URL", "https://example.com/model.gguf");
        std::env::set_var("RYU_LOCAL_CHAT_MODEL_SHA256", "abc123");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.embedder.id, "custom/embed-model");
        assert_eq!(reg.embedder.dims, 512);
        assert_eq!(reg.reranker.id, "custom/reranker");
        assert_eq!(reg.local_chat_model.id, "my-custom-model");
        assert_eq!(
            reg.local_chat_model.weight_url,
            "https://example.com/model.gguf"
        );
        assert_eq!(reg.local_chat_model.sha256, "abc123");
    }

    #[test]
    fn with_models_sets_fields() {
        let reg = ProviderRegistry::with_models("test/embed", 256, "test/reranker");
        assert_eq!(reg.embedder.id, "test/embed");
        assert_eq!(reg.embedder.dims, 256);
        assert_eq!(reg.reranker.id, "test/reranker");
        // local_chat_model uses the default values
        assert_eq!(reg.local_chat_model.id, DEFAULT_LOCAL_CHAT_MODEL_ID);
    }

    // ── File-backed swap tests (AC3: no recompile, just edit registry.json) ─

    #[test]
    fn from_file_reads_chat_model_override() {
        // env > file precedence, so clear the registry env and serialize against
        // the other from_env/from_file tests to keep the file values authoritative.
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"default_llm_base_url":"https://api.example.com","default_llm_model":"my-custom-model"}"#,
        )
        .unwrap();
        let reg = ProviderRegistry::from_file(&path);
        assert_eq!(reg.default_llm_base_url, "https://api.example.com");
        assert_eq!(reg.default_llm_model, "my-custom-model");
        // Embed/reranker fall back to built-in defaults when not set in the file.
        assert_eq!(reg.embedder.id, DEFAULT_EMBED_MODEL);
        assert_eq!(reg.reranker.id, DEFAULT_RERANKER_MODEL);
    }

    #[test]
    fn from_file_reads_embed_model_override() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"embed_model":"custom/embed-test","embed_dims":512,"reranker_model":"custom/reranker-test"}"#,
        )
        .unwrap();
        let reg = ProviderRegistry::from_file(&path);
        assert_eq!(reg.embedder.id, "custom/embed-test");
        assert_eq!(reg.embedder.dims, 512);
        assert_eq!(reg.reranker.id, "custom/reranker-test");
    }

    #[test]
    fn from_file_reads_local_chat_model_override() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"local_chat_model_id":"my-gguf","local_chat_model_url":"https://example.com/my.gguf","local_chat_model_sha256":"deadbeef"}"#,
        )
        .unwrap();
        let reg = ProviderRegistry::from_file(&path);
        assert_eq!(reg.local_chat_model.id, "my-gguf");
        assert_eq!(
            reg.local_chat_model.weight_url,
            "https://example.com/my.gguf"
        );
        assert_eq!(reg.local_chat_model.sha256, "deadbeef");
    }

    #[test]
    fn from_file_handles_absent_file_gracefully() {
        // from_file falls back to env-derived defaults (env > file > literal), so
        // clear the registry env and serialize against the other from_env tests.
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let reg =
            ProviderRegistry::from_file(std::path::Path::new("/nonexistent/path/registry.json"));
        // Must not panic; returns built-in defaults.
        assert_eq!(reg.default_llm_model, DEFAULT_LLM_MODEL);
        assert_eq!(reg.embedder.id, DEFAULT_EMBED_MODEL);
    }

    #[test]
    fn from_file_handles_malformed_json_gracefully() {
        // Reads the env-overridable default_llm_model; clear env + serialize.
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, "not-valid-json").unwrap();
        let reg = ProviderRegistry::from_file(&path);
        // Must not panic; returns built-in defaults.
        assert_eq!(reg.default_llm_model, DEFAULT_LLM_MODEL);
    }

    #[test]
    fn provider_and_strategy_entries_are_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{
              "providers": [{"id":"my-provider","base_url":"https://llm.example.com"}],
              "strategies": [{"id":"rag_strategy","value":"graphrag"}]
            }"#,
        )
        .unwrap();
        let reg = ProviderRegistry::from_file(&path);
        assert_eq!(reg.providers.len(), 1);
        assert_eq!(reg.providers[0].id, "my-provider");
        assert_eq!(reg.strategies.len(), 1);
        assert_eq!(reg.strategies[0].value, "graphrag");
    }

    // ── Default agent id (U041) ───────────────────────────────────────────────

    #[test]
    fn default_agent_id_falls_back_to_ryu() {
        // AC4: the literal default must be "ryu" when no env var / file sets it.
        // Only the flagship Ryu agent is installed by default; all other
        // built-ins are opt-in via the agents catalog.
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        std::env::remove_var("RYU_DEFAULT_AGENT");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.default_agent_id, DEFAULT_AGENT_ID);
        assert_eq!(reg.default_agent_id, "ryu");
    }

    #[test]
    fn default_agent_id_respects_env_var() {
        // AC4: RYU_DEFAULT_AGENT overrides the built-in literal.
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        std::env::set_var("RYU_DEFAULT_AGENT", "acp:claude");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.default_agent_id, "acp:claude");
    }

    #[test]
    fn default_agent_id_reads_from_file() {
        // AC4: registry.json `default_agent_id` field is honoured.
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        std::env::remove_var("RYU_DEFAULT_AGENT");
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"default_agent_id":"acp:gemini"}"#).unwrap();
        let reg = ProviderRegistry::from_file(&path);
        assert_eq!(reg.default_agent_id, "acp:gemini");
    }
}
