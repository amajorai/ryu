use std::pin::Pin;

use axum::body::Body;
use serde_json::{json, Value};
use tracing::debug;

use crate::error::GatewayError;

use super::{chat_completions_url, check_response_status, check_stream_status, Provider};

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
    api_key: String,
    base_url: String,
    /// Sent as HTTP-Referer for OpenRouter usage attribution.
    site_url: String,
    /// Sent as X-Title for OpenRouter usage attribution.
    site_name: String,
    /// Managed server-side options injected into every request.
    options: OpenRouterOptions,
}

impl OpenRouterProvider {
    pub fn new(
        client: reqwest::Client,
        api_key: String,
        base_url: String,
        site_url: String,
        site_name: String,
        options: OpenRouterOptions,
    ) -> Self {
        Self {
            client,
            api_key,
            base_url,
            site_url,
            site_name,
            options,
        }
    }
}

impl Provider for OpenRouterProvider {
    fn name(&self) -> &'static str {
        "openrouter"
    }

    fn complete<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            self.options.apply(&mut payload);
            debug!(
                provider = "openrouter",
                model, "sending non-streaming request"
            );

            let resp = self
                .client
                .post(chat_completions_url(&self.base_url))
                .bearer_auth(&self.api_key)
                .header("HTTP-Referer", &self.site_url)
                .header("X-Title", &self.site_name)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    GatewayError::ProviderError(format!("openrouter request failed: {e}"))
                })?;

            check_response_status(resp, "openrouter").await
        })
    }

    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, GatewayError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(model.to_string());
            payload["stream"] = Value::Bool(true);
            self.options.apply(&mut payload);
            debug!(provider = "openrouter", model, "sending streaming request");

            let resp = self
                .client
                .post(chat_completions_url(&self.base_url))
                .bearer_auth(&self.api_key)
                .header("HTTP-Referer", &self.site_url)
                .header("X-Title", &self.site_name)
                .json(&payload)
                .send()
                .await
                .map_err(|e| {
                    GatewayError::ProviderError(format!("openrouter stream request failed: {e}"))
                })?;

            let resp = check_stream_status(resp, "openrouter").await?;
            Ok(Body::from_stream(resp.bytes_stream()))
        })
    }
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
}
