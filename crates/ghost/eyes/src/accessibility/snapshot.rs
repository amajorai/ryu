//! Snapshot request and result types.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{AXTreeNode, WalkLimits, WalkStats};
use crate::contract::GhostError;

/// Which window a snapshot (or a live resolution) targets.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WindowTarget {
    #[default]
    Focused,
    /// A window of the frontmost app titled exactly `title`, else the first whose title
    /// contains it (case-insensitive).
    FocusedTitle { title: String },
    /// That process's focused/main window.
    Pid { pid: i32 },
    /// Exact (trimmed) title match only. On a miss: if the process has exactly one
    /// window, use it (Pid behaviour); if it has more than one, STALE_REF with
    /// details.reason "window_changed". Several exact matches are STALE_REF
    /// "window_ambiguous": the snapshot's window cannot be told apart.
    PidTitle { pid: i32, title: String },
}

#[derive(Debug, Clone)]
pub struct SnapshotOptions {
    pub target: WindowTarget,
    pub limits: WalkLimits,
    /// Chromium/Electron renderer activation (macOS only); opt-in per call.
    pub activate_renderer: bool,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            target: WindowTarget::Focused,
            limits: WalkLimits::platform_default(),
            activate_renderer: false,
        }
    }
}

/// Outcome of renderer accessibility activation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererA11y {
    NotApplicable,
    AlreadyEnabled,
    Enabled,
    Unverified,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct AXSnapshot {
    /// Window element; paths are relative to it.
    pub root: AXTreeNode,
    /// 0 only when the backend truly cannot tell (X11 fallback).
    pub pid: i32,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    /// == `stats.complete()`.
    pub complete: bool,
    pub stats: WalkStats,
    /// Activation failure is reported here, never as an `Err`.
    pub renderer: RendererA11y,
}

/// How a window title picked one of a process's windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TitlePick {
    Found(usize),
    /// No title matched; the process has this many windows.
    Miss(usize),
    /// This many windows carry exactly the wanted title (strict only).
    Ambiguous(usize),
}

impl TitlePick {
    /// The `PidTitle` miss rule: a process with a single window uses it.
    pub(crate) fn or_single_window(self) -> Self {
        match self {
            Self::Miss(1) => Self::Found(0),
            other => other,
        }
    }
}

/// Picks a window by title.
///
/// `strict` (the `PidTitle` identity check) accepts only an exact, trimmed title
/// match, and several exact matches are [`TitlePick::Ambiguous`]: a substring hit
/// or a same-titled sibling would resolve the ref in the wrong window. Otherwise
/// (a user-supplied title) the first exact match wins, then the first
/// case-insensitive substring match.
pub(crate) fn pick_window_title(titles: &[Option<&str>], wanted: &str, strict: bool) -> TitlePick {
    let wanted = wanted.trim();
    let exact: Vec<usize> = titles
        .iter()
        .enumerate()
        .filter(|(_, t)| t.is_some_and(|t| t.trim() == wanted))
        .map(|(i, _)| i)
        .collect();
    match (exact.as_slice(), strict) {
        ([only], _) => return TitlePick::Found(*only),
        ([first, ..], false) => return TitlePick::Found(*first),
        ([_, _, ..], true) => return TitlePick::Ambiguous(exact.len()),
        _ => {}
    }
    if !strict {
        let needle = wanted.to_lowercase();
        let hit = titles
            .iter()
            .position(|t| t.is_some_and(|t| t.to_lowercase().contains(&needle)));
        if let Some(i) = hit {
            return TitlePick::Found(i);
        }
    }
    TitlePick::Miss(titles.len())
}

/// STALE_REF for a window the snapshot's title no longer singles out:
/// `window_ambiguous` for [`TitlePick::Ambiguous`], else `window_changed`.
pub(crate) fn window_pick_error(pick: TitlePick, pid: i32) -> GhostError {
    let (reason, count, message) = match pick {
        TitlePick::Ambiguous(count) => (
            "window_ambiguous",
            count,
            "several windows share the snapshot's window title, so its window cannot be told apart",
        ),
        TitlePick::Miss(count) => (
            "window_changed",
            count,
            "the window the snapshot was taken from is no longer present",
        ),
        TitlePick::Found(_) => (
            "window_changed",
            1,
            "the window the snapshot was taken from is no longer present",
        ),
    };
    GhostError::stale_ref(message)
        .with_details(json!({ "reason": reason, "pid": pid, "window_count": count }))
        .with_suggestion("take a new snapshot")
}
