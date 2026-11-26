//! The fan-out: depth and concurrency caps, checkpoint replay, progress events.
// test-exempt: moved verbatim out of workflow/delegation.rs by the module split; covered by delegation/tests.rs.

use super::*;

/// Run a fan-out of sibling delegates concurrently, honouring the depth and
/// concurrency caps. Same-depth delegates execute at the same time (bounded by
/// `caps.effective_concurrency()`), each in a clean context. Progress events are
/// sent on `progress` as delegates start and finish.
///
/// `depth` is the depth of the delegates being launched (a top-level parent
/// delegating is `depth == 1`). Returns one [`DelegateResult`] per spec, in the
/// input order, regardless of completion order.
///
/// When `checkpoint_key` is `Some`, each completed delegate result is checkpointed
/// to disk and already-completed delegates are skipped on re-entry, making the
/// fan-out resumable after a Core restart.
pub async fn run_fanout(
    delegates: Vec<DelegateSpec>,
    caps: DelegationCaps,
    depth: usize,
    progress: Option<tokio::sync::mpsc::UnboundedSender<DelegateProgress>>,
) -> Result<Vec<DelegateResult>, DelegationError> {
    run_fanout_with_policy(
        delegates,
        caps,
        depth,
        progress,
        None,
        DelegationExecutionPolicy::Normal,
        format!("delegation-{}", uuid::Uuid::new_v4().simple()),
    )
    .await
}

/// Run a catalog review through the clean Gateway completion path, even when
/// the delegate names a registered agent. A registered agent owns its own tool
/// loop, so it cannot be used for a read-only catalog review without making the
/// preset prompt-only. The clean path exposes no executable tools.
pub async fn run_read_only_fanout(
    delegates: Vec<DelegateSpec>,
    caps: DelegationCaps,
    depth: usize,
    progress: Option<tokio::sync::mpsc::UnboundedSender<DelegateProgress>>,
) -> Result<Vec<DelegateResult>, DelegationError> {
    run_fanout_with_policy(
        delegates,
        caps,
        depth,
        progress,
        None,
        DelegationExecutionPolicy::ReadOnly,
        format!("delegation-{}", uuid::Uuid::new_v4().simple()),
    )
    .await
}

/// Like [`run_fanout`] but accepts an optional [`FanoutCheckpointKey`] that
/// enables per-delegate durable checkpointing.
pub async fn run_fanout_with_checkpoint(
    delegates: Vec<DelegateSpec>,
    caps: DelegationCaps,
    depth: usize,
    progress: Option<tokio::sync::mpsc::UnboundedSender<DelegateProgress>>,
    checkpoint_key: Option<Arc<FanoutCheckpointKey>>,
) -> Result<Vec<DelegateResult>, DelegationError> {
    let lifecycle_run_id = checkpoint_key
        .as_ref()
        .map(|key| key.run_id.clone())
        .unwrap_or_else(|| format!("delegation-{}", uuid::Uuid::new_v4().simple()));
    run_fanout_with_policy(
        delegates,
        caps,
        depth,
        progress,
        checkpoint_key,
        DelegationExecutionPolicy::Normal,
        lifecycle_run_id,
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DelegationExecutionPolicy {
    Normal,
    ReadOnly,
}

async fn run_fanout_with_policy(
    delegates: Vec<DelegateSpec>,
    caps: DelegationCaps,
    depth: usize,
    progress: Option<tokio::sync::mpsc::UnboundedSender<DelegateProgress>>,
    checkpoint_key: Option<Arc<FanoutCheckpointKey>>,
    execution_policy: DelegationExecutionPolicy,
    run_id: String,
) -> Result<Vec<DelegateResult>, DelegationError> {
    if delegates.is_empty() {
        return Err(DelegationError::Empty);
    }
    if depth > MAX_DELEGATION_DEPTH {
        return Err(DelegationError::DepthExceeded { depth });
    }

    let mut caps = caps;
    caps.max_tokens = caps.effective_max_tokens();
    let semaphore = Arc::new(Semaphore::new(caps.effective_concurrency()));
    let caps = Arc::new(caps);
    let mut handles: Vec<(String, tokio::task::JoinHandle<DelegateResult>)> =
        Vec::with_capacity(delegates.len());

    // Reserve every delegate that will run before spawning any of them, so the
    // run's lifecycle count reaches zero only when the last one finishes, not
    // whenever the delegates holding permits drain ahead of the queued ones.
    let slots: Vec<(DelegateSpec, FanoutSlot)> = delegates
        .into_iter()
        .map(|spec| {
            // Check for an existing checkpoint — skip the model call if found.
            let saved = checkpoint_key
                .as_deref()
                .and_then(|key| load_delegate_checkpoint(key, &spec.id));
            let slot = match saved {
                Some(saved) => FanoutSlot::Checkpointed(saved),
                None => FanoutSlot::Queued(DelegationRunReservation::reserve(
                    &run_id,
                    lifecycle_agent_id(&spec),
                )),
            };
            (spec, slot)
        })
        .collect();

    // `delegate.*` runs under the caller's sub-agent Box scope (a task-local),
    // which `tokio::spawn` below does not inherit. Carry it into each delegate so
    // its machine verbs run on its own child Box.
    let box_scope = crate::sidecar::mcp::box_desktop::current_subagent_scope();
    for (spec, slot) in slots {
        let reservation = match slot {
            FanoutSlot::Checkpointed(saved) => {
                // Emit the progress events so callers see the delegate as
                // started-and-finished even on resume.
                if let Some(tx) = &progress {
                    let _ = tx.send(DelegateProgress::Started {
                        id: saved.id.clone(),
                        preset: saved.preset,
                    });
                    let _ = tx.send(DelegateProgress::Finished {
                        result: saved.clone(),
                    });
                }
                // Push a handle that resolves immediately with the saved result.
                let id = saved.id.clone();
                let handle = tokio::spawn(async move { saved });
                handles.push((id, handle));
                continue;
            }
            FanoutSlot::Queued(reservation) => reservation,
        };

        let semaphore = Arc::clone(&semaphore);
        let caps = Arc::clone(&caps);
        let progress = progress.clone();
        let checkpoint_key = checkpoint_key.clone();
        let box_scope = box_scope.clone();

        let id = spec.id.clone();
        let delegate = async move {
            // The permit gates how many delegates run at once; acquiring it is
            // the moment a delegate "starts".
            let _permit = semaphore
                .acquire_owned()
                .await
                .expect("delegation semaphore closed");

            if let Some(tx) = &progress {
                let _ = tx.send(DelegateProgress::Started {
                    id: spec.id.clone(),
                    preset: spec.preset,
                });
            }

            let mut lifecycle_lease = reservation.admit();

            let result = crate::sidecar::mcp::box_desktop::with_subagent_scope(
                box_scope,
                run_one(&spec, &caps, execution_policy),
            )
            .await;
            lifecycle_lease.finish();

            // SubagentStop hooks (Claude parity): fire detached when a delegated
            // sub-agent finishes, observation-only. Fires for every delegation
            // path (workflow steps, teams, host.runAgent) since all funnel here.
            fire_subagent_stop_hooks(&spec, &result);

            // Persist the result before emitting the Finished event so a
            // restart between the save and the event still recovers correctly.
            // Only successes are durable: a failed delegate (a rate or usage
            // limit, a wall-time cap, a crashed agent) runs again when the
            // fan-out is resumed instead of replaying its failure forever.
            if let Some(ref key) = checkpoint_key {
                if result.error.is_none() {
                    save_delegate_checkpoint(key, &result);
                }
            }

            if let Some(tx) = &progress {
                let _ = tx.send(DelegateProgress::Finished {
                    result: result.clone(),
                });
            }
            result
        };
        // Each delegate is a sub-turn of the caller's turn: keep its attribution.
        let attribution = crate::profile_activity::current_attribution();
        let handle = tokio::spawn(crate::profile_activity::with_attribution(
            attribution,
            delegate,
        ));
        handles.push((id, handle));
    }

    let mut results = Vec::with_capacity(handles.len());
    for (_, handle) in handles {
        match handle.await {
            Ok(r) => results.push(r),
            Err(join_err) => results.push(DelegateResult::failed(
                "unknown".to_string(),
                PermissionPreset::default(),
                format!("delegate task panicked: {join_err}"),
            )),
        }
    }
    Ok(results)
}

/// A fan-out delegate either replays its checkpointed result or is queued to
/// run, holding its place in the run's lifecycle count until it finishes.
enum FanoutSlot {
    Checkpointed(DelegateResult),
    Queued(DelegationRunReservation),
}

/// The agent id a delegate reports on lifecycle transitions.
fn lifecycle_agent_id(spec: &DelegateSpec) -> &str {
    spec.agent_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .unwrap_or(&spec.id)
}

/// Fire `subagent_stop` hooks (Claude's SubagentStop) DETACHED when a delegate
/// finishes. Observation-only; never blocks the delegation. `ctx.output` carries
/// the sub-agent's final text, `ctx.event` its id/agent/error. Directives ignored.
/// The global dispatcher's own DB-free fast path skips instantly when no
/// `subagent_stop` plugin is loaded.
fn fire_subagent_stop_hooks(spec: &DelegateSpec, result: &DelegateResult) {
    let ctx = crate::plugin_host::HookContext {
        conversation_id: result.child_conversation_id.clone(),
        agent_id: spec.agent_id.clone(),
        output: result.output.clone(),
        event: Some(serde_json::json!({
            "id": result.id,
            "agent_id": spec.agent_id,
            "error": result.error,
            "ok": result.error.is_none(),
        })),
        ..Default::default()
    };
    let attribution = crate::profile_activity::current_attribution();
    tokio::spawn(crate::profile_activity::with_attribution(
        attribution,
        async move {
            let _ = crate::plugin_host::dispatch_global(crate::plugin_host::ON_SUBAGENT_STOP, ctx)
                .await;
        },
    ));
}
