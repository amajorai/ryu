//! **Agent Skill runtime** (M3, issue #145).
//!
//! This module owns the Core side of the Skills standard:
//! - SKILL.md parsing (YAML front-matter + Markdown body).
//! - [`SkillRecord`] — the real, executable Skill Runnable (replaces `SkillStub`).
//! - [`SkillRegistry`] — loads skills from the universal Agent Skills directories
//!   (overridable via `RYU_SKILLS_DIR`), plus the legacy flat `<id>.md` layout for
//!   back-compat. Two standard roots are scanned so a skill installed by *any*
//!   agent is detected:
//!     1. `~/.claude/skills/<id>/SKILL.md` — the Claude Code / skills-CLI location
//!        (also Ryu's own write/install target).
//!     2. `~/.agents/skills/<id>/SKILL.md` — the **vendor-neutral** Agent Skills
//!        directory the `agentskills.io` / `vercel-labs/skills` ecosystem installs
//!        into, and the exact path the managed Pi binary auto-loads. Detecting it
//!        means skills any tool dropped there work in Ryu with zero setup. Per the
//!        spec, root-level `.md` files under this dir are ignored (dirs only).
//!   On an id collision the first root (`~/.claude/skills`) wins.
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

use ryu_sidecar_runtime::layout;
use serde::{Deserialize, Serialize};

pub mod api;
mod builtin;
pub mod store;

pub use api::{routes, SkillsCtx};

/// Process-wide lock for tests that mutate the global `RYU_SKILLS_DIR` /
/// `RYU_SKILLS_ACTIVE_FILE` env vars. Several test modules (`skills`,
/// `skills_catalog::from_source`, `sidecar::mcp::skills_tool`) point these at their
/// own tempdirs; without serializing them a parallel `cargo test` run has one
/// test's `remove_var` clobber another's `set_var`, so a write falls through to the
/// real `~/.claude/skills`. Every test that touches those vars must hold this.
///
/// Exposed `pub` (not `#[cfg(test)]`-gated) because Core's own test modules that
/// stayed behind — `skills_catalog::from_source` and `sidecar::mcp::skills_tool` —
/// hold this same lock across the crate boundary (`#[cfg(test)]` statics do not
/// cross crates). The cost is one always-compiled zero-sized mutex.
pub static SKILLS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ── Data-dir seam (inverts `apps/core`'s `paths::ryu_dir()`) ─────────────────────
//
// Skills keep Ryu-local state OUT of the shared skills dir: the activation set
// (`state/skills-active.json`), version snapshots (`state/skill-versions/`) and
// managed source history (`files/source-history/`). All of those live under
// Ryu's own data folder, which Core owns and can relocate. Rather than depend on
// `apps/core`, the crate reads the folder from a process-global set once at
// startup by Core (`ryu_skills::set_data_dir(paths::ryu_dir())`), mirroring how
// the moved `ryu_quests` engine is published via a `OnceLock`. When unset it falls
// back to the same pointer- and profile-aware resolution every Ryu process uses
// (`ryu_sidecar_runtime::ryu_dir`).

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Publish the Ryu data folder. Idempotent; a second call is ignored. Core calls
/// this at startup **before** [`SkillRegistry::load`] so seeding resolves against
/// the real (possibly relocated) data dir, not the fallback.
pub fn set_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// The Ryu data folder. The value Core published, or — when unset — the shared
/// resolver's answer (`RYU_DIR`, the Storage pointer, then the profile default).
fn data_dir() -> PathBuf {
    DATA_DIR
        .get()
        .cloned()
        .unwrap_or_else(ryu_sidecar_runtime::ryu_dir)
}

pub(crate) fn ryu_data_dir() -> PathBuf {
    data_dir()
}

// ── Global registry (read by the moved `/api/skills` handlers) ───────────────────
//
// The `/api/skills` CRUD/version/activate handlers moved to `api.rs`. They read the
// live [`SkillRegistry`] from this process-global handle (published by Core from the
// one `ServerState.skills` instance at startup), exactly as the extracted `ryu_quests`
// engine is published via its own `OnceLock`. The registry is `Arc`-backed, so the
// global and every `ServerState.skills` clone share one inner `RwLock`: a handler's
// `reload()` is visible to the chat-turn injection and vice versa.

static REGISTRY: OnceLock<SkillRegistry> = OnceLock::new();

/// Publish the process-global skill registry. Idempotent; a second call is ignored.
pub fn set_global_registry(registry: SkillRegistry) {
    let _ = REGISTRY.set(registry);
}

/// The process-global skill registry, if Core has published one.
pub fn global_registry() -> Option<&'static SkillRegistry> {
    REGISTRY.get()
}

// ── Disclosure mode (progressive vs full) ───────────────────────────────────────
//
// Progressive disclosure injects only each skill's name+description (L1) up front
// and lets the model load a full body (L2) on demand via the `skills.load` tool —
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

/// Max L1 index entries injected before the model is told to use `skills.search`
/// instead of relying on the inline list.
///
/// **The cut is id-alphabetical, and that bias is permanent.** Sorting the scan
/// ([`scan_skill_dir_opts`]) bought determinism, not fairness: on a node with more
/// than `SKILL_INDEX_CAP` enabled on-demand skills the excluded ones are the
/// alphabetically-last ones on every turn, and an author can buy their way into the
/// index with an `a-` prefix. Accepted, because the alternatives are worse: a
/// query-ranked cut busts the prompt cache every turn (see
/// [`SkillRegistry::progressive_block`]), and a rotating/random cut makes the
/// injected prefix differ between two identical turns — the same cache cost plus
/// irreproducible behaviour. Nothing is *lost* by the cut either: the trailing
/// "...and N more" line points at `skills.search`, which ranks over every enabled
/// skill regardless of index position, so the bias costs a skill its free mention,
/// never its reachability.
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
/// Core implements `Runnable for SkillRecord` (`RunnableKind::Skill`) host-side —
/// the `Runnable` trait lives in `apps/core`, so the impl stays there while this
/// data type lives in the crate. Instruction injection happens in Core; Gateway
/// attribution happens via the `x-ryu-skill-ids` header Core attaches to outgoing
/// requests (AC3).
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

impl SkillRecord {
    /// Whether this record has an instruction body to serve.
    ///
    /// A record with an empty `instructions` is *advertisable but not loadable*: it
    /// carries identity metadata and nothing to inject. Two things produce that
    /// shape, and neither is a bug:
    ///
    /// 1. [`SkillRegistry::register_app_skill`] — a plugin contributing a
    ///    `RunnableKind::Skill` registers `instructions: String::new()`, because the
    ///    plugin's `SkillConfig` is `skill_id`-only; the real body only exists once
    ///    the skill is materialised on disk.
    /// 2. [`parse_skill_md`] — a `SKILL.md` that is front-matter only (or that never
    ///    closes its front-matter) parses to an empty body; the *only* parse error is
    ///    a missing `name`. So the disk half can produce one too.
    ///
    /// The predicate is therefore about the **body, full stop** — not about the
    /// `app__` prefix and not about where the record came from. A plugin skill
    /// genuinely materialised on disk parses into a record with a real body and
    /// passes here (and disk records precede the `app_skills` bag in
    /// [`SkillRegistry::enabled`], so the disk copy is the one every lookup finds).
    ///
    /// **This is the one rule for every surface that offers a skill**, and they must
    /// keep agreeing: advertising a skill whose load returns nothing is the
    /// healthy-status-for-a-thing-that-is-not-there defect, and it is *louder* on the
    /// injected surfaces than on the searched ones, because the injected index tells
    /// the model in so many words to call `skills.load` with the id.
    ///
    /// | Surface | Where the rule is applied |
    /// |---|---|
    /// | progressive-disclosure L1 index | [`SkillRegistry::progressive_block`], via [`SkillRegistry::loadable_for`] |
    /// | always-on / full-body injection | [`SkillRegistry::progressive_block`] and [`SkillRegistry::skill_block`], via [`SkillRegistry::loadable_for`] |
    /// | `skills.search` | `do_search` in `apps/core/src/sidecar/mcp/skills_tool.rs` |
    /// | `skills.load` | `do_load` in the same module — the one surface that must still **see** the record, so it can refuse it by name rather than answering `ok:true` with an empty body |
    /// | merged tool catalog (`tool_search` list + resolve) | `apps/core/src/sidecar/mcp/catalog.rs` |
    /// | workflow `Skill` node | `compose_skill_prompt` in `apps/core/src/workflow/executor.rs` |
    ///
    /// That last row is NOT a discovery surface — a human wrote the id into the
    /// node, nothing offered it — so the "advertises what the loader refuses"
    /// defect does not apply to it. It applies the predicate for the sibling
    /// reason: composing `## Skill: <name>\n` with an empty body would run the node
    /// on nothing and report success. `compose_skill_prompt` returns `Err` instead,
    /// and keeps that arm textually distinct from its "is not installed" arm,
    /// because "no such skill" and "registered here but its body was never
    /// installed" need different fixes. (This row was a stated exception while
    /// `run_skill` still had the defect; it is now closed, and closed by *calling
    /// this method* rather than by re-deriving the rule.)
    ///
    /// One consumer of [`SkillRegistry::list_all`] remains deliberately **outside**
    /// the rule: `GET /api/skills` (`api::list_skills`) is the skills-library
    /// **inventory**. It must keep showing a plugin's contribution before the body
    /// exists — otherwise enabling a plugin would make its skill vanish from the UI
    /// while the plugin claims to provide it. Inventory and offer legitimately
    /// differ.
    ///
    /// It lives on the record, in this Core-independent crate, rather than in the
    /// Core-side MCP module where it was first written: the rule is a property of the
    /// record, and this crate owns both the type and producer (1). The block builders
    /// below cannot call into `apps/core`, so leaving it there would have forced a
    /// second spelling of the same rule — which is exactly the drift that let the
    /// injected index keep advertising what `skills.load` had started refusing.
    /// `skills_tool::is_loadable` is now a delegate to this method.
    pub fn is_loadable(&self) -> bool {
        !self.instructions.trim().is_empty()
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

    let fm: SkillFrontMatter = noyalib::compat::serde_yaml::from_str(&front_raw)
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
pub(crate) fn split_front_matter(content: &str) -> Result<(String, String), String> {
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
/// means a skill installed anywhere is usable everywhere. Ryu's own installer /
/// authoring writes here (the singular [`SkillRegistry::skills_dir`]).
fn default_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
        .join("skills")
}

/// The **vendor-neutral** Agent Skills directory: `~/.agents/skills`. This is the
/// cross-agent, cross-platform location the `agentskills.io` / `vercel-labs/skills`
/// ecosystem installs into (`~` resolves the OS home on macOS, Linux and Windows
/// alike), and the exact hard-coded path the managed Pi binary auto-loads. Ryu
/// disables Pi's own discovery of it (see `pi_config`) precisely so Core stays the
/// single governed injector — which means Core must scan it here for those skills
/// to be detected at all. Read-only: Ryu never writes into it.
fn agents_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agents")
        .join("skills")
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
/// registry loader and the catalog's installed-view both call it (via
/// [`scan_all_skill_dirs`]).
pub fn scan_skill_dir(dir: &Path) -> Vec<InstalledSkillPath> {
    scan_skill_dir_opts(dir, true)
}

/// The ordered set of roots scanned for installed skills, each paired with whether
/// legacy flat `<id>.md` files count as skills there.
///
/// - `RYU_SKILLS_DIR` override → that single dir, flat layout honoured (the
///   explicit knob the user owns; tests and the installer rely on flat support).
/// - Otherwise → `~/.claude/skills` (flat honoured, for back-compat with the
///   legacy migration) followed by the vendor-neutral `~/.agents/skills` (dirs
///   only — the Agent Skills spec says root-level `.md` files there are not
///   skills). The first root wins on an id collision.
fn skills_scan_roots() -> Vec<(PathBuf, bool)> {
    if let Some(p) = std::env::var_os("RYU_SKILLS_DIR") {
        return vec![(PathBuf::from(p), true)];
    }
    let claude = default_skills_dir();
    let agents = agents_skills_dir();
    let mut roots = vec![(claude.clone(), true)];
    if agents != claude {
        roots.push((agents, false));
    }
    roots
}

/// Scan **every** standard skills root ([`skills_scan_roots`]) in one pass,
/// deduped by id (first root wins). This is what the registry loader and the
/// catalog's installed-view use so a skill dropped into any standard location —
/// `~/.claude/skills` or the vendor-neutral `~/.agents/skills` — is detected.
pub fn scan_all_skill_dirs() -> Vec<InstalledSkillPath> {
    let mut found: Vec<InstalledSkillPath> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (dir, include_flat) in skills_scan_roots() {
        for s in scan_skill_dir_opts(&dir, include_flat) {
            if seen.insert(s.id.clone()) {
                found.push(s);
            } else {
                tracing::debug!(
                    "skill id '{}' at {} shadowed by an earlier root; skipping",
                    s.id,
                    s.skill_md.display()
                );
            }
        }
    }
    found
}

/// Resolve `id` to the one `SKILL.md` every consumer would load for it, or `None`
/// when the id is free across the **whole** namespace.
///
/// This is the existence predicate a *writer* needs, and it is deliberately not
/// `<write root>/<id>/SKILL.md`.exists(). The write target
/// ([`SkillRegistry::skills_dir`]) is only root **one** of the namespace, and within
/// a root the directory layout beats the legacy flat `<id>.md` form (see
/// [`scan_skill_dir_opts`]). So creating `<write root>/<id>/SKILL.md` for an id that
/// already resolves *anywhere* does not add an id — it takes one over:
/// [`scan_all_skill_dirs`] hands the winning entry to [`SkillRegistry::reload`], and
/// from there `enabled`/`enabled_for`/`skill_block`/`progressive_block`, the
/// `skills.search`/`skills.load` tools and the skills library all serve the new
/// bytes under the old id. The shadowed file survives on disk but is unreachable,
/// which for every consumer equals an overwrite.
///
/// Membership does not depend on root order — an id either appears in some root's
/// scan or it does not — so this answers "is the id taken?" identically to
/// [`scan_all_skill_dirs`]. Root order only decides *which* path comes back, and it
/// is the same first-root-wins order that function dedupes by, so the returned path
/// is the entry `reload()` would actually read.
pub fn resolve_skill_md(id: &str) -> Option<PathBuf> {
    resolve_skill_md_in(&skills_scan_roots(), id)
}

/// The root-explicit half of [`resolve_skill_md`].
///
/// Split out so first-root-wins and the dirs-only rule for the vendor-neutral root
/// are testable against temp roots instead of the developer's real `$HOME`. The two
/// standard roots are *not* individually env-overridable: `RYU_SKILLS_DIR` collapses
/// [`skills_scan_roots`] to a single root rather than redirecting root two, so a test
/// that only redirected the second root would scan the real `~/.claude/skills` as
/// root one.
fn resolve_skill_md_in(roots: &[(PathBuf, bool)], id: &str) -> Option<PathBuf> {
    roots.iter().find_map(|(dir, include_flat)| {
        scan_skill_dir_opts(dir, *include_flat)
            .into_iter()
            .find(|s| s.id == id)
            .map(|s| s.skill_md)
    })
}

/// Scan a single `dir`. When `include_flat_md` is false, legacy flat `<id>.md`
/// files are ignored and only `<id>/SKILL.md` directories are treated as skills
/// (the rule for the vendor-neutral `~/.agents/skills` root).
///
/// **The result is sorted by id.** `read_dir` yields entries in whatever order the
/// filesystem enumerates them (inode/hash order on ext4/APFS, creation order on
/// others) — stable on one machine, arbitrary across machines, and free to change
/// when a skill is added or removed. That order propagated all the way into
/// [`SkillRegistry::progressive_block`], which injects only the first
/// [`SKILL_INDEX_CAP`] on-demand skills: with more than 20 enabled skills, *which*
/// 20 the model could see was effectively arbitrary and could shift between runs.
///
/// This is the single choke point for that: [`scan_skill_dir`] and
/// [`scan_all_skill_dirs`] both funnel through here, so every disk-derived
/// consumer — the registry's `reload()` and `skills_catalog`'s installed-view,
/// which never goes through [`SkillRegistry`] at all — inherits the ordering from
/// one place. Sorting happens after the flat merge; the "directory form beats
/// legacy flat form" rule is established by the `seen` set, not by position, so it
/// survives the sort. [`scan_all_skill_dirs`] deliberately does *not* re-sort the
/// merged result: root-1-then-root-2 is already deterministic, and a global sort
/// would blur the "first root wins" story for no gain.
fn scan_skill_dir_opts(dir: &Path, include_flat_md: bool) -> Vec<InstalledSkillPath> {
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
        } else if include_flat_md && path.extension().and_then(|e| e.to_str()) == Some("md") {
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
    // Deterministic visibility (see the doc-comment): ids are unique within a root,
    // so this is a total order with no tie-break needed.
    found.sort_by(|a, b| a.id.cmp(&b.id));
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
    layout::state_path(&crate::ryu_data_dir(), "skills-active.json")
}

/// Load the set of active skill ids (those injected on the default route).
pub fn load_active_set() -> HashSet<String> {
    match ryu_json_store::read_or_default::<Vec<String>>(&active_set_path()) {
        Ok(values) => values.into_iter().collect(),
        Err(error) => {
            tracing::error!(error = %error, "skill activation store is corrupt");
            HashSet::new()
        }
    }
}

fn save_active_set(set: &HashSet<String>) -> anyhow::Result<()> {
    let path = active_set_path();
    let mut list: Vec<String> = set.iter().cloned().collect();
    list.sort();
    ryu_json_store::mutate(&path, |stored: &mut Vec<String>| {
        *stored = list;
        Ok(())
    })
}

/// Mark a skill active (inject on the default route) or inactive. Idempotent.
pub fn try_set_active(id: &str, active: bool) -> anyhow::Result<bool> {
    let path = active_set_path();
    ryu_json_store::mutate(&path, |stored: &mut Vec<String>| {
        let mut set: HashSet<String> = stored.drain(..).collect();
        let changed = if active {
            set.insert(id.to_owned())
        } else {
            set.remove(id)
        };
        let mut values: Vec<String> = set.into_iter().collect();
        values.sort();
        *stored = values;
        Ok(changed)
    })
}

/// Backward-compatible best-effort activation seam for Core integrations.
/// Persistence failures are logged loudly and, crucially, never replace a
/// corrupt file with an empty activation set. HTTP callers use [`try_set_active`]
/// when they need to surface a 500 to the user.
pub fn set_active(id: &str, active: bool) {
    if let Err(error) = try_set_active(id, active) {
        tracing::error!(skill_id = id, active, error = %error, "persisting skill activation failed");
    }
}

/// On first run, seed the activation set from catalog provenance (skills
/// installed *through Ryu*) — so previously-installed skills stay active without
/// auto-activating the dozens of skills other tools may have placed in the shared
/// dir. A no-op once the set file exists.
fn ensure_active_set_seeded() {
    if active_set_path().exists() {
        return;
    }
    let provenance = layout::state_path(&crate::ryu_data_dir(), "skills-catalog-installed.json");
    let set: HashSet<String> = std::fs::read_to_string(&provenance)
        .ok()
        .and_then(|s| serde_json::from_str::<std::collections::HashMap<String, String>>(&s).ok())
        .map(|m| m.into_keys().collect())
        .unwrap_or_default();
    if let Err(error) = save_active_set(&set) {
        tracing::error!(error = %error, "seeding skill activation store failed");
    }
}

// ── SkillRegistry ──────────────────────────────────────────────────────────────

/// Registry of installed agent skills.
///
/// Skills are loaded from `~/.claude/skills/` (env-overridable via
/// `RYU_SKILLS_DIR`) plus the vendor-neutral `~/.agents/skills/`. The registry is write-locked during hot-reload so reads
/// during a chat turn are always consistent.
///
/// Core-vs-Gateway: the registry decides *which skills apply* (Core). Whether the
/// instructions are *allowed* to be injected is a Gateway policy concern (future).
#[derive(Clone)]
pub struct SkillRegistry {
    inner: Arc<RwLock<Vec<SkillRecord>>>,
    /// Skills contributed by **enabled plugins** (`RunnableKind::Skill`), kept in a
    /// bag SEPARATE from `inner` so a disk [`Self::reload`] can never wipe them —
    /// exactly mirroring `McpRegistry::register_app_tool`'s `app_tools`. Populated
    /// by [`Self::register_app_skill`] on plugin enable, drained by
    /// [`Self::unregister_app_skill`] on disable. In-memory only; survives restart
    /// because `onStartup` re-runs every enabled plugin through the runnable
    /// registry. Merged into [`Self::list_all`] and [`Self::enabled`].
    app_skills: Arc<RwLock<Vec<SkillRecord>>>,
}

impl SkillRegistry {
    /// Create an empty registry (no skills loaded yet).
    pub fn empty() -> Self {
        Self {
            inner: Arc::new(RwLock::new(Vec::new())),
            app_skills: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Test helper: replace the in-memory skill set directly (no disk I/O).
    ///
    /// Exposed `pub` (not `#[cfg(test)]`-gated) because Core's own `skills_tool`
    /// test module drives it across the crate boundary — a `#[cfg(test)]` method is
    /// invisible to a dependent crate's tests. It is inert in production (nothing
    /// calls it), so the always-compiled cost is nil.
    pub fn replace_for_test(&self, skills: Vec<SkillRecord>) {
        *self.inner.write().expect("SkillRegistry lock poisoned") = skills;
    }

    /// Load skills from disk and return a populated registry.
    ///
    /// Mirrors [`crate::plugin_manifest::PluginManifestLoader`]'s pattern: built-in
    /// embedded first-party defaults, then user skills from `RYU_SKILLS_DIR` or the
    /// universal `~/.claude/skills/` directory.
    pub fn load() -> Self {
        ensure_active_set_seeded();
        builtin::install_defaults();
        let registry = Self::empty();
        registry.reload();
        registry
    }

    /// Resolve the **write/install target** directory: `RYU_SKILLS_DIR` if set,
    /// else `~/.claude/skills`. This is the single dir Ryu's installer and
    /// `skills.author` write into (one canonical home for Ryu-authored skills).
    ///
    /// Detection is *broader* than this: [`scan_all_skill_dirs`] also reads the
    /// vendor-neutral `~/.agents/skills`, so a skill installed by Ryu is usable
    /// everywhere — and a skill installed by any other agent into either standard
    /// root shows up as installed in Ryu.
    pub fn skills_dir() -> PathBuf {
        if let Some(p) = std::env::var_os("RYU_SKILLS_DIR") {
            return PathBuf::from(p);
        }
        default_skills_dir()
    }

    /// (Re)load skills from disk, replacing the current registry contents.
    ///
    /// Scans **all** standard roots ([`scan_all_skill_dirs`]) — `~/.claude/skills`
    /// and the vendor-neutral `~/.agents/skills` — not just the singular write
    /// target, so a skill any agent installed into either is detected.
    pub fn reload(&self) {
        let mut skills: Vec<SkillRecord> = Vec::new();

        let active = load_active_set();
        for found in scan_all_skill_dirs() {
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

    /// Register a skill contributed by an enabled plugin (`RunnableKind::Skill`).
    ///
    /// The mirror of `McpRegistry::register_app_tool`: the skill is added to the
    /// `app_skills` bag so it is immediately listable ([`Self::list_all`]) and, when
    /// `enabled`, injected ([`Self::enabled`]) exactly like a first-party skill —
    /// without touching disk. Idempotent: re-registering the same id replaces the
    /// existing entry, so re-enabling a plugin is a no-op. `id` uses the
    /// `app__<skill_id>` convention every other app contribution shares.
    pub fn register_app_skill(&self, id: String, name: String, description: Option<String>) {
        let record = SkillRecord {
            id: id.clone(),
            name,
            description,
            // App-declared skills carry only identity metadata at this layer (the
            // `SkillConfig` is `skill_id`-only), mirroring how `register_app_tool`
            // registers a slug with no executable body. A real instruction body
            // lands when the skill is materialised on disk.
            instructions: String::new(),
            allowed_tools: Vec::new(),
            enabled: true,
            always_on: false,
        };
        if let Ok(mut skills) = self.app_skills.write() {
            skills.retain(|s| s.id != id);
            skills.push(record);
            // Second, independent order source. [`Self::enabled`] is disk-skills ++
            // this bag, and the `SKILL_INDEX_CAP` cut in `progressive_block` can land
            // inside the bag — whose natural order is *plugin-enable order*, which
            // varies with startup scheduling. Sorting the scanner (the disk half)
            // cannot cover this half, so the bag sorts itself on every insert.
            skills.sort_by(|a, b| a.id.cmp(&b.id));
        }
    }

    /// Register a body-bearing skill shipped by Core itself. Built-in skills use
    /// the same live bag as plugin contributions so a disk reload cannot remove
    /// them, while keeping their instructions available through the normal
    /// progressive `skills.search` / `skills.load` path.
    pub fn register_builtin_skill(
        &self,
        id: String,
        name: String,
        description: Option<String>,
        instructions: String,
    ) {
        let record = SkillRecord {
            id: id.clone(),
            name,
            description,
            instructions,
            allowed_tools: Vec::new(),
            enabled: true,
            always_on: false,
        };
        if let Ok(mut skills) = self.app_skills.write() {
            skills.retain(|skill| skill.id != id);
            skills.push(record);
            skills.sort_by(|a, b| a.id.cmp(&b.id));
        }
    }

    /// Remove a plugin-registered skill by id. Called when a plugin is disabled so
    /// its skill stops being listable and injectable. Idempotent: removing an id
    /// that is not present is a no-op.
    pub fn unregister_app_skill(&self, id: &str) {
        if let Ok(mut skills) = self.app_skills.write() {
            skills.retain(|s| s.id != id);
        }
    }

    /// Snapshot of the plugin-contributed skills (the `app_skills` bag).
    fn app_skills_snapshot(&self) -> Vec<SkillRecord> {
        self.app_skills
            .read()
            .map(|v| v.clone())
            .unwrap_or_default()
    }

    /// Return all installed skills (enabled and disabled), e.g. for listing.
    /// Includes both disk-loaded skills and plugin-contributed `app_skills`.
    pub fn list_all(&self) -> Vec<SkillRecord> {
        let mut all = self
            .inner
            .read()
            .expect("SkillRegistry lock poisoned")
            .clone();
        all.extend(self.app_skills_snapshot());
        all
    }

    /// Return only the enabled skills (disk-loaded + plugin-contributed).
    pub fn enabled(&self) -> Vec<SkillRecord> {
        let mut enabled: Vec<SkillRecord> = self
            .inner
            .read()
            .expect("SkillRegistry lock poisoned")
            .iter()
            .filter(|s| s.enabled)
            .cloned()
            .collect();
        enabled.extend(self.app_skills_snapshot().into_iter().filter(|s| s.enabled));
        enabled
    }

    /// Return `true` when at least one skill is enabled (disk-loaded or
    /// plugin-contributed).
    pub fn has_enabled(&self) -> bool {
        self.inner
            .read()
            .expect("SkillRegistry lock poisoned")
            .iter()
            .any(|s| s.enabled)
            || self.app_skills_snapshot().iter().any(|s| s.enabled)
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

    /// [`Self::enabled_for`] narrowed to the records that actually have something to
    /// serve ([`SkillRecord::is_loadable`]) — the **injection scope**.
    ///
    /// Deliberately a separate step rather than a filter inside `enabled_for`:
    /// `skills.load` resolves against `enabled_for` and *must still see* a body-less
    /// record, so it can refuse it by name ("registered by a plugin but its
    /// instructions are not installed on this node yet") instead of falling into the
    /// deliberately indistinguishable "no enabled skill with id" branch that exists to
    /// stop allowlist enumeration. Filtering one level down would have turned an
    /// honest diagnostic back into a shrug. So the cut lands here, at the two block
    /// builders, and Core's `skills_tool`/`catalog` doors apply the same
    /// [`SkillRecord::is_loadable`] predicate at their own edges.
    ///
    /// Private on purpose. Core cannot be switched onto this helper from here
    /// (`catalog.rs` and `skills_tool.rs` filter their own iterators), and a `pub`
    /// helper that only half the callers use would re-create the two-spellings
    /// problem at the API level. The shared thing is the *predicate*, not the sweep.
    ///
    /// **This widens when both block builders return `None`** — a registry whose only
    /// enabled skills are body-less now answers `None` where it used to answer an
    /// empty block. That is only safe because every consumer already treats `None` as
    /// "this turn has no skills" rather than as an error: the ACP arm of
    /// `adapters::route_agent_stream` leaves `long_term_system` untouched (covered by
    /// `acp_no_skill_block_leaves_preamble_unchanged`), and
    /// [`Self::inject_into_messages_filtered`] returns an empty id list without
    /// touching the messages. `has_enabled()` — which *would* now disagree with the
    /// blocks — has no production caller; it is test-only today.
    fn loadable_for(&self, allowlist: &[String]) -> Vec<SkillRecord> {
        self.enabled_for(allowlist)
            .into_iter()
            .filter(SkillRecord::is_loadable)
            .collect()
    }

    /// Build the combined skill-instruction block for an allowlist.
    ///
    /// Returns `(header_text, injected_ids)`, or `None` when nothing applies.
    /// Used by both the openai-compat injector and the ACP-prompt seam so the two
    /// planes share one source of truth for what a given agent's skill text is.
    ///
    /// Scoped by [`Self::loadable_for`], not `enabled_for`: a body-less record used to
    /// contribute a `## Skill: <name>` heading with nothing under it — a section that
    /// costs prompt tokens and teaches the model that this skill has no content.
    /// `injected_ids` (the `x-ryu-skill-ids` attribution) shrinks with it, which is
    /// the point: attribution should list what was actually injected.
    pub fn skill_block(&self, allowlist: &[String]) -> Option<(String, Vec<String>)> {
        let active = self.loadable_for(allowlist);
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
    /// `skills.load` tool. Returns `(text, injected_ids)` where `injected_ids`
    /// are the `always_on` skills whose full bodies are actually in context (for
    /// `x-ryu-skill-ids` attribution); the indexed-only skills are not attributed
    /// until loaded.
    ///
    /// Only meaningful where the turn has a tool loop (ACP plane); callers on a
    /// no-tool path must use [`Self::skill_block`] instead so skills aren't
    /// silently unreachable.
    ///
    /// **Deliberately NOT query-aware.** Ranking the L1 index against the user's
    /// message would obviously pick better than 20 skills, and it is still the
    /// wrong trade: this output is folded into `long_term_system` (see the ACP arm
    /// of `adapters::route_agent_stream`), i.e. it becomes the *system prefix* of
    /// every ACP turn. A query-dependent prefix changes on every message and busts
    /// the provider prompt cache each turn — paying full uncached input price on
    /// the largest, most repeated part of the request to reorder a list the model
    /// can already search. Query-aware selection belongs in the `skills.search`
    /// tool, which is per-call and caches nothing. What this function owes the
    /// caller instead is *determinism*: see [`scan_skill_dir_opts`].
    ///
    /// **Scoped by [`Self::loadable_for`], not `enabled_for`.** This is the loudest
    /// discovery surface there is: every id it lists arrives under a sentence telling
    /// the model to call `skills.load` with that id "before acting". Listing a
    /// body-less record here therefore *instructs* the model to make a call that
    /// `do_load` now refuses — a wasted round the model cannot avoid, on the one
    /// surface it cannot opt out of. (An `always_on` body-less record was worse still:
    /// it injected an empty `## Skill:` section outright.) The `SKILL_INDEX_CAP` cut
    /// below now also spends its 20 slots only on skills that can actually be loaded.
    pub fn progressive_block(&self, allowlist: &[String]) -> Option<(String, Vec<String>)> {
        let active = self.loadable_for(allowlist);
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
                 call the `skills.load` tool with its id to read its full instructions \
                 before acting, then follow them."
                    .to_owned(),
            ];
            for s in on_demand.iter().take(SKILL_INDEX_CAP) {
                let desc = s.description.as_deref().unwrap_or("(no description)");
                lines.push(format!("- {} — {}: {}", s.id, s.name, desc));
            }
            if on_demand.len() > SKILL_INDEX_CAP {
                lines.push(format!(
                    "...and {} more. Use the `skills.search` tool to find skills by task.",
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
    /// `RunnableKind` discriminant, always `"skill"`.
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

    /// Holds [`SKILLS_ENV_LOCK`] and restores `RYU_SKILLS_DIR` /
    /// `RYU_SKILLS_ACTIVE_FILE` to whatever they were, on drop.
    ///
    /// Both vars are process-global and three test modules (`skills`,
    /// `skills_catalog::from_source`, `sidecar::mcp::skills_tool`) point them at
    /// their own tempdirs, so a test that sets them must serialize on the lock *and*
    /// put back exactly what it found rather than blindly `remove_var`-ing an outer
    /// override it did not set.
    ///
    /// Restoring in `Drop` instead of at the end of the test body is the load-bearing
    /// part: a panic mid-test — a failed assertion, an `expect` on a registry block —
    /// skips trailing cleanup and leaves the vars pointing at a tempdir that is being
    /// deleted, which then surfaces as a flake in whichever *unrelated* test runs
    /// next in this binary. Same class of bug that `skills_catalog::plugin_skills`
    /// hit, and the same reason `skills_tool`'s `AuthorEnv` cleans up in `Drop`.
    /// `unwrap_or_else(into_inner)` matches the siblings: a poisoned lock means some
    /// other test panicked, which must not cascade.
    struct SkillsEnvGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        prev_dir: Option<std::ffi::OsString>,
        prev_active: Option<std::ffi::OsString>,
    }

    impl SkillsEnvGuard {
        fn new() -> Self {
            let lock = SKILLS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            Self {
                _lock: lock,
                prev_dir: std::env::var_os("RYU_SKILLS_DIR"),
                prev_active: std::env::var_os("RYU_SKILLS_ACTIVE_FILE"),
            }
        }
    }

    impl Drop for SkillsEnvGuard {
        fn drop(&mut self) {
            for (key, prev) in [
                ("RYU_SKILLS_DIR", self.prev_dir.take()),
                ("RYU_SKILLS_ACTIVE_FILE", self.prev_active.take()),
            ] {
                match prev {
                    Some(v) => std::env::set_var(key, v),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    const MINIMAL_SKILL_MD: &str = r#"---
name: "Minimal Skill"
---
Do something minimal.
"#;

    // ── App-contributed skills (plugin enable/disable) ───────────────────────────

    #[test]
    fn register_app_skill_is_listable_and_enabled() {
        // Hold the env lock and point RYU_SKILLS_DIR at an empty tempdir so the
        // `reload()` below reads zero disk skills (never the real ~/.claude/skills),
        // leaving only the one app-contributed skill. The guard restores the var even
        // if an assertion below panics.
        let _env = SkillsEnvGuard::new();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("RYU_SKILLS_DIR", dir.path());

        let reg = SkillRegistry::empty();
        assert!(reg.list_all().is_empty());
        assert!(!reg.has_enabled());

        reg.register_app_skill(
            "app__research".to_owned(),
            "Research".to_owned(),
            Some("App-registered skill".to_owned()),
        );

        assert_eq!(reg.list_all().len(), 1);
        assert!(reg.has_enabled(), "app skill defaults to enabled");
        assert_eq!(reg.enabled()[0].id, "app__research");
        // A disk reload must NOT wipe the app_skills bag.
        reg.reload();
        assert_eq!(
            reg.list_all().len(),
            1,
            "reload must not drop app-contributed skills"
        );
    }

    #[test]
    fn register_app_skill_is_idempotent_and_unregister_is_symmetric() {
        let reg = SkillRegistry::empty();
        reg.register_app_skill("app__x".to_owned(), "X".to_owned(), None);
        reg.register_app_skill("app__x".to_owned(), "X (v2)".to_owned(), None);
        assert_eq!(
            reg.list_all().len(),
            1,
            "re-register replaces, not duplicates"
        );
        assert_eq!(reg.list_all()[0].name, "X (v2)");

        reg.unregister_app_skill("app__x");
        assert!(reg.list_all().is_empty());
        // Unregistering a missing id is a no-op.
        reg.unregister_app_skill("app__missing");
    }

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

    // NOTE: `SkillRecord`'s `Runnable` impl lives in `apps/core` (the trait is
    // Core-local), so its `skill_record_implements_runnable` test moved to Core's
    // `skills_host.rs` alongside the impl.

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
            text.contains("skills.load"),
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

    /// A body-less record must not be advertised by either injected block, and must
    /// not eat an `always_on` slot — while its loadable siblings are untouched.
    ///
    /// Both shapes appear here because both producers are real (see
    /// [`SkillRecord::is_loadable`]): `hollow` is a front-matter-only `SKILL.md`
    /// (the disk producer) and it is `always-on`, which is the case
    /// `register_app_skill` cannot construct because it hardcodes `always_on: false`.
    /// Before this rule reached the block builders, `hollow` injected a literal
    /// `## Skill: Hollow` heading with nothing under it and claimed an
    /// `x-ryu-skill-ids` attribution for text that was never sent.
    #[test]
    fn a_body_less_record_is_in_neither_injected_block() {
        let hollow = parse_skill_md(
            "hollow",
            "---\nname: \"Hollow\"\ndescription: \"promises nothing\"\nalways-on: true\n---\n",
        )
        .unwrap();
        assert_eq!(
            hollow.instructions, "",
            "front-matter only parses to no body"
        );
        assert!(!hollow.is_loadable());

        let real = parse_skill_md(
            "real",
            "---\nname: \"Real\"\ndescription: \"does a thing\"\n---\nReal body.",
        )
        .unwrap();
        assert!(real.is_loadable());

        let registry = registry_of(vec![hollow, real]);

        // `enabled_for` is deliberately unfiltered: `skills.load` resolves against it
        // so it can refuse a body-less id by name. Only the blocks narrow.
        assert_eq!(registry.enabled_for(&[]).len(), 2);

        let (progressive, injected) = registry.progressive_block(&[]).expect("a block");
        assert!(
            !progressive.contains("Hollow"),
            "a body-less record must not be named in the L1 index or injected \
             always-on: {progressive}"
        );
        assert!(
            injected.is_empty(),
            "nothing was injected, so nothing may be attributed: {injected:?}"
        );
        assert!(
            progressive.contains("- real — Real: does a thing"),
            "the loadable sibling is still indexed: {progressive}"
        );

        let (full, ids) = registry.skill_block(&[]).expect("a block");
        assert!(!full.contains("Hollow"), "{full}");
        assert!(full.contains("Real body."), "{full}");
        assert_eq!(ids, vec!["real".to_owned()]);
    }

    /// A plugin-contributed record with nothing behind it yet is invisible to both
    /// blocks — including when it is the only skill, where the blocks must say "no
    /// skills" rather than emit an empty section.
    ///
    /// It stays listable and `has_enabled()`-true on purpose: `GET /api/skills`
    /// (`api::list_skills` → [`Self::list_all`]) is the skills-library inventory and
    /// must keep showing the plugin's contribution, and `skills.load` must still
    /// find it to explain why it cannot be loaded. Only the injected surfaces filter,
    /// so the user-visible inventory and the model-visible offer legitimately differ —
    /// which is why the assertions below pin *both* sides.
    #[test]
    fn a_body_less_app_skill_is_advertised_by_no_block() {
        let reg = SkillRegistry::empty();
        reg.register_app_skill(
            "app__summarize".to_owned(),
            "Summarize".to_owned(),
            Some("App-registered skill (skill_id: summarize)".to_owned()),
        );

        assert_eq!(reg.list_all().len(), 1, "still listable in the library");
        assert!(reg.has_enabled(), "the app bag is untouched");
        assert_eq!(
            reg.enabled_for(&[]).len(),
            1,
            "`load` must still see it to refuse it by name"
        );

        assert!(
            reg.progressive_block(&[]).is_none(),
            "an index of only-unloadable skills is worse than no index"
        );
        assert!(reg.skill_block(&[]).is_none());

        // The same id, materialised on disk, is a normal skill again — the rule is
        // about the body, not about the `app__` prefix.
        let materialised = parse_skill_md(
            "app__summarize",
            "---\nname: \"Summarize\"\ndescription: \"summarize a thread\"\n---\nSummarize it.",
        )
        .unwrap();
        let with_disk = registry_of(vec![materialised]);
        let (text, _) = with_disk.progressive_block(&[]).expect("a block");
        assert!(
            text.contains("- app__summarize — Summarize: summarize a thread"),
            "{text}"
        );
        let (full, ids) = with_disk.skill_block(&[]).expect("a block");
        assert!(full.contains("Summarize it."), "{full}");
        assert_eq!(ids, vec!["app__summarize".to_owned()]);
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
    fn scan_is_sorted_by_id_regardless_of_creation_order() {
        // Create the dirs in reverse-alphabetical order so a scanner that just
        // echoed `read_dir` would very likely come back unsorted on a filesystem
        // that enumerates by creation order. The mixed flat/dir set also proves the
        // sort happens after the flat entries are merged in, not before.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for id in ["zeta", "mid", "alpha"] {
            let dir = root.join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), format!("---\nname: {id}\n---\nbody")).unwrap();
        }
        std::fs::write(root.join("nova.md"), "---\nname: Nova\n---\nbody").unwrap();

        let ids: Vec<String> = scan_skill_dir(root).into_iter().map(|s| s.id).collect();
        assert_eq!(
            ids,
            vec![
                "alpha".to_owned(),
                "mid".to_owned(),
                "nova".to_owned(),
                "zeta".to_owned()
            ],
            "scan must return a stable id-sorted order, not filesystem order"
        );
    }

    #[test]
    fn progressive_index_cut_is_stable_across_reloads() {
        // The defect this guards: `progressive_block` shows only the first
        // SKILL_INDEX_CAP on-demand skills, so an unsorted scan made *which* skills
        // the model can see depend on filesystem enumeration order. With a sorted
        // scan the cut is the alphabetically-first CAP ids, every time.
        // Save/restore via the guard, not a trailing `remove_var`: the `expect("block")`
        // calls below can panic, and a bare removal on the happy path only would leak
        // both vars into every later test in this binary.
        let _env = SkillsEnvGuard::new();
        let tmp = tempfile::tempdir().unwrap();
        let active = tmp.path().join("active.json");
        // More skills than the index cap, created in an order unrelated to their ids.
        let total = SKILL_INDEX_CAP + 5;
        let mut ids: Vec<String> = (0..total).map(|i| format!("skill-{i:03}")).collect();
        for id in ids.iter().rev() {
            let dir = tmp.path().join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), format!("---\nname: {id}\n---\nbody")).unwrap();
        }
        ids.sort();
        std::fs::write(&active, serde_json::to_string(&ids).unwrap()).unwrap();
        std::env::set_var("RYU_SKILLS_DIR", tmp.path());
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", &active);

        let registry = SkillRegistry::empty();
        registry.reload();
        let (first, _) = registry.progressive_block(&[]).expect("block");
        registry.reload();
        let (second, _) = registry.progressive_block(&[]).expect("block");

        assert_eq!(first, second, "the injected index must be reload-stable");
        for id in ids.iter().take(SKILL_INDEX_CAP) {
            assert!(first.contains(id), "expected {id} in the index:\n{first}");
        }
        for id in ids.iter().skip(SKILL_INDEX_CAP) {
            assert!(
                !first.contains(id),
                "{id} sorts past the cap and must not be indexed:\n{first}"
            );
        }
    }

    #[test]
    fn scan_missing_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        assert!(scan_skill_dir(&missing).is_empty());
    }

    #[test]
    fn agents_root_ignores_flat_md_but_keeps_dirs() {
        // The vendor-neutral `~/.agents/skills` root scans dirs only: a root-level
        // `<id>.md` is NOT a skill there (Agent Skills spec), while `<id>/SKILL.md`
        // still is.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let dir = root.join("gamma");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: Gamma\n---\nbody").unwrap();
        // A stray flat markdown file that must be ignored under this root.
        std::fs::write(root.join("delta.md"), "---\nname: Delta\n---\nbody").unwrap();

        let ids: Vec<String> = scan_skill_dir_opts(root, false)
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(
            ids,
            vec!["gamma".to_owned()],
            "flat .md ignored under agents root"
        );

        // The same tree WITH flat support enabled picks up both.
        let mut both: Vec<String> = scan_skill_dir_opts(root, true)
            .into_iter()
            .map(|s| s.id)
            .collect();
        both.sort();
        assert_eq!(both, vec!["delta".to_owned(), "gamma".to_owned()]);
    }

    /// The namespace predicate `skills.author` guards creates with.
    ///
    /// Root-explicit on purpose: the two standard roots are not individually
    /// env-overridable (`RYU_SKILLS_DIR` collapses the list to one root), and the only
    /// other lever — `$HOME`, which `dirs::home_dir` reads first on unix — is resolved
    /// by ~20 other `ryu-core` call sites in the same multi-threaded test binary, so
    /// pointing it at a tempdir would be a flake vector for unrelated tests. Passing
    /// roots in covers the two behaviours that make the write path's `dest.exists()`
    /// wrong: an id owned only by root two is still taken, and within a root the
    /// directory form beats a legacy flat `<id>.md`.
    #[test]
    fn resolve_skill_md_spans_every_root_and_both_layouts() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();

        let write_dir_skill = |root: &std::path::Path, id: &str| {
            let dir = root.join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), "---\nname: X\n---\nbody").unwrap();
            dir.join("SKILL.md")
        };

        // Root one (flat honoured): a shared id, a flat-only id, and an id that
        // exists in both layouts.
        let shared_one = write_dir_skill(one.path(), "shared");
        std::fs::write(one.path().join("flat.md"), "---\nname: F\n---\nb").unwrap();
        let dup_dir = write_dir_skill(one.path(), "dup");
        std::fs::write(one.path().join("dup.md"), "---\nname: D\n---\nb").unwrap();

        // Root two (dirs only, mirroring `~/.agents/skills`): the same shared id plus
        // one it alone owns, and a flat file that is not a skill there.
        write_dir_skill(two.path(), "shared");
        write_dir_skill(two.path(), "ecosystem");
        std::fs::write(two.path().join("agents-flat.md"), "---\nname: A\n---\nb").unwrap();

        let roots = vec![
            (one.path().to_path_buf(), true),
            (two.path().to_path_buf(), false),
        ];

        assert_eq!(
            resolve_skill_md_in(&roots, "shared").as_deref(),
            Some(shared_one.as_path()),
            "first root wins, so root one's file is what loads"
        );
        assert!(
            resolve_skill_md_in(&roots, "ecosystem").is_some(),
            "an id owned only by the second root is still taken: writing it into root \
             one would shadow it"
        );
        assert_eq!(
            resolve_skill_md_in(&roots, "flat").as_deref(),
            Some(one.path().join("flat.md").as_path()),
            "the legacy flat layout takes an id too"
        );
        assert_eq!(
            resolve_skill_md_in(&roots, "dup").as_deref(),
            Some(dup_dir.as_path()),
            "within a root the directory form beats the flat file"
        );
        assert!(
            resolve_skill_md_in(&roots, "agents-flat").is_none(),
            "a flat .md under the dirs-only root is not a skill, so its id is free"
        );
        assert!(resolve_skill_md_in(&roots, "nobody").is_none());

        // Membership must agree with the deduped scan every consumer reads.
        let mut scanned: Vec<String> = roots
            .iter()
            .flat_map(|(d, flat)| scan_skill_dir_opts(d, *flat))
            .map(|s| s.id)
            .collect();
        scanned.sort();
        scanned.dedup();
        for id in &scanned {
            assert!(
                resolve_skill_md_in(&roots, id).is_some(),
                "every scanned id must resolve: {id}"
            );
        }
    }

    /// The public entry point honours the `RYU_SKILLS_DIR` override, i.e. the single
    /// root a test/installer node runs with is the namespace there.
    #[test]
    fn resolve_skill_md_honours_the_single_root_override() {
        let _env = SkillsEnvGuard::new();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("solo.md"), "---\nname: S\n---\nb").unwrap();
        std::env::set_var("RYU_SKILLS_DIR", dir.path());

        assert_eq!(
            resolve_skill_md("solo").as_deref(),
            Some(dir.path().join("solo.md").as_path())
        );
        assert!(resolve_skill_md("absent").is_none());
    }

    #[test]
    fn scan_roots_honour_override_then_fall_back_to_two_standard_dirs() {
        let _env = SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let prev = std::env::var_os("RYU_SKILLS_DIR");

        // Override → exactly one root, flat layout honoured.
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("RYU_SKILLS_DIR", tmp.path());
        let roots = skills_scan_roots();
        assert_eq!(roots.len(), 1, "override collapses to a single root");
        assert_eq!(roots[0].0, tmp.path());
        assert!(roots[0].1, "override root honours flat .md");

        // No override → the two standard roots, agents dir second and dirs-only.
        std::env::remove_var("RYU_SKILLS_DIR");
        let roots = skills_scan_roots();
        assert_eq!(roots.len(), 2, "claude + agents roots");
        assert_eq!(roots[0].0, default_skills_dir());
        assert!(roots[0].1, "claude root honours flat .md");
        assert_eq!(roots[1].0, agents_skills_dir());
        assert!(!roots[1].1, "agents root is dirs-only");

        match prev {
            Some(v) => std::env::set_var("RYU_SKILLS_DIR", v),
            None => std::env::remove_var("RYU_SKILLS_DIR"),
        }
    }

    // One test owns the process-global skills env vars to avoid races with any
    // other test that might read them; it exercises the activation round-trip and
    // the reload gate together.
    #[test]
    fn activation_set_gates_injection() {
        let _env = SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
        try_set_active("active-one", true).unwrap();
        try_set_active("dormant-two", true).unwrap();
        try_set_active("dormant-two", false).unwrap();
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
