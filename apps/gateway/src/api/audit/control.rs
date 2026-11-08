use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    audit::AuditLogger,
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

/// Body accepted by `POST /v1/audit/control`. The gateway derives the actor
/// from the authenticated admin context; Core may additionally submit a
/// bounded, already-verified actor identity so the local row can name the user
/// who initiated the control-plane call. Raw config payloads are never accepted.
#[derive(Debug, Deserialize)]
pub struct ControlAuditBody {
    pub action: String,
    pub target: String,
    #[serde(default)]
    pub summary: Option<String>,
    /// Optional verified Core user identity for a local proxy call. Direct
    /// gateway-admin callers omit this and are recorded as gateway admins.
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub actor_name: Option<String>,
    /// Stable agent id for an agent-scoped control change.
    #[serde(default)]
    pub agent_id: Option<String>,
}

fn bounded_control_value(value: String, max_len: usize) -> Result<String, GatewayError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(GatewayError::BadRequest(
            "control audit action and target are required".to_string(),
        ));
    }
    if value.chars().count() > max_len {
        return Err(GatewayError::BadRequest(
            "control audit fields are too long".to_string(),
        ));
    }
    Ok(value)
}

fn bounded_control_summary(value: Option<String>) -> Result<Option<String>, GatewayError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > 400 {
        return Err(GatewayError::BadRequest(
            "control audit summary is too long".to_string(),
        ));
    }
    Ok(Some(value))
}

fn bounded_control_actor(value: Option<String>) -> Result<Option<String>, GatewayError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > 240 {
        return Err(GatewayError::BadRequest(
            "control audit actor fields are too long".to_string(),
        ));
    }
    Ok(Some(value))
}

/// Record a successful gateway-local control mutation after the caller's
/// authenticated admin boundary has been enforced.
pub async fn record_control_change(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ControlAuditBody>,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    crate::api::config::require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        &headers,
        "Control audit writes",
    )?;

    let action = bounded_control_value(body.action, 120)?;
    let target = bounded_control_value(body.target, 120)?;
    let summary = bounded_control_summary(body.summary)?;
    let actor_id = bounded_control_actor(body.actor_id)?;
    let actor_name = bounded_control_actor(body.actor_name)?;
    let agent_id = bounded_control_actor(body.agent_id)?;
    if state.audit.is_enabled() {
        let actor = if ctx.is_master_key {
            actor_name.as_deref().unwrap_or("master-key")
        } else {
            actor_name.as_deref().unwrap_or("loopback-admin")
        };
        state.log_audit(AuditLogger::make_control_record_with_agent(
            Uuid::new_v4().to_string(),
            ctx.api_key,
            actor.to_string(),
            actor_id,
            agent_id,
            action,
            target,
            summary,
        ));
    }

    Ok(Json(json!({ "ok": true })))
}
