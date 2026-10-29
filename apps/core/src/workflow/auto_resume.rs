//! Automatic resumption of durable workflow runs: after a crash or restart,
//! after a provider rate/usage/session limit resets, and after the background
//! task running a run panics.
//!
//! The executor already checkpoints every node, so a run *can* continue from
//! its last completed node; this module is what makes it *do* so without a
//! person re-submitting it. It mirrors the boot auto-resume for chat turns
//! (`server::run_auto_resume`, which covers chats and worker threads) and shares
//! its preference and safety rails:
//!
//! - **Crash / restart.** At boot every top-level run still marked `Running`
//!   was interrupted by the previous process. Each is claimed by bumping
//!   [`WorkflowRun::crash_resumes`] *on disk before any work starts*, so a run
//!   that takes Core down again cannot crash-loop it; after
//!   [`MAX_CRASH_RESUMES`] it is failed with an explanation instead. Runs idle
//!   for longer than [`MAX_AGE`] are left for the user.
//! - **Limits.** A run parked as `Waiting` (see [`super::limits`]) is woken at
//!   its `resume_at`, including after a restart, because the wake time is
//!   persisted on the run.
//! - **Background task crash.** Resumed runs execute under [`spawn_supervised`]:
//!   if the task panics, the run is relaunched against the same crash budget.
//! - **Sub-agents.** Fan-out delegates checkpoint only their successes, so a
//!   resumed `AgentDelegate` or script node reruns exactly the delegates that
//!   did not finish (see [`super::delegation`]).
//!
//! Nested child runs are never resumed directly: their top-level run is, and it
//! re-enters each child under the child's deterministic run id.
//!
//! Safety rails: the shared `auto-resume-interrupted-threads` preference turns
//! all of this off; Safe Mode, a Kill Switch pause, or a lapsed entitlement
//! hold it (limit wakes re-check every [`HOLD_RECHECK`]).

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};

use super::executor::PARENT_RUN_KEY;
use super::store::{self, RunStatus, WorkflowRun};

/// Preference shared with chat auto-resume. Anything but an explicit off value
/// keeps auto-resume on.
pub const AUTO_RESUME_PREF_KEY: &str = "auto-resume-interrupted-threads";

/// Automatic restarts per run after the process running it died.
pub const MAX_CRASH_RESUMES: u32 = 2;

/// Limit waits per run before the run is failed instead of parked again.
/// Generous on purpose: a long job on a busy plan can wait out many windows.
pub const MAX_LIMIT_WAITS: u32 = 48;

/// Runs whose last checkpoint is older than this are not resumed after a crash.
pub const MAX_AGE: chrono::Duration = chrono::Duration::days(7);

/// Let the previous process's orphaned agent trees be reaped first.
const SETTLE_DELAY: Duration = Duration::from_secs(3);

/// Spacing between resumed runs so a node does not start them all at once.
const STAGGER: Duration = Duration::from_millis(750);

/// How often a held limit wake re-checks the safety rails.
const HOLD_RECHECK: Duration = Duration::from_secs(5 * 60);

/// Parse the preference defensively: unset or unrecognized values keep it on.
pub fn auto_resume_enabled(raw: Option<&str>) -> bool {
    !matches!(
        raw.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("false" | "0" | "off" | "no")
    )
}

/// Why automatic resumption is held right now, if it is.
async fn hold_reason() -> Option<&'static str> {
    let preference = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(store) => store.get(AUTO_RESUME_PREF_KEY).await.ok().flatten(),
        Err(_) => None,
    };
    if !auto_resume_enabled(preference.as_deref()) {
        return Some("off by preference");
    }
    if crate::safe_mode::is_active() {
        return Some("Safe Mode");
    }
    if crate::execution_control::is_paused() {
        return Some("Kill Switch pause");
    }
    if !crate::entitlement::is_active() {
        return Some("node not entitled");
    }
    None
}

/// Run ids with a live executor task in this process, so a boot scan, a wake,
/// and a manual continue never execute one run twice.
fn executing() -> &'static Mutex<HashSet<String>> {
    static EXECUTING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    EXECUTING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Run ids with a pending limit wake in this process.
fn waking() -> &'static Mutex<HashSet<String>> {
    static WAKING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    WAKING.get_or_init(|| Mutex::new(HashSet::new()))
}

fn try_insert(set: &Mutex<HashSet<String>>, run_id: &str) -> bool {
    set.lock()
        .map(|mut ids| ids.insert(run_id.to_owned()))
        .unwrap_or(false)
}

fn remove(set: &Mutex<HashSet<String>>, run_id: &str) -> bool {
    set.lock()
        .map(|mut ids| ids.remove(run_id))
        .unwrap_or(false)
}

/// Whether this process is executing `run_id` right now.
pub fn is_executing(run_id: &str) -> bool {
    executing()
        .lock()
        .map(|ids| ids.contains(run_id))
        .unwrap_or(false)
}

/// What the boot scan decided for one persisted run.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BootAction {
    /// Interrupted mid-run: restart it now (budget already checked).
    Resume,
    /// Parked on a limit: wake it at `resume_at`.
    Wake,
    /// Interrupted too many times: fail it.
    Exhausted,
    /// Nothing to do (terminal, awaiting a person, nested, or too old).
    Skip,
}

/// Decide what to do with `run` at boot. Pure so it is unit testable.
pub(crate) fn boot_action(run: &WorkflowRun, now: DateTime<Utc>) -> BootAction {
    if run.dry_run || run.state.contains_key(PARENT_RUN_KEY) {
        return BootAction::Skip;
    }
    match run.status {
        RunStatus::Waiting => BootAction::Wake,
        RunStatus::Running => {
            let updated = DateTime::parse_from_rfc3339(&run.updated_at)
                .map(|at| at.with_timezone(&Utc))
                .unwrap_or(now);
            if now.signed_duration_since(updated) > MAX_AGE {
                BootAction::Skip
            } else if run.crash_resumes >= MAX_CRASH_RESUMES {
                BootAction::Exhausted
            } else {
                BootAction::Resume
            }
        }
        RunStatus::AwaitingInput | RunStatus::Completed | RunStatus::Failed => BootAction::Skip,
    }
}

/// Resume interrupted runs and re-arm limit wakes. Runs once, after the
/// Gateway has started (a resumed node needs it to reach a model).
pub async fn resume_after_boot() {
    let now = Utc::now();
    let mut resume = Vec::new();
    for run in store::list_runs() {
        match boot_action(&run, now) {
            BootAction::Resume => resume.push(run.run_id),
            BootAction::Wake => schedule_wake(&run),
            BootAction::Exhausted => {
                let error = format!(
                    "interrupted when Ryu stopped; not resumed automatically after \
                     {MAX_CRASH_RESUMES} attempts"
                );
                if let Err(e) = super::executor::fail_run(&run.run_id, &error).await {
                    tracing::warn!(run_id = %run.run_id, "auto-resume: could not fail run: {e}");
                }
            }
            BootAction::Skip => {}
        }
    }
    if resume.is_empty() {
        return;
    }
    if let Some(reason) = hold_reason().await {
        tracing::info!(
            count = resume.len(),
            reason,
            "auto-resume: interrupted workflow runs left for manual continue"
        );
        return;
    }
    tokio::time::sleep(SETTLE_DELAY).await;
    for run_id in resume {
        if crate::execution_control::is_paused() {
            tracing::info!("auto-resume: stopped by Kill Switch");
            break;
        }
        match claim_crash_resume(&run_id) {
            Ok(true) => {
                tracing::info!(run_id, "auto-resume: resuming interrupted workflow run");
                spawn_supervised(run_id);
                tokio::time::sleep(STAGGER).await;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(run_id, "auto-resume: claim failed: {e}"),
        }
    }
}

/// Spend one crash resume on `run_id`, durably, before any work starts.
/// Returns `false` when the run is no longer `Running` or the budget is spent.
fn claim_crash_resume(run_id: &str) -> std::io::Result<bool> {
    let mut run = store::load_run(run_id)?;
    if run.status != RunStatus::Running || run.crash_resumes >= MAX_CRASH_RESUMES {
        return Ok(false);
    }
    run.crash_resumes += 1;
    run.updated_at = Utc::now().to_rfc3339();
    store::save_run(&run)?;
    Ok(true)
}

/// Wake `run` at its `resume_at` (immediately when that has passed). Idempotent
/// per process; the wake time is on disk, so a restart re-arms it at boot.
pub fn schedule_wake(run: &WorkflowRun) {
    if run.status != RunStatus::Waiting || !try_insert(waking(), &run.run_id) {
        return;
    }
    let run_id = run.run_id.clone();
    let resume_at = run
        .resume_at
        .as_deref()
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .map_or_else(Utc::now, |at| at.with_timezone(&Utc));
    tokio::spawn(async move {
        let delay = resume_at
            .signed_duration_since(Utc::now())
            .to_std()
            .unwrap_or_default();
        tokio::time::sleep(delay).await;
        while let Some(reason) = hold_reason().await {
            tracing::info!(run_id, reason, "auto-resume: limit wake held");
            tokio::time::sleep(HOLD_RECHECK).await;
        }
        // `continue_now` cancels a pending wake by removing it from the set.
        if !remove(waking(), &run_id) {
            return;
        }
        let still_waiting = store::load_run(&run_id)
            .map(|run| run.status == RunStatus::Waiting)
            .unwrap_or(false);
        if still_waiting {
            tracing::info!(run_id, "auto-resume: limit window reopened; resuming run");
            spawn_supervised(run_id);
        }
    });
}

/// Continue a `Running` or `Waiting` run now, for the manual "continue" route.
/// Returns `false` when the run is not resumable or is already active here.
pub fn continue_now(run_id: &str) -> std::io::Result<bool> {
    let run = store::load_run(run_id)?;
    if !matches!(run.status, RunStatus::Running | RunStatus::Waiting)
        || run.state.contains_key(PARENT_RUN_KEY)
    {
        return Ok(false);
    }
    if is_executing(run_id) || super::executor::is_run_executing(run_id) {
        return Ok(false);
    }
    // The person asked not to wait for a pending limit wake: cancel it.
    remove(waking(), run_id);
    Ok(spawn_supervised(run_id.to_owned()))
}

/// Execute `run_id` from its last checkpoint in a supervised background task.
/// A panic in the executor task is the "background task crashed" case: the
/// run is relaunched while its crash budget lasts, then failed. Returns `false`
/// when this process is already running it.
pub fn spawn_supervised(run_id: String) -> bool {
    if !try_insert(executing(), &run_id) {
        return false;
    }
    tokio::spawn(async move {
        loop {
            let task_run_id = run_id.clone();
            let outcome = tokio::spawn(async move { execute(&task_run_id).await }).await;
            match outcome {
                Ok(Ok(run)) => {
                    tracing::info!(run_id, status = ?run.status, "auto-resume: run settled");
                    break;
                }
                Ok(Err(error)) => {
                    tracing::warn!(run_id, "auto-resume: run did not resume: {error}");
                    // A definition that no longer exists or a refused agent
                    // would otherwise leave the run `Running` forever.
                    if let Ok(run) = store::load_run(&run_id) {
                        if run.status == RunStatus::Running {
                            let _ = super::executor::fail_run(&run_id, &error).await;
                        }
                    }
                    break;
                }
                Err(join) if join.is_panic() => {
                    tracing::error!(run_id, "auto-resume: workflow task panicked");
                    match claim_crash_resume(&run_id) {
                        Ok(true) => continue,
                        _ => {
                            let _ = super::executor::fail_run(
                                &run_id,
                                "the background task running this workflow crashed repeatedly",
                            )
                            .await;
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        remove(executing(), &run_id);
    });
    true
}

async fn execute(run_id: &str) -> Result<WorkflowRun, String> {
    let run = store::load_run(run_id).map_err(|e| format!("could not load run: {e}"))?;
    // Settled (or handed to a person) since this resume was queued.
    if !matches!(run.status, RunStatus::Running | RunStatus::Waiting) {
        return Ok(run);
    }
    let workflow = store::load_runnable_workflow(&run.workflow_id)
        .map_err(|e| format!("workflow '{}' is no longer available: {e}", run.workflow_id))?;
    super::executor::run_workflow(&workflow, run.input.clone(), run.run_id.clone()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn run(status: RunStatus) -> WorkflowRun {
        let mut run = WorkflowRun::new("r".into(), "w".into(), HashMap::new());
        run.status = status;
        run
    }

    #[test]
    fn preference_defaults_on_and_only_explicit_values_turn_it_off() {
        assert!(auto_resume_enabled(None));
        assert!(auto_resume_enabled(Some("true")));
        assert!(auto_resume_enabled(Some("garbage")));
        for off in ["false", " FALSE ", "0", "off", "no"] {
            assert!(!auto_resume_enabled(Some(off)), "{off} should disable");
        }
    }

    #[test]
    fn boot_resumes_interrupted_runs_within_budget_and_age() {
        let now = Utc::now();
        assert_eq!(
            boot_action(&run(RunStatus::Running), now),
            BootAction::Resume
        );

        let mut spent = run(RunStatus::Running);
        spent.crash_resumes = MAX_CRASH_RESUMES;
        assert_eq!(boot_action(&spent, now), BootAction::Exhausted);

        let mut stale = run(RunStatus::Running);
        stale.updated_at = (now - MAX_AGE - chrono::Duration::minutes(1)).to_rfc3339();
        assert_eq!(boot_action(&stale, now), BootAction::Skip);
    }

    #[test]
    fn boot_rearms_limit_waits_and_leaves_everything_else() {
        let now = Utc::now();
        assert_eq!(boot_action(&run(RunStatus::Waiting), now), BootAction::Wake);
        for status in [
            RunStatus::AwaitingInput,
            RunStatus::Completed,
            RunStatus::Failed,
        ] {
            assert_eq!(boot_action(&run(status), now), BootAction::Skip);
        }
        // Children are resumed through their top-level run.
        let mut child = run(RunStatus::Running);
        child
            .state
            .insert(PARENT_RUN_KEY.to_owned(), "parent".to_owned());
        assert_eq!(boot_action(&child, now), BootAction::Skip);
    }
}

/// End-to-end recovery through the real executor and Deno sandbox. Skipped when
/// the sandbox runtime is not installed (the script node needs it).
#[cfg(test)]
mod executor_tests {
    use super::*;
    use crate::workflow::test_support::{edge, node, workflow};
    use crate::workflow::{NodeKind, Workflow};
    use std::collections::HashMap;

    fn script_workflow(id: &str, code: &str) -> Workflow {
        workflow(
            id,
            "script",
            vec![
                node("in", NodeKind::Input { key: None }),
                node(
                    "script",
                    NodeKind::Script {
                        code: code.into(),
                        agent_id: None,
                        preset: None,
                        allow_mutation: None,
                    },
                ),
                node(
                    "out",
                    NodeKind::Output {
                        key: Some("result".into()),
                    },
                ),
            ],
            vec![edge("in", "script"), edge("script", "out")],
        )
    }

    const LIMITED: &str = r#"throw new Error("Claude usage limit reached, resets in 2 hours");"#;

    #[tokio::test]
    async fn a_limit_parks_the_run_and_waking_it_finishes_the_same_run() {
        if !ryu_tool_exec::is_available() {
            eprintln!("skipping: Deno sandbox runtime not installed");
            return;
        }
        let id = format!(
            "{}park-{}",
            store::SCRIPT_WORKFLOW_PREFIX,
            uuid::Uuid::new_v4().simple()
        );
        let run_id = format!("park-run-{}", uuid::Uuid::new_v4().simple());
        let parked = super::super::executor::run_workflow(
            &script_workflow(&id, LIMITED),
            HashMap::new(),
            run_id.clone(),
        )
        .await
        .expect("a limit is not a failure");
        assert_eq!(parked.status, RunStatus::Waiting);
        assert_eq!(parked.limit_waits, 1);
        let resume_at = DateTime::parse_from_rfc3339(parked.resume_at.as_deref().unwrap())
            .unwrap()
            .with_timezone(&Utc);
        let wait = resume_at.signed_duration_since(Utc::now());
        assert!(
            wait > chrono::Duration::minutes(119) && wait <= chrono::Duration::minutes(121),
            "{wait}"
        );
        let node = &parked.nodes["script"];
        assert_eq!(
            node.attempts, 0,
            "waiting out a limit spends no retry budget"
        );
        assert_eq!(node.status, store::NodeStatus::Running);
        let on_disk = store::load_run(&run_id).unwrap();
        assert_eq!(on_disk.status, RunStatus::Waiting);
        assert_eq!(boot_action(&on_disk, Utc::now()), BootAction::Wake);

        // The limit reset: the woken run continues under the same id.
        let woken = super::super::executor::run_workflow(
            &script_workflow(&id, "return 'done';"),
            HashMap::new(),
            run_id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(woken.status, RunStatus::Completed);
        assert_eq!(woken.output.get("result").map(String::as_str), Some("done"));
        assert!(woken.resume_at.is_none() && woken.wait_reason.is_none());
        assert_eq!(woken.nodes["script"].attempts, 1);
    }

    #[tokio::test]
    async fn a_limit_inside_a_child_workflow_parks_the_whole_chain() {
        if !ryu_tool_exec::is_available() {
            eprintln!("skipping: Deno sandbox runtime not installed");
            return;
        }
        let child_id = format!("child-{}", uuid::Uuid::new_v4().simple());
        store::save_workflow(&script_workflow(&child_id, LIMITED)).unwrap();
        let parent = workflow(
            format!("parent-{}", uuid::Uuid::new_v4().simple()),
            "parent",
            vec![
                node("in", NodeKind::Input { key: None }),
                node(
                    "child",
                    NodeKind::SubWorkflow {
                        workflow_id: child_id.clone(),
                    },
                ),
                node("out", NodeKind::Output { key: None }),
            ],
            vec![edge("in", "child"), edge("child", "out")],
        );
        let run_id = format!("parent-run-{}", uuid::Uuid::new_v4().simple());
        let parked = super::super::executor::run_workflow(&parent, HashMap::new(), run_id.clone())
            .await
            .unwrap();
        assert_eq!(parked.status, RunStatus::Waiting, "{:?}", parked.error);
        assert!(parked
            .wait_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("usage limit")));
        let child = store::load_run(&format!("{run_id}-sub-child")).unwrap();
        assert_eq!(child.status, RunStatus::Waiting);
        // Only the top-level run is woken; it re-enters the child.
        assert_eq!(boot_action(&child, Utc::now()), BootAction::Skip);
        assert_eq!(boot_action(&parked, Utc::now()), BootAction::Wake);
    }

    #[tokio::test]
    async fn an_interrupted_script_run_is_resumed_under_supervision() {
        if !ryu_tool_exec::is_available() {
            eprintln!("skipping: Deno sandbox runtime not installed");
            return;
        }
        let id = format!(
            "{}crash-{}",
            store::SCRIPT_WORKFLOW_PREFIX,
            uuid::Uuid::new_v4().simple()
        );
        store::save_script_workflow(&script_workflow(&id, "return 'recovered';")).unwrap();
        // What a crash leaves behind: `Running`, the script node mid-attempt.
        let run_id = format!("crash-run-{}", uuid::Uuid::new_v4().simple());
        let mut interrupted = WorkflowRun::new(run_id.clone(), id, HashMap::new());
        interrupted.nodes.insert(
            "in".into(),
            store::NodeRunState {
                status: store::NodeStatus::Completed,
                output: Some(String::new()),
                error: None,
                attempts: 1,
                wake_at: None,
            },
        );
        interrupted.nodes.insert(
            "script".into(),
            store::NodeRunState {
                status: store::NodeStatus::Running,
                output: None,
                error: None,
                attempts: 1,
                wake_at: None,
            },
        );
        store::save_run(&interrupted).unwrap();
        assert_eq!(boot_action(&interrupted, Utc::now()), BootAction::Resume);

        assert!(claim_crash_resume(&run_id).unwrap());
        assert_eq!(store::load_run(&run_id).unwrap().crash_resumes, 1);
        assert!(spawn_supervised(run_id.clone()));
        assert!(!spawn_supervised(run_id.clone()), "one executor per run");

        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let settled = loop {
            let run = store::load_run(&run_id).unwrap();
            if run.status != RunStatus::Running {
                break run;
            }
            assert!(std::time::Instant::now() < deadline, "run never settled");
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(settled.status, RunStatus::Completed);
        assert_eq!(
            settled.output.get("result").map(String::as_str),
            Some("recovered")
        );
        assert_eq!(settled.crash_resumes, 1);
    }

    #[tokio::test]
    async fn the_crash_budget_is_durable() {
        let run_id = format!("budget-run-{}", uuid::Uuid::new_v4().simple());
        let mut run = WorkflowRun::new(run_id.clone(), "gone".into(), HashMap::new());
        run.crash_resumes = MAX_CRASH_RESUMES - 1;
        store::save_run(&run).unwrap();
        assert!(claim_crash_resume(&run_id).unwrap());
        assert!(
            !claim_crash_resume(&run_id).unwrap(),
            "budget spent on disk"
        );
        assert_eq!(
            boot_action(&store::load_run(&run_id).unwrap(), Utc::now()),
            BootAction::Exhausted
        );
    }
}
