//! Authoring + version history for user-editable Agent Skills.
//!
//! Skills themselves live in the shared universal directory
//! `~/.claude/skills/<id>/SKILL.md` ([`SkillRegistry::skills_dir`]), the same
//! layout Claude Code and the skills CLI read. This module adds the *write* side
//! the catalog installer never needed: creating a brand-new SKILL.md from the
//! desktop editor, updating an existing one, and an undoable source history.
//!
//! **Version snapshots** are checkpoints in Ryu's managed local Git repository
//! under `files/source-history/skills/<id>/SKILL.md`, the sealed store shared
//! with workflows, agents and pages. Earlier builds kept plaintext JSON
//! snapshots under `state/skill-versions/<id>/<vid>.json`;
//! [`import_legacy_skill_versions`] (run at Core startup) moves them into the
//! sealed history, verifies each one, and deletes the plaintext folder.
//!
//! Core-vs-Gateway: this is squarely Core (it decides *what a skill is*); the
//! Gateway still governs whether the skill's instructions are *allowed* to be
//! injected at request time.

use std::path::{Path, PathBuf};

pub use ryu_workspace::source_history::SourceHistory;
use serde::{Deserialize, Serialize};

use super::SkillRegistry;

// ── Path helpers ────────────────────────────────────────────────────────────

fn versions_root() -> PathBuf {
    ryu_sidecar_runtime::layout::state_path(&crate::ryu_data_dir(), "skill-versions")
}

fn source_history() -> SourceHistory {
    SourceHistory::new(ryu_sidecar_runtime::layout::files_path(
        &crate::ryu_data_dir(),
        "source-history",
    ))
}

/// Where a skill's versions are recorded inside a [`SourceHistory`].
pub fn source_history_path(skill_id: &str) -> String {
    format!("skills/{skill_id}/SKILL.md")
}

/// Record the Git audit projection without turning a successful source write
/// into a reported failure. The SKILL.md file is authoritative and Git history
/// can be repaired after a transient disk or repository failure.
fn checkpoint_source_history_best_effort(relative_path: &str, content: &str, label: Option<&str>) {
    if let Err(error) = source_history().checkpoint(relative_path, content, label) {
        tracing::warn!(
            path = relative_path,
            error = %error,
            "skill source-history checkpoint was not recorded"
        );
    }
}

/// Validate a skill id as a single safe path segment (no separators, no `..`),
/// so neither a version path nor a skill path can escape its directory.
pub fn validate_id(id: &str) -> std::io::Result<()> {
    let bad = id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || id.contains(':');
    if bad {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid skill id '{id}'"),
        ));
    }
    Ok(())
}

fn skill_versions_dir(id: &str) -> std::io::Result<PathBuf> {
    validate_id(id)?;
    Ok(versions_root().join(id))
}

/// Sanitize a name/slug into one safe path segment. Keeps alphanumerics, `-`,
/// `_`, `.`; collapses everything else to a dash; trims leading/trailing dashes
/// and dots. Returns `None` when nothing safe remains. Mirrors
/// `sidecar::mcp::skills_tool::sanitize_slug` (fail-closed).
pub fn sanitize_slug(raw: &str) -> Option<String> {
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
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    Some(trimmed.to_lowercase())
}

// ── Editable draft (what the desktop editor sends) ──────────────────────────

/// The subset of a SKILL.md the desktop editor exposes as form fields. On save
/// these patch the *known* front-matter keys; every other key already on disk
/// (`enabled`, `license`, a `metadata:` block, …) is preserved verbatim so
/// editing one field never silently drops another tool's data.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillDraft {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub always_on: bool,
    /// The Markdown instruction body (everything below the front-matter).
    #[serde(default)]
    pub body: String,
}

// ── Reading the on-disk source ──────────────────────────────────────────────

/// Read the raw SKILL.md text for an installed skill, or `None` when it is not on
/// disk. Handles both the standard `<id>/SKILL.md` and legacy flat `<id>.md`
/// layouts by delegating to the same scanner the registry loader uses.
pub fn read_skill_source(id: &str) -> std::io::Result<Option<String>> {
    read_skill_source_in(&SkillRegistry::skills_dir(), id)
}

/// [`read_skill_source`] against an explicit skills root.
pub fn read_skill_source_in(skills_root: &Path, id: &str) -> std::io::Result<Option<String>> {
    validate_id(id)?;
    let path = super::scan_skill_dir(skills_root)
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| s.skill_md);
    match path {
        Some(p) => Ok(Some(std::fs::read_to_string(p)?)),
        None => Ok(None),
    }
}

// ── Building a SKILL.md from a draft (front-matter-preserving) ──────────────

/// Reconstruct a full SKILL.md from a draft, patching only the editor-exposed
/// front-matter keys onto any pre-existing front-matter (`existing`). Unknown
/// keys are preserved; a cleared optional (empty description, empty tool list)
/// removes that key. `existing` is `None` for a brand-new skill.
pub fn build_skill_md(existing: Option<&str>, draft: &SkillDraft) -> Result<String, String> {
    use noyalib::compat::serde_yaml::{Mapping, Value};

    // Start from the existing front-matter mapping so unknown keys survive.
    let mut map: Mapping = match existing {
        Some(src) => {
            let (front_raw, _body) = super::split_front_matter(src)?;
            if front_raw.trim().is_empty() {
                Mapping::new()
            } else {
                noyalib::compat::serde_yaml::from_str(&front_raw).unwrap_or_default()
            }
        }
        None => Mapping::new(),
    };

    let name = draft.name.trim();
    if name.is_empty() {
        return Err("skill name is required".to_owned());
    }
    map.insert("name".to_owned(), Value::from(name));

    match draft.description.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => {
            map.insert("description".to_owned(), Value::from(d));
        }
        _ => {
            map.remove("description");
        }
    }

    let tools: Vec<Value> = draft
        .allowed_tools
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(Value::from)
        .collect();
    if tools.is_empty() {
        map.remove("allowed-tools");
    } else {
        map.insert("allowed-tools".to_owned(), Value::Sequence(tools));
    }

    if draft.always_on {
        map.insert("always-on".to_owned(), Value::from(true));
    } else {
        map.remove("always-on");
    }

    let mut yaml = noyalib::compat::serde_yaml::to_string(&Value::Mapping(map))
        .map_err(|e| format!("failed to render front-matter: {e}"))?;
    // noyalib's serde_yaml shim omits the trailing newline the closing `---` fence needs.
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }

    Ok(format!(
        "---\n{yaml}---\n\n{body}\n",
        yaml = yaml,
        body = draft.body.trim()
    ))
}

// ── Writing skills ──────────────────────────────────────────────────────────

/// Atomically write `source` as the skill's SKILL.md (tmp + rename), creating the
/// skill directory as needed. Returns the destination path.
fn write_skill_md(id: &str, source: &str) -> std::io::Result<PathBuf> {
    validate_id(id)?;
    let skill_dir = SkillRegistry::skills_dir().join(id);
    std::fs::create_dir_all(&skill_dir)?;
    let dest = skill_dir.join("SKILL.md");
    let tmp = skill_dir.join("SKILL.md.tmp");
    std::fs::write(&tmp, source.as_bytes())?;
    std::fs::rename(&tmp, &dest)?;
    Ok(dest)
}

/// Outcome of a create/update write: the on-disk id, the file path, and the exact
/// canonical source bytes written (so the caller can echo it back to the editor
/// as the diff baseline without a re-read).
pub struct WriteResult {
    pub id: String,
    pub path: PathBuf,
    pub source: String,
}

/// Error creating a new skill.
pub enum CreateError {
    /// The derived slug collides with an existing skill directory.
    Conflict(String),
    /// The draft is malformed (missing name, unusable slug, or the rendered
    /// SKILL.md does not round-trip through the loader).
    Invalid(String),
    Io(std::io::Error),
}

/// Create a brand-new skill from a draft. The id is derived from the name;
/// creation fails with [`CreateError::Conflict`] rather than clobbering an
/// existing skill of the same slug. The new skill is left for the caller to
/// activate + reload.
pub fn create_skill(draft: &SkillDraft) -> Result<WriteResult, CreateError> {
    let slug = sanitize_slug(&draft.name).ok_or_else(|| {
        CreateError::Invalid(format!("could not derive an id from '{}'", draft.name))
    })?;

    // The id is taken when it resolves anywhere in the skills namespace (the
    // legacy flat `<slug>.md`, `~/.agents/skills/<slug>/`), not only when the
    // write root has `<slug>/`: writing there would silently shadow that skill.
    // A bare `<slug>/` without SKILL.md is still refused rather than written into.
    let skill_dir = SkillRegistry::skills_dir().join(&slug);
    if super::resolve_skill_md(&slug).is_some() || skill_dir.exists() {
        return Err(CreateError::Conflict(slug));
    }

    let source = build_skill_md(None, draft).map_err(CreateError::Invalid)?;
    // Fail closed: never persist a file the loader can't read back.
    super::parse_skill_md(&slug, &source)
        .map_err(|e| CreateError::Invalid(format!("skill did not round-trip: {e}")))?;

    let path = write_skill_md(&slug, &source).map_err(CreateError::Io)?;
    checkpoint_source_history_best_effort(
        &source_history_path(&slug),
        &source,
        Some("Skill saved"),
    );
    Ok(WriteResult {
        id: slug,
        path,
        source,
    })
}

/// Update an existing skill from a draft, preserving any front-matter keys the
/// editor does not manage. Returns the canonical source written.
pub fn update_skill(id: &str, draft: &SkillDraft) -> Result<WriteResult, CreateError> {
    validate_id(id).map_err(CreateError::Io)?;
    let existing = read_skill_source(id).map_err(CreateError::Io)?;
    let source = build_skill_md(existing.as_deref(), draft).map_err(CreateError::Invalid)?;
    super::parse_skill_md(id, &source)
        .map_err(|e| CreateError::Invalid(format!("skill did not round-trip: {e}")))?;
    let path = write_skill_md(id, &source).map_err(CreateError::Io)?;
    checkpoint_source_history_best_effort(&source_history_path(id), &source, Some("Skill saved"));
    Ok(WriteResult {
        id: id.to_owned(),
        path,
        source,
    })
}

// ── Version history ─────────────────────────────────────────────────────────

#[path = "store_versions.rs"]
mod versions;

pub use versions::*;

#[path = "store_legacy.rs"]
mod legacy;

#[cfg(test)]
use legacy::import_legacy_skill_versions_in;
pub use legacy::{import_legacy_skill_versions, legacy_skill_versions_pending, LegacyImportReport};

#[cfg(test)]
#[path = "store_editor_tests.rs"]
mod editor_tests;

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
