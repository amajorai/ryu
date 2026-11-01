// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! The semantic action ladder as a pure state machine.
//!
//! Rungs run in order until the first terminating outcome. Sync backends (macOS,
//! Windows) use [`run_chain`]; async code (Linux) loops over [`ChainState`] directly.

use std::ops::ControlFlow;
use std::time::Instant;

use serde_json::json;

use super::{ActionStep, StepOutcome};
use crate::contract::{Delivery, ErrorCode, GhostError};

#[derive(Debug)]
pub(crate) struct ChainResult {
    pub method: &'static str,
    pub outcome: StepOutcome,
    pub attempts: Vec<ActionStep>,
}

pub(crate) struct ChainState {
    deadline: Instant,
    attempts: Vec<ActionStep>,
    prior: Delivery,
    saw_without_effect: bool,
}

impl ChainState {
    pub fn new(deadline: Instant) -> Self {
        Self {
            deadline,
            attempts: Vec::new(),
            prior: Delivery::NotDelivered,
            saw_without_effect: false,
        }
    }

    fn methods(&self) -> Vec<&'static str> {
        self.attempts.iter().map(|a| a.method).collect()
    }

    /// `Err(TIMEOUT)` once the deadline has passed: `NotDelivered` if nothing was
    /// delivered yet, else `DeliveredUnverified`.
    pub fn before_step(&self) -> Result<(), GhostError> {
        if Instant::now() < self.deadline {
            return Ok(());
        }
        let delivery = if self.prior.maybe_delivered() {
            Delivery::DeliveredUnverified
        } else {
            Delivery::NotDelivered
        };
        Err(GhostError::timeout(
            "the action deadline passed before the next attempt",
            delivery,
        )
        .with_details(json!({ "attempts": self.methods() })))
    }

    /// `Break` when the chain ends (terminating outcome or `Err`); `Continue` to try
    /// the next rung.
    pub fn record(
        &mut self,
        method: &'static str,
        r: Result<StepOutcome, GhostError>,
    ) -> ControlFlow<Result<ChainResult, GhostError>> {
        match r {
            Ok(outcome) => {
                self.attempts.push(ActionStep { method, outcome });
                if outcome.terminates() {
                    return ControlFlow::Break(Ok(ChainResult {
                        method,
                        outcome,
                        attempts: std::mem::take(&mut self.attempts),
                    }));
                }
                if outcome == StepOutcome::DeliveredWithoutEffect {
                    self.saw_without_effect = true;
                    self.prior = Delivery::DeliveredUnverified;
                }
                ControlFlow::Continue(())
            }
            Err(e) => ControlFlow::Break(Err(e.after_delivery(self.prior))),
        }
    }

    /// Called when the rungs are exhausted.
    pub fn finish(self) -> Result<ChainResult, GhostError> {
        let details = json!({ "attempts": self.methods() });
        if self.saw_without_effect {
            Err(GhostError::new(
                ErrorCode::ActionFailed,
                "the action was delivered but had no observable effect",
            )
            .with_delivery(Delivery::DeliveredUnverified)
            .with_details(details))
        } else {
            Err(
                GhostError::not_supported("the element does not support this action")
                    .with_delivery(Delivery::NotDelivered)
                    .with_details(details),
            )
        }
    }
}

pub(crate) struct Rung<'a> {
    pub method: &'static str,
    pub run: Box<dyn FnMut() -> Result<StepOutcome, GhostError> + 'a>,
}

/// Sync wrapper over [`ChainState`].
pub(crate) fn run_chain(
    rungs: Vec<Rung<'_>>,
    deadline: Instant,
) -> Result<ChainResult, GhostError> {
    let mut state = ChainState::new(deadline);
    for mut rung in rungs {
        state.before_step()?;
        let r = (rung.run)();
        if let ControlFlow::Break(done) = state.record(rung.method, r) {
            return done;
        }
    }
    state.finish()
}
