//! Workflow authority that read and scheduling routes must apply in addition to
//! their own route permission.
//!
//! A webhook trigger's signing secret authenticates the public
//! `/api/workflows/:id/webhook` route, so whoever reads it can start the
//! workflow with a payload of their choosing. [`workflow_view_for_caller`]
//! therefore reveals it only to callers who could manage it anyway
//! (`workflow.edit` on that workflow, the gate `GET /api/webhooks/:id/secret`
//! applies); a `workflow.view`-only reader gets the masked placeholder.
//!
//! A scheduled routine that targets a workflow runs it with node authority, so
//! [`authorize_scheduled_workflow_target`] requires `workflow.run` on that
//! workflow, exactly as `POST /workflows/:id/run` does, before a routine can be
//! pointed at it or run on demand.

use super::{enforce_permission_on, ServerState};
use crate::identity_verify::{permissions, VerifiedCaller};
use crate::scheduler::store::JobTarget;
use crate::workflow::{secrets, Workflow};

/// The single-workflow view for `caller`, who already holds `workflow.view` on
/// `workflow_id`: the trigger signing secret stays readable only with
/// `workflow.edit` on the same workflow.
pub(super) async fn workflow_view_for_caller(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    workflow_id: &str,
    workflow: Workflow,
) -> Workflow {
    let may_manage_secret = enforce_permission_on(
        state,
        caller,
        permissions::WORKFLOW_EDIT,
        crate::acl::KIND_WORKFLOW,
        workflow_id,
    )
    .await
    .is_ok();
    if may_manage_secret {
        secrets::redact_for_client(workflow)
    } else {
        secrets::redact_for_listing(workflow)
    }
}

/// Refuse a routine whose target is a workflow the caller may not run.
///
/// `current` is the job's persisted target on an update (`None` on a create or
/// a run-now). Keeping an existing workflow target while disabling the routine
/// is allowed, so a caller who lost `workflow.run` can still switch it off.
pub(super) async fn authorize_scheduled_workflow_target(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    target: &JobTarget,
    enabled: bool,
    current: Option<&JobTarget>,
) -> Result<(), String> {
    let JobTarget::Workflow { workflow_id, .. } = target else {
        return Ok(());
    };
    if !enabled && current == Some(target) {
        return Ok(());
    }
    enforce_permission_on(
        state,
        caller,
        permissions::WORKFLOW_RUN,
        crate::acl::KIND_WORKFLOW,
        workflow_id,
    )
    .await
    .map_err(|_| format!("insufficient permissions: workflow.run on workflow '{workflow_id}'"))
}

#[cfg(test)]
#[path = "workflow_access_test.rs"]
mod tests;
