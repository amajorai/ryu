//! Project instruction files and their content revisions.

use super::*;

/// Content hash (hex) used to dedup memory imports and to key the imported
/// instructions snapshot in the preferences store.
pub fn content_sha256(content: &str) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(content.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

// ---------------------------------------------------------------------------
// Project instructions → system prompt (the runtime half of "import setup")
// ---------------------------------------------------------------------------

/// Candidate instruction file names at a project root, most canonical first.
/// Mirrors the desktop's `resolveProjectAgentsFile` order (`AGENTS.md` variants
/// before `CLAUDE.md`), so the prompt copy and the editor agree on which file
/// wins when both exist.
pub(super) const PROJECT_INSTRUCTION_CANDIDATES: &[&str] = &[
    "AGENTS.md",
    "agents.md",
    "Agents.md",
    "CLAUDE.md",
    "claude.md",
];

/// Read the project instructions for a working folder, if any: the first
/// existing `AGENTS.md` / `CLAUDE.md` (case-insensitive) directly under `cwd`.
///
/// This is what makes an imported (or merely opened) project's instructions
/// actually *take effect*: the import flow registers the folder as a project,
/// and every turn that runs in that folder picks the file up here — live, so
/// editing the file (in ProjectSettingsDialog or directly) applies immediately.
///
/// Returns `(file_name, content)` where content is capped at
/// [`MAX_PROJECT_INSTRUCTIONS_PROMPT_BYTES`] with a truncation note. `None` for
/// a missing folder, no candidate file, an unreadable file, or one over the cap
/// — a project without instructions degrades to no block, never an error.
pub fn project_instructions(cwd: &str) -> Option<(String, String)> {
    let dir = Path::new(cwd);
    if !dir.is_dir() {
        return None;
    }
    let home = dirs::home_dir();
    let mut roots = Vec::new();
    let mut current = Some(dir);
    while let Some(root) = current {
        roots.push(root);
        current = root.parent();
    }
    roots.reverse();
    if let Some(home) = home.as_deref() {
        roots.retain(|root| root.starts_with(home) || *root == dir);
    }
    let mut found = Vec::new();
    for root in roots {
        for name in PROJECT_INSTRUCTION_CANDIDATES {
            let path = root.join(name);
            if !path.is_file() {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            if content.trim().is_empty() {
                continue;
            }
            found.push((
                name.to_string(),
                truncate_prompt_instructions(&content, meta.len()),
            ));
            break;
        }
    }
    (!found.is_empty()).then(|| {
        (
            found
                .iter()
                .map(|(path, _)| path.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            found
                .into_iter()
                .map(|(_, content)| content)
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
    })
}

/// Bound an instructions body for the system prompt, appending a one-line note
/// when the original exceeded the prompt cap so the model never mistakes the
/// truncated copy for the whole file.
pub(super) fn truncate_prompt_instructions(content: &str, file_len: u64) -> String {
    let bytes = content.len() as u64;
    if bytes <= MAX_PROJECT_INSTRUCTIONS_PROMPT_BYTES {
        return content.to_string();
    }
    // Cut on a UTF-8 boundary.
    let mut end = MAX_PROJECT_INSTRUCTIONS_PROMPT_BYTES as usize;
    while end > 0 && !content.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n\n(project instructions truncated from {:.1} KB — open the file for the rest)",
        &content[..end],
        file_len as f64 / 1024.0
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
