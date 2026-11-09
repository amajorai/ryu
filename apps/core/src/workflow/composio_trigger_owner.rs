//! Save-time ownership check for a workflow's Composio triggers.
//!
//! A Composio workflow trigger delivers a connected account's raw provider
//! events (for example incoming mail) into the workflow's `trigger` state, so on
//! a node with an organization access model the member saving the workflow
//! must own every account its triggers listen to, exactly as the agent trigger
//! route requires. The verified saver is then recorded as the subscription's
//! subscriber, and delivery re-checks that user on every event.

use super::{Workflow, WorkflowTrigger};

/// Refusal for a save with no verified member to own the account.
pub(super) const UNVERIFIED_SAVER: &str =
    "a Composio trigger on an organization-bound node must be saved by a signed-in member who owns its connected account";
/// Refusal for an account the saver does not own.
pub(super) const FOREIGN_ACCOUNT: &str =
    "Composio trigger account is not connected to your account";

/// The connected accounts a workflow's Composio triggers listen to.
pub(super) fn composio_trigger_accounts(workflow: &Workflow) -> Vec<&str> {
    workflow
        .triggers
        .iter()
        .filter_map(|trigger| match trigger {
            WorkflowTrigger::Composio {
                connected_account_id,
                ..
            } => connected_account_id
                .as_deref()
                .map(str::trim)
                .filter(|account| !account.is_empty()),
            _ => None,
        })
        .collect()
}

/// Whether this node enforces per-member account isolation.
fn node_is_bound() -> bool {
    crate::sidecar::control_plane::is_managed_node()
        || crate::sidecar::control_plane::registered_org().is_some()
}

/// Refuse a save whose Composio triggers listen to an account `saver` does not
/// own. Only an embedded-mode, organization-bound node subscribes per-user
/// accounts from a workflow save; Connect mode never subscribes from here and
/// an unbound personal node has a single owner.
pub(super) async fn refuse_foreign_composio_accounts(
    workflow: &Workflow,
    saver: Option<&str>,
) -> Result<(), String> {
    let accounts = composio_trigger_accounts(workflow);
    if accounts.is_empty() || ryu_composio::service::is_configured() || !node_is_bound() {
        return Ok(());
    }
    let Some(saver) = saver.map(str::trim).filter(|user| !user.is_empty()) else {
        return Err(UNVERIFIED_SAVER.to_owned());
    };
    let Some(store) = crate::composio_triggers::global() else {
        // No store: reconcile subscribes nothing, so nothing can be delivered.
        return Ok(());
    };
    for account in accounts {
        match store.user_owns_account(saver, account).await {
            Ok(true) => {}
            Ok(false) => return Err(FOREIGN_ACCOUNT.to_owned()),
            Err(error) => {
                return Err(format!(
                    "Composio trigger account could not be verified: {error}"
                ))
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::control_plane::with_test_node_binding;
    use crate::workflow::test_support::workflow;

    fn composio(account: Option<&str>) -> WorkflowTrigger {
        WorkflowTrigger::Composio {
            toolkit: "gmail".to_owned(),
            trigger_slug: "GMAIL_NEW_GMAIL_MESSAGE".to_owned(),
            connected_account_id: account.map(str::to_owned),
        }
    }

    fn with_triggers(triggers: Vec<WorkflowTrigger>) -> Workflow {
        Workflow {
            triggers,
            ..workflow("wf_owner", "owner", Vec::new(), Vec::new())
        }
    }

    #[test]
    fn only_declared_non_blank_accounts_are_checked() {
        let declared = with_triggers(vec![
            WorkflowTrigger::Manual,
            composio(Some(" ca_b ")),
            composio(None),
            composio(Some("  ")),
        ]);
        assert_eq!(composio_trigger_accounts(&declared), vec!["ca_b"]);
    }

    #[tokio::test]
    async fn an_unbound_personal_node_keeps_its_single_owner_saves() {
        let declared = with_triggers(vec![composio(Some("ca_b"))]);
        let allowed = with_test_node_binding(
            false,
            None,
            refuse_foreign_composio_accounts(&declared, None),
        )
        .await;
        assert_eq!(allowed, Ok(()));
    }

    #[tokio::test]
    async fn a_managed_node_refuses_a_save_with_no_verified_saver() {
        let declared = with_triggers(vec![composio(Some("ca_victim"))]);
        let refused = with_test_node_binding(
            true,
            None,
            refuse_foreign_composio_accounts(&declared, None),
        )
        .await;
        assert_eq!(refused, Err(UNVERIFIED_SAVER.to_owned()));
        let blank = with_test_node_binding(
            true,
            None,
            refuse_foreign_composio_accounts(&declared, Some("  ")),
        )
        .await;
        assert_eq!(blank, Err(UNVERIFIED_SAVER.to_owned()));
    }
}
