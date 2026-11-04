//! The single workflow write path: validate, stamp, persist, and reconcile
//! triggers into the external resources that fire them.

use super::*;

pub async fn persist_workflow(workflow: Workflow) -> Result<Workflow, String> {
    persist_workflow_with_revision(workflow, None)
        .await
        .map_err(|error| match error {
            WorkflowPersistError::Invalid(message) => message,
            WorkflowPersistError::RevisionConflict(_) => {
                "workflow revision conflict: it was changed since it was loaded".to_owned()
            }
        })
}

pub enum WorkflowPersistError {
    Invalid(String),
    RevisionConflict(Option<String>),
}

pub async fn persist_workflow_guarded(
    workflow: Workflow,
) -> Result<Workflow, WorkflowPersistError> {
    let expected_revision = workflow.updated_at.clone();
    persist_workflow_with_revision(workflow, expected_revision).await
}

async fn persist_workflow_with_revision(
    mut workflow: Workflow,
    expected_revision: Option<String>,
) -> Result<Workflow, WorkflowPersistError> {
    // Validate the DAG before persisting so callers never store a broken graph.
    WorkflowGraph::build(&workflow).map_err(|e| WorkflowPersistError::Invalid(e.to_string()))?;
    if crate::sidecar::control_plane::registered_org().is_some()
        && has_unscoped_managed_nodes(&workflow)
    {
        return Err(WorkflowPersistError::Invalid(
            "workflow agent and nested-workflow references are disabled on organization-bound nodes until resource ACL propagation is available"
                .to_owned(),
        ));
    }
    ensure_agents_active(&workflow)
        .await
        .map_err(WorkflowPersistError::Invalid)?;

    if workflow.id.is_empty() {
        workflow.id = format!("wf_{}", uuid::Uuid::new_v4().simple());
    }
    let now = chrono::Utc::now().to_rfc3339();
    if workflow.created_at.is_none() {
        workflow.created_at = Some(now.clone());
    }
    workflow.updated_at = Some(now);

    // A client edits the redacted view (`secrets::redact_for_client`): swap any
    // echoed placeholder back for the stored credential of the same node.
    let stored = if workflow.id.is_empty() {
        None
    } else {
        store::load_workflow(&workflow.id).ok()
    };
    secrets::restore_redacted(&mut workflow, stored.as_ref())
        .map_err(WorkflowPersistError::Invalid)?;
    backfill_webhook_secrets(&mut workflow);

    store::save_workflow_if_revision(&workflow, expected_revision.as_deref()).map_err(|error| {
        match error {
            store::WorkflowCheckpointError::RevisionConflict(revision) => {
                WorkflowPersistError::RevisionConflict(revision)
            }
            store::WorkflowCheckpointError::Store(error) => {
                WorkflowPersistError::Invalid(error.to_string())
            }
        }
    })?;
    reconcile_triggers(&workflow).await;
    Ok(workflow)
}

/// Ensure every `Webhook` trigger carries a signing secret so the endpoint can
/// actually fire. A secret-less webhook trigger is a **dead endpoint** — the
/// inbound dispatcher fail-closes on `NoSecret` (an unauthenticated public
/// trigger is a forgery vector), so a workflow created without one (e.g. via the
/// NL builder or the API) would never run.
///
/// Idempotent and non-clobbering: a user-set secret is left untouched; an empty
/// secret first reuses the previously-stored secret for this workflow (so a
/// re-save from a stale client never rotates it), and only mints a fresh
/// high-entropy secret when none exists yet. The value is surfaced back to the
/// canvas trigger panel (read-only) so the caller can sign with it.
fn backfill_webhook_secrets(workflow: &mut Workflow) {
    let has_empty_webhook = workflow.triggers.iter().any(|t| {
        matches!(t, WorkflowTrigger::Webhook { secret }
            if secret.as_deref().map(str::trim).unwrap_or("").is_empty())
    });
    if !has_empty_webhook {
        return;
    }

    // The secret already stored for this workflow (if any), reused so a re-save
    // that omits the secret preserves it rather than rotating it.
    let prior_secret = if workflow.id.is_empty() {
        None
    } else {
        store::load_workflow(&workflow.id).ok().and_then(|prior| {
            prior.triggers.iter().find_map(|t| match t {
                WorkflowTrigger::Webhook { secret } => secret
                    .as_ref()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty()),
                _ => None,
            })
        })
    };

    for trigger in &mut workflow.triggers {
        if let WorkflowTrigger::Webhook { secret } = trigger {
            let empty = secret.as_deref().map(str::trim).unwrap_or("").is_empty();
            if empty {
                *secret = Some(prior_secret.clone().unwrap_or_else(generate_webhook_secret));
            }
        }
    }
}

/// Mint a fresh high-entropy webhook signing secret (256 bits of UUIDv4 entropy
/// as hex, matching the hex the HMAC verifier keys on). Dependency-light: reuses
/// the `uuid` crate already used to mint workflow ids.
fn generate_webhook_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Reconcile a workflow's declared triggers into the external resources that
/// fire it. Idempotent and best-effort (logs and swallows errors):
///   - Schedule triggers → deterministic `wf-sched-<id>-*` scheduler jobs.
///   - Composio triggers → workflow-target Composio subscriptions.
/// Manual / Webhook declare no external resource here.
pub async fn reconcile_triggers(workflow: &Workflow) {
    // Schedules are local + fast, so reconcile inline.
    triggers::apply_schedule_reconcile(&workflow.id, &workflow.name, &workflow.triggers);

    // A webhook trigger is only reachable on a laptop once Core has registered
    // with the managed relay (which mints the token `relay_inbound_url` composes).
    // Ensure that registration + subscription is live so a trigger created after
    // boot resolves its public URL without a Core restart. Spawned so the network
    // register (up to ~20s) never blocks the save; idempotent server- and
    // client-side, and a no-op for the non-relay tunnel backends.
    let has_webhook = workflow
        .triggers
        .iter()
        .any(|t| matches!(t, WorkflowTrigger::Webhook { .. }));
    if has_webhook {
        tokio::spawn(crate::webhook_ingress::ensure_relay_started_after_save());
    }

    // Connect target bindings are managed separately from workflow definitions.
    // Saving a workflow must neither remove those bindings nor mutate provider
    // subscriptions through Core's legacy Composio client.
    if ryu_composio::service::is_configured() {
        return;
    }

    // Composio reconcile makes a network call per subscription; keep it
    // best-effort and inline so a save reflects the declared set, but never let
    // it surface an error to the caller.
    let Some(store) = crate::composio_triggers::global() else {
        return;
    };
    let has_composio = workflow
        .triggers
        .iter()
        .any(|trigger| matches!(trigger, WorkflowTrigger::Composio { .. }));
    if has_composio {
        if let Err(error) = crate::webhook_ingress::reconcile_composio_subscription(store).await {
            tracing::warn!(
                workflow = %workflow.id,
                error = %error,
                "composio project webhook subscription reconcile failed"
            );
            return;
        }
    }
    // Replace the workflow's existing composio subs with the declared set
    // (simplest convergent strategy: drop all, re-create the current ones).
    if let Err(e) = store.delete_embedded_for_workflow(&workflow.id).await {
        tracing::warn!(workflow = %workflow.id, error = %e, "clearing prior composio workflow subs");
    }
    for trigger in &workflow.triggers {
        if let WorkflowTrigger::Composio {
            toolkit,
            trigger_slug,
            connected_account_id,
        } = trigger
        {
            let Some(account) = connected_account_id.as_deref() else {
                tracing::warn!(
                    workflow = %workflow.id,
                    slug = %trigger_slug,
                    "composio workflow trigger missing connected_account_id; skipping subscribe"
                );
                continue;
            };
            if let Err(e) = store
                .subscribe_workflow(
                    &workflow.id,
                    toolkit,
                    trigger_slug,
                    account,
                    serde_json::json!({}),
                )
                .await
            {
                tracing::warn!(workflow = %workflow.id, slug = %trigger_slug, error = %e, "composio workflow subscribe failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::test_support::workflow;

    fn webhook_workflow(secret: Option<&str>) -> Workflow {
        Workflow {
            id: String::new(), // empty id → backfill skips the prior-secret disk lookup
            name: "wh".into(),
            description: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            triggers: vec![WorkflowTrigger::Webhook {
                secret: secret.map(str::to_owned),
            }],
            max_concurrency: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn first_webhook_secret(wf: &Workflow) -> Option<String> {
        wf.triggers.iter().find_map(|t| match t {
            WorkflowTrigger::Webhook { secret } => secret.clone(),
            _ => None,
        })
    }

    #[test]
    fn backfill_generates_secret_when_absent() {
        let mut wf = webhook_workflow(None);
        backfill_webhook_secrets(&mut wf);
        let secret = first_webhook_secret(&wf).expect("a secret was generated");
        assert!(!secret.trim().is_empty(), "generated secret is non-empty");
        assert!(secret.len() >= 32, "generated secret has real entropy");
    }

    #[test]
    fn backfill_generates_secret_when_blank() {
        let mut wf = webhook_workflow(Some("   "));
        backfill_webhook_secrets(&mut wf);
        let secret = first_webhook_secret(&wf).expect("a secret was generated");
        assert!(!secret.trim().is_empty());
    }

    #[test]
    fn backfill_preserves_user_secret() {
        let mut wf = webhook_workflow(Some("user-set-secret"));
        backfill_webhook_secrets(&mut wf);
        assert_eq!(
            first_webhook_secret(&wf).as_deref(),
            Some("user-set-secret"),
            "a user-set secret is never clobbered"
        );
    }

    #[test]
    fn backfill_is_noop_without_webhook_trigger() {
        let mut wf = Workflow {
            triggers: vec![WorkflowTrigger::Manual],
            ..workflow(String::new(), "n", Vec::new(), Vec::new())
        };
        backfill_webhook_secrets(&mut wf);
        assert!(matches!(wf.triggers[0], WorkflowTrigger::Manual));
    }

    #[tokio::test]
    async fn org_bound_node_refuses_a_while_body_workflow_reference() {
        use crate::sidecar::control_plane::{
            with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
        };
        let org_node = RegisteredNode {
            org: RegisteredOrg {
                id: "org1".to_owned(),
                name: "Org".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        };
        let looping = workflow(
            String::new(),
            "loop",
            vec![crate::workflow::test_support::node(
                "loop",
                NodeKind::While {
                    expr: "input == go".into(),
                    body_workflow_id: Some("wf_b".into()),
                    max_iterations: Some(1),
                },
            )],
            Vec::new(),
        );
        let refused =
            with_test_node_binding(true, Some(org_node), persist_workflow_guarded(looping)).await;
        assert!(matches!(
            refused,
            Err(WorkflowPersistError::Invalid(message)) if message.contains("nested-workflow")
        ));
    }
}
