//! A plan run's status, its posted result, and stopping or diffing a run on this node.

use super::super::accounts::ProviderId;
use super::super::local_run;
use super::super::store::{self, RunRecord};
use super::super::{plan_owner, CloudTaskBackend};
use super::availability::account_label;
use super::features::{run_view, RunView};
use super::follow_up::refresh_codex;
use super::{api_error, bad_request, respond, ApiError};
use crate::server::cloud_environments as environments;
use crate::server::ResolvedAuthorization;
use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::Response;
use axum::Extension;
use serde_json::json;

#[utoipa::path(get,path="/api/cloud-tasks/{conversation_id}/subscription-run",operation_id="get_cloud_task_subscription_run",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation whose cloud task runs on the caller's own plan")),description="The caller's cloud task that runs on their own Claude or ChatGPT plan: backend, the provider's session or task ID and link, status (Codex reports it; a Claude cloud session is tracked on claude.ai and stays `submitted`), Codex's summary, the last error (redacted), and which session features the backend supports. A run owned by another caller reads as not found.",responses((status=200,body=RunView),(status=400,description="Invalid conversation ID"),(status=403,description="Not a personal identity"),(status=404,description="subscription_run_not_found")))]
pub(crate) async fn run_status(
    axum::extract::State(state): axum::extract::State<crate::server::ServerState>,
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Response {
    respond(
        async {
            let (owner, mut record) = owned_run(&auth, &conversation_id)?;
            if record.backend == CloudTaskBackend::OpenaiSubscriptionCli {
                let settings = store::settings(&owner);
                let link = settings.environments.get(&record.environment_id).cloned();
                refresh_codex(&mut record, link.as_ref(), None).await;
                store::save_run(record.clone());
            }
            post_result_once(&state, &auth, &mut record).await;
            Ok(run_view(record))
        }
        .await,
    )
}

/// Statuses after which a run has a result to show.
fn finished(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "stopped" | "ready" | "done" | "succeeded" | "error"
    )
}

/// Post a finished run's result into its conversation once, as an assistant message,
/// so everyone who can read the conversation (teammates included) sees it. Only the
/// account's owner can continue the run.
async fn post_result_once(
    state: &crate::server::ServerState,
    auth: &ResolvedAuthorization,
    record: &mut RunRecord,
) {
    if record.result_posted || !finished(&record.status) {
        return;
    }
    let tag = record
        .backend
        .provider()
        .map_or_else(String::new, |provider| {
            format!(
                "{} · {}",
                ProviderId::from(provider).product(),
                account_label(&record.owner, provider, record.account())
            )
        });
    let event = super::super::chat_event::plan_result_event(record, &tag);
    // Only the node owner reads a plan run (§0.3), so the message carries the tenancy
    // the start message did: the owner's own, signed in or not.
    let tenancy = crate::server::caller_tenancy(&auth.caller);
    if event
        .append(&state.conversations, &record.conversation_id, None, tenancy)
        .await
        .is_ok()
    {
        record.result_posted = true;
        store::save_run(record.clone());
    }
}

/// The caller's run for this conversation; another caller's run reads as not found.
fn owned_run(
    auth: &ResolvedAuthorization,
    conversation_id: &str,
) -> Result<(String, RunRecord), ApiError> {
    let owner = plan_owner(auth, &environments::owner(auth)?);
    if !crate::sidecar::adapters::acp::is_safe_host_conversation_id(conversation_id) {
        return Err(bad_request("A valid conversation ID is required."));
    }
    let not_found = || {
        api_error(
            StatusCode::NOT_FOUND,
            "subscription_run_not_found",
            "This conversation has no cloud task on your plan.",
        )
    };
    let record = store::run(conversation_id).ok_or_else(not_found)?;
    if record.owner != owner {
        return Err(not_found());
    }
    Ok((owner, record))
}

fn local_only(record: &RunRecord) -> Result<(), ApiError> {
    if record.backend.runs_on_node() {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::CONFLICT,
            "subscription_run_remote",
            "This task runs in the provider's cloud. Review or stop it on the provider's site.",
        ))
    }
}

#[utoipa::path(post,path="/api/cloud-tasks/{conversation_id}/subscription-run/stop",operation_id="stop_cloud_task_subscription_run",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation whose task runs on this node on the caller's own Claude or ChatGPT plan")),description="Stop the Claude Code or Codex run on this node for this conversation. Its worktree and branch are kept. Runs in the provider's cloud are stopped on the provider's site.",responses((status=200,body=Value),(status=404,description="subscription_run_not_found"),(status=409,description="subscription_run_remote")))]
pub(crate) async fn stop_run(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Response {
    respond(
        async {
            let (_, record) = owned_run(&auth, &conversation_id)?;
            local_only(&record)?;
            Ok(json!({"stopped": local_run::stop(&conversation_id)}))
        }
        .await,
    )
}

#[utoipa::path(get,path="/api/cloud-tasks/{conversation_id}/subscription-run/diff",operation_id="get_cloud_task_subscription_run_diff",tag="Cloud environments",security(("bearerAuth"=[])),params(("conversation_id"=String,Path,description="Conversation whose task runs on this node on the caller's own Claude or ChatGPT plan")),description="The changes the Claude Code or Codex run on this node made in its worktree: the branch, `git status --porcelain` lines, and the patch against the commit it started from (new files included, cut at 512 KiB).",responses((status=200,body=local_run::LocalDiff),(status=404,description="subscription_run_not_found"),(status=409,description="subscription_run_remote"),(status=502,description="subscription_diff_failed")))]
pub(crate) async fn run_diff(
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(conversation_id): Path<String>,
) -> Response {
    respond(
        async {
            let (_, record) = owned_run(&auth, &conversation_id)?;
            local_only(&record)?;
            local_run::diff(&record).await.map_err(|reason| {
                api_error(StatusCode::BAD_GATEWAY, "subscription_diff_failed", &reason)
            })
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_terminal_statuses_count_as_finished() {
        for status in [
            "completed",
            "failed",
            "stopped",
            "ready",
            "done",
            "succeeded",
            "error",
        ] {
            assert!(finished(status), "{status}");
        }
        for status in ["running", "queued", "", "Completed"] {
            assert!(!finished(status), "{status}");
        }
    }
}
