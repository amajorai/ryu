//! C-ABI surface over the `ryu-sdk` Rust core.
//!
//! This is the binding layer the Go (cgo) package calls, and is usable by any
//! C-FFI consumer. Conventions:
//!
//! - **Strings** are NUL-terminated UTF-8 `char*`. Every `char*` the library
//!   *returns* is heap-owned and must be freed with [`ryu_string_free`].
//! - **Value functions** (e.g. parse, schema, resolve-url) return a `char*`, or
//!   `NULL` on error — call [`ryu_last_error`] for the message.
//! - **Void/validate functions** return `0` on success, `-1` on error (message
//!   via [`ryu_last_error`]).
//! - The hand-written header is `include/ryu_sdk.h` (regenerate with cbindgen).

use std::cell::RefCell;
use std::ffi::{c_char, c_int, CStr, CString};
use std::sync::OnceLock;

thread_local! {
    /// Last error message for the current thread, set by failing calls.
    static LAST_ERROR: RefCell<Option<CString>> = const { RefCell::new(None) };
}

fn set_error(msg: impl Into<String>) {
    let c = CString::new(msg.into()).unwrap_or_else(|_| CString::new("error").unwrap());
    LAST_ERROR.with(|e| *e.borrow_mut() = Some(c));
}

fn clear_error() {
    LAST_ERROR.with(|e| *e.borrow_mut() = None);
}

/// Shared multi-thread tokio runtime for the blocking model calls.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build tokio runtime")
    })
}

/// Borrow a `*const c_char` as `&str`, or set an error and return `None`.
///
/// # Safety
/// `ptr` must be NULL or a valid NUL-terminated UTF-8 string.
unsafe fn as_str<'a>(ptr: *const c_char, what: &str) -> Option<&'a str> {
    if ptr.is_null() {
        set_error(format!("{what} pointer is null"));
        return None;
    }
    match CStr::from_ptr(ptr).to_str() {
        Ok(s) => Some(s),
        Err(_) => {
            set_error(format!("{what} is not valid UTF-8"));
            None
        }
    }
}

/// Allocate an owned C string the caller must free with [`ryu_string_free`].
fn to_c_string(s: String) -> *mut c_char {
    match CString::new(s) {
        Ok(c) => c.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

// ── Error + memory management ──────────────────────────────────────────────────

/// Return the current thread's last error as an owned C string, or `NULL` if
/// none. Caller frees with [`ryu_string_free`].
#[no_mangle]
pub extern "C" fn ryu_last_error() -> *mut c_char {
    LAST_ERROR.with(|e| match &*e.borrow() {
        Some(c) => to_c_string(c.to_string_lossy().into_owned()),
        None => std::ptr::null_mut(),
    })
}

/// Free a `char*` previously returned by this library. NULL is a no-op.
///
/// # Safety
/// `ptr` must be a pointer returned by this library and not already freed.
#[no_mangle]
pub unsafe extern "C" fn ryu_string_free(ptr: *mut c_char) {
    if !ptr.is_null() {
        drop(CString::from_raw(ptr));
    }
}

// ── Manifest + schema ─────────────────────────────────────────────────────────

/// Validate a plugin id. Returns `0` if valid, `-1` otherwise (see
/// [`ryu_last_error`]).
///
/// # Safety
/// `id` must be a valid NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn ryu_validate_plugin_id(id: *const c_char) -> c_int {
    clear_error();
    let Some(id) = as_str(id, "id") else {
        return -1;
    };
    match ryu_sdk::validate_plugin_id(id) {
        Ok(()) => 0,
        Err(e) => {
            set_error(e);
            -1
        }
    }
}

/// Parse and fully validate a `plugin.json` string. Returns the normalized
/// manifest JSON (caller frees), or `NULL` on error.
///
/// # Safety
/// `json` must be a valid NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn ryu_parse_and_validate_manifest(json: *const c_char) -> *mut c_char {
    clear_error();
    let Some(json) = as_str(json, "json") else {
        return std::ptr::null_mut();
    };
    match ryu_sdk::PluginManifest::parse_and_validate(json) {
        Ok(m) => match serde_json::to_string(&m) {
            Ok(s) => to_c_string(s),
            Err(e) => {
                set_error(e.to_string());
                std::ptr::null_mut()
            }
        },
        Err(e) => {
            set_error(e);
            std::ptr::null_mut()
        }
    }
}

/// Return the `plugin.json` JSON Schema as a string (caller frees).
#[no_mangle]
pub extern "C" fn ryu_plugin_manifest_json_schema() -> *mut c_char {
    clear_error();
    to_c_string(ryu_sdk::json_schema::plugin_manifest_schema().to_string())
}

// ── Gateway ───────────────────────────────────────────────────────────────────

/// Return the resolved gateway base URL (caller frees).
#[no_mangle]
pub extern "C" fn ryu_resolve_gateway_url() -> *mut c_char {
    clear_error();
    to_c_string(ryu_sdk::resolve_gateway_url())
}

/// Validate an egress URL. Returns `0` if allowed, `-1` if it points at a
/// blocked direct provider (see [`ryu_last_error`]).
///
/// # Safety
/// `url` must be a valid NUL-terminated UTF-8 string.
#[no_mangle]
pub unsafe extern "C" fn ryu_assert_allowed_egress(url: *const c_char) -> c_int {
    clear_error();
    let Some(url) = as_str(url, "url") else {
        return -1;
    };
    match ryu_sdk::assert_allowed_egress(url) {
        Ok(()) => 0,
        Err(e) => {
            set_error(e.to_string());
            -1
        }
    }
}

// ── Model client ──────────────────────────────────────────────────────────────

/// Opaque handle to a [`ryu_sdk::ModelClient`].
pub struct ModelClientHandle {
    inner: ryu_sdk::ModelClient,
}

/// Construct a model client. `base_url`/`token` may be NULL to use the
/// `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN` defaults. Returns a handle to free
/// with [`ryu_model_client_free`], or `NULL` on error (e.g. blocked egress).
///
/// # Safety
/// `model` must be a valid UTF-8 string; `base_url`/`token` NULL or valid UTF-8.
#[no_mangle]
pub unsafe extern "C" fn ryu_model_client_new(
    model: *const c_char,
    base_url: *const c_char,
    token: *const c_char,
) -> *mut ModelClientHandle {
    clear_error();
    let Some(model) = as_str(model, "model") else {
        return std::ptr::null_mut();
    };
    let base_url = if base_url.is_null() {
        None
    } else {
        match as_str(base_url, "base_url") {
            Some(s) => Some(s.to_string()),
            None => return std::ptr::null_mut(),
        }
    };
    let token = if token.is_null() {
        None
    } else {
        match as_str(token, "token") {
            Some(s) => Some(s.to_string()),
            None => return std::ptr::null_mut(),
        }
    };
    match ryu_sdk::ModelClient::new(model, ryu_sdk::ModelClientOptions { base_url, token }) {
        Ok(inner) => Box::into_raw(Box::new(ModelClientHandle { inner })),
        Err(e) => {
            set_error(e.to_string());
            std::ptr::null_mut()
        }
    }
}

/// Free a model client handle. NULL is a no-op.
///
/// # Safety
/// `handle` must be a pointer from [`ryu_model_client_new`], not already freed.
#[no_mangle]
pub unsafe extern "C" fn ryu_model_client_free(handle: *mut ModelClientHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Blocking non-streaming chat completion. `messages_json` is a JSON array of
/// `{"role","content"}`. Returns a JSON object
/// `{"content","finish_reason","usage"}` (caller frees), or `NULL` on error.
///
/// # Safety
/// `handle` must be a valid handle; `messages_json` a valid UTF-8 JSON string.
#[no_mangle]
pub unsafe extern "C" fn ryu_model_client_chat(
    handle: *const ModelClientHandle,
    messages_json: *const c_char,
) -> *mut c_char {
    clear_error();
    if handle.is_null() {
        set_error("model client handle is null");
        return std::ptr::null_mut();
    }
    let Some(messages_json) = as_str(messages_json, "messages_json") else {
        return std::ptr::null_mut();
    };
    let messages: Vec<ryu_sdk::ChatMessage> = match serde_json::from_str(messages_json) {
        Ok(m) => m,
        Err(e) => {
            set_error(format!("invalid messages_json: {e}"));
            return std::ptr::null_mut();
        }
    };
    let client = &(*handle).inner;
    let result = runtime().block_on(client.chat(&messages));
    match result {
        Ok(res) => {
            let usage = res.usage.map(|u| {
                serde_json::json!({
                    "prompt_tokens": u.prompt_tokens,
                    "completion_tokens": u.completion_tokens,
                    "total_tokens": u.total_tokens,
                })
            });
            let payload = serde_json::json!({
                "content": res.content,
                "finish_reason": res.finish_reason,
                "usage": usage,
            });
            to_c_string(payload.to_string())
        }
        Err(e) => {
            set_error(e.to_string());
            std::ptr::null_mut()
        }
    }
}

// ── Embedding client ────────────────────────────────────────────────────────────

/// Opaque handle to a [`ryu_sdk::EmbeddingClient`].
pub struct EmbeddingClientHandle {
    inner: ryu_sdk::EmbeddingClient,
}

/// Construct an embedding client. `base_url`/`token` may be NULL to use the
/// `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN` defaults. Returns a handle to free
/// with [`ryu_embedding_client_free`], or `NULL` on error (e.g. blocked egress).
///
/// # Safety
/// `model` must be a valid UTF-8 string; `base_url`/`token` NULL or valid UTF-8.
#[no_mangle]
pub unsafe extern "C" fn ryu_embedding_client_new(
    model: *const c_char,
    base_url: *const c_char,
    token: *const c_char,
) -> *mut EmbeddingClientHandle {
    clear_error();
    let Some(model) = as_str(model, "model") else {
        return std::ptr::null_mut();
    };
    let base_url = if base_url.is_null() {
        None
    } else {
        match as_str(base_url, "base_url") {
            Some(s) => Some(s.to_string()),
            None => return std::ptr::null_mut(),
        }
    };
    let token = if token.is_null() {
        None
    } else {
        match as_str(token, "token") {
            Some(s) => Some(s.to_string()),
            None => return std::ptr::null_mut(),
        }
    };
    match ryu_sdk::EmbeddingClient::new(model, ryu_sdk::EmbeddingClientOptions { base_url, token })
    {
        Ok(inner) => Box::into_raw(Box::new(EmbeddingClientHandle { inner })),
        Err(e) => {
            set_error(e.to_string());
            std::ptr::null_mut()
        }
    }
}

/// Free an embedding client handle. NULL is a no-op.
///
/// # Safety
/// `handle` must be a pointer from [`ryu_embedding_client_new`], not already freed.
#[no_mangle]
pub unsafe extern "C" fn ryu_embedding_client_free(handle: *mut EmbeddingClientHandle) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}

/// Blocking embedding request. `inputs_json` is a JSON array of strings. Returns
/// a JSON object `{"embeddings":[{"index","vector"}],"usage"}` (caller frees), or
/// `NULL` on error.
///
/// # Safety
/// `handle` must be a valid handle; `inputs_json` a valid UTF-8 JSON string.
#[no_mangle]
pub unsafe extern "C" fn ryu_embedding_client_embed(
    handle: *const EmbeddingClientHandle,
    inputs_json: *const c_char,
) -> *mut c_char {
    clear_error();
    if handle.is_null() {
        set_error("embedding client handle is null");
        return std::ptr::null_mut();
    }
    let Some(inputs_json) = as_str(inputs_json, "inputs_json") else {
        return std::ptr::null_mut();
    };
    let inputs: Vec<String> = match serde_json::from_str(inputs_json) {
        Ok(v) => v,
        Err(e) => {
            set_error(format!("invalid inputs_json: {e}"));
            return std::ptr::null_mut();
        }
    };
    let client = &(*handle).inner;
    let result = runtime().block_on(client.embed(&inputs));
    match result {
        Ok(res) => {
            let embeddings: Vec<serde_json::Value> = res
                .embeddings
                .iter()
                .map(|e| {
                    serde_json::json!({
                        "index": e.index,
                        "vector": e.vector,
                    })
                })
                .collect();
            let usage = res.usage.map(|u| {
                serde_json::json!({
                    "prompt_tokens": u.prompt_tokens,
                    "total_tokens": u.total_tokens,
                })
            });
            let payload = serde_json::json!({
                "embeddings": embeddings,
                "usage": usage,
            });
            to_c_string(payload.to_string())
        }
        Err(e) => {
            set_error(e.to_string());
            std::ptr::null_mut()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Take ownership of a returned C string and turn it into a Rust String,
    /// freeing it via the library's own free fn (exercises that path too).
    unsafe fn take(ptr: *mut c_char) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        ryu_string_free(ptr);
        Some(s)
    }

    fn c(s: &str) -> CString {
        CString::new(s).unwrap()
    }

    #[test]
    fn validate_plugin_id_ffi() {
        unsafe {
            assert_eq!(ryu_validate_plugin_id(c("io.ryu.ok").as_ptr()), 0);
            assert!(take(ryu_last_error()).is_none(), "no error on success");

            assert_eq!(ryu_validate_plugin_id(c("../evil").as_ptr()), -1);
            assert!(!take(ryu_last_error()).expect("error set").is_empty());

            // Null input is a handled error, not a crash.
            assert_eq!(ryu_validate_plugin_id(std::ptr::null()), -1);
            assert!(take(ryu_last_error()).unwrap().contains("null"));
        }
    }

    #[test]
    fn manifest_parse_and_schema_ffi() {
        unsafe {
            let good = c(
                r#"{"id":"com.example.x","name":"X","version":"1.0.0","runnables":[{"id":"t","name":"T","kind":"tool","config":{"slug":"s"}}]}"#,
            );
            let out = take(ryu_parse_and_validate_manifest(good.as_ptr())).expect("ok");
            assert!(out.contains("com.example.x"));

            let bad = c(r#"{"id":"com.example.x","name":"X","version":"nope","runnables":[]}"#);
            assert!(ryu_parse_and_validate_manifest(bad.as_ptr()).is_null());
            assert!(take(ryu_last_error()).unwrap().contains("semver"));

            let schema = take(ryu_plugin_manifest_json_schema()).expect("schema");
            assert!(schema.contains("\"properties\"") && schema.contains("version"));
        }
    }

    #[test]
    fn gateway_ffi() {
        unsafe {
            let url = take(ryu_resolve_gateway_url()).expect("url");
            assert!(url.starts_with("http"));

            assert_eq!(
                ryu_assert_allowed_egress(c("http://127.0.0.1:7981").as_ptr()),
                0
            );
            assert_eq!(
                ryu_assert_allowed_egress(c("https://api.openai.com").as_ptr()),
                -1
            );
            assert!(take(ryu_last_error())
                .unwrap()
                .to_lowercase()
                .contains("egress"));
        }
    }

    #[test]
    fn model_client_lifecycle_ffi() {
        unsafe {
            // Direct-provider base URL is rejected at construction.
            let bad = ryu_model_client_new(
                c("gpt-4o").as_ptr(),
                c("https://api.openai.com").as_ptr(),
                std::ptr::null(),
            );
            assert!(bad.is_null());
            assert!(take(ryu_last_error()).is_some());

            // Gateway URL constructs a handle we can free.
            let h = ryu_model_client_new(
                c("gemma4").as_ptr(),
                c("http://127.0.0.1:7981").as_ptr(),
                std::ptr::null(),
            );
            assert!(!h.is_null());
            ryu_model_client_free(h);
            // Freeing null is a no-op.
            ryu_model_client_free(std::ptr::null_mut());
        }
    }

    #[test]
    fn embedding_client_lifecycle_ffi() {
        unsafe {
            // Direct-provider base URL is rejected at construction.
            let bad = ryu_embedding_client_new(
                c("text-embedding-3-small").as_ptr(),
                c("https://api.openai.com").as_ptr(),
                std::ptr::null(),
            );
            assert!(bad.is_null());
            assert!(take(ryu_last_error()).is_some());

            // Gateway URL constructs a handle we can free.
            let h = ryu_embedding_client_new(
                c("nomic-embed-text-v1.5").as_ptr(),
                c("http://127.0.0.1:7981").as_ptr(),
                std::ptr::null(),
            );
            assert!(!h.is_null());

            // Invalid inputs_json is a handled error, not a crash.
            assert!(ryu_embedding_client_embed(h, c("not json").as_ptr()).is_null());
            assert!(take(ryu_last_error()).unwrap().contains("inputs_json"));

            ryu_embedding_client_free(h);
            // Freeing null is a no-op.
            ryu_embedding_client_free(std::ptr::null_mut());
        }
    }
}
