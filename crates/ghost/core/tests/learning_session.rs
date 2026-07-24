//! State-machine tests for the recording `LearningSession`.

use ghost_core::learning::{LearnedEvent, LearningSession, SessionStatus};

fn event(ts_ms: u64, kind: &str) -> LearnedEvent {
    LearnedEvent {
        ts_ms,
        event_type: kind.to_string(),
        x: None,
        y: None,
        key: None,
        element_role: None,
        element_name: None,
        element_id: None,
        app_name: None,
    }
}

#[test]
fn new_session_is_idle_and_empty() {
    let s = LearningSession::new();
    assert_eq!(s.status(), SessionStatus::Idle);
    assert_eq!(s.event_count(), 0);
    assert_eq!(s.task_description(), None);
    assert_eq!(s.elapsed_secs(), 0);
}

#[test]
fn default_matches_new() {
    let s = LearningSession::default();
    assert_eq!(s.status(), SessionStatus::Idle);
}

#[test]
fn start_transitions_to_recording_and_stores_task() {
    let s = LearningSession::new();
    s.start(Some("book a flight".to_string())).expect("start");
    assert_eq!(s.status(), SessionStatus::Recording);
    assert_eq!(s.task_description(), Some("book a flight".to_string()));
}

#[test]
fn starting_twice_while_recording_is_rejected() {
    let s = LearningSession::new();
    s.start(None).expect("first start");
    let err = s.start(None).unwrap_err();
    assert!(err.contains("Already recording"), "{err}");
    // Still recording — the failed re-start did not reset anything.
    assert_eq!(s.status(), SessionStatus::Recording);
}

#[test]
fn events_are_collected_only_while_recording() {
    let s = LearningSession::new();
    // Before start: push is a no-op.
    s.push_event(event(1, "click"));
    assert_eq!(s.event_count(), 0);

    s.start(None).expect("start");
    s.push_event(event(10, "click"));
    s.push_event(event(20, "type"));
    assert_eq!(s.event_count(), 2);
}

#[test]
fn stop_returns_collected_events_and_transitions() {
    let s = LearningSession::new();
    s.start(None).expect("start");
    s.push_event(event(5, "click"));
    s.push_event(event(6, "scroll"));

    let events = s.stop().expect("stop");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].event_type, "click");
    assert_eq!(events[1].event_type, "scroll");
    assert_eq!(s.status(), SessionStatus::Stopped);
}

#[test]
fn stopping_when_not_recording_is_rejected() {
    let s = LearningSession::new();
    let err = s.stop().unwrap_err();
    assert!(err.contains("Not recording"), "{err}");
}

#[test]
fn push_after_stop_is_ignored() {
    let s = LearningSession::new();
    s.start(None).expect("start");
    s.push_event(event(1, "click"));
    let _ = s.stop().expect("stop");

    s.push_event(event(2, "click"));
    // The count reflects only what was captured while Recording.
    assert_eq!(s.event_count(), 1);
    assert_eq!(s.status(), SessionStatus::Stopped);
}

#[test]
fn restart_clears_previous_events() {
    let s = LearningSession::new();
    s.start(Some("first".to_string())).expect("start");
    s.push_event(event(1, "click"));
    let _ = s.stop().expect("stop");

    // A fresh start after stop resets the buffer and task description.
    s.start(Some("second".to_string())).expect("restart");
    assert_eq!(s.status(), SessionStatus::Recording);
    assert_eq!(s.event_count(), 0);
    assert_eq!(s.task_description(), Some("second".to_string()));
}
