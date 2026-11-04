//! Exact-agent `agent.run` authority for scheduled agent routines.
//!
//! A routine runs its target agent with that agent's tools, accounts and
//! identity bindings, and persists the turns in a chat its owner reads. On an
//! organization-bound node that is an agent run on the owner's behalf, so it
//! needs the same exact-agent `agent.run` decision a chat turn applies. The
//! routine tool checks it when a member creates, changes or runs a routine,
//! and the scheduler checks it again at every firing against the owner's
//! current membership, so revoking a member's access stops their routines.

use crate::identity_verify::{permissions, VerifiedCaller};
use crate::sidecar::control_plane::{self, ResolvedPermissions};

/// The refusal a routine reports when its owner may not run its agent.
fn denied(agent_id: &str) -> String {
    format!("insufficient permissions: agent.run on agent '{agent_id}'")
}

#[cfg(test)]
tokio::task_local! {
    /// The current principal a test resolves for a routine owner, instead of
    /// asking the control plane.
    static TEST_OWNER: (VerifiedCaller, ResolvedPermissions);
}

/// Run `fut` with `owner` as the control plane's current answer for any
/// routine owner it resolves.
#[cfg(test)]
pub(crate) async fn with_test_owner<F: std::future::Future>(
    owner: VerifiedCaller,
    fut: F,
) -> F::Output {
    TEST_OWNER
        .scope((owner, ResolvedPermissions::default()), fut)
        .await
}

async fn resolve_owner(user_id: &str) -> anyhow::Result<(VerifiedCaller, ResolvedPermissions)> {
    #[cfg(test)]
    if let Ok(owner) = TEST_OWNER.try_with(Clone::clone) {
        return Ok(owner);
    }
    control_plane::resolve_current_principal(user_id).await
}

/// Require that the routine owner `owner_user_id` may run `agent_id` now.
///
/// A routine with no owner was created with node authority (the node token),
/// and an unbound personal node has no organization ACL to consult; both keep
/// their existing behavior. Otherwise the owner's current membership and
/// permissions are resolved fresh, and a lookup failure refuses the run.
pub(crate) async fn require_owner_may_run_agent(
    owner_user_id: Option<&str>,
    agent_id: &str,
) -> Result<(), String> {
    let Some(owner) = owner_user_id else {
        return Ok(());
    };
    if !control_plane::is_managed_node() && control_plane::registered_org().is_none() {
        return Ok(());
    }
    let (caller, resolved) = resolve_owner(owner)
        .await
        .map_err(|_| "current authorization for the routine's owner is unavailable".to_owned())?;
    if caller.user_id != owner {
        return Err(denied(agent_id));
    }
    crate::server::enforce_permission_on_resolved(
        &Some(caller),
        permissions::AGENT_RUN,
        crate::acl::KIND_AGENT,
        agent_id,
        resolved,
    )
    .map_err(|_| denied(agent_id))
}

/// [`require_owner_may_run_agent`] for every agent a routine call would run.
pub(crate) async fn require_owner_may_run_agents(
    owner_user_id: Option<&str>,
    agent_ids: &[String],
) -> Result<(), String> {
    for agent_id in agent_ids {
        require_owner_may_run_agent(owner_user_id, agent_id).await?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_run_access_tests.rs"]
mod tests;
