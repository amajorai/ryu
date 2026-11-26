//! Install a catalog skill into the skills folder, and check installed skills for updates.
// test-exempt: moved verbatim out of skills_catalog/mod.rs by the module split; covered by skills_catalog/tests.rs.

use super::*;

// ── Install ───────────────────────────────────────────────────────────────

/// Outcome of installing a Skill.
#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub slug: String,
    pub path: String,
    #[serde(skip)]
    pub(crate) artifact_fingerprint: Option<String>,
}

/// The index of a package's entry doc: the file named `SKILL.md` (any case)
/// nearest the package root, else the first file whose path ends with
/// `skill.md`. Install stages exactly this file as `SKILL.md` and fingerprints
/// these same bytes, and detail and update checks read it too, so a package
/// that also ships e.g. `examples/writing-a-skill.md` never installs one doc
/// while reporting or comparing another.
pub(super) fn entry_skill_doc_index(files: &[DownloadFile]) -> Option<usize> {
    let depth = |path: &str| {
        path.split(['/', '\\'])
            .filter(|segment| !segment.is_empty() && *segment != ".")
            .count()
    };
    files
        .iter()
        .enumerate()
        .filter(|(_, f)| {
            f.path
                .rsplit(['/', '\\'])
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        })
        .min_by_key(|(_, f)| depth(&f.path))
        .or_else(|| {
            files
                .iter()
                .enumerate()
                .find(|(_, f)| f.path.to_lowercase().ends_with("skill.md"))
        })
        .map(|(index, _)| index)
}

/// Write a downloaded skill package into `staging`: the entry doc (see
/// [`entry_skill_doc_index`]) as `SKILL.md`, every other file at its declared
/// relative path.
pub(super) async fn stage_skill_files(
    staging: &std::path::Path,
    files: &[DownloadFile],
) -> Result<()> {
    tokio::fs::create_dir_all(staging)
        .await
        .with_context(|| format!("creating {}", staging.display()))?;
    let entry = entry_skill_doc_index(files);
    let entry_dest = staging.join("SKILL.md");
    for (index, f) in files.iter().enumerate() {
        let dest = if Some(index) == entry {
            entry_dest.clone()
        } else {
            let Some(dest) = safe_join(staging, &f.path) else {
                tracing::warn!("skipping skill file with unsafe path: {}", f.path);
                continue;
            };
            // A second root-level `skill.md` would replace the entry doc on a
            // case-insensitive filesystem.
            if dest
                .strip_prefix(staging)
                .is_ok_and(|relative| relative.as_os_str().eq_ignore_ascii_case("SKILL.md"))
            {
                tracing::warn!("skipping a second root skill doc: {}", f.path);
                continue;
            }
            dest
        };
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        tokio::fs::write(&dest, &f.contents)
            .await
            .with_context(|| format!("writing {}", dest.display()))?;
    }
    Ok(())
}

/// Move every staged file into `skill_dir`, `SKILL.md` LAST, so a concurrent
/// registry reload never sees a new entry doc beside old resources. Each move
/// is a same-volume rename, which replaces the destination atomically.
pub(super) async fn place_staged_skill(
    staging: &std::path::Path,
    skill_dir: &std::path::Path,
) -> Result<()> {
    let mut pending = vec![staging.to_path_buf()];
    let mut files = Vec::new();
    while let Some(dir) = pending.pop() {
        let mut entries = tokio::fs::read_dir(&dir)
            .await
            .with_context(|| format!("reading {}", dir.display()))?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if entry.file_type().await?.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    let entry_doc = staging.join("SKILL.md");
    files.sort_by_key(|path| *path == entry_doc);
    for source in files {
        let relative = source
            .strip_prefix(staging)
            .context("staged skill file escaped its staging dir")?;
        let dest = skill_dir.join(relative);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        tokio::fs::rename(&source, &dest)
            .await
            .with_context(|| format!("rename {} -> {}", source.display(), dest.display()))?;
    }
    Ok(())
}

/// The folder name and the folder for the catalog id `id` under `skills_root`.
/// The name is the third part of the id, the same text the download asks the
/// catalog for, so it may hold no `/` (the id `o/r/x/..` asks for `x/..`, and
/// the text after its last slash would write into the parent of the skills
/// folder). It must be one plain name: not empty, not `.` or `..`, and on
/// Windows free of `:` and `\`, where a name such as `C:x` makes the join drop
/// the skills folder. No file system call is made.
fn skill_folder(skills_root: &std::path::Path, id: &str) -> Result<(String, std::path::PathBuf)> {
    let (_, _, name) = split_id(id).context("skill id must be owner/repo/slug")?;
    let skill_dir = crate::sidecar::extract_guard::names::append_named(
        skills_root,
        &name,
        "skill id tail",
        false,
    )?;
    Ok((name, skill_dir))
}

/// Download a Skill and write it into the universal Agent Skills directory in the
/// standard one-directory-per-skill layout: `~/.claude/skills/<slug>/SKILL.md`
/// plus every bundled resource at its declared relative path. The
/// [`ryu_skills::SkillRegistry`] loads it on next scan, and so do Claude Code
/// and the skills CLI, which read the same directory.
pub async fn install_skill(client: &reqwest::Client, id: &str) -> Result<InstallResult> {
    // Before the request: a refused id asks the catalog for nothing and creates
    // nothing.
    let skills_root = ryu_skills::SkillRegistry::skills_dir();
    let (slug, skill_dir) = skill_folder(&skills_root, id)?;
    let files = download(client, id).await?;

    let Some(entry_doc) = entry_skill_doc_index(&files) else {
        anyhow::bail!("package has no SKILL.md — cannot install");
    };

    tokio::fs::create_dir_all(&skills_root)
        .await
        .with_context(|| format!("creating skills dir {}", skills_root.display()))?;

    // Stage every file first, in a sibling directory on the same volume. An
    // update that fails partway (disk full, a bad path) then leaves the
    // installed skill exactly as it was, instead of a mix of old and new files.
    // Files the new version dropped are deliberately not deleted: this
    // directory is shared with other agents, and users keep their own files in
    // it.
    //
    // Staged BESIDE the skills dir, not in it: every agent that scans the
    // skills dir (Ryu's registry, Claude Code) would load a staging folder
    // holding a SKILL.md as a skill of its own.
    //
    // A fresh directory per install, so two installs of the same skill (an
    // "Update all" overlapping a manual update) never share or delete each
    // other's staging. Removed when it drops.
    let staging_root = skills_root
        .parent()
        .unwrap_or(&skills_root)
        .join(".ryu-skill-staging");
    tokio::fs::create_dir_all(&staging_root)
        .await
        .with_context(|| format!("creating {}", staging_root.display()))?;
    let staging_dir = tempfile::Builder::new()
        .prefix(&format!("{slug}-"))
        .tempdir_in(&staging_root)
        .with_context(|| format!("creating a staging dir in {}", staging_root.display()))?;
    let staging = staging_dir.path().to_path_buf();
    stage_skill_files(&staging, &files).await?;
    place_staged_skill(&staging, &skill_dir).await?;
    drop(staging_dir);
    let dest = skill_dir.join("SKILL.md");
    // The same entry doc stage_skill_files wrote as SKILL.md.
    let skill_md_contents = files[entry_doc].contents.as_str();

    // Record provenance (slug → full id) so the installed view can deep-link
    // back to the catalog detail for this Skill.
    record_provenance(&slug, id);
    // A skill the user installed *through Ryu* is active by default — it injects
    // on the default chat route (bulk-discovered shared-dir skills do not until
    // the user activates them).
    ryu_skills::set_active(&slug, true);
    // A catalog install is a user choice, so the skill is user-owned — the
    // bundled-system sync must never auto-remove it.
    crate::skills_catalog::system_skills::record_origin(
        &slug,
        crate::skills_catalog::system_skills::SkillOrigin::User,
    );

    let result = InstallResult {
        artifact_fingerprint: public_stats::artifact_fingerprint(&slug, skill_md_contents),
        slug,
        path: dest.to_string_lossy().to_string(),
    };
    if uses_public_catalog() {
        // The successful download above came from the canonical anonymous
        // public listing endpoint and supplied these exact installed bytes.
        public_stats::record_public_install(id, &result);
    }
    Ok(result)
}

/// One installed skill whose local SKILL.md differs from the current upstream
/// package — i.e. an update is available. Content-diff is the only viable signal
/// because skills.sh exposes no per-skill version; it is also fully retroactive
/// (works for skills installed before this check existed).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SkillUpdate {
    /// On-disk skill slug (`~/.claude/skills/<slug>/`).
    pub slug: String,
    /// Full catalog id (`owner/repo/slug`) — the apply/re-install key.
    pub id: String,
    /// Display name (the slug; skills.sh has no separate title on the package).
    pub name: String,
    /// The catalog source the update was found on, and so the one that must
    /// apply it. Detection always reads skills.sh; applying through whichever
    /// source happens to be active sent a skills.sh id to a different
    /// marketplace, which failed and left the row in place.
    pub source: &'static str,
}

/// Normalise SKILL.md text for comparison: unify line endings and ignore
/// trailing whitespace so a checkout/CRLF difference never reads as an update.
pub(super) fn normalise_skill_md(s: &str) -> String {
    s.replace("\r\n", "\n").trim_end().to_string()
}

/// Detect which installed (through-Ryu) skills have a newer upstream SKILL.md.
/// For each skill with recorded provenance (`slug → owner/repo/slug`), re-fetch
/// the upstream package and byte-compare its SKILL.md against the on-disk copy.
/// Best-effort per skill: a failed fetch/read skips that one rather than failing
/// the whole check.
pub async fn check_updates(client: &reqwest::Client) -> Vec<SkillUpdate> {
    let provenance = load_provenance();
    let mut out = Vec::new();
    for (slug, id) in provenance {
        let local_path = ryu_skills::SkillRegistry::skills_dir()
            .join(&slug)
            .join("SKILL.md");
        let Ok(local) = tokio::fs::read_to_string(&local_path).await else {
            continue;
        };
        let Ok(files) = download(client, &id).await else {
            continue;
        };
        // Compare the same entry doc install_skill writes as SKILL.md, so a
        // package that ships SKILL.md at a nested path (e.g. `slug/SKILL.md`) is
        // still update-checked rather than silently skipped.
        let Some(remote) = entry_skill_doc_index(&files).map(|index| &files[index]) else {
            continue;
        };
        if normalise_skill_md(&local) != normalise_skill_md(&remote.contents) {
            out.push(SkillUpdate {
                name: slug.clone(),
                slug,
                id,
                source: "skills-sh",
            });
        }
    }
    out
}

/// Join a package-declared relative path onto `base`, rejecting anything that
/// would escape the skill directory (absolute paths, `..`, drive/root
/// components). Returns `None` for an unsafe or empty path.
pub(super) fn safe_join(base: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    // Reject a rooted/UNC/drive-qualified path up front (before normalization
    // collapses the leading separators). A UNC `\\server\share` or rooted `/abs`
    // must never be joined onto a skill dir.
    if std::path::Path::new(rel).has_root()
        || rel.starts_with('/')
        || rel.starts_with('\\')
        || rel.contains(':')
    {
        return None;
    }
    let normalized = rel.replace('\\', "/");
    let mut out = base.to_path_buf();
    let mut pushed = false;
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        // Reject a rooted or drive-qualified segment. On Windows, `PathBuf::push`
        // with a rooted component (`C:/evil`, `\\server\share`, `/abs`) REPLACES
        // the base instead of appending, escaping the skill dir.
        if std::path::Path::new(segment).has_root() || segment.contains(':') {
            return None;
        }
        out.push(segment);
        pushed = true;
    }
    if pushed {
        Some(out)
    } else {
        None
    }
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
