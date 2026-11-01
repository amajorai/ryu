// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Live element resolution: window root, pid check, path-first navigation,
//! then a bounded re-walk with strict identity re-checks.

use std::time::Instant;

use ::windows::Win32::UI::Accessibility::IUIAutomationElement;
use serde_json::json;

use super::super::limits::WalkBudget;
use super::super::resolve::{accept_path_hit, identity_matches, resolve_in_tree, IdentityMatch};
use super::super::{ElementLocator, MatchBy, ResolvedElement, WalkLimits};
use super::actions_state::read_state;
use super::com::UiaSession;
use super::snapshot::acquire_root;
use super::walk::{describe, walk_element};
use crate::contract::GhostError;

/// The child at native index `idx` under the control-view walker.
fn child_at(
    session: &UiaSession,
    parent: &IUIAutomationElement,
    idx: u32,
) -> Option<IUIAutomationElement> {
    // SAFETY: walker calls on live elements of this thread's session.
    unsafe {
        let mut current = session.walker.GetFirstChildElement(parent).ok()?;
        for _ in 0..idx {
            current = session.walker.GetNextSiblingElement(&current).ok()?;
        }
        Some(current)
    }
}

/// Follows `path` (child indices) from `root`.
pub(crate) fn element_at_path(
    session: &UiaSession,
    root: &IUIAutomationElement,
    path: &[u32],
) -> Option<IUIAutomationElement> {
    let mut current = root.clone();
    for &idx in path {
        current = child_at(session, &current, idx)?;
    }
    Some(current)
}

fn changed_during_resolve() -> GhostError {
    GhostError::stale_ref("the element changed while it was being resolved")
        .with_details(json!({ "reason": "changed_during_resolve" }))
        .with_suggestion("take a new snapshot")
}

fn deadline_passed() -> GhostError {
    GhostError::timeout(
        "the deadline passed while resolving the element",
        crate::contract::Delivery::NotDelivered,
    )
}

/// A live element plus its resolved description.
pub(crate) struct LiveElement {
    pub element: IUIAutomationElement,
    pub resolved: ResolvedElement,
}

fn finish(
    element: IUIAutomationElement,
    node: super::super::AXTreeNode,
    path: Vec<u32>,
    matched_by: MatchBy,
    pid: i32,
) -> LiveElement {
    let role_key = node.stable_role();
    let state = read_state(&element, &role_key, node.secure);
    LiveElement {
        element,
        resolved: ResolvedElement {
            node,
            path,
            matched_by,
            pid,
            state,
        },
    }
}

/// Resolves `locator` against the live UI before `deadline`.
pub(crate) fn resolve_live(
    session: &UiaSession,
    locator: &ElementLocator,
    deadline: Instant,
) -> Result<LiveElement, GhostError> {
    let (root, pid) = acquire_root(session, &locator.window)?;
    if locator.pid > 0 && pid != locator.pid {
        return Err(
            GhostError::stale_ref("the window now belongs to a different process")
                .with_details(json!({ "snapshot_pid": locator.pid, "current_pid": pid }))
                .with_suggestion("take a new snapshot"),
        );
    }

    if let Some(element) = element_at_path(session, &root, &locator.path) {
        let node = describe(&element);
        if accept_path_hit(&node, &locator.identity) {
            return Ok(finish(
                element,
                node,
                locator.path.clone(),
                MatchBy::Path,
                pid,
            ));
        }
    }

    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(deadline_passed());
    }
    let limits = WalkLimits::platform_default();
    let limits = limits.with_budget(limits.budget.min(remaining));
    let mut budget = WalkBudget::start(limits);
    let tree = walk_element(session, &root, 0, &mut budget);
    let resolution = resolve_in_tree(&tree, &locator.identity, &locator.path)?;
    let path = resolution.path;
    let matched_by = resolution.matched_by;

    let element = element_at_path(session, &root, &path).ok_or_else(changed_during_resolve)?;
    let node = describe(&element);
    if identity_matches(&node, &locator.identity) != IdentityMatch::Match {
        return Err(changed_during_resolve());
    }
    Ok(finish(element, node, path, matched_by, pid))
}
