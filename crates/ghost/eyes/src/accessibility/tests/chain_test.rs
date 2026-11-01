use std::ops::ControlFlow;
use std::time::{Duration, Instant};

use super::super::chain::{run_chain, ChainState, Rung};
use super::super::StepOutcome;
use crate::contract::{Delivery, ErrorCode, GhostError};

fn later() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

fn rung(method: &'static str, r: Result<StepOutcome, GhostError>) -> Rung<'static> {
    Rung {
        method,
        run: Box::new(move || r.clone()),
    }
}

#[test]
fn stops_at_first_terminating_outcome() {
    let mut third_ran = false;
    let rungs = vec![
        rung("a", Ok(StepOutcome::NotDelivered)),
        rung("b", Ok(StepOutcome::DeliveredVerified)),
        Rung {
            method: "c",
            run: Box::new(|| {
                third_ran = true;
                Ok(StepOutcome::DeliveredVerified)
            }),
        },
    ];
    let r = run_chain(rungs, later()).expect("ok");
    assert_eq!(r.method, "b");
    assert_eq!(r.outcome, StepOutcome::DeliveredVerified);
    assert_eq!(r.attempts.len(), 2);
    assert!(!third_ran);
}

#[test]
fn satisfied_terminates() {
    let r = run_chain(vec![rung("a", Ok(StepOutcome::Satisfied))], later()).expect("ok");
    assert_eq!(r.outcome, StepOutcome::Satisfied);
    assert_eq!(r.outcome.delivery(), Delivery::NotDelivered);
}

#[test]
fn falls_through_on_delivered_without_effect() {
    let rungs = vec![
        rung("a", Ok(StepOutcome::DeliveredWithoutEffect)),
        rung("b", Ok(StepOutcome::DeliveredUnverified)),
    ];
    let r = run_chain(rungs, later()).expect("ok");
    assert_eq!(r.method, "b");
    assert_eq!(r.attempts.len(), 2);
}

#[test]
fn error_after_delivery_is_upgraded() {
    let rungs = vec![
        rung("a", Ok(StepOutcome::DeliveredWithoutEffect)),
        rung("b", Err(GhostError::not_found("gone"))),
    ];
    let err = run_chain(rungs, later()).expect_err("err");
    assert_eq!(err.code, ErrorCode::ElementNotFound);
    assert_eq!(err.delivery, Delivery::DeliveredUnverified);
}

#[test]
fn error_before_delivery_keeps_its_delivery() {
    let rungs = vec![
        rung("a", Ok(StepOutcome::NotDelivered)),
        rung("b", Err(GhostError::not_found("gone"))),
    ];
    let err = run_chain(rungs, later()).expect_err("err");
    assert_eq!(err.delivery, Delivery::NotDelivered);
}

#[test]
fn exhaustion_with_nothing_delivered_is_not_supported() {
    let rungs = vec![
        rung("a", Ok(StepOutcome::NotDelivered)),
        rung("b", Ok(StepOutcome::NotDelivered)),
    ];
    let err = run_chain(rungs, later()).expect_err("err");
    assert_eq!(err.code, ErrorCode::ActionNotSupported);
    assert_eq!(err.delivery, Delivery::NotDelivered);
    assert_eq!(
        err.details.unwrap()["attempts"],
        serde_json::json!(["a", "b"])
    );
}

#[test]
fn exhaustion_after_without_effect_is_action_failed() {
    let rungs = vec![
        rung("a", Ok(StepOutcome::DeliveredWithoutEffect)),
        rung("b", Ok(StepOutcome::NotDelivered)),
    ];
    let err = run_chain(rungs, later()).expect_err("err");
    assert_eq!(err.code, ErrorCode::ActionFailed);
    assert_eq!(err.delivery, Delivery::DeliveredUnverified);
}

#[test]
fn passed_deadline_times_out_without_running() {
    let mut ran = false;
    let rungs = vec![Rung {
        method: "a",
        run: Box::new(|| {
            ran = true;
            Ok(StepOutcome::DeliveredVerified)
        }),
    }];
    let err = run_chain(rungs, Instant::now()).expect_err("timeout");
    assert_eq!(err.code, ErrorCode::Timeout);
    assert_eq!(err.delivery, Delivery::NotDelivered);
    assert!(!ran);
}

#[test]
fn deadline_after_delivery_is_delivered_unverified() {
    let mut state = ChainState::new(Instant::now() + Duration::from_millis(30));
    assert!(state.before_step().is_ok());
    let flow = state.record("a", Ok(StepOutcome::DeliveredWithoutEffect));
    assert!(matches!(flow, ControlFlow::Continue(())));
    std::thread::sleep(Duration::from_millis(40));
    let err = state.before_step().expect_err("timeout");
    assert_eq!(err.code, ErrorCode::Timeout);
    assert_eq!(err.delivery, Delivery::DeliveredUnverified);
}
