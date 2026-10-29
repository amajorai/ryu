use std::collections::HashSet;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use axum::body::Body;
use serde_json::{json, Value};
use tracing::{debug, warn};

use crate::{error::ProviderError, quota::ProviderQuotas};

use super::{
    account_pool::AccountPool, chat_completions_url, check_completion_response,
    check_response_status, check_service_response, check_stream_status, classify_send_error,
    discover_openai_models_at, embeddings_url, is_credential_status, models_from_response,
    parse_account_quota, parse_quota_domain, parse_rate_limit, read_credential_refusal, rerank_url,
    response_body::BoundedResponse, service_audio_response, streaming_request, AcceptedVideo,
    BatchCreateRequest, BatchListQuery, BatchProvider, BatchProviderError, EgressClientPool,
    JobStatus, Provider, RateLimitInfo, VideoJob, VideoPollError, VideoPollFuture, VideoPollOrigin,
};

const MAX_BATCH_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

/// Returned (as a 504) when a batch request was sent but its outcome is
/// unknown. A resubmitted batch is a separate billed batch, so the caller must
/// check what already exists first.
const BATCH_DELIVERY_UNCERTAIN: &str = "OpenRouter did not confirm the batch request; it may \
     already have taken effect, so list batches before resubmitting";

const OPENROUTER_APP_CATEGORIES: &str = "personal-agent";

/// A completed OpenRouter video can be served only from the authenticated
/// content endpoint, so the poller inlines it. A larger result fails the job
/// instead of holding an unbounded body in the job store.
const MAX_INLINE_VIDEO_BYTES: usize = 48 * 1024 * 1024;

/// The job error for a completed video that exceeds [`MAX_INLINE_VIDEO_BYTES`].
const VIDEO_TOO_LARGE: &str = "OpenRouter video exceeds the 48 MiB inline delivery limit";

/// Waits before each read of a speech generation's cost record. OpenRouter's
/// Speech API answers with raw audio and no cost, and the generation record that
/// carries the cost can lag the response briefly.
const GENERATION_COST_RETRY_DELAYS_MS: [u64; 4] = [0, 250, 750, 1_500];

/// Each cost-record read is bounded so a slow record endpoint adds at most
/// about 14.5 s (four attempts plus the waits) to an already-delivered reply.
const GENERATION_COST_ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// OpenRouter's own router slugs (`openrouter/auto`) are real upstream model
/// ids, but `openrouter/<vendor>/<model>` is Ryu's routing form for a catalog
/// slug and must reach OpenRouter as `<vendor>/<model>`.
fn upstream_model(model: &str) -> &str {
    match model.strip_prefix("openrouter/") {
        Some(slug) if slug.contains('/') => slug,
        _ => model,
    }
}

/// Server-side options ryu injects into every OpenRouter request. These map to
/// OpenRouter's own request fields (`provider`, `plugins`, `usage`) and let a
/// managed node enforce a privacy posture and get accurate cost accounting
/// without the caller having to configure anything. The `provider` privacy
/// fields are authoritative — a managed node's zero-data-collection / ZDR
/// guarantee must not be overridable by a caller's request body — while
/// plugins and usage accounting are only added when absent.
#[derive(Debug, Clone, Default)]
pub struct OpenRouterOptions {
    /// Legacy configuration input. Outbound requests always use "deny".
    pub data_collection: Option<String>,
    /// Legacy configuration input. Outbound requests always require ZDR.
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
    /// Apply only routing/privacy fields. Embeddings and reranking accept the
    /// provider object too, but do not accept chat-only `plugins` or `usage`.
    pub fn apply_provider_routing(&self, payload: &mut Value) {
        let Some(obj) = payload.as_object_mut() else {
            return;
        };

        // ZDR is standard for every user. Legacy config and caller opt-outs
        // cannot weaken the outbound privacy policy.
        {
            let provider = obj
                .entry("provider")
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            if !provider.is_object() {
                *provider = json!({});
            }
            if let Some(provider) = provider.as_object_mut() {
                provider.insert("data_collection".into(), json!("deny"));
                provider.insert("zdr".into(), json!(true));
                if let Some(sort) = &self.sort {
                    provider.insert("sort".into(), Value::String(sort.clone()));
                }
            }
        }
    }

    /// Apply the configured server-side options to an outgoing chat payload.
    /// Defensive: a non-object payload (never produced by the chat path) is left
    /// untouched rather than panicking.
    pub fn apply(&self, payload: &mut Value) {
        self.apply_provider_routing(payload);
        let Some(obj) = payload.as_object_mut() else {
            return;
        };

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
    egress: Option<Arc<EgressClientPool>>,
    /// Account rotation set (#4). See `OpenAiProvider::keys`.
    keys: Vec<String>,
    account_pool: AccountPool,
    base_url: String,
    /// Sent as HTTP-Referer for OpenRouter usage attribution.
    site_url: String,
    /// Sent as X-Title for OpenRouter usage attribution.
    site_name: String,
    /// Managed server-side options injected into every request.
    options: OpenRouterOptions,
    quota: Arc<ProviderQuotas>,
    /// Chat models whose output includes audio (music and voice models such as
    /// Lyria or GPT Audio), learned from discovery. Speech requests for them
    /// use streamed chat audio instead of the dedicated speech endpoint.
    audio_output_models: RwLock<AudioCatalog>,
}

/// Chat models with audio output, and when the list was last refreshed.
#[derive(Default)]
struct AudioCatalog {
    ids: HashSet<String>,
    refreshed: Option<std::time::Instant>,
}

/// A speech request refreshes the audio-model list at most this often, so a
/// node that never ran full discovery still recognizes new music models.
const AUDIO_CATALOG_TTL: std::time::Duration = std::time::Duration::from_secs(3600);
/// After a failed refresh, retry no sooner than this.
const AUDIO_CATALOG_RETRY: std::time::Duration = std::time::Duration::from_secs(300);

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
        Self::new_with_egress(
            client, None, keys, base_url, site_url, site_name, options, quota,
        )
    }

    pub fn new_with_egress(
        client: reqwest::Client,
        egress: Option<Arc<EgressClientPool>>,
        keys: Vec<String>,
        base_url: String,
        site_url: String,
        site_name: String,
        options: OpenRouterOptions,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self {
            client,
            egress,
            account_pool: AccountPool::new(keys.len()),
            keys,
            base_url,
            site_url,
            site_name,
            options,
            quota,
            audio_output_models: RwLock::new(AudioCatalog::default()),
        }
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

    /// The primary account key, for non-rotating calls (model discovery, media).
    #[cfg(test)]
    fn primary_key(&self) -> &str {
        self.keys.first().map(String::as_str).unwrap_or("")
    }

    fn batches_url(&self) -> String {
        format!("{}/batches", self.base_url.trim_end_matches('/'))
    }

    fn batch_url(&self, id: &str) -> String {
        format!("{}/{}", self.batches_url(), id)
    }

    async fn send_batch_request(
        &self,
        method: reqwest::Method,
        url: String,
        configure: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, BatchProviderError> {
        // Batch IDs belong to the submitting account. Keep the primary account
        // stable for all batch lifecycle operations and honor live account policy.
        let key = self
            .keys
            .first()
            .filter(|_| self.account_pool.is_available(0))
            .ok_or_else(|| BatchProviderError {
                status: 503,
                message: "OpenRouter primary batch account is unavailable".to_owned(),
                retry_after: None,
            })?;
        self.send_request(None, "OpenRouter batch", |client| {
            configure(
                self.add_attribution_headers(client.request(method.clone(), &url).bearer_auth(key)),
            )
        })
        .await
        .map_err(|error| match error {
            // A timeout or broken connection after sending: OpenRouter may
            // already have created (or deleted) the batch, and a blind resubmit
            // would start a second billed batch. Never report it as unreachable.
            ProviderError::DeliveryUncertain(_) => BatchProviderError {
                status: 504,
                message: if method == reqwest::Method::GET {
                    "OpenRouter batch request timed out before the provider answered".to_owned()
                } else {
                    BATCH_DELIVERY_UNCERTAIN.to_owned()
                },
                retry_after: None,
            },
            // Connection failures, cooling egress endpoints, and egress proxy
            // rejections never reached OpenRouter, so a retry is safe.
            _ => BatchProviderError {
                status: 502,
                message: "OpenRouter batch request could not reach the provider".to_owned(),
                retry_after: None,
            },
        })
    }

    /// Identify the configured app (`site_url` / `site_name`, Ryu by default) in
    /// OpenRouter's rankings and marketplace. Keep the legacy title header while
    /// OpenRouter supports it for older clients. An operator who blanks both
    /// values sends no app identity: no referer, titles, or app categories.
    fn add_attribution_headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let site_url = self.site_url.trim();
        let site_name = self.site_name.trim();
        let mut request = request;
        if !site_url.is_empty() {
            request = request.header("HTTP-Referer", site_url);
        }
        if !site_name.is_empty() {
            request = request
                .header("X-OpenRouter-Title", site_name)
                .header("X-Title", site_name);
        }
        if !site_url.is_empty() || !site_name.is_empty() {
            request = request.header("X-OpenRouter-Categories", OPENROUTER_APP_CATEGORIES);
        }
        request.header("X-OpenRouter-Metadata", "enabled")
    }

    fn egress_client(
        &self,
        session: Option<&str>,
    ) -> Result<(Option<usize>, &reqwest::Client), ProviderError> {
        if let Some(pool) = &self.egress {
            let (index, client) = pool.candidates(session).into_iter().next().ok_or_else(|| {
                ProviderError::Transport(
                    "all configured egress endpoints are cooling down".to_owned(),
                )
            })?;
            Ok((Some(index), client))
        } else {
            Ok((None, &self.client))
        }
    }

    async fn send_request(
        &self,
        session: Option<&str>,
        context: &str,
        make_request: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, ProviderError> {
        self.send_request_captured(session, context, make_request)
            .await
            .map(|(response, _)| response)
    }

    /// [`Self::send_request`], also returning the exact client that carried
    /// the request so accepted async work can keep polling through it.
    async fn send_request_captured(
        &self,
        session: Option<&str>,
        context: &str,
        make_request: impl Fn(&reqwest::Client) -> reqwest::RequestBuilder,
    ) -> Result<(reqwest::Response, reqwest::Client), ProviderError> {
        let (index, client) = self.egress_client(session)?;
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
        result.map(|response| (response, client.clone()))
    }

    fn api_url(&self, path: &str) -> String {
        format!("{}/{path}", self.base_url.trim_end_matches('/'))
    }

    /// Send one media request. A definitive pre-acceptance rejection (429 or
    /// 402) moves to the next eligible account; the last eligible account's
    /// response is returned unread so the caller's status mapping classifies it.
    async fn send_media_request(
        &self,
        session: Option<&str>,
        context: &str,
        make_request: impl Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    ) -> Result<MediaResponse, ProviderError> {
        let candidates: Vec<usize> = self
            .account_pool
            .candidates(session)
            .into_iter()
            .filter(|index| self.account_pool.is_available(*index))
            .collect();
        let Some((&last, earlier)) = candidates.split_last() else {
            return Err(ProviderError::RateLimited {
                provider: "openrouter".to_owned(),
                retry_after: None,
                reset_at: None,
            });
        };
        for &index in earlier {
            let (response, client) = self
                .send_media_to(index, session, context, &make_request)
                .await?;
            let status = response.status();
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = parse_rate_limit(response.headers()).and_then(|l| l.retry_after);
                self.account_pool.record_rate_limit(index, retry_after);
                continue;
            }
            if status == reqwest::StatusCode::PAYMENT_REQUIRED {
                self.account_pool.record_rate_limit(index, None);
                continue;
            }
            return Ok(MediaResponse::new(index, response, client));
        }
        let (response, client) = self
            .send_media_to(last, session, context, &make_request)
            .await?;
        Ok(MediaResponse::new(last, response, client))
    }

    async fn send_media_to(
        &self,
        index: usize,
        session: Option<&str>,
        context: &str,
        make_request: &impl Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    ) -> Result<(reqwest::Response, reqwest::Client), ProviderError> {
        let key = &self.keys[index];
        let (response, client) = self
            .send_request_captured(session, context, |client| make_request(client, key))
            .await?;
        if let Some(domain) = parse_quota_domain(response.headers()) {
            self.account_pool.record_quota_domain(index, domain);
        }
        Ok((response, client))
    }

    /// Record the outcome of a media request against the account that served it.
    fn settle_media_account<T>(
        &self,
        index: usize,
        session: Option<&str>,
        quota: Option<&RateLimitInfo>,
        result: &Result<T, ProviderError>,
    ) {
        match result {
            Ok(_) => {
                if let Some(info) = quota {
                    self.account_pool.record_quota(index, info);
                }
                self.account_pool.record_success(session, index);
            }
            Err(ProviderError::RateLimited { retry_after, .. }) => {
                self.account_pool.record_rate_limit(index, *retry_after);
            }
            Err(ProviderError::PaymentRequired { .. }) => {
                self.account_pool.record_rate_limit(index, None);
            }
            Err(_) => {}
        }
    }

    /// POST a JSON media request and parse its JSON reply. Accepted work that
    /// cannot be decoded is reported as uncertain delivery, never retried.
    async fn post_media_json(
        &self,
        path: &str,
        payload: &Value,
        context: &str,
    ) -> Result<Value, ProviderError> {
        let url = self.api_url(path);
        let MediaResponse {
            index,
            response,
            quota,
            ..
        } = self
            .send_media_request(None, context, |client, key| {
                self.add_attribution_headers(client.post(&url))
                    .bearer_auth(key)
                    .json(payload)
            })
            .await?;
        let result = check_service_response(response, "openrouter", Some(&self.quota)).await;
        self.settle_media_account(index, None, quota.as_ref(), &result);
        result
    }

    /// Image generation through OpenRouter's dedicated Images API. Models the
    /// Images API does not serve (404) fall back to the chat image modality.
    async fn generate_image_via_images_api(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<Value, ProviderError> {
        if !body
            .get("prompt")
            .and_then(Value::as_str)
            .is_some_and(|prompt| !prompt.trim().is_empty())
        {
            return Err(ProviderError::Provider(
                "OpenRouter image generation requires a prompt".to_owned(),
            ));
        }
        let mut payload = body.clone();
        payload["model"] = Value::String(upstream_model(model).to_owned());
        if let Some(fields) = payload.as_object_mut() {
            // OpenAI's `response_format` (url | b64_json) has no Images API
            // equivalent; results are always inline base64.
            fields.remove("response_format");
            fields.remove("stream");
        }
        self.options.apply_provider_routing(&mut payload);
        debug!(
            provider = "openrouter",
            model, "sending image generation request"
        );

        let url = self.api_url("images");
        let MediaResponse {
            index,
            response,
            quota,
            ..
        } = self
            .send_media_request(None, "openrouter image request failed", |client, key| {
                self.add_attribution_headers(client.post(&url))
                    .bearer_auth(key)
                    .json(&payload)
            })
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            let _ = response.bounded_bytes().await;
            return self.generate_image_via_chat(model, body).await;
        }
        let result = check_service_response(response, "openrouter", Some(&self.quota)).await;
        self.settle_media_account(index, None, quota.as_ref(), &result);
        result
    }

    /// Image generation via the chat-completions image *output modality*. A
    /// caller that already provides `messages` (full chat control) has them
    /// forwarded verbatim; otherwise the `prompt` becomes a single user
    /// message. Image parts are extracted into `{ "data": [{ "url": … }] }`.
    async fn generate_image_via_chat(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<Value, ProviderError> {
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

        let json = self.complete(model, &payload).await?;
        Ok(extract_chat_images(&json))
    }

    async fn wants_chat_audio(&self, model: &str, body: &Value) -> bool {
        if opts_into_chat_audio(body) {
            return true;
        }
        self.refresh_audio_catalog_if_stale().await;
        self.audio_output_models
            .read()
            .is_ok_and(|catalog| catalog.ids.contains(upstream_model(model)))
    }

    fn record_audio_catalog(&self, ids: HashSet<String>) {
        if let Ok(mut catalog) = self.audio_output_models.write() {
            catalog.ids = ids;
            catalog.refreshed = Some(std::time::Instant::now());
        }
    }

    /// Load the audio-output model list on demand. It is small (OpenRouter
    /// filters it server-side) and complements full catalog discovery.
    async fn refresh_audio_catalog_if_stale(&self) {
        let stale = self.audio_output_models.read().is_ok_and(|catalog| {
            catalog
                .refreshed
                .is_none_or(|refreshed| refreshed.elapsed() >= AUDIO_CATALOG_TTL)
        });
        if !stale {
            return;
        }
        let Ok((_, client)) = self.egress_client(None) else {
            return;
        };
        let Some(index) = self.account_pool.candidates(None).into_iter().next() else {
            return;
        };
        let url = format!(
            "{}/models?output_modalities=audio",
            self.base_url.trim_end_matches('/')
        );
        let ids = discover_openai_models_at(client, &url, &self.keys[index])
            .await
            .and_then(|json| json.get("data").and_then(Value::as_array).cloned())
            .map(|models| {
                models
                    .iter()
                    .filter(|model| produces_chat_audio(model))
                    .filter_map(|model| model["id"].as_str().map(str::to_owned))
                    .collect::<HashSet<_>>()
            });
        match ids {
            Some(ids) => self.record_audio_catalog(ids),
            None => {
                // Keep the previous list and back off before the next attempt.
                if let Ok(mut catalog) = self.audio_output_models.write() {
                    let now = std::time::Instant::now();
                    catalog.refreshed = Some(
                        now.checked_sub(AUDIO_CATALOG_TTL - AUDIO_CATALOG_RETRY)
                            .unwrap_or(now),
                    );
                }
            }
        }
    }

    /// Text-to-speech through OpenRouter's `/audio/speech`, which answers with
    /// raw audio bytes in mp3 or pcm. The cost comes from the generation record
    /// named by the reply's `x-generation-id` header.
    async fn synthesize_via_speech_api(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<Value, ProviderError> {
        let mut payload = body.clone();
        payload["model"] = Value::String(upstream_model(model).to_owned());
        if let Some(fields) = payload.as_object_mut() {
            // Chat-only fields have no meaning for the Speech API.
            fields.remove("messages");
            fields.remove("modalities");
        }
        // OpenRouter speech returns mp3 or pcm only. Other formats (wav, opus,
        // aac, flac) are served as mp3; the envelope reports the real type.
        let supported = payload
            .get("response_format")
            .and_then(Value::as_str)
            .is_some_and(|format| matches!(format, "mp3" | "pcm"));
        if !supported {
            payload["response_format"] = Value::String("mp3".to_owned());
        }
        self.options.apply_provider_routing(&mut payload);
        debug!(provider = "openrouter", model, "sending TTS request");

        let url = self.api_url("audio/speech");
        let MediaResponse {
            index,
            response,
            quota,
            client,
        } = self
            .send_media_request(None, "openrouter speech request failed", |client, key| {
                self.add_attribution_headers(client.post(&url))
                    .bearer_auth(key)
                    .json(&payload)
            })
            .await?;
        let generation = speech_generation_id(response.headers());
        let result = service_audio_response(response, "openrouter", Some(&self.quota)).await;
        self.settle_media_account(index, None, quota.as_ref(), &result);
        let mut envelope = result?;
        // The raw-audio reply has no `usage`; without the recorded cost the
        // Gateway would bill a per-character-priced speech model at its flat
        // speech rate. This is not gated on `usage_accounting`, which only
        // toggles the legacy chat `usage.include` flag.
        let cost = match generation {
            Some(id) => self.generation_cost(&client, index, &id).await,
            None => None,
        };
        match cost {
            Some(cost) => envelope["usage"] = json!({ "cost": cost }),
            None => warn!(
                provider = "openrouter",
                model,
                "OpenRouter speech cost was not available; the configured speech rate applies"
            ),
        }
        Ok(envelope)
    }

    /// The cost OpenRouter recorded for one generation, read with the account
    /// and connection that made it. A record that is not written yet (404), a
    /// rate limit, or a transient upstream failure is retried briefly.
    async fn generation_cost(
        &self,
        client: &reqwest::Client,
        index: usize,
        id: &str,
    ) -> Option<f64> {
        let url =
            reqwest::Url::parse_with_params(&self.api_url("generation"), [("id", id)]).ok()?;
        for delay in GENERATION_COST_RETRY_DELAYS_MS {
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            let Ok(response) = self
                .add_attribution_headers(client.get(url.clone()))
                .bearer_auth(&self.keys[index])
                .timeout(GENERATION_COST_ATTEMPT_TIMEOUT)
                .send()
                .await
            else {
                continue;
            };
            let status = response.status();
            if status == reqwest::StatusCode::NOT_FOUND
                || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || status.is_server_error()
            {
                let _ = response.bounded_bytes().await;
                continue;
            }
            if !status.is_success() {
                return None;
            }
            let body = response.bounded_bytes().await.ok()?;
            return generation_total_cost(&serde_json::from_slice::<Value>(&body).ok()?);
        }
        None
    }

    /// Audio generation (music, expressive voice) from chat models with an
    /// audio output modality. OpenRouter streams audio output only, so the
    /// stream is collected into the same audio envelope as `/audio/speech`.
    ///
    /// The chat messages are always built from `input` and `instructions`, the
    /// speech fields the Gateway's firewall, locked guardrails, and companion
    /// redaction inspect. Caller `messages` are never forwarded, so a speech
    /// request cannot carry an uninspected chat conversation.
    async fn synthesize_via_chat(&self, model: &str, body: &Value) -> Result<Value, ProviderError> {
        let format = chat_audio_format(body);
        let mut messages = Vec::new();
        if let Some(instructions) = body
            .get("instructions")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        {
            messages.push(json!({ "role": "system", "content": instructions }));
        }
        messages.push(json!({ "role": "user", "content": speech_prompt(body)? }));
        let mut audio = json!({ "format": format });
        if let Some(voice) = body
            .pointer("/audio/voice")
            .or_else(|| body.get("voice"))
            .and_then(Value::as_str)
        {
            audio["voice"] = Value::String(voice.to_owned());
        }
        let mut payload = json!({
            "model": upstream_model(model),
            "messages": messages,
            "modalities": chat_audio_modalities(body),
            "audio": audio,
            "stream": true,
        });
        for key in ["provider", "user", "session_id"] {
            if let Some(value) = body.get(key) {
                payload[key] = value.clone();
            }
        }
        self.options.apply(&mut payload);
        debug!(
            provider = "openrouter",
            model, "sending audio generation (chat) request"
        );

        let url = chat_completions_url(&self.base_url);
        let MediaResponse {
            index,
            response,
            quota,
            ..
        } = self
            .send_media_request(None, "openrouter audio request failed", |client, key| {
                self.add_attribution_headers(client.post(&url))
                    .bearer_auth(key)
                    .json(&payload)
            })
            .await?;
        let accepted = check_stream_status(response, "openrouter", Some(&self.quota)).await;
        self.settle_media_account(index, None, quota.as_ref(), &accepted);
        let stream = accepted?.bounded_text().await.map_err(|_| {
            ProviderError::DeliveryUncertain(
                "openrouter accepted audio stream could not be read".to_owned(),
            )
        })?;
        collect_chat_audio(&stream, format)
    }

    /// Speech-to-text through OpenRouter's JSON `/audio/transcriptions`. Core
    /// carries audio as base64 `file`; it is forwarded as `input_audio`.
    async fn transcribe_via_stt_api(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<Value, ProviderError> {
        let input_audio = match body.get("input_audio") {
            Some(input) => input.clone(),
            None => stt_input_audio(body)?,
        };
        let mut payload = json!({
            "model": upstream_model(model),
            "input_audio": input_audio,
        });
        for key in [
            "language",
            "temperature",
            "timestamp_granularities",
            "diarize",
            "keyterms",
            "provider",
            "user",
            "session_id",
        ] {
            if let Some(value) = body.get(key).filter(|value| !value.is_null()) {
                payload[key] = value.clone();
            }
        }
        // OpenRouter answers in JSON only. Text, SRT, and VTT requests receive
        // the JSON transcript (`text`) rather than an upstream rejection.
        if let Some(format) = body
            .get("response_format")
            .and_then(Value::as_str)
            .filter(|format| matches!(*format, "json" | "verbose_json"))
        {
            payload["response_format"] = Value::String(format.to_owned());
        }
        self.options.apply_provider_routing(&mut payload);
        debug!(provider = "openrouter", model, "sending STT request");
        self.post_media_json(
            "audio/transcriptions",
            &payload,
            "openrouter transcription request failed",
        )
        .await
    }

    /// Submit an asynchronous OpenRouter video job. Submission is never
    /// replayed after the upstream could have accepted it.
    async fn submit_video(
        &self,
        model: &str,
        body: &Value,
    ) -> Result<AcceptedVideo, ProviderError> {
        let mut payload = body.clone();
        let Some(fields) = payload.as_object_mut() else {
            return Err(ProviderError::Provider(
                "OpenRouter video request must be an object".to_owned(),
            ));
        };
        if fields
            .get("n")
            .is_some_and(|n| !n.is_null() && n.as_u64() != Some(1))
        {
            return Err(ProviderError::Provider(
                "OpenRouter video generation accepts one video per request".to_owned(),
            ));
        }
        fields.remove("n");
        fields.remove("response_format");
        payload["model"] = Value::String(upstream_model(model).to_owned());
        self.options.apply_provider_routing(&mut payload);
        debug!(
            provider = "openrouter",
            model, "submitting video generation job"
        );

        let url = self.api_url("videos");
        let MediaResponse {
            index,
            response,
            quota,
            client,
        } = self
            .send_media_request(None, "openrouter video request failed", |client, key| {
                self.add_attribution_headers(client.post(&url))
                    .bearer_auth(key)
                    .json(&payload)
            })
            .await?;
        let result = check_service_response(response, "openrouter", Some(&self.quota)).await;
        self.settle_media_account(index, None, quota.as_ref(), &result);
        let accepted = result?;
        let uncertain = || {
            ProviderError::DeliveryUncertain(
                "OpenRouter accepted the video job without a usable job id".to_owned(),
            )
        };
        let id = accepted["id"]
            .as_str()
            .filter(|id| valid_video_job_id(id))
            .ok_or_else(uncertain)?
            .to_owned();
        let status = video_status(&accepted).ok_or_else(uncertain)?;
        let origin = Arc::new(OpenRouterVideoOrigin {
            client,
            key: self.keys[index].clone(),
            base_url: self.base_url.trim_end_matches('/').to_owned(),
            id: id.clone(),
            inline_limit: MAX_INLINE_VIDEO_BYTES,
        });
        // A job reported complete at submit still needs its content fetched;
        // leave it pollable rather than losing the accepted operation.
        let initial = match status {
            JobStatus::Succeeded => match origin.poll().await {
                Ok(job) => job,
                Err(_) => VideoJob {
                    provider_ref: id,
                    status: JobStatus::Running,
                    output: None,
                    error: None,
                },
            },
            status => VideoJob {
                provider_ref: id,
                status,
                output: None,
                error: (status == JobStatus::Failed).then(|| video_failure(&accepted)),
            },
        };
        Ok(AcceptedVideo { initial, origin })
    }
}

/// A media response with the account and HTTP client that carried it.
struct MediaResponse {
    index: usize,
    response: reqwest::Response,
    quota: Option<RateLimitInfo>,
    client: reqwest::Client,
}

impl MediaResponse {
    fn new(index: usize, response: reqwest::Response, client: reqwest::Client) -> Self {
        let quota = response
            .status()
            .is_success()
            .then(|| parse_account_quota(response.headers()))
            .flatten();
        Self {
            index,
            response,
            quota,
            client,
        }
    }
}

/// The text an OpenAI-shaped speech body asks a chat audio model to perform:
/// the string `input`, which is the field the Gateway inspects.
fn speech_prompt(body: &Value) -> Result<String, ProviderError> {
    body.get("input")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            ProviderError::Provider("OpenRouter audio generation requires `input` text".to_owned())
        })
}

/// A speech body that names an `audio` output modality asks for chat audio
/// even when the model is not in the audio-output catalog.
fn opts_into_chat_audio(body: &Value) -> bool {
    body.get("modalities")
        .and_then(Value::as_array)
        .is_some_and(|modalities| modalities.iter().any(|modality| modality == "audio"))
}

/// The chat `modalities`: a caller's own `text`/`audio` list when it includes
/// audio, otherwise OpenRouter's documented `["text", "audio"]`.
fn chat_audio_modalities(body: &Value) -> Value {
    body.get("modalities")
        .and_then(Value::as_array)
        .filter(|_| opts_into_chat_audio(body))
        .filter(|modalities| {
            modalities
                .iter()
                .all(|modality| modality == "text" || modality == "audio")
        })
        .map_or_else(
            || json!(["text", "audio"]),
            |modalities| Value::Array(modalities.clone()),
        )
}

/// The chat `audio.format` for a speech body, which is also the format the
/// envelope reports. An omitted format is mp3, as for OpenAI speech; chat audio
/// spells PCM `pcm16` and has no AAC, which is served as mp3.
fn chat_audio_format(body: &Value) -> &'static str {
    match body
        .pointer("/audio/format")
        .or_else(|| body.get("response_format"))
        .and_then(Value::as_str)
    {
        Some("wav") => "wav",
        Some("flac") => "flac",
        Some("opus") => "opus",
        Some("pcm" | "pcm16") => "pcm16",
        _ => "mp3",
    }
}

/// OpenRouter's id for the generation behind a raw-audio speech reply.
fn speech_generation_id(headers: &reqwest::header::HeaderMap) -> Option<String> {
    headers
        .get("x-generation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|id| {
            id.starts_with("gen-")
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .map(str::to_owned)
}

/// The total cost on an OpenRouter generation record, in USD.
fn generation_total_cost(record: &Value) -> Option<f64> {
    record
        .pointer("/data/total_cost")
        .and_then(Value::as_f64)
        .filter(|cost| cost.is_finite() && *cost >= 0.0)
}

fn audio_mime_for_format(format: &str) -> &'static str {
    match format.to_ascii_lowercase().as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "opus" | "ogg" => "audio/ogg",
        "aac" => "audio/aac",
        "pcm" | "pcm16" => "audio/pcm",
        _ => "audio/wav",
    }
}

/// Collect a streamed chat-audio response into the audio envelope. Audio
/// arrives as base64 fragments in `choices[0].delta.audio.data`; OpenRouter
/// documents decoding their concatenation.
fn collect_chat_audio(stream: &str, format: &str) -> Result<Value, ProviderError> {
    use base64::Engine as _;

    let mut fragments: Vec<String> = Vec::new();
    let mut transcript = String::new();
    let mut usage = Value::Null;
    for line in stream.lines() {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(error) = event.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("upstream error");
            return Err(ProviderError::DeliveryUncertain(format!(
                "openrouter audio generation failed after acceptance: {message}"
            )));
        }
        if let Some(audio) = event.pointer("/choices/0/delta/audio") {
            if let Some(fragment) = audio.get("data").and_then(Value::as_str) {
                fragments.push(fragment.to_owned());
            }
            if let Some(text) = audio.get("transcript").and_then(Value::as_str) {
                transcript.push_str(text);
            }
        }
        if event.get("usage").is_some_and(Value::is_object) {
            usage = event["usage"].clone();
        }
    }
    let engine = &base64::engine::general_purpose::STANDARD;
    let bytes = engine.decode(fragments.concat()).or_else(|_| {
        fragments
            .iter()
            .try_fold(Vec::new(), |mut bytes, fragment| {
                bytes.extend(engine.decode(fragment)?);
                Ok::<_, base64::DecodeError>(bytes)
            })
    });
    let bytes = bytes
        .ok()
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| {
            ProviderError::DeliveryUncertain(
                "openrouter accepted audio generation returned no decodable audio".to_owned(),
            )
        })?;
    Ok(json!({
        "object": "audio",
        "data": [{
            "b64_json": engine.encode(bytes),
            "content_type": audio_mime_for_format(format),
        }],
        "transcript": transcript,
        "usage": usage,
        "raw": Value::Null,
    }))
}

/// Build OpenRouter's `input_audio` from Core's base64 `file` + `filename`.
fn stt_input_audio(body: &Value) -> Result<Value, ProviderError> {
    use base64::Engine as _;

    let data = body
        .get("file")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| {
            ProviderError::Provider("STT request missing base64 `file` field".to_owned())
        })?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| {
            ProviderError::Provider(format!("STT `file` is not valid base64: {error}"))
        })?;
    let format = body
        .get("format")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            body.get("filename")
                .and_then(Value::as_str)
                .and_then(|name| name.rsplit_once('.'))
                .map(|(_, extension)| extension.to_ascii_lowercase())
        })
        .unwrap_or_else(|| "wav".to_owned());
    let valid_format = format.len() <= 16
        && format
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && format
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '_' | '-'));
    if !valid_format {
        return Err(ProviderError::Provider(format!(
            "STT audio format `{format}` is not a valid format name"
        )));
    }
    Ok(json!({ "data": data, "format": format }))
}

/// OpenRouter video job ids are `gen-vid-<timestamp>-<20 alphanumerics>`;
/// anything else must not be interpolated into a credentialed poll URL.
fn valid_video_job_id(id: &str) -> bool {
    id.strip_prefix("gen-vid-")
        .and_then(|rest| rest.split_once('-'))
        .is_some_and(|(timestamp, suffix)| {
            !timestamp.is_empty()
                && timestamp.bytes().all(|b| b.is_ascii_digit())
                && suffix.len() == 20
                && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

fn video_status(job: &Value) -> Option<JobStatus> {
    Some(match job.get("status")?.as_str()? {
        "pending" => JobStatus::Queued,
        "in_progress" => JobStatus::Running,
        "completed" => JobStatus::Succeeded,
        "failed" | "cancelled" | "expired" => JobStatus::Failed,
        _ => return None,
    })
}

fn video_failure(job: &Value) -> String {
    match job.get("status").and_then(Value::as_str) {
        Some("cancelled") => "OpenRouter video generation was cancelled".to_owned(),
        Some("expired") => "OpenRouter video generation expired".to_owned(),
        _ => "OpenRouter video generation failed".to_owned(),
    }
}

/// Why a completed video's content could not be delivered.
enum VideoContentError {
    /// Every later poll would fail the same way, so the job fails.
    Undeliverable(&'static str),
    /// A transient or malformed response; the job stays pollable.
    Poll(VideoPollError),
}

impl From<VideoPollError> for VideoContentError {
    fn from(error: VideoPollError) -> Self {
        Self::Poll(error)
    }
}

/// The captured account, client, and job id for one accepted video.
struct OpenRouterVideoOrigin {
    client: reqwest::Client,
    key: String,
    base_url: String,
    id: String,
    /// The largest content body inlined; [`MAX_INLINE_VIDEO_BYTES`] in service.
    inline_limit: usize,
}

impl OpenRouterVideoOrigin {
    fn same_origin(&self, url: &reqwest::Url) -> bool {
        reqwest::Url::parse(&self.base_url).is_ok_and(|base| {
            base.scheme() == url.scheme()
                && base.host_str() == url.host_str()
                && base.port_or_known_default() == url.port_or_known_default()
        })
    }

    /// The credential is attached only to this job's own content endpoint,
    /// never to another OpenRouter API path named by an upstream response.
    fn is_job_content(&self, url: &reqwest::Url) -> bool {
        let Ok(base) = reqwest::Url::parse(&self.base_url) else {
            return false;
        };
        let expected = format!(
            "{}/videos/{}/content",
            base.path().trim_end_matches('/'),
            self.id
        );
        url.path() == expected
            && url.fragment().is_none()
            && url
                .query_pairs()
                .all(|(name, value)| name == "index" && value.bytes().all(|b| b.is_ascii_digit()))
    }

    /// Resolve one completed output to a URL the client can open without the
    /// OpenRouter credential: third-party HTTPS URLs pass through, while
    /// OpenRouter-hosted content is downloaded and inlined.
    async fn deliverable_url(&self, raw: &str) -> Result<String, VideoContentError> {
        let url = reqwest::Url::parse(raw)
            .or_else(|_| reqwest::Url::parse(&self.base_url).and_then(|base| base.join(raw)))
            .map_err(|_| VideoPollError::InvalidResponse)?;
        if !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() {
            return Err(VideoPollError::InvalidResponse.into());
        }
        if self.same_origin(&url) {
            if !self.is_job_content(&url) {
                return Err(VideoPollError::InvalidResponse.into());
            }
            return self.inline_content(url).await;
        }
        if url.scheme() != "https" {
            return Err(VideoPollError::InvalidResponse.into());
        }
        Ok(url.into())
    }

    async fn inline_content(&self, url: reqwest::Url) -> Result<String, VideoContentError> {
        use base64::Engine as _;

        let mut response = crate::video_poll_response(
            self.client
                .get(url)
                .timeout(std::time::Duration::from_secs(300))
                .bearer_auth(&self.key),
        )
        .await?;
        let declared = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(|value| value.trim().to_ascii_lowercase());
        let content_type = match declared.as_deref() {
            Some(value) if value.starts_with("video/") => value.to_owned(),
            None | Some("application/octet-stream") => "video/mp4".to_owned(),
            Some(_) => return Err(VideoPollError::InvalidResponse.into()),
        };
        // Size is a property of the finished video: every later poll would
        // download the same oversized body again, so it fails the job.
        if response
            .content_length()
            .is_some_and(|length| length > self.inline_limit as u64)
        {
            return Err(VideoContentError::Undeliverable(VIDEO_TOO_LARGE));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| VideoPollError::TransportUnavailable)?
        {
            if bytes.len().saturating_add(chunk.len()) > self.inline_limit {
                return Err(VideoContentError::Undeliverable(VIDEO_TOO_LARGE));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Err(VideoPollError::InvalidResponse.into());
        }
        Ok(format!(
            "data:{content_type};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    async fn completed_output(&self, job: &Value) -> Result<Value, VideoContentError> {
        let listed: Vec<&str> = job
            .get("unsigned_urls")
            .and_then(Value::as_array)
            .map(|urls| urls.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let fallback = format!("{}/videos/{}/content?index=0", self.base_url, self.id);
        let sources = if listed.is_empty() {
            vec![fallback.as_str()]
        } else {
            listed
        };
        let mut data = Vec::with_capacity(sources.len());
        for source in sources {
            data.push(json!({ "url": self.deliverable_url(source).await? }));
        }
        let mut output = json!({ "data": data });
        if job.get("usage").is_some_and(Value::is_object) {
            output["usage"] = job["usage"].clone();
        }
        Ok(output)
    }
}

impl VideoPollOrigin for OpenRouterVideoOrigin {
    fn poll(&self) -> VideoPollFuture<'_> {
        Box::pin(async move {
            let response = crate::video_poll_response(
                self.client
                    .get(format!("{}/videos/{}", self.base_url, self.id))
                    .timeout(std::time::Duration::from_secs(60))
                    .bearer_auth(&self.key),
            )
            .await?;
            let job = crate::video_poll_json(response).await?;
            if job.get("id").and_then(Value::as_str) != Some(self.id.as_str()) {
                return Err(VideoPollError::InvalidResponse);
            }
            let status = video_status(&job).ok_or(VideoPollError::InvalidResponse)?;
            if status == JobStatus::Succeeded {
                return match self.completed_output(&job).await {
                    Ok(output) => Ok(VideoJob {
                        provider_ref: self.id.clone(),
                        status,
                        output: Some(output),
                        error: None,
                    }),
                    // Terminal, so the job stops being re-downloaded and its
                    // credit reservation is released without a debit.
                    Err(VideoContentError::Undeliverable(reason)) => Ok(VideoJob {
                        provider_ref: self.id.clone(),
                        status: JobStatus::Failed,
                        output: None,
                        error: Some(reason.to_owned()),
                    }),
                    Err(VideoContentError::Poll(error)) => Err(error),
                };
            }
            Ok(VideoJob {
                provider_ref: self.id.clone(),
                status,
                output: None,
                error: (status == JobStatus::Failed).then(|| video_failure(&job)),
            })
        })
    }
}

impl BatchProvider for OpenRouterProvider {
    fn create_batch<'a>(
        &'a self,
        request: &'a BatchCreateRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, BatchProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let response = self
                .send_batch_request(reqwest::Method::POST, self.batches_url(), |builder| {
                    builder.json(request)
                })
                .await?;
            read_batch_response(response, &reqwest::Method::POST).await
        })
    }

    fn list_batches<'a>(
        &'a self,
        query: &'a BatchListQuery,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, BatchProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let mut pairs = Vec::new();
            if let Some(limit) = query.limit {
                pairs.push(("limit", limit.to_string()));
            }
            if let Some(after) = query.after.as_deref() {
                pairs.push(("after", after.to_owned()));
            }
            pairs.extend(query.status.iter().map(|status| ("status", status.clone())));
            if let Some(created_after) = query.created_after.as_deref() {
                pairs.push(("created_after", created_after.to_owned()));
            }
            if let Some(created_before) = query.created_before.as_deref() {
                pairs.push(("created_before", created_before.to_owned()));
            }

            let response = self
                .send_batch_request(reqwest::Method::GET, self.batches_url(), |builder| {
                    builder.query(&pairs)
                })
                .await?;
            read_batch_response(response, &reqwest::Method::GET).await
        })
    }

    fn get_batch<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, BatchProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let response = self
                .send_batch_request(reqwest::Method::GET, self.batch_url(id), |builder| builder)
                .await?;
            read_batch_response(response, &reqwest::Method::GET).await
        })
    }

    fn delete_batch<'a>(
        &'a self,
        id: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, BatchProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let response = self
                .send_batch_request(reqwest::Method::DELETE, self.batch_url(id), |builder| {
                    builder
                })
                .await?;
            read_batch_response(response, &reqwest::Method::DELETE).await
        })
    }
}

async fn read_batch_response(
    mut response: reqwest::Response,
    method: &reqwest::Method,
) -> Result<Value, BatchProviderError> {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BATCH_RESPONSE_BYTES as u64)
    {
        return Err(BatchProviderError {
            status: 502,
            message: "OpenRouter batch response exceeded the 64 MiB limit".to_owned(),
            retry_after,
        });
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if status.is_success() && *method != reqwest::Method::GET {
            // The provider accepted a submit or delete; only its answer (for a
            // submission, the new batch id) was lost. A read is safe to repeat,
            // so it keeps the plain read error below.
            BatchProviderError {
                status: 504,
                message: BATCH_DELIVERY_UNCERTAIN.to_owned(),
                retry_after: None,
            }
        } else {
            BatchProviderError {
                status: 502,
                message: format!("OpenRouter batch response could not be read: {error}"),
                retry_after: retry_after.clone(),
            }
        }
    })? {
        if bytes.len().saturating_add(chunk.len()) > MAX_BATCH_RESPONSE_BYTES {
            return Err(BatchProviderError {
                status: 502,
                message: "OpenRouter batch response exceeded the 64 MiB limit".to_owned(),
                retry_after,
            });
        }
        bytes.extend_from_slice(&chunk);
    }

    if !status.is_success() {
        let body = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| body.get("message").and_then(Value::as_str))
            .map(|message| message.chars().take(2048).collect())
            .unwrap_or_else(|| "OpenRouter batch request failed".to_owned());
        return Err(BatchProviderError {
            status: status.as_u16(),
            message,
            retry_after,
        });
    }

    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|error| BatchProviderError {
        status: 502,
        message: format!("OpenRouter returned an invalid batch response: {error}"),
        retry_after,
    })
}

impl Provider for OpenRouterProvider {
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
        "openrouter"
    }

    fn has_rotating_accounts(&self) -> bool {
        self.account_pool.has_restrictions()
            || self.keys.len() > 1
            || self.egress.as_ref().is_some_and(|pool| pool.len() > 1)
    }

    fn discover_models<'a>(
        &'a self,
    ) -> Pin<Box<dyn std::future::Future<Output = Option<Vec<Value>>> + Send + 'a>> {
        Box::pin(async move {
            let (_, client) = self.egress_client(None).ok()?;
            let index = self.account_pool.candidates(None).into_iter().next()?;
            // The default listing returns text-output models only; image,
            // speech, transcription, video, embedding, and rerank models are
            // listed only for an explicit output-modality query.
            let url = format!(
                "{}/models?output_modalities=all",
                self.base_url.trim_end_matches('/')
            );
            let json = discover_openai_models_at(client, &url, &self.keys[index]).await?;
            let models = catalog_models(models_from_response(json)?);
            self.record_audio_catalog(
                models
                    .iter()
                    .filter(|model| produces_chat_audio(model))
                    .filter_map(|model| model["id"].as_str().map(str::to_owned))
                    .collect(),
            );
            (!models.is_empty()).then_some(models)
        })
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
            let mut payload = body.clone();
            payload["model"] = Value::String(upstream_model(model).to_owned());
            self.options.apply(&mut payload);
            debug!(
                provider = "openrouter",
                model, "sending non-streaming request"
            );

            let url = chat_completions_url(&self.base_url);
            let candidates = self.account_pool.candidates(session);
            let mut last_err: Option<ProviderError> = None;
            for index in candidates {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(session, "openrouter request failed", |client| {
                        self.add_attribution_headers(client.post(&url))
                            .bearer_auth(key)
                            .json(&payload)
                    })
                    .await?;
                if let Some(domain) = parse_quota_domain(resp.headers()) {
                    self.account_pool.record_quota_domain(index, domain);
                }

                let status = resp.status();
                if is_credential_status(status) {
                    let (error, key_refused) =
                        read_credential_refusal(resp, "openrouter", false).await;
                    if !key_refused {
                        return Err(error);
                    }
                    self.account_pool.record_auth_failure(index);
                    last_err = Some(error);
                    continue;
                }
                let account_quota = status
                    .is_success()
                    .then(|| parse_account_quota(resp.headers()))
                    .flatten();
                match check_completion_response(resp, "openrouter", Some(&self.quota)).await {
                    Err(
                        e @ (ProviderError::RateLimited { .. }
                        | ProviderError::PaymentRequired { .. }),
                    ) => {
                        let retry_after = match &e {
                            ProviderError::RateLimited { retry_after, .. } => *retry_after,
                            _ => None,
                        };
                        self.account_pool.record_rate_limit(index, retry_after);
                        last_err = Some(e);
                        continue;
                    }
                    Ok(value) => {
                        if let Some(info) = account_quota.as_ref() {
                            self.account_pool.record_quota(index, info);
                        }
                        self.account_pool.record_success(session, index);
                        return Ok(value);
                    }
                    Err(error) => return Err(error),
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
        self.complete_stream_for_session(model, body, None)
    }

    fn complete_stream_for_session<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
        session: Option<&'a str>,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Body, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(upstream_model(model).to_owned());
            payload["stream"] = Value::Bool(true);
            self.options.apply(&mut payload);
            debug!(provider = "openrouter", model, "sending streaming request");

            let url = chat_completions_url(&self.base_url);
            let candidates = self.account_pool.candidates(session);
            let mut last_err: Option<ProviderError> = None;
            for index in candidates {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(session, "openrouter stream request failed", |client| {
                        streaming_request(
                            self.add_attribution_headers(client.post(&url))
                                .bearer_auth(key)
                                .json(&payload),
                        )
                    })
                    .await?;
                if let Some(domain) = parse_quota_domain(resp.headers()) {
                    self.account_pool.record_quota_domain(index, domain);
                }

                let status = resp.status();
                if is_credential_status(status) {
                    let (error, key_refused) =
                        read_credential_refusal(resp, "openrouter", true).await;
                    if !key_refused {
                        return Err(error);
                    }
                    self.account_pool.record_auth_failure(index);
                    last_err = Some(error);
                    continue;
                }
                let account_quota = status
                    .is_success()
                    .then(|| parse_account_quota(resp.headers()))
                    .flatten();
                match check_stream_status(resp, "openrouter", Some(&self.quota)).await {
                    Err(
                        e @ (ProviderError::RateLimited { .. }
                        | ProviderError::PaymentRequired { .. }),
                    ) => {
                        let retry_after = match &e {
                            ProviderError::RateLimited { retry_after, .. } => *retry_after,
                            _ => None,
                        };
                        self.account_pool.record_rate_limit(index, retry_after);
                        last_err = Some(e);
                        continue;
                    }
                    Err(e) => return Err(e),
                    Ok(resp) => {
                        if let Some(info) = account_quota.as_ref() {
                            self.account_pool.record_quota(index, info);
                        }
                        self.account_pool.record_success(session, index);
                        return Ok(Body::from_stream(resp.bytes_stream()));
                    }
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: "openrouter".to_string(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    fn embed<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(upstream_model(model).to_owned());
            self.options.apply_provider_routing(&mut payload);
            let candidates = self.account_pool.candidates(None);
            let mut last_err = None;
            for index in candidates {
                if !self.account_pool.is_available(index) {
                    continue;
                }
                let key = &self.keys[index];
                let resp = self
                    .send_request(None, "openrouter request failed", |client| {
                        self.add_attribution_headers(client.post(embeddings_url(&self.base_url)))
                            .bearer_auth(key)
                            .json(&payload)
                    })
                    .await?;
                match check_response_status(resp, "openrouter", Some(&self.quota)).await {
                    Err(
                        e @ (ProviderError::RateLimited { .. }
                        | ProviderError::PaymentRequired { .. }),
                    ) => {
                        let retry_after = match &e {
                            ProviderError::RateLimited { retry_after, .. } => *retry_after,
                            _ => None,
                        };
                        self.account_pool.record_rate_limit(index, retry_after);
                        last_err = Some(e);
                    }
                    result => return result,
                }
            }
            Err(last_err.unwrap_or_else(|| ProviderError::RateLimited {
                provider: "openrouter".to_owned(),
                retry_after: None,
                reset_at: None,
            }))
        })
    }

    fn rerank<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let mut payload = body.clone();
            payload["model"] = Value::String(upstream_model(model).to_owned());
            self.options.apply_provider_routing(&mut payload);
            let index = self
                .account_pool
                .candidates(None)
                .first()
                .copied()
                .ok_or_else(|| ProviderError::RateLimited {
                    provider: "openrouter".to_owned(),
                    retry_after: None,
                    reset_at: None,
                })?;
            let key = &self.keys[index];
            let resp = self
                .send_request(None, "openrouter request failed", |client| {
                    self.add_attribution_headers(client.post(rerank_url(&self.base_url)))
                        .bearer_auth(key)
                        .json(&payload)
                })
                .await?;
            let result = check_response_status(resp, "openrouter", Some(&self.quota)).await;
            if let Err(ProviderError::RateLimited { retry_after, .. }) = &result {
                self.account_pool.record_rate_limit(index, *retry_after);
            }
            if let Err(ProviderError::PaymentRequired { .. }) = &result {
                self.account_pool.record_rate_limit(index, None);
            }
            result
        })
    }

    /// Image generation through OpenRouter's Images API (`POST /images`),
    /// which returns OpenAI-shaped `data[].b64_json`. A caller that supplies
    /// `messages` keeps full chat control through the chat image modality,
    /// which returns `{ "data": [{ "url": … }], "raw": … }`.
    fn generate_image<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            if body.get("messages").is_some() {
                self.generate_image_via_chat(model, body).await
            } else {
                self.generate_image_via_images_api(model, body).await
            }
        })
    }

    /// Speech through `POST /audio/speech`, or streamed chat audio for models
    /// whose output modality is audio (music, expressive voice) and for
    /// requests whose `modalities` include `audio`.
    fn synthesize_speech<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            if self.wants_chat_audio(model, body).await {
                self.synthesize_via_chat(model, body).await
            } else {
                self.synthesize_via_speech_api(model, body).await
            }
        })
    }

    fn transcribe_audio<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>> {
        Box::pin(self.transcribe_via_stt_api(model, body))
    }

    fn submit_video_bound<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<AcceptedVideo, ProviderError>> + Send + 'a>>
    {
        Box::pin(self.submit_video(model, body))
    }
}

/// Keep catalog models a Ryu operation can serve and label non-chat models
/// with the Gateway modality that serves them. Text and mixed text output
/// models stay unlabeled (chat). Classifier-only models are dropped.
fn catalog_models(models: Vec<Value>) -> Vec<Value> {
    models
        .into_iter()
        .filter_map(|mut model| {
            let outputs: Vec<&str> = model
                .pointer("/architecture/output_modalities")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let modality = if outputs.is_empty() || outputs.contains(&"text") {
                None
            } else if outputs.contains(&"image") {
                Some("image")
            } else if outputs.contains(&"speech") {
                Some("tts")
            } else if outputs.contains(&"transcription") {
                Some("stt")
            } else if outputs.contains(&"video") {
                Some("video")
            } else if outputs.contains(&"embeddings") {
                Some("embedding")
            } else if outputs.contains(&"rerank") {
                Some("rerank")
            } else {
                return None;
            };
            if let Some(modality) = modality {
                model["modality"] = Value::String(modality.to_owned());
            }
            Some(model)
        })
        .collect()
}

fn produces_chat_audio(model: &Value) -> bool {
    model
        .pointer("/architecture/output_modalities")
        .and_then(Value::as_array)
        .is_some_and(|outputs| outputs.iter().any(|output| output == "audio"))
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
    fn apply_provider_routing_keeps_chat_only_options_out_of_payloads() {
        let opts = OpenRouterOptions {
            data_collection: Some("deny".into()),
            zdr: Some(true),
            sort: Some("throughput".into()),
            response_healing: true,
            usage_accounting: true,
        };
        let mut payload = json!({"model":"embed-model","usage":{"include":false}});
        opts.apply_provider_routing(&mut payload);

        assert_eq!(payload["provider"]["data_collection"], json!("deny"));
        assert_eq!(payload["provider"]["zdr"], json!(true));
        assert_eq!(payload["provider"]["sort"], json!("throughput"));
        assert_eq!(payload["usage"]["include"], json!(false));
        assert!(payload.get("plugins").is_none());
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
        assert_eq!(payload["provider"]["zdr"], json!(true));
        assert_eq!(payload["provider"]["data_collection"], json!("deny"));
        assert!(payload.get("plugins").is_none());
        assert!(payload.get("usage").is_none());
    }

    #[test]
    fn privacy_cannot_be_disabled_by_config_or_caller() {
        let opts = OpenRouterOptions {
            data_collection: Some("allow".into()),
            zdr: Some(false),
            ..Default::default()
        };
        for provider in [
            json!(null),
            json!(false),
            json!({"zdr":false,"data_collection":"allow","order":["example"]}),
        ] {
            let mut payload = json!({"model":"x","provider":provider});
            opts.apply_provider_routing(&mut payload);
            assert_eq!(payload["provider"]["zdr"], json!(true));
            assert_eq!(payload["provider"]["data_collection"], json!("deny"));
            if provider.is_object() {
                assert_eq!(payload["provider"]["order"], json!(["example"]));
            }
        }
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
        let p = provider_with(
            "http://x".into(),
            vec!["a", "b"],
            OpenRouterOptions::default(),
        );
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

    /// A freshly loaded audio-model catalog, so speech tests do not trigger
    /// the on-demand catalog request.
    fn with_audio_models(provider: &OpenRouterProvider, ids: &[&str]) {
        provider.record_audio_catalog(ids.iter().map(|id| (*id).to_owned()).collect());
    }

    /// An accepted 2xx that cannot be decoded, or a timeout after the request
    /// was sent, may already be billed upstream: it must stop fallback instead
    /// of replaying the completion on the next provider.
    #[tokio::test]
    async fn uncertain_delivery_is_typed_and_never_replayed() {
        let body = json!({ "messages": [] });
        let server = MockServer::always(MockResponse::ok_json("not-json")).await;
        let p = provider_with(
            server.base_url().to_string(),
            vec!["first", "second"],
            OpenRouterOptions::default(),
        );
        let error = p.complete("anthropic/claude-3", &body).await.unwrap_err();
        assert!(
            matches!(error, ProviderError::DeliveryUncertain(_)),
            "{error:?}"
        );
        assert_eq!(server.request_count(), 1);

        let (url, seen, stalled) = crate::test_support::stalled_server().await;
        let p = OpenRouterProvider::new(
            // Streams lift the total timeout; the read timeout still fires.
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(200))
                .read_timeout(std::time::Duration::from_millis(200))
                .build()
                .unwrap(),
            vec!["first".to_owned(), "second".to_owned()],
            url,
            "https://ryu.example".to_string(),
            "Ryu".to_string(),
            OpenRouterOptions::default(),
            Arc::new(ProviderQuotas::new()),
        );
        for (expected, streaming) in [(1, false), (2, true)] {
            let error = if streaming {
                p.complete_stream("anthropic/claude-3", &body)
                    .await
                    .err()
                    .unwrap()
            } else {
                p.complete("anthropic/claude-3", &body).await.unwrap_err()
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
        let error = provider_with(refused, vec!["first"], OpenRouterOptions::default())
            .complete("anthropic/claude-3", &body)
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::Transport(_)), "{error:?}");
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
        assert_eq!(
            reqs[0].header("http-referer").as_deref(),
            Some("https://ryu.example")
        );
        assert_eq!(reqs[0].header("x-openrouter-title").as_deref(), Some("Ryu"));
        assert_eq!(reqs[0].header("x-title").as_deref(), Some("Ryu"));
        assert_eq!(
            reqs[0].header("x-openrouter-categories").as_deref(),
            Some("personal-agent")
        );
        assert_eq!(
            reqs[0].header("x-openrouter-metadata").as_deref(),
            Some("enabled")
        );
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer sk-or")
        );
        // Managed privacy posture is injected into the outgoing body.
        assert_eq!(reqs[0].json()["provider"]["data_collection"], json!("deny"));
        assert_eq!(reqs[0].json()["model"], json!("anthropic/claude-3"));
    }

    #[tokio::test]
    async fn blank_site_identity_sends_no_app_attribution() {
        // A self-hoster who blanks site_url / site_name must not have their
        // traffic attributed to Ryu (or to an empty app) at OpenRouter.
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"or"}"#)).await;
        let p = OpenRouterProvider::new(
            reqwest::Client::new(),
            vec!["sk-or".to_owned()],
            server.base_url().to_string(),
            " ".to_string(),
            String::new(),
            OpenRouterOptions::default(),
            Arc::new(ProviderQuotas::new()),
        );
        p.complete("anthropic/claude-3", &json!({ "messages": [] }))
            .await
            .unwrap();

        let reqs = server.requests();
        for header in [
            "http-referer",
            "x-openrouter-title",
            "x-title",
            "x-openrouter-categories",
        ] {
            assert_eq!(reqs[0].header(header), None, "{header} must not be sent");
        }
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer sk-or")
        );
    }

    #[tokio::test]
    async fn prompt_cache_markers_reach_openrouter_unmodified() {
        // The end-to-end gap the audit named: nothing proved cache markers
        // actually leave the process. Assert on the bytes the mock server
        // received, so a future change to `apply()` that reshapes or drops the
        // caller's markers fails here.
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"or"}"#)).await;
        let opts = OpenRouterOptions {
            data_collection: Some("deny".into()),
            usage_accounting: true,
            ..Default::default()
        };
        let p = provider_with(server.base_url().to_string(), vec!["sk-or"], opts);
        let body = json!({
            "cache_control": { "type": "ephemeral", "ttl": "1h" },
            "session_id": "conv-abc",
            "messages": [
                { "role": "system", "content": [
                    { "type": "text", "text": "HUGE PREFIX",
                      "cache_control": { "type": "ephemeral" } }
                ]},
                { "role": "user", "content": "hi" }
            ]
        });
        p.complete("anthropic/claude-sonnet-4", &body)
            .await
            .unwrap();

        let sent = server.requests()[0].json();
        assert_eq!(
            sent["cache_control"],
            json!({ "type": "ephemeral", "ttl": "1h" })
        );
        assert_eq!(sent["session_id"], json!("conv-abc"));
        assert_eq!(
            sent["messages"][0]["content"][0]["cache_control"]["type"],
            json!("ephemeral")
        );
        // The managed options still applied alongside the cache markers.
        assert_eq!(sent["provider"]["data_collection"], json!("deny"));
        assert_eq!(sent["usage"]["include"], json!(true));
    }

    #[tokio::test]
    async fn prompt_cache_markers_survive_the_streaming_path_too() {
        let server = MockServer::always(MockResponse::ok_json("data: [DONE]\n\n")).await;
        let p = provider_with(
            server.base_url().to_string(),
            vec!["sk-or"],
            OpenRouterOptions::default(),
        );
        let body = json!({
            "messages": [{ "role": "user", "content": [
                { "type": "text", "text": "ctx",
                  "prompt_cache_breakpoint": { "mode": "explicit" } }
            ]}],
            "prompt_cache_key": "conv-abc"
        });
        p.complete_stream("openai/gpt-4o", &body).await.unwrap();

        let sent = server.requests()[0].json();
        assert_eq!(sent["prompt_cache_key"], json!("conv-abc"));
        assert_eq!(
            sent["messages"][0]["content"][0]["prompt_cache_breakpoint"]["mode"],
            json!("explicit")
        );
        assert_eq!(sent["stream"], json!(true));
    }

    #[tokio::test]
    async fn complete_error_does_not_leak_key() {
        const SECRET: &str = "sk-or-SECRET-abcdef";
        let server = MockServer::always(MockResponse::json(
            402,
            r#"{"error":{"message":"no credits"}}"#,
        ))
        .await;
        let p = provider_with(
            server.base_url().to_string(),
            vec![SECRET],
            Default::default(),
        );
        let err = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .unwrap_err();
        match &err {
            ProviderError::PaymentRequired { provider, message } => {
                assert_eq!(provider, "openrouter");
                assert_eq!(message, "no credits");
            }
            other => panic!("expected PaymentRequired, got {other:?}"),
        }
        let rendered = format!("{err}{err:?}");
        assert!(!rendered.contains(SECRET), "leaked: {rendered}");
        assert!(rendered.contains("no credits"));
    }

    #[tokio::test]
    async fn complete_rotates_to_the_next_key_after_payment_required() {
        let server = MockServer::start(vec![
            MockResponse::json(402, r#"{"error":{"message":"no credits"}}"#),
            MockResponse::ok_json(r#"{"id":"served-by-second-key"}"#),
        ])
        .await;
        let p = provider_with(
            server.base_url().to_owned(),
            vec!["sk-empty", "sk-funded"],
            Default::default(),
        );

        let out = p
            .complete("m", &json!({ "messages": [] }))
            .await
            .expect("the funded key should serve after the empty key returns 402");
        assert_eq!(out["id"], json!("served-by-second-key"));

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer sk-empty")
        );
        assert_eq!(
            requests[1].header("authorization").as_deref(),
            Some("Bearer sk-funded")
        );
    }

    #[tokio::test]
    async fn refused_key_moves_the_session_to_a_healthy_key() {
        for (status, stream) in [(401, false), (403, true)] {
            let server = MockServer::start(vec![
                MockResponse::json(
                    status,
                    r#"{"error":{"message":"invalid key","code":"invalid_api_key"}}"#,
                ),
                MockResponse::ok_json(r#"{"id":"ok"}"#),
                MockResponse::ok_json(r#"{"id":"ok"}"#),
            ])
            .await;
            let p = provider_with(
                server.base_url().to_owned(),
                vec!["sk-revoked", "sk-healthy"],
                Default::default(),
            );
            let body = json!({ "messages": [] });
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
                .map(|request| request.header("authorization").unwrap())
                .collect();
            assert_eq!(
                keys,
                [
                    "Bearer sk-revoked",
                    "Bearer sk-healthy",
                    "Bearer sk-healthy"
                ],
                "{status}"
            );
        }
    }

    #[tokio::test]
    async fn a_moderation_403_neither_rotates_nor_cools_the_key() {
        // OpenRouter answers flagged input with a 403: a refusal of the request.
        let flagged = r#"{"error":{"code":403,"message":"Your chosen model requires moderation and your input was flagged"}}"#;
        for stream in [false, true] {
            let server = MockServer::start(vec![
                MockResponse::json(403, flagged),
                MockResponse::ok_json(r#"{"id":"ok"}"#),
            ])
            .await;
            let p = provider_with(
                server.base_url().to_owned(),
                vec!["sk-first", "sk-second"],
                Default::default(),
            );
            let body = json!({ "messages": [] });
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
            p.complete_for_session("m", &body, Some("conv"))
                .await
                .unwrap();
            let keys: Vec<_> = server
                .requests()
                .iter()
                .map(|request| request.header("authorization").unwrap())
                .collect();
            assert_eq!(
                keys,
                ["Bearer sk-first", "Bearer sk-first"],
                "stream={stream}"
            );
        }
    }

    #[tokio::test]
    async fn batches_submit_list_poll_and_delete_without_retrying_submissions() {
        use crate::batches::{BatchCreateRequest, BatchListQuery, BatchRequestItem};

        let server = MockServer::always(MockResponse::json(
            202,
            r#"{"id":"batch_123","status":"validating"}"#,
        ))
        .await;
        let provider = provider_with(
            server.base_url().to_owned(),
            vec!["sk-or-first", "sk-or-second"],
            Default::default(),
        );
        let request = BatchCreateRequest {
            endpoint: "/v1/chat/completions".to_owned(),
            model: "openai/gpt-4o-mini".to_owned(),
            completion_window: Some("24h".to_owned()),
            provider: Some(crate::batches::BatchProviderRouting {
                only: vec!["openai".to_owned()],
            }),
            requests: vec![BatchRequestItem {
                custom_id: "eval-1".to_owned(),
                body: json!({ "messages": [{ "role": "user", "content": "Say hi" }] }),
            }],
        };
        let created = provider.create_batch(&request).await.unwrap();
        assert_eq!(created["id"], json!("batch_123"));
        let _ = provider
            .list_batches(&BatchListQuery {
                limit: Some(2),
                status: vec!["completed".to_owned(), "failed".to_owned()],
                ..Default::default()
            })
            .await
            .unwrap();
        let _ = provider.get_batch("batch_123").await.unwrap();
        let _ = provider.delete_batch("batch_123").await.unwrap();

        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].path, "/batches");
        assert_eq!(
            requests[0].header("authorization").as_deref(),
            Some("Bearer sk-or-first")
        );
        assert_eq!(
            requests[0].header("http-referer").as_deref(),
            Some("https://ryu.example")
        );
        assert_eq!(requests[0].header("x-title").as_deref(), Some("Ryu"));
        assert_eq!(
            requests[0].json()["requests"][0]["custom_id"],
            json!("eval-1")
        );
        assert_eq!(requests[1].method, "GET");
        let query = requests[1].query.as_deref().unwrap_or_default();
        assert!(query.contains("status=completed"));
        assert!(query.contains("status=failed"));
        assert_eq!(requests[2].path, "/batches/batch_123");
        assert_eq!(requests[3].method, "DELETE");
    }

    #[tokio::test]
    async fn batch_submit_is_not_retried_after_an_ambiguous_upstream_failure() {
        use crate::batches::{BatchCreateRequest, BatchRequestItem};

        let server = MockServer::start(vec![
            MockResponse::json(503, r#"{"error":{"message":"temporarily unavailable"}}"#),
            MockResponse::json(202, r#"{"id":"batch_second"}"#),
        ])
        .await;
        let provider = provider_with(
            server.base_url().to_owned(),
            vec!["sk-or"],
            Default::default(),
        );
        let request = BatchCreateRequest {
            endpoint: "/v1/embeddings".to_owned(),
            model: "openai/text-embedding-3-small".to_owned(),
            completion_window: None,
            provider: None,
            requests: vec![BatchRequestItem {
                custom_id: "embed-1".to_owned(),
                body: json!({ "input": "batching is useful" }),
            }],
        };
        let error = provider.create_batch(&request).await.unwrap_err();
        assert_eq!(error.status, 503);
        assert_eq!(error.message, "temporarily unavailable");
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn batch_submit_timeout_reports_uncertain_delivery_not_unreachable() {
        use crate::batches::{BatchCreateRequest, BatchRequestItem};

        let request = BatchCreateRequest {
            endpoint: "/v1/embeddings".to_owned(),
            model: "openai/text-embedding-3-small".to_owned(),
            completion_window: None,
            provider: None,
            requests: vec![BatchRequestItem {
                custom_id: "embed-1".to_owned(),
                body: json!({ "input": "batching is useful" }),
            }],
        };

        // The request reaches the provider, which never answers: the batch may
        // exist, so this must not read as "could not reach" (a safe retry).
        let (url, seen, stalled) = crate::test_support::stalled_server().await;
        let provider = OpenRouterProvider::new(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(200))
                .read_timeout(std::time::Duration::from_millis(200))
                .build()
                .unwrap(),
            vec!["sk-or".to_owned(), "sk-or-second".to_owned()],
            url,
            "https://ryu.example".to_string(),
            "Ryu".to_string(),
            OpenRouterOptions::default(),
            Arc::new(ProviderQuotas::new()),
        );
        let error = provider.create_batch(&request).await.unwrap_err();
        assert_eq!(error.status, 504, "{}", error.message);
        assert!(error.message.contains("list batches"), "{}", error.message);
        assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), 1);
        stalled.abort();

        // A refused connection never reached OpenRouter and stays a 502.
        let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let refused = format!("http://{}", unused.local_addr().unwrap());
        drop(unused);
        let error = provider_with(refused, vec!["sk-or"], OpenRouterOptions::default())
            .create_batch(&request)
            .await
            .unwrap_err();
        assert_eq!(error.status, 502, "{}", error.message);
        assert!(
            error.message.contains("could not reach"),
            "{}",
            error.message
        );
    }

    /// Serve every request with a 2xx head whose body is cut off, so the batch
    /// answer is lost after OpenRouter accepted the request.
    async fn truncated_answer_server() -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                // Consume the whole request (head and body) before answering.
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                while let Ok(read) = socket.read(&mut buffer).await {
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
                    let Some(head_end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let body_length = text[..head_end]
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if request.len() >= head_end + 4 + body_length {
                        break;
                    }
                }
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                          content-length: 64\r\nconnection: close\r\n\r\n{\"id\":\"batch_",
                    )
                    .await;
                let _ = socket.shutdown().await;
            }
        });
        (url, server)
    }

    #[tokio::test]
    async fn truncated_batch_answer_is_uncertain_only_for_writes() {
        use crate::batches::{BatchCreateRequest, BatchRequestItem};

        let (url, server) = truncated_answer_server().await;
        let provider = provider_with(url, vec!["sk-or"], OpenRouterOptions::default());
        let request = BatchCreateRequest {
            endpoint: "/v1/embeddings".to_owned(),
            model: "openai/text-embedding-3-small".to_owned(),
            completion_window: None,
            provider: None,
            requests: vec![BatchRequestItem {
                custom_id: "embed-1".to_owned(),
                body: json!({ "input": "batching is useful" }),
            }],
        };

        // The submission was accepted and only its batch id was lost.
        let error = provider.create_batch(&request).await.unwrap_err();
        assert_eq!(error.status, 504, "{}", error.message);
        assert!(error.message.contains("list batches"), "{}", error.message);

        // A cut-off poll is a plain read failure and safe to repeat.
        let error = provider.get_batch("batch_123").await.unwrap_err();
        assert_eq!(error.status, 502, "{}", error.message);
        assert!(
            error.message.contains("could not be read"),
            "{}",
            error.message
        );
        server.abort();
    }

    #[tokio::test]
    async fn generate_image_with_messages_builds_chat_call_and_extracts_images() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"choices":[{"message":{"images":[{"image_url":{"url":"data:image/png;base64,ZZ"}}]}}]}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let out = p
            .generate_image(
                "google/gemini-2.5-flash-image",
                &json!({ "messages": [{ "role": "user", "content": "a fox" }] }),
            )
            .await
            .unwrap();
        assert_eq!(out["data"][0]["url"], json!("data:image/png;base64,ZZ"));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/chat/completions");
        let sent = reqs[0].json();
        assert_eq!(sent["messages"][0]["content"], json!("a fox"));
        assert_eq!(sent["modalities"], json!(["image", "text"]));
    }

    #[tokio::test]
    async fn generate_image_posts_prompt_to_images_api() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"created":1,"data":[{"b64_json":"ZZ","media_type":"image/webp"}],"usage":{"cost":0.04}}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let out = p
            .generate_image(
                "openrouter/bytedance-seed/seedream-4.5",
                &json!({ "prompt": "a fox", "size": "1024x1024", "response_format": "url" }),
            )
            .await
            .unwrap();
        assert_eq!(out["data"][0]["b64_json"], json!("ZZ"));
        assert_eq!(out["usage"]["cost"], json!(0.04));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/images");
        assert_eq!(reqs[0].header("x-openrouter-title").as_deref(), Some("Ryu"));
        let sent = reqs[0].json();
        assert_eq!(sent["model"], json!("bytedance-seed/seedream-4.5"));
        assert_eq!(sent["prompt"], json!("a fox"));
        assert_eq!(sent["size"], json!("1024x1024"));
        assert!(sent.get("response_format").is_none());
        assert_eq!(sent["provider"]["zdr"], json!(true));
        assert_eq!(sent["provider"]["data_collection"], json!("deny"));
        assert!(sent.get("plugins").is_none());
    }

    #[tokio::test]
    async fn generate_image_falls_back_to_chat_when_images_api_lacks_the_model() {
        let server = MockServer::start(vec![
            MockResponse::json(404, r#"{"error":{"message":"model not found"}}"#),
            MockResponse::ok_json(
                r#"{"choices":[{"message":{"images":[{"image_url":{"url":"data:image/png;base64,QQ"}}]}}]}"#,
            ),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let out = p
            .generate_image("vendor/chat-image", &json!({ "prompt": "a fox" }))
            .await
            .unwrap();
        assert_eq!(out["data"][0]["url"], json!("data:image/png;base64,QQ"));
        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/images");
        assert_eq!(reqs[1].path, "/chat/completions");
        assert_eq!(reqs[1].json()["messages"][0]["content"], json!("a fox"));
    }

    #[tokio::test]
    async fn generate_image_requires_a_prompt_before_sending() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let error = p
            .generate_image("vendor/model", &json!({}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("requires a prompt"));
        assert_eq!(server.request_count(), 0);
    }

    #[tokio::test]
    async fn synthesize_speech_posts_to_speech_api_and_wraps_audio() {
        let server = MockServer::always(MockResponse::ok_bytes(
            "audio/mpeg",
            vec![0xff, 0xfb, 0x90, 0x00],
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        with_audio_models(&p, &[]);
        let out = p
            .synthesize_speech(
                "openrouter/elevenlabs/eleven-v4",
                &json!({ "input": "hello", "voice": "Rachel" }),
            )
            .await
            .unwrap();
        assert_eq!(out["object"], json!("audio"));
        assert_eq!(out["data"][0]["content_type"], json!("audio/mpeg"));
        assert_eq!(out["data"][0]["b64_json"], json!("//uQAA=="));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/audio/speech");
        let sent = reqs[0].json();
        assert_eq!(sent["model"], json!("elevenlabs/eleven-v4"));
        assert_eq!(sent["input"], json!("hello"));
        assert_eq!(sent["voice"], json!("Rachel"));
        assert_eq!(sent["response_format"], json!("mp3"));
        assert_eq!(sent["provider"]["zdr"], json!(true));
    }

    #[tokio::test]
    async fn synthesize_speech_serves_unsupported_formats_as_labeled_mp3() {
        let server = MockServer::always(MockResponse::ok_bytes("audio/mpeg", vec![1, 2, 3])).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        with_audio_models(&p, &[]);
        for format in ["wav", "opus", "aac", "flac"] {
            let out = p
                .synthesize_speech(
                    "elevenlabs/eleven-v4",
                    &json!({ "input": "hello", "response_format": format }),
                )
                .await
                .unwrap();
            assert_eq!(out["data"][0]["content_type"], json!("audio/mpeg"));
        }
        p.synthesize_speech(
            "elevenlabs/eleven-v4",
            &json!({ "input": "hello", "response_format": "pcm" }),
        )
        .await
        .unwrap();
        let formats: Vec<Value> = server
            .requests()
            .iter()
            .map(|request| request.json()["response_format"].clone())
            .collect();
        assert_eq!(
            formats,
            [
                json!("mp3"),
                json!("mp3"),
                json!("mp3"),
                json!("mp3"),
                json!("pcm")
            ]
        );
    }

    #[tokio::test]
    async fn speech_loads_the_audio_model_catalog_on_demand() {
        let stream =
            "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"AQID\"}}}]}\n\ndata: [DONE]\n\n";
        let server = MockServer::start(vec![
            MockResponse::ok_json(
                r#"{"data":[{"id":"google/lyria-3-pro-preview","architecture":{"output_modalities":["text","audio"]}}]}"#,
            ),
            MockResponse::ok_json(stream),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let out = p
            .synthesize_speech("google/lyria-3-pro-preview", &json!({ "input": "jazz" }))
            .await
            .unwrap();
        assert_eq!(out["data"][0]["b64_json"], json!("AQID"));
        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/models");
        assert_eq!(reqs[0].query.as_deref(), Some("output_modalities=audio"));
        assert_eq!(reqs[1].path, "/chat/completions");

        // A fresh catalog is reused rather than fetched for every request.
        p.synthesize_speech("google/lyria-3-pro-preview", &json!({ "input": "jazz" }))
            .await
            .unwrap();
        assert_eq!(server.request_count(), 3);
    }

    #[tokio::test]
    async fn chat_embeddings_and_rerank_strip_the_routing_prefix() {
        let server = MockServer::always(MockResponse::ok_json(r#"{"id":"or"}"#)).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        p.complete(
            "openrouter/anthropic/claude-sonnet-4",
            &json!({ "messages": [] }),
        )
        .await
        .unwrap();
        p.complete("openrouter/auto", &json!({ "messages": [] }))
            .await
            .unwrap();
        p.complete_stream("openrouter/openai/gpt-5", &json!({ "messages": [] }))
            .await
            .unwrap();
        p.embed("openrouter/voyageai/voyage-4", &json!({ "input": "x" }))
            .await
            .unwrap();
        p.rerank(
            "openrouter/cohere/rerank-4",
            &json!({ "query": "x", "documents": [] }),
        )
        .await
        .unwrap();
        let models: Vec<Value> = server
            .requests()
            .iter()
            .map(|request| request.json()["model"].clone())
            .collect();
        assert_eq!(
            models,
            [
                json!("anthropic/claude-sonnet-4"),
                json!("openrouter/auto"),
                json!("openai/gpt-5"),
                json!("voyageai/voyage-4"),
                json!("cohere/rerank-4"),
            ]
        );
    }

    #[tokio::test]
    async fn synthesize_speech_rotates_accounts_after_payment_required() {
        let server = MockServer::start(vec![
            MockResponse::json(402, r#"{"error":{"message":"Insufficient credits"}}"#),
            MockResponse::ok_bytes("audio/mpeg", vec![1, 2, 3]),
        ])
        .await;
        let p = provider_with(
            server.base_url().to_string(),
            vec!["first", "second"],
            Default::default(),
        );
        with_audio_models(&p, &[]);
        p.synthesize_speech("elevenlabs/eleven-v4", &json!({ "input": "hello" }))
            .await
            .unwrap();
        let reqs = server.requests();
        assert_eq!(
            reqs[0].header("authorization").as_deref(),
            Some("Bearer first")
        );
        assert_eq!(
            reqs[1].header("authorization").as_deref(),
            Some("Bearer second")
        );
    }

    #[tokio::test]
    async fn synthesize_speech_streams_chat_audio_for_audio_output_models() {
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"AQID\",\"transcript\":\"la \"}}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"BAUG\",\"transcript\":\"la\"}}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"cost\":0.02}}\n\n",
            "data: [DONE]\n\n",
        );
        let server = MockServer::always(MockResponse::ok_json(stream)).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        with_audio_models(&p, &["google/lyria-3-pro-preview"]);
        let out = p
            .synthesize_speech(
                "openrouter/google/lyria-3-pro-preview",
                &json!({ "input": "an upbeat jazz loop", "voice": "alloy", "response_format": "mp3" }),
            )
            .await
            .unwrap();
        assert_eq!(out["data"][0]["b64_json"], json!("AQIDBAUG"));
        assert_eq!(out["data"][0]["content_type"], json!("audio/mpeg"));
        assert_eq!(out["transcript"], json!("la la"));
        assert_eq!(out["usage"]["cost"], json!(0.02));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/chat/completions");
        let sent = reqs[0].json();
        assert_eq!(sent["model"], json!("google/lyria-3-pro-preview"));
        assert_eq!(sent["stream"], json!(true));
        assert_eq!(sent["modalities"], json!(["text", "audio"]));
        assert_eq!(sent["audio"], json!({ "format": "mp3", "voice": "alloy" }));
        assert_eq!(sent["messages"][0]["content"], json!("an upbeat jazz loop"));
        assert!(sent.get("input").is_none());
        assert!(sent.get("response_format").is_none());
    }

    #[tokio::test]
    async fn chat_audio_builds_messages_only_from_inspected_speech_fields() {
        let stream =
            "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"AQID\"}}}]}\n\ndata: [DONE]\n\n";
        let server = MockServer::always(MockResponse::ok_json(stream)).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        with_audio_models(&p, &[]);
        let out = p
            .synthesize_speech(
                "openai/gpt-audio",
                &json!({
                    "input": "read this aloud",
                    "instructions": "speak warmly",
                    "modalities": ["text", "audio"],
                    "messages": [{ "role": "user", "content": "uninspected chat" }],
                }),
            )
            .await
            .unwrap();
        // An omitted format is mp3, as for OpenAI speech.
        assert_eq!(out["data"][0]["content_type"], json!("audio/mpeg"));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/chat/completions");
        let sent = reqs[0].json();
        assert_eq!(
            sent["messages"],
            json!([
                { "role": "system", "content": "speak warmly" },
                { "role": "user", "content": "read this aloud" },
            ])
        );
        assert_eq!(sent["modalities"], json!(["text", "audio"]));
        assert_eq!(sent["audio"], json!({ "format": "mp3" }));
        assert!(!sent.to_string().contains("uninspected chat"));

        // `messages` alone does not select chat audio, and never reaches the
        // Speech API either.
        let speech = MockServer::always(MockResponse::ok_bytes("audio/mpeg", vec![1])).await;
        let p = provider_with(speech.base_url().to_string(), vec!["k"], Default::default());
        with_audio_models(&p, &[]);
        p.synthesize_speech(
            "elevenlabs/eleven-v4",
            &json!({ "input": "hello", "messages": [{ "role": "user", "content": "chat" }] }),
        )
        .await
        .unwrap();
        let reqs = speech.requests();
        assert_eq!(reqs[0].path, "/audio/speech");
        assert!(reqs[0].json().get("messages").is_none());
    }

    #[test]
    fn chat_audio_formats_follow_the_speech_contract() {
        assert_eq!(chat_audio_format(&json!({})), "mp3");
        assert_eq!(
            chat_audio_format(&json!({ "response_format": "wav" })),
            "wav"
        );
        assert_eq!(
            chat_audio_format(&json!({ "response_format": "pcm" })),
            "pcm16"
        );
        assert_eq!(
            chat_audio_format(&json!({ "response_format": "aac" })),
            "mp3"
        );
        assert_eq!(
            chat_audio_format(&json!({ "audio": { "format": "flac" }, "response_format": "wav" })),
            "flac"
        );
        // Only an audio modality list is honored; anything else is replaced.
        assert_eq!(
            chat_audio_modalities(&json!({ "modalities": ["audio"] })),
            json!(["audio"])
        );
        assert_eq!(
            chat_audio_modalities(&json!({ "modalities": ["image", "audio"] })),
            json!(["text", "audio"])
        );
        assert!(!opts_into_chat_audio(&json!({ "modalities": ["text"] })));
    }

    #[tokio::test]
    async fn speech_api_cost_comes_from_the_generation_record() {
        const GENERATION: &str = "gen-tts-1791408882-gsi0JmqAdk574VPMDHMH";
        let server = MockServer::start(vec![
            MockResponse::ok_bytes("audio/mpeg", vec![1, 2, 3])
                .with_header("x-generation-id", GENERATION),
            MockResponse::json(404, r#"{"error":{"message":"Generation not found"}}"#),
            MockResponse::ok_json(format!(
                r#"{{"data":{{"id":"{GENERATION}","total_cost":0.0002}}}}"#
            )),
        ])
        .await;
        // Default options leave the legacy `usage_accounting` flag off; the
        // speech cost lookup must not depend on it.
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        with_audio_models(&p, &[]);
        let out = p
            .synthesize_speech(
                "openrouter/elevenlabs/eleven-v3",
                &json!({ "input": "hello" }),
            )
            .await
            .unwrap();
        assert_eq!(out["usage"]["cost"], json!(0.0002));

        let reqs = server.requests();
        assert_eq!(reqs.len(), 3);
        assert_eq!(reqs[0].path, "/audio/speech");
        // A record that is not written yet is read again.
        for request in &reqs[1..] {
            assert_eq!(request.method, "GET");
            assert_eq!(request.path, "/generation");
            assert_eq!(
                request.query.as_deref(),
                Some(format!("id={GENERATION}").as_str())
            );
            assert_eq!(request.header("authorization").as_deref(), Some("Bearer k"));
        }
    }

    #[test]
    fn speech_generation_ids_are_validated_before_use() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert_eq!(speech_generation_id(&headers), None);
        headers.insert("x-generation-id", "gen-tts-1-AbC_d".parse().unwrap());
        assert_eq!(
            speech_generation_id(&headers).as_deref(),
            Some("gen-tts-1-AbC_d")
        );
        headers.insert("x-generation-id", "gen-1&id=other".parse().unwrap());
        assert_eq!(speech_generation_id(&headers), None);
        assert_eq!(
            generation_total_cost(&json!({ "data": { "total_cost": -1.0 } })),
            None
        );
        assert_eq!(
            generation_total_cost(&json!({ "data": { "total_cost": 0.5 } })),
            Some(0.5)
        );
    }

    #[test]
    fn chat_audio_without_audio_is_uncertain_delivery() {
        let error = collect_chat_audio(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n",
            "wav",
        )
        .unwrap_err();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
    }

    #[tokio::test]
    async fn transcribe_audio_sends_json_input_audio() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"text":"hello","usage":{"cost":0.0005}}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let out = p
            .transcribe_audio(
                "openai/whisper-large-v3",
                &json!({
                    "file": "AQID",
                    "filename": "clip.MP3",
                    "language": "en",
                    "response_format": "text",
                    "prompt": "names"
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["text"], json!("hello"));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/audio/transcriptions");
        let sent = reqs[0].json();
        assert_eq!(sent["model"], json!("openai/whisper-large-v3"));
        assert_eq!(
            sent["input_audio"],
            json!({ "data": "AQID", "format": "mp3" })
        );
        assert_eq!(sent["language"], json!("en"));
        assert!(sent.get("response_format").is_none());
        assert!(sent.get("prompt").is_none());
        assert!(sent.get("file").is_none());
        assert_eq!(sent["provider"]["zdr"], json!(true));
    }

    #[tokio::test]
    async fn transcribe_audio_rejects_invalid_audio_before_sending() {
        let server = MockServer::always(MockResponse::ok_json("{}")).await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        for body in [
            json!({}),
            json!({ "file": "not base64!" }),
            json!({ "file": "AQID", "format": "../wav" }),
        ] {
            assert!(p
                .transcribe_audio("openai/whisper-large-v3", &body)
                .await
                .is_err());
        }
        assert_eq!(server.request_count(), 0);
    }

    const VIDEO_ID: &str = "gen-vid-1789480874-Ab3dEf9hIjKlMnOpQrSt";

    #[tokio::test]
    async fn video_submits_polls_and_inlines_openrouter_hosted_content() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(format!(
                r#"{{"id":"{VIDEO_ID}","polling_url":"/api/v1/videos/{VIDEO_ID}","status":"pending"}}"#
            )),
            MockResponse::ok_json(format!(r#"{{"id":"{VIDEO_ID}","status":"in_progress"}}"#)),
            MockResponse::ok_json(format!(
                r#"{{"id":"{VIDEO_ID}","status":"completed","unsigned_urls":["{{{{BASE}}}}/videos/{VIDEO_ID}/content?index=0"],"usage":{{"cost":0.5}}}}"#
            )),
            MockResponse::ok_bytes("video/mp4", vec![0, 0, 0, 24]),
        ])
        .await;
        let p = provider_with(
            server.base_url().to_string(),
            vec!["sk-video"],
            Default::default(),
        );
        let accepted = p
            .submit_video_bound(
                "openrouter/google/veo-3.1",
                &json!({ "prompt": "a fox", "duration": 8, "n": 1 }),
            )
            .await
            .unwrap();
        assert_eq!(accepted.initial.status, JobStatus::Queued);

        let running = accepted.origin.poll().await.unwrap();
        assert_eq!(running.status, JobStatus::Running);
        let done = accepted.origin.poll().await.unwrap();
        assert_eq!(done.status, JobStatus::Succeeded);
        let output = done.output.unwrap();
        assert_eq!(
            output["data"][0]["url"],
            json!("data:video/mp4;base64,AAAAGA==")
        );
        assert_eq!(output["usage"]["cost"], json!(0.5));

        let reqs = server.requests();
        assert_eq!(reqs[0].path, "/videos");
        let sent = reqs[0].json();
        assert_eq!(sent["model"], json!("google/veo-3.1"));
        assert_eq!(sent["duration"], json!(8));
        assert!(sent.get("n").is_none());
        assert_eq!(reqs[1].method, "GET");
        assert_eq!(reqs[1].path, format!("/videos/{VIDEO_ID}"));
        assert_eq!(reqs[3].path, format!("/videos/{VIDEO_ID}/content"));
        assert_eq!(reqs[3].query.as_deref(), Some("index=0"));
        assert!(reqs
            .iter()
            .all(|request| request.header("authorization").as_deref() == Some("Bearer sk-video")));
    }

    #[tokio::test]
    async fn completed_video_passes_third_party_https_urls_through() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(format!(r#"{{"id":"{VIDEO_ID}","status":"pending"}}"#)),
            MockResponse::ok_json(format!(
                r#"{{"id":"{VIDEO_ID}","status":"completed","unsigned_urls":["https://cdn.example/v.mp4"]}}"#
            )),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let accepted = p
            .submit_video_bound("google/veo-3.1", &json!({ "prompt": "a fox" }))
            .await
            .unwrap();
        let done = accepted.origin.poll().await.unwrap();
        assert_eq!(
            done.output.unwrap()["data"][0]["url"],
            json!("https://cdn.example/v.mp4")
        );
        assert_eq!(server.request_count(), 2);
    }

    #[tokio::test]
    async fn video_poll_reports_failures_without_leaking_upstream_text() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(format!(r#"{{"id":"{VIDEO_ID}","status":"pending"}}"#)),
            MockResponse::json(401, r#"{"error":{"message":"sk-secret rejected"}}"#),
            MockResponse::ok_json(r#"{"id":"gen-vid-1-AAAAAAAAAAAAAAAAAAAA","status":"pending"}"#),
            MockResponse::ok_json(format!(
                r#"{{"id":"{VIDEO_ID}","status":"failed","error":"sk-secret upstream detail"}}"#
            )),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let accepted = p
            .submit_video_bound("google/veo-3.1", &json!({ "prompt": "a fox" }))
            .await
            .unwrap();
        assert_eq!(
            accepted.origin.poll().await.unwrap_err(),
            VideoPollError::CredentialRejected
        );
        assert_eq!(
            accepted.origin.poll().await.unwrap_err(),
            VideoPollError::InvalidResponse
        );
        let failed = accepted.origin.poll().await.unwrap();
        assert_eq!(failed.status, JobStatus::Failed);
        assert!(!failed.error.unwrap().contains("sk-secret"));
    }

    #[tokio::test]
    async fn completed_video_never_sends_the_key_to_other_openrouter_paths() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(format!(r#"{{"id":"{VIDEO_ID}","status":"pending"}}"#)),
            MockResponse::ok_json(format!(
                r#"{{"id":"{VIDEO_ID}","status":"completed","unsigned_urls":["/keys"]}}"#
            )),
            MockResponse::ok_json(format!(r#"{{"id":"{VIDEO_ID}","status":"completed"}}"#)),
            MockResponse::ok_json(r#"{"data":"not a video"}"#),
        ])
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let accepted = p
            .submit_video_bound("google/veo-3.1", &json!({ "prompt": "a fox" }))
            .await
            .unwrap();
        assert_eq!(
            accepted.origin.poll().await.unwrap_err(),
            VideoPollError::InvalidResponse
        );
        assert_eq!(server.request_count(), 2);
        // The job's own content endpoint is used, but a non-video body is refused.
        assert_eq!(
            accepted.origin.poll().await.unwrap_err(),
            VideoPollError::InvalidResponse
        );
        assert_eq!(
            server.requests()[3].path,
            format!("/videos/{VIDEO_ID}/content")
        );
    }

    #[tokio::test]
    async fn oversized_completed_video_fails_the_job_instead_of_polling_again() {
        let server = MockServer::start(vec![
            MockResponse::ok_json(format!(
                r#"{{"id":"{VIDEO_ID}","status":"completed","usage":{{"cost":0.5}}}}"#
            )),
            MockResponse::ok_bytes("video/mp4", vec![0; 64]),
        ])
        .await;
        let origin = OpenRouterVideoOrigin {
            client: reqwest::Client::new(),
            key: "k".to_owned(),
            base_url: server.base_url().to_owned(),
            id: VIDEO_ID.to_owned(),
            inline_limit: 32,
        };
        let failed = origin.poll().await.unwrap();
        assert_eq!(failed.status, JobStatus::Failed);
        assert!(failed.output.is_none());
        assert_eq!(failed.error.as_deref(), Some(VIDEO_TOO_LARGE));
        assert_eq!(
            server.requests()[1].path,
            format!("/videos/{VIDEO_ID}/content")
        );
    }

    #[tokio::test]
    async fn video_submission_rejects_unusable_job_ids_and_multiple_outputs() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"id":"../../keys","status":"pending"}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let error = p
            .submit_video_bound("google/veo-3.1", &json!({ "prompt": "a fox", "n": 2 }))
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("one video"));
        assert_eq!(server.request_count(), 0);

        let error = p
            .submit_video_bound("google/veo-3.1", &json!({ "prompt": "a fox" }))
            .await
            .err()
            .unwrap();
        assert!(matches!(error, ProviderError::DeliveryUncertain(_)));
    }

    #[tokio::test]
    async fn discovery_lists_every_modality_and_labels_media_models() {
        let server = MockServer::always(MockResponse::ok_json(
            r#"{"data":[
                {"id":"openai/gpt-5","architecture":{"output_modalities":["text"]}},
                {"id":"google/gemini-image","architecture":{"output_modalities":["image","text"]}},
                {"id":"bytedance-seed/seedream-4.5","architecture":{"output_modalities":["image"]}},
                {"id":"elevenlabs/eleven-v4","architecture":{"output_modalities":["speech"]}},
                {"id":"openai/whisper-large-v3","architecture":{"output_modalities":["transcription"]}},
                {"id":"google/veo-3.1","architecture":{"output_modalities":["video"]}},
                {"id":"voyageai/voyage-4","architecture":{"output_modalities":["embeddings"]}},
                {"id":"cohere/rerank-4","architecture":{"output_modalities":["rerank"]}},
                {"id":"google/lyria-3-pro-preview","architecture":{"output_modalities":["text","audio"]}},
                {"id":"vendor/classifier","architecture":{"output_modalities":["decisions"]}}
            ]}"#,
        ))
        .await;
        let p = provider_with(server.base_url().to_string(), vec!["k"], Default::default());
        let models = p.discover_models().await.unwrap();
        assert_eq!(
            server.requests()[0].query.as_deref(),
            Some("output_modalities=all")
        );
        let modality = |id: &str| {
            models
                .iter()
                .find(|model| model["id"] == id)
                .map(|model| model.get("modality").cloned())
        };
        assert_eq!(modality("openai/gpt-5"), Some(None));
        assert_eq!(modality("google/gemini-image"), Some(None));
        assert_eq!(
            modality("bytedance-seed/seedream-4.5"),
            Some(Some(json!("image")))
        );
        assert_eq!(modality("elevenlabs/eleven-v4"), Some(Some(json!("tts"))));
        assert_eq!(
            modality("openai/whisper-large-v3"),
            Some(Some(json!("stt")))
        );
        assert_eq!(modality("google/veo-3.1"), Some(Some(json!("video"))));
        assert_eq!(
            modality("voyageai/voyage-4"),
            Some(Some(json!("embedding")))
        );
        assert_eq!(modality("cohere/rerank-4"), Some(Some(json!("rerank"))));
        assert_eq!(modality("google/lyria-3-pro-preview"), Some(None));
        assert_eq!(modality("vendor/classifier"), None);
        assert!(
            p.wants_chat_audio("openrouter/google/lyria-3-pro-preview", &json!({}))
                .await
        );
        assert!(!p.wants_chat_audio("elevenlabs/eleven-v4", &json!({})).await);
        assert_eq!(server.request_count(), 1);
    }

    #[test]
    fn upstream_model_keeps_router_slugs_and_strips_routing_prefix() {
        assert_eq!(upstream_model("openrouter/auto"), "openrouter/auto");
        assert_eq!(
            upstream_model("openrouter/google/veo-3.1"),
            "google/veo-3.1"
        );
        assert_eq!(upstream_model("google/veo-3.1"), "google/veo-3.1");
    }
}
