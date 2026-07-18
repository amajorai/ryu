//! Core-side host shim for the extracted [`ryu_predict`] crate.
//!
//! The predictive-typing completion engine (config, per-app allowlist, secure-field
//! denylist, prompt assembly, reply cleanup) and the `/api/predict/*` surface now
//! live in `crates/ryu-predict`. That crate has ZERO dependency on `apps/core`;
//! every cross-cutting call it needs is inverted through the
//! [`ryu_predict::PredictHost`] trait. This module is Core's implementation of that
//! trait, wiring the crate to Core's real machinery:
//!
//! - **enabled flag** → [`crate::predict::is_enabled`] (the plugin-owned kernel
//!   switch, seeded at boot + flipped on plugin enable/disable — stays in Core),
//! - **preferences** → [`crate::server::ServerState::preferences`],
//! - **agent-bound model** → [`crate::server::ServerState::agent_store`],
//! - **default model** → [`crate::registry::DEFAULT_LLM_MODEL`],
//! - **Gateway side-model call** → [`crate::server::call_side_model`] (the same
//!   path `/btw`, goal, and double-check use).

use async_trait::async_trait;

use crate::server::ServerState;

/// Core's implementation of [`ryu_predict::PredictHost`].
pub struct CorePredictHost {
    state: ServerState,
}

impl CorePredictHost {
    pub fn new(state: ServerState) -> Self {
        Self { state }
    }
}

#[async_trait]
impl ryu_predict::PredictHost for CorePredictHost {
    fn is_enabled(&self) -> bool {
        crate::predict::is_enabled()
    }

    async fn pref_get(&self, key: &str) -> Option<String> {
        self.state.preferences.get(key).await.ok().flatten()
    }

    async fn pref_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.state
            .preferences
            .set(key, value)
            .await
            .map_err(|e| e.to_string())
    }

    async fn agent_bound_model(&self, agent_id: &str) -> Option<String> {
        if let Ok(Some(agent)) = self.state.agent_store.get(agent_id).await {
            agent
                .chat_model
                .as_ref()
                .and_then(|s| s.model_id.clone())
                .or(agent.model.clone())
        } else {
            None
        }
    }

    fn default_model(&self) -> String {
        crate::registry::DEFAULT_LLM_MODEL.to_string()
    }

    async fn call_side_model(
        &self,
        model: &str,
        effort: &str,
        system: &str,
        user: &str,
    ) -> Result<String, String> {
        crate::server::call_side_model(&self.state, model, effort, system, user).await
    }
}
