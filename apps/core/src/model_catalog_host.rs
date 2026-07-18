//! Core's implementation of the extracted [`ryu_model_catalog::ModelCatalogHost`]
//! seam.
//!
//! The `ryu-model-catalog` crate owns the model catalog + device-fit primitive —
//! Hugging Face search/detail, GGUF tree inspection, per-node device detection and
//! fit estimation, installed-model tracking, and capability overrides. What it
//! cannot own — because they are process-global kernel concepts — are five
//! cross-cutting couplings this shim implements:
//!
//! - the active `~/.ryu` **data dir** ([`crate::paths::ryu_dir`], profile /
//!   relocation-aware), under which every catalog cache and downloaded weight
//!   lives,
//! - **Hugging Face bearer auth** ([`crate::hf_auth::authorize`], preferences-first
//!   then env), attached only to Hub requests,
//! - the per-node **engine-support gate** ([`crate::catalog::registry::supported_on_node`])
//!   that drives the format-compatibility verdict,
//! - the bundled **default-model repos** (the swappable [`crate::registry`]'s
//!   local chat + embed entries), used only to derive a real HF repo for
//!   origin-less pre-existing installs, and
//! - the **active-model preference** (the `ACTIVE_MODEL_PREF` KV entry read via
//!   [`crate::server::preferences`]).
//!
//! Core installs it once at boot via [`ryu_model_catalog::set_global_host`],
//! BEFORE any catalog route can run.

use std::path::PathBuf;
use std::sync::Arc;

use ryu_model_catalog::{DefaultModelRepos, ModelCatalogHost};

/// Install [`CoreModelCatalogHost`] as the process-global model-catalog host.
/// Idempotent (first install wins). Called once from `main` at boot; the catalog
/// is only reachable over HTTP routes, so it is never consulted before install.
pub fn install() {
    ryu_model_catalog::set_global_host(Arc::new(CoreModelCatalogHost));
}

/// Core's `ModelCatalogHost` — the kernel side of the model-catalog seam.
pub struct CoreModelCatalogHost;

#[async_trait::async_trait]
impl ModelCatalogHost for CoreModelCatalogHost {
    fn ryu_dir(&self) -> PathBuf {
        crate::paths::ryu_dir()
    }

    fn authorize_hf(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        crate::hf_auth::authorize(req)
    }

    fn supported_on_node(&self, engine: &str) -> bool {
        crate::catalog::registry::supported_on_node(engine)
    }

    fn default_model_repos(&self) -> DefaultModelRepos {
        let reg = crate::registry::ModelRegistry::from_env();
        [&reg.local_chat_model, &reg.local_embed_model]
            .into_iter()
            .map(|m| (m.id.clone(), m.weight_url.clone()))
            .collect()
    }

    async fn active_model_pref(&self) -> Option<String> {
        let prefs = crate::server::preferences::PreferencesStore::open_default().ok()?;
        prefs
            .get(ryu_model_catalog::installed::ACTIVE_MODEL_PREF)
            .await
            .ok()?
    }
}
