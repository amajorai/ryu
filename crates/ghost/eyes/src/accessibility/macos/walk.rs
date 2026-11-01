//! Element description and the AXChildren tree walk.
//!
//! The walk never filters children: each child's index in `children` equals its
//! index in AXChildren. Each element gets its own messaging timeout before its IPC.

use super::super::limits::{TruncationCause, WalkBudget};
use super::super::{roles, AXTreeNode, ElementState};
use super::attr::*;
use super::cf::*;
use super::ffi::{AX_ATTRIBUTE_UNSUPPORTED, AX_CANNOT_COMPLETE, AX_NOT_IMPLEMENTED, AX_NO_VALUE};

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

/// Checked state from an AXValue: 0 => false, 1 => true, 2 (mixed) or other => unknown.
pub(crate) fn checked_from_value(text: Option<&str>) -> Option<bool> {
    match text?.trim() {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    }
}

pub(crate) fn has_checked_state(role_key: &str) -> bool {
    matches!(
        role_key,
        "checkbox" | "radiobutton" | "switch" | "togglebutton"
    )
}

pub(crate) fn has_expanded_state(role_key: &str) -> bool {
    matches!(role_key, "row" | "treeitem" | "disclosure" | "combobox")
}

pub(crate) fn has_selected_state(role_key: &str) -> bool {
    matches!(role_key, "row" | "cell" | "tab" | "listitem")
}

/// Selected state; tab buttons expose it as their AXValue.
pub(crate) fn read_selected(el: &CfRef, role_key: &str, value: Option<&str>) -> Option<bool> {
    attr_bool(el, "AXSelected").or_else(|| {
        if role_key == "tab" {
            checked_from_value(value)
        } else {
            None
        }
    })
}

/// Reads one element's attributes (no children). Secure values are never read.
pub(crate) fn describe(el: &CfRef) -> AXTreeNode {
    let role = role(el).unwrap_or_else(|| "AXUnknown".to_string());
    let subrole = non_empty(attr_string(el, "AXSubrole"));
    let role_key = roles::role_key_from_ax(&role, subrole.as_deref());
    let secure = roles::is_secure_ax(&role, subrole.as_deref());
    let title = non_empty(attr_string(el, "AXTitle"))
        .or_else(|| non_empty(attr_string(el, "AXDescription")));
    let value = if secure {
        None
    } else {
        attr_value_text(el, "AXValue")
    };
    let identifier = non_empty(attr_string(el, "AXIdentifier"));
    let native_id = non_empty(attr_string(el, "AXDOMIdentifier"));
    let enabled = attr_bool(el, "AXEnabled").unwrap_or(true);
    let focused = attr_bool(el, "AXFocused").unwrap_or(false);

    let checked = if has_checked_state(&role_key) {
        checked_from_value(value.as_deref())
    } else {
        None
    };
    let expanded = if has_expanded_state(&role_key) {
        attr_bool(el, "AXExpanded")
    } else {
        None
    };
    let selected = if has_selected_state(&role_key) {
        read_selected(el, &role_key, value.as_deref())
    } else {
        None
    };
    let states =
        (checked.is_some() || expanded.is_some() || selected.is_some() || focused).then(|| {
            ElementState {
                checked,
                expanded,
                selected,
                focused: Some(focused),
                value: value.clone(),
                secure,
            }
        });

    let mut node = AXTreeNode {
        role,
        title,
        value,
        identifier,
        bounds: bounds(el),
        children: Vec::new(),
        enabled,
        focused,
        hidden: false,
        subrole,
        role_key: Some(role_key),
        native_id,
        secure,
        subtree_truncated: false,
        states,
    };
    node.redact();
    node
}

fn child_count(el: &CfRef) -> i64 {
    children_array(el).map_or(0, |arr| unsafe {
        super::ffi::CFArrayGetCount(arr.as_ptr()).max(0)
    })
}

/// A placeholder for a child that could not be read, keeping native indices intact.
fn placeholder() -> AXTreeNode {
    AXTreeNode {
        role: "AXUnknown".to_string(),
        role_key: Some("unknown".to_string()),
        ..Default::default()
    }
}

/// The AXChildren of `el`. "No value" and "unsupported" are a leaf; any other
/// error (a timeout, a busy app, a failure) is a truncation, never a leaf.
fn read_children(el: &CfRef, budget: &WalkBudget) -> Result<Vec<Option<CfRef>>, TruncationCause> {
    match children_array(el) {
        Ok(arr) => Ok(unsafe { cf_array_items(arr.as_ptr()) }),
        Err(AX_NO_VALUE | AX_ATTRIBUTE_UNSUPPORTED | AX_NOT_IMPLEMENTED) => Ok(Vec::new()),
        Err(AX_CANNOT_COMPLETE) if std::time::Instant::now() >= budget.deadline => {
            Err(TruncationCause::Deadline)
        }
        Err(_) => Err(TruncationCause::ReadError),
    }
}

/// Walks `el` and its AXChildren within `budget`'s limits and deadline.
pub(crate) fn walk(el: &CfRef, depth: u32, budget: &mut WalkBudget) -> AXTreeNode {
    budget.visit();
    if !set_timeout(el, budget.deadline) {
        let mut node = placeholder();
        budget.truncate(&mut node, TruncationCause::Deadline);
        return node;
    }
    let mut node = describe(el);
    if depth >= budget.limits.max_depth {
        if child_count(el) > 0 {
            budget.truncate(&mut node, TruncationCause::Depth);
        }
        return node;
    }
    let items = match read_children(el, budget) {
        Ok(items) => items,
        Err(why) => {
            budget.truncate(&mut node, why);
            return node;
        }
    };
    let cap = budget.limits.max_children;
    let mut cause = None;
    for item in items.iter().take(cap) {
        if let Some(why) = budget.exhausted() {
            cause = Some(why);
            break;
        }
        let child = match item {
            Some(child) => walk(child, depth + 1, budget),
            None => {
                budget.visit();
                placeholder()
            }
        };
        node.children.push(child);
    }
    if items.len() > cap {
        budget.truncate(&mut node, TruncationCause::Siblings);
    }
    if let Some(why) = cause {
        budget.truncate(&mut node, why);
    }
    node
}
