//! AT-SPI2 tree walk, node description, hit testing and app listing over D-Bus.

use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

use ::atspi::proxy::component::ComponentProxy;
use ::atspi::proxy::text::TextProxy;
use ::atspi::proxy::value::ValueProxy;
use ::atspi::zbus;
use ::atspi::{CoordType, ObjectRefOwned, State, StateSet};

use super::super::limits::{TruncationCause, WalkBudget};
use super::super::roles::{is_secure_atspi, role_key_from_atspi};
use super::super::{AXTreeNode, Bounds, ElementState, WalkLimits};
use super::conn::{accessible, connect, native_id, proxy, remaining, within};
use super::pid::{bus_proxy, obj_pid};
use crate::contract::GhostError;

/// Characters read from a text element's value during a walk.
pub(crate) const MAX_TEXT_CHARS: i32 = 2000;

type NodeFuture<'a> = Pin<Box<dyn Future<Output = AXTreeNode> + Send + 'a>>;

/// Where a node's value comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ValueSource {
    None,
    /// `Text.GetText(0, min(CharacterCount, limit))`.
    Text,
    /// `Value.CurrentValue`.
    Numeric,
}

/// Which value read a node gets. Secure nodes and walks with `read_values: false`
/// (passive capture) never read values.
pub(crate) fn value_source(role_key: &str, secure: bool, read_values: bool) -> ValueSource {
    if secure || !read_values {
        return ValueSource::None;
    }
    match role_key {
        "textfield" | "textarea" | "combobox" => ValueSource::Text,
        "slider" | "spinbutton" | "scrollbar" | "progressbar" => ValueSource::Numeric,
        _ => ValueSource::None,
    }
}

/// `Value.CurrentValue` as text: integral values without a fraction.
pub(crate) fn format_number(n: f64) -> Option<String> {
    if !n.is_finite() {
        return None;
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return Some(format!("{}", n as i64));
    }
    Some(format!("{n}"))
}

fn is_checkable_role(role_key: &str) -> bool {
    matches!(
        role_key,
        "checkbox" | "radiobutton" | "switch" | "togglebutton"
    )
}

/// Read-back primitives from an AT-SPI state set. `Indeterminate` is "mixed",
/// reported as an unknown checked state.
pub(crate) fn element_state(
    states: StateSet,
    role_key: &str,
    value: Option<String>,
    secure: bool,
) -> ElementState {
    let on = states.contains(State::Checked) || states.contains(State::Pressed);
    let checkable = states.contains(State::Checkable) || is_checkable_role(role_key);
    let checked = if states.contains(State::Indeterminate) {
        None
    } else if checkable || on {
        Some(on)
    } else {
        None
    };
    let flag = |has: State, is: State| {
        (states.contains(has) || states.contains(is)).then(|| states.contains(is))
    };
    ElementState {
        checked,
        expanded: flag(State::Expandable, State::Expanded),
        selected: flag(State::Selectable, State::Selected),
        focused: flag(State::Focusable, State::Focused),
        value: if secure { None } else { value },
        secure,
    }
}

async fn read_text(conn: &zbus::Connection, obj: &ObjectRefOwned, limit: i32) -> Option<String> {
    let text = proxy::<TextProxy<'_>>(conn, obj).await.ok()?;
    let count = text.character_count().await.ok()?.max(0);
    text.get_text(0, count.min(limit)).await.ok()
}

async fn read_numeric(conn: &zbus::Connection, obj: &ObjectRefOwned) -> Option<String> {
    let value = proxy::<ValueProxy<'_>>(conn, obj).await.ok()?;
    format_number(value.current_value().await.ok()?)
}

/// Reads a value from `source`; `limit` caps text reads in characters.
pub(crate) async fn read_value(
    conn: &zbus::Connection,
    obj: &ObjectRefOwned,
    source: ValueSource,
    limit: i32,
) -> Option<String> {
    match source {
        ValueSource::None => None,
        ValueSource::Text => read_text(conn, obj, limit).await,
        ValueSource::Numeric => read_numeric(conn, obj).await,
    }
}

async fn bounds_of(conn: &zbus::Connection, obj: &ObjectRefOwned) -> Option<Bounds> {
    let component = proxy::<ComponentProxy<'_>>(conn, obj).await.ok()?;
    let (x, y, w, h) = component.get_extents(CoordType::Screen).await.ok()?;
    Some(Bounds {
        x,
        y,
        width: w.unsigned_abs(),
        height: h.unsigned_abs(),
    })
}

/// One node at depth 0 plus the raw facts actions need.
pub(crate) struct Described {
    pub node: AXTreeNode,
    pub states: StateSet,
}

pub(crate) fn placeholder() -> AXTreeNode {
    AXTreeNode {
        role: "element".to_string(),
        ..Default::default()
    }
}

/// Describes `obj` without its children. The node is redacted.
pub(crate) async fn describe(
    conn: &zbus::Connection,
    obj: &ObjectRefOwned,
    read_values: bool,
) -> Described {
    let Ok(proxy) = accessible(conn, obj).await else {
        return Described {
            node: placeholder(),
            states: StateSet::empty(),
        };
    };
    let role = proxy
        .get_role()
        .await
        .map(|r| format!("{r:?}").to_lowercase())
        .unwrap_or_else(|_| "element".to_string());
    let title = proxy.name().await.ok().filter(|s| !s.is_empty());
    let identifier = proxy.accessible_id().await.ok().filter(|s| !s.is_empty());
    let states = proxy.get_state().await.unwrap_or_default();
    let role_key = role_key_from_atspi(&role, states.contains(State::Editable));
    let secure = is_secure_atspi(&role);
    let source = value_source(&role_key, secure, read_values);
    let value = read_value(conn, obj, source, MAX_TEXT_CHARS).await;
    let state = element_state(states, &role_key, value.clone(), secure);
    let mut node = AXTreeNode {
        title,
        identifier,
        bounds: bounds_of(conn, obj).await,
        enabled: states.contains(State::Enabled) || states.contains(State::Sensitive),
        focused: states.contains(State::Focused),
        hidden: !states.contains(State::Showing) || !states.contains(State::Visible),
        value,
        native_id: native_id(obj),
        secure,
        states: (state != ElementState::default()).then_some(state),
        role_key: Some(role_key),
        role,
        ..Default::default()
    };
    node.redact();
    Described { node, states }
}

/// Walks `obj` and its descendants under `budget`. Children keep their native
/// AT-SPI index: a child that cannot be read becomes a placeholder, never a gap.
pub(crate) fn walk<'a>(
    conn: &'a zbus::Connection,
    obj: ObjectRefOwned,
    depth: u32,
    budget: &'a mut WalkBudget,
) -> NodeFuture<'a> {
    Box::pin(async move {
        budget.visit();
        let read_values = budget.limits.read_values;
        let Some(described) = within(budget.deadline, describe(conn, &obj, read_values)).await
        else {
            let mut node = placeholder();
            budget.truncate(&mut node, TruncationCause::Deadline);
            return node;
        };
        let mut node = described.node;
        let Ok(proxy) = accessible(conn, &obj).await else {
            budget.truncate(&mut node, TruncationCause::ReadError);
            return node;
        };
        if depth >= budget.limits.max_depth {
            let count = within(budget.deadline, proxy.child_count()).await;
            if matches!(count, Some(Ok(n)) if n > 0) {
                budget.truncate(&mut node, TruncationCause::Depth);
            }
            return node;
        }
        // A failed or timed-out child read is not a leaf: flag it so completeness and
        // the stale/absent decision stay honest.
        let kids = match within(budget.deadline, proxy.get_children()).await {
            Some(Ok(kids)) => kids,
            Some(Err(_)) => {
                budget.truncate(&mut node, TruncationCause::ReadError);
                return node;
            }
            None => {
                budget.truncate(&mut node, TruncationCause::Deadline);
                return node;
            }
        };
        let cap = budget.limits.max_children;
        let mut truncated = (kids.len() > cap).then_some(TruncationCause::Siblings);
        for kid in kids.into_iter().take(cap) {
            if let Some(cause) = budget.exhausted() {
                truncated = Some(cause);
                break;
            }
            node.children.push(walk(conn, kid, depth + 1, budget).await);
        }
        if let Some(cause) = truncated {
            budget.truncate(&mut node, cause);
        }
        node
    })
}

/// The accessible under screen point (x, y) in the active window, with its
/// direct children.
pub(crate) async fn element_at(x: i32, y: i32) -> Result<Option<AXTreeNode>, GhostError> {
    let a11y = connect().await?;
    let conn = a11y.connection();
    let limits = WalkLimits {
        max_depth: 1,
        ..WalkLimits::platform_default()
    };
    let deadline = Instant::now() + limits.budget;
    let window = super::snapshot::active_window(conn, deadline).await?.window;
    let Ok(component) = proxy::<ComponentProxy<'_>>(conn, &window).await else {
        return Ok(None);
    };
    let hit = component.get_accessible_at_point(x, y, CoordType::Screen);
    let hit = match tokio::time::timeout(remaining(deadline), hit).await {
        Ok(Ok(hit)) if !hit.is_null() => hit,
        _ => return Ok(None),
    };
    let mut budget = WalkBudget::start(limits);
    Ok(Some(walk(conn, hit, 0, &mut budget).await))
}

/// Running accessible applications with their pids (0 when the bus cannot tell).
pub(crate) async fn list_apps() -> Result<Vec<serde_json::Value>, GhostError> {
    let a11y = connect().await?;
    let conn = a11y.connection();
    let dbus = bus_proxy(conn).await;
    let deadline = WalkLimits::platform_default().deadline_from_now();
    let mut apps = vec![];
    for app in super::snapshot::app_refs(conn, deadline).await? {
        // An application that does not answer in time is listed without a name.
        let name = super::snapshot::app_name(conn, &app, deadline)
            .await
            .unwrap_or_default();
        let pid = obj_pid(dbus.as_ref(), &app).await.unwrap_or(0);
        apps.push(serde_json::json!({ "name": name, "pid": pid }));
    }
    Ok(apps)
}
