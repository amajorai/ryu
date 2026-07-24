//! Model catalog — the orchestration logic behind Ryu's "browse and install a
//! model" experience. **All logic lives here in Core** so every surface
//! (desktop, mobile, CLI, extension) reuses the exact same search, ranking,
//! device-fit, stats, and install behaviour through one HTTP API. Clients are
//! pure GUI layers.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): discovering *which*
//! model to run and downloading its weights is "what runs" — orchestration —
//! so it belongs in Core. The Gateway still governs every model *call*
//! (routing, budgets, policy); this module never makes inference calls.
//!
//! What it does, all swappable and graceful:
//! - **Search** the Hugging Face Hub, restricted to GGUF (llama.cpp-runnable)
//!   models, with friendly sort orders and an installed-only view.
//! - **Detail** a model: its README, every GGUF quant file with real sizes, and
//!   for each file a plain-language [`device::FitVerdict`] ("runs on your
//!   device") computed from detected RAM.
//! - **Stats** from Artificial Analysis ([`aa`]) when an API key is configured,
//!   degrading silently to no stats otherwise.
//! - **Install** a chosen GGUF by reusing the shared, checksum-verifying
//!   [`GgufDownloader`]; provenance is recorded so the catalog shows what's
//!   installed.
//!
//! Nothing is hardcoded to a single model: the Hub is the source, the local
//! engine (llama.cpp) consumes the downloaded weights, and the bundled default
//! still comes from the swappable the swappable local model registry.

pub mod aa;
pub mod capabilities;
pub mod device;
pub mod gguf;
pub mod installed;
pub mod llmfit;
pub mod models_dev;
pub(crate) mod win_process;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use serde::Serialize;

use device::{estimate_fit, human_bytes, DeviceInfo};
use ryu_model_format::ModelFormat;

/// The bundled default chat/embed/reranker model repos, as `(id, weight_url)`.
/// Used only to derive a Hugging Face repo fallback for origin-less pre-existing
/// installs, so they resolve to a real repo card instead of a bare `local:` one.
pub type DefaultModelRepos = Vec<(String, String)>;

/// The narrow kernel seam this extracted primitive inverts back into Core.
///
/// The catalog itself is pure orchestration (HF search/detail, device-fit,
/// installed-model tracking), but five cross-cutting couplings are process-global
/// Core state. Core implements this once (`apps/core/src/model_catalog_host.rs`)
/// and installs it at boot via [`set_global_host`], BEFORE the first catalog call.
/// Production [`host`] is strict: it panics if the host was never installed rather
/// than silently defaulting to a wrong data dir / dropping HF auth.
#[async_trait::async_trait]
pub trait ModelCatalogHost: Send + Sync {
    /// The active Ryu data dir (`~/.ryu`, or its profile/relocation variant).
    /// All catalog caches, `installed-models.json`, and downloaded weights live
    /// under it. Resolved per call because the user can relocate it at runtime.
    fn ryu_dir(&self) -> PathBuf;

    /// Attach the user's Hugging Face bearer token (preferences-first, env
    /// fallback) to an outgoing Hub request and return the (possibly modified)
    /// builder. Pass-through when no token is configured; the token never leaves
    /// the host.
    fn authorize_hf(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder;

    /// Whether the named local engine (llama.cpp, vllm, sglang, mlx, …) is
    /// runnable on this Core node (platform + install gate). Drives the per-node
    /// format-compatibility verdict.
    fn supported_on_node(&self, engine: &str) -> bool;

    /// The bundled default chat + embedding model repos as `(id, weight_url)`,
    /// read from the swappable local model registry.
    fn default_model_repos(&self) -> DefaultModelRepos;

    /// The active-model preference raw value (the `ACTIVE_MODEL_PREF` KV entry),
    /// or `None` when unset or the preferences store can't be opened.
    async fn active_model_pref(&self) -> Option<String>;
}

fn host_slot() -> &'static OnceLock<Arc<dyn ModelCatalogHost>> {
    static HOST: OnceLock<Arc<dyn ModelCatalogHost>> = OnceLock::new();
    &HOST
}

/// Install the process-wide [`ModelCatalogHost`]. Called once at Core boot,
/// before any catalog call. Idempotent-friendly for tests (first install wins).
pub fn set_global_host(host: Arc<dyn ModelCatalogHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host. Strict by design: panics if [`set_global_host`] was
/// never called, rather than silently defaulting to a wrong data dir.
fn host() -> Arc<dyn ModelCatalogHost> {
    host_slot().get().cloned().expect(
        "ryu-model-catalog host not installed — call ryu_model_catalog::set_global_host at boot",
    )
}

/// The active Ryu data dir, via the installed host.
fn ryu_dir() -> PathBuf {
    host().ryu_dir()
}

/// Test-only host backed by a process-wide temp data dir, installed on first use
/// (idempotent — `set_global_host` is first-wins). Tests that touch a data-dir
/// path (`installed`, `capabilities`, `aa`, `models_dev` caches) call this first
/// so they never hit a real `~/.ryu` and never panic on a missing host. Mirrors
/// the `ryu-downloads` crate's own `TestHost` pattern.
#[cfg(test)]
pub(crate) fn ensure_test_host() {
    use std::sync::OnceLock;
    static TMP: OnceLock<PathBuf> = OnceLock::new();
    let dir = TMP
        .get_or_init(|| {
            let d =
                std::env::temp_dir().join(format!("ryu-model-catalog-test-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&d);
            d
        })
        .clone();

    struct TestHost {
        dir: PathBuf,
    }
    #[async_trait::async_trait]
    impl ModelCatalogHost for TestHost {
        fn ryu_dir(&self) -> PathBuf {
            self.dir.clone()
        }
        fn authorize_hf(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
            req
        }
        fn supported_on_node(&self, _engine: &str) -> bool {
            false
        }
        fn default_model_repos(&self) -> DefaultModelRepos {
            Vec::new()
        }
        async fn active_model_pref(&self) -> Option<String> {
            None
        }
    }
    set_global_host(Arc::new(TestHost { dir }));
}

const USER_AGENT: &str = "ryu-core/0.1 (+https://ryu.app)";

/// Whether an engine is runnable on this Core node (platform + install gate).
/// Thin wrapper so the capability helpers can be passed a plain `fn`.
fn engine_supported(name: &str) -> bool {
    host().supported_on_node(name)
}

/// The per-node compatibility verdict for a format: `(compatible, needs_engine)`.
/// `needs_engine` is the human label of the first engine that *could* serve the
/// format, shown when no serving engine is supported on this node. Computed on
/// the Core node so the verdict is authoritative even when the client is remote.
fn format_compat(fmt: ModelFormat) -> (bool, Option<String>) {
    let compatible = ryu_model_format::format_supported_on_node(fmt, engine_supported);
    let needs_engine = if compatible {
        None
    } else {
        ryu_model_format::needs_engine_label(fmt)
    };
    (compatible, needs_engine)
}

/// The active-model weight reference (stem or repo id) a given engine should
/// serve, when the user's active-model selection targets that engine. Returns
/// `None` when no selection is set, the selection is for another engine, or the
/// preferences store can't be opened — so providers fall through to their env /
/// default tier. This is the runtime-switch source feeding each provider's
/// `start()`, sitting *below* an explicit `with_model` override.
pub async fn active_model_ref_for_engine(engine: &str) -> Option<String> {
    let raw = host().active_model_pref().await?;
    let active = installed::parse_active_pref(&raw)?;
    if active.engine == engine && !active.r#ref.trim().is_empty() {
        Some(active.r#ref)
    } else {
        None
    }
}

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
    fn cache_tag(&self) -> &str {
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

// ── In-process TTL cache ─────────────────────────────────────────────────────
//
// Hugging Face detail needs 3 round-trips (info + tree + README), so it's the
// slow part of navigating the catalog. A short in-process cache makes repeat
// opens (and every non-react-query client — mobile, extension, CLI) fast without
// adding a dependency. Keyed by a string; values are pre-serialized JSON so one
// map serves both list and detail. The desktop layers its own client cache on
// top; this is the shared floor.

use std::sync::Mutex;
use std::time::{Duration, Instant};

const LIST_TTL: Duration = Duration::from_secs(60);
const DETAIL_TTL: Duration = Duration::from_secs(300);

struct CacheEntry {
    value: serde_json::Value,
    stored: Instant,
}

static CACHE: Mutex<Option<std::collections::HashMap<String, CacheEntry>>> = Mutex::new(None);

fn cache_get(key: &str, ttl: Duration) -> Option<serde_json::Value> {
    let guard = CACHE.lock().ok()?;
    let map = guard.as_ref()?;
    let entry = map.get(key)?;
    if entry.stored.elapsed() <= ttl {
        Some(entry.value.clone())
    } else {
        None
    }
}

fn cache_put(key: String, value: serde_json::Value) {
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
fn cache_invalidate(needle: &str) {
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

    fn hf_key(self) -> &'static str {
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
fn is_diffusion_pipeline_tag(tag: &str) -> bool {
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
    /// Machine-readable fit verdict (`great`/`ok`/`tight`/`too_big`/`unknown`).
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
    /// Machine-readable coarse fit verdict for a snapshot repo (`great`/`ok`/
    /// `unknown`/`too_big`). Empty for GGUF.
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

// ── HTTP helpers ─────────────────────────────────────────────────────────────

fn hf_get(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    let req = client.get(url).header("User-Agent", USER_AGENT);
    // Optional token (preferences-first, env fallback) raises rate limits and
    // unlocks gated repos for search, detail, and README/tree fetches.
    host().authorize_hf(req)
}

fn gated_to_bool(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(s) => !s.is_empty() && s != "false",
        _ => false,
    }
}

/// Pull the three surfaced GGUF spec fields out of an optional `gguf` block.
fn gguf_fields(g: &Option<HfGguf>) -> (Option<u64>, Option<String>, Option<u64>) {
    match g {
        Some(g) => (g.context_length, g.architecture.clone(), g.total),
        None => (None, None, None),
    }
}

fn split_id(id: &str) -> (String, String) {
    match id.split_once('/') {
        Some((a, n)) => (a.to_string(), n.to_string()),
        None => (String::new(), id.to_string()),
    }
}

// ── Quantization parsing (no regex dependency) ───────────────────────────────

/// A byte that separates name segments in a GGUF filename.
fn is_quant_sep(b: u8) -> bool {
    matches!(b, b'-' | b'_' | b'.' | b' ' | b'/')
}

/// Try to match a GGUF quant token starting exactly at `i`, returning its byte
/// length. Recognizes the four quant *families* by grammar instead of a fixed
/// token list, so community suffix variants (`Q4_K_P`, `Q4_K_XL`, `Q8_K_P`, …)
/// resolve too:
/// - importance-matrix: `IQ<1-4>_<letters>` (IQ2_XXS, IQ4_NL)
/// - K-quant: `Q<1-8>_K` with an optional `_<letters>` suffix (Q6_K, Q4_K_M, Q4_K_XL)
/// - legacy: `Q<1-8>_<0-1>` (Q4_0, Q8_0)
/// - float: `BF16`, `F16`, `F32`
fn match_quant_at(b: &[u8], i: usize) -> Option<usize> {
    let n = b.len();
    // Float formats.
    for tok in [b"BF16".as_slice(), b"F16", b"F32"] {
        if b[i..].starts_with(tok) {
            return Some(tok.len());
        }
    }
    // Importance-matrix: I Q <1-4> _ <letters+>
    if b[i] == b'I'
        && i + 3 < n
        && b[i + 1] == b'Q'
        && (b'1'..=b'4').contains(&b[i + 2])
        && b[i + 3] == b'_'
    {
        let mut j = i + 4;
        while j < n && b[j].is_ascii_alphabetic() {
            j += 1;
        }
        if j > i + 4 {
            return Some(j - i);
        }
    }
    // Q-quant: Q <1-8> _ …
    if b[i] == b'Q' && i + 3 < n && (b'1'..=b'8').contains(&b[i + 1]) && b[i + 2] == b'_' {
        // K-quant with an optional `_<letters>` suffix.
        if b[i + 3] == b'K' {
            let mut j = i + 4;
            if j < n && b[j] == b'_' {
                let mut k = j + 1;
                while k < n && b[k].is_ascii_alphabetic() {
                    k += 1;
                }
                if k > j + 1 {
                    j = k;
                }
            }
            return Some(j - i);
        }
        // Legacy: Q<d>_<0|1>.
        if b[i + 3] == b'0' || b[i + 3] == b'1' {
            return Some(4);
        }
    }
    None
}

/// Extract the quantization label from a GGUF filename, if present. Scans for a
/// separator-bounded quant token (see [`match_quant_at`]) and keeps the longest
/// match, so `gemma-4-it-Q4_K_M.gguf` → `Q4_K_M` and `model-Q3_K_P.gguf` →
/// `Q3_K_P`. Returns `None` only for genuinely non-standard / mixed quants.
fn parse_quant(filename: &str) -> Option<String> {
    let upper = filename.to_uppercase();
    let b = upper.as_bytes();
    let mut best: Option<(usize, usize)> = None;
    let mut i = 0;
    while i < b.len() {
        if let Some(len) = match_quant_at(b, i) {
            let left_ok = i == 0 || is_quant_sep(b[i - 1]);
            let right = i + len;
            let right_ok = right == b.len() || is_quant_sep(b[right]);
            if left_ok && right_ok {
                if best.is_none_or(|(_, bl)| len > bl) {
                    best = Some((i, len));
                }
                i = right;
                continue;
            }
        }
        i += 1;
    }
    best.map(|(s, l)| upper[s..s + l].to_string())
}

/// Local file stem used to store a downloaded GGUF (`~/.ryu/models/<stem>.gguf`).
fn local_stem(filename: &str) -> String {
    filename.trim_end_matches(".gguf").to_string()
}

/// Reject anything that isn't a single, safe GGUF filename. The name must be one
/// normal path component — no `/`, `\`, `..`, or leading `.` — ending in
/// `.gguf`. This is security-critical: `filename` becomes the on-disk stem
/// (`~/.ryu/models/<stem>.gguf` via [`LocalModelEntry::weight_path`]), so an
/// unchecked `..`, path separator, or absolute path from the install endpoint
/// would let a caller write the downloaded bytes anywhere on disk (path
/// traversal / arbitrary file write).
fn validate_gguf_filename(name: &str) -> Result<()> {
    use std::ffi::OsStr;
    use std::path::{Component, Path};

    if !name.to_lowercase().ends_with(".gguf") {
        anyhow::bail!("only .gguf files can be installed (got {name})");
    }
    if name.starts_with('.') || name.contains('/') || name.contains('\\') {
        anyhow::bail!("unsafe filename: {name}");
    }
    // The whole string must be exactly one normal component (rejects `.`, `..`,
    // and Windows drive/UNC prefixes that `PathBuf::join` would otherwise honor).
    let mut comps = Path::new(name).components();
    match (comps.next(), comps.next()) {
        (Some(Component::Normal(only)), None) if only == OsStr::new(name) => Ok(()),
        _ => anyhow::bail!("unsafe filename: {name}"),
    }
}

/// Validate a Hugging Face repo id (`author/name`). Both segments must be
/// non-empty, free of `..`, and contain only `[A-Za-z0-9._-]`. `repo_id` is
/// interpolated into Hub URLs and used to look up the expected checksum, so an
/// unvalidated id could manipulate the request path.
fn validate_repo_id(id: &str) -> Result<()> {
    fn ok_segment(s: &str) -> bool {
        !s.is_empty()
            && s != "."
            && s != ".."
            && !s.contains("..")
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    }
    match id.split_once('/') {
        Some((author, name)) if ok_segment(author) && ok_segment(name) => Ok(()),
        _ => anyhow::bail!("unsafe repo id: {id}"),
    }
}

// ── Search ───────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct HfListItem {
    id: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pipeline_tag: Option<String>,
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
    #[serde(default)]
    gguf: Option<HfGguf>,
}

/// The Hub's parsed GGUF metadata block (`gguf` on a model). The Hub reads this
/// from a representative GGUF file in the repo, so it is repo-level, not
/// per-quant. Returned in detail by default and in list responses when the
/// `gguf` expand field is requested (see [`search_models`]).
#[derive(serde::Deserialize)]
struct HfGguf {
    /// Context window in tokens (the single prompt+completion budget).
    #[serde(default)]
    context_length: Option<u64>,
    /// Architecture id, e.g. `"llama"`, `"gemma3"`.
    #[serde(default)]
    architecture: Option<String>,
    /// Total parameter count.
    #[serde(default)]
    total: Option<u64>,
}

/// Restrict a search to one Hugging Face task. `task` is a raw HF `pipeline_tag`
/// value (e.g. `"sentence-similarity"` for embeddings, `"text-generation"` for
/// chat, `"automatic-speech-recognition"` for speech-to-text). The friendly
/// category → tag mapping lives in the client; Core just forwards the tag so the
/// taxonomy stays swappable and no category is hardcoded here. An empty string
/// means "any task". HF accepts a single `pipeline_tag` value, so this filter is
/// single-select by nature.
fn sanitize_task(task: &str) -> Option<String> {
    let t = task.trim();
    if t.is_empty() {
        return None;
    }
    // Pipeline tags are lowercase ASCII words joined by hyphens; reject anything
    // else so the value can't smuggle extra query parameters into the Hub URL.
    let ok = t
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    ok.then(|| t.to_string())
}

/// Restrict a search to one Hugging Face org/user (the "browse this org" filter).
/// `author` is a Hub namespace (e.g. `google`, `unsloth`). HF usernames/org names
/// are ASCII alphanumerics with `-`, `_`, and `.`; reject anything else so the
/// value can't smuggle extra query parameters into the Hub URL. Empty = no filter.
fn sanitize_author(author: &str) -> Option<String> {
    let a = author.trim();
    if a.is_empty() {
        return None;
    }
    let ok = a
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    ok.then(|| a.to_string())
}

/// One page of search results: the cards plus an opaque cursor for the next page
/// (`None` when there are no more results, or for the local installed view).
pub struct ModelPage {
    pub models: Vec<ModelCard>,
    pub next_cursor: Option<String>,
}

/// Search the Hub for GGUF models. When `installed_only` is true we bypass the
/// network entirely and return exactly the models the user has downloaded, so
/// the installed view works offline. `task` optionally narrows results to one
/// Hugging Face pipeline tag (see [`sanitize_task`]).
///
/// `cursor` drives infinite-scroll pagination: pass `None` for the first page,
/// then the `next_cursor` of the previous page for each subsequent page. The Hub
/// returns the cursor in a `Link: rel="next"` header (see [`parse_next_cursor`]);
/// it is opaque and already percent-encoded, so we forward it verbatim and never
/// re-encode it. The base params (filter/sort/task/search) must stay identical
/// across pages, which is naturally the case since they form the cache/query key.
pub async fn search_models(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    query: &str,
    sort: CatalogSort,
    format: ModelFormat,
    limit: usize,
    installed_only: bool,
    task: &str,
    author: &str,
    cursor: Option<&str>,
) -> Result<ModelPage> {
    if installed_only {
        return Ok(ModelPage {
            models: installed_cards_enriched(client, endpoint).await,
            next_cursor: None,
        });
    }

    let limit = limit.clamp(1, 100);
    let api_base = &endpoint.api_base;
    // Format is a per-call facet (one clean HF cursor per format); the desktop
    // fans out across formats. `filter=gguf` is no longer hardcoded — each
    // format supplies its own Hub filter, and MLX (which has none) is scoped to
    // the `mlx-community` org when the caller didn't already pick an author.
    let mut url = format!(
        "{api_base}/models?sort={}&direction=-1&limit={limit}",
        sort.hf_key()
    );
    if let Some(f) = format.hf_filter() {
        url.push_str(&format!("&filter={f}"));
    }
    if format == ModelFormat::Mlx && sanitize_author(author).is_none() {
        url.push_str("&author=mlx-community");
    }
    // Request the extra columns the cards render via the Hub's `expand`
    // projection — most importantly `gguf` (the context window). `expand`
    // returns *only* the listed fields, so every column the cards use must
    // appear here. An HF-compatible mirror that ignores `expand` simply returns
    // its default shape and the missing fields deserialize to `None` (graceful).
    for field in [
        "gguf",
        "downloads",
        "likes",
        "tags",
        "pipeline_tag",
        "gated",
        "createdAt",
        "lastModified",
    ] {
        url.push_str(&format!("&expand[]={field}"));
    }
    if let Some(tag) = sanitize_task(task) {
        url.push_str(&format!("&pipeline_tag={}", urlencoding::encode(&tag)));
    }
    // Org/user browse filter — restricts to one Hub namespace.
    if let Some(org) = sanitize_author(author) {
        url.push_str(&format!("&author={}", urlencoding::encode(&org)));
    }
    if !query.trim().is_empty() {
        url.push_str(&format!("&search={}", urlencoding::encode(query.trim())));
    }
    // The cursor arrives already percent-encoded (extracted verbatim from the
    // Hub's Link header, decoded exactly once by the client/axum round-trip), so
    // it is appended as-is — re-encoding here would double-encode and break it.
    if let Some(c) = cursor.filter(|c| !c.is_empty()) {
        url.push_str(&format!("&cursor={c}"));
    }

    let resp = hf_get(client, &url)
        .send()
        .await
        .context("requesting Hugging Face model list")?;
    if !resp.status().is_success() {
        anyhow::bail!("Hugging Face list returned HTTP {}", resp.status());
    }
    // Read the pagination cursor from the headers before `.json()` consumes the body.
    let next_cursor = parse_next_cursor(resp.headers().get(reqwest::header::LINK));
    let items: Vec<HfListItem> = resp.json().await.context("parsing model list")?;

    let installed = installed::installed_repo_ids();
    let (compatible, needs_engine) = format_compat(format);
    let models = items
        .into_iter()
        .map(|it| {
            let (author, name) = split_id(&it.id);
            let installed = installed.contains(&it.id);
            let (context_length, architecture, params) = gguf_fields(&it.gguf);
            // Detect diffusion from pipeline_tag first (reliable); fall back to
            // architecture for repos where the tag is absent but the gguf block is.
            let diffusion = it
                .pipeline_tag
                .as_deref()
                .map(is_diffusion_pipeline_tag)
                .unwrap_or_else(|| {
                    architecture
                        .as_deref()
                        .is_some_and(gguf::is_diffusion_architecture)
                });
            ModelCard {
                installed,
                author,
                name,
                downloads: it.downloads,
                likes: it.likes,
                pipeline_tag: it.pipeline_tag,
                tags: it.tags,
                gated: gated_to_bool(&it.gated),
                last_modified: it.last_modified,
                created_at: it.created_at,
                context_length,
                architecture,
                params,
                id: it.id,
                format,
                compatible,
                needs_engine: needs_engine.clone(),
                diffusion,
            }
        })
        .collect();
    Ok(ModelPage {
        models,
        next_cursor,
    })
}

/// Extract the `cursor` value from a Hugging Face `Link` header's `rel="next"`
/// entry, returning it in its original percent-encoded form (so it can be
/// forwarded verbatim into the next request URL). Returns `None` when there is no
/// next page. We extract only the cursor — not the whole next URL — so a malicious
/// header can never redirect the follow-up request elsewhere (SSRF-safe).
fn parse_next_cursor(link: Option<&reqwest::header::HeaderValue>) -> Option<String> {
    let header = link?.to_str().ok()?;
    // A Link header may hold several comma-separated entries; the cursor is
    // base64url+percent-encoded, so it never contains a raw comma.
    for part in header.split(',') {
        if !part.contains("rel=\"next\"") {
            continue;
        }
        let start = part.find('<')? + 1;
        let end = part[start..].find('>')? + start;
        let next_url = &part[start..end];
        let cpos = next_url.find("cursor=")? + "cursor=".len();
        let value = next_url[cpos..]
            .split('&')
            .next()
            .unwrap_or(&next_url[cpos..]);
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Build cards for the offline installed view by scanning the on-disk models
/// directory (`~/.ryu/models/*.gguf`) — the same source of truth the per-model
/// `installed` badge uses — and resolving each file's origin repo from the
/// provenance store, falling back to the bundled-default registry entry. Files
/// with no known origin still appear as local entries so nothing the user has
/// downloaded is hidden.
fn installed_cards() -> Vec<ModelCard> {
    // stem → repo_id, from recorded provenance.
    let mut stem_to_repo: std::collections::HashMap<String, String> = installed::load_present()
        .into_iter()
        .map(|m| (m.stem, m.repo_id))
        .collect();

    // The bundled default chat + embedding models are downloaded at onboarding
    // (not via the catalog install endpoint). Newer installs record provenance
    // there, but derive the repo from the registry's weight URL as a fallback so
    // pre-existing installs (and the nomic embedding GGUF) resolve to their real
    // Hugging Face repo instead of showing up as an origin-less `local:` card.
    for (id, weight_url) in host().default_model_repos() {
        if let Some(repo) = repo_from_hf_url(&weight_url) {
            stem_to_repo.entry(id).or_insert(repo);
        }
    }

    // De-dupe by repo (or by stem for origin-less local files), preserving a
    // stable alphabetical order.
    let (gguf_compatible, gguf_needs) = format_compat(ModelFormat::Gguf);
    let mut seen = std::collections::BTreeMap::<String, ModelCard>::new();
    for stem in on_disk_gguf_stems() {
        let (key, id, author, name) = match stem_to_repo.get(&stem) {
            Some(repo) => {
                let (author, name) = split_id(repo);
                (repo.clone(), repo.clone(), author, name)
            }
            None => (
                format!("local:{stem}"),
                String::new(),
                "local".to_string(),
                stem.clone(),
            ),
        };
        // Detect diffusion from the on-disk GGUF metadata (secondary probe; the
        // enriched path below overwrites this with the Hub pipeline_tag when online).
        let diffusion = capabilities::detect_local_is_diffusion(&stem);
        seen.entry(key).or_insert(ModelCard {
            id,
            author,
            name,
            downloads: 0,
            likes: 0,
            pipeline_tag: None,
            tags: Vec::new(),
            gated: false,
            last_modified: None,
            created_at: None,
            context_length: None,
            architecture: None,
            params: None,
            installed: true,
            format: ModelFormat::Gguf,
            compatible: gguf_compatible,
            needs_engine: gguf_needs.clone(),
            diffusion,
        });
    }

    // Snapshot installs (safetensors / MLX) live in a directory, not as a
    // `.gguf` file, so `on_disk_gguf_stems` never sees them — add them from the
    // provenance index (which `load_present` already filters to present-on-disk).
    for m in installed::load_present() {
        if m.format == ModelFormat::Gguf {
            continue;
        }
        let key = if m.repo_id.is_empty() {
            format!("local:{}", m.stem)
        } else {
            m.repo_id.clone()
        };
        let (author, name) = split_id(&m.repo_id);
        let (compatible, needs_engine) = format_compat(m.format);
        seen.entry(key).or_insert(ModelCard {
            id: m.repo_id.clone(),
            author,
            name,
            downloads: 0,
            likes: 0,
            pipeline_tag: None,
            tags: Vec::new(),
            gated: false,
            last_modified: None,
            created_at: None,
            context_length: None,
            architecture: None,
            params: None,
            installed: true,
            format: m.format,
            compatible,
            needs_engine,
            diffusion: false,
        });
    }
    seen.into_values().collect()
}

/// Enrich the offline installed cards with live Hugging Face metadata
/// (downloads, likes, tags, task, gated, dates) so the installed-only view shows
/// the same numbers as the browse list instead of zeros. Best-effort and
/// per-card: a card whose repo can't be resolved (an origin-less `local:` file)
/// or whose fetch fails (offline) keeps its local values, so the installed view
/// still works with no network — it just shows zero counts until reconnected.
async fn installed_cards_enriched(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
) -> Vec<ModelCard> {
    let mut cards = installed_cards();
    for card in &mut cards {
        // Origin-less local files have no Hub repo to enrich from.
        if card.id.is_empty() {
            continue;
        }
        if let Some(meta) = fetch_card_meta(client, endpoint, &card.id).await {
            card.downloads = meta.downloads;
            card.likes = meta.likes;
            card.tags = meta.tags;
            card.gated = gated_to_bool(&meta.gated);
            card.last_modified = meta.last_modified;
            card.created_at = meta.created_at;
            let (context_length, architecture, params) = gguf_fields(&meta.gguf);
            card.context_length = context_length;
            card.params = params;
            // Refresh diffusion from the Hub pipeline_tag (more reliable than
            // GGUF architecture for models whose metadata omits the arch key).
            let tag = meta.pipeline_tag;
            card.diffusion = tag
                .as_deref()
                .map(is_diffusion_pipeline_tag)
                .unwrap_or_else(|| {
                    architecture
                        .as_deref()
                        .is_some_and(gguf::is_diffusion_architecture)
                })
                || card.diffusion; // keep local detection if Hub provides nothing
            card.architecture = architecture;
            card.pipeline_tag = tag;
        }
    }
    cards
}

/// Best-effort fetch of one model's Hub metadata (the info endpoint only — no
/// tree/README round-trips), used to enrich installed cards. `None` on any
/// failure so the caller falls back to the local card.
async fn fetch_card_meta(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
) -> Option<HfModelInfo> {
    if validate_repo_id(id).is_err() {
        return None;
    }
    let url = format!("{}/models/{id}", endpoint.api_base);
    let resp = hf_get(client, &url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<HfModelInfo>().await.ok()
}

/// Record provenance for a model downloaded *outside* the catalog install path
/// (the onboarding default chat + embedding GGUFs). Derives the origin repo and
/// original filename from the Hugging Face `weight_url` so the installed view
/// resolves the same repo, friendly name, and quantization as a catalog install
/// — instead of a bare `local:<stem>` card with no metadata. Idempotent on
/// `stem`; best-effort (a write failure is logged by the caller, never fatal).
pub fn record_default_download(
    stem: &str,
    weight_url: &str,
    size_bytes: Option<u64>,
    mmproj: Option<String>,
) -> Result<()> {
    // Original filename = the URL's last path segment (drop any query string).
    let filename = weight_url
        .rsplit('/')
        .next()
        .map(|s| s.split('?').next().unwrap_or(s))
        .filter(|s| !s.is_empty())
        .unwrap_or(stem)
        .to_string();
    installed::record(installed::InstalledModel {
        repo_id: repo_from_hf_url(weight_url).unwrap_or_default(),
        filename,
        stem: stem.to_string(),
        size_bytes,
        format: ModelFormat::Gguf,
        mmproj,
        finetune_base: None,
    })
}

/// Delete an installed GGUF file and drop its provenance record. The on-disk
/// file is the source of truth for "installed", so it is removed first; the
/// provenance entry is then cleared and the relevant caches invalidated so the
/// catalog reflects the change on the next fetch. Idempotent: succeeds even if
/// the file (or record) was already gone. `repo_id` is used only to scope cache
/// invalidation, so it need not be a valid Hub id.
pub fn uninstall_file(repo_id: &str, filename: &str) -> Result<()> {
    // The filename becomes the on-disk stem; reject traversal before touching FS.
    validate_gguf_filename(filename)?;
    let stem = local_stem(filename);
    let path = ryu_dir().join("models").join(format!("{stem}.gguf"));
    if path.exists() {
        std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
    }
    // Remove the bound vision adapter too, if this model had one — the projector
    // is keyed to the model's stem (`<stem>.mmproj.gguf`), so it would otherwise
    // be orphaned. Best-effort: a missing file is fine.
    let mmproj = installed::mmproj_file_path(&stem);
    if mmproj.exists() {
        if let Err(e) = std::fs::remove_file(&mmproj) {
            tracing::warn!("removing vision adapter {} failed: {e}", mmproj.display());
        }
    }
    installed::remove(&stem)?;

    // Installed state changed — drop cached detail for this repo + all lists.
    cache_invalidate(repo_id);
    cache_invalidate("list:");
    Ok(())
}

/// Extract the `author/name` repo id from a Hugging Face `resolve` URL, e.g.
/// `https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/x.gguf`.
pub fn repo_from_hf_url(url: &str) -> Option<String> {
    let rest = url.split("huggingface.co/").nth(1)?;
    let repo = rest.split("/resolve/").next()?;
    if repo.contains('/') && !repo.is_empty() {
        Some(repo.to_string())
    } else {
        None
    }
}

/// Stems of every model `*.gguf` file currently in `~/.ryu/models/`. Excludes
/// vision adapters (`*.mmproj.gguf`): a projector is a companion of a model, not
/// a selectable/activatable model itself, so it must never surface as its own
/// catalog card (and must never be served as `--model`).
fn on_disk_gguf_stems() -> Vec<String> {
    let dir = ryu_dir().join("models");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.to_ascii_lowercase().ends_with(".mmproj.gguf") {
                return None;
            }
            name.strip_suffix(".gguf").map(str::to_string)
        })
        .collect()
}

// ── Detail ─────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct HfModelInfo {
    id: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    pipeline_tag: Option<String>,
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default, rename = "createdAt")]
    created_at: Option<String>,
    #[serde(default)]
    gguf: Option<HfGguf>,
    #[serde(default)]
    siblings: Vec<HfSibling>,
}

#[derive(serde::Deserialize)]
struct HfSibling {
    rfilename: String,
}

#[derive(serde::Deserialize)]
struct HfTreeEntry {
    #[serde(default)]
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    lfs: Option<HfLfs>,
}

#[derive(serde::Deserialize)]
struct HfLfs {
    #[serde(default)]
    oid: Option<String>,
    #[serde(default)]
    size: u64,
}

/// Fetch the full detail for one model. For GGUF this is the per-file quant list
/// with device-fit; for a snapshot format (safetensors/MLX) `files` is empty and
/// the repo-level `repo_*` fields carry the total size + a **conservative** fit
/// verdict (these engines load the whole repo, so the optimistic GGUF
/// "partial offload" copy must not be reused). `format` is the facet the client
/// was browsing.
pub async fn model_detail(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
    format: ModelFormat,
) -> Result<ModelDetail> {
    // Defense-in-depth: the id is interpolated into the info/tree/README URLs.
    // The install path already validates, but with a custom (user-supplied) host
    // the detail path is also attacker-reachable, so reject unsafe ids here too.
    validate_repo_id(id)?;
    let info_url = format!("{}/models/{id}", endpoint.api_base);
    let resp = hf_get(client, &info_url)
        .send()
        .await
        .context("requesting model info")?;
    if !resp.status().is_success() {
        anyhow::bail!("Hugging Face model info returned HTTP {}", resp.status());
    }
    let info: HfModelInfo = resp.json().await.context("parsing model info")?;

    let device = DeviceInfo::detect();
    let installed_set = installed::installed_repo_ids();
    let (author, name) = split_id(&info.id);

    // File sizes + LFS checksums come from the tree endpoint (siblings carry
    // only filenames). Best-effort: if the tree call fails we still list files
    // without sizes rather than failing the whole detail view. The tree is
    // filtered to this format's weight files.
    let sizes = fetch_tree_sizes(client, endpoint, id, format)
        .await
        .unwrap_or_default();

    // GGUF: per-file quant list with per-file device-fit (unchanged behaviour).
    // Snapshot: no per-file picker — leave `files` empty and use repo-level fit.
    // A GGUF vision model ships its projector as a separate `mmproj-*.gguf`. It
    // is not a selectable weight quant, so keep it out of the picker — but record
    // that the repo is vision-capable so the UI can badge it and the user knows
    // the adapter is auto-installed alongside whichever quant they pick.
    let vision = format == ModelFormat::Gguf
        && info.siblings.iter().any(|s| {
            s.rfilename.to_lowercase().ends_with(".gguf") && is_mmproj_filename(&s.rfilename)
        });

    let mut files: Vec<GgufFile> = if format == ModelFormat::Gguf {
        info.siblings
            .iter()
            .filter(|s| {
                s.rfilename.to_lowercase().ends_with(".gguf") && !is_mmproj_filename(&s.rfilename)
            })
            .map(|s| {
                let (size_bytes, sha256) = sizes.get(&s.rfilename).cloned().unwrap_or((None, None));
                let stem = local_stem(&s.rfilename);
                let installed = models_dir_has(&stem);
                let fit = estimate_fit(size_bytes, &device);
                GgufFile {
                    quant: parse_quant(&s.rfilename),
                    size_human: size_bytes.map(human_bytes).unwrap_or_default(),
                    size_bytes,
                    sha256,
                    url: format!("{}/{id}/resolve/main/{}", endpoint.host, s.rfilename),
                    installed,
                    fit: fit.as_str().to_string(),
                    fit_label: fit.label().to_string(),
                    filename: s.rfilename.clone(),
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    // Installed files float to the top (so what you have is always visible
    // first); within each group, smallest-first puts the friendliest (most
    // likely to fit) option on top.
    files.sort_by(|a, b| {
        b.installed.cmp(&a.installed).then(
            a.size_bytes
                .unwrap_or(u64::MAX)
                .cmp(&b.size_bytes.unwrap_or(u64::MAX)),
        )
    });

    // Repo-level snapshot size + conservative fit (empty for GGUF).
    let (repo_size_bytes, repo_fit, repo_fit_label) = if format == ModelFormat::Gguf {
        (None, String::new(), String::new())
    } else {
        let total: u64 = sizes.values().filter_map(|(s, _)| *s).sum();
        let total = (total > 0).then_some(total);
        let (fit, label) = snapshot_fit(total, &device);
        (total, fit, label)
    };

    let readme = fetch_readme(client, endpoint, id).await;
    let stats = aa::stats_for(client, &name, &info.id).await;

    let (compatible, needs_engine) = format_compat(format);
    let (context_length, architecture, params) = gguf_fields(&info.gguf);
    let diffusion = info
        .pipeline_tag
        .as_deref()
        .map(is_diffusion_pipeline_tag)
        .unwrap_or_else(|| {
            architecture
                .as_deref()
                .is_some_and(gguf::is_diffusion_architecture)
        });
    let card = ModelCard {
        installed: installed_set.contains(&info.id) || files.iter().any(|f| f.installed),
        author,
        name,
        downloads: info.downloads,
        likes: info.likes,
        pipeline_tag: info.pipeline_tag,
        tags: info.tags,
        gated: gated_to_bool(&info.gated),
        last_modified: info.last_modified,
        created_at: info.created_at,
        context_length,
        architecture,
        params,
        id: info.id.clone(),
        format,
        compatible,
        needs_engine,
        diffusion,
    };

    Ok(ModelDetail {
        card,
        readme,
        format,
        files,
        vision,
        repo_size_bytes,
        repo_fit,
        repo_fit_label,
        stats,
        stats_api_key_present: aa::has_api_key(),
        device,
    })
}

/// Conservative repo-level fit verdict for a snapshot model. Unlike GGUF, vLLM/
/// MLX load the whole repo into memory, so anything short of a clean GPU fit is
/// reported as "may not fit" rather than the optimistic "partial offload" copy.
fn snapshot_fit(total: Option<u64>, device: &DeviceInfo) -> (String, String) {
    let Some(bytes) = total else {
        return (
            "unknown".to_string(),
            "Size unknown — check the model card before installing.".to_string(),
        );
    };
    let verdict = estimate_fit(Some(bytes), device);
    match verdict {
        device::FitVerdict::Great | device::FitVerdict::Ok => {
            (verdict.as_str().to_string(), verdict.label().to_string())
        }
        device::FitVerdict::Unknown => (
            "unknown".to_string(),
            "Can't check your device — verify the model fits before installing.".to_string(),
        ),
        _ => (
            "too_big".to_string(),
            format!(
                "This {} model may not fit — these engines load the whole repo into memory.",
                human_bytes(bytes)
            ),
        ),
    }
}

/// Map of repo-relative path → (size_bytes, sha256) from the Hub tree endpoint,
/// restricted to the weight + config files of `format`. The keys are the
/// recursive repo-relative paths, so a snapshot install can mirror the tree
/// under the snapshot dir. GGUF callers pass `ModelFormat::Gguf` for identical
/// `.gguf`-only behaviour.
async fn fetch_tree_sizes(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
    format: ModelFormat,
) -> Result<std::collections::HashMap<String, (Option<u64>, Option<String>)>> {
    let url = format!("{}/models/{id}/tree/main?recursive=true", endpoint.api_base);
    let resp = hf_get(client, &url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("tree HTTP {}", resp.status());
    }
    let entries: Vec<HfTreeEntry> = resp.json().await?;
    let mut map = std::collections::HashMap::new();
    for e in entries {
        let lower = e.path.to_lowercase();
        if !format
            .weight_extensions()
            .iter()
            .any(|ext| lower.ends_with(ext))
        {
            continue;
        }
        let (size, sha) = match e.lfs {
            // LFS files: the lfs block carries the real size + sha256 oid.
            Some(lfs) => (Some(if lfs.size > 0 { lfs.size } else { e.size }), lfs.oid),
            None => (if e.size > 0 { Some(e.size) } else { None }, None),
        };
        map.insert(e.path, (size, sha));
    }
    Ok(map)
}

/// Fetch + clean the README. Strips a leading YAML front-matter block (the
/// `--- ... ---` metadata) that only adds noise for a reader. Returns `None`
/// when the repo has no README or the fetch fails.
async fn fetch_readme(client: &reqwest::Client, endpoint: &HfEndpoint, id: &str) -> Option<String> {
    let url = format!("{}/{id}/raw/main/README.md", endpoint.host);
    let resp = hf_get(client, &url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let raw = resp.text().await.ok()?;
    Some(strip_front_matter(&raw))
}

/// Remove a leading `---\n...\n---\n` YAML front-matter block if present.
fn strip_front_matter(md: &str) -> String {
    let trimmed = md.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        // Find the closing delimiter on its own line.
        if let Some(end) = rest.find("\n---") {
            let after = &rest[end + 4..];
            return after.trim_start_matches(['\n', '\r']).to_string();
        }
    }
    md.to_string()
}

// ── Cached JSON wrappers (the shared latency floor for every client) ────────

/// Cached form of [`search_models`], returning
/// `{ "models": [...], "next_cursor": "…"|null }`. The installed-only view is
/// never cached (it's local + must stay fresh).
pub async fn search_models_json(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    query: &str,
    sort: CatalogSort,
    format: ModelFormat,
    limit: usize,
    installed_only: bool,
    task: &str,
    author: &str,
    cursor: Option<&str>,
) -> Result<serde_json::Value> {
    // `format`, `task`, `author` and `cursor` are part of the cache key: without
    // them, switching format/category/org or paging would collide on the same
    // cached list. The endpoint host is prefixed so two sources never serve each
    // other's cached results.
    let key = format!(
        "list:{}:{}:{}:{limit}:{task}:{author}:{}:{query}",
        endpoint.cache_tag(),
        format.as_str(),
        sort.hf_key(),
        cursor.unwrap_or("")
    );
    if !installed_only {
        if let Some(v) = cache_get(&key, LIST_TTL) {
            return Ok(v);
        }
    }
    let page = search_models(
        client,
        endpoint,
        query,
        sort,
        format,
        limit,
        installed_only,
        task,
        author,
        cursor,
    )
    .await?;
    let value = serde_json::json!({ "models": page.models, "next_cursor": page.next_cursor });
    if !installed_only {
        cache_put(key, value.clone());
    }
    Ok(value)
}

/// Cached form of [`model_detail`], returning the serialized detail object.
pub async fn model_detail_json(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    id: &str,
    format: ModelFormat,
) -> Result<serde_json::Value> {
    let key = format!("detail:{}:{}:{id}", endpoint.cache_tag(), format.as_str());
    if let Some(v) = cache_get(&key, DETAIL_TTL) {
        return Ok(v);
    }
    let detail = model_detail(client, endpoint, id, format).await?;
    let value = serde_json::to_value(detail)?;
    cache_put(key, value.clone());
    Ok(value)
}

// ── Install ───────────────────────────────────────────────────────────────

/// The outcome of installing a GGUF file.
#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub repo_id: String,
    pub filename: String,
    pub path: String,
}

/// Download + verify a specific GGUF file from a repo, reusing the shared
/// [`GgufDownloader`] (checksum-verified, atomic, retrying). Records provenance
/// so the catalog can show it as installed.
/// Build the [`ryu_downloads::DownloadSpec`] for a GGUF weight, matching the
/// version-store key (`gguf:<id>`) the old `GgufDownloader` used so the
/// fast-path checksum-skip and provenance stay consistent.
pub fn gguf_download_spec(
    id: &str,
    weight_url: &str,
    sha256: &str,
    label: &str,
) -> ryu_downloads::DownloadSpec {
    ryu_downloads::DownloadSpec {
        kind: ryu_downloads::DownloadKind::Model,
        label: label.to_string(),
        url: weight_url.to_string(),
        // `~/.ryu/models/<id>.gguf` — matches the local model registry's
        // `LocalModelEntry::weight_path()` so the version-store key + fast-path
        // checksum-skip stay identical to the pre-extraction path.
        dest: ryu_dir().join("models").join(format!("{id}.gguf")),
        sha256: (!sha256.is_empty()).then(|| sha256.to_string()),
        version_record: Some(ryu_downloads::VersionRecord {
            store_key: format!("gguf:{id}"),
            version: id.to_string(),
        }),
    }
}

/// Default multimodal-projector precision preference. `f16` is the standard,
/// widely-published mmproj precision and a safe default across uploaders;
/// overridable via `RYU_MMPROJ_QUANT` so nothing is hardcoded.
const DEFAULT_MMPROJ_QUANT: &str = "f16";

/// Whether a repo file is a multimodal projector ("vision adapter") rather than
/// a model weight quant. llama.cpp ships a vision model's projector as a
/// separate `mmproj-*.gguf` companion; uploaders name it inconsistently
/// (`mmproj-F16.gguf`, `mmproj-model-f16.gguf`, …) but every variant carries the
/// `mmproj` token, so a substring match is the dominant, uploader-agnostic
/// signal. Used both to detect a vision repo and to keep the projector out of
/// the user-facing quant picker.
pub(crate) fn is_mmproj_filename(name: &str) -> bool {
    name.to_ascii_lowercase().contains("mmproj")
}

/// Pick the best multimodal projector from a repo tree map (path → size/sha).
/// Prefers the configured precision (`RYU_MMPROJ_QUANT`, default `f16`), then any
/// `f16`, then the smallest remaining candidate (a deterministic tiebreak).
/// Returns the chosen `(filename, size_bytes, sha256)`, or `None` when the repo
/// ships no projector (a text-only model). Only single-component `.gguf`
/// filenames qualify, so a nested repo path can never become the on-disk adapter
/// name.
fn pick_mmproj(
    sizes: &std::collections::HashMap<String, (Option<u64>, Option<String>)>,
) -> Option<(String, Option<u64>, Option<String>)> {
    let pref = std::env::var("RYU_MMPROJ_QUANT")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MMPROJ_QUANT.to_string())
        .to_ascii_lowercase();

    let mut candidates: Vec<(String, Option<u64>, Option<String>)> = sizes
        .iter()
        .filter(|(path, _)| {
            let lower = path.to_ascii_lowercase();
            is_mmproj_filename(&lower)
                && lower.ends_with(".gguf")
                && !path.contains('/')
                && !path.contains('\\')
        })
        .map(|(p, (s, sha))| (p.clone(), *s, sha.clone()))
        .collect();
    if candidates.is_empty() {
        return None;
    }

    // Stable sort by size first (smallest = the deterministic baseline), then by
    // precision score — the stable pass preserves smallest-first within a score.
    candidates.sort_by_key(|(_, size, _)| size.unwrap_or(u64::MAX));
    let score = |name: &str| -> u8 {
        let l = name.to_ascii_lowercase();
        if l.contains(&pref) {
            0
        } else if l.contains("f16") {
            1
        } else {
            2
        }
    };
    candidates.sort_by_key(|(name, _, _)| score(name));
    candidates.into_iter().next()
}

/// Download the multimodal projector `filename` from `repo_id` and store it as
/// the vision adapter bound to `model_stem` (`~/.ryu/models/<stem>.mmproj.gguf`),
/// through the shared verified [`ryu_downloads::DownloadCenter`]. The dest
/// name is built from the already-validated `model_stem`, so the (HF-supplied)
/// projector filename only reaches the download URL, never the on-disk path.
async fn download_mmproj(
    endpoint: &HfEndpoint,
    repo_id: &str,
    model_stem: &str,
    filename: &str,
    sha256: Option<String>,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<std::path::PathBuf> {
    let spec = ryu_downloads::DownloadSpec {
        kind: ryu_downloads::DownloadKind::Model,
        label: format!("{repo_id} (vision adapter)"),
        url: format!("{}/{repo_id}/resolve/main/{filename}", endpoint.host),
        dest: installed::mmproj_file_path(model_stem),
        sha256: sha256.filter(|s| !s.is_empty()),
        version_record: Some(ryu_downloads::VersionRecord {
            store_key: format!("gguf-mmproj:{model_stem}"),
            version: filename.to_string(),
        }),
    };
    downloads
        .download_blocking(spec)
        .await
        .with_context(|| format!("downloading vision adapter {filename} from {repo_id}"))
}

/// Detect and install the multimodal projector ("vision adapter") for a GGUF
/// model in `repo_id`, binding it to `model_stem`. Fetches the repo tree, picks
/// the best projector ([`pick_mmproj`]), and downloads it. Returns the installed
/// projector filename, or `None` when the repo is text-only. Surfaces failures
/// as `Err` so callers can warn-and-continue — vision is a bonus, never a
/// blocker for chat. Reused by the onboarding default-model path.
pub async fn install_companion_mmproj(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    repo_id: &str,
    model_stem: &str,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<Option<String>> {
    let sizes = fetch_tree_sizes(client, endpoint, repo_id, ModelFormat::Gguf).await?;
    let Some((filename, _size, sha)) = pick_mmproj(&sizes) else {
        return Ok(None);
    };
    download_mmproj(endpoint, repo_id, model_stem, &filename, sha, downloads).await?;
    Ok(Some(filename))
}

pub async fn install_file(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    repo_id: &str,
    filename: &str,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<InstallResult> {
    // Security: both come straight from the install endpoint's JSON body. Reject
    // path-traversal filenames (the stem becomes an on-disk path) and malformed
    // repo ids (interpolated into Hub URLs) before any download or write.
    validate_gguf_filename(filename)?;
    validate_repo_id(repo_id)?;

    let stem = local_stem(filename);
    let url = format!("{}/{repo_id}/resolve/main/{filename}", endpoint.host);

    // Pull the expected sha256 (and size) from the tree so the download is
    // checksum-verified; empty sha falls back to no verification.
    let sizes = fetch_tree_sizes(client, endpoint, repo_id, ModelFormat::Gguf)
        .await
        .unwrap_or_default();
    let (size_bytes, sha) = sizes.get(filename).cloned().unwrap_or((None, None));

    // Route through the global DownloadCenter: streams to a `.part` file with
    // live progress + pause/resume/cancel, verifies the checksum, and records the
    // version — replacing the old whole-file-into-RAM GgufDownloader path.
    let path = downloads
        .download_blocking(gguf_download_spec(
            &stem,
            &url,
            &sha.unwrap_or_default(),
            &format!("{repo_id} ({filename})"),
        ))
        .await
        .with_context(|| format!("downloading {filename} from {repo_id}"))?;

    // Auto-install the vision adapter when this repo ships a projector, binding
    // it to the model's stem (`<stem>.mmproj.gguf`) so the launch path loads it
    // automatically. Best-effort: a vision model still chats as text-only if the
    // adapter download fails, and a text-only repo simply has no projector. The
    // model quant itself never matches `mmproj`, so it is never re-fetched.
    let mmproj = match pick_mmproj(&sizes) {
        Some((mm_name, _sz, mm_sha)) if mm_name != filename => {
            match download_mmproj(endpoint, repo_id, &stem, &mm_name, mm_sha, downloads).await {
                Ok(p) => {
                    tracing::info!("installed vision adapter {mm_name} -> {}", p.display());
                    Some(mm_name)
                }
                Err(e) => {
                    tracing::warn!("vision adapter download failed for {repo_id}: {e:#}");
                    None
                }
            }
        }
        _ => None,
    };

    installed::record(installed::InstalledModel {
        repo_id: repo_id.to_string(),
        filename: filename.to_string(),
        stem,
        size_bytes,
        format: ModelFormat::Gguf,
        mmproj,
        finetune_base: None,
    })?;

    // The installed state just changed — drop cached detail for this repo and all
    // cached lists so the "Installed" badge is correct on the next fetch.
    cache_invalidate(repo_id);
    cache_invalidate("list:");

    Ok(InstallResult {
        repo_id: repo_id.to_string(),
        filename: filename.to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

/// Download + verify a GGUF from an arbitrary, source-supplied descriptor (URL +
/// optional sha256 + destination filename) through the same privileged
/// [`GgufDownloader`] path as [`install_file`]. This is the install handoff for
/// non-HF model sources (e.g. a Ryu model-index): the the active catalog source
/// resolves *what* to install (the descriptor), and Core performs the verified
/// download here so the source itself never touches the disk.
///
/// `repo_id` is the descriptor's `repo_id` (used only for provenance + cache
/// invalidation, so it is *not* required to be a Hub `author/name`). The `url`
/// must be `https://` and is validated against the SSRF guard by the caller
/// (the route) before this runs; `dest_filename` is path-traversal-guarded here
/// since it becomes the on-disk stem.
pub async fn install_from_descriptor(
    repo_id: &str,
    url: &str,
    sha256: Option<&str>,
    dest_filename: &str,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<InstallResult> {
    // Security: dest_filename becomes the on-disk stem, so it must be a single
    // safe `.gguf` component (no traversal, no separators).
    validate_gguf_filename(dest_filename)?;

    let stem = local_stem(dest_filename);

    let path = downloads
        .download_blocking(gguf_download_spec(
            &stem,
            url,
            sha256.unwrap_or(""),
            &format!("{repo_id} ({dest_filename})"),
        ))
        .await
        .with_context(|| format!("downloading {dest_filename} from {url}"))?;

    installed::record(installed::InstalledModel {
        repo_id: repo_id.to_string(),
        filename: dest_filename.to_string(),
        stem,
        size_bytes: None,
        format: ModelFormat::Gguf,
        // Single-URL descriptor installs (non-HF seam sources) carry no repo
        // tree to discover a companion projector — text-only binding.
        mmproj: None,
        // Plain weight install, not a fine-tune merge.
        finetune_base: None,
    })?;

    // Installed state changed — drop cached detail for this repo + all lists.
    cache_invalidate(repo_id);
    cache_invalidate("list:");

    Ok(InstallResult {
        repo_id: repo_id.to_string(),
        filename: dest_filename.to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

/// Reject a snapshot repo-relative path that isn't a safe weight/config file
/// under the snapshot directory. Unlike [`validate_gguf_filename`] (a single
/// component), a snapshot mirrors a nested repo tree, so multi-component paths
/// are allowed — but every component must be normal: no `..`, no absolute path,
/// no Windows drive/UNC prefix, no leading separator, no leading-dot component.
/// The extension must be one of the format's weight/config extensions. This is a
/// fresh security boundary because each path becomes an on-disk write target.
fn validate_snapshot_path(rel: &str, format: ModelFormat) -> Result<()> {
    use std::path::{Component, Path};

    let lower = rel.to_lowercase();
    if !format
        .weight_extensions()
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        anyhow::bail!("unexpected file in snapshot: {rel}");
    }
    if rel.is_empty() || rel.starts_with('/') || rel.starts_with('\\') {
        anyhow::bail!("unsafe snapshot path: {rel}");
    }
    // Reject backslashes outright so a Windows-style path can't sneak a drive or
    // alternate separator past the component check.
    if rel.contains('\\') {
        anyhow::bail!("unsafe snapshot path: {rel}");
    }
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(seg) => {
                if seg.to_string_lossy().starts_with('.') {
                    anyhow::bail!("unsafe snapshot path: {rel}");
                }
            }
            // CurDir/ParentDir/RootDir/Prefix are all rejected.
            _ => anyhow::bail!("unsafe snapshot path: {rel}"),
        }
    }
    Ok(())
}

/// Install a multi-file repo snapshot (safetensors / MLX) for an engine that
/// serves a whole repo directory rather than a single GGUF file. Enumerates the
/// repo's weight + config files via the format-aware tree endpoint, validates
/// each repo-relative path, and downloads each through the shared
/// [`ryu_downloads::DownloadCenter`] (per-file resume + checksum), mirroring
/// the tree under `~/.ryu/models/<slug>/`. Records one provenance entry.
///
/// Only the default HF path uses this (it has repo-relative paths). Seam sources
/// stay single-file/GGUF.
pub async fn install_snapshot(
    client: &reqwest::Client,
    endpoint: &HfEndpoint,
    repo_id: &str,
    format: ModelFormat,
    downloads: &ryu_downloads::DownloadCenter,
) -> Result<InstallResult> {
    validate_repo_id(repo_id)?;
    if format.is_single_file() {
        anyhow::bail!("install_snapshot called for a single-file format: {repo_id}");
    }

    let tree = fetch_tree_sizes(client, endpoint, repo_id, format).await?;
    if tree.is_empty() {
        anyhow::bail!(
            "no installable {} files found in {repo_id}",
            format.as_str()
        );
    }

    let slug = installed::slugify_repo(repo_id);
    let dir = installed::model_snapshot_dir(&slug);
    let mut total: u64 = 0;

    // Deterministic order so a resumed install is reproducible.
    let mut paths: Vec<&String> = tree.keys().collect();
    paths.sort();

    for rel in paths {
        validate_snapshot_path(rel, format)?;
        let (size_bytes, sha) = tree.get(rel).cloned().unwrap_or((None, None));
        if let Some(b) = size_bytes {
            total += b;
        }
        let dest = dir.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating snapshot dir {}", parent.display()))?;
        }
        let spec = ryu_downloads::DownloadSpec {
            kind: ryu_downloads::DownloadKind::Model,
            label: format!("{repo_id} ({rel})"),
            url: format!("{}/{repo_id}/resolve/main/{rel}", endpoint.host),
            dest,
            sha256: sha,
            version_record: Some(ryu_downloads::VersionRecord {
                store_key: format!("snapshot:{slug}:{rel}"),
                version: repo_id.to_string(),
            }),
        };
        downloads
            .download_blocking(spec)
            .await
            .with_context(|| format!("downloading {rel} from {repo_id}"))?;
    }

    installed::record(installed::InstalledModel {
        repo_id: repo_id.to_string(),
        filename: repo_id.to_string(),
        stem: slug,
        size_bytes: (total > 0).then_some(total),
        format,
        // Snapshot (safetensors/MLX) engines resolve their own vision tower from
        // the repo config — the GGUF `mmproj` companion concept does not apply.
        mmproj: None,
        finetune_base: None,
    })?;

    cache_invalidate(repo_id);
    cache_invalidate("list:");

    Ok(InstallResult {
        repo_id: repo_id.to_string(),
        filename: repo_id.to_string(),
        path: dir.to_string_lossy().to_string(),
    })
}

// ── Misc ─────────────────────────────────────────────────────────────────

fn models_dir_has(stem: &str) -> bool {
    ryu_dir()
        .join("models")
        .join(format!("{stem}.gguf"))
        .exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_quant_picks_most_specific() {
        assert_eq!(
            parse_quant("gemma-4-E2B-it-Q4_K_M.gguf").as_deref(),
            Some("Q4_K_M")
        );
        assert_eq!(parse_quant("model.Q8_0.gguf").as_deref(), Some("Q8_0"));
        assert_eq!(parse_quant("model-f16.gguf").as_deref(), Some("F16"));
        assert_eq!(parse_quant("model-bf16.gguf").as_deref(), Some("BF16"));
        assert_eq!(parse_quant("model-IQ4_XS.gguf").as_deref(), Some("IQ4_XS"));
        assert_eq!(
            parse_quant("model-IQ2_XXS.gguf").as_deref(),
            Some("IQ2_XXS")
        );
        assert_eq!(parse_quant("Qwen-Q6_K.gguf").as_deref(), Some("Q6_K"));
        // Community suffix variants that the old fixed-list parser missed.
        assert_eq!(parse_quant("model-Q3_K_P.gguf").as_deref(), Some("Q3_K_P"));
        assert_eq!(parse_quant("model-Q8_K_P.gguf").as_deref(), Some("Q8_K_P"));
        assert_eq!(
            parse_quant("model-UD-Q4_K_XL.gguf").as_deref(),
            Some("Q4_K_XL")
        );
        assert_eq!(parse_quant("weights.gguf"), None);
    }

    #[test]
    fn split_id_handles_org_and_bare() {
        assert_eq!(
            split_id("unsloth/gemma"),
            ("unsloth".into(), "gemma".into())
        );
        assert_eq!(split_id("gemma"), (String::new(), "gemma".into()));
    }

    #[test]
    fn gated_normalizes_variants() {
        assert!(gated_to_bool(&serde_json::json!("manual")));
        assert!(gated_to_bool(&serde_json::json!(true)));
        assert!(!gated_to_bool(&serde_json::json!(false)));
        assert!(!gated_to_bool(&serde_json::json!("false")));
        assert!(!gated_to_bool(&serde_json::Value::Null));
    }

    #[test]
    fn strip_front_matter_removes_yaml() {
        let md = "---\nlicense: mit\ntags:\n- text-generation\n---\n# Hello\nbody";
        assert_eq!(strip_front_matter(md), "# Hello\nbody");
    }

    #[test]
    fn strip_front_matter_keeps_plain_markdown() {
        let md = "# Title\nno front matter";
        assert_eq!(strip_front_matter(md), md);
    }

    #[test]
    fn local_stem_strips_extension() {
        assert_eq!(local_stem("gemma-Q4_K_M.gguf"), "gemma-Q4_K_M");
    }

    #[test]
    fn is_mmproj_matches_projector_names() {
        assert!(is_mmproj_filename("mmproj-F16.gguf"));
        assert!(is_mmproj_filename("mmproj-model-f16.gguf"));
        assert!(is_mmproj_filename("MMPROJ-BF16.GGUF"));
        // A normal weight quant is never a projector.
        assert!(!is_mmproj_filename("gemma-4-E2B-it-Q4_K_M.gguf"));
    }

    #[test]
    fn pick_mmproj_prefers_f16_then_smallest() {
        use std::collections::HashMap;
        let mut tree: HashMap<String, (Option<u64>, Option<String>)> = HashMap::new();
        // A model quant (ignored) plus several projector precisions.
        tree.insert("gemma-Q4_K_M.gguf".into(), (Some(3_000), None));
        tree.insert("mmproj-Q8_0.gguf".into(), (Some(400), Some("sha8".into())));
        tree.insert("mmproj-F16.gguf".into(), (Some(900), Some("sha16".into())));
        tree.insert("mmproj-F32.gguf".into(), (Some(1_800), None));

        // Default preference is f16, even though Q8 is smaller.
        let (name, _size, sha) = pick_mmproj(&tree).expect("a projector is found");
        assert_eq!(name, "mmproj-F16.gguf");
        assert_eq!(sha.as_deref(), Some("sha16"));
    }

    #[test]
    fn pick_mmproj_none_for_text_only_repo() {
        use std::collections::HashMap;
        let mut tree: HashMap<String, (Option<u64>, Option<String>)> = HashMap::new();
        tree.insert("model-Q4_K_M.gguf".into(), (Some(3_000), None));
        tree.insert("model-Q8_0.gguf".into(), (Some(6_000), None));
        assert!(pick_mmproj(&tree).is_none());
    }

    #[test]
    fn pick_mmproj_falls_back_to_smallest_without_f16() {
        use std::collections::HashMap;
        let mut tree: HashMap<String, (Option<u64>, Option<String>)> = HashMap::new();
        tree.insert("mmproj-Q8_0.gguf".into(), (Some(900), None));
        tree.insert("mmproj-Q4_0.gguf".into(), (Some(400), None));
        // No f16 candidate and no env override → smallest remaining wins.
        let (name, _size, _sha) = pick_mmproj(&tree).expect("a projector is found");
        assert_eq!(name, "mmproj-Q4_0.gguf");
    }

    #[test]
    fn validate_gguf_filename_accepts_plain_names() {
        assert!(validate_gguf_filename("gemma-4-E2B-it-Q4_K_M.gguf").is_ok());
        assert!(validate_gguf_filename("model-00001-of-00002.gguf").is_ok());
        assert!(validate_gguf_filename("Model.GGUF").is_ok());
    }

    #[test]
    fn validate_gguf_filename_rejects_traversal() {
        // Path traversal and separators must never reach the on-disk stem.
        assert!(validate_gguf_filename("../evil.gguf").is_err());
        assert!(validate_gguf_filename("..\\..\\evil.gguf").is_err());
        assert!(validate_gguf_filename("sub/dir/model.gguf").is_err());
        assert!(validate_gguf_filename("C:\\Windows\\System32\\evil.gguf").is_err());
        assert!(validate_gguf_filename("/etc/cron.d/evil.gguf").is_err());
        assert!(validate_gguf_filename(".hidden.gguf").is_err());
        // Wrong extension is rejected regardless of shape.
        assert!(validate_gguf_filename("model.bin").is_err());
        assert!(validate_gguf_filename("..").is_err());
    }

    #[test]
    fn validate_repo_id_accepts_author_name() {
        assert!(validate_repo_id("unsloth/gemma-4-E2B-it-GGUF").is_ok());
        assert!(validate_repo_id("TheBloke/Llama-2-7B.GGUF").is_ok());
    }

    #[test]
    fn validate_repo_id_rejects_malformed() {
        assert!(validate_repo_id("nogroup").is_err());
        assert!(validate_repo_id("../../etc").is_err());
        assert!(validate_repo_id("a/b/c").is_err());
        assert!(validate_repo_id("author/").is_err());
        assert!(validate_repo_id("/name").is_err());
        assert!(validate_repo_id("au thor/name").is_err());
        assert!(validate_repo_id("author/..").is_err());
    }

    #[test]
    fn repo_from_hf_url_extracts_repo() {
        assert_eq!(
            repo_from_hf_url(
                "https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf"
            )
            .as_deref(),
            Some("unsloth/gemma-4-E2B-it-GGUF")
        );
        assert_eq!(repo_from_hf_url("https://example.com/foo.gguf"), None);
    }

    // ── HfEndpoint / sort / sanitizers (pure) ────────────────────────────────

    #[test]
    fn hf_endpoint_variants_and_cache_tag() {
        let hf = HfEndpoint::huggingface();
        assert_eq!(hf.api_base, "https://huggingface.co/api");
        assert_eq!(hf.host, "https://huggingface.co");
        assert_eq!(hf.cache_tag(), "huggingface.co");

        let ms = HfEndpoint::modelscope();
        assert!(ms.api_base.contains("modelscope"));
        assert_eq!(ms.cache_tag(), "modelscope.cn");

        // A base ending in `/api/v2/` keeps the api root and strips to the host.
        let custom = HfEndpoint::from_base_url("https://mirror.example.com/api/v2/");
        assert_eq!(custom.api_base, "https://mirror.example.com/api/v2");
        assert_eq!(custom.host, "https://mirror.example.com");

        // A base with no `/api` segment reuses itself as the content host.
        let plain = HfEndpoint::from_base_url("https://plain.example.com");
        assert_eq!(plain.api_base, "https://plain.example.com");
        assert_eq!(plain.host, "https://plain.example.com");

        assert_eq!(HfEndpoint::default(), HfEndpoint::huggingface());
    }

    #[test]
    fn catalog_sort_parse_and_hf_key() {
        assert!(matches!(CatalogSort::parse("downloads"), CatalogSort::Downloads));
        assert!(matches!(CatalogSort::parse("likes"), CatalogSort::Likes));
        assert!(matches!(CatalogSort::parse("recent"), CatalogSort::Recent));
        assert!(matches!(
            CatalogSort::parse("lastModified"),
            CatalogSort::Recent
        ));
        assert!(matches!(CatalogSort::parse("anything"), CatalogSort::Trending));
        assert_eq!(CatalogSort::Trending.hf_key(), "trendingScore");
        assert_eq!(CatalogSort::Downloads.hf_key(), "downloads");
        assert_eq!(CatalogSort::Likes.hf_key(), "likes");
        assert_eq!(CatalogSort::Recent.hf_key(), "lastModified");
    }

    #[test]
    fn diffusion_pipeline_tag_detection() {
        assert!(is_diffusion_pipeline_tag("text-to-image"));
        assert!(is_diffusion_pipeline_tag("image-to-image"));
        assert!(is_diffusion_pipeline_tag("text-to-video"));
        assert!(!is_diffusion_pipeline_tag("text-generation"));
    }

    #[test]
    fn gguf_fields_extracts_or_defaults() {
        let block = Some(HfGguf {
            context_length: Some(8192),
            architecture: Some("llama".into()),
            total: Some(7_000_000_000),
        });
        assert_eq!(
            gguf_fields(&block),
            (Some(8192), Some("llama".to_string()), Some(7_000_000_000))
        );
        assert_eq!(gguf_fields(&None), (None, None, None));
    }

    #[test]
    fn sanitize_task_and_author_reject_unsafe() {
        assert_eq!(sanitize_task(" text-generation "), Some("text-generation".into()));
        assert_eq!(sanitize_task("speech2text"), Some("speech2text".into()));
        assert_eq!(sanitize_task(""), None);
        assert_eq!(sanitize_task("Has Spaces!"), None);
        assert_eq!(sanitize_task("inject&param=1"), None);

        assert_eq!(sanitize_author(" google "), Some("google".into()));
        assert_eq!(sanitize_author("mlx-community"), Some("mlx-community".into()));
        assert_eq!(sanitize_author(""), None);
        assert_eq!(sanitize_author("bad/author"), None);
    }

    #[test]
    fn parse_next_cursor_extracts_only_the_cursor() {
        use reqwest::header::HeaderValue;
        let link = HeaderValue::from_str(
            "<https://huggingface.co/api/models?sort=x&cursor=ABC123&limit=20>; rel=\"next\"",
        )
        .unwrap();
        assert_eq!(parse_next_cursor(Some(&link)).as_deref(), Some("ABC123"));
        assert_eq!(parse_next_cursor(None), None);
        let only_prev =
            HeaderValue::from_str("<https://x/api/models?cursor=Z>; rel=\"prev\"").unwrap();
        assert_eq!(parse_next_cursor(Some(&only_prev)), None);
    }

    // ── snapshot fit + snapshot path validation ──────────────────────────────

    fn dev(ram: Option<u64>, vram: Option<u64>) -> device::DeviceInfo {
        device::DeviceInfo {
            total_ram_bytes: ram,
            ram_human: String::new(),
            vram_bytes: vram,
            vram_human: String::new(),
            gpu_name: None,
            unified_memory: false,
            os: "test".into(),
        }
    }

    #[test]
    fn snapshot_fit_conservative_labels() {
        let gib = 1024u64 * 1024 * 1024;
        let big = dev(Some(64 * gib), Some(48 * gib));

        // Unknown total → "size unknown".
        let (fit, label) = snapshot_fit(None, &big);
        assert_eq!(fit, "unknown");
        assert!(label.to_lowercase().contains("unknown"));

        // A tiny repo fits comfortably → great/ok passes through verbatim.
        let (fit, _) = snapshot_fit(Some(gib), &big);
        assert!(fit == "great" || fit == "ok");

        // A repo far larger than any memory → conservative too_big copy.
        let (fit, label) = snapshot_fit(Some(500 * gib), &big);
        assert_eq!(fit, "too_big");
        assert!(label.contains("may not fit"));

        // No device memory at all → estimate is Unknown → conservative unknown.
        let (fit, _) = snapshot_fit(Some(gib), &dev(None, None));
        assert_eq!(fit, "unknown");
    }

    #[test]
    fn validate_snapshot_path_guards_traversal() {
        use ModelFormat::Safetensors as ST;
        assert!(validate_snapshot_path("model.safetensors", ST).is_ok());
        assert!(validate_snapshot_path("sub/dir/model.safetensors", ST).is_ok());
        assert!(validate_snapshot_path("config.json", ST).is_ok());
        assert!(validate_snapshot_path("tokenizer.model", ST).is_ok());

        assert!(validate_snapshot_path("../evil.safetensors", ST).is_err());
        assert!(validate_snapshot_path("dir\\evil.safetensors", ST).is_err());
        assert!(validate_snapshot_path("/abs/model.safetensors", ST).is_err());
        assert!(validate_snapshot_path(".hidden/model.safetensors", ST).is_err());
        assert!(validate_snapshot_path("weights.gguf", ST).is_err()); // wrong ext
        assert!(validate_snapshot_path("", ST).is_err());
    }

    // ── in-process cache ─────────────────────────────────────────────────────

    #[test]
    fn cache_put_get_invalidate() {
        let key = "list:unit-test-cache-unique-1".to_string();
        assert!(cache_get(&key, LIST_TTL).is_none());
        cache_put(key.clone(), serde_json::json!({ "a": 1 }));
        assert_eq!(cache_get(&key, LIST_TTL), Some(serde_json::json!({ "a": 1 })));
        cache_invalidate("unit-test-cache-unique-1");
        assert!(cache_get(&key, LIST_TTL).is_none());
    }

    #[test]
    fn gguf_download_spec_shape() {
        ensure_test_host();
        let spec = gguf_download_spec("my-stem", "https://hf/x.gguf", "deadbeef", "a label");
        assert_eq!(spec.url, "https://hf/x.gguf");
        assert_eq!(spec.sha256.as_deref(), Some("deadbeef"));
        assert!(spec
            .dest
            .ends_with(std::path::Path::new("models/my-stem.gguf")));
        assert_eq!(spec.version_record.as_ref().unwrap().store_key, "gguf:my-stem");
        // Empty sha → no checksum on the spec.
        let spec2 = gguf_download_spec("s2", "u", "", "l");
        assert!(spec2.sha256.is_none());
    }

    // ── on-disk stems / uninstall / default-download provenance ──────────────

    #[test]
    fn on_disk_stems_exclude_mmproj_and_models_dir_has() {
        ensure_test_host();
        let stem = "ondisk-unique-f1";
        let models = ryu_dir().join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join(format!("{stem}.gguf")), b"x").unwrap();
        std::fs::write(models.join(format!("{stem}.mmproj.gguf")), b"p").unwrap();

        assert!(models_dir_has(stem));
        assert!(!models_dir_has("ondisk-nope-f1"));

        let stems = on_disk_gguf_stems();
        assert!(stems.contains(&stem.to_string()));
        assert!(
            !stems.contains(&format!("{stem}.mmproj")),
            "the vision adapter must never surface as its own stem"
        );

        let _ = std::fs::remove_file(models.join(format!("{stem}.gguf")));
        let _ = std::fs::remove_file(models.join(format!("{stem}.mmproj.gguf")));
    }

    #[test]
    fn record_default_download_derives_repo_and_filename() {
        ensure_test_host();
        let stem = "default-dl-unique-d1";
        let models = ryu_dir().join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join(format!("{stem}.gguf")), b"x").unwrap();
        record_default_download(
            stem,
            "https://huggingface.co/acme/default-dl-repo/resolve/main/default-dl-unique-d1.gguf?download=true",
            Some(1),
            None,
        )
        .unwrap();
        // Provenance resolves the on-disk stem back to the derived HF repo.
        assert_eq!(
            installed::repo_for_stem(stem).as_deref(),
            Some("acme/default-dl-repo")
        );

        let _ = installed::remove(stem);
        let _ = std::fs::remove_file(models.join(format!("{stem}.gguf")));
    }

    #[tokio::test]
    async fn installed_only_search_lists_local_cards_offline() {
        ensure_test_host();
        let stem = "installed-only-unique-g1";
        let models = ryu_dir().join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join(format!("{stem}.gguf")), b"x").unwrap();
        installed::record(installed::InstalledModel {
            repo_id: "acme/installed-only-repo".into(),
            filename: format!("{stem}.gguf"),
            stem: stem.into(),
            size_bytes: Some(1),
            format: ModelFormat::Gguf,
            mmproj: None,
            finetune_base: None,
        })
        .unwrap();

        // Point enrichment at a server that 404s every info request, so each card
        // keeps its local values (proves the offline fallback path).
        let addr = spawn_http(|_path| (404, vec![], b"nope".to_vec()));
        let endpoint = HfEndpoint {
            api_base: format!("http://{addr}/api"),
            host: format!("http://{addr}"),
        };
        let page = search_models(
            &test_client(),
            &endpoint,
            "",
            CatalogSort::Trending,
            ModelFormat::Gguf,
            20,
            true,
            "",
            "",
            None,
        )
        .await
        .unwrap();
        assert!(page.next_cursor.is_none());
        let card = page
            .models
            .iter()
            .find(|c| c.id == "acme/installed-only-repo")
            .expect("the recorded install shows as a card");
        assert!(card.installed);

        let _ = installed::remove(stem);
        let _ = std::fs::remove_file(models.join(format!("{stem}.gguf")));
    }

    #[tokio::test]
    async fn uninstall_file_removes_weights_adapter_and_record() {
        ensure_test_host();
        let stem = "uninstall-unique-e1";
        let filename = "uninstall-unique-e1.gguf";
        let models = ryu_dir().join("models");
        std::fs::create_dir_all(&models).unwrap();
        let path = models.join(format!("{stem}.gguf"));
        std::fs::write(&path, b"x").unwrap();
        let mm = installed::mmproj_file_path(stem);
        std::fs::write(&mm, b"p").unwrap();
        installed::record(installed::InstalledModel {
            repo_id: "acme/uninst".into(),
            filename: filename.into(),
            stem: stem.into(),
            size_bytes: Some(1),
            format: ModelFormat::Gguf,
            mmproj: Some("mmproj-f16.gguf".into()),
            finetune_base: None,
        })
        .unwrap();

        uninstall_file("acme/uninst", filename).unwrap();
        assert!(!path.exists(), "weights removed");
        assert!(!mm.exists(), "bound vision adapter removed too");
        assert!(installed::load_present().iter().all(|m| m.stem != stem));

        // Idempotent: uninstalling an already-gone file still succeeds.
        uninstall_file("acme/uninst", filename).unwrap();
        // Path traversal is rejected before touching the filesystem.
        assert!(uninstall_file("acme/uninst", "../evil.gguf").is_err());
    }

    // ── HTTP-backed search / detail / install via a std-only mock server ─────

    /// A reqwest client that ignores any ambient proxy (localhost must be direct).
    fn test_client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    /// Spawn a throwaway HTTP/1.1 server on an ephemeral loopback port. `handler`
    /// maps a request path to `(status, extra_headers, body)`. Zero dependencies —
    /// good enough to exercise the catalog's fetch/parse logic hermetically.
    fn spawn_http<F>(handler: F) -> String
    where
        F: Fn(&str) -> (u16, Vec<(&'static str, String)>, Vec<u8>) + Send + Sync + 'static,
    {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = std::sync::Arc::new(handler);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let handler = handler.clone();
                std::thread::spawn(move || {
                    let mut data = Vec::new();
                    let mut buf = [0u8; 4096];
                    loop {
                        match stream.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                data.extend_from_slice(&buf[..n]);
                                if data.windows(4).any(|w| w == b"\r\n\r\n") {
                                    break;
                                }
                            }
                            Err(_) => return,
                        }
                    }
                    let req = String::from_utf8_lossy(&data);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_string();
                    let (status, headers, body) = handler(&path);
                    let mut resp = format!(
                        "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n",
                        body.len()
                    );
                    for (k, v) in headers {
                        resp.push_str(&format!("{k}: {v}\r\n"));
                    }
                    resp.push_str("\r\n");
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.write_all(&body);
                    let _ = stream.flush();
                });
            }
        });
        format!("127.0.0.1:{}", addr.port())
    }

    /// Install a downloads host (once) so `DownloadCenter` can write under a temp dir.
    fn ensure_downloads_host() {
        use std::sync::Once;
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            struct DlHost {
                dir: PathBuf,
            }
            impl ryu_downloads::DownloadsHost for DlHost {
                fn ryu_dir(&self) -> PathBuf {
                    self.dir.clone()
                }
                fn installed_checksum(&self, _store_key: &str) -> Option<String> {
                    None
                }
                fn record_version(&self, _store_key: &str, _version: &str, _checksum: &str) {}
                fn authorize(
                    &self,
                    _url: &str,
                    req: reqwest::RequestBuilder,
                ) -> reqwest::RequestBuilder {
                    req
                }
            }
            let dir =
                std::env::temp_dir().join(format!("ryu-mc-downloads-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            ryu_downloads::set_global_host(std::sync::Arc::new(DlHost { dir }));
        });
    }

    #[tokio::test]
    async fn search_models_parses_list_and_next_cursor() {
        ensure_test_host();
        let addr = spawn_http(|path| {
            if path.contains("/api/models?") {
                let body = serde_json::json!([
                    {
                        "id": "unsloth/gemma-3-GGUF",
                        "downloads": 10, "likes": 2,
                        "tags": ["text-generation"],
                        "pipeline_tag": "text-generation",
                        "gated": false,
                        "createdAt": "2024-01-01", "lastModified": "2024-02-01",
                        "gguf": { "context_length": 8192, "architecture": "gemma3", "total": 4_000_000_000u64 }
                    },
                    {
                        "id": "flux-org/flux-GGUF",
                        "pipeline_tag": "text-to-image",
                        "gated": "manual",
                        "gguf": { "architecture": "flux" }
                    }
                ])
                .to_string()
                .into_bytes();
                (
                    200,
                    vec![(
                        "Link",
                        "<https://huggingface.co/api/models?cursor=NEXT123&x=1>; rel=\"next\""
                            .to_string(),
                    )],
                    body,
                )
            } else {
                (404, vec![], b"no".to_vec())
            }
        });
        let endpoint = HfEndpoint {
            api_base: format!("http://{addr}/api"),
            host: format!("http://{addr}"),
        };
        let page = search_models(
            &test_client(),
            &endpoint,
            "gemma",
            CatalogSort::Trending,
            ModelFormat::Gguf,
            20,
            false,
            "",
            "",
            None,
        )
        .await
        .unwrap();

        assert_eq!(page.models.len(), 2);
        assert_eq!(page.next_cursor.as_deref(), Some("NEXT123"));

        let g = &page.models[0];
        assert_eq!(g.id, "unsloth/gemma-3-GGUF");
        assert_eq!(g.author, "unsloth");
        assert_eq!(g.name, "gemma-3-GGUF");
        assert_eq!(g.context_length, Some(8192));
        assert_eq!(g.architecture.as_deref(), Some("gemma3"));
        assert_eq!(g.downloads, 10);
        // The TestHost supports no engines → shown but flagged incompatible.
        assert!(!g.compatible);
        assert!(g.needs_engine.is_some());
        assert!(!g.diffusion);

        let f = &page.models[1];
        assert!(f.diffusion, "flux pipeline tag ⇒ diffusion");
        assert!(f.gated, "\"manual\" gated string normalizes to true");
    }

    #[tokio::test]
    async fn model_detail_builds_gguf_file_list_and_readme() {
        ensure_test_host();
        let addr = spawn_http(|path| {
            if path.contains("/tree/") {
                let body = serde_json::json!([
                    { "path": "model-Q4_K_M.gguf", "size": 0, "lfs": { "oid": "abc", "size": 4000 } },
                    { "path": "model-Q8_0.gguf", "size": 8000 },
                    { "path": "mmproj-f16.gguf", "size": 500 },
                    { "path": "README.md", "size": 10 }
                ])
                .to_string()
                .into_bytes();
                (200, vec![], body)
            } else if path.contains("/raw/") && path.contains("README") {
                (200, vec![], b"---\nlicense: mit\n---\n# Hello\nBody text".to_vec())
            } else if path.contains("/api/models/") {
                let body = serde_json::json!({
                    "id": "acme/widget-detail-model",
                    "downloads": 5, "likes": 1,
                    "tags": ["text-generation"],
                    "pipeline_tag": "text-generation",
                    "gated": false,
                    "createdAt": "2024-01-01", "lastModified": "2024-02-01",
                    "gguf": { "context_length": 4096, "architecture": "llama", "total": 4_000_000_000u64 },
                    "siblings": [
                        { "rfilename": "model-Q4_K_M.gguf" },
                        { "rfilename": "model-Q8_0.gguf" },
                        { "rfilename": "mmproj-f16.gguf" },
                        { "rfilename": "README.md" }
                    ]
                })
                .to_string()
                .into_bytes();
                (200, vec![], body)
            } else {
                (404, vec![], b"no".to_vec())
            }
        });
        let endpoint = HfEndpoint {
            api_base: format!("http://{addr}/api"),
            host: format!("http://{addr}"),
        };
        let detail = model_detail(
            &test_client(),
            &endpoint,
            "acme/widget-detail-model",
            ModelFormat::Gguf,
        )
        .await
        .unwrap();

        assert_eq!(detail.card.id, "acme/widget-detail-model");
        assert_eq!(detail.card.context_length, Some(4096));
        assert!(detail.vision, "repo ships an mmproj projector ⇒ vision");
        // mmproj + README excluded → exactly the two selectable quants.
        assert_eq!(detail.files.len(), 2);
        // Smallest-first (both un-installed): Q4 (4000) before Q8 (8000).
        assert_eq!(detail.files[0].filename, "model-Q4_K_M.gguf");
        assert_eq!(detail.files[0].quant.as_deref(), Some("Q4_K_M"));
        assert_eq!(detail.files[0].size_bytes, Some(4000));
        assert_eq!(detail.files[0].sha256.as_deref(), Some("abc"));
        assert_eq!(detail.files[1].filename, "model-Q8_0.gguf");
        assert_eq!(detail.files[1].sha256, None);
        // Front-matter stripped from the README.
        assert_eq!(detail.readme.as_deref(), Some("# Hello\nBody text"));
        // GGUF leaves the snapshot repo-level fields empty.
        assert!(detail.repo_fit.is_empty());
        assert!(detail.repo_size_bytes.is_none());
    }

    #[tokio::test]
    async fn cached_json_wrappers_serve_from_cache() {
        ensure_test_host();
        let addr = spawn_http(|path| {
            if path.contains("/api/models?") {
                (200, vec![], b"[]".to_vec())
            } else {
                (404, vec![], b"no".to_vec())
            }
        });
        let endpoint = HfEndpoint {
            api_base: format!("http://{addr}/api"),
            host: format!("http://{addr}"),
        };
        let first = search_models_json(
            &test_client(),
            &endpoint,
            "cache-probe-unique-h1",
            CatalogSort::Recent,
            ModelFormat::Gguf,
            20,
            false,
            "",
            "",
            None,
        )
        .await
        .unwrap();
        assert!(first.get("models").is_some());
        // Second call with the same key is served from the in-process cache.
        let second = search_models_json(
            &test_client(),
            &endpoint,
            "cache-probe-unique-h1",
            CatalogSort::Recent,
            ModelFormat::Gguf,
            20,
            false,
            "",
            "",
            None,
        )
        .await
        .unwrap();
        assert_eq!(first, second);
    }

    #[tokio::test]
    async fn install_from_descriptor_downloads_and_records() {
        ensure_test_host();
        ensure_downloads_host();
        let addr = spawn_http(|path| {
            if path.contains("/resolve/") {
                (200, vec![], b"FAKE-GGUF-DESCRIPTOR-BYTES".to_vec())
            } else {
                (404, vec![], b"no".to_vec())
            }
        });
        let dc = ryu_downloads::DownloadCenter::with_default_client();
        std::fs::create_dir_all(ryu_dir().join("models")).unwrap();
        let stem = "install-desc-unique-c1";
        let url = format!("http://{addr}/acme/desc-repo/resolve/main/{stem}.gguf");
        let res = install_from_descriptor(
            "acme/desc-repo",
            &url,
            None,
            &format!("{stem}.gguf"),
            &dc,
        )
        .await
        .unwrap();

        assert_eq!(res.repo_id, "acme/desc-repo");
        assert_eq!(res.filename, format!("{stem}.gguf"));
        assert!(ryu_dir()
            .join("models")
            .join(format!("{stem}.gguf"))
            .exists());
        assert!(installed::load_present().iter().any(|m| m.stem == stem));

        let _ = installed::remove(stem);
        let _ = std::fs::remove_file(ryu_dir().join("models").join(format!("{stem}.gguf")));
    }

    #[tokio::test]
    async fn install_file_downloads_from_repo_and_records() {
        ensure_test_host();
        ensure_downloads_host();
        let addr = spawn_http(|path| {
            if path.contains("/tree/") {
                (200, vec![], b"[]".to_vec()) // empty tree → no sha, no mmproj
            } else if path.contains("/resolve/") {
                (200, vec![], b"FAKE-GGUF-INSTALL-FILE".to_vec())
            } else {
                (404, vec![], b"no".to_vec())
            }
        });
        let endpoint = HfEndpoint {
            api_base: format!("http://{addr}/api"),
            host: format!("http://{addr}"),
        };
        let dc = ryu_downloads::DownloadCenter::with_default_client();
        std::fs::create_dir_all(ryu_dir().join("models")).unwrap();
        let stem = "install-file-unique-c2";
        let res = install_file(
            &test_client(),
            &endpoint,
            "acme/inst-file-c2",
            &format!("{stem}.gguf"),
            &dc,
        )
        .await
        .unwrap();
        assert_eq!(res.repo_id, "acme/inst-file-c2");
        assert!(installed::load_present().iter().any(|m| m.stem == stem));

        // Path-traversal + bad-repo guards fire before any network.
        assert!(install_file(&test_client(), &endpoint, "acme/x", "../evil.gguf", &dc)
            .await
            .is_err());
        assert!(install_file(&test_client(), &endpoint, "no-slash", "ok.gguf", &dc)
            .await
            .is_err());

        let _ = installed::remove(stem);
        let _ = std::fs::remove_file(ryu_dir().join("models").join(format!("{stem}.gguf")));
    }

    #[tokio::test]
    async fn install_snapshot_mirrors_tree_and_records() {
        ensure_test_host();
        ensure_downloads_host();
        let addr = spawn_http(|path| {
            if path.contains("/tree/") {
                let body = serde_json::json!([
                    { "path": "model.safetensors", "size": 100 },
                    { "path": "config.json", "size": 20 }
                ])
                .to_string()
                .into_bytes();
                (200, vec![], body)
            } else if path.contains("/resolve/") {
                (200, vec![], b"SNAPSHOT-SHARD-BYTES".to_vec())
            } else {
                (404, vec![], b"no".to_vec())
            }
        });
        let endpoint = HfEndpoint {
            api_base: format!("http://{addr}/api"),
            host: format!("http://{addr}"),
        };
        let dc = ryu_downloads::DownloadCenter::with_default_client();
        let repo = "acme/snap-c3";
        let res = install_snapshot(&test_client(), &endpoint, repo, ModelFormat::Safetensors, &dc)
            .await
            .unwrap();
        let slug = installed::slugify_repo(repo);
        assert_eq!(res.repo_id, repo);
        assert!(installed::load_present().iter().any(|m| m.stem == slug));
        assert!(installed::model_snapshot_dir(&slug)
            .join("model.safetensors")
            .exists());

        // A single-file format is rejected by install_snapshot.
        assert!(
            install_snapshot(&test_client(), &endpoint, repo, ModelFormat::Gguf, &dc)
                .await
                .is_err()
        );

        let _ = installed::remove(&slug);
        let _ = std::fs::remove_dir_all(installed::model_snapshot_dir(&slug));
    }
}
