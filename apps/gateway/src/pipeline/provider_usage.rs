//! Provider usage parsing; policy and accounting side effects stay in the pipeline.

use serde_json::{json, Value};

/// Force `stream_options.include_usage = true` on the request body so
/// OpenAI-compatible providers emit a terminal usage frame at the end of the
/// SSE stream. Non-conforming providers silently ignore the field and the
/// stream observer falls back to its prompt and output estimates.
///
/// A client-sent `false` is overwritten, not kept: the usage frame is what a
/// metered stream is billed from, so the caller must not be able to switch it
/// off. A client that did not ask for usage receives one extra usage-only
/// chunk, which OpenAI-compatible parsers ignore.
///
/// Called when `evals.stream_usage` is set or the stream is metered.
pub(super) fn inject_stream_usage_option(body: &mut Value) {
    if let Some(obj) = body.as_object_mut() {
        let opts = obj.entry("stream_options").or_insert_with(|| json!({}));
        if !opts.is_object() {
            *opts = json!({});
        }
        if let Some(opts_obj) = opts.as_object_mut() {
            opts_obj.insert("include_usage".into(), json!(true));
        }
    }
}

/// The decoded `data:` frames of an assembled SSE transcript that can carry a
/// top-level `usage` object, which is all the usage readers below look at.
/// Every other frame (one per generated token) is skipped without parsing: a
/// frame whose text has neither `usage` nor a JSON `\u` escape (which could
/// spell the key) cannot hold one.
fn sse_usage_frames(raw: &str) -> impl Iterator<Item = Value> + '_ {
    raw.lines().filter_map(|line| {
        let data = line.strip_prefix("data:")?.trim();
        if data.is_empty() || data == "[DONE]" || !(data.contains("usage") || data.contains("\\u"))
        {
            return None;
        }
        serde_json::from_str::<Value>(data).ok()
    })
}

/// Parse streamed token counts from an assembled OpenAI SSE transcript.
///
/// OpenAI-compatible providers emit one terminal "usage" chunk when
/// `stream_options.include_usage = true`. Its shape is:
/// ```json
/// {"choices":[],"usage":{"prompt_tokens":N,"completion_tokens":M,"total_tokens":T}}
/// ```
/// We scan all `data:` frames for a non-empty `usage` block (any frame may
/// carry it; in practice it is the last non-DONE frame). Returns `(0, 0)` when
/// no usage frame is found, falling back to the caller's estimate.
pub(super) fn sse_parse_usage(raw: &str) -> (u64, u64) {
    let mut best = (0u64, 0u64);
    for json in sse_usage_frames(raw) {
        let input = json["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
        let output = json["usage"]["completion_tokens"].as_u64().unwrap_or(0);
        if input > 0 || output > 0 {
            best = (input, output);
        }
    }
    best
}

/// Estimate the output tokens a stream delivered when the provider sent no
/// usage frame (a disconnect before the terminal frame, or a provider that
/// ignores `stream_options`). Counts the generated text, not the SSE framing:
/// `choices[].delta` content, reasoning, refusals and tool-call names and
/// arguments, plus legacy `choices[].text` and buffered `choices[].message`
/// content, at roughly four characters per token.
///
/// A transcript with no decodable frame falls back to its raw size, so bytes
/// the provider did generate are never estimated as zero.
pub(super) fn sse_estimate_output_tokens(raw: &str) -> u64 {
    fn push_text(value: &Value, chars: &mut u64) {
        match value {
            Value::String(text) => *chars += text.chars().count() as u64,
            // Content-part arrays: `[{"type":"text","text":"..."}]`.
            Value::Array(parts) => {
                for part in parts {
                    if let Some(text) = part.get("text") {
                        push_text(text, chars);
                    } else {
                        push_text(part, chars);
                    }
                }
            }
            _ => {}
        }
    }
    fn push_message(message: &Value, chars: &mut u64) {
        for key in ["content", "reasoning_content", "reasoning", "refusal"] {
            if let Some(value) = message.get(key) {
                push_text(value, chars);
            }
        }
        if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                for key in ["name", "arguments"] {
                    if let Some(value) = call["function"].get(key) {
                        push_text(value, chars);
                    }
                }
            }
        }
    }

    let mut chars = 0u64;
    let mut decoded_frame = false;
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        decoded_frame = true;
        let Some(choices) = frame.get("choices").and_then(Value::as_array) else {
            continue;
        };
        for choice in choices {
            for key in ["delta", "message"] {
                if let Some(message) = choice.get(key) {
                    push_message(message, &mut chars);
                }
            }
            if let Some(text) = choice.get("text") {
                push_text(text, &mut chars);
            }
        }
    }
    if !decoded_frame {
        chars = raw.chars().count() as u64;
    }
    chars.div_ceil(4)
}

/// Preserve an independently reported cache read, including an explicit zero.
pub(super) fn provider_cached_tokens_reported(response: &Value) -> Option<u64> {
    let usage = &response["usage"];
    usage["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .or_else(|| usage["input_tokens_details"]["cached_tokens"].as_u64())
        .or_else(|| usage["cache_read_input_tokens"].as_u64())
        .or_else(|| usage["cached_tokens"].as_u64())
}

/// Preserve an independently reported cache write, including an explicit zero.
pub(super) fn provider_cache_write_tokens_reported(response: &Value) -> Option<u64> {
    let usage = &response["usage"];
    usage["prompt_tokens_details"]["cache_write_tokens"]
        .as_u64()
        .or_else(|| usage["input_tokens_details"]["cache_write_tokens"].as_u64())
        .or_else(|| usage["cache_write_tokens"].as_u64())
        .or_else(|| usage["cache_creation_input_tokens"].as_u64())
}

pub(super) fn sse_parse_cached_tokens_reported(raw: &str) -> Option<u64> {
    sse_scan_usage(raw, provider_cached_tokens_reported)
}

/// Provider-reported prompt cache counts. `None` means the provider did not
/// report cache details; a reported zero stays `Some(0)` for accurate traces.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct ProviderCacheUsage {
    pub read_tokens: u64,
    pub write_tokens: u64,
    /// The part of `write_tokens` written with a one-hour TTL, which costs more
    /// than a default (five-minute) write. Zero when not reported.
    pub write_1h_tokens: u64,
}

impl ProviderCacheUsage {
    /// The legs an own-supply price bills.
    pub(super) fn pricing(self) -> ryu_gw_router::own_supply::CacheTokens {
        ryu_gw_router::own_supply::CacheTokens {
            read: self.read_tokens,
            write: self.write_tokens,
            write_1h: self.write_1h_tokens,
        }
    }

    /// Both rounds' counts, summed (a tool loop bills every round).
    pub(super) fn plus(self, other: Self) -> Self {
        Self {
            read_tokens: self.read_tokens.saturating_add(other.read_tokens),
            write_tokens: self.write_tokens.saturating_add(other.write_tokens),
            write_1h_tokens: self.write_1h_tokens.saturating_add(other.write_1h_tokens),
        }
    }
}

pub(super) fn provider_cache_usage(response: &Value) -> Option<ProviderCacheUsage> {
    let usage = response.get("usage")?;
    let read_tokens = usage["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .or_else(|| usage["input_tokens_details"]["cached_tokens"].as_u64())
        .or_else(|| usage["cache_read_input_tokens"].as_u64())
        .or_else(|| usage["cached_tokens"].as_u64());
    let write_tokens = usage["prompt_tokens_details"]["cache_write_tokens"]
        .as_u64()
        .or_else(|| usage["input_tokens_details"]["cache_write_tokens"].as_u64())
        .or_else(|| usage["cache_write_tokens"].as_u64())
        .or_else(|| usage["cache_creation_input_tokens"].as_u64());
    if read_tokens.is_none() && write_tokens.is_none() {
        return None;
    }
    let write_1h_tokens = usage["prompt_tokens_details"]["cache_write_1h_tokens"]
        .as_u64()
        .or_else(|| usage["cache_creation"]["ephemeral_1h_input_tokens"].as_u64())
        .unwrap_or(0);
    Some(ProviderCacheUsage {
        read_tokens: read_tokens.unwrap_or(0),
        write_tokens: write_tokens.unwrap_or(0),
        write_1h_tokens,
    })
}

/// Read cache counters for the existing aggregate metrics. Missing detail is
/// represented as zero there; request traces use [`provider_cache_usage`] to
/// preserve the distinction between an unreported value and a reported zero.
pub(super) fn provider_cached_tokens(response: &Value) -> u64 {
    provider_cached_tokens_reported(response).unwrap_or(0)
}

/// Counterpart of [`provider_cached_tokens`] for cache *writes* — prompt tokens
/// the provider stored rather than served. Tracked separately because a write is
/// billed above the normal input rate, so "cached_tokens went up" alone cannot
/// tell an operator whether caching is saving money or costing it.
pub(super) fn provider_cache_write_tokens(response: &Value) -> u64 {
    provider_cache_write_tokens_reported(response).unwrap_or(0)
}

/// Streaming counterpart of [`provider_cache_write_tokens`].
pub(super) fn sse_parse_cache_write_tokens(raw: &str) -> u64 {
    sse_parse_cache_write_tokens_reported(raw).unwrap_or(0)
}

pub(super) fn sse_parse_cache_usage(raw: &str) -> Option<ProviderCacheUsage> {
    let mut best = None;
    for frame in sse_usage_frames(raw) {
        if let Some(usage) = provider_cache_usage(&frame) {
            best = Some(usage);
        }
    }
    best
}

/// Streaming counterpart of [`provider_cache_write_tokens_reported`].
pub(super) fn sse_parse_cache_write_tokens_reported(raw: &str) -> Option<u64> {
    sse_scan_usage(raw, provider_cache_write_tokens_reported)
}

/// Scan an assembled SSE transcript and keep the last reported value, including
/// zero. Providers commonly omit cache usage on intermediate frames.
fn sse_scan_usage(raw: &str, pick: fn(&Value) -> Option<u64>) -> Option<u64> {
    let mut best = None;
    for json in sse_usage_frames(raw) {
        if let Some(value) = pick(&json) {
            best = Some(value);
        }
    }
    best
}

/// Streaming counterpart of [`provider_cached_tokens`]: scan an assembled SSE
/// transcript for the terminal usage frame's cached-token count. Mirrors
/// [`sse_parse_usage`]; returns 0 when absent.
pub(super) fn sse_parse_cached_tokens(raw: &str) -> u64 {
    sse_parse_cached_tokens_reported(raw).unwrap_or(0)
}

/// Read a provider-reported USD cost from either the normal response envelope
/// or a preserved raw payload (OpenRouter image output uses `raw`).
pub(super) fn response_reported_cost_usd(response: &Value) -> Option<f64> {
    response
        .get("usage")
        .and_then(|usage| usage.get("cost"))
        .or_else(|| {
            response
                .get("raw")
                .and_then(|raw| raw.get("usage"))
                .and_then(|usage| usage.get("cost"))
        })
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
}

/// Read OpenRouter's selected underlying provider from opt-in routing metadata.
/// Values come from the upstream response, so keep only a short display label
/// without control characters before it reaches the transaction ledger.
pub(super) fn response_upstream_provider(response: &Value) -> Option<String> {
    let metadata = response
        .get("openrouter_metadata")
        .or_else(|| response.pointer("/raw/openrouter_metadata"))?;
    let selected = metadata["endpoints"]["available"]
        .as_array()
        .and_then(|available| {
            available
                .iter()
                .find(|endpoint| endpoint["selected"].as_bool() == Some(true))
        })
        .and_then(|endpoint| {
            endpoint["provider"]
                .as_str()
                .or_else(|| endpoint["provider_name"].as_str())
        });
    let provider = selected
        .or_else(|| metadata["provider_name"].as_str())
        .or_else(|| metadata["provider"].as_str())?;
    let provider = provider.trim();
    if provider.is_empty() || provider.len() > 128 || provider.chars().any(char::is_control) {
        return None;
    }
    Some(provider.to_owned())
}

/// Streaming counterpart of [`response_upstream_provider`]. OpenRouter may put
/// routing metadata on the terminal event, so scan all data frames and retain
/// the last selected provider label.
pub(super) fn sse_parse_openrouter_provider(raw: &str) -> Option<String> {
    let mut provider = None;
    for line in raw.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(selected) = response_upstream_provider(&frame) {
            provider = Some(selected);
        }
    }
    provider
}

/// Convert a provider-reported USD cost to micro-USD. Zero is meaningful: a
/// provider promotion can make a managed request free, so only negative and
/// non-finite values fall back to the token estimate.
pub(super) fn cost_usd_to_micro(cost_usd: f64) -> Option<u64> {
    if cost_usd.is_finite() && cost_usd >= 0.0 {
        Some((cost_usd * 1_000_000.0).round() as u64)
    } else {
        None
    }
}

/// Extract the provider-reported generation cost (USD) from an assembled SSE
/// transcript. OpenRouter includes `usage.cost` in the terminal usage frame when
/// usage accounting is enabled; mirrors [`sse_parse_usage`]. `None` when absent.
pub(super) fn sse_parse_cost(raw: &str) -> Option<f64> {
    let mut best = None;
    for json in sse_usage_frames(raw) {
        if let Some(cost) = json["usage"]["cost"].as_f64() {
            if cost.is_finite() && cost >= 0.0 {
                best = Some(cost);
            }
        }
    }
    best
}

#[cfg(test)]
#[path = "provider_usage_test.rs"]
mod tests;
