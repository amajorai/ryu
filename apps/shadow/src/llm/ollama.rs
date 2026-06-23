use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use anyhow::Result;
use async_trait::async_trait;
use reqwest::Client;
use tokio::time::Duration;

use super::{openai_compat::OpenAICompatClient, LlmProvider, LlmRequest, LlmResponse};

const PROBE_INTERVAL: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_MODEL: &str = "qwen2.5:7b-instruct";

/// Ollama local inference provider.
///
/// Wraps an OpenAI-compatible client (Ollama exposes `/v1/chat/completions`)
/// and augments it with background availability probing. Callers can check
/// `is_available()` before dispatching to avoid blocking on a downed daemon.
pub struct OllamaProvider {
    inner: OpenAICompatClient,
    probe_client: Client,
    base_url: String,
    available: Arc<AtomicBool>,
}

impl OllamaProvider {
    /// Create a new provider. `base_url` should be the Ollama base URL without
    /// a trailing `/v1` — e.g. `"http://localhost:11434"`.
    pub fn new(base_url: impl Into<String>, model: Option<String>) -> Arc<Self> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
        let v1_url = format!("{}/v1", base_url);
        let probe_client = Client::builder()
            .timeout(PROBE_TIMEOUT)
            .build()
            .expect("probe client");
        let provider = Arc::new(Self {
            inner: OpenAICompatClient::new(v1_url, model, String::new()),
            probe_client,
            base_url,
            available: Arc::new(AtomicBool::new(false)),
        });
        // Kick off background probing
        {
            let p = Arc::clone(&provider);
            tokio::spawn(async move { p.probe_loop().await });
        }
        provider
    }

    /// Returns `true` if Ollama was reachable during the last probe.
    pub fn is_available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    /// Perform a single availability check. Probes `/api/tags` which is
    /// a cheap native Ollama endpoint.
    pub async fn probe_once(&self) -> bool {
        let url = format!("{}/api/tags", self.base_url);
        match self.probe_client.get(&url).send().await {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }

    async fn probe_loop(&self) {
        loop {
            let ok = self.probe_once().await;
            let was_ok = self.available.swap(ok, Ordering::Relaxed);
            if ok && !was_ok {
                tracing::info!("Ollama became available at {}", self.base_url);
            } else if !ok && was_ok {
                tracing::warn!("Ollama became unavailable at {}", self.base_url);
            }
            tokio::time::sleep(PROBE_INTERVAL).await;
        }
    }
}

#[async_trait]
impl LlmProvider for OllamaProvider {
    async fn generate(&self, req: LlmRequest) -> Result<LlmResponse> {
        self.inner.generate(req).await
    }

    async fn stream(
        &self,
        req: LlmRequest,
        on_token: &mut (dyn FnMut(String) + Send),
    ) -> Result<LlmResponse> {
        self.inner.stream(req, on_token).await
    }
}
