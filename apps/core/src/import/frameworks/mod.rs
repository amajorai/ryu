//! Framework-aware detectors for moving an existing agent setup into Ryu:
//! OpenClaw (`~/.openclaw`, legacy `~/.clawdbot` / `~/.moltbot`), Hermes Agent
//! (`~/.hermes`), an extracted Meta Muse filesystem export, and Mastra or
//! LangChain/LangGraph projects.
//!
//! This extends the generic setup scan in the parent module rather than adding
//! a second importer. Every item is emitted as an existing scan kind
//! (`agent`, `memory`, `mcp_server`; skills are already found by the shared
//! `SKILL.md` walk), so the import step, the agent-sync ledger, and the desktop
//! picker reuse one write path:
//!
//! - a persona workspace (`SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`)
//!   becomes one Ryu agent whose system prompt is the composed persona;
//! - Markdown memory files (`MEMORY.md`, `USER.md`, dated daily notes, Muse
//!   `memory/bank/`) are split into individual memory entries;
//! - MCP servers in `openclaw.json` (JSON5, `mcp.servers`) and Hermes
//!   `config.yaml` (`mcp_servers`) are lowered into `McpServerConfig`;
//! - Mastra `new Agent({...})` and LangChain `create_agent(...)`-style calls
//!   whose instructions are static string literals become Ryu agents.
//!
//! Credentials, channel tokens, schedules, and runtime state are never imported
//! here. The scan reports them as review notes (names only, never values) so
//! the user can recreate access through Ryu's own vault and channel flows.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{
    counted, file_size, kind, messages, rel_path, CodexSubagent, Collector, Message, ScanItem,
};
use crate::sidecar::mcp::McpServerConfig;

mod code_agents;
mod config;
mod lexer;
mod memory;
mod notes;

pub use code_agents::*;
pub use config::*;
pub use lexer::*;
pub use memory::*;
pub use notes::*;

/// Largest config / persona / memory file read by a framework detector.
const MAX_FRAMEWORK_FILE_BYTES: u64 = 1024 * 1024;
/// Largest source file inspected for code-defined agents.
const MAX_SOURCE_FILE_BYTES: u64 = 512 * 1024;
/// Source files inspected per project scan.
const MAX_SOURCE_FILES: usize = 400;
/// Directory depth for the code-agent walk (`src/mastra/agents/x.ts` is 3).
const MAX_SOURCE_DEPTH: usize = 6;
/// Memory entries recorded from one Markdown memory file.
pub const MAX_MEMORY_ENTRIES_PER_FILE: usize = 200;
/// Longest single imported memory entry, in characters.
const MAX_MEMORY_ENTRY_CHARS: usize = 4000;
/// Daily / bank memory files listed per scan.
const MAX_MEMORY_FILES: usize = 120;

/// A supported source framework. The wire id is stable and lowercase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Framework {
    OpenClaw,
    Hermes,
    Muse,
    Mastra,
    LangChain,
    /// A bare persona folder (`SOUL.md` / `IDENTITY.md`, optional `MEMORY.md`)
    /// with no product-specific markers — for example a scanned OpenClaw
    /// workspace, or instructions and notes saved out of a hosted agent that
    /// has no export.
    Persona,
}

impl Framework {
    /// Stable wire id, also accepted as an agent-sync provider.
    pub fn id(self) -> &'static str {
        match self {
            Self::OpenClaw => "openclaw",
            Self::Hermes => "hermes",
            Self::Muse => "muse",
            Self::Mastra => "mastra",
            Self::LangChain => "langchain",
            Self::Persona => "persona",
        }
    }

    /// Human-readable product name.
    pub fn label(self) -> &'static str {
        match self {
            Self::OpenClaw => "OpenClaw",
            Self::Hermes => "Hermes",
            Self::Muse => "Muse",
            Self::Mastra => "Mastra",
            Self::LangChain => "LangChain",
            Self::Persona => "Persona",
        }
    }

    /// True for frameworks whose home folder holds a persona and Markdown memory.
    pub fn has_persona_home(self) -> bool {
        matches!(
            self,
            Self::OpenClaw | Self::Hermes | Self::Muse | Self::Persona
        )
    }
}

/// OpenClaw config file names, newest first (legacy Clawdbot / Moltbot names
/// are still read).
pub const OPENCLAW_CONFIG_FILES: &[&str] = &["openclaw.json", "clawdbot.json", "moltbot.json"];

/// Detect which framework a scanned folder belongs to. Cheap probes only; a
/// plain project with none of these markers returns `None`.
pub fn detect(root: &Path) -> Option<Framework> {
    let dir_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if matches!(dir_name.as_str(), ".openclaw" | ".clawdbot" | ".moltbot")
        || OPENCLAW_CONFIG_FILES.iter().any(|f| root.join(f).is_file())
    {
        return Some(Framework::OpenClaw);
    }
    if dir_name == ".hermes"
        || (root.join("config.yaml").is_file()
            && (root.join("SOUL.md").is_file() || root.join("memories").is_dir()))
    {
        return Some(Framework::Hermes);
    }
    if root.join("SOUL.md").is_file()
        && (root.join("dreams").is_dir()
            || root.join("memory").join("bank").is_dir()
            || root.join("ALIGNMENT_SYNTHESIS.md").is_file())
    {
        return Some(Framework::Muse);
    }
    let package_json = read_bounded(&root.join("package.json"), MAX_FRAMEWORK_FILE_BYTES);
    if let Some(pkg) = package_json.as_deref() {
        if package_depends_on(pkg, |name| name == "@mastra/core") {
            return Some(Framework::Mastra);
        }
        if package_depends_on(pkg, |name| {
            name == "langchain" || name.starts_with("@langchain/")
        }) {
            return Some(Framework::LangChain);
        }
    }
    if root.join("langgraph.json").is_file() {
        return Some(Framework::LangChain);
    }
    for file in ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"] {
        if let Some(text) = read_bounded(&root.join(file), MAX_FRAMEWORK_FILE_BYTES) {
            let lower = text.to_ascii_lowercase();
            if lower.contains("langchain") || lower.contains("langgraph") {
                return Some(Framework::LangChain);
            }
        }
    }
    // A bare persona workspace (someone scanned `~/.openclaw/workspace` or a
    // folder of saved instructions directly) still imports as a persona home.
    if is_persona_dir(root) {
        return Some(Framework::Persona);
    }
    None
}

fn package_depends_on(raw: &str, matches: impl Fn(&str) -> bool) -> bool {
    let Ok(pkg) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    ["dependencies", "devDependencies", "peerDependencies"]
        .iter()
        .filter_map(|key| pkg.get(key).and_then(Value::as_object))
        .any(|deps| deps.keys().any(|name| matches(name)))
}

/// Run the framework detectors for `root` and append their items/notes to the
/// shared collector. Returns the detected framework.
pub(super) fn collect(root: &Path, c: &mut Collector) -> Option<Framework> {
    let framework = detect(root)?;
    if framework.has_persona_home() {
        collect_persona_home(root, framework, c);
    }
    match framework {
        Framework::OpenClaw => collect_openclaw_notes(root, c),
        Framework::Hermes => collect_hermes_notes(root, c),
        Framework::Muse => collect_muse_notes(root, c),
        Framework::Persona => note_persona_leftovers(root, c),
        Framework::Mastra | Framework::LangChain => collect_code_agents(root, framework, c),
    }
    collect_env_credential_names(root, framework, c);
    Some(framework)
}

// ---------------------------------------------------------------------------
// Persona homes (OpenClaw / Hermes / Muse)
// ---------------------------------------------------------------------------

/// Persona files composed into one system prompt, in prompt order.
const PERSONA_FILES: &[(&str, &str)] = &[
    ("SOUL.md", "Soul"),
    ("IDENTITY.md", "Identity"),
    ("AGENTS.md", "Operating instructions"),
    ("TOOLS.md", "Tool notes"),
];

/// Workspace folders that hold a persona: the root itself, then OpenClaw's
/// `workspace/`, `workspace.default/`, and per-agent `workspace-<id>/`.
fn persona_workspaces(root: &Path, framework: Framework) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if is_persona_dir(root) {
        out.push(root.to_path_buf());
    }
    if framework != Framework::OpenClaw {
        return out;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| n == "workspace" || n.starts_with("workspace.") || n.starts_with("workspace-"))
        .collect();
    names.sort();
    for name in names {
        let dir = root.join(name);
        if is_persona_dir(&dir) {
            out.push(dir);
        }
    }
    out
}

fn is_persona_dir(dir: &Path) -> bool {
    dir.join("SOUL.md").is_file() || dir.join("IDENTITY.md").is_file()
}

/// The file an agent item id points at for a persona workspace.
fn persona_anchor(dir: &Path) -> PathBuf {
    if dir.join("SOUL.md").is_file() {
        dir.join("SOUL.md")
    } else {
        dir.join("IDENTITY.md")
    }
}

fn collect_persona_home(root: &Path, framework: Framework, c: &mut Collector) {
    for workspace in persona_workspaces(root, framework) {
        let anchor = persona_anchor(&workspace);
        if let Some(persona) = parse_persona(root, &anchor) {
            let rel = rel_path(&c.root, &anchor);
            c.agents.push(ScanItem::titled(
                kind::AGENT,
                format!("{}/{rel}", kind::AGENT),
                Message::new(messages::IMPORT_SOURCE_AGENT_TITLE_MESSAGE)
                    .text("source", framework.label())
                    .text("name", &persona.name),
                Some(workspace.to_string_lossy().to_string()),
            ));
        }
        collect_memory_docs(&workspace, framework, c);
    }
    // Hermes keeps memory under `memories/`.
    let memories = root.join("memories");
    if memories.is_dir() {
        collect_memory_docs(&memories, framework, c);
    }
}

/// Emit memory items for `MEMORY.md`, `USER.md`, dated daily notes under
/// `memory/`, and Muse's categorized `memory/bank/`.
fn collect_memory_docs(dir: &Path, framework: Framework, c: &mut Collector) {
    for name in ["MEMORY.md", "USER.md"] {
        let path = dir.join(name);
        if path.is_file() {
            push_memory_item(&path, framework, c);
        }
    }
    let daily = dir.join("memory");
    if daily.is_dir() {
        let mut files = markdown_files(&daily, 1);
        files.retain(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(is_dated_stem)
        });
        for path in files {
            push_memory_item(&path, framework, c);
        }
        let bank = daily.join("bank");
        if bank.is_dir() {
            for path in markdown_files(&bank, 3) {
                push_memory_item(&path, framework, c);
            }
        }
    }
}

fn push_memory_item(path: &Path, framework: Framework, c: &mut Collector) {
    if c.memories.len() >= MAX_MEMORY_FILES {
        return;
    }
    let rel = rel_path(&c.root, path);
    let id = format!("{}/{rel}", kind::MEMORY);
    if c.memories.iter().any(|item| item.id == id) {
        return;
    }
    let entries = parse_markdown_memory(path)
        .map(|m| m.entries.len())
        .unwrap_or(0);
    if entries == 0 {
        return;
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("memory");
    let title = if entries == 1 {
        Message::new(messages::IMPORT_SOURCE_MEMORY_ONE_TITLE_MESSAGE)
    } else {
        counted(
            Message::new(messages::IMPORT_SOURCE_MEMORY_TITLE_MESSAGE),
            entries,
        )
    };
    c.memories.push(ScanItem::titled(
        kind::MEMORY,
        id,
        title.text("source", framework.label()).text("name", name),
        Some(path.to_string_lossy().to_string()),
    ));
}

#[cfg(test)]
mod tests;
