//! macOS backend over the AXUIElement API.
//!
//! Snapshots, live resolution and semantic actions each run inside one blocking
//! task and one AX session; no live handle leaves this module.

use std::time::{Duration, Instant};

use super::find::{find_in_tree, FindOptions};
use super::limits::WalkBudget;
use super::*;

mod actions;
mod actions_state;
mod attr;
mod ax_error;
mod cf;
mod electron;
mod ffi;
mod nav;
mod snapshot;
mod walk;

#[cfg(test)]
mod tests;

/// macOS search matches role, title and value, never the identifier.
const FIND_OPTIONS: FindOptions = FindOptions {
    match_identifier: false,
    match_value: true,
};

/// The focused window's tree under the default limits (no renderer activation).
pub fn get_focused_tree_sync() -> Result<AXTreeNode> {
    snapshot::snapshot_sync(&SnapshotOptions::default())
        .map(|s| s.root)
        .map_err(anyhow::Error::new)
}

pub fn find_element_sync(description: &str) -> Option<AXTreeNode> {
    let tree = get_focused_tree_sync().ok()?;
    find_in_tree(&tree, description, FIND_OPTIONS)
}

pub fn element_at_sync(x: i32, y: i32) -> Option<AXTreeNode> {
    let sys = unsafe { cf::CfRef::owned(ffi::AXUIElementCreateSystemWide()) }?;
    let limits = WalkLimits {
        max_depth: 1,
        ..WalkLimits::platform_default()
    };
    let mut budget = WalkBudget::start(limits);
    // No messaging timeout on `sys`: on the system-wide element it sets the global
    // default for every AXUIElement in the process. The hit test keeps the default;
    // the walk below sets a timeout per element.
    let mut out: ffi::AXUIElementRef = std::ptr::null();
    let err = unsafe {
        ffi::AXUIElementCopyElementAtPosition(sys.as_ptr(), x as f32, y as f32, &mut out)
    };
    let el = unsafe { cf::CfRef::owned(out) }?;
    if err != ffi::AX_SUCCESS {
        return None;
    }
    Some(walk::walk(&el, 0, &mut budget))
}

fn list_apps_sync() -> Vec<serde_json::Value> {
    use objc2::runtime::{AnyClass, AnyObject};
    unsafe {
        let ws_class = match AnyClass::get("NSWorkspace") {
            Some(c) => c,
            None => return vec![],
        };
        let workspace: *mut AnyObject = objc2::msg_send![ws_class, sharedWorkspace];
        let apps: *mut AnyObject = objc2::msg_send![workspace, runningApplications];
        let count: usize = objc2::msg_send![apps, count];
        let mut result = vec![];
        for i in 0..count {
            let app: *mut AnyObject = objc2::msg_send![apps, objectAtIndex: i];
            let name_obj: *mut AnyObject = objc2::msg_send![app, localizedName];
            if name_obj.is_null() {
                continue;
            }
            let cptr: *const std::ffi::c_char = objc2::msg_send![name_obj, UTF8String];
            if cptr.is_null() {
                continue;
            }
            let name = std::ffi::CStr::from_ptr(cptr).to_string_lossy().to_string();
            let pid: i32 = objc2::msg_send![app, processIdentifier];
            result.push(serde_json::json!({ "name": name, "pid": pid }));
        }
        result
    }
}

fn join_error(e: &tokio::task::JoinError) -> GhostError {
    GhostError::internal(format!("the accessibility task failed: {e}"))
}

fn resolve_sync(
    locator: &ElementLocator,
    deadline: Duration,
) -> Result<ResolvedElement, GhostError> {
    nav::resolve_live(locator, Instant::now() + deadline).map(|live| live.resolved)
}

pub struct MacOSAXTree;

impl MacOSAXTree {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

#[async_trait]
impl AXTree for MacOSAXTree {
    async fn get_focused_tree(&self) -> Result<AXTreeNode> {
        tokio::task::spawn_blocking(get_focused_tree_sync).await?
    }
    async fn find_element(&self, description: &str) -> Option<AXTreeNode> {
        // An empty query would match the root node (every string contains "").
        if description.trim().is_empty() {
            return None;
        }
        let desc = description.to_string();
        tokio::task::spawn_blocking(move || find_element_sync(&desc))
            .await
            .ok()
            .flatten()
    }
    async fn element_at(&self, x: i32, y: i32) -> Option<AXTreeNode> {
        tokio::task::spawn_blocking(move || element_at_sync(x, y))
            .await
            .ok()
            .flatten()
    }
    async fn list_apps(&self) -> Vec<serde_json::Value> {
        tokio::task::spawn_blocking(list_apps_sync)
            .await
            .unwrap_or_default()
    }
    async fn snapshot(&self, opts: SnapshotOptions) -> Result<AXSnapshot, GhostError> {
        tokio::task::spawn_blocking(move || snapshot::snapshot_sync(&opts))
            .await
            .map_err(|e| join_error(&e))?
    }
    async fn resolve(
        &self,
        locator: &ElementLocator,
        deadline: Duration,
    ) -> Result<ResolvedElement, GhostError> {
        let locator = locator.clone();
        tokio::task::spawn_blocking(move || resolve_sync(&locator, deadline))
            .await
            .map_err(|e| join_error(&e))?
    }
    async fn perform(
        &self,
        locator: &ElementLocator,
        action: &ElementAction,
        opts: &ActionOptions,
    ) -> Result<ActionOutcome, GhostError> {
        let (locator, action, opts) = (locator.clone(), action.clone(), opts.clone());
        tokio::task::spawn_blocking(move || actions::perform_sync(&locator, &action, &opts))
            .await
            .map_err(|e| join_error(&e))?
    }
}
