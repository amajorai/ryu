//! Driving a profile job: completion, cancel, grace, and failure.

use super::jobs_tests::test_job;
use super::*;

/// A stop hook for drafts that never reach a cancel.
fn no_stop(_: &str) {}

const TEST_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

async fn insert_test_job() -> String {
    let id = format!("test-{}", uuid::Uuid::new_v4());
    jobs().lock().await.insert(id.clone(), test_job());
    id
}

async fn job_snapshot(id: &str) -> ProfileJob {
    jobs()
        .lock()
        .await
        .get(id)
        .cloned()
        .expect("test job is still tracked")
}

fn test_draft() -> ProfileDraft {
    ProfileDraft {
        agent_id: "ryu".to_owned(),
        agent_suggestions: vec![AgentSuggestion {
            description: "Drafts a weekly summary.".to_owned(),
            id: "weekly-0".to_owned(),
            name: "weekly".to_owned(),
            reason: "Repeated weekly summaries.".to_owned(),
            system_prompt: "Summarize the week.".to_owned(),
            title: "Weekly".to_owned(),
            tools: Vec::new(),
        }],
        profile: "Profile".to_owned(),
    }
}

/// Records which phases ran and with which conversation id.
#[derive(Clone, Default)]
struct PhaseLog {
    drafted: Arc<std::sync::Mutex<Option<String>>>,
    committed: Arc<std::sync::Mutex<Option<String>>>,
    discarded: Arc<std::sync::Mutex<Option<String>>>,
}

impl PhaseLog {
    fn record(slot: &std::sync::Mutex<Option<String>>, conversation_id: String) {
        *slot.lock().unwrap() = Some(conversation_id);
    }

    fn get(slot: &std::sync::Mutex<Option<String>>) -> Option<String> {
        slot.lock().unwrap().clone()
    }

    fn discard(&self) -> impl FnOnce(String) -> std::future::Ready<()> {
        let discarded = self.discarded.clone();
        move |conversation_id| {
            Self::record(&discarded, conversation_id);
            std::future::ready(())
        }
    }
}

#[tokio::test]
async fn foreground_profile_job_completes_without_the_background_flag() {
    let id = insert_test_job().await;
    let log = PhaseLog::default();
    let drafted = log.drafted.clone();
    let committed = log.committed.clone();

    drive_job(
        &id,
        move |_, conversation_id| async move {
            PhaseLog::record(&drafted, conversation_id);
            anyhow::Ok(test_draft())
        },
        move |_, conversation_id, _| async move {
            PhaseLog::record(&committed, conversation_id);
            anyhow::Ok(())
        },
        log.discard(),
        no_stop,
        TEST_GRACE,
    )
    .await;

    let job = job_snapshot(&id).await;
    assert!(!job.background, "the user never chose Run in background");
    assert_eq!(job.state, JobState::Completed);
    assert!(job.materialized);
    assert!(!job.driver_active, "a finished driver releases its slot");
    assert!(!profile_job_holds_slot(&job));
    assert_eq!(job.agent_suggestions.len(), 1);
    let drafted = PhaseLog::get(&log.drafted);
    assert!(
        drafted.is_some(),
        "the build ran without the background flag"
    );
    assert_eq!(PhaseLog::get(&log.committed), drafted);
    assert_eq!(job.conversation_id, drafted);
    assert_eq!(PhaseLog::get(&log.discarded), None);
}

#[tokio::test]
async fn cancelling_a_drafting_profile_job_stops_its_turn_and_discards_the_draft() {
    let id = insert_test_job().await;
    let log = PhaseLog::default();
    let (draft_started_tx, draft_started_rx) = tokio::sync::oneshot::channel::<()>();
    // The model turn runs elsewhere (an ACP agent's detached task) and only
    // ends when it is told to stop, like a real cancelled turn.
    let turn_stopped = Arc::new(tokio::sync::Notify::new());
    let stop_signals = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let (release_turn_tx, release_turn_rx) = tokio::sync::oneshot::channel::<()>();
    let committed = log.committed.clone();
    let drafted = log.drafted.clone();
    let discard = log.discard();
    let task_id = id.clone();
    let turn_stopped_in_draft = turn_stopped.clone();
    let stop_signals_in_hook = stop_signals.clone();
    let turn_stopped_in_hook = turn_stopped.clone();
    let task = tokio::spawn(async move {
        drive_job(
            &task_id,
            move |_, conversation_id| async move {
                PhaseLog::record(&drafted, conversation_id);
                let _ = draft_started_tx.send(());
                turn_stopped_in_draft.notified().await;
                // The stopped turn still needs a moment to wind down.
                let _ = release_turn_rx.await;
                Err::<ProfileDraft, _>(anyhow::anyhow!("turn cancelled"))
            },
            move |_, conversation_id, _| async move {
                PhaseLog::record(&committed, conversation_id);
                anyhow::Ok(())
            },
            discard,
            move |conversation_id: &str| {
                stop_signals_in_hook
                    .lock()
                    .unwrap()
                    .push(conversation_id.to_owned());
                turn_stopped_in_hook.notify_one();
            },
            TEST_GRACE,
        )
        .await;
    });
    draft_started_rx.await.expect("the draft phase started");

    let cancelled = {
        let mut guard = jobs().lock().await;
        request_cancel(guard.get_mut(&id).expect("test job is tracked"))
    };
    assert!(cancelled);

    // The job reports Cancelled at once but keeps its slot, and nothing is
    // discarded, while its turn is still stopping.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while stop_signals.lock().unwrap().is_empty() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cancel signals the running turn");
    let stopping = job_snapshot(&id).await;
    assert_eq!(stopping.state, JobState::Cancelled);
    assert!(
        profile_job_holds_slot(&stopping),
        "a cancelled job counts against the caps until its turn ends"
    );
    assert_eq!(PhaseLog::get(&log.discarded), None);

    release_turn_tx.send(()).expect("the turn is winding down");
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .expect("the stopped turn lets the driver finish")
        .expect("driver task joins");

    let job = job_snapshot(&id).await;
    assert_eq!(job.state, JobState::Cancelled);
    assert!(!job.materialized);
    assert!(job.conversation_id.is_none());
    assert!(!profile_job_holds_slot(&job), "the slot is released");
    assert_eq!(PhaseLog::get(&log.committed), None);
    let drafted = PhaseLog::get(&log.drafted);
    assert_eq!(
        stop_signals.lock().unwrap().first(),
        drafted.as_ref(),
        "the draft's own turn is the one stopped"
    );
    assert_eq!(
        PhaseLog::get(&log.discarded),
        drafted,
        "the draft's conversation is removed"
    );
}

#[tokio::test]
async fn a_cancelled_draft_that_ignores_stop_is_abandoned_after_the_grace() {
    let id = insert_test_job().await;
    let log = PhaseLog::default();
    let (draft_started_tx, draft_started_rx) = tokio::sync::oneshot::channel::<()>();
    let drafted = log.drafted.clone();
    let discard = log.discard();
    let stops = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let stops_in_hook = stops.clone();
    let task_id = id.clone();
    let task = tokio::spawn(async move {
        drive_job(
            &task_id,
            move |_, conversation_id| async move {
                PhaseLog::record(&drafted, conversation_id);
                let _ = draft_started_tx.send(());
                std::future::pending::<anyhow::Result<ProfileDraft>>().await
            },
            |_, _, _| async { anyhow::Ok(()) },
            discard,
            move |_: &str| {
                stops_in_hook.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            },
            std::time::Duration::from_millis(600),
        )
        .await;
    });
    draft_started_rx.await.expect("the draft phase started");
    {
        let mut guard = jobs().lock().await;
        assert!(request_cancel(
            guard.get_mut(&id).expect("test job is tracked")
        ));
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .expect("the grace bounds the wait")
        .expect("driver task joins");

    let job = job_snapshot(&id).await;
    assert_eq!(job.state, JobState::Cancelled);
    assert!(!profile_job_holds_slot(&job));
    assert!(
        stops.load(std::sync::atomic::Ordering::SeqCst) >= 2,
        "the stop is re-signalled while the turn keeps running"
    );
    assert_eq!(PhaseLog::get(&log.discarded), PhaseLog::get(&log.drafted));
}

#[tokio::test]
async fn a_materializing_profile_job_refuses_cancel_and_completes() {
    let id = insert_test_job().await;
    let log = PhaseLog::default();
    let (commit_started_tx, commit_started_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let discard = log.discard();
    let task_id = id.clone();
    let task = tokio::spawn(async move {
        drive_job(
            &task_id,
            |_, _| async { anyhow::Ok(test_draft()) },
            move |_, _, _| async move {
                let _ = commit_started_tx.send(());
                let _ = release_rx.await;
                anyhow::Ok(())
            },
            discard,
            no_stop,
            TEST_GRACE,
        )
        .await;
    });
    commit_started_rx.await.expect("materialization started");

    let cancelled = {
        let mut guard = jobs().lock().await;
        request_cancel(guard.get_mut(&id).expect("test job is tracked"))
    };
    assert!(!cancelled, "durable writes have begun");
    release_tx.send(()).expect("commit is waiting");
    task.await.expect("driver task joins");

    let job = job_snapshot(&id).await;
    assert_eq!(job.state, JobState::Completed);
    assert!(job.materialized);
    assert!(!job.cancel_requested);
    assert_eq!(PhaseLog::get(&log.discarded), None);
}

#[tokio::test]
async fn a_failed_profile_draft_is_reported_and_discarded_without_materializing() {
    let id = insert_test_job().await;
    let log = PhaseLog::default();
    let drafted = log.drafted.clone();
    drive_job(
        &id,
        move |_, conversation_id| async move {
            PhaseLog::record(&drafted, conversation_id);
            Err::<ProfileDraft, _>(anyhow::anyhow!("model unavailable"))
        },
        |_, _, _| async { Err::<(), _>(anyhow::anyhow!("a failed draft must not materialize")) },
        log.discard(),
        no_stop,
        TEST_GRACE,
    )
    .await;

    let job = job_snapshot(&id).await;
    assert_eq!(job.state, JobState::Failed);
    assert_eq!(job.error.as_deref(), Some("model unavailable"));
    assert!(!job.materialized);
    assert!(job.conversation_id.is_none());
    assert!(PhaseLog::get(&log.discarded).is_some());
    assert_eq!(PhaseLog::get(&log.discarded), PhaseLog::get(&log.drafted));
    assert!(!request_cancel(&mut job.clone()));
}

#[tokio::test]
async fn a_cancelled_profile_job_never_starts_drafting() {
    let id = insert_test_job().await;
    {
        let mut guard = jobs().lock().await;
        assert!(request_cancel(
            guard.get_mut(&id).expect("test job is tracked")
        ));
    }
    let log = PhaseLog::default();
    let drafted = log.drafted.clone();
    drive_job(
        &id,
        move |_, conversation_id| async move {
            PhaseLog::record(&drafted, conversation_id);
            anyhow::Ok(test_draft())
        },
        |_, _, _| async { anyhow::Ok(()) },
        log.discard(),
        no_stop,
        TEST_GRACE,
    )
    .await;

    let job = job_snapshot(&id).await;
    assert_eq!(job.state, JobState::Cancelled);
    assert_eq!(PhaseLog::get(&log.drafted), None);
    assert_eq!(PhaseLog::get(&log.discarded), None);
}
