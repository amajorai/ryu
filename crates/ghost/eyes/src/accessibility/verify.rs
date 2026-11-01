// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Pure post-condition checks used to verify semantic actions and typing.

use super::{ElementAction, ElementState};

/// Largest magnitude at which an f64 still represents every integer exactly.
const MAX_EXACT: f64 = 9_007_199_254_740_992.0; // 2^53
const NUMERIC_EPSILON: f64 = 1e-6;

fn is_numeric_role(role_key: &str) -> bool {
    matches!(
        role_key,
        "slider" | "spinbutton" | "scrollbar" | "progressbar"
    )
}

fn parse_number(s: &str) -> Option<f64> {
    let n: f64 = s.trim().parse().ok()?;
    (n.is_finite() && n.abs() < MAX_EXACT).then_some(n)
}

/// Exact comparison after CRLF -> LF; numeric comparison (|d| <= 1e-6, finite,
/// magnitude < 2^53) only for slider/spinbutton/scrollbar/progressbar.
pub fn value_matches(role_key: &str, expected: &str, observed: &str) -> bool {
    let expected = expected.replace("\r\n", "\n");
    let observed = observed.replace("\r\n", "\n");
    if expected == observed {
        return true;
    }
    if !is_numeric_role(role_key) {
        return false;
    }
    match (parse_number(&expected), parse_number(&observed)) {
        (Some(e), Some(o)) => (e - o).abs() <= NUMERIC_EPSILON,
        _ => false,
    }
}

/// Whether `after` shows the action's effect. `None` when the state needed to
/// decide is not available (or the action has no observable state).
pub fn postcondition(
    action: &ElementAction,
    role_key: &str,
    before: Option<&ElementState>,
    after: &ElementState,
) -> Option<bool> {
    match action {
        ElementAction::SetValue(expected) => {
            if after.secure {
                return None;
            }
            let observed = after.value.as_deref()?;
            Some(value_matches(role_key, expected, observed))
        }
        ElementAction::Toggle => {
            let before = before?;
            match (before.checked, after.checked) {
                (Some(b), Some(a)) => Some(a != b),
                _ => match (before.expanded, after.expanded) {
                    (Some(b), Some(a)) => Some(a != b),
                    _ => None,
                },
            }
        }
        ElementAction::Check => after.checked,
        ElementAction::Uncheck => after.checked.map(|c| !c),
        ElementAction::Expand => after.expanded,
        ElementAction::Collapse => after.expanded.map(|e| !e),
        ElementAction::Select => after.selected,
        ElementAction::Focus => after.focused,
        ElementAction::Press | ElementAction::ScrollIntoView | ElementAction::ShowMenu => None,
    }
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// expected = `typed` if `clear` or `before` is empty/None; otherwise there is not
/// enough evidence (the text may already have been present) and the result is
/// `None`. `None` also when `after` is unknown; else whitespace-normalized equality.
pub fn verify_typed(
    before: Option<&str>,
    typed: &str,
    clear: bool,
    after: Option<&str>,
) -> Option<bool> {
    let before_empty = before.is_none_or(str::is_empty);
    if !(clear || before_empty) {
        return None;
    }
    let after = after?;
    Some(normalize_ws(after) == normalize_ws(typed))
}
