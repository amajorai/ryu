//! Exact-agent authorization for the assistant-first opening.
//!
//! `POST /api/proactive/opening` names the agent to run, and the opening turn is
//! persisted into a conversation the caller owns and can read back. The generic
//! `agent.run` collection permission is therefore not enough: the named agent's
//! own resource ACL and the fleet availability policy must admit the caller
//! before an idempotency claim is taken or any provider work starts, exactly as
//! the primary chat route does.

use crate::server::*;

/// Refuse an opening for an agent this caller may not run. The `auto` sentinel
/// is resolved inside the routing adapter, where the post-routing exact-agent
/// check (fed by the threaded `AgentResourceAuthorization`) covers its concrete
/// target, so it is not checked here.
pub(in crate::server) async fn enforce_opening_agent_runnable(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    agent_id: &str,
) -> Result<(), axum::response::Response> {
    authorize_opening_agent(
        agent_id,
        crate::fleet::is_agent_available,
        enforce_agent_resource_permission(
            state,
            caller,
            crate::identity_verify::permissions::AGENT_RUN,
            agent_id,
        ),
    )
    .await
}

/// The decision behind [`enforce_opening_agent_runnable`], with the fleet policy
/// and the exact-agent ACL injected so tests can prove the refusal without the
/// full Core server state. `exact_acl` is a lazy future: it is only awaited for
/// a concrete agent the fleet policy admits.
pub(in crate::server) async fn authorize_opening_agent(
    agent_id: &str,
    available: impl FnOnce(&str) -> bool,
    exact_acl: impl std::future::Future<Output = Result<(), axum::response::Response>>,
) -> Result<(), axum::response::Response> {
    if agent_id == crate::agent_routing::AUTO_AGENT_ID {
        return Ok(());
    }
    if !available(agent_id) {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            format!("agent '{agent_id}' is unavailable under organization policy"),
        ));
    }
    exact_acl.await
}

/// The authorization the routing adapter re-checks after handoffs and lane
/// defaults settle the effective agent. Only a verified caller has an identity
/// to check; an anonymous local caller is the node itself.
pub(in crate::server) fn opening_agent_authorization(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Option<Arc<crate::sidecar::adapters::AgentResourceAuthorization>> {
    caller.as_ref()?;
    Some(Arc::new(
        crate::sidecar::adapters::AgentResourceAuthorization {
            state: state.clone(),
            caller: caller.clone(),
        },
    ))
}
