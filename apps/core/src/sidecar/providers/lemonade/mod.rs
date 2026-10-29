//! Lemonade Server is externally managed: Ryu adopts its loopback API, while
//! Lemonade owns installation, acceleration backends, and model storage.

use serde::Deserialize;

use super::adopted::{AdoptedEngine, AdoptedProbe};

pub const ENGINE_NAME: &str = "lemonade";
/// External service port, intentionally not shifted by the Ryu profile.
pub const BASE_URL: &str = "http://127.0.0.1:13305";
const SETUP_HINT: &str = "Install and start Lemonade Server from https://lemonade-server.ai/ on this node, with its local API at http://127.0.0.1:13305, then try Add again. Manage model downloads in Lemonade. For a custom address or API key, use an OpenAI-compatible provider in Settings.";

#[derive(Deserialize)]
struct ServerHealth {
    status: String,
    version: String,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
    #[serde(default)]
    recipe: String,
    #[serde(default)]
    labels: Vec<String>,
    downloaded: Option<bool>,
    #[serde(default)]
    embedding: bool,
    #[serde(default)]
    reranking: bool,
}

impl Model {
    fn is_chat(&self) -> bool {
        if self.downloaded == Some(false) || self.embedding || self.reranking {
            return false;
        }
        if self.labels.iter().any(|label| {
            matches!(
                label.as_str(),
                "transcription"
                    | "embeddings"
                    | "embedding"
                    | "reranking"
                    | "image"
                    | "tts"
                    | "audio-generation"
                    | "classification"
                    | "classifier"
                    | "3d"
            )
        }) {
            return false;
        }
        self.labels.iter().any(|label| label == "chat")
            || matches!(
                self.recipe.as_str(),
                "llamacpp" | "flm" | "ryzenai-llm" | "oga" | "vllm" | "collection.omni"
            )
    }
}

/// The Lemonade Server marker for [`AdoptedEngine`].
pub struct Lemonade;

impl AdoptedProbe for Lemonade {
    const ENGINE: &'static str = ENGINE_NAME;
    const LABEL: &'static str = "Lemonade";
    const ADOPTED_LABEL: &'static str = "Lemonade Server";
    const DEFAULT_BASE: &'static str = BASE_URL;
    const SETUP_HINT: &'static str = SETUP_HINT;

    async fn probe(client: &reqwest::Client, base_url: &str) -> anyhow::Result<()> {
        let health = client
            .get(format!("{base_url}/v1/health"))
            .send()
            .await?
            .error_for_status()?
            .json::<ServerHealth>()
            .await?;
        anyhow::ensure!(
            health.status == "ok" && !health.version.trim().is_empty(),
            "Lemonade is not healthy"
        );
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

pub type LemonadeManager = AdoptedEngine<Lemonade>;

impl AdoptedEngine<Lemonade> {
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
                    name: id.to_owned(),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests;
