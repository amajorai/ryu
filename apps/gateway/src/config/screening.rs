//! `[screening]`: where this machine's hazard screener backends live
//! (managed guardrails screener addendum section 5.2).
//!
//! Endpoints are a property of the machine, so they live here or in env.
//! Policy (which backend fills which role, thresholds, qualifications and
//! remote-processor records) lives in the platform floor on the hosted fleet
//! and is never read from this section there. On a self-hosted node the
//! operator opts in with `node_classifiers = true`, and the node's own
//! screener runs at node tier, never bound by Ryu's floor.
//!
//! On Fleet custody `PUT /v1/config` refuses a `screening` patch with 403
//! `platform_locked`, so a config write cannot repoint a floor backend.
//!
//! ```toml
//! [screening]
//! node_classifiers = false
//!
//! [screening.backends.decision_local]
//! kind = "decision_local"
//! base_url = "http://127.0.0.1:11435/v1/systemone"
//! model = "laya"
//! weights_sha256_env = "RYU_SCREENER_DECISION_SHA256"
//!
//! [screening.backends.jev]
//! kind = "decision_remote"
//! base_url = "https://api.typesafe.ai/v1/systemone"
//! model = "jev-latest"
//! api_key_env = "RYU_SCREENER_JEV_API_KEY"
//! processor_id = "typesafe"
//! allow_remote_processor = false
//! ```

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The default per-org request budget per minute while the screener runs in
/// degraded mode (spec 02.9 `degraded_min_rpm`).
pub const DEFAULT_DEGRADED_RPM: u32 = 30;

/// The `[screening]` section.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScreeningConfig {
    /// Self-hosted opt-in to run the node's own screener on its traffic.
    /// Ignored on the hosted fleet, where the platform floor decides.
    #[serde(default)]
    pub node_classifiers: bool,
    /// Requests per minute each org may send while screening is degraded
    /// on this replica. The first request always passes.
    #[serde(default = "default_degraded_rpm")]
    pub degraded_rpm: u32,
    /// Backend endpoints by id. The floor's roles name these ids.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub backends: BTreeMap<String, ScreeningBackendConfig>,
}

impl Default for ScreeningConfig {
    fn default() -> Self {
        Self {
            node_classifiers: false,
            degraded_rpm: DEFAULT_DEGRADED_RPM,
            backends: BTreeMap::new(),
        }
    }
}

impl ScreeningConfig {
    /// Whether the section is untouched, so a saved `gateway.toml` stays
    /// byte-identical when nobody authored it.
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

fn default_degraded_rpm() -> u32 {
    DEFAULT_DEGRADED_RPM
}

fn default_template_version() -> u32 {
    1
}

/// The kind of one backend (addendum section 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScreeningBackendKind {
    /// A guard model (Llama Guard, Qwen3Guard) on an OpenAI-compatible engine.
    GuardModel,
    /// A closed-choice decision model on the `systemone` wire on loopback or
    /// a private network (Laya, Ollaya, Kev). The primary screener.
    DecisionLocal,
    /// A remote decision API on the same wire (Jev). Opt-in, and refused for
    /// floor traffic without an approved retention record in the floor.
    DecisionRemote,
    /// The LLM-judge inspector on a pinned endpoint.
    Inspector,
}

impl ScreeningBackendKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GuardModel => "guard_model",
            Self::DecisionLocal => "decision_local",
            Self::DecisionRemote => "decision_remote",
            Self::Inspector => "inspector",
        }
    }
}

/// One `[screening.backends.<id>]` table. Each value may be given inline or
/// through the `*_env` variable naming it; the inline value wins.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScreeningBackendConfig {
    pub kind: ScreeningBackendKind,
    /// Guard models only: `llama_guard` or `qwen3guard`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialect: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_env: Option<String>,
    /// The sha256 of the served weights. Required for a local decision model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights_sha256_env: Option<String>,
    #[serde(default = "default_template_version")]
    pub template_version: u32,
    /// Guard models only: whether the engine accepts images.
    #[serde(default)]
    pub images: bool,
    /// The variable holding a bearer: the remote processor's key, or a guard
    /// engine's static key on a private network. Never the value itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    /// Remote processors only: the processor the floor's record names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub processor_id: Option<String>,
    /// Remote processors on a self-hosted node: the operator's opt-in to
    /// send prompts to the third party. The fleet reads the floor record.
    #[serde(default)]
    pub allow_remote_processor: bool,
    /// Whether a non-loopback local endpoint is on a private network (the
    /// fleet's screening network). Loopback hosts are detected.
    #[serde(default)]
    pub private_network: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hard_timeout_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<usize>,
}

impl ScreeningBackendConfig {
    /// A backend of `kind` with every optional field empty.
    pub fn of_kind(kind: ScreeningBackendKind) -> Self {
        Self {
            kind,
            dialect: None,
            base_url: None,
            base_url_env: None,
            model: None,
            model_env: None,
            weights_sha256: None,
            weights_sha256_env: None,
            template_version: default_template_version(),
            images: false,
            api_key_env: None,
            processor_id: None,
            allow_remote_processor: false,
            private_network: false,
            hard_timeout_ms: None,
            max_concurrency: None,
        }
    }

    /// The inline value, else the named variable's value, trimmed.
    pub fn resolve(
        inline: Option<&str>,
        env: Option<&str>,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Option<String> {
        inline
            .map(str::to_owned)
            .or_else(|| env.and_then(lookup))
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_addendum_shape_and_refuses_unknown_keys() {
        let parsed: ScreeningConfig = toml::from_str(
            r#"
            node_classifiers = true
            [backends.decision_local]
            kind = "decision_local"
            base_url = "http://127.0.0.1:11435/v1/systemone"
            model = "laya"
            weights_sha256 = "0123456789abcdef"
            [backends.jev]
            kind = "decision_remote"
            base_url = "https://api.typesafe.ai/v1/systemone"
            model = "jev-latest"
            api_key_env = "RYU_SCREENER_JEV_API_KEY"
            processor_id = "typesafe"
            "#,
        )
        .expect("parses");
        assert!(parsed.node_classifiers);
        assert_eq!(parsed.degraded_rpm, DEFAULT_DEGRADED_RPM);
        assert_eq!(
            parsed.backends["decision_local"].kind,
            ScreeningBackendKind::DecisionLocal
        );
        assert!(!parsed.backends["jev"].allow_remote_processor);

        let unknown = toml::from_str::<ScreeningConfig>(
            r#"
            [backends.x]
            kind = "decision_local"
            api_key = "inline secrets are not a field"
            "#,
        );
        assert!(unknown.is_err());
        assert!(ScreeningConfig::default().is_default());
    }

    #[test]
    fn inline_values_win_over_the_named_variable() {
        let lookup = |name: &str| (name == "URL_VAR").then(|| " http://env ".to_owned());
        assert_eq!(
            ScreeningBackendConfig::resolve(Some("http://inline"), Some("URL_VAR"), &lookup),
            Some("http://inline".to_owned())
        );
        assert_eq!(
            ScreeningBackendConfig::resolve(None, Some("URL_VAR"), &lookup),
            Some("http://env".to_owned())
        );
        assert_eq!(
            ScreeningBackendConfig::resolve(None, Some("MISSING"), &lookup),
            None
        );
    }
}
