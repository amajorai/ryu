//! Resuming a handoff on the destination and marking the source continued.

use super::*;

pub(crate) async fn resume_inner(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
    request: RnpWorkspaceResumeRequestV0,
    roots: &Roots,
) -> Result<RnpWorkspaceResumeResultV0, Response> {
    if request.version != VERSION {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "unsupported-version",
            "unsupported continuity version",
        ));
    }
    let manifest = request.manifest;
    validate_manifest(&manifest).map_err(validation_response)?;
    if manifest.conversation_id != id {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-manifest",
            "path conversation id does not match the workspace manifest",
        ));
    }
    // The transcript resume runs first, so the conversation must exist here.
    require_resource_write(
        state.conversations.get_access_meta(id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    )?;
    if enforce_permission(
        state,
        caller,
        crate::identity_verify::permissions::AGENT_EDIT,
    )
    .await
    .is_err()
    {
        return Err(coded_error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "insufficient permissions: agent.edit",
        ));
    }
    // A worktree added to an existing checkout would inherit that checkout's
    // workspace trust (#662 `worktree_origin`) until handed-off worktrees are
    // excluded by their `ryu-handoff` marker, so v1 resumes into new clones only.
    if matches!(
        request.destination,
        RnpWorkspaceDestinationV0::ExistingCheckout { .. }
    ) {
        return Err(coded_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "existing-checkout-unavailable",
            "this node resumes handed-off working trees into a new clone only",
        ));
    }
    let _guard = workspace_lock().lock().await;
    sweep(roots);

    let record_file = record_path(roots, &manifest.workspace_id);
    let result = |status: &str, record: &ResumeRecord| RnpWorkspaceResumeResultV0 {
        version: VERSION,
        workspace_id: manifest.workspace_id.clone(),
        conversation_id: id.to_owned(),
        status: status.to_owned(),
        folder_path: record.folder_path.clone(),
        worktree_path: record.worktree_path.clone(),
        branch: record.branch.clone(),
        // Handed-off folders are never trusted automatically.
        warnings: vec!["workspace-untrusted".to_owned()],
    };
    if let Some(record) = std::fs::read(&record_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ResumeRecord>(&bytes).ok())
        .filter(|record| {
            record.conversation_id == id && FsPath::new(&record.worktree_path).is_dir()
        })
    {
        state
            .conversations
            .set_run_metadata(
                id,
                Some(&record.worktree_path),
                Some(&record.branch),
                Some(&record.worktree_path),
            )
            .await
            .map_err(stamp_error)?;
        return Ok(result("unchanged", &record));
    }

    let bundle = manifest
        .commits
        .as_ref()
        .map(|commits| received_blob(roots, &commits.blob))
        .transpose()?;
    let diff = manifest
        .diff
        .as_ref()
        .map(|diff| received_blob(roots, &diff.blob))
        .transpose()?;

    let (repo_root, created) = prepare_repository(&manifest, &request.destination, roots).await?;
    let worktree_dir = repo_root
        .join(".ryu-worktrees")
        .join(format!("handoff-{}", slug(&manifest.workspace_id, 12)));
    let marker = json!({
        "workspaceId": manifest.workspace_id,
        "conversationId": id,
        "baseCommit": manifest.repo.base_commit,
        "at": now_millis(),
    })
    .to_string();
    let materialize = handoff::MaterializeRequest {
        repo_root: repo_root.clone(),
        bundle: bundle.as_ref().map(|path| path.to_path_buf()),
        head: manifest.repo.base_commit.clone(),
        branch: format!("handoff/{}", slug(id, 8)),
        worktree_dir,
        diff: diff.as_ref().map(|path| path.to_path_buf()),
        expected_paths: manifest
            .diff
            .as_ref()
            .map(|diff| diff.files.iter().map(|file| file.path.clone()).collect())
            .unwrap_or_default(),
        marker,
    };
    let materialized = blocking(move || handoff::materialize_handoff(&materialize)).await;
    // Remove the opened plaintext copies as soon as git has read them.
    drop(bundle);
    drop(diff);
    let materialized = match materialized {
        Ok(materialized) => materialized,
        Err(response) => {
            if created {
                let _ = std::fs::remove_dir_all(&repo_root);
            }
            return Err(response);
        }
    };
    let record = ResumeRecord {
        conversation_id: id.to_owned(),
        folder_path: repo_root.to_string_lossy().into_owned(),
        worktree_path: materialized.worktree_path.to_string_lossy().into_owned(),
        branch: materialized.branch,
    };
    // The thread now works in the worktree; isolation must stay off for it (a
    // managed fork from HEAD would leave the uncommitted changes behind, and
    // `create_managed_worktree` refuses a handoff worktree for that reason).
    state
        .conversations
        .set_run_metadata(
            id,
            Some(&record.worktree_path),
            Some(&record.branch),
            Some(&record.worktree_path),
        )
        .await
        .map_err(stamp_error)?;
    if let Ok(bytes) = serde_json::to_vec(&record) {
        if let Err(error) = write_atomically(&record_file, &bytes) {
            tracing::warn!("could not record workspace resume: {error}");
        }
    }
    for blob in [
        manifest.commits.as_ref().map(|commits| &commits.blob),
        manifest.diff.as_ref().map(|diff| &diff.blob),
    ]
    .into_iter()
    .flatten()
    {
        let _ = std::fs::remove_file(roots.blobs().join(&blob.sha256));
    }
    Ok(result("created", &record))
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/workspace/resume",
    tag = "Conversations",
    summary = "Rebuild a handed-off working tree as a worktree on this node",
    params(("id" = String, Path)),
    request_body = RnpWorkspaceResumeRequestV0,
    responses((status = 200, body = RnpWorkspaceResumeResultV0), (status = 403), (status = 409), (status = 422))
)]
pub(crate) async fn resume_workspace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(request): Json<RnpWorkspaceResumeRequestV0>,
) -> Response {
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    match resume_inner(&state, &caller, &id, request, &roots).await {
        Ok(result) => Json(result).into_response(),
        Err(response) => response,
    }
}

pub(crate) async fn set_continued_inner(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
    record: Option<RnpContinuedOnV0>,
) -> Result<serde_json::Value, Response> {
    require_resource_write(
        state.conversations.get_access_meta(id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    )?;
    let Some(record) = record else {
        state
            .conversations
            .clear_continued_on(id)
            .await
            .map_err(stamp_error)?;
        return Ok(json!({ "continuedOn": null }));
    };
    let ids_valid = [record.bundle_id.as_deref(), record.workspace_id.as_deref()]
        .into_iter()
        .flatten()
        .all(|value| valid_text(value, MAX_ID_BYTES, false));
    if !valid_text(&record.node_label, MAX_LABEL_BYTES, false) || !ids_valid || record.at < 0 {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "continued-on record is invalid",
        ));
    }
    let value = serde_json::to_value(&record).map_err(stamp_error)?;
    state
        .conversations
        .set_continued_on(id, &value.to_string())
        .await
        .map_err(stamp_error)?;
    Ok(json!({ "continuedOn": value }))
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/continued",
    tag = "Conversations",
    summary = "Mark this thread as continued on another node",
    params(("id" = String, Path)),
    request_body = RnpContinuedOnV0,
    responses((status = 200), (status = 403), (status = 404))
)]
pub(crate) async fn mark_continued(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(record): Json<RnpContinuedOnV0>,
) -> Response {
    match set_continued_inner(&state, &caller, &id, Some(record)).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

#[utoipa::path(
    delete,
    path = "/api/rnp/v0/conversations/{id}/continued",
    tag = "Conversations",
    summary = "Take a continued thread back on this node",
    params(("id" = String, Path)),
    responses((status = 200), (status = 403), (status = 404))
)]
pub(crate) async fn clear_continued(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    match set_continued_inner(&state, &caller, &id, None).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}
