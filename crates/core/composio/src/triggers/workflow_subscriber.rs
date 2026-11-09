//! Who subscribed a legacy (embedded) **workflow** trigger, and the
//! delivery-time check that they may still receive its events.
//!
//! A workflow trigger delivers a connected account's raw provider events into
//! the workflow's state, so the subscriber must own that account when the
//! workflow is saved, and must still be allowed to run the workflow (and still
//! own the account) when each event arrives. The host makes that decision; a
//! row with no recorded subscriber is the host's to refuse on nodes that have
//! an organization access model.

use anyhow::Result;
use serde_json::Value;

use super::{ComposioTriggerStore, TriggerSubscription};

impl ComposioTriggerStore {
    /// Register a workflow-target trigger and record `subscriber_user_id`, the
    /// verified user whose account it listens to. Delivery re-checks that user
    /// through [`crate::ComposioHost::subscriber_may_run_workflow`].
    pub async fn subscribe_workflow_as(
        &self,
        subscriber_user_id: &str,
        workflow_id: &str,
        toolkit: &str,
        trigger_slug: &str,
        connected_account_id: &str,
        config: Value,
    ) -> Result<TriggerSubscription> {
        self.subscribe_target(
            "workflow",
            subscriber_user_id,
            "",
            Some(workflow_id),
            "",
            toolkit,
            trigger_slug,
            connected_account_id,
            config,
        )
        .await
    }

    /// Whether `connected_account_id` is one of `user_id`'s own connected
    /// accounts, listed through this store's Composio client.
    pub async fn user_owns_account(
        &self,
        user_id: &str,
        connected_account_id: &str,
    ) -> Result<bool> {
        if user_id.trim().is_empty() || connected_account_id.trim().is_empty() {
            return Ok(false);
        }
        Ok(
            crate::connect::owned_connection(&self.http, connected_account_id, Some(user_id))
                .await?
                .is_some(),
        )
    }
}

/// Whether a matched workflow row may fire now. Any host error is a refusal,
/// so a failed check never delivers an event.
pub(super) async fn workflow_delivery_allowed(
    sub: &TriggerSubscription,
    workflow_id: &str,
) -> bool {
    let decision = match crate::host::host() {
        Ok(host) => {
            host.subscriber_may_run_workflow(
                &sub.subscriber_user_id,
                workflow_id,
                &sub.connected_account_id,
            )
            .await
        }
        Err(error) => Err(error),
    };
    match decision {
        Ok(true) => true,
        Ok(false) => {
            tracing::info!(
                workflow = %workflow_id,
                trigger = %sub.trigger_slug,
                "composio trigger skipped: the subscriber may no longer run the workflow or no longer owns the account"
            );
            false
        }
        Err(error) => {
            tracing::warn!(workflow = %workflow_id, error = %error, "composio workflow trigger access check failed");
            false
        }
    }
}
