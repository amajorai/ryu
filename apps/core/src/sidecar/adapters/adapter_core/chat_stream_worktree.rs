use super::*;

/// Resolve the ACP working directory, reusing or creating the conversation's managed worktree.
///
/// Returns whether the worktree was reused, the effective cwd, and the guard.
pub(super) async fn allocate_turn_worktree(
    req: &ChatStreamRequest,
    route: &AgentRoute,
    worktree_diffs: &crate::server::WorktreeDiffStore,
    requested_environment: &Vec<(String, String)>,
) -> Result<(bool, PathBuf, Option<WorktreeGuard>), Response> {
    // Whether `worktree_guard` is this conversation's live worktree taken out of
    // the diff store (it goes back there if the turn is rejected before it runs).
    let mut worktree_reused = false;
    let (effective_cwd, worktree_guard): (PathBuf, Option<WorktreeGuard>) =
        if matches!(route, AgentRoute::Acp { .. }) {
            let base = req
                .cwd
                .as_deref()
                .map(PathBuf::from)
                .filter(|p| p.exists())
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

            if req.worktree_isolation && is_git_repo(&base) {
                let repo_root = find_git_root(&base).unwrap_or_else(|| base.clone());
                let worktree_options = match crate::learning::global_state() {
                    Some(state) => match crate::server::governance::runtime_worktree_options(
                        &state.preferences,
                    )
                    .await
                    {
                        Ok(options) => options,
                        Err(error) => {
                            return Err(error_stream(format!(
                                "Worktree settings could not be loaded: {error}"
                            )))
                        }
                    },
                    None => ryu_workspace::worktree::ManagedWorktreeOptions::default(),
                };
                // Persistent per-session: reuse this conversation's live worktree
                // across turns instead of forking a fresh one each message. Take
                // the guard out of the diff store so the run owns it; the
                // completion task re-inserts it with a refreshed diff. A new
                // worktree is created only when the conversation has none yet
                // (first turn) or its previous one was applied/removed.
                let reused = if let Some(ref conv_id) = req.conversation_id {
                    let mut store = worktree_diffs.lock().await;
                    store
                        .get_mut(conv_id)
                        .and_then(|run| match run.guard.take() {
                            Some(g) if g.path.exists() => Some(g),
                            // Stale guard (dir vanished) — drop it and create fresh.
                            _ => None,
                        })
                } else {
                    None
                };
                match reused {
                    Some(mut guard) => {
                        guard.update_managed_options(&worktree_options);
                        guard.suspend_managed_pruning();
                        worktree_reused = true;
                        (guard.path.clone(), Some(guard))
                    }
                    None => match create_managed_worktree(
                        &repo_root,
                        req.worktree_branch.as_deref(),
                        &worktree_options,
                    ) {
                        Ok(mut guard) => {
                            guard.suspend_managed_pruning();
                            if let Some(environment) = req.project_environment.as_ref() {
                                if let Err(error) = guard.configure_environment(
                                    environment.setup.current(),
                                    environment.cleanup.current(),
                                    requested_environment.clone(),
                                ) {
                                    tracing::warn!(
                                        environment = %environment.name,
                                        error = %error,
                                        "project environment setup failed"
                                    );
                                    return Err(error_stream(format!(
                                        "Environment setup failed for '{}': {error}",
                                        environment.name
                                    )));
                                }
                            }
                            let worktree_path = guard.path.clone();
                            (worktree_path, Some(guard))
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "managed worktree creation failed");
                            return Err(error_stream(format!("Worktree creation failed: {e:#}")));
                        }
                    },
                }
            } else {
                (base, None)
            }
        } else {
            (
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                None,
            )
        };
    Ok((worktree_reused, effective_cwd, worktree_guard))
}

/// Record run metadata and claim the durable `running` status before streaming begins.
pub(super) async fn mark_turn_running(
    req: &ChatStreamRequest,
    conversations: &ConversationStore,
    durable_conversation: bool,
    worktree_guard: &Option<WorktreeGuard>,
) -> TurnRejection {
    // Record run metadata and mark the run as "running" before streaming begins
    // so the state is durable even if the connection drops mid-stream (U013).
    // When worktree isolation is active, the guard's path takes priority over
    // any client-supplied worktree_path.
    let mut running_claim = None;
    if durable_conversation {
        if let Some(ref conv_id) = req.conversation_id {
            let folder_path = req.cwd.as_deref();
            let branch = req.branch.as_deref();
            let resolved_worktree = worktree_guard
                .as_ref()
                .map(|g| g.path.to_string_lossy().into_owned());
            let worktree_path = resolved_worktree
                .as_deref()
                .or(req.worktree_path.as_deref());
            if folder_path.is_some() || branch.is_some() || worktree_path.is_some() {
                if let Err(e) = conversations
                    .set_run_metadata(conv_id, folder_path, branch, worktree_path)
                    .await
                {
                    tracing::warn!("failed to set run metadata: {e:#}");
                }
            }
            match conversations.set_run_status(conv_id, "running").await {
                Ok(()) => {
                    running_claim = conversations
                        .get_run_summary(conv_id)
                        .await
                        .ok()
                        .flatten()
                        .filter(|run| run.run_status.as_deref() == Some("running"))
                        .map(|run| (conv_id.clone(), run.updated_at));
                }
                Err(e) => tracing::warn!("failed to set run status to running: {e:#}"),
            }
        }
    }
    TurnRejection {
        conversations: conversations.clone(),
        claim: running_claim,
    }
}

/// Checkpoint the chat's folder before any agent touches it, keyed by the user turn.
pub(super) async fn checkpoint_turn_workspace(
    req: &ChatStreamRequest,
    conversations: &ConversationStore,
    mut persisted_user_message_id: Option<String>,
    worktree_guard: &Option<WorktreeGuard>,
) {
    // Checkpoint the chat's folder before any agent touches it, keyed by the
    // user turn, so the user can rewind code and conversation to this point.
    // Edits and regenerates re-run the turn at the active user leaf; the first
    // capture for a turn wins, so a regenerate keeps the original pre-turn state.
    if req.persist {
        if let Some(ref conv_id) = req.conversation_id {
            let turn_message_id = match persisted_user_message_id.take() {
                Some(message_id) => Some(message_id),
                None if req.skip_user_append => conversations
                    .active_leaf_user_message(conv_id)
                    .await
                    .unwrap_or_else(|error| {
                        tracing::warn!("reading the checkpoint turn failed: {error:#}");
                        None
                    }),
                None => None,
            };
            if let Some(message_id) = turn_message_id {
                let workspace = crate::server::chat_checkpoints::turn_workspace(
                    req.cwd.as_deref(),
                    worktree_guard.as_ref().map(|guard| guard.path.as_path()),
                );
                crate::server::chat_checkpoints::capture_turn(
                    conversations,
                    conv_id,
                    &message_id,
                    workspace,
                )
                .await;
            }
        }
    }
}
