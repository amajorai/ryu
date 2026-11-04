use super::*;

/// Normalize `.`/`..` without touching the filesystem. This keeps checks for
/// not-yet-created write targets lexical while the existing-target helpers below
/// add canonical and symlink checks before any read or write.
fn normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// True when `path` stays inside `root` after lexical normalization. A relative
/// path is joined to `root` first. The filesystem is not consulted here because
/// this helper also governs a not-yet-created write target.
pub(super) fn path_within_root(root: &std::path::Path, path: &std::path::Path) -> bool {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    normalize_path(&abs).starts_with(normalize_path(root))
}

fn scoped_path(roots: &[std::path::PathBuf], path: &std::path::Path) -> Option<std::path::PathBuf> {
    roots.iter().find_map(|root| {
        if path_within_root(root, path) {
            let candidate = if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            };
            Some(normalize_path(&candidate))
        } else {
            None
        }
    })
}

fn path_has_symlink_component_below_root(path: &std::path::Path, root: &std::path::Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    false
}

/// A checked `fs/*` target: the canonical session root plus the plain relative
/// path below it. It is opened only through `open_beneath`, never by name, so a
/// symlink swapped in after the check cannot redirect the read or write.
pub(super) struct ScopedTarget {
    pub(super) root: std::path::PathBuf,
    pub(super) rel: std::path::PathBuf,
}

/// Check an existing client-hosted path: both its lexical and canonical forms
/// must stay within one session root, no component below the root may be a
/// symlink, and the target must not be a protected host path. This is an early
/// refusal only; `open_beneath` re-enforces the no-symlink walk at open time.
pub(super) fn scoped_existing_target(
    roots: &[std::path::PathBuf],
    path: &std::path::Path,
) -> Option<ScopedTarget> {
    roots.iter().find_map(|root| {
        let candidate = scoped_path(std::slice::from_ref(root), path)?;
        let canonical_root = std::fs::canonicalize(root).ok()?;
        let canonical = std::fs::canonicalize(&candidate).ok()?;
        if !path_within_root(&canonical_root, &canonical)
            || path_has_symlink_component_below_root(&candidate, root)
            || crate::tool_exec::is_protected_host_path(&canonical)
        {
            return None;
        }
        let rel = canonical.strip_prefix(&canonical_root).ok()?.to_path_buf();
        Some(ScopedTarget {
            root: canonical_root,
            rel,
        })
    })
}

/// Validate a write target without requiring the target itself to exist. Every
/// existing ancestor must be a real, in-root directory; a missing suffix may be
/// created, but a symlink anywhere below the session root is refused. Like
/// `scoped_existing_target`, this is an early refusal; `open_beneath` enforces
/// the walk again when the file is created.
pub(super) fn scoped_write_target(
    roots: &[std::path::PathBuf],
    path: &std::path::Path,
) -> Option<ScopedTarget> {
    roots.iter().find_map(|root| {
        let candidate = scoped_path(std::slice::from_ref(root), path)?;
        let canonical_root = std::fs::canonicalize(root).ok()?;
        let mut existing = candidate.clone();
        while !existing.exists() {
            if !existing.pop() {
                return None;
            }
        }
        let canonical_existing = std::fs::canonicalize(&existing).ok()?;
        if !path_within_root(&canonical_root, &canonical_existing)
            || path_has_symlink_component_below_root(&existing, root)
            || path_has_symlink_component_below_root(&candidate, root)
            || crate::tool_exec::is_protected_host_path(&canonical_existing)
            || crate::tool_exec::is_protected_host_path(&candidate)
        {
            return None;
        }
        let rel = candidate
            .strip_prefix(normalize_path(root))
            .ok()?
            .to_path_buf();
        Some(ScopedTarget {
            root: canonical_root,
            rel,
        })
    })
}

/// Serve `fs/read_text_file`, applying the optional 1-based `line` offset and
/// `limit`. Confined to the session workspace root: an out-of-root path returns
/// `""` (the ACP response carries only `content`; degrading to empty matches how
/// a missing file behaves, and never feeds out-of-workspace secrets to the
/// model). Returns `""` on any open or read error likewise.
pub(super) fn read_text_file_scoped_in_roots(
    req: &ReadTextFileRequest,
    roots: &[std::path::PathBuf],
) -> String {
    let Some(target) = scoped_existing_target(roots, &req.path) else {
        tracing::warn!(
            path = %req.path.display(),
            "fs/read_text_file refused: path is outside the session workspaces"
        );
        return String::new();
    };
    read_scoped_target(&target, req.line, req.limit)
}

/// Read a checked target through `open_beneath`, applying the optional 1-based
/// `line` offset and `limit`. Any open or read failure, including a symlink
/// swapped in after the check, degrades to `""`.
pub(super) fn read_scoped_target(
    target: &ScopedTarget,
    line: Option<u32>,
    limit: Option<u32>,
) -> String {
    const MAX_READ_BYTES: usize = 4 * 1024 * 1024;
    use std::io::Read as _;

    let Ok(file) = super::scoped_open::open_beneath(&target.root, &target.rel, false) else {
        return String::new();
    };
    let mut bytes = Vec::new();
    if file
        .take((MAX_READ_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return String::new();
    }
    if bytes.len() > MAX_READ_BYTES {
        bytes.truncate(MAX_READ_BYTES);
    }
    let content = String::from_utf8_lossy(&bytes).into_owned();
    if line.is_none() && limit.is_none() {
        return content;
    }
    let lines: Vec<&str> = content.lines().collect();
    let start = line.unwrap_or(1).saturating_sub(1) as usize;
    if start >= lines.len() {
        return String::new();
    }
    let end = limit
        .map(|l| (start + l as usize).min(lines.len()))
        .unwrap_or(lines.len());
    lines[start..end].join("\n")
}

/// Serve `fs/write_text_file`, creating parent directories as needed. Confined
/// to the session workspace root — an out-of-root path is refused (no directory
/// is created, nothing is written).
pub(super) fn write_text_file_scoped_in_roots(
    req: &WriteTextFileRequest,
    roots: &[std::path::PathBuf],
) -> anyhow::Result<()> {
    let Some(target) = scoped_write_target(roots, &req.path) else {
        return Err(anyhow::anyhow!(
            "refusing write outside the session workspaces: {}",
            req.path.display()
        ));
    };
    write_scoped_target(&target, &req.content)
        .map_err(|e| anyhow::anyhow!("write {}: {e}", req.path.display()))
}

/// Create or truncate a checked target through `open_beneath` and write
/// `content`. Missing parents are created without following symlinks.
pub(super) fn write_scoped_target(target: &ScopedTarget, content: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut file = super::scoped_open::open_beneath(&target.root, &target.rel, true)?;
    file.write_all(content.as_bytes())
}

/// Collapse a tool call's `content` blocks (text/diff/terminal) into a JSON
/// value the UI can render as output. Plain text blocks are concatenated;
/// anything richer passes through as structured JSON.
pub(super) fn tool_content_to_output(content: &[ToolCallContent]) -> Option<serde_json::Value> {
    if content.is_empty() {
        return None;
    }
    let mut text = String::new();
    let mut structured: Vec<serde_json::Value> = Vec::new();
    for block in content {
        match block {
            ToolCallContent::Content(c) => {
                if let ContentBlock::Text(t) = &c.content {
                    text.push_str(&t.text);
                } else if let Ok(v) = serde_json::to_value(&c.content) {
                    structured.push(v);
                }
            }
            other => {
                if let Ok(v) = serde_json::to_value(other) {
                    structured.push(v);
                }
            }
        }
    }
    if structured.is_empty() {
        (!text.is_empty()).then(|| serde_json::Value::String(text))
    } else {
        if !text.is_empty() {
            structured.push(serde_json::Value::String(text));
        }
        Some(serde_json::Value::Array(structured))
    }
}

/// If a tool's content carries an ACP `Diff` block — the protocol-standard,
/// agent-agnostic way an agent reports a file edit (the same signal Zed renders
/// its diffs from) — surface it in the exact shape the desktop's Edit/Write diff
/// card reads: `{ old_content, content, path }`. ACP edits arrive *here* (in the
/// content block), not in the agent-specific `raw_input`, so without this the
/// diff card renders empty for ACP agents. Returns `None` when no diff is present
/// (non-edit tools are unaffected).
pub(super) fn extract_diff_output(content: &[ToolCallContent]) -> Option<serde_json::Value> {
    content.iter().find_map(|block| match block {
        ToolCallContent::Diff(diff) => Some(serde_json::json!({
            "old_content": diff.old_text.clone().unwrap_or_default(),
            "content": diff.new_text.clone(),
            "path": diff.path.display().to_string(),
        })),
        _ => None,
    })
}
