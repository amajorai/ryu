//! Worktree Diff Review app. Wired (B2) to Core's M1 git-native worktree store:
//! `review` reads the run's persisted [`WorktreeDiff`] and parses its unified
//! diff into the per-file / per-hunk shape the frozen `DiffReview` widget renders;
//! `apply` / `open_pr` land the whole tree (merge / PR); `discard` drops the run's
//! worktree.
//!
//! Run correlation: the widget forwards `run_id` from its `toolInput`, but the
//! authoritative key is `ctx.conversation_id` (threaded on the widget callTool
//! path), so every op resolves `args.run_id` first and falls back to the owning
//! conversation. This is why the conversation-id plumbing is load-bearing.
//!
//! Caveats (backend has no per-hunk granularity): the widget's include checkboxes
//! select hunks, but `apply` / `discard` operate on the WHOLE worktree — deselected
//! hunks are still applied/dropped. `apply_worktree` supports only whole-tree
//! merge/PR, so this is the v1 floor.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use super::{app_result, AppDispatchCtx};
use ryu_workspace::worktree::{apply_worktree, ApplyMode, FileChangeKind, WorktreeDiff};

pub async fn dispatch(tool: &str, args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    match tool {
        "review" => review(args, ctx).await,
        "apply" => apply(args, ctx, ApplyMode::Merge).await,
        "open_pr" => apply(args, ctx, ApplyMode::Pr).await,
        "discard" => discard(args, ctx).await,
        other => Err(anyhow!("unknown ryu.worktree tool '{other}'")),
    }
}

/// Resolve the run id: the explicit `run_id` arg, else the owning conversation.
fn resolve_run_id(args: &Value, ctx: &AppDispatchCtx<'_>) -> Option<String> {
    args.get("run_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| ctx.conversation_id.clone())
}

/// Read the diff for a run's worktree and shape it for the widget.
async fn review(args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    let store = ctx
        .worktree_diffs
        .ok_or_else(|| anyhow!("worktree store is unavailable"))?;
    let Some(run_id) = resolve_run_id(&args, ctx) else {
        return Ok(empty_review("(none)"));
    };

    let (diff, branch, path) = {
        let guard = store.lock().await;
        let Some(run) = guard.get(&run_id) else {
            return Ok(empty_review(&run_id));
        };
        let branch = run.guard.as_ref().map(|g| g.branch.clone());
        let path = run
            .guard
            .as_ref()
            .map(|g| g.path.to_string_lossy().into_owned());
        (run.diff.clone(), branch, path)
    };

    let structured = build_review(&diff, branch, path);
    let summary = format!(
        "Diff review: {} changed file(s) in run '{run_id}'.",
        diff.files.len()
    );
    Ok(app_result(structured, None, &summary))
}

/// Apply the whole worktree: merge into the base branch, or open a PR. Mirrors
/// the `worktree_apply_handler` HTTP path (take the live guard, run the blocking
/// git I/O off the async runtime; dropping the guard cleans the worktree up).
async fn apply(args: Value, ctx: &AppDispatchCtx<'_>, mode: ApplyMode) -> Result<Value> {
    let store = ctx
        .worktree_diffs
        .ok_or_else(|| anyhow!("worktree store is unavailable"))?;
    let Some(run_id) = resolve_run_id(&args, ctx) else {
        return Err(anyhow!("no run id in scope for apply"));
    };

    let op = match mode {
        ApplyMode::Merge => "apply",
        ApplyMode::Pr => "open_pr",
    };
    let message = args
        .get("title")
        .or_else(|| args.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "Apply Ryu run changes".to_owned());

    // Take the guard out so it is live during apply and dropped (cleanup) after.
    let guard = {
        let mut store = store.lock().await;
        store.get_mut(&run_id).and_then(|run| run.guard.take())
    };
    let Some(guard) = guard else {
        return Ok(app_result(
            json!({ "success": false, "status": "gone", "op": op, "run_id": run_id }),
            None,
            "Worktree has already been applied or was not found.",
        ));
    };

    let result =
        tokio::task::spawn_blocking(move || apply_worktree(&guard, mode, &message, None)).await;

    match result {
        Ok(Ok(success)) => Ok(app_result(
            json!({
                "success": true,
                "op": op,
                "commit": success.commit,
                "pr_url": success.pr_url,
            }),
            None,
            match op {
                "open_pr" => "Opened a pull request.",
                _ => "Applied the worktree changes.",
            },
        )),
        Ok(Err(conflict)) => Ok(app_result(
            json!({
                "success": false,
                "op": op,
                "error": "merge_conflict",
                "conflicted_files": conflict.conflicted_files,
            }),
            None,
            "Merge conflict — the base branch was left unchanged.",
        )),
        Err(e) => Err(anyhow!("apply task failed: {e}")),
    }
}

/// Discard a run's worktree: remove it from the store; dropping the removed
/// [`WorktreeRun`] drops its guard, which git-removes the worktree + branch. The
/// drop is done on the blocking pool since it shells out to git synchronously.
async fn discard(args: Value, ctx: &AppDispatchCtx<'_>) -> Result<Value> {
    let store = ctx
        .worktree_diffs
        .ok_or_else(|| anyhow!("worktree store is unavailable"))?;
    let Some(run_id) = resolve_run_id(&args, ctx) else {
        return Err(anyhow!("no run id in scope for discard"));
    };

    let run = {
        let mut store = store.lock().await;
        store.remove(&run_id)
    };
    let removed = run.is_some();
    if let Some(run) = run {
        // Drop off the async runtime — `WorktreeGuard::drop` runs blocking git.
        let _ = tokio::task::spawn_blocking(move || drop(run)).await;
    }

    Ok(app_result(
        json!({ "status": "ok", "op": "discard", "discarded": removed, "run_id": run_id }),
        None,
        if removed {
            "Discarded the worktree."
        } else {
            "No worktree to discard."
        },
    ))
}

/// Shape a [`WorktreeDiff`] into the widget's `ReviewOutput` (branch, worktree
/// path, summary, and per-file hunks parsed from the unified diff).
fn build_review(diff: &WorktreeDiff, branch: Option<String>, path: Option<String>) -> Value {
    let mut hunks_by_file = parse_hunks_by_file(&diff.unified_diff);
    let mut additions: u64 = 0;
    let mut deletions: u64 = 0;
    let files: Vec<Value> = diff
        .files
        .iter()
        .map(|f| {
            additions += u64::from(f.additions);
            deletions += u64::from(f.deletions);
            let hunks = hunks_by_file.remove(&f.path).unwrap_or_default();
            json!({
                "path": f.path,
                "status": file_status(&f.kind),
                "additions": f.additions,
                "deletions": f.deletions,
                "hunks": hunks,
            })
        })
        .collect();

    json!({
        "branch": branch.unwrap_or_else(|| "ryu/run".to_owned()),
        "worktree_path": path.unwrap_or_default(),
        "summary": {
            "files": diff.files.len(),
            "additions": additions,
            "deletions": deletions,
        },
        "files": files,
    })
}

/// A valid, empty `ReviewOutput` so the widget renders its "no changes" state
/// rather than an error when a run has no live worktree.
fn empty_review(run_id: &str) -> Value {
    app_result(
        json!({
            "branch": "ryu/run",
            "worktree_path": "",
            "summary": { "files": 0, "additions": 0, "deletions": 0 },
            "files": [],
        }),
        None,
        &format!("No worktree found for run '{run_id}'."),
    )
}

fn file_status(kind: &FileChangeKind) -> &'static str {
    match kind {
        FileChangeKind::Added => "added",
        FileChangeKind::Modified => "modified",
        FileChangeKind::Deleted => "deleted",
        FileChangeKind::Renamed => "renamed",
    }
}

/// Parse a git unified diff into `path -> [hunk]`, where each hunk is
/// `{ id, header, lines: [{ kind, content }] }` (`kind` ∈ add/del/ctx). Lenient:
/// binary/unparseable files simply yield no hunks (the widget renders them as a
/// file row with an empty body rather than crashing).
fn parse_hunks_by_file(unified: &str) -> HashMap<String, Vec<Value>> {
    let mut map: HashMap<String, Vec<Value>> = HashMap::new();
    let mut per_file_idx: HashMap<String, usize> = HashMap::new();
    let mut a_path: Option<String> = None;
    let mut path: Option<String> = None;
    let mut header: Option<String> = None;
    let mut lines: Vec<Value> = Vec::new();

    // Commit the in-progress hunk (if any) to its file's bucket.
    macro_rules! commit {
        () => {
            if let (Some(p), Some(h)) = (path.as_ref(), header.take()) {
                let idx = per_file_idx.entry(p.clone()).or_insert(0);
                let id = format!("{p}#{idx}");
                *idx += 1;
                map.entry(p.clone()).or_default().push(json!({
                    "id": id,
                    "header": h,
                    "lines": std::mem::take(&mut lines),
                }));
            } else {
                lines.clear();
            }
        };
    }

    for line in unified.lines() {
        if line.starts_with("diff --git") {
            // New file: flush the previous file's last hunk and reset paths.
            commit!();
            a_path = None;
            path = None;
        } else if line.starts_with("@@") {
            // New hunk (same or new file): flush the previous one, start this.
            commit!();
            header = Some(line.to_owned());
        } else if header.is_none() && line.starts_with("--- ") {
            a_path = clean_diff_path(&line[4..]);
        } else if header.is_none() && line.starts_with("+++ ") {
            path = clean_diff_path(&line[4..]).or_else(|| a_path.clone());
        } else if header.is_some() {
            let entry = if let Some(content) = line.strip_prefix('+') {
                Some(("add", content))
            } else if let Some(content) = line.strip_prefix('-') {
                Some(("del", content))
            } else if let Some(content) = line.strip_prefix(' ') {
                Some(("ctx", content))
            } else {
                // "\ No newline at end of file" and any stray line: skip.
                None
            };
            if let Some((kind, content)) = entry {
                lines.push(json!({ "kind": kind, "content": content }));
            }
        }
    }
    commit!();
    map
}

/// Strip a diff file-header path (`a/foo`, `b/foo`, `/dev/null`, optionally
/// tab-suffixed or quoted) down to the repo-relative path. `/dev/null` → `None`.
fn clean_diff_path(raw: &str) -> Option<String> {
    let raw = raw.split('\t').next().unwrap_or(raw).trim();
    let raw = raw.trim_matches('"');
    if raw == "/dev/null" {
        return None;
    }
    let stripped = raw
        .strip_prefix("a/")
        .or_else(|| raw.strip_prefix("b/"))
        .unwrap_or(raw);
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multi_file_unified_diff_into_hunks() {
        // Built line-by-line and joined so the leading space that marks a
        // context line survives — a `\`-continued string literal would strip it.
        let diff = [
            "diff --git a/src/foo.rs b/src/foo.rs",
            "--- a/src/foo.rs",
            "+++ b/src/foo.rs",
            "@@ -1,3 +1,4 @@ impl Foo",
            " ctx line",
            "-old line",
            "+new line a",
            "+new line b",
            "diff --git a/new.txt b/new.txt",
            "--- /dev/null",
            "+++ b/new.txt",
            "@@ -0,0 +1,1 @@",
            "+hello",
        ]
        .join("\n");
        let map = parse_hunks_by_file(&diff);
        let foo = map.get("src/foo.rs").expect("foo hunks");
        assert_eq!(foo.len(), 1);
        assert_eq!(foo[0]["id"], "src/foo.rs#0");
        let lines = foo[0]["lines"].as_array().unwrap();
        // ctx + del + 2 adds = 4 lines.
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[1]["kind"], "del");
        assert_eq!(lines[1]["content"], "old line");
        let newf = map.get("new.txt").expect("new.txt hunks");
        assert_eq!(newf[0]["lines"].as_array().unwrap()[0]["content"], "hello");
    }

    #[test]
    fn body_line_starting_with_dashes_is_not_a_file_header() {
        // A deleted line whose content begins with "-- " must stay a del line,
        // not be misread as a `--- ` file header (guarded by header.is_some()).
        // Joined line-by-line so the context line's leading space survives (a
        // `\`-continued literal would strip it). The del line's on-disk content
        // is "-- a comment"; with the leading `-` del marker it reads "--- a
        // comment" in the diff, which is exactly the "--- " header shape guarded.
        let diff = [
            "diff --git a/x b/x",
            "--- a/x",
            "+++ b/x",
            "@@ -1,2 +1,1 @@",
            " keep",
            "--- a comment",
        ]
        .join("\n");
        let map = parse_hunks_by_file(&diff);
        let hunks = map.get("x").expect("x hunks");
        let lines = hunks[0]["lines"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["kind"], "del");
        assert_eq!(lines[1]["content"], "-- a comment");
    }
}
