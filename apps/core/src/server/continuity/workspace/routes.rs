//! The workspace handoff router, the capability probe, and the wire mapping
//! of an inspected folder.

use super::*;

pub(crate) fn router() -> Router<ServerState> {
    Router::new()
        .route("/api/rnp/v0/capabilities", get(capabilities))
        .route(
            "/api/rnp/v0/conversations/:id/workspace/inspect",
            post(inspect_workspace),
        )
        .route(
            "/api/rnp/v0/conversations/:id/workspace/export",
            post(export_workspace),
        )
        .route(
            "/api/rnp/v0/conversations/:id/workspace/resume",
            post(resume_workspace),
        )
        .route(
            "/api/rnp/v0/conversations/:id/continued",
            post(mark_continued).delete(clear_continued),
        )
        .layer(DefaultBodyLimit::max(MAX_JSON_BYTES))
        .route(
            "/api/rnp/v0/workspace-blobs/:sha256",
            get(get_blob)
                .head(head_blob)
                .put(put_blob)
                .layer(DefaultBodyLimit::max(handoff::MAX_BUNDLE_BYTES as usize)),
        )
}

#[utoipa::path(
    get,
    path = "/api/rnp/v0/capabilities",
    tag = "Conversations",
    summary = "List the optional RNP v0 features this node supports",
    responses((status = 200, body = RnpCapabilitiesV0))
)]
pub(crate) async fn capabilities() -> Json<RnpCapabilitiesV0> {
    Json(RnpCapabilitiesV0 {
        version: VERSION,
        features: vec![FEATURE_WORKSPACE.to_owned()],
    })
}

/// The source conversation after the read ACL, refusing while a turn runs.
pub(super) async fn source_summary(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
) -> Result<crate::server::conversations::ConversationSummary, Response> {
    require_resource_read(
        state.conversations.get_access_meta(id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    )?;
    let summary = state
        .conversations
        .get_summary(id)
        .await
        .map_err(|error| {
            coded_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                error.to_string(),
            )
        })?
        .ok_or_else(|| {
            coded_error(
                StatusCode::NOT_FOUND,
                "not-found",
                format!("conversation '{id}' not found"),
            )
        })?;
    if summary.run_status.as_deref() == Some("running") {
        return Err(coded_error(
            StatusCode::CONFLICT,
            "turn-running",
            "wait for the active response to finish before continuing elsewhere",
        ));
    }
    Ok(summary)
}

/// The folder the thread works in: its worktree when it has one, else its folder.
pub(super) fn thread_folder(
    summary: &crate::server::conversations::ConversationSummary,
) -> Result<PathBuf, Response> {
    [
        summary.worktree_path.as_deref(),
        summary.folder_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(PathBuf::from)
    .find(|path| path.is_dir())
    .ok_or_else(|| {
        coded_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "not-a-git-repository",
            "this thread has no folder to hand off",
        )
    })
}

pub(super) fn file_wire(file: &handoff::ChangedFile) -> RnpWorkspaceFileV0 {
    RnpWorkspaceFileV0 {
        path: file.path.clone(),
        status: serde_json::to_value(file.status)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "modified".to_owned()),
        bytes: file.bytes,
        binary: file.binary,
        sensitive: file.sensitive,
    }
}

pub(super) fn reason_wire(reason: handoff::OmissionReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "not-selected".to_owned())
}

pub(super) fn repo_wire(inspection: &handoff::WorkspaceInspection) -> RnpWorkspaceRepoV0 {
    RnpWorkspaceRepoV0 {
        name: inspection.name.clone(),
        remote_url: inspection.remote_url.clone(),
        base_commit: inspection.head.clone(),
        branch: inspection.branch.clone(),
        upstream_ref: inspection.upstream_ref.clone(),
    }
}
