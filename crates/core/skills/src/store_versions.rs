//! Version history for user-editable skills: snapshots of a skill's SKILL.md
//! in the managed source history, listing, loading and restoring them.

use serde::{Deserialize, Serialize};

use super::*;

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
/// when the skill has no source on disk (nothing to snapshot).
pub fn snapshot_skill(
    skill_id: &str,
    label: Option<&str>,
) -> std::io::Result<Option<SkillVersionMeta>> {
    snapshot_skill_in(
        &SkillRegistry::skills_dir(),
        &source_history(),
        skill_id,
        label,
    )
}

/// [`snapshot_skill`] against an explicit skills root and history store, so a
/// caller that owns its folders never reaches the node's.
pub fn snapshot_skill_in(
    skills_root: &Path,
    history: &SourceHistory,
    skill_id: &str,
    label: Option<&str>,
) -> std::io::Result<Option<SkillVersionMeta>> {
    let Some(source) = read_skill_source_in(skills_root, skill_id)? else {
        return Ok(None);
    };
    // Capture the display name for the meta (best-effort; falls back to the id).
    let name = crate::parse_skill_md(skill_id, &source)
        .map(|r| r.name)
        .unwrap_or_else(|_| skill_id.to_owned());
    save_skill_version_in(history, skill_id, &name, &source, label).map(Some)
}

/// Persist a raw SKILL.md source string as a new version. Prefer [`snapshot_skill`]
/// which reads the current on-disk source for you.
pub fn save_skill_version(
    skill_id: &str,
    name: &str,
    source: &str,
    label: Option<&str>,
) -> std::io::Result<SkillVersionMeta> {
    save_skill_version_in(&source_history(), skill_id, name, source, label)
}

fn save_skill_version_in(
    history: &SourceHistory,
    skill_id: &str,
    name: &str,
    source: &str,
    label: Option<&str>,
) -> std::io::Result<SkillVersionMeta> {
    validate_id(skill_id)?;
    let version = history.checkpoint(&source_history_path(skill_id), source, label)?;
    Ok(SkillVersionMeta {
        id: version.id,
        skill_id: skill_id.to_owned(),
        name: name.to_owned(),
        label: version.label,
        created_at: version.created_at,
    })
}

/// List a skill's saved versions, newest first (metadata only).
pub fn list_skill_versions(skill_id: &str) -> std::io::Result<Vec<SkillVersionMeta>> {
    validate_id(skill_id)?;
    let path = source_history_path(skill_id);
    let history = source_history();
    let mut versions = Vec::new();
    for version in history.list(&path, None)? {
        let Some(source) = history.read(&path, &version.id)? else {
            continue;
        };
        let name = crate::parse_skill_md(skill_id, &source)
            .map(|record| record.name)
            .unwrap_or_else(|_| skill_id.to_owned());
        versions.push(SkillVersionMeta {
            id: version.id,
            skill_id: skill_id.to_owned(),
            name,
            label: version.label,
            created_at: version.created_at,
        });
    }
    versions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(versions)
}

/// Load one saved version in full (including its captured source).
pub fn load_skill_version(
    skill_id: &str,
    version_id: &str,
) -> std::io::Result<Option<SkillVersion>> {
    validate_id(skill_id)?;
    // Imported legacy snapshots keep their UUID as 32 hex digits, so an id the
    // UI cached in its hyphenated form still resolves.
    let version_id = version_id.replace('-', "").to_ascii_lowercase();
    let version_id = version_id.as_str();
    if is_git_version_id(version_id) {
        let path = source_history_path(skill_id);
        let history = source_history();
        if let Some(source) = history.read(&path, version_id)? {
            let name = crate::parse_skill_md(skill_id, &source)
                .map(|record| record.name)
                .unwrap_or_else(|_| skill_id.to_owned());
            let metadata = history
                .list(&path, Some(1000))?
                .into_iter()
                .find(|version| version.id == version_id);
            return Ok(Some(SkillVersion {
                id: version_id.to_owned(),
                skill_id: skill_id.to_owned(),
                name,
                label: metadata.as_ref().and_then(|version| version.label.clone()),
                created_at: metadata
                    .map(|version| version.created_at)
                    .unwrap_or_else(now_millis),
                source,
            }));
        }
    }
    Ok(None)
}

fn is_git_version_id(version_id: &str) -> bool {
    (7..=64).contains(&version_id.len())
        && version_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

/// Restore a saved version as the skill's current SKILL.md. Records the current
/// on-disk source as a named undo point first, so the restore is itself undoable;
/// unlabeled identical saves remain idempotent. The captured source is then written
/// back verbatim (lossless). Returns the restored source, or `None` when the version
/// does not exist. The caller reloads the registry so the change is live.
pub fn restore_skill_version(skill_id: &str, version_id: &str) -> std::io::Result<Option<String>> {
    let Some(version) = load_skill_version(skill_id, version_id)? else {
        return Ok(None);
    };
    // Best-effort: a skill whose file was deleted out from under us simply has
    // nothing to snapshot.
    let _ = snapshot_skill(skill_id, Some("Before restore"));
    write_skill_md(skill_id, &version.source)?;
    checkpoint_source_history_best_effort(
        &source_history_path(skill_id),
        &version.source,
        Some("Restore skill version"),
    );
    Ok(Some(version.source))
}

/// Delete legacy JSON snapshots for a skill. Git source history is immutable and
/// is intentionally not removed by this compatibility operation.
pub fn delete_skill_versions(skill_id: &str) -> std::io::Result<bool> {
    let dir = skill_versions_dir(skill_id)?;
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
#[path = "store_versions_tests.rs"]
mod tests;
