use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use std::collections::HashMap;

use crate::{
    config::{
        ApiKeyConfig, AuthConfig, BudgetConfig, FirewallConfig, FirewallOverlay, GatewayConfig,
        ProviderId, ProvidersConfig, RoutingConfig, SmartRoutingConfig, StageBackendsConfig,
        ToolProfile, ToolsConfig,
    },
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

// ─── GET /v1/config ──────────────────────────────────────────────────────────

/// Public view of GatewayConfig with provider api_key fields redacted.
#[derive(Serialize)]
struct ConfigView {
    firewall: FirewallConfig,
    budgets: BudgetConfig,
    providers: ProvidersView,
    auth: AuthView,
    routing: RoutingView,
    /// Tool-loop config: master switch + named tool-policy profiles. Profiles
    /// carry no secrets, so they are returned verbatim for the UI to read/edit
    /// (mirrors how `firewall` / `smart_routing` are surfaced).
    tools: ToolsConfigView,
    /// Gateway-local standalone-desktop firewall overlay stores (§6 of the
    /// hierarchical-policy spec): the org and per-agent [`FirewallOverlay`]s
    /// authored via `PUT /v1/config` when there is no control plane. Keyed by org
    /// id / agent id; `{}` on a fresh node. These are the mid + leaf scopes of the
    /// node→org→agent cascade for the standalone path; the node scope (base
    /// firewall) plus its `inspector` + `locked_fields` are carried inside
    /// `firewall`. Persisted to `gateway.toml`
    /// (`GatewayConfig::firewall_{org,agent}_overlays`) and reseeded into the
    /// resolver at startup (FIX 4), so they survive a gateway restart.
    firewall_org_overlays: HashMap<String, FirewallOverlay>,
    firewall_agent_overlays: HashMap<String, FirewallOverlay>,
    /// Static policy-drift warnings (dangerous-tool-combo + elevation drift).
    /// Computed from the LIVE firewall config plus the tool / composio / exec
    /// budget config and the distributed policy. Empty on a clean config.
    drift: Vec<crate::policy::DriftWarning>,
}

/// Redacted view of ToolsConfig: the master switch and the named tool-policy
/// profiles (presets). `always_on` tool defs and the loop tuning knobs are
/// omitted; profiles are the operator-facing policy surface.
#[derive(Serialize)]
struct ToolsConfigView {
    enabled: bool,
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
    name: String,
    /// Key value is always `"***"` in GET responses.
    key: String,
    trusted_forwarder: bool,
    org_id: Option<String>,
    team_id: Option<String>,
}

/// Public view of RoutingConfig (no secrets; ProviderId serializes as a bare string).
#[derive(Serialize)]
struct RoutingView {
    default_provider: ProviderId,
    model_map: std::collections::HashMap<String, ModelMappingView>,
    fallback_chain: Vec<ProviderId>,
    /// Cost-tier ordering (#2). Not a secret; returned so the desktop tier editor
    /// can read-modify-write the full routing object.
    provider_tiers: std::collections::HashMap<ProviderId, u8>,
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
struct ProvidersView {
    openai: Option<ProviderView>,
    anthropic: Option<ProviderView>,
    local: Option<LocalView>,
    openrouter: Option<ProviderView>,
    core: Option<CoreView>,
    modal: Option<ProviderView>,
    genai: Option<GenAiView>,
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
}

fn redact_providers(p: &ProvidersConfig) -> ProvidersView {
    ProvidersView {
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
        core: p.core.as_ref().map(|c| CoreView {
            base_url: c.base_url.clone(),
            has_token: c.token.is_some(),
        }),
        modal: p.modal.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
            api_key_count: usize::from(!c.api_key.is_empty()),
        }),
        genai: p.genai.as_ref().map(|c| GenAiView {
            keys: c.keys.keys().cloned().collect(),
        }),
    }
}

fn redact_auth(a: &AuthConfig) -> AuthView {
    AuthView {
        require_auth: a.require_auth,
        api_keys: a
            .api_keys
            .iter()
            .map(|k| ApiKeyView {
                name: k.name.clone(),
                key: "***".to_string(),
                trusted_forwarder: k.trusted_forwarder,
                org_id: k.org_id.clone(),
                team_id: k.team_id.clone(),
            })
            .collect(),
    }
}

/// Authorize an admin (config/audit) request. The master key always passes.
/// Without it, access is allowed ONLY from a loopback peer in no-auth mode —
/// never from a remote host. The gateway can bind `0.0.0.0` (config default), so
/// `require_auth` alone (a *base*-auth flag, not an admin gate) must not be the
/// only thing standing between a remote caller and this surface.
/// Whether an admin request may pass WITHOUT the master key. Pure decision so the
/// mesh-neutralization (#478, B-9), the fleet-neutralization (managed-cloud
/// WS2), and the provisioned-master-key gate (P2 #2) are unit-testable. The only
/// no-master-key path is a loopback peer in no-auth mode — and that loopback
/// trust is neutralized when ANY of the following holds:
///   - the mesh is on OR fleet mode is on, because in both cases an inbound peer
///     can appear as `127.0.0.1` without being the local operator (userspace
///     mesh tailnet peers are loopback; behind a co-located fleet LB/reverse-proxy
///     external callers are loopback) — either would otherwise fail the gate OPEN;
///   - a master key IS provisioned (`master_key_present`). Provisioning a master
///     key via `GATEWAY_MASTER_KEY` also forces `require_auth = true`
///     (`config.rs` env load), so that path is already covered by `require_auth`;
///     this term additionally closes the file-config residual where
///     `gateway.toml [auth] master_key` is set with `require_auth = false` — an
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
/// provisioned) — see [`admin_loopback_allowed`]. Shared by the config, audit,
/// and budget-spend handlers so the gate has one definition and cannot drift.
/// CSRF defense (F3): reject state-changing requests that a browser stamped as a
/// cross-origin (`cross-site`) or same-origin scripted (`same-site`) fetch.
///
/// Several privileged gateway routes authorize on loopback posture alone (no
/// credential) while the gateway serves a permissive `allow_origin(Any)` CORS
/// policy — so a malicious web page the user merely visits could `fetch()` them
/// cross-origin (e.g. read the config, PUT a trusted_forwarder API key, or get a
/// manifest signed under the trusted key). Browsers stamp `Sec-Fetch-Site` on
/// such requests and page JS cannot forge or strip it; a cross-site (or
/// same-site) browser origin is never a legitimate privileged caller. Non-browser
/// callers — curl, SDKs, and the desktop's own admin path (webview → Core →
/// gateway, whose gateway hop is a server-side Rust request) — omit the header
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

/// Anti–DNS-rebinding defense (F3): reject a request whose `Host` header is not a
/// loopback authority. `Host` is a Fetch-spec forbidden header — page JS cannot
/// set or forge it — so a rebinding page pointing `evil.com` at `127.0.0.1` still
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
        state.config.fleet,
        master_key_present,
    ) {
        return Err(GatewayError::Unauthorized(format!(
            "{action} requires the master key."
        )));
    }
    Ok(())
}

/// Return the current firewall, budget, provider (redacted), auth, and routing config.
/// Requires the master key — same auth gate as `GET /v1/audit`.
pub async fn get_config(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    require_local_admin(&state, &peer, ctx.is_master_key, &headers, "Config access")?;

    // Read live config from the RwLock fields so GET reflects any PUT changes
    // that have been applied since startup.
    let firewall_cfg = state.with_firewall(|fw| fw.config().clone());
    let budget_cfg = state.with_budget(|b| b.config().clone());
    let auth_cfg = state.with_auth(|a| a.clone());

    let routing = &state.config.routing;
    let routing_view = RoutingView {
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
        smart_routing: routing.smart_routing.clone(),
    };

    // Tool-policy profiles are static config (read from state.config like
    // routing); a PUT change takes effect on the next gateway restart.
    let tools_view = ToolsConfigView {
        enabled: state.config.tools.enabled,
        profiles: state.config.tools.profiles.clone(),
    };

    // Compute drift from the LIVE firewall config (so PUT hot-swaps are
    // reflected) plus the static tool / composio / exec-budget config and the
    // current distributed policy snapshot. Warn-only: nothing is blocked.
    let drift = crate::policy::detect_drift(
        &state.config.tools,
        &state.config.composio,
        &state.config.exec_budget,
        &firewall_cfg,
        &state.policy_snapshot(),
    );

    let view = ConfigView {
        firewall: firewall_cfg,
        budgets: budget_cfg,
        providers: redact_providers(&state.config.providers),
        auth: redact_auth(&auth_cfg),
        routing: routing_view,
        tools: tools_view,
        // Snapshot the resolver's standalone-local overlay stores so the desktop
        // can read-modify-write them. Empty on the hosted path (overlays arrive
        // on the resolve response there, not via this store).
        firewall_org_overlays: state.resolver.org_overlays(),
        firewall_agent_overlays: state.resolver.agent_overlays(),
        drift,
    };

    Ok(Json(json!(view)))
}

// ─── PUT /v1/config ───────────────────────────────────────────────────────────

/// Partial update to the auth config accepted by `PUT /v1/config`.
/// Only `api_keys` is writable; `require_auth` and `master_key` are
/// environment-variable-only to prevent accidental lockout.
#[derive(Deserialize)]
pub struct AuthConfigPatch {
    /// Full replacement list of API keys. Any key not in this list is removed.
    pub api_keys: Vec<ApiKeyConfig>,
}

/// Partial config update accepted by `PUT /v1/config`.
/// `firewall`, `budgets`, and `auth.api_keys` are hot-swapped live. `routing` is
/// **partially** hot-swapped: its `smart_routing` sub-config (the classifier
/// on/off switch + rules) live-swaps the global smart router
/// ([`crate::state::AppState::update_smart_router`]) with no restart, while
/// `model_map` / `fallback_chain` / `provider_tiers` live in the [`ModelRouter`]
/// startup snapshot and still take effect on the next gateway restart. `tools` is
/// persisted and takes effect on the next restart (the request path reads the
/// startup snapshot). Provider credentials and master_key require an
/// environment-variable change.
#[derive(Deserialize)]
pub struct ConfigPatch {
    pub firewall: Option<FirewallConfig>,
    pub budgets: Option<BudgetConfig>,
    /// When present, replaces the list of per-client API keys. The master key
    /// and `require_auth` flag are unchanged; they are environment-variable-only.
    pub auth: Option<AuthConfigPatch>,
    pub routing: Option<RoutingConfig>,
    /// When present, replaces the tool-loop config (master switch + named
    /// tool-policy profiles). Like `routing`, this is persisted and takes effect
    /// on the next gateway restart; the request path reads `state.config.tools`
    /// directly, which is fixed at startup.
    pub tools: Option<ToolsConfig>,
    /// Full replacement of the gateway-local standalone org overlay store (§6).
    /// Full-replacement semantics, matching `auth.api_keys`: any org id absent
    /// from this map is removed. Applied to the resolver's in-memory store
    /// (invalidating the scanner cache) AND persisted to `gateway.toml` (FIX 4)
    /// so it survives a restart — but only when a writable config path exists; an
    /// overlay-only patch on a node with no config path still applies live and
    /// simply skips disk, so authoring never hard-errors. Each overlay is
    /// normalized first (the node-only `wrap_untrusted_tool_results` value/lock is
    /// stripped, FIX 2).
    #[serde(default)]
    pub firewall_org_overlays: Option<HashMap<String, FirewallOverlay>>,
    /// Full replacement of the gateway-local standalone per-agent overlay store
    /// (§6), keyed by agent id. Same full-replacement + persist-when-path-exists
    /// + normalize semantics as `firewall_org_overlays`.
    #[serde(default)]
    pub firewall_agent_overlays: Option<HashMap<String, FirewallOverlay>>,
    /// Full replacement of the user-authored custom evaluator set
    /// ([`GatewayConfig::custom_evaluators`]). Validated
    /// ([`crate::evaluators::validate_custom_evaluators`]: non-empty ids, no dupes)
    /// then persisted to `gateway.toml`. Like `routing`/`tools` it is NOT
    /// hot-swapped — the request path reads the startup snapshot, so it takes effect
    /// on the next gateway restart (the desktop save flow triggers one). Absent ⇒
    /// the existing set is preserved.
    #[serde(default)]
    pub custom_evaluators: Option<Vec<crate::evaluators::Evaluator>>,
    /// Per-stage active-backend selection (W6a). Names which registered backend is
    /// active for each inverted stage. Every requested id is validated against the
    /// live registry's `available()` set BEFORE persist (fail-closed: an unknown id
    /// is rejected with `BadRequest` listing the registered ids), so a saved config
    /// can never brick the next boot. `budget` — the one registry with a `&self`
    /// `set_active` — is swapped live; the rest are startup snapshots (like
    /// `routing`/`tools`), so their new selection takes effect on the next restart.
    #[serde(default)]
    pub backends: Option<StageBackendsConfig>,
}

/// Whether a [`ConfigPatch`] carries no updatable field at all. Extracted as a
/// pure predicate (mirroring [`admin_loopback_allowed`]) so the "empty patch"
/// rejection — which must now also accept an overlay-only patch — is
/// unit-testable without building a request. Each argument is one
/// `patch.<field>.is_some()`.
#[allow(clippy::fn_params_excessive_bools, clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
fn patch_is_empty(
    firewall: bool,
    budgets: bool,
    auth: bool,
    routing: bool,
    tools: bool,
    org_overlays: bool,
    agent_overlays: bool,
    custom_evaluators: bool,
    backends: bool,
) -> bool {
    !(firewall
        || budgets
        || auth
        || routing
        || tools
        || org_overlays
        || agent_overlays
        || custom_evaluators
        || backends)
}

/// Validate a per-stage backend selection against the live registries before it
/// is persisted or applied (W6a). Every requested id must be registered in that
/// stage's registry (`available()`), else the patch is refused with a `BadRequest`
/// listing the registered ids — otherwise a persisted unknown id would refuse the
/// NEXT boot (`AppState::new` fails closed). A disabled stage (empty `available`,
/// only semantic_cache today) accepts only the default `"builtin"` no-op.
fn validate_stage_backends(
    state: &SharedState,
    sel: &StageBackendsConfig,
) -> Result<(), GatewayError> {
    let checks: [(&str, &str, Vec<String>); 7] = [
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
/// persisted, or resolved — an org/agent scope may neither set nor lock it.
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

/// Apply a config change live, then persist to `gateway.toml`. The live state
/// is updated atomically; the file write uses a temp-file rename so a crash
/// mid-write leaves the old file intact.
///
/// Validation order: deserialize → persist → apply-live. If the file write
/// fails the live config is unchanged.
pub async fn put_config(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(patch): Json<ConfigPatch>,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    // Same local-trust rule as GET: writable from loopback in no-auth mode,
    // master-key-gated otherwise (remote peers always need the master key).
    require_local_admin(&state, &peer, ctx.is_master_key, &headers, "Config updates")?;

    if patch_is_empty(
        patch.firewall.is_some(),
        patch.budgets.is_some(),
        patch.auth.is_some(),
        patch.routing.is_some(),
        patch.tools.is_some(),
        patch.firewall_org_overlays.is_some(),
        patch.firewall_agent_overlays.is_some(),
        patch.custom_evaluators.is_some(),
        patch.backends.is_some(),
    ) {
        return Err(GatewayError::BadRequest(
            "Patch body must include at least one of: firewall, budgets, auth, routing, tools, \
             firewall_org_overlays, firewall_agent_overlays, custom_evaluators, backends"
                .to_string(),
        ));
    }

    // Validate any incoming per-stage backend selection against the live
    // registries BEFORE persisting: an unknown id here would refuse the NEXT boot
    // (AppState::new fails closed), so reject it now with the registered ids.
    if let Some(backends) = &patch.backends {
        validate_stage_backends(&state, backends)?;
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
    let org_next = patch.firewall_org_overlays.map(normalize_overlay_map);
    let agent_next = patch.firewall_agent_overlays.map(normalize_overlay_map);

    let has_config_field = patch.firewall.is_some()
        || patch.budgets.is_some()
        || patch.auth.is_some()
        || patch.routing.is_some()
        || patch.tools.is_some()
        || patch.custom_evaluators.is_some()
        || patch.backends.is_some();
    let has_overlay_field = org_next.is_some() || agent_next.is_some();
    // Persist when a config-backed field changed (always — `save()` errors if no
    // path, as before), OR when overlays changed AND a writable config path exists
    // (FIX 4: overlays now round-trip through `gateway.toml`). An overlay-only
    // patch on a node with no config path still applies live but skips disk, so
    // authoring a standalone overlay never hard-errors.
    let config_path_exists = GatewayConfig::config_path().is_some();
    let needs_persist = has_config_field || (has_overlay_field && config_path_exists);

    if needs_persist {
        // Build the updated persisted config by cloning the current one and
        // applying the patch fields. We do NOT touch provider keys or master_key.
        let mut updated_config: GatewayConfig = state.config.clone();
        if let Some(fw) = &patch.firewall {
            updated_config.firewall = fw.clone();
        }
        if let Some(budgets) = &patch.budgets {
            updated_config.budgets = budgets.clone();
        }
        if let Some(auth_patch) = &patch.auth {
            updated_config.auth.api_keys = auth_patch.api_keys.clone();
        }
        if let Some(routing) = &patch.routing {
            updated_config.routing = routing.clone();
        }
        if let Some(tools) = &patch.tools {
            updated_config.tools = tools.clone();
        }
        // Per-stage backend selection (W6a): persisted so a restart's
        // `AppState::new` reapplies it. Already validated against the live
        // registries above, so the persisted ids can never brick the next boot.
        if let Some(backends) = &patch.backends {
            updated_config.backends = backends.clone();
        }
        // Custom evaluators (full replacement). Snapshot-only, like routing/tools:
        // persisted here, read from the startup config on the request path, so it
        // takes effect on the next gateway restart (the desktop save flow must
        // trigger a restart — see the handler doc). CLOBBER GUARD: `state.config`
        // is the STARTUP snapshot and is never hot-swapped, so on a patch that
        // OMITS the field we must preserve the LAST-PERSISTED set from disk rather
        // than the stale snapshot — otherwise an unrelated later PUT (e.g.
        // firewall-only) would clone `custom_evaluators = []` and wipe
        // hand-authored evaluators. Mirrors the overlay stores' `unwrap_or_else(live)`
        // intent; if the disk read fails we fall back to the snapshot clone.
        if let Some(custom) = &patch.custom_evaluators {
            updated_config.custom_evaluators = custom.clone();
        } else if let Ok(on_disk) = GatewayConfig::load() {
            updated_config.custom_evaluators = on_disk.custom_evaluators;
        }
        // Overlay stores (FIX 4): the resulting full-replacement store equals the
        // normalized `next` map when the patch carries it, else the resolver's
        // current live store (so a config-only patch preserves existing overlays
        // rather than wiping them from disk).
        updated_config.firewall_org_overlays = org_next
            .clone()
            .unwrap_or_else(|| state.resolver.org_overlays());
        updated_config.firewall_agent_overlays = agent_next
            .clone()
            .unwrap_or_else(|| state.resolver.agent_overlays());

        // Persist first: if the write fails, we leave live config unchanged.
        updated_config.save().map_err(|e| {
            GatewayError::Internal(anyhow::anyhow!("Failed to persist config: {e}"))
        })?;
    }

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
    // still take effect on the next restart, but the smart-routing TOGGLE — the
    // one a Core policy plugin flips — now lands without a respawn.
    if let Some(routing) = patch.routing {
        state.update_smart_router(routing.smart_routing);
    }
    // Per-stage backend selection (W6a): budget is the one registry with a `&self`
    // `set_active`, so its selection swaps live (validated above → cannot fail).
    // The other stages' registries take `&mut self` and are startup snapshots, so
    // their persisted selection takes effect on the next restart — the same
    // restart-only discipline as `routing.model_map` / `tools` / `custom_evaluators`.
    if let Some(backends) = &patch.backends {
        state.budget.set_active(&backends.budget);
    }

    // Apply the standalone overlay-store replacements (§6) live, using the
    // normalized maps. Each resolver write invalidates the scanner cache, so the
    // next request re-resolves the node→org→agent cascade against the new
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

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::admin_loopback_allowed;

    #[test]
    fn loopback_no_auth_no_mesh_is_allowed() {
        // The classic local-dev case: loopback peer, no base auth, mesh off,
        // fleet off, and no master key provisioned. This is the zero-config
        // Core-proxy path and MUST stay open.
        assert!(admin_loopback_allowed(true, false, false, false, false));
    }

    #[test]
    fn mesh_neutralizes_loopback_trust() {
        // #478 B-9: under mesh a tailnet peer appears as 127.0.0.1, so loopback
        // trust must be neutralized — admin requires the master key.
        assert!(!admin_loopback_allowed(true, false, true, false, false));
    }

    #[test]
    fn fleet_neutralizes_loopback_trust() {
        // WS2: behind a co-located fleet LB an external caller appears as
        // 127.0.0.1, so fleet mode drops loopback trust — admin requires the
        // master key even for a loopback peer.
        assert!(!admin_loopback_allowed(true, false, false, true, false));
    }

    #[test]
    fn provisioned_master_key_neutralizes_loopback_trust() {
        // P2 #2: a master key set in gateway.toml with require_auth=false must
        // still gate these control-plane reads — loopback trust is neutralized
        // once an admin key exists, so config/audit require it.
        assert!(!admin_loopback_allowed(true, false, false, false, true));
    }

    #[test]
    fn remote_peer_never_loopback_allowed() {
        assert!(!admin_loopback_allowed(false, false, false, false, false));
        assert!(!admin_loopback_allowed(false, false, true, false, false));
    }

    #[test]
    fn require_auth_forces_master_key() {
        assert!(!admin_loopback_allowed(true, true, false, false, false));
    }

    // ── §6 gateway-local firewall overlay stores (org/agent scopes) ───────────
    //
    // These cover the two things THIS leaf changes on top of the resolver (which
    // resolve.rs already unit-tests): the loosened empty-patch guard + the JSON
    // shape of the overlay fields, and end-to-end that authoring an overlay via
    // the same replace helper the PUT handler uses changes the resolved scanner
    // for a request carrying that org/agent, while other scopes stay on the base.

    use std::collections::HashMap;

    use super::{patch_is_empty, replace_overlay_store, ConfigPatch};
    use crate::{
        audit::AuditLogger,
        config::{
            AuditConfig, CustomPattern, CustomPatternKind, EvalsConfig, FirewallOverlay,
            FirewallPolicy, GatewayConfig,
        },
        evals::EvalsRunner,
        pipeline::RequestContext,
        state::AppState,
    };

    /// A minimal, disk-free `AppState` (audit disabled, default config).
    fn test_state() -> AppState {
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = EvalsRunner::new(EvalsConfig::default());
        AppState::new_for_test(GatewayConfig::default(), audit, evals)
    }

    /// A minimal `RequestContext` carrying only an org/agent id, on the standalone
    /// path (`resolved_policy: None` ⇒ empty control-plane bundle ⇒ the resolver
    /// consults its gateway-local overlay stores).
    fn ctx_for(org: Option<&str>, agent: Option<&str>) -> RequestContext {
        RequestContext {
            request_id: "t".into(),
            api_key: "k".into(),
            is_master_key: false,
            org_id: org.map(str::to_string),
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: agent.map(str::to_string),
            key_config: None,
            skill_ids: None,
            tool_actions: None,
            tools_header_present: false,
            slot_provider: None,
            slot_model: None,
            session_id: None,
            feature: None,
            companion_source: false,
            tool_search_requested: false,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: false,
            remaining_budget_micro_usd: None,
            resolved_policy: None,
        }
    }

    /// Author (full-replacement) the resolver's local org overlay store, exactly
    /// as `put_config` does.
    fn put_org_overlays(state: &AppState, next: HashMap<String, FirewallOverlay>) {
        replace_overlay_store(
            state.resolver.org_overlays().into_keys().collect(),
            next,
            |id| state.resolver.remove_org_overlay(id),
            |id, ov| state.resolver.set_org_overlay(id, ov),
        );
    }

    fn put_agent_overlays(state: &AppState, next: HashMap<String, FirewallOverlay>) {
        replace_overlay_store(
            state.resolver.agent_overlays().into_keys().collect(),
            next,
            |id| state.resolver.remove_agent_overlay(id),
            |id, ov| state.resolver.set_agent_overlay(id, ov),
        );
    }

    #[test]
    fn patch_is_empty_true_only_when_every_field_absent() {
        // The all-none case is the only rejection.
        assert!(patch_is_empty(
            false, false, false, false, false, false, false, false, false
        ));
        // Regression guard for the loosened check: an OVERLAY-ONLY patch (the
        // standalone-desktop authoring case) must NOT be rejected as empty.
        assert!(!patch_is_empty(
            false, false, false, false, false, true, false, false, false
        ));
        assert!(!patch_is_empty(
            false, false, false, false, false, false, true, false, false
        ));
        // A custom-evaluators-only patch is also non-empty.
        assert!(!patch_is_empty(
            false, false, false, false, false, false, false, true, false
        ));
        // A backends-only patch (per-stage backend selection) is non-empty.
        assert!(!patch_is_empty(
            false, false, false, false, false, false, false, false, true
        ));
        // A classic config-field patch is still non-empty.
        assert!(!patch_is_empty(
            true, false, false, false, false, false, false, false, false
        ));
    }

    /// The PUT path validates every requested stage backend against the live
    /// registries: the default (all-`"builtin"`) selection is accepted; a
    /// registered non-builtin (here a stub registered into the budget registry) is
    /// accepted; an unknown id is refused with a `BadRequest` that names the stage.
    #[test]
    fn put_config_validates_stage_backends() {
        use super::validate_stage_backends;
        use crate::budget::{BudgetBackend, BudgetDecision};
        use crate::config::{BudgetConfig, StageBackendsConfig};
        use crate::error::GatewayError;
        use std::sync::Arc;

        struct StubBudget(BudgetConfig);
        impl BudgetBackend for StubBudget {
            fn config(&self) -> &BudgetConfig {
                &self.0
            }
            fn evaluate(&self, _u: Option<&str>, _a: Option<&str>) -> Option<BudgetDecision> {
                None
            }
            fn evaluate_session(&self, _s: Option<&str>) -> Option<BudgetDecision> {
                None
            }
            fn record(&self, _u: Option<&str>, _a: Option<&str>, _t: u64) {}
            fn record_session(&self, _s: Option<&str>, _t: u64) {}
        }

        let state = Arc::new(test_state());

        // Default (all "builtin") selection validates cleanly.
        assert!(validate_stage_backends(&state, &StageBackendsConfig::default()).is_ok());

        // An unknown id for any stage is refused, naming the stage.
        let mut bad = StageBackendsConfig::default();
        bad.cache = "ghost".to_string();
        match validate_stage_backends(&state, &bad) {
            Err(GatewayError::BadRequest(msg)) => {
                assert!(
                    msg.contains("backends.cache") && msg.contains("ghost"),
                    "{msg}"
                );
            }
            other => panic!("expected BadRequest, got {other:?}"),
        }

        // A registered non-builtin backend validates — and the live budget registry
        // then swaps to it (the &self hot-swap the PUT handler performs).
        state
            .budget
            .register("stub", Arc::new(StubBudget(BudgetConfig::default())));
        let mut good = StageBackendsConfig::default();
        good.budget = "stub".to_string();
        assert!(validate_stage_backends(&state, &good).is_ok());
        assert!(state.budget.set_active("stub"));
        assert_eq!(state.budget.active_id().as_str(), "stub");
    }

    #[test]
    fn config_patch_deserializes_overlay_fields() {
        // Confirms the wire shape the desktop read-modify-writes: snake_case
        // overlay keys under two top-level maps keyed by org/agent id.
        let json = serde_json::json!({
            "firewall_org_overlays": {
                "o1": { "policy": "block", "redact_pii": false, "custom_patterns": [] }
            },
            "firewall_agent_overlays": {
                "a1": { "enabled": false }
            }
        });
        let patch: ConfigPatch = serde_json::from_value(json).expect("deserialize overlay patch");

        let org = patch.firewall_org_overlays.expect("org overlays present");
        assert_eq!(org["o1"].policy, Some(FirewallPolicy::Block));
        assert_eq!(org["o1"].redact_pii, Some(false));
        let agent = patch
            .firewall_agent_overlays
            .expect("agent overlays present");
        assert_eq!(agent["a1"].enabled, Some(false));
    }

    #[test]
    fn replace_overlay_store_removes_absent_ids_and_updates_present() {
        let state = test_state();
        state
            .resolver
            .set_org_overlay("keep".into(), FirewallOverlay::default());
        state
            .resolver
            .set_org_overlay("drop".into(), FirewallOverlay::default());

        // A full-replacement PUT that lists only `keep` (with a change) drops
        // `drop` and updates `keep`.
        let mut next = HashMap::new();
        next.insert(
            "keep".to_string(),
            FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                ..Default::default()
            },
        );
        put_org_overlays(&state, next);

        let store = state.resolver.org_overlays();
        assert!(store.contains_key("keep"), "listed id retained");
        assert!(!store.contains_key("drop"), "absent id removed");
        assert_eq!(
            store["keep"].policy,
            Some(FirewallPolicy::Block),
            "listed id updated"
        );
    }

    #[test]
    fn authored_overlays_change_resolved_scanner_per_scope() {
        let state = test_state();
        let ctx = ctx_for(Some("o1"), Some("a1"));
        // `WIDGET-\d+` is matched by no built-in PII pattern, so the node base
        // lets it through.
        assert!(
            state
                .resolved_scanner(&ctx)
                .scan_inbound("ship WIDGET-123 now")
                .is_none(),
            "node base does not know WIDGET ids"
        );

        // Author an org overlay adding a PII custom pattern.
        let mut org = HashMap::new();
        org.insert(
            "o1".to_string(),
            FirewallOverlay {
                custom_patterns: vec![CustomPattern {
                    name: "widget".into(),
                    regex: r"WIDGET-\d+".into(),
                    kind: CustomPatternKind::Pii,
                }],
                ..Default::default()
            },
        );
        put_org_overlays(&state, org);

        // A request for org o1 now trips the org's custom pattern.
        assert!(
            state
                .resolved_scanner(&ctx)
                .scan_inbound("ship WIDGET-123 now")
                .is_some(),
            "org overlay pattern enforced for its org"
        );
        // A request for a DIFFERENT org is unaffected — empty overlay ⇒ node base.
        let other = ctx_for(Some("o2"), None);
        assert!(
            state
                .resolved_scanner(&other)
                .scan_inbound("ship WIDGET-123 now")
                .is_none(),
            "other org still on the node base"
        );

        // Author an agent overlay tightening the policy; the leaf wins.
        let mut agent = HashMap::new();
        agent.insert(
            "a1".to_string(),
            FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                ..Default::default()
            },
        );
        put_agent_overlays(&state, agent);

        let resolved = state.resolved_scanner(&ctx);
        assert_eq!(
            resolved.config().policy,
            FirewallPolicy::Block,
            "agent leaf overlay applied"
        );
        // The org pattern still applies alongside the agent policy (union).
        assert!(resolved.scan_inbound("ship WIDGET-123 now").is_some());
    }

    #[test]
    fn empty_overlays_resolve_to_node_base() {
        // The preserved-behaviour invariant: with no overlays authored, a request
        // carrying org/agent ids resolves byte-for-byte to the node base.
        let state = test_state();
        let ctx = ctx_for(Some("o1"), Some("a1"));
        let resolved = state.resolved_scanner(&ctx).config().clone();
        let base = state.resolver.node_base();
        assert_eq!(resolved.enabled, base.enabled);
        assert_eq!(resolved.scan_inbound, base.scan_inbound);
        assert_eq!(resolved.policy, base.policy);
        assert_eq!(resolved.redact_pii, base.redact_pii);
        assert!(resolved.custom_patterns.is_empty());
        // The default lock set is already sorted, so the resolver's sorted
        // union reproduces the node base byte-for-byte.
        assert_eq!(resolved.locked_fields, base.locked_fields);
    }

    #[test]
    fn custom_evaluators_round_trip_through_gateway_config_and_merge() {
        use crate::evaluators::{
            Capabilities, Evaluator, EvaluatorCategory, EvaluatorImpl, EvaluatorRegistry,
            EvaluatorTarget, OfflineConfig,
        };

        // A default (no custom evaluators) config must NOT emit the key, so an
        // existing gateway.toml stays byte-identical (skip_serializing_if =
        // Vec::is_empty) — back-compat: no field == today.
        let empty = toml::to_string(&GatewayConfig::default()).expect("serialize default");
        assert!(
            !empty.contains("custom_evaluators"),
            "empty custom-evaluator set is omitted from gateway.toml"
        );

        // Author one custom offline Regex evaluator with a NEW id + one that
        // OVERRIDES a builtin, then round-trip through TOML (the on-disk format).
        let mk = |id: &str| Evaluator {
            id: id.to_string(),
            name: format!("Custom {id}"),
            description: "round-trip".to_string(),
            category: EvaluatorCategory::Custom,
            target: EvaluatorTarget::Output,
            capabilities: Capabilities {
                inline: false,
                offline: true,
            },
            impl_: EvaluatorImpl::Regex {
                patterns: vec!["forbidden".to_string()],
            },
            inline: None,
            offline: Some(OfflineConfig {
                threshold: 0.5,
                judge_model: None,
            }),
            builtin: false,
            enforced: false,
            higher_is_better: true,
        };
        let mut config = GatewayConfig::default();
        config.custom_evaluators = vec![mk("my_custom_eval"), mk("toxicity")];

        // This is the exact serializer save() uses; it exercises the TOML
        // ValueAfterTable hazard for the Evaluator struct (scalars after tables).
        let toml_str = toml::to_string_pretty(&config).expect("serialize custom evaluators");
        let reloaded: GatewayConfig = toml::from_str(&toml_str).expect("deserialize (load path)");
        assert_eq!(
            reloaded.custom_evaluators.len(),
            2,
            "custom evaluators survive the config round-trip"
        );
        assert_eq!(reloaded.custom_evaluators[0].id, "my_custom_eval");

        // The merged registry from the reloaded config exposes the new id AND the
        // override (in-place, builtin forced false).
        let reg = EvaluatorRegistry::from_config(&reloaded);
        let new = reg.get("my_custom_eval").expect("new custom id present");
        assert!(!new.builtin);
        assert!(new.capabilities.offline);
        let ovr = reg.get("toxicity").expect("builtin override present");
        assert!(!ovr.builtin, "override reports as custom (builtin=false)");
        assert_eq!(ovr.category.as_str(), "custom");
    }

    #[test]
    fn overlays_round_trip_through_gateway_config_and_reseed_resolver() {
        // FIX 4: overlays authored into GatewayConfig serialize + deserialize and
        // are reseeded into the resolver when AppState is built from the reloaded
        // config, so a standalone overlay survives a gateway restart.
        let mut config = GatewayConfig::default();
        let mut org = HashMap::new();
        org.insert(
            "o1".to_string(),
            FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                ..Default::default()
            },
        );
        config.firewall_org_overlays = org;

        // A default (no-overlay) config must NOT emit the keys, so an existing
        // gateway.toml stays byte-identical (skip_serializing_if = HashMap::is_empty).
        let empty = toml::to_string(&GatewayConfig::default()).expect("serialize default");
        assert!(
            !empty.contains("firewall_org_overlays"),
            "empty overlay stores are omitted from gateway.toml"
        );

        // Round-trip through TOML (the on-disk format save()/load() use).
        let toml_str = toml::to_string(&config).expect("serialize");
        let reloaded: GatewayConfig = toml::from_str(&toml_str).expect("deserialize");
        assert_eq!(
            reloaded.firewall_org_overlays["o1"].policy,
            Some(FirewallPolicy::Block),
            "org overlay survives the config round-trip"
        );

        // Build state from the reloaded config; the resolver reseeds at startup.
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = EvalsRunner::new(EvalsConfig::default());
        let state = AppState::new_for_test(reloaded, audit, evals);
        assert_eq!(
            state.resolver.org_overlays()["o1"].policy,
            Some(FirewallPolicy::Block),
            "resolver reseeded from persisted config"
        );
        // And it drives resolution for a request carrying that org.
        let ctx = ctx_for(Some("o1"), None);
        assert_eq!(
            state.resolved_scanner(&ctx).config().policy,
            FirewallPolicy::Block,
        );
    }

    #[test]
    fn redact_providers_masks_keys_and_reports_counts() {
        use super::redact_providers;
        use crate::config::{
            AnthropicProviderConfig, CoreProviderConfig, GenAiProviderConfig, OpenAiProviderConfig,
            ProvidersConfig,
        };

        let cfg = ProvidersConfig {
            openai: Some(OpenAiProviderConfig {
                api_key: "sk-secret".to_string(),
                api_keys: vec!["sk-a".to_string(), "sk-b".to_string()],
                base_url: "https://api.openai.com/v1".to_string(),
            }),
            anthropic: Some(AnthropicProviderConfig {
                api_key: "sk-anthropic".to_string(),
                api_keys: vec![],
                base_url: "https://api.anthropic.com".to_string(),
            }),
            core: Some(CoreProviderConfig {
                base_url: "http://127.0.0.1:7979".to_string(),
                token: Some("core-token".to_string()),
            }),
            genai: Some(GenAiProviderConfig {
                keys: HashMap::from([("gemini".to_string(), "sk-gem".to_string())]),
            }),
            ..ProvidersConfig::default()
        };

        let view = redact_providers(&cfg);
        let openai = view.openai.unwrap();
        assert_eq!(openai.api_key, "***", "the raw key must never be returned");
        assert_eq!(openai.base_url, "https://api.openai.com/v1");
        // all_keys() = primary + 2 extras, none blank ⇒ 3 accounts.
        assert_eq!(openai.api_key_count, 3);
        assert_eq!(view.anthropic.unwrap().api_key_count, 1);
        // Core exposes only whether a token is present, never the token itself.
        assert!(view.core.unwrap().has_token);
        // GenAi exposes only the key NAMES (providers), not the secret values.
        let genai = view.genai.unwrap();
        assert_eq!(genai.keys, vec!["gemini".to_string()]);
    }

    #[test]
    fn redact_auth_masks_api_keys_but_keeps_metadata() {
        use super::redact_auth;
        use crate::config::{ApiKeyConfig, AuthConfig};

        let auth = AuthConfig {
            require_auth: true,
            master_key: Some("sk-master".to_string()),
            api_keys: vec![ApiKeyConfig {
                key: "sk-client-secret".to_string(),
                name: "client-1".to_string(),
                org_id: Some("org-1".to_string()),
                team_id: Some("team-1".to_string()),
                project_id: None,
                requests_per_minute: None,
                tokens_per_minute: None,
                token_budget_total: None,
                downgrade_to: None,
                trusted_forwarder: true,
            }],
        };
        let view = redact_auth(&auth);
        assert!(view.require_auth);
        assert_eq!(view.api_keys.len(), 1);
        let k = &view.api_keys[0];
        assert_eq!(k.key, "***", "the client key must be masked");
        assert_eq!(k.name, "client-1");
        assert_eq!(k.org_id.as_deref(), Some("org-1"));
        assert!(k.trusted_forwarder);
    }

    #[test]
    fn admin_loopback_allowed_only_on_the_unlocked_local_case() {
        use super::admin_loopback_allowed;
        // The one green case: loopback peer, no auth required, no mesh/fleet, no
        // master key ⇒ the local unauthenticated admin path is allowed.
        assert!(admin_loopback_allowed(true, false, false, false, false));
        // Any single lock closes it.
        assert!(!admin_loopback_allowed(false, false, false, false, false)); // remote peer
        assert!(!admin_loopback_allowed(true, true, false, false, false)); // auth required
        assert!(!admin_loopback_allowed(true, false, true, false, false)); // mesh on
        assert!(!admin_loopback_allowed(true, false, false, true, false)); // fleet on
        assert!(!admin_loopback_allowed(true, false, false, false, true)); // master key set
    }

    #[tokio::test]
    async fn require_local_admin_admits_master_key_and_rejects_remote_anon() {
        use super::require_local_admin;
        use crate::config::{AuthConfig, GatewayConfig};
        use axum::http::HeaderMap;
        use std::net::SocketAddr;
        use std::sync::Arc;

        // A gateway with a master key configured (auth required).
        let config = GatewayConfig {
            auth: AuthConfig {
                require_auth: true,
                master_key: Some("sk-master".to_string()),
                api_keys: vec![],
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));

        let loopback: SocketAddr = "127.0.0.1:5".parse().unwrap();
        let remote: SocketAddr = "203.0.113.7:5".parse().unwrap();
        let no_headers = HeaderMap::new();

        // The master key admits from anywhere.
        assert!(require_local_admin(&state, &remote, true, &no_headers, "Config").is_ok());
        // A non-master, remote, auth-required caller is refused.
        let err = require_local_admin(&state, &remote, false, &no_headers, "Config").unwrap_err();
        assert!(matches!(err, crate::error::GatewayError::Unauthorized(_)));
        // A non-master loopback caller is ALSO refused here, because a master key is
        // configured (the unlocked-local exception requires no master key).
        assert!(require_local_admin(&state, &loopback, false, &no_headers, "Config").is_err());
    }

    #[tokio::test]
    async fn require_local_admin_rejects_cross_origin_browser_requests() {
        use super::require_local_admin;
        use crate::config::GatewayConfig;
        use axum::http::HeaderMap;
        use std::net::SocketAddr;
        use std::sync::Arc;

        // Zero-config desktop posture: no auth, no master key — the loopback
        // exception would otherwise admit an anonymous local caller.
        let config = GatewayConfig::default();
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));
        let loopback: SocketAddr = "127.0.0.1:5".parse().unwrap();

        // No Sec-Fetch-Site (curl, SDK, Core's server-side hop): admitted.
        assert!(require_local_admin(&state, &loopback, false, &HeaderMap::new(), "Config").is_ok());

        // A cross-site browser fetch (the CSRF attack) is refused even on loopback.
        let mut cross = HeaderMap::new();
        cross.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert!(
            require_local_admin(&state, &loopback, false, &cross, "Config").is_err(),
            "cross-site browser origin must be rejected"
        );

        // same-site is likewise not a legitimate admin caller.
        let mut same_site = HeaderMap::new();
        same_site.insert("sec-fetch-site", "same-site".parse().unwrap());
        assert!(require_local_admin(&state, &loopback, false, &same_site, "Config").is_err());

        // A direct navigation (`none`) is not a scripted cross-origin request.
        let mut none = HeaderMap::new();
        none.insert("sec-fetch-site", "none".parse().unwrap());
        assert!(require_local_admin(&state, &loopback, false, &none, "Config").is_ok());
    }

    #[tokio::test]
    async fn require_local_admin_rejects_non_loopback_host_rebinding() {
        use super::require_local_admin;
        use crate::config::GatewayConfig;
        use axum::http::HeaderMap;
        use std::net::SocketAddr;
        use std::sync::Arc;

        // No-auth loopback posture (zero-config desktop): the peer is always
        // 127.0.0.1 in a DNS-rebinding attack, so peer posture alone can't tell the
        // browser from a legit server-side caller — the Host header does.
        let state = Arc::new(AppState::new_for_test_default());
        let loopback: SocketAddr = "127.0.0.1:9999".parse().unwrap();

        // Rebinding shape: browser points evil.com at 127.0.0.1, so the request is
        // same-origin post-rebind but its (unforgeable) Host is the attacker domain.
        let mut rebinding = HeaderMap::new();
        rebinding.insert("host", "evil.com:7981".parse().unwrap());
        rebinding.insert("sec-fetch-site", "same-origin".parse().unwrap());
        assert!(
            matches!(
                require_local_admin(&state, &loopback, false, &rebinding, "Config").unwrap_err(),
                crate::error::GatewayError::Unauthorized(_)
            ),
            "a rebinding browser (non-loopback Host) must be rejected"
        );

        // Legitimate server-side caller (curl / SDK / Core's gateway hop): loopback
        // Host, no Sec-Fetch-Site. This is the load-bearing non-regression.
        let mut legit = HeaderMap::new();
        legit.insert("host", "127.0.0.1:7981".parse().unwrap());
        assert!(
            require_local_admin(&state, &loopback, false, &legit, "Config").is_ok(),
            "a server-side loopback caller must still pass"
        );

        // Even a loopback Host is refused if the browser stamped it same-origin: a
        // Sec-Fetch-Site tell on a privileged mutation is never a legit admin caller.
        let mut loopback_but_browser = HeaderMap::new();
        loopback_but_browser.insert("host", "127.0.0.1:7981".parse().unwrap());
        loopback_but_browser.insert("sec-fetch-site", "same-origin".parse().unwrap());
        assert!(
            require_local_admin(&state, &loopback, false, &loopback_but_browser, "Config").is_err(),
            "a same-origin browser fetch is rejected even on a loopback Host"
        );
    }

    #[tokio::test]
    async fn get_config_returns_a_redacted_view_for_the_master_key() {
        use super::get_config;
        use crate::config::{AuthConfig, GatewayConfig, OpenAiProviderConfig, ProvidersConfig};
        use axum::extract::{ConnectInfo, State};
        use axum::http::HeaderMap;
        use axum::Json;
        use std::net::SocketAddr;
        use std::sync::Arc;

        let config = GatewayConfig {
            auth: AuthConfig {
                require_auth: true,
                master_key: Some("sk-master".to_string()),
                api_keys: vec![],
            },
            providers: ProvidersConfig {
                openai: Some(OpenAiProviderConfig {
                    api_key: "sk-openai-secret".to_string(),
                    api_keys: vec![],
                    base_url: "https://api.openai.com/v1".to_string(),
                }),
                ..ProvidersConfig::default()
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));

        let mut headers = HeaderMap::new();
        headers.insert("authorization", "Bearer sk-master".parse().unwrap());
        let peer = ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap());

        let Json(body) = get_config(State(state), peer, headers)
            .await
            .expect("master key may read config");

        // The provider key is redacted, and no raw secret appears anywhere.
        assert_eq!(body["providers"]["openai"]["api_key"], "***");
        let serialized = serde_json::to_string(&body).unwrap();
        assert!(
            !serialized.contains("sk-openai-secret"),
            "the raw provider key must never leave the gateway"
        );
        assert_eq!(body["auth"]["require_auth"], true);
    }

    #[tokio::test]
    async fn get_config_rejects_a_missing_or_wrong_key() {
        use super::get_config;
        use crate::config::{AuthConfig, GatewayConfig};
        use axum::extract::{ConnectInfo, State};
        use axum::http::HeaderMap;
        use std::net::SocketAddr;
        use std::sync::Arc;

        let config = GatewayConfig {
            auth: AuthConfig {
                require_auth: true,
                master_key: Some("sk-master".to_string()),
                api_keys: vec![],
            },
            ..GatewayConfig::default()
        };
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let state = Arc::new(AppState::new_for_test(
            config,
            audit,
            EvalsRunner::new(EvalsConfig::default()),
        ));

        // A remote peer with no authorization header must not read config.
        let peer = ConnectInfo("203.0.113.7:5".parse::<SocketAddr>().unwrap());
        let res = get_config(State(state), peer, HeaderMap::new()).await;
        assert!(res.is_err(), "unauthenticated remote read must be refused");
    }
}
