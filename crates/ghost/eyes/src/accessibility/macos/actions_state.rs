//! State read-back, polling and value coercion for the macOS action chains.

use std::time::{Duration, Instant};

use super::super::{verify, AXTreeNode, ElementState};
use super::attr::*;
use super::ax_error::ReadBack;
use super::cf::{cf_kind, CfKind, CfRef};
use super::walk::{checked_from_value, has_checked_state, read_selected};
use crate::contract::GhostError;

/// Checked state from AXValue (checkbox, radio, switch, toggle button).
pub(crate) fn read_checked(el: &CfRef) -> Option<bool> {
    checked_from_value(attr_value_text(el, "AXValue").as_deref())
}

/// Expanded state: AXExpanded, then AXDisclosing, then a disclosure triangle's AXValue.
pub(crate) fn read_expanded(el: &CfRef, role_key: &str) -> Option<bool> {
    attr_bool(el, "AXExpanded")
        .or_else(|| attr_bool(el, "AXDisclosing"))
        .or_else(|| {
            if role_key == "disclosure" {
                read_checked(el)
            } else {
                None
            }
        })
}

/// Full read-back of one element's state. A secure value is never read.
pub(crate) fn read_state(el: &CfRef, node: &AXTreeNode) -> ElementState {
    let role_key = node.stable_role();
    let value = if node.secure {
        None
    } else {
        attr_value_text(el, "AXValue")
    };
    let checked = if has_checked_state(&role_key) {
        checked_from_value(value.as_deref())
    } else {
        None
    };
    ElementState {
        checked,
        expanded: read_expanded(el, &role_key),
        selected: read_selected(el, &role_key, value.as_deref()),
        focused: attr_bool(el, "AXFocused"),
        value,
        secure: node.secure,
    }
}

/// Polls `read` every `interval` for up to `window` (and never past `deadline`)
/// until it returns `Some(target)`; returns the last observation.
pub(crate) fn poll_state(
    deadline: Instant,
    interval: Duration,
    window: Duration,
    target: bool,
    mut read: impl FnMut() -> Option<bool>,
) -> Option<bool> {
    let until = deadline.min(Instant::now() + window);
    loop {
        let seen = read();
        if seen == Some(target) || Instant::now() + interval > until {
            return seen;
        }
        std::thread::sleep(interval);
    }
}

/// Maps a polled state to the effect of a write/press aimed at `target`:
/// reached => `Some(true)`, a known other state => `Some(false)`, unknown => `None`.
pub(crate) fn effect_of(seen: Option<bool>, target: bool) -> Option<bool> {
    seen.map(|s| s == target)
}

/// Read-back classification of a boolean state written towards `target`.
pub(crate) fn bool_readback(seen: Option<bool>, target: bool) -> ReadBack {
    match seen {
        Some(s) if s == target => ReadBack::Requested,
        Some(_) => ReadBack::Before,
        None => ReadBack::Unreadable,
    }
}

/// Whether the application's focus is on `el` or a descendant within 3 levels.
/// Every element read here gets its own messaging timeout from `deadline` (the
/// timeout does not propagate to elements an attribute returns); `None` once the
/// deadline has passed.
pub(crate) fn focus_reached(app: &CfRef, el: &CfRef, deadline: Instant) -> Option<bool> {
    if attr_bool(el, "AXFocused") == Some(true) {
        return Some(true);
    }
    let Some(mut cur) = attr_element(app, "AXFocusedUIElement") else {
        return attr_bool(el, "AXFocused");
    };
    for _ in 0..=3 {
        if el.equals(cur.as_ptr()) {
            return Some(true);
        }
        if !set_timeout(&cur, deadline) {
            return None;
        }
        match attr_element(&cur, "AXParent") {
            Some(parent) => cur = parent,
            None => break,
        }
    }
    Some(false)
}

/// Whether `el` currently has an AXMenu child. Each child gets a messaging timeout
/// from `deadline` before its role is read; false once the deadline has passed.
pub(crate) fn has_menu_child(el: &CfRef, deadline: Instant) -> bool {
    children(el)
        .iter()
        .flatten()
        .any(|c| set_timeout(c, deadline) && role(c).as_deref() == Some("AXMenu"))
}

/// The CF type of the element's current AXValue, which a write must match.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ValueKind {
    Number,
    Boolean,
    Text,
}

pub(crate) fn value_kind(el: &CfRef) -> ValueKind {
    match copy_attr(el, "AXValue") {
        Ok(v) => match unsafe { cf_kind(v.as_ptr()) } {
            CfKind::Number => ValueKind::Number,
            CfKind::Boolean => ValueKind::Boolean,
            CfKind::String | CfKind::Other => ValueKind::Text,
        },
        Err(_) => ValueKind::Text,
    }
}

/// A requested value coerced to the element's value type.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Coerced {
    Number(f64),
    Boolean(bool),
    Text(String),
}

/// "", "0", "false", "no", "off" (case-insensitive) are false; anything else is true.
pub(crate) fn truthy(input: &str) -> bool {
    !matches!(
        input.trim().to_ascii_lowercase().as_str(),
        "" | "0" | "false" | "no" | "off"
    )
}

/// Coerces `input` to `kind`; a non-numeric input for a numeric value is INVALID_ARGS.
pub(crate) fn coerce(kind: ValueKind, input: &str) -> Result<Coerced, GhostError> {
    match kind {
        ValueKind::Number => input
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .map(Coerced::Number)
            .ok_or_else(|| GhostError::invalid_args("this element takes a numeric value")),
        ValueKind::Boolean => Ok(Coerced::Boolean(truthy(input))),
        ValueKind::Text => Ok(Coerced::Text(input.to_string())),
    }
}

/// Whether an observed AXValue text equals the coerced request.
pub(crate) fn coerced_matches(role_key: &str, want: &Coerced, observed: &str) -> bool {
    match want {
        Coerced::Number(n) => observed
            .trim()
            .parse::<f64>()
            .is_ok_and(|o| (o - n).abs() <= 1e-6),
        Coerced::Boolean(b) => checked_from_value(Some(observed)) == Some(*b),
        Coerced::Text(s) => verify::value_matches(role_key, s, observed),
    }
}

/// Read-back classification of a value write.
pub(crate) fn value_readback(
    role_key: &str,
    want: &Coerced,
    before: Option<&str>,
    observed: Option<&str>,
) -> ReadBack {
    let Some(observed) = observed else {
        return ReadBack::Unreadable;
    };
    if coerced_matches(role_key, want, observed) {
        ReadBack::Requested
    } else if before.is_some_and(|b| verify::value_matches(role_key, b, observed)) {
        ReadBack::Before
    } else {
        ReadBack::Other
    }
}
