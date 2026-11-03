//! Per-stage backend selection (`[stage_backends]`).

use super::*;

/// The default active-backend id for every inverted pipeline stage: the built-in
/// in-process implementation, registered under `"builtin"` and active out of the
/// box. Nothing hardcoded — a plugin registers an alternative under a new id and
/// names it here (or via `PUT /v1/config { backends }`).
pub fn default_stage_backend() -> String {
    "builtin".to_string()
}

/// Skip serializing an unset `[pipeline]` table so an existing `gateway.toml`
/// stays byte-identical when no stage reorder/disable is configured.
pub(super) fn pipeline_order_is_default(
    cfg: &crate::pipeline::stages::PipelineOrderConfig,
) -> bool {
    cfg == &crate::pipeline::stages::PipelineOrderConfig::default()
}

/// Per-stage active-backend selection (W6a). One id per inverted stage naming
/// which registered backend is active; the registries themselves live in
/// `crate::{budget,cache,semantic_cache,audit,evals,circuit_breaker,rate_limit}`.
/// Every field defaults to `"builtin"`, so an absent `[backends]` table is
/// byte-identical to today. Selection is applied at `AppState` build and refused
/// fail-closed when an id is not registered (see `AppState::new`).
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct StageBackendsConfig {
    #[serde(default = "default_stage_backend")]
    pub budget: String,
    #[serde(default = "default_stage_backend")]
    pub cache: String,
    #[serde(default = "default_stage_backend")]
    pub semantic_cache: String,
    #[serde(default = "default_stage_backend")]
    pub audit: String,
    #[serde(default = "default_stage_backend")]
    pub evals: String,
    #[serde(default = "default_stage_backend")]
    pub circuit_breaker: String,
    #[serde(default = "default_stage_backend")]
    pub rate_limit: String,
    #[serde(default = "default_stage_backend")]
    pub firewall: String,
    /// The routing layer: `"builtin"` (Ryu's own model-map + prefix routing), or
    /// an upstream router — `"openrouter"`, `"litellm"`, `"local"` — that takes
    /// `router/<model>` ids and every model the built-in table would hand to
    /// `default_provider`. Applied live by `PUT /v1/config { backends }`.
    #[serde(default = "default_stage_backend")]
    pub router: String,
    #[serde(default = "default_stage_backend")]
    pub smart_router: String,
    #[serde(default = "default_stage_backend")]
    pub passthrough: String,
    /// The connections layer: which managed connection provider (`"composio"`,
    /// `"treg"`) answers `/v1/providers/*` calls that do not name one.
    /// `"builtin"` resolves to the only configured provider, else none — so a
    /// caller that names its provider is unaffected. Applied live.
    #[serde(default = "default_stage_backend")]
    pub connections: String,
}

/// A partial `[backends]` update, as `PUT /v1/config { backends }` accepts it.
///
/// Every field is optional and an omitted field keeps the persisted selection,
/// so changing one layer (`router`, `connections`) never resets another stage.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct StageBackendsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_cache: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evals: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub circuit_breaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub firewall: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub router: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart_router: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passthrough: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections: Option<String>,
}

impl StageBackendsPatch {
    /// The full selection after applying this patch to `base`.
    pub fn apply_to(&self, mut base: StageBackendsConfig) -> StageBackendsConfig {
        macro_rules! merge {
            ($($field:ident),*) => {
                $(if let Some(value) = &self.$field {
                    base.$field.clone_from(value);
                })*
            };
        }
        merge!(
            budget,
            cache,
            semantic_cache,
            audit,
            evals,
            circuit_breaker,
            rate_limit,
            firewall,
            router,
            smart_router,
            passthrough,
            connections
        );
        base
    }
}

impl Default for StageBackendsConfig {
    fn default() -> Self {
        Self {
            budget: default_stage_backend(),
            cache: default_stage_backend(),
            semantic_cache: default_stage_backend(),
            audit: default_stage_backend(),
            evals: default_stage_backend(),
            circuit_breaker: default_stage_backend(),
            rate_limit: default_stage_backend(),
            firewall: default_stage_backend(),
            router: default_stage_backend(),
            smart_router: default_stage_backend(),
            passthrough: default_stage_backend(),
            connections: default_stage_backend(),
        }
    }
}
