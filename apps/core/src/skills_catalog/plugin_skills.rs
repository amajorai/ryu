//! Plugin-bundled Agent Skills — folder-convention materialization.
//!
//! A plugin may ship one or more Agent Skills under `<plugin_root>/skills/`,
//! dir-per-skill (`skills/<slug>/SKILL.md`, the exact layout the skills scanner
//! and `skills_catalog::from_source` already recognise). On plugin **enable** those
//! skill directories are copied into the canonical write root
//! (`SkillRegistry::skills_dir()` = `~/.claude/skills/<slug>`) and activated; on
//! **disable** they are deactivated (files left in place, mirroring the record);
//! on **uninstall** the plugin-owned directories are deleted.
//!
//! ## Ownership without a schema change
//!
//! `PluginRecord` has no skills column, so ownership is tracked with an inert
//! marker file — [`OWNER_MARKER`] (`~/.claude/skills/<slug>/.ryu-plugin-owner`,
//! containing the owning plugin id). The skills scanner keys on `SKILL.md` and
//! ignores every other file, so the marker never appears as a skill. This makes
//! the two sharp edges safe:
//!
//! - **copy-if-absent** — a destination `<slug>` that already exists and is NOT
//!   owned by this plugin is never overwritten (a user's hand-installed skill of
//!   the same name is preserved; the plugin's copy is skipped + logged).
//! - **owned-only removal** — uninstall deletes a `<slug>` only when its marker
//!   names this plugin, so it can never delete a user's skill.
//!
//! ## Built-in vs user-installed (the discriminating fork)
//!
//! A **user-installed / satellite** plugin lives on disk at
//! `~/.ryu/plugins/<id>/`, so `<id>/skills/` is present and this materializer
//! works directly. A **built-in** plugin ships only its compiled-in manifest
//! fixture (`include_str!`), so `plugins-store/<x>/skills/` is NOT on the user's
//! machine; materializing built-in skills needs a compile-time embed
//! (`include_dir!`) parallel to the fixture. That embed is a deliberate follow-up
//! — [`plugin_skills_root`] returns `None` for a plugin with no on-disk dir and
//! logs it, so built-ins are an explicit no-op, never a silent one.

use std::path::{Path, PathBuf};

/// Inert marker file dropped inside each plugin-materialized skill directory,
/// containing the owning plugin id. Ignored by the skills scanner (which keys on
/// `SKILL.md`), so it never surfaces as a skill; read back on uninstall to delete
/// only the directories this plugin owns.
pub const OWNER_MARKER: &str = ".ryu-plugin-owner";

/// The on-disk root a plugin's bundled skills live under, or `None`.
///
/// User-installed / satellite plugins live at `~/.ryu/plugins/<id>/`, so their
/// `skills/` subdir is on disk. Built-in plugins ship only the compiled-in
/// manifest fixture (no `skills/` on the user's machine) — they return `None`, a
/// logged no-op pending the `include_dir!` embed follow-up. The id is validated
/// before it is used as a path component.
pub fn plugin_skills_root(plugin_id: &str) -> Option<PathBuf> {
    if crate::plugin_manifest::validate_plugin_id(plugin_id).is_err() {
        return None;
    }
    let dir = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(plugin_id)
        .join("skills");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// Materialize + activate every bundled skill a plugin ships (enable seam).
///
/// Scans `<plugin_root>/skills` for dir-per-skill `SKILL.md` layouts, and for each
/// discovered skill COPY-IF-ABSENT into `~/.claude/skills/<slug>`: an existing
/// destination owned by this plugin is refreshed, one owned by another plugin or
/// the user is skipped (never clobbered). Then drops the [`OWNER_MARKER`] and
/// activates the slug. Returns the slugs that were materialized. Best-effort: a
/// per-skill failure is logged, never fatal.
pub fn install_plugin_skills(plugin_id: &str) -> Vec<String> {
    let Some(root) = plugin_skills_root(plugin_id) else {
        return Vec::new();
    };
    let write_root = ryu_skills::SkillRegistry::skills_dir();
    let mut installed = Vec::new();
    for skill_dir in discover_skill_dirs(&root) {
        let Some(slug) = skill_dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let dest = write_root.join(slug);
        // copy-if-absent: never overwrite a directory this plugin does not own.
        if dest.exists() && marker_owner(&dest).as_deref() != Some(plugin_id) {
            tracing::warn!(
                plugin = %plugin_id,
                slug,
                "install_plugin_skills: destination exists and is not owned by this plugin — skipping"
            );
            continue;
        }
        if let Err(e) = copy_skill_dir(&skill_dir, &dest) {
            tracing::warn!(plugin = %plugin_id, slug, "install_plugin_skills: copy failed: {e}");
            continue;
        }
        if let Err(e) = std::fs::write(dest.join(OWNER_MARKER), plugin_id) {
            tracing::warn!(plugin = %plugin_id, slug, "install_plugin_skills: writing owner marker failed: {e}");
        }
        ryu_skills::set_active(slug, true);
        installed.push(slug.to_owned());
    }
    if !installed.is_empty() {
        tracing::info!(plugin = %plugin_id, skills = ?installed, "materialized plugin-bundled skill(s)");
    }
    installed
}

/// Deactivate a plugin's bundled skills (disable seam) — flip each owned slug
/// inactive but LEAVE the files on disk, mirroring how a disabled plugin's record
/// persists. Returns the deactivated slugs.
pub fn deactivate_plugin_skills(plugin_id: &str) -> Vec<String> {
    let mut done = Vec::new();
    for (slug, _dir) in owned_skill_dirs(plugin_id) {
        ryu_skills::set_active(&slug, false);
        done.push(slug);
    }
    done
}

/// Remove a plugin's bundled skills from disk (uninstall seam) — delete only the
/// `~/.claude/skills/<slug>` directories whose owner marker names this plugin, and
/// deactivate each. A user's hand-installed skill of the same name (no marker, or
/// a marker naming a different plugin) is never touched. Returns removed slugs.
pub fn remove_plugin_skills(plugin_id: &str) -> Vec<String> {
    let mut removed = Vec::new();
    for (slug, dir) in owned_skill_dirs(plugin_id) {
        ryu_skills::set_active(&slug, false);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => removed.push(slug),
            Err(e) => {
                tracing::warn!(plugin = %plugin_id, slug, "remove_plugin_skills: delete failed: {e}");
            }
        }
    }
    if !removed.is_empty() {
        tracing::info!(plugin = %plugin_id, skills = ?removed, "removed plugin-bundled skill(s)");
    }
    removed
}

/// The `(slug, dir)` pairs under the skills write root whose owner marker names
/// `plugin_id`. The single "which skills does this plugin own" query, so
/// deactivate + remove can never touch a directory the plugin did not create.
fn owned_skill_dirs(plugin_id: &str) -> Vec<(String, PathBuf)> {
    let write_root = ryu_skills::SkillRegistry::skills_dir();
    let Ok(entries) = std::fs::read_dir(&write_root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        if marker_owner(&dir).as_deref() == Some(plugin_id) {
            if let Some(slug) = dir.file_name().and_then(|n| n.to_str()) {
                out.push((slug.to_owned(), dir.clone()));
            }
        }
    }
    out
}

/// Read the owner id from a skill directory's [`OWNER_MARKER`], trimmed. `None`
/// when the marker is absent/unreadable (a non-plugin skill).
fn marker_owner(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(OWNER_MARKER))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// The direct `<slug>/SKILL.md` skill directories under `<plugin_root>/skills`.
///
/// The plugin convention is dir-per-skill one level deep (`skills/<slug>/SKILL.md`),
/// so this is a single shallow scan — intentionally NOT the deep container walk
/// `from_source::find_skills` does for arbitrary fetched repos, because a plugin's
/// own tree is authored to the convention.
fn discover_skill_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir.is_dir() && has_skill_md(&dir) {
            out.push(dir);
        }
    }
    out
}

/// True when `dir` directly contains a `SKILL.md` (case-insensitive).
fn has_skill_md(dir: &Path) -> bool {
    if dir.join("SKILL.md").is_file() {
        return true;
    }
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|e| {
            e.path().is_file()
                && e.file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("SKILL.md")
        })
    })
}

/// Recursively copy `src` skill directory into `dest`, creating `dest`. Symlinks
/// are skipped (a bundled skill is plain files); the source is the plugin's own
/// on-disk tree, so this is a straight copy, not a traversal-guarded fetch.
fn copy_skill_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_skill_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A skill directory owned by plugin A is discovered as owned by A and not B.
    #[test]
    fn owner_marker_scopes_ownership() {
        let tmp = std::env::temp_dir().join(format!("ryu-plugin-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("RYU_SKILLS_DIR", &tmp);

        let a_dir = tmp.join("skill-a");
        std::fs::create_dir_all(&a_dir).unwrap();
        std::fs::write(a_dir.join("SKILL.md"), "# A").unwrap();
        std::fs::write(a_dir.join(OWNER_MARKER), "plugin-a").unwrap();

        let owned_by_a = owned_skill_dirs("plugin-a");
        assert_eq!(owned_by_a.len(), 1);
        assert_eq!(owned_by_a[0].0, "skill-a");
        assert!(owned_skill_dirs("plugin-b").is_empty());

        std::env::remove_var("RYU_SKILLS_DIR");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
