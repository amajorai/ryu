use crate::response_body::BoundedResponse;
use std::pin::Pin;
use std::sync::Arc;

use axum::body::Body;
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt};
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::{error::ProviderError, quota::ProviderQuotas};

use super::{
    account_pool::AccountPool, classify_send_error, error_body_message, parse_account_quota,
    parse_quota_domain, parse_rate_limit, streaming_request, upstream_error_with_key_refusal,
    EgressClientPool, Provider,
};

pub struct AnthropicProvider {
    provider_id: &'static str,
    client: reqwest::Client,
    egress: Option<Arc<EgressClientPool>>,
    /// Account rotation set (#4). See `OpenAiProvider::keys`.
    keys: Vec<String>,
    account_pool: AccountPool,
    base_url: String,
    quota: Arc<ProviderQuotas>,
    /// Top-level fields written over every converted body, after the
    /// allowlist. Empty for every Anthropic slot; the Vercel lane uses it to
    /// send its zero data retention option on the Messages leg.
    extra_body: serde_json::Map<String, Value>,
}

impl AnthropicProvider {
    pub fn new(
        client: reqwest::Client,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::new_with_egress(client, None, keys, base_url, quota)
    }

    pub fn new_with_egress(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::new_named_with_egress("anthropic", client, egress, keys, base_url, quota)
    }

    pub fn new_named_with_egress(
        provider_id: &'static str,
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            provider_id,
            client,
            egress,
            account_pool: AccountPool::new(keys.len()),
            keys,
            base_url,
            quota,
            extra_body: serde_json::Map::new(),
        }
    }

    /// Write these top-level fields over every converted body. Caller fields
    /// never reach this map: the body conversion is an allowlist.
    pub fn with_extra_body(mut self, extra: serde_json::Map<String, Value>) -> Self {
        self.extra_body = extra;
        self
    }

    /// The next account key in round-robin order.
    #[cfg(test)]
    fn next_key(&self) -> String {
        self.account_pool
            .candidates(None)
            .first()
            .and_then(|index| self.keys.get(*index))
            .cloned()
            .unwrap_or_default()
    }

    fn messages_url(&self) -> String {
        format!("{}/v1/messages", self.base_url.trim_end_matches('/'))
    }

    /// A `POST /v1/messages` builder carrying the auth and version headers every
    /// Anthropic call needs, plus an `anthropic-beta` header that unions whatever
    /// the caller asked for (`caller_beta`) with the extended-cache-TTL beta when
    /// — and only when — the payload actually asks for a non-default
    /// `cache_control.ttl`. When neither applies no beta header is sent at all.
    fn anthropic_post(
        &self,
        client: &reqwest::Client,
        url: &str,
        key: &str,
        payload: &Value,
        caller_beta: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let mut req = client
            .post(url)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01");
        if let Some(beta) = anthropic_beta_header(caller_beta, wants_extended_cache_ttl(payload)) {
            req = req.header("anthropic-beta", beta);
        }
        req.json(payload)
    }

    async fn send_request(
        &self,
        session: Option<&str>,
        context: &str,
        make_request: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ProviderError> {
        let (index, client) = if let Some(pool) = &self.egress {
            let (index, client) = pool.candidates(session).into_iter().next().ok_or_else(|| {
                ProviderError::Transport(
                    "all configured egress endpoints are cooling down".to_owned(),
                )
            })?;
            (Some(index), client)
        } else {
            (None, &self.client)
        };
        let result = crate::trace_context::apply(make_request(client))
            .send()
            .await
            .map_err(|error| classify_send_error(context, &error));
        if let Ok(response) = &result {
            crate::trace_context::observe_status(response.status());
        }
        if let (Some(pool), Some(index)) = (&self.egress, index) {
            match &result {
                Ok(response)
                    if response.status() == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED =>
                {
                    pool.record_failure(index, Some(300));
                    return Err(ProviderError::Transport(
                        "configured egress proxy authentication failed".to_owned(),
                    ));
                }
                Ok(_) => pool.record_success(session, index),
                // An uncertain delivery cools the proxy without rotating or
                // replaying the request.
                Err(ProviderError::Transport(_) | ProviderError::DeliveryUncertain(_)) => {
                    pool.record_failure(index, None)
                }
                Err(_) => {}
            }
        }
        result
    }

    /// Convert an OpenAI-format chat request body into an Anthropic messages body.
    ///
    /// This is an allowlist, not a passthrough: only the keys named below reach
    /// Anthropic. That is what keeps the private `ryu_anthropic_beta` field (see
    /// [`anthropic_beta_header`]) off the wire — it is read by the callers of
    /// `to_anthropic_body` for the header and never copied into the payload.
    ///
    /// The same holds for the private `ryu_upstream_subject` field: the Gateway
    /// sets it on hosted attempts, and only its value is sent, as
    /// `metadata.user_id`. A caller's own `metadata` is never copied.
    fn to_anthropic_body(&self, model: &str, body: &Value) -> Value {
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        let mut filtered_messages = anthropic_messages(&messages);

        // Accept Chat Completions' current token limit while keeping the legacy
        // key for existing clients. Anthropic still calls its wire field max_tokens.
        let max_tokens = body
            .get("max_completion_tokens")
            .or_else(|| body.get("max_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(4096);

        let mut req = json!({
            "model": model,
            "messages": filtered_messages,
            "max_tokens": max_tokens,
        });

        // System messages hoist to Anthropic's top-level `system` field.
        if let Some(system) = system_field(&messages) {
            req["system"] = system;
        }

        if let Some(subject) = body
            .get(UPSTREAM_SUBJECT_FIELD)
            .and_then(Value::as_str)
            .filter(|subject| !subject.is_empty())
        {
            req["metadata"] = json!({ "user_id": subject });
        }

        // Forward optional parameters
        if let Some(t) = body.get("temperature") {
            req["temperature"] = t.clone();
        }
        if let Some(p) = body.get("top_p") {
            req["top_p"] = p.clone();
        }
        // Native Anthropic sampler; reaches the body from the gateway's
        // `ryu_sampling` translation or a caller that sent it directly.
        if let Some(k) = body.get("top_k").filter(|k| k.is_u64()) {
            req["top_k"] = k.clone();
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

        // Tool calling. Both keys are omitted entirely when the caller named no
        // tools, so an ordinary chat request keeps exactly the payload it had
        // before tool support existed. `tool_choice` is gated on `tools` for the
        // same reason: Anthropic rejects a choice that selects from nothing, and
        // an agent framework that disables tools mid-loop by emptying the array
        // (or that merely sets `parallel_tool_calls`) would otherwise ship a key
        // this adapter never used to send.
        if let Some(tools) = anthropic_tools(body) {
            req["tools"] = tools;
            if let Some(choice) = anthropic_tool_choice(body) {
                req["tool_choice"] = choice;
            }
        }

        // The prompt-cache policy's Auto mode marks the request, not a block.
        // The allowlist above never copies that root key, so on the direct path
        // Claude used to get no breakpoint at all and every turn re-sent the
        // prompt uncached. Place it where automatic caching would: on the last
        // cacheable block, caching the whole prefix.
        if let Some(cache_control) = body.get("cache_control").filter(|c| c.is_object()) {
            if !contains_cache_control(&req) {
                place_request_cache_breakpoint(&mut filtered_messages, cache_control);
                req["messages"] = Value::Array(filtered_messages);
            }
        }

        for (key, value) in &self.extra_body {
            req[key.as_str()] = value.clone();
        }

        req
    }

    /// Convert an Anthropic messages response into an OpenAI chat completion response.
    fn from_anthropic_response(&self, resp: &Value, requested_model: &str) -> Value {
        let blocks = resp["content"].as_array().cloned().unwrap_or_default();
        let mut text = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        // Whether the response carries any block this OpenAI projection cannot
        // represent (`server_tool_use`, the code-execution results, `thinking`, …).
        let mut has_exotic_blocks = false;
        for b in &blocks {
            match b["type"].as_str() {
                Some("tool_use") => tool_calls.push(json!({
                    "id": b["id"],
                    "type": "function",
                    "function": {
                        "name": b["name"],
                        // OpenAI carries arguments as a JSON-encoded *string*.
                        "arguments": encode_tool_arguments(&b["input"]),
                    },
                })),
                // `None` covers the type-less `{"text": …}` blocks older callers
                // and fixtures send; it must not count as exotic, or an ordinary
                // response would grow a `ryu_content_blocks` key.
                Some("text") | None => {
                    if let Some(t) = b["text"].as_str() {
                        text.push_str(t);
                    }
                }
                _ => has_exotic_blocks = true,
            }
        }

        let stop_reason = map_stop_reason(resp["stop_reason"].as_str());

        let cache = CacheUsage::from_anthropic(&resp["usage"]);
        // Anthropic reports `input_tokens` *excluding* whatever it served from or
        // wrote to the prompt cache, while OpenAI's `prompt_tokens` includes it.
        // Add the cache legs back so downstream token accounting (and any cost
        // model keyed on `prompt_tokens`) sees the true prompt size.
        //
        // This correction belongs to the NATIVE Anthropic `/v1/messages` shape
        // only. Do not mirror it onto the OpenAI-compatible path (OpenRouter):
        // there `prompt_tokens` already includes `cached_tokens`, so adding them
        // again would double-count the prompt.
        let input_tokens = resp["usage"]["input_tokens"].as_u64().unwrap_or(0) + cache.total();
        let output_tokens = resp["usage"]["output_tokens"].as_u64().unwrap_or(0);

        // OpenAI convention: a message that is *only* tool calls carries a null
        // content, not an empty string.
        let content = if text.is_empty() && !tool_calls.is_empty() {
            Value::Null
        } else {
            Value::String(text)
        };

        let mut out = json!({
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
        });
        if !tool_calls.is_empty() {
            out["choices"][0]["message"]["tool_calls"] = Value::Array(tool_calls);
        }
        if has_exotic_blocks {
            // Nothing in the OpenAI shape can hold a code-execution result or a
            // thinking block, so hand the caller the original array verbatim
            // rather than dropping it. Attached only when one is actually
            // present, so ordinary responses keep their historical wire shape.
            out["choices"][0]["message"]["ryu_content_blocks"] = resp["content"].clone();
        }
        // Server-tool call counts are how Anthropic bills web search / code
        // execution; they have no OpenAI equivalent, so copy them across as-is.
        if let Some(server) = resp["usage"].get("server_tool_use") {
            out["usage"]["server_tool_use"] = server.clone();
        }
        cache.merge_into_usage(&mut out["usage"]);
        out
    }
}

/// Prompt-cache read/write token counts lifted off a provider `usage` block.
///
/// Anthropic names these `cache_read_input_tokens` / `cache_creation_input_tokens`;
/// the OpenAI-compatible shape (what OpenRouter and this gateway's own pipeline
/// read) names them `prompt_tokens_details.{cached_tokens,cache_write_tokens}`.
/// This carries the pair between the two vocabularies.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CacheUsage {
    /// Prompt tokens served from the provider's cache (a cache *read*).
    pub read: u64,
    /// Prompt tokens written into the provider's cache (a cache *write* — billed
    /// above the normal input rate, which is why it is reported separately).
    pub write: u64,
    /// The part of `write` written with the one-hour TTL
    /// (`cache_creation.ephemeral_1h_input_tokens`), billed at a higher rate
    /// than a default five-minute write.
    pub write_1h: u64,
}

impl CacheUsage {
    /// Read the Anthropic-native field names off a `usage` object.
    pub(crate) fn from_anthropic(usage: &Value) -> Self {
        let write = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
        Self {
            read: usage["cache_read_input_tokens"].as_u64().unwrap_or(0),
            write,
            write_1h: usage["cache_creation"]["ephemeral_1h_input_tokens"]
                .as_u64()
                .unwrap_or(0)
                .min(write),
        }
    }

    pub(crate) fn total(self) -> u64 {
        self.read + self.write
    }

    pub(crate) fn is_zero(self) -> bool {
        self.total() == 0
    }

    /// Stamp both vocabularies onto an OpenAI-shaped `usage` object. A no-op when
    /// the provider reported no caching, so a non-caching response keeps exactly
    /// the wire shape it had before prompt-cache support existed.
    pub(crate) fn merge_into_usage(self, usage: &mut Value) {
        if self.is_zero() {
            return;
        }
        usage["prompt_tokens_details"] = json!({
            "cached_tokens": self.read,
            "cache_write_tokens": self.write,
        });
        // Native names too, so an Anthropic-aware caller reading through the
        // gateway sees the same fields it would get talking to Anthropic direct.
        usage["cache_read_input_tokens"] = json!(self.read);
        usage["cache_creation_input_tokens"] = json!(self.write);
        // One-hour writes cost more than five-minute ones, so the split travels
        // with the usage (only when present, keeping the default-TTL shape).
        if self.write_1h > 0 {
            usage["prompt_tokens_details"]["cache_write_1h_tokens"] = json!(self.write_1h);
            usage["cache_creation"] = json!({
                "ephemeral_5m_input_tokens": self.write - self.write_1h,
                "ephemeral_1h_input_tokens": self.write_1h,
            });
        }
    }
}

/// Build Anthropic's top-level `system` value from the OpenAI-shape system
/// messages.
///
/// Returns `None` when there are no system messages. When every block is plain
/// text with no `cache_control`, the blocks are joined into a single string —
/// the exact wire shape this adapter has always produced. As soon as any block
/// carries a `cache_control` breakpoint (or is not a plain text block), the
/// array form is emitted instead, because a string `system` cannot carry one.
///
/// This is also a plain correctness fix: the previous `filter_map(as_str)` threw
/// away *any* array-form system content, silently dropping the whole system
/// prompt for callers that send content blocks.
fn system_field(messages: &[Value]) -> Option<Value> {
    let mut blocks: Vec<Value> = Vec::new();
    for m in messages
        .iter()
        .filter(|m| m["role"].as_str() == Some("system"))
    {
        blocks.extend(content_blocks(&m["content"]));
    }
    if blocks.is_empty() {
        return None;
    }

    // `collect::<Option<Vec<_>>>` short-circuits to `None` the moment one block
    // is not plain cache-free text, which is exactly when we need the array form.
    let plain: Option<Vec<&str>> = blocks
        .iter()
        .map(|b| {
            let plain_text = b.get("cache_control").is_none() && b["type"] == json!("text");
            plain_text.then(|| b["text"].as_str()).flatten()
        })
        .collect();

    Some(match plain {
        Some(parts) => Value::String(parts.join("\n\n")),
        None => Value::Array(blocks),
    })
}

/// Normalise one OpenAI-shape message `content` into Anthropic content blocks.
/// A plain string becomes a single `text` block; an array passes through
/// block-by-block so per-block `cache_control` breakpoints survive.
fn content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::String(s) => vec![json!({ "type": "text", "text": s })],
        Value::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

/// Project the OpenAI-shape message list onto Anthropic's `messages` array.
///
/// System messages are dropped (they hoist to the top-level `system` field via
/// [`system_field`]) and everything that is not part of a tool loop keeps the
/// plain `{role, content}` shape this adapter has always produced — a string
/// passes through as a string, a block array passes through verbatim so per-block
/// `cache_control` breakpoints survive.
///
/// The two tool-loop shapes have no such passthrough, because OpenAI carries a
/// tool call on the *message* and Anthropic carries it in the *content*:
///
/// * an assistant message with `tool_calls` becomes an assistant turn whose
///   content is a block array — its text (when non-empty) followed by one
///   `tool_use` block per call;
/// * `role: "tool"` messages become `tool_result` blocks inside a **user** turn,
///   and consecutive ones merge into a single turn because Anthropic requires
///   every result for a turn to arrive in one user message.
/// True when a `cache_control` breakpoint already sits anywhere in `value`.
fn contains_cache_control(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            map.contains_key("cache_control") || map.values().any(contains_cache_control)
        }
        Value::Array(items) => items.iter().any(contains_cache_control),
        _ => false,
    }
}

/// Put a request-level `cache_control` on the final message's last cacheable
/// block. Thinking blocks and empty text cannot carry a breakpoint, so the walk
/// skips them; a plain-string turn becomes a single text block to carry it.
fn place_request_cache_breakpoint(messages: &mut [Value], cache_control: &Value) {
    let Some(last) = messages.last_mut() else {
        return;
    };
    match last.get_mut("content") {
        Some(Value::String(text)) if !text.is_empty() => {
            let text = std::mem::take(text);
            last["content"] =
                json!([{ "type": "text", "text": text, "cache_control": cache_control }]);
        }
        Some(Value::Array(blocks)) => {
            let cacheable = blocks.iter_mut().rev().find(|block| {
                let kind = block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let empty_text = kind == "text"
                    && block
                        .get("text")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty);
                block.is_object()
                    && !matches!(kind, "thinking" | "redacted_thinking")
                    && !empty_text
            });
            if let Some(block) = cacheable {
                block["cache_control"] = cache_control.clone();
            }
        }
        _ => {}
    }
}

fn anthropic_messages(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    // Index into `out` of the user turn currently collecting `tool_result`
    // blocks, so a run of tool messages merges instead of emitting a turn each.
    let mut open_tool_turn: Option<usize> = None;

    for m in messages {
        match m["role"].as_str() {
            Some("system") => continue,
            Some("tool") => {
                // Without a call id Anthropic cannot match the result to its
                // `tool_use` block, and it rejects the whole turn — skip it.
                let Some(id) = m["tool_call_id"].as_str() else {
                    continue;
                };
                // `content` is optional on Anthropic's `tool_result`, but an
                // explicit `null` is not the same as an absent key and is
                // rejected, so a content-less tool message omits it entirely.
                let mut block = json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                });
                if !m["content"].is_null() {
                    block["content"] = m["content"].clone();
                }
                // A caller's breakpoint on the result (the last block of an agent
                // tool-loop turn) rides on the message; Anthropic wants it here.
                if let Some(cache_control) = m.get("cache_control").filter(|c| c.is_object()) {
                    block["cache_control"] = cache_control.clone();
                }
                match open_tool_turn {
                    Some(i) => {
                        if let Some(blocks) = out[i]["content"].as_array_mut() {
                            blocks.push(block);
                        }
                    }
                    None => {
                        out.push(json!({ "role": "user", "content": [block] }));
                        open_tool_turn = Some(out.len() - 1);
                    }
                }
                continue;
            }
            Some("assistant") => {
                // An assistant turn echoed back with the blocks this adapter
                // preserved on the way up (`ryu_content_blocks`) replays
                // verbatim. That is what makes a `pause_turn` resumable:
                // Anthropic continues a paused server-tool turn only when it
                // sees the original trailing `server_tool_use` block, which the
                // OpenAI `{role, content}` shape cannot carry.
                if let Some(blocks) = m["ryu_content_blocks"].as_array() {
                    out.push(json!({ "role": "assistant", "content": blocks }));
                    open_tool_turn = None;
                    continue;
                }
                if let Some(calls) = m["tool_calls"].as_array().filter(|c| !c.is_empty()) {
                    let mut blocks: Vec<Value> = Vec::new();
                    // Content may be a string or already a block array (a
                    // caller round-tripping blocks to carry a `cache_control`
                    // breakpoint). Taking only the string form dropped the
                    // assistant's text on every tool turn.
                    match &m["content"] {
                        Value::String(text) if !text.is_empty() => {
                            blocks.push(json!({ "type": "text", "text": text }));
                        }
                        Value::Array(_) => blocks.extend(content_blocks(&m["content"])),
                        _ => {}
                    }
                    for call in calls {
                        let mut block = json!({
                            "type": "tool_use",
                            "id": call["id"],
                            "name": call["function"]["name"],
                            "input": parse_tool_arguments(&call["function"]["arguments"]),
                        });
                        if let Some(cache_control) =
                            call.get("cache_control").filter(|c| c.is_object())
                        {
                            block["cache_control"] = cache_control.clone();
                        }
                        blocks.push(block);
                    }
                    out.push(json!({ "role": "assistant", "content": blocks }));
                    open_tool_turn = None;
                    continue;
                }
            }
            _ => {}
        }

        out.push(json!({
            "role": m["role"],
            "content": m["content"],
        }));
        open_tool_turn = None;
    }

    out
}

/// Translate compatible image blocks without fetching caller URLs or changing
/// native Anthropic blocks, tool results, or cache breakpoints.
fn translate_vision_blocks(value: &mut Value, provider: &str) -> Result<(), ProviderError> {
    use base64::Engine as _;
    match value {
        Value::Array(items) => {
            for item in items {
                translate_vision_blocks(item, provider)?;
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("image_url") {
                let url = object
                    .get("image_url")
                    .and_then(|image| image.get("url"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProviderError::Provider("Anthropic image_url needs a URL string".to_owned())
                    })?;
                let source = if let Some(data_uri) = url.strip_prefix("data:") {
                    let (metadata, encoded) = data_uri.split_once(',').ok_or_else(|| {
                        ProviderError::Provider("Anthropic image data URI is malformed".to_owned())
                    })?;
                    let mime = metadata
                        .strip_suffix(";base64")
                        .filter(|mime| {
                            matches!(
                                *mime,
                                "image/jpeg" | "image/png" | "image/gif" | "image/webp"
                            )
                        })
                        .ok_or_else(|| {
                            ProviderError::Provider(
                                "Anthropic image needs JPEG, PNG, GIF or WebP base64".to_owned(),
                            )
                        })?;
                    if encoded.is_empty()
                        || encoded.len() > 10 * 1024 * 1024
                        || base64::engine::general_purpose::STANDARD
                            .decode(encoded)
                            .is_err()
                    {
                        return Err(ProviderError::Provider(
                            "Anthropic image base64 is empty, invalid or too large".to_owned(),
                        ));
                    }
                    json!({"type":"base64","media_type":mime,"data":encoded})
                } else {
                    if provider.starts_with("bedrock") {
                        return Err(ProviderError::Provider(
                            "Bedrock vision requires inline image data".to_owned(),
                        ));
                    }
                    crate::web::ValidatedPublicWebUrl::parse(url).map_err(|_| {
                        ProviderError::Provider(
                            "Anthropic image URL must be a public HTTP or HTTPS URL".to_owned(),
                        )
                    })?;
                    json!({"type":"url","url":url})
                };
                object.remove("image_url");
                object.insert("type".to_owned(), json!("image"));
                object.insert("source".to_owned(), source);
            } else {
                // Content arrays can also occur inside tool-result blocks.
                for key in ["messages", "content", "system"] {
                    if let Some(child) = object.get_mut(key) {
                        translate_vision_blocks(child, provider)?;
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// Decode an OpenAI `function.arguments` value into the object Anthropic wants
/// for `tool_use.input`. OpenAI sends a JSON-encoded string; an empty or
/// unparseable one becomes `{}` rather than failing the whole turn. An object is
/// accepted as-is for clients that skip the encoding step.
fn parse_tool_arguments(arguments: &Value) -> Value {
    match arguments {
        Value::String(s) if !s.trim().is_empty() => {
            serde_json::from_str(s).unwrap_or_else(|_| json!({}))
        }
        Value::Object(_) => arguments.clone(),
        _ => json!({}),
    }
}

/// Encode an Anthropic `tool_use.input` object as the JSON *string* OpenAI's
/// `function.arguments` is. A missing or non-object input becomes `"{}"`, never
/// `"null"` — callers parse this field as an object.
fn encode_tool_arguments(input: &Value) -> String {
    if !input.is_object() {
        return "{}".to_string();
    }
    serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
}

/// Build Anthropic's `tools` array from the OpenAI-shape `tools` field.
///
/// An OpenAI function tool is rewritten to Anthropic's `{name, description,
/// input_schema}`. Anything else — `{"type": "code_execution_20260120", …}`,
/// web search/fetch, the tool-search variants, or a bare `{name, input_schema}`
/// — passes through **verbatim**, which is what lets a caller drive Anthropic's
/// server-side tools through this adapter unchanged.
///
/// Returns `None` when the caller named no tools, so the `tools` key is omitted
/// rather than emitted empty.
fn anthropic_tools(body: &Value) -> Option<Value> {
    let tools = body["tools"].as_array().filter(|t| !t.is_empty())?;

    let mapped: Vec<Value> = tools
        .iter()
        .map(|entry| {
            let function = &entry["function"];
            let is_openai_shape =
                function.is_object() && matches!(entry["type"].as_str(), None | Some("function"));
            if !is_openai_shape {
                return entry.clone();
            }

            let mut tool = json!({
                "name": function["name"],
                // Anthropic requires input_schema; an argument-less OpenAI tool
                // may omit `parameters`, so fall back to an empty object schema.
                "input_schema": match function.get("parameters") {
                    Some(p) if p.is_object() => p.clone(),
                    _ => json!({ "type": "object", "properties": {} }),
                },
            });
            if let Some(d) = function.get("description") {
                tool["description"] = d.clone();
            }
            // Anthropic reads these at the tool's top level; OpenAI callers put
            // them either there or beside the function body, so accept both.
            // `strict` is deliberately dropped: Anthropic has no per-tool
            // equivalent, and forwarding it would be rejected as unknown.
            for key in ["allowed_callers", "defer_loading", "cache_control"] {
                if let Some(v) = entry.get(key).or_else(|| function.get(key)) {
                    tool[key] = v.clone();
                }
            }
            tool
        })
        .collect();

    Some(Value::Array(mapped))
}

/// Build Anthropic's `tool_choice` from the OpenAI-shape `tool_choice` and
/// `parallel_tool_calls` fields.
///
/// OpenAI's `"auto"` / `"none"` / `"required"` map to `{"type": …}` objects
/// (`required` is Anthropic's `any`), and `{"type": "function", "function":
/// {"name": N}}` becomes `{"type": "tool", "name": N}`. An object that is already
/// Anthropic-native passes through verbatim. `parallel_tool_calls: false` sets
/// `disable_parallel_tool_use` *inside* the resulting object — that is where
/// Anthropic carries it — creating a default `{"type": "auto"}` if the caller
/// named no choice at all.
fn anthropic_tool_choice(body: &Value) -> Option<Value> {
    let mut choice = match body.get("tool_choice") {
        Some(Value::String(s)) => match s.as_str() {
            "auto" => Some(json!({ "type": "auto" })),
            "none" => Some(json!({ "type": "none" })),
            "required" => Some(json!({ "type": "any" })),
            _ => None,
        },
        Some(Value::Object(o)) => match o.get("type").and_then(Value::as_str) {
            Some("auto" | "any" | "tool" | "none") => Some(Value::Object(o.clone())),
            // `get` rather than `Index`: indexing a `Map` with a missing key
            // panics, and `tool_choice` is caller-controlled JSON, so
            // `{"type":"function"}` with no `function` object would take the
            // whole gateway process down.
            Some("function") => o
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(|name| json!({ "type": "tool", "name": name })),
            _ => None,
        },
        _ => None,
    };

    if body["parallel_tool_calls"] == json!(false) {
        let target = choice.get_or_insert_with(|| json!({ "type": "auto" }));
        if let Some(map) = target.as_object_mut() {
            map.insert("disable_parallel_tool_use".to_string(), json!(true));
        }
    }

    choice
}

/// Map an Anthropic `stop_reason` onto an OpenAI `finish_reason`.
///
/// `pause_turn` is deliberately **not** an OpenAI value: Anthropic pauses a
/// long-running server-tool turn with it, and the caller is expected to resume by
/// sending the response back. Collapsing it to `"stop"` (as this adapter used to)
/// reports a truncated answer as a complete one with no error anywhere, so it is
/// passed through verbatim for callers that know to look for it.
fn map_stop_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("max_tokens") => "length",
        Some("tool_use") => "tool_calls",
        Some("refusal") => "content_filter",
        Some("pause_turn") => "pause_turn",
        // "end_turn", "stop_sequence", and anything unknown.
        _ => "stop",
    }
}

/// The `anthropic-beta` header value: the comma-joined union of the caller's own
/// comma-separated list and the extended-cache-TTL beta when the payload needs
/// it, de-duplicated with the caller's order preserved. `None` when neither
/// applies, so a plain request sends no beta header at all.
///
/// Beta selection is the caller's business — nothing here sniffs tool types to
/// guess which beta a request wants.
/// Private body field carrying the Gateway's upstream subject; mirrored by
/// `UPSTREAM_SUBJECT_FIELD` in the Gateway's identity module.
const UPSTREAM_SUBJECT_FIELD: &str = "ryu_upstream_subject";

fn anthropic_beta_header(caller: Option<&str>, wants_ttl: bool) -> Option<String> {
    let mut betas: Vec<&str> = Vec::new();
    for part in caller.unwrap_or_default().split(',') {
        let part = part.trim();
        if !part.is_empty() && !betas.contains(&part) {
            betas.push(part);
        }
    }
    if wants_ttl && !betas.contains(&EXTENDED_CACHE_TTL_BETA) {
        betas.push(EXTENDED_CACHE_TTL_BETA);
    }
    (!betas.is_empty()).then(|| betas.join(","))
}

/// Whether any `cache_control` breakpoint in the outgoing payload asks for a TTL
/// other than Anthropic's 5-minute default. Those require an opt-in beta header,
/// and without it Anthropic rejects the request rather than silently downgrading
/// — so the header is sent if and only if an extended TTL is actually present.
fn wants_extended_cache_ttl(payload: &Value) -> bool {
    fn walk(v: &Value) -> bool {
        match v {
            Value::Object(map) => {
                if let Some(ttl) = map.get("cache_control").and_then(|c| c.get("ttl")) {
                    if ttl.as_str().is_some_and(|t| t != "5m") {
                        return true;
                    }
                }
                map.values().any(walk)
            }
            Value::Array(items) => items.iter().any(walk),
            _ => false,
        }
    }
    walk(payload)
}

/// Anthropic's opt-in beta for `cache_control.ttl` values beyond the 5-minute
/// default (currently `"1h"`).
pub const EXTENDED_CACHE_TTL_BETA: &str = "extended-cache-ttl-2025-04-11";

/// Anthropic's original prompt-caching beta. Caching is generally available,
/// so the value is a no-op upstream, but older SDKs still send it.
pub const PROMPT_CACHING_BETA: &str = "prompt-caching-2024-07-31";

impl Provider for AnthropicProvider {
    fn configure_account_policies(&self, policies: &[crate::ProviderAccountPolicy]) {
        self.account_pool.configure(policies);
    }

    fn configure_account_strategy(&self, strategy: crate::AccountSelectionStrategy) {
        self.account_pool.configure_strategy(strategy);
    }

    fn configure_fill_first_drain_percent(&self, percent: u8) {
        self.account_pool
            .configure_fill_first_drain_percent(percent);
    }

    fn name(&self) -> &'static str {
        self.provider_id
    }

    fn has_rotating_accounts(&self) -> bool {
        self.account_pool.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        self.complete_for_session(model, body, None)
    }

    fn complete_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = self.to_anthropic_body(model, body);
            translate_vision_blocks(&mut payload, self.provider_id)?;
            debug!(
                provider = self.provider_id,
                model, "sending non-streaming request"
            );

            let url = self.messages_url();
            let caller_beta = body["ryu_anthropic_beta"].as_str();
            // Account rotation (#4): rotate keys on a 429 or a refused key
            // before failing over.
            let candidates = self.account_pool.candidates(session);
            let mut last_err: Option<ProviderError> = None;
            for index in candidates {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(session, "Anthropic request failed", |client| {
                        self.anthropic_post(client, &url, key, &payload, caller_beta)
                    })
                    .await?;

                let status = resp.status();
                if let Some(domain) = parse_quota_domain(resp.headers()) {
                    self.account_pool.record_quota_domain(index, domain);
                }
                let rate_limit = parse_rate_limit(resp.headers());
                let account_quota = parse_account_quota(resp.headers());

                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    let retry_after = rate_limit.as_ref().and_then(|r| r.retry_after);
                    let reset_at = rate_limit.as_ref().and_then(|r| r.reset_at);
                    self.quota
                        .record_rate_limited(self.provider_id, retry_after, reset_at);
                    self.account_pool.record_rate_limit(index, retry_after);
                    let _ = resp.bounded_text().await;
                    warn!(provider = self.provider_id, "provider rate limited (429)");
                    let e = ProviderError::RateLimited {
                        provider: self.provider_id.to_string(),
                        retry_after,
                        reset_at,
                    };
                    last_err = Some(e);
                    continue;
                }

                // Classify an error by its status before parsing: a 400 with a
                // non-JSON body is still this request's rejection, and a
                // rejection must not count toward the shared provider circuit.
                if !status.is_success() {
                    let body = resp.bounded_text().await.unwrap_or_default();
                    let msg = error_body_message(&body);
                    warn!(provider = self.provider_id, status = %status, "provider returned error");
                    let (error, key_refused) = upstream_error_with_key_refusal(
                        self.provider_id,
                        status,
                        &body,
                        format!("Anthropic error {status}: {msg}"),
                    );
                    if key_refused {
                        self.account_pool.record_auth_failure(index);
                        last_err = Some(error);
                        continue;
                    }
                    return Err(error);
                }

                let json: Value = resp.bounded_json().await.map_err(|_| {
                    // Accepted generations are billed upstream; never replay.
                    ProviderError::DeliveryUncertain(
                        "Anthropic accepted response could not be decoded".to_owned(),
                    )
                })?;

                if let Some(info) = rate_limit.as_ref() {
                    self.quota.record_success(self.provider_id, info);
                }
                if let Some(info) = account_quota.as_ref() {
                    self.account_pool.record_quota(index, info);
                }

                self.account_pool.record_success(session, index);

                // Requested model (before routing) for response shaping
                let requested_model = body["model"].as_str().unwrap_or(model);
                return Ok(self.from_anthropic_response(&json, requested_model));
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_string(),
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
        self.complete_stream_for_session(model, body, None)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = self.to_anthropic_body(model, body);
            translate_vision_blocks(&mut payload, self.provider_id)?;
            payload["stream"] = Value::Bool(true);
            debug!(
                provider = self.provider_id,
                model, "sending streaming request"
            );

            let url = self.messages_url();
            let caller_beta = body["ryu_anthropic_beta"].as_str();
            let candidates = self.account_pool.candidates(session);
            let mut last_err: Option<ProviderError> = None;
            for index in candidates {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(session, "Anthropic stream request failed", |client| {
                        streaming_request(self.anthropic_post(
                            client,
                            &url,
                            key,
                            &payload,
                            caller_beta,
                        ))
                    })
                    .await?;

                let status = resp.status();
                if let Some(domain) = parse_quota_domain(resp.headers()) {
                    self.account_pool.record_quota_domain(index, domain);
                }
                let rate_limit = parse_rate_limit(resp.headers());
                let account_quota = parse_account_quota(resp.headers());

                if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    let retry_after = rate_limit.as_ref().and_then(|r| r.retry_after);
                    let reset_at = rate_limit.as_ref().and_then(|r| r.reset_at);
                    self.quota
                        .record_rate_limited(self.provider_id, retry_after, reset_at);
                    self.account_pool.record_rate_limit(index, retry_after);
                    let _ = resp.bounded_text().await;
                    let e = ProviderError::RateLimited {
                        provider: self.provider_id.to_string(),
                        retry_after,
                        reset_at,
                    };
                    last_err = Some(e);
                    continue;
                }

                if !status.is_success() {
                    let text = resp.bounded_text().await.unwrap_or_default();
                    let (error, key_refused) = upstream_error_with_key_refusal(
                        self.provider_id,
                        status,
                        &text,
                        format!("Anthropic stream error {status}: {text}"),
                    );
                    if key_refused {
                        self.account_pool.record_auth_failure(index);
                        last_err = Some(error);
                        continue;
                    }
                    return Err(error);
                }

                if let Some(info) = rate_limit.as_ref() {
                    self.quota.record_success(self.provider_id, info);
                }
                if let Some(info) = account_quota.as_ref() {
                    self.account_pool.record_quota(index, info);
                }

                self.account_pool.record_success(session, index);

                let requested_model = body["model"].as_str().unwrap_or(model).to_string();

                // Translate Anthropic SSE events → OpenAI SSE events on the fly.
                let raw_stream = resp.bytes_stream();
                let translated = translate_anthropic_stream(raw_stream, requested_model);
                return Ok(Body::from_stream(translated));
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: self.provider_id.to_string(),
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
    // Usage is spread across two Anthropic events: `message_start` carries the
    // input legs (including the prompt-cache read/write counts) and
    // `message_delta` carries the running output count. Accumulate both so the
    // terminal OpenAI chunk can report a usage block — without one, the
    // gateway's `sse_parse_usage` / `sse_parse_cached_tokens` see nothing and
    // streaming token and cache accounting on this path is blind.
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cache = CacheUsage::default();
    // Anthropic sends both `message_delta` and `message_stop`; emit the terminal
    // chunk (and `[DONE]`) exactly once.
    let mut finished = false;
    // Read off `message_delta.delta.stop_reason` when it arrives; "stop" is the
    // right default for a stream that ends without one.
    let mut finish_reason: &'static str = "stop";
    // OpenAI's `delta.tool_calls[].index` counts *tool calls*, while Anthropic's
    // content index counts every block including text — so keep our own counter
    // and remember which call the `input_json_delta` fragments belong to.
    let mut tool_call_index: usize = 0;
    let mut open_tool_call: Option<usize> = None;
    // SSE lines do not respect network chunk boundaries: a `data:` line can
    // arrive split across two reads, and a non-UTF8 read is only non-UTF8
    // because a multi-byte character straddles the boundary. Carry the trailing
    // partial line (and any undecodable tail bytes) into the next chunk instead
    // of dropping it. Losing one `content_block_start` line would drop a whole
    // tool call: the counter never advances, so the call's id and name are
    // never emitted and its `input_json_delta` fragments have nowhere to land.
    let mut pending = Vec::<u8>::new();
    let cid = completion_id.clone();

    raw.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        .flat_map(move |chunk_result| {
            let cid = cid.clone();
            let model = model.clone();

            match chunk_result {
                Err(e) => stream::iter(vec![Err(e)]).left_stream(),
                Ok(chunk) => {
                    pending.extend_from_slice(&chunk);
                    // Split on the last newline: everything before it is whole
                    // lines, the remainder is a partial line awaiting more bytes.
                    let split_at = match pending.iter().rposition(|b| *b == b'\n') {
                        Some(i) => i + 1,
                        None => return stream::iter(vec![]).left_stream(),
                    };
                    let ready: Vec<u8> = pending.drain(..split_at).collect();
                    let text = match String::from_utf8(ready) {
                        Ok(t) => t,
                        // A boundary-straddling character cannot survive here
                        // because we cut on a newline, so this is genuinely
                        // malformed input rather than a split; skip it.
                        Err(_) => return stream::iter(vec![]).left_stream(),
                    };

                    let mut output: Vec<Result<Bytes, std::io::Error>> = Vec::new();

                    for line in text.lines() {
                        if line.starts_with("event: ") {
                            last_event_type = line[7..].trim().to_string();
                        } else if line.starts_with("data: ") {
                            let data = &line[6..];

                            match last_event_type.as_str() {
                                "content_block_start" => {
                                    if let Ok(v) = serde_json::from_str::<Value>(data) {
                                        let block = &v["content_block"];
                                        if block["type"].as_str() == Some("tool_use") {
                                            let idx = tool_call_index;
                                            tool_call_index += 1;
                                            open_tool_call = Some(idx);
                                            let oai_chunk = serde_json::json!({
                                                "id": cid,
                                                "object": "chat.completion.chunk",
                                                "created": created,
                                                "model": model,
                                                "choices": [{
                                                    "index": 0,
                                                    "delta": {"tool_calls": [{
                                                        "index": idx,
                                                        "id": block["id"],
                                                        "type": "function",
                                                        "function": {
                                                            "name": block["name"],
                                                            "arguments": "",
                                                        },
                                                    }]},
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
                                // The one place the open call is cleared. Doing it
                                // on any *other* `content_block_start` instead
                                // would silently drop the `input_json_delta`
                                // fragments if Anthropic ever interleaved an event
                                // shape we do not model — the call would then
                                // stream with empty `arguments`.
                                "content_block_stop" => open_tool_call = None,
                                "content_block_delta" => {
                                    if let Ok(v) = serde_json::from_str::<Value>(data) {
                                        let delta = &v["delta"];
                                        // Anthropic streams a tool call's input as
                                        // `partial_json` fragments the caller
                                        // concatenates; OpenAI streams the same
                                        // fragments as `function.arguments`.
                                        let tool_fragment = (delta["type"] == "input_json_delta")
                                            .then(|| delta["partial_json"].as_str())
                                            .flatten()
                                            .zip(open_tool_call);
                                        let chunk_delta = if let Some(text) = delta["text"].as_str()
                                        {
                                            Some(serde_json::json!({ "content": text }))
                                        } else {
                                            tool_fragment.map(|(partial, idx)| {
                                                serde_json::json!({"tool_calls": [{
                                                    "index": idx,
                                                    "function": { "arguments": partial },
                                                }]})
                                            })
                                        };
                                        if let Some(chunk_delta) = chunk_delta {
                                            let oai_chunk = serde_json::json!({
                                                "id": cid,
                                                "object": "chat.completion.chunk",
                                                "created": created,
                                                "model": model,
                                                "choices": [{
                                                    "index": 0,
                                                    "delta": chunk_delta,
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
                                "message_start" => {
                                    if let Ok(v) = serde_json::from_str::<Value>(data) {
                                        let usage = &v["message"]["usage"];
                                        input_tokens = usage["input_tokens"].as_u64().unwrap_or(0);
                                        cache = CacheUsage::from_anthropic(usage);
                                    }
                                }
                                "message_stop" | "message_delta" => {
                                    if let Ok(v) = serde_json::from_str::<Value>(data) {
                                        if let Some(n) = v["usage"]["output_tokens"].as_u64() {
                                            output_tokens = n;
                                        }
                                        if let Some(r) = v["delta"]["stop_reason"].as_str() {
                                            finish_reason = map_stop_reason(Some(r));
                                        }
                                    }
                                    if finished {
                                        continue;
                                    }
                                    finished = true;
                                    // Same `input_tokens` correction as the
                                    // non-streaming path: Anthropic excludes the
                                    // cache legs, OpenAI's `prompt_tokens` includes them.
                                    let prompt_tokens = input_tokens + cache.total();
                                    let mut usage = serde_json::json!({
                                        "prompt_tokens": prompt_tokens,
                                        "completion_tokens": output_tokens,
                                        "total_tokens": prompt_tokens + output_tokens,
                                    });
                                    cache.merge_into_usage(&mut usage);
                                    let stop_chunk = serde_json::json!({
                                        "id": cid,
                                        "object": "chat.completion.chunk",
                                        "created": created,
                                        "model": model,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {},
                                            "finish_reason": finish_reason,
                                        }],
                                        "usage": usage,
                                    });
                                    if let Ok(json_str) = serde_json::to_string(&stop_chunk) {
                                        let line = format!("data: {json_str}\n\ndata: [DONE]\n\n");
                                        output.push(Ok(Bytes::from(line)));
                                    }
                                }
                                // Anthropic reports a failure after the 200 (an
                                // `overloaded_error`, an `api_error`) as `event:
                                // error` and then closes. Surface it in-band and
                                // end the body with an error, never a terminal
                                // chunk or `[DONE]`, so a truncated answer cannot
                                // read as a clean completion.
                                "error" => {
                                    if finished {
                                        continue;
                                    }
                                    finished = true;
                                    let error = serde_json::from_str::<Value>(data)
                                        .map(|v| v["error"].clone())
                                        .unwrap_or(Value::Null);
                                    let kind = error["type"].as_str().unwrap_or("api_error");
                                    let message = error["message"]
                                        .as_str()
                                        .unwrap_or("Anthropic stream failed");
                                    let frame = serde_json::json!({
                                        "error": { "type": kind, "message": message },
                                    });
                                    output.push(Ok(Bytes::from(format!("data: {frame}\n\n"))));
                                    output.push(Err(std::io::Error::other(format!(
                                        "Anthropic stream error: {kind}"
                                    ))));
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

    #[tokio::test]
    async fn bedrock_rate_limits_keep_the_alias_identity_for_chat_and_stream() {
        let server = MockServer::always(MockResponse::json(429, "quota")).await;
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        for streaming in [false, true] {
            let provider = AnthropicProvider::new_named_with_egress(
                "bedrock",
                reqwest::Client::new(),
                None,
                vec!["test-key".to_owned()],
                server.base_url().to_owned(),
                Arc::new(ProviderQuotas::new()),
            );
            assert_eq!(provider.name(), "bedrock");
            let error = if streaming {
                provider
                    .complete_stream("claude-test", &body)
                    .await
                    .err()
                    .unwrap()
            } else {
                provider.complete("claude-test", &body).await.err().unwrap()
            };
            assert!(
                matches!(error, ProviderError::RateLimited { provider, .. } if provider == "bedrock")
            );
        }
        assert_eq!(server.request_count(), 2);
    }

    /// A generation Anthropic may still be running (timeout after the send) or
    /// has finished (an accepted 2xx whose body cannot be decoded) is billed
    /// upstream, so it must stop fallback instead of replaying on the next
    /// provider. Only a connection that was never established may fall back.
    #[tokio::test]
    async fn uncertain_delivery_is_typed_and_never_replayed() {
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        let server = MockServer::always(MockResponse::ok_json("not-json")).await;
        let provider = provider_with(server.base_url().to_owned(), vec!["first", "second"]);
        let error = provider.complete("claude-test", &body).await.unwrap_err();
        assert!(
            matches!(error, ProviderError::DeliveryUncertain(_)),
            "{error:?}"
        );
        assert_eq!(server.request_count(), 1);

        let (url, seen, stalled) = crate::test_support::stalled_server().await;
        let provider = AnthropicProvider::new(
            // Streams lift the total timeout; the read timeout still fires.
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(200))
                .read_timeout(std::time::Duration::from_millis(200))
                .build()
                .unwrap(),
            vec!["first".to_owned(), "second".to_owned()],
            url,
            Arc::new(ProviderQuotas::new()),
        );
        for (expected, streaming) in [(1, false), (2, true)] {
            let error = if streaming {
                provider
                    .complete_stream("claude-test", &body)
                    .await
                    .err()
                    .unwrap()
            } else {
                provider.complete("claude-test", &body).await.unwrap_err()
            };
            assert!(
                matches!(error, ProviderError::DeliveryUncertain(_)),
                "streaming={streaming}: {error:?}"
            );
            assert_eq!(
                seen.load(std::sync::atomic::Ordering::SeqCst),
                expected,
                "streaming={streaming}"
            );
        }
        stalled.abort();

        let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let refused = format!("http://{}", unused.local_addr().unwrap());
        drop(unused);
        let error = provider_with(refused, vec!["first"])
            .complete("claude-test", &body)
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::Transport(_)), "{error:?}");
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
    fn to_anthropic_body_maps_current_chat_token_limit() {
        let p = dummy();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "max_completion_tokens": 123
        });

        assert_eq!(p.to_anthropic_body("m", &body)["max_tokens"], json!(123));
    }

    #[test]
    fn to_anthropic_body_forwards_integer_top_k_only() {
        let p = dummy();
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }], "top_k": 40 });
        assert_eq!(p.to_anthropic_body("m", &body)["top_k"], json!(40));

        let invalid = json!({ "messages": [{ "role": "user", "content": "hi" }], "top_k": 0.5 });
        assert!(p.to_anthropic_body("m", &invalid).get("top_k").is_none());
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
        assert_eq!(
            out["choices"][0]["message"]["content"],
            json!("hello world")
        );
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

    // ── prompt caching: system blocks, usage, TTL beta ───────────────────────

    #[test]
    fn to_anthropic_body_keeps_array_system_and_its_cache_breakpoint() {
        let p = dummy();
        // Before the fix this dropped the system prompt entirely: the old
        // `filter_map(as_str)` skipped every array-form system message.
        let body = json!({
            "messages": [
                { "role": "system", "content": [
                    { "type": "text", "text": "HUGE PREFIX",
                      "cache_control": { "type": "ephemeral" } }
                ]},
                { "role": "user", "content": "hi" }
            ]
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(out["system"][0]["text"], json!("HUGE PREFIX"));
        assert_eq!(
            out["system"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
    }

    #[test]
    fn to_anthropic_body_joins_plain_array_system_into_a_string() {
        let p = dummy();
        // No cache_control anywhere ⇒ the historical string shape is preserved,
        // so a non-caching caller's wire format is byte-identical to before.
        let body = json!({
            "messages": [
                { "role": "system", "content": [{ "type": "text", "text": "one" }] },
                { "role": "system", "content": "two" }
            ]
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(out["system"], json!("one\n\ntwo"));
    }

    #[test]
    fn to_anthropic_body_passes_message_cache_control_through() {
        let p = dummy();
        let body = json!({
            "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "ctx", "cache_control": { "type": "ephemeral" } }
            ]}]
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(
            out["messages"][0]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
    }

    #[test]
    fn to_anthropic_body_lifts_tool_loop_breakpoints_onto_the_blocks() {
        let p = dummy();
        let body = json!({
            "messages": [
                { "role": "assistant", "content": null, "tool_calls": [{
                    "id": "tu_1", "type": "function",
                    "function": { "name": "lookup", "arguments": "{}" },
                    "cache_control": { "type": "ephemeral" }
                }] },
                { "role": "tool", "tool_call_id": "tu_1", "content": "found",
                  "cache_control": { "type": "ephemeral", "ttl": "1h" } }
            ]
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(
            out["messages"][0]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        assert_eq!(
            out["messages"][1]["content"][0]["cache_control"]["ttl"],
            json!("1h")
        );
    }

    #[test]
    fn to_anthropic_body_places_request_cache_control_on_the_last_block() {
        // Auto prompt caching marks the request root; it must land on a block
        // or Anthropic never caches the prefix.
        let p = dummy();
        let body = json!({
            "cache_control": { "type": "ephemeral", "ttl": "1h" },
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "first" },
                { "role": "assistant", "content": "reply" },
                { "role": "user", "content": "latest question" }
            ]
        });
        let out = p.to_anthropic_body("claude-sonnet-4-5", &body);
        assert!(out.get("cache_control").is_none());
        let last = out["messages"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["content"][0]["text"], json!("latest question"));
        assert_eq!(last["content"][0]["cache_control"]["ttl"], json!("1h"));
        assert_eq!(out["messages"][0]["content"], json!("first"));
    }

    #[test]
    fn to_anthropic_body_keeps_caller_breakpoints_over_the_request_marker() {
        let p = dummy();
        let body = json!({
            "cache_control": { "type": "ephemeral" },
            "messages": [
                { "role": "user", "content": [
                    { "type": "text", "text": "ctx", "cache_control": { "type": "ephemeral" } }
                ]},
                { "role": "assistant", "content": "ok" },
                { "role": "user", "content": "next" }
            ]
        });
        let out = p.to_anthropic_body("claude-sonnet-4-5", &body);
        let last = out["messages"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["content"], json!("next"));
    }

    #[test]
    fn from_anthropic_response_surfaces_cache_read_and_write_tokens() {
        let p = dummy();
        let resp = json!({
            "content": [{ "type": "text", "text": "x" }],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "cache_read_input_tokens": 900,
                "cache_creation_input_tokens": 100
            }
        });
        let out = p.from_anthropic_response(&resp, "m");
        // OpenAI-shape prompt_tokens includes the cache legs Anthropic excludes.
        assert_eq!(out["usage"]["prompt_tokens"], json!(1010));
        assert_eq!(out["usage"]["total_tokens"], json!(1015));
        assert_eq!(
            out["usage"]["prompt_tokens_details"]["cached_tokens"],
            json!(900)
        );
        assert_eq!(
            out["usage"]["prompt_tokens_details"]["cache_write_tokens"],
            json!(100)
        );
        // Native names survive too.
        assert_eq!(out["usage"]["cache_read_input_tokens"], json!(900));
        assert_eq!(out["usage"]["cache_creation_input_tokens"], json!(100));
        // A default-TTL write carries no one-hour split.
        assert!(out["usage"]["prompt_tokens_details"]
            .get("cache_write_1h_tokens")
            .is_none());
        assert!(out["usage"].get("cache_creation").is_none());
    }

    #[test]
    fn from_anthropic_response_carries_the_one_hour_cache_write_split() {
        let p = dummy();
        let resp = json!({
            "content": [{ "type": "text", "text": "x" }],
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 100,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 40,
                    "ephemeral_1h_input_tokens": 60
                }
            }
        });
        let out = p.from_anthropic_response(&resp, "m");
        assert_eq!(
            out["usage"]["prompt_tokens_details"]["cache_write_tokens"],
            json!(100)
        );
        assert_eq!(
            out["usage"]["prompt_tokens_details"]["cache_write_1h_tokens"],
            json!(60)
        );
        assert_eq!(
            out["usage"]["cache_creation"]["ephemeral_1h_input_tokens"],
            json!(60)
        );
        assert_eq!(
            out["usage"]["cache_creation"]["ephemeral_5m_input_tokens"],
            json!(40)
        );
    }

    #[test]
    fn from_anthropic_response_omits_cache_details_when_uncached() {
        let p = dummy();
        let resp = json!({
            "content": [{ "text": "x" }],
            "usage": { "input_tokens": 4, "output_tokens": 2 }
        });
        let out = p.from_anthropic_response(&resp, "m");
        assert_eq!(out["usage"]["prompt_tokens"], json!(4));
        assert!(out["usage"].get("prompt_tokens_details").is_none());
    }

    #[test]
    fn wants_extended_cache_ttl_only_for_non_default_ttl() {
        assert!(!wants_extended_cache_ttl(&json!({
            "system": [{ "cache_control": { "type": "ephemeral" } }]
        })));
        assert!(!wants_extended_cache_ttl(&json!({
            "system": [{ "cache_control": { "type": "ephemeral", "ttl": "5m" } }]
        })));
        assert!(wants_extended_cache_ttl(&json!({
            "messages": [{ "content": [{ "cache_control": { "ttl": "1h" } }] }]
        })));
    }

    #[tokio::test]
    async fn complete_sends_ttl_beta_header_only_when_asked() {
        let ok = r#"{"id":"m","content":[{"text":"ok"}],"stop_reason":"end_turn",
                    "usage":{"input_tokens":1,"output_tokens":1}}"#;

        let plain = MockServer::always(MockResponse::ok_json(ok)).await;
        let p = provider_with(plain.base_url().to_string(), vec!["k"]);
        p.complete(
            "m",
            &json!({ "messages": [{ "role": "user", "content": "hi" }] }),
        )
        .await
        .unwrap();
        assert!(plain.requests()[0].header("anthropic-beta").is_none());

        let ttl = MockServer::always(MockResponse::ok_json(ok)).await;
        let p = provider_with(ttl.base_url().to_string(), vec!["k"]);
        p.complete(
            "m",
            &json!({ "messages": [{ "role": "system", "content": [
                { "type": "text", "text": "big",
                  "cache_control": { "type": "ephemeral", "ttl": "1h" } }
            ]}]}),
        )
        .await
        .unwrap();
        assert_eq!(
            ttl.requests()[0].header("anthropic-beta").as_deref(),
            Some(EXTENDED_CACHE_TTL_BETA)
        );
    }

    #[tokio::test]
    async fn translate_anthropic_stream_emits_usage_with_cache_counts_once() {
        let sse = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":900,\"cache_creation_input_tokens\":0}}}\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7}}\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n",
        );
        let out = collect_stream(vec![sse], "m").await;
        assert!(out.contains(r#""prompt_tokens":910"#), "got: {out}");
        assert!(out.contains(r#""completion_tokens":7"#), "got: {out}");
        assert!(out.contains(r#""cached_tokens":900"#), "got: {out}");
        // message_delta + message_stop must not both terminate the stream.
        assert_eq!(out.matches("data: [DONE]").count(), 1, "got: {out}");
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

    /// SSE lines do not respect network chunk boundaries. A `content_block_start`
    /// split mid-line used to be dropped whole, and with it the tool call: the
    /// index never advanced, so neither the id/name chunk nor the argument
    /// fragments were ever emitted.
    #[tokio::test]
    async fn translate_anthropic_stream_reassembles_lines_split_across_chunks() {
        let out = collect_stream(
            vec![
                "event: content_block_start\ndata: {\"content_block\":{\"type\":\"too",
                "l_use\",\"id\":\"toolu_1\",\"name\":\"get_orders\"}}\n",
                "event: content_block_delta\ndata: {\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"id\\\":\"}}\n",
                "event: content_block_delta\ndata: {\"delta\":{\"type\":\"input_json_de",
                "lta\",\"partial_json\":\"\\\"A-1\\\"}\"}}\n",
                "event: message_delta\ndata: {\"delta\":{\"stop_reason\":\"tool_use\"}}\n",
            ],
            "m",
        )
        .await;
        assert!(
            out.contains("\"id\":\"toolu_1\""),
            "lost the split start: {out}"
        );
        assert!(out.contains("get_orders"));
        // Both fragments land on the same call.
        assert!(out.contains("{\\\"id\\\":"), "lost a fragment: {out}");
        assert!(out.contains("\\\"A-1\\\"}"), "lost a fragment: {out}");
        assert!(out.contains("\"finish_reason\":\"tool_calls\""));
    }

    /// A multi-byte character straddling a chunk boundary is a split, not
    /// corruption: the bytes must be held, not thrown away with the line.
    #[tokio::test]
    async fn translate_anthropic_stream_holds_a_split_multibyte_character() {
        let payload = "event: content_block_delta\ndata: {\"delta\":{\"text\":\"café\"}}\n";
        let bytes = payload.as_bytes();
        // Cut inside the two-byte "é".
        let cut = payload.find('é').unwrap() + 1;
        let head = Box::leak(bytes[..cut].to_vec().into_boxed_slice());
        let tail = Box::leak(bytes[cut..].to_vec().into_boxed_slice());
        let raw = futures_util::stream::iter(vec![
            Ok::<Bytes, reqwest::Error>(Bytes::from_static(head)),
            Ok::<Bytes, reqwest::Error>(Bytes::from_static(tail)),
        ]);
        let translated = translate_anthropic_stream(raw, "m".to_string());
        let mut out = String::new();
        futures_util::pin_mut!(translated);
        while let Some(item) = translated.next().await {
            out.push_str(std::str::from_utf8(&item.unwrap()).unwrap());
        }
        assert!(out.contains("café"), "dropped a split character: {out}");
    }

    async fn collect_stream(chunks: Vec<&'static str>, model: &str) -> String {
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
    async fn translate_anthropic_stream_fails_on_a_mid_stream_error_event() {
        let sse = concat!(
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hal\"}}\n",
            "event: error\n",
            "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n",
        );
        let raw = futures_util::stream::iter(vec![Ok::<Bytes, reqwest::Error>(Bytes::from(sse))]);
        let items: Vec<_> = translate_anthropic_stream(raw, "m".to_owned())
            .collect()
            .await;
        let text: String = items
            .iter()
            .filter_map(|item| item.as_ref().ok())
            .map(|bytes| std::str::from_utf8(bytes).unwrap().to_owned())
            .collect();
        assert!(text.contains(r#""content":"Hal""#), "got: {text}");
        let frames = stream_chunks(&text);
        let error = frames.last().unwrap();
        assert_eq!(error["error"]["type"], json!("overloaded_error"));
        assert_eq!(error["error"]["message"], json!("Overloaded"));
        assert!(!text.contains("[DONE]"), "got: {text}");
        assert!(!text.contains("finish_reason\":\"stop"), "got: {text}");
        assert!(items.last().unwrap().is_err());
    }

    #[tokio::test]
    async fn refused_key_moves_the_session_to_a_healthy_key() {
        let ok = r#"{"id":"m","content":[{"text":"ok"}],"stop_reason":"end_turn",
            "usage":{"input_tokens":1,"output_tokens":1}}"#;
        for (status, stream) in [(401, false), (403, true)] {
            let server = MockServer::start(vec![
                MockResponse::json(
                    status,
                    r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
                ),
                MockResponse::ok_json(ok),
                MockResponse::ok_json(ok),
            ])
            .await;
            let p = provider_with(server.base_url().to_string(), vec!["revoked", "healthy"]);
            let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
            for _ in 0..2 {
                if stream {
                    p.complete_stream_for_session("m", &body, Some("conv"))
                        .await
                        .unwrap();
                } else {
                    p.complete_for_session("m", &body, Some("conv"))
                        .await
                        .unwrap();
                }
            }
            let keys: Vec<_> = server
                .requests()
                .iter()
                .map(|request| request.header("x-api-key").unwrap())
                .collect();
            assert_eq!(keys, ["revoked", "healthy", "healthy"], "{status}");
        }
        let server = MockServer::always(MockResponse::json(401, "{}")).await;
        let p = provider_with(server.base_url().to_string(), vec!["only"]);
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        for _ in 0..2 {
            assert!(matches!(
                p.complete("m", &body).await,
                Err(ProviderError::Rejected { status: 401, .. })
            ));
        }
        assert_eq!(server.request_count(), 2);
    }

    #[tokio::test]
    async fn a_request_refusal_403_neither_rotates_nor_cools_the_key() {
        // `permission_error`: this key may not use the requested model/beta. Any
        // other key would be refused the same request, so the key stays usable.
        let refusal =
            r#"{"type":"error","error":{"type":"permission_error","message":"model not enabled"}}"#;
        let ok = r#"{"id":"m","content":[{"text":"ok"}],"stop_reason":"end_turn",
            "usage":{"input_tokens":1,"output_tokens":1}}"#;
        for stream in [false, true] {
            let server = MockServer::start(vec![
                MockResponse::json(403, refusal),
                MockResponse::ok_json(ok),
            ])
            .await;
            let p = provider_with(server.base_url().to_string(), vec!["first", "second"]);
            let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
            let refused = if stream {
                p.complete_stream_for_session("m", &body, Some("conv"))
                    .await
                    .err()
            } else {
                p.complete_for_session("m", &body, Some("conv")).await.err()
            };
            assert!(
                matches!(refused, Some(ProviderError::Rejected { status: 403, .. })),
                "stream={stream}: {refused:?}"
            );
            // The next request still goes to the first key: it was not cooled.
            p.complete_for_session("m", &body, Some("conv"))
                .await
                .unwrap();
            let keys: Vec<_> = server
                .requests()
                .iter()
                .map(|request| request.header("x-api-key").unwrap())
                .collect();
            assert_eq!(keys, ["first", "first"], "stream={stream}");
        }
    }

    #[tokio::test]
    async fn complete_translates_and_sends_anthropic_headers() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"id":"msg_1","content":[{"type":"text","text":"hi there"}],
                "stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":5}}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["sk-secret-KEY"]);
        let body =
            json!({ "model": "claude-alias", "messages": [{ "role": "user", "content": "hi" }] });
        let out = p.complete("claude-3-5", &body).await.unwrap();

        assert_eq!(out["choices"][0]["message"]["content"], json!("hi there"));
        assert_eq!(out["usage"]["total_tokens"], json!(8));
        // Response is shaped with the caller's *requested* model, not the routed one.
        assert_eq!(out["model"], json!("claude-alias"));

        let reqs = server.requests();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].path, "/v1/messages");
        assert_eq!(
            reqs[0].header("x-api-key").as_deref(),
            Some("sk-secret-KEY")
        );
        assert_eq!(
            reqs[0].header("anthropic-version").as_deref(),
            Some("2023-06-01")
        );
        // The routed model (not the alias) is what goes upstream.
        assert_eq!(reqs[0].json()["model"], json!("claude-3-5"));
    }

    #[tokio::test]
    async fn vision_translates_inline_and_remote_images_on_buffered_and_streaming_wire() {
        for streaming in [false, true] {
            let reply = if streaming {
                MockResponse::ok_json("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"seen\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
                    .with_header("content-type", "text/event-stream")
            } else {
                MockResponse::ok_json(
                    r#"{"id":"msg_vision","content":[{"type":"text","text":"seen"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#,
                )
            };
            let server = MockServer::always(reply).await;
            let provider = provider_with(server.base_url().to_owned(), vec!["vision-key"]);
            let body = json!({"messages":[{"role":"user","content":[
                {"type":"text","text":"What is shown?"},
                {"type":"image_url","image_url":{"url":"data:image/png;base64,AQID","detail":"high"},"cache_control":{"type":"ephemeral"}},
                {"type":"image_url","image_url":{"url":"https://images.example.com/image.jpg"}},
                {"type":"image","source":{"type":"base64","media_type":"image/webp","data":"AQID"}}
            ]}]});
            if streaming {
                let response = provider
                    .complete_stream("claude-vision", &body)
                    .await
                    .unwrap();
                let bytes = axum::body::to_bytes(response, 1024 * 1024).await.unwrap();
                let text = String::from_utf8(bytes.to_vec()).unwrap();
                assert!(text.contains("seen"));
                assert!(text.contains("[DONE]"));
            } else {
                let response = provider.complete("claude-vision", &body).await.unwrap();
                assert_eq!(response["choices"][0]["message"]["content"], "seen");
            }
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].path, "/v1/messages");
            assert_eq!(
                requests[0].header("x-api-key").as_deref(),
                Some("vision-key")
            );
            let payload = requests[0].json();
            assert_eq!(payload["model"], "claude-vision");
            assert_eq!(
                payload["messages"][0]["content"][1],
                json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"AQID"},"cache_control":{"type":"ephemeral"}})
            );
            assert_eq!(
                payload["messages"][0]["content"][2],
                json!({"type":"image","source":{"type":"url","url":"https://images.example.com/image.jpg"}})
            );
            assert_eq!(
                payload["messages"][0]["content"][3],
                body["messages"][0]["content"][3]
            );
        }
    }

    #[tokio::test]
    async fn malformed_or_private_vision_inputs_never_send_credentials() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let provider = provider_with(server.base_url().to_owned(), vec!["vision-key"]);
        for url in [
            "data:image/svg+xml;base64,AQID",
            "data:image/png;base64,invalid",
            "file:///image.png",
            "http://127.0.0.1/image.png",
            "https://user:password@example.com/image.png",
        ] {
            let body = json!({"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":url}}]}]});
            assert!(provider.complete("claude-vision", &body).await.is_err());
            assert!(provider
                .complete_stream("claude-vision", &body)
                .await
                .is_err());
        }
        assert_eq!(server.requests().len(), 0);
        let mut bedrock = json!({"messages":[{"content":[{"type":"image_url","image_url":{"url":"https://images.example.com/a.png"}}]}]});
        assert!(translate_vision_blocks(&mut bedrock, "bedrock-api").is_err());
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
        assert!(
            !rendered.contains(SECRET),
            "key leaked in error: {rendered}"
        );
        assert!(rendered.contains("invalid request"));
    }

    #[tokio::test]
    async fn request_rejections_are_typed_even_without_a_json_body() {
        // A rejection says nothing about Anthropic's health, so it must reach
        // the gateway as `Rejected` (never `Provider`) or one tenant's bad
        // request would count toward the circuit every tenant shares.
        for (status, reply) in [
            (400, r#"{"error":{"message":"bad parameter"}}"#),
            (413, "<html>request too large</html>"),
            (422, "not json"),
        ] {
            let server = MockServer::always(MockResponse::json(status, reply)).await;
            let p = provider_with(server.base_url().to_string(), vec!["sk-ant-test"]);
            let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
            assert!(
                matches!(
                    p.complete("m", &body).await,
                    Err(ProviderError::Rejected { .. })
                ),
                "complete {status}"
            );
            assert!(
                matches!(
                    p.complete_stream("m", &body).await,
                    Err(ProviderError::Rejected { .. })
                ),
                "stream {status}"
            );
        }
        let server = MockServer::always(MockResponse::json(500, "upstream down")).await;
        let p = provider_with(server.base_url().to_string(), vec!["sk-ant-test"]);
        let body = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        assert!(matches!(
            p.complete("m", &body).await,
            Err(ProviderError::Provider(_))
        ));
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
        let server =
            MockServer::always(MockResponse::json(429, "nope").with_header("retry-after", "9"))
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

    // ── tool calling: request shaping ────────────────────────────────────────

    #[test]
    fn to_anthropic_body_maps_openai_function_tools() {
        let p = dummy();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Look up the weather",
                    "parameters": { "type": "object", "properties": { "city": { "type": "string" } } },
                    // Anthropic has no per-tool `strict`; it must not be forwarded.
                    "strict": true,
                    "defer_loading": true
                },
                "allowed_callers": ["assistant"],
                "cache_control": { "type": "ephemeral" }
            }]
        });
        let out = p.to_anthropic_body("m", &body);
        let tool = &out["tools"][0];
        assert_eq!(tool["name"], json!("get_weather"));
        assert_eq!(tool["description"], json!("Look up the weather"));
        // `parameters` becomes Anthropic's `input_schema`...
        assert_eq!(
            tool["input_schema"]["properties"]["city"]["type"],
            json!("string")
        );
        assert!(tool.get("parameters").is_none());
        // ...and the extras survive from either nesting level.
        assert_eq!(tool["allowed_callers"], json!(["assistant"]));
        assert_eq!(tool["defer_loading"], json!(true));
        assert_eq!(tool["cache_control"]["type"], json!("ephemeral"));
        // `strict` is dropped, not passed through.
        assert!(tool.get("strict").is_none());
        assert!(tool.get("function").is_none());
    }

    #[test]
    fn to_anthropic_body_defaults_input_schema_for_argument_less_tools() {
        let p = dummy();
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [{ "type": "function", "function": { "name": "ping" } }]
        });
        let out = p.to_anthropic_body("m", &body);
        // Anthropic requires input_schema even when the tool takes no arguments.
        assert_eq!(
            out["tools"][0]["input_schema"],
            json!({ "type": "object", "properties": {} })
        );
        assert!(out["tools"][0].get("description").is_none());
    }

    #[test]
    fn to_anthropic_body_passes_native_server_tools_through_verbatim() {
        let p = dummy();
        let native = json!({ "type": "code_execution_20260120", "name": "code_execution" });
        let bare = json!({ "name": "legacy", "input_schema": { "type": "object" } });
        let body = json!({
            "messages": [{ "role": "user", "content": "hi" }],
            "tools": [native, bare, { "type": "web_search_20250305", "name": "web_search", "max_uses": 3 }]
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(out["tools"][0], native);
        assert_eq!(out["tools"][1], bare);
        assert_eq!(out["tools"][2]["max_uses"], json!(3));
    }

    #[test]
    fn to_anthropic_body_omits_tools_when_absent_or_empty() {
        let p = dummy();
        let plain = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        // A no-tool request is byte-identical to what this adapter produced
        // before tool support existed — no stray `tools`/`tool_choice` keys.
        assert_eq!(
            p.to_anthropic_body("m", &plain),
            json!({
                "model": "m",
                "messages": [{ "role": "user", "content": "hi" }],
                "max_tokens": 4096,
            })
        );

        let mut empty = plain.clone();
        empty["tools"] = json!([]);
        assert!(p.to_anthropic_body("m", &empty).get("tools").is_none());
    }

    #[test]
    fn to_anthropic_body_maps_every_tool_choice_spelling() {
        let p = dummy();
        // `tools` is present throughout: a choice that selects from nothing is
        // omitted by design (see `to_anthropic_body_omits_tool_choice_when_no_tools_are_named`).
        let choice_for = |c: Value| {
            let body = json!({
                "messages": [],
                "tools": [{ "type": "function", "function": { "name": "pick_me" } }],
                "tool_choice": c,
            });
            p.to_anthropic_body("m", &body)["tool_choice"].clone()
        };
        assert_eq!(choice_for(json!("auto")), json!({ "type": "auto" }));
        assert_eq!(choice_for(json!("none")), json!({ "type": "none" }));
        // OpenAI's "required" is Anthropic's "any".
        assert_eq!(choice_for(json!("required")), json!({ "type": "any" }));
        assert_eq!(
            choice_for(json!({ "type": "function", "function": { "name": "pick_me" } })),
            json!({ "type": "tool", "name": "pick_me" })
        );
        // An already-Anthropic choice passes through untouched.
        assert_eq!(
            choice_for(json!({ "type": "tool", "name": "native" })),
            json!({ "type": "tool", "name": "native" })
        );
    }

    #[test]
    fn to_anthropic_body_disables_parallel_tool_use_inside_tool_choice() {
        let p = dummy();
        // Anthropic carries this *inside* tool_choice, not as a sibling key.
        let out = p.to_anthropic_body(
            "m",
            &json!({
                "messages": [],
                "tools": [{ "type": "function", "function": { "name": "f" } }],
                "tool_choice": "required",
                "parallel_tool_calls": false,
            }),
        );
        assert_eq!(
            out["tool_choice"],
            json!({ "type": "any", "disable_parallel_tool_use": true })
        );
        assert!(out.get("parallel_tool_calls").is_none());

        // With no tool_choice at all it still has to land somewhere (as long as
        // the caller named tools; without them the whole key is omitted).
        let out = p.to_anthropic_body(
            "m",
            &json!({
                "messages": [],
                "tools": [{ "type": "function", "function": { "name": "f" } }],
                "parallel_tool_calls": false,
            }),
        );
        assert_eq!(
            out["tool_choice"],
            json!({ "type": "auto", "disable_parallel_tool_use": true })
        );

        // `true` is Anthropic's default: no tool_choice is invented for it.
        let out = p.to_anthropic_body("m", &json!({ "messages": [], "parallel_tool_calls": true }));
        assert!(out.get("tool_choice").is_none());
    }

    #[test]
    fn to_anthropic_body_projects_assistant_tool_calls_into_tool_use_blocks() {
        let p = dummy();
        let body = json!({
            "messages": [
                { "role": "user", "content": "weather?" },
                { "role": "assistant", "content": "let me check", "tool_calls": [
                    { "id": "call_1", "type": "function",
                      "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } },
                    // Empty arguments must degrade to `{}`, not break the turn.
                    { "id": "call_2", "type": "function",
                      "function": { "name": "get_time", "arguments": "" } }
                ]}
            ]
        });
        let out = p.to_anthropic_body("m", &body);
        let assistant = &out["messages"][1];
        assert_eq!(assistant["role"], json!("assistant"));
        // Text first, then one tool_use block per call.
        assert_eq!(
            assistant["content"][0],
            json!({ "type": "text", "text": "let me check" })
        );
        assert_eq!(
            assistant["content"][1],
            json!({ "type": "tool_use", "id": "call_1", "name": "get_weather",
                    "input": { "city": "Paris" } })
        );
        assert_eq!(assistant["content"][2]["input"], json!({}));
        assert_eq!(assistant["content"].as_array().unwrap().len(), 3);
        // The OpenAI-only key does not reach Anthropic.
        assert!(assistant.get("tool_calls").is_none());
    }

    #[test]
    fn to_anthropic_body_omits_the_text_block_for_empty_assistant_content() {
        let p = dummy();
        let body = json!({
            "messages": [{ "role": "assistant", "content": "", "tool_calls": [
                { "id": "c", "function": { "name": "f", "arguments": "{}" } }
            ]}]
        });
        let out = p.to_anthropic_body("m", &body);
        let blocks = out["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], json!("tool_use"));
    }

    #[test]
    fn to_anthropic_body_merges_consecutive_tool_messages_into_one_user_turn() {
        let p = dummy();
        let body = json!({
            "messages": [
                { "role": "assistant", "content": null, "tool_calls": [
                    { "id": "call_1", "function": { "name": "a", "arguments": "{}" } },
                    { "id": "call_2", "function": { "name": "b", "arguments": "{}" } }
                ]},
                { "role": "tool", "tool_call_id": "call_1", "content": "18C" },
                { "role": "tool", "tool_call_id": "call_2", "content": "14:00" },
                // No tool_call_id: Anthropic cannot match it, so it is skipped.
                { "role": "tool", "content": "orphan" }
            ]
        });
        let out = p.to_anthropic_body("m", &body);
        let messages = out["messages"].as_array().unwrap();
        // Assistant turn + ONE user turn holding both results.
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], json!("user"));
        assert_eq!(
            messages[1]["content"],
            json!([
                { "type": "tool_result", "tool_use_id": "call_1", "content": "18C" },
                { "type": "tool_result", "tool_use_id": "call_2", "content": "14:00" },
            ])
        );
    }

    /// `tool_choice` is caller-controlled JSON. `{"type":"function"}` with no
    /// `function` object used to index a `Map` with a missing key, which panics
    /// and takes the process down on a request anyone can send.
    #[test]
    fn to_anthropic_body_survives_a_malformed_tool_choice() {
        let p = dummy();
        for choice in [
            json!({ "type": "function" }),
            json!({ "type": "function", "function": {} }),
            json!({ "type": "function", "function": { "name": 7 } }),
            json!({ "type": "nonsense" }),
            json!("nonsense"),
            json!(42),
        ] {
            let body = json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "tools": [{ "type": "function", "function": { "name": "f" } }],
                "tool_choice": choice,
            });
            let out = p.to_anthropic_body("m", &body);
            // Unmappable choices are simply omitted; nothing panics.
            assert!(
                out.get("tool_choice").is_none() || out["tool_choice"]["type"] == json!("tool")
            );
        }
    }

    /// A choice that selects from nothing is rejected upstream, and an ordinary
    /// request must keep the payload it had before tool support existed.
    #[test]
    fn to_anthropic_body_omits_tool_choice_when_no_tools_are_named() {
        let p = dummy();
        let base = json!({ "messages": [{ "role": "user", "content": "hi" }] });
        for extra in [
            json!({ "tools": [], "tool_choice": "auto" }),
            json!({ "parallel_tool_calls": false }),
            json!({ "tool_choice": "required" }),
        ] {
            let mut body = base.clone();
            for (k, v) in extra.as_object().unwrap() {
                body[k] = v.clone();
            }
            let out = p.to_anthropic_body("m", &body);
            assert!(out.get("tool_choice").is_none(), "leaked for {extra}");
            assert!(out.get("tools").is_none(), "leaked tools for {extra}");
        }
    }

    /// A caller that round-trips assistant content in block form (the only shape
    /// that can carry a `cache_control` breakpoint) used to lose its text on
    /// every tool turn, because only the string form was read.
    #[test]
    fn to_anthropic_body_keeps_block_array_assistant_content_alongside_tool_calls() {
        let p = dummy();
        let body = json!({
            "messages": [{
                "role": "assistant",
                "content": [{ "type": "text", "text": "let me check" }],
                "tool_calls": [
                    { "id": "call_1", "function": { "name": "a", "arguments": "{}" } }
                ],
            }],
            "tools": [{ "type": "function", "function": { "name": "a" } }],
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(
            out["messages"][0]["content"],
            json!([
                { "type": "text", "text": "let me check" },
                { "type": "tool_use", "id": "call_1", "name": "a", "input": {} },
            ])
        );
    }

    /// Resuming a `pause_turn` requires Anthropic to see the original trailing
    /// `server_tool_use` block, so an echoed assistant turn replays the blocks
    /// this adapter preserved rather than the flattened text.
    #[test]
    fn to_anthropic_body_replays_preserved_blocks_for_a_paused_turn() {
        let p = dummy();
        let blocks = json!([
            { "type": "text", "text": "searching" },
            { "type": "server_tool_use", "id": "srv_1", "name": "code_execution", "input": {} },
        ]);
        let body = json!({
            "messages": [
                { "role": "user", "content": "go" },
                { "role": "assistant", "content": "searching", "ryu_content_blocks": blocks },
            ],
            "tools": [{ "type": "code_execution_20260120", "name": "code_execution" }],
        });
        let out = p.to_anthropic_body("m", &body);
        assert_eq!(out["messages"][1]["content"], blocks);
    }

    /// `tool_result.content` is optional, but an explicit `null` is not the same
    /// as an absent key and is rejected.
    #[test]
    fn to_anthropic_body_omits_null_tool_result_content() {
        let p = dummy();
        let body = json!({
            "messages": [{ "role": "tool", "tool_call_id": "call_1" }],
            "tools": [{ "type": "function", "function": { "name": "a" } }],
        });
        let out = p.to_anthropic_body("m", &body);
        let block = &out["messages"][0]["content"][0];
        assert_eq!(block["type"], json!("tool_result"));
        assert!(block.get("content").is_none());
    }

    #[test]
    fn to_anthropic_body_starts_a_new_turn_after_an_interrupting_message() {
        let p = dummy();
        let body = json!({
            "messages": [
                { "role": "tool", "tool_call_id": "a", "content": "1" },
                { "role": "user", "content": "and now?" },
                { "role": "tool", "tool_call_id": "b", "content": "2" }
            ]
        });
        let out = p.to_anthropic_body("m", &body);
        // Only *consecutive* tool messages merge.
        assert_eq!(out["messages"].as_array().unwrap().len(), 3);
        assert_eq!(out["messages"][2]["content"][0]["tool_use_id"], json!("b"));
    }

    // ── tool calling: caller-supplied betas ──────────────────────────────────

    #[test]
    fn anthropic_beta_header_unions_and_dedups() {
        assert_eq!(anthropic_beta_header(None, false), None);
        assert_eq!(
            anthropic_beta_header(None, true),
            Some(EXTENDED_CACHE_TTL_BETA.to_string())
        );
        assert_eq!(
            anthropic_beta_header(Some("a, b ,a"), false),
            Some("a,b".to_string())
        );
        // Caller order first, then the TTL beta, with no duplicate.
        assert_eq!(
            anthropic_beta_header(Some(&format!("a,{EXTENDED_CACHE_TTL_BETA}")), true),
            Some(format!("a,{EXTENDED_CACHE_TTL_BETA}"))
        );
        assert_eq!(anthropic_beta_header(Some("  "), false), None);
    }

    #[tokio::test]
    async fn complete_sends_caller_betas_without_leaking_the_field_upstream() {
        let ok = r#"{"id":"m","content":[{"text":"ok"}],"stop_reason":"end_turn",
                    "usage":{"input_tokens":1,"output_tokens":1}}"#;
        let server = MockServer::always(MockResponse::ok_json(ok)).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"]);
        p.complete(
            "m",
            &json!({
                "messages": [{ "role": "system", "content": [
                    { "type": "text", "text": "big",
                      "cache_control": { "type": "ephemeral", "ttl": "1h" } }
                ]}],
                "ryu_anthropic_beta": format!("code-execution-2025-08-25,{EXTENDED_CACHE_TTL_BETA}"),
            }),
        )
        .await
        .unwrap();

        let req = &server.requests()[0];
        assert_eq!(
            req.header("anthropic-beta").as_deref(),
            Some(format!("code-execution-2025-08-25,{EXTENDED_CACHE_TTL_BETA}").as_str())
        );
        // The private field is a header instruction, never part of the payload.
        assert!(req.json().get("ryu_anthropic_beta").is_none());
    }

    #[tokio::test]
    async fn upstream_subject_becomes_metadata_user_id_and_caller_metadata_is_dropped() {
        let ok = r#"{"id":"m","content":[{"text":"ok"}],"stop_reason":"end_turn",
                    "usage":{"input_tokens":1,"output_tokens":1}}"#;
        let server = MockServer::always(MockResponse::ok_json(ok)).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"]);
        let subject = "ryu.1.0123456789abcdef0123456789abcdef";
        p.complete(
            "m",
            &json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "metadata": { "user_id": "RYU_TEST_LEXICON-meta" },
                "user": "RYU_TEST_LEXICON-user",
                UPSTREAM_SUBJECT_FIELD: subject,
            }),
        )
        .await
        .unwrap();
        // Without the private field no metadata is sent at all.
        p.complete(
            "m",
            &json!({
                "messages": [{ "role": "user", "content": "hi" }],
                "metadata": { "user_id": "RYU_TEST_LEXICON-meta" },
            }),
        )
        .await
        .unwrap();

        let requests = server.requests();
        let stamped = requests[0].json();
        assert_eq!(stamped["metadata"], json!({ "user_id": subject }));
        assert!(stamped.get(UPSTREAM_SUBJECT_FIELD).is_none());
        assert!(!stamped.to_string().contains("RYU_TEST_LEXICON"));
        let plain = requests[1].json();
        assert!(plain.get("metadata").is_none());
        assert!(!plain.to_string().contains("RYU_TEST_LEXICON"));
    }

    // ── tool calling: response shaping ───────────────────────────────────────

    #[test]
    fn from_anthropic_response_concatenates_every_text_block() {
        let p = dummy();
        let resp = json!({
            "content": [
                { "type": "text", "text": "one " },
                { "type": "text", "text": "two" }
            ],
            "usage": { "input_tokens": 1, "output_tokens": 1 }
        });
        let out = p.from_anthropic_response(&resp, "m");
        // Only the first block was read before, silently truncating the answer.
        assert_eq!(out["choices"][0]["message"]["content"], json!("one two"));
    }

    #[test]
    fn from_anthropic_response_maps_tool_use_to_tool_calls() {
        let p = dummy();
        let resp = json!({
            "content": [{ "type": "tool_use", "id": "toolu_1", "name": "get_weather",
                          "input": { "city": "Paris" } }],
            "stop_reason": "tool_use",
            "usage": { "input_tokens": 1, "output_tokens": 1 }
        });
        let out = p.from_anthropic_response(&resp, "m");
        let msg = &out["choices"][0]["message"];
        // Tool calls and no text ⇒ OpenAI's null content, not "".
        assert_eq!(msg["content"], Value::Null);
        assert_eq!(msg["tool_calls"][0]["id"], json!("toolu_1"));
        assert_eq!(msg["tool_calls"][0]["type"], json!("function"));
        assert_eq!(
            msg["tool_calls"][0]["function"]["name"],
            json!("get_weather")
        );
        // `arguments` is a JSON-encoded string, not an object.
        assert_eq!(
            msg["tool_calls"][0]["function"]["arguments"],
            json!(r#"{"city":"Paris"}"#)
        );
        assert_eq!(out["choices"][0]["finish_reason"], json!("tool_calls"));
    }

    #[test]
    fn from_anthropic_response_keeps_text_alongside_tool_calls() {
        let p = dummy();
        let resp = json!({
            "content": [
                { "type": "text", "text": "checking" },
                { "type": "tool_use", "id": "t", "name": "f" }
            ],
            "usage": { "input_tokens": 1, "output_tokens": 1 }
        });
        let out = p.from_anthropic_response(&resp, "m");
        assert_eq!(out["choices"][0]["message"]["content"], json!("checking"));
        // A tool_use block with no input still yields object-shaped arguments.
        assert_eq!(
            out["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            json!("{}")
        );
    }

    #[test]
    fn from_anthropic_response_omits_tool_calls_when_there_are_none() {
        let p = dummy();
        let resp = json!({ "content": [{ "type": "text", "text": "hi" }],
                           "usage": { "input_tokens": 1, "output_tokens": 1 } });
        let out = p.from_anthropic_response(&resp, "m");
        assert!(out["choices"][0]["message"].get("tool_calls").is_none());
    }

    #[test]
    fn from_anthropic_response_maps_the_remaining_stop_reasons() {
        let p = dummy();
        let mk = |reason: &str| {
            json!({ "content": [{ "text": "x" }], "stop_reason": reason,
                    "usage": { "input_tokens": 0, "output_tokens": 0 } })
        };
        let finish = |reason: &str| {
            p.from_anthropic_response(&mk(reason), "m")["choices"][0]["finish_reason"].clone()
        };
        assert_eq!(finish("stop_sequence"), json!("stop"));
        assert_eq!(finish("refusal"), json!("content_filter"));
        // Deliberately non-OpenAI: a paused server-tool turn is resumable, and
        // reporting it as "stop" hands the caller a truncated answer with no error.
        assert_eq!(finish("pause_turn"), json!("pause_turn"));
    }

    #[test]
    fn from_anthropic_response_attaches_exotic_blocks_only_when_present() {
        let p = dummy();
        let content = json!([
            { "type": "server_tool_use", "id": "srv_1", "name": "code_execution",
              "input": { "code": "print(1)" } },
            { "type": "text", "text": "1" }
        ]);
        let resp = json!({ "content": content, "stop_reason": "end_turn",
                           "usage": { "input_tokens": 1, "output_tokens": 1 } });
        let out = p.from_anthropic_response(&resp, "m");
        // The OpenAI shape cannot hold these, so the original array rides along.
        assert_eq!(out["choices"][0]["message"]["ryu_content_blocks"], content);
        // Text blocks are still projected normally.
        assert_eq!(out["choices"][0]["message"]["content"], json!("1"));

        // An ordinary text-only response keeps its historical wire shape.
        let plain = json!({ "content": [{ "type": "text", "text": "hi" }],
                            "usage": { "input_tokens": 1, "output_tokens": 1 } });
        let out = p.from_anthropic_response(&plain, "m");
        assert!(out["choices"][0]["message"]
            .get("ryu_content_blocks")
            .is_none());
    }

    #[test]
    fn from_anthropic_response_copies_server_tool_use_counts() {
        let p = dummy();
        let resp = json!({
            "content": [{ "type": "text", "text": "x" }],
            "usage": {
                "input_tokens": 4, "output_tokens": 2,
                "server_tool_use": { "web_search_requests": 2, "code_execution_seconds": 7 }
            }
        });
        let out = p.from_anthropic_response(&resp, "m");
        // Server-tool counts are the billing surface for web search / code exec.
        assert_eq!(
            out["usage"]["server_tool_use"],
            json!({ "web_search_requests": 2, "code_execution_seconds": 7 })
        );
        // An uncached, non-server-tool response is untouched.
        let plain = json!({ "content": [], "usage": { "input_tokens": 1, "output_tokens": 1 } });
        assert!(p.from_anthropic_response(&plain, "m")["usage"]
            .get("server_tool_use")
            .is_none());
    }

    // ── tool calling: streaming ──────────────────────────────────────────────

    /// The JSON payload of every `data:` line in a translated stream, minus the
    /// terminal `[DONE]` sentinel.
    fn stream_chunks(out: &str) -> Vec<Value> {
        out.lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .filter(|d| *d != "[DONE]")
            .map(|d| serde_json::from_str::<Value>(d).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn translate_anthropic_stream_emits_tool_call_deltas() {
        let sse = concat!(
            "event: content_block_start\n",
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}"#,
            "\n",
            "event: content_block_delta\n",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}"#,
            "\n",
            "event: content_block_delta\n",
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"Paris\"}"}}"#,
            "\n",
            "event: content_block_stop\n",
            r#"data: {"type":"content_block_stop","index":0}"#,
            "\n",
            "event: message_delta\n",
            r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}"#,
            "\n",
            "event: message_stop\n",
            r#"data: {"type":"message_stop"}"#,
            "\n",
        );
        let out = collect_stream(vec![sse], "m").await;
        let chunks = stream_chunks(&out);
        assert_eq!(chunks.len(), 4, "got: {out}");

        // The opening chunk names the call; the index counts tool calls, not
        // Anthropic content blocks.
        assert_eq!(
            chunks[0]["choices"][0]["delta"]["tool_calls"][0],
            json!({ "index": 0, "id": "toolu_1", "type": "function",
                    "function": { "name": "get_weather", "arguments": "" } })
        );

        // The fragments reassemble into the full arguments string, all on index 0.
        let mut args = String::new();
        for c in &chunks[1..3] {
            let call = &c["choices"][0]["delta"]["tool_calls"][0];
            assert_eq!(call["index"], json!(0));
            args.push_str(call["function"]["arguments"].as_str().unwrap());
        }
        assert_eq!(args, r#"{"city":"Paris"}"#);

        // finish_reason comes from message_delta now, not a hardcoded "stop".
        assert_eq!(
            chunks[3]["choices"][0]["finish_reason"],
            json!("tool_calls")
        );
        assert_eq!(chunks[3]["usage"]["completion_tokens"], json!(9));
        assert_eq!(out.matches("data: [DONE]").count(), 1);
    }

    #[tokio::test]
    async fn translate_anthropic_stream_indexes_parallel_tool_calls_in_order() {
        let sse = concat!(
            "event: content_block_start\n",
            r#"data: {"content_block":{"type":"text"}}"#,
            "\n",
            "event: content_block_start\n",
            r#"data: {"content_block":{"type":"tool_use","id":"a","name":"first"}}"#,
            "\n",
            "event: content_block_start\n",
            r#"data: {"content_block":{"type":"tool_use","id":"b","name":"second"}}"#,
            "\n",
        );
        let chunks = stream_chunks(&collect_stream(vec![sse], "m").await);
        // The text block occupies Anthropic index 0 but must not consume an
        // OpenAI tool_calls index.
        assert_eq!(chunks.len(), 2);
        assert_eq!(
            chunks[0]["choices"][0]["delta"]["tool_calls"][0]["index"],
            json!(0)
        );
        assert_eq!(
            chunks[1]["choices"][0]["delta"]["tool_calls"][0]["index"],
            json!(1)
        );
        assert_eq!(
            chunks[1]["choices"][0]["delta"]["tool_calls"][0]["id"],
            json!("b")
        );
    }

    #[tokio::test]
    async fn translate_anthropic_stream_keeps_the_open_call_across_unmodelled_events() {
        let sse = concat!(
            "event: content_block_start\n",
            r#"data: {"content_block":{"type":"tool_use","id":"a","name":"f"}}"#,
            "\n",
            // An event shape this translator does not model. It must not close
            // the open call, or the fragments below vanish and the tool is
            // invoked with empty arguments.
            "event: content_block_start\n",
            r#"data: {"type":"content_block_start"}"#,
            "\n",
            "event: content_block_delta\n",
            r#"data: {"delta":{"type":"input_json_delta","partial_json":"{\"a\":1}"}}"#,
            "\n",
        );
        let chunks = stream_chunks(&collect_stream(vec![sse], "m").await);
        assert_eq!(chunks.len(), 2);
        assert_eq!(
            chunks[1]["choices"][0]["delta"]["tool_calls"][0],
            json!({ "index": 0, "function": { "arguments": r#"{"a":1}"# } })
        );
    }

    #[tokio::test]
    async fn translate_anthropic_stream_maps_pause_turn_finish_reason() {
        let sse = concat!(
            "event: message_delta\n",
            r#"data: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":3}}"#,
            "\n",
        );
        let chunks = stream_chunks(&collect_stream(vec![sse], "m").await);
        assert_eq!(
            chunks[0]["choices"][0]["finish_reason"],
            json!("pause_turn")
        );
    }
}
