use std::sync::atomic::{AtomicUsize, Ordering};

static CALLS: AtomicUsize = AtomicUsize::new(0);

fn live(_: &str) -> bool {
    CALLS.fetch_add(1, Ordering::SeqCst);
    true
}

fn idle(_: &str) -> bool {
    CALLS.fetch_add(1, Ordering::SeqCst);
    false
}

#[test]
fn every_canceller_runs_after_one_reports_a_live_turn() {
    // An ACP turn answers first; the durable driver wrapping it (and the hook
    // loop that would start a Continue turn) must still be stopped.
    CALLS.store(0, Ordering::SeqCst);
    assert!(crate::server::signal_every_canceller(
        "c",
        &[live, idle, live]
    ));
    assert_eq!(CALLS.load(Ordering::SeqCst), 3);
    assert!(!crate::server::signal_every_canceller("c", &[idle, idle]));
}

#[test]
fn cancel_stops_the_durable_driver() {
    use crate::sidecar::adapters::live_turn;
    let conversation_id = format!("cancel-turn-test-{}", uuid::Uuid::new_v4());
    let turn = live_turn::register(&conversation_id, true);
    assert!(crate::server::cancel_conversation_turn(&conversation_id));
    assert!(live_turn::cancel_requested(&conversation_id));
    drop(turn);
    assert!(!crate::server::cancel_conversation_turn(&conversation_id));
}
