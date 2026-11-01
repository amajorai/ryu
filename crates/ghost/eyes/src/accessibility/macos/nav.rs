//! Live element resolution: window root, path navigation and identity checks.

use std::time::Instant;

use serde_json::json;

use super::super::resolve::{accept_path_hit, identity_matches, resolve_in_tree, IdentityMatch};
use super::super::{AXTreeNode, ElementLocator, MatchBy, ResolvedElement, WalkLimits};
use super::actions_state::read_state;
use super::attr::*;
use super::cf::{cf_array_items, CfRef};
use super::ffi::CFArrayGetCount;
use super::snapshot::{acquire, walk_root, WindowRoot};
use super::walk::describe;
use crate::contract::{Delivery, GhostError};

/// A live element resolved inside one AX session.
pub(crate) struct Live {
    pub win: WindowRoot,
    pub el: CfRef,
    pub resolved: ResolvedElement,
}

pub(crate) fn deadline_error(what: &str) -> GhostError {
    GhostError::timeout(
        format!("the deadline passed before {what}"),
        Delivery::NotDelivered,
    )
}

fn changed_during_resolve() -> GhostError {
    GhostError::stale_ref("the element changed while it was being resolved")
        .with_details(json!({ "reason": "changed_during_resolve" }))
        .with_suggestion("take a new snapshot")
}

/// Follows `path` (AXChildren indices) from `root`; `None` if an index is missing.
pub(crate) fn navigate(root: &CfRef, path: &[u32], deadline: Instant) -> Option<CfRef> {
    let mut cur = unsafe { CfRef::retained(root.as_ptr()) }?;
    for &idx in path {
        if !set_timeout(&cur, deadline) {
            return None;
        }
        let arr = children_array(&cur).ok()?;
        let count = unsafe { CFArrayGetCount(arr.as_ptr()) };
        if i64::from(idx) >= count {
            return None;
        }
        let mut items = unsafe { cf_array_items(arr.as_ptr()) };
        cur = items.get_mut(usize::try_from(idx).ok()?)?.take()?;
    }
    set_timeout(&cur, deadline);
    Some(cur)
}

/// STALE_REF when the element is owned by a different process than the root.
fn check_element_pid(el: &CfRef, pid: i32) -> Result<(), GhostError> {
    match element_pid(el) {
        Some(found) if found != pid => Err(GhostError::stale_ref(
            "the element belongs to a different process",
        )
        .with_details(
            json!({ "reason": "pid_mismatch", "snapshot_pid": pid, "current_pid": found }),
        )),
        _ => Ok(()),
    }
}

fn finish(win: WindowRoot, el: CfRef, node: AXTreeNode, path: Vec<u32>, by: MatchBy) -> Live {
    let state = read_state(&el, &node);
    Live {
        resolved: ResolvedElement {
            node,
            path,
            matched_by: by,
            pid: win.pid,
            state,
        },
        el,
        win,
    }
}

/// Resolves `locator` live: acquire the window, try the stored path, then a fresh
/// bounded walk with `resolve_in_tree`, re-checking identity on the live handle.
pub(crate) fn resolve_live(
    locator: &ElementLocator,
    deadline: Instant,
) -> Result<Live, GhostError> {
    if Instant::now() >= deadline {
        return Err(deadline_error("the element was resolved"));
    }
    if locator.pid > 0 && !process_alive(locator.pid) {
        return Err(
            GhostError::stale_ref("the application that owned the element has exited")
                .with_details(json!({ "reason": "process_exited", "pid": locator.pid })),
        );
    }
    let win = acquire(&locator.window, deadline)?;
    if locator.pid > 0 && win.pid != locator.pid {
        return Err(
            GhostError::stale_ref("the target window now belongs to a different process")
                .with_details(json!({
                    "reason": "pid_mismatch",
                    "snapshot_pid": locator.pid,
                    "current_pid": win.pid,
                }))
                .with_suggestion("take a new snapshot"),
        );
    }
    let id = &locator.identity;

    if let Some(el) = navigate(&win.root, &locator.path, deadline) {
        let node = describe(&el);
        if accept_path_hit(&node, id) && check_element_pid(&el, win.pid).is_ok() {
            let path = locator.path.clone();
            return Ok(finish(win, el, node, path, MatchBy::Path));
        }
    }

    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(deadline_error("the element was resolved"));
    }
    let defaults = WalkLimits::platform_default();
    let limits = defaults.with_budget(defaults.budget.min(remaining));
    let (tree, _) = walk_root(&win.root, limits);
    let (path, by) = {
        let res = resolve_in_tree(&tree, id, &locator.path)?;
        (res.path, res.matched_by)
    };
    let el = navigate(&win.root, &path, deadline).ok_or_else(changed_during_resolve)?;
    let node = describe(&el);
    if identity_matches(&node, id) != IdentityMatch::Match {
        return Err(changed_during_resolve());
    }
    check_element_pid(&el, win.pid)?;
    Ok(finish(win, el, node, path, by))
}
