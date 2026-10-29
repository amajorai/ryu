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
//! Any error (service down, timeout, bad response) leaves the original
//! messages untouched and is reported as [`CompressionOutcome::Failed`]. A
//! self-hosted Gateway then sends them uncompressed, so chat never breaks when
//! headroom is absent; the hosted fleet refuses the request instead. The
//! pipeline re-screens the messages it swaps in (see `pipeline::edit_rescan`).

use std::time::Duration;

use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::config::CompressionConfig;

/// What one [`maybe_compress`] call did to the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionOutcome {
    /// Nothing to compress: no `messages` array, a conversation shorter than
    /// `min_messages`, or the service answered `compressed: false`.
    Skipped,
    /// `body["messages"]` was replaced with the service's messages.
    /// `tokens_saved` is set when the service reports or implies it.
    Applied { tokens_saved: Option<u64> },
    /// The service errored, timed out, answered non-2xx or returned an
    /// unusable body. `body` is untouched.
    Failed,
}

/// Compress `body["messages"]` in place via the configured compression service.
///
/// `body` is left untouched unless the outcome is
/// [`CompressionOutcome::Applied`].
pub async fn maybe_compress(
    client: &reqwest::Client,
    cfg: &CompressionConfig,
    body: &mut Value,
) -> CompressionOutcome {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return CompressionOutcome::Skipped;
    };
    if messages.len() < cfg.min_messages {
        return CompressionOutcome::Skipped;
    }

    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let endpoint = format!("{}/v1/compress", cfg.url.trim_end_matches('/'));
    let payload = json!({ "messages": messages, "model": model });

    let mut req = client
        .post(&endpoint)
        .timeout(Duration::from_millis(cfg.timeout_ms))
        .json(&payload);
    if let Some(token) = cfg.token.as_deref().filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }

    let resp = match req.send().await {
        Ok(resp) if resp.status().is_success() => resp,
        Ok(resp) => {
            warn!(status = %resp.status(), "compression: service non-2xx");
            return CompressionOutcome::Failed;
        }
        Err(e) => {
            warn!("compression: request failed: {e}");
            return CompressionOutcome::Failed;
        }
    };

    let parsed: Value = match resp.json().await {
        Ok(value) => value,
        Err(e) => {
            warn!("compression: unreadable response: {e}");
            return CompressionOutcome::Failed;
        }
    };

    apply_compression(body, &parsed)
}

/// Apply a compression-service response to `body`. Split out from the HTTP
/// call so the swap logic is unit-testable.
///
/// Only swaps when the service reports `compressed: true` (or omits the flag)
/// and returns a non-empty `messages` array of objects that each carry a role.
/// A response that echoes the original messages with `compressed: false` is
/// the service declining, so it is [`CompressionOutcome::Skipped`]; any other
/// unusable response is [`CompressionOutcome::Failed`].
fn apply_compression(body: &mut Value, parsed: &Value) -> CompressionOutcome {
    let compressed_flag = parsed
        .get("compressed")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !compressed_flag {
        return CompressionOutcome::Skipped;
    }

    let Some(compressed) = parsed.get("messages").filter(|messages| {
        messages.as_array().is_some_and(|messages| {
            !messages.is_empty()
                && messages.iter().all(|message| {
                    message.as_object().is_some()
                        && message
                            .get("role")
                            .and_then(Value::as_str)
                            .is_some_and(|role| !role.is_empty())
                })
        })
    }) else {
        return CompressionOutcome::Failed;
    };

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
    CompressionOutcome::Applied {
        tokens_saved: saved,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn requests_reuse_connection_and_keep_timeout_and_short_chat_behavior() {
        use axum::{extract::ConnectInfo, routing::post, Json, Router};
        use std::{
            collections::HashSet,
            net::SocketAddr,
            sync::{Arc, Mutex},
        };

        let peers = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&peers);
        let app = Router::new()
            .route("/v1/compress", post(move |ConnectInfo(peer): ConnectInfo<SocketAddr>| {
                let observed = Arc::clone(&observed);
                async move {
                    observed.lock().unwrap().push(peer);
                    Json(json!({"messages": [{"role": "user", "content": "short"}], "tokens_saved": 7}))
                }
            }))
            .route("/slow/v1/compress", post(|| async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                Json(json!({"messages": [{"role": "user", "content": "late"}]}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut cfg = CompressionConfig {
            url: format!("http://{address}"),
            timeout_ms: 1_000,
            ..CompressionConfig::default()
        };
        let mut short = body_with(1);
        assert_eq!(
            maybe_compress(&client, &cfg, &mut short).await,
            CompressionOutcome::Skipped
        );
        assert!(peers.lock().unwrap().is_empty());
        for _ in 0..2 {
            let mut body = body_with(6);
            assert_eq!(
                maybe_compress(&client, &cfg, &mut body).await,
                CompressionOutcome::Applied {
                    tokens_saved: Some(7)
                }
            );
            assert_eq!(body["messages"][0]["content"], "short");
        }
        {
            let peers = peers.lock().unwrap();
            assert_eq!(peers.len(), 2);
            assert_eq!(
                peers.iter().collect::<HashSet<_>>().len(),
                1,
                "sequential compressions must reuse one connection"
            );
        }
        cfg.url = format!("http://{address}/slow");
        cfg.timeout_ms = 10;
        let mut body = body_with(6);
        let original = body.clone();
        assert_eq!(
            maybe_compress(&client, &cfg, &mut body).await,
            CompressionOutcome::Failed
        );
        assert_eq!(
            body, original,
            "request timeout must retain the original messages"
        );
        server.abort();
    }

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
        assert_eq!(
            saved,
            CompressionOutcome::Applied {
                tokens_saved: Some(70)
            }
        );
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
        assert_eq!(
            apply_compression(&mut body, &resp),
            CompressionOutcome::Skipped
        );
        assert_eq!(body, original, "messages must be untouched on fail-open");
    }

    #[test]
    fn missing_messages_is_a_failure_and_leaves_the_body() {
        let mut body = body_with(6);
        let original = body.clone();
        let resp = json!({ "compressed": true, "tokens_saved": 10 });
        assert_eq!(
            apply_compression(&mut body, &resp),
            CompressionOutcome::Failed
        );
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
        assert_eq!(
            apply_compression(&mut body, &resp),
            CompressionOutcome::Applied {
                tokens_saved: Some(30)
            }
        );
    }
}
