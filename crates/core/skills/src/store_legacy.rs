//! One-time import of the plaintext skill snapshots earlier builds wrote under
//! `state/skill-versions/<id>/<vid>.json` into the sealed source history.

use std::path::Path;

use ryu_workspace::source_history::SourceHistory;

use super::{SkillVersion, source_history, source_history_path, validate_id, versions_root};

/// What [`import_legacy_skill_versions`] did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct LegacyImportReport {
    /// Snapshots imported into the sealed history.
    pub imported: usize,
    /// Snapshot files that were not valid snapshots (unreadable before too) and
    /// were deleted with their folder.
    pub discarded: usize,
    /// Skill folders kept because an import or delete failed (retried next start).
    pub kept: usize,
}

/// Move the plaintext `state/skill-versions/<id>/<vid>.json` snapshots earlier
/// builds wrote into the sealed source history, keeping each one's label and
/// creation time (and its id, as 32 hex digits). A folder is deleted only after
/// every snapshot in it was imported and read back; any failure keeps the folder
/// for the next start. Idempotent.
pub fn import_legacy_skill_versions() -> LegacyImportReport {
    import_legacy_skill_versions_in(&versions_root(), &source_history())
}

pub(super) fn import_legacy_skill_versions_in(
    root: &Path,
    history: &SourceHistory,
) -> LegacyImportReport {
    let mut report = LegacyImportReport::default();
    let Ok(entries) = std::fs::read_dir(root) else {
        return report;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(skill_id) = dir.file_name().and_then(|name| name.to_str()) else {
            report.kept += 1;
            continue;
        };
        if validate_id(skill_id).is_err() {
            report.kept += 1;
            continue;
        }
        match import_legacy_skill_dir(&dir, skill_id, history) {
            Ok((imported, discarded)) => {
                report.imported += imported;
                report.discarded += discarded;
                if let Err(error) = std::fs::remove_dir_all(&dir) {
                    report.kept += 1;
                    tracing::warn!(skill = skill_id, %error, "legacy skill versions were imported but their plaintext folder was not removed");
                }
            }
            Err(error) => {
                report.kept += 1;
                tracing::warn!(skill = skill_id, %error, "legacy skill versions stay unencrypted until the next start");
            }
        }
    }
    // Drop the empty root so the status check sees nothing left.
    let _ = std::fs::remove_dir(root);
    if report.discarded > 0 {
        tracing::warn!(
            discarded = report.discarded,
            "deleted legacy skill snapshot files that were not readable snapshots"
        );
    }
    report
}

fn import_legacy_skill_dir(
    dir: &Path,
    skill_id: &str,
    history: &SourceHistory,
) -> std::io::Result<(usize, usize)> {
    let path = source_history_path(skill_id);
    let mut imported = 0;
    let mut discarded = 0;
    for entry in std::fs::read_dir(dir)? {
        let file = entry?.path();
        if file.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let bytes = std::fs::read(&file)?;
        let Ok(version) = serde_json::from_slice::<SkillVersion>(&bytes) else {
            discarded += 1;
            continue;
        };
        history.import_version(
            &path,
            Some(&version.id),
            version.created_at,
            version.label.as_deref(),
            &version.source,
        )?;
        imported += 1;
    }
    Ok((imported, discarded))
}

/// Why skill version history is still partly unencrypted: the legacy
/// `state/skill-versions/` folder holds snapshots the startup import has not
/// moved yet. `None` when nothing is left.
pub fn legacy_skill_versions_pending() -> Option<String> {
    let root = versions_root();
    let pending = std::fs::read_dir(&root)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .count();
    (pending > 0).then(|| {
        format!("{pending} skill(s) still have version snapshots from an earlier version that are not imported yet")
    })
}
