// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Live element resolution: window root, pid check, path-first navigation, then a
//! bounded re-walk with strict identity re-checks.

use std::time::Instant;

use ::atspi::zbus;
use ::atspi::{ObjectRefOwned, StateSet};
use serde_json::json;

use super::super::limits::WalkBudget;
use super::super::resolve::{accept_path_hit, identity_matches, resolve_in_tree, IdentityMatch};
use super::super::{ElementLocator, MatchBy, ResolvedElement, WalkLimits};
use super::at_spi::{describe, walk, Described};
use super::conn::{accessible, within};
use super::pid::{pid_mismatch, process_alive, process_exited};
use super::snapshot::acquire_root;
use crate::contract::{Delivery, GhostError};

/// A live element plus its resolved description and raw AT-SPI states.
pub(crate) struct LiveElement {
    pub obj: ObjectRefOwned,
    pub resolved: ResolvedElement,
    pub states: StateSet,
}

/// The child at AT-SPI index `idx`, if it exists.
async fn child_at(
    conn: &zbus::Connection,
    parent: &ObjectRefOwned,
    idx: u32,
    deadline: Instant,
) -> Option<ObjectRefOwned> {
    let proxy = accessible(conn, parent).await.ok()?;
    let idx = i32::try_from(idx).ok()?;
    let count = within(deadline, proxy.child_count()).await?.ok()?;
    if idx >= count {
        return None;
    }
    let child = within(deadline, proxy.get_child_at_index(idx))
        .await?
        .ok()?;
    (!child.is_null()).then_some(child)
}

/// Follows `path` (child indices) from `root`.
pub(crate) async fn element_at_path(
    conn: &zbus::Connection,
    root: &ObjectRefOwned,
    path: &[u32],
    deadline: Instant,
) -> Option<ObjectRefOwned> {
    let mut current = root.clone();
    for &idx in path {
        current = child_at(conn, &current, idx, deadline).await?;
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
        Delivery::NotDelivered,
    )
}

fn finish(
    obj: ObjectRefOwned,
    described: Described,
    path: Vec<u32>,
    matched_by: MatchBy,
    pid: i32,
) -> LiveElement {
    let node = described.node;
    let state = node.states.clone().unwrap_or_default();
    LiveElement {
        obj,
        states: described.states,
        resolved: ResolvedElement {
            state,
            node,
            path,
            matched_by,
            pid,
        },
    }
}

/// Resolves `locator` against the live UI before `deadline`.
pub(crate) async fn resolve_live(
    conn: &zbus::Connection,
    locator: &ElementLocator,
    deadline: Instant,
) -> Result<LiveElement, GhostError> {
    if locator.pid > 0 && !process_alive(locator.pid) {
        return Err(process_exited(locator.pid));
    }
    let root = acquire_root(conn, &locator.window, deadline).await?;
    if locator.pid > 0 && root.pid != locator.pid {
        return Err(pid_mismatch(locator.pid, root.pid));
    }
    let pid = root.pid;

    if let Some(obj) = element_at_path(conn, &root.window, &locator.path, deadline).await {
        if let Some(described) = within(deadline, describe(conn, &obj, true)).await {
            if accept_path_hit(&described.node, &locator.identity) {
                let path = locator.path.clone();
                return Ok(finish(obj, described, path, MatchBy::Path, pid));
            }
        }
    }

    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(deadline_passed());
    }
    let limits = WalkLimits::platform_default();
    let limits = limits.with_budget(limits.budget.min(left));
    let mut budget = WalkBudget::start(limits);
    let tree = walk(conn, root.window.clone(), 0, &mut budget).await;
    let resolution = resolve_in_tree(&tree, &locator.identity, &locator.path)?;
    let path = resolution.path;
    let matched_by = resolution.matched_by;

    let obj = element_at_path(conn, &root.window, &path, deadline)
        .await
        .ok_or_else(changed_during_resolve)?;
    let described = within(deadline, describe(conn, &obj, true))
        .await
        .ok_or_else(deadline_passed)?;
    if identity_matches(&described.node, &locator.identity) != IdentityMatch::Match {
        return Err(changed_during_resolve());
    }
    Ok(finish(obj, described, path, matched_by, pid))
}
