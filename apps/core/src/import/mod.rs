//! Scan a user-picked local folder (a project directory OR an agent config root
//! like `~/.claude`, `~/.cursor`, `~/.codex`, or `~`) and import the *setup* it
//! contains into Ryu's own stores — the companion to `native_history.rs`, which
//! imports conversations. ChatGPT/Codex call this "import from another agent"
//! (Settings > Import / `/import`); the equivalent here is: point at ONE folder,
//! scan it, and pull out instructions, skills, MCP servers, plugins, and Claude
//! project memories. See `docs/agent-setup-import.md` for the full design.
//!
//! Scope: this module is the **pure read side** — it detects what is importable
//! and parses the foreign on-disk shapes into Ryu's types. The stateful writes
//! (skills install, mcp.json merge, plugin persist, memory record) live in the
//! server handlers so they reuse the exact same store seams as the normal install
//! flows (`from_source::install_from_dir`, `persist_installed_plugin`, the atomic
//! mcp.json writer, `MemoryStore::record_full`).
//!
//! Like `native_history`, everything here is read-only against the source folder
//! and every write lands in a Ryu-owned store; an unsupported or unreadable
//! folder degrades to an empty scan, never an error.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::i18n::messages;
use crate::i18n::Message;
use crate::sidecar::mcp::McpServerConfig;

pub mod chat_exports;
pub mod frameworks;

mod helpers;
mod instructions;
mod parse;
mod resolve;
mod scan_collect;
mod scan_text;

pub(crate) use helpers::*;
pub use instructions::*;
pub use parse::*;
pub use resolve::*;
use scan_collect::*;
pub use scan_text::*;

/// `skip_serializing_if` predicate: omit a field when it is `false`.
fn is_false(v: &bool) -> bool {
    !*v
}

/// Max directory depth below the scanned root we descend into.
const MAX_SCAN_DEPTH: usize = 4;
/// Hard cap on entries visited per scan — keeps a scan of `~` bounded no matter
/// how many projects / caches have accumulated.
const MAX_SCAN_ENTRIES: usize = 4000;
/// Per-kind caps so a single scan can never produce an unwieldy picker list.
const MAX_SKILLS: usize = 50;
const MAX_MCP_SERVERS: usize = 50;
const MAX_PLUGINS: usize = 40;
const MAX_MEMORIES: usize = 100;
const MAX_INSTRUCTIONS: usize = 4;
const MAX_SUBAGENTS: usize = 50;
const MAX_SLASH_COMMANDS: usize = 50;
/// Skip a candidate transcript/config file larger than this when scanning for
/// metadata (e.g. a bloated `~/.claude.json`).
const MAX_SCAN_BYTES: u64 = 8 * 1024 * 1024;
/// Cap on an imported instructions file body.
const MAX_INSTRUCTIONS_BYTES: u64 = 256 * 1024;
/// Cap on the instruction file body injected into a turn's system prompt.
/// Reading a project's full 256 KB instructions on every turn is paid for on
/// every turn of every channel, so the prompt copy is bounded tighter than the
/// import record; truncation is surfaced to the model.
const MAX_PROJECT_INSTRUCTIONS_PROMPT_BYTES: u64 = 64 * 1024;

/// Item kinds the scanner can detect. String keys on the wire; the scan/run
/// payloads carry them verbatim.
pub mod kind {
    pub const INSTRUCTIONS: &str = "instructions";
    pub const SKILL: &str = "skill";
    pub const MCP_SERVER: &str = "mcp_server";
    pub const PLUGIN: &str = "plugin";
    pub const MEMORY: &str = "memory";
    pub const AGENT: &str = "agent";
    pub const SLASH_COMMAND: &str = "slash_command";
    /// A group of conversations from a ChatGPT or Claude data export (one per
    /// project, plus one for chats outside a project).
    pub const CONVERSATIONS: &str = "conversations";
}

/// One importable item found by a scan.
#[derive(Debug, Clone, Serialize)]
pub struct ScanItem {
    /// SHA-256 of bounded instruction source bytes; absent on other item kinds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_revision: Option<String>,
    /// `instructions | skill | mcp_server | plugin | memory` (see [`kind`]).
    pub kind: &'static str,
    /// Opaque, root-relative locator. Round-trips back to a file/dir on disk in
    /// the import step (see `resolve_item`); never trust client bytes, always
    /// re-resolve against the folder.
    pub id: String,
    /// English title; `title_i18n` is the same text as a Core message.
    pub title: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "scan_text::wire_message"
    )]
    pub title_i18n: Option<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The sentences of an English `detail`, as Core messages; empty when the
    /// detail is a path.
    #[serde(
        skip_serializing_if = "Vec::is_empty",
        serialize_with = "scan_text::wire_messages"
    )]
    pub detail_i18n: Vec<Message>,
    /// Cheap same-name/same-id hint computed during the scan. The authoritative
    /// answer is reported by the import step.
    #[serde(skip_serializing_if = "is_false")]
    pub already_exists: bool,
}

/// The result of a scan.
#[derive(Debug, Clone, Serialize)]
pub struct ScanResult {
    /// Canonicalized absolute path of the scanned folder.
    pub root: String,
    pub items: Vec<ScanItem>,
    /// English warnings, kept for older clients.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// The same warnings with their Core messages, in the same order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warning_notices: Vec<ScanWarning>,
    /// Detected source (`openclaw`, `hermes`, `muse`, `mastra`, `langchain`,
    /// `persona`, or a `chatgpt` / `claude-ai` data export), when the folder is
    /// one. See [`frameworks`] and [`chat_exports`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
}

/// One item the client asks to import, as selected in the scan preview.
#[derive(Debug, Clone, Deserialize)]
pub struct ImportSelection {
    pub kind: String,
    pub id: String,
}

/// Per-item outcome of an import run.
#[derive(Debug, Clone, Serialize)]
pub struct ImportOutcome {
    /// Revision of the exact instruction bytes acknowledged by the destination write.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_revision: Option<String>,
    pub kind: String,
    pub id: String,
    pub title: String,
    pub status: &'static str,
    #[serde(skip_serializing_if = "is_false")]
    pub already_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// For `instructions` items, the containing folder the desktop should
    /// register as a workspace project.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
}

impl ImportOutcome {
    pub fn ok(kind: &str, id: &str, title: &str) -> Self {
        Self {
            content_revision: None,
            kind: kind.to_string(),
            id: id.to_string(),
            title: title.to_string(),
            status: "imported",
            already_exists: false,
            detail: None,
            folder_path: None,
        }
    }

    pub fn skipped(kind: &str, id: &str, title: &str, reason: &str) -> Self {
        Self {
            content_revision: None,
            kind: kind.to_string(),
            id: id.to_string(),
            title: title.to_string(),
            status: "skipped",
            already_exists: false,
            detail: Some(reason.to_string()),
            folder_path: None,
        }
    }

    pub fn failed(kind: &str, id: &str, title: &str, err: &str) -> Self {
        Self {
            content_revision: None,
            kind: kind.to_string(),
            id: id.to_string(),
            title: title.to_string(),
            status: "failed",
            already_exists: false,
            detail: Some(err.to_string()),
            folder_path: None,
        }
    }

    pub fn already(kind: &str, id: &str, title: &str) -> Self {
        Self {
            content_revision: None,
            kind: kind.to_string(),
            id: id.to_string(),
            title: title.to_string(),
            status: "skipped",
            already_exists: true,
            detail: Some("already imported".to_string()),
            folder_path: None,
        }
    }
}

/// Skip hidden / housekeeping dirs that would balloon a scan (VCS, deps). Note
/// what is deliberately NOT skipped: dot-dirs like `.cursor`, `.claude`,
/// `.codex` are exactly where agent setup lives and must stay reachable.
fn is_skipped_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".hg" | ".svn" | ".bzr" | "node_modules" | "target" | "dist" | "build"
    )
}

/// Resolve the scanned root: expand `~`, canonicalize, require a directory.
pub fn canonicalize_root(input: &str) -> Result<PathBuf> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        bail!("path is empty");
    }
    let mut path = PathBuf::from(trimmed);
    if let Some(rest) = trimmed.strip_prefix('~') {
        let home = dirs::home_dir().context("no home directory")?;
        path = home.join(rest.trim_start_matches(['/', '\\']));
    }
    let canonical = fs::canonicalize(&path)
        .with_context(|| format!("cannot resolve folder {}", path.to_string_lossy()))?;
    if !canonical.is_dir() {
        bail!("not a directory: {}", canonical.to_string_lossy());
    }
    Ok(canonical)
}

/// Resolve the Codex home whose `agents/` and `prompts/` stores are importable
/// during a scan. Arbitrary project-local directories with those names are
/// deliberately excluded: Codex only gives those stores meaning under its
/// configured `CODEX_HOME` (or a visible `.codex` directory).
fn codex_root_for_scan(root: &Path) -> Option<PathBuf> {
    let configured = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
        .and_then(|path| fs::canonicalize(path).ok())
        .filter(|path| path.is_dir());

    if let Some(configured) = configured {
        if root.starts_with(&configured) || configured.starts_with(root) {
            return Some(configured);
        }
    }

    // A user may explicitly scan a `.codex` tree, including a test or portable
    // tree that is not their process-global CODEX_HOME.
    if root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(".codex"))
    {
        return Some(root.to_path_buf());
    }
    let nested = root.join(".codex");
    nested.is_dir().then_some(nested)
}

/// Scan `root` for importable setup. Read-only; bounded; never errors on a
/// folder with nothing to import.
pub fn scan_source(root: &Path) -> Result<ScanResult> {
    let mut collector = Collector {
        root: root.to_path_buf(),
        codex_root: codex_root_for_scan(root),
        entries_seen: 0,
        warnings: Vec::new(),
        instructions: Vec::new(),
        skills: Vec::new(),
        mcp: Vec::new(),
        plugins: Vec::new(),
        memories: Vec::new(),
        agents: Vec::new(),
        slash_commands: Vec::new(),
        conversations: Vec::new(),
        mcp_names_present: existing_mcp_names(),
    };

    // Root-level instruction files + MCP config files.
    collect_root_files(root, &mut collector);
    // Cursor keeps its MCP config at `.cursor/mcp.json` — check it directly (the
    // walk skips nothing here; this is just a targeted one-level probe).
    collect_mcp_config(root, "cursor-json", ".cursor/mcp.json", &mut collector);

    // Bounded walk for skills / plugins / memory stores.
    walk(root, root, 0, &mut collector);

    // Framework homes and projects (OpenClaw, Hermes, Muse, Mastra, LangChain):
    // personas, Markdown memory, and code-defined agents, as existing kinds.
    // A ChatGPT / Claude data export is a source of its own; otherwise try the
    // framework detectors.
    let source = match chat_exports::collect(root, &mut collector) {
        Some(export) => Some(export.id()),
        None => frameworks::collect(root, &mut collector).map(frameworks::Framework::id),
    };

    let mut items = Vec::new();
    items.extend(collector.instructions.into_iter());
    items.extend(collector.skills.into_iter());
    items.extend(collector.mcp.into_iter());
    items.extend(collector.plugins.into_iter());
    items.extend(collector.memories.into_iter());
    items.extend(collector.agents.into_iter());
    items.extend(collector.slash_commands.into_iter());
    items.extend(collector.conversations.into_iter());
    let mut seen_ids = std::collections::HashSet::new();
    items.retain(|item| seen_ids.insert(format!("{}:{}", item.kind, item.id)));
    items.truncate(MAX_SCAN_ENTRIES);

    Ok(ScanResult {
        root: root.to_string_lossy().to_string(),
        items,
        warnings: collector
            .warnings
            .iter()
            .map(|warning| warning.message.clone())
            .collect(),
        warning_notices: collector.warnings,
        source,
    })
}

/// Accumulates scan results across the walk.
struct Collector {
    root: PathBuf,
    codex_root: Option<PathBuf>,
    entries_seen: usize,
    warnings: Vec<ScanWarning>,
    instructions: Vec<ScanItem>,
    skills: Vec<ScanItem>,
    mcp: Vec<ScanItem>,
    plugins: Vec<ScanItem>,
    memories: Vec<ScanItem>,
    agents: Vec<ScanItem>,
    slash_commands: Vec<ScanItem>,
    conversations: Vec<ScanItem>,
    /// Names already present in `~/.ryu/mcp.json` (used for the cheap hint).
    mcp_names_present: std::collections::HashSet<String>,
}

impl Collector {
    fn exhausted(&self) -> bool {
        self.entries_seen >= MAX_SCAN_ENTRIES
    }

    fn bump(&mut self) {
        self.entries_seen += 1;
    }
}

/// `~`-rooted MCP config tokens → the config file path they stand for, relative
/// to the scanned root. Used to encode/decode an `mcp_server` item id.
const MCP_CONFIG_TOKENS: &[(&str, &str)] = &[
    ("json", "mcp.json"),
    ("cursor-json", ".cursor/mcp.json"),
    ("toml", "config.toml"),
    ("claude", ".claude.json"),
    ("openclaw", "openclaw.json"),
    ("clawdbot", "clawdbot.json"),
    ("moltbot", "moltbot.json"),
    ("hermes", "config.yaml"),
];

/// Names of the `.claude.json` / `mcp.json` MCP map key (the shared dialect).
fn mcp_map_keys() -> &'static [&'static str] {
    &["mcpServers", "servers", "mcp_servers"]
}

/// Names already present in the user's `~/.ryu/mcp.json`, for the cheap
/// `already_exists` hint on MCP items.
fn existing_mcp_names() -> std::collections::HashSet<String> {
    let path = crate::sidecar::mcp::McpRegistry::config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return std::collections::HashSet::new(),
    };
    let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return std::collections::HashSet::new();
    };
    let mut names = std::collections::HashSet::new();
    for key in mcp_map_keys() {
        if let Some(map) = val.get(key).and_then(|v| v.as_object()) {
            names.extend(map.keys().cloned());
        }
    }
    names
}

#[cfg(test)]
mod tests;
