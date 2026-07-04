//! Reading an ACP agent's *own* on-disk conversation history so Ryu can list and
//! import past threads — the "import agent thread" feature (Zed/VSCode parity).
//!
//! When you run Claude Code / Codex / etc. as an ACP subprocess, the agent keeps
//! its own transcript on disk (Claude Code → `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`,
//! Codex → `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`). Zed lets you *import*
//! those threads and VS Code surfaces them automatically; Ryu never read them.
//! This module resolves each engine's history store, lists the threads, and reads
//! one thread back as a normalized `[{role, content}]` transcript that the caller
//! materializes into a Ryu conversation.
//!
//! Scope: this is a *read-only* importer. It restores the transcript as text — it
//! does **not** warm the agent's own internal context (that is ACP `session/load`,
//! a separate, riskier piece deferred deliberately; Ryu already re-feeds recent
//! history to the agent on its next turn via the short-term replay in the adapter).
//!
//! Only engines with a known, verified on-disk format are supported
//! ([`engine_spec`]); every other agent returns an empty list so the UI degrades
//! to "no importable threads" rather than erroring.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

/// Max threads returned by a single list call (newest first). A cap keeps the
/// picker responsive on machines with thousands of historical sessions.
const MAX_THREADS: usize = 200;
/// Max transcript files actually parsed per list call. A cheap `mtime` stat pass
/// picks the newest this many files before any full parse, so total scan work is
/// bounded regardless of how many sessions have accumulated on disk. Set above
/// [`MAX_THREADS`] so empty/unparseable files don't starve the returned count.
const SCAN_LIMIT: usize = 400;
/// Max messages imported from a single thread. Guards the sealed `messages`
/// table against a pathologically long transcript; truncation is surfaced.
const MAX_IMPORT_MESSAGES: usize = 2000;
/// Skip transcript files larger than this when scanning for list metadata.
const MAX_SCAN_BYTES: u64 = 32 * 1024 * 1024;

/// The on-disk transcript format an engine writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryFormat {
    /// Claude Code: `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`, one JSON
    /// object per line with `type`, `sessionId`, `cwd`, `gitBranch`, and a
    /// `message` object (`role` + `content`).
    ClaudeJsonl,
    /// Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one JSON object
    /// per line wrapping a `payload` whose `type` is `session_meta` / `message`
    /// / `turn_context` / etc.
    CodexRollout,
}

/// One importable thread from an agent's native history store.
#[derive(Debug, Clone, Serialize)]
pub struct NativeThread {
    /// Opaque, engine-relative locator (posix path under the engine root, minus
    /// the `.jsonl` extension). Round-trips back to a file in [`read_thread`].
    pub id: String,
    pub engine: String,
    pub title: String,
    /// Working directory the thread ran in, if the transcript records one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// The agent's own session/thread id (Claude Code uuid, Codex `session_id`),
    /// recorded so a future ACP `session/load` can warm-resume the agent context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_session_id: Option<String>,
    pub message_count: usize,
    /// File mtime in epoch millis — the thread's last-activity time.
    pub updated_at: i64,
}

/// A normalized transcript message ready to persist into a Ryu conversation.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedMessage {
    /// `"user"` or `"assistant"`.
    pub role: String,
    pub content: String,
}

/// A fully read thread: its metadata plus the transcript.
#[derive(Debug, Clone, Serialize)]
pub struct ImportedThread {
    pub thread: NativeThread,
    pub messages: Vec<ImportedMessage>,
    /// True when the transcript was longer than [`MAX_IMPORT_MESSAGES`] and the
    /// tail was dropped — surfaced so the caller never implies a full import.
    pub truncated: bool,
}

/// Resolve an engine id to its history root directory and format. Returns
/// `None` for engines whose store we do not (yet) parse.
///
/// `engine` is the [`crate::sidecar::adapters::AgentInfo::engine`] value — the
/// agent id with any `acp:` prefix stripped (e.g. `claude`, `codex`).
fn engine_spec(engine: &str) -> Option<(PathBuf, HistoryFormat)> {
    match engine {
        "claude" | "claude-code" => Some((claude_projects_root()?, HistoryFormat::ClaudeJsonl)),
        "codex" => Some((codex_sessions_root()?, HistoryFormat::CodexRollout)),
        _ => None,
    }
}

/// Whether Ryu can list/import an engine's native history — drives the UI's
/// decision to show the "import thread" affordance for a given agent.
pub fn engine_supports_history(engine: &str) -> bool {
    matches!(engine, "claude" | "claude-code" | "codex")
}

/// `<CLAUDE_CONFIG_DIR|~/.claude>/projects`, honouring the same override the
/// Claude CLI itself reads (mirrors `usage::claude::credentials_path`).
fn claude_projects_root() -> Option<PathBuf> {
    let home = std::env::var("CLAUDE_CONFIG_DIR")
        .ok()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")))?;
    Some(home.join("projects"))
}

/// First existing Codex `sessions` root among the locations the CLI honours:
/// `$CODEX_HOME/sessions`, `~/.codex/sessions`, `~/.config/codex/sessions`.
fn codex_sessions_root() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(custom) = std::env::var("CODEX_HOME") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            candidates.push(PathBuf::from(trimmed).join("sessions"));
        }
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".codex").join("sessions"));
        candidates.push(home.join(".config").join("codex").join("sessions"));
    }
    candidates.into_iter().find(|p| p.is_dir())
}

/// List an engine's importable threads, newest first, capped at [`MAX_THREADS`].
///
/// When `cwd_filter` is `Some`, only threads that ran in that directory are
/// returned (Claude Code stores per-project, so this is a cheap dir match; for
/// Codex the cwd is read from the transcript). Unsupported engines return `Ok([])`.
pub fn list_threads(engine: &str, cwd_filter: Option<&str>) -> Result<Vec<NativeThread>> {
    let Some((root, format)) = engine_spec(engine) else {
        return Ok(Vec::new());
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut threads = match format {
        HistoryFormat::ClaudeJsonl => list_claude(engine, &root, cwd_filter)?,
        HistoryFormat::CodexRollout => list_codex(engine, &root, cwd_filter)?,
    };
    threads.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    threads.truncate(MAX_THREADS);
    Ok(threads)
}

/// Read one thread's transcript. `id` is the opaque locator from [`list_threads`].
pub fn read_thread(engine: &str, id: &str) -> Result<ImportedThread> {
    let Some((root, format)) = engine_spec(engine) else {
        bail!("engine {engine:?} has no readable native history");
    };
    let path = resolve_thread_path(&root, id)?;
    let (mut messages, meta) = match format {
        HistoryFormat::ClaudeJsonl => parse_claude_file(&path)?,
        HistoryFormat::CodexRollout => parse_codex_file(&path)?,
    };
    let truncated = messages.len() > MAX_IMPORT_MESSAGES;
    if truncated {
        messages.truncate(MAX_IMPORT_MESSAGES);
    }
    let updated_at = file_mtime_millis(&path);
    let thread = NativeThread {
        id: id.to_string(),
        engine: engine.to_string(),
        // Fall back to the first user line, exactly as the list does — otherwise
        // a summary-less thread (every Codex thread, and Claude threads with no
        // `summary` line) would import as a generic title that set_title locks.
        title: meta
            .title
            .clone()
            .unwrap_or_else(|| first_line_title(&messages)),
        cwd: meta.cwd,
        git_branch: meta.git_branch,
        native_session_id: meta.native_session_id,
        message_count: messages.len(),
        updated_at,
    };
    Ok(ImportedThread {
        thread,
        messages,
        truncated,
    })
}

/// Resolve an opaque engine-relative `id` back to a `.jsonl` file under `root`,
/// rejecting any traversal outside the store.
fn resolve_thread_path(root: &Path, id: &str) -> Result<PathBuf> {
    if id.is_empty() || id.contains("..") || id.starts_with('/') {
        bail!("invalid thread id");
    }
    let mut path = root.to_path_buf();
    for segment in id.split('/') {
        if segment.is_empty() || segment == "." {
            bail!("invalid thread id");
        }
        path.push(segment);
    }
    path.set_extension("jsonl");
    let canonical = fs::canonicalize(&path).with_context(|| format!("thread {id:?} not found"))?;
    let canonical_root = fs::canonicalize(root).context("canonicalizing history root")?;
    if !canonical.starts_with(&canonical_root) {
        bail!("thread id escapes history root");
    }
    Ok(canonical)
}

/// Metadata scraped from a transcript header/first turn.
#[derive(Default)]
struct ThreadMeta {
    title: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    native_session_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

fn list_claude(engine: &str, root: &Path, cwd_filter: Option<&str>) -> Result<Vec<NativeThread>> {
    let filter_slug = cwd_filter.map(claude_cwd_slug);
    // Cheap pass: gather candidate files with their mtime + id, no parsing yet.
    let mut candidates: Vec<Candidate> = Vec::new();
    for project in read_dir_sorted(root) {
        if !project.is_dir() {
            continue;
        }
        let project_name = match project.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if let Some(slug) = &filter_slug {
            if &project_name != slug {
                continue;
            }
        }
        for file in read_dir_sorted(&project) {
            if file.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = file.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            candidates.push(Candidate {
                mtime: file_mtime_millis(&file),
                id: format!("{project_name}/{stem}"),
                path: file,
            });
        }
    }
    // Parse only the newest SCAN_LIMIT so total work is bounded no matter how
    // many sessions have accumulated. The Claude filename stem is the session id.
    Ok(materialize(engine, candidates, parse_claude_file))
}

/// A cheaply-gathered list candidate: enough to sort by recency and locate the
/// file, before committing to a full parse.
struct Candidate {
    path: PathBuf,
    id: String,
    mtime: i64,
}

/// Sort candidates newest-first, keep the newest [`SCAN_LIMIT`], then parse each
/// with `parse` and build a [`NativeThread`] — dropping empty/unparseable files.
fn materialize(
    engine: &str,
    mut candidates: Vec<Candidate>,
    parse: fn(&Path) -> Result<(Vec<ImportedMessage>, ThreadMeta)>,
) -> Vec<NativeThread> {
    candidates.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    candidates.truncate(SCAN_LIMIT);
    let mut out = Vec::new();
    for cand in candidates {
        let (messages, meta) = match parse(&cand.path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if messages.is_empty() {
            continue;
        }
        // Claude records no session_id on some line types; the filename stem (the
        // last id segment) is the session UUID, so use it as the fallback.
        let stem_fallback = cand.id.rsplit('/').next().map(str::to_string);
        out.push(NativeThread {
            id: cand.id,
            engine: engine.to_string(),
            title: meta.title.unwrap_or_else(|| first_line_title(&messages)),
            cwd: meta.cwd,
            git_branch: meta.git_branch,
            native_session_id: meta.native_session_id.or(stem_fallback),
            message_count: messages.len(),
            updated_at: cand.mtime,
        });
    }
    out
}

/// Claude Code slugs a cwd into its project dir name by replacing every `/` and
/// `.` with `-` (e.g. `/Users/x/y.z` → `-Users-x-y-z`).
fn claude_cwd_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

fn parse_claude_file(path: &Path) -> Result<(Vec<ImportedMessage>, ThreadMeta)> {
    let file = fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    if file.metadata().map(|m| m.len()).unwrap_or(0) > MAX_SCAN_BYTES {
        bail!("transcript too large to scan");
    }
    let reader = BufReader::new(file);
    let mut messages = Vec::new();
    let mut meta = ThreadMeta::default();
    for line in reader.lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            _ => continue,
        };
        let obj: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = obj.get("type").and_then(Value::as_str).unwrap_or("");
        // A dedicated `summary` line carries the human-facing thread title.
        if kind == "summary" {
            if let Some(s) = obj.get("summary").and_then(Value::as_str) {
                if !s.trim().is_empty() {
                    meta.title = Some(s.trim().to_string());
                }
            }
            continue;
        }
        if kind != "user" && kind != "assistant" {
            continue;
        }
        // Sidechain lines belong to sub-agent runs, not the main transcript.
        if obj.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if meta.cwd.is_none() {
            meta.cwd = obj
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
        if meta.git_branch.is_none() {
            meta.git_branch = obj
                .get("gitBranch")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
        if meta.native_session_id.is_none() {
            meta.native_session_id = obj
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
        let message = match obj.get("message") {
            Some(m) => m,
            None => continue,
        };
        let role = message.get("role").and_then(Value::as_str).unwrap_or(kind);
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = extract_claude_text(message.get("content"));
        if text.trim().is_empty() {
            continue;
        }
        messages.push(ImportedMessage {
            role: role.to_string(),
            content: text,
        });
    }
    Ok((messages, meta))
}

/// Flatten Claude's `content` (a string for user turns, or a block array with
/// `text`/`thinking`/`tool_use`/`tool_result` blocks) into plain transcript
/// text, keeping only human-readable `text` blocks.
fn extract_claude_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        if !t.trim().is_empty() {
                            parts.push(t.trim().to_string());
                        }
                    }
                }
            }
            parts.join("\n\n")
        }
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

fn list_codex(engine: &str, root: &Path, cwd_filter: Option<&str>) -> Result<Vec<NativeThread>> {
    // Cheap pass: gather candidate files with mtime + engine-relative id.
    let mut candidates: Vec<Candidate> = Vec::new();
    for file in codex_rollout_files(root) {
        let Some(rel) = file
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .map(|r| r.trim_end_matches(".jsonl").replace('\\', "/"))
        else {
            continue;
        };
        candidates.push(Candidate {
            mtime: file_mtime_millis(&file),
            id: rel,
            path: file,
        });
    }
    let mut threads = materialize(engine, candidates, parse_codex_file);
    // Codex records its cwd inside the transcript, so a cwd filter can only be
    // applied after parsing — within the newest-SCAN_LIMIT window.
    if let Some(want) = cwd_filter {
        threads.retain(|t| t.cwd.as_deref() == Some(want));
    }
    Ok(threads)
}

/// Depth limit for the Codex session walk (`sessions/YYYY/MM/DD/…` is depth 3).
/// A generous cap that still stops a pathological tree cold.
const CODEX_WALK_MAX_DEPTH: usize = 8;

/// Recursively collect `rollout-*.jsonl` files under the Codex sessions root
/// (laid out as `YYYY/MM/DD/rollout-*.jsonl`).
///
/// Directory symlinks are NOT followed and the descent is depth-capped, so a
/// self-referential symlink (`sessions/loop -> sessions`) can't spin the walk
/// into an unbounded loop / OOM on the blocking thread.
fn codex_rollout_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        for entry in read_dir_sorted(&dir) {
            // Never traverse into a symlink — check the link itself, not its
            // target, so a directory symlink is skipped rather than followed.
            let is_symlink = fs::symlink_metadata(&entry)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(true);
            if is_symlink {
                continue;
            }
            if entry.is_dir() {
                if depth < CODEX_WALK_MAX_DEPTH {
                    stack.push((entry, depth + 1));
                }
            } else if entry.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let is_rollout = entry
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("rollout-"))
                    .unwrap_or(false);
                if is_rollout {
                    out.push(entry);
                }
            }
        }
    }
    out
}

fn parse_codex_file(path: &Path) -> Result<(Vec<ImportedMessage>, ThreadMeta)> {
    let file = fs::File::open(path).with_context(|| format!("opening {}", path.display()))?;
    if file.metadata().map(|m| m.len()).unwrap_or(0) > MAX_SCAN_BYTES {
        bail!("transcript too large to scan");
    }
    let reader = BufReader::new(file);
    let mut messages = Vec::new();
    let mut meta = ThreadMeta::default();
    for line in reader.lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            _ => continue,
        };
        let obj: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Codex records nest the real item type in `payload.type` (`message`,
        // `turn_context`, `reasoning`, …) under an outer wrapper type
        // (`response_item`/`event_msg`); only `session_meta` carries its type on
        // the outer object with no inner `type`. So read the inner type first and
        // fall back to the outer wrapper type.
        let payload = obj.get("payload").unwrap_or(&obj);
        let ptype = payload
            .get("type")
            .or_else(|| obj.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match ptype {
            "session_meta" => {
                if meta.cwd.is_none() {
                    meta.cwd = payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                }
                if meta.native_session_id.is_none() {
                    meta.native_session_id = payload
                        .get("session_id")
                        .or_else(|| payload.get("id"))
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                }
            }
            "turn_context" => {
                if meta.cwd.is_none() {
                    meta.cwd = payload
                        .get("cwd")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string);
                }
            }
            // The canonical transcript: `message` items carry the real user and
            // assistant turns as `input_text` / `output_text` content blocks.
            // (The `user_message` / `agent_message` events are internal governance
            // /tool traffic, not the human conversation — deliberately skipped.)
            "message" => {
                let role = payload.get("role").and_then(Value::as_str).unwrap_or("");
                if role != "user" && role != "assistant" {
                    continue;
                }
                let text = extract_codex_text(payload.get("content"));
                if text.trim().is_empty() {
                    continue;
                }
                messages.push(ImportedMessage {
                    role: role.to_string(),
                    content: text,
                });
            }
            _ => {}
        }
    }
    Ok((messages, meta))
}

/// Flatten Codex's `content` block array (`input_text` / `output_text` / `text`)
/// into plain transcript text.
fn extract_codex_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                let btype = block.get("type").and_then(Value::as_str).unwrap_or("");
                if matches!(btype, "input_text" | "output_text" | "text") {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        if !t.trim().is_empty() {
                            parts.push(t.trim().to_string());
                        }
                    }
                }
            }
            parts.join("\n\n")
        }
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Derive a title from the first user message when no explicit summary exists.
fn first_line_title(messages: &[ImportedMessage]) -> String {
    let first_user = messages
        .iter()
        .find(|m| m.role == "user")
        .or_else(|| messages.first());
    match first_user {
        Some(m) => {
            let line = m.content.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            let trimmed = line.trim();
            if trimmed.chars().count() > 80 {
                let cut: String = trimmed.chars().take(80).collect();
                format!("{cut}…")
            } else if trimmed.is_empty() {
                "Untitled thread".to_string()
            } else {
                trimmed.to_string()
            }
        }
        None => "Untitled thread".to_string(),
    }
}

/// Directory entries sorted by name for deterministic ordering. Best-effort:
/// an unreadable directory yields an empty list.
fn read_dir_sorted(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
        Err(_) => Vec::new(),
    };
    entries.sort();
    entries
}

/// File mtime in epoch millis, or 0 if unavailable.
fn file_mtime_millis(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_slug_matches_cli_layout() {
        assert_eq!(claude_cwd_slug("/private/tmp"), "-private-tmp");
        assert_eq!(
            claude_cwd_slug("/Users/j/Code/ryu.closed"),
            "-Users-j-Code-ryu-closed"
        );
    }

    #[test]
    fn unsupported_engine_lists_empty() {
        assert!(list_threads("gemini", None).unwrap().is_empty());
        assert!(!engine_supports_history("gemini"));
        assert!(engine_supports_history("claude"));
    }

    #[test]
    fn thread_id_rejects_traversal() {
        let root = std::env::temp_dir();
        assert!(resolve_thread_path(&root, "../etc/passwd").is_err());
        assert!(resolve_thread_path(&root, "/etc/passwd").is_err());
        assert!(resolve_thread_path(&root, "").is_err());
    }

    #[test]
    fn extract_claude_text_handles_string_and_blocks() {
        assert_eq!(
            extract_claude_text(Some(&serde_json::json!("hello"))),
            "hello"
        );
        let blocks = serde_json::json!([
            {"type": "thinking", "thinking": "hidden"},
            {"type": "text", "text": "visible"},
            {"type": "tool_use", "name": "bash"}
        ]);
        assert_eq!(extract_claude_text(Some(&blocks)), "visible");
    }

    #[test]
    fn extract_codex_text_flattens_blocks() {
        let blocks = serde_json::json!([
            {"type": "input_text", "text": "a"},
            {"type": "output_text", "text": "b"}
        ]);
        assert_eq!(extract_codex_text(Some(&blocks)), "a\n\nb");
    }

    /// Smoke test against the developer's REAL on-disk history. Ignored by
    /// default (machine-dependent); run with:
    ///   cargo test -p ryu-core native_history::tests::smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn smoke_real_history() {
        for engine in ["claude", "codex"] {
            let threads = list_threads(engine, None).expect("list");
            eprintln!("[{engine}] {} threads", threads.len());
            if let Some(t) = threads.first() {
                eprintln!(
                    "  newest: {:?} | msgs={} | cwd={:?} | sid={:?}",
                    t.title, t.message_count, t.cwd, t.native_session_id
                );
                let imported = read_thread(engine, &t.id).expect("read");
                eprintln!(
                    "  read back: {} messages, title={:?}, truncated={}",
                    imported.messages.len(),
                    imported.thread.title,
                    imported.truncated
                );
                assert!(!imported.messages.is_empty(), "read produced no messages");
                assert!(
                    imported.messages.iter().all(|m| m.role == "user" || m.role == "assistant"),
                    "unexpected role in imported transcript"
                );
                // read_thread's title must match what the list showed — not the
                // generic fallback (regression guard for the title divergence).
                assert_eq!(
                    imported.thread.title, t.title,
                    "read_thread title diverged from list title"
                );
                assert_ne!(imported.thread.title, "Imported thread");
            }
        }
    }
}
