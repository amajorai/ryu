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

/// Serve `fs/read_text_file`, applying the optional 1-based `line` offset and
/// `limit`. Confined to the session workspace root: an out-of-root path returns
/// `""` (the ACP response carries only `content`; degrading to empty matches how
/// a missing file behaves, and never feeds out-of-workspace secrets to the
/// model). Existing targets are canonicalized, checked for symlink components,
/// and checked against protected host paths before the read. Returns `""` on any
/// read error likewise.
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

/// Resolve an existing client-hosted path only when both its lexical and
/// canonical forms stay within one session root. The canonical result prevents
/// the child filesystem from following a workspace symlink after the check, and
/// the explicit component check rejects symlink aliases that still point inside
/// the workspace.
fn scoped_existing_path(
    roots: &[std::path::PathBuf],
    path: &std::path::Path,
) -> Option<std::path::PathBuf> {
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
        Some(canonical)
    })
}

/// Validate a write target without requiring the target itself to exist. Every
/// existing ancestor must be a real, in-root directory; a missing suffix may be
/// created, but a symlink anywhere below the session root is refused.
fn scoped_write_path(
    roots: &[std::path::PathBuf],
    path: &std::path::Path,
) -> Option<std::path::PathBuf> {
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
        Some(candidate)
    })
}

pub(super) fn read_text_file_scoped_in_roots(
    req: &ReadTextFileRequest,
    roots: &[std::path::PathBuf],
) -> String {
    const MAX_READ_BYTES: usize = 4 * 1024 * 1024;
    use std::io::Read as _;

    let Some(path) = scoped_existing_path(roots, &req.path) else {
        tracing::warn!(
            path = %req.path.display(),
            "fs/read_text_file refused: path is outside the session workspaces"
        );
        return String::new();
    };
    let Ok(file) = std::fs::File::open(path) else {
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
    if req.line.is_none() && req.limit.is_none() {
        return content;
    }
    let lines: Vec<&str> = content.lines().collect();
    let start = req.line.unwrap_or(1).saturating_sub(1) as usize;
    if start >= lines.len() {
        return String::new();
    }
    let end = req
        .limit
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
    let Some(path) = scoped_write_path(roots, &req.path) else {
        return Err(anyhow::anyhow!(
            "refusing write outside the session workspaces: {}",
            req.path.display()
        ));
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, &req.content)
        .map_err(|e| anyhow::anyhow!("write {}: {e}", path.display()))
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
