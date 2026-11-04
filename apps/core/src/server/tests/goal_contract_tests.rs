use crate::server::{goal_state_from_record, GoalRecord};

#[test]
fn hydrates_legacy_condition_records() {
    let state = goal_state_from_record(Some(GoalRecord {
        condition: Some("  ship it  ".to_owned()),
        status: None,
        turns: 3,
        ..GoalRecord::default()
    }));
    assert_eq!(state.goal.as_deref(), Some("ship it"));
    assert_eq!(state.status.as_deref(), Some("active"));
    assert_eq!(state.turns, 3);
}

#[test]
fn preserves_paused_status_and_progress() {
    let state = goal_state_from_record(Some(GoalRecord {
        condition: Some("ship it".to_owned()),
        status: Some("paused".to_owned()),
        turns: 7,
        ..GoalRecord::default()
    }));
    assert_eq!(state.status.as_deref(), Some("paused"));
    assert_eq!(state.turns, 7);
}

#[test]
fn exposes_achieved_timestamp() {
    let state = goal_state_from_record(Some(GoalRecord {
        achieved_at: Some(42),
        condition: Some("ship it".to_owned()),
        status: Some("achieved".to_owned()),
        ..GoalRecord::default()
    }));
    assert_eq!(state.status.as_deref(), Some("achieved"));
    assert_eq!(state.achieved_at, Some(42));
}
