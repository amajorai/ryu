//! Managed provider routing for Core-hosted apps.
//!
//! Apps may request a provider operation, but they never receive a provider key.
//! Core authenticates the sidecar, binds the request to the registered node
//! organization, applies the calling agent's account access when the app names
//! one, and forwards it to Gateway. Gateway owns provider-vault lookup, upstream
//! execution, and wallet accounting.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use ryu_app_events::{ManagedProviderCall, ProviderRouterError};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::agent_access::AgentAccountPolicy;
use crate::provider_pins::{
    normalized_tool_id, pin_for_call, CatalogBrandLookup, ProviderPin, ProviderPins,
};
use crate::sidecar::{deferred_authorization, ext_proxy::authenticate_sidecar, gateway};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderStatusBody {
    pub provider: String,
    /// When set, the answer also honors the user's provider pin for this
    /// tool's brand: Treg reads unavailable for a brand pinned to Composio.
    #[serde(default)]
    pub tool_id: Option<String>,
}

fn invalid(message: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": message.into() })),
    )
        .into_response()
}

/// Gateway refusals an app can act on, passed through with Gateway's own
/// status and typed JSON body: `402` (`insufficient_credits` with the balance,
/// estimate and `top_up_url`, or `max_cost_exceeded`), `403` (`tool_unpriced`)
/// and `503` (`credit_accounting_unavailable`, retryable). Collapsing them into
/// a `502` would hide a credit refusal behind what reads as an upstream outage.
const PASS_THROUGH_STATUSES: [u16; 3] = [402, 403, 503];

fn failed(error: ProviderRouterError) -> Response {
    if let ProviderRouterError::Rejected { status, body } = &error {
        if PASS_THROUGH_STATUSES.contains(status) {
            if let (Ok(code), Ok(body)) = (
                StatusCode::from_u16(*status),
                serde_json::from_str::<serde_json::Value>(body),
            ) {
                if body.is_object() {
                    return (code, Json(body)).into_response();
                }
            }
        }
    }
    let status = match &error {
        ProviderRouterError::Rejected { status, .. } if *status == 401 || *status == 403 => {
            StatusCode::FORBIDDEN
        }
        ProviderRouterError::Rejected { status, .. } if PASS_THROUGH_STATUSES.contains(status) => {
            StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY)
        }
        ProviderRouterError::NotHosted => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_GATEWAY,
    };
    (status, Json(json!({ "error": error.to_string() }))).into_response()
}

/// `POST /api/host/capability/providers.status`.
pub(crate) async fn host_provider_status(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ProviderStatusBody>,
) -> Response {
    if body.provider.trim().is_empty() {
        return invalid("provider is required");
    }
    if let Err((status, message)) = authenticate_sidecar(&state, &headers).await {
        return (status, Json(json!({ "error": message }))).into_response();
    }

    if let Some(raw) = body.tool_id.as_deref().filter(|id| !id.trim().is_empty()) {
        let Some(tool_id) = normalized_tool_id(raw) else {
            return invalid("toolId is not a valid tool id");
        };
        let pins = load_pins(&state).await;
        let pin = pin_for_call(&pins, &tool_id, None, &CatalogBrandLookup).await;
        if pin == Some(ProviderPin::Composio) && body.provider.trim() == "treg" {
            return Json(json!({ "configured": false, "pinnedProvider": "composio" }))
                .into_response();
        }
    }

    match gateway::managed_provider_status(&state.client, &body.provider).await {
        Ok(configured) => Json(json!({ "configured": configured })).into_response(),
        Err(error) => failed(error),
    }
}

fn agent_access_refused(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "error": message.into(), "reason": "agent_account_access" })),
    )
        .into_response()
}

/// Apply the calling agent's account access to an app's provider call.
///
/// An app that does work for an agent hands back the grant Core stamped on the
/// forwarded request ([`deferred_authorization::AGENT_GRANT_HEADER`]), also
/// for work it runs later (a scheduled post). The grant only names the agent:
/// its current record decides, so a changed setting applies to calls already
/// queued. A grant for another app, a forged or stale one (the node token
/// rotated), an agent without a record and a store error all refuse.
///
/// A call with no grant is not on an agent's behalf and is unchanged, except
/// while Core is forwarding an agent's request to the same app: then the app
/// must hand the grant back, and a call without it is refused (see
/// [`deferred_authorization::has_active_agent_request`]).
pub(crate) async fn authorize_agent_provider_call(
    state: &ServerState,
    plugin_id: &str,
    headers: &axum::http::HeaderMap,
    body: &ManagedProviderCall,
) -> Result<(), Response> {
    if is_ungranted_capability_lookup(headers, body) {
        return Ok(());
    }
    authorize_agent_provider(
        state,
        plugin_id,
        headers,
        &body.provider,
        body.account_id.as_deref(),
    )
    .await
}

/// A Composio `capabilities` lookup that names no account and carries no grant.
///
/// It only reads a toolkit's public tool metadata: it uses no account of the
/// user's and is not billed, and with no account named a limited agent could
/// never be allowed it. An app may therefore make it while it serves an agent's
/// request (an agent's capability matrix would otherwise come back empty).
fn is_ungranted_capability_lookup(
    headers: &axum::http::HeaderMap,
    body: &ManagedProviderCall,
) -> bool {
    !headers.contains_key(deferred_authorization::AGENT_GRANT_HEADER)
        && body.provider == "composio"
        && body.operation.as_deref() == Some("capabilities")
        && body.account_id.is_none()
}

/// The refusal for a grant-less provider call made while the app serves an
/// agent's request.
const MISSING_AGENT_GRANT: &str = "this app is doing work for an agent, so its provider calls must forward the agent grant Core sent with the request";

pub(crate) async fn authorize_agent_provider(
    state: &ServerState,
    plugin_id: &str,
    headers: &axum::http::HeaderMap,
    provider: &str,
    account_id: Option<&str>,
) -> Result<(), Response> {
    let mut presented = headers
        .get_all(deferred_authorization::AGENT_GRANT_HEADER)
        .iter();
    let Some(grant) = presented.next() else {
        if deferred_authorization::has_active_agent_request(plugin_id) {
            return Err(agent_access_refused(
                StatusCode::FORBIDDEN,
                MISSING_AGENT_GRANT,
            ));
        }
        return Ok(());
    };
    let grant = grant
        .to_str()
        .ok()
        .filter(|_| presented.next().is_none())
        .ok_or_else(|| agent_access_refused(StatusCode::FORBIDDEN, "invalid agent grant"))?;
    let (agent_id, verified) =
        match deferred_authorization::verify_agent_grant(grant.trim(), plugin_id) {
            Ok(agent_id) => (agent_id, true),
            // A grant stored before the node token rotated (or the node joined an
            // organization) no longer verifies. Its unverified agent id is used
            // only to let the call through when that agent is now unrestricted,
            // which a call with no grant already is; anything else stays refused.
            Err(error) => {
                match deferred_authorization::unverified_agent_grant_hint(grant.trim(), plugin_id) {
                    Some(agent_id) => (agent_id, false),
                    None => return Err(agent_access_refused(StatusCode::FORBIDDEN, error)),
                }
            }
        };
    let record = match state.agent_store.get(&agent_id).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return Err(agent_access_refused(
                StatusCode::FORBIDDEN,
                "the agent this work was started for no longer exists",
            ))
        }
        Err(error) => {
            tracing::warn!("agent account policy lookup failed: {error:#}");
            return Err(agent_access_refused(
                StatusCode::FORBIDDEN,
                "the agent's account access could not be checked",
            ));
        }
    };
    let policy = AgentAccountPolicy::from_record(&record);
    if !verified {
        return if policy.is_unrestricted() {
            Ok(())
        } else {
            Err(agent_access_refused(
                StatusCode::FORBIDDEN,
                "the agent that started this work has limited account access, and its authorization is from before this device's credentials changed; ask the agent to start it again",
            ))
        };
    }
    policy
        .authorize_managed_provider_call(provider, account_id)
        .map_err(|reason| agent_access_refused(StatusCode::FORBIDDEN, reason))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProviderAuthorizeBody {
    pub provider: String,
    #[serde(default)]
    pub account_id: Option<String>,
}

/// `POST /api/host/capability/providers.authorize`.
///
/// For an app that reaches a provider with credentials it holds itself (a
/// direct adapter) rather than through `providers.call`: before using them for
/// an agent, it asks Core whether that agent's account access allows the
/// provider, with the same rules `providers.call` applies. The agent grant is
/// required; a request without one is not for an agent and has nothing to ask.
pub(crate) async fn host_provider_authorize(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ProviderAuthorizeBody>,
) -> Response {
    let provider = body.provider.trim();
    if provider.is_empty() || provider.len() > 64 {
        return invalid("provider is empty or too long");
    }
    if body
        .account_id
        .as_deref()
        .is_some_and(|account| account.len() > 256)
    {
        return invalid("accountId is too long");
    }
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((plugin_id, _)) => plugin_id,
        Err((status, message)) => {
            return (status, Json(json!({ "error": message }))).into_response();
        }
    };
    if !headers.contains_key(deferred_authorization::AGENT_GRANT_HEADER) {
        return invalid("an agent grant is required");
    }
    match authorize_agent_provider(
        &state,
        &plugin_id,
        &headers,
        provider,
        body.account_id.as_deref(),
    )
    .await
    {
        Ok(()) => Json(json!({ "allowed": true })).into_response(),
        Err(response) => response,
    }
}

/// `POST /api/host/capability/providers.call`.
pub(crate) async fn host_provider_call(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Json(mut body): Json<ManagedProviderCall>,
) -> Response {
    if let Err(error) = body.validate() {
        return failed(error);
    }
    // The pin is decided on, and the call forwarded with, the id exactly as
    // Gateway will read it, so padding cannot dodge the brand lookup.
    match normalized_tool_id(&body.tool_id) {
        Some(tool_id) => body.tool_id = tool_id,
        None => return invalid("tool_id is not a valid tool id"),
    }
    // The authenticated app id, never one the app supplies: Gateway scopes the
    // provider-side idempotency key by it, so two apps in one org never replay
    // each other's results.
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((plugin_id, _)) => plugin_id,
        Err((status, message)) => {
            return (status, Json(json!({ "error": message }))).into_response();
        }
    };
    if let Err(response) = authorize_agent_provider_call(&state, &plugin_id, &headers, &body).await
    {
        return response;
    }

    // The user's provider pin for this call's brand, decided here and never
    // taken from the app: a Composio pin keeps the call off Treg.
    let pins = load_pins(&state).await;
    let provider_pin = pin_for_call(
        &pins,
        &body.tool_id,
        body.operation.as_deref(),
        &CatalogBrandLookup,
    )
    .await;
    if let Some(refusal) = refuse_pinned(&body, provider_pin) {
        return refusal;
    }

    let org_id = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let facts = gateway::CoreCallFacts {
        org_id: org_id.as_deref(),
        caller_id: &plugin_id,
        provider_pin,
        require_servable: false,
        ..gateway::CoreCallFacts::default()
    };
    match gateway::call_managed_provider_with(&state.client, &facts, body).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => failed(error),
    }
}

async fn load_pins(state: &ServerState) -> anyhow::Result<ProviderPins> {
    ProviderPins::from_read(
        state
            .preferences
            .get(crate::catalog_source::INTEGRATION_PROVIDER_PINS_PREF)
            .await,
    )
}

/// An app that names Treg for a call whose brand the user pinned to Composio
/// is refused here, with the `policy_violation` body Gateway would send, so an
/// app can fall through to its Composio path. Gateway enforces the same pin.
fn refuse_pinned(call: &ManagedProviderCall, pin: Option<ProviderPin>) -> Option<Response> {
    (pin == Some(ProviderPin::Composio) && call.provider.trim() == "treg").then(|| {
        (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": {
                    "type": "policy_violation",
                    "code": "policy_violation",
                    "message": "this service is set to use Composio in the Integrations Store",
                    "pinnedProvider": "composio",
                }
            })),
        )
            .into_response()
    })
}

#[cfg(test)]
mod tests;
