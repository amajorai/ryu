//! The task's own worktree in the owner's checkout, and the changes made in it.

use super::super::store::RunRecord;
use super::super::{cli, redact};
use super::keep_head;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;

const MAX_DIFF_BYTES: usize = 512 * 1024;

#[cfg(test)]
static WORKTREE_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

#[cfg(test)]
pub(crate) fn set_worktree_root_for_test(root: Option<PathBuf>) {
    *WORKTREE_ROOT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = root;
}

fn task_key(conversation_id: &str) -> String {
    let digest = Sha256::digest(conversation_id.as_bytes());
    digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn worktree_dir(conversation_id: &str) -> PathBuf {
    let name = format!("cloud-task-worktrees/{}", task_key(conversation_id));
    #[cfg(test)]
    if let Some(root) = WORKTREE_ROOT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        return root.join(name);
    }
    crate::paths::files_path(&name)
}

/// Every `git` here runs in the owner's checkout or in a worktree that shares its
/// `.git/config` and hooks. That configuration is not trusted: the hardened builder
/// from `ryu-workspace` switches off every program it can name (file monitor, hooks,
/// external diff, textconv), with the same allowlisted environment as before.
async fn git(cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = tokio::process::Command::from(ryu_workspace::git_command_with_env(
        args,
        cli::child_env(std::env::vars()),
    ));
    command
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| "git could not be run".to_owned())
}

/// The conversation's worktree and branch, created from the checkout's current `HEAD`
/// the first time.
pub(crate) async fn ensure_worktree(
    checkout: &Path,
    conversation_id: &str,
) -> Result<(PathBuf, String), String> {
    let dir = worktree_dir(conversation_id);
    let branch = format!("ryu/task-{}", task_key(conversation_id));
    if dir.join(".git").exists() {
        return Ok((dir, branch));
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| "the task folder could not be made".to_owned())?;
    }
    let target = dir.to_string_lossy().into_owned();
    let created = git(
        checkout,
        &["worktree", "add", "-b", &branch, &target, "HEAD"],
    )
    .await?;
    if created.status.success() {
        return Ok((dir, branch));
    }
    // The branch survives a removed worktree: reuse it.
    let reused = git(checkout, &["worktree", "add", &target, &branch]).await?;
    if reused.status.success() {
        Ok((dir, branch))
    } else {
        Err(redact::scrub(
            String::from_utf8_lossy(&created.stderr).trim(),
        ))
    }
}

/// What changed in the task's worktree since it started: the status and the patch
/// against the commit it started from, new files included.
#[derive(serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDiff {
    pub(crate) branch: Option<String>,
    /// `git status --porcelain` lines.
    pub(crate) files: Vec<String>,
    pub(crate) patch: String,
    /// The patch was cut at 512 KiB.
    pub(crate) truncated: bool,
}

pub(crate) async fn diff(record: &RunRecord) -> Result<LocalDiff, String> {
    let workspace = PathBuf::from(
        record
            .workspace
            .clone()
            .ok_or_else(|| "this run has no worktree".to_owned())?,
    );
    // Mark new files so they show in the patch; this touches only the task's own index.
    git(&workspace, &["add", "--intent-to-add", "--all"]).await?;
    let status = git(&workspace, &["status", "--porcelain"]).await?;
    let patch = git(&workspace, &["diff", "HEAD"]).await?;
    if !patch.status.success() {
        return Err("git could not read the changes".into());
    }
    let patch = String::from_utf8_lossy(&patch.stdout);
    let truncated = patch.len() > MAX_DIFF_BYTES;
    Ok(LocalDiff {
        branch: record.branch.clone(),
        files: String::from_utf8_lossy(&status.stdout)
            .lines()
            .take(2000)
            .map(str::to_owned)
            .collect(),
        patch: if truncated {
            keep_head(&patch, MAX_DIFF_BYTES)
        } else {
            patch.into_owned()
        },
        truncated,
    })
}

#[cfg(test)]
#[path = "worktree_tests.rs"]
mod tests;
