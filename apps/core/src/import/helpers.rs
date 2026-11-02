//! Small path, name, and manifest helpers shared by the scan and import steps.

use super::*;

/// True when a stem is a valid slash-command name (letters/digits/dash/underscore).
pub(super) fn is_valid_command_name(stem: &str) -> bool {
    !stem.is_empty()
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

pub(super) fn rel_path(root: &Path, path: &Path) -> String {
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

pub(super) fn file_size(path: &Path) -> Result<u64> {
    Ok(std::fs::metadata(path)?.len())
}

/// The install name a skill found at `dir` will get (mirrors
/// `from_source::skill_name_for` minus the tarball-root special case).
pub(super) fn skill_install_name(dir: &Path) -> String {
    if let Some(fm_name) = front_matter_name(dir) {
        return sanitize_name(&fm_name);
    }
    let base = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    sanitize_name(&base)
}

pub(super) fn front_matter_name(dir: &Path) -> Option<String> {
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

pub(super) fn sanitize_name(raw: &str) -> String {
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
pub(super) fn has_skill_md(dir: &Path) -> bool {
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
pub(super) fn find_manifest(dir: &Path) -> Option<&'static str> {
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
pub(super) fn plugin_id_from_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    val.get("id").and_then(|v| v.as_str()).map(str::to_string)
}

/// Cheap hint: does a plugin with `id` already look installed? A directory
/// exists under the plugins root (the loader's scan picks it up). Built-in id
/// collisions are not checked here — the import step reports the real conflict.
pub(super) fn plugin_dir_exists(id: &str) -> bool {
    crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(id))
        .is_dir()
}
