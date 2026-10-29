//! llama-swap is externally managed: Ryu adopts its loopback API, while
//! llama-swap owns its YAML configuration, backend commands, and model swapping.

use serde::Deserialize;

use super::adopted::{AdoptedEngine, AdoptedProbe};

pub const ENGINE_NAME: &str = "llama-swap";
/// Dedicated external endpoint, avoiding llama.cpp's :8080. Not profile-shifted.
pub const BASE_URL: &str = "http://127.0.0.1:9292";
const SETUP_HINT: &str = "Install and configure llama-swap from https://github.com/mostlygeek/llama-swap, then start it with --listen 127.0.0.1:9292 --config /path/to/config.yaml and try Add again. Models and backend commands stay in llama-swap. For another address or an API key, use an OpenAI-compatible provider in Settings.";

#[derive(Deserialize)]
struct ModelList {
    data: Vec<Model>,
}

#[derive(Deserialize, Default)]
struct Architecture {
    #[serde(default)]
    input_modalities: Vec<String>,
    #[serde(default)]
    output_modalities: Vec<String>,
}

#[derive(Deserialize, Default)]
struct Capabilities {
    #[serde(default)]
    reranker: bool,
}

#[derive(Deserialize)]
struct Model {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    architecture: Architecture,
    #[serde(default)]
    capabilities: Capabilities,
}

impl Model {
    fn is_chat(&self) -> bool {
        // Older configurations omit capabilities entirely. Keep their IDs usable,
        // but do not offer explicitly image/audio-only or reranking models as chat.
        !self.capabilities.reranker
            && (self.architecture.input_modalities.is_empty()
                || self
                    .architecture
                    .input_modalities
                    .iter()
                    .any(|m| m == "text"))
            && (self.architecture.output_modalities.is_empty()
                || self
                    .architecture
                    .output_modalities
                    .iter()
                    .any(|m| m == "text"))
    }
}

/// The llama-swap marker for [`AdoptedEngine`].
pub struct LlamaSwap;

impl AdoptedProbe for LlamaSwap {
    const ENGINE: &'static str = ENGINE_NAME;
    const LABEL: &'static str = "llama-swap";
    const DEFAULT_BASE: &'static str = BASE_URL;
    const SETUP_HINT: &'static str = SETUP_HINT;

    async fn probe(client: &reqwest::Client, base_url: &str) -> anyhow::Result<()> {
        let health = client
            .get(format!("{base_url}/health"))
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;
        anyhow::ensure!(health.trim() == "OK", "llama-swap is not healthy");
        // Health alone can succeed while inference endpoints require an API key.
        client
            .get(format!("{base_url}/v1/models"))
            .send()
            .await?
            .error_for_status()?
            .json::<ModelList>()
            .await?;
        Ok(())
    }
}

pub type LlamaSwapManager = AdoptedEngine<LlamaSwap>;

impl AdoptedEngine<LlamaSwap> {
    pub async fn chat_models(&self) -> anyhow::Result<Vec<crate::sidecar::adapters::EngineModel>> {
        let response = self
            .client
            .get(format!("{}/v1/models", self.base_url))
            .send()
            .await?
            .error_for_status()?
            .json::<ModelList>()
            .await?;
        let mut seen = std::collections::HashSet::new();
        Ok(response
            .data
            .into_iter()
            .filter_map(|entry| {
                let id = entry.id.trim();
                if id.is_empty() || !entry.is_chat() || !seen.insert(id.to_owned()) {
                    return None;
                }
                Some(crate::sidecar::adapters::EngineModel {
                    id: id.to_owned(),
                    name: if entry.name.trim().is_empty() {
                        id.to_owned()
                    } else {
                        entry.name.trim().to_owned()
                    },
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests;
