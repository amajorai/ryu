//! Exact-agent authority the scheduled-routine routes apply to agent targets.
//!
//! A routine that targets an agent runs that agent for its owner, so
//! [`authorize_scheduled_agent_target`] requires `agent.run` on that agent,
//! exactly as a chat turn with it does, before a routine can be pointed at it
//! or run on demand. The scheduler re-checks the owner at every firing
//! (`crate::scheduler::agent_run_access`).

use super::{enforce_permission_on, ServerState};
use crate::identity_verify::{permissions, VerifiedCaller};
use crate::scheduler::store::JobTarget;

/// Refuse a routine whose target is an agent the caller may not run.
///
/// `current` is the job's persisted target on an update (`None` on a create or
/// a run-now). Keeping an existing agent target while disabling the routine is
/// allowed, so a caller who lost `agent.run` can still switch it off.
pub(super) async fn authorize_scheduled_agent_target(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    target: &JobTarget,
    enabled: bool,
    current: Option<&JobTarget>,
) -> Result<(), String> {
    let JobTarget::Agent { agent_id, .. } = target else {
        return Ok(());
    };
    if !enabled && current == Some(target) {
        return Ok(());
    }
    enforce_permission_on(
        state,
        caller,
        permissions::AGENT_RUN,
        crate::acl::KIND_AGENT,
        agent_id,
    )
    .await
    .map_err(|_| format!("insufficient permissions: agent.run on agent '{agent_id}'"))
}

#[cfg(test)]
#[path = "scheduled_agent_access_test.rs"]
mod tests;
