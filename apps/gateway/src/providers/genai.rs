use std::collections::HashMap;
use std::pin::Pin;

use axum::body::Body;
use bytes::Bytes;
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use tracing::debug;

// External `genai` crate (disambiguated with a leading `::` so it is never
// confused with this `crate::providers::genai` module).
use ::genai::chat::{ChatMessage, ChatOptions, ChatRequest, ChatResponse, ChatStreamEvent, StreamChunk};
use ::genai::resolver::{AuthData, AuthResolver};
use ::genai::{Client, ModelIden};

use crate::error::GatewayError;

use super::Provider;

/// Multi-provider backend powered by the `genai` crate.
///
/// This provider exists to cover the *native-format* providers the gateway does
/// not implement by hand (primarily Gemini). The OpenAI-compatible ecosystem is
/// already handled cheaply by byte-passthrough providers (OpenAI, OpenRouter),
/// so `genai` is scoped to the long tail of native protocols where writing a
/// translator by hand (as `anthropic.rs` does) would be repetitive.
///
/// Like every other provider it speaks the gateway's OpenAI-compatible boundary
/// contract: OpenAI-shaped JSON in, OpenAI-shaped JSON (or OpenAI SSE) out. The
/// translation to and from `genai`'s native types happens entirely inside here.
pub struct GenAiProvider {
    client: Client,
}

impl GenAiProvider {
    /// Build a client whose per-provider API keys come from the gateway config
    /// rather than environment variables.
    ///
    /// `keys` is keyed by the lowercase `genai` adapter kind (e.g. `"gemini"`,
    /// `"groq"`, `"xai"`, `"deepseek"`, `"cohere"`). When a request resolves to
    /// an adapter that has no configured key, the resolver returns `None` and
    /// `genai` falls back to its own default (env-var) auth for that provider.
    pub fn new(keys: HashMap<String, String>) -> Self {
        let auth_resolver = AuthResolver::from_resolver_fn(
            move |model_iden: ModelIden| -> Result<Option<AuthData>, ::genai::resolver::Error> {
                let kind = model_iden.adapter_kind.as_lower_str();
                Ok(keys.get(kind).map(|k| AuthData::from_single(k.clone())))
            },
        );

        let client = Client::builder().with_auth_resolver(auth_resolver).build();

        Self { client }
    }
}

impl Provider for GenAiProvider {
    fn name(&self) -> &'static str {
        "genai"
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let chat_req = ChatRequest::new(parse_messages(body));
            let opts = build_options(body, false);
            debug!(provider = "genai", model, "sending non-streaming request");

            let res = self
                .client
                .exec_chat(model, chat_req, Some(&opts))
                .await
                .map_err(|e| GatewayError::ProviderError(format!("genai request failed: {e}")))?;

            let requested_model = body["model"].as_str().unwrap_or(model);
            Ok(to_openai_response(res, requested_model))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let chat_req = ChatRequest::new(parse_messages(body));
            let opts = build_options(body, true);
            debug!(provider = "genai", model, "sending streaming request");

            let res = self
                .client
                .exec_chat_stream(model, chat_req, Some(&opts))
                .await
                .map_err(|e| {
                    GatewayError::ProviderError(format!("genai stream request failed: {e}"))
                })?;

            let requested_model = body["model"].as_str().unwrap_or(model).to_string();
            let translated = translate_genai_stream(res.stream, requested_model);
            Ok(Body::from_stream(translated))
        })
    }
}

/// Convert an OpenAI-format `messages` array into `genai` chat messages.
///
/// `genai` accepts `system` as an ordinary message in the sequence, so system
/// prompts are mapped 1:1 rather than hoisted into a separate field (unlike the
/// Anthropic translator). Tool messages are folded into `user` since this
/// provider does not surface tool calling.
fn parse_messages(body: &Value) -> Vec<ChatMessage> {
    let mut out = Vec::new();
    let Some(arr) = body["messages"].as_array() else {
        return out;
    };

    for m in arr {
        let role = m["role"].as_str().unwrap_or("user");
        let content = extract_text(&m["content"]);
        let msg = match role {
            "system" => ChatMessage::system(content),
            "assistant" => ChatMessage::assistant(content),
            // "tool" and anything unexpected fall back to a user turn.
            _ => ChatMessage::user(content),
        };
        out.push(msg);
    }

    out
}

/// Extract plain text from an OpenAI message `content`, which is either a string
/// or an array of content parts (`{"type":"text","text":"..."}`).
fn extract_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Map OpenAI sampling parameters onto `genai` `ChatOptions`. When `capture_usage`
/// is set (streaming), token usage is captured so it can be surfaced at stream end.
fn build_options(body: &Value, capture_usage: bool) -> ChatOptions {
    let mut opts = ChatOptions::default();

    if let Some(t) = body.get("temperature").and_then(Value::as_f64) {
        opts = opts.with_temperature(t);
    }
    if let Some(m) = body.get("max_tokens").and_then(Value::as_u64) {
        opts = opts.with_max_tokens(m as u32);
    }
    if let Some(p) = body.get("top_p").and_then(Value::as_f64) {
        opts = opts.with_top_p(p);
    }
    match body.get("stop") {
        Some(Value::String(s)) => {
            opts = opts.with_stop_sequence(s.clone());
        }
        Some(Value::Array(arr)) => {
            let seqs: Vec<String> = arr
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            if !seqs.is_empty() {
                opts = opts.with_stop_sequences(seqs);
            }
        }
        _ => {}
    }
    if capture_usage {
        opts = opts.with_capture_usage(true);
    }

    opts
}

/// Convert a `genai` `ChatResponse` into an OpenAI chat-completion response.
fn to_openai_response(res: ChatResponse, requested_model: &str) -> Value {
    let content = res.first_text().unwrap_or_default().to_string();
    let prompt = res.usage.prompt_tokens.unwrap_or(0);
    let completion = res.usage.completion_tokens.unwrap_or(0);
    let total = res.usage.total_tokens.unwrap_or(prompt + completion);

    json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
        "object": "chat.completion",
        "created": chrono::Utc::now().timestamp(),
        "model": requested_model,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": content,
            },
            "finish_reason": "stop",
            "logprobs": null,
        }],
        "usage": {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total,
        }
    })
}

/// Translate a `genai` event stream into OpenAI-compatible SSE chunks.
///
/// `genai` yields typed `ChatStreamEvent`s; we emit `chat.completion.chunk`
/// frames terminated by `data: [DONE]`, matching what the OpenAI streaming API
/// (and therefore every client of this gateway) expects.
fn translate_genai_stream(
    stream: ::genai::chat::ChatStream,
    model: String,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = chrono::Utc::now().timestamp();

    stream.flat_map(move |event| {
        let id = id.clone();
        let model = model.clone();
        let mut output: Vec<Result<Bytes, std::io::Error>> = Vec::new();

        match event {
            Ok(ChatStreamEvent::Chunk(StreamChunk { content })) => {
                let chunk = json!({
                    "id": id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"content": content},
                        "finish_reason": null,
                    }]
                });
                if let Ok(s) = serde_json::to_string(&chunk) {
                    output.push(Ok(Bytes::from(format!("data: {s}\n\n"))));
                }
            }
            Ok(ChatStreamEvent::End(_)) => {
                let stop = json!({
                    "id": id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }]
                });
                if let Ok(s) = serde_json::to_string(&stop) {
                    output.push(Ok(Bytes::from(format!("data: {s}\n\ndata: [DONE]\n\n"))));
                }
            }
            // Start / ReasoningChunk / ThoughtSignatureChunk / ToolCallChunk:
            // not represented in the OpenAI text-completion stream, so skipped.
            Ok(_) => {}
            Err(e) => {
                output.push(Err(std::io::Error::new(std::io::ErrorKind::Other, e)));
            }
        }

        stream::iter(output)
    })
}
