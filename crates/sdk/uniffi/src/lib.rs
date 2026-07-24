//! UniFFI binding surface over the `ryu-sdk` Rust core.
//!
//! This is the **multi-language** path: one cdylib, from which `uniffi-bindgen`
//! emits idiomatic Python / Swift / Kotlin packages (and, via the third-party
//! `uniffi-bindgen-cs` / `uniffi-bindgen-go`, C# and Go). It sits alongside the
//! two existing bindings and wraps the **same** `ryu_sdk::*` functions they do,
//! so manifest rules, the gateway egress blocklist, and the model/embedding
//! transport never drift across languages:
//!
//! - `crates/ryu-sdk-napi`  — TypeScript/JS (napi-rs; the shipped #439 binding,
//!   keeps the streaming closure boundary via `ThreadsafeFunction`).
//! - `crates/ryu-sdk-ffi`   — raw C-ABI (hand-written; cgo-consumed Go today).
//! - `crates/ryu-sdk-uniffi` (this) — the generated multi-language path.
//!
//! ## Scope: the blocking surface + streaming via a callback interface
//!
//! UniFFI has no closure type (`crates/ryu-sdk/SPIKE-napi-closure-boundary.md`,
//! section (a)), so the bulk of the surface is **blocking, value-in / value-out**
//! and maps onto UniFFI's IDL with zero callback machinery. Streaming chat
//! (`ModelClient::stream`) is the one exception: it is surfaced through the
//! `#[uniffi::export(callback_interface)] ChatSink { on_delta / on_error /
//! on_done }` the spike predicted, with a blocking `ModelClient::stream(messages,
//! sink)` that drives the underlying async `ryu_sdk` stream on the shared runtime
//! and pumps deltas into the foreign sink. See
//! `docs/multi-language-bindings-spec.md` for the full streaming design.

// Namespace = the generated foreign module name. We set it to `ryu_sdk` (NOT the
// crate name `ryu_sdk_uniffi`) so the emitted package imports as `import ryu_sdk`
// in Python (and the equivalent in Swift/Kotlin), matching `bindings/python`'s
// pyproject + smoke test. The FFI symbol prefix still derives from the crate path
// and the compiled library is loaded by `cdylib_name` in `uniffi.toml`, so this
// only renames the surfaced package, not the linked artifact.
uniffi::setup_scaffolding!("ryu_sdk");

use std::sync::OnceLock;

/// The single error type surfaced to foreign code. Carries the human-readable
/// message from the underlying `ryu_sdk` error, so a Python/Swift caller gets a
/// `RyuError` with `.message` (or the language's idiomatic equivalent).
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum RyuError {
    #[error("{message}")]
    Ryu { message: String },
}

impl RyuError {
    fn msg(message: impl Into<String>) -> Self {
        RyuError::Ryu {
            message: message.into(),
        }
    }
}

/// Shared multi-thread tokio runtime for the blocking model/embedding calls,
/// mirroring `crates/ryu-sdk-ffi/src/lib.rs:33-41`. The foreign caller blocks on
/// these and runs its own thread/task for concurrency — no closure crosses the
/// boundary.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build tokio runtime")
    })
}

// ── Manifest + schema ─────────────────────────────────────────────────────────

/// Validate a plugin id (reverse-domain, path-traversal-safe). Errors on invalid.
#[uniffi::export]
pub fn validate_plugin_id(id: String) -> Result<(), RyuError> {
    ryu_sdk::validate_plugin_id(&id).map_err(RyuError::msg)
}

/// Parse and fully validate a `manifest.json` string (id, semver, per-kind runnable
/// contracts). Returns the normalized manifest JSON string, or errors.
#[uniffi::export]
pub fn parse_and_validate_manifest(json: String) -> Result<String, RyuError> {
    let manifest = ryu_sdk::PluginManifest::parse_and_validate(&json).map_err(RyuError::msg)?;
    serde_json::to_string(&manifest).map_err(|e| RyuError::msg(e.to_string()))
}

/// The `manifest.json` JSON Schema as a string. Derived from the Rust types, so it
/// never drifts from what the core validates.
#[uniffi::export]
pub fn plugin_manifest_json_schema() -> String {
    ryu_sdk::json_schema::plugin_manifest_schema().to_string()
}

// ── Gateway ───────────────────────────────────────────────────────────────────

/// Resolve the effective gateway base URL (`RYU_GATEWAY_URL` or the default).
#[uniffi::export]
pub fn resolve_gateway_url() -> String {
    ryu_sdk::resolve_gateway_url()
}

/// Resolve the optional gateway bearer token (`RYU_GATEWAY_TOKEN`), or `None`.
#[uniffi::export]
pub fn resolve_gateway_token() -> Option<String> {
    ryu_sdk::resolve_gateway_token()
}

/// Error if `url` points at a blocked direct-provider endpoint (the egress rule
/// every binding shares — `api.openai.com` and friends are rejected so all
/// model calls route through the local gateway).
#[uniffi::export]
pub fn assert_allowed_egress(url: String) -> Result<(), RyuError> {
    ryu_sdk::assert_allowed_egress(&url).map_err(|e| RyuError::msg(e.to_string()))
}

// ── Model client ──────────────────────────────────────────────────────────────

/// A chat message. `role` is "system" | "user" | "assistant".
#[derive(uniffi::Record)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Token usage for a completion, when the gateway reports it.
#[derive(uniffi::Record)]
pub struct Usage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

/// A non-streaming chat completion result. Also delivered to
/// [`ChatSink::on_done`] as the accumulated terminal result of a stream (with the
/// joined content + finish reason; `usage` is `None` on the streaming path because
/// the gateway's SSE frames carry no usage — see `ryu_sdk::model`).
#[derive(uniffi::Record)]
pub struct ChatResult {
    pub content: String,
    pub finish_reason: Option<String>,
    pub usage: Option<Usage>,
}

/// A streaming chat completion delta, delivered to [`ChatSink::on_delta`] as the
/// gateway's OpenAI-compat SSE frames arrive. `content` is the incremental text
/// fragment (may be empty on role-only chunks); `finish_reason` is set on the
/// final chunk.
#[derive(uniffi::Record)]
pub struct ChatDelta {
    pub content: String,
    pub finish_reason: Option<String>,
}

/// A foreign-implemented sink that receives streaming chat events. This is the
/// callback-interface path UniFFI requires for streaming (it has no closure type):
/// a Python/Swift/Kotlin/C#/Go caller implements the three methods and passes an
/// instance to [`ModelClient::stream`]. The Rust side drives the underlying
/// gateway-validated stream and invokes these in order — zero or more `on_delta`,
/// then exactly one terminal `on_done` (success) **or** `on_error` (failure).
///
/// **Re-entrancy:** these callbacks run on the runtime driver thread while
/// [`ModelClient::stream`] holds a `block_on`. An implementation MUST NOT call
/// back into another blocking SDK method (`chat` / `embed` / `stream`) from
/// inside a callback — each of those opens its own `block_on`, and starting a
/// runtime from within a runtime panics (`Cannot start a runtime from within a
/// runtime`), aborting the FFI process. To chain a follow-up completion, return
/// from the callback first and issue it from your own thread.
#[uniffi::export(callback_interface)]
pub trait ChatSink: Send + Sync {
    /// One incremental delta from the stream.
    fn on_delta(&self, delta: ChatDelta);
    /// A terminal error; no further callbacks follow. `message` is the underlying
    /// `ryu_sdk` error text (transport, HTTP status, or blocked egress).
    fn on_error(&self, message: String);
    /// Terminal success. `result` is the accumulated reply (joined content +
    /// finish reason); no further callbacks follow.
    fn on_done(&self, result: ChatResult);
}

/// A gateway-mandatory model client. Every call routes through the Ryu gateway;
/// direct-provider base URLs are rejected at construction (`new` errors).
#[derive(uniffi::Object)]
pub struct ModelClient {
    inner: ryu_sdk::ModelClient,
}

#[uniffi::export]
impl ModelClient {
    /// Create a client for `model`. `base_url` / `token` default to
    /// `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN` when `None`.
    #[uniffi::constructor]
    pub fn new(
        model: String,
        base_url: Option<String>,
        token: Option<String>,
    ) -> Result<std::sync::Arc<Self>, RyuError> {
        let inner =
            ryu_sdk::ModelClient::new(model, ryu_sdk::ModelClientOptions { base_url, token })
                .map_err(|e| RyuError::msg(e.to_string()))?;
        Ok(std::sync::Arc::new(Self { inner }))
    }

    /// Blocking non-streaming chat completion. Returns the full reply. For
    /// incremental deltas, use [`ModelClient::stream`] with a [`ChatSink`].
    pub fn chat(&self, messages: Vec<ChatMessage>) -> Result<ChatResult, RyuError> {
        let msgs: Vec<ryu_sdk::ChatMessage> = messages
            .into_iter()
            .map(|m| ryu_sdk::ChatMessage {
                role: m.role,
                content: m.content,
            })
            .collect();
        let res = runtime()
            .block_on(self.inner.chat(&msgs))
            .map_err(|e| RyuError::msg(e.to_string()))?;
        Ok(ChatResult {
            content: res.content,
            finish_reason: res.finish_reason,
            usage: res.usage.map(|u| Usage {
                prompt_tokens: u.prompt_tokens as i64,
                completion_tokens: u.completion_tokens as i64,
                total_tokens: u.total_tokens as i64,
            }),
        })
    }

    /// Blocking streaming chat completion. Drives the **same** gateway-validated
    /// `ryu_sdk::ModelClient::stream` on the shared runtime and pumps each delta
    /// into `sink`, so the egress invariant holds identically to `chat` (a
    /// direct-provider client cannot be constructed in the first place). Returns
    /// when the stream ends: every delta is delivered via `sink.on_delta`, then
    /// exactly one `sink.on_done` (success) or `sink.on_error` (failure).
    pub fn stream(&self, messages: Vec<ChatMessage>, sink: Box<dyn ChatSink>) {
        use futures_util::StreamExt;

        let msgs: Vec<ryu_sdk::ChatMessage> = messages
            .into_iter()
            .map(|m| ryu_sdk::ChatMessage {
                role: m.role,
                content: m.content,
            })
            .collect();
        runtime().block_on(async {
            let stream = self.inner.stream(&msgs);
            futures_util::pin_mut!(stream);
            let mut content = String::new();
            let mut finish_reason: Option<String> = None;
            while let Some(item) = stream.next().await {
                match item {
                    Ok(delta) => {
                        content.push_str(&delta.content);
                        if delta.finish_reason.is_some() {
                            finish_reason.clone_from(&delta.finish_reason);
                        }
                        sink.on_delta(ChatDelta {
                            content: delta.content,
                            finish_reason: delta.finish_reason,
                        });
                    }
                    Err(e) => {
                        sink.on_error(e.to_string());
                        return;
                    }
                }
            }
            sink.on_done(ChatResult {
                content,
                finish_reason,
                usage: None,
            });
        });
    }
}

// ── Embedding client ────────────────────────────────────────────────────────────

/// One embedding vector with its position in the input batch.
#[derive(uniffi::Record)]
pub struct Embedding {
    pub index: u32,
    pub vector: Vec<f64>,
}

/// The result of an embedding request: one vector per input, in input order.
#[derive(uniffi::Record)]
pub struct EmbeddingResult {
    pub embeddings: Vec<Embedding>,
    pub prompt_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

/// A gateway-mandatory embedding client. Every call routes through the Ryu
/// gateway; direct-provider base URLs are rejected at construction.
#[derive(uniffi::Object)]
pub struct EmbeddingClient {
    inner: ryu_sdk::EmbeddingClient,
}

#[uniffi::export]
impl EmbeddingClient {
    /// Create an embedding client for `model`. `base_url` / `token` default to
    /// `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN` when `None`.
    #[uniffi::constructor]
    pub fn new(
        model: String,
        base_url: Option<String>,
        token: Option<String>,
    ) -> Result<std::sync::Arc<Self>, RyuError> {
        let inner = ryu_sdk::EmbeddingClient::new(
            model,
            ryu_sdk::EmbeddingClientOptions { base_url, token },
        )
        .map_err(|e| RyuError::msg(e.to_string()))?;
        Ok(std::sync::Arc::new(Self { inner }))
    }

    /// Blocking embedding request. Returns one vector per input (in order).
    pub fn embed(&self, inputs: Vec<String>) -> Result<EmbeddingResult, RyuError> {
        let res = runtime()
            .block_on(self.inner.embed(&inputs))
            .map_err(|e| RyuError::msg(e.to_string()))?;
        Ok(EmbeddingResult {
            embeddings: res
                .embeddings
                .into_iter()
                .map(|e| Embedding {
                    index: e.index as u32,
                    vector: e.vector.into_iter().map(f64::from).collect(),
                })
                .collect(),
            prompt_tokens: res.usage.as_ref().map(|u| u.prompt_tokens as i64),
            total_tokens: res.usage.as_ref().map(|u| u.total_tokens as i64),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These assert the SHARED rules through the UniFFI wrapper, mirroring the
    // C-ABI tests in crates/ryu-sdk-ffi/src/lib.rs so the single-core guarantee
    // is checked from this binding too — no foreign toolchain required.

    #[test]
    fn validate_plugin_id_rules() {
        assert!(validate_plugin_id("io.ryu.ok".into()).is_ok());
        assert!(validate_plugin_id("../evil".into()).is_err());
    }

    #[test]
    fn manifest_semver_error() {
        let bad = r#"{"id":"com.example.x","name":"X","version":"nope","runnables":[]}"#;
        let err = parse_and_validate_manifest(bad.into()).unwrap_err();
        let RyuError::Ryu { message } = err;
        assert!(
            message.contains("semver"),
            "expected semver error, got: {message}"
        );
    }

    #[test]
    fn manifest_parse_ok() {
        let good = r#"{"id":"com.example.x","name":"X","version":"1.0.0","runnables":[{"id":"t","name":"T","kind":"tool","config":{"slug":"s"}}]}"#;
        let out = parse_and_validate_manifest(good.into()).expect("valid manifest");
        assert!(out.contains("com.example.x"));
    }

    #[test]
    fn egress_blocklist() {
        assert!(assert_allowed_egress("http://127.0.0.1:7981".into()).is_ok());
        let err = assert_allowed_egress("https://api.openai.com".into()).unwrap_err();
        let RyuError::Ryu { message } = err;
        assert!(message.to_lowercase().contains("egress"));
    }

    #[test]
    fn model_client_rejects_direct_provider() {
        // Direct-provider base URL is rejected at construction.
        let bad = ModelClient::new("gpt-4o".into(), Some("https://api.openai.com".into()), None);
        assert!(bad.is_err());

        // Gateway URL constructs a client.
        let ok = ModelClient::new("gemma4".into(), Some("http://127.0.0.1:7981".into()), None);
        assert!(ok.is_ok());
    }

    #[test]
    fn embedding_client_rejects_direct_provider() {
        let bad = EmbeddingClient::new(
            "text-embedding-3-small".into(),
            Some("https://api.openai.com".into()),
            None,
        );
        assert!(bad.is_err());

        let ok = EmbeddingClient::new(
            "nomic-embed-text-v1.5".into(),
            Some("http://127.0.0.1:7981".into()),
            None,
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn schema_describes_manifest() {
        let schema = plugin_manifest_json_schema();
        assert!(schema.contains("\"properties\"") && schema.contains("version"));
    }
}
