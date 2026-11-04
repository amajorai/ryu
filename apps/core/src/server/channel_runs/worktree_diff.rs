//! Assistant-first opening, channel bot runs, the channel command registry and background processes: `worktree_diff_handler` through `worktree_apply_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    get,
    path = "/api/worktree/{run_id}/diff",
    tag = "Worktree",
    summary = "Diff a run's worktree",
    params(("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn worktree_diff_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(run_id): Path<String>,
) -> axum::response::Response {
    // Per-resource ACL: `run_id` IS the conversation id, and the diff is the code
    // the run produced in that conversation's working folder.
    if let Err(resp) = require_conversation_access_if_known(&state, &caller, &run_id, false).await {
        return resp;
    }

    // Snapshot what we need and DROP the lock before shelling out — the git read
    // below is slow enough to stall every other run's worktree bookkeeping if it
    // were held across it. Same discipline as `worktree_status_handler`.
    let snapshot = {
        let store = state.worktree_diffs.lock().await;
        let Some(run) = store.get(&run_id) else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "no diff found for run", "run_id": run_id })),
            )
                .into_response();
        };
        let live = run.guard.as_ref().map(|g| {
            let base = if g.base_hash.is_empty() {
                "HEAD".to_string()
            } else {
                g.base_hash.clone()
            };
            (g.path.clone(), base)
        });
        (live, run.diff.clone(), run.computed_at.elapsed())
    };
    let (live, cached, age) = snapshot;

    // `run.diff` was computed when the run ended. Anything that touched the
    // worktree since — the user committing, resetting or discarding from a
    // terminal, another tool, a later turn — makes it fiction, and it stayed on
    // screen as "+N −M" long after the change was gone. So while the worktree is
    // still live, RE-READ it; the stored diff is the answer only once the
    // worktree has been applied/removed and there is nothing left to read.
    //
    // Throttled: the recompute stages the run's own (ephemeral, Ryu-created)
    // worktree index and walks every changed file, so a client that asked on a
    // tight loop would make the node shell out on a tight loop. Well under any
    // interval a UI polls at, far above per-keystroke.
    const WORKTREE_DIFF_MAX_AGE: std::time::Duration = std::time::Duration::from_millis(1500);
    let Some((path, base)) = live.filter(|_| age >= WORKTREE_DIFF_MAX_AGE) else {
        return Json(serde_json::to_value(&cached).unwrap_or(serde_json::json!({})))
            .into_response();
    };

    let read = |path: std::path::PathBuf, base: String| async move {
        tokio::task::spawn_blocking(move || worktree::worktree_diff(&path, &base))
            .await
            .ok()
    };

    let Some(mut fresh) = read(path.clone(), base.clone()).await else {
        // The blocking task panicked or was cancelled — answer with what we had
        // rather than failing the read.
        return Json(serde_json::to_value(&cached).unwrap_or(serde_json::json!({})))
            .into_response();
    };

    // `worktree_diff` answers "no changes" for a git FAILURE as well as for a
    // genuinely clean tree, and the failure is reachable here: staging takes
    // `index.lock`, so two reads arriving together (a focus refetch landing on
    // top of the turn-end invalidation, or a second client) can collide and one
    // comes back empty. Accepting that would hide the Changes section and its
    // Apply / Open PR buttons for a worktree that still holds the run's work.
    //
    // So "everything disappeared" is CONFIRMED before it is believed — read once
    // more, and take the empty answer only if it repeats. A lock collision does
    // not survive the retry; a tree the user really did reset does. Note this is
    // not a "keep the old number" fallback: that would be the very staleness this
    // handler exists to end.
    if !fresh.has_changes && cached.has_changes {
        match read(path, base).await {
            Some(second) => fresh = second,
            None => {
                return Json(serde_json::to_value(&cached).unwrap_or(serde_json::json!({})))
                    .into_response();
            }
        }
    }

    // Write the fresh diff back so `apply` and the throttle both see it. The
    // entry can have been removed (applied) while we were shelling out; that is
    // fine, the read still answers.
    {
        let mut store = state.worktree_diffs.lock().await;
        if let Some(run) = store.get_mut(&run_id) {
            run.diff = fresh.clone();
            run.computed_at = std::time::Instant::now();
        }
    }

    Json(serde_json::to_value(&fresh).unwrap_or(serde_json::json!({}))).into_response()
}

#[utoipa::path(
    get,
    path = "/api/worktree/{run_id}/status",
    tag = "Worktree",
    summary = "Status of a conversation's persistent worktree",
    params(("run_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn worktree_status_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(run_id): Path<String>,
) -> axum::response::Response {
    if let Err(resp) = require_conversation_access_if_known(&state, &caller, &run_id, false).await {
        return resp;
    }
    // Snapshot everything we need, then release the lock — the live git read
    // below shells out, and holding `worktree_diffs` across it would stall every
    // other run's worktree bookkeeping.
    let snapshot = {
        let store = state.worktree_diffs.lock().await;
        store.get(&run_id).map(|run| {
            let (branch, path) = run
                .guard
                .as_ref()
                .map(|g| {
                    (
                        Some(g.branch.clone()),
                        Some(g.path.to_string_lossy().into_owned()),
                    )
                })
                .unwrap_or((None, None));
            (
                run.guard.is_some(),
                branch,
                path,
                run.diff.has_changes,
                run.diff.files.len(),
            )
        })
    };

    let Some((active, branch, path, snap_has_changes, snap_changed_files)) = snapshot else {
        return Json(json!({ "active": false })).into_response();
    };

    // `run.diff` is a snapshot taken when the run last computed a diff, so it
    // goes stale the moment anything touches the worktree. While a worktree is
    // still live, re-read it with the same `query_git_state` that backs
    // `GET /api/git/status`, so both surfaces report one number instead of two
    // that drift apart. Fall back to the snapshot once the worktree is gone.
    let live = match path.clone() {
        Some(p) => tokio::task::spawn_blocking(move || ryu_workspace::git::query_git_state(&p))
            .await
            .ok()
            .filter(|s| s.is_repo),
        None => None,
    };
    let (has_changes, changed_files) = match live {
        Some(git) => (git.dirty, git.changed_files_count),
        None => (snap_has_changes, snap_changed_files),
    };

    Json(json!({
        // `active` ⇒ a live worktree is held for this conversation (the session
        // can iterate in it); false once it has been applied.
        "active": active,
        "branch": branch,
        "path": path,
        "has_changes": has_changes,
        "changed_files": changed_files,
    }))
    .into_response()
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct WorktreeApplyBody {
    pub(in crate::server) mode: worktree::ApplyMode,
    pub(in crate::server) message: String,
    #[serde(default)]
    pub(in crate::server) base: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/worktree/{run_id}/apply",
    tag = "Worktree",
    summary = "Apply/merge a run's worktree",
    params(("run_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn worktree_apply_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(run_id): Path<String>,
    Json(body): Json<WorktreeApplyBody>,
) -> axum::response::Response {
    if body.message.trim().is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "message is required".to_owned());
    }
    // Per-resource ACL: apply COMMITS/MERGES another user's run into their repo — the
    // most destructive conversation-derived write on the node.
    if let Err(resp) = require_conversation_access_if_known(&state, &caller, &run_id, true).await {
        return resp;
    }

    // Take the guard out of the store so it is live during apply and then
    // released under the latest cleanup policy after apply finishes.
    let guard = {
        let mut store = state.worktree_diffs.lock().await;
        match store.get_mut(&run_id) {
            Some(run) => run.guard.take(),
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "no worktree found for run", "run_id": run_id })),
                )
                    .into_response();
            }
        }
    };

    let Some(mut guard) = guard else {
        return json_error(
            StatusCode::GONE,
            "worktree has already been applied or cleaned up".to_owned(),
        );
    };

    let mode = body.mode;
    let message = body.message.trim().to_string();
    let base = body.base.as_deref().map(str::to_string);
    guard.suspend_managed_pruning();

    // Apply is synchronous git I/O; run it on the blocking thread pool.
    let result = tokio::task::spawn_blocking(move || {
        let result = worktree::apply_worktree(&guard, mode, &message, base.as_deref());
        (guard, result)
    })
    .await;

    let result = match result {
        Ok((mut guard, result)) => {
            if result.is_ok() {
                match governance::runtime_worktree_options(&state.preferences).await {
                    Ok(options) => guard.update_managed_options(&options),
                    Err(error) => {
                        tracing::warn!(error = %error, "cleanup settings unavailable after apply; worktree retained")
                    }
                }
                if let Err(error) = tokio::task::spawn_blocking(move || drop(guard)).await {
                    tracing::warn!(error = %error, "worktree release task failed");
                }
            } else {
                let mut store = state.worktree_diffs.lock().await;
                if let Some(run) = store.get_mut(&run_id) {
                    if run.guard.is_none() {
                        run.guard = Some(guard);
                    }
                }
            }
            Ok(result)
        }
        Err(error) => Err(error),
    };

    match result {
        Ok(Ok(success)) => Json(json!({
            "success": true,
            "commit": success.commit,
            "pr_url": success.pr_url,
        }))
        .into_response(),

        Ok(Err(conflict)) => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "merge_conflict",
                "conflicted_files": conflict.conflicted_files,
            })),
        )
            .into_response(),

        Err(e) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("apply task panicked: {e}"),
        ),
    }
}
