//! The skills folder learned skills land in: the one place skill synthesis and
//! an approved learned skill reach the disk.
//!
//! Core uses [`SkillsDir::library`], the node's skills library: the
//! `RYU_SKILLS_DIR` (else `~/.claude/skills`) write root, the whole skills
//! namespace for id collisions, the node's activation set, and the managed
//! source history for the copy saved before a skill is replaced.
//! [`SkillsDir::isolated`] confines all of that to one folder and one history
//! store the caller owns, so the write paths can run against a temp dir.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use ryu_skills::store::{SkillVersionMeta, SourceHistory};

use super::library::{learned_skills_from, LearnedSkill};

/// A handle on the skills folder learned skills are written to. Cheap to clone;
/// clones of an isolated handle share its activation record.
#[derive(Clone)]
pub struct SkillsDir {
    scope: Scope,
}

#[derive(Clone)]
enum Scope {
    /// The node's skills library (paths resolved at each use, as before).
    Library,
    /// One folder plus one history store. It is not part of the node's
    /// library, so activating a skill here is only recorded on the handle.
    Isolated {
        root: PathBuf,
        history: SourceHistory,
        active: Arc<Mutex<BTreeSet<String>>>,
    },
}

impl SkillsDir {
    /// The node's skills library.
    pub fn library() -> Self {
        Self {
            scope: Scope::Library,
        }
    }

    /// Only `root` (skills are `<root>/<slug>/SKILL.md`) and `history` (the copy
    /// saved before a skill is replaced). Nothing outside them is read or written.
    pub fn isolated(root: PathBuf, history: SourceHistory) -> Self {
        Self {
            scope: Scope::Isolated {
                root,
                history,
                active: Arc::new(Mutex::new(BTreeSet::new())),
            },
        }
    }

    /// The folder new skills are written into.
    pub fn root(&self) -> PathBuf {
        match &self.scope {
            Scope::Library => ryu_skills::SkillRegistry::skills_dir(),
            Scope::Isolated { root, .. } => root.clone(),
        }
    }

    /// Every `learned-*` skill this folder's namespace holds, sorted by slug.
    pub fn learned_skills(&self) -> Vec<LearnedSkill> {
        learned_skills_from(match &self.scope {
            Scope::Library => ryu_skills::scan_all_skill_dirs(),
            Scope::Isolated { root, .. } => ryu_skills::scan_skill_dir(root),
        })
    }

    /// Whether `slug` resolves anywhere in the namespace, or already has a
    /// directory in the write root (the predicate the skills editor uses before
    /// creating a skill, so a direct write never shadows or reuses one).
    pub fn slug_taken(&self, slug: &str) -> bool {
        let resolves = match &self.scope {
            Scope::Library => ryu_skills::resolve_skill_md(slug).is_some(),
            Scope::Isolated { root, .. } => ryu_skills::scan_skill_dir(root)
                .iter()
                .any(|skill| skill.id == slug),
        };
        resolves || self.root().join(slug).exists()
    }

    /// Save the skill's current source to version history under `label`.
    /// `None` when the skill has no source in the write root.
    pub fn snapshot(&self, slug: &str, label: &str) -> std::io::Result<Option<SkillVersionMeta>> {
        match &self.scope {
            Scope::Library => ryu_skills::store::snapshot_skill(slug, Some(label)),
            Scope::Isolated { root, history, .. } => {
                ryu_skills::store::snapshot_skill_in(root, history, slug, Some(label))
            }
        }
    }

    /// Atomically write `<root>/<slug>/SKILL.md` (tmp + rename), mirroring the
    /// catalog installer so a concurrent registry reload never sees a
    /// half-written file.
    pub async fn write(&self, slug: &str, contents: &str) -> Result<()> {
        let dir = self.root().join(slug);
        tokio::fs::create_dir_all(&dir)
            .await
            .with_context(|| format!("creating skill dir {}", dir.display()))?;
        let tmp = dir.join("SKILL.md.tmp");
        let final_path = dir.join("SKILL.md");
        tokio::fs::write(&tmp, contents)
            .await
            .with_context(|| format!("writing {}", tmp.display()))?;
        tokio::fs::rename(&tmp, &final_path)
            .await
            .with_context(|| format!("renaming into {}", final_path.display()))?;
        Ok(())
    }

    /// Mark `slug` active.
    pub fn activate(&self, slug: &str) {
        match &self.scope {
            Scope::Library => ryu_skills::set_active(slug, true),
            Scope::Isolated { active, .. } => {
                active
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(slug.to_string());
            }
        }
    }

    /// Whether `slug` is marked active.
    pub fn is_active(&self, slug: &str) -> bool {
        match &self.scope {
            Scope::Library => ryu_skills::load_active_set().contains(slug),
            Scope::Isolated { active, .. } => active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .contains(slug),
        }
    }
}
