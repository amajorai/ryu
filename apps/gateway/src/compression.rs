//! Context compression — the egress transform that "auto-wraps" every
//! gateway-routed agent (M2 / #425).
//!
//! When [`CompressionConfig::enabled`] is set, the pipeline calls
//! [`maybe_compress`] just before the upstream provider call. It ships the
//! request `messages` to an external compression service (headroom's
//! `/v1/compress` endpoint) and swaps in the compressed messages.
//!
//! Placement follows the Core-vs-Gateway rule: deciding *what is shared* with
//! the provider is a Gateway concern, so compression lives here, on the egress
//! path, as a swappable transform — not in Core. Because the default
//! OpenAI-compat chat path and the `ryu`/`pi`/`codex` ACP agents all already
//! route through the gateway, enabling this compresses all of them with no
//! per-agent wiring.
//!
//! It **fails open**: any error (service down, timeout, bad response) leaves the
//! original messages untouched so chat never breaks when headroom is absent.

use std::time::Duration;

use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::config::CompressionConfig;

/// Compress `body["messages"]` in place via the configured compression service.
///
/// No-ops (leaves `body` untouched) when: there is no `messages` array, the
/// conversation is shorter than `min_messages`, or the service errors in any
/// way. Returns the number of tokens saved when known (for metrics/logging),
/// or `None` when nothing was applied.
pub async fn maybe_compress(cfg: &CompressionConfig, body: &mut Value) -> Option<u64> {
    let messages = body.get("messages").and_then(Value::as_array)?;
    if messages.len() < cfg.min_messages {
        return None;
    }

    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let endpoint = format!("{}/v1/compress", cfg.url.trim_end_matches('/'));
    let payload = json!({ "messages": messages, "model": model });

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(cfg.timeout_ms))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            warn!("compression: client build failed, passthrough: {e}");
            return None;
        }
    };

    let mut req = client.post(&endpoint).json(&payload);
    if let Some(token) = cfg.token.as_deref().filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }

    let resp = match req.send().await {
        Ok(resp) if resp.status().is_success() => resp,
        Ok(resp) => {
            warn!(status = %resp.status(), "compression: service non-2xx, passthrough");
            return None;
        }
        Err(e) => {
            warn!("compression: request failed, passthrough: {e}");
            return None;
        }
    };

    let parsed: Value = match resp.json().await {
        Ok(value) => value,
        Err(e) => {
            warn!("compression: unreadable response, passthrough: {e}");
            return None;
        }
    };

    apply_compression(body, &parsed)
}

/// Apply a compression-service response to `body`, returning tokens saved when
/// available. Split out from the HTTP call so the swap logic is unit-testable.
///
/// Only swaps when the service reports `compressed: true` (or omits the flag)
/// and returns a non-empty `messages` array — a fail-open response that echoes
/// the original messages with `compressed: false` is left as a no-op.
fn apply_compression(body: &mut Value, parsed: &Value) -> Option<u64> {
    let compressed_flag = parsed
        .get("compressed")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !compressed_flag {
        return None;
    }

    let compressed = parsed
        .get("messages")
        .filter(|m| m.as_array().is_some_and(|arr| !arr.is_empty()))?;

    let before = parsed.get("tokens_before").and_then(Value::as_u64);
    let after = parsed.get("tokens_after").and_then(Value::as_u64);
    let saved = parsed
        .get("tokens_saved")
        .and_then(Value::as_u64)
        .or_else(|| match (before, after) {
            (Some(b), Some(a)) if b >= a => Some(b - a),
            _ => None,
        });
    debug!(?before, ?after, ?saved, "compression: applied");

    body["messages"] = compressed.clone();
    saved
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_with(messages: usize) -> Value {
        let msgs: Vec<Value> = (0..messages)
            .map(|i| json!({ "role": "user", "content": format!("m{i}") }))
            .collect();
        json!({ "model": "gpt-4o", "messages": msgs })
    }

    #[test]
    fn swaps_messages_and_reports_saved_tokens() {
        let mut body = body_with(6);
        let resp = json!({
            "messages": [{ "role": "user", "content": "compressed" }],
            "tokens_before": 100,
            "tokens_after": 30,
            "compressed": true,
        });
        let saved = apply_compression(&mut body, &resp);
        assert_eq!(saved, Some(70));
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["content"], "compressed");
    }

    #[test]
    fn fail_open_response_is_a_noop() {
        let mut body = body_with(6);
        let original = body.clone();
        // headroom's own client echoes the input with compressed:false on failure.
        let resp = json!({
            "messages": [{ "role": "user", "content": "echo" }],
            "compressed": false,
        });
        assert_eq!(apply_compression(&mut body, &resp), None);
        assert_eq!(body, original, "messages must be untouched on fail-open");
    }

    #[test]
    fn missing_messages_is_a_noop() {
        let mut body = body_with(6);
        let original = body.clone();
        let resp = json!({ "compressed": true, "tokens_saved": 10 });
        assert_eq!(apply_compression(&mut body, &resp), None);
        assert_eq!(body, original);
    }

    #[test]
    fn derives_saved_from_before_after_when_absent() {
        let mut body = body_with(6);
        let resp = json!({
            "messages": [{ "role": "user", "content": "c" }],
            "tokens_before": 50,
            "tokens_after": 20,
        });
        assert_eq!(apply_compression(&mut body, &resp), Some(30));
    }
}
