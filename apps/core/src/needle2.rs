//! Core's Needle 2 selector for unified tool and Agent Skill discovery.
//!
//! Needle 2 is deliberately used as a selector, not as an authorization or
//! execution engine. Core builds a temporary function-schema view of the
//! already-scoped catalog, asks Needle 2 for the relevant function aliases,
//! and maps those aliases back to canonical Ryu descriptor ids. The existing
//! Gateway allowlist, approval, budget, audit, and Core dispatch paths remain
//! authoritative after this point.
//!
//! The upstream runtime is a small C ABI shipped in a platform-specific Python
//! wheel. We load that ABI dynamically so the normal Core binary stays usable
//! when the optional runtime is unavailable. The default path lazily downloads
//! and checksum-verifies the pinned public wheel through Ryu's DownloadCenter;
//! an unavailable runtime falls back to the deterministic BM25 ranker.

use std::collections::HashMap;
use std::ffi::CString;
use std::io::{Cursor, Read};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use anyhow::Result;
use libloading::Library;
use serde_json::{json, Map, Value};
use tokio::sync::Mutex;
use tracing::warn;

use ryu_tool_registry::{ToolDescriptor, ToolKind, ToolSelector};

const NEEDLE2_REPO: &str = "Cactus-Compute/needle2";
const NEEDLE2_REVISION: &str = "98fbd955b0347e78059be0c253cc1ffa09b87bc7";
const NEEDLE2_ENGINE_VERSION: &str = "2.0.3";
const NEEDLE2_RESPONSE_BYTES: usize = 64 * 1024;
const NEEDLE2_MAX_NEW_TOKENS: c_int = 96;
const NEEDLE2_DOWNLOAD_STORE_KEY_PREFIX: &str = "needle2-engine";

type NeedleInit = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> c_int;
type NeedleComplete = unsafe extern "C" fn(*const c_char, c_int, *mut c_char, c_int) -> c_int;
type NeedleReset = unsafe extern "C" fn();

/// The DownloadCenter shared by Core's other managed artifacts.
static DOWNLOADS: OnceLock<crate::downloads::DownloadCenter> = OnceLock::new();

/// The one process-local selector instance. Needle's C ABI owns one active
/// toolset, so a mutex inside the instance serializes its init/complete pair.
static SELECTOR: OnceLock<Arc<Needle2Selector>> = OnceLock::new();

/// Needle's C ABI state is process-global even when callers construct more
/// than one Rust selector (for example, concurrent catalog and skill searches
/// or isolated tests). Serialize the full init/complete/reset transaction
/// across those instances as well.
static NEEDLE_CALL_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

/// Install Core's process-wide DownloadCenter before any catalog search can
/// lazily fetch the Needle runtime. Idempotent to keep test/bootstrap wiring
/// harmless when called more than once.
pub fn install_downloads(downloads: crate::downloads::DownloadCenter) {
    let _ = DOWNLOADS.set(downloads);
}

/// Return the shared Core Needle 2 selector.
pub fn selector() -> Arc<Needle2Selector> {
    SELECTOR
        .get_or_init(|| Arc::new(Needle2Selector::default()))
        .clone()
}

#[derive(Default)]
pub struct Needle2Selector {
    /// `None` until the first successful resolution. Failed downloads are not
    /// cached permanently, so a transient network failure can recover later.
    resolved_library: Mutex<Option<PathBuf>>,
    /// Needle's C ABI has process-global state and is not safe to call
    /// concurrently. The dynamic library stays loaded for Core's lifetime.
    engine: Arc<std::sync::Mutex<Option<Needle2Library>>>,
}

impl Needle2Selector {
    async fn library_path(&self) -> Result<PathBuf, String> {
        if let Some(path) = explicit_library_path()? {
            return Ok(path);
        }

        let mut resolved = self.resolved_library.lock().await;
        if let Some(path) = resolved.as_ref() {
            return Ok(path.clone());
        }
        let path = ensure_default_library().await?;
        *resolved = Some(path.clone());
        Ok(path)
    }
}

#[async_trait::async_trait]
impl ToolSelector for Needle2Selector {
    async fn select(&self, query: &str, candidates: &[ToolDescriptor]) -> Option<Vec<String>> {
        if query.trim().is_empty() || candidates.is_empty() {
            return Some(Vec::new());
        }

        let path = match self.library_path().await {
            Ok(path) => path,
            Err(error) => {
                warn!(error = %error, "Needle 2 unavailable; falling back to BM25 tool ranking");
                return None;
            }
        };
        let query = query.to_owned();
        let candidates = candidates.to_vec();
        let engine = Arc::clone(&self.engine);

        match tokio::task::spawn_blocking(move || {
            let _call_guard = NEEDLE_CALL_LOCK
                .get_or_init(|| std::sync::Mutex::new(()))
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut guard = engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.is_none() {
                *guard = Some(Needle2Library::load(&path)?);
            }
            guard
                .as_mut()
                .expect("Needle 2 library was initialized")
                .select(&query, &candidates)
        })
        .await
        {
            Ok(Ok(selected)) => Some(selected),
            Ok(Err(error)) => {
                warn!(error = %error, "Needle 2 selection failed; falling back to BM25 tool ranking");
                None
            }
            Err(error) => {
                warn!(error = %error, "Needle 2 worker failed; falling back to BM25 tool ranking");
                None
            }
        }
    }
}

struct Needle2Library {
    _library: Library,
    init: NeedleInit,
    complete: NeedleComplete,
    reset: NeedleReset,
}

impl Needle2Library {
    fn load(path: &Path) -> Result<Self, String> {
        // SAFETY: The library is kept alive in `_library` for at least as long
        // as all copied function pointers are used. The symbols and signatures
        // mirror Cactus's published ctypes ABI in `needle/__init__.py`.
        let library = unsafe { Library::new(path) }
            .map_err(|error| format!("load Needle 2 library {}: {error}", path.display()))?;
        let init = unsafe { library.get::<NeedleInit>(b"needle_init\0") }
            .map(|symbol| *symbol)
            .map_err(|error| format!("load Needle 2 needle_init: {error}"))?;
        let complete = unsafe { library.get::<NeedleComplete>(b"needle_complete\0") }
            .map(|symbol| *symbol)
            .map_err(|error| format!("load Needle 2 needle_complete: {error}"))?;
        let reset = unsafe { library.get::<NeedleReset>(b"needle_reset\0") }
            .map(|symbol| *symbol)
            .map_err(|error| format!("load Needle 2 needle_reset: {error}"))?;
        Ok(Self {
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
        let schemas = schemas_for(candidates)?;
        let schema_json = serde_json::to_string(&schemas)
            .map_err(|error| format!("serialize Needle 2 schemas: {error}"))?;
        let system = c_string("")?;
        let schema = c_string(&schema_json)?;
        let index_path = tool_index_path();
        if let Some(parent) = index_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create Needle 2 index dir: {error}"))?;
        }
        let index_path = c_string(&index_path.to_string_lossy())?;
        let query = c_string(query)?;

        // SAFETY: Every pointer is borrowed from a live CString for the duration
        // of the synchronous C call; the engine writes only into `output` below.
        let init_code =
            unsafe { (self.init)(system.as_ptr(), schema.as_ptr(), index_path.as_ptr()) };
        if init_code < 0 {
            return Err(format!("needle_init failed with code {init_code}"));
        }

        let mut output = vec![0_u8; NEEDLE2_RESPONSE_BYTES];
        // SAFETY: `query` and `output` remain valid for the call and the output
        // length is bounded by the allocated buffer size.
        let complete_code = unsafe {
            (self.complete)(
                query.as_ptr(),
                NEEDLE2_MAX_NEW_TOKENS,
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
            .ok_or_else(|| "Needle 2 response was not NUL-terminated".to_owned())?;
        let response: Value = serde_json::from_slice(&output[..end])
            .map_err(|error| format!("parse Needle 2 response: {error}"))?;
        let aliases = schemas
            .iter()
            .filter_map(|schema| {
                let name = schema.get("name")?.as_str()?.to_owned();
                let id = schema.get("x-ryu-id")?.as_str()?.to_owned();
                Some((name, id))
            })
            .collect::<HashMap<_, _>>();
        let selected = selected_ids(&response, &aliases)?;

        // Reset only clears the selector's conversation state; the library and
        // its schema index remain loaded for the next search.
        unsafe { (self.reset)() };
        Ok(selected)
    }
}

fn c_string(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "Needle 2 input contained a NUL byte".to_owned())
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
            return Err(format!(
                "Needle 2 returned unknown candidate alias '{name}'"
            ));
        };
        if !selected.iter().any(|existing| existing == id) {
            selected.push(id.clone());
        }
    }
    Ok(selected)
}

fn explicit_library_path() -> Result<Option<PathBuf>, String> {
    for key in ["RYU_NEEDLE2_LIB_PATH", "NEEDLE_LIB_PATH"] {
        let Some(value) = std::env::var_os(key) else {
            continue;
        };
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(Some(path));
        }
        return Err(format!("{key} points to a missing Needle 2 library"));
    }
    Ok(None)
}

async fn ensure_default_library() -> Result<PathBuf, String> {
    let Some(platform) = platform_tag() else {
        return Err(format!(
            "Needle 2 has no bundled runtime wheel for target {}-{}; set RYU_NEEDLE2_LIB_PATH",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    };
    let library_name = library_name();
    let base = crate::paths::ryu_dir()
        .join("engines")
        .join("needle2")
        .join(NEEDLE2_ENGINE_VERSION);
    let library_path = base.join(library_name);
    if library_path.is_file() {
        return Ok(library_path);
    }
    std::fs::create_dir_all(&base)
        .map_err(|error| format!("create Needle 2 cache {}: {error}", base.display()))?;

    let wheel_name = format!("cactus_needle-{NEEDLE2_ENGINE_VERSION}-py3-none-{platform}.whl");
    let wheel_path = base.join(&wheel_name);
    let url = format!(
        "https://huggingface.co/{NEEDLE2_REPO}/resolve/{NEEDLE2_REVISION}/python/{wheel_name}"
    );
    let downloads = DOWNLOADS
        .get()
        .cloned()
        .ok_or_else(|| "Needle 2 DownloadCenter is not initialized".to_owned())?;
    let wheel_path = downloads
        .download_blocking(crate::downloads::DownloadSpec {
            kind: crate::downloads::DownloadKind::Engine,
            role: crate::downloads::DownloadRole::Engine,
            label: "Needle 2 tool and skill router".to_owned(),
            url,
            dest: wheel_path,
            sha256: expected_wheel_sha256(platform).map(str::to_owned),
            version_record: Some(crate::downloads::VersionRecord {
                store_key: format!("{NEEDLE2_DOWNLOAD_STORE_KEY_PREFIX}-{platform}"),
                version: NEEDLE2_ENGINE_VERSION.to_owned(),
            }),
        })
        .await
        .map_err(|error| format!("download Needle 2 runtime: {error:#}"))?;

    let library_path_for_extract = library_path.clone();
    let library_member = format!("needle/{library_name}");
    tokio::task::spawn_blocking(move || {
        extract_library(&wheel_path, &library_path_for_extract, &library_member)
    })
    .await
    .map_err(|error| format!("Needle 2 extraction worker failed: {error}"))??;
    Ok(library_path)
}

fn extract_library(wheel_path: &Path, library_path: &Path, member: &str) -> Result<(), String> {
    let wheel = std::fs::read(wheel_path)
        .map_err(|error| format!("read Needle 2 wheel {}: {error}", wheel_path.display()))?;
    let mut archive = zip::ZipArchive::new(Cursor::new(wheel))
        .map_err(|error| format!("open Needle 2 wheel: {error}"))?;
    let mut library = Vec::new();
    archive
        .by_name(member)
        .map_err(|error| format!("find {member} in Needle 2 wheel: {error}"))?
        .read_to_end(&mut library)
        .map_err(|error| format!("read {member} from Needle 2 wheel: {error}"))?;

    let parent = library_path
        .parent()
        .ok_or_else(|| "Needle 2 library path has no parent".to_owned())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create Needle 2 library dir: {error}"))?;
    let temporary = parent.join(format!(".needle2-library-{}.tmp", std::process::id()));
    std::fs::write(&temporary, library)
        .map_err(|error| format!("write temporary Needle 2 library: {error}"))?;
    if let Err(error) = std::fs::rename(&temporary, library_path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("install Needle 2 library: {error}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(library_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("set Needle 2 library permissions: {error}"))?;
    }
    Ok(())
}

fn tool_index_path() -> PathBuf {
    crate::paths::ryu_dir()
        .join("cache")
        .join("needle2")
        .join("tools.idx")
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
fn platform_tag() -> Option<&'static str> {
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

fn expected_wheel_sha256(platform: &str) -> Option<&'static str> {
    match platform {
        "macosx_11_0_arm64" => {
            Some("17c2b9ff3c3f1238e0a26385cfda0780d120cda390594d7fc7e5b7f2a970ce95")
        }
        "macosx_11_0_x86_64" => {
            Some("dc55a60b6803fbfd73fa50c09803df54bb47155dcdec74e5988c21838d5cc070")
        }
        "manylinux2014_aarch64" => {
            Some("0e6f0d04e42ac16f34661c7eaab027c87e1fdac294b3dbdb6ca5c9d0597398ab")
        }
        "manylinux2014_x86_64" => {
            Some("d23df1d0babeb7323dcaf860dfaf833bbd7d2229b205f691c05c9cbc6d3d3653")
        }
        "musllinux_1_2_aarch64" => {
            Some("89ae29fb3f3dabd46e374581bd87f71b7d044a95b9bd65ede2b42688ade632f0")
        }
        "musllinux_1_2_x86_64" => {
            Some("1a3558242d7f252255efff3258fc81b2d47ea74eace862fda60f16fe684caa53")
        }
        "win_amd64" => Some("3c012603a6bc5d7f36aa26da3d0819a8fa226dd40c7f242013b5e214a51168c7"),
        "win_arm64" => Some("cadcd8ff7f18b47046c547cbc450dabe607c197db2855eb6497d615ff551db0f"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_wheel_is_pinned() {
        let platform = platform_tag().expect("test host has a Needle 2 wheel");
        let digest = expected_wheel_sha256(platform).expect("platform digest");
        assert_eq!(digest.len(), 64);
        assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn selection_maps_only_known_aliases_and_allows_refusal() {
        let aliases = HashMap::from([("ryu_candidate_0".to_owned(), "exa.search".to_owned())]);
        assert_eq!(
            selected_ids(&json!({ "type": "refuse", "function_calls": [] }), &aliases)
                .expect("refusal"),
            Vec::<String>::new()
        );
        assert_eq!(
            selected_ids(
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
            &json!({ "function_calls": [{ "name": "unknown", "arguments": {} }] }),
            &aliases,
        )
        .is_err());
    }

    #[test]
    fn schemas_mark_skills_as_loadable_capabilities() {
        let candidate = ToolDescriptor {
            id: "skills.web".to_owned(),
            name: "Web research".to_owned(),
            description: "Research the web".to_owned(),
            kind: ToolKind::Skill,
            arg_names: Vec::new(),
            arg_descriptions: Vec::new(),
            score: None,
            meta: None,
            widget_accessible: false,
            output_template: None,
        };
        let schemas = schemas_for(&[candidate]).expect("schema");
        assert_eq!(schemas[0]["x-ryu-id"], "skills.web");
        assert!(schemas[0]["description"]
            .as_str()
            .expect("description")
            .contains("Agent Skill"));
    }

    #[tokio::test]
    async fn configured_runtime_selects_a_relevant_catalog_entry() {
        let Some(path) = std::env::var_os("RYU_NEEDLE2_LIB_PATH") else {
            return;
        };
        assert!(
            Path::new(&path).is_file(),
            "configured Needle 2 library exists"
        );

        let candidates = vec![
            ToolDescriptor {
                id: "exa.search".to_owned(),
                name: "search_web".to_owned(),
                description: "Search the web for current information and news.".to_owned(),
                kind: ToolKind::Mcp,
                arg_names: vec!["query".to_owned()],
                arg_descriptions: vec!["The search query.".to_owned()],
                score: None,
                meta: None,
                widget_accessible: false,
                output_template: None,
            },
            ToolDescriptor {
                id: "calendar.create".to_owned(),
                name: "create_event".to_owned(),
                description: "Create a calendar event with a title and time.".to_owned(),
                kind: ToolKind::Mcp,
                arg_names: vec!["title".to_owned(), "time".to_owned()],
                arg_descriptions: vec!["Event title.".to_owned(), "Event time.".to_owned()],
                score: None,
                meta: None,
                widget_accessible: false,
                output_template: None,
            },
        ];
        let selected = Needle2Selector::default()
            .select("search the web for the latest Rust news", &candidates)
            .await
            .expect("configured runtime returns a selection");
        assert_eq!(selected.first().map(String::as_str), Some("exa.search"));
    }

    #[tokio::test]
    async fn configured_runtime_selects_a_relevant_skill_entry() {
        let Some(path) = std::env::var_os("RYU_NEEDLE2_LIB_PATH") else {
            return;
        };
        assert!(
            Path::new(&path).is_file(),
            "configured Needle 2 library exists"
        );

        let candidates = vec![
            ToolDescriptor {
                id: "skills.web-research".to_owned(),
                name: "web_research_workflow".to_owned(),
                description: "Use a step-by-step web research workflow with source checking."
                    .to_owned(),
                kind: ToolKind::Skill,
                arg_names: Vec::new(),
                arg_descriptions: Vec::new(),
                score: None,
                meta: None,
                widget_accessible: false,
                output_template: None,
            },
            ToolDescriptor {
                id: "calendar.create".to_owned(),
                name: "create_event".to_owned(),
                description: "Create a calendar event with a title and time.".to_owned(),
                kind: ToolKind::Mcp,
                arg_names: vec!["title".to_owned(), "time".to_owned()],
                arg_descriptions: vec!["Event title.".to_owned(), "Event time.".to_owned()],
                score: None,
                meta: None,
                widget_accessible: false,
                output_template: None,
            },
        ];
        let selected = Needle2Selector::default()
            .select(
                "use a step-by-step web research workflow with source checking",
                &candidates,
            )
            .await
            .expect("configured runtime returns a skill selection");
        assert_eq!(
            selected.first().map(String::as_str),
            Some("skills.web-research")
        );
    }

    #[tokio::test]
    async fn default_runtime_can_download_and_select_when_enabled() {
        if std::env::var_os("RYU_NEEDLE2_AUTO_TEST").as_deref() != Some(std::ffi::OsStr::new("1")) {
            return;
        }
        assert!(explicit_library_path()
            .expect("explicit path check")
            .is_none());
        crate::downloads::install();
        let downloads = crate::downloads::DownloadCenter::with_default_client();
        downloads.load().await;
        install_downloads(downloads);

        let candidate = ToolDescriptor {
            id: "exa.search".to_owned(),
            name: "search_web".to_owned(),
            description: "Search the web for current information and news.".to_owned(),
            kind: ToolKind::Mcp,
            arg_names: vec!["query".to_owned()],
            arg_descriptions: vec!["The search query.".to_owned()],
            score: None,
            meta: None,
            widget_accessible: false,
            output_template: None,
        };
        let selected = Needle2Selector::default()
            .select("search the web for current Rust news", &[candidate])
            .await
            .expect("default runtime downloads and returns a selection");
        assert_eq!(selected, vec!["exa.search"]);
    }
}
