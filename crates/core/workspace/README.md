# ryu-workspace

Git-native workspace primitive for Ryu: the git / worktree engine that shells
`git` / `gh` for a caller-supplied `cwd`.

## Role in the decomposition

An extracted Core capability crate — **in-process by default** and consumed as a
**non-optional path dependency**: the ACP chat loop opens a worktree per isolated
run. It carries **zero dependency on `apps/core`**. The only kernel coupling is the
Windows console-suppression `NoWindow` util, vendored verbatim (`win_process.rs` — a
`Command`-builder extension trait with no shared crate home). The chat-cwd threading
(`ChatStreamRequest → conversations.rs`) stays kernel; only the git engine moves
here.

## Key API

`worktree.rs`:
- `create_worktree` / `create_worktree_in` → `WorktreeGuard` — per-run worktree on
  an isolated `ryu/run-<id>` branch, cleaned up on `Drop`.
- `worktree_diff(path, base_ref) -> WorktreeDiff` — aggregate run diff (committed +
  staged/untracked, numstat + name-status); `FileSummary` / `FileChangeKind`.
- `apply_worktree(..., ApplyMode)` — whole-tree apply: commit → merge-into-base, or
  commit → push → `gh pr create`; `ApplySuccess` / `ConflictError`.
- `is_git_repo` / `find_git_root`.

`git.rs` (read-only + simple mutations):
- `query_git_state(cwd) -> GitState`, `list_branches -> GitBranches`,
  `checkout_branch`, `create_branch`, `run_git_action -> CommitPushOutcome`.

## Swap seam

None — this is the git engine itself (shells `git`/`gh`); it is a swappable *default*
only at the Core layer that chooses to open a per-run worktree.

## Consumed as

Compiled-into-Core crate (default path dependency); no optional features.
