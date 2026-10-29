//! Magnitude is externally managed: Ryu adopts its loopback inference API,
//! while Magnitude owns installation, hardware tuning, and model storage.
//!
//! Magnitude serves on `:10100` while its desktop app or `magnitude serve` is
//! running. The OpenAI-compatible API lives under `/inference/v1` (not the bare
//! `/v1`), so [`BASE_URL`] carries the `/inference` prefix and the standard
//! `{base}/v1/chat/completions` join resolves to Magnitude's real path, the same
//! way Docker Model Runner's `/engines` prefix is absorbed.

use serde::Deserialize;

use super::adopted::{AdoptedEngine, AdoptedProbe};

pub const ENGINE_NAME: &str = "magnitude";
/// External service host, intentionally not shifted by the Ryu profile.
const HOST_URL: &str = "http://127.0.0.1:10100";
/// OpenAI-compatible base without the trailing `/v1`.
pub const BASE_URL: &str = "http://127.0.0.1:10100/inference";
const SETUP_HINT: &str = "Install Magnitude from https://magnitude.dev/download on this node, then open the app or run `magnitude serve` so its local API answers at http://127.0.0.1:10100, and try Add again. Download models in Magnitude (Discover, or `magnitude catalog pull <model-id>`). For a remote Magnitude server or an API key, use an OpenAI-compatible provider in Settings.";

#[derive(Deserialize)]
struct ModelList {
    data: Vec<Model>,
}

#[derive(Deserialize)]
struct Model {
    id: String,
}

/// The Magnitude marker for [`AdoptedEngine`]. Its `base_url` is [`HOST_URL`]:
/// the probe and model listing join their own `/health` and `/inference/v1`
/// paths onto the bare host.
pub struct Magnitude;

async fn list_models(client: &reqwest::Client, host_url: &str) -> anyhow::Result<ModelList> {
    Ok(client
        .get(format!("{host_url}/inference/v1/models"))
        .send()
        .await?
        .error_for_status()?
        .json::<ModelList>()
        .await?)
}

impl AdoptedProbe for Magnitude {
    const ENGINE: &'static str = ENGINE_NAME;
    const LABEL: &'static str = "Magnitude";
    const DEFAULT_BASE: &'static str = HOST_URL;
    const SETUP_HINT: &'static str = SETUP_HINT;

    async fn probe(client: &reqwest::Client, host_url: &str) -> anyhow::Result<()> {
        client
            .get(format!("{host_url}/health"))
            .send()
            .await?
            .error_for_status()?;
        // Health alone does not prove this port is Magnitude's inference API.
        list_models(client, host_url).await?;
        Ok(())
    }
}

pub type MagnitudeManager = AdoptedEngine<Magnitude>;

impl AdoptedEngine<Magnitude> {
    pub async fn chat_models(&self) -> anyhow::Result<Vec<crate::sidecar::adapters::EngineModel>> {
        let response = list_models(&self.client, &self.base_url).await?;
        let mut seen = std::collections::HashSet::new();
        Ok(response
            .data
            .into_iter()
            .filter_map(|entry| {
                let id = entry.id.trim();
                if id.is_empty() || !seen.insert(id.to_owned()) {
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
