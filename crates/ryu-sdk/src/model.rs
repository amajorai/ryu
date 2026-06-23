//! Gateway-mandatory model client — the transport every binding shares.
//!
//! Ports `packages/sdk/src/model/client.ts`. All calls POST to
//! `{base}/v1/chat/completions` on the Ryu gateway; the client never contacts a
//! provider directly. The unary path mirrors the OpenAI-compat response; the
//! streaming path hand-parses OpenAI-compat server-sent events (codegen does not
//! produce usable SSE methods, so this stays hand-written regardless of the
//! `codegen` feature).

use async_stream::try_stream;
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

use crate::gateway::{
    assert_allowed_egress, resolve_gateway_token, resolve_gateway_url, EgressNotAllowed,
};

/// A single message in a chat conversation (OpenAI-compat subset).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// The speaker: `"system"`, `"user"`, or `"assistant"`.
    pub role: String,
    /// The message text.
    pub content: String,
}

impl ChatMessage {
    /// Convenience constructor for a `system` message.
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: "system".into(), content: content.into() }
    }
    /// Convenience constructor for a `user` message.
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: "user".into(), content: content.into() }
    }
    /// Convenience constructor for an `assistant` message.
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: content.into() }
    }
}

/// A streaming chat completion delta.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatDelta {
    /// Incremental text fragment (may be empty on role-only chunks).
    pub content: String,
    /// Non-null on the final chunk when `finish_reason` is set.
    pub finish_reason: Option<String>,
}

/// Token usage as reported by the gateway.
#[derive(Debug, Clone, PartialEq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

/// Non-streaming chat completion result.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatResult {
    /// The full assistant reply text.
    pub content: String,
    /// The gateway/model-reported finish reason.
    pub finish_reason: Option<String>,
    /// Usage stats when the gateway reports them.
    pub usage: Option<Usage>,
}

/// Errors a [`ModelClient`] can surface.
#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    /// The configured base URL points at a blocked direct provider.
    #[error(transparent)]
    Egress(#[from] EgressNotAllowed),
    /// Network/transport failure talking to the gateway.
    #[error("[ryu-sdk] gateway request failed: {0}")]
    Transport(#[from] reqwest::Error),
    /// The gateway returned a non-2xx status.
    #[error("[ryu-sdk] gateway returned HTTP {status} from {url}: {body}")]
    Http { status: u16, url: String, body: String },
}

/// Options for [`ModelClient::new`].
#[derive(Debug, Default, Clone)]
pub struct ModelClientOptions {
    /// Gateway base URL (no trailing `/v1`). Defaults to `RYU_GATEWAY_URL` then
    /// [`crate::gateway::DEFAULT_GATEWAY_URL`]. Direct provider URLs are rejected.
    pub base_url: Option<String>,
    /// Bearer token forwarded as `Authorization: Bearer <token>`. Defaults to
    /// `RYU_GATEWAY_TOKEN`.
    pub token: Option<String>,
}

/// A gateway-mandatory model client.
#[derive(Debug, Clone)]
pub struct ModelClient {
    model: String,
    base_url: String,
    token: Option<String>,
    http: reqwest::Client,
}

// ── Wire types (deserialised from the gateway) ────────────────────────────────

#[derive(Deserialize)]
struct UnaryResponse {
    choices: Option<Vec<UnaryChoice>>,
    usage: Option<WireUsage>,
}
#[derive(Deserialize)]
struct UnaryChoice {
    message: Option<WireMessage>,
    finish_reason: Option<String>,
}
#[derive(Deserialize)]
struct WireMessage {
    content: Option<String>,
}
#[derive(Deserialize)]
struct WireUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}
#[derive(Deserialize)]
struct StreamChunk {
    choices: Option<Vec<StreamChoice>>,
}
#[derive(Deserialize)]
struct StreamChoice {
    delta: Option<StreamDelta>,
    finish_reason: Option<String>,
}
#[derive(Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

impl ModelClient {
    /// Construct a client for `model`. Rejects a direct-provider `base_url` at
    /// construction time (egress enforcement).
    pub fn new(model: impl Into<String>, options: ModelClientOptions) -> Result<Self, ModelError> {
        let base = options.base_url.unwrap_or_else(resolve_gateway_url);
        assert_allowed_egress(&base)?;
        Ok(Self {
            model: model.into(),
            base_url: base.trim_end_matches('/').to_string(),
            token: options.token.or_else(resolve_gateway_token),
            http: reqwest::Client::new(),
        })
    }

    /// The model id this client targets.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// The resolved gateway base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn completions_url(&self) -> String {
        format!("{}/v1/chat/completions", self.base_url)
    }

    fn request(&self, messages: &[ChatMessage], stream: bool) -> reqwest::RequestBuilder {
        let body = serde_json::json!({
            "model": self.model,
            "messages": messages,
            "stream": stream,
        });
        let mut req = self.http.post(self.completions_url()).json(&body);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }
        req
    }

    /// Send a non-streaming chat completion request to the gateway.
    pub async fn chat(&self, messages: &[ChatMessage]) -> Result<ChatResult, ModelError> {
        let url = self.completions_url();
        let resp = self.request(messages, false).send().await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ModelError::Http { status, url, body });
        }
        let parsed: UnaryResponse = resp.json().await?;
        let choice = parsed.choices.and_then(|mut c| if c.is_empty() { None } else { Some(c.remove(0)) });
        let (content, finish_reason) = match choice {
            Some(c) => (
                c.message.and_then(|m| m.content).unwrap_or_default(),
                c.finish_reason,
            ),
            None => (String::new(), None),
        };
        Ok(ChatResult {
            content,
            finish_reason,
            usage: parsed.usage.map(|u| Usage {
                prompt_tokens: u.prompt_tokens.unwrap_or(0),
                completion_tokens: u.completion_tokens.unwrap_or(0),
                total_tokens: u.total_tokens.unwrap_or(0),
            }),
        })
    }

    /// Send a streaming chat completion request, yielding [`ChatDelta`] items as
    /// the gateway's OpenAI-compat SSE frames arrive.
    pub fn stream<'a>(
        &'a self,
        messages: &'a [ChatMessage],
    ) -> impl Stream<Item = Result<ChatDelta, ModelError>> + 'a {
        let url = self.completions_url();
        try_stream! {
            let resp = self.request(messages, true).send().await?;
            let status = resp.status();
            if status.is_success() {
                let mut bytes = resp.bytes_stream();
                // Accumulate raw bytes; SSE frames are newline-delimited and each
                // `data:` line carries a complete UTF-8 JSON payload, so we only
                // decode once a line is complete (avoids splitting multi-byte chars).
                let mut buf: Vec<u8> = Vec::new();
                while let Some(chunk) = bytes.next().await {
                    buf.extend_from_slice(&chunk?);
                    while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = buf.drain(..=nl).collect();
                        let line = String::from_utf8_lossy(&line);
                        match parse_sse_line(&line) {
                            SseLine::Done => return,
                            SseLine::Delta(delta) => yield delta,
                            SseLine::Skip => {}
                        }
                    }
                }
            } else {
                let body = resp.text().await.unwrap_or_default();
                Err(ModelError::Http { status: status.as_u16(), url, body })?;
            }
        }
    }
}

enum SseLine {
    Delta(ChatDelta),
    Done,
    Skip,
}

/// Parse a single SSE line into a delta, the terminator, or a skip.
fn parse_sse_line(line: &str) -> SseLine {
    let trimmed = line.trim();
    let Some(payload) = trimmed.strip_prefix("data:") else {
        return SseLine::Skip;
    };
    let payload = payload.trim();
    if payload == "[DONE]" {
        return SseLine::Done;
    }
    let Ok(chunk) = serde_json::from_str::<StreamChunk>(payload) else {
        return SseLine::Skip;
    };
    let Some(choice) = chunk.choices.and_then(|mut c| if c.is_empty() { None } else { Some(c.remove(0)) })
    else {
        return SseLine::Skip;
    };
    SseLine::Delta(ChatDelta {
        content: choice.delta.and_then(|d| d.content).unwrap_or_default(),
        finish_reason: choice.finish_reason,
    })
}

/// Convenience constructor mirroring the TS `defineModel(id, opts)` factory.
pub fn define_model(model: impl Into<String>, options: ModelClientOptions) -> Result<ModelClient, ModelError> {
    ModelClient::new(model, options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_direct_provider_base_url() {
        let err = ModelClient::new(
            "gpt-4o",
            ModelClientOptions { base_url: Some("https://api.openai.com".into()), token: None },
        )
        .unwrap_err();
        assert!(matches!(err, ModelError::Egress(_)));
    }

    #[test]
    fn defaults_to_gateway_and_strips_trailing_slash() {
        let c = ModelClient::new(
            "gemma4",
            ModelClientOptions { base_url: Some("http://127.0.0.1:7981/".into()), token: None },
        )
        .unwrap();
        assert_eq!(c.base_url(), "http://127.0.0.1:7981");
        assert_eq!(c.completions_url(), "http://127.0.0.1:7981/v1/chat/completions");
    }

    #[test]
    fn parses_sse_lines() {
        assert!(matches!(parse_sse_line(": comment"), SseLine::Skip));
        assert!(matches!(parse_sse_line("data: [DONE]"), SseLine::Done));
        match parse_sse_line(r#"data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}"#) {
            SseLine::Delta(d) => {
                assert_eq!(d.content, "hi");
                assert!(d.finish_reason.is_none());
            }
            _ => panic!("expected delta"),
        }
    }
}
