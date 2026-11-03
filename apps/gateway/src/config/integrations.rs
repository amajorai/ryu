//! Widget limits and the Composio / Treg integration config.

use super::*;

/// Widget (Ryu Apps) governance config (§4.3). Governs the interactive widget
/// tool calls and follow-up messages that a rendered app iframe makes back
/// through the host — the traffic that arrives at the gateway carrying the
/// `widget: { instance_id, origin_server }` exec envelope.
///
/// The gateway owns rate/scan governance for these round-trips (D5: `exec_tool`
/// runs scan → budget → forward → audit for a widget `callTool`). The token
/// buckets are per-`instance_id` so one rendered widget cannot exhaust another's
/// budget. `max_concurrent_widget_instances_per_session` is declared here as the
/// single swappable knob (nothing hardcoded) but is enforced in Core at mint
/// time (D4, `WidgetInstanceStore::mint`), not on this request path.
///
/// Everything is a swappable default; the whole section can be disabled with
/// `enabled = false`, which makes the widget branch a bare governed forward.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WidgetConfig {
    /// Master switch for widget-specific governance. Default: true. When false,
    /// widget calls still forward (governed by the base exec gate) but skip the
    /// per-instance rate/scan layer.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Max widget `callTool`s per rolling minute, per widget instance. 0 =
    /// unlimited. Default: 60.
    #[serde(default = "default_widget_max_calls_per_min")]
    pub max_calls_per_min: u32,
    /// Max `sendFollowUpMessage`s per rolling minute, per widget instance
    /// (stricter than `callTool`). 0 = unlimited. Default: 6.
    #[serde(default = "default_widget_max_followups_per_min")]
    pub max_followups_per_min: u32,
    /// Max concurrently live widget instances per session. Declared here as the
    /// governance knob; enforced by Core at mint time (D4), not on this path.
    /// Default: 8.
    #[serde(default = "default_widget_max_concurrent_instances_per_session")]
    pub max_concurrent_widget_instances_per_session: u32,
    /// Scan widget `callTool` arguments through the firewall (PII/secret/
    /// injection) before forwarding. Default: true.
    #[serde(default = "default_true")]
    pub scan_arguments: bool,
    /// Scan `sendFollowUpMessage` prompts before they enter model context.
    /// Default: true.
    #[serde(default = "default_true")]
    pub scan_followups: bool,
}

pub(super) fn default_widget_max_calls_per_min() -> u32 {
    60
}
pub(super) fn default_widget_max_followups_per_min() -> u32 {
    6
}
pub(super) fn default_widget_max_concurrent_instances_per_session() -> u32 {
    8
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_calls_per_min: default_widget_max_calls_per_min(),
            max_followups_per_min: default_widget_max_followups_per_min(),
            max_concurrent_widget_instances_per_session:
                default_widget_max_concurrent_instances_per_session(),
            scan_arguments: true,
            scan_followups: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComposioConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Composio API key (env: COMPOSIO_API_KEY).
    pub api_key: Option<String>,
    /// Allowlist of Composio action names the gateway may execute.
    #[serde(default)]
    pub actions: Vec<String>,
    /// Usage-based upstream add-ons, with no Ryu Enterprise-plan gate. Enabling
    /// ZDR here asserts it is already enabled on the executing Composio project.
    #[serde(default)]
    pub billing: ryu_gw_contracts::composio_billing::ComposioBillingPolicy,
    /// Maximum agentic loop rounds before returning the last response. Default: 3.
    #[serde(default = "default_composio_max_rounds")]
    pub max_rounds: u8,
    /// Fallback Composio user ID for an orgless, standalone Gateway.
    ///
    /// Org-bound requests use an identity derived from the authenticated org
    /// and, when available, a Gateway-verified user. A dynamic `rgw_` token
    /// never accepts its caller-supplied `x-ryu-user-id` as Composio authority.
    /// The default `"default"` remains for single-user/test setups; the
    /// `COMPOSIO_ENTITY_ID` env var overrides only that standalone fallback.
    #[serde(default = "default_composio_entity_id")]
    pub entity_id: String,
}

pub(super) fn default_composio_max_rounds() -> u8 {
    3
}

pub(super) fn default_composio_entity_id() -> String {
    "default".to_string()
}

impl Default for ComposioConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key: None,
            actions: Vec::new(),
            billing: Default::default(),
            max_rounds: default_composio_max_rounds(),
            entity_id: default_composio_entity_id(),
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct TregConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_treg_base_url")]
    pub base_url: String,
    /// Runtime-only secret, supplied by the environment or provider vault.
    #[serde(skip)]
    pub token: Option<String>,
    /// Largest Treg response body, in bytes, the Gateway reads for one call or
    /// catalog lookup. A larger call body fails with
    /// `provider_response_too_large`; Treg already ran and metered the call, so
    /// it is still charged, and only the body is withheld. Default: 2 MiB.
    /// `RYU_TREG_MAX_RESPONSE_BYTES`.
    #[serde(default = "default_treg_max_response_bytes")]
    pub max_response_bytes: usize,
    /// Operator-held per-call prices, in raw micro-USD before markup, keyed by
    /// Treg endpoint id. A row here wins over Treg's catalog estimate when a
    /// wallet-billed call is priced before it runs. An endpoint with neither a
    /// row nor a catalog price is refused on the managed tier, never served free.
    #[serde(default)]
    pub prices: std::collections::BTreeMap<String, u64>,
    /// Seconds a catalog price estimate is reused before it is fetched again.
    /// Default: 600.
    #[serde(default = "default_treg_price_cache_secs")]
    pub price_cache_secs: u64,
}

pub(super) fn default_treg_base_url() -> String {
    "https://treg.to".to_owned()
}

/// 2 MiB: well above any JSON tool response a metered call should return, and
/// small enough that a misbehaving upstream cannot exhaust Gateway memory.
pub const DEFAULT_TREG_MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn default_treg_max_response_bytes() -> usize {
    DEFAULT_TREG_MAX_RESPONSE_BYTES
}

pub(super) fn default_treg_price_cache_secs() -> u64 {
    600
}

impl Default for TregConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_treg_base_url(),
            token: None,
            max_response_bytes: default_treg_max_response_bytes(),
            prices: std::collections::BTreeMap::new(),
            price_cache_secs: default_treg_price_cache_secs(),
        }
    }
}

impl std::fmt::Debug for TregConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TregConfig")
            .field("enabled", &self.enabled)
            .field("base_url", &self.base_url)
            .field("max_response_bytes", &self.max_response_bytes)
            .field("prices", &self.prices)
            .field("price_cache_secs", &self.price_cache_secs)
            .field(
                "token",
                &self.token.as_ref().map(|_| "<set>").unwrap_or("<unset>"),
            )
            .finish()
    }
}

// `SemanticCacheConfig` + `CacheConfig` moved to the extracted `ryu-gw-cache`
// stage crate (co-located with the backends they configure) and are re-exported
// from the top of this module.

// ─── Original Phase-1 config structs ─────────────────────────────────────────
