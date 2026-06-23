use std::sync::Arc;

use super::ollama::OllamaProvider;
use super::{openai_compat::OpenAICompatClient, LlmProvider, LlmRequest, LlmResponse};
use crate::config::LlmConfig;

/// Routes all LLM requests through a single configured provider.
/// Optionally holds a local Ollama provider for latency-sensitive paths.
pub struct LlmOrchestrator {
    provider: Arc<dyn LlmProvider>,
    local: Option<Arc<OllamaProvider>>,
}

impl LlmOrchestrator {
    pub fn new(config: &LlmConfig) -> Self {
        let client = OpenAICompatClient::new(
            config.base_url.clone(),
            config.model.clone(),
            config.api_key.clone(),
        );

        // If the configured base_url looks like an Ollama instance (port 11434),
        // also spin up a probing OllamaProvider for latency-sensitive callers.
        let local = if config.base_url.contains("11434") || config.api_key.is_empty() {
            let ollama_base = config
                .base_url
                .trim_end_matches("/v1")
                .trim_end_matches('/')
                .to_string();
            Some(OllamaProvider::new(ollama_base, Some(config.model.clone())))
        } else {
            None
        };

        Self {
            provider: Arc::new(client),
            local,
        }
    }

    pub fn provider(&self) -> Arc<dyn LlmProvider> {
        Arc::clone(&self.provider)
    }

    /// Returns the local Ollama provider, if configured and reachable.
    pub fn local(&self) -> Option<Arc<OllamaProvider>> {
        self.local
            .as_ref()
            .filter(|p| p.is_available())
            .map(Arc::clone)
    }

    /// Returns the local provider regardless of availability (for explicit opt-in).
    pub fn local_unchecked(&self) -> Option<Arc<OllamaProvider>> {
        self.local.as_ref().map(Arc::clone)
    }

    pub async fn generate(&self, req: LlmRequest) -> anyhow::Result<LlmResponse> {
        self.provider.generate(req).await
    }

    pub async fn stream(
        &self,
        req: LlmRequest,
        on_token: &mut (dyn FnMut(String) + Send),
    ) -> anyhow::Result<LlmResponse> {
        self.provider.stream(req, on_token).await
    }
}
