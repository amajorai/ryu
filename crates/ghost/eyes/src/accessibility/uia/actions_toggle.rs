// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Toggle/check/uncheck and expand/collapse ladders over UIA patterns.

use std::time::{Duration, Instant};

use ::windows::Win32::UI::Accessibility::{
    ExpandCollapseState, ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded,
    IUIAutomationExpandCollapsePattern, IUIAutomationTogglePattern, UIA_ExpandCollapsePatternId,
    UIA_TogglePatternId,
};

use super::super::chain::{run_chain, ChainResult};
use super::super::{ElementAction, StepOutcome};
use super::actions::{
    call, invoke_rung, rung, select, Ctx, DeliveredUnverified, DeliveredVerified, NotDelivered,
    Satisfied, POLL_EVERY, SETTLE,
};
use super::actions_state::{is_leaf, pattern, poll, read_expand_state, read_toggle, Toggle};
use crate::contract::{Delivery, ErrorCode, GhostError};

const TOGGLE_SETTLE: Duration = Duration::from_millis(600);
const EXPAND_POLL: Duration = Duration::from_millis(20);

fn radio_uncheck() -> GhostError {
    GhostError::not_supported("a radio button cannot be unchecked; select another option")
}

fn no_effect() -> GhostError {
    GhostError::new(
        ErrorCode::ActionFailed,
        "the toggle state did not reach the requested state",
    )
    .with_delivery(Delivery::DeliveryUncertain)
}

/// Polls the toggle state until `reached` or the settle window ends. Returns
/// whether it was reached and whether Indeterminate was observed on the way.
fn watch(
    p: &IUIAutomationTogglePattern,
    deadline: Instant,
    reached: impl Fn(Toggle) -> bool,
) -> (bool, bool) {
    let until = (Instant::now() + TOGGLE_SETTLE).min(deadline);
    let mut saw_indeterminate = false;
    loop {
        if let Ok(state) = read_toggle(p) {
            if reached(state) {
                return (true, saw_indeterminate);
            }
            saw_indeterminate |= state.is_none();
        }
        if Instant::now() >= until {
            return (false, saw_indeterminate);
        }
        std::thread::sleep(POLL_EVERY.min(until.saturating_duration_since(Instant::now())));
    }
}

fn toggle_once(c: &Ctx<'_>, action: &ElementAction) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.Toggle";
    let Some(p) = pattern::<IUIAutomationTogglePattern>(c.el, UIA_TogglePatternId, M)? else {
        return Ok(NotDelivered);
    };
    let current = read_toggle(&p).ok();
    let target: Option<bool> = match action {
        ElementAction::Check => Some(true),
        ElementAction::Uncheck => Some(false),
        _ => current.flatten().map(|on| !on),
    };
    if target.is_some() && current == Some(target) {
        return Ok(Satisfied);
    }
    // SAFETY: COM call on a live pattern.
    if !call(unsafe { p.Toggle() }, M)? {
        return Ok(NotDelivered);
    }
    if !c.verify {
        return Ok(DeliveredUnverified);
    }
    let reached = |s: Toggle| match target {
        Some(t) => s == Some(t),
        None => current.is_some() && Some(s) != current,
    };
    let (ok, saw_indeterminate) = watch(&p, c.deadline, reached);
    if ok {
        return Ok(DeliveredVerified);
    }
    // A tri-state control can pass through Indeterminate: toggle once more, only then.
    if target.is_some() && saw_indeterminate {
        // SAFETY: as above.
        if call(unsafe { p.Toggle() }, M)? && watch(&p, c.deadline, reached).0 {
            return Ok(DeliveredVerified);
        }
    }
    Err(no_effect())
}

/// Toggle, Check and Uncheck.
pub(crate) fn toggle(c: &Ctx<'_>, action: &ElementAction) -> Result<ChainResult, GhostError> {
    if c.role == "radiobutton" {
        let selected = c.before.checked == Some(true);
        let unselect = match action {
            ElementAction::Uncheck => true,
            ElementAction::Toggle => selected,
            _ => false,
        };
        if unselect {
            return Err(radio_uncheck());
        }
        let rungs = vec![rung("UIA.SelectionItem.Select", || {
            select(c, StepOutcome::DeliveredWithoutEffect, true)
        })];
        return run_chain(rungs, c.deadline);
    }
    run_chain(
        vec![rung("UIA.Toggle", || toggle_once(c, action))],
        c.deadline,
    )
}

fn at_target(state: ExpandCollapseState, expand: bool) -> bool {
    if expand {
        state == ExpandCollapseState_Expanded
    } else {
        state == ExpandCollapseState_Collapsed
    }
}

/// The known opposite of the target (PartiallyExpanded counts as expanded).
fn known_opposite(state: ExpandCollapseState, expand: bool) -> bool {
    if expand {
        state == ExpandCollapseState_Collapsed
    } else {
        !is_leaf(state) && state != ExpandCollapseState_Collapsed
    }
}

/// Polls every 20 ms for up to 300 ms; a delivered call with no visible effect is
/// `DeliveredWithoutEffect`, so the ladder moves on.
fn verify_expand(c: &Ctx<'_>, reached: impl FnMut() -> Option<bool>) -> StepOutcome {
    if !c.verify {
        return DeliveredUnverified;
    }
    match poll(EXPAND_POLL, SETTLE, c.deadline, reached) {
        Some(true) => DeliveredVerified,
        _ => StepOutcome::DeliveredWithoutEffect,
    }
}

/// Expand and Collapse: the pattern, then Invoke only from the known opposite state.
pub(crate) fn expand_collapse(c: &Ctx<'_>, expand: bool) -> Result<ChainResult, GhostError> {
    let method: &'static str = if expand {
        "UIA.ExpandCollapse.Expand"
    } else {
        "UIA.ExpandCollapse.Collapse"
    };
    let p =
        pattern::<IUIAutomationExpandCollapsePattern>(c.el, UIA_ExpandCollapsePatternId, method)?;
    let state = p.as_ref().and_then(read_expand_state);
    if state.is_some_and(is_leaf) {
        return Err(GhostError::not_supported(
            "the element has nothing to expand or collapse",
        ));
    }
    if state.is_some_and(|s| at_target(s, expand)) {
        return run_chain(vec![rung(method, || Ok(Satisfied))], c.deadline);
    }
    let reached = || {
        p.as_ref()
            .and_then(read_expand_state)
            .map(|s| at_target(s, expand))
    };
    let pattern_rung = rung(method, || {
        let Some(pat) = p.as_ref() else {
            return Ok(NotDelivered);
        };
        // SAFETY: COM calls on a live pattern.
        let sent = call(
            unsafe {
                if expand {
                    pat.Expand()
                } else {
                    pat.Collapse()
                }
            },
            method,
        )?;
        if !sent {
            return Ok(NotDelivered);
        }
        Ok(verify_expand(c, reached))
    });
    let invoke = rung("UIA.Invoke", || {
        let fresh = p.as_ref().and_then(read_expand_state);
        if !fresh.is_some_and(|s| known_opposite(s, expand)) {
            return Ok(NotDelivered);
        }
        match invoke_rung(c)? {
            DeliveredUnverified => Ok(verify_expand(c, reached)),
            other => Ok(other),
        }
    });
    run_chain(vec![pattern_rung, invoke], c.deadline)
}
