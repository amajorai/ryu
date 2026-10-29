# ryu-deletion-guard

Shared, pure detection for permanent file and directory deletion attempts.

The crate is intentionally independent of Core, Gateway, configuration, and the
filesystem. It is used at multiple execution seams so a local fallback or a
different tool transport cannot silently turn a blocked deletion back on.

The detector recognizes direct deletion commands (including Windows `del`,
`erase`, `rd`, and PowerShell removal verbs), nested shell wrappers, destructive Git
operations, common scripting-language deletion APIs, patch file deletion
markers, and filesystem-shaped MCP tool ids. It does not move files or rewrite
commands; callers deny the operation and direct the user to the host's
recoverable Trash or Recycle Bin mechanism.

Command classification rejects input above 2 MiB or above an 8 MiB byte-weighted
scan-work budget with the stable `scan_work_limit` rule. Suffix searches reserve
their token bytes plus one unit per token before searching, and nested wrappers
share the same budget. Repeated shell or Git words cannot force unbounded repeated
suffix scans; exceeding the budget denies execution rather than skipping the guard.
