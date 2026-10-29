//! Portable conversation checkpoints in Git's object store.
//!
//! The active branch and worktree are never changed. A checkpoint is a commit
//! under `refs/ryu/checkpoints/<sha256>`, containing one `conversation.json`.
//! `refs/notes/ryu` is a lightweight index from the code commit to checkpoints.

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::process::{Output, Stdio};

use serde::Serialize;

use super::git_without_hooks;
use crate::win_process::NoWindow;

const MAX_CHECKPOINT_BYTES: usize = 8 * 1024 * 1024;
const MAX_METADATA_BYTES: usize = 8 * 1024;
const MAX_LIST: usize = 100;
const MAX_PUSH_CHECKPOINTS: usize = 1_000;
const CHECKPOINT_PREFIX: &str = "refs/ryu/checkpoints/";
const NOTES_REF: &str = "refs/notes/ryu";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoHead {
    pub root: String,
    pub head: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCheckpoint {
    pub checkpoint_id: String,
    pub checkpoint_ref: String,
    pub code_commit: String,
    pub already_saved: bool,
}

#[derive(Debug, Clone)]
pub struct VerifiedCheckpointRef {
    pub checkpoint_id: String,
    pub object_id: String,
}

fn git_output(cwd: &str, args: &[&str], input: Option<&[u8]>) -> Result<Output, String> {
    let mut command = git_without_hooks(args);
    command
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "Ryu")
        .env("GIT_AUTHOR_EMAIL", "history@ryu.local")
        .env("GIT_COMMITTER_NAME", "Ryu")
        .env("GIT_COMMITTER_EMAIL", "history@ryu.local")
        .no_window();
    if let Some(bytes) = input {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| "Git is unavailable".to_owned())?;
        child
            .stdin
            .take()
            .ok_or_else(|| "Git input is unavailable".to_owned())?
            .write_all(bytes)
            .map_err(|_| "Could not write the Git checkpoint".to_owned())?;
        child
            .wait_with_output()
            .map_err(|_| "Git did not finish the checkpoint operation".to_owned())
    } else {
        command
            .output()
            .map_err(|_| "Git is unavailable".to_owned())
    }
}

fn git_text(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = git_output(cwd, args, None)?;
    if !output.status.success() {
        // Git stderr may contain a credential-bearing remote URL or a path from
        // untrusted repository configuration. Never return it over the API.
        return Err("Git could not complete the history operation".to_owned());
    }
    String::from_utf8(output.stdout)
        .map(|text| text.trim().to_owned())
        .map_err(|_| "Git returned invalid text".to_owned())
}

fn git_text_with_input(cwd: &str, args: &[&str], input: &[u8]) -> Result<String, String> {
    let output = git_output(cwd, args, Some(input))?;
    if !output.status.success() {
        return Err("Git could not write the history checkpoint".to_owned());
    }
    String::from_utf8(output.stdout)
        .map(|text| text.trim().to_owned())
        .map_err(|_| "Git returned invalid text".to_owned())
}

fn valid_sha(value: &str) -> bool {
    (value.len() == 40 || value.len() == 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_checkpoint_id(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn repository_head(cwd: &str) -> Result<RepoHead, String> {
    let path =
        std::fs::canonicalize(cwd).map_err(|_| "Project folder is unavailable".to_owned())?;
    if !path.is_dir() {
        return Err("Project folder is not a directory".to_owned());
    }
    let path = path
        .to_str()
        .ok_or_else(|| "Project folder path is not UTF-8".to_owned())?;
    let root = git_text(path, &["rev-parse", "--show-toplevel"])?;
    let root =
        std::fs::canonicalize(root).map_err(|_| "Git repository root is unavailable".to_owned())?;
    if !Path::new(path).starts_with(&root) {
        return Err("Project folder escaped its Git repository".to_owned());
    }
    let root = root
        .to_str()
        .ok_or_else(|| "Git repository path is not UTF-8".to_owned())?;
    let head = git_text(root, &["rev-parse", "--verify", "HEAD^{commit}"])?;
    if !valid_sha(&head) {
        return Err("Git HEAD is invalid".to_owned());
    }
    let branch = git_text(root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
    Ok(RepoHead {
        root: root.to_owned(),
        head,
        branch,
    })
}

pub fn read_checkpoint(cwd: &str, checkpoint_id: &str) -> Result<Vec<u8>, String> {
    let object_id = checkpoint_ref_oid(cwd, checkpoint_id)?;
    read_checkpoint_at_oid(cwd, &object_id)
}

pub fn read_checkpoint_metadata(cwd: &str, checkpoint_id: &str) -> Result<Vec<u8>, String> {
    let object_id = checkpoint_ref_oid(cwd, checkpoint_id)?;
    read_checkpoint_metadata_at_oid(cwd, &object_id)
}

pub fn checkpoint_ref_oid(cwd: &str, checkpoint_id: &str) -> Result<String, String> {
    if !valid_checkpoint_id(checkpoint_id) {
        return Err("Invalid checkpoint id".to_owned());
    }
    let repo = repository_head(cwd)?;
    let reference = format!("{CHECKPOINT_PREFIX}{checkpoint_id}^{{commit}}");
    let oid = git_text(&repo.root, &["rev-parse", "--verify", &reference])?;
    if !valid_sha(&oid) {
        return Err("Checkpoint ref has an invalid Git object id".to_owned());
    }
    Ok(oid)
}

pub fn read_checkpoint_at_oid(cwd: &str, object_id: &str) -> Result<Vec<u8>, String> {
    read_checkpoint_file_at_oid(cwd, object_id, "conversation.json", MAX_CHECKPOINT_BYTES)
}

pub fn read_checkpoint_metadata_at_oid(cwd: &str, object_id: &str) -> Result<Vec<u8>, String> {
    read_checkpoint_file_at_oid(cwd, object_id, "metadata.json", MAX_METADATA_BYTES)
}

fn read_checkpoint_file_at_oid(
    cwd: &str,
    object_id: &str,
    filename: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    if !valid_sha(object_id) {
        return Err("Invalid checkpoint object id".to_owned());
    }
    let repo = repository_head(cwd)?;
    let object_path = format!("{object_id}:{filename}");
    let size = git_text(&repo.root, &["cat-file", "-s", &object_path])?
        .parse::<usize>()
        .map_err(|_| "Checkpoint size is invalid".to_owned())?;
    if size > max_bytes {
        return Err("Checkpoint file exceeds its size limit".to_owned());
    }
    let output = git_output(&repo.root, &["cat-file", "blob", &object_path], None)?;
    if !output.status.success() || output.stdout.len() != size {
        return Err("Checkpoint could not be read".to_owned());
    }
    Ok(output.stdout)
}

pub fn list_checkpoint_ids(cwd: &str) -> Result<Vec<String>, String> {
    let repo = repository_head(cwd)?;
    let count = format!("--count={MAX_LIST}");
    let names = git_text(
        &repo.root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &count,
            "--format=%(refname)",
            CHECKPOINT_PREFIX,
        ],
    )?;
    Ok(names
        .lines()
        .filter_map(|name| name.strip_prefix(CHECKPOINT_PREFIX))
        .filter(|id| valid_checkpoint_id(id))
        .map(str::to_owned)
        .collect())
}

pub fn list_all_checkpoint_ids_for_push(cwd: &str) -> Result<Vec<String>, String> {
    let repo = repository_head(cwd)?;
    let names = git_text(
        &repo.root,
        &["for-each-ref", "--format=%(refname)", CHECKPOINT_PREFIX],
    )?;
    let mut ids = Vec::new();
    for name in names.lines() {
        let id = name
            .strip_prefix(CHECKPOINT_PREFIX)
            .filter(|value| valid_checkpoint_id(value))
            .ok_or_else(|| "Repository has an invalid Ryu checkpoint ref".to_owned())?;
        ids.push(id.to_owned());
        if ids.len() > MAX_PUSH_CHECKPOINTS {
            return Err("Too many checkpoints to push in one operation".to_owned());
        }
    }
    Ok(ids)
}

/// Store already-redacted JSON. This layer intentionally knows nothing about
/// conversation content, caller identity, or redaction policy.
pub fn save_checkpoint(
    cwd: &str,
    expected_root: &str,
    expected_head: &str,
    checkpoint_id: &str,
    payload: &[u8],
    metadata: &[u8],
) -> Result<SavedCheckpoint, String> {
    if !valid_checkpoint_id(checkpoint_id) {
        return Err("Invalid checkpoint id".to_owned());
    }
    if payload.len() > MAX_CHECKPOINT_BYTES {
        return Err("Checkpoint exceeds the 8 MiB limit".to_owned());
    }
    if metadata.len() > MAX_METADATA_BYTES {
        return Err("Checkpoint metadata exceeds the 8 KiB limit".to_owned());
    }
    let repo = repository_head(cwd)?;
    if repo.root != expected_root {
        return Err("Git repository changed since the preview; refresh before saving".to_owned());
    }
    if repo.head != expected_head {
        return Err("Git HEAD changed since the preview; refresh before saving".to_owned());
    }
    let checkpoint_ref = format!("{CHECKPOINT_PREFIX}{checkpoint_id}");
    let existing = git_output(&repo.root, &["show-ref", "--verify", &checkpoint_ref], None)?;
    let already_saved = existing.status.success();
    if already_saved {
        if read_checkpoint(&repo.root, checkpoint_id)? != payload {
            return Err("Checkpoint id already contains different content".to_owned());
        }
    } else {
        let blob = git_text_with_input(&repo.root, &["hash-object", "-w", "--stdin"], payload)?;
        let metadata_blob =
            git_text_with_input(&repo.root, &["hash-object", "-w", "--stdin"], metadata)?;
        if !valid_sha(&blob) || !valid_sha(&metadata_blob) {
            return Err("Git returned an invalid checkpoint blob".to_owned());
        }
        let tree_input = format!(
            "100644 blob {blob}\tconversation.json\n100644 blob {metadata_blob}\tmetadata.json\n"
        );
        let tree = git_text_with_input(&repo.root, &["mktree"], tree_input.as_bytes())?;
        if !valid_sha(&tree) {
            return Err("Git returned an invalid checkpoint tree".to_owned());
        }
        let message = format!("Ryu conversation checkpoint {checkpoint_id}");
        let checkpoint_commit = git_text(&repo.root, &["commit-tree", &tree, "-m", &message])?;
        if !valid_sha(&checkpoint_commit) {
            return Err("Git returned an invalid checkpoint commit".to_owned());
        }
        let zero_oid = "0".repeat(repo.head.len());
        git_text(
            &repo.root,
            &["update-ref", &checkpoint_ref, &checkpoint_commit, &zero_oid],
        )?;
    }

    let marker = format!("ryu:checkpoint:{checkpoint_id}");
    let existing_note = git_output(
        &repo.root,
        &["notes", "--ref=ryu", "show", &repo.head],
        None,
    )?;
    if !existing_note.status.success()
        || !String::from_utf8_lossy(&existing_note.stdout)
            .lines()
            .any(|line| line.trim() == marker)
    {
        git_text(
            &repo.root,
            &["notes", "--ref=ryu", "append", "-m", &marker, &repo.head],
        )?;
    }
    Ok(SavedCheckpoint {
        checkpoint_id: checkpoint_id.to_owned(),
        checkpoint_ref,
        code_commit: repo.head,
        already_saved,
    })
}

/// Explicit transfer of history refs. No ordinary code branch is pushed or
/// fetched, and these functions are never called by a background hook.
pub fn sync_history(
    cwd: &str,
    action: &str,
    verified_refs: &[VerifiedCheckpointRef],
) -> Result<(), String> {
    let repo = repository_head(cwd)?;
    if action != "push" && action != "fetch" {
        return Err("Invalid history sync action".to_owned());
    }
    let notes_exist = if action == "push" {
        git_output(&repo.root, &["show-ref", "--verify", NOTES_REF], None)?
            .status
            .success()
    } else {
        git_output(
            &repo.root,
            &["ls-remote", "--exit-code", "origin", NOTES_REF],
            None,
        )?
        .status
        .success()
    };
    let notes_oid = if action == "push" && notes_exist {
        let oid = git_text(
            &repo.root,
            &["rev-parse", "--verify", "refs/notes/ryu^{commit}"],
        )?;
        if !valid_sha(&oid) {
            return Err("Ryu Git notes have an invalid object id".to_owned());
        }
        Some(oid)
    } else {
        None
    };
    if action == "push" {
        if verified_refs.is_empty() {
            return Err("There are no verified local checkpoints to push".to_owned());
        }
        let approved: HashSet<&str> = verified_refs
            .iter()
            .map(|reference| reference.checkpoint_id.as_str())
            .collect();
        if approved.len() != verified_refs.len()
            || verified_refs.iter().any(|reference| {
                !valid_checkpoint_id(&reference.checkpoint_id) || !valid_sha(&reference.object_id)
            })
        {
            return Err("History contains an invalid checkpoint id".to_owned());
        }
        if notes_exist {
            let notes = git_text(&repo.root, &["notes", "--ref=ryu", "list"])?;
            for row in notes.lines() {
                let Some((_note_oid, code_commit)) = row.split_once(' ') else {
                    return Err("Ryu Git notes are malformed".to_owned());
                };
                if !valid_sha(code_commit) {
                    return Err("Ryu Git notes are malformed".to_owned());
                }
                let content = git_text(&repo.root, &["notes", "--ref=ryu", "show", code_commit])?;
                for marker in content.lines().filter(|line| !line.trim().is_empty()) {
                    let Some(id) = marker.trim().strip_prefix("ryu:checkpoint:") else {
                        return Err("Ryu Git notes contain unreviewed content".to_owned());
                    };
                    if !approved.contains(id) {
                        return Err("Ryu Git notes reference an unverified checkpoint".to_owned());
                    }
                }
            }
            if git_text(
                &repo.root,
                &["rev-parse", "--verify", "refs/notes/ryu^{commit}"],
            )? != notes_oid.as_deref().unwrap_or_default()
            {
                return Err("Ryu Git notes changed during privacy review".to_owned());
            }
        }
        let mut args = vec!["push".to_owned(), "--".to_owned(), "origin".to_owned()];
        for reference in verified_refs {
            args.push(format!(
                "{}:{CHECKPOINT_PREFIX}{}",
                reference.object_id, reference.checkpoint_id
            ));
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git_text(&repo.root, &refs)?;
    } else {
        git_text(
            &repo.root,
            &[
                "fetch",
                "--",
                "origin",
                "refs/ryu/checkpoints/*:refs/ryu/checkpoints/*",
            ],
        )?;
    }
    if notes_exist {
        let notes_source = notes_oid.as_deref().unwrap_or("refs/notes/ryu");
        let refspec = format!("{notes_source}:refs/notes/ryu");
        git_text(&repo.root, &[action, "--", "origin", &refspec])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &str, args: &[&str]) -> String {
        git_text(cwd, args).expect("git command")
    }

    #[test]
    fn checkpoint_stays_off_branch_and_is_idempotent() {
        let dir = tempfile::tempdir().expect("temp repo");
        let cwd = dir.path().to_str().expect("utf8");
        git(cwd, &["init", "-q"]);
        git(
            cwd,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "Initial",
            ],
        );
        let head = repository_head(cwd).expect("head");
        let payload = br#"{"format":"ryu-portable-conversation","title":"safe"}"#;
        let id = "a".repeat(64);
        let metadata = br#"{"title":"safe"}"#;
        let first =
            save_checkpoint(cwd, &head.root, &head.head, &id, payload, metadata).expect("save");
        let second = save_checkpoint(cwd, &head.root, &head.head, &id, payload, metadata)
            .expect("save twice");
        assert!(!first.already_saved);
        assert!(second.already_saved);
        assert_eq!(read_checkpoint(cwd, &id).expect("read"), payload);
        assert_eq!(
            read_checkpoint_metadata(cwd, &id).expect("metadata"),
            metadata
        );
        assert_eq!(repository_head(cwd).expect("head after").head, head.head);
        assert_eq!(
            git(cwd, &["notes", "--ref=ryu", "show", &head.head])
                .matches(&id)
                .count(),
            1
        );
    }

    #[test]
    fn checkpoint_refs_round_trip_through_a_git_remote() {
        let source = tempfile::tempdir().expect("source repo");
        let remote = tempfile::tempdir().expect("bare remote");
        let clone_parent = tempfile::tempdir().expect("clone parent");
        let source_path = source.path().to_str().expect("utf8");
        let remote_path = remote.path().to_str().expect("utf8");
        git(remote_path, &["init", "--bare", "-q"]);
        git(source_path, &["init", "-q"]);
        git(
            source_path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-qm",
                "Initial",
            ],
        );
        git(source_path, &["remote", "add", "origin", remote_path]);
        git(
            source_path,
            &["push", "-q", "origin", "HEAD:refs/heads/main"],
        );
        let head = repository_head(source_path).expect("head");
        let payload = br#"{"format":"ryu-portable-conversation","title":"safe"}"#;
        let metadata = br#"{"title":"safe"}"#;
        let id = "b".repeat(64);
        save_checkpoint(source_path, &head.root, &head.head, &id, payload, metadata).expect("save");
        let verified = VerifiedCheckpointRef {
            checkpoint_id: id.clone(),
            object_id: checkpoint_ref_oid(source_path, &id).expect("checkpoint oid"),
        };
        // Simulate a local ref changing after Core reviewed the original
        // object. Pushing the ref name would send this replacement instead.
        let replacement_blob = git_text_with_input(
            source_path,
            &["hash-object", "-w", "--stdin"],
            br#"{"content":"unreviewed replacement"}"#,
        )
        .expect("replacement blob");
        let replacement_tree = git_text_with_input(
            source_path,
            &["mktree"],
            format!("100644 blob {replacement_blob}\tconversation.json\n").as_bytes(),
        )
        .expect("replacement tree");
        let replacement_commit = git(
            source_path,
            &["commit-tree", &replacement_tree, "-m", "Replacement"],
        );
        git(
            source_path,
            &[
                "update-ref",
                &format!("{CHECKPOINT_PREFIX}{id}"),
                &replacement_commit,
            ],
        );
        sync_history(source_path, "push", &[verified]).expect("push history");

        let clone_path = clone_parent.path().join("clone");
        let clone = clone_path.to_str().expect("utf8");
        git(
            clone_parent.path().to_str().expect("utf8"),
            &["clone", "-q", "-b", "main", remote_path, clone],
        );
        sync_history(clone, "fetch", &[]).expect("fetch history");
        assert_eq!(read_checkpoint(clone, &id).expect("restored"), payload);
        assert!(git(clone, &["notes", "--ref=ryu", "show", &head.head]).contains(&id));
    }
}
