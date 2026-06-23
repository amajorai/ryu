//! `@ryu/sdk` native addon — the napi-rs binding that exposes the `ryu-sdk`
//! Rust core to TypeScript/JavaScript.
//!
//! This makes the SDK a true single-core: manifest validation, the JSON Schema,
//! the gateway egress rules, and the gateway-mandatory model client all run the
//! exact same Rust as the Go/Python bindings. (Tradeoff: a native addon does not
//! run in browsers/edge/workers and ships per-platform `.node` binaries.)

use futures_util::StreamExt;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

// ── Manifest + schema ─────────────────────────────────────────────────────────

/// Validate a plugin id (reverse-domain, path-traversal-safe). Throws on invalid.
#[napi]
pub fn validate_plugin_id(id: String) -> Result<()> {
    ryu_sdk::validate_plugin_id(&id).map_err(Error::from_reason)
}

/// Parse and fully validate a `plugin.json` string (id, semver, per-kind
/// runnable contracts). Returns the normalized manifest JSON, or throws.
#[napi]
pub fn parse_and_validate_manifest(json: String) -> Result<String> {
    let manifest = ryu_sdk::PluginManifest::parse_and_validate(&json).map_err(Error::from_reason)?;
    serde_json::to_string(&manifest).map_err(|e| Error::from_reason(e.to_string()))
}

/// The JSON Schema for a `plugin.json`, as a JSON string. Derived from the Rust
/// types, so it never drifts from what the core validates.
#[napi]
pub fn plugin_manifest_json_schema() -> String {
    ryu_sdk::json_schema::plugin_manifest_schema().to_string()
}

// ── Gateway ───────────────────────────────────────────────────────────────────

/// Resolve the effective gateway base URL (`RYU_GATEWAY_URL` or the default).
#[napi]
pub fn resolve_gateway_url() -> String {
    ryu_sdk::resolve_gateway_url()
}

/// Resolve the optional gateway bearer token (`RYU_GATEWAY_TOKEN`), or null.
#[napi]
pub fn resolve_gateway_token() -> Option<String> {
    ryu_sdk::resolve_gateway_token()
}

/// Throw if `url` points at a blocked direct-provider endpoint (egress rule).
#[napi]
pub fn assert_allowed_egress(url: String) -> Result<()> {
    ryu_sdk::assert_allowed_egress(&url).map_err(|e| Error::from_reason(e.to_string()))
}

// ── Model client ──────────────────────────────────────────────────────────────

/// A chat message (`role` is "system" | "user" | "assistant").
#[napi(object)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// A non-streaming chat completion result.
#[napi(object)]
pub struct ChatResult {
    pub content: String,
    pub finish_reason: Option<String>,
    pub prompt_tokens: Option<i64>,
    pub completion_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

/// A streaming chat delta passed to the `stream` callback.
#[napi(object)]
pub struct ChatDelta {
    pub content: String,
    pub finish_reason: Option<String>,
}

fn to_core_messages(messages: Vec<ChatMessage>) -> Vec<ryu_sdk::ChatMessage> {
    messages
        .into_iter()
        .map(|m| ryu_sdk::ChatMessage { role: m.role, content: m.content })
        .collect()
}

/// A gateway-mandatory model client. Every call routes through the Ryu gateway;
/// direct-provider base URLs are rejected at construction.
#[napi]
pub struct ModelClient {
    inner: ryu_sdk::ModelClient,
}

#[napi]
impl ModelClient {
    /// Create a client for `model`. `baseUrl`/`token` default to
    /// `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN`.
    #[napi(constructor)]
    pub fn new(model: String, base_url: Option<String>, token: Option<String>) -> Result<Self> {
        let inner = ryu_sdk::ModelClient::new(
            model,
            ryu_sdk::ModelClientOptions { base_url, token },
        )
        .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self { inner })
    }

    /// Non-streaming chat completion. Resolves with the full reply.
    #[napi]
    pub async fn chat(&self, messages: Vec<ChatMessage>) -> Result<ChatResult> {
        let inner = self.inner.clone();
        let msgs = to_core_messages(messages);
        let res = inner.chat(&msgs).await.map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(ChatResult {
            content: res.content,
            finish_reason: res.finish_reason,
            prompt_tokens: res.usage.as_ref().map(|u| u.prompt_tokens as i64),
            completion_tokens: res.usage.as_ref().map(|u| u.completion_tokens as i64),
            total_tokens: res.usage.as_ref().map(|u| u.total_tokens as i64),
        })
    }

    /// Streaming chat completion. Invokes `callback(err, delta)` for each SSE
    /// delta, then once more with `delta = null` to signal clean completion;
    /// `err` is set if the stream fails. Returns after dispatch (the stream
    /// drains on the addon's tokio runtime).
    #[napi]
    pub fn stream(
        &self,
        messages: Vec<ChatMessage>,
        callback: ThreadsafeFunction<Option<ChatDelta>>,
    ) -> Result<()> {
        let inner = self.inner.clone();
        let msgs = to_core_messages(messages);
        napi::tokio::spawn(async move {
            let stream = inner.stream(&msgs);
            futures_util::pin_mut!(stream);
            while let Some(item) = stream.next().await {
                match item {
                    Ok(delta) => {
                        let payload = ChatDelta {
                            content: delta.content,
                            finish_reason: delta.finish_reason,
                        };
                        callback.call(Ok(Some(payload)), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                    Err(e) => {
                        callback.call(
                            Err(Error::from_reason(e.to_string())),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                        return;
                    }
                }
            }
            // Clean end-of-stream sentinel.
            callback.call(Ok(None), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(())
    }
}

// ── Embedding client ────────────────────────────────────────────────────────────

/// One embedding vector with its position in the input batch.
#[napi(object)]
pub struct Embedding {
    pub index: u32,
    pub vector: Vec<f64>,
}

/// The result of an embedding request: one vector per input (in input order).
#[napi(object)]
pub struct EmbeddingResult {
    pub embeddings: Vec<Embedding>,
    pub prompt_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

/// A gateway-mandatory embedding client. Every call routes through the Ryu
/// gateway; direct-provider base URLs are rejected at construction.
#[napi]
pub struct EmbeddingClient {
    inner: ryu_sdk::EmbeddingClient,
}

#[napi]
impl EmbeddingClient {
    /// Create an embedding client for `model`. `baseUrl`/`token` default to
    /// `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN`.
    #[napi(constructor)]
    pub fn new(model: String, base_url: Option<String>, token: Option<String>) -> Result<Self> {
        let inner = ryu_sdk::EmbeddingClient::new(
            model,
            ryu_sdk::EmbeddingClientOptions { base_url, token },
        )
        .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(Self { inner })
    }

    /// Embed a batch of texts, resolving with one vector per input (in order).
    #[napi]
    pub async fn embed(&self, inputs: Vec<String>) -> Result<EmbeddingResult> {
        let inner = self.inner.clone();
        let res = inner.embed(&inputs).await.map_err(|e| Error::from_reason(e.to_string()))?;
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
