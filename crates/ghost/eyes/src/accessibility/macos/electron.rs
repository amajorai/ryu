// Portions adapted from vercel-labs/agent-desktop (Apache-2.0); modified.
//! Chromium/Electron renderer accessibility activation.
//!
//! Chromium builds its web accessibility tree only once an assistive client asks
//! for it, through `AXManualAccessibility` (Electron) or `AXEnhancedUserInterface`
//! (Chromium browsers). Activation is opt-in per call and never fails a snapshot
//! or an action: the outcome is reported as a [`RendererA11y`].

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use super::super::{AXTreeNode, RendererA11y};
use super::attr::*;
use super::cf::{cf_boolean, CfRef};

const MANUAL: &str = "AXManualAccessibility";
const ENHANCED: &str = "AXEnhancedUserInterface";
const CACHE_TTL: Duration = Duration::from_secs(600);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const SETTLE: Duration = Duration::from_secs(2);
/// ENHANCED is written only with more than this left before the deadline.
const ENHANCED_MIN_REMAINING: Duration = Duration::from_secs(2);
const PROBE_MAX_NODES: usize = 3000;
const PROBE_MAX_DEPTH: u32 = 30;

/// Pids whose renderer is known to be enabled, with when that was established.
static CACHE: LazyLock<Mutex<HashMap<i32, Instant>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WebState {
    /// No AXWebArea.
    Absent,
    /// AXWebArea(s), none with children.
    Empty,
    /// An AXWebArea with children.
    Populated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Manual,
    Enhanced,
}

/// The AXWebArea state of a walked tree.
pub(crate) fn web_state(tree: &AXTreeNode) -> WebState {
    fn visit(node: &AXTreeNode, state: &mut WebState) {
        if node.role == "AXWebArea" {
            if !node.children.is_empty() {
                *state = WebState::Populated;
                return;
            }
            *state = WebState::Empty;
        }
        for child in &node.children {
            visit(child, state);
            if *state == WebState::Populated {
                return;
            }
        }
    }
    let mut state = WebState::Absent;
    visit(tree, &mut state);
    state
}

/// MANUAL when settable; ENHANCED only for an empty AXWebArea; else nothing to do.
pub(crate) fn choose_mode(manual_settable: bool, web: WebState) -> Option<Mode> {
    if manual_settable {
        Some(Mode::Manual)
    } else if web == WebState::Empty {
        Some(Mode::Enhanced)
    } else {
        None
    }
}

/// Whether a MANUAL write took effect: a web area gained children, or one appeared.
pub(crate) fn manual_took_effect(before: WebState, now: WebState) -> bool {
    now == WebState::Populated || (before == WebState::Absent && now != WebState::Absent)
}

fn cached(pid: i32) -> bool {
    let Ok(mut cache) = CACHE.lock() else {
        return false;
    };
    cache.retain(|_, at| at.elapsed() < CACHE_TTL);
    cache.contains_key(&pid)
}

fn remember(pid: i32, outcome: RendererA11y) -> RendererA11y {
    if matches!(
        outcome,
        RendererA11y::Enabled | RendererA11y::AlreadyEnabled
    ) {
        if let Ok(mut cache) = CACHE.lock() {
            cache.insert(pid, Instant::now());
        }
    }
    outcome
}

/// Live, role-only probe for AXWebArea under the application element.
fn probe_live(app: &CfRef, deadline: Instant) -> WebState {
    let mut state = WebState::Absent;
    let mut visited = 0usize;
    let mut stack: Vec<(CfRef, u32)> = Vec::new();
    if let Some(app) = unsafe { CfRef::retained(app.as_ptr()) } {
        stack.push((app, 0));
    }
    while let Some((el, depth)) = stack.pop() {
        visited += 1;
        if visited > PROBE_MAX_NODES || !set_timeout(&el, deadline) {
            break;
        }
        let kids: Vec<CfRef> = children(&el).into_iter().flatten().collect();
        if role(&el).as_deref() == Some("AXWebArea") {
            if !kids.is_empty() {
                return WebState::Populated;
            }
            state = WebState::Empty;
        }
        if depth < PROBE_MAX_DEPTH {
            stack.extend(kids.into_iter().rev().map(|k| (k, depth + 1)));
        }
    }
    state
}

/// Enables the renderer accessibility tree of `pid` if it looks needed.
/// Never returns an error; see the module docs.
pub(crate) fn ensure_renderer_accessibility(
    app: &CfRef,
    pid: i32,
    tree: &AXTreeNode,
    deadline: Instant,
) -> RendererA11y {
    if cached(pid) {
        return RendererA11y::AlreadyEnabled;
    }
    if !set_timeout(app, deadline) {
        return RendererA11y::Failed;
    }
    let web = web_state(tree);
    let Some(mode) = choose_mode(is_settable(app, MANUAL), web) else {
        return RendererA11y::NotApplicable;
    };
    match mode {
        Mode::Manual if web == WebState::Populated => {
            return remember(pid, RendererA11y::AlreadyEnabled)
        }
        Mode::Enhanced if attr_bool(app, ENHANCED) == Some(true) => {
            return remember(pid, RendererA11y::AlreadyEnabled)
        }
        Mode::Manual | Mode::Enhanced => {}
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if mode == Mode::Enhanced && remaining <= ENHANCED_MIN_REMAINING {
        return RendererA11y::Failed;
    }
    let attr = match mode {
        Mode::Manual => MANUAL,
        Mode::Enhanced => ENHANCED,
    };
    // A setter error (e.g. NotImplemented) is ignored: the effect decides.
    let _ = set_attr(app, attr, cf_boolean(true));
    let outcome = match mode {
        Mode::Manual => {
            // Do not read MANUAL back: Electron reports it inconsistently.
            let until = Instant::now() + SETTLE.min(remaining);
            loop {
                if manual_took_effect(web, probe_live(app, deadline.min(until))) {
                    break RendererA11y::Enabled;
                }
                if Instant::now() + POLL_INTERVAL > until {
                    break RendererA11y::Unverified;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        }
        Mode::Enhanced => {
            set_timeout(app, deadline);
            let outcome = if attr_bool(app, ENHANCED) == Some(true) {
                RendererA11y::Enabled
            } else {
                RendererA11y::Unverified
            };
            std::thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(SETTLE),
            );
            outcome
        }
    };
    remember(pid, outcome)
}
