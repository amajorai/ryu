use anyhow::Result;
use serde_json::{json, Value};

use ghost_eyes::{AXTree, PlatformAXTree, PlatformWindowTracker, WindowTracker};
use ghost_hands::focus_app;

use crate::refmap::{reidentify, render, Resolved, Snapshot, SnapshotStore};

use super::{int_param, str_param};

const DRILL_SUGGESTION: &str =
    "Act on a ref with ghost_click/ghost_type {\"ref\":\"@eN\"}, or expand a container with ghost_snapshot {\"root\":\"@eN\"}.";

/// Capture a fresh skeleton of the focused window (assigning stable `@eN` refs), or
/// — when `root` is given — re-render a deeper view of a container from an existing
/// snapshot. Drill-down does not walk deeper than the original capture (bounded by the
/// platform AX walk: ~6 levels on Windows/Linux, ~25 on macOS); to reach elements below
/// that, snapshot the relevant app/window directly.
pub async fn ghost_snapshot(params: Value) -> Result<Value> {
    if let Some(app_name) = str_param(&params, "app") {
        focus_app(app_name);
        tokio::time::sleep(tokio::time::Duration::from_millis(120)).await;
    }

    let depth = int_param(&params, "depth", 3).clamp(0, 10) as u32;
    let store = SnapshotStore::open()?;

    // Drill-down: re-render a container from a stored snapshot, no re-capture.
    if let Some(ref_id) = str_param(&params, "root") {
        let snapshot = match str_param(&params, "snapshot") {
            Some(id) => store.load(id)?,
            None => store.load_latest()?,
        };
        let node = snapshot.find_ref(ref_id).ok_or_else(|| {
            anyhow::anyhow!("ref {ref_id} not found in snapshot {}", snapshot.id)
        })?;
        return Ok(json!({
            "snapshot_id": snapshot.id,
            "root": ref_id,
            "tree": render(node, depth),
            "suggestion": DRILL_SUGGESTION,
        }));
    }

    // Fresh capture of the focused window.
    let tracker = PlatformWindowTracker::new()?;
    let win = tracker.get_active_window().await;
    let pid = win.as_ref().map(|w| w.pid).unwrap_or(0);
    let app_name = win.as_ref().map(|w| w.app_name.clone());

    let ax = PlatformAXTree::new()?;
    let tree = ax.get_focused_tree().await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let snapshot = Snapshot::build(&tree, app_name.clone(), pid, now_ms);
    store.save(&snapshot)?;

    Ok(json!({
        "snapshot_id": snapshot.id,
        "app": app_name,
        "pid": pid,
        "ref_count": snapshot.ref_count(),
        "tree": render(&snapshot.tree, depth),
        "suggestion": DRILL_SUGGESTION,
    }))
}

/// Resolve an `@eN` ref from the latest snapshot to current screen coordinates,
/// re-identifying the element in the now-focused window. Returns a `STALE_REF` error
/// (in the message) if the focused app changed or the element is gone.
pub async fn resolve_ref(ref_id: &str) -> Result<(i32, i32)> {
    let store = SnapshotStore::open()?;
    let snapshot = store.load_latest()?;
    let entry = snapshot.find_ref(ref_id).cloned().ok_or_else(|| {
        anyhow::anyhow!(
            "STALE_REF: {ref_id} is not in the latest snapshot ({}); re-run ghost_snapshot",
            snapshot.id
        )
    })?;

    // Focus the snapshot's app so re-identification reads the right window.
    if let Some(app) = &snapshot.app {
        focus_app(app);
        tokio::time::sleep(tokio::time::Duration::from_millis(120)).await;
    }

    let tracker = PlatformWindowTracker::new()?;
    let cur_pid = tracker.get_active_window().await.map(|w| w.pid).unwrap_or(0);
    if snapshot.pid != 0 && cur_pid != 0 && cur_pid != snapshot.pid {
        anyhow::bail!(
            "STALE_REF: the focused app changed (snapshot pid {}, now {}); re-run ghost_snapshot",
            snapshot.pid,
            cur_pid
        );
    }

    let ax = PlatformAXTree::new()?;
    let tree = ax.get_focused_tree().await?;
    match reidentify(&tree, &entry) {
        Resolved::At { x, y } => Ok((x, y)),
        Resolved::Stale(msg) => Err(anyhow::anyhow!(msg)),
    }
}
