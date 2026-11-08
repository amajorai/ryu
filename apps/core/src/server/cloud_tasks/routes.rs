//! The cloud task stop route, OpenAPI document and task preparation.

use super::leases::{persist_lease, persist_record};
use super::release::stop_owned_task;
use super::*;

pub(in crate::server) fn routes() -> axum::Router<crate::server::ServerState> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/api/cloud-tasks/:conversation_id", get(api::status))
        .route(
            "/api/cloud-tasks/:conversation_id/prompt",
            post(api::prompt),
        )
        .route("/api/cloud-tasks/:conversation_id/diff", get(api::diff))
        .route(
            "/api/cloud-tasks/:conversation_id/finish",
            post(api::finish),
        )
        .route("/api/cloud-tasks/:conversation_id/stop", post(stop))
        .layer(axum::extract::DefaultBodyLimit::max(262_144))
}
#[utoipa::path(post,path="/api/cloud-tasks/{conversation_id}/stop",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation bound to a personally owned cloud task")),description="Stop the caller's retained cloud task workspace and remove its owned resource lease after successful cleanup. Requires GatewayRoute with current personal identity; revoked execution permission does not prevent stopping an owned task. Idempotent for already stopped or absent caller-owned tasks. A stopped conversation cannot rerun installation automatically; start a new conversation. Failed cleanup preserves the lease for retry.",responses((status=200,body=Value),(status=403,description="Execution authority or identity denied"),(status=503,description="Cleanup failed; retry stop")))]
pub(super) async fn stop(
    axum::Extension(auth): axum::Extension<ResolvedAuthorization>,
    axum::extract::Path(conversation_id): axum::extract::Path<String>,
) -> Result<Json<Value>, ApiError> {
    stop_owned_task(&auth, &conversation_id).await?;
    Ok(Json(
        json!({"conversationId":conversation_id,"status":"stopped"}),
    ))
}
#[derive(utoipa::OpenApi)]
#[openapi(
    paths(api::status, api::prompt, api::diff, api::finish, stop),
    components(schemas(
        api::CloudTaskStatus,
        api::ActiveRunView,
        api::LastRunView,
        box_arm::FinishSummary,
        api::PromptRequest,
        api::PromptAccepted,
        api::PromptRunAccepted,
        api::DiffResponse,
        box_arm::DiffFile,
        api::FinishRequest,
        api::FinishResponse,
        crate::server::session_box::SessionBoxView,
        crate::server::session_box::BoxCaps
    ))
)]
pub(super) struct CloudTaskApiDoc;
pub(in crate::server) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    let mut doc = CloudTaskApiDoc::openapi();
    doc.merge(crate::server::session_box::openapi());
    doc
}

pub(super) async fn prepare_task(
    profile: environments::PreparedEnvironment,
    conversation_id: String,
    authority: ResolvedAuthorization,
) -> Result<LiveTask> {
    let lease_id = uuid::Uuid::new_v4().to_string();
    if profile.backend == environments::TaskBackend::Box {
        return prepare_box_task(profile, lease_id, conversation_id, authority).await;
    }
    let expires_at = now()? + LIFETIME_SECONDS;
    let workspace = if let (Some(backend), Some(key)) = (&profile.vpn_backend, &profile.vpn_key) {
        TaskWorkspace::Vpn(
            backend
                .create_workspace(&profile.governed_spec, key, LIFETIME_SECONDS)
                .await?,
        )
    } else if profile.governed {
        TaskWorkspace::Governed(
            ryu_sandbox::opensandbox::OpenSandboxSandbox::governed()
                .create(&profile.governed_spec)
                .await?,
        )
    } else {
        persist_record(&TaskLease {
            schema_version: 1,
            id: lease_id.clone(),
            owner: profile.owner.clone(),
            conversation_id: conversation_id.clone(),
            expires_at,
            backend: "docker".into(),
            handle: json!(lease_id),
        })?;
        TaskWorkspace::Docker(
            ryu_sandbox::docker::DockerSandbox::new()
                .create_leased_workspace(
                    &lease_id,
                    expires_at,
                    SandboxCapabilities {
                        network: profile.network,
                        ..Default::default()
                    },
                )
                .await?,
        )
    };
    let context = CloudTaskContext {
        environment_id: profile.environment_id.clone(),
        environment_name: profile.environment_name.clone(),
        revision: profile.revision,
        working_directory: profile.working_directory.clone(),
        repository_directories: profile.repository_directories.clone(),
        start_instructions: profile.start_instructions.clone(),
        executor: profile.executor.clone(),
        backend: profile.backend.label().to_owned(),
    };
    let task = LiveTask::new(
        context,
        profile,
        workspace,
        expires_at,
        lease_id,
        conversation_id,
        authority,
    );
    if !matches!(&task.workspace, TaskWorkspace::Docker(_)) && persist_lease(&task).is_err() {
        task.destroy().await?;
        bail!("Cloud task lease could not be persisted");
    }
    match task.run(&task.profile.script, 120).await {
        Ok(output) if output.exit_code == 0 => Ok(task),
        _ => {
            task.destroy().await?;
            bail!("Cloud environment installation failed");
        }
    }
}
/// Box arm of [`prepare_task`]: lease first, then create, meter, and run setup.
pub(super) async fn prepare_box_task(
    profile: environments::PreparedEnvironment,
    lease_id: String,
    conversation_id: String,
    authority: ResolvedAuthorization,
) -> Result<LiveTask> {
    let expires_at = now()? + profile.lifetime_seconds;
    // The same admission as a session Box (signed running cap, credit
    // pre-flight at the size's rate, Box limits) before anything is created.
    crate::server::session_box::admit_cloud_task(
        &authority,
        &profile.owner,
        box_arm::task_box_size(),
    )
    .await?;
    let relay_owner = box_arm::relay_owner(&authority);
    let created = box_arm::create(
        &profile,
        &lease_id,
        &conversation_id,
        expires_at,
        &relay_owner,
    )
    .await?;
    let context = CloudTaskContext {
        environment_id: profile.environment_id.clone(),
        environment_name: profile.environment_name.clone(),
        revision: profile.revision,
        working_directory: profile.working_directory.clone(),
        repository_directories: profile.repository_directories.clone(),
        start_instructions: profile.start_instructions.clone(),
        executor: profile.executor.clone(),
        backend: profile.backend.label().to_owned(),
    };
    let mut task = LiveTask::new(
        context,
        profile,
        TaskWorkspace::Box(created.workspace),
        expires_at,
        lease_id,
        conversation_id,
        authority,
    );
    task.metered = created.metering.is_some();
    task.metering = created.metering;
    match task.run(&task.profile.script, 600).await {
        Ok(output) if output.exit_code == 0 => {}
        _ => {
            task.destroy().await?;
            bail!("Cloud environment installation failed");
        }
    }
    if !task.context.repository_directories.is_empty() {
        match box_arm::base_revision(&task).await {
            Ok((sha, branch)) => {
                task.base_sha = Some(sha);
                task.base_branch = branch;
            }
            Err(_) => {
                task.destroy().await?;
                bail!("Cloud task repository revision could not be read");
            }
        }
    }
    Ok(task)
}
