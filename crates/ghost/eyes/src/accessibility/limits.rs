//! Walk limits and truncation bookkeeping.
//!
//! Limits carry a *budget*, not an absolute deadline: each walker computes
//! `deadline = Instant::now() + budget` when its walk starts, so every walk
//! (including a re-walk) gets a fresh budget.

use std::time::{Duration, Instant};

use serde::Serialize;

use super::AXTreeNode;

#[derive(Debug, Clone, Copy)]
pub struct WalkLimits {
    pub max_depth: u32,
    pub max_children: usize,
    pub max_nodes: usize,
    pub budget: Duration,
    /// false disables the Linux text/value reads added in this effort (passive capture).
    /// It does not change macOS/Windows value reads, which exist today.
    pub read_values: bool,
}

impl WalkLimits {
    /// macOS {25,100,5000,3s,true}; Windows/Linux {6,100,5000,3s,true}.
    pub fn platform_default() -> Self {
        let max_depth = if cfg!(target_os = "macos") { 25 } else { 6 };
        Self {
            max_depth,
            max_children: 100,
            max_nodes: 5000,
            budget: Duration::from_secs(3),
            read_values: true,
        }
    }

    /// Shadow passive capture, preserving today's per-OS depth/children:
    /// macOS {4,40,1500,1.5s,false}; Windows {4,100,1500,1.5s,false}; Linux {6,100,1500,1.5s,false}.
    pub fn passive() -> Self {
        let (max_depth, max_children) = if cfg!(target_os = "macos") {
            (4, 40)
        } else if cfg!(target_os = "windows") {
            (4, 100)
        } else {
            (6, 100)
        };
        Self {
            max_depth,
            max_children,
            max_nodes: 1500,
            budget: Duration::from_millis(1500),
            read_values: false,
        }
    }

    #[must_use]
    pub fn with_budget(mut self, budget: Duration) -> Self {
        self.budget = budget;
        self
    }

    /// The absolute deadline of a walk that starts now.
    pub fn deadline_from_now(&self) -> Instant {
        Instant::now() + self.budget
    }
}

impl Default for WalkLimits {
    fn default() -> Self {
        Self::platform_default()
    }
}

/// Why a subtree was cut short.
#[derive(Debug, Clone, Copy)]
pub enum TruncationCause {
    Depth,
    Siblings,
    NodeBudget,
    Deadline,
    /// The children could not be read (an error other than "no children"): the
    /// subtree may hold elements the walk never saw.
    ReadError,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct WalkStats {
    pub nodes: usize,
    pub truncated_nodes: u32,
    pub max_depth_hit: bool,
    pub sibling_cap_hit: bool,
    pub node_budget_hit: bool,
    pub deadline_hit: bool,
    /// A node's children could not be read.
    pub read_error_hit: bool,
}

impl WalkStats {
    /// True when no limit cut the walk short.
    pub fn complete(&self) -> bool {
        !(self.max_depth_hit
            || self.sibling_cap_hit
            || self.node_budget_hit
            || self.deadline_hit
            || self.read_error_hit)
    }

    /// Flags `node.subtree_truncated` (counting each node once) and records the cause.
    pub fn mark_truncated(&mut self, node: &mut AXTreeNode, why: TruncationCause) {
        if !node.subtree_truncated {
            node.subtree_truncated = true;
            self.truncated_nodes = self.truncated_nodes.saturating_add(1);
        }
        match why {
            TruncationCause::Depth => self.max_depth_hit = true,
            TruncationCause::Siblings => self.sibling_cap_hit = true,
            TruncationCause::NodeBudget => self.node_budget_hit = true,
            TruncationCause::Deadline => self.deadline_hit = true,
            TruncationCause::ReadError => self.read_error_hit = true,
        }
    }
}

/// Per-walk bookkeeping shared by the platform walkers: the limits, the deadline
/// computed when the walk starts, and the running stats.
pub(crate) struct WalkBudget {
    pub limits: WalkLimits,
    pub deadline: Instant,
    pub stats: WalkStats,
}

impl WalkBudget {
    /// Starts a walk: the deadline is `now + limits.budget`.
    pub(crate) fn start(limits: WalkLimits) -> Self {
        Self {
            limits,
            deadline: limits.deadline_from_now(),
            stats: WalkStats::default(),
        }
    }

    /// Counts one visited node.
    pub(crate) fn visit(&mut self) {
        self.stats.nodes += 1;
    }

    /// Why no further node may be walked, if a limit has run out.
    pub(crate) fn exhausted(&self) -> Option<TruncationCause> {
        if self.stats.nodes >= self.limits.max_nodes {
            Some(TruncationCause::NodeBudget)
        } else if Instant::now() >= self.deadline {
            Some(TruncationCause::Deadline)
        } else {
            None
        }
    }

    /// Flags `node` as truncated for `why`.
    pub(crate) fn truncate(&mut self, node: &mut AXTreeNode, why: TruncationCause) {
        self.stats.mark_truncated(node, why);
    }
}
