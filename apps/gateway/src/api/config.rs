use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    config::{
        ApiKeyConfig, AuthConfig, BudgetConfig, FirewallConfig, GatewayConfig, ProviderKind,
        ProvidersConfig, RoutingConfig, SmartRoutingConfig,
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

/// Public view of RoutingConfig (no secrets; ProviderKind serializes as lowercase string).
#[derive(Serialize)]
struct RoutingView {
    default_provider: ProviderKind,
    model_map: std::collections::HashMap<String, ModelMappingView>,
    fallback_chain: Vec<ProviderKind>,
    /// Classifier-driven routing (custom routing instructions). Carries no
    /// secrets, so it is returned verbatim for the UI to read + edit.
    smart_routing: SmartRoutingConfig,
}

#[derive(Serialize)]
struct ModelMappingView {
    provider: ProviderKind,
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
        }),
        anthropic: p.anthropic.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
        }),
        local: p.local.as_ref().map(|c| LocalView {
            base_url: c.base_url.clone(),
        }),
        openrouter: p.openrouter.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
        }),
        core: p.core.as_ref().map(|c| CoreView {
            base_url: c.base_url.clone(),
            has_token: c.token.is_some(),
        }),
        modal: p.modal.as_ref().map(|c| ProviderView {
            api_key: "***".to_string(),
            base_url: c.base_url.clone(),
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
/// mesh-neutralization (#478, B-9) is unit-testable. The only no-master-key path
/// is a loopback peer in no-auth mode — and that loopback trust is neutralized
/// when the mesh is on, because under userspace networking inbound tailnet peers
/// appear as `127.0.0.1` and would otherwise fail the gate OPEN to the tailnet.
fn admin_loopback_allowed(peer_is_loopback: bool, require_auth: bool, mesh_on: bool) -> bool {
    !require_auth && peer_is_loopback && !mesh_on
}

fn require_local_admin(
    state: &SharedState,
    peer: &SocketAddr,
    is_master_key: bool,
    action: &str,
) -> Result<(), GatewayError> {
    if is_master_key {
        return Ok(());
    }
    let require_auth = state.with_auth(|a| a.require_auth);
    if !admin_loopback_allowed(
        peer.ip().is_loopback(),
        require_auth,
        crate::tools::mesh_enabled(),
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
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key))?;
    require_local_admin(&state, &peer, ctx.is_master_key, "Config access")?;

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
        smart_routing: routing.smart_routing.clone(),
    };

    let view = ConfigView {
        firewall: firewall_cfg,
        budgets: budget_cfg,
        providers: redact_providers(&state.config.providers),
        auth: redact_auth(&auth_cfg),
        routing: routing_view,
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
/// `firewall` and `budgets` are hot-swapped live. `routing` is persisted and
/// takes effect on the next gateway restart (the router is not live-swappable).
/// `auth.api_keys` is hot-swapped live. Provider credentials and master_key
/// require an environment-variable change.
#[derive(Deserialize)]
pub struct ConfigPatch {
    pub firewall: Option<FirewallConfig>,
    pub budgets: Option<BudgetConfig>,
    /// When present, replaces the list of per-client API keys. The master key
    /// and `require_auth` flag are unchanged; they are environment-variable-only.
    pub auth: Option<AuthConfigPatch>,
    pub routing: Option<RoutingConfig>,
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
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key))?;
    // Same local-trust rule as GET: writable from loopback in no-auth mode,
    // master-key-gated otherwise (remote peers always need the master key).
    require_local_admin(&state, &peer, ctx.is_master_key, "Config updates")?;

    if patch.firewall.is_none()
        && patch.budgets.is_none()
        && patch.auth.is_none()
        && patch.routing.is_none()
    {
        return Err(GatewayError::BadRequest(
            "Patch body must include at least one of: firewall, budgets, auth, routing".to_string(),
        ));
    }

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

    // Persist first: if the write fails, we leave live config unchanged.
    updated_config
        .save()
        .map_err(|e| GatewayError::Internal(anyhow::anyhow!("Failed to persist config: {e}")))?;

    // Now apply live hot-swappable changes (firewall, budgets, auth).
    // Routing is not live-swappable (the ModelRouter holds a snapshot of
    // RoutingConfig at startup); it takes effect on the next gateway restart.
    if let Some(fw) = patch.firewall {
        state.update_firewall_config(fw);
    }
    if let Some(budgets) = patch.budgets {
        state.update_budget_config(budgets);
    }
    if let Some(auth_patch) = patch.auth {
        state.update_auth_config(auth_patch.api_keys);
    }

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::admin_loopback_allowed;

    #[test]
    fn loopback_no_auth_no_mesh_is_allowed() {
        // The classic local-dev case: loopback peer, no base auth, mesh off.
        assert!(admin_loopback_allowed(true, false, false));
    }

    #[test]
    fn mesh_neutralizes_loopback_trust() {
        // #478 B-9: under mesh a tailnet peer appears as 127.0.0.1, so loopback
        // trust must be neutralized — admin requires the master key.
        assert!(!admin_loopback_allowed(true, false, true));
    }

    #[test]
    fn remote_peer_never_loopback_allowed() {
        assert!(!admin_loopback_allowed(false, false, false));
        assert!(!admin_loopback_allowed(false, false, true));
    }

    #[test]
    fn require_auth_forces_master_key() {
        assert!(!admin_loopback_allowed(true, true, false));
    }
}
