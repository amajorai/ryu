//! IUIAutomation tree walk (ControlViewWalker order).
//!
//! Children are never filtered: each child's index in `children` is its native
//! index under the control-view walker, so stored paths navigate back to it.

use ::windows::Win32::UI::Accessibility::{
    IUIAutomationElement, IUIAutomationValuePattern, UIA_ValuePatternId,
};

use super::super::limits::{TruncationCause, WalkBudget};
use super::super::{roles, AXTreeNode, Bounds};
use super::com::UiaSession;

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// The element's control-type id, if readable.
pub(crate) fn control_type(element: &IUIAutomationElement) -> Option<i32> {
    // SAFETY: COM property read on a live element of this thread's session.
    unsafe { element.CurrentControlType().ok().map(|t| t.0) }
}

/// The element's canonical role key.
pub(crate) fn role_key_of(element: &IUIAutomationElement) -> String {
    control_type(element)
        .map(roles::role_key_from_uia)
        .unwrap_or_else(|| "other".to_string())
}

/// Whether the element is a password field (fail-closed for editable roles).
pub(crate) fn is_secure(element: &IUIAutomationElement, role_key: &str) -> bool {
    // SAFETY: COM property read.
    let is_password = unsafe { element.CurrentIsPassword().ok().map(|b| b.as_bool()) };
    roles::is_secure_uia(is_password, role_key)
}

/// `ValuePattern.CurrentValue`, never read for a secure element.
pub(crate) fn read_value(element: &IUIAutomationElement) -> Option<String> {
    // SAFETY: COM pattern acquisition and property read.
    unsafe {
        let vp = element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .ok()?;
        vp.CurrentValue()
            .ok()
            .and_then(|s| non_empty(s.to_string()))
    }
}

/// Describes one element at depth 0 (no children), redacted.
pub(crate) fn describe(element: &IUIAutomationElement) -> AXTreeNode {
    // SAFETY: COM property reads on a live element; every failure has a default.
    unsafe {
        let role = element
            .CurrentLocalizedControlType()
            .map(|s| s.to_string())
            .unwrap_or_else(|_| "element".to_string());
        let role_key = role_key_of(element);
        let secure = is_secure(element, &role_key);
        let title = element
            .CurrentName()
            .ok()
            .and_then(|s| non_empty(s.to_string()));
        let value = if secure { None } else { read_value(element) };
        let identifier = element
            .CurrentAutomationId()
            .ok()
            .and_then(|s| non_empty(s.to_string()));
        let bounds = element.CurrentBoundingRectangle().ok().map(|r| Bounds {
            x: r.left,
            y: r.top,
            width: (r.right - r.left).unsigned_abs(),
            height: (r.bottom - r.top).unsigned_abs(),
        });
        let enabled = element
            .CurrentIsEnabled()
            .map(|b| b.as_bool())
            .unwrap_or(true);
        let focused = element
            .CurrentHasKeyboardFocus()
            .map(|b| b.as_bool())
            .unwrap_or(false);
        let hidden = element
            .CurrentIsOffscreen()
            .map(|b| b.as_bool())
            .unwrap_or(false);
        let mut node = AXTreeNode {
            role,
            title,
            value,
            identifier,
            bounds,
            enabled,
            focused,
            hidden,
            role_key: Some(role_key),
            secure,
            ..Default::default()
        };
        node.redact();
        node
    }
}

/// A null result (no child / no next sibling) arrives as an empty error with an
/// `S_OK` code and ends the list; any other error (a UIA timeout, an element that is
/// no longer available) leaves the children unread, so the node is truncated.
fn read_failure(e: &::windows::core::Error) -> Option<TruncationCause> {
    (!e.code().is_ok()).then_some(TruncationCause::ReadError)
}

/// Walks `element` and its descendants within `budget`'s limits.
pub(crate) fn walk_element(
    session: &UiaSession,
    element: &IUIAutomationElement,
    depth: u32,
    budget: &mut WalkBudget,
) -> AXTreeNode {
    budget.visit();
    let mut node = describe(element);
    let mut truncated: Option<TruncationCause> = None;
    // SAFETY: walker calls on live elements of this thread's session.
    let first = match unsafe { session.walker.GetFirstChildElement(element) } {
        Ok(first) => Some(first),
        Err(e) => {
            truncated = read_failure(&e);
            None
        }
    };
    if let Some(first) = first {
        if depth >= budget.limits.max_depth {
            truncated = Some(TruncationCause::Depth);
        } else {
            let mut current = first;
            loop {
                if node.children.len() >= budget.limits.max_children {
                    truncated = Some(TruncationCause::Siblings);
                    break;
                }
                if let Some(cause) = budget.exhausted() {
                    truncated = Some(cause);
                    break;
                }
                let child = walk_element(session, &current, depth + 1, budget);
                node.children.push(child);
                // SAFETY: as above.
                match unsafe { session.walker.GetNextSiblingElement(&current) } {
                    Ok(next) => current = next,
                    Err(e) => {
                        truncated = read_failure(&e);
                        break;
                    }
                }
            }
        }
    }
    if let Some(cause) = truncated {
        budget.truncate(&mut node, cause);
    }
    node
}
