// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Semantic element actions over UI Automation patterns. Never synthesizes input.
//!
//! Each action is a ladder of rungs run through `run_chain`; a pattern the element
//! does not support is `NotDelivered`, so the ladder falls through to the next rung.

use std::time::{Duration, Instant};

use ::windows::Win32::UI::Accessibility::{
    IUIAutomationElement, IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern,
    IUIAutomationLegacyIAccessiblePattern, IUIAutomationScrollItemPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, UIA_ExpandCollapsePatternId,
    UIA_InvokePatternId, UIA_LegacyIAccessiblePatternId, UIA_ScrollItemPatternId,
    UIA_SelectionItemPatternId, UIA_TogglePatternId,
};

use super::super::chain::{run_chain, ChainResult, Rung};
use super::super::{
    ActionOptions, ActionOutcome, ElementAction, ElementLocator, ElementState, RendererA11y,
    StepOutcome, Verification, VerificationScope,
};
use super::actions_state::{pattern, poll, read_focused, read_selected, read_state, read_toggle};
use super::com::UiaSession;
use super::hresult::{classify, Phase};
use super::nav::resolve_live;
use super::{actions_toggle, actions_value};
use crate::contract::GhostError;

pub(crate) use StepOutcome::{DeliveredUnverified, DeliveredVerified, NotDelivered, Satisfied};

/// Everything a rung needs about the resolved target.
pub(crate) struct Ctx<'a> {
    pub el: &'a IUIAutomationElement,
    pub role: &'a str,
    pub secure: bool,
    pub verify: bool,
    pub deadline: Instant,
    pub before: &'a ElementState,
}

/// Interval and window for read-back polling.
pub(crate) const POLL_EVERY: Duration = Duration::from_millis(25);
pub(crate) const SETTLE: Duration = Duration::from_millis(300);

/// Runs a mutating pattern call: `Ok(true)` delivered, `Ok(false)` unsupported
/// (`UIA_E_NOTSUPPORTED`, falls through), `Err` per the HRESULT table.
pub(crate) fn call(
    r: ::windows::core::Result<()>,
    method: &'static str,
) -> Result<bool, GhostError> {
    match r {
        Ok(()) => Ok(true),
        Err(e) => classify(&e, method, Phase::Act).map(|_| false),
    }
}

pub(crate) fn rung<'a>(
    method: &'static str,
    run: impl FnMut() -> Result<StepOutcome, GhostError> + 'a,
) -> Rung<'a> {
    Rung {
        method,
        run: Box::new(run),
    }
}

/// Verified when `probe` turns true within the settle window, else `otherwise`.
pub(crate) fn settle(
    c: &Ctx<'_>,
    within: Duration,
    otherwise: StepOutcome,
    probe: impl FnMut() -> Option<bool>,
) -> StepOutcome {
    if !c.verify {
        return DeliveredUnverified;
    }
    match poll(POLL_EVERY, within, c.deadline, probe) {
        Some(true) => DeliveredVerified,
        _ => otherwise,
    }
}

fn invoke(c: &Ctx<'_>) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.Invoke";
    let Some(p) = pattern::<IUIAutomationInvokePattern>(c.el, UIA_InvokePatternId, M)? else {
        return Ok(NotDelivered);
    };
    // SAFETY: COM call on a live pattern of this thread's session.
    Ok(if call(unsafe { p.Invoke() }, M)? {
        DeliveredUnverified
    } else {
        NotDelivered
    })
}

/// `Invoke`, exposed for the expand/collapse ladder.
pub(crate) fn invoke_rung(c: &Ctx<'_>) -> Result<StepOutcome, GhostError> {
    invoke(c)
}

fn legacy_default(c: &Ctx<'_>) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.LegacyIAccessible.DoDefaultAction";
    let Some(p) =
        pattern::<IUIAutomationLegacyIAccessiblePattern>(c.el, UIA_LegacyIAccessiblePatternId, M)?
    else {
        return Ok(NotDelivered);
    };
    // SAFETY: COM calls on a live pattern.
    let action = unsafe { p.CurrentDefaultAction() }
        .map(|s| s.to_string())
        .unwrap_or_default();
    if action.trim().is_empty() {
        return Ok(NotDelivered);
    }
    Ok(if call(unsafe { p.DoDefaultAction() }, M)? {
        DeliveredUnverified
    } else {
        NotDelivered
    })
}

/// SelectionItem.Select, verified by `CurrentIsSelected`; `miss` when it stays false.
/// With `stateful`, an already-selected element is `Satisfied` and nothing is sent.
pub(crate) fn select(
    c: &Ctx<'_>,
    miss: StepOutcome,
    stateful: bool,
) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.SelectionItem.Select";
    let Some(p) =
        pattern::<IUIAutomationSelectionItemPattern>(c.el, UIA_SelectionItemPatternId, M)?
    else {
        return Ok(NotDelivered);
    };
    if stateful && read_selected(c.el) == Some(true) {
        return Ok(Satisfied);
    }
    // SAFETY: COM call on a live pattern.
    if !call(unsafe { p.Select() }, M)? {
        return Ok(NotDelivered);
    }
    Ok(settle(c, SETTLE, miss, || read_selected(c.el)))
}

fn press_select(c: &Ctx<'_>) -> Result<StepOutcome, GhostError> {
    if !matches!(c.role, "listitem" | "tab" | "treeitem") {
        return Ok(NotDelivered);
    }
    select(c, DeliveredUnverified, false)
}

fn press_toggle(c: &Ctx<'_>) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.Toggle";
    let Some(p) = pattern::<IUIAutomationTogglePattern>(c.el, UIA_TogglePatternId, M)? else {
        return Ok(NotDelivered);
    };
    let before = read_toggle(&p);
    // SAFETY: COM call on a live pattern.
    if !call(unsafe { p.Toggle() }, M)? {
        return Ok(NotDelivered);
    }
    Ok(settle(c, SETTLE, DeliveredUnverified, || {
        Some(before.is_ok() && read_toggle(&p) != before)
    }))
}

fn focus(c: &Ctx<'_>) -> Result<StepOutcome, GhostError> {
    if c.before.focused == Some(true) {
        return Ok(Satisfied);
    }
    // SAFETY: COM call on a live element.
    if !call(unsafe { c.el.SetFocus() }, "UIA.SetFocus")? {
        return Ok(NotDelivered);
    }
    Ok(settle(c, SETTLE, DeliveredUnverified, || {
        read_focused(c.el)
    }))
}

fn scroll_into_view(c: &Ctx<'_>) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.ScrollItem.ScrollIntoView";
    let Some(p) = pattern::<IUIAutomationScrollItemPattern>(c.el, UIA_ScrollItemPatternId, M)?
    else {
        return Ok(NotDelivered);
    };
    // SAFETY: COM call on a live pattern.
    Ok(if call(unsafe { p.ScrollIntoView() }, M)? {
        DeliveredUnverified
    } else {
        NotDelivered
    })
}

fn show_menu(c: &Ctx<'_>) -> Result<StepOutcome, GhostError> {
    const M: &str = "UIA.ExpandCollapse.Expand";
    let Some(p) =
        pattern::<IUIAutomationExpandCollapsePattern>(c.el, UIA_ExpandCollapsePatternId, M)?
    else {
        return Ok(NotDelivered);
    };
    // SAFETY: COM call on a live pattern.
    if !call(unsafe { p.Expand() }, M)? {
        return Ok(NotDelivered);
    }
    Ok(settle(
        c,
        Duration::from_millis(600),
        DeliveredUnverified,
        || super::actions_state::read_expand_state(&p).and_then(super::actions_state::expanded_of),
    ))
}

fn chain_for(c: &Ctx<'_>, action: &ElementAction) -> Result<ChainResult, GhostError> {
    let rungs = match action {
        ElementAction::Press => vec![
            rung("UIA.Invoke", || invoke(c)),
            rung("UIA.LegacyIAccessible.DoDefaultAction", || {
                legacy_default(c)
            }),
            rung("UIA.SelectionItem.Select", || press_select(c)),
            rung("UIA.Toggle", || press_toggle(c)),
        ],
        ElementAction::Focus => vec![rung("UIA.SetFocus", || focus(c))],
        ElementAction::SetValue(text) => return actions_value::set_value(c, text),
        ElementAction::Toggle | ElementAction::Check | ElementAction::Uncheck => {
            return actions_toggle::toggle(c, action)
        }
        ElementAction::Expand | ElementAction::Collapse => {
            return actions_toggle::expand_collapse(c, matches!(action, ElementAction::Expand))
        }
        ElementAction::Select => vec![rung("UIA.SelectionItem.Select", || {
            select(c, StepOutcome::DeliveredWithoutEffect, true)
        })],
        ElementAction::ScrollIntoView => {
            vec![rung("UIA.ScrollItem.ScrollIntoView", || {
                scroll_into_view(c)
            })]
        }
        ElementAction::ShowMenu => {
            if !matches!(c.role, "menuitem" | "button" | "popupbutton") {
                return Err(GhostError::not_supported(
                    "show_menu is supported only on menu items and buttons",
                ));
            }
            vec![rung("UIA.ExpandCollapse.Expand", || show_menu(c))]
        }
    };
    run_chain(rungs, c.deadline)
}

fn verification_for(action: &ElementAction, outcome: StepOutcome, c: &Ctx<'_>) -> Verification {
    let (scope, reason) = if outcome == Satisfied {
        (VerificationScope::AlreadyInState, None)
    } else if !c.verify {
        (VerificationScope::Skipped, Some("not_requested"))
    } else if matches!(action, ElementAction::SetValue(_)) && c.secure {
        (VerificationScope::Unavailable, Some("secure_field"))
    } else if outcome == DeliveredVerified {
        match action {
            ElementAction::SetValue(_) => (VerificationScope::ElementValue, None),
            _ => (VerificationScope::ElementState, None),
        }
    } else if !action.is_stateful() {
        (VerificationScope::Unavailable, Some("not_stateful"))
    } else {
        (
            VerificationScope::Unavailable,
            Some("insufficient_evidence"),
        )
    };
    Verification { scope, reason }
}

/// Resolves `locator` and performs `action` on this thread's session.
pub(crate) fn perform_sync(
    session: &UiaSession,
    locator: &ElementLocator,
    action: &ElementAction,
    opts: &ActionOptions,
    deadline: Instant,
) -> Result<ActionOutcome, GhostError> {
    let live = resolve_live(session, locator, deadline)?;
    let role = live.resolved.node.stable_role();
    let before = live.resolved.state.clone();
    let c = Ctx {
        el: &live.element,
        role: &role,
        secure: live.resolved.node.secure,
        verify: opts.verify,
        deadline,
        before: &before,
    };
    let result = chain_for(&c, action)?;
    let verification = verification_for(action, result.outcome, &c);
    let after = opts
        .verify
        .then(|| read_state(&live.element, &role, c.secure));
    Ok(ActionOutcome {
        action: action.name(),
        method: result.method,
        delivery: result.outcome.delivery(),
        verification,
        attempts: result.attempts,
        element: live.resolved,
        before: Some(before),
        after,
        renderer: RendererA11y::NotApplicable,
    })
}
