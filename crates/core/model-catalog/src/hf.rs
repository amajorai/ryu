//! Hugging Face endpoint, in-process TTL cache, wire types and HTTP helpers.

use super::*;

/// Where a model catalog's HTTP calls point. The Hugging Face Hub host is no
/// longer a module-level const — the active the active catalog source owns one
/// of these and threads it through search / detail / install, so a second
/// HF-compatible source (ModelScope, a private mirror, a custom base URL) drops
/// in with no code change to the fetch logic. This is the "nothing hardcoded"
/// rule applied to the model catalog host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HfEndpoint {
    /// API base (the `/api` root), e.g. `https://huggingface.co/api`. Used for
    /// the `models`, `models/{id}`, and tree endpoints.
    pub api_base: String,
    /// Content host (no `/api`), e.g. `https://huggingface.co`. Used for the
    /// `resolve/main` (download) and `raw/main/README.md` paths.
    pub host: String,
}

impl HfEndpoint {
    /// The default Hugging Face Hub endpoint.
    pub fn huggingface() -> Self {
        Self {
            api_base: "https://huggingface.co/api".to_string(),
            host: "https://huggingface.co".to_string(),
        }
    }

    /// ModelScope — an HF-Hub-compatible mirror. ModelScope exposes the same
    /// repo/resolve/tree shape under its own host. TODO(#460): the exact API
    /// base path on ModelScope is best-effort here; if a ModelScope fetch 404s,
    /// adjust `api_base`/`host` (the endpoint is fully data-driven, so this is a
    /// string change, not a code change). The point of this unit is proving the
    /// seam carries a *second* endpoint, not pixel-perfect ModelScope parity.
    pub fn modelscope() -> Self {
        Self {
            // `/api/v1` is the API root (search appends `/models`, mirroring how
            // HF's `/api` root becomes `/api/models`). Do NOT include `/models`
            // here or the search URL doubles to `.../models/models`.
            api_base: "https://modelscope.cn/api/v1".to_string(),
            host: "https://modelscope.cn".to_string(),
        }
    }

    /// Build an endpoint from a user-supplied HF-compatible base URL (a custom
    /// model source). The base is treated as the API root; the content host is
    /// derived by stripping a trailing `/api*` segment when present, else the
    /// base is reused as the host.
    pub fn from_base_url(base: &str) -> Self {
        let base = base.trim_end_matches('/');
        let host = match base.find("/api") {
            Some(idx) => base[..idx].to_string(),
            None => base.to_string(),
        };
        Self {
            api_base: base.to_string(),
            host,
        }
    }

    /// Short, filesystem/cache-safe tag identifying this endpoint's host. Used
    /// to namespace the in-process cache so two sources never collide.
    pub(crate) fn cache_tag(&self) -> &str {
        self.host
            .trim_start_matches("https://")
            .trim_start_matches("http://")
    }
}

impl Default for HfEndpoint {
    fn default() -> Self {
        Self::huggingface()
    }
}

//
// Hugging Face detail needs 3 round-trips (info + tree + README), so it's the
// slow part of navigating the catalog. A short in-process cache makes repeat
// opens (and every non-react-query client — mobile, extension, CLI) fast without
// adding a dependency. Keyed by a string; values are pre-serialized JSON so one
// map serves both list and detail. The desktop layers its own client cache on
// top; this is the shared floor.

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub(crate) const LIST_TTL: Duration = Duration::from_secs(60);
pub(crate) const DETAIL_TTL: Duration = Duration::from_secs(300);

pub(crate) struct CacheEntry {
    pub(crate) value: serde_json::Value,
    pub(crate) stored: Instant,
}

pub(crate) static CACHE: Mutex<Option<std::collections::HashMap<String, CacheEntry>>> =
    Mutex::new(None);

pub(crate) fn cache_get(key: &str, ttl: Duration) -> Option<serde_json::Value> {
    let guard = CACHE.lock().ok()?;
    let map = guard.as_ref()?;
    let entry = map.get(key)?;
    if entry.stored.elapsed() <= ttl {
        Some(entry.value.clone())
    } else {
        None
    }
}

pub(crate) fn cache_put(key: String, value: serde_json::Value) {
    if let Ok(mut guard) = CACHE.lock() {
        let map = guard.get_or_insert_with(std::collections::HashMap::new);
        // Bound the map so a long-running process can't grow it without limit.
        if map.len() > 256 {
            map.clear();
        }
        map.insert(
            key,
            CacheEntry {
                value,
                stored: Instant::now(),
            },
        );
    }
}

/// Drop cached entries whose key contains `needle` (e.g. a repo id after install).
pub(crate) fn cache_invalidate(needle: &str) {
    if let Ok(mut guard) = CACHE.lock() {
        if let Some(map) = guard.as_mut() {
            map.retain(|k, _| !k.contains(needle));
        }
    }
}

/// Friendly catalog sort orders, mapped to Hugging Face Hub sort keys.
#[derive(Debug, Clone, Copy)]
pub enum CatalogSort {
    /// Trending right now (default — best for non-technical discovery).
    Trending,
    /// Most downloaded all-time.
    Downloads,
    /// Most liked.
    Likes,
    /// Most recently updated.
    Recent,
}

impl CatalogSort {
    pub fn parse(s: &str) -> Self {
        match s {
            "downloads" => CatalogSort::Downloads,
            "likes" => CatalogSort::Likes,
            "recent" | "lastModified" => CatalogSort::Recent,
            _ => CatalogSort::Trending,
        }
    }

    pub(crate) fn hf_key(self) -> &'static str {
        match self {
            CatalogSort::Trending => "trendingScore",
            CatalogSort::Downloads => "downloads",
            CatalogSort::Likes => "likes",
            CatalogSort::Recent => "lastModified",
        }
    }
}

/// True for HuggingFace pipeline tags that identify a generative image/video
/// diffusion model (stable-diffusion.cpp compatible).
pub(crate) fn is_diffusion_pipeline_tag(tag: &str) -> bool {
    matches!(tag, "text-to-image" | "image-to-image" | "text-to-video")
}

/// A single model as shown in the left-hand selector list.
#[derive(Debug, Clone, Serialize)]
pub struct ModelCard {
    /// Hugging Face repo id, e.g. `"unsloth/gemma-4-E2B-it-GGUF"`.
    pub id: String,
    /// Org/author segment of the id.
    pub author: String,
    /// Repo name segment (no author).
    pub name: String,
    pub downloads: u64,
    pub likes: u64,
    /// Primary task tag, e.g. `"text-generation"`.
    pub pipeline_tag: Option<String>,
    /// All Hub tags (language, license, task, …).
    pub tags: Vec<String>,
    /// True when the model requires accepting terms / a token to download.
    pub gated: bool,
    pub last_modified: Option<String>,
    /// When the repo was first published on the Hub (ISO-8601). Present in list
    /// and detail responses; powers the "added X ago" hint in the catalog.
    pub created_at: Option<String>,
    /// Context window in tokens, from the Hub's parsed GGUF metadata
    /// (`gguf.context_length`). This is the *single* token budget shared by the
    /// prompt and the completion — GGUF models expose one window, not separate
    /// input/output limits. `None` when the Hub hasn't parsed it (e.g. a mirror
    /// that doesn't return the `gguf` block).
    pub context_length: Option<u64>,
    /// Model architecture from GGUF metadata, e.g. `"llama"`, `"gemma3"`. `None`
    /// when unavailable.
    pub architecture: Option<String>,
    /// Parameter count from GGUF metadata (`gguf.total`), e.g. ~8 billion. `None`
    /// when unavailable.
    pub params: Option<u64>,
    /// True when at least one file from this repo is downloaded locally.
    pub installed: bool,
    /// Weight format this card was surfaced under (the query facet).
    pub format: ModelFormat,
    /// Whether some engine that can serve `format` is runnable on this node.
    /// `false` ⇒ the card is shown but annotated (e.g. "Needs vLLM"), never
    /// hidden.
    pub compatible: bool,
    /// Human label of the engine the user would need for an incompatible card
    /// (e.g. `"vLLM"`, `"MLX"`); `None` when compatible.
    pub needs_engine: Option<String>,
    /// True when this is a generative image/video diffusion model (FLUX, SDXL,
    /// SD3, …). Detected from the Hub `pipeline_tag` at browse time, or from
    /// the GGUF `general.architecture` for local-only installs.
    pub diffusion: bool,
}

/// One downloadable GGUF file (a specific quantization of a model).
#[derive(Debug, Clone, Serialize)]
pub struct GgufFile {
    /// Filename within the repo, e.g. `"gemma-4-E2B-it-Q4_K_M.gguf"`.
    pub filename: String,
    /// Parsed quantization label, e.g. `"Q4_K_M"`, `"F16"`. `None` if unknown.
    pub quant: Option<String>,
    pub size_bytes: Option<u64>,
    /// Friendly size string, e.g. `"3.1 GB"`.
    pub size_human: String,
    /// Expected SHA-256 (from the Hub's LFS metadata) when available.
    pub sha256: Option<String>,
    /// Direct download URL.
    pub url: String,
    pub installed: bool,
    /// Machine-readable fit verdict, one of [`FitVerdict::as_str`]: `great`/`ok`
    /// (fully on the GPU), `partial`/`cpu` (runs, may be slow), `too_big` (does
    /// not fit memory) or `no_space` (not enough free disk to download), or
    /// `unknown`. `too_big` and `no_space` are refused by the install route. A
    /// file not yet installed is checked against free disk as well as memory; a
    /// vision repo's fit counts the companion projector the install adds.
    pub fit: String,
    /// Plain-language fit sentence for non-technical users.
    pub fit_label: String,
}

/// The full right-hand detail payload for a selected model.
#[derive(Debug, Clone, Serialize)]
pub struct ModelDetail {
    pub card: ModelCard,
    /// README markdown (YAML front-matter stripped). `None` if the repo has none.
    pub readme: Option<String>,
    /// Weight format of this detail view (drives whether `files` or the repo-level
    /// snapshot fields are populated).
    pub format: ModelFormat,
    /// Every GGUF file in the repo, each with size + device-fit. **Populated only
    /// for `format == Gguf`**; snapshot formats use the `repo_*` fields below.
    /// Excludes the multimodal projector (`mmproj-*.gguf`) — that is an adapter,
    /// not a user-selectable quant (see `vision`).
    pub files: Vec<GgufFile>,
    /// True for a GGUF repo that ships a multimodal projector — i.e. installing
    /// any quant here also auto-installs the matching vision adapter, and the
    /// served model can accept images. `false` for text-only and snapshot repos.
    pub vision: bool,
    /// Total on-disk size of a snapshot repo's weights (summed shards). `None`
    /// for GGUF (use per-file sizes) or when the tree fetch failed.
    pub repo_size_bytes: Option<u64>,
    /// Machine-readable fit verdict for a snapshot repo, the same vocabulary as
    /// GGUF files (`great`/`ok`/`partial`/`cpu`/`too_big`/`no_space`/`unknown`).
    /// `too_big` and `no_space` block the install. Empty for GGUF.
    pub repo_fit: String,
    /// Plain-language, **conservative** fit sentence for a snapshot repo — never
    /// reuses the optimistic GGUF "partial offload" copy, because vLLM/MLX want
    /// the whole repo resident. Empty for GGUF.
    pub repo_fit_label: String,
    /// Independent benchmark stats, when matched + a key is configured.
    pub stats: Option<aa::AaStats>,
    /// Whether an Artificial Analysis API key is configured (UI can prompt).
    pub stats_api_key_present: bool,
    /// The machine the fit verdicts were computed against.
    pub device: DeviceInfo,
}

pub(crate) fn hf_get(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    let req = client.get(url).header("User-Agent", USER_AGENT);
    // The stored token is specifically a Hugging Face credential. Never attach
    // it to an HF-compatible mirror or a custom catalog endpoint, even though
    // those endpoints share the same response shape.
    if url
        .parse::<reqwest::Url>()
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .is_some_and(|host| matches!(host.as_str(), "huggingface.co" | "www.huggingface.co"))
    {
        // Optional token (preferences-first, env fallback) raises rate limits
        // and unlocks gated repos on the first-party Hub only.
        host().authorize_hf(url, req)
    } else {
        req
    }
}

pub(crate) fn gated_to_bool(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(s) => !s.is_empty() && s != "false",
        _ => false,
    }
}

/// Pull the three surfaced GGUF spec fields out of an optional `gguf` block.
pub(crate) fn gguf_fields(g: &Option<HfGguf>) -> (Option<u64>, Option<String>, Option<u64>) {
    match g {
        Some(g) => (g.context_length, g.architecture.clone(), g.total),
        None => (None, None, None),
    }
}

#[cfg(test)]
#[path = "hf_tests.rs"]
mod tests;
