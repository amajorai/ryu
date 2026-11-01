// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! SetValue ladder: ValuePattern, then RangeValuePattern, then LegacyIAccessible.
//!
//! The requested text is never logged or put into an error; read-back is skipped
//! for password fields.

use ::windows::core::{BSTR, HSTRING, PCWSTR};
use ::windows::Win32::UI::Accessibility::{
    IUIAutomationLegacyIAccessiblePattern, IUIAutomationRangeValuePattern,
    IUIAutomationValuePattern, UIA_LegacyIAccessiblePatternId, UIA_RangeValuePatternId,
    UIA_ValuePatternId,
};

use super::super::chain::{run_chain, ChainResult};
use super::super::verify::value_matches;
use super::super::StepOutcome;
use super::actions::{call, rung, Ctx, DeliveredUnverified, NotDelivered, POLL_EVERY, SETTLE};
use super::actions_state::{pattern, poll, read_value_text};
use crate::contract::GhostError;

/// Decides a delivered write by reading the value back.
fn read_back(c: &Ctx<'_>, expected: &str) -> StepOutcome {
    if c.secure || !c.verify {
        return DeliveredUnverified;
    }
    let mut last: Option<String> = None;
    let seen = poll(POLL_EVERY, SETTLE, c.deadline, || {
        last = read_value_text(c.el);
        last.as_deref().map(|v| value_matches(c.role, expected, v))
    });
    if seen == Some(true) {
        return StepOutcome::DeliveredVerified;
    }
    let before = c.before.value.as_deref();
    let before_was_target = before.is_some_and(|b| value_matches(c.role, expected, b));
    if !before_was_target && last.as_deref() == before {
        StepOutcome::DeliveredWithoutEffect
    } else {
        DeliveredUnverified
    }
}

fn value_pattern(c: &Ctx<'_>, text: &str) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.Value.SetValue";
    let Some(p) = pattern::<IUIAutomationValuePattern>(c.el, UIA_ValuePatternId, M)? else {
        return Ok(NotDelivered);
    };
    // SAFETY: COM calls on a live pattern of this thread's session.
    if unsafe { p.CurrentIsReadOnly() }.is_ok_and(|b| b.as_bool()) {
        return Ok(NotDelivered);
    }
    if !call(unsafe { p.SetValue(&BSTR::from(text)) }, M)? {
        return Ok(NotDelivered);
    }
    Ok(read_back(c, text))
}

fn range_pattern(c: &Ctx<'_>, text: &str) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.RangeValue.SetValue";
    let Some(number) = text.trim().parse::<f64>().ok().filter(|n| n.is_finite()) else {
        return Ok(NotDelivered);
    };
    let Some(p) = pattern::<IUIAutomationRangeValuePattern>(c.el, UIA_RangeValuePatternId, M)?
    else {
        return Ok(NotDelivered);
    };
    // SAFETY: COM calls on a live pattern.
    if unsafe { p.CurrentIsReadOnly() }.is_ok_and(|b| b.as_bool()) {
        return Ok(NotDelivered);
    }
    if !call(unsafe { p.SetValue(number) }, M)? {
        return Ok(NotDelivered);
    }
    Ok(read_back(c, text))
}

fn legacy_pattern(c: &Ctx<'_>, text: &str) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.LegacyIAccessible.SetValue";
    let Some(p) =
        pattern::<IUIAutomationLegacyIAccessiblePattern>(c.el, UIA_LegacyIAccessiblePatternId, M)?
    else {
        return Ok(NotDelivered);
    };
    let wide = HSTRING::from(text);
    // SAFETY: `wide` outlives the call; COM call on a live pattern.
    if !call(unsafe { p.SetValue(PCWSTR(wide.as_ptr())) }, M)? {
        return Ok(NotDelivered);
    }
    Ok(read_back(c, text))
}

/// SetValue: Value (not read-only) → RangeValue (finite number, not read-only) →
/// LegacyIAccessible.
pub(crate) fn set_value(c: &Ctx<'_>, text: &str) -> Result<ChainResult, GhostError> {
    let rungs = vec![
        rung("UIA.Value.SetValue", || value_pattern(c, text)),
        rung("UIA.RangeValue.SetValue", || range_pattern(c, text)),
        rung("UIA.LegacyIAccessible.SetValue", || legacy_pattern(c, text)),
    ];
    run_chain(rungs, c.deadline)
}
