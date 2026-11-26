//! The order Auto tries accounts in, and how long it keeps one aside.
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::memory::{Busy, Candidate, Memory, NO_MODEL_TTL};

const P: &str = "claude-pro-max";
const OPUS: &str = "claude-opus-4-5";
const SONNET: &str = "claude-sonnet-4-5";

fn candidates(ids: &[&str]) -> Vec<Candidate> {
    ids.iter()
        .map(|id| Candidate {
            id: (*id).to_owned(),
            priority: 0,
            active: *id == "c",
        })
        .collect()
}

fn leaked() -> &'static Mutex<Memory> {
    Box::leak(Box::new(Mutex::new(Memory::default())))
}

#[test]
fn a_limited_account_is_left_out_for_its_model_until_its_reset_and_no_longer() {
    let mut memory = Memory::default();
    let all = candidates(&["a", "b"]);
    let now = Instant::now();
    let reset = now + Duration::from_secs(5 * 60 * 60);
    memory.limit(P, "a", OPUS, reset);

    assert_eq!(memory.order(P, Some("s"), OPUS, &all, false, now), ["b"]);
    let just_before = reset - Duration::from_secs(1);
    assert_eq!(
        memory.order(P, Some("s"), OPUS, &all, false, just_before),
        ["b"]
    );
    // Another model is not limited by this answer.
    assert!(memory
        .order(P, Some("s"), SONNET, &all, false, now)
        .contains(&"a".to_owned()));
    // At the reset the account is tried again.
    let after = memory.order(P, Some("t"), OPUS, &all, false, reset);
    assert!(after.contains(&"a".to_owned()), "{after:?}");
    assert_eq!(
        memory.first_reset(P, &all, &[OPUS.to_owned()], now),
        Some(reset - now)
    );
    assert_eq!(memory.first_reset(P, &all, &[OPUS.to_owned()], reset), None);
    assert_eq!(memory.first_reset(P, &all, &[SONNET.to_owned()], now), None);
}

#[test]
fn no_access_to_a_model_holds_six_hours_and_is_not_a_limit() {
    let mut memory = Memory::default();
    let all = candidates(&["a", "b"]);
    let now = Instant::now();
    memory.refuse_model(P, "a", OPUS, now);
    assert_eq!(memory.order(P, None, OPUS, &all, false, now), ["b"]);
    assert_eq!(memory.first_reset(P, &all, &[OPUS.to_owned()], now), None);
    let later = now + NO_MODEL_TTL;
    assert!(memory
        .order(P, None, OPUS, &all, false, later)
        .contains(&"a".to_owned()));
}

#[test]
fn new_sessions_start_on_different_accounts_and_a_session_keeps_its_account() {
    let mut memory = Memory::default();
    let all = candidates(&["a", "b", "c"]);
    let now = Instant::now();
    let firsts: Vec<String> = (0..3)
        .map(|n| memory.order(P, Some(&format!("sub-{n}")), OPUS, &all, false, now)[0].clone())
        .collect();
    let mut distinct = firsts.clone();
    distinct.sort();
    distinct.dedup();
    assert_eq!(distinct.len(), 3, "{firsts:?}");

    memory.served(P, Some("chat"), "b", OPUS, now);
    for _ in 0..3 {
        assert_eq!(
            memory.order(P, Some("chat"), OPUS, &all, false, now)[0],
            "b"
        );
    }
}

#[test]
fn parallel_requests_go_to_idle_accounts_first() {
    let memory = leaked();
    let all = candidates(&["a", "b", "c"]);
    let now = Instant::now();
    super::memory::lock(memory).served(P, Some("bot"), "a", OPUS, now);
    // Three subagents that share the bot's session run at the same time.
    let mut held = Vec::new();
    let mut used = Vec::new();
    for _ in 0..3 {
        let first =
            super::memory::lock(memory).order(P, Some("bot"), OPUS, &all, false, now)[0].clone();
        held.push(Busy::start(memory, P, &first));
        used.push(first);
    }
    used.sort();
    assert_eq!(used, ["a", "b", "c"]);
    drop(held);
    // When they are done the session is back on its own account.
    let order = super::memory::lock(memory).order(P, Some("bot"), OPUS, &all, false, now);
    assert_eq!(order[0], "a");
}

#[test]
fn manual_starts_at_the_active_account_and_priority_comes_first() {
    let mut memory = Memory::default();
    let all = candidates(&["a", "b", "c"]);
    let now = Instant::now();
    for _ in 0..3 {
        assert_eq!(
            memory.order(P, None, OPUS, &all, true, now),
            ["c", "a", "b"]
        );
    }
    let mut ranked = candidates(&["a", "b", "c"]);
    ranked[2].priority = 0;
    ranked[0].priority = 5;
    ranked[1].priority = 5;
    for _ in 0..3 {
        assert_eq!(memory.order(P, None, OPUS, &ranked, false, now)[0], "c");
    }
}
