use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use serde_json::{json, Value};
use tracing::debug;

use crate::{error::ProviderError, quota::ProviderQuotas};

use super::{
    chat_completions_url, check_response_status, check_stream_status, discover_openai_models,
    models_from_response, Provider,
};

/// Server-side options ryu injects into every OpenRouter request. These map to
/// OpenRouter's own request fields (`provider`, `plugins`, `usage`) and let a
/// managed node enforce a privacy posture and get accurate cost accounting
/// without the caller having to configure anything. The `provider` privacy
/// fields are authoritative — a managed node's zero-data-collection / ZDR
/// guarantee must not be overridable by a caller's request body — while
/// plugins and usage accounting are only added when absent.
#[derive(Debug, Clone, Default)]
pub struct OpenRouterOptions {
    /// `provider.data_collection`: "allow" | "deny". `None` → field omitted (the
    /// default, so a BYOK caller's own routing is not overridden). Managed nodes
    /// set "deny" so prompts are never retained for training.
    pub data_collection: Option<String>,
    /// `provider.zdr`: require zero-data-retention endpoints. `None` → omitted.
    pub zdr: Option<bool>,
    /// `provider.sort`: "price" | "throughput" | "latency". `None` → omitted.
    pub sort: Option<String>,
    /// Add the `response-healing` plugin (repairs malformed JSON). Default off.
    pub response_healing: bool,
    /// Request legacy usage accounting (`usage: {include: true}`). Current
    /// OpenRouter returns `usage.cost` on every response unconditionally, so this
    /// is a harmless no-op there; it only matters for older or
    /// OpenRouter-compatible endpoints that still gate cost behind the flag.
    /// Default on for that compatibility.
    pub usage_accounting: bool,
}

impl OpenRouterOptions {
    /// Apply the configured server-side options to an outgoing chat payload.
    /// Defensive: a non-object payload (never produced by the chat path) is left
    /// untouched rather than panicking.
    pub fn apply(&self, payload: &mut Value) {
        let Some(obj) = payload.as_object_mut() else {
            return;
        };

        // provider routing / privacy — authoritative: overwrite whatever the
        // caller supplied so the managed posture always wins.
        if self.data_collection.is_some() || self.zdr.is_some() || self.sort.is_some() {
            let provider = obj
                .entry("provider")
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            if let Some(provider) = provider.as_object_mut() {
                if let Some(dc) = &self.data_collection {
                    provider.insert("data_collection".into(), Value::String(dc.clone()));
                }
                if let Some(zdr) = self.zdr {
                    provider.insert("zdr".into(), Value::Bool(zdr));
                }
                if let Some(sort) = &self.sort {
                    provider.insert("sort".into(), Value::String(sort.clone()));
                }
            }
        }

        // response-healing plugin — add once, never duplicate an existing entry.
        if self.response_healing {
            let plugins = obj
                .entry("plugins")
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(arr) = plugins.as_array_mut() {
                let present = arr
                    .iter()
                    .any(|p| p.get("id").and_then(Value::as_str) == Some("response-healing"));
                if !present {
                    arr.push(json!({ "id": "response-healing" }));
                }
            }
        }

        // usage accounting — so responses report the real `usage.cost` used for
        // at-cost credit metering. Additive: don't clobber a caller's own flag.
        if self.usage_accounting {
            let usage = obj.entry("usage").or_insert_with(|| json!({}));
            if let Some(usage_obj) = usage.as_object_mut() {
                usage_obj.entry("include").or_insert(json!(true));
            }
        }
    }
}

/// OpenRouter (https://openrouter.ai) — OpenAI-compatible API with access to
/// 200+ models from every major provider. Uses the same wire format as OpenAI,
/// just with two extra identification headers and ryu's managed [`OpenRouterOptions`].
pub struct OpenRouterProvider {
    client: reqwest::Client,
    /// Account rotation set (#4). See `OpenAiProvider::keys`.
    keys: Vec<String>,
    cursor: AtomicUsize,
    base_url: String,
    /// Sent as HTTP-Referer for OpenRouter usage attribution.
    site_url: String,
    /// Sent as X-Title for OpenRouter usage attribution.
    site_name: String,
    /// Managed server-side options injected into every request.
    options: OpenRouterOptions,
    quota: Arc<ProviderQuotas>,
}

impl OpenRouterProvider {
    pub fn new(
        client: reqwest::Client,
        keys: Vec<String>,
        base_url: String,
        site_url: String,
        site_name: String,
        options: OpenRouterOptions,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            client,
            keys,
            cursor: AtomicUsize::new(0),
            base_url,
            site_url,
            site_name,
            options,
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

    /// The primary account key, for non-rotating calls (model discovery, media).
    fn primary_key(&self) -> &str {
        self.keys.first().map(String::as_str).unwrap_or("")
    }
}

impl Provider for OpenRouterProvider {
    fn name(&self) -> &'static str {
        "openrouter"
    }

    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async move {
            let json =
                discover_openai_models(&self.client, &self.base_url, self.primary_key()).await?;
            models_from_response(json)
        })
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            self.options.apply(&mut payload);
            debug!(
                provider = "openrouter",
                model, "sending non-streaming request"
            );

            let url = chat_completions_url(&self.base_url);
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<ProviderError> = None;
            for _ in 0..attempts {
                let key = self.next_key();
                let resp = self
                    .client
                    .post(&url)
                    .bearer_auth(&key)
                    .header("HTTP-Referer", &self.site_url)
                    .header("X-Title", &self.site_name)
                    .json(&payload)
                    .send()
                    .await
                    .map_err(|e| {
                        ProviderError::Provider(format!("openrouter request failed: {e}"))
                    })?;

                match check_response_status(resp, "openrouter", Some(&self.quota)).await {
                    Err(e @ ProviderError::RateLimited { .. }) if attempts > 1 => {
                        last_err = Some(e);
                        continue;
                    }
                    other => return other,
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: "openrouter".to_string(),
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
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            payload["stream"] = Value::Bool(true);
            self.options.apply(&mut payload);
            debug!(provider = "openrouter", model, "sending streaming request");

            let url = chat_completions_url(&self.base_url);
            let attempts = self.keys.len().max(1);
            let mut last_err: Option<ProviderError> = None;
            for _ in 0..attempts {
                let key = self.next_key();
                let resp = self
                    .client
                    .post(&url)
                    .bearer_auth(&key)
                    .header("HTTP-Referer", &self.site_url)
                    .header("X-Title", &self.site_name)
                    .json(&payload)
                    .send()
                    .await
                    .map_err(|e| {
                        ProviderError::Provider(format!("openrouter stream request failed: {e}"))
                    })?;

                match check_stream_status(resp, "openrouter", Some(&self.quota)).await {
                    Err(e @ ProviderError::RateLimited { .. }) if attempts > 1 => {
                        last_err = Some(e);
                        continue;
                    }
                    Err(e) => return Err(e),
                    Ok(resp) => return Ok(Body::from_stream(resp.bytes_stream())),
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: "openrouter".to_string(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    /// Image generation via OpenRouter's chat-completions image *output modality*
    /// — OpenRouter has no OpenAI-style `/images/generations` endpoint. We turn
    /// the image request into a chat call with `modalities: ["image", "text"]`,
    /// then extract the returned image parts
    /// (`choices[].message.images[].image_url.url`, usually a base64 data URL)
    /// into the OpenAI-ish `{ "data": [{ "url": … }] }` shape.
    ///
    /// A caller that already provides `messages` (full chat control) has them
    /// forwarded verbatim; otherwise the `prompt` becomes a single user message.
    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = if body.get("messages").is_some() {
                body.clone()
            } else {
                let prompt = body.get("prompt").and_then(Value::as_str).unwrap_or("");
                json!({ "messages": [{ "role": "user", "content": prompt }] })
            };
            payload["model"] = Value::String(model.to_string());
            // Request image output. Don't clobber a caller-supplied modalities.
            if payload.get("modalities").is_none() {
                payload["modalities"] = json!(["image", "text"]);
            }
            self.options.apply(&mut payload);
            debug!(
                provider = "openrouter",
                model, "sending image generation (chat) request"
            );

            let resp = self
                .client
                .post(chat_completions_url(&self.base_url))
                .bearer_auth(self.primary_key())
                .header("HTTP-Referer", &self.site_url)
                .header("X-Title", &self.site_name)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    ProviderError::Provider(format!("openrouter image request failed: {e}"))
                })?;

            let json = check_response_status(resp, "openrouter", None).await?;
            Ok(extract_chat_images(&json))
        })
    }
}

/// Pull image parts out of an OpenRouter chat-completions response into the
/// OpenAI images `{ "data": [{ "url": … }], "raw": <response> }` shape. Images
/// live at `choices[].message.images[].image_url.url` (base64 data URLs).
fn extract_chat_images(response: &Value) -> Value {
    let mut data: Vec<Value> = Vec::new();
    if let Some(choices) = response["choices"].as_array() {
        for choice in choices {
            if let Some(images) = choice["message"]["images"].as_array() {
                for img in images {
                    if let Some(url) = img["image_url"]["url"].as_str() {
                        data.push(json!({ "url": url }));
                    } else if let Some(url) = img["url"].as_str() {
                        data.push(json!({ "url": url }));
                    }
                }
            }
        }
    }
    json!({ "data": data, "raw": response.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_injects_privacy_plugins_and_usage() {
        let opts = OpenRouterOptions {
            data_collection: Some("deny".into()),
            zdr: Some(true),
            sort: Some("throughput".into()),
            response_healing: true,
            usage_accounting: true,
        };
        let mut payload = json!({ "model": "openrouter/auto", "messages": [] });
        opts.apply(&mut payload);

        assert_eq!(payload["provider"]["data_collection"], json!("deny"));
        assert_eq!(payload["provider"]["zdr"], json!(true));
        assert_eq!(payload["provider"]["sort"], json!("throughput"));
        assert_eq!(payload["usage"]["include"], json!(true));
        let plugins = payload["plugins"].as_array().expect("plugins array");
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0]["id"], json!("response-healing"));
    }

    #[test]
    fn apply_privacy_overrides_caller_but_keeps_other_provider_fields() {
        let opts = OpenRouterOptions {
            data_collection: Some("deny".into()),
            ..Default::default()
        };
        // Caller tries to opt back into data collection and set an order pref.
        let mut payload = json!({
            "provider": { "data_collection": "allow", "order": ["openai"] }
        });
        opts.apply(&mut payload);
        // Managed posture wins on the privacy field...
        assert_eq!(payload["provider"]["data_collection"], json!("deny"));
        // ...but unrelated caller routing is preserved.
        assert_eq!(payload["provider"]["order"], json!(["openai"]));
    }

    #[test]
    fn apply_does_not_duplicate_response_healing_or_clobber_usage() {
        let opts = OpenRouterOptions {
            response_healing: true,
            usage_accounting: true,
            ..Default::default()
        };
        let mut payload = json!({
            "plugins": [{ "id": "response-healing" }],
            "usage": { "include": false }
        });
        opts.apply(&mut payload);
        assert_eq!(payload["plugins"].as_array().unwrap().len(), 1);
        // Caller's explicit usage flag is not overwritten.
        assert_eq!(payload["usage"]["include"], json!(false));
    }

    #[test]
    fn apply_omits_fields_when_unset() {
        let opts = OpenRouterOptions::default();
        let mut payload = json!({ "model": "x", "messages": [] });
        opts.apply(&mut payload);
        assert!(payload.get("provider").is_none());
        assert!(payload.get("plugins").is_none());
        assert!(payload.get("usage").is_none());
    }

    #[test]
    fn apply_leaves_non_object_payload_untouched() {
        let opts = OpenRouterOptions {
            data_collection: Some("deny".into()),
            ..Default::default()
        };
        let mut payload = json!("not an object");
        opts.apply(&mut payload);
        assert_eq!(payload, json!("not an object"));
    }

    #[test]
    fn extract_chat_images_reads_image_url_and_bare_url() {
        let resp = json!({
            "choices": [{
                "message": {
                    "images": [
                        { "image_url": { "url": "data:image/png;base64,AAA" } },
                        { "url": "https://x/b.png" }
                    ]
                }
            }]
        });
        let out = extract_chat_images(&resp);
        let data = out["data"].as_array().unwrap();
        assert_eq!(data.len(), 2);
        assert_eq!(data[0]["url"], json!("data:image/png;base64,AAA"));
        assert_eq!(data[1]["url"], json!("https://x/b.png"));
        // Full response preserved under `raw`.
        assert!(out["raw"]["choices"].is_array());
    }

    #[test]
    fn extract_chat_images_empty_when_no_images() {
        let out = extract_chat_images(&json!({ "choices": [{ "message": { "content": "hi" } }] }));
        assert_eq!(out["data"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn next_key_rotates_and_primary_is_first() {
        let p = provider_with("http://x".into(), vec!["a", "b"], OpenRouterOptions::default());
        assert_eq!(p.primary_key(), "a");
        assert_eq!(p.next_key(), "a");
        assert_eq!(p.next_key(), "b");
    }

    // ── async request-shaping tests over a local mock server ──────────────────
    use crate::test_support::{MockResponse, MockServer};

    fn provider_with(
        base_url: String,
        keys: Vec<&str>,
        options: OpenRouterOptions,
    ) -> OpenRouterProvider {
        OpenRouterProvider::new(
            reqwest::Client::new(),
            keys.into_iter().map(String::from).collect(),
            base_url,
            "https://ryu.example".to_string(),
            "Ryu".to_string(),
            options,
            Arc::new(ProviderQuotas::new()),
        )
    }

    #[tokio::test]
    async fn complete_sends_attribution_headers_and_applies_options() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"or"}"#)).await;
        let opts = OpenRouterOptions {
            data_collection: Some("deny".into()),
            ..Default::default()
        };
        let p = provider_with(server.base_url().to_string(), vec!["sk-or"], opts);
        let out = p
            .complete("anthropic/claude-3", &json!({ "messages": [] }))
            .await
            .unwrap();
        assert_eq!(out["id"], json!("or"));

        let reqs = server.requests();
        assert_eq!(reqs[0].header("http-referer").as_deref(), Some("https://ryu.example"));
        assert_eq!(reqs[0].header("x-title").as_deref(), Some("Ryu"));
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer sk-or")
        );
        // Managed privacy posture is injected into the outgoing body.
        assert_eq!(reqs[0].json()["provider"]["data_collection"], json!("deny"));
        assert_eq!(reqs[0].json()["model"], json!("anthropic/claude-3"));
    }

    #[tokio::test]
    async fn complete_error_does_not_leak_key() {
        const SECRET: &str = "sk-or-SECRET-abcdef";
        let server =
            MockServer::always(MockResponse::json(402, r#"{"error":{"message":"no credits"}}"#))
                .await;
        let p = provider_with(server.base_url().to_string(), vec![SECRET], Default::default());
        let err = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .unwrap_err();
        let rendered = format!("{err}{err:?}");
        assert!(!rendered.contains(SECRET), "leaked: {rendered}");
        assert!(rendered.contains("no credits"));
    }

    #[tokio::test]
    async fn generate_image_builds_chat_call_and_extracts_images() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"choices":[{"message":{"images":[{"image_url":{"url":"data:image/png;base64,ZZ"}}]}}]}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let out = p
            .generate_image("google/gemini-2.5-flash-image", &json!({ "prompt": "a fox" }))
            .await
            .unwrap();
        assert_eq!(out["data"][0]["url"], json!("data:image/png;base64,ZZ"));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/chat/completions");
        let sent = reqs[0].json();
        // prompt became a user message and image modality was requested.
        assert_eq!(sent["messages"][0]["content"], json!("a fox"));
        assert_eq!(sent["modalities"], json!(["image", "text"]));
    }
}
