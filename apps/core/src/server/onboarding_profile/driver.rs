//! Driving one profile job through its draft and materialise phases.

use super::*;

pub(super) async fn run_job(id: String, state: ServerState) {
    let draft_state = state.clone();
    let discard_state = state.clone();
    drive_job(
        &id,
        move |inputs, conversation_id| async move {
            draft_profile(&draft_state, &inputs, &conversation_id).await
        },
        move |inputs, conversation_id, draft| async move {
            // Accepted: the conversation is the user's profile chat from here
            // on, so a restart must no longer sweep it.
            clear_pending_profile_draft(&state.preferences, &conversation_id).await;
            materialize_profile(&state, &inputs, &conversation_id, draft).await
        },
        move |conversation_id| async move {
            discard_profile_draft(&discard_state, &conversation_id).await;
        },
        |conversation_id| {
            // Every canceller: an ACP agent runs the turn on a detached task
            // that dropping the draft future does not stop.
            crate::server::cancel_conversation_turn(conversation_id);
        },
        PROFILE_DRAFT_CANCEL_GRACE,
    )
    .await;
}

/// Run one job through its draft and materialisation phases, then release the
/// job's slot. The phases are injected so the lifecycle (start immediately,
/// cancel only before materialisation, record the outcome) is testable without
/// a model.
///
/// On a cancel the draft turn is stopped, not merely abandoned: `stop_turn` is
/// signalled until the draft future ends (bounded by `cancel_grace`), and only
/// then does `discard` run, so a turn that is still persisting cannot write
/// into a conversation that was already removed. `discard` runs whenever a
/// draft is withdrawn before materialisation (a cancel, an expired job, or a
/// failed draft) so the conversation the draft wrote does not outlive it.
pub(super) async fn drive_job<Draft, DraftFut, Commit, CommitFut, Discard, DiscardFut, Stop>(
    id: &str,
    draft: Draft,
    commit: Commit,
    discard: Discard,
    stop_turn: Stop,
    cancel_grace: Duration,
) where
    Draft: FnOnce(ProfileJobInputs, String) -> DraftFut,
    DraftFut: Future<Output = anyhow::Result<ProfileDraft>>,
    Commit: FnOnce(ProfileJobInputs, String, ProfileDraft) -> CommitFut,
    CommitFut: Future<Output = anyhow::Result<()>>,
    Discard: FnOnce(String) -> DiscardFut,
    DiscardFut: Future<Output = ()>,
    Stop: Fn(&str),
{
    drive_job_phases(id, draft, commit, discard, stop_turn, cancel_grace).await;
    if let Some(job) = jobs().lock().await.get_mut(id) {
        job.driver_active = false;
    }
}

pub(super) async fn drive_job_phases<
    Draft,
    DraftFut,
    Commit,
    CommitFut,
    Discard,
    DiscardFut,
    Stop,
>(
    id: &str,
    draft: Draft,
    commit: Commit,
    discard: Discard,
    stop_turn: Stop,
    cancel_grace: Duration,
) where
    Draft: FnOnce(ProfileJobInputs, String) -> DraftFut,
    DraftFut: Future<Output = anyhow::Result<ProfileDraft>>,
    Commit: FnOnce(ProfileJobInputs, String, ProfileDraft) -> CommitFut,
    CommitFut: Future<Output = anyhow::Result<()>>,
    Discard: FnOnce(String) -> DiscardFut,
    DiscardFut: Future<Output = ()>,
    Stop: Fn(&str),
{
    let (inputs, cancel) = {
        let guard = jobs().lock().await;
        let Some(job) = guard.get(id) else {
            return;
        };
        if job.cancel_requested || profile_job_is_terminal(job) {
            return;
        }
        (job.inputs.clone(), job.cancel.clone())
    };
    let conversation_id = format!("profile-{}", uuid::Uuid::new_v4());

    let mut draft_turn = Box::pin(draft(inputs.clone(), conversation_id.clone()));
    let drafted = tokio::select! {
        biased;
        () = cancel.cancelled() => None,
        result = &mut draft_turn => Some(result),
    };
    if drafted.is_none() {
        let stopped = tokio::time::timeout(cancel_grace, async {
            loop {
                stop_turn(&conversation_id);
                tokio::select! {
                    _ = &mut draft_turn => break,
                    () = tokio::time::sleep(PROFILE_DRAFT_CANCEL_RESIGNAL) => {}
                }
            }
        })
        .await;
        if stopped.is_err() {
            tracing::warn!(
                conversation_id = %conversation_id,
                "onboarding: a cancelled profile draft did not stop within its grace period"
            );
        }
    }
    // Dropping the future also ends a turn that is bound to its stream.
    drop(draft_turn);

    let accepted = {
        let mut guard = jobs().lock().await;
        match (guard.get_mut(id), drafted) {
            // Cancelled, expired, or pruned while drafting: withdraw the draft.
            (None, _) | (_, None) => None,
            (Some(job), _) if job.cancel_requested || profile_job_is_terminal(job) => None,
            (Some(job), Some(Ok(draft))) => {
                // Flipped under the job lock, so a concurrent cancel either
                // landed above or is refused from here on.
                job.materialized = true;
                job.conversation_id = Some(conversation_id.clone());
                Some(draft)
            }
            (Some(job), Some(Err(err))) => {
                job.state = JobState::Failed;
                job.error = Some(err.to_string());
                None
            }
        }
    };
    let Some(draft) = accepted else {
        discard(conversation_id).await;
        return;
    };

    let agent_suggestions = draft.agent_suggestions.clone();
    let result = commit(inputs, conversation_id, draft).await;
    let mut guard = jobs().lock().await;
    if let Some(job) = guard.get_mut(id) {
        match result {
            Ok(()) => {
                job.agent_suggestions = agent_suggestions;
                job.state = JobState::Completed;
            }
            Err(err) => {
                job.state = JobState::Failed;
                job.error = Some(err.to_string());
            }
        }
    }
}
