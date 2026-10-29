//! **Output styles** — Ryu's port of Claude Code output styles (`docs/output-styles.md`).
//!
//! An output style changes *how* an agent answers — role, tone, default response
//! shape — by editing the system prompt for the turn. It never changes what the
//! agent knows, which tools it has, or which model runs. The body is prose, never
//! code: nothing in this crate (or downstream of it) evaluates it, which is why a
//! style needs zero capability grants — the same argument `ThemeContribution`
//! makes for themes.
//!
//! This module owns:
//! - the file format ([`parse_output_style_md`]) — YAML frontmatter + Markdown body,
//!   byte-compatible with a Claude Code output style;
//! - the four-source merge ([`OutputStyleRegistry`]) — plugin contributions, the
//!   user root, project roots, managed settings, later sources winning;
//! - the legacy node-default selection ([`load_selection`] / [`set_selection`]),
//!   retained only for upgrade compatibility;
//! - the text actually injected into the system prompt ([`style_block`]).
//!
//! **What it deliberately does NOT own.** `keep-coding-instructions` is surfaced
//! faithfully on the record and interpreted nowhere in here: per design §2 it
//! decides whether the style body *replaces* or is *appended after* the agent's
//! base instructions, and that assembly happens at the injection seams in
//! `apps/core/src/sidecar/adapters/mod.rs`. [`style_block`] returns body + adherence
//! reminder; the caller owns the merge. Agent assignment resolves in Core, which
//! holds the request and the agent record; this crate supplies the style registry
//! and the [`OutputStyleRegistry::forced_style`] override that beats the caller's
//! selection.
//!
//! Core-vs-crate rule: like `ryu-skills`, this crate has **ZERO dependency on
//! `apps/core`**. The Ryu data folder is inverted in via [`set_data_dir`], and the
//! live registry is published to a process-global handle via [`set_global_registry`]
//! so the HTTP handlers in [`api`] reach it without a `State` extractor.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, RwLock},
};

use serde::{Deserialize, Serialize};

pub mod api;
pub mod store;

pub use api::{routes, OutputStylesCtx};

/// Process-wide lock for tests that mutate the global [`ENV_OUTPUT_STYLES_DIR`] /
/// [`ENV_SELECTION_FILE`] env vars.
///
/// Both vars are process-global, so two tests pointing them at their own tempdirs
/// in parallel have one test's `remove_var` clobber the other's `set_var` — and the
/// write then falls through to the developer's real `~/.claude/output-styles`. Every
/// test that touches them must hold this. Exposed `pub` (not `#[cfg(test)]`-gated)
/// for the same reason `ryu_skills::SKILLS_ENV_LOCK` is: a `#[cfg(test)]` static does
/// not cross a crate boundary, so a Core-side test that redirects these vars needs to
/// hold the *same* lock. The cost is one always-compiled zero-sized mutex.
pub static OUTPUT_STYLES_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Explicit override collapsing the whole scan to one user-owned directory. Mirrors
/// `RYU_SKILLS_DIR`: it is the knob the user (and every test) owns, so it wins over
/// the derived roots *and* suppresses the project/managed tiers — otherwise a test
/// pointing at a tempdir would still pick up whatever `.claude/output-styles` happens
/// to sit above its working directory.
pub const ENV_OUTPUT_STYLES_DIR: &str = "RYU_OUTPUT_STYLES_DIR";

/// The override the Claude CLI itself reads for its config root; honoured here so a
/// user who has already relocated `~/.claude` does not have to relocate it twice.
/// Mirrors `native_history::claude_projects_root` and `ryu_usage::claude`.
pub const ENV_CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";

/// Test/ops override for the node-default selection file (see [`selection_path`]).
pub const ENV_SELECTION_FILE: &str = "RYU_OUTPUT_STYLE_FILE";

/// Directory name for a styles root, under both `<claude-dir>` and `<project>/.claude`.
const STYLES_DIR_NAME: &str = "output-styles";

// ── Data-dir seam (inverts `apps/core`'s `paths::ryu_dir()`) ─────────────────────
//
// Two Ryu-local things resolve against the data folder: the node-default selection
// file, and the profile-aware derivation of the user styles root (see
// `user_output_styles_dir`). Rather than depend on `apps/core`, the crate reads the
// folder from a process-global set once at startup by Core
// (`ryu_output_styles::set_data_dir(paths::ryu_dir())`), exactly as `ryu_skills`
// does. When unset it falls back to the same pointer- and profile-aware
// resolution every Ryu process uses (`ryu_sidecar_runtime::ryu_dir`).

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Publish the Ryu data folder. Idempotent; a second call is ignored. Core calls this
/// at startup **before** [`OutputStyleRegistry::load`] so the selection file and the
/// user styles root resolve against the real (possibly relocated, possibly
/// profile-suffixed) data dir rather than the fallback.
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

// ── Global registry (read by the `/api/output-styles` handlers) ──────────────────
//
// The handlers in `api.rs` are State-free named fns reading the live registry from
// this process-global handle, published by Core from its one instance at startup.
// The registry is `Arc`-backed, so the global and every Core-side clone share one
// inner `RwLock`: a handler's `reload()` is visible to the chat-turn injection and
// vice versa.

static REGISTRY: OnceLock<OutputStyleRegistry> = OnceLock::new();

/// Publish the process-global output-style registry. Idempotent; a second call is
/// ignored.
pub fn set_global_registry(registry: OutputStyleRegistry) {
    let _ = REGISTRY.set(registry);
}

/// The process-global output-style registry, if Core has published one.
pub fn global_registry() -> Option<&'static OutputStyleRegistry> {
    REGISTRY.get()
}

// ── The file format ──────────────────────────────────────────────────────────────
//
// ```markdown
// ---
// name: ELI5
// description: keep it simple pls
// keep-coding-instructions: true
// ---
//
// It's been a long day and my brain is fried, talk to me like I'm 5.
// ```
//
// Byte-compatible with a Claude Code output style, so a file copied out of
// `~/.claude/output-styles` works here unchanged and vice-versa. The YAML keys are
// KEBAB-case because that is the shape upstream defined; renaming them to snake_case
// would break exactly the interop that is the point of the port.

/// Parsed frontmatter from an output-style `.md` file.
///
/// Unknown keys are **tolerated, not rejected** (no `deny_unknown_fields`): a style
/// authored against a newer schema degrades to "the fields we understand" instead of
/// failing to load, which matters because these files are hand-authored and shared
/// between two products that version independently.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct OutputStyleFrontMatter {
    /// Display name in the picker. Optional here even though the table in design §1
    /// calls it a string: the documented default is the file stem, so a body-only
    /// file is still a valid style (see [`parse_output_style_md`]).
    #[serde(default)]
    pub name: Option<String>,
    /// One-liner shown under the name in the picker.
    #[serde(default)]
    pub description: Option<String>,
    /// Keep the agent's own base instructions instead of replacing them. Defaults to
    /// `false`, matching upstream — see [`OutputStyleRecord::keep_coding_instructions`]
    /// for what it binds to in Ryu and who acts on it.
    #[serde(default, rename = "keep-coding-instructions")]
    pub keep_coding_instructions: bool,
    /// Plugin-shipped styles only: apply automatically while the plugin is enabled.
    /// Honoured only for [`OutputStyleSource::Plugin`] records — see
    /// [`OutputStyleRegistry::forced_style`].
    #[serde(default, rename = "force-for-plugin")]
    pub force_for_plugin: bool,
}

// ── OutputStyleRecord ────────────────────────────────────────────────────────────

/// Where a style came from — which also fixes its precedence in the merge and
/// whether this crate may write to it.
///
/// The ordering of the variants is the merge order (lowest precedence first), and
/// [`OutputStyleSource::rank`] is the one place that is spelled out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStyleSource {
    /// Compiled into Core, with no package home — the shape the Core-only entries in
    /// `plugin_manifest/fixtures/` have. **Nothing produces this today**: the shipped
    /// built-ins (design §8) are contributed by the `@ryu/output-styles` *plugin* and
    /// therefore arrive as [`OutputStyleSource::Plugin`]. The variant exists so a
    /// future Core-owned default is expressible without widening this enum under
    /// every downstream `match`.
    Builtin,
    /// `contributes.output_styles[]` of an enabled plugin, registered in-memory via
    /// [`OutputStyleRegistry::register_plugin_style`]. Read-only: the package tree is
    /// signed, and on a user's machine a built-in plugin has no package tree at all.
    Plugin,
    /// `<claude-dir>/output-styles/*.md` — the one root this crate writes to
    /// ([`store`]).
    User,
    /// `<project>/.claude/output-styles/*.md`, from every directory between the
    /// working directory and the repo root. Writable in principle (design §3) but not
    /// through this crate's authoring surface, which has a single write target.
    Project,
    /// Managed-settings `output-styles/*.md`, pushed by an administrator. Read-only,
    /// and highest precedence so a managed style cannot be shadowed by a user file.
    Managed,
}

impl OutputStyleSource {
    /// Precedence rank; higher wins on an id collision. The merge is "later sources
    /// win" (design §3), so this is the sort key every merge path uses instead of
    /// re-deriving the order from the sequence roots happen to be scanned in.
    pub fn rank(self) -> u8 {
        match self {
            Self::Builtin => 0,
            Self::Plugin => 1,
            Self::User => 2,
            Self::Project => 3,
            Self::Managed => 4,
        }
    }

    /// Whether [`store`] may create/update/delete this style's file in place. Only
    /// the user root is writable; editing anything else *forks* it into the user root
    /// (design §6), which is a create, not a mutation.
    pub fn is_writable(self) -> bool {
        matches!(self, Self::User)
    }

    /// Stable wire discriminant (`"plugin"`, `"user"`, …) for the HTTP surface.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Plugin => "plugin",
            Self::User => "user",
            Self::Project => "project",
            Self::Managed => "managed",
        }
    }
}

/// A parsed output style: the frontmatter metadata plus the prose body that gets
/// appended to the system prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputStyleRecord {
    /// Stable id — the filename stem (`eli5.md` → `eli5`) for a disk style, or the
    /// manifest's `output_styles[].id` for a plugin one. The id, not the name, is what
    /// the selection persists, so renaming a style in its frontmatter never orphans a
    /// selection.
    pub id: String,
    /// Display name from the frontmatter, falling back to the id (which is the file
    /// stem) when the frontmatter omits it or has none.
    pub name: String,
    /// One-liner under the name in the picker.
    pub description: Option<String>,
    /// Everything after the closing `---`: the prose appended to the system prompt.
    /// Never evaluated — see the module docs on why a style needs zero grants.
    pub body: String,
    /// Keep the agent's own base instructions (`system_prompt` on the agent record)
    /// instead of replacing them.
    ///
    /// **This crate does not act on it.** Upstream the flag gates Claude Code's
    /// built-in software-engineering block; Ryu has no such block, so design §2 binds
    /// it to the closest separable thing we do have — `true` appends the style body
    /// after the agent's base instructions, `false` (the default) replaces them. That
    /// assembly happens at the injection seams in
    /// `apps/core/src/sidecar/adapters/mod.rs`; here the flag is carried faithfully
    /// and nothing more, so there is exactly one place that decides replace-vs-append.
    pub keep_coding_instructions: bool,
    /// Apply this style automatically while its plugin is enabled, overriding all
    /// selection tiers. Parsed from any source (the frontmatter struct cannot
    /// know where a file came from) but **honoured only for
    /// [`OutputStyleSource::Plugin`]** — see [`OutputStyleRegistry::forced_style`].
    pub force_for_plugin: bool,
    /// Provenance, which also fixes precedence and writability.
    pub source: OutputStyleSource,
    /// The `.md` this was read from, or `None` for a plugin contribution (whose body
    /// arrives inline in the manifest and has no path on the user's machine). This is
    /// the discriminant `GET /:id/source` uses to decide between reading the file and
    /// serving the registered text.
    pub path: Option<PathBuf>,
}

impl OutputStyleRecord {
    /// Whether this style has anything to inject.
    ///
    /// A frontmatter-only file parses into a record with an empty body — legal to
    /// list (it has a name and a description) but pointless to inject. Every surface
    /// that *offers* a style to the model funnels through [`style_block`], which
    /// applies this predicate, so a body-less style can never contribute a bare
    /// adherence reminder telling the model to follow instructions that are not there.
    pub fn has_body(&self) -> bool {
        !self.body.trim().is_empty()
    }
}

// ── Parsing ──────────────────────────────────────────────────────────────────────

/// Parse an output-style `.md` into an [`OutputStyleRecord`], as
/// [`OutputStyleSource::User`].
///
/// **This is the one parser** for disk styles and plugin-contributed styles alike
/// (design §4): a plugin's `output_styles[].file` is hydrated into an inline `source`
/// carrying the *whole file*, frontmatter included, precisely so there is no second,
/// drifting spelling of the format. Callers that know better set
/// [`OutputStyleRecord::source`] afterwards — [`OutputStyleRegistry`] does exactly
/// that, and [`parse_output_style_md_from`] is the pre-tagged convenience form.
///
/// Returns `Err` only on malformed YAML. A missing `name` is **not** an error: design
/// §1 defines the default as the file stem, so a file that is nothing but prose is a
/// valid style whose name is its id. That tolerance is deliberate — these files are
/// hand-written, and refusing one on a missing optional would make the picker's
/// contents depend on how carefully somebody typed YAML.
pub fn parse_output_style_md(id: &str, content: &str) -> Result<OutputStyleRecord, String> {
    parse_output_style_md_from(id, content, OutputStyleSource::User)
}

/// [`parse_output_style_md`] with the provenance known up front.
pub fn parse_output_style_md_from(
    id: &str,
    content: &str,
    source: OutputStyleSource,
) -> Result<OutputStyleRecord, String> {
    let (front_raw, body) = split_front_matter(content)?;

    let fm: OutputStyleFrontMatter = if front_raw.trim().is_empty() {
        OutputStyleFrontMatter::default()
    } else {
        noyalib::compat::serde_yaml::from_str(&front_raw)
            .map_err(|e| format!("YAML parse error in output style '{id}': {e}"))?
    };

    let name = fm
        .name
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| id.to_owned());

    Ok(OutputStyleRecord {
        id: id.to_owned(),
        name,
        description: fm
            .description
            .map(|d| d.trim().to_owned())
            .filter(|d| !d.is_empty()),
        body: body.trim().to_owned(),
        keep_coding_instructions: fm.keep_coding_instructions,
        force_for_plugin: fm.force_for_plugin,
        source,
        path: None,
    })
}

/// Split an output-style file into `(frontmatter_yaml, body)`.
///
/// Accepts both `---\n…\n---\nbody` and a bare body. The tolerance is copied
/// deliberately from `ryu_skills::split_front_matter`, including the two odd arms —
/// a file with no closing `---` is read as all-frontmatter-no-body rather than
/// rejected — so the two Markdown-with-frontmatter formats Ryu reads behave
/// identically at the edges instead of one silently accepting what the other refuses.
pub(crate) fn split_front_matter(content: &str) -> Result<(String, String), String> {
    let trimmed = content.trim_start();

    if !trimmed.starts_with("---") {
        // No frontmatter: the whole file is the body.
        return Ok((String::new(), content.to_owned()));
    }

    let after_opener = match trimmed.find('\n') {
        Some(pos) => &trimmed[pos + 1..],
        None => return Err("output style starts with '---' but has no content".to_owned()),
    };

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
        None => Ok((after_opener.to_owned(), String::new())),
    }
}

// ── Injection ────────────────────────────────────────────────────────────────────

/// The adherence reminder appended after every injected style body.
///
/// Upstream triggers a reminder on *every* output-style injection, and the reason is
/// empirical rather than decorative: without one, a long conversation drifts back to
/// the model's default voice a few turns in and the user concludes the picker did
/// nothing. Kept to two sentences — this rides in the system prefix of every turn, so
/// it is paid for on each request.
const ADHERENCE_REMINDER: &str = "The instructions above are your output style: they \
govern how you write every reply in this conversation, not just the next one. Keep \
following them even in long, multi-step, or heavily technical answers.";

/// The text injected into the system prompt for `record` — its body plus the
/// adherence reminder (design §5).
///
/// A **free function, not a method** on [`OutputStyleRegistry`]: agent assignment has
/// already resolved to one record by the time an injection seam calls this, so the
/// block builder needs no registry state, and keeping it free means the per-turn
/// `ChatRequest.output_style` path can build a block without touching the global
/// handle.
///
/// Returns an **empty string** when the record has no body ([`OutputStyleRecord::has_body`]),
/// so a frontmatter-only style injects nothing rather than a reminder pointing at
/// instructions that do not exist. Callers should treat empty as "no style this turn".
///
/// What this deliberately does *not* do is merge with the agent's base instructions:
/// `keep-coding-instructions` decides replace-vs-append and that belongs to the
/// caller (see [`OutputStyleRecord::keep_coding_instructions`]).
pub fn style_block(record: &OutputStyleRecord) -> String {
    if !record.has_body() {
        return String::new();
    }
    format!("{}\n\n{ADHERENCE_REMINDER}", record.body.trim())
}

// ── Disk layout ──────────────────────────────────────────────────────────────────

/// The user styles root: `<claude-dir>/output-styles`.
///
/// Resolution ladder, tightest constraint first:
///
/// 1. `RYU_OUTPUT_STYLES_DIR` — the explicit knob the user owns, mirroring
///    `RYU_SKILLS_DIR`. Used as-is (it names the styles dir itself, not a claude dir).
/// 2. `CLAUDE_CONFIG_DIR`/`output-styles` — the same override the Claude CLI itself
///    reads, honoured for the same reason `native_history` and `ryu_usage` honour it:
///    a user who already relocated their Claude config should not have to say so
///    twice.
/// 3. **Derived from the injected data dir**, profile-aware: `~/.ryu` ⇒ `~/.claude`,
///    `~/.ryu-dev` ⇒ `~/.claude-dev`.
///
/// Step 3 is the part worth explaining. `ryu_skills` hardcodes `~/.claude` and that is
/// right for *its* root, which is a shared directory other agents also populate. This
/// root is different: it is read-write and Ryu-owned — [`store`] creates, updates and
/// deletes files in it — so a dev stack pointed at it would mutate the release stack's
/// styles, which is exactly the state-bleed `RYU_PROFILE` exists to prevent. Deriving
/// the suffix from the data dir keeps the release profile landing on plain `~/.claude`
/// (so the byte-compatibility claim in design §1 holds where it matters, since that is
/// the only profile an end user runs) while giving `bun dev` its own root.
///
/// **Known hole:** the suffix can only be inferred when the data dir is still named
/// `.ryu<suffix>`. `RYU_DIR=/somewhere/else` *together with* a non-release profile
/// yields no inferable suffix and falls back to `~/.claude`. `bun dev` defaults the
/// data dir to `~/.ryu-dev` rather than setting `RYU_DIR`, so the normal dev path is
/// covered; the escape hatch for the rest is `RYU_OUTPUT_STYLES_DIR`. A second
/// injection seam for the claude dir would be a better fix and a worse trade — one
/// more thing Core must remember to publish before the registry loads.
pub fn user_output_styles_dir() -> PathBuf {
    if let Some(p) = non_empty_env(ENV_OUTPUT_STYLES_DIR) {
        return p;
    }
    if let Some(p) = non_empty_env(ENV_CLAUDE_CONFIG_DIR) {
        return p.join(STYLES_DIR_NAME);
    }
    claude_dir_from_data_dir().join(STYLES_DIR_NAME)
}

/// Read an env var as a path, treating unset and empty as absent.
fn non_empty_env(key: &str) -> Option<PathBuf> {
    let v = std::env::var_os(key)?;
    let p = PathBuf::from(v);
    (!p.as_os_str().is_empty()).then_some(p)
}

/// `<data-dir parent>/.claude<profile suffix>`, the derivation described in
/// [`user_output_styles_dir`].
///
/// The suffix is taken from the data dir's own folder name and only when it actually
/// starts with `.ryu` **and** the remainder is empty or begins with `-`. Requiring the
/// dash is what stops a hypothetical `.ryusomething` from silently becoming
/// `.claudesomething`.
fn claude_dir_from_data_dir() -> PathBuf {
    let data = data_dir();
    let home = || {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".claude")
    };
    let (Some(parent), Some(name)) = (data.parent(), data.file_name().and_then(|n| n.to_str()))
    else {
        return home();
    };
    let Some(suffix) = name.strip_prefix(".ryu") else {
        return home();
    };
    if !(suffix.is_empty() || suffix.starts_with('-')) {
        return home();
    }
    parent.join(format!(".claude{suffix}"))
}

/// The managed-settings styles root, or `None` when there is none.
///
/// Always `None` today, and deliberately so: design §3 lists a managed tier, but this
/// tree has **no managed-settings path resolver at all** (`grep managed.settings`
/// finds one unrelated comment in `pi_config`). Guessing a location would ship a root
/// that silently never matches — indistinguishable from a broken scan the first time
/// an administrator actually pushes a file. [`OutputStyleSource::Managed`] stays in the
/// enum so downstream `match`es are written against the final shape; wiring this up is
/// one function body once the resolver exists.
pub fn managed_output_styles_dir() -> Option<PathBuf> {
    None
}

/// Project styles roots: every `<dir>/.claude/output-styles` between the working
/// directory and the repo root.
///
/// **Returned farthest-first, and that inversion is the point.** Design §3 says
/// "nearest to the working directory wins", while the global merge is "later sources
/// win" — so the nearest directory has to come *last*. Emitting them in the order the
/// merge consumes them keeps that reconciliation in one place instead of leaving every
/// caller to remember to reverse the walk.
///
/// The walk stops after the first directory containing `.git` — design §3's "repo
/// root". With no `.git` anywhere above it, it does walk every ancestor to the
/// filesystem root; that is the honest reading of "between the working directory and
/// the repo root" when there is no repo, and each step is one `read_dir` of a
/// directory that almost never exists.
pub fn project_output_styles_dirs(cwd: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for dir in cwd.ancestors() {
        roots.push(dir.join(".claude").join(STYLES_DIR_NAME));
        if dir.join(".git").exists() {
            break;
        }
    }
    roots.reverse();
    roots
}

/// A style discovered inside one directory: its stable id and the file to read.
pub struct InstalledOutputStylePath {
    /// Stable id — the filename stem.
    pub id: String,
    /// Absolute path to the `<id>.md`.
    pub path: PathBuf,
}

/// A style discovered by [`scan_all_output_style_dirs`], tagged with the tier it came
/// from so the loader can set [`OutputStyleRecord::source`] without re-deriving it.
pub struct DiscoveredOutputStyle {
    pub id: String,
    pub path: PathBuf,
    pub source: OutputStyleSource,
}

/// Scan one directory for `*.md` output styles (flat layout — a style is a single
/// file, unlike a skill's directory-with-resources).
///
/// **The result is sorted by id.** `read_dir` yields entries in filesystem order,
/// which is stable on one machine and arbitrary across machines; sorting here is what
/// makes "which of two same-id files won" reproducible, and it is the single choke
/// point every disk-derived consumer funnels through.
pub fn scan_output_style_dir(dir: &Path) -> Vec<InstalledOutputStylePath> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!("output-styles directory {} does not exist", dir.display());
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!(
                "could not scan output-styles directory {}: {e}",
                dir.display()
            );
            return Vec::new();
        }
    };

    let mut found: Vec<InstalledOutputStylePath> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        found.push(InstalledOutputStylePath { id, path });
    }
    found.sort_by(|a, b| a.id.cmp(&b.id));
    found
}

/// The ordered disk roots, lowest precedence first.
///
/// `RYU_OUTPUT_STYLES_DIR` collapses this to the single user root: it is an explicit
/// override, and letting project/managed roots survive alongside it would mean a test
/// pointed at a tempdir still picked up whatever `.claude/output-styles` happens to
/// sit above its working directory.
fn output_style_scan_roots() -> Vec<(PathBuf, OutputStyleSource)> {
    let user = user_output_styles_dir();
    if std::env::var_os(ENV_OUTPUT_STYLES_DIR).is_some() {
        return vec![(user, OutputStyleSource::User)];
    }

    let mut roots: Vec<(PathBuf, OutputStyleSource)> = vec![(user, OutputStyleSource::User)];
    if let Ok(cwd) = std::env::current_dir() {
        roots.extend(
            project_output_styles_dirs(&cwd)
                .into_iter()
                .map(|d| (d, OutputStyleSource::Project)),
        );
    }
    if let Some(managed) = managed_output_styles_dir() {
        roots.push((managed, OutputStyleSource::Managed));
    }
    roots
}

/// Scan every disk root ([`output_style_scan_roots`]) in one pass, deduped by id —
/// the inverse of `ryu_skills::scan_all_skill_dirs`, whose first-root-wins order
/// encodes a different rule.
///
/// A collision is decided by [`OutputStyleSource::rank`] first and by scan order only
/// as the tie-break (later wins, which is what makes the nearest project root beat a
/// farther one — they share a rank). Deciding it on rank rather than purely on
/// position is what keeps this function and [`OutputStyleRegistry::all`] obeying *one*
/// precedence rule: the roots happen to be emitted in ascending-rank order today, so
/// position alone would agree, but then reordering [`output_style_scan_roots`] would
/// silently make the two disagree — and the disagreement would only show up as the
/// wrong style being injected.
///
/// The shadowed entry is logged at debug: it is a normal, intended state (a project
/// override of a user style) and not something to warn about.
pub fn scan_all_output_style_dirs() -> Vec<DiscoveredOutputStyle> {
    let mut merged: BTreeMap<String, DiscoveredOutputStyle> = BTreeMap::new();
    for (dir, source) in output_style_scan_roots() {
        for found in scan_output_style_dir(&dir) {
            if let Some(prev) = merged.get(&found.id) {
                if prev.source.rank() > source.rank() {
                    tracing::debug!(
                        "output style '{}' at {} is shadowed by the higher-ranked {}",
                        found.id,
                        found.path.display(),
                        prev.path.display()
                    );
                    continue;
                }
                tracing::debug!(
                    "output style '{}' at {} shadows {}",
                    found.id,
                    found.path.display(),
                    prev.path.display()
                );
            }
            merged.insert(
                found.id.clone(),
                DiscoveredOutputStyle {
                    id: found.id,
                    path: found.path,
                    source,
                },
            );
        }
    }
    merged.into_values().collect()
}

// ── Legacy node-default selection ────────────────────────────────────────────────
//
// This file is retained only so older clients and existing nodes can be upgraded
// without losing their former choice. Normal turns no longer read it: profile
// assignment lives on the agent record, while an explicit per-turn override rides
// on the request.
//
// Stored in Ryu's OWN data folder, never in the styles dir, so Ryu-local state never
// mutates files another tool owns — the same split `ryu_skills` makes for
// `skills-active.json`.

/// The persisted legacy node-default selection. A struct rather than a bare string so
/// "explicitly no style" (`{"style_id": null}`) and "never chosen" (no file) stay
/// distinguishable while older clients are still upgraded.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SelectionFile {
    #[serde(default)]
    style_id: Option<String>,
}

/// Path to the node-default selection file. Overridable via [`ENV_SELECTION_FILE`]
/// (tests, and ops who want it elsewhere).
fn selection_path() -> PathBuf {
    if let Some(p) = non_empty_env(ENV_SELECTION_FILE) {
        return p;
    }
    ryu_sidecar_runtime::layout::state_path(&ryu_data_dir(), "output-style.json")
}

/// The legacy node-default style id, or `None` when no style is selected.
///
/// Design §8: the shipped default is "no style", so the whole feature is inert until
/// a user picks one — which is why an unreadable or absent file resolves to `None`
/// rather than to some fallback style.
pub fn load_selection() -> Option<String> {
    let raw = std::fs::read_to_string(selection_path()).ok()?;
    let parsed: SelectionFile = serde_json::from_str(&raw).ok()?;
    parsed
        .style_id
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Set (or clear, with `None`) the legacy node-default style. Best-effort: a failure
/// to persist is logged, not surfaced, matching how the skills activation set behaves.
pub fn set_selection(style_id: Option<&str>) {
    let path = selection_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = SelectionFile {
        style_id: style_id
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty()),
    };
    match serde_json::to_string_pretty(&file) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                tracing::warn!("could not persist output-style selection: {e}");
            }
        }
        Err(e) => tracing::warn!("could not serialize output-style selection: {e}"),
    }
}

// ── OutputStyleRegistry ──────────────────────────────────────────────────────────

/// A plugin-contributed style plus the raw file it was parsed from.
///
/// The raw text is retained because a plugin style has no path on the user's machine
/// (design §4: the body is inlined into the manifest so it stays inside the signed
/// surface), and `GET /:id/source` must still be able to serve it — that endpoint is
/// what the "fork this into my own styles" action reads.
#[derive(Debug, Clone)]
struct PluginStyle {
    record: OutputStyleRecord,
    source: String,
}

/// Registry of available output styles: the disk scan plus the in-memory plugin bag.
///
/// `Arc`-backed, so the process-global handle ([`set_global_registry`]) and Core's own
/// clone share one inner `RwLock` — an HTTP handler's [`Self::reload`] is immediately
/// visible to the next chat turn.
#[derive(Clone)]
pub struct OutputStyleRegistry {
    /// Styles read from disk (user / project / managed), replaced wholesale by
    /// [`Self::reload`].
    disk: Arc<RwLock<Vec<OutputStyleRecord>>>,
    /// Styles contributed by **enabled plugins**, kept in a bag SEPARATE from `disk`
    /// so a disk reload can never wipe them — the same split
    /// `SkillRegistry::register_app_skill` makes, for the same reason. In-memory only;
    /// it survives a restart because every enabled plugin is re-run through the
    /// contribution registry on startup.
    ///
    /// Insertion order is **load order**, and that is load-bearing: it decides the
    /// [`Self::forced_style`] winner. Re-registering an existing id therefore replaces
    /// it *in place* rather than moving it to the end.
    plugins: Arc<RwLock<Vec<PluginStyle>>>,
}

impl OutputStyleRegistry {
    /// Create an empty registry (nothing loaded yet).
    pub fn empty() -> Self {
        Self {
            disk: Arc::new(RwLock::new(Vec::new())),
            plugins: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Load the disk styles and return a populated registry.
    pub fn load() -> Self {
        let registry = Self::empty();
        registry.reload();
        registry
    }

    /// (Re)load the disk styles, replacing the current disk contents. The plugin bag
    /// is untouched.
    pub fn reload(&self) {
        let mut styles: Vec<OutputStyleRecord> = Vec::new();
        for found in scan_all_output_style_dirs() {
            match std::fs::read_to_string(&found.path) {
                Ok(content) => {
                    match parse_output_style_md_from(&found.id, &content, found.source) {
                        Ok(mut record) => {
                            record.path = Some(found.path.clone());
                            tracing::debug!(id = %record.id, source = record.source.as_str(), "output style loaded");
                            styles.push(record);
                        }
                        Err(e) => {
                            tracing::warn!(
                                "output style at {} rejected: {e}",
                                found.path.display()
                            );
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "could not read output style at {}: {e}",
                        found.path.display()
                    );
                }
            }
        }
        tracing::info!(count = styles.len(), "output-style registry loaded");
        *self
            .disk
            .write()
            .expect("OutputStyleRegistry lock poisoned") = styles;
    }

    /// Register a style contributed by an enabled plugin.
    ///
    /// `source` is the **whole file** — frontmatter included — exactly as design §4
    /// requires: it goes through [`parse_output_style_md_from`], the same parser a disk
    /// style uses, so the frontmatter stays the single source of truth for a style's
    /// metadata and there is no second code path that could disagree about what
    /// `keep-coding-instructions` means.
    ///
    /// Idempotent: re-registering an id replaces that entry **in place**, preserving
    /// load order (which decides [`Self::forced_style`]). Returns `Err` with the parse
    /// error when the contributed text is malformed, so a broken plugin fails visibly
    /// at enable time rather than vanishing from the picker.
    pub fn register_plugin_style(&self, id: String, source: &str) -> Result<(), String> {
        let record = parse_output_style_md_from(&id, source, OutputStyleSource::Plugin)?;
        let forces = record.force_for_plugin;
        let entry = PluginStyle {
            record,
            source: source.to_owned(),
        };
        let Ok(mut bag) = self.plugins.write() else {
            return Err("output-style registry lock poisoned".to_owned());
        };
        if forces {
            if let Some(existing) = bag
                .iter()
                .find(|p| p.record.force_for_plugin && p.record.id != id)
            {
                // Design §5: the first loaded wins and Core logs the collision rather
                // than picking silently — a forced style that lost is a support call
                // ("my plugin's style isn't applying") with no other trace.
                tracing::warn!(
                    "output style '{}' declares force-for-plugin but '{}' already forces one; \
                     the first loaded wins",
                    id,
                    existing.record.id
                );
            }
        }
        match bag.iter().position(|p| p.record.id == id) {
            Some(i) => bag[i] = entry,
            None => bag.push(entry),
        }
        Ok(())
    }

    /// Remove a plugin-registered style by id (called when the plugin is disabled).
    /// Idempotent.
    pub fn unregister_plugin_style(&self, id: &str) {
        if let Ok(mut bag) = self.plugins.write() {
            bag.retain(|p| p.record.id != id);
        }
    }

    /// Every available style, merged and deduped by id with the higher-ranked source
    /// winning ([`OutputStyleSource::rank`]), sorted by id.
    ///
    /// Note the plugin bag merges **below** the disk records, the opposite of
    /// `SkillRegistry::enabled`'s trailing append: design §3 puts plugin contributions
    /// at the bottom of the precedence table precisely so a user can fork a plugin
    /// style into their own root and have the fork take effect under the same id.
    pub fn all(&self) -> Vec<OutputStyleRecord> {
        let mut merged: BTreeMap<String, OutputStyleRecord> = BTreeMap::new();
        for p in self.plugin_snapshot() {
            merged.insert(p.record.id.clone(), p.record);
        }
        for record in self
            .disk
            .read()
            .expect("OutputStyleRegistry lock poisoned")
            .iter()
        {
            match merged.get(&record.id) {
                Some(existing) if existing.source.rank() > record.source.rank() => {}
                _ => {
                    merged.insert(record.id.clone(), record.clone());
                }
            }
        }
        merged.into_values().collect()
    }

    /// The effective style for `id`, or `None`.
    ///
    /// Returns an **owned** record rather than the `&OutputStyleRecord` a plain `Vec`
    /// field would allow: the contents live behind an `RwLock` so a borrow cannot
    /// outlive the read guard, and handing out a guard would let an HTTP handler hold
    /// the registry locked across an await point.
    pub fn get(&self, id: &str) -> Option<OutputStyleRecord> {
        self.all().into_iter().find(|r| r.id == id)
    }

    /// The style forced by an enabled plugin (`force-for-plugin: true`), which
    /// overrides the per-turn and per-agent selection while that plugin is enabled.
    ///
    /// Two rules are enforced here rather than at the call sites:
    ///
    /// - **Plugin styles only.** The frontmatter struct happily parses the key out of
    ///   any file, so a user could drop `force-for-plugin: true` into their own `.md`
    ///   and pin the node to it. Design §1 scopes the key to plugin-shipped styles, so
    ///   only the plugin bag is consulted.
    /// - **First loaded wins**, with the collision logged at registration time (see
    ///   [`Self::register_plugin_style`]) rather than on every turn.
    ///
    /// The winner is then resolved through [`Self::get`], not returned straight from
    /// the bag: if the user has forked the forced style into their own root, the fork
    /// is the effective record for that id and forcing must apply to the fork.
    pub fn forced_style(&self) -> Option<OutputStyleRecord> {
        let id = self
            .plugin_snapshot()
            .into_iter()
            .find(|p| p.record.force_for_plugin)
            .map(|p| p.record.id)?;
        self.get(&id)
    }

    /// The raw `.md` text behind a style: the file for a disk style, the registered
    /// contribution text for a plugin one. `None` when the id is unknown or the file
    /// cannot be read.
    pub fn source_of(&self, id: &str) -> Option<String> {
        match self.get(id) {
            Some(record) => match record.path {
                Some(path) => std::fs::read_to_string(path).ok(),
                None => self
                    .plugin_snapshot()
                    .into_iter()
                    .find(|p| p.record.id == id)
                    .map(|p| p.source),
            },
            None => None,
        }
    }

    fn plugin_snapshot(&self) -> Vec<PluginStyle> {
        self.plugins.read().map(|v| v.clone()).unwrap_or_default()
    }
}

// ── Public summary type ──────────────────────────────────────────────────────────

/// One row of `GET /api/output-styles`.
///
/// The field names are chosen so a `store_tabs` contribution can map straight onto
/// them as a read-only catalog. `active` is retained for older clients while the
/// legacy node selection is migrated; agent assignment is read from each agent's
/// persona record instead.
#[derive(Debug, Clone, Serialize)]
pub struct OutputStyleSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// Provenance discriminant (`"plugin"`, `"user"`, …).
    pub source: &'static str,
    /// Whether this style is selected by the legacy node-default file or forced by
    /// a plugin. It is not the per-agent assignment state.
    pub active: bool,
    /// Whether a forced plugin style is what makes it active — the picker uses this to
    /// explain why the selection is not the user's own.
    pub forced: bool,
    /// Mirrors [`OutputStyleRecord::keep_coding_instructions`].
    pub keep_coding_instructions: bool,
    /// Whether the authoring surface can edit this file in place; `false` means an
    /// edit forks it into the user root (design §6).
    pub editable: bool,
}

impl OutputStyleSummary {
    fn new(record: &OutputStyleRecord, active_id: Option<&str>, forced_id: Option<&str>) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            description: record.description.clone(),
            source: record.source.as_str(),
            active: active_id == Some(record.id.as_str()),
            forced: forced_id == Some(record.id.as_str()),
            keep_coding_instructions: record.keep_coding_instructions,
            editable: record.source.is_writable(),
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"---
name: ELI5
description: keep it simple pls
keep-coding-instructions: true
---

It's been a long day and my brain is fried, talk to me like I'm 5.
"#;

    /// Holds [`OUTPUT_STYLES_ENV_LOCK`] and restores [`ENV_OUTPUT_STYLES_DIR`] /
    /// [`ENV_SELECTION_FILE`] to whatever they were, on drop.
    ///
    /// Restoring in `Drop` rather than at the end of the test body is the load-bearing
    /// part: a panicking assertion skips trailing cleanup and would leave the vars
    /// pointing at a tempdir that is being deleted, surfacing as a flake in whichever
    /// *unrelated* test runs next in this binary. `unwrap_or_else(into_inner)` on the
    /// lock matches `ryu_skills`: a poisoned lock means another test panicked, which
    /// must not cascade.
    struct EnvGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        prev_dir: Option<std::ffi::OsString>,
        prev_selection: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn new(styles_dir: &Path, selection: &Path) -> Self {
            let lock = OUTPUT_STYLES_ENV_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let guard = Self {
                _lock: lock,
                prev_dir: std::env::var_os(ENV_OUTPUT_STYLES_DIR),
                prev_selection: std::env::var_os(ENV_SELECTION_FILE),
            };
            std::env::set_var(ENV_OUTPUT_STYLES_DIR, styles_dir);
            std::env::set_var(ENV_SELECTION_FILE, selection);
            guard
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev_dir {
                Some(v) => std::env::set_var(ENV_OUTPUT_STYLES_DIR, v),
                None => std::env::remove_var(ENV_OUTPUT_STYLES_DIR),
            }
            match &self.prev_selection {
                Some(v) => std::env::set_var(ENV_SELECTION_FILE, v),
                None => std::env::remove_var(ENV_SELECTION_FILE),
            }
        }
    }

    #[test]
    fn parses_kebab_case_front_matter() {
        let rec = parse_output_style_md("eli5", SAMPLE).expect("parse");
        assert_eq!(rec.id, "eli5");
        assert_eq!(rec.name, "ELI5");
        assert_eq!(rec.description.as_deref(), Some("keep it simple pls"));
        assert!(rec.keep_coding_instructions);
        assert!(!rec.force_for_plugin);
        assert!(rec.body.starts_with("It's been a long day"));
    }

    #[test]
    fn keep_coding_instructions_defaults_to_false() {
        let rec =
            parse_output_style_md("plain", "---\nname: Plain\n---\nno markdown").expect("parse");
        assert!(!rec.keep_coding_instructions);
        assert!(!rec.force_for_plugin);
    }

    #[test]
    fn force_for_plugin_parses_from_kebab_key() {
        let rec = parse_output_style_md("f", "---\nname: F\nforce-for-plugin: true\n---\nbody")
            .expect("parse");
        assert!(rec.force_for_plugin);
    }

    #[test]
    fn no_front_matter_falls_back_to_the_file_stem() {
        let rec = parse_output_style_md("my-style", "just prose, no yaml").expect("parse");
        assert_eq!(rec.name, "my-style");
        assert_eq!(rec.body, "just prose, no yaml");
        assert!(rec.description.is_none());
    }

    #[test]
    fn unknown_front_matter_keys_are_tolerated() {
        let src = "---\nname: N\nsome-future-key: 3\nnested:\n  a: b\n---\nbody";
        let rec = parse_output_style_md("n", src).expect("unknown keys must not fail the parse");
        assert_eq!(rec.name, "N");
        assert_eq!(rec.body, "body");
    }

    #[test]
    fn style_block_carries_the_body_and_a_reminder() {
        let rec = parse_output_style_md("eli5", SAMPLE).expect("parse");
        let block = style_block(&rec);
        assert!(block.contains("talk to me like I'm 5"));
        assert!(block.contains("output style"));
        // The body leads; the reminder trails it.
        assert!(block.find("talk to me").unwrap() < block.find("output style").unwrap());
    }

    #[test]
    fn style_block_is_empty_without_a_body() {
        let rec = parse_output_style_md("meta", "---\nname: Meta\n---\n").expect("parse");
        assert!(!rec.has_body());
        assert!(style_block(&rec).is_empty());
    }

    /// The four-source merge: a plugin style is shadowed by a user file of the same
    /// id, and the plugin style survives a disk `reload()`.
    #[test]
    fn user_disk_style_wins_over_a_plugin_style_of_the_same_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sel = dir.path().join("selection.json");
        let _guard = EnvGuard::new(dir.path(), &sel);

        std::fs::write(dir.path().join("eli5.md"), "---\nname: Forked\n---\nmine").expect("write");

        let reg = OutputStyleRegistry::empty();
        reg.register_plugin_style("eli5".to_owned(), SAMPLE)
            .expect("register");
        reg.register_plugin_style("adhd".to_owned(), "---\nname: ADHD\n---\naction first")
            .expect("register");
        reg.reload();

        let all = reg.all();
        assert_eq!(all.len(), 2, "ids merge, they do not duplicate");
        let eli5 = reg.get("eli5").expect("eli5");
        assert_eq!(eli5.name, "Forked");
        assert_eq!(eli5.source, OutputStyleSource::User);
        // The plugin bag survived the disk reload.
        assert_eq!(
            reg.get("adhd").expect("adhd").source,
            OutputStyleSource::Plugin
        );
    }

    #[test]
    fn forced_style_ignores_a_user_file_that_claims_to_force() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sel = dir.path().join("selection.json");
        let _guard = EnvGuard::new(dir.path(), &sel);

        std::fs::write(
            dir.path().join("sneaky.md"),
            "---\nname: Sneaky\nforce-for-plugin: true\n---\npin me",
        )
        .expect("write");

        let reg = OutputStyleRegistry::load();
        assert!(reg.get("sneaky").expect("loaded").force_for_plugin);
        assert!(
            reg.forced_style().is_none(),
            "force-for-plugin is plugin-only"
        );

        reg.register_plugin_style(
            "forced".to_owned(),
            "---\nname: F\nforce-for-plugin: true\n---\nb",
        )
        .expect("register");
        // First loaded wins even after a second plugin forces one.
        reg.register_plugin_style(
            "second".to_owned(),
            "---\nname: S\nforce-for-plugin: true\n---\nb",
        )
        .expect("register");
        assert_eq!(reg.forced_style().expect("forced").id, "forced");
    }

    #[test]
    fn selection_round_trips_and_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sel = dir.path().join("selection.json");
        let _guard = EnvGuard::new(dir.path(), &sel);

        assert_eq!(load_selection(), None, "no style is the shipped default");
        set_selection(Some("eli5"));
        assert_eq!(load_selection().as_deref(), Some("eli5"));
        set_selection(None);
        assert_eq!(load_selection(), None);
    }

    #[test]
    fn scan_ignores_non_markdown_and_sorts_by_id() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("zeta.md"), "z").expect("write");
        std::fs::write(dir.path().join("alpha.md"), "a").expect("write");
        std::fs::write(dir.path().join("notes.txt"), "ignored").expect("write");
        let found = scan_output_style_dir(dir.path());
        let ids: Vec<&str> = found.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["alpha", "zeta"]);
    }

    #[test]
    fn project_roots_are_farthest_first_and_stop_at_the_repo_root() {
        let repo = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(repo.path().join(".git")).expect("git dir");
        let nested = repo.path().join("apps").join("core");
        std::fs::create_dir_all(&nested).expect("nested");

        let roots = project_output_styles_dirs(&nested);
        assert_eq!(roots.len(), 3, "cwd, apps, repo root — and no further");
        // Farthest first, so the nearest lands last and therefore wins the merge.
        assert!(roots[0].starts_with(repo.path()));
        assert_eq!(roots[0], repo.path().join(".claude").join(STYLES_DIR_NAME));
        assert_eq!(roots[2], nested.join(".claude").join(STYLES_DIR_NAME));
    }

    #[test]
    fn source_ranks_follow_the_design_table() {
        assert!(OutputStyleSource::Builtin.rank() < OutputStyleSource::Plugin.rank());
        assert!(OutputStyleSource::Plugin.rank() < OutputStyleSource::User.rank());
        assert!(OutputStyleSource::User.rank() < OutputStyleSource::Project.rank());
        assert!(OutputStyleSource::Project.rank() < OutputStyleSource::Managed.rank());
        assert!(OutputStyleSource::User.is_writable());
        assert!(!OutputStyleSource::Plugin.is_writable());
    }

    #[test]
    fn malformed_yaml_is_the_only_parse_error() {
        let err = parse_output_style_md("bad", "---\nname: [unclosed\n---\nbody")
            .expect_err("malformed YAML must fail");
        assert!(err.contains("bad"), "the error names the style: {err}");
    }
}
