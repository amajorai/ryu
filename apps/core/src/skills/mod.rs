//! **Agent Skill runtime** (M3, issue #145).
//!
//! This module owns the Core side of the Skills standard:
//! - SKILL.md parsing (YAML front-matter + Markdown body).
//! - [`SkillRecord`] — the real, executable Skill Runnable (replaces `SkillStub`).
//! - [`SkillRegistry`] — loads skills from the universal Agent Skills directory
//!   `~/.claude/skills/<id>/SKILL.md` (overridable via `RYU_SKILLS_DIR`), the same
//!   location Claude Code and the skills CLI read, plus the legacy flat
//!   `<id>.md` layout for back-compat.
//!
//! Core-vs-Gateway rule: Core decides *what skills run* (selection, loading,
//! instruction injection into the outgoing request body). The Gateway decides
//! *what is allowed / measured / paid* (budget, audit, firewall).  The Gateway
//! already calls `SkillsRegistry::inject` — that governs egress.  Core injects
//! skill instructions into the assembled request body *before* it is forwarded
//! to the Gateway, so the turn demonstrably changes (AC2) and the Gateway counts
//! the skill-tagged call toward budget/audit (AC3).

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock, RwLock,
    },
};

use serde::{Deserialize, Serialize};

use crate::runnable::{Runnable, RunnableKind};

// ── Disclosure mode (progressive vs full) ───────────────────────────────────────
//
// Progressive disclosure injects only each skill's name+description (L1) up front
// and lets the model load a full body (L2) on demand via the `skills__load` tool —
// the Agent Skills standard. It is only safe where the turn has a tool loop (the
// ACP plane); the no-tool openai-compat fast path keeps full injection regardless,
// so a weak model is never starved (see `adapters::route_chat_stream`).

/// Preference key (and desktop toggle) selecting the global disclosure mode.
/// Values: `"progressive"` (default) | `"full"`.
pub const SKILLS_DISCLOSURE_PREF: &str = "skills-disclosure";

/// Dev seed env var: `RYU_SKILLS_DISCLOSURE=full` forces full injection at boot
/// before any pref is read. The persisted pref (set per request from the chat
/// handler) is the real source of truth, exactly like `headroom::is_enabled`.
const ENV_SKILLS_DISCLOSURE: &str = "RYU_SKILLS_DISCLOSURE";

/// Max L1 index entries injected before the model is told to use `skills__search`
/// instead of relying on the inline list.
pub const SKILL_INDEX_CAP: usize = 20;

static PROGRESSIVE_DISCLOSURE: OnceLock<AtomicBool> = OnceLock::new();

fn disclosure_seed() -> bool {
    // Default ON (progressive); only an explicit `full` disables it.
    match std::env::var(ENV_SKILLS_DISCLOSURE) {
        Ok(v) => !v.trim().eq_ignore_ascii_case("full"),
        Err(_) => true,
    }
}

fn disclosure_flag() -> &'static AtomicBool {
    PROGRESSIVE_DISCLOSURE.get_or_init(|| AtomicBool::new(disclosure_seed()))
}

/// Whether progressive disclosure is currently active (the global mode).
pub fn is_progressive_disclosure() -> bool {
    disclosure_flag().load(Ordering::Relaxed)
}

/// Set the global disclosure mode. Called from the chat handler (resolved from the
/// `skills-disclosure` pref) and at startup; the pref is the source of truth.
pub fn set_progressive_disclosure(progressive: bool) {
    disclosure_flag().store(progressive, Ordering::Relaxed);
}

/// Parse a `skills-disclosure` pref value into the progressive flag (default true).
pub fn disclosure_value_is_progressive(value: &str) -> bool {
    !value.trim().eq_ignore_ascii_case("full")
}

// ── SKILL.md format ────────────────────────────────────────────────────────────
//
// A SKILL.md file starts with a YAML front-matter block delimited by `---` lines,
// followed by Markdown that forms the instruction body. Unknown front-matter keys
// are silently ignored so skills from newer versions remain parseable.
//
// Minimal example:
//
// ```markdown
// ---
// name: "My Skill"
// description: "Adds a polite greeting to every reply."
// ---
// Always begin every response with "Hello!".
// ```
//
// Extended example with tool allowlist:
//
// ```markdown
// ---
// name: "Web Researcher"
// description: "Enables web search for this turn."
// allowed-tools:
//   - "agentbrowser"
//   - "spider"
// ---
// You have access to web-search tools. Search the web when you need factual information.
// ```

/// Parsed front-matter from a SKILL.md file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SkillFrontMatter {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Optional list of tool names the skill declares it needs.
    #[serde(default, rename = "allowed-tools")]
    pub allowed_tools: Vec<String>,
    /// When false the skill is installed but inactive. Defaults to true.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// When true the skill's full body is always injected up front, bypassing
    /// progressive disclosure. The escape hatch for a critical skill or a weak
    /// model that cannot reliably self-load. Defaults to false.
    #[serde(default, rename = "always-on")]
    pub always_on: bool,
}

fn default_true() -> bool {
    true
}

// ── SkillRecord ────────────────────────────────────────────────────────────────

/// A parsed, executable Agent Skill loaded from a SKILL.md file.
///
/// This is the real [`Runnable`] implementation for `RunnableKind::Skill`.
/// Instruction injection happens in Core; Gateway attribution happens via the
/// `x-ryu-skill-ids` header Core attaches to outgoing requests (AC3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRecord {
    /// Stable id derived from the skill filename stem (e.g. `"web-researcher"`
    /// for `web-researcher.md`).
    pub id: String,
    /// Human-readable display name from the front-matter `name` field.
    pub name: String,
    /// Short description from the front-matter `description` field.
    pub description: Option<String>,
    /// Instruction body — the Markdown below the front-matter delimiter.
    /// This is injected into the system prompt for every turn where the skill
    /// is active.
    pub instructions: String,
    /// Tools the skill declares it needs. Core surfaces them to the MCP bridge
    /// for the turn; the Gateway enforces the grant (not Core).
    pub allowed_tools: Vec<String>,
    /// When `false` the skill is loaded but skipped during selection.
    pub enabled: bool,
    /// When `true` the full body is injected up front even under progressive
    /// disclosure (see [`SkillRegistry::progressive_block`]). Default `false`.
    #[serde(default)]
    pub always_on: bool,
}

impl Runnable for SkillRecord {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn kind(&self) -> RunnableKind {
        RunnableKind::Skill
    }
}

// ── Parsing ────────────────────────────────────────────────────────────────────

/// Parse a SKILL.md string into a [`SkillRecord`].
///
/// Returns `Err` only when the required `name` field is missing. All other
/// errors (missing front-matter, unknown fields) are handled gracefully so
/// skills from newer spec versions still load in older Cores.
pub fn parse_skill_md(id: &str, content: &str) -> Result<SkillRecord, String> {
    // Split on the opening `---` delimiter.
    let (front_raw, body) = split_front_matter(content)?;

    let fm: SkillFrontMatter = serde_yml::from_str(&front_raw)
        .map_err(|e| format!("YAML parse error in skill '{id}': {e}"))?;

    if fm.name.is_empty() {
        return Err(format!(
            "skill '{id}': front-matter missing required 'name' field"
        ));
    }

    Ok(SkillRecord {
        id: id.to_owned(),
        name: fm.name,
        description: fm.description,
        instructions: body.trim().to_owned(),
        allowed_tools: fm.allowed_tools,
        enabled: fm.enabled,
        always_on: fm.always_on,
    })
}

/// Split a SKILL.md into `(front_matter_yaml, instruction_body)`.
///
/// Accepts both `---\n...content...\n---\nbody` and bare-body (no front-matter)
/// files. When there is no front-matter the whole content is treated as the
/// instruction body and an empty front-matter string is returned.
fn split_front_matter(content: &str) -> Result<(String, String), String> {
    let trimmed = content.trim_start();

    if !trimmed.starts_with("---") {
        // No front-matter: treat the whole content as instructions.
        return Ok((String::new(), content.to_owned()));
    }

    // Skip the opening `---` line.
    let after_opener = match trimmed.find('\n') {
        Some(pos) => &trimmed[pos + 1..],
        None => return Err("skill file starts with '---' but has no content".to_owned()),
    };

    // Find the closing `---` delimiter.
    let close_marker = "\n---";
    match after_opener.find(close_marker) {
        Some(pos) => {
            let fm = after_opener[..pos].to_owned();
            let body_start = pos + close_marker.len();
            let body = after_opener[body_start..]
                .trim_start_matches('\n')
                .to_owned();
            Ok((fm, body))
        }
        None => {
            // No closing `---`: treat everything after the opener as front-matter
            // with an empty body.
            Ok((after_opener.to_owned(), String::new()))
        }
    }
}

// ── Disk layout ──────────────────────────────────────────────────────────────

/// The universal Agent Skills directory: `~/.claude/skills`. This is the
/// convention Claude Code and the skills CLI use (one directory per skill, each
/// containing a `SKILL.md` plus any bundled resources), so standardizing on it
/// means a skill installed anywhere is usable everywhere.
fn default_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("skills")
}

/// The legacy flat skills directory Ryu used before standardizing: `~/.ryu/skills`.
fn legacy_skills_dir() -> PathBuf {
    crate::paths::ryu_dir().join("skills")
}

/// A skill discovered on disk: its stable id and the path to its `SKILL.md`.
pub struct InstalledSkillPath {
    /// Stable id — the directory name (standard layout) or filename stem (legacy).
    pub id: String,
    /// Absolute path to the skill's `SKILL.md` (standard) or `<id>.md` (legacy).
    pub skill_md: PathBuf,
}

/// Scan `dir` for installed skills, supporting both layouts in one pass:
/// - **standard** `~/.claude/skills/<id>/SKILL.md` (id = directory name), and
/// - **legacy flat** `<id>.md` (id = filename stem).
///
/// On an id collision the standard directory form wins (it can carry resources).
/// This is the single source of truth for "what skills are on disk" — the
/// registry loader and the catalog's installed-view both call it.
pub fn scan_skill_dir(dir: &Path) -> Vec<InstalledSkillPath> {
    let mut found: Vec<InstalledSkillPath> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut flat: Vec<InstalledSkillPath> = Vec::new();

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!("skills directory {} does not exist", dir.display());
            return found;
        }
        Err(e) => {
            tracing::warn!("could not scan skills directory {}: {e}", dir.display());
            return found;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if is_dir {
            // Standard layout: `<id>/SKILL.md` (case-insensitive filename).
            let id = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let Some(skill_md) = find_skill_md(&path) else {
                continue;
            };
            if seen.insert(id.clone()) {
                found.push(InstalledSkillPath { id, skill_md });
            } else {
                tracing::warn!(
                    "duplicate skill id '{}' at {}; skipping",
                    id,
                    path.display()
                );
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            // Legacy flat layout: `<id>.md`. Defer so directory forms win.
            let id = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if !id.is_empty() {
                flat.push(InstalledSkillPath { id, skill_md: path });
            }
        }
    }

    for f in flat {
        if seen.insert(f.id.clone()) {
            found.push(f);
        }
    }
    found
}

/// Find the `SKILL.md` inside a skill directory (filename is matched
/// case-insensitively, as the standard allows `SKILL.md`).
fn find_skill_md(skill_dir: &Path) -> Option<PathBuf> {
    let direct = skill_dir.join("SKILL.md");
    if direct.is_file() {
        return Some(direct);
    }
    let entries = std::fs::read_dir(skill_dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file()
            && p.file_name()
                .map(|n| n.to_string_lossy().eq_ignore_ascii_case("SKILL.md"))
                == Some(true)
        {
            return Some(p);
        }
    }
    None
}

// ── Activation (installed ≠ active) ──────────────────────────────────────────
//
// Standardizing on the shared `~/.claude/skills` directory means the registry now
// sees every skill any tool installed there — dozens of them. The openai_compat
// default route injects *all enabled* skill bodies into one system block with no
// cap, so "on disk = injected" would flood (and can overflow) a small local
// model's context. The activation set decouples *installed/visible* from
// *active/injected*: a skill injects only when activated. Seeding keeps prior
// behavior — skills installed through Ryu (provenance) and migrated legacy ones
// are active; bulk-discovered ecosystem skills are visible but inactive until the
// user turns them on. (Claude Code et al. read the dir natively and are
// unaffected by this gate.)

/// Path to Ryu's activation set. Kept in Ryu's own directory, never in the shared
/// skills dir, so Ryu-local state never mutates files other tools own. Overridable
/// via `RYU_SKILLS_ACTIVE_FILE`.
fn active_set_path() -> PathBuf {
    if let Some(p) = std::env::var_os("RYU_SKILLS_ACTIVE_FILE") {
        return PathBuf::from(p);
    }
    crate::paths::ryu_dir().join("skills-active.json")
}

/// Load the set of active skill ids (those injected on the default route).
pub fn load_active_set() -> HashSet<String> {
    std::fs::read_to_string(active_set_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

fn save_active_set(set: &HashSet<String>) {
    let path = active_set_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut list: Vec<&String> = set.iter().collect();
    list.sort();
    if let Ok(json) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(path, json);
    }
}

/// Mark a skill active (inject on the default route) or inactive. Idempotent.
pub fn set_active(id: &str, active: bool) {
    let mut set = load_active_set();
    let changed = if active {
        set.insert(id.to_owned())
    } else {
        set.remove(id)
    };
    if changed {
        save_active_set(&set);
    }
}

/// On first run after standardizing on the shared dir, seed the activation set
/// from catalog provenance (skills installed *through Ryu*) plus anything still in
/// the legacy flat dir — so previously-installed skills stay active without
/// auto-activating the dozens of skills other tools may have placed in the shared
/// dir. A no-op once the set file exists.
fn ensure_active_set_seeded() {
    if active_set_path().exists() {
        return;
    }
    let provenance = crate::paths::ryu_dir().join("skills-catalog-installed.json");
    let mut set: HashSet<String> = std::fs::read_to_string(&provenance)
        .ok()
        .and_then(|s| serde_json::from_str::<std::collections::HashMap<String, String>>(&s).ok())
        .map(|m| m.into_keys().collect())
        .unwrap_or_default();
    for found in scan_skill_dir(&legacy_skills_dir()) {
        set.insert(found.id);
    }
    save_active_set(&set);
}

/// One-time, best-effort migration of legacy flat skills from `~/.ryu/skills/*.md`
/// into the universal `~/.claude/skills/<id>/SKILL.md` layout, so every skill lives
/// in the one standard location agents already read.
///
/// Additive and idempotent: it never overwrites an existing skill and never
/// deletes the source (the legacy file stays as a backup). Skipped entirely when
/// `RYU_SKILLS_DIR` is set, since that is an explicit override the user owns.
fn migrate_legacy_skills() {
    if std::env::var_os("RYU_SKILLS_DIR").is_some() {
        return;
    }
    let legacy = legacy_skills_dir();
    let dest_root = default_skills_dir();
    let Ok(entries) = std::fs::read_dir(&legacy) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if stem.is_empty() {
            continue;
        }
        // Legacy sibling docs were stored flat as `<id>__<name>.md`; map them back
        // into the skill's own directory as `<name>.md`. The base skill becomes
        // `<id>/SKILL.md`.
        let (skill_id, dest_name) = match stem.split_once("__") {
            Some((base, rest)) => (base.to_string(), format!("{rest}.md")),
            None => (stem.clone(), "SKILL.md".to_string()),
        };
        let dest_dir = dest_root.join(&skill_id);
        let dest = dest_dir.join(&dest_name);
        if dest.exists() {
            continue;
        }
        if std::fs::create_dir_all(&dest_dir).is_err() {
            continue;
        }
        match std::fs::copy(&path, &dest) {
            Ok(_) => {
                tracing::info!(
                    "migrated legacy skill {} -> {}",
                    path.display(),
                    dest.display()
                );
                // A migrated skill was a Ryu skill — keep it active by default.
                if dest_name == "SKILL.md" {
                    set_active(&skill_id, true);
                }
            }
            Err(e) => {
                tracing::warn!("migrating legacy skill {} failed: {e}", path.display());
            }
        }
    }
}

// ── SkillRegistry ──────────────────────────────────────────────────────────────

/// Registry of installed agent skills.
///
/// Skills are loaded from `~/.ryu/skills/*.md` (env-overridable via
/// `RYU_SKILLS_DIR`). The registry is write-locked during hot-reload so reads
/// during a chat turn are always consistent.
///
/// Core-vs-Gateway: the registry decides *which skills apply* (Core). Whether the
/// instructions are *allowed* to be injected is a Gateway policy concern (future).
#[derive(Clone)]
pub struct SkillRegistry {
    inner: Arc<RwLock<Vec<SkillRecord>>>,
}

impl SkillRegistry {
    /// Create an empty registry (no skills loaded yet).
    pub fn empty() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Test helper: replace the in-memory skill set directly (no disk I/O).
    #[cfg(test)]
    pub fn replace_for_test(&self, skills: Vec<SkillRecord>) {
        *self.inner.write().expect("SkillRegistry lock poisoned") = skills;
    }

    /// Load skills from disk and return a populated registry.
    ///
    /// Mirrors [`crate::plugin_manifest::PluginManifestLoader`]'s pattern: built-in
    /// fixtures first (none today), then user skills from `RYU_SKILLS_DIR` or the
    /// universal `~/.claude/skills/` directory. A one-time, best-effort migration
    /// lifts any legacy `~/.ryu/skills/*.md` files into the standard layout first
    /// so every skill ends up in one place.
    pub fn load() -> Self {
        ensure_active_set_seeded();
        migrate_legacy_skills();
        let registry = Self::empty();
        registry.reload();
        registry
    }

    /// Resolve the skills directory: `RYU_SKILLS_DIR` if set, else the universal
    /// Agent Skills directory `~/.claude/skills`.
    ///
    /// This is the location Claude Code, the skills CLI, and other agents already
    /// read, so a skill installed by Ryu is usable everywhere — and a skill
    /// installed by any of those tools shows up as installed in Ryu.
    pub fn skills_dir() -> PathBuf {
        if let Some(p) = std::env::var_os("RYU_SKILLS_DIR") {
            return PathBuf::from(p);
        }
        default_skills_dir()
    }

    /// (Re)load skills from disk, replacing the current registry contents.
    pub fn reload(&self) {
        let dir = Self::skills_dir();
        let mut skills: Vec<SkillRecord> = Vec::new();

        let active = load_active_set();
        for found in scan_skill_dir(&dir) {
            match std::fs::read_to_string(&found.skill_md) {
                Ok(content) => match parse_skill_md(&found.id, &content) {
                    Ok(mut record) => {
                        // Installed ≠ active: a skill injects on the default route
                        // only when activated, so the shared dir's many skills
                        // don't all flood (or overflow) the prompt.
                        record.enabled = record.enabled && active.contains(&found.id);
                        tracing::debug!(id = %found.id, name = %record.name, active = record.enabled, "skill loaded");
                        skills.push(record);
                    }
                    Err(e) => {
                        tracing::warn!("skill at {} rejected: {e}", found.skill_md.display());
                    }
                },
                Err(e) => {
                    tracing::warn!("could not read skill at {}: {e}", found.skill_md.display());
                }
            }
        }

        tracing::info!(count = skills.len(), "skill registry loaded");
        *self.inner.write().expect("SkillRegistry lock poisoned") = skills;
    }

    /// Return all installed skills (enabled and disabled), e.g. for listing.
    pub fn list_all(&self) -> Vec<SkillRecord> {
        self.inner
            .read()
            .expect("SkillRegistry lock poisoned")
            .clone()
    }

    /// Return only the enabled skills.
    pub fn enabled(&self) -> Vec<SkillRecord> {
        self.inner
            .read()
            .expect("SkillRegistry lock poisoned")
            .iter()
            .filter(|s| s.enabled)
            .cloned()
            .collect()
    }

    /// Return `true` when at least one skill is enabled.
    pub fn has_enabled(&self) -> bool {
        self.inner
            .read()
            .expect("SkillRegistry lock poisoned")
            .iter()
            .any(|s| s.enabled)
    }

    /// Return the enabled skills permitted by a per-agent allowlist.
    ///
    /// An **empty** allowlist means "all enabled skills" (back-compat default).
    /// A non-empty allowlist narrows to the *intersection* of the allowlist and
    /// the globally-enabled set — it never re-activates a globally-inactive skill.
    pub fn enabled_for(&self, allowlist: &[String]) -> Vec<SkillRecord> {
        let enabled = self.enabled();
        if allowlist.is_empty() {
            return enabled;
        }
        let allow: std::collections::HashSet<&str> = allowlist.iter().map(String::as_str).collect();
        enabled
            .into_iter()
            .filter(|s| allow.contains(s.id.as_str()))
            .collect()
    }

    /// Build the combined skill-instruction block for an allowlist.
    ///
    /// Returns `(header_text, injected_ids)`, or `None` when nothing applies.
    /// Used by both the openai-compat injector and the ACP-prompt seam so the two
    /// planes share one source of truth for what a given agent's skill text is.
    pub fn skill_block(&self, allowlist: &[String]) -> Option<(String, Vec<String>)> {
        let active = self.enabled_for(allowlist);
        if active.is_empty() {
            return None;
        }
        let ids: Vec<String> = active.iter().map(|s| s.id.clone()).collect();
        let header = active
            .iter()
            .map(|s| format!("## Skill: {}\n{}", s.name, s.instructions))
            .collect::<Vec<_>>()
            .join("\n\n");
        Some((header, ids))
    }

    /// Build the **progressive-disclosure** block for an allowlist (L1 + escape
    /// hatch). `always_on` skills get their full body injected up front; every
    /// other enabled+allowed skill contributes one compact L1 index line
    /// (`- <id> — <name>: <description>`) and is loaded on demand via the
    /// `skills__load` tool. Returns `(text, injected_ids)` where `injected_ids`
    /// are the `always_on` skills whose full bodies are actually in context (for
    /// `x-ryu-skill-ids` attribution); the indexed-only skills are not attributed
    /// until loaded.
    ///
    /// Only meaningful where the turn has a tool loop (ACP plane); callers on a
    /// no-tool path must use [`Self::skill_block`] instead so skills aren't
    /// silently unreachable.
    pub fn progressive_block(&self, allowlist: &[String]) -> Option<(String, Vec<String>)> {
        let active = self.enabled_for(allowlist);
        if active.is_empty() {
            return None;
        }

        let (always_on, on_demand): (Vec<&SkillRecord>, Vec<&SkillRecord>) =
            active.iter().partition(|s| s.always_on);

        let mut sections: Vec<String> = Vec::new();

        // Full bodies for always-on skills (the escape hatch).
        for s in &always_on {
            sections.push(format!("## Skill: {}\n{}", s.name, s.instructions));
        }

        // Compact L1 index for the rest.
        if !on_demand.is_empty() {
            let mut lines = vec![
                "## Available skills (load on demand)".to_owned(),
                "These skills are available but not yet loaded. When one is relevant, \
                 call the `skills__load` tool with its id to read its full instructions \
                 before acting, then follow them."
                    .to_owned(),
            ];
            for s in on_demand.iter().take(SKILL_INDEX_CAP) {
                let desc = s.description.as_deref().unwrap_or("(no description)");
                lines.push(format!("- {} — {}: {}", s.id, s.name, desc));
            }
            if on_demand.len() > SKILL_INDEX_CAP {
                lines.push(format!(
                    "...and {} more. Use the `skills__search` tool to find skills by task.",
                    on_demand.len() - SKILL_INDEX_CAP
                ));
            }
            sections.push(lines.join("\n"));
        }

        let injected_ids: Vec<String> = always_on.iter().map(|s| s.id.clone()).collect();
        Some((sections.join("\n\n"), injected_ids))
    }

    /// Inject enabled skill instructions into an OpenAI-compat messages array.
    ///
    /// All enabled skills are combined into a single `system` message block and
    /// prepended before the first user message. When a `system` message already
    /// exists its content is prepended with the skill block, separated by `---`.
    ///
    /// Returns the ids of the skills that were injected, so callers can attach
    /// them as an `x-ryu-skill-ids` header for Gateway attribution (AC3).
    pub fn inject_into_messages(&self, messages: &mut Vec<serde_json::Value>) -> Vec<String> {
        self.inject_into_messages_filtered(messages, &[])
    }

    /// Like [`Self::inject_into_messages`] but restricted to a per-agent skill
    /// allowlist (see [`Self::enabled_for`] for the empty-means-all semantics).
    pub fn inject_into_messages_filtered(
        &self,
        messages: &mut Vec<serde_json::Value>,
        allowlist: &[String],
    ) -> Vec<String> {
        let Some((header, ids)) = self.skill_block(allowlist) else {
            return Vec::new();
        };

        tracing::debug!(count = ids.len(), ids = ?ids, "injecting skills into messages");

        // Find an existing system message to prepend to.
        if let Some(sys) = messages.iter_mut().find(|m| m["role"] == "system") {
            let existing = sys["content"].as_str().unwrap_or("").to_owned();
            let merged = if existing.is_empty() {
                header
            } else {
                format!("{header}\n\n---\n\n{existing}")
            };
            sys["content"] = serde_json::Value::String(merged);
        } else {
            // No system message — insert one at index 0.
            messages.insert(
                0,
                serde_json::json!({
                    "role": "system",
                    "content": header,
                }),
            );
        }

        ids
    }
}

// ── Public summary type ────────────────────────────────────────────────────────

/// HTTP response body for `GET /api/skills`.
#[derive(Debug, Clone, Serialize)]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub allowed_tools: Vec<String>,
    /// When true the full body is always injected up front (bypasses progressive
    /// disclosure). Surfaced so the desktop can render the per-skill toggle.
    pub always_on: bool,
    /// [`crate::runnable::RunnableKind`] discriminant, always `"skill"`.
    pub kind: &'static str,
}

impl From<&SkillRecord> for SkillSummary {
    fn from(r: &SkillRecord) -> Self {
        Self {
            id: r.id.clone(),
            name: r.name.clone(),
            description: r.description.clone(),
            enabled: r.enabled,
            allowed_tools: r.allowed_tools.clone(),
            always_on: r.always_on,
            kind: "skill",
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const SAMPLE_SKILL_MD: &str = r#"---
name: "Polite Greeter"
description: "Prefixes every reply with a greeting."
allowed-tools:
  - "agentbrowser"
---
Always begin every response with "Hello!".
"#;

    const MINIMAL_SKILL_MD: &str = r#"---
name: "Minimal Skill"
---
Do something minimal.
"#;

    // ── Parser ─────────────────────────────────────────────────────────────────

    #[test]
    fn parses_full_skill_md() {
        let record = parse_skill_md("polite-greeter", SAMPLE_SKILL_MD).unwrap();
        assert_eq!(record.id, "polite-greeter");
        assert_eq!(record.name, "Polite Greeter");
        assert_eq!(
            record.description.as_deref(),
            Some("Prefixes every reply with a greeting.")
        );
        assert_eq!(
            record.instructions,
            "Always begin every response with \"Hello!\"."
        );
        assert_eq!(record.allowed_tools, vec!["agentbrowser"]);
        assert!(record.enabled, "default enabled must be true");
    }

    #[test]
    fn parses_minimal_skill_md() {
        let record = parse_skill_md("minimal", MINIMAL_SKILL_MD).unwrap();
        assert_eq!(record.name, "Minimal Skill");
        assert!(record.description.is_none());
        assert_eq!(record.instructions, "Do something minimal.");
        assert!(record.allowed_tools.is_empty());
    }

    #[test]
    fn rejects_skill_md_without_name() {
        let bad = "---\ndescription: \"no name\"\n---\nbody";
        let err = parse_skill_md("bad", bad).unwrap_err();
        assert!(err.contains("name"), "error should mention 'name': {err}");
    }

    #[test]
    fn skill_record_implements_runnable() {
        let record = parse_skill_md("polite-greeter", SAMPLE_SKILL_MD).unwrap();
        assert_eq!(record.kind(), RunnableKind::Skill);
        assert_eq!(record.id(), "polite-greeter");
        assert_eq!(record.name(), "Polite Greeter");
    }

    // ── Registry injection ─────────────────────────────────────────────────────

    /// Build an in-memory registry with one enabled skill.
    fn registry_with(skill: SkillRecord) -> SkillRegistry {
        let reg = SkillRegistry::empty();
        *reg.inner.write().unwrap() = vec![skill];
        reg
    }

    #[test]
    fn inject_adds_system_message_when_none_present() {
        let record = parse_skill_md("greeter", SAMPLE_SKILL_MD).unwrap();
        let registry = registry_with(record);

        let mut messages: Vec<Value> = vec![json!({"role": "user", "content": "hi"})];
        let injected_ids = registry.inject_into_messages(&mut messages);

        // A system message must now be present at index 0.
        assert_eq!(messages[0]["role"], "system");
        let sys_content = messages[0]["content"].as_str().unwrap();
        assert!(
            sys_content.contains("Always begin every response with"),
            "system message should contain skill instructions: {sys_content}"
        );
        assert!(
            sys_content.contains("Polite Greeter"),
            "system message should contain skill name: {sys_content}"
        );
        assert_eq!(injected_ids, vec!["greeter"]);
        // Original user message still present.
        assert_eq!(messages.len(), 2);
    }

    #[test]
    fn inject_prepends_to_existing_system_message() {
        let record = parse_skill_md("greeter", SAMPLE_SKILL_MD).unwrap();
        let registry = registry_with(record);

        let mut messages: Vec<Value> = vec![
            json!({"role": "system", "content": "You are a helpful assistant."}),
            json!({"role": "user", "content": "hi"}),
        ];
        let ids = registry.inject_into_messages(&mut messages);

        let sys_content = messages[0]["content"].as_str().unwrap();
        assert!(
            sys_content.contains("Always begin every response"),
            "skill injected"
        );
        assert!(
            sys_content.contains("You are a helpful assistant"),
            "existing preserved"
        );
        assert!(sys_content.contains("---"), "separator present");
        assert_eq!(ids, vec!["greeter"]);
    }

    #[test]
    fn disabled_skills_are_not_injected() {
        let mut record = parse_skill_md("disabled", SAMPLE_SKILL_MD).unwrap();
        record.enabled = false;
        let registry = registry_with(record);

        let mut messages: Vec<Value> = vec![json!({"role": "user", "content": "hi"})];
        let ids = registry.inject_into_messages(&mut messages);

        // No system message should have been added.
        assert!(ids.is_empty(), "no ids returned for disabled skill");
        assert_eq!(messages.len(), 1, "no system message inserted");
        assert_eq!(messages[0]["role"], "user");
    }

    #[test]
    fn empty_registry_does_not_mutate_messages() {
        let registry = SkillRegistry::empty();
        let mut messages: Vec<Value> = vec![json!({"role": "user", "content": "hi"})];
        let ids = registry.inject_into_messages(&mut messages);
        assert!(ids.is_empty());
        assert_eq!(messages.len(), 1);
    }

    #[test]
    fn inject_returns_ids_of_all_active_skills() {
        let s1 = parse_skill_md("skill-one", "---\nname: \"Skill One\"\n---\nDo one.").unwrap();
        let s2 = parse_skill_md("skill-two", "---\nname: \"Skill Two\"\n---\nDo two.").unwrap();
        let registry = SkillRegistry::empty();
        *registry.inner.write().unwrap() = vec![s1, s2];

        let mut messages: Vec<Value> = vec![json!({"role": "user", "content": "hi"})];
        let ids = registry.inject_into_messages(&mut messages);

        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"skill-one".to_owned()));
        assert!(ids.contains(&"skill-two".to_owned()));
    }

    /// Build an in-memory registry from a list of skill records.
    fn registry_of(skills: Vec<SkillRecord>) -> SkillRegistry {
        let reg = SkillRegistry::empty();
        *reg.inner.write().unwrap() = skills;
        reg
    }

    #[test]
    fn empty_allowlist_means_all_enabled_skills() {
        let s1 = parse_skill_md("skill-one", "---\nname: \"One\"\n---\nDo one.").unwrap();
        let s2 = parse_skill_md("skill-two", "---\nname: \"Two\"\n---\nDo two.").unwrap();
        let registry = registry_of(vec![s1, s2]);

        // Empty allowlist = no narrowing: every enabled skill is permitted.
        let mut ids: Vec<String> = registry
            .enabled_for(&[])
            .into_iter()
            .map(|s| s.id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["skill-one".to_owned(), "skill-two".to_owned()]);
    }

    #[test]
    fn nonempty_allowlist_narrows_to_intersection_with_enabled() {
        let s1 = parse_skill_md("skill-one", "---\nname: \"One\"\n---\nDo one.").unwrap();
        let s2 = parse_skill_md("skill-two", "---\nname: \"Two\"\n---\nDo two.").unwrap();
        let mut s3 = parse_skill_md("skill-three", "---\nname: \"Three\"\n---\nDo three.").unwrap();
        s3.enabled = false; // globally disabled
        let registry = registry_of(vec![s1, s2, s3]);

        // Allowlist picks one enabled skill, plus a globally-disabled one (which
        // must NOT be re-activated) and an unknown id (ignored).
        let allow = vec![
            "skill-two".to_owned(),
            "skill-three".to_owned(),
            "does-not-exist".to_owned(),
        ];
        let ids: Vec<String> = registry
            .enabled_for(&allow)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(ids, vec!["skill-two".to_owned()]);
    }

    #[test]
    fn filtered_injection_respects_allowlist() {
        let s1 = parse_skill_md("skill-one", "---\nname: \"One\"\n---\nInstruction one.").unwrap();
        let s2 = parse_skill_md("skill-two", "---\nname: \"Two\"\n---\nInstruction two.").unwrap();
        let registry = registry_of(vec![s1, s2]);

        let mut messages: Vec<Value> = vec![json!({"role": "user", "content": "hi"})];
        let ids = registry.inject_into_messages_filtered(&mut messages, &["skill-one".to_owned()]);

        assert_eq!(ids, vec!["skill-one".to_owned()]);
        let sys = messages[0]["content"].as_str().unwrap();
        assert!(sys.contains("Instruction one."), "allowed skill injected");
        assert!(
            !sys.contains("Instruction two."),
            "non-allowlisted skill must not be injected: {sys}"
        );
    }

    #[test]
    fn skill_block_returns_none_when_nothing_matches() {
        let s1 = parse_skill_md("skill-one", "---\nname: \"One\"\n---\nDo one.").unwrap();
        let registry = registry_of(vec![s1]);
        // Allowlist names only an unknown skill -> empty intersection -> None.
        assert!(registry.skill_block(&["unknown".to_owned()]).is_none());
    }

    #[test]
    fn progressive_block_indexes_on_demand_skills() {
        let s1 = parse_skill_md(
            "researcher",
            "---\nname: \"Researcher\"\ndescription: \"searches the web\"\n---\nLong body here.",
        )
        .unwrap();
        let registry = registry_of(vec![s1]);
        let (text, ids) = registry.progressive_block(&[]).expect("a block");
        // The full body is NOT injected — only the L1 index line is.
        assert!(
            !text.contains("Long body here."),
            "body must not inject: {text}"
        );
        assert!(
            text.contains("- researcher — Researcher: searches the web"),
            "{text}"
        );
        assert!(
            text.contains("skills__load"),
            "must tell the model how to load"
        );
        // No always-on skills => nothing attributed as injected.
        assert!(ids.is_empty(), "no always-on bodies injected: {ids:?}");
    }

    #[test]
    fn progressive_block_injects_always_on_bodies_full() {
        let always = parse_skill_md(
            "critical",
            "---\nname: \"Critical\"\ndescription: \"d\"\nalways-on: true\n---\nMUST do this.",
        )
        .unwrap();
        let lazy = parse_skill_md(
            "lazy",
            "---\nname: \"Lazy\"\ndescription: \"later\"\n---\nLazy body.",
        )
        .unwrap();
        let registry = registry_of(vec![always, lazy]);
        let (text, ids) = registry.progressive_block(&[]).expect("a block");
        // Always-on skill gets its full body; the other is only indexed.
        assert!(
            text.contains("MUST do this."),
            "always-on body injected: {text}"
        );
        assert!(
            !text.contains("Lazy body."),
            "lazy body not injected: {text}"
        );
        assert!(
            text.contains("- lazy — Lazy: later"),
            "lazy is indexed: {text}"
        );
        assert_eq!(
            ids,
            vec!["critical".to_owned()],
            "only always-on attributed"
        );
    }

    #[test]
    fn progressive_block_none_when_no_skills() {
        let registry = registry_of(vec![]);
        assert!(registry.progressive_block(&[]).is_none());
    }

    #[test]
    fn scan_finds_standard_and_legacy_layouts() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // Standard layout: <id>/SKILL.md (the universal ~/.claude/skills shape).
        let std_dir = root.join("alpha");
        std::fs::create_dir_all(&std_dir).unwrap();
        std::fs::write(std_dir.join("SKILL.md"), "---\nname: Alpha\n---\nbody").unwrap();
        // A bundled resource alongside SKILL.md must not be mistaken for a skill.
        std::fs::write(std_dir.join("reference.md"), "notes").unwrap();

        // Legacy flat layout: <id>.md at the top level.
        std::fs::write(root.join("beta.md"), "---\nname: Beta\n---\nbody").unwrap();

        let mut ids: Vec<String> = scan_skill_dir(root).into_iter().map(|s| s.id).collect();
        ids.sort();
        assert_eq!(ids, vec!["alpha".to_owned(), "beta".to_owned()]);
    }

    #[test]
    fn scan_prefers_directory_over_flat_on_id_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let dir = root.join("dup");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: Dir\n---\nfrom dir").unwrap();
        std::fs::write(root.join("dup.md"), "---\nname: Flat\n---\nfrom flat").unwrap();

        let found = scan_skill_dir(root);
        assert_eq!(found.len(), 1, "id collision collapses to one entry");
        assert_eq!(found[0].id, "dup");
        assert!(
            found[0].skill_md.ends_with("SKILL.md"),
            "directory layout wins: {}",
            found[0].skill_md.display()
        );
    }

    #[test]
    fn scan_missing_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert!(scan_skill_dir(&missing).is_empty());
    }

    // One test owns the process-global skills env vars to avoid races with any
    // other test that might read them; it exercises the activation round-trip and
    // the reload gate together.
    #[test]
    fn activation_set_gates_injection() {
        let dir = tempfile::tempdir().unwrap();
        let active = tempfile::tempdir().unwrap();
        let active_file = active.path().join("active.json");

        let a = dir.path().join("active-one");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("SKILL.md"), "---\nname: One\n---\nbody one").unwrap();
        let b = dir.path().join("dormant-two");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("SKILL.md"), "---\nname: Two\n---\nbody two").unwrap();

        std::env::set_var("RYU_SKILLS_DIR", dir.path());
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", &active_file);

        // Round-trip: activate + deactivate persist correctly.
        assert!(load_active_set().is_empty(), "no file yet -> empty");
        set_active("active-one", true);
        set_active("dormant-two", true);
        set_active("dormant-two", false);
        let set = load_active_set();
        assert!(set.contains("active-one"));
        assert!(!set.contains("dormant-two"), "deactivated id removed");

        // Gate: both skills are installed/visible, only the active one injects.
        let reg = SkillRegistry::empty();
        reg.reload();
        let enabled = reg.enabled();

        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");

        assert_eq!(reg.list_all().len(), 2, "both skills are installed/visible");
        assert_eq!(enabled.len(), 1, "only the activated skill injects");
        assert_eq!(enabled[0].id, "active-one");
    }
}
