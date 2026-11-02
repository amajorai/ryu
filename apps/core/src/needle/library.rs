//! The loaded Needle C ABI: opening the native library, one select
//! transaction, and the schema/alias mapping around it.

use std::collections::HashMap;
use std::ffi::CString;
use std::os::raw::{c_char, c_int};
use std::path::Path;

use libloading::Library;
use serde_json::{json, Map, Value};

use ryu_tool_registry::{ToolDescriptor, ToolKind};

use super::NeedleRuntime;

const NEEDLE_RESPONSE_BYTES: usize = 64 * 1024;
const NEEDLE_MAX_NEW_TOKENS: c_int = 96;

type NeedleInit = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> c_int;
type NeedleComplete = unsafe extern "C" fn(*const c_char, c_int, *mut c_char, c_int) -> c_int;
type NeedleReset = unsafe extern "C" fn();
type NeedleLoad = unsafe extern "C" fn(*const u8, u64) -> c_int;

pub(super) struct NeedleLibrary {
    runtime: &'static NeedleRuntime,
    _library: Library,
    init: NeedleInit,
    complete: NeedleComplete,
    reset: NeedleReset,
}

impl NeedleLibrary {
    /// Load the C ABI and, for a release with separate weights, hand them to
    /// `needle_load` before the first search.
    pub(super) fn load(
        runtime: &'static NeedleRuntime,
        path: &Path,
        weights: Option<&Path>,
    ) -> Result<Self, String> {
        let label = runtime.label;
        // SAFETY: The library is kept alive in `_library` for at least as long
        // as all copied function pointers are used. The symbols and signatures
        // mirror Cactus's published ctypes ABI in `needle/__init__.py`.
        let library = unsafe { open_library(path) }
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

    pub(super) fn select(
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

pub(super) fn schemas_for(candidates: &[ToolDescriptor]) -> Result<Vec<Value>, String> {
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

pub(super) fn selected_ids(
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

/// Open the native library at `path`.
///
/// On Windows, Core restricts its DLL search order to System32 at startup
/// (`ryu_sidecar_runtime::dll_search`), so a plain `LoadLibrary` would no longer
/// find dependencies shipped beside the library. Load it by fully qualified path
/// with the library's own directory plus System32 instead: never the
/// executable's directory, the current directory, or `PATH`.
///
/// # Safety
///
/// Loading a library runs its initializers; the caller must trust `path`.
unsafe fn open_library(path: &Path) -> Result<Library, libloading::Error> {
    #[cfg(windows)]
    {
        let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
        unsafe {
            libloading::os::windows::Library::load_with_flags(
                &absolute,
                ryu_sidecar_runtime::dll_search::MANAGED_LIBRARY_LOAD_FLAGS,
            )
        }
        .map(Library::from)
    }
    #[cfg(not(windows))]
    {
        unsafe { Library::new(path) }
    }
}
