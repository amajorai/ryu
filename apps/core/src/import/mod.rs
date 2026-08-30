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

use crate::sidecar::mcp::McpServerConfig;

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
}

/// One importable item found by a scan.
#[derive(Debug, Clone, Serialize)]
pub struct ScanItem {
    /// `instructions | skill | mcp_server | plugin | memory` (see [`kind`]).
    pub kind: &'static str,
    /// Opaque, root-relative locator. Round-trips back to a file/dir on disk in
    /// the import step (see `resolve_item`); never trust client bytes, always
    /// re-resolve against the folder.
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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
        mcp_names_present: existing_mcp_names(),
    };

    // Root-level instruction files + MCP config files.
    collect_root_files(root, &mut collector);
    // Cursor keeps its MCP config at `.cursor/mcp.json` — check it directly (the
    // walk skips nothing here; this is just a targeted one-level probe).
    collect_mcp_config(root, "cursor-json", ".cursor/mcp.json", &mut collector);

    // Bounded walk for skills / plugins / memory stores.
    walk(root, root, 0, &mut collector);

    let mut items = Vec::new();
    items.extend(collector.instructions.into_iter());
    items.extend(collector.skills.into_iter());
    items.extend(collector.mcp.into_iter());
    items.extend(collector.plugins.into_iter());
    items.extend(collector.memories.into_iter());
    items.extend(collector.agents.into_iter());
    items.extend(collector.slash_commands.into_iter());
    items.truncate(MAX_SCAN_ENTRIES);

    Ok(ScanResult {
        root: root.to_string_lossy().to_string(),
        items,
        warnings: collector.warnings,
    })
}

/// Accumulates scan results across the walk.
struct Collector {
    root: PathBuf,
    codex_root: Option<PathBuf>,
    entries_seen: usize,
    warnings: Vec<String>,
    instructions: Vec<ScanItem>,
    skills: Vec<ScanItem>,
    mcp: Vec<ScanItem>,
    plugins: Vec<ScanItem>,
    memories: Vec<ScanItem>,
    agents: Vec<ScanItem>,
    slash_commands: Vec<ScanItem>,
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

/// Root-level items: instruction files and MCP config files sitting at `root`.
fn collect_root_files(root: &Path, c: &mut Collector) {
    if c.exhausted() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        c.bump();
        if let Some(n) = entry.file_name().to_str() {
            names.push(n.to_string());
        }
    }
    let lower = |n: &str| n.to_ascii_lowercase();

    // Instructions: any AGENTS.md / CLAUDE.md at the root (case-insensitive).
    for n in names.iter().filter(|n| {
        let l = lower(n);
        l == "agents.md" || l == "claude.md"
    }) {
        if c.instructions.len() >= MAX_INSTRUCTIONS {
            break;
        }
        let path = root.join(n);
        if file_size(&path)
            .map(|s| s > MAX_INSTRUCTIONS_BYTES)
            .unwrap_or(false)
        {
            continue;
        }
        c.instructions.push(ScanItem {
            kind: kind::INSTRUCTIONS,
            id: format!("{}/{}", kind::INSTRUCTIONS, n),
            title: format!("Project instructions ({n})"),
            detail: Some(path.to_string_lossy().to_string()),
            already_exists: false,
        });
    }

    // MCP configs at the root.
    collect_mcp_config(root, "json", "mcp.json", c);
    collect_mcp_config(root, "toml", "config.toml", c);
    collect_mcp_config(root, "claude", ".claude.json", c);
}

/// Parse one MCP config file at `root` and emit an item per server.
fn collect_mcp_config(root: &Path, token: &str, rel: &str, c: &mut Collector) {
    if c.mcp.len() >= MAX_MCP_SERVERS {
        return;
    }
    let path = root.join(rel);
    if !path.is_file() {
        return;
    }
    if file_size(&path)
        .map(|s| s > MAX_SCAN_BYTES)
        .unwrap_or(false)
    {
        c.warnings.push(format!(
            "skipping {} (too large to scan)",
            path.to_string_lossy()
        ));
        return;
    }
    let servers = if is_toml_mcp(rel) {
        parse_mcp_toml(&path)
    } else {
        parse_mcp_json(&path)
    };
    let servers = match servers {
        Ok(s) => s,
        Err(e) => {
            c.warnings
                .push(format!("{}: {}", path.to_string_lossy(), e));
            return;
        }
    };
    for (name, _cfg) in servers {
        if c.mcp.len() >= MAX_MCP_SERVERS {
            break;
        }
        c.mcp.push(ScanItem {
            kind: kind::MCP_SERVER,
            id: format!("{}/mcp/{}/{}", kind::MCP_SERVER, token, name),
            title: format!("MCP server '{name}'"),
            detail: Some(path.to_string_lossy().to_string()),
            already_exists: c.mcp_names_present.contains(&name),
        });
    }
}

/// True when a config file path names a Codex-style TOML MCP config.
fn is_toml_mcp(rel: &str) -> bool {
    rel.ends_with("config.toml")
}

/// Recursive bounded walk: any dir that IS a skill / plugin / memory store is
/// recorded and not descended into.
fn walk(root: &Path, dir: &Path, depth: usize, c: &mut Collector) {
    if depth > MAX_SCAN_DEPTH || c.exhausted() {
        return;
    }

    // A plugin bundle: a directory that directly contains a manifest. Record it
    // (when under the cap) and never descend — a plugin dir is a unit.
    if let Some(manifest_name) = find_manifest(dir) {
        if c.plugins.len() < MAX_PLUGINS {
            if let Some(id) = plugin_id_from_file(&dir.join(manifest_name)) {
                let rel = rel_path(&c.root, dir);
                c.plugins.push(ScanItem {
                    kind: kind::PLUGIN,
                    id: format!("{}/{rel}", kind::PLUGIN),
                    title: format!("Plugin '{id}'"),
                    detail: Some(dir.to_string_lossy().to_string()),
                    already_exists: plugin_dir_exists(&id),
                });
            }
        }
        return;
    }

    // A skill: a directory that directly contains a SKILL.md. Record it and
    // don't descend (bundled resources live inside the skill dir).
    if has_skill_md(dir) {
        if c.skills.len() < MAX_SKILLS {
            let name = skill_install_name(dir);
            let rel = rel_path(&c.root, dir);
            c.skills.push(ScanItem {
                kind: kind::SKILL,
                id: format!("{}/{rel}", kind::SKILL),
                title: format!("Skill '{name}'"),
                detail: Some(dir.to_string_lossy().to_string()),
                already_exists: ryu_skills::SkillRegistry::skills_dir().join(&name).is_dir(),
            });
        }
        return;
    }

    // A Claude Code memory store: `**/memory/<uuid>.md`.
    if c.memories.len() < MAX_MEMORIES
        && dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("memory"))
            .unwrap_or(false)
    {
        let root = c.root.clone();
        collect_memory_files(&root, dir, c);
        return;
    }

    // A Codex subagent store: `agents/<name>.md` (only files that parse as
    // subagents are listed, so a project's stray `agents/` notes stay silent).
    let dir_name = dir.file_name().and_then(|n| n.to_str());
    if c.agents.len() < MAX_SUBAGENTS
        && c.codex_root
            .as_ref()
            .is_some_and(|codex_root| dir.starts_with(codex_root))
        && dir_name
            .map(|n| n.eq_ignore_ascii_case("agents"))
            .unwrap_or(false)
    {
        let root = c.root.clone();
        collect_codex_subagents(&root, dir, c);
        return;
    }

    // A Codex slash-command store: `prompts/<name>.md`.
    if c.slash_commands.len() < MAX_SLASH_COMMANDS
        && c.codex_root
            .as_ref()
            .is_some_and(|codex_root| dir.starts_with(codex_root))
        && dir_name
            .map(|n| n.eq_ignore_ascii_case("prompts"))
            .unwrap_or(false)
    {
        let root = c.root.clone();
        collect_codex_prompts(&root, dir, c);
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        c.bump();
        if c.exhausted() {
            return;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str() else {
            continue;
        };
        if is_skipped_dir(name) {
            continue;
        }
        walk(root, &entry.path(), depth + 1, c);
    }
}

/// Emit one item per Claude-style memory file under a `memory/` dir. Only files
/// that plausibly ARE Claude memories are listed (uuid-like stem OR the known
/// JSON content shape), so a project's random `memory/notes.md` stays silent.
fn collect_memory_files(root: &Path, dir: &Path, c: &mut Collector) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if c.memories.len() >= MAX_MEMORIES {
            break;
        }
        c.bump();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|n| n.split('.').next()) else {
            continue;
        };
        if name.to_string_lossy().to_ascii_lowercase().ends_with(".nl") {
            continue;
        }
        let path = entry.path();
        // Claude memory stems are uuids (hex + dashes). A non-uuid stem is only
        // accepted when the body looks like the Claude memory JSON/front-matter
        // shape (a raw-text file is too generic to be a memory store).
        let uuid_like =
            stem.len() == 36 && stem.chars().all(|ch| ch.is_ascii_hexdigit() || ch == '-');
        if !uuid_like && !looks_like_json_memory(&path) {
            continue;
        }
        let rel = rel_path(root, &path);
        c.memories.push(ScanItem {
            kind: kind::MEMORY,
            id: format!("{}/{rel}", kind::MEMORY),
            title: format!("Memory {stem}"),
            detail: Some(dir.to_string_lossy().to_string()),
            already_exists: false,
        });
    }
}

/// Emit one item per Codex subagent under an `agents/` dir. Only files that
/// parse as Codex subagents (front-matter with a `name`) are listed.
fn collect_codex_subagents(root: &Path, dir: &Path, c: &mut Collector) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if c.agents.len() >= MAX_SUBAGENTS {
            break;
        }
        c.bump();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if parse_codex_subagent(&path).is_none() {
            continue;
        }
        let rel = rel_path(root, &path);
        c.agents.push(ScanItem {
            kind: kind::AGENT,
            id: format!("{}/{rel}", kind::AGENT),
            title: format!(
                "Agent '{}'",
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("subagent")
            ),
            detail: Some(path.to_string_lossy().to_string()),
            already_exists: false,
        });
    }
}

/// Emit one item per Codex slash-command prompt under a `prompts/` dir. The
/// file stem is the command name; a file with no body is skipped.
fn collect_codex_prompts(root: &Path, dir: &Path, c: &mut Collector) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if c.slash_commands.len() >= MAX_SLASH_COMMANDS {
            break;
        }
        c.bump();
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_valid_command_name(stem) || parse_codex_prompt(&path).is_none() {
            continue;
        }
        let rel = rel_path(root, &path);
        c.slash_commands.push(ScanItem {
            kind: kind::SLASH_COMMAND,
            id: format!("{}/{rel}", kind::SLASH_COMMAND),
            title: format!("Slash command '/{stem}'"),
            detail: Some(path.to_string_lossy().to_string()),
            already_exists: false,
        });
    }
}

// ---------------------------------------------------------------------------
// Item id resolution (re-read from disk, never trust client bytes)
// ---------------------------------------------------------------------------

/// Re-resolve a selection's `id` to the on-disk path it names, guarding against
/// traversal outside `root`. Returns the absolute path and the id's relative form.
pub fn resolve_item_path(root: &Path, id: &str) -> Result<PathBuf> {
    let rel = id
        .strip_prefix(kind::INSTRUCTIONS)
        .and_then(|rest| rest.strip_prefix('/'))
        .or_else(|| {
            id.strip_prefix(kind::SKILL)
                .and_then(|rest| rest.strip_prefix('/'))
        })
        .or_else(|| {
            id.strip_prefix(kind::PLUGIN)
                .and_then(|rest| rest.strip_prefix('/'))
        })
        .or_else(|| {
            id.strip_prefix(kind::MEMORY)
                .and_then(|rest| rest.strip_prefix('/'))
        })
        .or_else(|| {
            id.strip_prefix(kind::AGENT)
                .and_then(|rest| rest.strip_prefix('/'))
        })
        .or_else(|| {
            id.strip_prefix(kind::SLASH_COMMAND)
                .and_then(|rest| rest.strip_prefix('/'))
        });
    let rel = match rel {
        Some(r) => r,
        None => bail!("unrecognized item id {id:?}"),
    };
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
        bail!("invalid item id {id:?}");
    }
    let mut path = root.to_path_buf();
    for segment in rel.split('/') {
        if segment.is_empty() || segment == "." {
            bail!("invalid item id {id:?}");
        }
        path.push(segment);
    }
    let canonical = fs::canonicalize(&path).with_context(|| format!("item {id:?} not found"))?;
    let canonical_root = fs::canonicalize(root).context("canonicalizing scan root")?;
    if !canonical.starts_with(&canonical_root) {
        bail!("item id escapes scan root");
    }
    Ok(canonical)
}

/// Recover the config token + server name from an `mcp_server` item id
/// (`mcp_server/mcp/<token>/<name>`). Returns `(token, name)`.
pub fn resolve_mcp_id(id: &str) -> Result<(&'static str, String)> {
    let rest = id
        .strip_prefix(kind::MCP_SERVER)
        .and_then(|r| r.strip_prefix("/mcp/"))
        .ok_or_else(|| anyhow::anyhow!("invalid mcp_server id {id:?}"))?;
    let (token, name) = rest
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("invalid mcp_server id {id:?}"))?;
    let (known_token, _rel) = MCP_CONFIG_TOKENS
        .iter()
        .find(|(t, _)| *t == token)
        .ok_or_else(|| anyhow::anyhow!("invalid mcp_server id {id:?}"))?;
    if name.is_empty() {
        bail!("invalid mcp_server id {id:?}");
    }
    Ok((*known_token, name.to_string()))
}

/// Re-read one foreign MCP server entry by token + name. Returns the parsed
/// config. `root` is the scanned folder.
pub fn read_mcp_entry(root: &Path, token: &str, name: &str) -> Result<McpServerConfig> {
    let rel = MCP_CONFIG_TOKENS
        .iter()
        .find(|(t, _)| *t == token)
        .map(|(_, r)| *r)
        .ok_or_else(|| anyhow::anyhow!("unknown mcp config token {token:?}"))?;
    let path = root.join(rel);
    if !path.is_file() {
        bail!("MCP config {} not found", path.to_string_lossy());
    }
    let servers = if is_toml_mcp(rel) {
        parse_mcp_toml(&path)?
    } else {
        parse_mcp_json(&path)?
    };
    servers
        .into_iter()
        .find(|(n, _)| *n == name)
        .map(|(_, cfg)| cfg)
        .with_context(|| {
            format!(
                "MCP server {name:?} not present in {}",
                path.to_string_lossy()
            )
        })
}

// ---------------------------------------------------------------------------
// Foreign format parsers
// ---------------------------------------------------------------------------

/// Parse a JSON MCP config (`mcp.json` / `.cursor/mcp.json` / `.claude.json`)
/// into `(name, config)` pairs, lowering each entry with the shared dialect
/// (`McpServerConfig` understands the Claude/Cursor shape incl. remote
/// `type`/`url`/`headers`). One unparseable entry costs that entry, never the
/// whole file.
pub fn parse_mcp_json(path: &Path) -> Result<Vec<(String, McpServerConfig)>> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.to_string_lossy()))?;
    let val: serde_json::Value = serde_json::from_str(&raw).context("parsing MCP config JSON")?;
    let mut out = Vec::new();
    for key in mcp_map_keys() {
        let Some(map) = val.get(key).and_then(|v| v.as_object()) else {
            continue;
        };
        for (name, entry) in map {
            match serde_json::from_value::<McpServerConfig>(entry.clone()) {
                Ok(cfg) => out.push((name.clone(), cfg)),
                Err(e) => tracing::debug!(
                    server = %name,
                    file = %path.to_string_lossy(),
                    "setup-import: skipping unparseable MCP entry ({e})"
                ),
            }
        }
        break;
    }
    Ok(out)
}

fn get_str(table: &toml::Table, key: &str) -> Option<String> {
    table.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn get_strs(table: &toml::Table, key: &str) -> Vec<String> {
    table
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn get_str_map(table: &toml::Table, key: &str) -> BTreeMap<String, String> {
    table
        .get(key)
        .and_then(|v| v.as_table())
        .map(|t| {
            t.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Parse a Codex-style `config.toml` MCP block (`[mcp_servers.<name>]`) into
/// `(name, config)` pairs.
pub fn parse_mcp_toml(path: &Path) -> Result<Vec<(String, McpServerConfig)>> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.to_string_lossy()))?;
    let val: toml::Value =
        toml::from_str(&raw).with_context(|| format!("parsing TOML {}", path.to_string_lossy()))?;
    let mut out = Vec::new();
    for key in ["mcp_servers", "mcpServers"] {
        let Some(table) = val.get(key).and_then(|v| v.as_table()) else {
            continue;
        };
        for (name, entry) in table {
            let Some(t) = entry.as_table() else {
                continue;
            };
            out.push((
                name.clone(),
                McpServerConfig {
                    command: get_str(t, "command"),
                    transport: get_str(t, "type"),
                    url: get_str(t, "url"),
                    headers: get_str_map(t, "headers"),
                    auth: None,
                    owner_plugin_id: None,
                    owner_server_name: None,
                    args: get_strs(t, "args"),
                    env: get_str_map(t, "env"),
                    description: get_str(t, "description"),
                    enabled: true,
                    version: None,
                    catalog_id: None,
                },
            ));
        }
        break;
    }
    Ok(out)
}

/// True when a file's first non-whitespace character marks it as the Claude
/// memory JSON body (`{`) or `---` front-matter shape — the cheap gate for
/// non-uuid memory filenames.
fn looks_like_json_memory(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let text = raw.trim_start();
    text.starts_with('{') || text.starts_with("---")
}

/// Parse one Claude Code memory file into `(content, when_to_use, importance)`.
/// Tolerant: a JSON body (`{"content": ..., "when_to_use": ..., "importance": N}`),
/// a `---` JSON front-matter block, or the raw file text. `None` when the file
/// cannot be read or is empty.
pub fn parse_claude_memory(path: &Path) -> Option<(String, Option<String>, i32)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    // JSON body (Claude's memory file format).
    if text.starts_with('{') {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(text) {
            if let Some(content) = val.get("content").and_then(|v| v.as_str()) {
                let content = content.trim();
                if content.is_empty() {
                    return None;
                }
                let when = val
                    .get("when_to_use")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let importance = val
                    .get("importance")
                    .and_then(|v| v.as_i64())
                    .map(|i| i.clamp(1, 5) as i32)
                    .unwrap_or(3);
                return Some((content.to_string(), when, importance));
            }
        }
    }
    // `---`-delimited JSON front-matter.
    if text.starts_with("---") {
        if let Some(end) = text[3..].find("\n---") {
            let block = &text[3..3 + end];
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(block.trim()) {
                let content = val
                    .get("content")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let when = val
                    .get("when_to_use")
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let importance = val
                    .get("importance")
                    .and_then(|v| v.as_i64())
                    .map(|i| i.clamp(1, 5) as i32)
                    .unwrap_or(3);
                if let Some(content) = content {
                    let body = text[3 + end + 4..].trim();
                    let full = if body.is_empty() {
                        content
                    } else {
                        format!("{content}\n\n{body}")
                    };
                    if !full.trim().is_empty() {
                        return Some((full.trim().to_string(), when, importance));
                    }
                }
            }
        }
    }
    // Fallback: raw text.
    Some((text.to_string(), None, 3))
}

// ---------------------------------------------------------------------------
// Codex subagents + slash commands (`~/.codex/agents/*.md`, `~/.codex/prompts/*.md`)
// ---------------------------------------------------------------------------

/// A Codex subagent definition parsed from `agents/<name>.md`. The front-matter
/// carries `name`, `description`, optional `tools` / `model`; the body is the
/// system prompt.
#[derive(Debug, Clone)]
pub struct CodexSubagent {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: String,
    pub tools: Vec<String>,
    pub model: Option<String>,
}

/// A Codex slash-command prompt parsed from `prompts/<name>.md`. The file stem
/// is the command name (without the leading slash); the body is the prompt
/// template that fills the composer when the command is picked.
#[derive(Debug, Clone)]
pub struct CodexPrompt {
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

/// Split `---`-delimited YAML front-matter from a markdown body. Mirrors the
/// skills crate's `split_front_matter`: a file without an opener is all body,
/// an opener without a closer is all front-matter.
fn split_front_matter(content: &str) -> (String, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (String::new(), content.to_owned());
    }
    let after_opener = match trimmed.find('\n') {
        Some(pos) => &trimmed[pos + 1..],
        None => return (String::new(), content.to_owned()),
    };
    match after_opener.find("\n---") {
        Some(pos) => {
            let fm = after_opener[..pos].to_owned();
            let body = after_opener[pos + "\n---".len()..]
                .trim_start_matches('\n')
                .to_owned();
            (fm, body)
        }
        None => (after_opener.to_owned(), String::new()),
    }
}

/// Parse a Codex subagent file. `None` unless it has `---` front-matter with a
/// non-empty `name` — the gate that keeps a project's random `agents/*.md`
/// notes out of the import list.
pub fn parse_codex_subagent(path: &Path) -> Option<CodexSubagent> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fm {
        name: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        tools: Option<Vec<String>>,
        #[serde(default)]
        model: Option<String>,
    }

    let content = fs::read_to_string(path).ok()?;
    let (front, body) = split_front_matter(&content);
    if front.trim().is_empty() {
        return None;
    }
    let fm: Fm = serde_yml::from_str(&front).ok()?;
    let name = fm.name?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(CodexSubagent {
        name,
        description: fm
            .description
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty()),
        system_prompt: body.trim().to_string(),
        tools: fm.tools.unwrap_or_default(),
        model: fm
            .model
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty()),
    })
}

/// Parse a Codex slash-command prompt file. The file stem is the command name;
/// a file with no body is skipped.
pub fn parse_codex_prompt(path: &Path) -> Option<CodexPrompt> {
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fm {
        #[serde(default)]
        description: Option<String>,
    }

    let name = path.file_stem()?.to_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let (front, body) = split_front_matter(&content);
    let body = body.trim().to_string();
    if body.is_empty() {
        return None;
    }
    let description = if front.trim().is_empty() {
        None
    } else {
        serde_yml::from_str::<Fm>(&front)
            .ok()
            .and_then(|f| f.description)
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
    };
    Some(CodexPrompt {
        name,
        description,
        body,
    })
}

/// True when a stem is a valid slash-command name (letters/digits/dash/underscore).
fn is_valid_command_name(stem: &str) -> bool {
    !stem.is_empty()
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"))
        .filter(|r| !r.is_empty())
        .or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| {
            path.to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/")
        })
}

fn file_size(path: &Path) -> Result<u64> {
    Ok(std::fs::metadata(path)?.len())
}

/// The install name a skill found at `dir` will get (mirrors
/// `from_source::skill_name_for` minus the tarball-root special case).
fn skill_install_name(dir: &Path) -> String {
    if let Some(fm_name) = front_matter_name(dir) {
        return sanitize_name(&fm_name);
    }
    let base = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    sanitize_name(&base)
}

fn front_matter_name(dir: &Path) -> Option<String> {
    let path = if dir.join("SKILL.md").is_file() {
        dir.join("SKILL.md")
    } else {
        std::fs::read_dir(dir).ok()?.flatten().find_map(|e| {
            let p = e.path();
            (p.is_file()
                && e.file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("SKILL.md"))
            .then_some(p)
        })?
    };
    let content = std::fs::read_to_string(path).ok()?;
    let record = ryu_skills::parse_skill_md("_probe", &content).ok()?;
    Some(record.name)
}

fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed
    }
}

/// True when `dir` directly contains a SKILL.md (case-insensitive).
fn has_skill_md(dir: &Path) -> bool {
    if dir.join("SKILL.md").is_file() {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path().is_file()
            && e.file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("SKILL.md")
    })
}

/// First manifest file name present directly under `dir`, if any.
fn find_manifest(dir: &Path) -> Option<&'static str> {
    crate::plugin_manifest::MANIFEST_FILE_NAMES
        .iter()
        .find(|name| dir.join(name).is_file())
        .copied()
}

/// Absolute path of the first manifest file directly inside a plugin dir, if
/// any. Used by the import handler to parse + hydrate the manifest from disk.
pub(crate) fn find_manifest_path(dir: &Path) -> Option<PathBuf> {
    crate::plugin_manifest::MANIFEST_FILE_NAMES
        .iter()
        .map(|name| dir.join(name))
        .find(|p| p.is_file())
}

/// The plugin `id` a manifest file declares, parsed minimally (the full gate
/// runs at import time).
fn plugin_id_from_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    val.get("id").and_then(|v| v.as_str()).map(str::to_string)
}

/// Cheap hint: does a plugin with `id` already look installed? A directory
/// exists under the plugins root (the loader's scan picks it up). Built-in id
/// collisions are not checked here — the import step reports the real conflict.
fn plugin_dir_exists(id: &str) -> bool {
    crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(id))
        .is_dir()
}

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
const PROJECT_INSTRUCTION_CANDIDATES: &[&str] = &[
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
fn truncate_prompt_instructions(content: &str, file_len: u64) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_tree() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ryu-import-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn scan_finds_instructions_skills_mcp_and_plugin() {
        let root = temp_tree();
        write(&root, "AGENTS.md", "# Repo rules\n");
        write(&root, "skills/foo/SKILL.md", "---\nname: foo\n---\n# Foo\n");
        write(
            &root,
            "mcp.json",
            r#"{"mcpServers":{"git":{"command":"mcp-git","args":["x"]}}}"#,
        );
        write(
            &root,
            "plugins/hello/manifest.json",
            r#"{"id":"@acme/hello","name":"Hello","version":"1.0.0","runnables":[]}"#,
        );

        let res = scan_source(&root).unwrap();
        let kinds: Vec<&str> = res.items.iter().map(|i| i.kind).collect();
        assert!(kinds.contains(&kind::INSTRUCTIONS), "kinds: {kinds:?}");
        assert!(kinds.contains(&kind::SKILL), "kinds: {kinds:?}");
        assert!(kinds.contains(&kind::MCP_SERVER), "kinds: {kinds:?}");
        assert!(kinds.contains(&kind::PLUGIN), "kinds: {kinds:?}");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_reads_codex_toml_mcp_servers() {
        let root = temp_tree();
        write(
            &root,
            "config.toml",
            r#"[model]
name = "gpt-5"
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem"]
[mcp_servers.git]
command = "mcp-git"
"#,
        );
        let res = scan_source(&root).unwrap();
        let mcp: Vec<&ScanItem> = res
            .items
            .iter()
            .filter(|i| i.kind == kind::MCP_SERVER)
            .collect();
        assert_eq!(mcp.len(), 2, "items: {res:#?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_skips_vcs_and_node_modules() {
        let root = temp_tree();
        write(&root, ".git/HEAD", "ref");
        write(&root, "node_modules/pkg/index.js", "x");
        write(
            &root,
            "skills/real/SKILL.md",
            "---\nname: real\n---\n# Real\n",
        );
        let res = scan_source(&root).unwrap();
        let skills: Vec<&ScanItem> = res.items.iter().filter(|i| i.kind == kind::SKILL).collect();
        assert_eq!(skills.len(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_finds_memory_files_only_when_they_look_like_claude_memories() {
        let root = temp_tree();
        write(
            &root,
            "projects/abc-123/memory/11111111-1111-1111-1111-111111111111.md",
            r#"{"content":"The build uses bun.","importance":3}"#,
        );
        write(&root, "memory/notes.md", "just some notes\n");
        let res = scan_source(&root).unwrap();
        let mem: Vec<&ScanItem> = res
            .items
            .iter()
            .filter(|i| i.kind == kind::MEMORY)
            .collect();
        assert_eq!(mem.len(), 1, "notes.md must be ignored: {res:#?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_item_path_guards_traversal() {
        let root = temp_tree();
        write(&root, "skills/ok/SKILL.md", "---\nname: ok\n---\n# Ok\n");
        assert!(resolve_item_path(&root, &format!("{}/ok", kind::SKILL)).is_err());
        assert!(resolve_item_path(&root, "../escape").is_err());
        assert!(resolve_item_path(&root, "/etc/passwd").is_err());
        let p = resolve_item_path(&root, &format!("{}/skills/ok", kind::SKILL)).unwrap();
        assert!(p.ends_with("skills/ok"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mcp_ids_round_trip() {
        let id = "mcp_server/mcp/cursor-json/foo";
        let (token, name) = resolve_mcp_id(id).unwrap();
        assert_eq!(token, "cursor-json");
        assert_eq!(name, "foo");
        assert!(resolve_mcp_id("mcp_server/whatever/foo").is_err());
    }

    #[test]
    fn parse_claude_memory_handles_three_shapes() {
        let dir = temp_tree();
        let json = dir.join("a.md");
        fs::write(
            &json,
            r#"{"content":"c1","when_to_use":"when x","importance":5}"#,
        )
        .unwrap();
        let (c, w, i) = parse_claude_memory(&json).unwrap();
        assert_eq!(c, "c1");
        assert_eq!(w.as_deref(), Some("when x"));
        assert_eq!(i, 5);

        let fm = dir.join("b.md");
        fs::write(&fm, "---\n{\"content\": \"c2\"}\n---\nbody text").unwrap();
        let (c, _, _) = parse_claude_memory(&fm).unwrap();
        assert!(c.starts_with("c2") && c.contains("body text"), "c: {c}");

        let raw = dir.join("c.md");
        fs::write(&raw, "plain text memory").unwrap();
        let (c, w, i) = parse_claude_memory(&raw).unwrap();
        assert_eq!(c, "plain text memory");
        assert_eq!(w, None);
        assert_eq!(i, 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_or_unreadable_folder_degrades_to_empty_scan() {
        let root = std::env::temp_dir().join(format!("ryu-import-empty-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let res = scan_source(&root).unwrap();
        assert!(res.items.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_finds_codex_subagents_and_slash_commands() {
        let root = temp_tree();
        write(
            &root,
            ".codex/agents/commit-message.md",
            "---\nname: commit-message\ndescription: Writes good commit messages\nmodel: gpt-5\n---\nWrite a concise commit message.\n",
        );
        write(
            &root,
            "agents/project-note.md",
            "---\nname: project-note\n---\nDo not import me.\n",
        );
        write(
            &root,
            ".codex/prompts/review.md",
            "---\ndescription: Review a diff\n---\nReview the attached diff for bugs.\n",
        );
        write(
            &root,
            "prompts/project.md",
            "---\ndescription: project\n---\nDo not import me.\n",
        );
        write(
            &root,
            ".codex/prompts/empty.md",
            "---\ndescription: empty\n---\n",
        );

        let res = scan_source(&root).unwrap();
        let agents: Vec<&ScanItem> = res.items.iter().filter(|i| i.kind == kind::AGENT).collect();
        let cmds: Vec<&ScanItem> = res
            .items
            .iter()
            .filter(|i| i.kind == kind::SLASH_COMMAND)
            .collect();
        assert_eq!(
            agents.len(),
            1,
            "project-local agents/ must not list as a subagent: {res:#?}"
        );
        assert_eq!(
            cmds.len(),
            1,
            "empty/project prompts must not list: {res:#?}"
        );
        assert!(agents[0].id.contains(".codex/agents/"));
        assert!(cmds[0].id.contains(".codex/prompts/"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_codex_subagent_extracts_fields() {
        let dir = temp_tree();
        let path = dir.join("x.md");
        fs::write(
            &path,
            "---\nname: reviewer\ndescription: Reviews code\nmodel: gpt-5\ntools:\n  - read\n  - bash\n---\nReview the diff.\n",
        )
        .unwrap();
        let sub = parse_codex_subagent(&path).unwrap();
        assert_eq!(sub.name, "reviewer");
        assert_eq!(sub.description.as_deref(), Some("Reviews code"));
        assert_eq!(sub.model.as_deref(), Some("gpt-5"));
        assert_eq!(sub.tools, vec!["read".to_string(), "bash".to_string()]);
        assert_eq!(sub.system_prompt, "Review the diff.");
        // No front-matter / no name → not a subagent.
        let plain = dir.join("plain.md");
        fs::write(&plain, "just text").unwrap();
        assert!(parse_codex_subagent(&plain).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_codex_prompt_uses_stem_as_name() {
        let dir = temp_tree();
        let path = dir.join("review.md");
        fs::write(
            &path,
            "---\ndescription: review it\n---\nReview this diff.\n",
        )
        .unwrap();
        let p = parse_codex_prompt(&path).unwrap();
        assert_eq!(p.name, "review");
        assert_eq!(p.description.as_deref(), Some("review it"));
        assert_eq!(p.body, "Review this diff.");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_instructions_reads_agents_md_preferring_agents_over_claude() {
        let dir = temp_tree();
        write(&dir, "CLAUDE.md", "# Claude rules\n");
        write(&dir, "AGENTS.md", "# Agent rules\n");
        let (file, content) = project_instructions(&dir.to_string_lossy()).unwrap();
        assert_eq!(file, "AGENTS.md", "AGENTS.md must win over CLAUDE.md");
        assert_eq!(content, "# Agent rules\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_instructions_returns_none_without_a_candidate_file() {
        let dir = temp_tree();
        write(&dir, "README.md", "# Not instructions\n");
        assert!(project_instructions(&dir.to_string_lossy()).is_none());
        assert!(project_instructions("/definitely/not/a/real/dir").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn project_instructions_truncates_over_the_prompt_cap() {
        let dir = temp_tree();
        let big = "x".repeat(MAX_PROJECT_INSTRUCTIONS_PROMPT_BYTES as usize + 1000);
        write(&dir, "AGENTS.md", &big);
        let (_, content) = project_instructions(&dir.to_string_lossy()).unwrap();
        assert!(
            content.len() as u64 <= MAX_PROJECT_INSTRUCTIONS_PROMPT_BYTES + 200,
            "content too long: {}",
            content.len()
        );
        assert!(content.contains("truncated"), "missing truncation note");
        let _ = fs::remove_dir_all(&dir);
    }
}
