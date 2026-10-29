//! Core's Cactus Needle selector for unified tool and Agent Skill discovery,
//! shared by the pinned [`crate::needle2`] and [`crate::needle3`] releases.
//!
//! Needle is deliberately used as a selector, not as an authorization or
//! execution engine. Core builds a temporary function-schema view of the
//! already-scoped catalog, asks Needle for the relevant function aliases,
//! and maps those aliases back to canonical Ryu descriptor ids. The existing
//! Gateway allowlist, approval, budget, audit, and Core dispatch paths remain
//! authoritative after this point.
//!
//! The upstream runtime is a small C ABI shipped in a platform-specific Python
//! wheel. We load that ABI dynamically so the normal Core binary stays usable
//! when the optional runtime is unavailable. The default path lazily downloads
//! and checksum-verifies the pinned public wheel through Ryu's DownloadCenter;
//! an unavailable runtime falls back to the deterministic BM25 ranker. Each
//! release module pins its own [`NeedleRuntime`]: repository, revision, wheel
//! digests, override env vars and, for Needle 3, separately shipped weights.

use std::collections::HashMap;
use std::ffi::CString;
use std::io::{Cursor, Read};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use libloading::Library;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;
use tracing::warn;

use ryu_sidecar_runtime::layout;

use ryu_tool_registry::{ToolDescriptor, ToolKind, ToolSelector};

const NEEDLE_RESPONSE_BYTES: usize = 64 * 1024;
const NEEDLE_MAX_NEW_TOKENS: c_int = 96;

type NeedleInit = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> c_int;
type NeedleComplete = unsafe extern "C" fn(*const c_char, c_int, *mut c_char, c_int) -> c_int;
type NeedleReset = unsafe extern "C" fn();
type NeedleLoad = unsafe extern "C" fn(*const u8, u64) -> c_int;

/// One pinned Needle release: where its runtime comes from, which env vars
/// override it, and the process-wide state its C ABI needs.
pub(crate) struct NeedleRuntime {
    /// Human-readable release name used in logs and errors (`Needle 2`).
    pub(crate) label: &'static str,
    /// Engine, model and cache directory name (`needle2`); also the stem of
    /// its DownloadCenter version-record keys (`needle2-engine-<platform>`).
    pub(crate) name: &'static str,
    /// Hugging Face repository that hosts the wheels and weights.
    pub(crate) repo: &'static str,
    pub(crate) revision: &'static str,
    pub(crate) engine_version: &'static str,
    /// Library override env vars, checked in order. The first is the one
    /// suggested when this target has no bundled runtime wheel.
    pub(crate) library_env_keys: &'static [&'static str],
    /// File stem of the native library inside the wheel's `needle/` package.
    pub(crate) wheel_library_stem: &'static str,
    /// The pinned wheel digest for a platform tag.
    pub(crate) wheel_sha256: fn(&str) -> Option<&'static str>,
    /// Weights shipped outside the wheel and handed to `needle_load`.
    pub(crate) weights: Option<NeedleWeights>,
    pub(crate) state: NeedleState,
}

/// Separately downloaded weights for a release whose library loads them at
/// runtime instead of embedding them.
pub(crate) struct NeedleWeights {
    /// Env var that points at a local weights file instead.
    pub(crate) env_key: &'static str,
    /// File name in the repository and under the model dir.
    pub(crate) file_name: &'static str,
    pub(crate) sha256: &'static str,
}

/// Process-wide state owned by one [`NeedleRuntime`].
pub(crate) struct NeedleState {
    /// The DownloadCenter shared by Core's other managed artifacts.
    downloads: OnceLock<crate::downloads::DownloadCenter>,
    /// The one process-local selector instance. Needle's C ABI owns one active
    /// toolset, so a mutex inside the instance serializes its init/complete pair.
    selector: OnceLock<Arc<NeedleSelector>>,
    /// Needle's C ABI state is process-global even when callers construct more
    /// than one Rust selector (for example, concurrent catalog and skill searches
    /// or isolated tests). Serialize the full init/complete/reset transaction
    /// across those instances as well.
    call_lock: std::sync::Mutex<()>,
}

impl NeedleState {
    pub(crate) const fn new() -> Self {
        Self {
            downloads: OnceLock::new(),
            selector: OnceLock::new(),
            call_lock: std::sync::Mutex::new(()),
        }
    }
}

impl NeedleRuntime {
    /// Install Core's process-wide DownloadCenter before any catalog search can
    /// lazily fetch this runtime. Idempotent to keep test/bootstrap wiring
    /// harmless when called more than once.
    pub(crate) fn install_downloads(&self, downloads: crate::downloads::DownloadCenter) {
        let _ = self.state.downloads.set(downloads);
    }

    /// Return this release's shared Core selector.
    pub(crate) fn selector(&'static self) -> Arc<NeedleSelector> {
        self.state
            .selector
            .get_or_init(|| Arc::new(NeedleSelector::new(self)))
            .clone()
    }

    pub(crate) fn explicit_library_path(&self) -> Result<Option<PathBuf>, String> {
        for key in self.library_env_keys {
            let Some(value) = std::env::var_os(key) else {
                continue;
            };
            let path = PathBuf::from(value);
            if path.is_file() {
                return Ok(Some(path));
            }
            return Err(format!("{key} points to a missing {} library", self.label));
        }
        Ok(None)
    }

    /// `None` when the weights are not overridden, or this release has none.
    pub(crate) fn explicit_weights_path(&self) -> Result<Option<PathBuf>, String> {
        let Some(weights) = &self.weights else {
            return Ok(None);
        };
        let key = weights.env_key;
        let Some(value) = std::env::var_os(key) else {
            return Ok(None);
        };
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(Some(path));
        }
        Err(format!("{key} points to missing {} weights", self.label))
    }

    /// Resolve this release's separate weights, downloading them on first use.
    /// `None` when the release ships none.
    pub(crate) async fn ensure_default_weights(&self) -> Result<Option<PathBuf>, String> {
        let Some(weights) = &self.weights else {
            return Ok(None);
        };
        if let Some(path) = self.explicit_weights_path()? {
            return Ok(Some(path));
        }
        // Weights are a model, not part of the engine: `models/tool-routing/<name>/<ver>/`.
        let base = layout::model_family_dir(
            &crate::paths::ryu_dir(),
            layout::Modality::ToolRouting,
            self.name,
        )
        .join(self.engine_version);
        let weight_path = base.join(weights.file_name);
        if weight_path.is_file() {
            return Ok(Some(weight_path));
        }
        if let Some(refusal) = crate::sidecar::onboarding::automatic_download_refusal(&format!(
            "The {} tool and skill router weights",
            self.label
        )) {
            return Err(refusal);
        }
        std::fs::create_dir_all(&base)
            .map_err(|error| format!("create {} cache {}: {error}", self.label, base.display()))?;
        self.download(
            "weights",
            crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Engine,
                role: crate::downloads::DownloadRole::Engine,
                label: format!("{} tool and skill router weights", self.label),
                url: format!(
                    "https://huggingface.co/{}/resolve/{}/{}",
                    self.repo, self.revision, weights.file_name
                ),
                dest: weight_path.clone(),
                sha256: Some(weights.sha256.to_owned()),
                version_record: self.version_record("weights"),
            },
        )
        .await?;
        Ok(Some(weight_path))
    }

    pub(crate) async fn ensure_default_library(&self) -> Result<PathBuf, String> {
        let label = self.label;
        let Some(platform) = platform_tag() else {
            return Err(format!(
                "{label} has no bundled runtime wheel for target {}-{}; set {}",
                std::env::consts::OS,
                std::env::consts::ARCH,
                self.library_env_keys[0]
            ));
        };
        let library_name = library_name();
        let base = layout::engine_dir(
            &crate::paths::ryu_dir(),
            layout::EngineGroup::ToolRouting,
            self.name,
        )
        .join(self.engine_version);
        let library_path = base.join(library_name);
        if library_path.is_file() {
            return Ok(library_path);
        }
        // With automatic local downloads off, refuse before any download (and
        // before creating the cache dir) so tool ranking falls back to BM25.
        if let Some(refusal) =
            crate::sidecar::onboarding::automatic_download_refusal(&format!("The {label} runtime"))
        {
            return Err(refusal);
        }
        std::fs::create_dir_all(&base)
            .map_err(|error| format!("create {label} cache {}: {error}", base.display()))?;

        let wheel_name = format!(
            "cactus_needle-{}-py3-none-{platform}.whl",
            self.engine_version
        );
        // The wheel is only an archive to pull the library out of: stage it in
        // `tmp/downloads`, keep just the library in the engine dir.
        let wheel_path = crate::sidecar::download_manager::tmp_dir().join(&wheel_name);
        let url = format!(
            "https://huggingface.co/{}/resolve/{}/python/{wheel_name}",
            self.repo, self.revision
        );
        let wheel_path = self
            .download(
                "runtime",
                crate::downloads::DownloadSpec {
                    kind: crate::downloads::DownloadKind::Engine,
                    role: crate::downloads::DownloadRole::Engine,
                    label: format!("{label} tool and skill router"),
                    url,
                    dest: wheel_path,
                    sha256: (self.wheel_sha256)(platform).map(str::to_owned),
                    version_record: self.version_record(platform),
                },
            )
            .await?;

        let library_path_for_extract = library_path.clone();
        // Installed as `libneedle.<ext>`; the wheel may name it after its release.
        let library_member = format!(
            "needle/{}{}",
            self.wheel_library_stem,
            &library_name["libneedle".len()..]
        );
        let wheel_for_extract = wheel_path.clone();
        let name = self.name;
        tokio::task::spawn_blocking(move || {
            extract_library(
                label,
                name,
                &wheel_for_extract,
                &library_path_for_extract,
                &library_member,
            )
        })
        .await
        .map_err(|error| format!("{label} extraction worker failed: {error}"))??;
        let _ = tokio::fs::remove_file(&wheel_path).await;
        Ok(library_path)
    }

    /// Fetch one pinned artifact through Core's DownloadCenter.
    async fn download(
        &self,
        artifact: &str,
        spec: crate::downloads::DownloadSpec,
    ) -> Result<PathBuf, String> {
        let downloads = self
            .state
            .downloads
            .get()
            .cloned()
            .ok_or_else(|| format!("{} DownloadCenter is not initialized", self.label))?;
        downloads
            .download_blocking(spec)
            .await
            .map_err(|error| format!("download {} {artifact}: {error:#}", self.label))
    }

    fn version_record(&self, suffix: &str) -> Option<crate::downloads::VersionRecord> {
        Some(crate::downloads::VersionRecord {
            store_key: format!("{}-engine-{suffix}", self.name),
            version: self.engine_version.to_owned(),
        })
    }

    fn tool_index_path(&self) -> PathBuf {
        layout::cache_path(
            &crate::paths::ryu_dir(),
            &format!("{}/tools.idx", self.name),
        )
    }
}

pub(crate) struct NeedleSelector {
    runtime: &'static NeedleRuntime,
    /// `None` until the first successful resolution. Failed downloads are not
    /// cached permanently, so a transient network failure can recover later.
    resolved_library: Mutex<Option<PathBuf>>,
    /// Needle's C ABI has process-global state and is not safe to call
    /// concurrently. The dynamic library stays loaded for Core's lifetime.
    engine: Arc<std::sync::Mutex<Option<NeedleLibrary>>>,
}

impl NeedleSelector {
    pub(crate) fn new(runtime: &'static NeedleRuntime) -> Self {
        Self {
            runtime,
            resolved_library: Mutex::default(),
            engine: Arc::default(),
        }
    }

    async fn library_path(&self) -> Result<PathBuf, String> {
        if let Some(path) = self.runtime.explicit_library_path()? {
            return Ok(path);
        }

        let mut resolved = self.resolved_library.lock().await;
        if let Some(path) = resolved.as_ref() {
            return Ok(path.clone());
        }
        let path = self.runtime.ensure_default_library().await?;
        *resolved = Some(path.clone());
        Ok(path)
    }
}

#[async_trait::async_trait]
impl ToolSelector for NeedleSelector {
    async fn select(&self, query: &str, candidates: &[ToolDescriptor]) -> Option<Vec<String>> {
        if query.trim().is_empty() || candidates.is_empty() {
            return Some(Vec::new());
        }

        let runtime = self.runtime;
        let label = runtime.label;
        let path = match self.library_path().await {
            Ok(path) => path,
            Err(error) => {
                warn!(error = %error, "{label} unavailable; falling back to BM25 tool ranking");
                return None;
            }
        };
        let weight_path = match runtime.ensure_default_weights().await {
            Ok(path) => path,
            Err(error) => {
                warn!(error = %error, "{label} weights unavailable; falling back to BM25 tool ranking");
                return None;
            }
        };
        let query = query.to_owned();
        let candidates = candidates.to_vec();
        let engine = Arc::clone(&self.engine);

        match tokio::task::spawn_blocking(move || {
            let _call_guard = runtime
                .state
                .call_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut guard = engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.is_none() {
                *guard = Some(NeedleLibrary::load(runtime, &path, weight_path.as_deref())?);
            }
            guard
                .as_mut()
                .expect("Needle library was initialized")
                .select(&query, &candidates)
        })
        .await
        {
            Ok(Ok(selected)) => Some(selected),
            Ok(Err(error)) => {
                warn!(error = %error, "{label} selection failed; falling back to BM25 tool ranking");
                None
            }
            Err(error) => {
                warn!(error = %error, "{label} worker failed; falling back to BM25 tool ranking");
                None
            }
        }
    }
}

struct NeedleLibrary {
    runtime: &'static NeedleRuntime,
    _library: Library,
    init: NeedleInit,
    complete: NeedleComplete,
    reset: NeedleReset,
}

impl NeedleLibrary {
    /// Load the C ABI and, for a release with separate weights, hand them to
    /// `needle_load` before the first search.
    fn load(
        runtime: &'static NeedleRuntime,
        path: &Path,
        weights: Option<&Path>,
    ) -> Result<Self, String> {
        let label = runtime.label;
        // SAFETY: The library is kept alive in `_library` for at least as long
        // as all copied function pointers are used. The symbols and signatures
        // mirror Cactus's published ctypes ABI in `needle/__init__.py`.
        let library = unsafe { Library::new(path) }
            .map_err(|error| format!("load {label} library {}: {error}", path.display()))?;
        let init = unsafe { library.get::<NeedleInit>(b"needle_init\0") }
            .map(|symbol| *symbol)
            .map_err(|error| format!("load {label} needle_init: {error}"))?;
        let complete = unsafe { library.get::<NeedleComplete>(b"needle_complete\0") }
            .map(|symbol| *symbol)
            .map_err(|error| format!("load {label} needle_complete: {error}"))?;
        let reset = unsafe { library.get::<NeedleReset>(b"needle_reset\0") }
            .map(|symbol| *symbol)
            .map_err(|error| format!("load {label} needle_reset: {error}"))?;
        if let Some(weights) = weights {
            let load = unsafe { library.get::<NeedleLoad>(b"needle_load\0") }
                .map(|symbol| *symbol)
                .map_err(|error| format!("load {label} needle_load: {error}"))?;
            let bytes = std::fs::read(weights)
                .map_err(|error| format!("read {label} weights {}: {error}", weights.display()))?;
            let load_code = unsafe { (load)(bytes.as_ptr(), bytes.len() as u64) };
            if load_code < 0 {
                return Err(format!("needle_load failed with code {load_code}"));
            }
        }
        Ok(Self {
            runtime,
            _library: library,
            init,
            complete,
            reset,
        })
    }

    fn select(
        &mut self,
        query: &str,
        candidates: &[ToolDescriptor],
    ) -> Result<Vec<String>, String> {
        let label = self.runtime.label;
        let schemas = schemas_for(candidates)?;
        let schema_json = serde_json::to_string(&schemas)
            .map_err(|error| format!("serialize {label} schemas: {error}"))?;
        let system = c_string(label, "")?;
        let schema = c_string(label, &schema_json)?;
        let index_path = self.runtime.tool_index_path();
        if let Some(parent) = index_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {label} index dir: {error}"))?;
        }
        let index_path = c_string(label, &index_path.to_string_lossy())?;
        let query = c_string(label, query)?;

        // SAFETY: Every pointer is borrowed from a live CString for the duration
        // of the synchronous C call; the engine writes only into `output` below.
        let init_code =
            unsafe { (self.init)(system.as_ptr(), schema.as_ptr(), index_path.as_ptr()) };
        if init_code < 0 {
            return Err(format!("needle_init failed with code {init_code}"));
        }

        let mut output = vec![0_u8; NEEDLE_RESPONSE_BYTES];
        // SAFETY: `query` and `output` remain valid for the call and the output
        // length is bounded by the allocated buffer size.
        let complete_code = unsafe {
            (self.complete)(
                query.as_ptr(),
                NEEDLE_MAX_NEW_TOKENS,
                output.as_mut_ptr().cast::<c_char>(),
                output.len() as c_int,
            )
        };
        if complete_code < 0 {
            return Err(format!("needle_complete failed with code {complete_code}"));
        }

        let end = output
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| format!("{label} response was not NUL-terminated"))?;
        let response: Value = serde_json::from_slice(&output[..end])
            .map_err(|error| format!("parse {label} response: {error}"))?;
        let aliases = schemas
            .iter()
            .filter_map(|schema| {
                let name = schema.get("name")?.as_str()?.to_owned();
                let id = schema.get("x-ryu-id")?.as_str()?.to_owned();
                Some((name, id))
            })
            .collect::<HashMap<_, _>>();
        let selected = selected_ids(label, &response, &aliases)?;

        // Reset only clears the selector's conversation state; the library and
        // its schema index remain loaded for the next search.
        unsafe { (self.reset)() };
        Ok(selected)
    }
}

fn c_string(label: &str, value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| format!("{label} input contained a NUL byte"))
}

fn schemas_for(candidates: &[ToolDescriptor]) -> Result<Vec<Value>, String> {
    candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let name = function_name(&candidate.id, index);
            let kind = if candidate.kind == ToolKind::Skill {
                "Agent Skill to load through skills.load"
            } else {
                "callable Ryu tool"
            };
            let description = format!(
                "{kind}; canonical id `{}`; name `{}`. {}",
                candidate.id, candidate.name, candidate.description
            );
            let mut properties = Map::new();
            for (index, arg_name) in candidate.arg_names.iter().enumerate() {
                let arg_description = candidate
                    .arg_descriptions
                    .get(index)
                    .cloned()
                    .unwrap_or_default();
                properties.insert(
                    arg_name.clone(),
                    json!({ "type": "string", "description": arg_description }),
                );
            }
            Ok(json!({
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                },
                "x-ryu-id": candidate.id,
            }))
        })
        .collect()
}

/// Preserve the catalog's semantic tokens in the model-facing function name
/// while keeping the identifier valid for Cactus's grammar. The numeric suffix
/// guarantees uniqueness after punctuation is normalized to underscores.
fn function_name(id: &str, index: usize) -> String {
    let mut normalized = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() {
            normalized.push(byte.to_ascii_lowercase() as char);
        } else if !normalized.ends_with('_') {
            normalized.push('_');
        }
    }
    let normalized = normalized.trim_matches('_');
    let normalized = if normalized.is_empty() {
        "candidate"
    } else {
        normalized
    };
    let max_name_len = 48_usize.saturating_sub(index.to_string().len() + 6);
    let stem: String = normalized.chars().take(max_name_len.max(1)).collect();
    format!("ryu_{stem}_{index}")
}

fn selected_ids(
    label: &str,
    response: &Value,
    aliases: &HashMap<String, String>,
) -> Result<Vec<String>, String> {
    let Some(calls) = response.get("function_calls").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    let mut selected = Vec::new();
    for call in calls {
        let Some(name) = call.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(id) = aliases.get(name) else {
            return Err(format!("{label} returned unknown candidate alias '{name}'"));
        };
        if !selected.iter().any(|existing| existing == id) {
            selected.push(id.clone());
        }
    }
    Ok(selected)
}

fn extract_library(
    label: &str,
    name: &str,
    wheel_path: &Path,
    library_path: &Path,
    member: &str,
) -> Result<(), String> {
    let wheel = std::fs::read(wheel_path)
        .map_err(|error| format!("read {label} wheel {}: {error}", wheel_path.display()))?;
    let mut archive = zip::ZipArchive::new(Cursor::new(wheel))
        .map_err(|error| format!("open {label} wheel: {error}"))?;
    let mut library = Vec::new();
    archive
        .by_name(member)
        .map_err(|error| format!("find {member} in {label} wheel: {error}"))?
        .read_to_end(&mut library)
        .map_err(|error| format!("read {member} from {label} wheel: {error}"))?;

    let parent = library_path
        .parent()
        .ok_or_else(|| format!("{label} library path has no parent"))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create {label} library dir: {error}"))?;
    let temporary = parent.join(format!(".{name}-library-{}.tmp", std::process::id()));
    std::fs::write(&temporary, library)
        .map_err(|error| format!("write temporary {label} library: {error}"))?;
    if let Err(error) = std::fs::rename(&temporary, library_path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("install {label} library: {error}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(library_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("set {label} library permissions: {error}"))?;
    }
    Ok(())
}

fn library_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "libneedle.dylib"
    } else if cfg!(target_os = "windows") {
        "libneedle.dll"
    } else {
        "libneedle.so"
    }
}

#[allow(unreachable_code)]
pub(crate) fn platform_tag() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Some("macosx_11_0_arm64");
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Some("macosx_11_0_x86_64");
    }
    #[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "aarch64"))]
    {
        return Some("manylinux2014_aarch64");
    }
    #[cfg(all(target_os = "linux", target_env = "gnu", target_arch = "x86_64"))]
    {
        return Some("manylinux2014_x86_64");
    }
    #[cfg(all(target_os = "linux", target_env = "musl", target_arch = "aarch64"))]
    {
        return Some("musllinux_1_2_aarch64");
    }
    #[cfg(all(target_os = "linux", target_env = "musl", target_arch = "x86_64"))]
    {
        return Some("musllinux_1_2_x86_64");
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Some("win_amd64");
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return Some("win_arm64");
    }
    None
}

/// Catalog fixtures shared by the release modules' runtime smoke tests.
#[cfg(test)]
pub(crate) mod test_support {
    use ryu_tool_registry::{ToolDescriptor, ToolKind};

    pub(crate) fn descriptor(
        id: &str,
        name: &str,
        description: &str,
        kind: ToolKind,
        args: &[(&str, &str)],
    ) -> ToolDescriptor {
        ToolDescriptor {
            id: id.to_owned(),
            name: name.to_owned(),
            description: description.to_owned(),
            kind,
            arg_names: args.iter().map(|(name, _)| (*name).to_owned()).collect(),
            arg_descriptions: args
                .iter()
                .map(|(_, description)| (*description).to_owned())
                .collect(),
            score: None,
            meta: None,
            widget_accessible: false,
            output_template: None,
        }
    }

    pub(crate) fn web_search() -> ToolDescriptor {
        descriptor(
            "exa.search",
            "search_web",
            "Search the web for current information and news.",
            ToolKind::Mcp,
            &[("query", "The search query.")],
        )
    }

    pub(crate) fn calendar_create() -> ToolDescriptor {
        descriptor(
            "calendar.create",
            "create_event",
            "Create a calendar event with a title and time.",
            ToolKind::Mcp,
            &[("title", "Event title."), ("time", "Event time.")],
        )
    }

    pub(crate) fn web_research_skill() -> ToolDescriptor {
        descriptor(
            "skills.web-research",
            "web_research_workflow",
            "Use a step-by-step web research workflow with source checking.",
            ToolKind::Skill,
            &[],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_maps_only_known_aliases_and_allows_refusal() {
        let aliases = HashMap::from([("ryu_candidate_0".to_owned(), "exa.search".to_owned())]);
        assert_eq!(
            selected_ids(
                "Needle",
                &json!({ "type": "refuse", "function_calls": [] }),
                &aliases
            )
            .expect("refusal"),
            Vec::<String>::new()
        );
        assert_eq!(
            selected_ids(
                "Needle",
                &json!({
                    "type": "call",
                    "function_calls": [{ "name": "ryu_candidate_0", "arguments": {} }]
                }),
                &aliases,
            )
            .expect("known alias"),
            vec!["exa.search"]
        );
        assert!(selected_ids(
            "Needle",
            &json!({ "function_calls": [{ "name": "unknown", "arguments": {} }] }),
            &aliases,
        )
        .is_err());
    }

    #[test]
    fn schemas_mark_skills_as_loadable_capabilities() {
        let candidate = test_support::descriptor(
            "skills.web",
            "Web research",
            "Research the web",
            ToolKind::Skill,
            &[],
        );
        let schemas = schemas_for(&[candidate]).expect("schema");
        assert_eq!(schemas[0]["x-ryu-id"], "skills.web");
        assert!(schemas[0]["description"]
            .as_str()
            .expect("description")
            .contains("Agent Skill"));
    }
}
