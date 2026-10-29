//! Unified provider/model/strategy registry for Ryu Core (spec unit U030).
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): deciding *which*
//! model or provider to use for a given role (embedding, chat, reranker …) is
//! "what runs" (orchestration choice), so this belongs in Core. The Gateway
//! governs *what is allowed/measured/paid* — routing policy and budget
//! enforcement stay there.
//!
//! Every model/provider/strategy default is a swappable config entry loaded
//! from `~/.ryu/state/registry.json` (or `$RYU_REGISTRY_PATH`), falling back to
//! built-in defaults when the file is absent or a field is missing. Environment
//! variables take precedence over file values; the built-in literals are the
//! last-resort fallbacks and are documented as such.
//!
//! # Precedence chain (highest → lowest)
//! 1. Environment variable (e.g. `RYU_DEFAULT_LLM_MODEL`)
//! 2. `~/.ryu/state/registry.json` field (or `$RYU_REGISTRY_PATH`)
//! 3. Built-in literal constant (last-resort fallback, documented below)
//!
//! # Which constructor you use decides whether layer 2 exists at all
//!
//! The chain above is what [`ProviderRegistry::load`] does. It is **not** what
//! [`ProviderRegistry::from_env`] does: that constructor passes `None` down to
//! `from_file_path`, so no file is ever opened and the chain collapses to
//! *env → literal*. Both constructors still have production callers.
//!
//! That used to make "is this `registry.json` field live?" a question with a
//! per-call-site answer, and several fields were live in one subsystem and dead in
//! another. **That is no longer true, and must not become true again.** The file
//! schema is now exactly the set of fields every one of whose consumers uses
//! [`load`](ProviderRegistry::load); every field any `from_env()` consumer reads has
//! had its file key *deleted*, so the two constructors cannot disagree about
//! anything. See `from_env_and_load_agree_on_every_field_a_from_env_consumer_reads`
//! for the guard that keeps it that way.
//!
//! ## The rule that decides which column a field lands in
//!
//! Not "is a per-call file read cheap?" — it always is. The question is
//! **coherence**: does one consumer of this field produce a durable artifact that a
//! *later, different* consumer must match?
//!
//! - **No artifact ⇒ convert the call site to `load()`.** `rag_strategy` is read
//!   once per Space creation and stamped straight into the row; `reranker_model` /
//!   `reranker_base_url` / `graph_extraction_model` are read once, at store open, and
//!   nothing on disk encodes the previous answer. A mutable file re-read cannot
//!   desync anything.
//! - **An artifact ⇒ delete the file key, leave it env-only.** The nine
//!   `local_*_model_{id,url,sha256}` values name a GGUF that
//!   `sidecar::onboarding::install_local_stack` *downloads* at boot and a llama.cpp
//!   sidecar *serves* arbitrarily later; the artifact is `~/.ryu/models/<modality>/<id>.gguf`.
//!   The three `embed_*` values decide the vector space of `spaces.db`,
//!   `retrieval.db` and `message-embeddings.db`; the artifact is the stored vectors
//!   (and, for `embed_dims`, the fixed width of the `chunk_vectors` vec0 table,
//!   which `SpaceStore::open_at` does **not** reconcile — only the separate
//!   embedding-model *preference* path triggers `apply_embedder_change` →
//!   `reindex_all`). Making those file-backed does not fix a dead knob; it builds a
//!   live corruption path.
//!
//! `embed_model` on its own looks convertible — every store tags each row with its
//! `embed_model` and filters search to the current one, so a swap merely hides old
//! content until a reindex. It is env-only anyway because it cannot be split from
//! its companions: a file-settable model id with an env-only `embed_dims` lets an
//! operator select a 1024-dim model that still declares 768 and fails at insert, and
//! a file-settable `embed_base_url` repoints the server *without* changing the model
//! id the per-row filter keys on — incommensurable vectors under one tag, silently.
//!
//! ## The resulting schema
//!
//! - **File-backed (all consumers on `load()`):** `default_agent_id`
//!   (`server::list_agents` / `list_agent_catalog`, `main.rs` first-start install,
//!   `sidecar::onboarding`); `default_llm_base_url` / `default_llm_model` /
//!   `providers` (`sidecar::adapters`); `rag_strategy` (`server::create_space` via
//!   `resolve_new_space_mode`); `reranker_model` / `reranker_base_url` /
//!   `graph_extraction_model` (`server::spaces::open_default` and
//!   `rag_host::open_retrieval_store`, both through [`crate::rag_host::retrieval_registry`]).
//!   `reranker_base_url` carries a profile asterisk — it is file-backed on the
//!   release profile and env-shadowed on every other one; see the `RYU_PROFILE`
//!   section below.
//! - **Env-only (no file key at all):** the three `embed_*` values, all nine
//!   `local_*_model_*` values (chat, embed, rerank, classify). Swap them with the
//!   matching `RYU_*` variable.
//!
//! Nothing is "settable but ignored" any more *on the release profile*, which is why
//! there is no longer a boot-time warning listing divergent fields. On any other
//! profile there is exactly one exception, and it is not a bug — see below.
//!
//! # `RYU_PROFILE` shadows part of this chain (the "I set it and nothing happened" case)
//!
//! [`crate::profile::apply_env_defaults`] runs at the top of `main` and seeds
//! profile-derived defaults into the process environment for every **non-release**
//! profile (`bun dev` defaults to `dev`; the release profile is an early-return
//! no-op). It only sets a variable the operator left unset, so an explicit export
//! still wins — but layer 1 of the precedence chain above is *env*, and the file is
//! layer 2. A variable Core seeded for you therefore outranks your `registry.json`
//! exactly as one you exported would.
//!
//! Of the seven variables `apply_env_defaults` can seed, **two** name a field of this
//! registry — and they are shadowed to different degrees, only one of which is a
//! setting the operator loses:
//!
//! - `RYU_EMBED_BASE_URL` → [`ProviderRegistry::embed_base_url`]. **Not a shadow.**
//!   That field has no `registry.json` key, so the seed has no file layer to
//!   outrank; it only replaces the built-in literal `:8081` with the profile's
//!   `:9081`, which is the whole point — that is where the profile's own
//!   `llamacpp-embed` listens.
//! - `RYU_RERANKER_BASE_URL` → [`ProviderRegistry::reranker_base_url`]. **A real
//!   shadow**, and the only one: the sole file-backed key in this schema whose env
//!   twin the profile sets. `reranker_base_url` in `registry.json` therefore cannot
//!   take effect for any developer on `dev` — correct under env > file, live on
//!   release, inert everywhere else. It also flips the *other* reranker from local
//!   to remote; see [`crate::rag_host::reranker_from_registry`].
//!
//! That is the complete set. The other four defaults (`RYU_BIND`, `RYU_GATEWAY_URL`,
//! `GATEWAY_CONFIG`, and `RYU_SHADOW_URL`) leave this schema
//! alone. `RYU_DIR` is resolved separately and is not seeded.
//! `registry_env_keys_shadowed_by_the_profile_defaults` checks the actual startup
//! default plan and fails if a future seed lands on
//! another registry key — because the failure mode of that edit is a `registry.json`
//! key that goes quietly dead for everyone running a dev stack, with no error
//! anywhere.
//!
//! ## Second-order: the file the chain reads is itself profile-relative
//!
//! [`registry_path`] falls back to `crate::paths::ryu_dir()`, and
//! `paths::default_ryu_dir()` is suffixed by the profile (`.ryu{suffix}`) *on its
//! own*, so unsetting `RYU_DIR` does not restore `~/.ryu` under `dev`.
//! (`paths::resolve` also consults a data-dir pointer file between the env var and
//! that default.) So on the `dev` profile every key in this schema is read from
//! `~/.ryu-dev/state/registry.json`. Editing `~/.ryu/state/registry.json` and seeing nothing
//! change is the expected outcome, not a dead key.
//!
//! # API keys
//! API keys are intentionally **not** stored in `registry.json`. Keep them in
//! environment variables (`RYU_DEFAULT_LLM_API_KEY` / `OPENAI_API_KEY`).
//! `registry.json` is config, not a secrets file.

use std::path::PathBuf;

use ryu_sidecar_runtime::layout::{self, Modality};
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

/// Default local embedding model id (storage key + filename stem in `models/embedding/`).
///
/// nomic-embed-text-v1.5 Q4_K_M from nomic-ai — publicly accessible without HF
/// authentication, ~84 MB, CPU-friendly. Served by the `llamacpp-embed` sidecar.
pub const DEFAULT_LOCAL_EMBED_MODEL_ID: &str = "nomic-embed-text-v1.5.Q4_K_M";

/// Default local embedding model weight URL. Override via `RYU_LOCAL_EMBED_MODEL_URL`.
///
/// # Why every default weight URL pins a commit revision, never `main`
///
/// A `/resolve/main/` URL and a hardcoded `*_SHA256` next to it are a contradiction:
/// the URL tracks whatever the upstream repo's default branch points at *today*,
/// while the checksum is frozen at whatever it pointed at when the const was
/// written. The moment upstream re-uploads a quant, every fresh install fails the
/// download with `checksum mismatch: expected … got …` and the model is
/// permanently unobtainable — the retry path re-fetches the same new bytes and
/// fails again. That is not hypothetical: it is exactly what happened to
/// [`DEFAULT_LOCAL_CHAT_MODEL_URL`] (Gemma), and it is the reason all five of
/// these now carry a 40-hex commit sha instead.
///
/// `/resolve/<commit-sha>/` is a permalink on the HF CDN, so URL and checksum move
/// together or not at all. When bumping a model, change the revision AND the
/// checksum in the same edit; read the new value from
/// `POST /api/models/<repo>/paths-info/<rev>` → `[0].lfs.oid` (the LFS oid IS the
/// sha256 of the file's contents; the top-level `oid` is a git blob hash and is
/// NOT what the downloader compares against).
pub const DEFAULT_LOCAL_EMBED_MODEL_URL: &str =
    "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/0188c9bf409793f810680a5a431e7b899c46104c/nomic-embed-text-v1.5.Q4_K_M.gguf";

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

/// Default local reranker model id (storage key + filename stem in `models/rerank/`).
///
/// BAAI bge-reranker-v2-m3, Q4_K_M (via the gpustack GGUF conversion) — a
/// multilingual cross-encoder reranker, ~438 MB, CPU-friendly and publicly
/// reachable without HF authentication. Served by the `llamacpp-rerank` sidecar.
pub const DEFAULT_LOCAL_RERANKER_MODEL_ID: &str = "bge-reranker-v2-m3.Q4_K_M";

/// Default local reranker weight URL. Override via `RYU_LOCAL_RERANKER_MODEL_URL`.
/// Pinned to a commit revision — see [`DEFAULT_LOCAL_EMBED_MODEL_URL`].
pub const DEFAULT_LOCAL_RERANKER_MODEL_URL: &str =
    "https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/3093af03b1a635e67b084b1d8c03c5f5e020fd05/bge-reranker-v2-m3-Q4_K_M.gguf";

/// SHA-256 of the default reranker GGUF (from the HF LFS oid / `x-linked-etag`).
/// Override via `RYU_LOCAL_RERANKER_MODEL_SHA256` (empty string skips verification).
pub const DEFAULT_LOCAL_RERANKER_MODEL_SHA256: &str =
    "e186a244ed455b4ab66ec64339ce7427a6ae13f5c0b5e544de96e50f0f8b3673";

/// Default local **classifier** model id (storage key + filename stem in
/// `models/classifier/`).
///
/// Gemma 3 270M IT, QAT Q4_0 (the `ggml-org` conversion) — a 270M
/// instruction-tuned model, ~241 MB, CPU-friendly and publicly reachable without
/// HF authentication. Served by the `llamacpp-classify` sidecar as the cheap
/// **classify tier**.
///
/// This exists because the gateway's two guardrail consumers — the firewall's
/// cheap-LLM inspector (`firewall.inspector.model`) and smart routing's
/// `classifier_model` — used to resolve any `gemma-*` selection to the gateway's
/// `local` provider, whose single base URL is the **resident chat engine**. One
/// llama-server serves exactly one model, so picking a 270M classifier there
/// silently ran the guardrail on the user's full-size chat model. There was no
/// small model to point at; this is it.
pub const DEFAULT_LOCAL_CLASSIFIER_MODEL_ID: &str = "gemma-3-270m-it-qat-Q4_0";

/// Default local classifier weight URL. Override via `RYU_LOCAL_CLASSIFIER_MODEL_URL`.
/// Pinned to a commit revision — see [`DEFAULT_LOCAL_EMBED_MODEL_URL`].
pub const DEFAULT_LOCAL_CLASSIFIER_MODEL_URL: &str =
    "https://huggingface.co/ggml-org/gemma-3-270m-it-qat-GGUF/resolve/7dba9faa7cdb58c7dc44b238c7dbb00e391fbf65/gemma-3-270m-it-qat-Q4_0.gguf";

/// SHA-256 of the default classifier GGUF (241 410 624 bytes; verified reachable
/// without HF authentication). Override via `RYU_LOCAL_CLASSIFIER_MODEL_SHA256`
/// (empty string skips verification).
pub const DEFAULT_LOCAL_CLASSIFIER_MODEL_SHA256: &str =
    "3626e245220ca4a1c5911eb4010b3ecb7bdbf5bc53c79403c21355354d1e2dc6";

/// Default local guard model id (storage key and filename stem in
/// `models/classifier/`). Qwen3Guard-Gen 0.6B, Q4_K_M, served by the opt-in
/// `llamacpp-guard` sidecar as a node-tier hazard screener backend in the
/// Qwen3Guard dialect. Apache-2.0 and ungated, unlike Llama Guard. It does not
/// cover `hazard.S4`, so it never qualifies alone for the platform floor; on a
/// node, which Ryu's floor never binds, it is one opinion beside the decision
/// model. Override via `RYU_LOCAL_GUARD_MODEL_ID`.
pub const DEFAULT_LOCAL_GUARD_MODEL_ID: &str = "qwen3guard-gen-0.6b-q4_k_m";

/// Default local guard model weight URL, pinned to a repository revision so the
/// checksum stays valid. Override via `RYU_LOCAL_GUARD_MODEL_URL`.
pub const DEFAULT_LOCAL_GUARD_MODEL_URL: &str =
    "https://huggingface.co/mradermacher/Qwen3Guard-Gen-0.6B-GGUF/resolve/2a59799e089fba3807d534a89c6b95bdf38ee76a/Qwen3Guard-Gen-0.6B.Q4_K_M.gguf";

/// SHA-256 of the default guard GGUF (484,220,416 bytes), from the Hugging Face
/// LFS oid at the pinned revision. Override via `RYU_LOCAL_GUARD_MODEL_SHA256`.
/// It is also the weights hash Core publishes for the screener backend, so a
/// qualification record and the screener cache pin these exact weights.
pub const DEFAULT_LOCAL_GUARD_MODEL_SHA256: &str =
    "2e73a1411746e6dbd8a71b4d22dc66369044283f433b81ed6e4006cab4af9859";

/// The local guard model: the GGUF the opt-in `llamacpp-guard` sidecar serves.
///
/// Env-only, like the classifier entry and for the same reason: the sidecar
/// (which downloads and serves the file) and the Gateway spawn env (which
/// publishes its id and hash) read it at different moments and must agree, so
/// the answer is frozen per process. Unlike the classifier, onboarding never
/// downloads it: the guard tier is off by default, and the sidecar fetches its
/// weights only after the operator opts in.
pub fn local_guard_model() -> LocalModelEntry {
    LocalModelEntry {
        modality: Modality::Classifier,
        id: env_or_file_or_literal(
            "RYU_LOCAL_GUARD_MODEL_ID",
            None,
            DEFAULT_LOCAL_GUARD_MODEL_ID,
        ),
        weight_url: env_or_file_or_literal(
            "RYU_LOCAL_GUARD_MODEL_URL",
            None,
            DEFAULT_LOCAL_GUARD_MODEL_URL,
        ),
        sha256: std::env::var("RYU_LOCAL_GUARD_MODEL_SHA256")
            .ok()
            .unwrap_or_else(|| DEFAULT_LOCAL_GUARD_MODEL_SHA256.to_owned()),
    }
}

/// Default local Speech Processing model id (storage key + filename stem in
/// `models/chat/`). S1-mini by Superwhisper is a 0.6B Q4_K_M text normalizer
/// for raw speech-recognition transcripts. It is not a chat model: the
/// dedicated `llamacpp-speech` sidecar serves it only for post-ASR cleanup.
pub const DEFAULT_LOCAL_SPEECH_MODEL_ID: &str = "s1-mini-q4_k_m";

/// Default local Speech Processing model weight URL. Override with
/// `RYU_LOCAL_SPEECH_MODEL_URL`. The revision is pinned so the checksum remains
/// valid if the upstream repository changes its default branch.
pub const DEFAULT_LOCAL_SPEECH_MODEL_URL: &str =
    "https://huggingface.co/superwhisper/s1-mini-GGUF/resolve/ee2c0f56e56345f475749a44ff2893e21c3cb292/s1-mini-q4_k_m.gguf";

/// SHA-256 of S1-mini Q4_K_M (484,219,808 bytes), from the Hugging Face LFS oid.
/// Override with `RYU_LOCAL_SPEECH_MODEL_SHA256`; an empty value disables
/// verification, like the other local model overrides.
pub const DEFAULT_LOCAL_SPEECH_MODEL_SHA256: &str =
    "3b41ebe2502cbd03e811d5d16b022f5ab551eda58d62597d152f89535003c634";
/// Last-resort fallback: default chat provider base URL.
pub const DEFAULT_LLM_BASE_URL: &str = "https://api.openai.com";
/// Last-resort fallback: default chat model id.
pub const DEFAULT_LLM_MODEL: &str = "gpt-4o-mini";
/// Last-resort fallback: RAG strategy (vector | graph). Selects which retrieval
/// algorithm a **newly created** Space is stamped with when the creator does not
/// name one — see [`ProviderRegistry::resolve_rag_strategy`] for why the node-wide
/// default is a creation-time input and not a query-time fallback.
pub const DEFAULT_RAG_STRATEGY: &str = "vector";
/// Supported graph-extraction implementation id. Core currently ships the
/// deterministic offline `local-cooccurrence` extractor. Any other configured id
/// is rejected when the Spaces store opens instead of being silently ignored.
pub const DEFAULT_GRAPH_EXTRACTION_MODEL: &str = "local-cooccurrence";

/// Default local chat model id (storage key + filename stem in `models/chat/`).
///
/// Gemma 4 E2B IT Q4_K_M from unsloth — publicly accessible without HF authentication,
/// ~3.1 GB, runs well on modest hardware. Validated as publicly reachable via git-lfs
/// redirect at https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF (HTTP 302 → 200,
/// no auth required).
pub const DEFAULT_LOCAL_CHAT_MODEL_ID: &str = "gemma-4-E2B-it-Q4_K_M";

/// The agent id auto-installed and enabled on first Core start (U041).
///
/// Override via `RYU_DEFAULT_AGENT` env var or `"default_agent_id"` in
/// `~/.ryu/state/registry.json`. The literal fallback is `"ryu"` — the flagship
/// Pi + Gateway agent is the only agent installed by default. Every other
/// built-in (Claude Code, Codex, Gemini CLI, Pi, OpenClaw, …) is opt-in via
/// the agents catalog (onboarding detects which CLIs the user already has and
/// lets them add the matching agent). `ryu` manages its own Pi binary, so it
/// is self-sufficient and never depends on the user having Pi on PATH.
pub const DEFAULT_AGENT_ID: &str = "ryu";

/// Default local chat model weight URL. Override via `RYU_LOCAL_CHAT_MODEL_URL`.
///
/// **Pinned to a commit revision, not `main`** — see the note on
/// [`DEFAULT_LOCAL_EMBED_MODEL_URL`]. This is the const that proved the point: it
/// pointed at `/resolve/main/`, unsloth re-uploaded the GGUF, and every fresh
/// install then failed the download with
/// `checksum mismatch: expected 9378bc47… got 740185b2…` — the default chat model,
/// unusable, with no way for a user to tell that upstream had moved.
pub const DEFAULT_LOCAL_CHAT_MODEL_URL: &str =
    "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/0314792d7f1f7e229411f620751375812bb9faf2/gemma-4-E2B-it-Q4_K_M.gguf";

/// SHA-256 of the default GGUF weight, as published at the pinned revision above
/// (HF `paths-info` → `lfs.oid`).
/// Override via `RYU_LOCAL_CHAT_MODEL_SHA256` (use empty string to skip verification).
pub const DEFAULT_LOCAL_CHAT_MODEL_SHA256: &str =
    "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8";

/// Size of the default chat GGUF at the pinned revision (HF `x-linked-size`).
/// It needs about 5.0 GiB of system RAM on the CPU (`system_ram_need_bytes`).
pub const DEFAULT_LOCAL_CHAT_MODEL_BYTES: u64 = 3_106_738_272;

/// Smaller chat default for machines whose RAM cannot hold
/// [`DEFAULT_LOCAL_CHAT_MODEL_ID`]: Gemma 3 1B IT Q4_K_M (the `ggml-org`
/// conversion, ungated), ~0.8 GB, needing about 2.4 GiB of RAM. Chosen by
/// [`local_chat_default_for`]; same family and chat template as the main
/// default, text-only (no vision adapter).
pub const FALLBACK_LOCAL_CHAT_MODEL_ID: &str = "gemma-3-1b-it-Q4_K_M";

/// Pinned to a commit revision — see [`DEFAULT_LOCAL_CHAT_MODEL_URL`].
pub const FALLBACK_LOCAL_CHAT_MODEL_URL: &str =
    "https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF/resolve/f9c28bcd85737ffc5aef028638d3341d49869c27/gemma-3-1b-it-Q4_K_M.gguf";

/// SHA-256 of the fallback chat GGUF (HF tree API `lfs.oid` at the pinned
/// revision).
pub const FALLBACK_LOCAL_CHAT_MODEL_SHA256: &str =
    "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135";

/// Size of the fallback chat GGUF (806 058 240 bytes, HF `lfs.size`).
pub const FALLBACK_LOCAL_CHAT_MODEL_BYTES: u64 = 806_058_240;

/// One built-in local chat default: `(id, weight URL, SHA-256)` plus its size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalChatDefault {
    pub id: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

pub const MAIN_LOCAL_CHAT_DEFAULT: LocalChatDefault = LocalChatDefault {
    id: DEFAULT_LOCAL_CHAT_MODEL_ID,
    url: DEFAULT_LOCAL_CHAT_MODEL_URL,
    sha256: DEFAULT_LOCAL_CHAT_MODEL_SHA256,
    bytes: DEFAULT_LOCAL_CHAT_MODEL_BYTES,
};

pub const FALLBACK_LOCAL_CHAT_DEFAULT: LocalChatDefault = LocalChatDefault {
    id: FALLBACK_LOCAL_CHAT_MODEL_ID,
    url: FALLBACK_LOCAL_CHAT_MODEL_URL,
    sha256: FALLBACK_LOCAL_CHAT_MODEL_SHA256,
    bytes: FALLBACK_LOCAL_CHAT_MODEL_BYTES,
};

/// The built-in chat default for a node: the main default unless the node's
/// RAM is known to be too small for it on the CPU (`fits_in_system_ram` —
/// weights × 1.2 + 1.5 GiB, ~5.0 GiB for Gemma 4 E2B), then the 1B fallback.
/// Unknown hardware (`None`, or RAM undetectable) keeps the main default.
pub fn local_chat_default_for(
    device: Option<&crate::model_catalog::device::DeviceInfo>,
) -> LocalChatDefault {
    let too_small = device.is_some_and(|device| {
        crate::model_catalog::device::fits_in_system_ram(DEFAULT_LOCAL_CHAT_MODEL_BYTES, device)
            == Some(false)
    });
    if too_small {
        FALLBACK_LOCAL_CHAT_DEFAULT
    } else {
        MAIN_LOCAL_CHAT_DEFAULT
    }
}

/// The local chat model id this node actually uses: an operator's
/// `RYU_LOCAL_CHAT_MODEL_ID`, else the hardware-chosen built-in default (the 1B
/// fallback on low-RAM nodes). Use this instead of
/// [`DEFAULT_LOCAL_CHAT_MODEL_ID`] wherever a side job needs "the local model",
/// so a fallback node never names a model it doesn't have. `from_env` is right
/// here: the local chat model has no `registry.json` key.
pub fn local_chat_model_id() -> String {
    ProviderRegistry::from_env().local_chat_model.id
}

/// Size of a built-in chat default by id, for the install-time fit check;
/// `None` for an operator-supplied id (an unknown size never blocks).
pub fn local_chat_default_bytes(id: &str) -> Option<u64> {
    [MAIN_LOCAL_CHAT_DEFAULT, FALLBACK_LOCAL_CHAT_DEFAULT]
        .into_iter()
        .find(|default| default.id == id)
        .map(|default| default.bytes)
}

/// Why this node got the fallback chat default, as one sentence with the real
/// numbers; `None` when it gets the main default.
pub fn local_chat_fallback_reason(
    device: &crate::model_catalog::device::DeviceInfo,
) -> Option<String> {
    use crate::model_catalog::device::{human_bytes, system_ram_need_bytes};
    (local_chat_default_for(Some(device)) == FALLBACK_LOCAL_CHAT_DEFAULT).then(|| {
        format!(
            "This computer has {} of memory, too little for the default Gemma 4 E2B chat model \
             (it needs about {}), so the smaller Gemma 3 1B ({}) was installed instead.",
            device.ram_human,
            human_bytes(system_ram_need_bytes(DEFAULT_LOCAL_CHAT_MODEL_BYTES)),
            human_bytes(FALLBACK_LOCAL_CHAT_MODEL_BYTES),
        )
    })
}

/// The hardware the chat default is picked for: this node's, probed once per
/// process (the same cache the llama.cpp variant pick uses, so the id is stable
/// for the process lifetime — see [`LocalModelEntry`]). Under `cfg(test)` it is
/// unknown, so every test sees the main default regardless of the CI machine.
#[cfg(not(test))]
fn chat_default_device() -> Option<&'static crate::model_catalog::device::DeviceInfo> {
    Some(crate::sidecar::providers::llamacpp::variant::device())
}

#[cfg(test)]
fn chat_default_device() -> Option<&'static crate::model_catalog::device::DeviceInfo> {
    None
}

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

// NOTE: there was a `StrategyEntry` type and a `strategies: Vec<StrategyEntry>`
// field here. Both are gone. Nothing ever read an entry's `value` — the array was
// parsed, stored, and then only *counted* (`main.rs` logged `strategies_count`), so
// it was a settable value that could not take effect, plus a boot line advertising
// it. Worse, the type's own example was `{ id: "rag_strategy", value: "graphrag" }`,
// which names the same key as the live top-level `rag_strategy` field: an operator
// following it wrote `{"strategies":[{"id":"rag_strategy","value":"graph"}]}`, got a
// file that parsed cleanly, and every Space was still created as `vector`. The live
// knob is the top-level `"rag_strategy"` key — see
// [`ProviderRegistry::resolve_rag_strategy`]. Do not re-add a forward-looking schema
// slot with no reader; add the reader first.

/// Entry for a local GGUF weight file (chat model downloaded for llama.cpp).
///
/// The download URL and expected SHA-256 are read from the registry so the bundled
/// model is swappable without recompiling.
/// Zero-setup headline: the default URL is publicly accessible without any API key.
///
/// # Swappable via `RYU_LOCAL_*_MODEL_{ID,URL,SHA256}` env vars **only**
///
/// `RegistryFile` deliberately carries no `local_*_model_*` key — not for chat, not
/// for embed, not for rerank, not for classify. Writing one into `registry.json`
/// parses (serde ignores unknown fields) and changes nothing, by design; the env var
/// is the swap seam.
///
/// The keys used to exist, and that was the bug. `sidecar::onboarding`
/// (which resolves the URL + SHA-256 to *fetch*) and every
/// `sidecar::providers::llamacpp` process launcher (which resolves `weight_path()`
/// to *serve*) build with [`ProviderRegistry::from_env`], so an operator who
/// redirected `local_chat_model_url` in the file still downloaded the built-in
/// weight, with no error — a settable value that could not take effect.
///
/// They were deleted rather than wired up because these three triples are the
/// textbook artifact case (see the module header). The download happens once, in a
/// background task at boot; the serve happens arbitrarily later, when a sidecar is
/// lazily started; `model_catalog_host::default_model_repos` and
/// `server::get_active_model` *report* the id to clients later still. A mutable file
/// re-read per call lets an operator desync those moments mid-session: the sidecar
/// looks for a GGUF nobody downloaded, refuses to start, and the error blames
/// onboarding. Freezing the answer per process — which is what `from_env` does —
/// makes all of them agree by construction.
///
/// Fixing it "properly" therefore means unifying the consumers onto ONE
/// process-lifetime resolution first (a `OnceLock`, or a value threaded from boot),
/// not sprinkling `load()` calls. Until someone does that, do not re-add the keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalModelEntry {
    /// Model identifier used to name the file in `models/<modality>/` and in
    /// the version store (e.g. `"gemma-3-1b-it-Q4_K_M"`).
    pub id: String,
    /// Which `models/<modality>/` folder the weight lives in. Fixed per registry
    /// slot (chat and Speech Processing → `chat`, embedder → `embedding`,
    /// reranker → `rerank`, classifier → `classifier`) and kept in step with
    /// `model_catalog::gguf_modality_for_role`, which picks the download
    /// destination for the same weight.
    pub modality: Modality,
    /// Direct HTTPS URL to the GGUF file. Must be publicly reachable without
    /// authentication (zero-setup headline: works with no API key).
    pub weight_url: String,
    /// Expected SHA-256 hex digest for the downloaded GGUF file. Empty string
    /// disables verification (not recommended for production).
    pub sha256: String,
}

impl LocalModelEntry {
    /// Resolved path for this weight: `<data dir>/models/<modality>/<id>.gguf`.
    pub fn weight_path(&self) -> PathBuf {
        layout::models_dir(&crate::paths::ryu_dir(), self.modality)
            .join(format!("{}.gguf", self.id))
    }
}

// ── File-backed config (registry.json) ───────────────────────────────────────

/// Raw JSON shape of `~/.ryu/state/registry.json` (or `$RYU_REGISTRY_PATH`).
/// All fields are optional so a partial file is always valid — missing fields
/// fall through to env vars, then to built-in literals.
///
/// # Every field here is read by consumers that all use [`ProviderRegistry::load`]
///
/// That is the invariant, not a coincidence, and it is what makes the per-field
/// "or `registry.json`" phrasing elsewhere in this module true rather than
/// aspirational. Adding a key whose consumers build with
/// [`ProviderRegistry::from_env`] re-creates the exact defect this schema was
/// trimmed to remove: a value an operator can set, that parses, and that nothing
/// reads. `from_env_and_load_agree_on_every_field_a_from_env_consumer_reads` fails
/// if you do.
///
/// Deliberately **not** `deny_unknown_fields`: an operator whose file still carries
/// one of the deleted keys must keep booting (the key is inert, exactly as it
/// effectively was before), not have the whole file fail to parse and fail open to
/// defaults — which would silently discard the keys that *do* work.
#[derive(Debug, Default, Deserialize)]
struct RegistryFile {
    /// Default chat provider base URL (overridden by `RYU_DEFAULT_LLM_BASE_URL`).
    #[serde(default)]
    default_llm_base_url: Option<String>,
    /// Default chat model id (overridden by `RYU_DEFAULT_LLM_MODEL`).
    #[serde(default)]
    default_llm_model: Option<String>,
    // NOTE: there is deliberately no `embed_model` / `embed_dims` /
    // `embed_base_url` here, and no `local_{chat,embed,reranker,classifier}_model_*`
    // triple. All twelve are env-only; the module header carries the artifact
    // argument, and the per-field docs on [`ProviderRegistry::embedder`],
    // [`LocalModelEntry`] and [`ProviderRegistry::local_classifier_model`] carry the
    // specifics. Every one of them was previously a parsed key that no consumer
    // could see, because their consumers build with [`ProviderRegistry::from_env`].
    // Do not re-add one without first converting ALL of that field's consumers to a
    // value resolved ONCE per process — several independent `load()` calls at
    // several different moments is strictly worse than the env-only they replace.
    /// Reranker model id (overridden by `RYU_RERANKER_MODEL`). Read once, at
    /// `rag_host::open_retrieval_store`; reranking persists nothing, so there is no
    /// artifact a later read could desync from.
    ///
    /// "Read" is not "observed": of the two places `open_retrieval_store` puts this
    /// value, only one is a behaviour. See [`ProviderRegistry::reranker`] for the
    /// accounting — the short version is that it names the model in the outbound
    /// `/rerank` request *when the retrieval reranker is remote at all*, and is
    /// otherwise carried unread.
    #[serde(default)]
    reranker_model: Option<String>,
    /// Reranker endpoint base URL (overridden by `RYU_RERANKER_BASE_URL`). Read by
    /// `rag_host::reranker_local_server` — see [`ProviderRegistry::reranker_base_url`]
    /// for which reranker that is and which one ignores it.
    ///
    /// Inert on every non-release profile: `profile::apply_env_defaults` seeds
    /// `RYU_RERANKER_BASE_URL` itself, and env outranks file. See the `RYU_PROFILE`
    /// section of the module header.
    #[serde(default)]
    reranker_base_url: Option<String>,
    /// Default RAG strategy: "vector" | "graph". Overridden by `RYU_RAG_STRATEGY`.
    /// Per-Space `retrieval_mode` column takes precedence over this global default.
    #[serde(default)]
    rag_strategy: Option<String>,
    /// Graph entity-extraction model id (overridden by `RYU_GRAPH_EXTRACTION_MODEL`).
    /// Read once, at `server::spaces::open_default`, and held by the store.
    #[serde(default)]
    graph_extraction_model: Option<String>,
    /// Named provider entries (supplemental; not used by built-in routing yet).
    #[serde(default)]
    providers: Vec<ProviderEntry>,
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
    /// Embedding model used for RAG (Spaces + retrieval): id and output dims.
    ///
    /// # Env-only (`RYU_EMBED_MODEL` / `RYU_EMBED_DIMS`). No `registry.json` key.
    ///
    /// Five consumers read this at two classes of moment — the three stores opened
    /// once at boot (`server::spaces::open_default` → `spaces.db`,
    /// `rag_host::open_retrieval_store` → `retrieval.db`,
    /// `search_host::open_default_message_index` → `message-embeddings.db`) and two
    /// per-use rankers (`tool_registry_host`, `agent_routing::auto`). The artifact is
    /// the stored vectors, and for `dims` specifically the fixed width of the
    /// `chunk_vectors` vec0 table.
    ///
    /// `dims` is the one that makes this env-only rather than convertible.
    /// `SpaceStore::open_at` runs `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors
    /// … float[dims]` and does **not** reconcile a width that no longer matches —
    /// only `apply_embedder_change` → `reindex_all` does, and that fires solely from
    /// the separate embedding-model *preference* path. A file-settable `dims` would
    /// therefore let one edit break every Space insert on the next boot, with the
    /// store reporting healthy. `id` cannot be split from it (a 1024-dim model
    /// declared at 768 fails at insert), and `embed_base_url` cannot either (see its
    /// own doc). So the whole trio stays on env, where changing it is at least a
    /// deliberate act at the same layer as `RYU_LOCAL_EMBED_MODEL_ID`, which selects
    /// the GGUF actually being served.
    pub embedder: ModelEntry,
    /// Base URL of the OpenAI-compatible embeddings endpoint (no `/v1` suffix).
    /// Defaults to the local `llamacpp-embed` server; `RYU_EMBED_BASE_URL` overrides.
    ///
    /// **Env-only, no `registry.json` key** — and for a sharper reason than
    /// [`Self::embedder`]. Every store tags each row with its `embed_model` and
    /// filters search to the current one, so a *model* swap merely hides old content
    /// until a reindex. Repointing the base URL changes which server answers while
    /// leaving that tag unchanged, so vectors from two different backends land under
    /// one id and are compared as though commensurable. No error, just worse results.
    pub embed_base_url: String,
    /// Local embedding model: the GGUF weight served by the dedicated llama.cpp
    /// `--embeddings` instance for zero-setup semantic RAG. Swappable via
    /// `RYU_LOCAL_EMBED_MODEL_{ID,URL,SHA256}` **only** — `registry.json` has no key
    /// for it, because `sidecar::onboarding` downloads the weight and
    /// `llamacpp::embed` serves it at a different moment. See [`LocalModelEntry`].
    pub local_embed_model: LocalModelEntry,
    /// Reranker model used to re-score top-K retrieval candidates.
    ///
    /// File-backed (`reranker_model`), read once by
    /// [`crate::rag_host::open_retrieval_store`] through
    /// [`crate::rag_host::retrieval_registry`] (`load()`). Reranking is a pure
    /// scoring call that persists nothing, so there is no artifact for a later read
    /// to desync from — that is what makes it *convertible*, not what makes it
    /// observable.
    ///
    /// # Exactly one branch observes it — not two
    ///
    /// `open_retrieval_store` puts this value in two places, and only the first is a
    /// behaviour:
    ///
    /// 1. **The remote branch of [`crate::rag_host::reranker_from_registry`].** When
    ///    `RYU_RERANKER_BASE_URL` is set, this id becomes `Reranker::Remote { model }`
    ///    and is sent as `"model"` in the `POST {base}/rerank` body. That is the
    ///    entire observable effect of the `reranker_model` key. The env var is the
    ///    only switch — unset ⇒ `Reranker::Local`, which ignores the id — so on the
    ///    **release** profile this branch is opt-in and off by default, while on
    ///    every **non-release** profile it is unconditionally on, because
    ///    `profile::apply_env_defaults` sets that variable. The key is thus *more*
    ///    live for a developer on `dev` than for a user on release.
    /// 2. **`RetrievalStore`'s `reranker_model_id` field**, passed as the id the
    ///    store "reports". Nothing reports it: `RetrievalStore::reranker_model_id()`
    ///    (`crates/core/rag/src/store/state.rs`) has no caller in this workspace outside that
    ///    crate's own unit test, and neither does its symmetric twin
    ///    `embedder_model_id()`. They are public accessors on the published
    ///    `ryu-rag` crate — API surface for an out-of-workspace consumer, not a live
    ///    read — so do not describe this field as "the id the store reports"; nothing
    ///    downstream of Core surfaces it.
    ///
    /// It is also **not** the id the Spaces reranker uses.
    /// [`crate::rag_host::reranker_local_server`] passes
    /// [`Self::local_reranker_model`]`.id` — a different field, naming the GGUF the
    /// `llamacpp-rerank` sidecar actually serves. Setting `reranker_model` expecting
    /// Space search to change is the mistake this paragraph exists to prevent.
    pub reranker: ModelEntry,
    /// Base URL of the OpenAI-compatible reranker endpoint (no `/v1` suffix).
    /// Defaults to the local `llamacpp-rerank` server.
    ///
    /// # Exactly one reader — say which, because the other reranker ignores it
    ///
    /// [`crate::rag_host::reranker_local_server`] (the Spaces reranker, built in
    /// `server::spaces::open_default`) resolves `RYU_RERANKER_BASE_URL` and falls
    /// back to this field, so `registry.json` reaches it.
    /// [`crate::rag_host::reranker_from_registry`] (the `retrieval.db` reranker) does
    /// **not** consult this field at all: it is opt-in remote, keyed solely on
    /// `RYU_RERANKER_BASE_URL` being set, and stays `Reranker::Local` otherwise.
    /// That asymmetry is deliberate — routing it through this field would silently
    /// flip `retrieval.db` from local term-overlap to always-remote against a server
    /// that is off by default.
    ///
    /// # …and on a non-release profile even that one reader cannot see it
    ///
    /// [`crate::profile::apply_env_defaults`] unconditionally seeds
    /// `RYU_RERANKER_BASE_URL` to the profile's shifted rerank port (`:9082` on
    /// `dev`) for every profile except `release`, and `reranker_local_server` prefers
    /// the env var over this field. `registry.json`'s `reranker_base_url` therefore
    /// takes effect **only on the release profile** — which is to say: not for any
    /// developer running `bun dev`, whose default profile is `dev`. This is correct
    /// under the documented env > file precedence and the key is genuinely live in
    /// release; it is called out because "I set `reranker_base_url` and nothing
    /// happened" has a profile answer, not a wiring answer. Export the variable
    /// yourself (an explicit value beats the seed) or run `RYU_PROFILE=release`.
    ///
    /// It is the **only** file-backed key in this schema with that asterisk; the
    /// module header's `RYU_PROFILE` section carries the whole set and the guard test
    /// that keeps it complete.
    pub reranker_base_url: String,
    /// Local reranker model: the GGUF cross-encoder served by the dedicated
    /// llama.cpp `--reranking` instance for zero-setup neural reranking of Spaces
    /// RAG. Swappable via `RYU_LOCAL_RERANKER_MODEL_{ID,URL,SHA256}` **only** —
    /// `registry.json` has no key for it, because `sidecar::onboarding` downloads the
    /// weight and `llamacpp::rerank` serves it at a different moment (its lazy start
    /// on first Space search, arbitrarily later). See [`LocalModelEntry`].
    pub local_reranker_model: LocalModelEntry,
    /// Local classifier model: the small GGUF served by the dedicated
    /// `llamacpp-classify` llama.cpp instance as the cheap **classify tier** the
    /// gateway's firewall inspector and smart-routing classifier route to. Not a
    /// RAG model — it lives beside the other local-model entries because it is the
    /// same kind of swappable, onboarding-downloaded GGUF default.
    ///
    /// # Env-only. `registry.json` has no key for this, on purpose.
    ///
    /// Swap it with `RYU_LOCAL_CLASSIFIER_MODEL_{ID,URL,SHA256}`. There is no
    /// `local_classifier_model_*` field in [`RegistryFile`], so the file cannot
    /// configure it — and unlike the other env-only entries here, that is a design
    /// decision rather than a `from_env()` call site nobody has converted yet. It
    /// previously *had* those keys while no consumer called [`load`], which is the
    /// worst of both: a settable key that did nothing.
    ///
    /// The reason it must not become file-backed by simply converting its callers:
    /// this triple is read by **three consumers at three different moments in one
    /// process lifetime**, and they must agree or the tier breaks.
    ///
    /// 1. `sidecar::onboarding::install_local_stack` — downloads the GGUF to
    ///    `~/.ryu/models/classifier/<id>.gguf`, once, from a background task at boot.
    /// 2. `sidecar::gateway::classify_model_id` — publishes the id to the gateway
    ///    (`RYU_CLASSIFY_MODEL_ID`) at gateway spawn, *and* re-resolves it on every
    ///    `PUT /v1/config` push to decide whether the pushed config selects this
    ///    tier (`patch_selects_classify_tier`).
    /// 3. `llamacpp::classify` — resolves `weight_path()` when that push lazily
    ///    starts the sidecar, arbitrarily long after (1).
    ///
    /// `from_env()` freezes the answer for the whole process, so all three agree by
    /// construction. `load()` re-reads a mutable file per call, so an operator
    /// editing `registry.json` mid-session would make (2) publish and route an id
    /// whose weight (1) never downloaded; (3) then bails on a missing path, the
    /// tier never starts, and the firewall inspector / smart-routing classifier /
    /// LLM-judge evaluators **fail open** — traffic passes unscanned. Silent, and
    /// security-relevant.
    ///
    /// Contrast `rag_strategy`, which *was* correctly converted to [`load`]: it is
    /// read once per request and immediately stamped into a `spaces` row, so it has
    /// no cross-moment coherence requirement to violate. Same-shaped knob, different
    /// consumption pattern, different correct answer. Making this one file-backed
    /// needs the three consumers unified onto one process-lifetime resolution first
    /// (a `OnceLock`, or a value threaded from boot) — not three `load()` calls.
    ///
    /// This field was the first to be resolved that way. The other four local-model
    /// triples have since joined it on the same argument; see [`LocalModelEntry`].
    pub local_classifier_model: LocalModelEntry,
    /// Local Speech Processing model: the S1-mini GGUF served by the dedicated
    /// `llamacpp-speech` instance for post-ASR cleanup. It is separate from the
    /// Voice Recognition engine: Whisper/Parakeet produce raw text, while this
    /// model formats that text before dictation inserts it.
    ///
    /// Env-only so onboarding, the sidecar, and the model catalog all resolve
    /// one process-lifetime artifact consistently. Use
    /// `RYU_LOCAL_SPEECH_MODEL_{ID,URL,SHA256}` to provide a compatible model.
    pub local_speech_model: LocalModelEntry,
    /// Default RAG strategy for Spaces that have no per-Space `retrieval_mode`
    /// set. One of `"vector"` or `"graph"`. Defaults to `"vector"`.
    /// File-backed (`rag_strategy`) and live — `server::create_space` uses [`load`].
    pub rag_strategy: String,
    /// Graph-extraction implementation id. The value is read from env or
    /// `registry.json`, passed to `SpaceStore`, and validated before the Spaces
    /// database opens. Only `local-cooccurrence` is supported today; other ids fail
    /// startup with an actionable error rather than pretending to select a model.
    pub graph_extraction_model: String,

    // ── Local inference stack ─────────────────────────────────────────────────
    /// Default local chat model: the GGUF weight served by llama.cpp for zero-setup
    /// no-key chat. Swappable via `RYU_LOCAL_CHAT_MODEL_{ID,URL,SHA256}` so users can
    /// swap to any GGUF they prefer without recompiling.
    ///
    /// **Env-only; `registry.json` has no key for it.** It used to have one, which
    /// made this the worst field in the registry: honoured by `pi_config` (`load()`)
    /// and ignored by `sidecar::onboarding` (downloads the weight),
    /// `llamacpp::{mod,process}` (serves it), `model_catalog_host` and
    /// `get_active_model` (report it) — so setting it made the managed Pi declare a
    /// model id that llama.cpp was not serving. Deleting the key is what makes
    /// `pi_config`'s `load()` and everyone else's `from_env()` agree by construction.
    /// See [`LocalModelEntry`].
    pub local_chat_model: LocalModelEntry,

    // ── Supplemental entries ─────────────────────────────────────────────────
    /// Named provider entries loaded from the file (supplemental).
    pub providers: Vec<ProviderEntry>,

    // ── Default agent (U041) ─────────────────────────────────────────────────
    /// Agent id that is auto-installed + enabled on first Core start.
    ///
    /// Resolution: `RYU_DEFAULT_AGENT` env > `default_agent_id` in
    /// `~/.ryu/state/registry.json` > built-in literal `"ryu"`.
    ///
    /// `GET /api/agents` surfaces this id with `"enabled": true` so clients
    /// can badge the default without hard-coding it.
    pub default_agent_id: String,
}

impl ProviderRegistry {
    /// Load the registry from the default path (`$RYU_REGISTRY_PATH` or
    /// `~/.ryu/state/registry.json`) and apply environment-variable overlays.
    ///
    /// Never panics. A missing or malformed file produces the built-in defaults.
    pub fn load() -> Self {
        let path = registry_path();
        Self::from_file_path(path.as_deref())
    }

    /// Load from an explicit file path. **No production caller uses this** — it is
    /// a test/injection helper only.
    ///
    /// That matters when writing tests: a test that proves "`registry.json` field X
    /// takes effect" by calling `from_file` proves nothing about production, because
    /// production reaches the file through [`load`](Self::load) →
    /// [`registry_path`] → `$RYU_REGISTRY_PATH` / `~/.ryu/state/registry.json`. A test of
    /// that shape passed for `rag_strategy` while the shipped path read no file at
    /// all. Prove file-backed behaviour with `load()` + a `RYU_REGISTRY_PATH`
    /// override instead (see `rag_strategy_reads_registry_file_via_load`).
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
        // Embedding trio: env → literal, with `None` where every other file-backed
        // field passes `file.*`. The vector space of three on-disk indexes hangs off
        // these, and `SpaceStore::open_at` does not reconcile a changed vec0 width —
        // see [`ProviderRegistry::embedder`] and [`ProviderRegistry::embed_base_url`].
        let embed_id = env_or_file_or_literal("RYU_EMBED_MODEL", None, DEFAULT_EMBED_MODEL);
        let embed_dims = std::env::var("RYU_EMBED_DIMS")
            .ok()
            .filter(|s| !s.is_empty())
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(DEFAULT_EMBED_DIMS);
        let embed_base_url =
            env_or_file_or_literal("RYU_EMBED_BASE_URL", None, DEFAULT_EMBED_BASE_URL);
        // Local GGUF triples (embed / rerank / chat / classify / speech): env → literal, no
        // file layer. One consumer downloads the weight, another serves it much
        // later — see [`LocalModelEntry`].
        let embed_model_id = env_or_file_or_literal(
            "RYU_LOCAL_EMBED_MODEL_ID",
            None,
            DEFAULT_LOCAL_EMBED_MODEL_ID,
        );
        let embed_model_url = env_or_file_or_literal(
            "RYU_LOCAL_EMBED_MODEL_URL",
            None,
            DEFAULT_LOCAL_EMBED_MODEL_URL,
        );
        let embed_model_sha256 = std::env::var("RYU_LOCAL_EMBED_MODEL_SHA256")
            .ok()
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
            None,
            DEFAULT_LOCAL_RERANKER_MODEL_ID,
        );
        let reranker_model_url = env_or_file_or_literal(
            "RYU_LOCAL_RERANKER_MODEL_URL",
            None,
            DEFAULT_LOCAL_RERANKER_MODEL_URL,
        );
        let reranker_model_sha256 = std::env::var("RYU_LOCAL_RERANKER_MODEL_SHA256")
            .ok()
            .unwrap_or_else(|| DEFAULT_LOCAL_RERANKER_MODEL_SHA256.to_owned());
        let classifier_model_id = env_or_file_or_literal(
            "RYU_LOCAL_CLASSIFIER_MODEL_ID",
            None,
            DEFAULT_LOCAL_CLASSIFIER_MODEL_ID,
        );
        let classifier_model_url = env_or_file_or_literal(
            "RYU_LOCAL_CLASSIFIER_MODEL_URL",
            None,
            DEFAULT_LOCAL_CLASSIFIER_MODEL_URL,
        );
        let classifier_model_sha256 = std::env::var("RYU_LOCAL_CLASSIFIER_MODEL_SHA256")
            .ok()
            .unwrap_or_else(|| DEFAULT_LOCAL_CLASSIFIER_MODEL_SHA256.to_owned());
        let speech_model_id = env_or_file_or_literal(
            "RYU_LOCAL_SPEECH_MODEL_ID",
            None,
            DEFAULT_LOCAL_SPEECH_MODEL_ID,
        );
        let speech_model_url = env_or_file_or_literal(
            "RYU_LOCAL_SPEECH_MODEL_URL",
            None,
            DEFAULT_LOCAL_SPEECH_MODEL_URL,
        );
        let speech_model_sha256 = std::env::var("RYU_LOCAL_SPEECH_MODEL_SHA256")
            .ok()
            .unwrap_or_else(|| DEFAULT_LOCAL_SPEECH_MODEL_SHA256.to_owned());
        let rag_strategy =
            env_or_file_or_literal("RYU_RAG_STRATEGY", file.rag_strategy, DEFAULT_RAG_STRATEGY);
        let graph_extraction_model = env_or_file_or_literal(
            "RYU_GRAPH_EXTRACTION_MODEL",
            file.graph_extraction_model,
            DEFAULT_GRAPH_EXTRACTION_MODEL,
        );

        // The built-in chat default is hardware-tiered (weak machines get the 1B
        // fallback). Any chat override env var means the operator chose the
        // model, so the whole triple then falls back to the main literals.
        let chat_overridden = [
            "RYU_LOCAL_CHAT_MODEL_ID",
            "RYU_LOCAL_CHAT_MODEL_URL",
            "RYU_LOCAL_CHAT_MODEL_SHA256",
        ]
        .iter()
        .any(|key| std::env::var_os(key).is_some());
        let chat_default = if chat_overridden {
            MAIN_LOCAL_CHAT_DEFAULT
        } else {
            local_chat_default_for(chat_default_device())
        };
        let chat_model_id =
            env_or_file_or_literal("RYU_LOCAL_CHAT_MODEL_ID", None, chat_default.id);
        let chat_model_url =
            env_or_file_or_literal("RYU_LOCAL_CHAT_MODEL_URL", None, chat_default.url);
        // SHA256 is special: empty string is a valid value (disables verify), so we
        // preserve it even when empty; the literal default is the known good hash.
        let chat_model_sha256 = std::env::var("RYU_LOCAL_CHAT_MODEL_SHA256")
            .ok()
            .unwrap_or_else(|| chat_default.sha256.to_owned());

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
                modality: Modality::Embedding,
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
                modality: Modality::Rerank,
                id: reranker_model_id,
                weight_url: reranker_model_url,
                sha256: reranker_model_sha256,
            },
            local_classifier_model: LocalModelEntry {
                modality: Modality::Classifier,
                id: classifier_model_id,
                weight_url: classifier_model_url,
                sha256: classifier_model_sha256,
            },
            local_speech_model: LocalModelEntry {
                modality: Modality::Chat,
                id: speech_model_id,
                weight_url: speech_model_url,
                sha256: speech_model_sha256,
            },
            rag_strategy,
            graph_extraction_model,
            local_chat_model: LocalModelEntry {
                modality: Modality::Chat,
                id: chat_model_id,
                weight_url: chat_model_url,
                sha256: chat_model_sha256,
            },
            providers: file.providers,
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

/// Resolve the registry file path: `$RYU_REGISTRY_PATH` or `~/.ryu/state/registry.json`.
///
/// # Under `cfg(test)` the unset case is a temp path, never `~/.ryu`
///
/// [`RegistryEnvGuard`] *clears* `RYU_REGISTRY_PATH`, and in production an unset var
/// means the operator's real `~/.ryu/state/registry.json`. Composed, that pointed guarded
/// tests at the developer's own config file — and worse, it did so for every
/// [`ProviderRegistry::load`] caller in the crate, including ones in other modules'
/// tests that never take [`lock_registry_env`] and so could not know to set the var
/// (`pi_config`'s `default_gateway_model` is the live example).
///
/// The per-test discipline "always positively set `RYU_REGISTRY_PATH`" cannot hold
/// that line: it has to be re-obeyed by every future test, in every module, that
/// happens to reach a `load()` several calls down. So the fallback itself is made
/// hermetic — under test the unset case resolves to a path inside the temp dir that
/// deliberately does not exist, which yields the built-in defaults exactly as a
/// fresh install does. Setting the var still works and is still the way to prove
/// file-backed behaviour; it is just no longer load-bearing for isolation.
///
/// See [`default_registry_path`] for the two definitions of the unset case.
fn registry_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("RYU_REGISTRY_PATH") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    Some(default_registry_path())
}

/// Where [`registry_path`] looks when `RYU_REGISTRY_PATH` is unset: the operator's
/// real config file.
#[cfg(not(test))]
fn default_registry_path() -> PathBuf {
    layout::state_path(&crate::paths::ryu_dir(), "registry.json")
}

/// The `cfg(test)` twin of [`default_registry_path`]: a path in the temp dir that is
/// never created, so an unset `RYU_REGISTRY_PATH` yields the built-in defaults
/// exactly as a fresh install does — rather than whatever is in the developer's
/// `~/.ryu`.
///
/// The process id keeps concurrent `cargo test` invocations from colliding. Nothing
/// ever writes here; the point of the path is that it is absent.
#[cfg(test)]
fn default_registry_path() -> PathBuf {
    std::env::temp_dir().join(format!("ryu-registry-absent-{}.json", std::process::id()))
}

// ── Backward-compat alias (retrieval.rs + existing tests call ModelRegistry) ──

/// Alias kept for backward compatibility. New code should use [`ProviderRegistry`].
pub type ModelRegistry = ProviderRegistry;

impl ProviderRegistry {
    /// Backward-compat constructor mirroring the old `ModelRegistry::from_env()`.
    /// Equivalent to [`ProviderRegistry::load`] except it skips file loading and
    /// reads only env vars + built-in literals.
    ///
    /// # This is not a test-only constructor
    ///
    /// The previous wording here ("used by retrieval tests that set env vars and
    /// expect immediate reflection") was false and cost a bug: it reads as though
    /// production always goes through `load()`, so a new call site can pick
    /// `from_env()` and silently lose the `registry.json` layer. `server::create_space`
    /// did exactly that — `registry.json {"rag_strategy":"graph"}` was inert while
    /// three doc comments promised it worked.
    ///
    /// # It is now safe *because of what its callers read*, not because it is safe
    ///
    /// The remaining production callers are `search_host::CoreSearchEmbedder`,
    /// `model_catalog_host::default_model_repos`, `sidecar::gateway::classify_model_id`,
    /// `sidecar::providers::llamacpp` (`mod`/`process`/`embed`/`rerank`/`classify`/`speech`),
    /// `sidecar::onboarding::install_local_stack`, and `server::get_active_model`.
    /// Every one of them reads **only** fields that have no `registry.json` key at
    /// all — the `embed_*` trio and the five local-GGUF triples — so for them
    /// `from_env()` and [`load`](Self::load) return identical values and the choice
    /// of constructor is not observable. That is the invariant, and
    /// `from_env_and_load_agree_on_every_field_a_from_env_consumer_reads` enforces
    /// it.
    ///
    /// It did not use to hold, and the cost was a class of bug rather than one bug:
    /// `server::create_space` picked `from_env` and `registry.json {"rag_strategy":
    /// "graph"}` was inert while three doc comments promised it worked; the embed
    /// fields were live for the tool ranker and dead for Spaces ingest at the same
    /// time.
    ///
    /// So: prefer [`load`](Self::load) in new code. Reach for `from_env` only when
    /// the fields you read have no file key (say which, at the call site), or when
    /// file loading is genuinely unwanted (a test that must not read the operator's
    /// real `~/.ryu/state/registry.json`). If you need a field that *is* file-backed, use
    /// `load()` — do not add a file key for a field this constructor's callers read.
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

    /// Returns the configured graph extraction implementation id. `SpaceStore`
    /// validates support before using it.
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
                modality: Modality::Embedding,
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
                modality: Modality::Rerank,
                id: DEFAULT_LOCAL_RERANKER_MODEL_ID.to_owned(),
                weight_url: DEFAULT_LOCAL_RERANKER_MODEL_URL.to_owned(),
                sha256: DEFAULT_LOCAL_RERANKER_MODEL_SHA256.to_owned(),
            },
            local_classifier_model: LocalModelEntry {
                modality: Modality::Classifier,
                id: DEFAULT_LOCAL_CLASSIFIER_MODEL_ID.to_owned(),
                weight_url: DEFAULT_LOCAL_CLASSIFIER_MODEL_URL.to_owned(),
                sha256: DEFAULT_LOCAL_CLASSIFIER_MODEL_SHA256.to_owned(),
            },
            local_speech_model: LocalModelEntry {
                modality: Modality::Chat,
                id: DEFAULT_LOCAL_SPEECH_MODEL_ID.to_owned(),
                weight_url: DEFAULT_LOCAL_SPEECH_MODEL_URL.to_owned(),
                sha256: DEFAULT_LOCAL_SPEECH_MODEL_SHA256.to_owned(),
            },
            rag_strategy: DEFAULT_RAG_STRATEGY.to_owned(),
            graph_extraction_model: DEFAULT_GRAPH_EXTRACTION_MODEL.to_owned(),
            local_chat_model: LocalModelEntry {
                modality: Modality::Chat,
                id: DEFAULT_LOCAL_CHAT_MODEL_ID.to_owned(),
                weight_url: DEFAULT_LOCAL_CHAT_MODEL_URL.to_owned(),
                sha256: DEFAULT_LOCAL_CHAT_MODEL_SHA256.to_owned(),
            },
            providers: Vec::new(),
            default_agent_id: DEFAULT_AGENT_ID.to_owned(),
        }
    }
}

impl ProviderRegistry {
    /// Resolve the retrieval strategy to stamp on a Space **at creation time**.
    ///
    /// Priority - highest first:
    /// 1. The mode the creator asked for (`space_mode`, when `Some` and non-empty) —
    ///    i.e. `retrieval_mode` on the `POST /api/spaces` body.
    /// 2. Registry default (`rag_strategy` field: `RYU_RAG_STRATEGY` env var, else
    ///    the `registry.json` `rag_strategy` key — env wins, see
    ///    [`env_or_file_or_literal`]). Both halves are only populated when the
    ///    registry was built with [`ProviderRegistry::load`]; through
    ///    [`ProviderRegistry::from_env`] the file half does not exist, which is why
    ///    `server::create_space` calls `load`.
    /// 3. Built-in literal [`DEFAULT_RAG_STRATEGY`] (`"vector"`), which is what the
    ///    `rag_strategy` field itself falls back to when neither env nor file set it.
    ///
    /// # Why creation time, and not the `space_mode()` search-path fallback
    ///
    /// The obvious-looking wiring — consult this at `SpaceStore::space_mode`, so the
    /// registry default applies to any Space that "has no mode" — cannot work, and
    /// wiring it there would be actively harmful:
    ///
    /// - The `spaces.retrieval_mode` column is `NOT NULL DEFAULT 'vector'`, so every
    ///   real row already carries a mode. `space_mode` only sees `None` when the
    ///   Space does not exist. A fallback there is therefore dead code.
    /// - The only way to make it *not* dead would be to treat the stored `'vector'`
    ///   as "unset" and let the global override it. Then an operator setting
    ///   `RYU_RAG_STRATEGY=graph` would flip every pre-existing Space to
    ///   `graph_search` — against a graph that was never built, because extraction
    ///   is gated on the mode at ingest. Those Spaces would return *nothing* while
    ///   reporting healthy. That is the exact defect class this knob is being fixed
    ///   to avoid.
    ///
    /// So the global default is an input to Space *creation*
    /// (`server::create_space`), and the per-Space column is authoritative
    /// thereafter — per-Space always wins, because once stamped it is the only value
    /// the search path reads. Changing an existing Space is an explicit act with an
    /// explicit consequence: `POST /api/spaces/{id}/retrieval-mode` →
    /// `SpaceStore::set_retrieval_mode`, which rebuilds the graph so the new mode
    /// can actually take effect.
    ///
    /// The returned string is *not* validated here: it may be an operator typo from
    /// env/JSON. The caller parses it with `RetrievalMode::parse` and reports the
    /// bad value rather than silently retrieving with the wrong algorithm.
    pub fn resolve_rag_strategy<'a>(&'a self, space_mode: Option<&'a str>) -> &'a str {
        if let Some(m) = space_mode.filter(|s| !s.is_empty()) {
            return m;
        }
        self.rag_strategy.as_str()
    }
}

// NOTE: `file_fields_their_consumers_ignore` used to live here — a diagnostic that
// compared `load()` against `from_env()` and let `main.rs` name, at boot, which
// `registry.json` fields the running system would ignore. It is deleted because it
// is now structurally dead: every field any `from_env()` consumer reads has had its
// file key removed, so the two constructors can no longer disagree and the function
// could only ever return an empty list.
//
// A diagnostic that always reports "nothing wrong" is the same defect as the one it
// was built to expose. The invariant it approximated is now asserted directly by
// `from_env_and_load_agree_on_every_field_a_from_env_consumer_reads`, which fails at
// compile-and-test time rather than warning an operator at boot. Do not reinstate
// the diagnostic; if a future field genuinely needs a split, fix the split.

// ── Test env plumbing (shared across the crate's test modules) ────────────────
//
// `apps/core` is one crate, so `registry::tests` and `server::…` tests run in the
// same process and share `std::env`. The lock and the guard below therefore live
// at module scope rather than inside `mod tests`: any test anywhere in the crate
// that builds a registry from env or from `RYU_REGISTRY_PATH` must take the *same*
// lock, or it races the tests here and reads their transient overrides.

/// Serializes every test that reads or mutates the process-global registry env
/// vars (consumed by [`ProviderRegistry::from_env`] and, via `RYU_REGISTRY_PATH`,
/// by [`ProviderRegistry::load`]). cargo runs tests in one process in parallel, so
/// two such tests can otherwise observe each other's transient overrides.
/// Poison-tolerant.
#[cfg(test)]
static REGISTRY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire [`REGISTRY_ENV_LOCK`]. `pub(crate)` so `server::mod`'s Space-creation
/// tests — which drive `resolve_new_space_mode`, and so mutate the very same env
/// vars — serialize against this module's tests instead of racing them.
#[cfg(test)]
pub(crate) fn lock_registry_env() -> std::sync::MutexGuard<'static, ()> {
    REGISTRY_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Snapshot + clear the registry env vars, restoring them on drop so a test that
/// mutates process env never leaks into the others.
///
/// **`RYU_REGISTRY_PATH` is cleared too.** Clearing alone used to be worse than
/// useless: an unset var meant the operator's real `~/.ryu/state/registry.json`, so a
/// guarded `load()` test read the developer's config. That hole is now closed in
/// [`registry_path`] itself, which resolves the unset case to a nonexistent temp
/// path under `cfg(test)` — so isolation no longer depends on each test remembering
/// to set the var, which is what made the hole reachable from other modules' tests.
///
/// A test that wants *file-backed* behaviour still sets `RYU_REGISTRY_PATH`
/// positively, to a written temp file — that is the only way to exercise the file
/// layer, and it is what `rag_strategy_reads_registry_file_via_load` does.
#[cfg(test)]
pub(crate) struct RegistryEnvGuard {
    saved: Vec<(&'static str, Option<String>)>,
}

#[cfg(test)]
impl RegistryEnvGuard {
    pub(crate) fn capture() -> Self {
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

#[cfg(test)]
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

#[cfg(test)]
const REGISTRY_ENV: &[&str] = &[
    "RYU_EMBED_MODEL",
    "RYU_EMBED_DIMS",
    // Listed since the embed trio became env-only: the guard test that asserts
    // `registry.json` cannot move these has to start from a known-clear baseline, or
    // a developer's exported `RYU_EMBED_BASE_URL` would make it pass for the wrong
    // reason (env wins over file in BOTH constructors, so a set var hides a
    // reinstated file key).
    "RYU_EMBED_BASE_URL",
    "RYU_RERANKER_MODEL",
    "RYU_RERANKER_BASE_URL",
    "RYU_GRAPH_EXTRACTION_MODEL",
    "RYU_DEFAULT_LLM_BASE_URL",
    "RYU_DEFAULT_LLM_MODEL",
    "RYU_LOCAL_CHAT_MODEL_ID",
    "RYU_LOCAL_CHAT_MODEL_URL",
    "RYU_LOCAL_CHAT_MODEL_SHA256",
    "RYU_LOCAL_EMBED_MODEL_ID",
    "RYU_LOCAL_EMBED_MODEL_URL",
    "RYU_LOCAL_EMBED_MODEL_SHA256",
    "RYU_LOCAL_RERANKER_MODEL_ID",
    "RYU_LOCAL_RERANKER_MODEL_URL",
    "RYU_LOCAL_RERANKER_MODEL_SHA256",
    "RYU_LOCAL_CLASSIFIER_MODEL_ID",
    "RYU_LOCAL_CLASSIFIER_MODEL_URL",
    "RYU_LOCAL_CLASSIFIER_MODEL_SHA256",
    "RYU_LOCAL_SPEECH_MODEL_ID",
    "RYU_LOCAL_SPEECH_MODEL_URL",
    "RYU_LOCAL_SPEECH_MODEL_SHA256",
    "RYU_DEFAULT_AGENT",
    // Listed so the `resolve_rag_strategy` precedence tests below are hermetic:
    // this knob now has a production consumer (`server::create_space`), so a
    // leaked value would change what mode a Space is created with.
    "RYU_RAG_STRATEGY",
    // The file half of the same knob. Cleared here so nothing inherits a stray
    // override; the cleared state is safe because `registry_path` resolves an unset
    // var to a nonexistent temp path under `cfg(test)` rather than to the operator's
    // real `~/.ryu/state/registry.json`.
    "RYU_REGISTRY_PATH",
];

#[cfg(test)]
mod tests {
    use super::*;

    /// Every default weight URL must be pinned to an immutable commit revision.
    ///
    /// A `/resolve/main/` URL paired with a frozen `*_SHA256` const is a live
    /// time-bomb: it keeps working right up until upstream re-uploads the quant,
    /// and then it fails FOREVER — `finalize` compares the fresh bytes against the
    /// stale const, rejects them, and every retry re-downloads the same new bytes
    /// and fails identically. There is no self-healing path and nothing in the
    /// error points at the real cause (upstream moved), so it reads as a corrupt
    /// download to everyone who hits it.
    ///
    /// It is not hypothetical — this test exists because the default chat model
    /// (Gemma) sat broken in exactly this state: pinned `9378bc47…`, upstream
    /// serving `740185b2…`. The five consts are checked together because the bug
    /// is a property of the URL SHAPE, not of any one model.
    ///
    /// If this fails on a URL you just edited: keep `/resolve/<40-hex-commit>/`
    /// and re-read the checksum from
    /// `POST /api/models/<repo>/paths-info/<rev>` → `[0].lfs.oid`.
    #[test]
    fn every_default_weight_url_is_pinned_to_a_commit_not_a_branch() {
        for (name, url, sha) in [
            (
                "embed",
                DEFAULT_LOCAL_EMBED_MODEL_URL,
                DEFAULT_LOCAL_EMBED_MODEL_SHA256,
            ),
            (
                "reranker",
                DEFAULT_LOCAL_RERANKER_MODEL_URL,
                DEFAULT_LOCAL_RERANKER_MODEL_SHA256,
            ),
            (
                "classifier",
                DEFAULT_LOCAL_CLASSIFIER_MODEL_URL,
                DEFAULT_LOCAL_CLASSIFIER_MODEL_SHA256,
            ),
            (
                "chat",
                DEFAULT_LOCAL_CHAT_MODEL_URL,
                DEFAULT_LOCAL_CHAT_MODEL_SHA256,
            ),
            (
                "speech",
                DEFAULT_LOCAL_SPEECH_MODEL_URL,
                DEFAULT_LOCAL_SPEECH_MODEL_SHA256,
            ),
        ] {
            let Some((_, tail)) = url.split_once("/resolve/") else {
                panic!("{name} weight URL is not an HF resolve URL: {url}");
            };
            let Some((revision, _)) = tail.split_once('/') else {
                panic!("{name} weight URL has no revision segment: {url}");
            };
            assert!(
                revision.len() == 40 && revision.chars().all(|c| c.is_ascii_hexdigit()),
                "{name} weight URL must pin a 40-hex commit revision, not the mutable \
                 '{revision}' — a moving ref plus a frozen checksum breaks the download \
                 permanently the next time upstream re-uploads: {url}"
            );
            assert!(
                sha.len() == 64 && sha.chars().all(|c| c.is_ascii_hexdigit()),
                "{name} checksum must be a 64-hex sha256 (the HF `lfs.oid` at the pinned \
                 revision), got {sha:?}"
            );
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
        assert_eq!(reg.local_speech_model.id, DEFAULT_LOCAL_SPEECH_MODEL_ID);
        assert!(reg.local_speech_model.weight_url.contains("s1-mini-GGUF"));
        assert!(!reg.local_speech_model.sha256.is_empty());
        assert_eq!(reg.reranker.id, "BAAI/bge-reranker");
        assert_eq!(reg.default_llm_base_url, DEFAULT_LLM_BASE_URL);
        assert_eq!(reg.default_llm_model, DEFAULT_LLM_MODEL);
    }

    fn device_with_ram(ram_gib: Option<u64>) -> crate::model_catalog::device::DeviceInfo {
        let total_ram_bytes = ram_gib.map(|g| g * 1024 * 1024 * 1024);
        crate::model_catalog::device::DeviceInfo {
            ram_human: total_ram_bytes
                .map(crate::model_catalog::device::human_bytes)
                .unwrap_or_default(),
            total_ram_bytes,
            vram_bytes: None,
            vram_human: String::new(),
            gpu_name: None,
            gpu_vendor: None,
            unified_memory: false,
            os: "linux".into(),
            disk_free_bytes: None,
            disk_free_human: String::new(),
        }
    }

    /// Gemma 4 E2B needs ~5.0 GiB on the CPU; below that the node's built-in
    /// chat default is the ~0.8 GB Gemma 3 1B. Unknown hardware never downgrades.
    #[test]
    fn chat_default_falls_back_to_gemma_3_1b_only_when_ram_is_known_too_small() {
        assert_eq!(local_chat_default_for(None), MAIN_LOCAL_CHAT_DEFAULT);
        assert_eq!(
            local_chat_default_for(Some(&device_with_ram(None))),
            MAIN_LOCAL_CHAT_DEFAULT
        );
        assert_eq!(
            local_chat_default_for(Some(&device_with_ram(Some(8)))),
            MAIN_LOCAL_CHAT_DEFAULT
        );
        assert_eq!(
            local_chat_default_for(Some(&device_with_ram(Some(6)))),
            MAIN_LOCAL_CHAT_DEFAULT
        );
        assert_eq!(
            local_chat_default_for(Some(&device_with_ram(Some(4)))),
            FALLBACK_LOCAL_CHAT_DEFAULT
        );
        assert_eq!(local_chat_fallback_reason(&device_with_ram(Some(8))), None);
        let reason = local_chat_fallback_reason(&device_with_ram(Some(4))).unwrap();
        assert!(reason.contains("This computer has 4.0 GB"), "{reason}");
        assert!(reason.contains("Gemma 3 1B"), "{reason}");
    }

    #[test]
    fn chat_defaults_are_pinned_and_sized() {
        for default in [MAIN_LOCAL_CHAT_DEFAULT, FALLBACK_LOCAL_CHAT_DEFAULT] {
            assert!(default.url.contains("/resolve/"), "{}", default.url);
            assert!(!default.url.contains("/resolve/main/"), "{}", default.url);
            assert!(default.url.ends_with(&format!("/{}.gguf", default.id)));
            assert_eq!(default.sha256.len(), 64);
            assert_eq!(local_chat_default_bytes(default.id), Some(default.bytes));
        }
        assert_eq!(local_chat_default_bytes("my-custom-model"), None);
    }

    #[test]
    fn default_local_chat_model_is_set() {
        let reg = ProviderRegistry::default();
        assert_eq!(reg.local_chat_model.id, DEFAULT_LOCAL_CHAT_MODEL_ID);
        assert_eq!(reg.local_chat_model.id, "gemma-4-E2B-it-Q4_K_M");
        assert!(!reg.local_chat_model.weight_url.is_empty());
        assert!(reg.local_chat_model.weight_url.contains("gemma-4-E2B"));
        assert!(!reg.local_chat_model.sha256.is_empty());
        // weight_path resolves to <data dir>/models/chat/<id>.gguf
        let path = reg.local_chat_model.weight_path();
        assert!(path.ends_with(format!("models/chat/{DEFAULT_LOCAL_CHAT_MODEL_ID}.gguf")));
    }

    #[test]
    fn each_local_model_role_has_its_own_models_folder() {
        let reg = ProviderRegistry::default();
        let folder = |entry: &LocalModelEntry| {
            entry
                .weight_path()
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
        };
        assert_eq!(folder(&reg.local_chat_model).as_deref(), Some("chat"));
        assert_eq!(folder(&reg.local_speech_model).as_deref(), Some("chat"));
        assert_eq!(folder(&reg.local_embed_model).as_deref(), Some("embedding"));
        assert_eq!(folder(&reg.local_reranker_model).as_deref(), Some("rerank"));
        assert_eq!(
            folder(&reg.local_classifier_model).as_deref(),
            Some("classifier")
        );
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
        assert_eq!(reg.local_speech_model.id, DEFAULT_LOCAL_SPEECH_MODEL_ID);
        assert_eq!(
            reg.local_speech_model.weight_url,
            DEFAULT_LOCAL_SPEECH_MODEL_URL
        );
        assert_eq!(
            reg.local_speech_model.sha256,
            DEFAULT_LOCAL_SPEECH_MODEL_SHA256
        );
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
        std::env::set_var("RYU_LOCAL_SPEECH_MODEL_ID", "my-speech-model");
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
        assert_eq!(reg.local_speech_model.id, "my-speech-model");
    }

    /// The classify tier's model must resolve to the pinned 270M GGUF out of the
    /// box: this is the whole point of the tier — without a *small* default the
    /// firewall inspector and the routing classifier fall back to the user's
    /// full-size resident chat model.
    #[test]
    fn default_local_classifier_model_is_the_270m_gemma() {
        let reg = ProviderRegistry::default();
        assert_eq!(
            reg.local_classifier_model.id,
            DEFAULT_LOCAL_CLASSIFIER_MODEL_ID
        );
        assert_eq!(reg.local_classifier_model.id, "gemma-3-270m-it-qat-Q4_0");
        // The router's builtin prefix rule (`gemma-3-270m` → `classify`) matches on
        // the LOWERCASED model string, so the default id must carry that prefix or
        // a classify selection would route back to the chat engine.
        assert!(reg
            .local_classifier_model
            .id
            .to_lowercase()
            .starts_with("gemma-3-270m"));
        assert_eq!(
            reg.local_classifier_model.weight_url,
            DEFAULT_LOCAL_CLASSIFIER_MODEL_URL
        );
        assert!(!reg.local_classifier_model.sha256.is_empty());
        // Distinct from the chat model — sharing the id would collide on the same
        // version-store key (`gguf:<id>`).
        assert_ne!(reg.local_classifier_model.id, reg.local_chat_model.id);
        let path = reg.local_classifier_model.weight_path();
        assert!(path.to_string_lossy().contains("models"));
        assert!(path.to_string_lossy().ends_with(".gguf"));
    }

    #[test]
    fn classifier_model_reads_env_overrides() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        // Unset ⇒ the built-in literals.
        let reg = ProviderRegistry::from_env();
        assert_eq!(
            reg.local_classifier_model.id,
            DEFAULT_LOCAL_CLASSIFIER_MODEL_ID
        );
        assert_eq!(
            reg.local_classifier_model.sha256,
            DEFAULT_LOCAL_CLASSIFIER_MODEL_SHA256
        );

        std::env::set_var("RYU_LOCAL_CLASSIFIER_MODEL_ID", "my-tiny-classifier");
        std::env::set_var(
            "RYU_LOCAL_CLASSIFIER_MODEL_URL",
            "https://example.com/tiny.gguf",
        );
        // Empty SHA is a valid value (it disables verification) and must survive.
        std::env::set_var("RYU_LOCAL_CLASSIFIER_MODEL_SHA256", "");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.local_classifier_model.id, "my-tiny-classifier");
        assert_eq!(
            reg.local_classifier_model.weight_url,
            "https://example.com/tiny.gguf"
        );
        assert_eq!(reg.local_classifier_model.sha256, "");
    }

    /// The classify tier is **env-only, on purpose**: `registry.json` has no
    /// `local_classifier_model_*` key, so writing one is inert — and now visibly so,
    /// rather than parsing into a value no consumer would ever read.
    ///
    /// This test is the inverse of the one it replaces. That one
    /// (`from_file_reads_classifier_model_override`) asserted the file half worked,
    /// and it passed — through `from_file`, which no production code calls — while
    /// all three real consumers (`sidecar::gateway::classify_model_id`,
    /// `llamacpp::classify`, `sidecar::onboarding::install_local_stack`) built with
    /// `from_env()` and could not see the file. A green test over a settable-but-dead
    /// key is exactly the silence this round exists to remove.
    ///
    /// The key was deleted rather than wired up because the three consumers resolve
    /// at three different moments in one process and must agree — see
    /// [`ProviderRegistry::local_classifier_model`] for why `load()` would let a
    /// mid-session file edit fail the firewall inspector open.
    ///
    /// Asserted through `load()`, the constructor with the file layer: if the file
    /// cannot reach it *there*, it cannot reach it anywhere.
    #[test]
    fn classifier_model_is_env_only_and_ignores_registry_file() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        // Also sets `rag_strategy`, whose file half IS live, so this proves the file
        // was read and parsed — not that the whole load silently failed.
        std::fs::write(
            &path,
            r#"{"local_classifier_model_id":"file-classifier","local_classifier_model_url":"https://example.com/file.gguf","local_classifier_model_sha256":"deadbeef","rag_strategy":"graph"}"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = ProviderRegistry::load();
        assert_eq!(
            reg.rag_strategy, "graph",
            "precondition: the file must actually have been read"
        );
        assert_eq!(
            reg.local_classifier_model.id, DEFAULT_LOCAL_CLASSIFIER_MODEL_ID,
            "registry.json must not be able to set the classifier id"
        );
        assert_eq!(
            reg.local_classifier_model.weight_url,
            DEFAULT_LOCAL_CLASSIFIER_MODEL_URL
        );
        assert_eq!(
            reg.local_classifier_model.sha256,
            DEFAULT_LOCAL_CLASSIFIER_MODEL_SHA256
        );

        // The env half still works — env-only means env-only, not unconfigurable.
        std::env::set_var("RYU_LOCAL_CLASSIFIER_MODEL_ID", "env-classifier");
        assert_eq!(
            ProviderRegistry::load().local_classifier_model.id,
            "env-classifier"
        );
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

    /// Renamed from `from_file_reads_chat_model_override`: it never exercised the
    /// *chat model* (that is `local_chat_model`, now env-only) — only the default LLM
    /// provider endpoint and model id, both of which are genuinely file-backed.
    #[test]
    fn from_file_reads_default_llm_provider_override() {
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

    /// `reranker_model` IS file-backed — its one consumer
    /// (`rag_host::open_retrieval_store`, via `retrieval_registry()`) uses `load()`.
    /// Asserted through `load()` + a real `RYU_REGISTRY_PATH` rather than
    /// `from_file`, which no production code calls and which therefore proves
    /// nothing about the shipped path (see [`ProviderRegistry::from_file`]).
    #[test]
    fn reranker_model_reads_registry_file_via_load() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"reranker_model":"custom/reranker-test"}"#).unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        assert_eq!(ProviderRegistry::load().reranker.id, "custom/reranker-test");
    }

    /// `reranker_base_url` is file-backed for its ONE reader,
    /// `rag_host::reranker_local_server` (the Spaces reranker). Pinned through
    /// `load()` because that is the constructor `server::spaces::open_default` now
    /// reaches it with.
    ///
    /// The guard clears `RYU_RERANKER_BASE_URL`, so the first half of this test is
    /// the **release** profile. Every other profile has that variable seeded by
    /// `profile::apply_env_defaults` and therefore behaves like the second half —
    /// see `profile_seeded_reranker_base_url_shadows_the_file_key`.
    #[test]
    fn reranker_base_url_reads_registry_file_via_load() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"reranker_base_url":"http://127.0.0.1:9999"}"#).unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        assert_eq!(
            ProviderRegistry::load().reranker_base_url,
            "http://127.0.0.1:9999"
        );
        // Env still wins over the file, in the conflicting case specifically.
        std::env::set_var("RYU_RERANKER_BASE_URL", "http://127.0.0.1:8123");
        assert_eq!(
            ProviderRegistry::load().reranker_base_url,
            "http://127.0.0.1:8123"
        );
    }

    /// The `dev`-profile configuration of the two knobs `profile::apply_env_defaults`
    /// seeds, side by side, because they are shadowed to *different* degrees and only
    /// one of them is a lost setting.
    ///
    /// Set both env vars the way `apply_env_defaults` does on any non-release
    /// profile, and put a conflicting value for each in `registry.json`:
    ///
    /// - `reranker_base_url` has a file key, so the seed **outranks a real setting**.
    ///   An operator who edits `registry.json` on a dev stack sees nothing happen,
    ///   with no warning anywhere. That is this test's whole point — and why the
    ///   field doc names the profile.
    /// - `embed_base_url` has no file key at all, so there is nothing to outrank; the
    ///   seed only moves the *default* to the profile's shifted port, which is the
    ///   intended behaviour rather than a shadow.
    #[test]
    fn profile_seeded_reranker_base_url_shadows_the_file_key() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"reranker_base_url":"http://rerank.internal:8082","embed_base_url":"http://embed.internal:8081"}"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);
        // Exactly what `apply_env_defaults` seeds on the `dev` profile (+1000).
        std::env::set_var("RYU_RERANKER_BASE_URL", "http://127.0.0.1:9082");
        std::env::set_var("RYU_EMBED_BASE_URL", "http://127.0.0.1:9081");

        let reg = ProviderRegistry::load();
        assert_eq!(
            reg.reranker_base_url, "http://127.0.0.1:9082",
            "the profile's seed outranks a file key the operator actually set"
        );
        assert_eq!(reg.embed_base_url, "http://127.0.0.1:9081");

        // …and dropping the seeds (the release profile) hands the file key back —
        // proving the value above came from the seed, not from the file being unread.
        std::env::remove_var("RYU_RERANKER_BASE_URL");
        std::env::remove_var("RYU_EMBED_BASE_URL");
        let reg = ProviderRegistry::load();
        assert_eq!(reg.reranker_base_url, "http://rerank.internal:8082");
        assert_eq!(
            reg.embed_base_url, DEFAULT_EMBED_BASE_URL,
            "embed_base_url has no file layer to fall back to — env-only"
        );
    }

    /// Exercise the actual startup default plan instead of parsing Rust source.
    /// These defaults participate in env > registry file > literal precedence;
    /// a new registry key here would silently shadow its file-backed setting.
    #[test]
    fn registry_env_keys_shadowed_by_the_profile_defaults() {
        let gateway_config = std::path::PathBuf::from("fixture-profile/gateway.toml");
        let defaults = crate::profile::environment_defaults_for(1000, Some(gateway_config.clone()));
        assert_eq!(
            defaults,
            vec![
                ("RYU_BIND", "127.0.0.1:8980".to_owned()),
                ("RYU_GATEWAY_URL", "http://127.0.0.1:8981".to_owned()),
                (
                    "GATEWAY_CONFIG",
                    gateway_config.to_string_lossy().into_owned()
                ),
                ("RYU_SHADOW_URL", "http://127.0.0.1:4030".to_owned()),
                ("RYU_EMBED_BASE_URL", "http://127.0.0.1:9081".to_owned()),
                ("RYU_RERANKER_BASE_URL", "http://127.0.0.1:9082".to_owned()),
            ]
        );
        let mut shadowed: Vec<&str> = REGISTRY_ENV
            .iter()
            .copied()
            .filter(|key| defaults.iter().any(|(seeded, _)| seeded == key))
            .collect();
        shadowed.sort_unstable();
        assert_eq!(
            shadowed,
            ["RYU_EMBED_BASE_URL", "RYU_RERANKER_BASE_URL"],
            "a profile default must not silently shadow another registry file setting"
        );

        let defaults_without_config = crate::profile::environment_defaults_for(1000, None);
        assert_eq!(defaults_without_config.len(), 5);
        assert!(!defaults_without_config
            .iter()
            .any(|(key, _)| *key == "GATEWAY_CONFIG"));
        assert!(
            !defaults
                .iter()
                .any(|(key, _)| *key == crate::paths::RYU_DIR_ENV),
            "seeding RYU_DIR would mask the operator's relocation pointer"
        );
    }

    /// `graph_extraction_model` is file-backed and enforced:
    /// `server::spaces::open_default` reads it through `retrieval_registry()` and
    /// hands it to `SpaceStore`, which accepts the shipped local id and rejects
    /// unsupported values. This test proves the file layer only; `ryu-spaces`
    /// separately proves the support boundary.
    #[test]
    fn graph_extraction_model_reads_registry_file_via_load() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"graph_extraction_model":"acme/entity-extractor"}"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = ProviderRegistry::load();
        assert_eq!(reg.graph_extraction_model, "acme/entity-extractor");
        assert_eq!(reg.graph_extraction_model_id(), "acme/entity-extractor");
    }

    /// The embed trio is **env-only**: `registry.json` cannot set the model id, the
    /// dims, or the endpoint.
    ///
    /// This is the inverse of the test it replaces (`from_file_reads_embed_model_override`),
    /// which asserted the file half worked — and passed, through `from_file`, while
    /// `server::spaces::open_default`, `rag_host::open_retrieval_store` and
    /// `search_host` all built with `from_env()` and could not see it. A green test
    /// over a settable-but-dead key buys silence.
    ///
    /// The keys were deleted rather than wired up because `embed_dims` fixes the
    /// width of the `chunk_vectors` vec0 table and `SpaceStore::open_at` does not
    /// reconcile a mismatch; the id cannot be split from the dims, and the base URL
    /// repoints the backend without changing the tag the per-row filter keys on. See
    /// [`ProviderRegistry::embedder`].
    #[test]
    fn embed_trio_is_env_only_and_ignores_registry_file() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        // `rag_strategy` is included as a positive control: its file half IS live, so
        // it proves the file was found and parsed rather than silently skipped.
        std::fs::write(
            &path,
            r#"{"embed_model":"file/embed-xl","embed_dims":1024,"embed_base_url":"http://127.0.0.1:9990","rag_strategy":"graph"}"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = ProviderRegistry::load();
        assert_eq!(
            reg.rag_strategy, "graph",
            "precondition: the file must actually have been read"
        );
        assert_eq!(reg.embedder.id, DEFAULT_EMBED_MODEL);
        assert_eq!(reg.embedder.dims, DEFAULT_EMBED_DIMS);
        assert_eq!(reg.embed_base_url, DEFAULT_EMBED_BASE_URL);

        // Env-only means env-only, not unconfigurable.
        std::env::set_var("RYU_EMBED_MODEL", "env/embed-xl");
        std::env::set_var("RYU_EMBED_DIMS", "1024");
        std::env::set_var("RYU_EMBED_BASE_URL", "http://127.0.0.1:9991");
        let reg = ProviderRegistry::load();
        assert_eq!(reg.embedder.id, "env/embed-xl");
        assert_eq!(reg.embedder.dims, 1024);
        assert_eq!(reg.embed_base_url, "http://127.0.0.1:9991");
    }

    /// All five local-GGUF triples are **env-only**. `local_chat_model` is the one
    /// that most needs pinning: its key was the last half-live field in the schema —
    /// honoured by `pi_config` (`load()`) and ignored by the onboarding downloader,
    /// `llamacpp::{mod,process}`, `model_catalog_host` and `get_active_model`
    /// (`from_env()`), so setting it made the managed Pi declare a model id that
    /// llama.cpp was not serving. Deleting the key is what makes those two
    /// constructors agree.
    #[test]
    fn local_model_triples_are_env_only_and_ignore_registry_file() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{
              "local_chat_model_id":"file-chat","local_chat_model_url":"https://example.com/chat.gguf","local_chat_model_sha256":"deadbeef",
              "local_embed_model_id":"file-embed","local_embed_model_url":"https://example.com/embed.gguf","local_embed_model_sha256":"deadbeef",
              "local_reranker_model_id":"file-rerank","local_reranker_model_url":"https://example.com/rerank.gguf","local_reranker_model_sha256":"deadbeef",
              "local_speech_model_id":"file-speech","local_speech_model_url":"https://example.com/speech.gguf","local_speech_model_sha256":"deadbeef",
              "rag_strategy":"graph"
            }"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = ProviderRegistry::load();
        assert_eq!(
            reg.rag_strategy, "graph",
            "precondition: the file must actually have been read"
        );
        assert_eq!(reg.local_chat_model.id, DEFAULT_LOCAL_CHAT_MODEL_ID);
        assert_eq!(
            reg.local_chat_model.weight_url,
            DEFAULT_LOCAL_CHAT_MODEL_URL
        );
        assert_eq!(reg.local_chat_model.sha256, DEFAULT_LOCAL_CHAT_MODEL_SHA256);
        assert_eq!(reg.local_embed_model.id, DEFAULT_LOCAL_EMBED_MODEL_ID);
        assert_eq!(reg.local_reranker_model.id, DEFAULT_LOCAL_RERANKER_MODEL_ID);
        assert_eq!(reg.local_speech_model.id, DEFAULT_LOCAL_SPEECH_MODEL_ID);

        // The env half still works.
        std::env::set_var("RYU_LOCAL_CHAT_MODEL_ID", "env-chat");
        assert_eq!(ProviderRegistry::load().local_chat_model.id, "env-chat");
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

    /// `providers` is loaded and consumed (`sidecar::adapters`, `load()`).
    ///
    /// The `strategies` array that used to be asserted here is gone: nothing ever
    /// read an entry's `value`, so it was a settable value that could not take
    /// effect, and this assertion was the green test over it. A `strategies` key in
    /// an existing operator's file now parses to nothing (serde ignores unknown
    /// fields), which is what it effectively did before.
    #[test]
    fn provider_entries_are_loaded() {
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
    }

    /// A file carrying only deleted keys must still parse and still yield the
    /// built-in defaults — `RegistryFile` is deliberately not `deny_unknown_fields`.
    ///
    /// This is the upgrade path: an operator whose `registry.json` still sets
    /// `embed_model` / `local_chat_model_url` / `strategies` keeps booting with the
    /// keys that DO work. With `deny_unknown_fields` the whole file would fail to
    /// parse and `RegistryFile::load` would fail *open* to defaults, silently
    /// discarding their `default_agent_id` and `rag_strategy` too.
    #[test]
    fn a_file_of_only_deleted_keys_still_parses_and_does_not_poison_the_live_ones() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"embed_model":"gone","embed_dims":1024,"local_chat_model_url":"https://example.com/x.gguf","strategies":[{"id":"rag_strategy","value":"graphrag"}],"default_agent_id":"acp:gemini","rag_strategy":"graph"}"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = ProviderRegistry::load();
        assert_eq!(reg.default_agent_id, "acp:gemini");
        assert_eq!(reg.rag_strategy, "graph");
        assert_eq!(reg.embedder.id, DEFAULT_EMBED_MODEL);
        assert_eq!(reg.embedder.dims, DEFAULT_EMBED_DIMS);
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

    // ── `rag_strategy` — the node-wide Space creation default ───────────────────
    //
    // These guard the knob that was, until now, advertised in `registry.json` and
    // `RYU_RAG_STRATEGY` while having zero production callers. Its one consumer is
    // `server::create_space`; the assertions below pin the precedence that consumer
    // relies on.

    /// Nothing configured ⇒ the built-in literal. Unchanged behaviour for every
    /// existing install: a Space created with no `retrieval_mode` is still vector.
    #[test]
    fn rag_strategy_defaults_to_vector() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.rag_strategy, DEFAULT_RAG_STRATEGY);
        assert_eq!(reg.resolve_rag_strategy(None), "vector");
    }

    /// `RYU_RAG_STRATEGY=graph` reaches `resolve_rag_strategy`, which is what makes
    /// the documented env knob real rather than a no-op.
    #[test]
    fn rag_strategy_reads_env_override() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        std::env::set_var("RYU_RAG_STRATEGY", "graph");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.resolve_rag_strategy(None), "graph");
    }

    /// `registry.json {"rag_strategy": "graph"}` reaches it too — the second half of
    /// the documented surface, proved **through the constructor production uses**.
    ///
    /// The previous version of this test called `ProviderRegistry::from_file`, which
    /// no production code calls. It passed for months while the shipped path
    /// (`server::create_space` → `from_env`) opened no file at all, so the file half
    /// of the documented knob was inert and a green assertion said otherwise. A test
    /// over a constructor nothing ships is worse than no test: it buys silence.
    ///
    /// Hence `load()` + a real `RYU_REGISTRY_PATH` — the same two hops production
    /// takes (`load` → `registry_path` → `$RYU_REGISTRY_PATH`). Setting the path is
    /// also what keeps this hermetic: `RegistryEnvGuard` *clears* the var, and an
    /// unset var makes `load()` read the operator's real `~/.ryu/state/registry.json`.
    #[test]
    fn rag_strategy_reads_registry_file_via_load() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"rag_strategy":"graph"}"#).unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = ProviderRegistry::load();
        assert_eq!(reg.rag_strategy, "graph");
        assert_eq!(reg.resolve_rag_strategy(None), "graph");
    }

    /// Env beats file, which is the direction the module header's precedence chain
    /// claims (`env_or_file_or_literal`: env → file → literal). Pinned in the
    /// conflicting case specifically — agreeing values would pass either way and
    /// prove nothing about the ordering.
    #[test]
    fn rag_strategy_env_beats_registry_file() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"rag_strategy":"graph"}"#).unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);
        std::env::set_var("RYU_RAG_STRATEGY", "vector");

        assert_eq!(
            ProviderRegistry::load().resolve_rag_strategy(None),
            "vector"
        );
    }

    /// A missing file is fail-open, not a panic or a wedged boot: `load()` on a path
    /// that does not exist yields the built-in literal. This is the case every
    /// install without a `registry.json` is in — i.e. almost all of them — so it is
    /// the behaviour that actually ships.
    #[test]
    fn load_falls_back_to_literals_when_the_file_is_absent() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        // Deliberately never created. Pointing at a nonexistent path inside a
        // tempdir (rather than leaving the var unset) is what stops this test from
        // reading the developer's real ~/.ryu/state/registry.json.
        std::env::set_var("RYU_REGISTRY_PATH", dir.path().join("nope.json"));

        let reg = ProviderRegistry::load();
        assert_eq!(reg.rag_strategy, DEFAULT_RAG_STRATEGY);
        assert_eq!(reg.resolve_rag_strategy(None), "vector");
    }

    /// An unknown value from the file survives verbatim, exactly as an unknown value
    /// from env does (`rag_strategy_does_not_validate_operator_typos`). The resolver
    /// must not normalize it away, or `server::create_space` loses its ability to
    /// warn the operator by name — it would just quietly build a vector Space.
    #[test]
    fn rag_strategy_file_typo_survives_to_the_consumer() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"rag_strategy":"graphrag"}"#).unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let reg = ProviderRegistry::load();
        assert_eq!(reg.resolve_rag_strategy(None), "graphrag");
        assert!(ryu_spaces::RetrievalMode::parse(reg.resolve_rag_strategy(None)).is_none());
    }

    /// **The guard that replaces the boot-time divergence warning.**
    ///
    /// The invariant: `from_env()` and `load()` must return the same value for every
    /// field any `from_env()` consumer reads. Those consumers are
    /// `search_host::CoreSearchEmbedder` (embed trio),
    /// `model_catalog_host::default_model_repos` (chat + embed + Speech Processing GGUFs),
    /// `sidecar::gateway::classify_model_id` and `llamacpp::classify` (classifier
    /// GGUF), `llamacpp::{mod,process}` and `server::get_active_model` (chat GGUF),
    /// `llamacpp::embed` (embed GGUF), `llamacpp::rerank` (rerank GGUF), and
    /// `sidecar::onboarding::install_local_stack` (all five GGUFs). Verified by
    /// reading each call site, not assumed.
    ///
    /// Holding the invariant is what makes the choice of constructor unobservable at
    /// those sites — and therefore what makes it safe to have deleted
    /// `file_fields_their_consumers_ignore` and the boot warning that consumed it. A
    /// runtime diagnostic that can only ever report "nothing wrong" is the same
    /// defect as the mis-scoped warning it replaced; this test says the same thing
    /// at build time, and *fails* instead of going quiet.
    ///
    /// It feeds `load()` a file that sets every one of the deleted keys, so
    /// re-adding any of them to `RegistryFile` breaks it immediately. The env guard
    /// matters here: env wins over file in BOTH constructors, so a stray exported
    /// `RYU_EMBED_MODEL` would make this pass for the wrong reason.
    #[test]
    fn from_env_and_load_agree_on_every_field_a_from_env_consumer_reads() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{
              "embed_model":"file/embed","embed_dims":1024,"embed_base_url":"http://127.0.0.1:9990",
              "local_chat_model_id":"file-chat","local_chat_model_url":"https://example.com/chat.gguf","local_chat_model_sha256":"aa",
              "local_embed_model_id":"file-embed","local_embed_model_url":"https://example.com/embed.gguf","local_embed_model_sha256":"bb",
              "local_reranker_model_id":"file-rerank","local_reranker_model_url":"https://example.com/rerank.gguf","local_reranker_model_sha256":"cc",
              "local_classifier_model_id":"file-classify","local_classifier_model_url":"https://example.com/classify.gguf","local_classifier_model_sha256":"dd",
              "local_speech_model_id":"file-speech","local_speech_model_url":"https://example.com/speech.gguf","local_speech_model_sha256":"ee",
              "rag_strategy":"graph"
            }"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let loaded = ProviderRegistry::load();
        let env_only = ProviderRegistry::from_env();

        // Precondition, asserted rather than assumed: the file really was found and
        // parsed. Without this the whole test could pass because `load()` silently
        // read nothing at all.
        assert_eq!(
            loaded.rag_strategy, "graph",
            "precondition: load() must have read the file"
        );
        assert_ne!(
            env_only.rag_strategy, "graph",
            "precondition: from_env() must NOT have read the file"
        );

        assert_eq!(
            loaded.embedder, env_only.embedder,
            "embed_model/embed_dims must have no file key: search_host, \
             spaces::open_default and open_retrieval_store fix the vector space of \
             three on-disk indexes from them"
        );
        assert_eq!(
            loaded.embed_base_url, env_only.embed_base_url,
            "embed_base_url must have no file key: it repoints the backend without \
             changing the embed_model tag the per-row search filter keys on"
        );
        assert_eq!(
            loaded.local_chat_model, env_only.local_chat_model,
            "local_chat_model must have no file key: onboarding downloads the GGUF \
             and llamacpp serves it at a different moment"
        );
        assert_eq!(
            loaded.local_embed_model, env_only.local_embed_model,
            "local_embed_model must have no file key (same download/serve split)"
        );
        assert_eq!(
            loaded.local_reranker_model, env_only.local_reranker_model,
            "local_reranker_model must have no file key (same download/serve split)"
        );
        assert_eq!(
            loaded.local_classifier_model, env_only.local_classifier_model,
            "local_classifier_model must have no file key: a mid-session desync \
             fails the firewall inspector and the routing classifier OPEN"
        );
        assert_eq!(
            loaded.local_speech_model, env_only.local_speech_model,
            "local_speech_model must have no file key: onboarding and the lazy \
             Speech Processing sidecar must resolve the same model"
        );
    }

    /// The other direction, so the guard above cannot be satisfied by making
    /// `load()` stop reading the file altogether: the fields whose consumers all use
    /// `load()` must still differ between the two constructors when the file sets
    /// them. If this ever passes vacuously the file layer has died.
    #[test]
    fn load_still_beats_from_env_for_the_fields_that_are_file_backed() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"default_llm_model":"file/chat","reranker_model":"file/rerank","reranker_base_url":"http://127.0.0.1:9999","graph_extraction_model":"file/extract","rag_strategy":"graph","default_agent_id":"acp:gemini"}"#,
        )
        .unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);

        let loaded = ProviderRegistry::load();
        let env_only = ProviderRegistry::from_env();
        assert_ne!(loaded.default_llm_model, env_only.default_llm_model);
        assert_ne!(loaded.reranker.id, env_only.reranker.id);
        assert_ne!(loaded.reranker_base_url, env_only.reranker_base_url);
        assert_ne!(
            loaded.graph_extraction_model,
            env_only.graph_extraction_model
        );
        assert_ne!(loaded.rag_strategy, env_only.rag_strategy);
        assert_ne!(loaded.default_agent_id, env_only.default_agent_id);
    }

    /// The unset case is hermetic under test: `load()` with no `RYU_REGISTRY_PATH`
    /// must NOT reach `~/.ryu/state/registry.json`.
    ///
    /// This is the isolation that used to be every individual test's responsibility
    /// — a responsibility that could not be discharged by tests in other modules
    /// which reach `load()` several calls down (`pi_config::default_gateway_model`)
    /// and have no reason to know the var exists. Pinned here rather than left to
    /// discipline, because the failure mode is a test that passes or fails according
    /// to what is in the developer's home directory.
    #[test]
    fn unset_registry_path_resolves_away_from_the_real_home_config_under_test() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        // The guard has cleared RYU_REGISTRY_PATH — this is exactly the state a test
        // that forgets to set it is in.
        let resolved = super::registry_path().expect("a path is always resolved");
        // Assert the POSITIVE shape first. The two negative assertions below both
        // pass vacuously on a machine that simply has no `~/.ryu/state/registry.json` —
        // which is most dev machines — so on their own they would be no evidence
        // that the `cfg(test)` fallback fired at all. If `registry` ever stops being
        // compiled under `cfg(test)` (it is a module of the *bin* target today, and
        // `src/lib.rs` is empty), this is the assertion that says so out loud
        // instead of letting the isolation quietly lapse.
        assert!(
            resolved.to_string_lossy().contains("ryu-registry-absent-"),
            "the cfg(test) fallback did not fire — isolation is NOT in effect and \
             every load() in the crate is reading a real config; got {}",
            resolved.display()
        );
        assert!(
            !resolved.starts_with(crate::paths::ryu_dir()),
            "must not resolve into the operator's ~/.ryu; got {}",
            resolved.display()
        );
        assert!(
            !resolved.exists(),
            "the temp fallback must be a definitely-absent file so load() yields \
             built-in defaults; got {}",
            resolved.display()
        );
        // …and the composed behaviour: built-in defaults, no panic.
        assert_eq!(ProviderRegistry::load().rag_strategy, DEFAULT_RAG_STRATEGY);
    }

    /// Env beats file for a file-backed field, pinned in the conflicting case. This
    /// is the half of the precedence chain that makes the module header's
    /// "1. env, 2. registry.json, 3. literal" true for `reranker_model` specifically
    /// — the same shape already pinned for `rag_strategy`, kept for a second field so
    /// a change to [`env_or_file_or_literal`] cannot pass on one example alone.
    #[test]
    fn env_beats_the_file_for_a_file_backed_field() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(&path, r#"{"reranker_model":"file/rerank"}"#).unwrap();
        std::env::set_var("RYU_REGISTRY_PATH", &path);
        std::env::set_var("RYU_RERANKER_MODEL", "env/rerank");

        assert_eq!(ProviderRegistry::load().reranker.id, "env/rerank");
    }

    /// **The precedence that matters**: an explicitly requested per-Space mode wins
    /// over the node-wide default, in BOTH directions. The `graph` default must not
    /// override a caller asking for `vector`, or the per-Space setting would be the
    /// one that cannot take effect.
    #[test]
    fn explicit_space_mode_beats_registry_default() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        std::env::set_var("RYU_RAG_STRATEGY", "graph");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.resolve_rag_strategy(Some("vector")), "vector");
        assert_eq!(reg.resolve_rag_strategy(Some("graph")), "graph");

        std::env::set_var("RYU_RAG_STRATEGY", "vector");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.resolve_rag_strategy(Some("graph")), "graph");
    }

    /// An empty string is "absent", not "a mode named nothing" — the HTTP layer
    /// relies on this so `{"retrieval_mode": ""}` falls back to the node default
    /// instead of failing a strict parse.
    #[test]
    fn empty_space_mode_falls_back_to_registry_default() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        std::env::set_var("RYU_RAG_STRATEGY", "graph");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.resolve_rag_strategy(Some("")), "graph");
    }

    /// The resolver is a *string* resolver: it does not validate. An operator typo
    /// in env/JSON comes back verbatim so the consumer can name the bad value in a
    /// warning rather than silently creating a vector Space. Pinned because a
    /// future "helpful" normalization here would hide the typo.
    #[test]
    fn rag_strategy_does_not_validate_operator_typos() {
        let _lock = lock_registry_env();
        let _g = RegistryEnvGuard::capture();
        std::env::set_var("RYU_RAG_STRATEGY", "graphrag");
        let reg = ProviderRegistry::from_env();
        assert_eq!(reg.resolve_rag_strategy(None), "graphrag");
        assert!(ryu_spaces::RetrievalMode::parse(reg.resolve_rag_strategy(None)).is_none());
    }
}
