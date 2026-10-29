//! `POST /api/agents/launch-check`: whether Core would start an agent's engine
//! under a given identity mode and account access, before the agent is saved
//! or its first turn runs.
//!
//! The answer comes from the launch path's own checks
//! ([`crate::sidecar::adapters::agent_launch_check`]), so the reason a client
//! shows is the text the agent's first turn would fail with. The route only
//! reads: it saves nothing and starts nothing, so it stays a CoreApi tool.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::Deserialize;

use super::ServerState;
use crate::agent_access::AgentAccountPolicy;
use crate::agents::AgentIdentityMode;
use crate::identity_verify::VerifiedCaller;
use crate::sidecar::adapters::AgentLaunchCheck;

/// The route, merged into the agents router.
pub fn routes() -> Router<ServerState> {
    Router::new().route("/api/agents/launch-check", post(agent_launch_check))
}

/// Body for `POST /api/agents/launch-check`.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct AgentLaunchCheckBody {
    /// The engine the agent would run on, as saved on its record.
    pub engine: String,
    /// `managed`, `individual` or `mixed`. Missing reads as `managed`.
    #[serde(default)]
    pub identity_mode: Option<String>,
    /// The account allowlist. Missing or `null` is no limit.
    #[serde(default)]
    pub account_access: Option<Vec<String>>,
    /// The saved agent's id, when it has one. Its routing switches apply.
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// Parse the body's identity mode: missing or empty is `managed`, the default
/// of every record. An unknown value is a client error.
fn identity_mode(value: Option<&str>) -> Result<AgentIdentityMode, String> {
    match value.map(str::trim) {
        None | Some("") => Ok(AgentIdentityMode::Managed),
        Some(mode) => mode
            .parse()
            .map_err(|error: anyhow::Error| error.to_string()),
    }
}

/// `POST /api/agents/launch-check`.
#[utoipa::path(
    post,
    path = "/api/agents/launch-check",
    tag = "Agents",
    summary = "Check whether an agent's engine would start under its account access",
    request_body = AgentLaunchCheckBody,
    responses(
        (status = 200, description = "OK", body = AgentLaunchCheck),
        (status = 400, description = "Missing engine or unknown identity mode", body = serde_json::Value),
        (status = 403, description = "Agent view permission required", body = serde_json::Value)
    )
)]
pub async fn agent_launch_check(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<AgentLaunchCheckBody>,
) -> Response {
    let engine = body.engine.trim();
    if engine.is_empty() {
        return super::json_error(StatusCode::BAD_REQUEST, "engine is required".to_owned());
    }
    let mode = match identity_mode(body.identity_mode.as_deref()) {
        Ok(mode) => mode,
        Err(error) => return super::json_error(StatusCode::BAD_REQUEST, error),
    };
    let agent_id = body
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if let Some(agent_id) = agent_id {
        if let Err(response) = super::enforce_agent_resource_permission(
            &state,
            &caller,
            crate::identity_verify::permissions::AGENT_VIEW,
            agent_id,
        )
        .await
        {
            return response;
        }
    }
    let policy = AgentAccountPolicy::from_parts(mode, body.account_access.as_deref());
    let check = crate::sidecar::adapters::agent_launch_check(
        agent_id,
        engine,
        &policy,
        &state.agents,
        crate::agent_sandbox::untrusted_support(),
    );
    let local_model_present =
        if check.limited_model_source == Some(crate::pi_config::LimitedModelSource::Local) {
            crate::sidecar::providers::llamacpp::active_chat_model_present(
                &crate::registry::ModelRegistry::from_env(),
            )
            .await
        } else {
            true
        };
    Json(check.with_model_warning(local_model_present)).into_response()
}

#[cfg(test)]
mod tests {
    use super::identity_mode;
    use crate::agents::AgentIdentityMode;

    #[test]
    fn identity_mode_defaults_to_managed_and_refuses_unknown_values() {
        assert_eq!(identity_mode(None), Ok(AgentIdentityMode::Managed));
        assert_eq!(identity_mode(Some(" ")), Ok(AgentIdentityMode::Managed));
        assert_eq!(
            identity_mode(Some("individual")),
            Ok(AgentIdentityMode::Individual)
        );
        assert_eq!(identity_mode(Some("mixed")), Ok(AgentIdentityMode::Mixed));
        assert!(identity_mode(Some("everyone")).is_err());
    }

    #[test]
    fn the_route_is_documented_and_stays_a_read_only_core_api_tool() {
        let spec = serde_json::to_value(super::super::openapi::api_doc()).unwrap();
        assert!(
            spec["paths"]["/api/agents/launch-check"]["post"].is_object(),
            "the launch check is not in the spec"
        );
        assert!(!crate::self_api::is_denied(
            "/api/agents/launch-check",
            "post"
        ));
    }
}
