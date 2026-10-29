//! freetoken is externally managed: Ryu adopts its loopback API, while
//! FreeToken owns its CUDA runtime, loaded model, and model files.

use serde::Deserialize;

use super::adopted::{AdoptedEngine, AdoptedProbe};

pub const ENGINE_NAME: &str = "freetoken";
/// FreeToken's external API default. Not profile-shifted because Ryu does not spawn it.
pub const BASE_URL: &str = "http://127.0.0.1:1919";
const SETUP_HINT: &str = "Install FreeToken on a supported Windows/Linux x86_64 NVIDIA node, load a model, and enable its local API at http://127.0.0.1:1919. For the CLI, use ft serve --model /path/to/model --host 127.0.0.1 --port 1919. Then try Add again. For a remote URL or API key, configure an OpenAI-compatible provider in Settings.";
const PLATFORM_HINT: &str = "FreeToken requires a Windows/Linux x86_64 node with a supported NVIDIA GPU; there is no native macOS runtime. Connect Ryu to a supported node or use a remote OpenAI-compatible provider.";

#[derive(Deserialize)]
struct ServerHealth {
    status: String,
    #[serde(default)]
    maintenance: Option<String>,
}

#[derive(Deserialize)]
struct ModelList {
    data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
    #[serde(default)]
    owned_by: String,
}

/// The FreeToken marker for [`AdoptedEngine`].
pub struct FreeToken;

impl AdoptedProbe for FreeToken {
    const ENGINE: &'static str = ENGINE_NAME;
    const LABEL: &'static str = "freetoken";
    const DEFAULT_BASE: &'static str = BASE_URL;
    const SETUP_HINT: &'static str = SETUP_HINT;
    const PLATFORM_HINT: &'static str = PLATFORM_HINT;

    fn supported() -> bool {
        crate::catalog::registry::supported_on_node(ENGINE_NAME)
    }

    async fn probe(client: &reqwest::Client, base_url: &str) -> anyhow::Result<()> {
        let response = client.get(format!("{base_url}/health")).send().await?;
        anyhow::ensure!(
            response.status().is_success(),
            "FreeToken health endpoint is unavailable"
        );
        let health = response.json::<ServerHealth>().await?;
        anyhow::ensure!(
            health.status == "ok",
            "FreeToken has not finished loading or reported an error"
        );
        anyhow::ensure!(
            health
                .maintenance
                .as_deref()
                .is_none_or(|state| state == "serving"),
            "FreeToken is undergoing maintenance and cannot serve chat yet"
        );
        let models = fetch_models(client, base_url).await?;
        anyhow::ensure!(!models.is_empty(), "FreeToken has no served model");
        Ok(())
    }
}

async fn fetch_models(
    client: &reqwest::Client,
    base_url: &str,
) -> anyhow::Result<Vec<crate::sidecar::adapters::EngineModel>> {
    let response = client.get(format!("{base_url}/v1/models")).send().await?;
    anyhow::ensure!(
        response.status().is_success(),
        "FreeToken models endpoint is unavailable or requires authentication"
    );
    let list = response.json::<ModelList>().await?;
    let mut seen = std::collections::HashSet::new();
    Ok(list
        .data
        .into_iter()
        .filter_map(|model| {
            let id = model.id.trim();
            if id.is_empty()
                || !model.owned_by.eq_ignore_ascii_case("freetoken")
                || !seen.insert(id.to_owned())
            {
                return None;
            }
            Some(crate::sidecar::adapters::EngineModel {
                id: id.to_owned(),
                name: id.to_owned(),
            })
        })
        .collect())
}

pub type FreeTokenManager = AdoptedEngine<FreeToken>;

impl AdoptedEngine<FreeToken> {
    pub async fn chat_models(&self) -> anyhow::Result<Vec<crate::sidecar::adapters::EngineModel>> {
        anyhow::ensure!(self.supported, PLATFORM_HINT);
        fetch_models(&self.client, &self.base_url).await
    }
}

#[cfg(test)]
mod tests;
