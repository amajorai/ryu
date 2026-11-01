// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Pattern acquisition and element-state read-back for UIA actions.

use std::time::{Duration, Instant};

use ::windows::core::Interface;
use ::windows::Win32::UI::Accessibility::{
    ExpandCollapseState, ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded,
    ExpandCollapseState_LeafNode, ExpandCollapseState_PartiallyExpanded, IUIAutomationElement,
    IUIAutomationExpandCollapsePattern, IUIAutomationRangeValuePattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, ToggleState, ToggleState_Off,
    ToggleState_On, UIA_ExpandCollapsePatternId, UIA_RangeValuePatternId,
    UIA_SelectionItemPatternId, UIA_TogglePatternId, UIA_PATTERN_ID,
};

use super::super::ElementState;
use super::hresult::{is_unsupported_pattern, to_error, Phase};
use super::walk::read_value;
use crate::contract::GhostError;

/// `GetCurrentPatternAs::<T>`: `Ok(None)` when the pattern is unsupported (null
/// pointer or `E_NOINTERFACE`, checked before the HRESULT table), else the
/// classified error.
pub(crate) fn pattern<T: Interface>(
    el: &IUIAutomationElement,
    id: UIA_PATTERN_ID,
    method: &'static str,
) -> Result<Option<T>, GhostError> {
    // SAFETY: COM pattern acquisition on a live element of this thread's session.
    match unsafe { el.GetCurrentPatternAs::<T>(id) } {
        Ok(p) => Ok(Some(p)),
        Err(e) if is_unsupported_pattern(e.code().0) => Ok(None),
        Err(e) => match to_error(&e, method, Phase::Read) {
            e if e.code == crate::contract::ErrorCode::ActionNotSupported => Ok(None),
            e => Err(e),
        },
    }
}

/// Toggle state: `Some(true)` On, `Some(false)` Off, `None` Indeterminate.
pub(crate) type Toggle = Option<bool>;

pub(crate) fn toggle_of(state: ToggleState) -> Toggle {
    if state == ToggleState_On {
        Some(true)
    } else if state == ToggleState_Off {
        Some(false)
    } else {
        None
    }
}

/// The current toggle state, `Err(())` when it cannot be read.
pub(crate) fn read_toggle(p: &IUIAutomationTogglePattern) -> Result<Toggle, ()> {
    // SAFETY: COM property read.
    unsafe { p.CurrentToggleState() }
        .map(toggle_of)
        .map_err(|_| ())
}

/// Expanded state: `Some(true)` Expanded/PartiallyExpanded, `Some(false)`
/// Collapsed, `None` for LeafNode or unknown.
pub(crate) fn expanded_of(state: ExpandCollapseState) -> Option<bool> {
    if state == ExpandCollapseState_Expanded || state == ExpandCollapseState_PartiallyExpanded {
        Some(true)
    } else if state == ExpandCollapseState_Collapsed {
        Some(false)
    } else {
        None
    }
}

pub(crate) fn is_leaf(state: ExpandCollapseState) -> bool {
    state == ExpandCollapseState_LeafNode
}

pub(crate) fn read_expand_state(
    p: &IUIAutomationExpandCollapsePattern,
) -> Option<ExpandCollapseState> {
    // SAFETY: COM property read.
    unsafe { p.CurrentExpandCollapseState() }.ok()
}

pub(crate) fn read_selected(el: &IUIAutomationElement) -> Option<bool> {
    let p: IUIAutomationSelectionItemPattern =
        pattern(el, UIA_SelectionItemPatternId, "UIA.SelectionItem").ok()??;
    // SAFETY: COM property read.
    unsafe { p.CurrentIsSelected() }.ok().map(|b| b.as_bool())
}

pub(crate) fn read_focused(el: &IUIAutomationElement) -> Option<bool> {
    // SAFETY: COM property read.
    unsafe { el.CurrentHasKeyboardFocus() }
        .ok()
        .map(|b| b.as_bool())
}

/// The element's value as text: `ValuePattern`, else `RangeValuePattern`.
/// Never called for a secure element.
pub(crate) fn read_value_text(el: &IUIAutomationElement) -> Option<String> {
    if let Some(v) = read_value(el) {
        return Some(v);
    }
    let p: IUIAutomationRangeValuePattern =
        pattern(el, UIA_RangeValuePatternId, "UIA.RangeValue").ok()??;
    // SAFETY: COM property read.
    unsafe { p.CurrentValue() }.ok().map(|n| n.to_string())
}

/// Read-back primitives. `value` is `None` (and `secure` set) for a secure element.
pub(crate) fn read_state(el: &IUIAutomationElement, role_key: &str, secure: bool) -> ElementState {
    let checked = if role_key == "radiobutton" {
        read_selected(el)
    } else {
        pattern::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId, "UIA.Toggle")
            .ok()
            .flatten()
            .and_then(|p| read_toggle(&p).ok().flatten())
    };
    let expanded = pattern::<IUIAutomationExpandCollapsePattern>(
        el,
        UIA_ExpandCollapsePatternId,
        "UIA.ExpandCollapse",
    )
    .ok()
    .flatten()
    .and_then(|p| read_expand_state(&p))
    .and_then(expanded_of);
    let selected = if role_key == "radiobutton" {
        None
    } else {
        read_selected(el)
    };
    ElementState {
        checked,
        expanded,
        selected,
        focused: read_focused(el),
        value: if secure { None } else { read_value_text(el) },
        secure,
    }
}

/// Polls `probe` every `every` until it returns `Some(true)` or `within` elapses
/// (capped at `deadline`). Returns the last observation.
pub(crate) fn poll<F>(
    every: Duration,
    within: Duration,
    deadline: Instant,
    mut probe: F,
) -> Option<bool>
where
    F: FnMut() -> Option<bool>,
{
    let until = (Instant::now() + within).min(deadline);
    loop {
        let seen = probe();
        if seen == Some(true) || Instant::now() >= until {
            return seen;
        }
        std::thread::sleep(every.min(until.saturating_duration_since(Instant::now())));
    }
}
