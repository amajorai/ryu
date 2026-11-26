//! Tests for the update restart gate (`restart_gate.rs`).

use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

use super::*;

/// Start a wait on `gate` whose active run count is read from `active`.
fn spawn_wait(
    gate: &Arc<Gate>,
    active: &Arc<AtomicUsize>,
    max_wait: Duration,
) -> tokio::task::JoinHandle<Release> {
    let gate = Arc::clone(gate);
    let active = Arc::clone(active);
    tokio::spawn(async move {
        gate.wait_until_idle(move || active.load(Ordering::SeqCst), POLL, max_wait)
            .await
    })
}

#[tokio::test(start_paused = true)]
async fn restart_is_deferred_while_a_run_is_active_and_applied_after() {
    let gate = Arc::new(Gate::new());
    let active = Arc::new(AtomicUsize::new(1));
    let wait = spawn_wait(&gate, &active, MAX_WAIT);

    // An hour of polls with the run still going: far past the old 20 s drain.
    tokio::time::sleep(Duration::from_secs(60 * 60)).await;
    assert!(!wait.is_finished(), "a running agent must hold the restart");
    assert!(gate.is_waiting());

    active.store(0, Ordering::SeqCst);
    assert_eq!(wait.await.unwrap(), Release::Idle);
    assert!(!gate.is_waiting());
}

#[tokio::test(start_paused = true)]
async fn the_gap_between_two_turns_is_not_idle() {
    let gate = Gate::new();
    let reads = AtomicUsize::new(0);
    // Idle, then a new turn, then idle twice: only the last pair releases.
    let readings: [usize; 4] = [0, 1, 0, 0];
    let release = gate
        .wait_until_idle(
            || readings[reads.fetch_add(1, Ordering::SeqCst).min(readings.len() - 1)],
            POLL,
            MAX_WAIT,
        )
        .await;
    assert_eq!(release, Release::Idle);
    assert_eq!(reads.load(Ordering::SeqCst), readings.len());
}

#[tokio::test(start_paused = true)]
async fn restart_now_releases_a_waiting_restart_at_once() {
    let gate = Arc::new(Gate::new());
    let active = Arc::new(AtomicUsize::new(3));
    let wait = spawn_wait(&gate, &active, MAX_WAIT);
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert!(!wait.is_finished());

    let asked = tokio::time::Instant::now();
    assert!(gate.restart_now());
    assert_eq!(wait.await.unwrap(), Release::RestartNow);
    assert!(
        asked.elapsed() < POLL,
        "the override must not wait for a poll"
    );
    assert_eq!(
        active.load(Ordering::SeqCst),
        3,
        "the runs were still going"
    );
}

#[tokio::test(start_paused = true)]
async fn restart_now_without_a_waiting_restart_is_refused_and_arms_nothing() {
    let gate = Arc::new(Gate::new());
    assert!(!gate.restart_now());

    // The refused call must not release a restart requested later.
    let active = Arc::new(AtomicUsize::new(1));
    let wait = spawn_wait(&gate, &active, MAX_WAIT);
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert!(!wait.is_finished());
    wait.abort();
}

#[tokio::test(start_paused = true)]
async fn a_run_that_never_ends_stops_holding_the_restart_after_the_longest_wait() {
    let gate = Gate::new();
    let started = tokio::time::Instant::now();
    let release = gate
        .wait_until_idle(|| 1, POLL, Duration::from_secs(60))
        .await;
    assert_eq!(release, Release::TimedOut);
    assert!(started.elapsed() >= Duration::from_secs(60));
    assert!(started.elapsed() < Duration::from_secs(60) + POLL + POLL);
}

#[test]
fn a_running_chat_turn_counts_as_an_active_run() {
    let turn = crate::sidecar::adapters::live_turn::register("restart-gate-test-turn", false);
    assert!(active_agent_runs() >= 1);
    let wire = serde_json::to_value(status()).unwrap();
    assert!(wire["active_runs"].as_u64().unwrap() >= 1);
    // No update restart was requested in this process, so nothing is waiting
    // and the process-wide override has nothing to release.
    assert_eq!(wire["waiting"], false);
    assert!(!restart_now());
    drop(turn);
}
