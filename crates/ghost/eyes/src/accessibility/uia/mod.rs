//! Windows backend over IUIAutomation (module named `uia` so it never shadows
//! the `windows` crate).
//!
//! Every call runs in its own COM apartment ([`com::ComGuard`]) with one
//! [`com::UiaSession`]. Every call runs on a dedicated thread with a deadline and
//! bounded UIA call timeouts, because a provider call can block on a modal dialog
//! or a hung UI thread.

use std::time::{Duration, Instant};

use super::find::{find_in_tree, FindOptions};
use super::limits::WalkBudget;
use super::*;

mod actions;
mod actions_state;
mod actions_toggle;
mod actions_value;
mod com;
mod hresult;
mod nav;
mod snapshot;
mod walk;

#[cfg(test)]
mod tests;

use com::{read_on_sta_thread, run_on_sta_thread, UiaSession};
use walk::walk_element;

const FIND_OPTIONS: FindOptions = FindOptions {
    match_identifier: true,
    match_value: true,
};

pub struct WindowsAXTree;

impl WindowsAXTree {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

/// Extra time a read gets past its walk budget: window acquisition before the walk
/// and the description of the node that was being read when the budget ran out.
const READ_SLACK: Duration = Duration::from_secs(1);

/// Runs read-only `work` in a fresh STA and UIA session, abandoned (TIMEOUT,
/// `NotDelivered`) once `budget` plus [`READ_SLACK`] has passed.
async fn blocking<T, F>(budget: Duration, work: F) -> Result<T, GhostError>
where
    T: Send + 'static,
    F: FnOnce(&UiaSession) -> Result<T, GhostError> + Send + 'static,
{
    let deadline = Instant::now() + budget + READ_SLACK;
    tokio::task::spawn_blocking(move || read_on_sta_thread(deadline, work))
        .await
        .map_err(|e| GhostError::internal(format!("UI Automation task failed: {e}")))?
}

#[async_trait]
impl AXTree for WindowsAXTree {
    async fn get_focused_tree(&self) -> Result<AXTreeNode> {
        // The private walk, never `self.snapshot` (the trait default calls back here).
        let opts = SnapshotOptions::default();
        let budget = opts.limits.budget;
        let snap = blocking(budget, move |s| snapshot::snapshot_sync(s, &opts)).await?;
        Ok(snap.root)
    }

    async fn find_element(&self, description: &str) -> Option<AXTreeNode> {
        // An empty query would match the root node (every string contains "").
        if description.trim().is_empty() {
            return None;
        }
        let desc = description.to_string();
        blocking(limits_with_depth(5).budget, move |s| {
            Ok(find_element_sync(s, &desc))
        })
        .await
        .ok()
        .flatten()
    }

    async fn element_at(&self, x: i32, y: i32) -> Option<AXTreeNode> {
        blocking(limits_with_depth(1).budget, move |s| {
            Ok(element_at_sync(s, x, y))
        })
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
        let budget = opts.limits.budget;
        blocking(budget, move |s| snapshot::snapshot_sync(s, &opts)).await
    }

    async fn resolve(
        &self,
        locator: &ElementLocator,
        deadline: Duration,
    ) -> Result<ResolvedElement, GhostError> {
        let locator = locator.clone();
        let deadline = Instant::now() + deadline;
        tokio::task::spawn_blocking(move || {
            run_on_sta_thread(deadline, move |s| {
                nav::resolve_live(s, &locator, deadline).map(|live| live.resolved)
            })
        })
        .await
        .map_err(|e| GhostError::internal(format!("UI Automation task failed: {e}")))?
    }

    async fn perform(
        &self,
        locator: &ElementLocator,
        action: &ElementAction,
        opts: &ActionOptions,
    ) -> Result<ActionOutcome, GhostError> {
        if matches!(action, ElementAction::Focus) && !opts.allow_focus_steal {
            return Err(GhostError::policy_denied(
                "moving keyboard focus is not allowed for this call",
            ));
        }
        let (locator, action, opts) = (locator.clone(), action.clone(), opts.clone());
        let deadline = Instant::now() + opts.deadline;
        tokio::task::spawn_blocking(move || {
            run_on_sta_thread(deadline, move |s| {
                actions::perform_sync(s, &locator, &action, &opts, deadline)
            })
        })
        .await
        .map_err(|e| GhostError::internal(format!("UI Automation task failed: {e}")))?
    }
}

fn limits_with_depth(max_depth: u32) -> WalkLimits {
    WalkLimits {
        max_depth,
        ..WalkLimits::platform_default()
    }
}

fn find_element_sync(session: &UiaSession, description: &str) -> Option<AXTreeNode> {
    let opts = SnapshotOptions {
        limits: limits_with_depth(5),
        ..SnapshotOptions::default()
    };
    let snap = snapshot::snapshot_sync(session, &opts).ok()?;
    find_in_tree(&snap.root, description, FIND_OPTIONS)
}

fn element_at_sync(session: &UiaSession, x: i32, y: i32) -> Option<AXTreeNode> {
    let pt = ::windows::Win32::Foundation::POINT { x, y };
    // SAFETY: COM call on this thread's session, which stays alive for the walk.
    let element = unsafe { session.automation.ElementFromPoint(pt) }.ok()?;
    let mut budget = WalkBudget::start(limits_with_depth(1));
    Some(walk_element(session, &element, 0, &mut budget))
}

fn list_apps_sync() -> Vec<serde_json::Value> {
    use ::windows::Win32::Foundation::INVALID_HANDLE_VALUE;
    use ::windows::Win32::System::Diagnostics::ToolHelp::*;
    let mut apps = vec![];
    // SAFETY: Toolhelp snapshot iteration; the handle is closed before returning.
    unsafe {
        let snapshot =
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).unwrap_or(INVALID_HANDLE_VALUE);
        if snapshot == INVALID_HANDLE_VALUE {
            return apps;
        }
        let mut pe = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut pe).is_ok() {
            loop {
                let len = pe
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(pe.szExeFile.len());
                let name = String::from_utf16_lossy(&pe.szExeFile[..len]);
                apps.push(serde_json::json!({ "pid": pe.th32ProcessID, "name": name }));
                if Process32NextW(snapshot, &mut pe).is_err() {
                    break;
                }
            }
        }
        let _ = ::windows::Win32::Foundation::CloseHandle(snapshot);
    }
    apps
}
