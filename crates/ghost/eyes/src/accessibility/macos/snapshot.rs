//! Window-root acquisition for `WindowTarget`s and the snapshot walk.

use std::time::Instant;

use serde_json::json;

use super::super::limits::WalkBudget;
use super::super::{pick_window_title, window_pick_error, TitlePick, WalkStats, WindowTarget};
use super::super::{AXSnapshot, AXTreeNode, RendererA11y, SnapshotOptions, WalkLimits};
use super::attr::*;
use super::cf::CfRef;
use super::ffi::{AX_API_DISABLED, AX_CANNOT_COMPLETE};
use super::{electron, walk};
use crate::contract::{Delivery, ErrorCode, GhostError};

/// The acquired window root: the element every locator path is relative to.
pub(crate) struct WindowRoot {
    pub app: CfRef,
    /// The window element, or the application element when it has no window.
    pub root: CfRef,
    pub pid: i32,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
}

/// The frontmost application's pid, through `NSWorkspace`.
pub(crate) fn frontmost_pid() -> Result<i32, GhostError> {
    use objc2::runtime::{AnyClass, AnyObject};
    let pid: i32 = unsafe {
        let ws_class = AnyClass::get("NSWorkspace")
            .ok_or_else(|| GhostError::internal("NSWorkspace is not available"))?;
        let workspace: *mut AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
        if workspace.is_null() {
            return Err(GhostError::internal("NSWorkspace is not available"));
        }
        let app: *mut AnyObject = objc2::msg_send![workspace, frontmostApplication];
        if app.is_null() {
            0
        } else {
            objc2::msg_send![app, processIdentifier]
        }
    };
    if pid <= 0 {
        return Err(GhostError::new(
            ErrorCode::AppNotFound,
            "no frontmost application",
        ));
    }
    Ok(pid)
}

/// Read errors that must not be ignored while acquiring a window.
fn read_error(code: i32) -> Option<GhostError> {
    match code {
        AX_API_DISABLED => Some(GhostError::perm_denied(
            "accessibility access is disabled for this process; grant it in System Settings",
        )),
        AX_CANNOT_COMPLETE => Some(
            GhostError::new(
                ErrorCode::AppUnresponsive,
                "the application did not answer accessibility requests",
            )
            .with_delivery(Delivery::NotDelivered),
        ),
        _ => None,
    }
}

fn windows(app: &CfRef) -> Result<Vec<CfRef>, GhostError> {
    match attr_elements(app, "AXWindows") {
        Ok(list) => Ok(list),
        Err(code) => read_error(code).map_or_else(|| Ok(Vec::new()), Err),
    }
}

/// Focused window, else main window, else the first of AXWindows, else the app.
fn pid_window(app: &CfRef) -> Result<CfRef, GhostError> {
    for attr in ["AXFocusedWindow", "AXMainWindow"] {
        match copy_attr(app, attr) {
            Ok(win) => return Ok(win),
            Err(code) => {
                if let Some(e) = read_error(code) {
                    return Err(e);
                }
            }
        }
    }
    if let Some(first) = windows(app)?.into_iter().next() {
        return Ok(first);
    }
    unsafe { CfRef::retained(app.as_ptr()) }
        .ok_or_else(|| GhostError::internal("could not retain the application element"))
}

/// `strict` (PidTitle): exact title only; a single window stands in on a miss,
/// otherwise STALE_REF. Not strict: exact then substring; a miss is ELEMENT_NOT_FOUND.
fn title_window(app: &CfRef, pid: i32, title: &str, strict: bool) -> Result<CfRef, GhostError> {
    let mut list = windows(app)?;
    let titles: Vec<_> = list.iter().map(|w| attr_string(w, "AXTitle")).collect();
    let refs: Vec<Option<&str>> = titles.iter().map(Option::as_deref).collect();
    match pick_window_title(&refs, title, strict) {
        TitlePick::Found(i) => Ok(list.swap_remove(i)),
        pick if strict => match pick.or_single_window() {
            TitlePick::Found(i) => Ok(list.swap_remove(i)),
            other => Err(window_pick_error(other, pid)),
        },
        _ => Err(
            GhostError::not_found("no window of the frontmost application matches the title")
                .with_details(json!({ "reason": "window_not_found" })),
        ),
    }
}

fn process_exited(pid: i32) -> GhostError {
    GhostError::stale_ref("the application that owned the element has exited")
        .with_details(json!({ "reason": "process_exited", "pid": pid }))
}

/// Acquires the window root for `target`. A dead target process is
/// STALE_REF `process_exited`.
pub(crate) fn acquire(target: &WindowTarget, deadline: Instant) -> Result<WindowRoot, GhostError> {
    let (pid, title, strict) = match target {
        WindowTarget::Focused => (frontmost_pid()?, None, false),
        WindowTarget::FocusedTitle { title } => (frontmost_pid()?, Some(title.as_str()), false),
        WindowTarget::Pid { pid } => (*pid, None, false),
        WindowTarget::PidTitle { pid, title } => (*pid, Some(title.as_str()), true),
    };
    if !process_alive(pid) {
        return Err(process_exited(pid));
    }
    let app = app_element(pid)
        .ok_or_else(|| GhostError::internal("AXUIElementCreateApplication failed"))?;
    if !set_timeout(&app, deadline) {
        return Err(GhostError::timeout(
            "the deadline passed before the window was acquired",
            Delivery::NotDelivered,
        ));
    }
    let root = match title {
        Some(t) => title_window(&app, pid, t, strict)?,
        None => pid_window(&app)?,
    };
    set_timeout(&root, deadline);
    Ok(WindowRoot {
        app_name: attr_string(&app, "AXTitle"),
        window_title: attr_string(&root, "AXTitle"),
        pid,
        root,
        app,
    })
}

/// Walks `root` under `limits` with a fresh budget.
pub(crate) fn walk_root(root: &CfRef, limits: WalkLimits) -> (AXTreeNode, WalkStats) {
    let mut budget = WalkBudget::start(limits);
    let node = walk::walk(root, 0, &mut budget);
    (node, budget.stats)
}

/// The snapshot behind both `snapshot` and `get_focused_tree`.
pub(crate) fn snapshot_sync(opts: &SnapshotOptions) -> Result<AXSnapshot, GhostError> {
    let acquire_deadline = Instant::now() + opts.limits.budget;
    let win = acquire(&opts.target, acquire_deadline).map_err(|e| {
        let exited = e.code == ErrorCode::StaleRef
            && e.details
                .as_ref()
                .and_then(|d| d.get("reason"))
                .is_some_and(|r| r == "process_exited");
        if exited {
            GhostError::new(
                ErrorCode::AppNotFound,
                "the target application is not running",
            )
        } else {
            e
        }
    })?;
    let (mut root, mut stats) = walk_root(&win.root, opts.limits);
    let mut renderer = RendererA11y::NotApplicable;
    if opts.activate_renderer {
        let deadline = Instant::now() + opts.limits.budget;
        renderer = electron::ensure_renderer_accessibility(&win.app, win.pid, &root, deadline);
        if renderer == RendererA11y::Enabled {
            (root, stats) = walk_root(&win.root, opts.limits);
        }
    }
    Ok(AXSnapshot {
        root,
        pid: win.pid,
        app_name: win.app_name,
        window_title: win.window_title,
        complete: stats.complete(),
        stats,
        renderer,
    })
}
