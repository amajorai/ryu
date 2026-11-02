//! Running an approved action, and failing a rejected workflow gate.

use super::*;

impl ApprovalEngine {
    /// Execute an approved action. Each arm proxies the existing engine the
    /// corresponding source already uses, so an approved run is identical to the
    /// autonomous run it replaced. Returns `Some(result)` for a tool call (the
    /// tool's output, recorded onto the row for the inbox), `None` otherwise.
    pub(super) async fn execute_action(
        &self,
        action: &PendingAction,
    ) -> anyhow::Result<Option<String>> {
        match action {
            PendingAction::ScheduledJob { target, job_id } => {
                if let Some(job_id) = job_id {
                    let job = crate::scheduler::store::load_job(job_id).map_err(|_| {
                        anyhow::anyhow!("scheduled routine '{job_id}' no longer exists")
                    })?;
                    if &job.target != target {
                        return Err(anyhow::anyhow!(
                            "scheduled routine '{job_id}' target changed since approval; request a new approval"
                        ));
                    }
                    // An approved app job waits for the same budget slot a scheduled
                    // run needs, so it never overlaps one of the same job.
                    let _budget_slot = crate::scheduler::admit_manual_run_waiting(
                        &job.id,
                        &job.target,
                        crate::scheduler::APPROVED_RUN_SLOT_WAIT,
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!(error))?;
                    // Never overlap a scheduled firing or a manual run of this job
                    // (any target, not only the budgeted app-backed ones).
                    let _in_flight =
                        crate::scheduler::claim_in_flight(&job.id).ok_or_else(|| {
                            anyhow::anyhow!("scheduled routine '{job_id}' is already running")
                        })?;
                    let claim = crate::scheduler::store::capture_execution(&job)
                        .await
                        .map_err(|error| {
                            anyhow::anyhow!("scheduled routine changed before execution: {error}")
                        })?;
                    let started_at = chrono::Utc::now().to_rfc3339();
                    let result = crate::scheduler::run_target_for_job(&job).await;
                    let finished_at = chrono::Utc::now().to_rfc3339();
                    let (outcome, run_id, error) = match result {
                        Ok(run_id) => (crate::scheduler::store::ExecOutcome::Success, run_id, None),
                        Err(error) => (
                            crate::scheduler::store::ExecOutcome::Failure,
                            None,
                            Some(error),
                        ),
                    };
                    crate::scheduler::store::append_execution_claim(
                        claim,
                        crate::scheduler::store::ExecRecord {
                            started_at,
                            finished_at,
                            outcome,
                            run_id,
                            error: error.clone(),
                        },
                    )
                    .await
                    .map_err(|save_error| {
                        anyhow::anyhow!("saving scheduled routine history: {save_error}")
                    })?;
                    if let Some(error) = error {
                        return Err(anyhow::anyhow!(error));
                    }
                } else {
                    // Backward compatibility for approvals persisted before the
                    // source job id was added. Budgeted under the job that now holds
                    // this target, when one does.
                    let budgeted = matches!(
                        target,
                        crate::scheduler::store::JobTarget::AppJob { .. }
                            | crate::scheduler::store::JobTarget::Quest { .. }
                    );
                    let budget_id = budgeted
                        .then(|| {
                            crate::scheduler::store::list_jobs()
                                .into_iter()
                                .find(|job| &job.target == target)
                        })
                        .flatten()
                        .map_or_else(
                            || format!("approval:{}", uuid::Uuid::new_v4().simple()),
                            |job| job.id,
                        );
                    let _budget_slot = crate::scheduler::admit_manual_run_waiting(
                        &budget_id,
                        target,
                        crate::scheduler::APPROVED_RUN_SLOT_WAIT,
                    )
                    .await
                    .map_err(|error| anyhow::anyhow!(error))?;
                    crate::scheduler::run_target(target)
                        .await
                        .map_err(|e| anyhow::anyhow!(e))?;
                }
                Ok(None)
            }
            PendingAction::WorkflowResume { run_id } => {
                crate::workflow::resume_run(run_id, r#"{"approved":true}"#.to_owned())
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?;
                Ok(None)
            }
            PendingAction::TriggerWorkflow {
                workflow_id,
                payload_json,
            } => {
                crate::composio_host::run_workflow_for_trigger(workflow_id, payload_json).await?;
                Ok(None)
            }
            PendingAction::TriggerAgent { agent_id, prompt } => {
                let run_id = format!("approvalrun_{}", uuid::Uuid::new_v4().simple());
                if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                    runner
                        .run(Some(agent_id.clone()), run_id, prompt.clone())
                        .await?;
                }
                Ok(None)
            }
            PendingAction::HealRerun { agent_id, prompt } => {
                // The `healrun_` prefix is the never-heal-a-heal marker: the heal
                // engine drops any failed event on a conversation with this prefix,
                // so a heal-run that itself fails cannot trigger another heal. This
                // is the DEFAULT heal path (`healing.auto-decide` is off — propose,
                // the user disposes), so the prefix comes from the shared contract
                // and not a literal: the engine reading it back lives in a separate
                // binary, where a drift is an infinite heal loop, not a parse error.
                let run_id = format!(
                    "{}{}",
                    ryu_healing_contracts::HEAL_PREFIX,
                    uuid::Uuid::new_v4().simple()
                );
                if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                    runner.run(agent_id.clone(), run_id, prompt.clone()).await?;
                }
                Ok(None)
            }
            PendingAction::AppSendTurn { .. } => {
                execute_app_send_turn(action).await?;
                Ok(None)
            }
            PendingAction::HealWorkflowRerun { run_id } => {
                crate::workflow::rerun_run(run_id)
                    .await
                    .map_err(|e| anyhow::anyhow!("re-running failed workflow {run_id}: {e}"))?;
                Ok(None)
            }
            PendingAction::ActivateSkill { slug, skill_md } => {
                let skills = self.skills.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("no skills registry attached; cannot activate approved skill")
                })?;
                // Deferred write happens now (on approve) so a rejected suggestion
                // never landed on disk. Then flip active + hot-reload the registry.
                ryu_learning::write_synthesized_skill(slug, skill_md)
                    .await
                    .map_err(|e| anyhow::anyhow!("writing approved skill `{slug}`: {e}"))?;
                ryu_skills::set_active(slug, true);
                skills.reload();
                Ok(Some(format!("Added the skill \"{slug}\" to your library.")))
            }
            PendingAction::ToolCall {
                tool_id,
                arguments,
                agent_id,
                allowlist,
                user_id,
                profile_ids,
                session_id,
                host_conversation_id,
                composio_connection_scope,
                conversation_scope,
                configure_approved,
            } => {
                let registry = self.registry.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("no MCP registry attached; cannot run approved tool call")
                })?;
                // Re-dispatch through the NO-GATE entry so the approved call runs
                // exactly once and does not re-raise an approval (infinite loop).
                let result = registry
                    .call_tool_with_identity_after_approval_scoped(
                        agent_id.as_deref(),
                        tool_id,
                        arguments.clone(),
                        allowlist.as_deref(),
                        user_id.as_deref(),
                        profile_ids,
                        session_id.clone(),
                        host_conversation_id.as_deref(),
                        composio_connection_scope.as_deref(),
                        conversation_scope.as_deref(),
                        *configure_approved,
                    )
                    .await?;
                // The no-gate path can still return an identity `__ryu_elicitation__`
                // envelope (a bound domain is NEEDS_AUTH). That is NOT a successful
                // run — the tool did not execute and no plane will consume the
                // envelope here — so surface it as an error on the row rather than a
                // false "result", telling the user the connection needs a login.
                if result.get("__ryu_elicitation__").is_some() {
                    return Err(anyhow::anyhow!(
                        "the approved tool `{tool_id}` needs an account connection that isn't logged in; connect it, then re-issue the request"
                    ));
                }
                Ok(Some(serde_json::to_string(&result).unwrap_or_default()))
            }
        }
    }
}

/// React to a rejected/expired action. Most kinds simply don't run; a workflow
/// gate, however, must fail its suspended run so it doesn't hang forever.
pub(super) async fn reject_action(action: &PendingAction) {
    if let PendingAction::WorkflowResume { run_id } = action {
        if let Err(e) = crate::workflow::fail_run(run_id, "approval rejected by user").await {
            tracing::warn!("approvals: failed to fail rejected workflow run {run_id}: {e}");
        }
    }
}
