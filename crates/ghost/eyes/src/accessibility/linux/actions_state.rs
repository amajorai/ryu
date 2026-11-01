// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Pure action planning for the AT-SPI backend (verb tables, rung plans, the
//! SetValue read-back verdict) plus the state reads the ladders poll.

use ::atspi::zbus;
use ::atspi::{ObjectRefOwned, State, StateSet};

use super::super::verify::value_matches;
use super::super::{ElementAction, ElementState, StepOutcome};
use super::at_spi::{element_state, read_value, value_source, ValueSource, MAX_TEXT_CHARS};
use super::conn::{accessible, within};
use crate::contract::GhostError;

/// An AT-SPI action name and the method label reported for it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Verb {
    pub name: &'static str,
    pub method: &'static str,
}

macro_rules! verbs {
    ($($name:literal),+ $(,)?) => {
        &[$(Verb { name: $name, method: concat!("atspi.action:", $name) }),+]
    };
}

pub(crate) const PRESS: &[Verb] = verbs!["click", "press", "activate", "open", "jump"];
pub(crate) const CHECK: &[Verb] = verbs!["check", "toggle", "switch", "click"];
pub(crate) const CHECK_ONLY: &[Verb] = verbs!["check"];
pub(crate) const UNCHECK: &[Verb] = verbs!["uncheck", "toggle", "switch", "click"];
pub(crate) const UNCHECK_ONLY: &[Verb] = verbs!["uncheck"];
pub(crate) const TOGGLE: &[Verb] = verbs!["toggle", "switch", "click"];
pub(crate) const EXPAND: &[Verb] = verbs!["listitem.toggle-expand", "expand", "click", "activate"];
pub(crate) const EXPAND_ONLY: &[Verb] = verbs!["expand"];
pub(crate) const COLLAPSE: &[Verb] =
    verbs!["listitem.toggle-expand", "collapse", "click", "activate"];
pub(crate) const COLLAPSE_ONLY: &[Verb] = verbs!["collapse"];
pub(crate) const SHOW_MENU: &[Verb] = verbs!["showContextMenu", "menu", "ShowMenu", "menu.popup"];
pub(crate) const SELECT: &[Verb] = verbs!["select"];

/// The first verb (in table order) the element exposes, matched case-insensitively,
/// with the element's action index.
pub(crate) fn pick_verb(names: &[String], verbs: &'static [Verb]) -> Option<(i32, &'static Verb)> {
    verbs.iter().find_map(|verb| {
        let pos = names
            .iter()
            .position(|n| n.eq_ignore_ascii_case(verb.name))?;
        Some((i32::try_from(pos).ok()?, verb))
    })
}

/// The state a delivered verb must produce to count as verified.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Expect {
    Nothing,
    Checked(bool),
    Expanded(bool),
    Selected,
}

/// One rung of an action ladder.
#[derive(Debug, PartialEq)]
pub(crate) enum Rung {
    /// Already in the requested state: nothing is sent.
    Already,
    Verb {
        verbs: &'static [Verb],
        expect: Expect,
    },
    GrabFocus,
    SetText,
    SetNumber,
    /// The parent's `Selection.SelectChild`; `stateful` makes a miss `DeliveredWithoutEffect`.
    SelectChild {
        stateful: bool,
    },
    ScrollTo,
}

pub(crate) fn is_numeric_role(role: &str) -> bool {
    matches!(role, "slider" | "spinbutton" | "scrollbar" | "progressbar")
}

/// The request already holds: the (non-secure) before value equals it.
pub(crate) fn already_set(role: &str, requested: &str, before: Option<&str>, secure: bool) -> bool {
    !secure && before.is_some_and(|b| value_matches(role, requested, b))
}

/// Judges a delivered write by its read-back: equal to the request is verified;
/// unchanged from a different before value means the write was ignored.
pub(crate) fn write_verdict(
    role: &str,
    requested: &str,
    before: Option<&str>,
    after: Option<&str>,
) -> StepOutcome {
    match after {
        Some(a) if value_matches(role, requested, a) => StepOutcome::DeliveredVerified,
        Some(a) if before.is_some_and(|b| b == a && !value_matches(role, requested, b)) => {
            StepOutcome::DeliveredWithoutEffect
        }
        _ => StepOutcome::DeliveredUnverified,
    }
}

fn not_supported(msg: &str) -> GhostError {
    GhostError::not_supported(msg)
}

fn check_plan(target: bool, before: &ElementState) -> Vec<Rung> {
    if before.checked == Some(target) {
        return vec![Rung::Already];
    }
    // Relative verbs (toggle/switch/click) are safe only from a known state.
    let verbs = match (target, before.checked.is_some()) {
        (true, true) => CHECK,
        (true, false) => CHECK_ONLY,
        (false, true) => UNCHECK,
        (false, false) => UNCHECK_ONLY,
    };
    vec![Rung::Verb {
        verbs,
        expect: Expect::Checked(target),
    }]
}

fn expand_plan(target: bool, before: &ElementState) -> Vec<Rung> {
    if before.expanded == Some(target) {
        return vec![Rung::Already];
    }
    let verbs = match (target, before.expanded == Some(!target)) {
        (true, true) => EXPAND,
        (true, false) => EXPAND_ONLY,
        (false, true) => COLLAPSE,
        (false, false) => COLLAPSE_ONLY,
    };
    vec![Rung::Verb {
        verbs,
        expect: Expect::Expanded(target),
    }]
}

fn set_value_plan(
    requested: &str,
    role: &str,
    before: &ElementState,
    states: StateSet,
    secure: bool,
) -> Result<Vec<Rung>, GhostError> {
    let numeric = is_numeric_role(role);
    if states.contains(State::ReadOnly) {
        return Err(not_supported("the element is read-only"));
    }
    if !numeric && !states.contains(State::Editable) {
        return Err(not_supported("the element is not editable"));
    }
    if already_set(role, requested, before.value.as_deref(), secure) {
        return Ok(vec![Rung::Already]);
    }
    Ok(if numeric {
        vec![Rung::SetNumber, Rung::SetText]
    } else {
        vec![Rung::SetText, Rung::SetNumber]
    })
}

/// The ladder for `action` on an element in `before`/`states`. Refusals (read-only
/// writes, unknown toggle state, unchecking a radio button) are errors here.
pub(crate) fn plan(
    action: &ElementAction,
    role: &str,
    before: &ElementState,
    states: StateSet,
    secure: bool,
) -> Result<Vec<Rung>, GhostError> {
    let radio = role == "radiobutton";
    let rungs = match action {
        ElementAction::Press => {
            let mut rungs = vec![Rung::Verb {
                verbs: PRESS,
                expect: Expect::Nothing,
            }];
            if matches!(role, "listitem" | "tab" | "treeitem") {
                rungs.push(Rung::SelectChild { stateful: false });
            }
            rungs
        }
        ElementAction::Focus if before.focused == Some(true) => vec![Rung::Already],
        ElementAction::Focus => vec![Rung::GrabFocus],
        ElementAction::SetValue(v) => return set_value_plan(v, role, before, states, secure),
        ElementAction::Uncheck if radio && before.checked != Some(false) => {
            return Err(not_supported(
                "a radio button cannot be unchecked; select another option",
            ))
        }
        ElementAction::Toggle if radio && before.checked == Some(true) => {
            return Err(not_supported(
                "a radio button cannot be unchecked; select another option",
            ))
        }
        ElementAction::Toggle if radio => check_plan(true, before),
        ElementAction::Toggle => match before.checked {
            Some(on) if !states.contains(State::Indeterminate) => vec![Rung::Verb {
                verbs: TOGGLE,
                expect: Expect::Checked(!on),
            }],
            _ => {
                return Err(not_supported(
                    "toggle needs a known checked state; use check or uncheck",
                ))
            }
        },
        ElementAction::Check => check_plan(true, before),
        ElementAction::Uncheck => check_plan(false, before),
        ElementAction::Expand => expand_plan(true, before),
        ElementAction::Collapse => expand_plan(false, before),
        ElementAction::Select if before.selected == Some(true) => vec![Rung::Already],
        ElementAction::Select => vec![
            Rung::SelectChild { stateful: true },
            Rung::Verb {
                verbs: SELECT,
                expect: Expect::Selected,
            },
        ],
        ElementAction::ScrollIntoView => vec![Rung::ScrollTo],
        ElementAction::ShowMenu => vec![Rung::Verb {
            verbs: SHOW_MENU,
            expect: Expect::Nothing,
        }],
    };
    Ok(rungs)
}

/// Reads the element's current state primitives (value included unless secure).
pub(crate) async fn read_state(
    conn: &zbus::Connection,
    obj: &ObjectRefOwned,
    role: &str,
    secure: bool,
    deadline: std::time::Instant,
) -> Option<ElementState> {
    let proxy = accessible(conn, obj).await.ok()?;
    let states = within(deadline, proxy.get_state()).await?.ok()?;
    let source = value_source(role, secure, true);
    let value = within(deadline, read_value(conn, obj, source, MAX_TEXT_CHARS))
        .await
        .flatten();
    Some(element_state(states, role, value, secure))
}

/// Reads a value back after a write, long enough to compare `requested`.
pub(crate) async fn read_back_value(
    conn: &zbus::Connection,
    obj: &ObjectRefOwned,
    role: &str,
    requested: &str,
    deadline: std::time::Instant,
) -> Option<String> {
    let limit = i32::try_from(requested.chars().count())
        .unwrap_or(i32::MAX)
        .saturating_add(16)
        .max(MAX_TEXT_CHARS);
    let first = if is_numeric_role(role) {
        ValueSource::Numeric
    } else {
        ValueSource::Text
    };
    if let Some(v) = within(deadline, read_value(conn, obj, first, limit))
        .await
        .flatten()
    {
        return Some(v);
    }
    let second = match first {
        ValueSource::Numeric => ValueSource::Text,
        _ => ValueSource::Numeric,
    };
    within(deadline, read_value(conn, obj, second, limit))
        .await
        .flatten()
}
