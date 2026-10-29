use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use std::collections::HashMap;

use crate::{
    audit::AuditLogger,
    config::{
        AcpConfig, ApiKeyConfig, AuthConfig, BudgetConfig, ComputerUseConfig, EgressConfig,
        EvalRoutingConfig, FirewallConfig, FirewallOverlay, GatewayConfig,
        MarketplaceRecommendationsConfig, Modality, ModalityMapping, PhoneCallLineConfig,
        PhoneCallsConfig, ProviderId, ProviderPoolConfig, ProvidersConfig, RoutingConfig,
        SmartRoutingConfig, StageBackendsConfig, ToolProfile, ToolsConfig,
    },
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

// â”€â”€â”€ GET /v1/config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Public view of GatewayConfig with provider api_key fields redacted.
#[derive(Serialize)]
struct ConfigView {
    #[serde(rename = "strategyCapabilities")]
    strategy_capabilities: StrategyCapabilities,
    #[serde(rename = "composioBilling")]
    composio_billing: ryu_gw_contracts::composio_billing::ComposioBillingPolicy,
    #[serde(rename = "composioBillingActive")]
    composio_billing_active: ryu_gw_contracts::composio_billing::ComposioBillingPolicy,
    #[serde(rename = "webServiceSchema")]
    web_service_schema: u8,
    #[serde(rename = "webServicePrices")]
    web_service_prices: crate::web_config::WebServicePrices,
    #[serde(rename = "configRevision")]
    config_revision: Option<ryu_gw_credentials::ConfigRevision>,
    #[serde(rename = "appliedProviderRevision")]
    applied_provider_revision: Option<ryu_gw_credentials::ConfigRevision>,
    #[serde(rename = "providerEpoch")]
    provider_epoch: Option<ryu_gw_credentials::ProviderRuntimeEpoch>,
    acp: AcpConfig,
    computer_use: ComputerUseConfig,
    #[serde(rename = "phoneCalls")]
    phone_calls: PhoneCallsView,
    firewall: FirewallConfig,
    budgets: BudgetConfig,
    providers: ProvidersView,
    /// Operator-owned outbound proxy pools. Credential values live only in
    /// environment variables; this view contains their names, not values.
    egress: EgressConfig,
    auth: AuthView,
    routing: RoutingView,
    /// The persisted per-stage backend selection, including the routing layer
    /// (`router`) and the connections layer (`connections`). Round-trippable:
    /// `PUT /v1/config { backends }` merges a partial update onto this.
    backends: StageBackendsConfig,
    /// Tool-loop config: master switch, always-injected tool defs, the loop
    /// tuning knobs, and the named tool-policy profiles. None of it carries a
    /// secret, so the section is returned verbatim for the UI to read/edit
    /// (mirrors how `firewall` / `smart_routing` are surfaced).
    tools: ToolsConfigView,
    /// Gateway-owned Marketplace recommendation policy. This is returned from
    /// persisted config so a read-modify-write client sees the kill switch and
    /// cadence it will actually save.
    marketplace_recommendations: MarketplaceRecommendationsConfig,
    /// Gateway-local standalone-desktop firewall overlay stores (Â§6 of the
    /// hierarchical-policy spec): the org and per-agent [`FirewallOverlay`]s
    /// authored via `PUT /v1/config` when there is no control plane. Keyed by org
    /// id / agent id; `{}` on a fresh node. These are the mid + leaf scopes of the
    /// nodeâ†’orgâ†’agent cascade for the standalone path; the node scope (base
    /// firewall) plus its `inspector` + `locked_fields` are carried inside
    /// `firewall`. Persisted to `gateway.toml`
    /// (`GatewayConfig::firewall_{org,agent}_overlays`) and reseeded into the
    /// resolver at startup (FIX 4), so they survive a gateway restart.
    firewall_org_overlays: HashMap<String, FirewallOverlay>,
    firewall_agent_overlays: HashMap<String, FirewallOverlay>,
    /// The pre-processing pipeline stage order this gateway is ACTUALLY running,
    /// as the kebab-case ids of [`crate::pipeline::stages::PipelineStage`]
    /// (`["rate-limit", "firewall", "inspector", â€¦]`). Read-only.
    ///
    /// ## Why it is here at all
    ///
    /// `[pipeline]` in `gateway.toml` can DROP a reorderable governance stage
    /// (`disabled = ["inspector"]` resolves to an order with no inspector â€” see
    /// `stages::tests::reorderable_stage_can_be_disabled`). Nothing in the desktop
    /// read the order, so the guardrails card kept rendering the inspector's
    /// enabled/model/mode/action/timeout fields as live and editable, and every
    /// save persisted settings for a stage the pipeline never reaches. A client
    /// can now compare a stage id against this list and badge it "not in
    /// pipeline" instead of showing a dead control as healthy.
    ///
    /// ## Why the LIVE order, not one re-resolved from the persisted file
    ///
    /// Unlike `routing` / `tools` immediately above â€” which are deliberately read
    /// from disk so a read-modify-write client sees what it last saved â€” this is
    /// `state.stage_order`, resolved from `config.pipeline` at `AppState`
    /// construction (`state.rs`, in `AppState::new` and in the two test
    /// constructors) and read straight back out here. It is a plain field on an
    /// `Arc<AppState>`, assigned only in those constructors and behind no lock, so
    /// nothing â€” including a `PUT /v1/config` â€” re-resolves it for the life of the
    /// process; `pre_process` iterates that exact slice on every request.
    ///
    /// Re-resolving a freshly-read `gateway.toml` here would instead report the
    /// order a FUTURE boot will use, so a hand-edit that has not been restarted
    /// into would mark a running stage as absent (or an absent one as running) â€” a
    /// status that reports healthy for a dead thing, which is the defect this
    /// field exists to remove. The two sections differ because their consumers
    /// differ: `routing` is round-tripped by the client, this is only rendered.
    ///
    /// ## Why there is no write path
    ///
    /// `pipeline` is deliberately absent from [`ConfigPatch`]. Reordering or
    /// disabling a governance stage is a way to silently disarm guardrails â€” a
    /// drag-to-reorder list one misdrop away from dropping the policy or DLP
    /// stage, with no diff an operator would notice. Stage order stays a
    /// `gateway.toml` edit (which is at least reviewable and fails closed at
    /// startup on an invariant violation). If a write path is ever added it needs
    /// its own confirmation + audit trail, not a field on this patch.
    pipeline_stages: Vec<&'static str>,
    /// Static policy-drift warnings (dangerous-tool-combo + elevation drift).
    /// Computed from the LIVE firewall config plus the tool / composio / exec
    /// budget config and the distributed policy. Empty on a clean config.
    drift: Vec<crate::policy::DriftWarning>,
}

/// Stable camelCase HTTP projection of the Gateway's snake_case TOML section.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneCallsView {
    enabled: bool,
    lines: Vec<PhoneCallLineView>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhoneCallLineView {
    id: String,
    label: String,
    twilio_number: String,
    caller_id: String,
    agent_id: Option<String>,
    tts_engine: Option<String>,
    tts_voice: Option<String>,
    transfer_to: Option<String>,
    greeting: String,
    #[serde(default)]
    allowed_callers: Vec<String>,
    #[serde(default)]
    max_concurrent_calls: Option<u32>,
}

impl From<PhoneCallsConfig> for PhoneCallsView {
    fn from(config: PhoneCallsConfig) -> Self {
        Self {
            enabled: config.enabled,
            lines: config
                .lines
                .into_iter()
                .map(|line| PhoneCallLineView {
                    id: line.id,
                    label: line.label,
                    twilio_number: line.twilio_number,
                    caller_id: line.caller_id,
                    agent_id: line.agent_id,
                    tts_engine: line.tts_engine,
                    tts_voice: line.tts_voice,
                    transfer_to: line.transfer_to,
                    greeting: line.greeting,
                    allowed_callers: line.allowed_callers,
                    max_concurrent_calls: line.max_concurrent_calls,
                })
                .collect(),
        }
    }
}

impl From<PhoneCallsView> for PhoneCallsConfig {
    fn from(view: PhoneCallsView) -> Self {
        Self {
            enabled: view.enabled,
            lines: view
                .lines
                .into_iter()
                .map(|line| PhoneCallLineConfig {
                    id: line.id,
                    label: line.label,
                    twilio_number: line.twilio_number,
                    caller_id: line.caller_id,
                    agent_id: line.agent_id,
                    tts_engine: line.tts_engine,
                    tts_voice: line.tts_voice,
                    transfer_to: line.transfer_to,
                    greeting: line.greeting,
                    allowed_callers: line.allowed_callers,
                    max_concurrent_calls: line.max_concurrent_calls,
                })
                .collect(),
        }
    }
}

#[derive(Serialize)]
struct StrategyCapabilities {
    chat: Vec<crate::config::ProviderPoolStrategy>,
    web: Vec<crate::config::ProviderPoolStrategy>,
}

impl Default for StrategyCapabilities {
    fn default() -> Self {
        let chat = ryu_gw_router::pool::PoolStrategy::ALL.to_vec();
        let web = chat
            .iter()
            .copied()
            .filter(|strategy| !strategy.is_chat_only())
            .collect();
        Self { chat, web }
    }
}

/// View of [`ToolsConfig`]: the master switch, the always-injected tool defs, the
/// loop tuning knobs, and the named tool-policy profiles (presets). Nothing is
/// redacted because nothing here is a secret.
///
/// Every field of `ToolsConfig` is mirrored ON PURPOSE, even the knobs no UI
/// edits. `PUT /v1/config { tools }` replaces the whole section, and every
/// `ToolsConfig` field is `#[serde(default)]`, so a field missing from this view
/// is a field a read-modify-write client cannot see â€” and therefore zeroes on its
/// next save (`always_on` emptied, `max_rounds`/`describe_top_n` reset to their
/// defaults). Keep this struct exhaustive: add a `ToolsConfig` field, add it here.
#[derive(Serialize)]
struct ToolsConfigView {
    enabled: bool,
    /// Tool defs injected + allowlisted on every tool-active request. Returned so
    /// a `tools` round-trip preserves them (see the struct doc); no UI sets them.
    always_on: Vec<Value>,
    /// Max tool-call rounds. Round-trip-only, as above.
    max_rounds: u8,
    /// Search hits described + injected per `tool_search`. Round-trip-only.
    describe_top_n: usize,
    /// Concurrent read-only tool calls per model step. Round-trip-only.
    parallel_reads: usize,
    profiles: std::collections::HashMap<String, ToolProfile>,
}

/// Redacted auth config: key values are omitted; only names + metadata are shown.
#[derive(Serialize)]
struct AuthView {
    require_auth: bool,
    api_keys: Vec<ApiKeyView>,
}

/// A single API key entry with the key value replaced by `"***"`.
#[derive(Serialize)]
struct ApiKeyView {
    allowed_operations: Vec<crate::config::ApiKeyOperation>,
    name: String,
    /// Key value is always `"***"` in GET responses.
    key: String,
    trusted_forwarder: bool,
    system_relay: bool,
    org_id: Option<String>,
    team_id: Option<String>,
}

/// Public view of RoutingConfig (no secrets; ProviderId serializes as a bare string).
///
/// Exhaustive over [`RoutingConfig`] for the same reason as [`ToolsConfigView`]:
/// `PUT /v1/config { routing }` replaces the section wholesale and every
/// `RoutingConfig` field is `#[serde(default)]`, so a field the desktop never
/// receives is one its `{ ...cfg.routing, â€¦ }` spread silently erases. That is
/// what used to happen to `modality_map` and `eval_routing` â€” both consumed FIRST
/// in the router's resolution order, so erasing them re-routes every image/TTS/STT
/// request back to the default provider.
#[derive(Serialize)]
struct RoutingView {
    web: crate::web_config::WebRoutingConfig,
    web_pools: std::collections::BTreeMap<String, crate::web_config::WebPoolConfig>,
    default_provider: ProviderId,
    model_map: std::collections::HashMap<String, ModelMappingView>,
    fallback_chain: Vec<ProviderId>,
    /// Cost-tier ordering (#2). Not a secret; returned so the desktop tier editor
    /// can read-modify-write the full routing object.
    provider_tiers: std::collections::HashMap<ProviderId, u8>,
    provider_pools: HashMap<String, ProviderPoolConfig>,
    /// Per-modality provider/model overrides (image/tts/stt/video). Serialized
    /// with the `Modality` enum as the JSON object key (`"image"`, â€¦), matching
    /// the on-disk TOML table. Round-trip-only today: no UI edits it.
    modality_map: std::collections::HashMap<Modality, ModalityMapping>,
    /// Eval-driven (A/B) routing across candidate providers. Round-trip-only.
    eval_routing: EvalRoutingConfig,
    /// Classifier-driven routing (custom routing instructions). Carries no
    /// secrets, so it is returned verbatim for the UI to read + edit.
    smart_routing: SmartRoutingConfig,
}

#[derive(Serialize)]
struct ModelMappingView {
    provider: ProviderId,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider_model: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ProvidersView {
    #[serde(rename = "accountStrategies")]
    account_strategies: HashMap<String, ryu_gw_providers::AccountSelectionStrategy>,
    #[serde(rename = "accountDrainThresholds")]
    account_drain_thresholds: HashMap<String, u8>,
    edge_tts: Option<EdgeTtsView>,
    #[serde(rename = "googleTranslateTts")]
    google_translate_tts: Option<EdgeTtsView>,
    google_tts: Option<GoogleTtsView>,
    polly: Option<PollyView>,
    web: std::collections::BTreeMap<
        ryu_gw_credentials::web::WebProviderKind,
        crate::web_config::WebProviderEditorView,
    >,
    accounts: HashMap<String, Vec<ProviderAccountView>>,
    openai: Option<ProviderView>,
    anthropic: Option<ProviderView>,
    local: Option<LocalView>,
    openrouter: Option<ProviderView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    litellm: Option<ProviderView>,
    core: Option<CoreView>,
    modal: Option<ProviderView>,
    genai: Option<GenAiView>,
    cohere: Option<ProviderView>,
    deepgram: Option<ProviderView>,
    assemblyai: Option<ProviderView>,
    elevenlabs: Option<ProviderView>,
    inworld: Option<ProviderView>,
    replicate: Option<ProviderView>,
    fal: Option<ProviderView>,
    recraft: Option<ProviderView>,
    stability: Option<ProviderView>,
    bfl: Option<ProviderView>,
    minimax: Option<ProviderView>,
    runway: Option<ProviderView>,
    topaz: Option<ProviderView>,
    compatible: HashMap<String, ProviderView>,
}

#[derive(Serialize)]
struct EdgeTtsView {
    anonymous_consumer_opt_in: bool,
    classification: &'static str,
    mode: &'static str,
}

#[derive(Serialize)]
struct GoogleTtsView {
    mode: &'static str,
    account_count: usize,
}

#[derive(Serialize)]
struct PollyView {
    mode: &'static str,
    region: String,
    account_count: usize,
}

#[derive(Serialize)]
struct ProviderAccountView {
    id: String,
    name: String,
    enabled: bool,
    priority: u16,
    #[serde(
        rename = "drainThresholdPercent",
        skip_serializing_if = "Option::is_none"
    )]
    drain_threshold_percent: Option<u8>,
    source: &'static str,
}

fn provider_account_views(p: &ProvidersConfig) -> HashMap<String, Vec<ProviderAccountView>> {
    provider_account_views_with_environment(p, &crate::providers::sdk_environment())
}

fn provider_account_views_with_environment(
    p: &ProvidersConfig,
    environment: &std::collections::BTreeMap<String, String>,
) -> HashMap<String, Vec<ProviderAccountView>> {
    let mut ids: Vec<&str> = vec![
        "openai",
        "anthropic",
        "openrouter",
        "litellm",
        "gemini",
        "modal",
        "cohere",
        "deepgram",
        "assemblyai",
        "elevenlabs",
        "inworld",
        "replicate",
        "fal",
        "recraft",
        "stability",
        "bfl",
        "minimax",
        "runway",
        "topaz",
    ];
    ids.extend(p.compatible.keys().map(String::as_str));
    let mut views: HashMap<_, _> = ids
        .into_iter()
        .filter_map(|provider| {
            let keys = p.account_keys(provider);
            if keys.is_empty() {
                return None;
            }
            let policies = p.policies_for(provider);
            Some((
                provider.to_owned(),
                keys.iter()
                    .zip(policies)
                    .enumerate()
                    .map(|(index, (key, policy))| ProviderAccountView {
                        id: ryu_gw_credentials::provider_account_id(provider, key),
                        name: if policy.name.is_empty() {
                            format!("Account {}", index + 1)
                        } else {
                            policy.name
                        },
                        enabled: policy.enabled,
                        priority: policy.priority,
                        drain_threshold_percent: policy.drain_threshold_percent,
                        source: "stored",
                    })
                    .collect(),
            ))
        })
        .collect();
    if let Some(config) = p.genai.as_ref() {
        for descriptor in ryu_gw_credentials::SDK_PROVIDERS {
            let keys = config
                .resolve_keys(descriptor.kind, &environment)
                .unwrap_or_default();
            if keys.is_empty() {
                continue;
            }
            let accounts = keys
                .iter()
                .enumerate()
                .map(|(index, entry)| {
                    let id = ryu_gw_credentials::provider_account_id(
                        descriptor.account_scope,
                        &entry.key,
                    );
                    let policy = p
                        .account_policies
                        .get(descriptor.account_scope)
                        .and_then(|policies| policies.get(&id))
                        .cloned()
                        .unwrap_or_default();
                    ProviderAccountView {
                        id,
                        name: if policy.name.is_empty() {
                            format!("Account {}", index + 1)
                        } else {
                            policy.name
                        },
                        enabled: policy.enabled,
                        priority: policy.priority,
                        drain_threshold_percent: policy.drain_threshold_percent,
                        source: match entry.source {
                            crate::config::SdkKeySource::Stored => "stored",
                            crate::config::SdkKeySource::Environment => "environment",
                            crate::config::SdkKeySource::Fleet => "fleet",
                        },
                    }
                })
                .collect();
            views.insert(descriptor.account_scope.to_owned(), accounts);
        }
    }
    if let Some(settings) = p.google_tts.as_ref() {
        let rows = settings
            .accounts
            .iter()
            .enumerate()
            .filter_map(|(index, account)| {
                let account = ryu_gw_providers::GoogleTtsAccount::supplied_oauth(
                    account.access_token.clone(),
                    account.quota_project.clone(),
                    account.expires_at_unix_secs,
                )
                .ok()?;
                let id = account.account_id().to_owned();
                let policy = p
                    .account_policies
                    .get("google-tts")
                    .and_then(|policies| policies.get(&id))
                    .cloned()
                    .unwrap_or_default();
                Some(ProviderAccountView {
                    id,
                    name: if policy.name.is_empty() {
                        format!("Account {}", index + 1)
                    } else {
                        policy.name
                    },
                    enabled: policy.enabled,
                    priority: policy.priority,
                    drain_threshold_percent: policy.drain_threshold_percent,
                    source: "stored",
                })
            })
            .collect();
        views.insert("google-tts".to_owned(), rows);
    }
    if let Some(settings) = p.polly.as_ref() {
        let rows = settings
            .accounts
            .iter()
            .enumerate()
            .filter_map(|(index, account)| {
                let account = ryu_gw_providers::PollyAccount::explicit(
                    account.access_key_id.clone(),
                    account.secret_access_key.clone(),
                    account.session_token.clone(),
                    account.expires_at_unix_secs,
                )
                .ok()?;
                let id = account.account_id(&settings.region).ok()?;
                let policy = p
                    .account_policies
                    .get("polly")
                    .and_then(|policies| policies.get(&id))
                    .cloned()
                    .unwrap_or_default();
                Some(ProviderAccountView {
                    id,
                    name: if policy.name.is_empty() {
                        format!("Account {}", index + 1)
                    } else {
                        policy.name
                    },
                    enabled: policy.enabled,
                    priority: policy.priority,
                    drain_threshold_percent: policy.drain_threshold_percent,
                    source: "stored",
                })
            })
            .collect();
        views.insert("polly".to_owned(), rows);
    }
    for (kind, connection) in &p.web {
        let scope = kind.descriptor().provider_id;
        let rows = connection
            .accounts()
            .iter()
            .enumerate()
            .filter_map(|(index, row)| {
                let id = row.account_id(*kind).ok()?;
                let policy = p
                    .account_policies
                    .get(scope)
                    .and_then(|policies| policies.get(&id))
                    .cloned()
                    .unwrap_or_default();
                Some(ProviderAccountView {
                    id,
                    name: if policy.name.is_empty() {
                        format!("Account {}", index + 1)
                    } else {
                        policy.name
                    },
                    enabled: policy.enabled,
                    priority: policy.priority,
                    drain_threshold_percent: policy.drain_threshold_percent,
                    source: "stored",
                })
            })
            .collect();
        if !connection.is_anonymous() {
            views.insert(scope.to_owned(), rows);
        }
    }
    views
}

#[derive(Serialize)]
struct ProviderView {
    api_key: String,
    base_url: String,
    /// Number of configured accounts for round-robin rotation (#4). The key
    /// values stay redacted (env-managed); only the count is exposed so the
    /// desktop can show "N accounts configured".
    api_key_count: usize,
}

#[derive(Serialize)]
struct LocalView {
    base_url: String,
}

#[derive(Serialize)]
struct CoreView {
    base_url: String,
    has_token: bool,
}

/// Redacted view of the genai multi-provider backend. Only the *adapter kinds*
/// that have a configured key (e.g. `"gemini"`) are listed; the key values
/// themselves are never serialized.
#[derive(Serialize)]
struct GenAiView {
    keys: Vec<String>,
    gemini_account_count: usize,
    sdk_providers: Vec<SdkProviderView>,
}

#[derive(Serialize)]
struct SdkProviderView {
    #[serde(flatten)]
    descriptor: &'static ryu_gw_credentials::SdkProviderDescriptor,
    configured: bool,
    account_count: usize,
    accounts: Vec<SdkAccountView>,
    context: Option<ryu_gw_credentials::SdkEndpointConfig>,
    activation_error: Option<String>,
}

#[derive(Serialize)]
struct SdkAccountView {
    id: String,
    source: &'static str,
}

pub(crate) fn redact_snapshot_providers(
    providers: &ProvidersConfig,
    environment: &std::collections::BTreeMap<String, String>,
    registry: &crate::providers::ProviderRegistry,
    native_sources: &HashMap<String, &'static str>,
) -> ProvidersView {
    let mut view = redact_providers_with_environment(providers, environment);
    for (scope, accounts) in &mut view.accounts {
        if ryu_gw_credentials::sdk_provider_by_id(scope).is_some() || scope == "gemini" {
            continue;
        }
        if let Some(source) = native_sources.get(scope) {
            for account in accounts {
                account.source = source;
            }
        }
    }
    if let Some(genai) = view.genai.as_mut() {
        for row in &mut genai.sdk_providers {
            if let Some(error) = registry.activation_error(row.descriptor.provider_id) {
                row.activation_error = Some(error.to_owned());
            }
        }
    }
    view
}

fn redact_providers(p: &ProvidersConfig) -> ProvidersView {
    redact_providers_with_environment(p, &crate::providers::sdk_environment())
}

fn redact_providers_with_environment(
    p: &ProvidersConfig,
    environment: &std::collections::BTreeMap<String, String>,
) -> ProvidersView {
    ProvidersView {
        account_strategies: p.account_strategies.clone(),
        account_drain_thresholds: p.account_drain_thresholds.clone(),
        edge_tts: p.edge_tts.as_ref().map(|settings| EdgeTtsView {
            anonymous_consumer_opt_in: settings.anonymous_consumer_opt_in,
            classification: ryu_gw_providers::edge_tts::EDGE_TTS_CLASSIFICATION,
            mode: "anonymous",
        }),
        google_translate_tts: p.google_translate_tts.as_ref().map(|settings| EdgeTtsView {
            anonymous_consumer_opt_in: settings.anonymous_consumer_opt_in,
            classification: ryu_gw_providers::google_translate_tts::CLASSIFICATION,
            mode: "anonymous",
        }),
        google_tts: p.google_tts.as_ref().map(|settings| GoogleTtsView {
            mode: "supplied_oauth_token",
            account_count: settings.accounts.len(),
        }),
        polly: p.polly.as_ref().map(|settings| PollyView {
            mode: "explicit_sigv4",
            region: settings.region.clone(),
            account_count: settings.accounts.len(),
        }),
        web: crate::web_config::web_editor_views(
            p,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |duration| duration.as_secs()),
        ),
        runway: p.runway.as_ref().map(|c| ProviderView {
            api_key: "***".into(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().len(),
        }),
        topaz: p.topaz.as_ref().map(|c| ProviderView {
            api_key: "***".into(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().len(),
        }),
        minimax: p.minimax.as_ref().map(|c| ProviderView {
            api_key: "***".into(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().len(),
        }),
        bfl: p.bfl.as_ref().map(|c| ProviderView {
            api_key: "***".into(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().len(),
        }),
        stability: p.stability.as_ref().map(|c| ProviderView {
            api_key: "***".to_owned(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().len(),
        }),
        recraft: p.recraft.as_ref().map(|c| ProviderView {
            api_key: "***".to_owned(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().len(),
        }),
        accounts: provider_account_views_with_environment(p, environment),
        openai: p.openai.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().iter().filter(|k| !k.is_empty()).count(),
        }),
        anthropic: p.anthropic.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().iter().filter(|k| !k.is_empty()).count(),
        }),
        local: p.local.as_ref().map(|c| LocalView {
            base_url: c.base_url.clone(),
        }),
        openrouter: p.openrouter.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().iter().filter(|k| !k.is_empty()).count(),
        }),
        litellm: p.litellm.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().iter().filter(|k| !k.is_empty()).count(),
        }),
        core: p.core.as_ref().map(|c| CoreView {
            base_url: c.base_url.clone(),
            has_token: c.token.is_some(),
        }),
        modal: p.modal.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
            api_key_count: c.all_keys().iter().filter(|key| !key.is_empty()).count(),
        }),
        genai: Some({
            let empty = crate::config::GenAiProviderConfig::default();
            let c = p.genai.as_ref().unwrap_or(&empty);
            let sdk_providers: Vec<_> = ryu_gw_credentials::SDK_PROVIDERS
                .iter()
                .map(|descriptor| {
                    let account = c.accounts.get(descriptor.kind);
                    let resolved = c.resolve_keys(descriptor.kind, &environment);
                    let mut activation_error = if resolved.is_err() {
                        Some("Invalid SDK account configuration".to_owned())
                    } else {
                        account.and_then(|account| account.activation_diagnostic(descriptor.kind))
                    };
                    let accounts: Vec<_> = resolved
                        .unwrap_or_default()
                        .into_iter()
                        .map(|entry| SdkAccountView {
                            id: ryu_gw_credentials::provider_account_id(
                                descriptor.account_scope,
                                &entry.key,
                            ),
                            source: match entry.source {
                                crate::config::SdkKeySource::Stored => "stored",
                                crate::config::SdkKeySource::Environment => "environment",
                                crate::config::SdkKeySource::Fleet => "fleet",
                            },
                        })
                        .collect();
                    if account.is_some()
                        && accounts.is_empty()
                        && descriptor.auth_kind != ryu_gw_credentials::SdkAuthKind::NoAuth
                        && activation_error.is_none()
                    {
                        activation_error =
                            Some("SDK provider has no configured credentials".to_owned());
                    }
                    SdkProviderView {
                        descriptor,
                        configured: account.is_some(),
                        account_count: accounts.len(),
                        accounts,
                        context: account
                            .filter(|account| account.validate(descriptor.kind).is_ok())
                            .map(|account| account.context.clone()),
                        activation_error,
                    }
                })
                .collect();
            let keys = sdk_providers
                .iter()
                .filter(|row| row.account_count > 0)
                .map(|row| row.descriptor.kind.to_owned())
                .collect();
            GenAiView {
                keys,
                gemini_account_count: sdk_providers
                    .iter()
                    .find(|row| row.descriptor.kind == "gemini")
                    .map_or(0, |row| row.account_count),
                sdk_providers,
            }
        }),
        cohere: p.cohere.as_ref().map(|config| ProviderView {
            api_key: "***".to_owned(),
            base_url: config.base_url.clone(),
            api_key_count: config
                .all_keys()
                .iter()
                .filter(|key| !key.is_empty())
                .count(),
        }),
        deepgram: p.deepgram.as_ref().map(|config| ProviderView {
            api_key: "***".to_owned(),
            base_url: config.base_url.clone(),
            api_key_count: config
                .all_keys()
                .iter()
                .filter(|key| !key.is_empty())
                .count(),
        }),
        assemblyai: p.assemblyai.as_ref().map(|config| ProviderView {
            api_key: "***".to_owned(),
            base_url: config.base_url.clone(),
            api_key_count: config
                .all_keys()
                .iter()
                .filter(|key| !key.is_empty())
                .count(),
        }),
        elevenlabs: p.elevenlabs.as_ref().map(|config| ProviderView {
            api_key: "***".to_owned(),
            base_url: config.base_url.clone(),
            api_key_count: config
                .all_keys()
                .iter()
                .filter(|key| !key.is_empty())
                .count(),
        }),
        inworld: p.inworld.as_ref().map(|config| ProviderView {
            api_key: "***".to_owned(),
            base_url: config.base_url.clone(),
            api_key_count: config
                .all_keys()
                .iter()
                .filter(|key| !key.is_empty())
                .count(),
        }),
        replicate: p.replicate.as_ref().map(|config| ProviderView {
            api_key: "***".to_owned(),
            base_url: config.base_url.clone(),
            api_key_count: config
                .all_keys()
                .iter()
                .filter(|key| !key.is_empty())
                .count(),
        }),
        fal: p.fal.as_ref().map(|config| ProviderView {
            api_key: "***".to_owned(),
            base_url: config.base_url.clone(),
            api_key_count: config
                .all_keys()
                .iter()
                .filter(|key| !key.is_empty())
                .count(),
        }),
        compatible: p
            .compatible
            .iter()
            .map(|(id, config)| {
                (
                    id.clone(),
                    ProviderView {
                        api_key: "***".to_owned(),
                        base_url: config.base_url.clone(),
                        api_key_count: config
                            .all_keys()
                            .iter()
                            .filter(|key| !key.is_empty())
                            .count(),
                    },
                )
            })
            .collect(),
    }
}

#[cfg(test)]
mod sdk_view_tests {
    use super::*;

    #[test]
    fn empty_configuration_exposes_inactive_safe_sdk_descriptors() {
        let view = redact_providers(&ProvidersConfig::default());
        let sdk = view.genai.unwrap();
        assert_eq!(
            sdk.sdk_providers.len(),
            ryu_gw_credentials::SDK_PROVIDERS.len()
        );
        assert!(sdk.keys.is_empty());
        assert_eq!(sdk.gemini_account_count, 0);
        assert!(sdk
            .sdk_providers
            .iter()
            .all(|row| !row.configured && row.account_count == 0 && row.accounts.is_empty()));
    }

    #[test]
    fn sdk_status_masks_material_and_preserves_policy_scope() {
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({"genai":{"accounts":{"groq":{"api_key":"private-groq","api_keys":["private-extra"]}}}})).unwrap();
        let view = redact_providers(&config);
        let encoded = serde_json::to_string(&view).unwrap();
        assert!(!encoded.contains("private-groq"));
        assert!(!encoded.contains("private-extra"));
        assert_eq!(view.accounts["genai-groq"].len(), 2);
        let sdk = view.genai.unwrap();
        let groq = sdk
            .sdk_providers
            .iter()
            .find(|row| row.descriptor.kind == "groq")
            .unwrap();
        assert!(groq.configured);
        assert_eq!(groq.account_count, 2);
        assert_eq!(groq.accounts[0].source, "stored");
    }
}

#[cfg(test)]
mod direct_provider_redaction_tests {
    use super::*;

    #[test]
    fn compatible_provider_view_exposes_only_endpoint_and_account_count() {
        let mut providers = ProvidersConfig::default();
        providers.compatible.insert(
            "voyage".to_owned(),
            crate::config::CompatibleProviderConfig {
                api_key: "secret-primary".to_owned(),
                api_keys: vec!["secret-extra".to_owned()],
                base_url: "https://api.voyageai.com/v1".to_owned(),
            },
        );
        let view = serde_json::to_value(redact_providers(&providers)).expect("serialize view");
        let voyage = &view["compatible"]["voyage"];
        assert_eq!(voyage["api_key"], "***");
        assert_eq!(voyage["api_key_count"], 2);
        assert!(!view.to_string().contains("secret-primary"));
        assert!(!view.to_string().contains("secret-extra"));
    }

    #[test]
    fn assemblyai_account_keys_are_never_returned_by_config_get() {
        let mut providers = ProvidersConfig::default();
        providers.assemblyai = Some(crate::config::AssemblyAiProviderConfig {
            api_key: "assembly-secret-primary".to_owned(),
            api_keys: vec!["assembly-secret-extra".to_owned()],
            base_url: "https://api.assemblyai.com".to_owned(),
            poll_interval_ms: 1500,
            poll_timeout_secs: 180,
        });
        let view = serde_json::to_value(redact_providers(&providers)).expect("serialize view");
        assert_eq!(view["assemblyai"]["api_key"], "***");
        assert_eq!(view["assemblyai"]["api_key_count"], 2);
        assert!(!view.to_string().contains("assembly-secret"));
    }
}

fn redact_auth(a: &AuthConfig) -> AuthView {
    AuthView {
        require_auth: a.require_auth,
        api_keys: a
            .api_keys
            .iter()
            .map(|k| ApiKeyView {
                allowed_operations: k.allowed_operations.clone(),
                name: k.name.clone(),
                key: "***".to_string(),
                trusted_forwarder: k.trusted_forwarder,
                system_relay: k.is_system_relay(),
                org_id: k.org_id.clone(),
                team_id: k.team_id.clone(),
            })
            .collect(),
    }
}

/// Authorize an admin (config/audit) request. The master key always passes.
/// Without it, access is allowed ONLY from a loopback peer in no-auth mode â€”
/// never from a remote host. The gateway can bind `0.0.0.0` (config default), so
/// `require_auth` alone (a *base*-auth flag, not an admin gate) must not be the
/// only thing standing between a remote caller and this surface.
/// Whether an admin request may pass WITHOUT the master key. Pure decision so the
/// mesh-neutralization (#478, B-9), the fleet-neutralization (managed-cloud
/// WS2), and the provisioned-master-key gate (P2 #2) are unit-testable. The only
/// no-master-key path is a loopback peer in no-auth mode â€” and that loopback
/// trust is neutralized when ANY of the following holds:
///   - the mesh is on OR fleet mode is on, because in both cases an inbound peer
///     can appear as `127.0.0.1` without being the local operator (userspace
///     mesh tailnet peers are loopback; behind a co-located fleet LB/reverse-proxy
///     external callers are loopback) â€” either would otherwise fail the gate OPEN;
///     `fleet_on` is [`crate::custody::exposure_hardened`]: the `fleet` flag
///     (exposure hardening, which a self-hosted stack behind its own proxy
///     also sets) OR Fleet custody detected from the vault signals, so a
///     hosted replica whose `gateway.toml` leaves `fleet = false` is still
///     closed;
///   - a master key IS provisioned (`master_key_present`). Provisioning a master
///     key via `GATEWAY_MASTER_KEY` also forces `require_auth = true`
///     (`config.rs` env load), so that path is already covered by `require_auth`;
///     this term additionally closes the file-config residual where
///     `gateway.toml [auth] master_key` is set with `require_auth = false` â€” an
///     operator who bothered to provision an admin key should not have these
///     control-plane reads (config = provider info, audit = full request
///     metadata) served keyless just because base auth is off.
pub(crate) fn admin_loopback_allowed(
    peer_is_loopback: bool,
    require_auth: bool,
    mesh_on: bool,
    fleet_on: bool,
    master_key_present: bool,
) -> bool {
    !require_auth && peer_is_loopback && !mesh_on && !fleet_on && !master_key_present
}

/// Authorize an admin (config/audit/budget-spend) request. The master key always
/// passes; otherwise it is allowed only from a loopback peer under the
/// zero-config dev posture (no base auth, no mesh/fleet, and no master key
/// provisioned) â€” see [`admin_loopback_allowed`]. Shared by the config, audit,
/// and budget-spend handlers so the gate has one definition and cannot drift.
/// CSRF defense (F3): reject state-changing requests that a browser stamped as a
/// cross-origin (`cross-site`) or same-origin scripted (`same-site`) fetch.
///
/// Several privileged gateway routes authorize on loopback posture alone (no
/// credential) while the gateway serves a permissive `allow_origin(Any)` CORS
/// policy â€” so a malicious web page the user merely visits could `fetch()` them
/// cross-origin (e.g. read the config, PUT a trusted_forwarder API key, or get a
/// manifest signed under the trusted key). Browsers stamp `Sec-Fetch-Site` on
/// such requests and page JS cannot forge or strip it; a cross-site (or
/// same-site) browser origin is never a legitimate privileged caller. Non-browser
/// callers â€” curl, SDKs, and the desktop's own admin path (webview â†’ Core â†’
/// gateway, whose gateway hop is a server-side Rust request) â€” omit the header
/// entirely and are unaffected. Shared so every gate uses one definition.
pub(crate) fn reject_cross_origin_browser(
    headers: &HeaderMap,
    action: &str,
) -> Result<(), GatewayError> {
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if site.eq_ignore_ascii_case("cross-site")
            || site.eq_ignore_ascii_case("same-site")
            || site.eq_ignore_ascii_case("same-origin")
        {
            return Err(GatewayError::Unauthorized(format!(
                "{action} is not permitted from a cross-origin browser request."
            )));
        }
    }
    Ok(())
}

/// Antiâ€“DNS-rebinding defense (F3): reject a request whose `Host` header is not a
/// loopback authority. `Host` is a Fetch-spec forbidden header â€” page JS cannot
/// set or forge it â€” so a rebinding page pointing `evil.com` at `127.0.0.1` still
/// sends `Host: evil.com:<port>`, which this rejects even though the post-rebind
/// request is same-origin (so `Sec-Fetch-Site` reads `same-origin` and CORS is
/// never consulted). Legitimate server-side callers (curl, SDKs, Core's own
/// gateway hop) address the gateway at `127.0.0.1`/`localhost`, so their `Host` is
/// loopback and passes. An ABSENT `Host` is allowed: browsers always send an
/// authority, so a hostless request is a raw-socket local process outside the
/// browser CSRF model.
pub(crate) fn reject_non_loopback_host(
    headers: &HeaderMap,
    action: &str,
) -> Result<(), GatewayError> {
    let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return Ok(());
    };
    // Strip the optional port. Bracketed IPv6 (`[::1]` / `[::1]:port`) keeps the
    // address inside the brackets; otherwise split off the rightmost colon.
    let hostname = if let Some(rest) = host.strip_prefix('[') {
        match rest.split_once(']') {
            Some((addr, _)) => addr,
            None => rest,
        }
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };

    let is_loopback = hostname.eq_ignore_ascii_case("localhost")
        || hostname
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
        || hostname
            .parse::<std::net::Ipv6Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);

    if is_loopback {
        Ok(())
    } else {
        Err(GatewayError::Unauthorized(format!(
            "{action} is not permitted from a non-loopback Host."
        )))
    }
}

pub(crate) fn require_local_admin(
    state: &SharedState,
    peer: &SocketAddr,
    is_master_key: bool,
    headers: &HeaderMap,
    action: &str,
) -> Result<(), GatewayError> {
    if is_master_key {
        return Ok(());
    }
    reject_cross_origin_browser(headers, action)?;
    reject_non_loopback_host(headers, action)?;
    let (require_auth, master_key_present) =
        state.with_auth(|a| (a.require_auth, a.master_key.is_some()));
    if !admin_loopback_allowed(
        peer.ip().is_loopback(),
        require_auth,
        crate::tools::mesh_enabled(),
        crate::custody::exposure_hardened(state.config.fleet, state.custody),
        master_key_present,
    ) {
        return Err(GatewayError::Unauthorized(format!(
            "{action} requires the master key."
        )));
    }
    Ok(())
}

/// Readback of persisted settings with runtime environment overlays. A failed
/// read serves the startup snapshot without echoing parser input. This helper is
/// only for GET; writes use a guarded authored-byte snapshot and fail closed.
/// Classify-derived route/provider values are stripped before readback.
fn persisted_config(state: &SharedState) -> GatewayConfig {
    GatewayConfig::load()
        .unwrap_or_else(|_error| {
            tracing::warn!(
                "config: could not re-read gateway.toml; serving degraded startup readback"
            );
            state.config.clone()
        })
        .without_derived_values()
}

/// Return the current firewall, budget, provider (redacted), auth, and routing config.
/// Requires the master key â€” same auth gate as `GET /v1/audit`.
pub async fn get_config(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    require_local_admin(&state, &peer, ctx.is_master_key, &headers, "Config access")?;
    let _config_update = state.provider_runtime.config_update.lock().await;
    let provider_snapshot = state.provider_runtime.snapshot();
    let file_guard = match GatewayConfig::config_path() {
        Some(path) => tokio::task::spawn_blocking(move || {
            ryu_gw_credentials::ConfigFileTransaction::acquire(&path)
        })
        .await
        .ok()
        .and_then(Result::ok),
        None => None,
    };
    let config_revision = file_guard
        .as_ref()
        .map(|guard| guard.snapshot().revision().clone());

    // Read live config from the RwLock fields so GET reflects any PUT changes
    // that have been applied since startup.
    let firewall_cfg = state.with_firewall(|fw| fw.config().clone());
    let budget_cfg = state.with_budget(|b| b.config().clone());
    let auth_cfg = state.with_auth(|a| a.clone());

    // Snapshot-only sections (routing, tools) come from the PERSISTED config, not
    // `state.config`: a PUT of either persists without hot-swapping the startup
    // snapshot, so serving the snapshot would hand a read-modify-write client
    // stale values it then writes back â€” see [`persisted_config`].
    let persisted = persisted_config(&state);

    let routing = &persisted.routing;
    let routing_view = RoutingView {
        web: routing.web.clone(),
        web_pools: routing.web_pools.clone(),
        default_provider: routing.default_provider.clone(),
        model_map: routing
            .model_map
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    ModelMappingView {
                        provider: v.provider.clone(),
                        provider_model: v.provider_model.clone(),
                    },
                )
            })
            .collect(),
        fallback_chain: routing.fallback_chain.clone(),
        provider_tiers: routing.provider_tiers.clone(),
        provider_pools: routing.provider_pools.clone(),
        modality_map: routing.modality_map.clone(),
        eval_routing: routing.eval_routing.clone(),
        smart_routing: routing.smart_routing.clone(),
    };

    // The whole tool-loop section, from the persisted config. ENFORCEMENT still
    // waits for the next restart (the request path reads the startup snapshot),
    // but the VIEW reports what is saved, so a client that read-modify-writes
    // `tools` round-trips it instead of zeroing the fields it cannot see.
    let tools_view = ToolsConfigView {
        enabled: persisted.tools.enabled,
        always_on: persisted.tools.always_on.clone(),
        max_rounds: persisted.tools.max_rounds,
        describe_top_n: persisted.tools.describe_top_n,
        parallel_reads: persisted.tools.parallel_reads,
        profiles: persisted.tools.profiles.clone(),
    };

    // Compute drift from the LIVE firewall config (so PUT hot-swaps are
    // reflected) plus the persisted tool / composio / exec-budget config and the
    // current distributed policy snapshot. The tool/composio/exec inputs come from
    // the same `persisted` value the views above are built from, so a warning can
    // never disagree with the config shown next to it. Warn-only: nothing is blocked.
    let drift = crate::policy::detect_drift(
        &persisted.tools,
        &persisted.composio,
        &persisted.exec_budget,
        &firewall_cfg,
        &state.policy_snapshot(),
    );

    let view = ConfigView {
        strategy_capabilities: Default::default(),
        composio_billing: persisted.composio.billing.clone(),
        composio_billing_active: state.config.composio.billing.clone(),
        web_service_schema: 1,
        web_service_prices: provider_snapshot.web_pricing.prices().clone(),
        config_revision,
        applied_provider_revision: provider_snapshot.authored_revision.clone(),
        provider_epoch: Some(provider_snapshot.epoch),
        acp: persisted.acp.clone(),
        computer_use: persisted.computer_use.clone(),
        phone_calls: persisted.channels.phone_calls.clone().into(),
        firewall: firewall_cfg,
        budgets: budget_cfg,
        providers: provider_snapshot.safe_provider_view(),
        egress: persisted.egress.clone(),
        auth: redact_auth(&auth_cfg),
        routing: routing_view,
        backends: persisted.backends.clone(),
        tools: tools_view,
        marketplace_recommendations: persisted.marketplace_recommendations.clone(),
        // Snapshot the resolver's standalone-local overlay stores so the desktop
        // can read-modify-write them. Empty on the hosted path (overlays arrive
        // on the resolve response there, not via this store).
        firewall_org_overlays: state.resolver.org_overlays(),
        firewall_agent_overlays: state.resolver.agent_overlays(),
        // The order `pre_process` is iterating right now â€” see the field doc for
        // why this alone is read from live state rather than from `persisted`.
        pipeline_stages: state
            .stage_order
            .stages()
            .iter()
            .map(|s| s.as_str())
            .collect(),
        drift,
    };

    Ok(Json(json!(view)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderApplyRequest {
    revision: ryu_gw_credentials::ConfigRevision,
}

/// Private provider-runtime control: receives a revision, never credential material.
/// The receipt is not whole-config application; unrelated live/restart ownership
/// and the smart-routing classifier remain with their existing config APIs.
pub(crate) async fn apply_provider_revision(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<ProviderApplyRequest>,
) -> Result<Json<ryu_gw_credentials::ProviderApplyOutcome>, GatewayError> {
    if !peer.ip().is_loopback() {
        return Err(GatewayError::Unauthorized(
            "Provider application requires a local control connection".to_owned(),
        ));
    }
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Provider application",
    )?;
    let outcome = match GatewayConfig::config_path() {
        Some(path) => {
            state
                .provider_runtime
                .apply_revision(path, request.revision)
                .await
        }
        None => ryu_gw_credentials::ProviderApplyOutcome::Failed {
            requested_revision: request.revision,
            active_revision: state.provider_runtime.snapshot().authored_revision.clone(),
            code: ryu_gw_credentials::ProviderApplyErrorCode::ConfigUnavailable,
        },
    };
    Ok(Json(outcome))
}

// â”€â”€â”€ PUT /v1/config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Partial update to the auth config accepted by `PUT /v1/config`.
/// Only `api_keys` is writable; `require_auth` and `master_key` are
/// environment-variable-only to prevent accidental lockout.
#[derive(Deserialize)]
pub struct AuthConfigPatch {
    /// Full replacement list of API keys. Any key not in this list is removed.
    pub api_keys: Vec<ApiKeyConfig>,
}

/// Resolve redacted keys from the current server-side auth store. Config GET
/// never returns key material, so clients must be able to round-trip `***`
/// without replacing a working bearer with that literal string. Preserve the
/// entire existing entry, including limits and tenancy fields omitted by GET.
fn resolve_redacted_api_keys(
    patch: &mut ConfigPatch,
    current: &crate::config::AuthConfig,
) -> Result<(), GatewayError> {
    let Some(auth) = patch.auth.as_mut() else {
        return Ok(());
    };
    // Bootstrapped Core/inference relays are kept by AppState and regenerated
    // from private key files. They are not user-managed config entries.
    if auth
        .api_keys
        .iter()
        .any(|entry| entry.is_system_relay() && entry.key != "***")
    {
        return Err(GatewayError::BadRequest(
            "system Gateway relay names are reserved".to_owned(),
        ));
    }
    auth.api_keys.retain(|entry| !entry.is_system_relay());
    let mut names = std::collections::HashSet::new();
    for entry in &mut auth.api_keys {
        if entry.name.trim().is_empty() || !names.insert(entry.name.clone()) {
            return Err(GatewayError::BadRequest(
                "Gateway API key names must be non-empty and unique".to_owned(),
            ));
        }
        if entry.key == "***" {
            let existing = current
                .api_keys
                .iter()
                .find(|saved| saved.name == entry.name)
                .ok_or_else(|| {
                    GatewayError::BadRequest(format!(
                        "no existing Gateway API key named '{}' to preserve",
                        entry.name
                    ))
                })?;
            *entry = existing.clone();
        } else {
            ryu_gw_credentials::validate(&entry.key)
                .map_err(|error| GatewayError::BadRequest(error.to_string()))?;
        }
        entry
            .validate_operations()
            .map_err(|error| GatewayError::BadRequest(error.to_owned()))?;
    }
    Ok(())
}

#[cfg(test)]
mod redacted_key_update_tests {
    use super::*;

    #[test]
    fn redacted_keys_preserve_their_secret_and_limits_during_create_and_revoke() {
        let existing: ApiKeyConfig = serde_json::from_value(json!({
            "name": "existing",
            "key": "existing-secret-with-enough-entropy",
            "requests_per_minute": 42,
            "trusted_forwarder": true
        }))
        .expect("existing key");
        let mut current = crate::config::AuthConfig::default();
        current.api_keys.push(existing.clone());
        let mut create: ConfigPatch = serde_json::from_value(json!({
            "auth": { "api_keys": [
                { "name": "existing", "key": "***" },
                { "name": "new", "key": "new-secret-with-enough-entropy" }
            ] }
        }))
        .expect("create patch");
        resolve_redacted_api_keys(&mut create, &current).expect("resolve placeholders");
        let keys = &create.auth.expect("auth patch").api_keys;
        assert_eq!(keys[0].key, existing.key);
        assert_eq!(keys[0].requests_per_minute, Some(42));
        assert!(keys[0].trusted_forwarder);
        assert_eq!(keys[1].name, "new");

        let mut revoke: ConfigPatch = serde_json::from_value(json!({
            "auth": { "api_keys": [] }
        }))
        .expect("revoke patch");
        resolve_redacted_api_keys(&mut revoke, &current).expect("revoke needs no secret");
        assert!(revoke.auth.expect("auth patch").api_keys.is_empty());
    }

    #[test]
    fn unknown_redacted_key_is_rejected() {
        let mut patch: ConfigPatch = serde_json::from_value(json!({
            "auth": { "api_keys": [{ "name": "missing", "key": "***" }] }
        }))
        .expect("patch");
        let error = resolve_redacted_api_keys(&mut patch, &crate::config::AuthConfig::default())
            .expect_err("placeholder cannot become a credential");
        assert!(error.to_string().contains("no existing Gateway API key"));
    }
}

/// Partial config update accepted by `PUT /v1/config`.
/// `firewall`, `budgets`, and `auth.api_keys` are hot-swapped live. `routing` is
/// **partially** hot-swapped: its `smart_routing` sub-config (the classifier
/// on/off switch + rules) live-swaps the global smart router
/// ([`crate::state::AppState::update_smart_router`]) with no restart, while
/// `model_map` / `fallback_chain` / `provider_tiers` live in the [`ModelRouter`]
/// startup snapshot and still take effect on the next gateway restart. `tools` is
/// persisted and takes effect on the next restart (the request path reads the
/// startup snapshot). Provider credentials use authored-file revision application
/// through local control; this patch exposes policy edits, not credential values.
/// Master-key changes retain their existing environment/lifecycle ownership.
#[derive(Default, Deserialize)]
pub struct ConfigPatch {
    #[serde(default, rename = "composioBilling")]
    pub composio_billing: Option<ryu_gw_contracts::composio_billing::ComposioBillingPolicy>,
    #[serde(default, rename = "expectedRevision")]
    pub expected_revision: Option<ryu_gw_credentials::ConfigRevision>,
    /// Merge named account settings by provider and opaque credential ID. Live.
    #[serde(default, rename = "providerAccountPolicies")]
    pub provider_account_policies: Option<ryu_gw_credentials::ProviderAccountPolicies>,
    /// Merge provider-level new-session account routing strategies. Live after provider reload.
    #[serde(default, rename = "providerAccountStrategies")]
    pub provider_account_strategies:
        Option<HashMap<String, ryu_gw_providers::AccountSelectionStrategy>>,
    /// Merge fill-first used-quota drain thresholds by provider (1–100).
    #[serde(default, rename = "providerAccountDrainThresholds")]
    pub provider_account_drain_thresholds: Option<HashMap<String, u8>>,
    /// ACP lifecycle/resource controls. Core enforces these settings where the
    /// subprocesses run; the Gateway owns persistence and authorization.
    #[serde(default)]
    pub acp: Option<AcpConfig>,
    /// Node-wide Ghost/computer-use policy. The setting is persisted here so
    /// Core and the provider boundary can make one node-level decision.
    #[serde(default)]
    pub computer_use: Option<ComputerUseConfig>,
    /// Phone-line routing and assistant policy. Twilio account credentials are
    /// environment/deployment secrets and are never accepted by this patch.
    #[serde(default)]
    #[serde(rename = "phoneCalls", alias = "phone_calls")]
    pub phone_calls: Option<PhoneCallsView>,
    pub firewall: Option<FirewallConfig>,
    pub budgets: Option<BudgetConfig>,
    /// When present, replaces the list of per-client API keys. The master key
    /// and `require_auth` flag are unchanged; they are environment-variable-only.
    pub auth: Option<AuthConfigPatch>,
    pub routing: Option<RoutingConfig>,
    /// Full replacement of outbound proxy pools and provider assignments.
    /// Validated before persistence and applied on the next Gateway restart.
    #[serde(default)]
    pub egress: Option<EgressConfig>,
    /// When present, replaces the tool-loop config (master switch + named
    /// tool-policy profiles). Like `routing`, this is persisted and takes effect
    /// on the next gateway restart; the request path reads `state.config.tools`
    /// directly, which is fixed at startup.
    pub tools: Option<ToolsConfig>,
    /// Personalized Marketplace recommendation policy. The closed cadence enum
    /// rejects values outside daily/weekly/monthly during JSON deserialization.
    #[serde(default)]
    pub marketplace_recommendations: Option<MarketplaceRecommendationsConfig>,
    /// Full replacement of the gateway-local standalone org overlay store (Â§6).
    /// Full-replacement semantics, matching `auth.api_keys`: any org id absent
    /// from this map is removed. Applied to the resolver's in-memory store
    /// (invalidating the scanner cache) AND persisted to `gateway.toml` (FIX 4)
    /// so it survives a restart â€” but only when a writable config path exists; an
    /// overlay-only patch on a node with no config path still applies live and
    /// simply skips disk, so authoring never hard-errors. Each overlay is
    /// normalized first (the node-only `wrap_untrusted_tool_results` value/lock is
    /// stripped, FIX 2).
    #[serde(default)]
    pub firewall_org_overlays: Option<HashMap<String, FirewallOverlay>>,
    /// Full replacement of the gateway-local standalone per-agent overlay store
    /// (Â§6), keyed by agent id. Same full-replacement + persist-when-path-exists
    /// + normalize semantics as `firewall_org_overlays`.
    #[serde(default)]
    pub firewall_agent_overlays: Option<HashMap<String, FirewallOverlay>>,
    /// Full replacement of the user-authored custom evaluator set
    /// ([`GatewayConfig::custom_evaluators`]). Validated
    /// ([`crate::evaluators::validate_custom_evaluators`]: non-empty ids, no dupes)
    /// then persisted to `gateway.toml`. Like `routing`/`tools` it is NOT
    /// hot-swapped â€” the request path reads the startup snapshot, so it takes effect
    /// on the next gateway restart (the desktop save flow triggers one). Absent â‡’
    /// the existing set is preserved.
    #[serde(default)]
    pub custom_evaluators: Option<Vec<crate::evaluators::Evaluator>>,
    /// Per-stage active-backend selection (W6a). Names which registered backend is
    /// active for each inverted stage. Every requested id is validated against the
    /// live registry's `available()` set BEFORE persist (fail-closed: an unknown id
    /// is rejected with `BadRequest` listing the registered ids), so a saved config
    /// can never brick the next boot. Omitted stages keep their persisted
    /// selection. `budget`, `router` (the routing layer) and `connections` (the
    /// connections layer) swap live; the rest are startup snapshots (like
    /// `routing`/`tools`), so their new selection takes effect on the next restart.
    #[serde(default)]
    pub backends: Option<crate::config::StageBackendsPatch>,
    /// The complete selection after `backends` is merged onto the persisted
    /// `[backends]` table. Computed by `put_config`; never read from the wire.
    #[serde(skip)]
    pub resolved_backends: Option<StageBackendsConfig>,
    /// Full replacement of `[screening]` (hazard screener endpoints). Refused
    /// with 403 `platform_locked` on the hosted fleet, where a config write
    /// must never repoint a floor backend; elsewhere persisted and applied on
    /// the next restart.
    #[serde(default)]
    pub screening: Option<crate::config::ScreeningConfig>,
}

/// Whether a [`ConfigPatch`] carries no updatable field at all. Extracted as a
/// pure predicate (mirroring [`admin_loopback_allowed`]) so the "empty patch"
/// rejection â€” which must now also accept an overlay-only patch â€” is
/// unit-testable without building a request. Each argument is one
/// `patch.<field>.is_some()`.
fn patch_is_empty(patch: &ConfigPatch) -> bool {
    patch.firewall.is_none()
        && patch.budgets.is_none()
        && patch.auth.is_none()
        && patch.routing.is_none()
        && patch.tools.is_none()
        && patch.acp.is_none()
        && patch.firewall_org_overlays.is_none()
        && patch.firewall_agent_overlays.is_none()
        && patch.custom_evaluators.is_none()
        && patch.backends.is_none()
        && patch.marketplace_recommendations.is_none()
        && patch.computer_use.is_none()
        && patch.phone_calls.is_none()
        && patch.egress.is_none()
        && patch.composio_billing.is_none()
        && patch.provider_account_policies.is_none()
        && patch.provider_account_strategies.is_none()
        && patch.provider_account_drain_thresholds.is_none()
        && patch.screening.is_none()
}

fn config_patch_sections(patch: &ConfigPatch) -> Vec<&'static str> {
    let mut sections = Vec::new();
    if patch.composio_billing.is_some() {
        sections.push("composioBilling");
    }
    if patch.provider_account_policies.is_some() {
        sections.push("providerAccountPolicies");
    }
    if patch.provider_account_strategies.is_some() {
        sections.push("providerAccountStrategies");
    }
    if patch.provider_account_drain_thresholds.is_some() {
        sections.push("providerAccountDrainThresholds");
    }
    if patch.firewall.is_some() {
        sections.push("firewall");
    }
    if patch.budgets.is_some() {
        sections.push("budgets");
    }
    if patch.auth.is_some() {
        sections.push("auth");
    }
    if patch.routing.is_some() {
        sections.push("routing");
    }
    if patch.egress.is_some() {
        sections.push("egress");
    }
    if patch.tools.is_some() {
        sections.push("tools");
    }
    if patch.acp.is_some() {
        sections.push("acp");
    }
    if patch.firewall_org_overlays.is_some() {
        sections.push("firewall_org_overlays");
    }
    if patch.firewall_agent_overlays.is_some() {
        sections.push("firewall_agent_overlays");
    }
    if patch.custom_evaluators.is_some() {
        sections.push("custom_evaluators");
    }
    if patch.backends.is_some() {
        sections.push("backends");
    }
    if patch.screening.is_some() {
        sections.push("screening");
    }
    if patch.marketplace_recommendations.is_some() {
        sections.push("marketplace_recommendations");
    }
    if patch.computer_use.is_some() {
        sections.push("computer_use");
    }
    if patch.phone_calls.is_some() {
        sections.push("phone_calls");
    }
    sections
}

fn forwarded_control_actor(headers: &HeaderMap, fallback: &str) -> (String, Option<String>) {
    let read = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.chars().count() <= 240)
            .map(str::to_owned)
    };
    let actor_id = read("x-ryu-control-actor-id");
    let actor_name = read("x-ryu-control-actor-name");
    let actor = actor_name
        .clone()
        .or_else(|| actor_id.clone())
        .unwrap_or_else(|| fallback.to_owned());
    (actor, actor_id)
}

/// Validate a per-stage backend selection against the live registries before it
/// is persisted or applied (W6a). Every requested id must be registered in that
/// stage's registry (`available()`), else the patch is refused with a `BadRequest`
/// listing the registered ids â€” otherwise a persisted unknown id would refuse the
/// NEXT boot (`AppState::new` fails closed). A disabled stage (empty `available`,
/// only semantic_cache today) accepts only the default `"builtin"` no-op.
fn validate_stage_backends(
    state: &SharedState,
    sel: &StageBackendsConfig,
) -> Result<(), GatewayError> {
    let checks: [(&str, &str, Vec<String>); 9] = [
        ("budget", sel.budget.as_str(), state.budget.available()),
        ("cache", sel.cache.as_str(), state.cache.available()),
        (
            "semantic_cache",
            sel.semantic_cache.as_str(),
            state.semantic_cache.available(),
        ),
        ("audit", sel.audit.as_str(), state.audit.available()),
        ("evals", sel.evals.as_str(), state.evals.available()),
        (
            "circuit_breaker",
            sel.circuit_breaker.as_str(),
            state.circuit_breaker.available(),
        ),
        (
            "rate_limit",
            sel.rate_limit.as_str(),
            state.rate_limiter.available(),
        ),
        (
            "router",
            sel.router.as_str(),
            state.provider_runtime.snapshot().router.available(),
        ),
        (
            "connections",
            sel.connections.as_str(),
            state.connections.available(),
        ),
    ];
    for (stage, requested, available) in checks {
        let known = if available.is_empty() {
            requested == crate::config::default_stage_backend()
        } else {
            available.iter().any(|id| id == requested)
        };
        if !known {
            return Err(GatewayError::BadRequest(format!(
                "backends.{stage}: unknown backend '{requested}'; registered backends: [{}]",
                available.join(", ")
            )));
        }
    }
    Ok(())
}

/// Normalize every overlay in a full-replacement map (FIX 2): each entry has its
/// node-only `wrap_untrusted_tool_results` value + lock stripped (see
/// [`crate::firewall::resolve::normalize_overlay`]) before it is stored,
/// persisted, or resolved â€” an org/agent scope may neither set nor lock it.
fn normalize_overlay_map(m: HashMap<String, FirewallOverlay>) -> HashMap<String, FirewallOverlay> {
    m.into_iter()
        .map(|(k, v)| (k, crate::firewall::resolve::normalize_overlay(&v)))
        .collect()
}

/// Apply a full-replacement update to a standalone overlay store on the resolver.
/// `remove` drops overlays absent from `next`; `set` (re)authors the rest. Each
/// call invalidates the resolver's scanner cache, so the next request resolves a
/// fresh cascade. Generic over the org/agent store via the two closures.
fn replace_overlay_store<R, S>(
    current_ids: Vec<String>,
    next: HashMap<String, FirewallOverlay>,
    mut remove: R,
    mut set: S,
) where
    R: FnMut(&str),
    S: FnMut(String, FirewallOverlay),
{
    for id in &current_ids {
        if !next.contains_key(id) {
            remove(id);
        }
    }
    for (id, overlay) in next {
        set(id, overlay);
    }
}

/// Validate, commit only requested authored TOML sections, then apply live state.
/// The shared file guard serializes Core and Gateway through live application.
/// Runtime overlays and startup fallbacks never seed persistence. Explicit stale
/// revisions return conflict before any disk or live mutation.
pub async fn put_config(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(mut patch): Json<ConfigPatch>,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    // Same local-trust rule as GET: writable from loopback in no-auth mode,
    // master-key-gated otherwise (remote peers always need the master key).
    require_local_admin(&state, &peer, ctx.is_master_key, &headers, "Config updates")?;

    let _config_update = state.provider_runtime.config_update.lock().await;
    state.with_auth(|current| resolve_redacted_api_keys(&mut patch, current))?;
    let has_account_updates = patch.provider_account_policies.is_some()
        || patch.provider_account_strategies.is_some()
        || patch.provider_account_drain_thresholds.is_some();

    if patch_is_empty(&patch) {
        return Err(GatewayError::BadRequest(
            "Patch body must include at least one of: acp, firewall, budgets, auth, routing, tools, \
             firewall_org_overlays, firewall_agent_overlays, custom_evaluators, backends, \
             marketplace_recommendations, computer_use, phone_calls, egress, screening, composioBilling, providerAccountPolicies, providerAccountStrategies, providerAccountDrainThresholds"
                .to_string(),
        ));
    }

    // On the hosted fleet the screener endpoints back Ryu's platform floor,
    // so no config write may repoint them (screener addendum 5.2).
    if patch.screening.is_some() && state.custody.is_fleet() {
        return Err(GatewayError::PlatformRefused {
            code: "platform_locked",
            message: "Screening endpoints on the hosted fleet are set by the platform and cannot be changed by a configuration write.",
        });
    }

    let changed_sections = config_patch_sections(&patch).join(", ");

    // Validate any incoming per-stage backend selection against the live
    // registries BEFORE persisting: an unknown id here would refuse the NEXT boot
    // (AppState::new fails closed), so reject it now with the registered ids.
    if let Some(backends) = &patch.backends {
        let resolved = backends.apply_to(persisted_config(&state).backends);
        validate_stage_backends(&state, &resolved)?;
        patch.resolved_backends = Some(resolved);
    }

    if let Some(acp) = &patch.acp {
        acp.validate().map_err(GatewayError::BadRequest)?;
    }
    if let Some(phone_calls) = &patch.phone_calls {
        let phone_calls: PhoneCallsConfig = phone_calls.clone().into();
        phone_calls.validate().map_err(GatewayError::BadRequest)?;
    }
    if let Some(egress) = &patch.egress {
        // Before any environment lookup: the caller also picks the proxy URL.
        crate::egress::validate_written_proxy_credential_env_names(
            egress,
            &persisted_config(&state).egress,
        )
        .map_err(GatewayError::BadRequest)?;
        crate::egress::EgressPools::new(egress).map_err(GatewayError::BadRequest)?;
    }

    // Validate any incoming custom evaluators before persisting (non-empty ids, no
    // dupes). Category/target/impl are serde-closed enums, so an invalid one fails
    // deserialization before reaching here.
    if let Some(custom) = &patch.custom_evaluators {
        crate::evaluators::validate_custom_evaluators(custom).map_err(GatewayError::BadRequest)?;

        // Compile + import-validate any WASM policy modules OFF the request path so
        // a malformed / oversized / forbidden-import module is rejected HERE at
        // declaration (the "enabling loads+validates the module" contract), not
        // discovered at first request. The hardened host is the same one the
        // pipeline uses, so this also warms its compiled-module cache.
        if custom
            .iter()
            .any(|e| matches!(e.impl_, crate::evaluators::EvaluatorImpl::Wasm { .. }))
        {
            let host = state.wasm_host().ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!(
                    "WASM policy host unavailable; cannot validate module"
                ))
            })?;
            crate::wasm_policy::validate_wasm_evaluators(host, custom)
                .map_err(GatewayError::BadRequest)?;
        }
    }

    // Normalize any incoming org/agent overlays up front (FIX 2): strip the
    // node-only `wrap_untrusted_tool_results` value + lock so it is never stored,
    // persisted, or resolved. Under full-replacement semantics the resulting store
    // equals this normalized `next` map, so it is also exactly what we persist.
    let org_next = patch
        .firewall_org_overlays
        .take()
        .map(normalize_overlay_map);
    let agent_next = patch
        .firewall_agent_overlays
        .take()
        .map(normalize_overlay_map);

    // Validate the candidate policy before persistence. Disabled unavailable bindings
    // remain valid so operators can recover old configurations in one update.
    // Validate against the LIVE custom set (it is hot-swapped by earlier
    // updates), not the startup snapshot in `state.config`.
    let live_custom = state.live_custom_evaluators();
    let candidate_custom: &[crate::evaluators::Evaluator] =
        patch.custom_evaluators.as_deref().unwrap_or(&live_custom);
    if patch.custom_evaluators.is_some() {
        crate::state::validate_online_evals_against(&state.config.evals.online, candidate_custom)
            .map_err(GatewayError::BadRequest)?;
    }
    let evaluator_registry = crate::evaluators::EvaluatorRegistry::from_custom(candidate_custom);
    if patch.firewall.is_some() || patch.custom_evaluators.is_some() {
        let firewall = patch.firewall.as_ref().unwrap_or(&state.config.firewall);
        evaluator_registry
            .validate_bindings(&firewall.evaluators)
            .map_err(GatewayError::BadRequest)?;
    }
    for overlays in [org_next.as_ref(), agent_next.as_ref()]
        .into_iter()
        .flatten()
    {
        for overlay in overlays.values() {
            if let Some(bindings) = &overlay.evaluators {
                evaluator_registry
                    .validate_bindings(bindings)
                    .map_err(GatewayError::BadRequest)?;
            }
        }
    }

    let has_config_field = patch.firewall.is_some()
        || patch.composio_billing.is_some()
        || patch.budgets.is_some()
        || patch.auth.is_some()
        || patch.routing.is_some()
        || patch.egress.is_some()
        || patch.tools.is_some()
        || patch.acp.is_some()
        || patch.custom_evaluators.is_some()
        || patch.backends.is_some()
        || patch.marketplace_recommendations.is_some()
        || patch.computer_use.is_some()
        || patch.phone_calls.is_some()
        || patch.provider_account_policies.is_some()
        || patch.provider_account_strategies.is_some()
        || patch.provider_account_drain_thresholds.is_some()
        || patch.screening.is_some();
    let has_overlay_field = org_next.is_some() || agent_next.is_some();
    // Persist when a config-backed field changed (always â€” `save()` errors if no
    // path, as before), OR when overlays changed AND a writable config path exists
    // (FIX 4: overlays now round-trip through `gateway.toml`). An overlay-only
    // patch on a node with no config path still applies live but skips disk, so
    // authoring a standalone overlay never hard-errors.
    let config_path_exists = GatewayConfig::config_path().is_some();
    let needs_persist = has_config_field || (has_overlay_field && config_path_exists);

    // Budget, the routing layer and the connections layer swap live; any other
    // stage still runs its startup selection until the next restart.
    let backends_restart_required = patch.resolved_backends.as_ref().is_some_and(|next| {
        let mut running = state.config.backends.clone();
        running.budget.clone_from(&next.budget);
        running.router.clone_from(&next.router);
        running.connections.clone_from(&next.connections);
        &running != next
    });
    let restart_required = patch.routing.is_some()
        || patch.composio_billing.is_some()
        || patch.egress.is_some()
        || patch.tools.is_some()
        || patch.acp.is_some()
        || backends_restart_required
        || patch.marketplace_recommendations.is_some()
        || patch.computer_use.is_some()
        || patch.phone_calls.is_some()
        || patch.screening.is_some();
    let mut live_applied = patch.firewall.is_some()
        || patch.custom_evaluators.is_some()
        || patch.budgets.is_some()
        || patch.auth.is_some()
        || has_overlay_field
        || patch.routing.is_some()
        || patch.backends.is_some();
    if let Some(routing) = &patch.routing {
        crate::provider_pools::ProviderPools::new(routing).map_err(GatewayError::BadRequest)?;
        crate::web_pools::WebServicePools::new(routing).map_err(GatewayError::BadRequest)?;
    }
    let (file_guard, config_revision, provider_apply_path) = if needs_persist {
        let path = GatewayConfig::config_path().ok_or_else(|| {
            GatewayError::Internal(anyhow::anyhow!("Cannot determine authored config path"))
        })?;
        let apply_path = path.clone();
        let sections = authored_sections(&patch, &org_next, &agent_next)?;
        let policies = patch.provider_account_policies.clone();
        let strategies = patch.provider_account_strategies.clone();
        let drain_thresholds = patch.provider_account_drain_thresholds.clone();
        let expected = patch.expected_revision.clone();
        let inputs = state.provider_runtime.capture_policy_inputs();
        let (guard, revision) = tokio::task::spawn_blocking(move || {
            commit_authored_config(
                &path,
                expected.as_ref(),
                sections,
                policies,
                strategies,
                drain_thresholds,
                inputs,
            )
        })
        .await
        .map_err(|_| {
            GatewayError::Internal(anyhow::anyhow!("Configuration transaction task failed"))
        })??;
        (Some(guard), Some(revision), Some(apply_path))
    } else {
        (None, None, None)
    };

    drop(file_guard);
    let provider_application = if has_account_updates {
        match (provider_apply_path, config_revision.as_ref()) {
            (Some(path), Some(revision)) => Some(
                state
                    .provider_runtime
                    .apply_revision_locked(path, revision.clone())
                    .await,
            ),
            _ => None,
        }
    } else {
        None
    };
    let accounts_applied = matches!(
        provider_application,
        Some(
            ryu_gw_credentials::ProviderApplyOutcome::Applied { .. }
                | ryu_gw_credentials::ProviderApplyOutcome::AlreadyApplied { .. }
        )
    );
    live_applied |= accounts_applied;
    // Now apply live hot-swappable changes (firewall, budgets, auth, and the
    // smart-routing sub-config). `update_firewall_config` also updates the
    // resolver's node base and invalidates its scanner cache.
    if let Some(fw) = patch.firewall {
        state.update_firewall_config(fw);
    }
    if let Some(budgets) = patch.budgets {
        state.update_budget_config(budgets);
    }
    if let Some(auth_patch) = patch.auth {
        state.update_auth_config(auth_patch.api_keys);
    }
    // Routing: hot-swap the smart router live (classifier on/off + rules). The
    // ModelRouter model_map / fallback / tiers stay on the startup snapshot and
    // still take effect on the next restart, but the smart-routing TOGGLE â€” the
    // one a Core policy plugin flips â€” now lands without a respawn.
    if let Some(routing) = patch.routing {
        state.update_smart_router(routing.smart_routing);
    }
    // Per-stage backend selection (W6a): budget is the one registry with a `&self`
    // `set_active`, so its selection swaps live (validated above â†’ cannot fail).
    // The other stages' registries take `&mut self` and are startup snapshots, so
    // their persisted selection takes effect on the next restart â€” the same
    // restart-only discipline as `routing.model_map` / `tools`.
    if let Some(backends) = &patch.resolved_backends {
        state.budget.set_active(&backends.budget);
        // The two product layers swap live as well: the routing layer on the
        // current provider snapshot (publication carries the active id forward)
        // and the connections layer on its registry. Both were validated above.
        state
            .provider_runtime
            .snapshot()
            .router
            .set_active(&backends.router);
        state.connections.set_selected(&backends.connections);
    }

    // Custom evaluators swap live: the catalog, offline/online scorers and the
    // inline guardrail bridge all read `state.evaluator_registry()`, so a saved
    // evaluator applies to the next request without a Gateway restart.
    if let Some(custom) = patch.custom_evaluators.take() {
        state.update_custom_evaluators(custom);
    }

    // Apply the standalone overlay-store replacements (Â§6) live, using the
    // normalized maps. Each resolver write invalidates the scanner cache, so the
    // next request re-resolves the nodeâ†’orgâ†’agent cascade against the new
    // overlays.
    if let Some(next) = org_next {
        replace_overlay_store(
            state.resolver.org_overlays().into_keys().collect(),
            next,
            |id| state.resolver.remove_org_overlay(id),
            |id, ov| state.resolver.set_org_overlay(id, ov),
        );
    }
    if let Some(next) = agent_next {
        replace_overlay_store(
            state.resolver.agent_overlays().into_keys().collect(),
            next,
            |id| state.resolver.remove_agent_overlay(id),
            |id, ov| state.resolver.set_agent_overlay(id, ov),
        );
    }

    let fallback_actor = if ctx.is_master_key {
        "master-key"
    } else {
        "loopback-admin"
    };
    let (actor, actor_id) = forwarded_control_actor(&headers, fallback_actor);
    state.log_audit(AuditLogger::make_control_record(
        Uuid::new_v4().to_string(),
        ctx.api_key,
        actor,
        actor_id,
        "config.update".to_string(),
        "gateway_config".to_string(),
        Some(changed_sections),
    ));

    Ok(Json(
        json!({ "ok": true, "providerAccountsApplied": accounts_applied, "providerApplication":provider_application, "persisted": needs_persist, "configRevision": config_revision, "applied": {"live":live_applied, "restartRequired":restart_required} }),
    ))
}

fn transaction_error(error: ryu_gw_credentials::ConfigCommitError) -> GatewayError {
    match error {
        ryu_gw_credentials::ConfigCommitError::Conflict { current_revision } => {
            GatewayError::ConfigConflict(current_revision)
        }
        ryu_gw_credentials::ConfigCommitError::Sealing => GatewayError::Internal(anyhow::anyhow!(
            "Configuration secrets could not be sealed: start the Gateway from Ryu Core, give \
             it the RYU_SEAL_KEY and RYU_SEAL_SCOPE printed by `ryu-core gateway-seal-env`, or \
             set RYU_MASTER_KEY so it can seal gateway.toml secrets"
        )),
        _ => GatewayError::Internal(anyhow::anyhow!("Authored configuration transaction failed")),
    }
}

type AuthoredSections = Vec<(&'static str, toml::Value)>;

fn authored_sections(
    patch: &ConfigPatch,
    org: &Option<HashMap<String, FirewallOverlay>>,
    agent: &Option<HashMap<String, FirewallOverlay>>,
) -> Result<AuthoredSections, GatewayError> {
    let mut sections = Vec::new();
    macro_rules! section {
        ($name:literal, $value:expr) => {
            if let Some(value) = $value {
                sections.push((
                    $name,
                    toml::Value::try_from(value).map_err(|_| {
                        GatewayError::Internal(anyhow::anyhow!(
                            "Configuration patch serialization failed"
                        ))
                    })?,
                ));
            }
        };
    }
    section!("firewall", &patch.firewall);
    section!("budgets", &patch.budgets);
    section!("routing", &patch.routing);
    section!("egress", &patch.egress);
    section!("tools", &patch.tools);
    section!("composio.billing", &patch.composio_billing);
    section!("acp", &patch.acp);
    section!("backends", &patch.resolved_backends);
    section!("custom_evaluators", &patch.custom_evaluators);
    section!(
        "marketplace_recommendations",
        &patch.marketplace_recommendations
    );
    section!("computer_use", &patch.computer_use);
    section!("screening", &patch.screening);
    let phone_calls = patch.phone_calls.clone().map(PhoneCallsConfig::from);
    section!("channels.phone_calls", &phone_calls);
    section!("firewall_org_overlays", org);
    section!("firewall_agent_overlays", agent);
    if let Some(auth) = &patch.auth {
        sections.push((
            "auth.api_keys",
            toml::Value::try_from(&auth.api_keys).map_err(|_| {
                GatewayError::Internal(anyhow::anyhow!("Auth patch serialization failed"))
            })?,
        ));
    }
    Ok(sections)
}

fn authored_table<'a>(
    root: &'a mut toml::Value,
    name: &str,
) -> Result<&'a mut toml::map::Map<String, toml::Value>, GatewayError> {
    root.as_table_mut()
        .ok_or_else(|| {
            GatewayError::Internal(anyhow::anyhow!("Authored configuration root is invalid"))
        })?
        .entry(name.to_owned())
        .or_insert_with(|| toml::Value::Table(Default::default()))
        .as_table_mut()
        .ok_or_else(|| {
            GatewayError::Internal(anyhow::anyhow!("Authored configuration section is invalid"))
        })
}

fn commit_authored_config(
    path: &std::path::Path,
    expected: Option<&ryu_gw_credentials::ConfigRevision>,
    sections: AuthoredSections,
    policies: Option<ryu_gw_credentials::ProviderAccountPolicies>,
    strategies: Option<HashMap<String, ryu_gw_providers::AccountSelectionStrategy>>,
    drain_thresholds: Option<HashMap<String, u8>>,
    inputs: crate::providers::ProviderInputs,
) -> Result<
    (
        ryu_gw_credentials::ConfigFileTransaction,
        ryu_gw_credentials::ConfigRevision,
    ),
    GatewayError,
> {
    let mut guard =
        ryu_gw_credentials::ConfigFileTransaction::acquire(path).map_err(transaction_error)?;
    let revision = guard.snapshot().revision().clone();
    if expected.is_some_and(|expected| *expected != revision) {
        return Err(GatewayError::ConfigConflict(revision));
    }
    let text = std::str::from_utf8(guard.snapshot().bytes()).map_err(|_| {
        GatewayError::Internal(anyhow::anyhow!(
            "Authored configuration encoding is invalid"
        ))
    })?;
    // Open sealed secrets so validation and account ids see the plaintext;
    // `commit` seals every secret leaf again before the bytes reach disk.
    let text = ryu_gw_credentials::sealed_config::open_text(text).map_err(|error| {
        GatewayError::Internal(anyhow::anyhow!("Authored configuration: {error}"))
    })?;
    let mut authored: toml::Value = toml::from_str(&text).map_err(|_| {
        GatewayError::Internal(anyhow::anyhow!("Authored configuration syntax is invalid"))
    })?;
    let _: GatewayConfig = authored.clone().try_into().map_err(|_| {
        GatewayError::Internal(anyhow::anyhow!("Authored configuration schema is invalid"))
    })?;
    for (name, value) in sections {
        if name == "auth.api_keys" {
            authored_table(&mut authored, "auth")?.insert("api_keys".to_owned(), value);
        } else if name == "composio.billing" {
            authored_table(&mut authored, "composio")?.insert("billing".to_owned(), value);
        } else {
            authored
                .as_table_mut()
                .ok_or_else(|| {
                    GatewayError::Internal(anyhow::anyhow!(
                        "Authored configuration root is invalid"
                    ))
                })?
                .insert(name.to_owned(), value);
        }
    }
    if let Some(policies) = policies {
        let effective: GatewayConfig = authored.clone().try_into().map_err(|_| {
            GatewayError::BadRequest("Authored provider configuration is invalid".to_owned())
        })?;
        let policies = inputs.validate_policies(effective, &policies, &revision)?;
        let providers = authored_table(&mut authored, "providers")?;
        let store = providers
            .entry("accountPolicies".to_owned())
            .or_insert_with(|| toml::Value::Table(Default::default()));
        for (provider, entries) in policies {
            let scope = authored_table(store, &provider)?;
            for (id, policy) in entries {
                scope.insert(
                    id,
                    toml::Value::try_from(policy).map_err(|_| {
                        GatewayError::Internal(anyhow::anyhow!(
                            "Account policy serialization failed"
                        ))
                    })?,
                );
            }
        }
    }
    if let Some(strategies) = strategies {
        if strategies.is_empty() || strategies.len() > 32 {
            return Err(GatewayError::BadRequest(
                "update between 1 and 32 provider account strategies".to_owned(),
            ));
        }
        let providers = authored_table(&mut authored, "providers")?;
        let store = providers
            .entry("accountStrategies".to_owned())
            .or_insert_with(|| toml::Value::Table(Default::default()));
        for (provider, strategy) in strategies {
            if !ryu_gw_credentials::supports_chat_account_routing(&provider) {
                return Err(GatewayError::BadRequest(format!(
                    "Account strategy is not supported for {provider}"
                )));
            }
            if !ryu_gw_credentials::supports_observed_quota_account_routing(&provider)
                && !matches!(
                    strategy,
                    ryu_gw_providers::AccountSelectionStrategy::RoundRobin
                        | ryu_gw_providers::AccountSelectionStrategy::FillFirst
                )
            {
                return Err(GatewayError::BadRequest(format!(
                    "{provider} account routing supports round robin or fill first; quota observations are unavailable"
                )));
            }
            store
                .as_table_mut()
                .ok_or_else(|| {
                    GatewayError::BadRequest(
                        "Authored accountStrategies must be a table".to_owned(),
                    )
                })?
                .insert(
                    provider,
                    toml::Value::try_from(strategy).map_err(|_| {
                        GatewayError::Internal(anyhow::anyhow!(
                            "Account strategy serialization failed"
                        ))
                    })?,
                );
        }
    }
    if let Some(thresholds) = drain_thresholds {
        if thresholds.is_empty() || thresholds.len() > 32 {
            return Err(GatewayError::BadRequest(
                "update between 1 and 32 provider account drain thresholds".to_owned(),
            ));
        }
        let providers = authored_table(&mut authored, "providers")?;
        let store = providers
            .entry("accountDrainThresholds".to_owned())
            .or_insert_with(|| toml::Value::Table(Default::default()));
        let store = store.as_table_mut().ok_or_else(|| {
            GatewayError::BadRequest("Authored accountDrainThresholds must be a table".to_owned())
        })?;
        for (provider, percent) in thresholds {
            if !ryu_gw_credentials::supports_observed_quota_account_routing(&provider) {
                return Err(GatewayError::BadRequest(format!(
                    "Account drain threshold is not supported for {provider}"
                )));
            }
            if !(1..=100).contains(&percent) {
                return Err(GatewayError::BadRequest(format!(
                    "Account drain threshold for {provider} must be 1–100"
                )));
            }
            store.insert(provider, toml::Value::Integer(i64::from(percent)));
        }
    }
    let _: GatewayConfig = authored.clone().try_into().map_err(|_| {
        GatewayError::Internal(anyhow::anyhow!("Patched configuration schema is invalid"))
    })?;
    let bytes = toml::to_string_pretty(&authored).map_err(|_| {
        GatewayError::Internal(anyhow::anyhow!(
            "Authored configuration serialization failed"
        ))
    })?;
    let revision = guard
        .commit(&revision, bytes.as_bytes())
        .map_err(transaction_error)?;
    Ok((guard, revision))
}

#[cfg(test)]
#[path = "config_authored_transaction_tests.rs"]
mod authored_transaction_tests;

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
