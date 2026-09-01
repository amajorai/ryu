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
