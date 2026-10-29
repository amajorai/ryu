//! Boot auto-resume for chat turns the previous Core process died in the middle of.
//!
//! [`ConversationStore::open`](super::conversations::ConversationStore::open)
//! already closes the books on those turns: the conversation moves to
//! `interrupted` and the truncated assistant reply is flagged. Without this task
//! the thread then sits there until someone opens the app and retries it by hand,
//! which on an unattended machine can be hours after the crash.
//!
//! Once the runtime is up, each interrupted turn is claimed and run again with no
//! client attached, through the same path as the reconnect retry route. Safety
//! rails:
//! - only turns that were live when *this* process booted are considered, so a
//!   thread left `interrupted` by an earlier boot or a Kill Switch pause is never
//!   picked up later;
//! - each user turn gets [`MAX_ATTEMPTS`] automatic resumes, recorded before the
//!   turn starts, so a turn that crashes Core cannot crash-loop it;
//! - turns older than [`MAX_AGE_MS`] are left for the user;
//! - only node-owned (untenanted) conversations are resumed. A conversation
//!   with an owner or org (a team member's chat on an org-bound node) is left
//!   `interrupted` for its author to retry, because a detached turn has no
//!   verified caller, JWT, or author and would otherwise run with node
//!   authority instead of the author's permissions;
//! - the `auto-resume-interrupted-threads` preference turns it off, and Safe
//!   Mode, a Kill Switch pause, or a lapsed entitlement skip it.

use std::time::Duration;

use super::conversations::AutoResumeClaim;
use super::ServerState;

/// Preference key. Anything but an explicit off value keeps auto-resume on.
pub const AUTO_RESUME_PREF_KEY: &str = "auto-resume-interrupted-threads";

/// Automatic resumes per user turn across boots.
pub const MAX_ATTEMPTS: u32 = 2;

/// Turns that started longer ago than this are not resumed automatically.
pub const MAX_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Let the previous process's orphaned agent trees be reaped before new ones
/// start in the same working folders.
const SETTLE_DELAY: Duration = Duration::from_secs(3);

/// Spacing between resumed turns so a node with many interrupted threads does
/// not start every agent at once.
const STAGGER: Duration = Duration::from_millis(750);

/// Appended to the outgoing user text only. It is not persisted, so the
/// transcript keeps the user's own words.
pub const RESUME_NOTE: &str = "[Ryu: this turn was interrupted when Ryu stopped unexpectedly \
(crash, restart, or power loss) and is being resumed automatically. Any reply you had started \
was cut off. Before repeating an action, check what was already done (files, commands, \
messages sent) and continue from there instead of starting over.]";

/// Parse the preference defensively: unset or unrecognized values keep it on.
pub fn auto_resume_enabled(raw: Option<&str>) -> bool {
    !matches!(
        raw.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("false" | "0" | "off" | "no")
    )
}

/// Why a captured conversation was not resumed. Logged, never surfaced.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Skip {
    Missing,
    TooOld,
    NoUserTurn,
    NotInterrupted,
    Exhausted,
    Attributed,
}

/// Resume every turn captured at boot. Runs once, after the Gateway start.
pub async fn resume_boot_interrupted_runs(state: ServerState) {
    let conversation_ids = state.conversations.take_boot_interrupted_runs();
    if conversation_ids.is_empty() {
        return;
    }
    let preference = state
        .preferences
        .get(AUTO_RESUME_PREF_KEY)
        .await
        .ok()
        .flatten();
    if !auto_resume_enabled(preference.as_deref()) {
        tracing::info!(
            count = conversation_ids.len(),
            "auto-resume: off by preference; interrupted threads left for manual retry"
        );
        return;
    }
    if crate::safe_mode::is_active() {
        tracing::info!("auto-resume: skipped in Safe Mode");
        return;
    }

    tokio::time::sleep(SETTLE_DELAY).await;
    let mut resumed = 0usize;
    for conversation_id in conversation_ids {
        if crate::execution_control::is_paused() {
            tracing::info!("auto-resume: stopped by Kill Switch");
            break;
        }
        if !crate::entitlement::is_active() {
            tracing::info!("auto-resume: node not entitled; interrupted threads left as-is");
            break;
        }
        match resume_one(&state, &conversation_id, now_millis()).await {
            Ok(Ok(attempt)) => {
                resumed += 1;
                tracing::info!(
                    conversation_id,
                    attempt,
                    "auto-resume: resumed interrupted thread"
                );
                tokio::time::sleep(STAGGER).await;
            }
            Ok(Err(reason)) => {
                tracing::info!(conversation_id, ?reason, "auto-resume: not resumed");
            }
            Err(error) => {
                tracing::warn!(conversation_id, "auto-resume failed: {error:#}");
            }
        }
    }
    if resumed > 0 {
        tracing::info!(
            resumed,
            "auto-resume: interrupted threads restarted after boot"
        );
    }
}

/// Claim and start one interrupted turn. `Ok(Err(_))` is a deliberate skip.
pub(crate) async fn resume_one(
    state: &ServerState,
    conversation_id: &str,
    now_ms: i64,
) -> anyhow::Result<Result<u32, Skip>> {
    let Some(summary) = state.conversations.get_run_summary(conversation_id).await? else {
        return Ok(Err(Skip::Missing));
    };
    if now_ms.saturating_sub(summary.updated_at) > MAX_AGE_MS {
        return Ok(Err(Skip::TooOld));
    }
    let messages = state
        .conversations
        .get_active_messages(conversation_id)
        .await?;
    let Some(last_user) = messages.iter().rev().find(|message| message.role == "user") else {
        return Ok(Err(Skip::NoUserTurn));
    };
    if last_user.content.trim().is_empty() {
        return Ok(Err(Skip::NoUserTurn));
    }
    let user_message_id = last_user.id.clone();
    let (attempt, claimed_at) = match state
        .conversations
        .claim_interrupted_run_for_auto_resume(conversation_id, &user_message_id, MAX_ATTEMPTS)
        .await?
    {
        AutoResumeClaim::Claimed {
            attempt,
            claimed_at,
        } => (attempt, claimed_at),
        AutoResumeClaim::NotInterrupted => return Ok(Err(Skip::NotInterrupted)),
        AutoResumeClaim::Exhausted => return Ok(Err(Skip::Exhausted)),
        AutoResumeClaim::Attributed => return Ok(Err(Skip::Attributed)),
    };

    let mut req = super::rerun_request_from_history(conversation_id, summary, messages);
    crate::sidecar::adapters::append_last_user_text(&mut req.messages, RESUME_NOTE);
    let turn = super::spawn_detached_chat_turn(state.clone(), req);
    // A turn rejected before it started leaves the claim's `running` behind
    // with nothing producing it; close it so the chat shows a failed retry.
    let conversations = state.conversations.clone();
    let conversation_id = conversation_id.to_owned();
    tokio::spawn(async move {
        let _ = turn.await;
        match conversations
            .fail_unstarted_auto_resume(&conversation_id, claimed_at)
            .await
        {
            Ok(true) => tracing::warn!(
                conversation_id,
                "auto-resume: resumed turn ended before it started; marked failed"
            ),
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(conversation_id, "auto-resume cleanup failed: {error:#}");
            }
        }
    });
    Ok(Ok(attempt))
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_defaults_on_and_only_explicit_values_turn_it_off() {
        assert!(auto_resume_enabled(None));
        assert!(auto_resume_enabled(Some("true")));
        assert!(auto_resume_enabled(Some("garbage")));
        for off in ["false", " FALSE ", "0", "off", "no"] {
            assert!(!auto_resume_enabled(Some(off)), "{off} should disable");
        }
    }

    use crate::sidecar::adapters::UiContent;

    fn text_of(content: &UiContent) -> &str {
        match content {
            UiContent::Text(text) => text,
            other => panic!("expected text content, got {other:?}"),
        }
    }

    async fn interrupted_conversation(state: &ServerState, id: &str) -> String {
        let turn = state
            .conversations
            .append_message(id, "user", "build it", None, None, None)
            .await
            .unwrap();
        state
            .conversations
            .append_message(id, "assistant", "half a repl", Some("agent-1"), None, None)
            .await
            .unwrap();
        state
            .conversations
            .set_run_status(id, "interrupted")
            .await
            .unwrap();
        turn
    }

    async fn run_status(state: &ServerState, id: &str) -> Option<String> {
        state
            .conversations
            .get_run_summary(id)
            .await
            .unwrap()
            .unwrap()
            .run_status
    }

    #[tokio::test]
    async fn rerun_request_replays_history_into_the_persisted_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());
        interrupted_conversation(&state, "conv").await;
        let mut summary = state
            .conversations
            .get_run_summary("conv")
            .await
            .unwrap()
            .unwrap();
        summary.agent_id = Some("agent-1".to_owned());
        summary.folder_path = Some("/work/repo".to_owned());
        summary.branch = Some("feature".to_owned());
        summary.worktree_path = Some("/work/repo/.worktrees/conv".to_owned());
        let messages = state
            .conversations
            .get_active_messages("conv")
            .await
            .unwrap();

        let req = super::super::rerun_request_from_history("conv", summary, messages);

        assert_eq!(req.conversation_id.as_deref(), Some("conv"));
        assert_eq!(req.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(req.cwd.as_deref(), Some("/work/repo"));
        assert_eq!(req.workspace_folders, vec!["/work/repo".to_owned()]);
        assert!(req.worktree_isolation);
        assert_eq!(req.branch.as_deref(), Some("feature"));
        assert_eq!(
            req.worktree_path.as_deref(),
            Some("/work/repo/.worktrees/conv")
        );
        // The user row already exists: the turn must persist only the reply.
        assert!(req.persist);
        assert!(req.skip_user_append);
        // The detached turn carries no caller identity of its own.
        assert!(req.verified_caller.is_none());
        assert!(req.author_user_id.is_none());
        let replayed: Vec<(&str, &str)> = req
            .messages
            .iter()
            .map(|message| (message.role.as_str(), text_of(&message.content)))
            .collect();
        assert_eq!(
            replayed,
            vec![("user", "build it"), ("assistant", "half a repl")]
        );
    }

    #[tokio::test]
    async fn rerun_request_without_a_worktree_does_not_isolate() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());
        interrupted_conversation(&state, "conv").await;
        let summary = state
            .conversations
            .get_run_summary("conv")
            .await
            .unwrap()
            .unwrap();
        let req = super::super::rerun_request_from_history("conv", summary, Vec::new());
        assert!(req.cwd.is_none());
        assert!(req.workspace_folders.is_empty());
        assert!(!req.worktree_isolation);
        assert!(req.persist && req.skip_user_append);
    }

    #[tokio::test]
    async fn resume_one_skips_turns_it_must_not_rerun() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());

        assert_eq!(
            resume_one(&state, "absent", now_millis()).await.unwrap(),
            Err(Skip::Missing)
        );

        // Interrupted, but no user turn to run again.
        state
            .conversations
            .append_message("no-user", "assistant", "hello", Some("agent-1"), None, None)
            .await
            .unwrap();
        state
            .conversations
            .set_run_status("no-user", "interrupted")
            .await
            .unwrap();
        assert_eq!(
            resume_one(&state, "no-user", now_millis()).await.unwrap(),
            Err(Skip::NoUserTurn)
        );

        // Too old to resume without the user.
        interrupted_conversation(&state, "stale").await;
        let updated_at = state
            .conversations
            .get_run_summary("stale")
            .await
            .unwrap()
            .unwrap()
            .updated_at;
        assert_eq!(
            resume_one(&state, "stale", updated_at + MAX_AGE_MS + 1)
                .await
                .unwrap(),
            Err(Skip::TooOld)
        );
        assert_eq!(
            run_status(&state, "stale").await.as_deref(),
            Some("interrupted")
        );

        // Finished turns are never re-run.
        state
            .conversations
            .append_message("done", "user", "build it", None, None, None)
            .await
            .unwrap();
        state
            .conversations
            .set_run_status("done", "completed")
            .await
            .unwrap();
        assert_eq!(
            resume_one(&state, "done", now_millis()).await.unwrap(),
            Err(Skip::NotInterrupted)
        );
        assert_eq!(
            run_status(&state, "done").await.as_deref(),
            Some("completed")
        );
    }

    #[tokio::test]
    async fn resume_one_stops_after_the_attempt_budget() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());
        let turn = interrupted_conversation(&state, "conv").await;
        // Earlier boots already spent the budget on this user turn.
        for _ in 0..MAX_ATTEMPTS {
            let claim = state
                .conversations
                .claim_interrupted_run_for_auto_resume("conv", &turn, MAX_ATTEMPTS)
                .await
                .unwrap();
            assert!(
                matches!(claim, AutoResumeClaim::Claimed { .. }),
                "{claim:?}"
            );
            state
                .conversations
                .set_run_status("conv", "interrupted")
                .await
                .unwrap();
        }
        assert_eq!(
            resume_one(&state, "conv", now_millis()).await.unwrap(),
            Err(Skip::Exhausted)
        );
        assert_eq!(
            run_status(&state, "conv").await.as_deref(),
            Some("interrupted")
        );
    }

    #[test]
    fn resume_one_claims_and_runs_the_turn_then_closes_an_unstarted_claim() {
        // The detached turn polls the full chat pipeline, whose debug-build
        // futures exceed the default 2 MiB test thread. Give this one test an
        // owned worker with a larger stack instead of changing global settings.
        let worker = std::thread::Builder::new()
            .name("auto-resume-fixture".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("create auto-resume fixture runtime")
                    .block_on(Box::pin(claim_and_run_fixture()));
            })
            .expect("start auto-resume fixture worker");
        if let Err(panic) = worker.join() {
            std::panic::resume_unwind(panic);
        }
    }

    async fn claim_and_run_fixture() {
        let directory = tempfile::tempdir().unwrap();
        let state = super::super::isolated_plugin_hook_test_state(directory.path());
        interrupted_conversation(&state, "conv").await;

        assert_eq!(
            resume_one(&state, "conv", now_millis()).await.unwrap(),
            Ok(1)
        );
        // The claim is recorded before the turn starts, so a racing resume loses.
        assert_ne!(
            run_status(&state, "conv").await.as_deref(),
            Some("interrupted")
        );

        // The test node has no agent runtime, so the detached turn ends without
        // producing a reply; the claim must not be left `running` forever.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let status = run_status(&state, "conv").await;
            if status.as_deref() != Some("running") {
                assert_eq!(status.as_deref(), Some("failed"));
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "resumed turn stayed running"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // No duplicate user row: the rerun only appends to the existing turn.
        let users = state
            .conversations
            .get_active_messages("conv")
            .await
            .unwrap()
            .into_iter()
            .filter(|message| message.role == "user")
            .count();
        assert_eq!(users, 1);
    }
}
