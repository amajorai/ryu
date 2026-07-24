use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt};
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::{error::ProviderError, quota::ProviderQuotas};

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
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let payload = self.to_anthropic_body(model, body);
            debug!(
                provider = "anthropic",
                model, "sending non-streaming request"
            );

            let url = self.messages_url();
            // Account rotation (#4): rotate keys on a 429 before failing over.
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<ProviderError> = None;
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
                        ProviderError::Provider(format!("Anthropic request failed: {e}"))
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
                    let e = ProviderError::RateLimited {
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
                    ProviderError::Provider(format!("Anthropic response parse error: {e}"))
                })?;

                if !status.is_success() {
                    let msg = json["error"]["message"]
                        .as_str()
                        .unwrap_or("unknown error")
                        .to_string();
                    warn!(provider = "anthropic", status = %status, error = %msg, "provider returned error");
                    return Err(ProviderError::Provider(format!(
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
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: "anthropic".to_string(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = self.to_anthropic_body(model, body);
            payload["stream"] = Value::Bool(true);
            debug!(provider = "anthropic", model, "sending streaming request");

            let url = self.messages_url();
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<ProviderError> = None;
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
                        ProviderError::Provider(format!("Anthropic stream request failed: {e}"))
                    })?;

                let status = resp.status();
                let rate_limit = parse_rate_limit(resp.headers());

                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    let retry_after = rate_limit.as_ref().and_then(|r| r.retry_after);
                    let reset_at = rate_limit.as_ref().and_then(|r| r.reset_at);
                    self.quota
                        .record_rate_limited("anthropic", retry_after, reset_at);
                    let _ = resp.text().await;
                    let e = ProviderError::RateLimited {
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
                    return Err(ProviderError::Provider(format!(
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
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: "anthropic".to_string(),
                retry_after: None,
                reset_at: None,
            }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{MockResponse, MockServer};
    use futures_util::StreamExt;
    use std::sync::Arc;

    fn provider_with(base_url: String, keys: Vec<&str>) -> AnthropicProvider {
        AnthropicProvider::new(
            reqwest::Client::new(),
            keys.into_iter().map(String::from).collect(),
            base_url,
            Arc::new(ProviderQuotas::new()),
        )
    }

    fn dummy() -> AnthropicProvider {
        provider_with("http://127.0.0.1:1".to_string(), vec!["k"])
    }

    #[test]
    fn to_anthropic_body_hoists_system_and_sets_max_tokens_default() {
        let p = dummy();
        let body = json!({
            "messages": [
                { "role": "system", "content": "be terse" },
                { "role": "user", "content": "hi" }
            ]
        });
        let out = p.to_anthropic_body("claude-3", &body);
        assert_eq!(out["model"], json!("claude-3"));
        assert_eq!(out["system"], json!("be terse"));
        // System message is filtered out of the messages array.
        assert_eq!(out["messages"].as_array().unwrap().len(), 1);
        assert_eq!(out["messages"][0]["role"], json!("user"));
        // Anthropic requires max_tokens; default is 4096 when unset.
        assert_eq!(out["max_tokens"], json!(4096));
    }

    #[test]
    fn to_anthropic_body_joins_multiple_system_messages() {
        let p = dummy();
        let body = json!({
            "messages": [
                { "role": "system", "content": "one" },
                { "role": "system", "content": "two" },
                { "role": "user", "content": "hi" }
            ],
            "max_tokens": 100
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(out["system"], json!("one\n\ntwo"));
        assert_eq!(out["max_tokens"], json!(100));
    }

    #[test]
    fn to_anthropic_body_maps_stop_string_and_forwards_sampling() {
        let p = dummy();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "temperature": 0.7,
            "top_p": 0.9,
            "stop": "STOP"
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(out["temperature"], json!(0.7));
        assert_eq!(out["top_p"], json!(0.9));
        // A string `stop` becomes a single-element `stop_sequences` array.
        assert_eq!(out["stop_sequences"], json!(["STOP"]));
        // No system message → no `system` field.
        assert!(out.get("system").is_none());
    }

    #[test]
    fn to_anthropic_body_passes_stop_array_through() {
        let p = dummy();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "stop": ["A", "B"]
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(out["stop_sequences"], json!(["A", "B"]));
    }

    #[test]
    fn from_anthropic_response_maps_content_and_usage_and_stop_reason() {
        let p = dummy();
        let resp = json!({
            "id": "msg_42",
            "content": [{ "type": "text", "text": "hello world" }],
            "stop_reason": "max_tokens",
            "usage": { "input_tokens": 10, "output_tokens": 7 }
        });
        let out = p.from_anthropic_response(&resp, "gpt-4o-alias");
        assert_eq!(out["id"], json!("msg_42"));
        assert_eq!(out["object"], json!("chat.completion"));
        assert_eq!(out["model"], json!("gpt-4o-alias"));
        assert_eq!(out["choices"][0]["message"]["content"], json!("hello world"));
        // max_tokens → OpenAI "length".
        assert_eq!(out["choices"][0]["finish_reason"], json!("length"));
        assert_eq!(out["usage"]["prompt_tokens"], json!(10));
        assert_eq!(out["usage"]["completion_tokens"], json!(7));
        assert_eq!(out["usage"]["total_tokens"], json!(17));
    }

    #[test]
    fn from_anthropic_response_stop_reason_variants() {
        let p = dummy();
        let mk = |reason: &str| {
            json!({ "content": [{ "text": "x" }], "stop_reason": reason,
                    "usage": { "input_tokens": 0, "output_tokens": 0 } })
        };
        assert_eq!(
            p.from_anthropic_response(&mk("end_turn"), "m")["choices"][0]["finish_reason"],
            json!("stop")
        );
        assert_eq!(
            p.from_anthropic_response(&mk("tool_use"), "m")["choices"][0]["finish_reason"],
            json!("tool_calls")
        );
        // Unknown / missing stop_reason defaults to "stop".
        assert_eq!(
            p.from_anthropic_response(&mk("weird"), "m")["choices"][0]["finish_reason"],
            json!("stop")
        );
    }

    #[test]
    fn from_anthropic_response_handles_missing_fields() {
        let p = dummy();
        // Empty response: content missing, usage missing, id missing.
        let out = p.from_anthropic_response(&json!({}), "m");
        assert_eq!(out["id"], json!("msg_unknown"));
        assert_eq!(out["choices"][0]["message"]["content"], json!(""));
        assert_eq!(out["usage"]["total_tokens"], json!(0));
    }

    #[test]
    fn next_key_rotates_round_robin() {
        let p = provider_with("http://x".into(), vec!["a", "b", "c"]);
        // Round-robin across the three keys, then wraps.
        let seq: Vec<String> = (0..4).map(|_| p.next_key()).collect();
        assert_eq!(seq, vec!["a", "b", "c", "a"]);
    }

    #[test]
    fn next_key_single_key_is_stable() {
        let p = provider_with("http://x".into(), vec!["only"]);
        assert_eq!(p.next_key(), "only");
        assert_eq!(p.next_key(), "only");
    }

    async fn collect_stream(
        chunks: Vec<&'static str>,
        model: &str,
    ) -> String {
        let raw = futures_util::stream::iter(
            chunks
                .into_iter()
                .map(|c| Ok::<Bytes, reqwest::Error>(Bytes::from(c)))
                .collect::<Vec<_>>(),
        );
        let translated = translate_anthropic_stream(raw, model.to_string());
        let mut out = String::new();
        futures_util::pin_mut!(translated);
        while let Some(item) = translated.next().await {
            out.push_str(std::str::from_utf8(&item.unwrap()).unwrap());
        }
        out
    }

    #[tokio::test]
    async fn translate_anthropic_stream_emits_openai_deltas_and_done() {
        let sse = concat!(
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n",
        );
        let out = collect_stream(vec![sse], "my-model").await;
        assert!(out.contains(r#""content":"Hel""#), "got: {out}");
        assert!(out.contains(r#""content":"lo""#), "got: {out}");
        assert!(out.contains(r#""object":"chat.completion.chunk""#));
        assert!(out.contains(r#""model":"my-model""#));
        assert!(out.contains(r#""finish_reason":"stop""#));
        assert!(out.contains("data: [DONE]"));
    }

    #[tokio::test]
    async fn translate_anthropic_stream_ignores_unknown_events() {
        let sse = concat!(
            "event: ping\n",
            "data: {\"type\":\"ping\"}\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\"}\n",
        );
        let out = collect_stream(vec![sse], "m").await;
        // No text deltas, no stop → no OpenAI chunks emitted.
        assert!(out.is_empty(), "expected empty, got: {out}");
    }

    #[tokio::test]
    async fn complete_translates_and_sends_anthropic_headers() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"id":"msg_1","content":[{"type":"text","text":"hi there"}],
                "stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":5}}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["sk-secret-KEY"]);
        let body = json!({ "model": "claude-alias", "messages": [{ "role": "user", "content": "hi" }] });
        let out = p.complete("claude-3-5", &body).await.unwrap();

        assert_eq!(out["choices"][0]["message"]["content"], json!("hi there"));
        assert_eq!(out["usage"]["total_tokens"], json!(8));
        // Response is shaped with the caller's *requested* model, not the routed one.
        assert_eq!(out["model"], json!("claude-alias"));

        let reqs = server.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].path, "/v1/messages");
        assert_eq!(reqs[0].header("x-api-key").as_deref(), Some("sk-secret-KEY"));
        assert_eq!(
            reqs[0].header("anthropic-version").as_deref(),
            Some("2023-06-01")
        );
        // The routed model (not the alias) is what goes upstream.
        assert_eq!(reqs[0].json()["model"], json!("claude-3-5"));
    }

    #[tokio::test]
    async fn complete_error_does_not_leak_the_api_key() {
        const SECRET: &str = "sk-ant-DO-NOT-LEAK-0xDEADBEEF";
        let server = MockServer::always(MockResponse::json(
            400,
            r#"{"error":{"message":"invalid request"}}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec![SECRET]);
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        let err = p.complete("m", &body).await.unwrap_err();

        // The key WAS used for auth (constructed correctly)...
        assert_eq!(
            server.requests()[0].header("x-api-key").as_deref(),
            Some(SECRET)
        );
        // ...but it must never appear in the error surfaced to the caller.
        let rendered = format!("{err}{err:?}");
        assert!(!rendered.contains(SECRET), "key leaked in error: {rendered}");
        assert!(rendered.contains("invalid request"));
    }

    #[tokio::test]
    async fn complete_rotates_key_on_429() {
        let server = MockServer::start(vec![
            MockResponse::json(429, "slow down"),
            MockResponse::ok_json(
                r#"{"id":"m","content":[{"text":"ok"}],"stop_reason":"end_turn",
                    "usage":{"input_tokens":1,"output_tokens":1}}"#,
            ),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["key-A", "key-B"]);
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        let out = p.complete("m", &body).await.unwrap();
        assert_eq!(out["choices"][0]["message"]["content"], json!("ok"));

        let reqs = server.requests();
        assert_eq!(reqs.len(), 2, "should have rotated to the second key");
        assert_eq!(reqs[0].header("x-api-key").as_deref(), Some("key-A"));
        assert_eq!(reqs[1].header("x-api-key").as_deref(), Some("key-B"));
    }

    #[tokio::test]
    async fn complete_surfaces_rate_limited_when_all_keys_exhausted() {
        let server = MockServer::always(
            MockResponse::json(429, "nope").with_header("retry-after", "9"),
        )
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["a", "b"]);
        let body = json!({ "messages": [] });
        let err = p.complete("m", &body).await.unwrap_err();
        match err {
            ProviderError::RateLimited {
                provider,
                retry_after,
                ..
            } => {
                assert_eq!(provider, "anthropic");
                assert_eq!(retry_after, Some(9));
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
        // Both keys were tried before giving up.
        assert_eq!(server.request_count(), 2);
    }
}
