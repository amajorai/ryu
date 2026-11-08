//! Exact-workflow `workflow.run` authority for scheduled workflow routines.
//!
//! A workflow routine runs its workflow with node authority: webhooks,
//! channel sends, notifications, code and model spend all fire on the owner's
//! schedule with the input the owner chose. The routine routes require
//! `workflow.run` when a member creates, changes or runs one; the scheduler
//! re-reads it at every firing against the owner's current membership, so
//! revoking a member's `workflow.run` (or the membership) stops their routines,
//! exactly as [`super::agent_run_access`] does for agent routines.

use super::agent_run_access::require_owner_permission;
use crate::identity_verify::permissions;

/// Require that the routine owner `owner_user_id` may run `workflow_id` now.
///
/// A routine with no owner (node authority) and an unbound personal node keep
/// their existing behavior; otherwise a lookup failure refuses the run.
pub(crate) async fn require_owner_may_run_workflow(
    owner_user_id: Option<&str>,
    workflow_id: &str,
) -> Result<(), String> {
    require_owner_permission(
        owner_user_id,
        permissions::WORKFLOW_RUN,
        crate::acl::KIND_WORKFLOW,
        workflow_id,
    )
    .await
    .map_err(|refusal| {
        refusal.message(|| {
            format!("insufficient permissions: workflow.run on workflow '{workflow_id}'")
        })
    })
}

#[cfg(test)]
#[path = "workflow_run_access_tests.rs"]
mod tests;
