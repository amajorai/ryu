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

use super::{file_size, kind, rel_path, CodexSubagent, Collector, ScanItem};
use crate::sidecar::mcp::McpServerConfig;

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
            c.agents.push(ScanItem {
                content_revision: None,
                kind: kind::AGENT,
                id: format!("{}/{rel}", kind::AGENT),
                title: format!("{} agent '{}'", framework.label(), persona.name),
                detail: Some(workspace.to_string_lossy().to_string()),
                already_exists: false,
            });
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
    c.memories.push(ScanItem {
        content_revision: None,
        kind: kind::MEMORY,
        id,
        title: format!(
            "{} memory {name} ({entries} {})",
            framework.label(),
            if entries == 1 { "entry" } else { "entries" }
        ),
        detail: Some(path.to_string_lossy().to_string()),
        already_exists: false,
    });
}

fn markdown_files(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if ft.is_dir() && depth > 1 {
            out.extend(markdown_files(&path, depth - 1));
        } else if ft.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
    out
}

/// `YYYY-MM-DD` or `YYYY-MM-DD-<suffix>`.
fn is_dated_stem(stem: &str) -> bool {
    let bytes = stem.as_bytes();
    bytes.len() >= 10
        && bytes[..10].iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// A persona workspace composed into a Ryu agent definition.
pub fn parse_persona(root: &Path, anchor: &Path) -> Option<CodexSubagent> {
    let dir = anchor.parent()?;
    let mut sections = Vec::new();
    for (file, heading) in PERSONA_FILES {
        let Some(text) = read_bounded(&dir.join(file), MAX_FRAMEWORK_FILE_BYTES) else {
            continue;
        };
        let text = text.trim();
        if !text.is_empty() {
            sections.push(format!("## {heading}\n\n{text}"));
        }
    }
    if sections.is_empty() {
        return None;
    }
    let framework = detect(root).unwrap_or(Framework::Persona);
    let identity = read_bounded(&dir.join("IDENTITY.md"), MAX_FRAMEWORK_FILE_BYTES);
    let workspace_suffix = dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("workspace-"))
        .filter(|s| !s.is_empty() && *s != "main");
    let name = identity
        .as_deref()
        .and_then(identity_name)
        .or_else(|| workspace_suffix.map(|s| format!("{}-{s}", framework.id())))
        .unwrap_or_else(|| framework.id().to_string());
    Some(CodexSubagent {
        name,
        description: Some(format!(
            "Migrated from {} ({}).",
            framework.label(),
            dir.to_string_lossy()
        )),
        system_prompt: sections.join("\n\n"),
        tools: Vec::new(),
        model: persona_model(root, framework),
    })
}

/// The `Name:` field of an OpenClaw-style `IDENTITY.md`
/// (`- **Name:** Clawd`, `Name: Clawd`, or `name: Clawd`).
fn identity_name(identity: &str) -> Option<String> {
    identity.lines().find_map(|line| {
        let cleaned: String = line
            .trim()
            .trim_start_matches(['-', '*', ' '])
            .replace("**", "");
        let (key, value) = cleaned.split_once(':')?;
        if !key.trim().eq_ignore_ascii_case("name") {
            return None;
        }
        let value = value.trim().trim_matches(['"', '\'', '*', '_']).trim();
        (!value.is_empty() && value.len() <= 80).then(|| value.to_string())
    })
}

/// The default model a persona home was configured with, as `provider/model`.
fn persona_model(root: &Path, framework: Framework) -> Option<String> {
    match framework {
        Framework::OpenClaw => {
            let config = read_openclaw_config(root)?;
            let model = config.pointer("/agents/defaults/model")?;
            model
                .as_str()
                .or_else(|| model.get("primary").and_then(Value::as_str))
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
        }
        Framework::Hermes => {
            let config = read_hermes_config(root)?;
            let model = config.get("model")?;
            let name = model
                .as_str()
                .or_else(|| model.get("default").and_then(Value::as_str))?
                .trim();
            if name.is_empty() {
                return None;
            }
            let provider = model
                .get("provider")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|p| !p.is_empty() && !name.contains('/'));
            Some(match provider {
                Some(p) => format!("{p}/{name}"),
                None => name.to_string(),
            })
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Markdown memory files
// ---------------------------------------------------------------------------

/// A Markdown memory file split into entries.
#[derive(Debug, Clone)]
pub struct MarkdownMemory {
    pub entries: Vec<String>,
    pub category: ryu_memory::MemoryCategory,
}

/// True when an item path is a Markdown memory document this module owns
/// (rather than a Claude Code `memory/<uuid>.md` record).
pub fn is_markdown_memory_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.eq_ignore_ascii_case("MEMORY.md") || name.eq_ignore_ascii_case("USER.md") {
        return true;
    }
    let in_dir = |dir: &str| {
        path.ancestors()
            .skip(1)
            .take(4)
            .any(|a| a.file_name().and_then(|n| n.to_str()) == Some(dir))
    };
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    (in_dir("memory") && is_dated_stem(stem)) || in_dir("bank")
}

/// Split a Markdown memory file into entries. Hermes separates entries with
/// `§`; OpenClaw and Muse use bullets and paragraphs. Dated daily notes are
/// prefixed with their date so the entry keeps its time context.
pub fn parse_markdown_memory(path: &Path) -> Option<MarkdownMemory> {
    let raw = read_bounded(path, MAX_FRAMEWORK_FILE_BYTES)?;
    let (_, body) = super::split_front_matter(&raw);
    let name = path.file_name()?.to_str()?;
    let stem = path.file_stem()?.to_str()?;
    let dated = is_dated_stem(stem).then(|| stem[..10].to_string());
    let bank_dir = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(str::to_ascii_lowercase);
    let category = if name.eq_ignore_ascii_case("USER.md") {
        ryu_memory::MemoryCategory::UserFact
    } else if dated.is_some() {
        ryu_memory::MemoryCategory::Event
    } else {
        match bank_dir.as_deref() {
            Some("preferences") => ryu_memory::MemoryCategory::Preference,
            Some("experiences") => ryu_memory::MemoryCategory::Event,
            Some("circumstances") => ryu_memory::MemoryCategory::UserFact,
            _ => ryu_memory::MemoryCategory::Other,
        }
    };
    let mut entries = split_memory_entries(&body);
    if let Some(date) = dated {
        for entry in &mut entries {
            *entry = format!("On {date}: {entry}");
        }
    }
    entries.truncate(MAX_MEMORY_ENTRIES_PER_FILE);
    Some(MarkdownMemory { entries, category })
}

/// Split free-form memory text into entries (`§`-delimited, bullets, or
/// paragraphs). Shared with the ChatGPT / Claude export importer.
pub fn split_memory_text(body: &str) -> Vec<String> {
    split_memory_entries(body)
}

fn split_memory_entries(body: &str) -> Vec<String> {
    let clean = |s: &str| -> Option<String> {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(trimmed.chars().take(MAX_MEMORY_ENTRY_CHARS).collect())
    };
    if body.contains('§') {
        return body.split('§').filter_map(clean).collect();
    }
    let mut entries = Vec::new();
    let mut current = String::new();
    let flush = |current: &mut String, entries: &mut Vec<String>| {
        if let Some(entry) = clean(current) {
            entries.push(entry);
        }
        current.clear();
    };
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || is_rule(trimmed) {
            flush(&mut current, &mut entries);
            continue;
        }
        if let Some(item) = bullet_text(line) {
            flush(&mut current, &mut entries);
            current.push_str(item);
            continue;
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(trimmed);
    }
    flush(&mut current, &mut entries);
    entries
}

fn is_rule(line: &str) -> bool {
    line.len() >= 3 && line.chars().all(|c| matches!(c, '-' | '*' | '_' | '='))
}

/// The text of a top-level bullet line (`- x`, `* x`, `+ x`, `1. x`), with an
/// optional task checkbox removed. Indented sub-bullets continue the parent.
fn bullet_text(line: &str) -> Option<&str> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let rest = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .or_else(|| line.strip_prefix("+ "))
        .or_else(|| {
            let digits = line.chars().take_while(char::is_ascii_digit).count();
            (digits > 0)
                .then(|| line[digits..].strip_prefix(". "))
                .flatten()
        })?;
    let rest = rest
        .strip_prefix("[ ] ")
        .or_else(|| rest.strip_prefix("[x] "))
        .or_else(|| rest.strip_prefix("[X] "))
        .unwrap_or(rest);
    Some(rest)
}

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

fn read_openclaw_config(root: &Path) -> Option<Value> {
    OPENCLAW_CONFIG_FILES.iter().find_map(|file| {
        let raw = read_bounded(&root.join(file), MAX_FRAMEWORK_FILE_BYTES)?;
        serde_json::from_str(&json5_to_json(&raw)).ok()
    })
}

fn read_hermes_config(root: &Path) -> Option<Value> {
    let raw = read_bounded(&root.join("config.yaml"), MAX_FRAMEWORK_FILE_BYTES)?;
    let yaml: noyalib::compat::serde_yaml::Value =
        noyalib::compat::serde_yaml::from_str(&raw).ok()?;
    serde_json::to_value(yaml).ok()
}

/// Parse MCP servers from an OpenClaw config (`mcp.servers.<name>`).
pub fn parse_openclaw_mcp(path: &Path) -> anyhow::Result<Vec<(String, McpServerConfig)>> {
    let raw = read_bounded(path, MAX_FRAMEWORK_FILE_BYTES)
        .ok_or_else(|| anyhow::anyhow!("cannot read {}", path.to_string_lossy()))?;
    let config: Value = serde_json::from_str(&json5_to_json(&raw))
        .map_err(|e| anyhow::anyhow!("parsing OpenClaw config: {e}"))?;
    Ok(lower_mcp_map(config.pointer("/mcp/servers")))
}

/// Parse MCP servers from a Hermes `config.yaml` (`mcp_servers.<name>`).
/// Servers disabled in the source are omitted.
pub fn parse_hermes_mcp(path: &Path) -> anyhow::Result<Vec<(String, McpServerConfig)>> {
    let raw = read_bounded(path, MAX_FRAMEWORK_FILE_BYTES)
        .ok_or_else(|| anyhow::anyhow!("cannot read {}", path.to_string_lossy()))?;
    let yaml: noyalib::compat::serde_yaml::Value = noyalib::compat::serde_yaml::from_str(&raw)
        .map_err(|e| anyhow::anyhow!("parsing config.yaml: {e}"))?;
    let config = serde_json::to_value(yaml)?;
    Ok(lower_mcp_map(config.get("mcp_servers")))
}

fn lower_mcp_map(map: Option<&Value>) -> Vec<(String, McpServerConfig)> {
    let Some(map) = map.and_then(Value::as_object) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(name, entry)| {
            let entry = entry.as_object()?;
            // Ryu enables every imported server, so a server the user switched
            // off in the source is not offered at all.
            if entry.get("enabled").and_then(Value::as_bool) == Some(false) {
                return None;
            }
            let text = |key: &str| {
                entry
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            let strings = |key: &str| -> BTreeMap<String, String> {
                entry
                    .get(key)
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| match v {
                                Value::String(s) => Some((k.clone(), s.clone())),
                                Value::Number(n) => Some((k.clone(), n.to_string())),
                                Value::Bool(b) => Some((k.clone(), b.to_string())),
                                _ => None,
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let transport = text("transport").or_else(|| text("type")).map(|t| {
                match t.to_ascii_lowercase().as_str() {
                    "streamable-http" | "streamable_http" | "http" => "http".to_string(),
                    other => other.to_string(),
                }
            });
            Some((
                name.clone(),
                McpServerConfig {
                    command: text("command"),
                    transport,
                    url: text("url"),
                    headers: strings("headers"),
                    auth: None,
                    owner_plugin_id: None,
                    owner_server_name: None,
                    cwd: None,
                    args: entry
                        .get("args")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    env: strings("env"),
                    description: text("description"),
                    enabled: true,
                    version: None,
                    catalog_id: None,
                },
            ))
        })
        .collect()
}

/// Convert JSON5 (comments, trailing commas, unquoted keys, single-quoted
/// strings) into strict JSON. Strict JSON passes through unchanged.
pub fn json5_to_json(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '"' | '\'' => {
                let quote = ch;
                out.push('"');
                i += 1;
                while i < chars.len() && chars[i] != quote {
                    let c = chars[i];
                    if c == '\\' && i + 1 < chars.len() {
                        let next = chars[i + 1];
                        if next == '\'' {
                            out.push('\'');
                        } else if next == '\n' {
                            // JSON5 line continuation.
                        } else {
                            out.push('\\');
                            out.push(next);
                        }
                        i += 2;
                        continue;
                    }
                    if c == '"' {
                        out.push_str("\\\"");
                    } else if c == '\n' {
                        out.push_str("\\n");
                    } else {
                        out.push(c);
                    }
                    i += 1;
                }
                out.push('"');
                i += 1;
            }
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            '}' | ']' => {
                let trimmed_len = out.trim_end().len();
                if out[..trimmed_len].ends_with(',') {
                    out.truncate(trimmed_len - 1);
                }
                out.push(ch);
                i += 1;
            }
            c if c.is_ascii_alphabetic() || c == '_' || c == '$' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '$')
                {
                    i += 1;
                }
                let ident: String = chars[start..i].iter().collect();
                let mut j = i;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                let is_key = chars.get(j) == Some(&':');
                if is_key {
                    out.push('"');
                    out.push_str(&ident);
                    out.push('"');
                } else {
                    out.push_str(&ident);
                }
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Review notes (never imported, never values)
// ---------------------------------------------------------------------------

fn collect_openclaw_notes(root: &Path, c: &mut Collector) {
    let Some(config) = read_openclaw_config(root) else {
        if OPENCLAW_CONFIG_FILES.iter().any(|f| root.join(f).is_file()) {
            c.warnings
                .push("OpenClaw config could not be parsed; MCP servers and the default model were not read.".to_owned());
        }
        note_persona_leftovers(root, c);
        return;
    };
    if let Some(workspace) = config
        .pointer("/agents/defaults/workspace")
        .and_then(Value::as_str)
    {
        let resolved = expand_home(workspace);
        if resolved
            .canonicalize()
            .ok()
            .is_some_and(|p| !p.starts_with(root))
        {
            c.warnings.push(format!(
                "OpenClaw workspace {workspace} is outside the scanned folder; scan it separately to import its persona and memory."
            ));
        }
    }
    if let Some(channels) = config.get("channels").and_then(Value::as_object) {
        let names: Vec<&str> = channels.keys().map(String::as_str).collect();
        if !names.is_empty() {
            c.warnings.push(format!(
                "Channels configured in OpenClaw ({}) are not imported; reconnect them in Ryu Channels. Bot tokens are never copied by a scan.",
                names.join(", ")
            ));
        }
    }
    if config.pointer("/models/providers").is_some() {
        c.warnings.push(
            "OpenClaw custom model providers are not imported; add them in Ryu Providers (keys go to the Secret Vault)."
                .to_owned(),
        );
    }
    note_persona_leftovers(root, c);
    if root.join("cron").is_dir() {
        c.warnings.push(
            "OpenClaw cron jobs are not imported; recreate them as Ryu schedules.".to_owned(),
        );
    }
}

fn collect_hermes_notes(root: &Path, c: &mut Collector) {
    note_persona_leftovers(root, c);
    if root.join("cron").is_dir() {
        c.warnings
            .push("Hermes cron jobs are not imported; recreate them as Ryu schedules.".to_owned());
    }
    if root.join("auth.json").is_file() {
        c.warnings.push(
            "Hermes OAuth provider sign-ins (auth.json) are not copied; sign in again in Ryu Providers."
                .to_owned(),
        );
    }
    if root.join("sessions").is_dir() {
        c.warnings
            .push("Hermes gateway sessions are runtime state and are not imported.".to_owned());
    }
}

fn collect_muse_notes(root: &Path, c: &mut Collector) {
    note_persona_leftovers(root, c);
    if root.join("dreams").is_dir() {
        c.warnings.push(
            "Muse dream reviews (dreams/) are archived reflections, not memories; they are not imported."
                .to_owned(),
        );
    }
    if root.join("ALIGNMENT_SYNTHESIS.md").is_file() {
        c.warnings.push(
            "Muse ALIGNMENT_SYNTHESIS.md is not imported automatically; review it and add standing guidance to the agent if you want it."
                .to_owned(),
        );
    }
}

/// Persona-adjacent files with no direct Ryu equivalent.
fn note_persona_leftovers(root: &Path, c: &mut Collector) {
    let mut dirs = vec![root.to_path_buf()];
    dirs.extend(persona_workspaces(root, Framework::OpenClaw));
    dirs.dedup();
    for dir in dirs {
        if dir.join("HEARTBEAT.md").is_file() {
            c.warnings.push(format!(
                "{} is not imported; recreate the heartbeat as a Ryu schedule.",
                dir.join("HEARTBEAT.md").to_string_lossy()
            ));
        }
        if dir.join("BOOTSTRAP.md").is_file() {
            c.warnings.push(format!(
                "{} is a first-run script and is not imported.",
                dir.join("BOOTSTRAP.md").to_string_lossy()
            ));
        }
    }
}

/// Report credential-looking variable NAMES found in the source's `.env` so a
/// user can move them into the Secret Vault deliberately. Values are never read
/// into the scan result.
fn collect_env_credential_names(root: &Path, framework: Framework, c: &mut Collector) {
    let path = root.join(".env");
    let Some(raw) = read_bounded(&path, MAX_FRAMEWORK_FILE_BYTES) else {
        return;
    };
    let names = credential_names(&raw);
    if names.is_empty() {
        return;
    }
    c.warnings.push(format!(
        "{} .env holds {} credential(s) ({}). Credentials are never imported by a scan; move them into the Secret Vault with `ryu migrate {} --secrets` or `ryu secrets import`.",
        framework.label(),
        names.len(),
        names.join(", "),
        path.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    ));
}

/// Names of credential-looking `KEY=value` lines in a dotenv file.
pub fn credential_names(dotenv: &str) -> Vec<String> {
    let mut names: Vec<String> = dotenv
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let line = line.strip_prefix("export ").unwrap_or(line);
            if line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            let value = value.trim().trim_matches(['"', '\'']);
            (is_credential_name(key) && !value.is_empty()).then(|| key.to_string())
        })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// `UPPER_SNAKE` names ending in a credential suffix.
pub fn is_credential_name(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD"]
            .iter()
            .any(|suffix| key.ends_with(suffix))
}

// ---------------------------------------------------------------------------
// Code-defined agents (Mastra / LangChain)
// ---------------------------------------------------------------------------

/// One agent extracted from source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodeAgent {
    pub name: String,
    pub description: Option<String>,
    pub instructions: String,
    pub model: Option<String>,
}

/// Outcome of extracting agents from one file: agents with static
/// instructions, plus call sites that could not be converted.
#[derive(Debug, Default)]
pub struct CodeAgents {
    pub agents: Vec<CodeAgent>,
    pub unresolved: Vec<String>,
}

fn collect_code_agents(root: &Path, framework: Framework, c: &mut Collector) {
    let mut files = Vec::new();
    source_files(root, 0, &mut files);
    let mut unresolved = Vec::new();
    for path in files {
        if c.agents.len() >= super::MAX_SUBAGENTS {
            break;
        }
        let Some(src) = read_bounded(&path, MAX_SOURCE_FILE_BYTES) else {
            continue;
        };
        let found = extract_code_agents(&src, &path, framework);
        let rel = rel_path(&c.root, &path);
        for (index, agent) in found.agents.iter().enumerate() {
            // The cap holds within one file too: a single source can define
            // more agents than a scan offers.
            if c.agents.len() >= super::MAX_SUBAGENTS {
                break;
            }
            c.agents.push(ScanItem {
                content_revision: None,
                kind: kind::AGENT,
                id: format!("{}/{rel}#{index}", kind::AGENT),
                title: format!("{} agent '{}'", framework.label(), agent.name),
                detail: Some(path.to_string_lossy().to_string()),
                already_exists: false,
            });
        }
        unresolved.extend(
            found
                .unresolved
                .into_iter()
                .map(|what| format!("{rel}: {what}")),
        );
    }
    if !unresolved.is_empty() {
        let shown: Vec<_> = unresolved.iter().take(10).cloned().collect();
        c.warnings.push(format!(
            "{} agent(s) whose instructions are built at runtime were not imported ({}{}); copy their prompts into a Ryu agent manually.",
            unresolved.len(),
            shown.join("; "),
            if unresolved.len() > shown.len() { "; …" } else { "" }
        ));
    }
    c.warnings.push(format!(
        "{} tools, workflows, and graphs are code and are not converted. Expose existing tools to Ryu through an MCP server, or point the project's model client at Ryu Gateway's OpenAI-compatible endpoint to keep running it unchanged.",
        framework.label()
    ));
}

fn source_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_SOURCE_DEPTH || out.len() >= MAX_SOURCE_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_SOURCE_FILES {
            return;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if ft.is_dir() {
            if name.starts_with('.')
                || super::is_skipped_dir(name)
                || matches!(
                    name,
                    "__pycache__" | "venv" | ".venv" | "site-packages" | "coverage"
                )
            {
                continue;
            }
            source_files(&entry.path(), depth + 1, out);
        } else if ft.is_file() {
            let is_source = [".ts", ".tsx", ".mts", ".js", ".mjs", ".py"]
                .iter()
                .any(|ext| name.ends_with(ext))
                && !name.ends_with(".d.ts")
                && !name.contains(".test.")
                && !name.contains(".spec.");
            if is_source
                && file_size(&entry.path())
                    .map(|s| s <= MAX_SOURCE_FILE_BYTES)
                    .unwrap_or(false)
            {
                out.push(entry.path());
            }
        }
    }
}

/// Extract the `#index`-th code agent from a source file. Used by the import
/// step to re-read the agent from disk.
pub fn parse_code_agent(root: &Path, path: &Path, index: usize) -> Option<CodeAgent> {
    let framework = detect(root)?;
    let src = read_bounded(path, MAX_SOURCE_FILE_BYTES)?;
    extract_code_agents(&src, path, framework)
        .agents
        .into_iter()
        .nth(index)
}

/// Constructor calls that define an agent, per framework and language.
fn agent_constructors(framework: Framework, python: bool) -> &'static [&'static str] {
    match (framework, python) {
        (Framework::Mastra, false) => &["new Agent("],
        (Framework::LangChain, true) => &[
            "create_react_agent(",
            "create_agent(",
            "create_deep_agent(",
            "create_tool_calling_agent(",
        ],
        (Framework::LangChain, false) => &[
            "createReactAgent(",
            "createAgent(",
            "createDeepAgent(",
            "createToolCallingAgent(",
        ],
        _ => &[],
    }
}

/// Keys that carry the system prompt, in preference order.
fn instruction_keys(framework: Framework, python: bool) -> &'static [&'static str] {
    match (framework, python) {
        (Framework::Mastra, _) => &["instructions"],
        (Framework::LangChain, true) => {
            &["system_prompt", "prompt", "instructions", "state_modifier"]
        }
        _ => &["systemPrompt", "prompt", "instructions", "stateModifier"],
    }
}

pub fn extract_code_agents(src: &str, path: &Path, framework: Framework) -> CodeAgents {
    let python = path.extension().and_then(|e| e.to_str()) == Some("py");
    let lexer = Lexer { python };
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("agent")
        .to_string();
    let mut calls: Vec<(usize, usize)> = Vec::new();
    for ctor in agent_constructors(framework, python) {
        let mut from = 0;
        while let Some(pos) = src[from..].find(ctor) {
            let start = from + pos;
            from = start + ctor.len();
            // Reject `foo.create_agent(` method-chains on unrelated objects and
            // identifiers that merely end with the constructor name.
            let prev = src[..start].chars().next_back();
            if prev.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }
            if lexer.in_code(src, start) {
                calls.push((start, start + ctor.len() - 1));
            }
        }
    }
    calls.sort_unstable();
    let mut out = CodeAgents::default();
    for (start, open) in calls {
        let Some(close) = lexer.matching_close(src, open) else {
            continue;
        };
        let mut args = &src[open + 1..close];
        if !python {
            // `new Agent({ ... })` / `createReactAgent({ ... })`: read the
            // options object literal.
            let trimmed = args.trim_start();
            if let Some(stripped) = trimmed.strip_prefix('{') {
                let offset = args.len() - stripped.len() - 1;
                let brace = open + 1 + offset;
                if let Some(end) = lexer.matching_close(src, brace) {
                    args = &src[brace + 1..end];
                }
            }
        }
        let separator = if python { '=' } else { ':' };
        let value_of = |key: &str| lexer.top_level_value(args, key, separator);
        let instructions = instruction_keys(framework, python)
            .iter()
            .find_map(|key| value_of(key))
            .and_then(|value| lexer.resolve_string(src, value));
        let assigned = assigned_name(src, start);
        let name = value_of("name")
            .or_else(|| value_of("id"))
            .and_then(|v| lexer.resolve_string(src, v))
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .or(assigned.clone())
            .unwrap_or_else(|| format!("{stem}-{}", out.agents.len() + 1));
        let Some(instructions) = instructions.filter(|i| !i.trim().is_empty()) else {
            out.unresolved.push(name);
            continue;
        };
        let model = value_of("model")
            .or_else(|| value_of("llm"))
            .and_then(|v| lexer.model_ref(src, v));
        let description = value_of("description").and_then(|v| lexer.resolve_string(src, v));
        out.agents.push(CodeAgent {
            name,
            description,
            instructions: instructions.trim().to_string(),
            model,
        });
    }
    out
}

/// `const foo = new Agent(` / `foo = create_agent(` → `foo`.
fn assigned_name(src: &str, call_start: usize) -> Option<String> {
    let before = src[..call_start].trim_end();
    let before = before.strip_suffix('=')?.trim_end();
    if before.ends_with(['=', '!', '<', '>']) {
        return None;
    }
    let before = before
        .rsplit_once(':')
        .filter(|(_, ty)| !ty.contains('\n'))
        .map(|(lhs, _)| lhs.trim_end())
        .unwrap_or(before);
    let ident: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    (!ident.is_empty() && !ident.chars().next().unwrap_or('0').is_ascii_digit()).then_some(ident)
}

/// A tiny lexer that understands enough JS/TS and Python string and comment
/// syntax to find call boundaries and static string literals.
struct Lexer {
    python: bool,
}

impl Lexer {
    /// Advance past one string literal starting at `i` (which must be a quote,
    /// or a Python prefix before one). Returns the index after the literal.
    fn skip_string(&self, b: &[u8], i: usize) -> Option<usize> {
        let mut i = i;
        if self.python {
            while i < b.len()
                && matches!(b[i], b'r' | b'R' | b'u' | b'U' | b'b' | b'B' | b'f' | b'F')
            {
                i += 1;
            }
        }
        let quote = *b.get(i)?;
        if !matches!(quote, b'"' | b'\'' | b'`') {
            return None;
        }
        let triple = self.python && b.get(i + 1) == Some(&quote) && b.get(i + 2) == Some(&quote);
        let mut j = if triple { i + 3 } else { i + 1 };
        while j < b.len() {
            if b[j] == b'\\' {
                j += 2;
                continue;
            }
            if b[j] == quote {
                if !triple {
                    return Some(j + 1);
                }
                if b.get(j + 1) == Some(&quote) && b.get(j + 2) == Some(&quote) {
                    return Some(j + 3);
                }
            }
            if b[j] == b'\n' && !triple && quote != b'`' {
                return Some(j);
            }
            j += 1;
        }
        Some(b.len())
    }

    fn comment_end(&self, b: &[u8], i: usize) -> Option<usize> {
        if self.python {
            if b[i] == b'#' {
                return Some(
                    b[i..]
                        .iter()
                        .position(|c| *c == b'\n')
                        .map_or(b.len(), |p| i + p),
                );
            }
            return None;
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            return Some(
                b[i..]
                    .iter()
                    .position(|c| *c == b'\n')
                    .map_or(b.len(), |p| i + p),
            );
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            return Some(
                b[i + 2..]
                    .windows(2)
                    .position(|w| w == b"*/")
                    .map_or(b.len(), |p| i + 2 + p + 2),
            );
        }
        None
    }

    fn is_quote(b: u8) -> bool {
        matches!(b, b'"' | b'\'' | b'`')
    }

    /// True when byte offset `pos` is outside strings and comments.
    fn in_code(&self, src: &str, pos: usize) -> bool {
        let b = src.as_bytes();
        let mut i = 0;
        while i < pos {
            if let Some(end) = self.comment_end(b, i) {
                if end > pos {
                    return false;
                }
                i = end.max(i + 1);
                continue;
            }
            if Self::is_quote(b[i]) {
                let end = self.skip_string(b, i).unwrap_or(b.len());
                if end > pos {
                    return false;
                }
                i = end;
                continue;
            }
            i += 1;
        }
        true
    }

    /// Index of the bracket closing the one at `open`.
    fn matching_close(&self, src: &str, open: usize) -> Option<usize> {
        let b = src.as_bytes();
        let mut depth = 0usize;
        let mut i = open;
        while i < b.len() {
            if let Some(end) = self.comment_end(b, i) {
                i = end.max(i + 1);
                continue;
            }
            match b[i] {
                c if Self::is_quote(c) => {
                    i = self.skip_string(b, i)?;
                    continue;
                }
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    /// The source text of `key`'s value at the top level of `args`
    /// (`key=value` in Python calls, `key: value` in JS objects). Shorthand
    /// properties (`{ instructions }`) resolve to the identifier itself.
    fn top_level_value<'a>(&self, args: &'a str, key: &str, sep: char) -> Option<&'a str> {
        let b = args.as_bytes();
        let mut depth = 0usize;
        let mut i = 0;
        let mut at_item_start = true;
        while i < b.len() {
            if let Some(end) = self.comment_end(b, i) {
                i = end.max(i + 1);
                continue;
            }
            let c = b[i];
            if Self::is_quote(c) {
                i = self.skip_string(b, i).unwrap_or(b.len());
                at_item_start = false;
                continue;
            }
            match c {
                b'(' | b'[' | b'{' => {
                    depth += 1;
                    at_item_start = false;
                }
                b')' | b']' | b'}' => depth = depth.saturating_sub(1),
                b',' if depth == 0 => at_item_start = true,
                c if c.is_ascii_whitespace() => {}
                _ if depth == 0 && at_item_start => {
                    at_item_start = false;
                    let rest = &args[i..];
                    let ident_len = rest
                        .bytes()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$')
                        .count();
                    if &rest[..ident_len] == key {
                        let after = rest[ident_len..].trim_start();
                        if let Some(value) = after.strip_prefix(sep) {
                            if !value.starts_with('=') {
                                return Some(value.trim_start());
                            }
                        }
                        if sep == ':' && (after.starts_with(',') || after.is_empty()) {
                            return Some(&rest[..ident_len]);
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    /// A static string value: a literal (or concatenation of literals), or an
    /// identifier bound to one elsewhere in the same file.
    fn resolve_string(&self, src: &str, value: &str) -> Option<String> {
        if let Some(s) = self.string_value(value) {
            return Some(s);
        }
        let ident: String = value
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
            .collect();
        let after = value[ident.len()..].trim_start();
        if ident.is_empty() || !(after.is_empty() || after.starts_with([',', '\n', ')', '}'])) {
            return None;
        }
        self.binding_value(src, &ident)
    }

    /// Find `IDENT = <literal>` (optionally `const`/`let`/typed) in `src`.
    fn binding_value(&self, src: &str, ident: &str) -> Option<String> {
        let mut from = 0;
        while let Some(pos) = src[from..].find(ident) {
            let start = from + pos;
            from = start + ident.len();
            let prev = src[..start].chars().next_back();
            if prev.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.') {
                continue;
            }
            let mut rest = src[from..].trim_start();
            if let Some(typed) = rest.strip_prefix(':') {
                // `NAME: str = "..."` / `const NAME: string = "..."`
                rest = typed.trim_start_matches(|c: char| c != '=' && c != '\n');
            }
            let Some(value) = rest.strip_prefix('=') else {
                continue;
            };
            if value.starts_with(['=', '>']) || !self.in_code(src, start) {
                continue;
            }
            if let Some(s) = self.string_value(value.trim_start()) {
                return Some(s);
            }
        }
        None
    }

    /// Decode a literal or literal concatenation at the start of `value`.
    fn string_value(&self, value: &str) -> Option<String> {
        let mut text = value.trim_start();
        let mut wrapped = false;
        if self.python {
            if let Some(inner) = text.strip_prefix('(') {
                text = inner.trim_start();
                wrapped = true;
            }
        }
        let mut out = String::new();
        let mut parts = 0;
        loop {
            let (part, len) = self.decode_literal(text)?;
            out.push_str(&part);
            parts += 1;
            text = text[len..].trim_start();
            if !self.python {
                if let Some(rest) = text.strip_prefix('+') {
                    text = rest.trim_start();
                    continue;
                }
            } else if text.starts_with(['"', '\'']) || (wrapped && text.starts_with(['r', 'R'])) {
                continue;
            }
            break;
        }
        if wrapped {
            text.strip_prefix(')')?;
        }
        (parts > 0).then_some(out)
    }

    /// Decode one literal at the start of `text`, returning `(value, byte_len)`.
    /// f-strings and template literals with substitutions are not static.
    fn decode_literal(&self, text: &str) -> Option<(String, usize)> {
        let b = text.as_bytes();
        let mut i = 0;
        let mut raw = false;
        if self.python {
            while i < b.len()
                && matches!(b[i], b'r' | b'R' | b'u' | b'U' | b'f' | b'F' | b'b' | b'B')
            {
                if matches!(b[i], b'f' | b'F' | b'b' | b'B') {
                    return None;
                }
                raw |= matches!(b[i], b'r' | b'R');
                i += 1;
            }
        }
        let quote = *b.get(i)?;
        if !Self::is_quote(quote) || (self.python && quote == b'`') {
            return None;
        }
        let end = self.skip_string(b, i)?;
        let triple = self.python && b.get(i + 1) == Some(&quote) && b.get(i + 2) == Some(&quote);
        let delim = if triple { 3 } else { 1 };
        if end < i + 2 * delim || b[end - 1] != quote {
            return None;
        }
        let body = &text[i + delim..end - delim];
        if quote == b'`' && body.contains("${") {
            return None;
        }
        let value = if raw {
            body.to_string()
        } else {
            unescape(body)
        };
        let value = if triple || quote == b'`' {
            dedent(&value)
        } else {
            value
        };
        Some((value, end))
    }

    /// `openai("gpt-4o")` → `openai/gpt-4o`; `"openai:gpt-4o"` → `openai/gpt-4o`;
    /// `ChatAnthropic(model="claude-x")` → `anthropic/claude-x`;
    /// `init_chat_model("gpt-4o", model_provider="openai")` → `openai/gpt-4o`.
    fn model_ref(&self, src: &str, value: &str) -> Option<String> {
        if let Some(s) = self.resolve_string(src, value) {
            let s = s.trim();
            return (!s.is_empty()).then(|| s.replacen(':', "/", 1));
        }
        let value = value.strip_prefix("new ").unwrap_or(value).trim_start();
        let ident: String = value
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
            .collect();
        let rest = value[ident.len()..].trim_start();
        let open = value.len() - rest.len();
        if !rest.starts_with('(') {
            return None;
        }
        let close = self.matching_close(value, open)?;
        let mut args = value[open + 1..close].trim();
        if let Some(object) = args.strip_prefix('{').and_then(|a| a.strip_suffix('}')) {
            args = object;
        }
        let sep = if self.python { '=' } else { ':' };
        let first = self.string_value(args).or_else(|| {
            ["model", "model_name", "modelName"]
                .iter()
                .find_map(|k| self.top_level_value(args, k, sep))
                .and_then(|v| self.resolve_string(src, v))
        })?;
        let first = first.trim().replacen(':', "/", 1);
        if first.contains('/') {
            return Some(first);
        }
        let provider = self
            .top_level_value(args, "model_provider", sep)
            .and_then(|v| self.string_value(v))
            .or_else(|| provider_for_constructor(ident.rsplit('.').next().unwrap_or(&ident)))?;
        Some(format!("{provider}/{first}"))
    }
}

fn provider_for_constructor(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    let provider = match lower.as_str() {
        "openai" | "chatopenai" | "azurechatopenai" => "openai",
        "anthropic" | "chatanthropic" => "anthropic",
        "google" | "chatgooglegenerativeai" | "chatvertexai" => "google",
        "groq" | "chatgroq" => "groq",
        "mistral" | "chatmistralai" => "mistral",
        "ollama" | "chatollama" => "ollama",
        "deepseek" | "chatdeepseek" => "deepseek",
        "xai" | "chatxai" => "xai",
        "openrouter" | "chatopenrouter" => "openrouter",
        _ => return None,
    };
    Some(provider.to_string())
}

fn unescape(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => {}
            Some('\n') => {}
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Remove the common leading indentation of a multi-line literal.
fn dedent(text: &str) -> String {
    let indent = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    text.lines()
        .map(|l| {
            if l.len() >= indent {
                &l[indent..]
            } else {
                l.trim_start()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_bounded(path: &Path, max: u64) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn expand_home(path: &str) -> PathBuf {
    match path.strip_prefix('~') {
        Some(rest) => dirs::home_dir()
            .map(|home| home.join(rest.trim_start_matches(['/', '\\'])))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_tree() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ryu-frameworks-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn write(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn json5_converts_comments_keys_quotes_and_trailing_commas() {
        let src = r#"{
  // the default agent
  agents: { defaults: { model: 'anthropic/claude-x', workspace: "~/w", }, },
  /* servers */
  mcp: { servers: { docs: { command: "uvx", args: ['mcp-server-fetch',], enabled: true } } },
  note: 'it\'s "quoted"',
}"#;
        let value: Value = serde_json::from_str(&json5_to_json(src)).unwrap();
        assert_eq!(
            value.pointer("/agents/defaults/model").unwrap(),
            "anthropic/claude-x"
        );
        assert_eq!(
            value.pointer("/mcp/servers/docs/args/0").unwrap(),
            "mcp-server-fetch"
        );
        assert_eq!(value.pointer("/note").unwrap(), "it's \"quoted\"");
        assert_eq!(json5_to_json(r#"{"a":[1,2]}"#), r#"{"a":[1,2]}"#);
    }

    #[test]
    fn openclaw_home_yields_persona_memory_mcp_skills_and_notes() {
        let root = temp_tree().join(".openclaw");
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        write(
            &root,
            "openclaw.json",
            r#"{
  agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] } } },
  channels: { telegram: { botToken: "123:abc" } },
  mcp: { servers: {
    docs: { command: "uvx", args: ["mcp-server-fetch"] },
    remote: { url: "https://mcp.example.com/mcp", transport: "streamable-http", headers: { Authorization: "Bearer ${T}" } },
  } },
}"#,
        );
        write(&root, "workspace/SOUL.md", "You are calm and direct.\n");
        write(
            &root,
            "workspace/IDENTITY.md",
            "- **Name:** Clawd\n- **Emoji:** 🦞\n",
        );
        write(&root, "workspace/AGENTS.md", "Always run tests.\n");
        write(&root, "workspace/HEARTBEAT.md", "check inbox\n");
        write(
            &root,
            "workspace/MEMORY.md",
            "# Facts\n- Lives in Lisbon\n- Prefers tea\n",
        );
        write(&root, "workspace/USER.md", "Name: Sam\n\nWorks on Ryu.\n");
        write(
            &root,
            "workspace/memory/2026-10-01.md",
            "- Shipped the importer\n",
        );
        write(&root, "workspace/memory/notes.md", "- not a daily file\n");
        write(
            &root,
            "workspace/skills/deploy/SKILL.md",
            "---\nname: deploy\ndescription: d\n---\nDeploy.\n",
        );
        write(
            &root,
            ".env",
            "OPENAI_API_KEY=sk-test\nTELEGRAM_BOT_TOKEN=1:x\nLOG_LEVEL=debug\n",
        );

        let scan = super::super::scan_source(&root).unwrap();
        assert_eq!(scan.source, Some("openclaw"));
        let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"agent/workspace/SOUL.md"), "{ids:?}");
        assert!(ids.contains(&"memory/workspace/MEMORY.md"), "{ids:?}");
        assert!(ids.contains(&"memory/workspace/USER.md"), "{ids:?}");
        assert!(
            ids.contains(&"memory/workspace/memory/2026-10-01.md"),
            "{ids:?}"
        );
        assert!(
            !ids.contains(&"memory/workspace/memory/notes.md"),
            "{ids:?}"
        );
        assert!(ids.contains(&"mcp_server/mcp/openclaw/docs"), "{ids:?}");
        assert!(ids.contains(&"mcp_server/mcp/openclaw/remote"), "{ids:?}");
        assert!(
            ids.iter()
                .any(|id| id.starts_with("skill/workspace/skills/deploy")),
            "{ids:?}"
        );
        let warnings = scan.warnings.join("\n");
        assert!(warnings.contains("telegram"), "{warnings}");
        assert!(warnings.contains("HEARTBEAT.md"), "{warnings}");
        assert!(warnings.contains("OPENAI_API_KEY") && warnings.contains("TELEGRAM_BOT_TOKEN"));
        assert!(
            !warnings.contains("sk-test")
                && !warnings.contains("123:abc")
                && !warnings.contains("LOG_LEVEL")
        );

        let persona = parse_persona(&root, &root.join("workspace/SOUL.md")).unwrap();
        assert_eq!(persona.name, "Clawd");
        assert_eq!(
            persona.model.as_deref(),
            Some("anthropic/claude-sonnet-4-6")
        );
        assert!(persona.system_prompt.contains("calm and direct"));
        assert!(persona.system_prompt.contains("Always run tests"));

        let servers = parse_openclaw_mcp(&root.join("openclaw.json")).unwrap();
        let remote = &servers.iter().find(|(n, _)| n == "remote").unwrap().1;
        assert_eq!(remote.transport.as_deref(), Some("http"));
        assert_eq!(remote.headers.get("Authorization").unwrap(), "Bearer ${T}");

        let memory = parse_markdown_memory(&root.join("workspace/MEMORY.md")).unwrap();
        assert_eq!(memory.entries, vec!["Lives in Lisbon", "Prefers tea"]);
        let daily = parse_markdown_memory(&root.join("workspace/memory/2026-10-01.md")).unwrap();
        assert_eq!(daily.entries, vec!["On 2026-10-01: Shipped the importer"]);
        assert_eq!(daily.category, ryu_memory::MemoryCategory::Event);
        let user = parse_markdown_memory(&root.join("workspace/USER.md")).unwrap();
        assert_eq!(user.category, ryu_memory::MemoryCategory::UserFact);
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn hermes_home_reads_section_delimited_memory_and_yaml_mcp() {
        let root = temp_tree().join(".hermes");
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        write(
            &root,
            "config.yaml",
            "model:\n  default: claude-sonnet-4-6\n  provider: anthropic\nmcp_servers:\n  github:\n    command: npx\n    args: [\"-y\", \"@modelcontextprotocol/server-github\"]\n    env:\n      GITHUB_PERSONAL_ACCESS_TOKEN: ${GH}\n  stripe:\n    url: https://mcp.stripe.com\n    enabled: false\n",
        );
        write(&root, "SOUL.md", "You are Hermes.\n");
        write(
            &root,
            "memories/MEMORY.md",
            "Rust service at ~/code/api\n§\nUbuntu 22.04 with Docker\n§\nPrefers concise answers\n",
        );
        write(&root, "memories/USER.md", "User is called Ada\n");
        write(
            &root,
            "skills/research/arxiv/SKILL.md",
            "---\nname: arxiv\ndescription: d\n---\nSearch.\n",
        );
        write(&root, "auth.json", "{}");

        let scan = super::super::scan_source(&root).unwrap();
        assert_eq!(scan.source, Some("hermes"));
        let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"agent/SOUL.md"), "{ids:?}");
        assert!(ids.contains(&"memory/memories/MEMORY.md"), "{ids:?}");
        assert!(ids.contains(&"mcp_server/mcp/hermes/github"), "{ids:?}");
        assert!(ids.iter().any(|id| id.contains("arxiv")), "{ids:?}");

        let memory = parse_markdown_memory(&root.join("memories/MEMORY.md")).unwrap();
        assert_eq!(memory.entries.len(), 3);
        let persona = parse_persona(&root, &root.join("SOUL.md")).unwrap();
        assert_eq!(persona.name, "hermes");
        assert_eq!(
            persona.model.as_deref(),
            Some("anthropic/claude-sonnet-4-6")
        );
        let servers = parse_hermes_mcp(&root.join("config.yaml")).unwrap();
        assert!(servers.iter().any(|(n, _)| n == "github"));
        assert!(
            !servers.iter().any(|(n, _)| n == "stripe"),
            "disabled servers are not offered"
        );
        let _ = fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn muse_export_reads_bank_memory() {
        let root = temp_tree();
        write(&root, "SOUL.md", "Muse persona\n");
        write(&root, "MEMORY.md", "- Has a dog named Pixel\n");
        write(&root, "memory/bank/preferences/food.md", "- Vegetarian\n");
        write(&root, "dreams/2026-10-01.md", "reflection\n");
        let scan = super::super::scan_source(&root).unwrap();
        assert_eq!(scan.source, Some("muse"));
        let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
        assert!(
            ids.contains(&"memory/memory/bank/preferences/food.md"),
            "{ids:?}"
        );
        let bank = parse_markdown_memory(&root.join("memory/bank/preferences/food.md")).unwrap();
        assert_eq!(bank.category, ryu_memory::MemoryCategory::Preference);
        assert!(scan.warnings.iter().any(|w| w.contains("dreams")));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mastra_agents_with_static_instructions_are_extracted() {
        let src = r#"
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";

const SUPPORT_PROMPT = `
  You are a support agent.
  Be kind.
`;

// new Agent({ name: "commented" })
export const weatherAgent = new Agent({
  name: "Weather Agent",
  instructions: "You are a helpful weather assistant." + " Use metric units.",
  model: openai("gpt-4o-mini"),
  tools: { weatherTool },
});

export const supportAgent = new Agent({
  id: "support",
  instructions: SUPPORT_PROMPT,
  model: "anthropic/claude-sonnet-4-6",
});

export const dynamicAgent = new Agent({
  name: "dynamic",
  instructions: ({ runtimeContext }) => `Hi ${runtimeContext.get("user")}`,
  model: openai("gpt-4o"),
});
"#;
        let found = extract_code_agents(src, Path::new("agents.ts"), Framework::Mastra);
        assert_eq!(found.agents.len(), 2, "{found:?}");
        assert_eq!(found.agents[0].name, "Weather Agent");
        assert_eq!(
            found.agents[0].instructions,
            "You are a helpful weather assistant. Use metric units."
        );
        assert_eq!(found.agents[0].model.as_deref(), Some("openai/gpt-4o-mini"));
        assert_eq!(found.agents[1].name, "support");
        assert_eq!(
            found.agents[1].instructions,
            "You are a support agent.\nBe kind."
        );
        assert_eq!(
            found.agents[1].model.as_deref(),
            Some("anthropic/claude-sonnet-4-6")
        );
        assert_eq!(found.unresolved, vec!["dynamic".to_string()]);
    }

    #[test]
    fn langchain_python_and_js_agents_are_extracted() {
        let py = r#"
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic

SYSTEM_PROMPT = """
    You are a research assistant.
    Cite sources.
"""

research_agent = create_react_agent(
    model=ChatAnthropic(model="claude-sonnet-4-6", temperature=0),
    tools=[search],
    prompt=SYSTEM_PROMPT,
)

# create_agent(model="x", system_prompt="commented")
writer = create_agent("openai:gpt-4o", tools=[], system_prompt=(
    "You write "
    "short posts."
), name="writer")

templated = create_agent(model="openai:gpt-4o", system_prompt=f"Hi {user}")
"#;
        let found = extract_code_agents(py, Path::new("graph.py"), Framework::LangChain);
        assert_eq!(found.agents.len(), 2, "{found:?}");
        assert_eq!(found.agents[0].name, "research_agent");
        assert_eq!(
            found.agents[0].instructions,
            "You are a research assistant.\nCite sources."
        );
        assert_eq!(
            found.agents[0].model.as_deref(),
            Some("anthropic/claude-sonnet-4-6")
        );
        assert_eq!(found.agents[1].name, "writer");
        assert_eq!(found.agents[1].instructions, "You write short posts.");
        assert_eq!(found.unresolved, vec!["templated".to_string()]);

        let js = r#"
const agent = createReactAgent({
  llm: new ChatOpenAI({ model: "gpt-4o" }),
  tools,
  prompt: 'You triage tickets.',
});
"#;
        let found = extract_code_agents(js, Path::new("agent.ts"), Framework::LangChain);
        assert_eq!(found.agents.len(), 1, "{found:?}");
        assert_eq!(found.agents[0].name, "agent");
        assert_eq!(found.agents[0].instructions, "You triage tickets.");
        assert_eq!(found.agents[0].model.as_deref(), Some("openai/gpt-4o"));
    }

    #[test]
    fn code_projects_are_detected_and_items_round_trip() {
        let root = temp_tree();
        write(
            &root,
            "package.json",
            r#"{"dependencies":{"@mastra/core":"^0.20.0"}}"#,
        );
        write(
            &root,
            "src/mastra/agents/index.ts",
            "export const a = new Agent({ name: 'a', instructions: 'Do A.', model: 'openai/gpt-4o' });\n",
        );
        write(
            &root,
            "node_modules/x/index.js",
            "new Agent({ name: 'dep', instructions: 'no' })",
        );
        let scan = super::super::scan_source(&root).unwrap();
        assert_eq!(scan.source, Some("mastra"));
        let agent = scan.items.iter().find(|i| i.kind == kind::AGENT).unwrap();
        assert_eq!(agent.id, "agent/src/mastra/agents/index.ts#0");
        assert_eq!(
            scan.items.iter().filter(|i| i.kind == kind::AGENT).count(),
            1
        );
        let (path, index) = super::super::resolve_agent_item(&root, &agent.id).unwrap();
        assert_eq!(index, Some(0));
        let parsed = parse_code_agent(&root, &path, 0).unwrap();
        assert_eq!(parsed.instructions, "Do A.");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn one_source_file_cannot_exceed_the_agent_cap() {
        let root = temp_tree();
        write(
            &root,
            "package.json",
            r#"{"dependencies":{"@mastra/core":"^0.20.0"}}"#,
        );
        let cap = super::super::MAX_SUBAGENTS;
        let src: String = (0..cap + 25)
            .map(|i| {
                format!(
                    "export const a{i} = new Agent({{ name: 'a{i}', instructions: 'Do {i}.', model: 'openai/gpt-4o' }});\n"
                )
            })
            .collect();
        write(&root, "src/agents.ts", &src);
        let scan = super::super::scan_source(&root).unwrap();
        assert_eq!(
            scan.items.iter().filter(|i| i.kind == kind::AGENT).count(),
            cap
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn credential_names_never_include_values_or_non_secrets() {
        let names = credential_names(
            "# c\nexport OPENAI_API_KEY=\"sk\"\nEMPTY_TOKEN=\nlower_key=x\nPORT=1\nDB_PASSWORD=p\n",
        );
        assert_eq!(names, vec!["DB_PASSWORD", "OPENAI_API_KEY"]);
    }

    #[test]
    fn plain_project_is_not_a_framework() {
        let root = temp_tree();
        write(&root, "package.json", r#"{"dependencies":{"react":"19"}}"#);
        assert_eq!(detect(&root), None);
        let _ = fs::remove_dir_all(&root);
    }
}
