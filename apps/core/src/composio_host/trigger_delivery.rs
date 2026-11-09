//! Delivery-time checks for a legacy (embedded) Composio agent trigger: the
//! agent's account policy, and whether the user who subscribed may still run
//! the agent. Both run on every event, so a binding made before access was
//! narrowed or revoked stops firing.

use crate::sidecar::control_plane;

/// The delivery-time account check. A user account (`account_entity` empty)
/// needs the agent's policy to allow it; an agent without a record keeps
/// today's behaviour. An own-entity account must be exactly this agent's
/// entity, and its record must exist and allow that account's events.
pub(super) fn agent_may_receive_from(
    record: Option<&crate::agents::AgentRecord>,
    agent_id: &str,
    connected_account_id: &str,
    account_entity: &str,
) -> bool {
    use crate::agent_access::AgentAccountPolicy;
    if account_entity.is_empty() {
        return record.is_none_or(|record| {
            AgentAccountPolicy::from_record(record).allows_composio_account(connected_account_id)
        });
    }
    AgentAccountPolicy::is_own_composio_entity(account_entity, agent_id)
        && record.is_some_and(|record| {
            AgentAccountPolicy::from_record(record)
                .allows_own_composio_trigger(connected_account_id)
        })
}

/// Whether the trigger's subscriber may run `agent_id` now, with the same
/// exact-agent `agent.run` decision a scheduled routine re-checks at every
/// firing. On an organization-bound node every subscription is made by a
/// verified member, so a row with no recorded subscriber (one from before
/// subscribers were stored) is refused rather than run with no principal. An
/// unbound personal node has no organization ACL and keeps every row.
pub(super) async fn subscriber_may_run_agent(subscriber_user_id: &str, agent_id: &str) -> bool {
    let bound = control_plane::is_managed_node() || control_plane::registered_org().is_some();
    if subscriber_user_id.is_empty() {
        return !bound;
    }
    crate::scheduler::agent_run_access::require_owner_may_run_agent(
        Some(subscriber_user_id),
        agent_id,
    )
    .await
    .is_ok()
}

/// Whether the user who subscribed a legacy workflow trigger may still receive
/// `connected_account_id`'s events into `workflow_id`. The same fresh
/// `workflow.run` decision a scheduled workflow re-checks at every firing, and
/// on an organization-bound node a fresh check that the subscriber still owns
/// the account. A row with no recorded subscriber (saved before subscribers
/// were stored, or by an unverified save) is refused on a bound node and kept
/// on an unbound personal node, which has no organization ACL.
pub(super) async fn subscriber_may_run_workflow(
    subscriber_user_id: &str,
    workflow_id: &str,
    connected_account_id: &str,
) -> bool {
    let bound = control_plane::is_managed_node() || control_plane::registered_org().is_some();
    if subscriber_user_id.is_empty() {
        return !bound;
    }
    if crate::scheduler::workflow_run_access::require_owner_may_run_workflow(
        Some(subscriber_user_id),
        workflow_id,
    )
    .await
    .is_err()
    {
        return false;
    }
    if !bound {
        return true;
    }
    let Some(store) = crate::composio_triggers::global() else {
        return false;
    };
    store
        .user_owns_account(subscriber_user_id, connected_account_id)
        .await
        .unwrap_or(false)
}
