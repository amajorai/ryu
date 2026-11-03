//! Inspecting a thread's folder and exporting a reviewed manifest.

use super::*;

pub(crate) async fn inspect_inner(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
) -> Result<RnpWorkspaceInspectionV0, Response> {
    let summary = source_summary(state, caller, id).await?;
    let folder = thread_folder(&summary)?;
    let inspection = blocking(move || handoff::inspect_workspace(&folder)).await?;
    Ok(RnpWorkspaceInspectionV0 {
        version: VERSION,
        conversation_id: id.to_owned(),
        repo: repo_wire(&inspection),
        unpushed_commits: inspection.unpushed_commits,
        diff_stat: RnpWorkspaceDiffStatV0 {
            files: inspection.changed.len(),
            insertions: inspection.insertions,
            deletions: inspection.deletions,
        },
        changed: inspection.changed.iter().map(file_wire).collect(),
        untracked_candidates: inspection
            .untracked
            .iter()
            .map(|candidate| RnpWorkspaceCandidateV0 {
                path: candidate.path.clone(),
                bytes: candidate.bytes,
                sensitive: candidate.sensitive,
                selectable: candidate.selectable,
                reason: candidate.reason.map(reason_wire),
            })
            .collect(),
    })
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/workspace/inspect",
    tag = "Conversations",
    summary = "Describe the working tree a handoff of this thread would carry",
    params(("id" = String, Path)),
    request_body = RnpWorkspaceInspectRequestV0,
    responses((status = 200, body = RnpWorkspaceInspectionV0), (status = 409), (status = 422))
)]
pub(crate) async fn inspect_workspace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(request): Json<RnpWorkspaceInspectRequestV0>,
) -> Response {
    if request.version != VERSION {
        return coded_error(
            StatusCode::BAD_REQUEST,
            "unsupported-version",
            "unsupported continuity version",
        );
    }
    match inspect_inner(&state, &caller, &id).await {
        Ok(inspection) => Json(inspection).into_response(),
        Err(response) => response,
    }
}

pub(crate) async fn export_inner(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
    request: RnpWorkspaceExportRequestV0,
    roots: &Roots,
) -> Result<RnpWorkspaceManifestV0, Response> {
    if request.version != VERSION {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "unsupported-version",
            "unsupported continuity version",
        ));
    }
    if !is_commit(&request.if_head) {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "ifHead must be a commit id",
        ));
    }
    if request.include_untracked.len() > handoff::MAX_UNTRACKED_COUNT {
        return Err(coded_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too-large",
            "too many untracked files",
        ));
    }
    if !request
        .include_untracked
        .iter()
        .all(|path| handoff::is_safe_repo_relative_path(path))
    {
        return Err(coded_error(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "an untracked path is unsafe",
        ));
    }
    let summary = source_summary(state, caller, id).await?;
    if request
        .if_updated_at
        .is_some_and(|value| value != summary.updated_at)
    {
        return Err(coded_error(
            StatusCode::CONFLICT,
            "conversation-changed",
            "conversation changed after the handoff review; review it again",
        ));
    }
    let folder = thread_folder(&summary)?;
    sweep(roots);
    let workspace_id = uuid::Uuid::new_v4().to_string();
    let staging = roots.staging().join(&workspace_id);
    let owner = StagingOwner {
        owner: caller_key(caller),
        created_at: now_millis(),
    };
    let owner_json = serde_json::to_vec(&owner).unwrap_or_default();
    if let Err(error) = write_atomically(&staging.join("owner.json"), &owner_json) {
        return Err(coded_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            format!("could not create the staging folder: {error}"),
        ));
    }
    let work = staging.join("work");
    let if_head = request.if_head.clone();
    let include = request.include_untracked.clone();
    let staging_for_task = staging.clone();
    let result = blocking(move || {
        let exported = handoff::export_workspace(&folder, &if_head, &include, &work)?;
        // Content-address each blob inside the caller's staging folder.
        // The exported file is sealed into the staging folder and the
        // plaintext work copy removed at once.
        let stage = |path: &FsPath| -> Result<(String, u64), HandoffError> {
            let plain = std::fs::read(path)
                .map_err(|error| HandoffError::Git(format!("could not read a blob: {error}")))?;
            let sha = sha256_hex(&plain);
            let bytes = plain.len() as u64;
            let sealed = write_sealed_blob(&staging_for_task.join(&sha), &plain);
            let _ = std::fs::remove_file(path);
            sealed
                .map_err(|error| HandoffError::Git(format!("could not stage a blob: {error}")))?;
            Ok((sha, bytes))
        };
        let commits = exported
            .commits
            .as_ref()
            .map(|commits| stage(&commits.path).map(|blob| (blob, commits.clone())))
            .transpose()?;
        let diff = exported
            .diff
            .as_ref()
            .map(|diff| stage(&diff.path).map(|blob| (blob, diff.clone())))
            .transpose()?;
        let _ = std::fs::remove_dir_all(&work);
        Ok((exported, commits, diff))
    })
    .await;
    let (exported, commits, diff) = match result {
        Ok(value) => value,
        Err(response) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(response);
        }
    };
    let manifest = RnpWorkspaceManifestV0 {
        version: VERSION,
        workspace_id,
        conversation_id: id.to_owned(),
        created_at: now_millis(),
        repo: repo_wire(&exported.inspection),
        commits: commits.map(|((sha256, bytes), commits)| RnpWorkspaceCommitsV0 {
            blob: RnpBlobRefV0 {
                sha256,
                bytes,
                media_type: MEDIA_BUNDLE.to_owned(),
            },
            tip: commits.tip,
            prerequisites: commits.prerequisites,
            count: commits.count,
        }),
        diff: diff.map(|((sha256, bytes), diff)| RnpWorkspaceDiffV0 {
            blob: RnpBlobRefV0 {
                sha256,
                bytes,
                media_type: MEDIA_DIFF.to_owned(),
            },
            files: diff.files.iter().map(file_wire).collect(),
        }),
        untracked: exported.untracked.iter().map(file_wire).collect(),
        omitted: exported
            .omitted
            .iter()
            .map(|omission| RnpWorkspaceOmissionV0 {
                path: omission.path.clone(),
                reason: reason_wire(omission.reason),
            })
            .collect(),
    };
    if let Err(error) = validate_manifest(&manifest) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(validation_response(error));
    }
    Ok(manifest)
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/workspace/export",
    tag = "Conversations",
    summary = "Stage the reviewed working tree of this thread for a handoff",
    params(("id" = String, Path)),
    request_body = RnpWorkspaceExportRequestV0,
    responses((status = 200, body = RnpWorkspaceManifestV0), (status = 409), (status = 413), (status = 422))
)]
pub(crate) async fn export_workspace(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(request): Json<RnpWorkspaceExportRequestV0>,
) -> Response {
    let roots = match Roots::resolve() {
        Ok(roots) => roots,
        Err(response) => return response,
    };
    match export_inner(&state, &caller, &id, request, &roots).await {
        Ok(manifest) => Json(manifest).into_response(),
        Err(response) => response,
    }
}
