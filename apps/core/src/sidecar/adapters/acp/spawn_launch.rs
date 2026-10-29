//! Launch phases of [`spawn_acp_task`]: the unpooled one-turn instance, live
//! instance reuse, superseded-instance retirement, and the pooled spawn.

use super::spawn_prepare::PoolKeyParts;
use super::*;

type AcpPool = std::collections::HashMap<String, AcpPoolEntry>;

/// What the instance subprocess is launched with.
pub(super) struct AcpLaunch {
    pub(super) spawn_cmd: String,
    pub(super) cwd: PathBuf,
    pub(super) additional_directories: Vec<PathBuf>,
    pub(super) environment: Vec<(String, String)>,
    pub(super) account_confinement: crate::agent_access::AccountConfinement,
}

/// The credentials a new instance's grants are issued from.
pub(super) struct AcpLaunchGrants<'a> {
    pub(super) tool_authority: Option<&'a crate::server::acp_tool_broker::AcpToolSessionAuthority>,
    pub(super) inference: Option<&'a RedeemedInference>,
}

/// Spawns an ephemeral, un-pooled instance that serves `acp_turn` and exits.
pub(super) fn spawn_unpooled(
    launch: AcpLaunch,
    keys: &PoolKeyParts,
    agent_key: &str,
    security_key: &str,
    fresh_session: bool,
    grants: AcpLaunchGrants<'_>,
    acp_turn: AcpTurn,
) {
    let AcpLaunch {
        spawn_cmd,
        cwd,
        additional_directories,
        environment,
        account_confinement,
    } = launch;
    let mut released_slot = false;
    // A fresh context turn must not leave the old pooled sender eligible for
    // a later request: drop it before spawning the unpooled instance. Revocation
    // is an admission barrier for new callbacks; a callback that already passed
    // the broker may finish, while the in-flight task drains its current turn.
    if fresh_session && !keys.conversation.is_empty() {
        let key = acp_pool_key(
            &keys.conversation,
            agent_key,
            &spawn_cmd,
            &cwd,
            &keys.workspace_key,
            &keys.environment_key,
            security_key,
        );
        if let Ok(mut pool) = acp_pool().lock() {
            // Its slot, once back, is this turn's.
            released_slot = pool.remove(&key).is_some_and(retire_pooled_instance);
        }
    }
    tracing::info!(reason = "unpooled", "ACP spawning an instance");
    let session_grant = grants
        .tool_authority
        .and_then(crate::server::acp_tool_broker::issue_session);
    // This instance serves one turn and exits, which drops the grant.
    let inference_grant = grants
        .inference
        .map(|redeemed| crate::server::acp_inference_proxy::issue(redeemed.scope.clone(), None));
    let (turns_tx, turns_rx) = mpsc::unbounded_channel();
    let _ = turns_tx.send(acp_turn); // drop tx → instance ends after this turn
    let instance = tokio::spawn(async move {
        crate::acp_runtime::refresh_from_gateway(&reqwest::Client::new()).await;
        let _permit = if released_slot {
            crate::acp_runtime::acquire_after_retiring(evict_idle_acp_instance).await
        } else {
            crate::acp_runtime::acquire(evict_idle_acp_instance).await
        };
        if let Err(e) = run_acp_instance(
            spawn_cmd,
            cwd,
            additional_directories,
            environment,
            session_grant,
            inference_grant,
            turns_rx,
            None,
            account_confinement,
        )
        .await
        {
            tracing::error!("ACP instance error: {e:#}");
        }
    });
    super::super::acp_instance_tasks::track(instance.abort_handle());
}

/// Why this turn could not reuse a live instance; also drops dead instances.
pub(super) fn classify_spawn_reason(pool: &mut AcpPool, key: &str) -> AcpSpawnReason {
    // Why this turn could not reuse a live instance, logged if it spawns one.
    let spawn_reason = match pool.get(key) {
        Some(entry) if entry.turns.is_closed() => AcpSpawnReason::Exited,
        Some(_) => AcpSpawnReason::NewConversation,
        None if take_recent_eviction(key) => AcpSpawnReason::Evicted,
        None => AcpSpawnReason::NewConversation,
    };
    // Drop dead instances (idle-TTL expired or crashed) so the map can't grow.
    pool.retain(|_, entry| {
        if entry.turns.is_closed() {
            if let Some(session_id) = entry.capability_session_id {
                crate::server::acp_tool_broker::revoke_session(session_id);
            }
            false
        } else {
            true
        }
    });
    spawn_reason
}

/// Outcome of offering the turn to this chat's live pooled instance.
pub(super) enum LiveReuse {
    /// The live instance accepted the turn; the caller returns its receiver.
    Reused,
    /// The turn (still pending) must go to a newly spawned instance.
    Spawn(Option<AcpTurn>),
}

/// Queues the turn on the live instance when its grants are still current.
pub(super) fn try_reuse_live_instance(
    pool: &mut AcpPool,
    key: &str,
    acp_turn: AcpTurn,
    tool_authority: Option<&crate::server::acp_tool_broker::AcpToolSessionAuthority>,
    spawn_reason: &mut AcpSpawnReason,
) -> LiveReuse {
    let mut pending = Some(acp_turn);
    if let Some(entry) = pool.get_mut(key) {
        let capability_is_current = match (entry.capability_session_id, tool_authority) {
            (Some(session_id), Some(authority)) => {
                crate::server::acp_tool_broker::renew_session(session_id, authority)
            }
            (None, None) => true,
            _ => false,
        };
        let inference_is_current = entry
            .inference_grant_id
            .is_none_or(crate::server::acp_inference_proxy::is_current);
        if capability_is_current && inference_is_current {
            // Busy before the turn is queued: until the instance picks it up,
            // admission must not evict it (and revoke its credentials) as idle.
            entry.activity.mark_busy();
            match entry.turns.send(pending.take().expect("turn present")) {
                Ok(()) => return LiveReuse::Reused, // reused this chat's live instance
                Err(err) => {
                    // Raced with teardown; respawn below.
                    pending = Some(err.0);
                    *spawn_reason = AcpSpawnReason::Exited;
                }
            }
        } else {
            *spawn_reason = if capability_is_current {
                AcpSpawnReason::StaleInferenceGrant
            } else {
                AcpSpawnReason::StaleToolCapability
            };
        }
    }
    LiveReuse::Spawn(pending)
}

/// Retires the key's and the conversation's superseded instances; returns whether a slot came back.
pub(super) fn retire_for_respawn(
    pool: &mut AcpPool,
    conversation: &str,
    agent_key: &str,
    key: &str,
    spawn_reason: &mut AcpSpawnReason,
) -> bool {
    // The old task may still be finishing a turn after its sender is dropped.
    // Revoke the capability now so no later callback from that task is admitted;
    // the callback already authorized by Core is intentionally not cancelled.
    let mut released_slot = pool.remove(key).is_some_and(retire_pooled_instance);
    let superseded = retire_superseded_instances(pool, conversation, agent_key, key);
    if superseded.retired > 0 {
        tracing::info!(
            superseded = superseded.retired,
            changed = superseded.changed.join(","),
            "ACP spawn retired this conversation's superseded instances of the same agent"
        );
        if *spawn_reason == AcpSpawnReason::NewConversation {
            *spawn_reason = AcpSpawnReason::KeyChanged;
        }
    }
    released_slot |= superseded.released_slot;
    tracing::info!(
        reason = spawn_reason.as_str(),
        changed = superseded.changed.join(","),
        "ACP spawning an instance"
    );
    released_slot
}

/// Spawns a pooled instance for `key`, enqueues the turn, and registers it in the pool.
pub(super) fn spawn_pooled(
    pool: &mut AcpPool,
    key: String,
    launch: AcpLaunch,
    pending: Option<AcpTurn>,
    grants: AcpLaunchGrants<'_>,
    released_slot: bool,
) {
    // No live instance for this (conversation, agent) key: spawn one and enqueue
    // the turn. On a mid-conversation harness switch (Plane B agent-auto picking a
    // different agent than last turn) this is the newly-chosen agent's first turn.
    //
    // TODO(cross-harness transcript replay, spec §2.3): a freshly-spawned agent's
    // FIRST turn is already seeded with recent context — `build_acp_prompt` folds
    // the caller's `short_term` (a window of recent conversation turns) into the
    // prompt preamble, so the new harness is not blind to the conversation. What is
    // NOT yet replayed is the WHOLE conversation history (a full transcript
    // summary/prefix) into the new ACP session, and in-subprocess ephemeral state
    // (open files the previous agent was editing) is intentionally not carried over
    // — history is replayed, live subprocess state is not.
    let (turns_tx, turns_rx) = mpsc::unbounded_channel();
    let _ = turns_tx.send(pending.expect("turn present"));
    let AcpLaunch {
        spawn_cmd,
        cwd,
        additional_directories,
        environment,
        account_confinement,
    } = launch;
    let spawn_cmd_task = spawn_cmd.clone();
    let cwd_task = cwd.clone();
    let additional_directories_task = additional_directories.clone();
    let session_grant = grants
        .tool_authority
        .and_then(crate::server::acp_tool_broker::issue_session);
    let capability_session_id = session_grant
        .as_ref()
        .map(crate::server::acp_tool_broker::AcpToolSessionGrant::session_id);
    crate::acp_runtime::ensure_memory_pressure_reaper(evict_idle_acp_instance);
    let activity = AcpInstanceActivity::new();
    let activity_task = Arc::clone(&activity);
    // Accepted only while this instance is in a turn; dropped with the
    // instance task, whatever ends it.
    let inference_grant = grants.inference.map(|redeemed| {
        crate::server::acp_inference_proxy::issue(
            redeemed.scope.clone(),
            Some(Arc::clone(&activity)),
        )
    });
    let inference_grant_id = inference_grant
        .as_ref()
        .map(crate::server::acp_inference_proxy::AcpInferenceGrant::grant_id);
    let instance = tokio::spawn(async move {
        crate::acp_runtime::refresh_from_gateway(&reqwest::Client::new()).await;
        // A retired predecessor's permit is this instance's slot; waiting for it
        // keeps the replacement from stopping another chat's warm agent.
        let mut permit = if released_slot {
            crate::acp_runtime::acquire_after_retiring(evict_idle_acp_instance).await
        } else {
            crate::acp_runtime::acquire(evict_idle_acp_instance).await
        };
        // An eviction of this instance ends when its slot comes back.
        permit.track_eviction(activity_task.evicted.clone());
        let _permit = permit;
        activity_task.mark_admitted();
        if let Err(e) = run_acp_instance(
            spawn_cmd_task,
            cwd_task,
            additional_directories_task,
            environment,
            session_grant,
            inference_grant,
            turns_rx,
            Some(activity_task),
            account_confinement,
        )
        .await
        {
            tracing::error!("ACP instance error: {e:#}");
        }
    });
    super::super::acp_instance_tasks::track(instance.abort_handle());
    pool.insert(
        key,
        AcpPoolEntry {
            turns: turns_tx,
            capability_session_id,
            inference_grant_id,
            activity,
        },
    );
}
