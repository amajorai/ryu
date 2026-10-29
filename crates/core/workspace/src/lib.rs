//! Git-native workspace primitive for Ryu.
//!
//! The git/worktree engine extracted from `apps/core/src/server/{git,worktree}.rs`.
//! It shells `git`/`gh` against a caller-supplied cwd and owns:
//!
//! - **[`worktree`]** — per-run worktrees (`create_worktree_in` → an isolated
//!   `ryu/run-<id>` branch under `.ryu-worktrees/`, `Drop`-on-completion cleanup),
//!   the aggregate run diff ([`worktree::worktree_diff`]), and whole-tree apply
//!   ([`worktree::apply_worktree`]: commit → merge-into-base OR commit → push →
//!   `gh pr create`).
//! - **[`git`]** — read-only status/branches plus checkout/create-branch/
//!   commit-push helpers.
//!
//! In-process by default: every entry point is a plain function call, never IPC.
//! ZERO dependency on `apps/core` — the only kernel coupling is the Windows
//! console-suppression [`win_process::NoWindow`] util, vendored verbatim. The
//! axum HTTP handlers that call these functions, the live `WorktreeDiffStore`
//! run-state, and the ChatStreamRequest→cwd threading all stay in Core.

mod win_process;

pub mod checkpoints;
pub mod git;
pub mod handoff;
pub mod source_history;
pub mod worktree;

#[cfg(test)]
#[path = "checkpoints/rewind_pin_tests.rs"]
mod checkpoint_rewind_pin_tests;
#[cfg(test)]
#[path = "git/hooks_tests.rs"]
mod git_hooks_tests;
#[cfg(test)]
#[path = "worktree_branch_tests.rs"]
mod worktree_branch_tests;
