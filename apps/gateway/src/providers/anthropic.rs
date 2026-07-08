use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt};
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::{error::GatewayError, quota::ProviderQuotas};

use super::{parse_rate_limit, Provider};

pub struct AnthropicProvider {
    client: reqwest::Client,
    /// Account rotation set (#4). See `OpenAiProvider::keys`.
    keys: Vec<String>,
    cursor: AtomicUsize,
    base_url: String,
    quota: Arc<ProviderQuotas>,
}

impl AnthropicProvider {
    pub fn new(
        client: reqwest::Client,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            client,
            keys,
            cursor: AtomicUsize::new(0),
            base_url,
            quota,
        }
    }

    /// The next account key in round-robin order.
    fn next_key(&self) -> String {
        let n = self.keys.len();
        if n <= 1 {
            return self.keys.first().cloned().unwrap_or_default();
        }
        let i = self.cursor.fetch_add(1, Ordering::Relaxed) % n;
        self.keys[i].clone()
    }

    fn messages_url(&self) -> String {
        format!("{}/v1/messages", self.base_url.trim_end_matches('/'))
    }

    /// Convert an OpenAI-format chat request body into an Anthropic messages body.
    fn to_anthropic_body(&self, model: &str, body: &Value) -> Value {
        let messages = body["messages"].as_array().cloned().unwrap_or_default();

        // Extract system messages and join them (Anthropic has a top-level system field)
        let system_parts: Vec<&str> = messages
            .iter()
            .filter(|m| m["role"].as_str() == Some("system"))
            .filter_map(|m| m["content"].as_str())
            .collect();

        // Non-system messages become the messages array
        let filtered_messages: Vec<Value> = messages
            .iter()
            .filter(|m| m["role"].as_str() != Some("system"))
            .map(|m| {
                // Normalise content: Anthropic accepts a string or content-block array.
                // If the OpenAI message already has a string content, pass it through.
                json!({
                    "role": m["role"],
                    "content": m["content"],
                })
            })
            .collect();

        // Anthropic requires max_tokens; fall back to 4096 if not provided.
        let max_tokens = body["max_tokens"].as_u64().unwrap_or(4096);

        let mut req = json!({
            "model": model,
            "messages": filtered_messages,
            "max_tokens": max_tokens,
        });

        if !system_parts.is_empty() {
            req["system"] = Value::String(system_parts.join("\n\n"));
        }

        // Forward optional parameters
        if let Some(t) = body.get("temperature") {
            req["temperature"] = t.clone();
        }
        if let Some(p) = body.get("top_p") {
            req["top_p"] = p.clone();
        }
        if let Some(s) = body.get("stop") {
            // Anthropic uses "stop_sequences" as an array
            match s {
                Value::String(str_val) => {
                    req["stop_sequences"] = json!([str_val]);
                }
                Value::Array(_) => {
                    req["stop_sequences"] = s.clone();
                }
                _ => {}
            }
        }

        req
    }

    /// Convert an Anthropic messages response into an OpenAI chat completion response.
    fn from_anthropic_response(&self, resp: &Value, requested_model: &str) -> Value {
        let content = resp["content"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|b| b["text"].as_str())
            .unwrap_or_default();

        let stop_reason = match resp["stop_reason"].as_str() {
            Some("end_turn") => "stop",
            Some("max_tokens") => "length",
            Some("tool_use") => "tool_calls",
            _ => "stop",
        };

        let input_tokens = resp["usage"]["input_tokens"].as_u64().unwrap_or(0);
        let output_tokens = resp["usage"]["output_tokens"].as_u64().unwrap_or(0);

        json!({
            "id": resp["id"].as_str().unwrap_or("msg_unknown"),
            "object": "chat.completion",
            "created": chrono::Utc::now().timestamp(),
            "model": requested_model,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                },
                "finish_reason": stop_reason,
                "logprobs": null,
            }],
            "usage": {
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
            }
        })
    }
}

impl Provider for AnthropicProvider {
    fn name(&self) -> &'static str {
        "anthropic"
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let payload = self.to_anthropic_body(model, body);
            debug!(
                provider = "anthropic",
                model, "sending non-streaming request"
            );

            let url = self.messages_url();
            // Account rotation (#4): rotate keys on a 429 before failing over.
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<GatewayError> = None;
            for _ in 0..attempts {
                let key = self.next_key();
                let resp = self
                    .client
                    .post(&url)
                    .header("x-api-key", &key)
                    .header("anthropic-version", "2023-06-01")
                    .json(&payload)
                    .send()
                    .await
                    .map_err(|e| {
                        GatewayError::ProviderError(format!("Anthropic request failed: {e}"))
                    })?;

                let status = resp.status();
                let rate_limit = parse_rate_limit(resp.headers());

                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    let retry_after = rate_limit.as_ref().and_then(|r| r.retry_after);
                    let reset_at = rate_limit.as_ref().and_then(|r| r.reset_at);
                    self.quota
                        .record_rate_limited("anthropic", retry_after, reset_at);
                    let _ = resp.text().await;
                    warn!(provider = "anthropic", "provider rate limited (429)");
                    let e = GatewayError::ProviderRateLimited {
                        provider: "anthropic".to_string(),
                        retry_after,
                        reset_at,
                    };
                    if attempts > 1 {
                        last_err = Some(e);
                        continue;
                    }
                    return Err(e);
                }

                let json: Value = resp.json().await.map_err(|e| {
                    GatewayError::ProviderError(format!("Anthropic response parse error: {e}"))
                })?;

                if !status.is_success() {
                    let msg = json["error"]["message"]
                        .as_str()
                        .unwrap_or("unknown error")
                        .to_string();
                    warn!(provider = "anthropic", status = %status, error = %msg, "provider returned error");
                    return Err(GatewayError::ProviderError(format!(
                        "Anthropic error {status}: {msg}"
                    )));
                }

                if let Some(info) = rate_limit.as_ref() {
                    self.quota.record_success("anthropic", info);
                }

                // Requested model (before routing) for response shaping
                let requested_model = body["model"].as_str().unwrap_or(model);
                return Ok(self.from_anthropic_response(&json, requested_model));
            }
            Err(
                last_err.unwrap_or_else(|| GatewayError::ProviderRateLimited {
                    provider: "anthropic".to_string(),
                    retry_after: None,
                    reset_at: None,
                }),
            )
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = self.to_anthropic_body(model, body);
            payload["stream"] = Value::Bool(true);
            debug!(provider = "anthropic", model, "sending streaming request");

            let url = self.messages_url();
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<GatewayError> = None;
            for _ in 0..attempts {
                let key = self.next_key();
                let resp = self
                    .client
                    .post(&url)
                    .header("x-api-key", &key)
                    .header("anthropic-version", "2023-06-01")
                    .json(&payload)
                    .send()
                    .await
                    .map_err(|e| {
                        GatewayError::ProviderError(format!("Anthropic stream request failed: {e}"))
                    })?;

                let status = resp.status();
                let rate_limit = parse_rate_limit(resp.headers());

                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    let retry_after = rate_limit.as_ref().and_then(|r| r.retry_after);
                    let reset_at = rate_limit.as_ref().and_then(|r| r.reset_at);
                    self.quota
                        .record_rate_limited("anthropic", retry_after, reset_at);
                    let _ = resp.text().await;
                    let e = GatewayError::ProviderRateLimited {
                        provider: "anthropic".to_string(),
                        retry_after,
                        reset_at,
                    };
                    if attempts > 1 {
                        last_err = Some(e);
                        continue;
                    }
                    return Err(e);
                }

                if !status.is_success() {
                    let text = resp.text().await.unwrap_or_default();
                    return Err(GatewayError::ProviderError(format!(
                        "Anthropic stream error {status}: {text}"
                    )));
                }

                if let Some(info) = rate_limit.as_ref() {
                    self.quota.record_success("anthropic", info);
                }

                let requested_model = body["model"].as_str().unwrap_or(model).to_string();

                // Translate Anthropic SSE events → OpenAI SSE events on the fly.
                let raw_stream = resp.bytes_stream();
                let translated = translate_anthropic_stream(raw_stream, requested_model);
                return Ok(Body::from_stream(translated));
            }
            Err(
                last_err.unwrap_or_else(|| GatewayError::ProviderRateLimited {
                    provider: "anthropic".to_string(),
                    retry_after: None,
                    reset_at: None,
                }),
            )
        })
    }
}

/// Translate an Anthropic streaming SSE response into OpenAI-compatible SSE chunks.
///
/// Anthropic events look like:
///   event: content_block_delta
///   data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}
///
/// We emit OpenAI-style:
///   data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"hello"},"index":0}]}
///   data: [DONE]
fn translate_anthropic_stream(
    raw: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
    model: String,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    use futures_util::stream;

    let completion_id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = chrono::Utc::now().timestamp();

    let mut last_event_type = String::new();
    let cid = completion_id.clone();

    raw.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        .flat_map(move |chunk_result| {
            let cid = cid.clone();
            let model = model.clone();

            match chunk_result {
                Err(e) => stream::iter(vec![Err(e)]).left_stream(),
                Ok(chunk) => {
                    let text = match std::str::from_utf8(&chunk) {
                        Ok(t) => t.to_string(),
                        Err(_) => return stream::iter(vec![]).left_stream(),
                    };

                    let mut output: Vec<Result<Bytes, std::io::Error>> = Vec::new();

                    for line in text.lines() {
                        if line.starts_with("event: ") {
                            last_event_type = line[7..].trim().to_string();
                        } else if line.starts_with("data: ") {
                            let data = &line[6..];

                            match last_event_type.as_str() {
                                "content_block_delta" => {
                                    if let Ok(v) = serde_json::from_str::<Value>(data) {
                                        if let Some(text) = v["delta"]["text"].as_str() {
                                            let oai_chunk = serde_json::json!({
                                                "id": cid,
                                                "object": "chat.completion.chunk",
                                                "created": created,
                                                "model": model,
                                                "choices": [{
                                                    "index": 0,
                                                    "delta": {"content": text},
                                                    "finish_reason": null,
                                                }]
                                            });
                                            if let Ok(json_str) = serde_json::to_string(&oai_chunk)
                                            {
                                                let line = format!("data: {json_str}\n\n");
                                                output.push(Ok(Bytes::from(line)));
                                            }
                                        }
                                    }
                                }
                                "message_stop" | "message_delta" => {
                                    let stop_chunk = serde_json::json!({
                                        "id": cid,
                                        "object": "chat.completion.chunk",
                                        "created": created,
                                        "model": model,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {},
                                            "finish_reason": "stop",
                                        }]
                                    });
                                    if let Ok(json_str) = serde_json::to_string(&stop_chunk) {
                                        let line = format!("data: {json_str}\n\ndata: [DONE]\n\n");
                                        output.push(Ok(Bytes::from(line)));
                                    }
                                }
                                _ => {}
                            }
                        }
                    }

                    stream::iter(output).right_stream()
                }
            }
        })
}
