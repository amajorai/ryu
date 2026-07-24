//! Authoring + version history for user-editable Agent Skills.
//!
//! Skills themselves live in the shared universal directory
//! `~/.claude/skills/<id>/SKILL.md` ([`SkillRegistry::skills_dir`]), the same
//! layout Claude Code and the skills CLI read. This module adds the *write* side
//! the catalog installer never needed: creating a brand-new SKILL.md from the
//! desktop editor, updating an existing one, and a bounded, undoable version
//! history.
//!
//! **Version snapshots** live in Ryu's OWN directory
//! `~/.ryu/skill-versions/<id>/<version_id>.json`, never in the shared skills dir
//! — exactly like `workflow/store.rs` keeps its versions out of the workflows
//! dir, so Ryu-local history never mutates files other tools own. A version wraps
//! the **raw SKILL.md string** (not decomposed fields), so a restore is lossless
//! and a diff surfaces front-matter changes too.
//!
//! Core-vs-Gateway: this is squarely Core (it decides *what a skill is*); the
//! Gateway still governs whether the skill's instructions are *allowed* to be
//! injected at request time.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::SkillRegistry;

/// Maximum retained versions per skill. Oldest beyond this are pruned on each new
/// snapshot so history stays bounded (mirrors `MAX_WORKFLOW_VERSIONS`).
const MAX_SKILL_VERSIONS: usize = 50;

// ── Path helpers ────────────────────────────────────────────────────────────

fn versions_root() -> PathBuf {
    crate::ryu_data_dir().join("skill-versions")
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
    validate_id(id)?;
    let dir = SkillRegistry::skills_dir();
    let path = super::scan_skill_dir(&dir)
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
    use serde_yml::{Mapping, Value};

    // Start from the existing front-matter mapping so unknown keys survive.
    let mut map: Mapping = match existing {
        Some(src) => {
            let (front_raw, _body) = super::split_front_matter(src)?;
            if front_raw.trim().is_empty() {
                Mapping::new()
            } else {
                serde_yml::from_str(&front_raw).unwrap_or_default()
            }
        }
        None => Mapping::new(),
    };

    let name = draft.name.trim();
    if name.is_empty() {
        return Err("skill name is required".to_owned());
    }
    map.insert(Value::from("name"), Value::from(name));

    match draft.description.as_deref().map(str::trim) {
        Some(d) if !d.is_empty() => {
            map.insert(Value::from("description"), Value::from(d));
        }
        _ => {
            map.remove(Value::from("description"));
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
        map.remove(Value::from("allowed-tools"));
    } else {
        map.insert(Value::from("allowed-tools"), Value::Sequence(tools));
    }

    if draft.always_on {
        map.insert(Value::from("always-on"), Value::from(true));
    } else {
        map.remove(Value::from("always-on"));
    }

    let yaml = serde_yml::to_string(&Value::Mapping(map))
        .map_err(|e| format!("failed to render front-matter: {e}"))?;

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

    let skill_dir = SkillRegistry::skills_dir().join(&slug);
    if skill_dir.exists() {
        return Err(CreateError::Conflict(slug));
    }

    let source = build_skill_md(None, draft).map_err(CreateError::Invalid)?;
    // Fail closed: never persist a file the loader can't read back.
    super::parse_skill_md(&slug, &source)
        .map_err(|e| CreateError::Invalid(format!("skill did not round-trip: {e}")))?;

    let path = write_skill_md(&slug, &source).map_err(CreateError::Io)?;
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
    Ok(WriteResult {
        id: id.to_owned(),
        path,
        source,
    })
}

// ── Version history ─────────────────────────────────────────────────────────

/// Metadata for one saved skill version (no embedded source, so lists stay light).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillVersionMeta {
    pub id: String,
    pub skill_id: String,
    /// The skill's display name captured at snapshot time.
    pub name: String,
    /// Optional user label for a manual snapshot (`None` for auto ones).
    pub label: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// A full saved skill version, including the raw SKILL.md captured at the time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillVersion {
    pub id: String,
    pub skill_id: String,
    pub name: String,
    pub label: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// The full SKILL.md text captured at snapshot time (lossless).
    pub source: String,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Snapshot a skill's current on-disk SKILL.md as a new version. Returns `None`
/// when the skill has no source on disk (nothing to snapshot). Prunes the oldest
/// versions past [`MAX_SKILL_VERSIONS`].
pub fn snapshot_skill(
    skill_id: &str,
    label: Option<&str>,
) -> std::io::Result<Option<SkillVersionMeta>> {
    let Some(source) = read_skill_source(skill_id)? else {
        return Ok(None);
    };
    // Capture the display name for the meta (best-effort; falls back to the id).
    let name = super::parse_skill_md(skill_id, &source)
        .map(|r| r.name)
        .unwrap_or_else(|_| skill_id.to_owned());
    save_skill_version(skill_id, &name, &source, label).map(Some)
}

/// Persist a raw SKILL.md source string as a new version. Prefer [`snapshot_skill`]
/// which reads the current on-disk source for you.
pub fn save_skill_version(
    skill_id: &str,
    name: &str,
    source: &str,
    label: Option<&str>,
) -> std::io::Result<SkillVersionMeta> {
    let dir = skill_versions_dir(skill_id)?;
    std::fs::create_dir_all(&dir)?;
    let version_id = format!("sv_{}", uuid::Uuid::new_v4().simple());
    let created_at = now_millis();
    let version = SkillVersion {
        id: version_id.clone(),
        skill_id: skill_id.to_owned(),
        name: name.to_owned(),
        label: label.map(str::to_string),
        created_at,
        source: source.to_owned(),
    };
    let json = serde_json::to_string_pretty(&version)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(dir.join(format!("{version_id}.json")), json)?;

    prune_skill_versions(skill_id)?;

    Ok(SkillVersionMeta {
        id: version_id,
        skill_id: skill_id.to_owned(),
        name: name.to_owned(),
        label: label.map(str::to_string),
        created_at,
    })
}

/// Read every version file for a skill (full, unsorted). Corrupt files are skipped
/// rather than failing the whole read.
fn read_skill_versions(skill_id: &str) -> std::io::Result<Vec<SkillVersion>> {
    let dir = skill_versions_dir(skill_id)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(v) = serde_json::from_slice::<SkillVersion>(&bytes) {
                out.push(v);
            }
        }
    }
    Ok(out)
}

/// List a skill's saved versions, newest first (metadata only).
pub fn list_skill_versions(skill_id: &str) -> std::io::Result<Vec<SkillVersionMeta>> {
    let mut versions = read_skill_versions(skill_id)?;
    versions.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(versions
        .into_iter()
        .map(|v| SkillVersionMeta {
            id: v.id,
            skill_id: v.skill_id,
            name: v.name,
            label: v.label,
            created_at: v.created_at,
        })
        .collect())
}

/// Load one saved version in full (including its captured source).
pub fn load_skill_version(
    skill_id: &str,
    version_id: &str,
) -> std::io::Result<Option<SkillVersion>> {
    validate_id(version_id)?;
    let path = skill_versions_dir(skill_id)?.join(format!("{version_id}.json"));
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Restore a saved version as the skill's current SKILL.md. Snapshots the current
/// on-disk source first (labelled `"Before restore"`) so the restore is itself
/// undoable, then writes the captured source back verbatim (lossless). Returns the
/// restored source, or `None` when the version does not exist. The caller reloads
/// the registry so the change is live.
pub fn restore_skill_version(skill_id: &str, version_id: &str) -> std::io::Result<Option<String>> {
    let Some(version) = load_skill_version(skill_id, version_id)? else {
        return Ok(None);
    };
    // Best-effort: a skill whose file was deleted out from under us simply has
    // nothing to snapshot.
    let _ = snapshot_skill(skill_id, Some("Before restore"));
    write_skill_md(skill_id, &version.source)?;
    Ok(Some(version.source))
}

/// Delete a skill's entire version history directory. Returns `true` when a
/// directory was removed.
pub fn delete_skill_versions(skill_id: &str) -> std::io::Result<bool> {
    let dir = skill_versions_dir(skill_id)?;
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Remove the oldest version files beyond [`MAX_SKILL_VERSIONS`].
fn prune_skill_versions(skill_id: &str) -> std::io::Result<()> {
    let mut versions = read_skill_versions(skill_id)?;
    if versions.len() <= MAX_SKILL_VERSIONS {
        return Ok(());
    }
    versions.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    let dir = skill_versions_dir(skill_id)?;
    for v in versions.into_iter().skip(MAX_SKILL_VERSIONS) {
        let _ = std::fs::remove_file(dir.join(format!("{}.json", v.id)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_preserves_unknown_front_matter_keys() {
        let existing = "---\nname: Old\nlicense: MIT\nenabled: false\n---\nold body";
        let draft = SkillDraft {
            name: "New Name".to_owned(),
            description: Some("desc".to_owned()),
            allowed_tools: vec!["spider".to_owned()],
            always_on: true,
            body: "new body".to_owned(),
        };
        let out = build_skill_md(Some(existing), &draft).expect("build");
        // Editor-managed keys are patched.
        assert!(out.contains("name: New Name"));
        assert!(out.contains("description: desc"));
        assert!(out.contains("allowed-tools:"));
        assert!(out.contains("always-on: true"));
        // Unknown / unmanaged keys survive.
        assert!(out.contains("license: MIT"));
        assert!(out.contains("enabled: false"));
        assert!(out.trim_end().ends_with("new body"));
        // And it round-trips through the loader.
        let rec = super::super::parse_skill_md("x", &out).expect("round-trip");
        assert_eq!(rec.name, "New Name");
        assert_eq!(rec.instructions, "new body");
        assert!(rec.always_on);
    }

    #[test]
    fn build_clears_optional_keys_when_emptied() {
        let existing = "---\nname: X\ndescription: had one\nalways-on: true\n---\nbody";
        let draft = SkillDraft {
            name: "X".to_owned(),
            description: None,
            allowed_tools: vec![],
            always_on: false,
            body: "body".to_owned(),
        };
        let out = build_skill_md(Some(existing), &draft).expect("build");
        assert!(!out.contains("description:"));
        assert!(!out.contains("always-on"));
    }

    #[test]
    fn version_roundtrip_isolated_by_uuid_id() {
        // Use a unique id against the real ryu_dir(), then self-clean (the
        // ryu_dir() OnceLock can't be redirected once resolved).
        let skill_id = format!("test-skill-{}", uuid::Uuid::new_v4().simple());
        let src = "---\nname: T\n---\nhello";
        let meta = save_skill_version(&skill_id, "T", src, Some("v1")).expect("save");
        assert_eq!(meta.skill_id, skill_id);

        let list = list_skill_versions(&skill_id).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label.as_deref(), Some("v1"));

        let full = load_skill_version(&skill_id, &meta.id)
            .expect("load")
            .expect("some");
        assert_eq!(full.source, src);

        assert!(delete_skill_versions(&skill_id).expect("delete"));
    }

    #[test]
    fn rejects_unsafe_ids() {
        assert!(validate_id("../escape").is_err());
        assert!(validate_id("a/b").is_err());
        assert!(validate_id("").is_err());
        assert!(validate_id("ok-id").is_ok());
    }
}
