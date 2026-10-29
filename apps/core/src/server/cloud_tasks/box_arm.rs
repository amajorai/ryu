//! Fresh cloud box arm of cloud tasks: one disposable Ryu Box per
//! conversation. Secrets travel only as per-command or per-prompt env, and
//! every script here is a constant that reads its data from env rather than
//! interpolating it. The Box bearer token stays in Core.
//!
//! The Box is created at its own size with its own screen (`desktop: true`),
//! metered at that size (`spec_for(size)`, never the env size), and parked on
//! a kill verdict (`KillAction::Park`), which stops the task with its
//! `stopReason`. A `core_tick` tenant renews the Box service's liveness lease
//! after every accepted tick.
use super::{
    api_error_code, bind_box, now, persist_record, persist_record_replace, records, remove_lease,
    tasks, unbind_box, ApiError, LiveTask, TaskLease, TaskSlot, TaskState, TaskWorkspace,
};
use crate::server::conversations::{ConversationStore, Tenancy};
use crate::server::session_box::{self, BoxMetering, BoxTarget, TargetSource};
use anyhow::{anyhow, bail, ensure, Result};
use axum::http::StatusCode;
use ryu_sandbox::box_session::{
    BoxNetwork, BoxSessionClient, BoxUser, DisposableBoxSpec, ManagedPromptSpec, ManagedProvider,
    PromptRunView, BOX_WORKSPACE_ROOT, ENSURE_GIT_SCRIPT,
};
use ryu_sandbox::{
    box_types::{BoxApiError, BoxSize, ParkReason},
    heartbeat::{self, KillAction, KillReason, ParkFn, RunOptions},
    ExecOutput, WorkspaceId,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

/// `activeRun.outputTail` limit (characters).
pub(super) const OUTPUT_TAIL_CHARS: usize = 16_384;
const MAX_PATCH_BYTES: usize = 786_432;
const MAX_DIFF_FILES: usize = 1000;
const MAX_PROMPT_CHARS: usize = 32_000;
const MAX_SUMMARY_CHARS: usize = 4000;
const MAX_MANAGED_TIMEOUT_SECONDS: u64 = 14_400;
const MIN_MANAGED_TIMEOUT_SECONDS: u64 = 60;
/// Box TTL beyond Core's own expiry: a server-side backstop.
const BOX_TTL_GRACE_SECONDS: u64 = 300;
const SETUP_CHECK_TTL_SECONDS: u64 = 900;
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const PATCH_MARKER: &str = "\n--RYU-PATCH--\n";
const RECOVERY_NAME_PREFIX: &str = "ryu-ct-";

const BASE_REVISION_SCRIPT: &str = "set -eu; git -C \"$RYU_REPO_DIR\" rev-parse HEAD; git -C \"$RYU_REPO_DIR\" rev-parse --abbrev-ref HEAD";
/// Box user. Env: RYU_REPO_DIR, RYU_BASE_SHA.
const DIFF_SCRIPT: &str = "set -eu; cd \"$RYU_REPO_DIR\"; git add -A -N >/dev/null 2>&1 || true; git diff --numstat \"$RYU_BASE_SHA\" | head -n 1000; printf '\\n--RYU-PATCH--\\n'; git diff --binary \"$RYU_BASE_SHA\" | head -c 786433";
/// Box user. Env: RYU_REPO_DIR, RYU_BASE_SHA, RYU_COMMIT_MESSAGE.
const COMMIT_SCRIPT: &str = "set -eu; cd \"$RYU_REPO_DIR\"; git add -A; if ! git diff --cached --quiet; then git -c user.name=Ryu -c user.email=cloud-task@ryu.invalid -c core.hooksPath=/dev/null commit -q -m \"$RYU_COMMIT_MESSAGE\"; fi; git rev-parse HEAD; git diff --numstat \"$RYU_BASE_SHA\" HEAD | head -n 1000";
/// Root, no token. Env: RYU_REPO_DIR, RYU_BRANCH, RYU_PUSH_DIR. The repo is
/// owned by the box user, and file:// transport drops `-c` overrides before it
/// spawns upload-pack, so the safe.directory exception rides on upload-pack.
const FETCH_SCRIPT: &str = "set -eu; umask 077; git init -q --bare \"$RYU_PUSH_DIR\"; if ! GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -C \"$RYU_PUSH_DIR\" -c safe.directory='*' -c core.hooksPath=/dev/null fetch -q --no-tags --upload-pack='git -c safe.directory=\"*\" upload-pack' -- \"file://$RYU_REPO_DIR\" \"+HEAD:refs/heads/$RYU_BRANCH\"; then rm -rf \"$RYU_PUSH_DIR\"; exit 1; fi";
/// Root. Env: RYU_PUSH_DIR, RYU_BRANCH, RYU_REMOTE_URL and the GIT_CONFIG_*
/// auth header. Never forces.
const PUSH_SCRIPT: &str = "export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 HOME=/nonexistent; trap 'rm -rf \"$RYU_PUSH_DIR\"' EXIT; git -C \"$RYU_PUSH_DIR\" -c core.hooksPath=/dev/null push -q -- \"$RYU_REMOTE_URL\" \"refs/heads/$RYU_BRANCH:refs/heads/$RYU_BRANCH\"";

/// The managed prompt run currently in flight.
pub(super) struct ActiveRun {
    pub id: String,
    pub status: String,
    pub process_id: Option<String>,
    pub started_at: String,
    pub output_tail: String,
    pub next_seq: u64,
}

/// The most recent finished managed prompt run.
#[derive(Clone)]
pub(super) struct LastRun {
    pub id: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub summary: Option<String>,
    pub reason: Option<String>,
    pub completed_at: Option<String>,
}

/// Outcome of `POST /api/cloud-tasks/{conversation_id}/finish`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskFinish)]
#[serde(rename_all = "camelCase")]
pub(super) struct FinishSummary {
    pub branch: Option<String>,
    pub head_sha: Option<String>,
    pub pushed: bool,
    /// `auth`, `non_fast_forward`, `network` or `unknown`.
    pub push_error: Option<String>,
    pub compare_url: Option<String>,
    /// The pull request Core opened after a successful push, when requested.
    pub pull_request: Option<PullRequestRef>,
    /// `auth`, `already_exists`, `validation`, `network` or `unknown`. A
    /// failed pull request never fails the finish or destroys the Box.
    pub pull_request_error: Option<String>,
    /// `destroyed` or `kept`.
    pub teardown: String,
    pub files: u64,
    pub insertions: u64,
    pub deletions: u64,
}

/// A GitHub pull request opened by `finish`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskPullRequest)]
#[serde(rename_all = "camelCase")]
pub(super) struct PullRequestRef {
    /// `https://github.com/{owner}/{repo}/pull/{number}`.
    pub url: String,
    pub number: u64,
}

/// One changed file; binary files have null counts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[schema(as = CloudTaskDiffFile)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiffFile {
    pub path: String,
    pub insertions: Option<u64>,
    pub deletions: Option<u64>,
}

/// A freshly created, metered Box.
pub(super) struct CreatedBox {
    pub workspace: WorkspaceId,
    pub metering: Option<BoxMetering>,
}

/// The size of a cloud task Box: `RYU_SANDBOX_BOX_SIZE` when an operator set
/// it, otherwise the session default (`small`), which is the size most often
/// in stock.
pub(super) fn task_box_size() -> BoxSize {
    std::env::var(ryu_sandbox::box_backend::ENV_BOX_SIZE)
        .ok()
        .and_then(|value| value.parse::<BoxSize>().ok())
        .unwrap_or_default()
}

/// Box labels: the kind and the lease, so fleet tooling can attribute a VM.
fn labels(kind: &str, lease_id: &str) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("ryu-kind".to_owned(), kind.to_owned()),
        ("ryu-lease".to_owned(), lease_id.to_owned()),
    ])
}

fn box_name(lease_id: &str) -> String {
    format!("{RECOVERY_NAME_PREFIX}{lease_id}")
}

/// The credential-free lease handle: the deterministic name, plus the box id
/// once create returned it.
pub(super) fn lease_handle(lease_id: &str, workspace: Option<&WorkspaceId>) -> Value {
    json!({"name": box_name(lease_id), "boxId": workspace.map(|id| id.0.clone())})
}

/// [`lease_handle`] of a parked Box: its state is saved and its compute
/// released; the lease stays until the task's lifetime ends.
pub(super) fn parked_handle(lease_id: &str, workspace: &WorkspaceId) -> Value {
    json!({"name": box_name(lease_id), "boxId": workspace.0, "parked": true})
}

/// Whether a lease handle records a parked Box.
pub(super) fn lease_is_parked(handle: &Value) -> bool {
    handle.get("parked").and_then(Value::as_bool) == Some(true)
}

fn box_lease(
    profile: &super::environments::PreparedEnvironment,
    lease_id: &str,
    conversation_id: &str,
    expires_at: u64,
    workspace: Option<&WorkspaceId>,
) -> TaskLease {
    TaskLease {
        schema_version: 1,
        id: lease_id.to_owned(),
        owner: profile.owner.clone(),
        conversation_id: conversation_id.to_owned(),
        expires_at,
        backend: "box".into(),
        handle: lease_handle(lease_id, workspace),
    }
}

/// Create the conversation's Box. The name-only lease is written before the
/// create call so a crash between the two is still recoverable by name.
pub(super) async fn create(
    profile: &super::environments::PreparedEnvironment,
    lease_id: &str,
    conversation_id: &str,
    expires_at: u64,
) -> Result<CreatedBox> {
    let client = session_box::box_client().await?;
    let name = box_name(lease_id);
    persist_record(&box_lease(
        profile,
        lease_id,
        conversation_id,
        expires_at,
        None,
    ))?;
    let size = task_box_size();
    let spec = DisposableBoxSpec {
        name: name.clone(),
        image: None,
        network: profile.box_network.clone().unwrap_or(BoxNetwork::None),
        ttl_seconds: profile.lifetime_seconds + BOX_TTL_GRACE_SECONDS,
        setup: vec![ENSURE_GIT_SCRIPT.to_owned()],
        size,
        desktop: true,
        labels: labels("cloud-task", lease_id),
    };
    let workspace = match client.create_disposable(&spec, &name).await {
        Ok(workspace) => workspace,
        Err(error) => {
            // An idempotent create can leave a Box behind (for example a
            // readiness timeout). Keep the lease unless cleanup is confirmed.
            if destroy_named(&client, &name).await.is_ok() {
                remove_lease(lease_id)?;
            }
            return Err(error.into());
        }
    };
    if let Err(error) = persist_record_replace(&box_lease(
        profile,
        lease_id,
        conversation_id,
        expires_at,
        Some(&workspace),
    )) {
        client.destroy(&workspace).await?;
        remove_lease(lease_id)?;
        return Err(error);
    }
    bind_box(
        &profile.owner,
        conversation_id,
        BoxTarget {
            box_id: workspace.clone(),
            lease_id: lease_id.to_owned(),
            run_id: lease_id.to_owned(),
            size,
            desktop: true,
            source: TargetSource::CloudTask,
        },
    );
    let metering = session_box::start_metering(
        lease_id,
        &workspace,
        size,
        client.billing_owner(),
        kill_action(
            profile.owner.clone(),
            conversation_id.to_owned(),
            lease_id.to_owned(),
            workspace.clone(),
        ),
        // A created Box always pays its per-start minimum.
        None,
    )
    .await;
    Ok(CreatedBox {
        workspace,
        metering,
    })
}

/// The kill action of a cloud task Box: park it with the verdict's reason,
/// then stop the task with that `stopReason`. The heartbeat retries a failed
/// park until it is confirmed.
pub(super) fn kill_action(
    owner: String,
    conversation_id: String,
    lease_id: String,
    workspace: WorkspaceId,
) -> ParkFn {
    Arc::new(move |reason: KillReason| {
        let owner = owner.clone();
        let conversation_id = conversation_id.clone();
        let lease_id = lease_id.clone();
        let workspace = workspace.clone();
        Box::pin(async move {
            let client = session_box::box_client().await?;
            // A running foreground command must not keep an out-of-credit
            // Box running: interrupt it and park.
            session_box::park_for_billing(&client, &workspace, reason.park_reason())
                .await
                .map_err(anyhow::Error::new)?;
            tokio::spawn(mark_killed(
                owner,
                conversation_id,
                lease_id,
                workspace,
                reason.as_str(),
            ));
            Ok(())
        })
    })
}

/// After a kill verdict parked the Box: the task stops with its reason, the
/// lease records the park, and the Box no longer routes machine verbs.
pub(super) async fn mark_killed(
    owner: String,
    conversation_id: String,
    lease_id: String,
    workspace: WorkspaceId,
    reason: &'static str,
) {
    unbind_box(&owner, &conversation_id, &lease_id);
    if let Err(error) = records::mark_stopped(&owner, &conversation_id, reason) {
        tracing::warn!(error = %error, "Cloud task stop reason could not be recorded");
    }
    let slot = tasks()
        .lock()
        .await
        .get(&(owner.clone(), conversation_id.clone()))
        .cloned();
    if let Some(slot) = slot {
        let mut state = slot.lock().await;
        if matches!(&*state, TaskState::Ready(task) if task.lease_id == lease_id) {
            if let TaskState::Ready(task) = &*state {
                let lease = TaskLease {
                    handle: parked_handle(&lease_id, &workspace),
                    ..box_lease(
                        &task.profile,
                        &lease_id,
                        &conversation_id,
                        task.expires_at,
                        Some(&workspace),
                    )
                };
                if let Err(error) = persist_record_replace(&lease) {
                    tracing::warn!(error = %error, "Cloud task lease could not record the park");
                }
            }
            *state = TaskState::Stopped;
        }
    }
}

async fn destroy_named(client: &BoxSessionClient, name: &str) -> Result<()> {
    if let Some(workspace) = client.find_by_name(name).await? {
        client.destroy(&workspace).await?;
    }
    Ok(())
}

/// Destroy a live Box task: cancel its run, settle billing, destroy, unlease.
pub(super) async fn destroy(task: &LiveTask, workspace: &WorkspaceId) -> Result<()> {
    let client = session_box::box_client().await?;
    if let Some(run) = &task.active_run {
        // Best effort: destroying the Box also fails the run server-side.
        let _ = client.cancel_prompt(workspace, &run.id).await;
    }
    if task.metered {
        session_box::finish_metering(&task.lease_id, task.metering.as_ref()).await;
    }
    match client.destroy(workspace).await {
        Ok(()) => {}
        Err(error)
            if error
                .downcast_ref::<BoxApiError>()
                .is_some_and(|error| *error == BoxApiError::NotFound) => {}
        Err(error) => return Err(error),
    }
    unbind_box(&task.profile.owner, &task.conversation_id, &task.lease_id);
    remove_lease(&task.lease_id)
}

/// Park a live Box task (the session Stop button): cancel its run, save its
/// state and release compute, settle billing, and record the park on the
/// lease. The caller marks the task stopped.
pub(super) async fn park(
    task: &LiveTask,
    workspace: &WorkspaceId,
    reason: ParkReason,
) -> Result<()> {
    let client = session_box::box_client().await?;
    if let Some(run) = &task.active_run {
        let _ = client.cancel_prompt(workspace, &run.id).await;
    }
    match client.park(workspace, reason).await {
        Ok(()) | Err(BoxApiError::NotFound) => {}
        Err(error) => return Err(error.into()),
    }
    if task.metered {
        session_box::finish_metering(&task.lease_id, task.metering.as_ref()).await;
    }
    unbind_box(&task.profile.owner, &task.conversation_id, &task.lease_id);
    let lease = TaskLease {
        handle: parked_handle(&task.lease_id, workspace),
        ..box_lease(
            &task.profile,
            &task.lease_id,
            &task.conversation_id,
            task.expires_at,
            Some(workspace),
        )
    };
    persist_record_replace(&lease)
}

/// Destroy the Box an orphaned lease names. Leases never resume.
pub(super) async fn recover_lease(lease_id: &str, handle: &Value) -> Result<()> {
    let name = handle
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Invalid cloud Box lease handle"))?;
    ensure!(
        name == box_name(lease_id),
        "Invalid cloud Box lease identity"
    );
    let client = session_box::box_client().await?;
    match handle.get("boxId") {
        Some(Value::String(id)) => match client.destroy(&WorkspaceId(id.clone())).await {
            Ok(()) => Ok(()),
            Err(error)
                if error
                    .downcast_ref::<BoxApiError>()
                    .is_some_and(|error| *error == BoxApiError::NotFound) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        },
        None | Some(Value::Null) => destroy_named(&client, name).await,
        Some(_) => bail!("Invalid cloud Box lease handle"),
    }
}

/// Park the Box an orphaned lease names (a Core restart, design §7.3) and
/// return the lease's parked handle. A lease written before its create
/// returned has no Box id: that Box is destroyed by name instead, and the
/// handle names no Box.
pub(super) async fn park_lease(lease_id: &str, handle: &Value) -> Result<Value> {
    let name = handle
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Invalid cloud Box lease handle"))?;
    ensure!(
        name == box_name(lease_id),
        "Invalid cloud Box lease identity"
    );
    let client = session_box::box_client().await?;
    match handle.get("boxId") {
        Some(Value::String(id)) => {
            let workspace = WorkspaceId(id.clone());
            match client.park(&workspace, ParkReason::User).await {
                Ok(()) | Err(BoxApiError::NotFound) => {}
                Err(error) => return Err(error.into()),
            }
            Ok(parked_handle(lease_id, &workspace))
        }
        None | Some(Value::Null) => {
            destroy_named(&client, name).await?;
            Ok(json!({"name": name, "boxId": null, "parked": true}))
        }
        Some(_) => bail!("Invalid cloud Box lease handle"),
    }
}

/// A one-off setup check in its own disposable Box (`launch`).
pub(super) async fn setup_check(
    script: &str,
    env: &[(String, String)],
    network: BoxNetwork,
) -> Result<ExecOutput> {
    let client = session_box::box_client().await?;
    let name = format!("ryu-setup-{}", uuid::Uuid::new_v4().simple());
    let size = BoxSize::Small;
    let spec = DisposableBoxSpec {
        name: name.clone(),
        image: None,
        network,
        ttl_seconds: SETUP_CHECK_TTL_SECONDS,
        setup: vec![ENSURE_GIT_SCRIPT.to_owned()],
        size,
        desktop: false,
        labels: BTreeMap::new(),
    };
    let workspace = match client.create_disposable(&spec, &name).await {
        Ok(workspace) => workspace,
        Err(error) => {
            let _ = destroy_named(&client, &name).await;
            return Err(error.into());
        }
    };
    let metering = register_setup_metering(&name, &workspace, size, &client).await;
    let result = client
        .exec_script(&workspace, script, env, BoxUser::Box, 120)
        .await;
    let billing = finalize_setup_metering(&name, metering).await;
    if let Err(error) = client.destroy(&workspace).await {
        // Retry by name before giving up; the check's short TTL reaps a Box
        // both attempts miss, and the check's own result still stands.
        if destroy_named(&client, &name).await.is_err() {
            tracing::warn!(error = %error, "Box setup check could not be destroyed; its TTL removes it");
        }
    }
    if let Err(error) = billing {
        tracing::warn!(error = %error, "Box setup check destroyed; final billing could not be confirmed");
    }
    result
}

/// A setup check is disposable: it is metered at its size and destroyed (not
/// parked) on a kill verdict.
async fn register_setup_metering(
    run_id: &str,
    workspace: &WorkspaceId,
    size: BoxSize,
    client: &BoxSessionClient,
) -> Option<(Option<String>, ryu_sandbox::spec::SandboxSpec, u64, Instant)> {
    use ryu_sandbox::box_credential::BillingOwner;
    if matches!(
        client.billing_owner(),
        BillingOwner::Settlement | BillingOwner::Subscription
    ) || ryu_sandbox::box_backend::subscription_passthrough_active().await
    {
        return None;
    }
    let org_id = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let spec = ryu_sandbox::box_types::spec_for(size);
    let budget = heartbeat::default_run_budget_micro_usd().await;
    heartbeat::register_run(
        run_id.to_owned(),
        org_id.clone(),
        "box",
        workspace.clone(),
        spec.clone(),
        budget,
        RunOptions {
            kill_action: KillAction::Destroy,
            size: Some(size),
            box_id: Some(workspace.0.clone()),
            // A created Box always pays its per-start minimum.
            minimum_waiver: None,
        },
    );
    Some((org_id, spec, budget, Instant::now()))
}

async fn finalize_setup_metering(
    run_id: &str,
    metering: Option<(Option<String>, ryu_sandbox::spec::SandboxSpec, u64, Instant)>,
) -> Result<(), String> {
    let Some((org_id, spec, budget, started)) = metering else {
        return Ok(());
    };
    let Some(residual) = heartbeat::deregister_for_final_debit(run_id) else {
        return Ok(());
    };
    let Some(org_id) = org_id else {
        return Ok(());
    };
    let measured = started.elapsed().as_secs().max(1);
    heartbeat::debit_final(
        run_id.to_owned(),
        Some(org_id),
        spec,
        measured.saturating_sub(residual.ticked_seconds),
        budget,
        residual,
    )
    .await
}

fn repo_env(task: &LiveTask) -> Vec<(String, String)> {
    vec![(
        "RYU_REPO_DIR".to_owned(),
        task.context.working_directory.clone(),
    )]
}

/// The commit and branch setup checked out in the primary repository.
pub(super) async fn base_revision(task: &LiveTask) -> Result<(String, Option<String>)> {
    let TaskWorkspace::Box(workspace) = &task.workspace else {
        bail!("Not a Box task");
    };
    let output = session_box::box_client()
        .await?
        .exec_script(
            workspace,
            BASE_REVISION_SCRIPT,
            &repo_env(task),
            BoxUser::Box,
            60,
        )
        .await?;
    ensure!(output.exit_code == 0, "Repository revision is unavailable");
    parse_base_revision(&String::from_utf8_lossy(&output.stdout))
}

fn parse_base_revision(stdout: &str) -> Result<(String, Option<String>)> {
    let mut lines = stdout.lines().map(str::trim);
    let sha = lines.next().unwrap_or_default();
    ensure!(
        matches!(sha.len(), 40 | 64) && sha.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Repository revision is invalid"
    );
    let branch = lines
        .next()
        .filter(|branch| !branch.is_empty() && *branch != "HEAD")
        .map(str::to_owned);
    Ok((sha.to_owned(), branch))
}

/// Replace every non-empty secret with `[redacted]`.
pub(super) fn redact(text: &str, secrets: &[String]) -> String {
    let mut text = text.to_owned();
    for secret in secrets {
        if !secret.is_empty() {
            text = text.replace(secret.as_str(), "[redacted]");
        }
    }
    text
}

/// The last `max` characters.
pub(super) fn tail(text: String, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text;
    }
    text.chars().skip(count - max).collect()
}

/// A branch name safe for a clean-room push.
pub(super) fn validate_branch(branch: &str, base: Option<&str>) -> Result<String> {
    let mut bytes = branch.bytes();
    ensure!(
        bytes.next().is_some_and(|byte| byte.is_ascii_alphanumeric())
            && branch.len() <= 100
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte)),
        "Branch names start with a letter or digit and use only letters, digits, '.', '_', '/' and '-' (up to 100 characters)."
    );
    ensure!(
        !branch.contains("..") && !branch.contains("@{") && !branch.contains("//"),
        "Branch names cannot contain '..', '@{{' or '//'."
    );
    ensure!(
        !branch.ends_with('/')
            && !branch.ends_with(".lock")
            && branch
                .split('/')
                .all(|part| !part.starts_with('.') && !part.ends_with(".lock")),
        "Branch names cannot end in '/' or '.lock', and no part may start with '.'."
    );
    ensure!(
        base != Some(branch),
        "Push to a new branch, not the branch the task started from."
    );
    Ok(branch.to_owned())
}

/// `ryu/<first 8 characters of the conversation id>`.
pub(super) fn default_branch(conversation_id: &str) -> String {
    let suffix: String = conversation_id
        .chars()
        .take(8)
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    format!("ryu/{}", if suffix.is_empty() { "task" } else { &suffix })
}

/// Parse `git diff --numstat` lines; binary files report `-` counts.
pub(super) fn parse_numstat(text: &str) -> Vec<DiffFile> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let insertions = fields.next()?;
            let deletions = fields.next()?;
            let path = fields.next()?.trim();
            if path.is_empty() {
                return None;
            }
            Some(DiffFile {
                path: path.to_owned(),
                insertions: insertions.trim().parse().ok(),
                deletions: deletions.trim().parse().ok(),
            })
        })
        .take(MAX_DIFF_FILES)
        .collect()
}

/// Split DIFF_SCRIPT stdout into `(files, patch, truncated)`.
pub(super) fn parse_diff_output(stdout: &str) -> (Vec<DiffFile>, String, bool) {
    let (numstat, patch) = stdout.split_once(PATCH_MARKER).unwrap_or((stdout, ""));
    let files = parse_numstat(numstat);
    let mut truncated = files.len() >= MAX_DIFF_FILES;
    let patch = if patch.len() > MAX_PATCH_BYTES {
        truncated = true;
        let mut end = MAX_PATCH_BYTES;
        while !patch.is_char_boundary(end) {
            end -= 1;
        }
        patch[..end].to_owned()
    } else {
        patch.to_owned()
    };
    (files, patch, truncated)
}

/// Map git push stderr to a stable error code.
pub(super) fn push_error_code(stderr: &str) -> &'static str {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("non-fast-forward") || lower.contains("rejected") {
        "non_fast_forward"
    } else if lower.contains("403")
        || lower.contains("authentication")
        || lower.contains("could not read")
    {
        "auth"
    } else if lower.contains("could not resolve") || lower.contains("timed out") {
        "network"
    } else {
        "unknown"
    }
}

/// The GitHub compare page for a pushed branch.
pub(super) fn compare_url(owner_repo: &str, base: Option<&str>, branch: &str) -> String {
    match base {
        Some(base) => format!("https://github.com/{owner_repo}/compare/{base}...{branch}?expand=1"),
        None => format!("https://github.com/{owner_repo}/compare/{branch}?expand=1"),
    }
}

fn relative_cwd(working_directory: &str) -> String {
    working_directory
        .strip_prefix(BOX_WORKSPACE_ROOT)
        .map(|rest| rest.trim_start_matches('/'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(".")
        .to_owned()
}

fn prompt_text(start_instructions: &str, text: &str) -> String {
    let joined = if start_instructions.trim().is_empty() {
        text.to_owned()
    } else {
        format!("{start_instructions}\n\n{text}")
    };
    joined.chars().take(MAX_PROMPT_CHARS).collect()
}

/// Variables that make the Codex CLI bill an OpenAI API key instead of a ChatGPT plan.
const OPENAI_KEY_VARIABLES: [&str; 2] = ["OPENAI_API_KEY", "CODEX_API_KEY"];

/// A Codex run in a Box with no OpenAI key bound would use the ChatGPT plan the user
/// signed in to inside the Box. That is a hosted app using a ChatGPT plan, which OpenAI
/// must approve first, so it waits for `cloud_tasks.subscription_backends_hosted_openai`
/// (docs/subscription-cloud-sessions.md §0c). Claude Code in a Box with the user's own
/// sign-in to the unmodified binary is allowed, and a Codex run with a bound key is
/// ordinary API use.
fn chatgpt_plan_refusal(
    executor: &str,
    box_env: &[(String, String)],
    allowed: bool,
) -> Option<ApiError> {
    let has_key = box_env
        .iter()
        .any(|(key, value)| OPENAI_KEY_VARIABLES.contains(&key.as_str()) && !value.is_empty());
    (executor == "codex" && !has_key && !allowed).then(|| {
        api_error_code(
            StatusCode::FORBIDDEN,
            "chatgpt_plan_in_box_unavailable",
            "Codex in a Ryu Box needs an OpenAI API key bound to this environment. Using your ChatGPT plan inside a Ryu Box is not available yet.",
        )
    })
}

fn managed_env(box_env: &[(String, String)], git_env_keys: &[String]) -> Vec<(String, String)> {
    box_env
        .iter()
        .filter(|(key, _)| !git_env_keys.contains(key))
        .cloned()
        .collect()
}

fn run_message(summary: Option<&str>, exit_code: Option<i32>, reason: Option<&str>) -> String {
    let mut content = summary
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .unwrap_or("The agent finished without output.")
        .to_owned();
    if let Some(reason) = reason {
        content.push_str(&format!("\n\nThe run ended early ({reason})."));
    } else if let Some(code) = exit_code.filter(|code| *code != 0) {
        content.push_str(&format!("\n\nExit code {code}."));
    }
    content
}

fn rfc3339_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Start a managed prompt in the task's Box and spawn its poller. The busy
/// check and the run reservation happen under the slot lock.
pub(super) async fn start_managed_run(
    slot: TaskSlot,
    conversations: ConversationStore,
    tenancy: Tenancy,
    executor: String,
    text: &str,
    chatgpt_plan_allowed: bool,
) -> Result<(String, String), ApiError> {
    let routing = crate::local_egress::entry::routing_active().await;
    let mut state = slot.lock().await;
    let TaskState::Ready(task) = &mut *state else {
        return Err(api_error_code(
            StatusCode::CONFLICT,
            "cloud_task_not_ready",
            "The cloud task is not ready.",
        ));
    };
    if task.active_run.is_some() || task.finishing {
        return Err(busy());
    }
    let mismatch = || {
        api_error_code(
            StatusCode::UNPROCESSABLE_ENTITY,
            "cloud_task_executor_mismatch",
            "This cloud environment runs Ryu. Send prompts from chat.",
        )
    };
    let TaskWorkspace::Box(workspace) = &task.workspace else {
        return Err(mismatch());
    };
    if let Some(refusal) = desktop_routing_refusal(task.profile.network, routing) {
        return Err(refusal);
    }
    let provider = ManagedProvider::from_executor(&task.context.executor).ok_or_else(mismatch)?;
    if let Some(refusal) = chatgpt_plan_refusal(
        &task.context.executor,
        &task.profile.box_env,
        chatgpt_plan_allowed,
    ) {
        return Err(refusal);
    }
    let remaining = task.expires_at.saturating_sub(now().unwrap_or(u64::MAX));
    let timeout_secs = remaining
        .saturating_sub(60)
        .min(MAX_MANAGED_TIMEOUT_SECONDS);
    if timeout_secs < MIN_MANAGED_TIMEOUT_SECONDS {
        return Err(api_error_code(
            StatusCode::CONFLICT,
            "cloud_task_not_ready",
            "The cloud task expires too soon to start another run.",
        ));
    }
    let spec = ManagedPromptSpec {
        provider,
        text: prompt_text(&task.context.start_instructions, text),
        cwd: relative_cwd(&task.context.working_directory),
        env: managed_env(&task.profile.box_env, &task.profile.git_env_keys),
        timeout_secs,
    };
    let unavailable = || {
        api_error_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_backend_unavailable",
            "The cloud box could not start the agent. Try again.",
        )
    };
    let client = session_box::box_client().await.map_err(|_| unavailable())?;
    let view = client
        .start_prompt(workspace, &spec)
        .await
        .map_err(|_| unavailable())?;
    let status = if view.status == "running" {
        "running"
    } else {
        "queued"
    };
    task.active_run = Some(ActiveRun {
        id: view.id.clone(),
        status: status.to_owned(),
        process_id: view.process_id.clone(),
        started_at: rfc3339_now(),
        output_tail: String::new(),
        next_seq: 0,
    });
    drop(state);
    tokio::spawn(poll_run(
        slot,
        conversations,
        tenancy,
        executor,
        view.id.clone(),
    ));
    Ok((view.id, status.to_owned()))
}

/// Box traffic cannot go through the user's desktop route (only Docker task
/// containers can reach it), so a networked Box action refuses while "Route
/// traffic through this computer" is on, failing closed like `LiveTask::run`.
pub(super) fn desktop_routing_refusal(network: bool, routing: bool) -> Option<ApiError> {
    (network && routing).then(|| {
        api_error_code(
            StatusCode::CONFLICT,
            "cloud_task_desktop_routing",
            "This cloud box cannot route through your desktop. Turn off \"Route traffic through this computer\" to run it from the cloud.",
        )
    })
}

pub(super) fn busy() -> ApiError {
    api_error_code(
        StatusCode::CONFLICT,
        "cloud_task_busy",
        "The cloud task is busy. Wait for the current run to finish.",
    )
}

struct PollTarget {
    workspace: WorkspaceId,
    process_id: Option<String>,
    next_seq: u64,
    redactions: Vec<String>,
    conversation_id: String,
}

fn poll_target(state: &TaskState, run_id: &str) -> Option<PollTarget> {
    let TaskState::Ready(task) = state else {
        return None;
    };
    let (TaskWorkspace::Box(workspace), Some(run)) = (&task.workspace, &task.active_run) else {
        return None;
    };
    (run.id == run_id).then(|| PollTarget {
        workspace: workspace.clone(),
        process_id: run.process_id.clone(),
        next_seq: run.next_seq,
        redactions: task.profile.task_redactions.clone(),
        conversation_id: task.conversation_id.clone(),
    })
}

/// Poll a run every two seconds without holding the slot lock across the
/// sleep or the Box calls. Stops when the task is stopped or destroyed.
async fn poll_run(
    slot: TaskSlot,
    conversations: ConversationStore,
    tenancy: Tenancy,
    executor: String,
    run_id: String,
) {
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;
        let Some(target) = poll_target(&*slot.lock().await, &run_id) else {
            return;
        };
        let Ok(client) = session_box::box_client().await else {
            continue;
        };
        let Ok(view) = client.prompt_run(&target.workspace, &run_id).await else {
            continue;
        };
        let process_id = view.process_id.clone().or(target.process_id);
        let page = match &process_id {
            Some(process_id) => client
                .process_output_after(&target.workspace, process_id, target.next_seq)
                .await
                .ok(),
            None => None,
        };
        let message = {
            let mut state = slot.lock().await;
            let TaskState::Ready(task) = &mut *state else {
                return;
            };
            let Some(run) = task.active_run.as_mut().filter(|run| run.id == run_id) else {
                return;
            };
            run.process_id = process_id;
            if view.status == "running" {
                run.status = "running".into();
            }
            if let Some(page) = page {
                let mut output = std::mem::take(&mut run.output_tail);
                for chunk in page.chunks {
                    run.next_seq = run.next_seq.max(chunk.seq);
                    output.push_str(&chunk.data);
                }
                // Redact the whole tail so a secret split across chunks is caught.
                run.output_tail = tail(redact(&output, &target.redactions), OUTPUT_TAIL_CHARS);
            }
            if view.is_terminal() {
                task.active_run = None;
                let last = last_run(view, &target.redactions);
                let message = run_message(
                    last.summary.as_deref(),
                    last.exit_code,
                    last.reason.as_deref(),
                );
                task.last_run = Some(last);
                Some(message)
            } else {
                None
            }
        };
        if let Some(content) = message {
            if conversations
                .append_message_as(
                    &target.conversation_id,
                    "assistant",
                    &content,
                    Some(&format!("cloud:{executor}")),
                    None,
                    None,
                    tenancy,
                )
                .await
                .is_err()
            {
                tracing::warn!("Cloud task run summary could not be saved to the conversation");
            }
            return;
        }
    }
}

fn last_run(view: PromptRunView, redactions: &[String]) -> LastRun {
    LastRun {
        status: if view.status == "completed" {
            "completed".into()
        } else {
            "failed".into()
        },
        id: view.id,
        exit_code: view.exit_code,
        summary: view.summary.map(|summary| {
            redact(&summary, redactions)
                .chars()
                .take(MAX_SUMMARY_CHARS)
                .collect()
        }),
        reason: view.reason,
        completed_at: view.completed_at,
    }
}

/// Review the uncommitted and committed changes since setup.
pub(super) async fn diff(
    workspace: &WorkspaceId,
    repo_dir: &str,
    base_sha: &str,
    redactions: &[String],
) -> Result<(Vec<DiffFile>, String, bool)> {
    let env = vec![
        ("RYU_REPO_DIR".to_owned(), repo_dir.to_owned()),
        ("RYU_BASE_SHA".to_owned(), base_sha.to_owned()),
    ];
    let output = session_box::box_client()
        .await?
        .exec_script(workspace, DIFF_SCRIPT, &env, BoxUser::Box, 120)
        .await?;
    ensure!(output.exit_code == 0, "The change review could not be read");
    let (files, patch, truncated) = parse_diff_output(&String::from_utf8_lossy(&output.stdout));
    Ok((files, redact(&patch, redactions), truncated))
}

/// Everything `finish` needs, copied out so the slot lock is not held across
/// the Box calls.
pub(super) struct FinishPlan {
    pub workspace: WorkspaceId,
    pub repo_dir: Option<String>,
    pub base_sha: Option<String>,
    pub base_branch: Option<String>,
    pub branch: Option<String>,
    pub commit_message: String,
    pub push: bool,
    pub token: Option<String>,
    pub repository: Option<String>,
    /// Open a pull request from `branch` into `base_branch` after the push.
    pub pull_request: Option<PullRequestPlan>,
}

/// Title, body and draft flag of a requested pull request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PullRequestPlan {
    pub title: String,
    pub body: String,
    pub draft: bool,
}

/// Interrupt, commit, and optionally clean-room push. The summary's teardown
/// is "kept"; the caller decides whether to destroy.
pub(super) async fn finish(plan: FinishPlan) -> Result<FinishSummary> {
    let client = session_box::box_client().await?;
    let _ = client.interrupt(&plan.workspace).await;
    let mut summary = FinishSummary {
        branch: plan.branch.clone(),
        head_sha: None,
        pushed: false,
        push_error: None,
        compare_url: None,
        pull_request: None,
        pull_request_error: None,
        teardown: "kept".into(),
        files: 0,
        insertions: 0,
        deletions: 0,
    };
    let (Some(repo_dir), Some(base_sha)) = (&plan.repo_dir, &plan.base_sha) else {
        return Ok(summary);
    };
    let commit_env = vec![
        ("RYU_REPO_DIR".to_owned(), repo_dir.clone()),
        ("RYU_BASE_SHA".to_owned(), base_sha.clone()),
        ("RYU_COMMIT_MESSAGE".to_owned(), plan.commit_message.clone()),
    ];
    let committed = client
        .exec_script(
            &plan.workspace,
            COMMIT_SCRIPT,
            &commit_env,
            BoxUser::Box,
            300,
        )
        .await?;
    ensure!(
        committed.exit_code == 0,
        "The changes could not be committed"
    );
    let stdout = String::from_utf8_lossy(&committed.stdout);
    let (head, numstat) = stdout.split_once('\n').unwrap_or((&stdout, ""));
    summary.head_sha = Some(head.trim().to_owned()).filter(|sha| !sha.is_empty());
    let files = parse_numstat(numstat);
    summary.files = files.len() as u64;
    summary.insertions = files.iter().filter_map(|file| file.insertions).sum();
    summary.deletions = files.iter().filter_map(|file| file.deletions).sum();
    if !plan.push {
        return Ok(summary);
    }
    let (Some(branch), Some(token), Some(repository)) =
        (&plan.branch, &plan.token, &plan.repository)
    else {
        bail!("Push requires a branch, a repository and a GitHub credential");
    };
    let push_dir = format!("/root/ryu-push-{}", uuid::Uuid::new_v4().simple());
    let fetch_env = vec![
        ("RYU_REPO_DIR".to_owned(), repo_dir.clone()),
        ("RYU_BRANCH".to_owned(), branch.clone()),
        ("RYU_PUSH_DIR".to_owned(), push_dir.clone()),
    ];
    let fetched = client
        .exec_script(
            &plan.workspace,
            FETCH_SCRIPT,
            &fetch_env,
            BoxUser::Root,
            300,
        )
        .await;
    if !matches!(&fetched, Ok(output) if output.exit_code == 0) {
        summary.push_error = Some("unknown".into());
        return Ok(summary);
    }
    let push_env = vec![
        ("RYU_PUSH_DIR".to_owned(), push_dir),
        ("RYU_BRANCH".to_owned(), branch.clone()),
        (
            "RYU_REMOTE_URL".to_owned(),
            format!("https://github.com/{repository}.git"),
        ),
        ("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()),
        (
            "GIT_CONFIG_KEY_0".to_owned(),
            "http.https://github.com/.extraheader".to_owned(),
        ),
        (
            "GIT_CONFIG_VALUE_0".to_owned(),
            format!(
                "Authorization: Basic {}",
                super::environments::github_basic_credential(token)
            ),
        ),
    ];
    match client
        .exec_script(&plan.workspace, PUSH_SCRIPT, &push_env, BoxUser::Root, 300)
        .await
    {
        Ok(output) if output.exit_code == 0 => {
            summary.pushed = true;
            summary.compare_url =
                Some(compare_url(repository, plan.base_branch.as_deref(), branch));
        }
        Ok(output) => {
            summary.push_error =
                Some(push_error_code(&String::from_utf8_lossy(&output.stderr)).to_owned());
        }
        Err(_) => summary.push_error = Some("network".into()),
    }
    if let (true, Some(pull_request), Some(base)) = (
        summary.pushed,
        &plan.pull_request,
        plan.base_branch.as_deref(),
    ) {
        match open_pull_request(token, repository, branch, base, pull_request).await {
            Ok(opened) => summary.pull_request = Some(opened),
            Err(code) => summary.pull_request_error = Some(code.to_owned()),
        }
    }
    Ok(summary)
}

/// GitHub REST response size cap for the pull request call.
const MAX_GITHUB_RESPONSE_BYTES: usize = 1_048_576;

fn github_http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

/// Open a pull request from Core (never from inside the Box) with the same
/// credential the push used, after Gateway approves `api.github.com`.
async fn open_pull_request(
    token: &str,
    repository: &str,
    head: &str,
    base: &str,
    plan: &PullRequestPlan,
) -> std::result::Result<PullRequestRef, &'static str> {
    let approval = super::environments::approve_network_policy(
        &ryu_sandbox::governed::GovernedWorkspaceSpec {
            egress: ryu_sandbox::governed::EgressPolicy::AllowedHosts(
                vec!["api.github.com".into()],
            ),
            credentials: vec![],
        },
        false,
    )
    .await;
    if approval.is_err() {
        return Err("auth");
    }
    create_pull_request_at(
        github_http(),
        &crate::server::cloud_github_transport::base_url(),
        token,
        repository,
        head,
        base,
        plan,
    )
    .await
}

/// `POST {api_base}/repos/{repository}/pulls`. The API base is a parameter
/// only so tests can point it at a local fake; production passes the fixed
/// GitHub.com origin. Returns a stable error code and never the upstream body
/// or the token. The returned URL is built from `repository` and the number,
/// not taken from the response.
pub(super) async fn create_pull_request_at(
    client: &reqwest::Client,
    api_base: &str,
    token: &str,
    repository: &str,
    head: &str,
    base: &str,
    plan: &PullRequestPlan,
) -> std::result::Result<PullRequestRef, &'static str> {
    let mut authorization =
        reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "auth")?;
    authorization.set_sensitive(true);
    let response = client
        .post(format!(
            "{}/repos/{repository}/pulls",
            api_base.trim_end_matches('/')
        ))
        .header(reqwest::header::AUTHORIZATION, authorization)
        .header(reqwest::header::USER_AGENT, "Ryu-cloud-tasks")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&json!({
            "title": plan.title,
            "head": head,
            "base": base,
            "body": plan.body,
            "draft": plan.draft,
        }))
        .send()
        .await
        .map_err(|_| "network")?;
    let status = response.status();
    let body = read_capped(response).await;
    pull_request_outcome(status.as_u16(), body.as_deref(), repository)
}

async fn read_capped(mut response: reqwest::Response) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > MAX_GITHUB_RESPONSE_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    Some(bytes)
}

/// Map a GitHub create-pull-request response to a ref or a stable code.
pub(super) fn pull_request_outcome(
    status: u16,
    body: Option<&[u8]>,
    repository: &str,
) -> std::result::Result<PullRequestRef, &'static str> {
    let parsed = body.and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok());
    match status {
        200 | 201 => {
            let number = parsed
                .as_ref()
                .and_then(|value| value["number"].as_u64())
                .filter(|number| *number > 0)
                .ok_or("unknown")?;
            Ok(PullRequestRef {
                url: format!("https://github.com/{repository}/pull/{number}"),
                number,
            })
        }
        401 | 403 | 404 => Err("auth"),
        422 => {
            let already_exists = parsed.as_ref().is_some_and(|value| {
                let mentions = |text: &str| text.to_ascii_lowercase().contains("already exists");
                value["message"].as_str().is_some_and(mentions)
                    || value["errors"].as_array().is_some_and(|errors| {
                        errors
                            .iter()
                            .any(|error| error["message"].as_str().is_some_and(mentions))
                    })
            });
            Err(if already_exists {
                "already_exists"
            } else {
                "validation"
            })
        }
        _ => Err("unknown"),
    }
}

/// The default pull request title: the commit message's first non-empty
/// line, at most 256 characters.
pub(super) fn default_pull_request_title(commit_message: &str) -> String {
    commit_message
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Changes from a Ryu cloud task")
        .chars()
        .take(256)
        .collect()
}

/// The assistant message summarizing a finish.
pub(super) fn finish_message(summary: &FinishSummary) -> String {
    let stats = format!(
        "{} file{} changed, +{} -{}",
        summary.files,
        if summary.files == 1 { "" } else { "s" },
        summary.insertions,
        summary.deletions
    );
    let branch = summary.branch.as_deref().unwrap_or("the task branch");
    let mut message = if summary.pushed {
        format!("Pushed branch `{branch}` ({stats}).")
    } else if let Some(error) = &summary.push_error {
        format!("Committed the changes ({stats}), but pushing `{branch}` failed ({error}). The cloud box was kept so no work is lost.")
    } else {
        format!("Finished the cloud task ({stats}).")
    };
    if let Some(pull_request) = &summary.pull_request {
        message.push_str(&format!(
            "\n\nOpened pull request #{}: {}",
            pull_request.number, pull_request.url
        ));
    } else if let Some(url) = &summary.compare_url {
        if let Some(error) = &summary.pull_request_error {
            message.push_str(&format!(
                "\n\nOpening a pull request failed ({error}). Open one here: {url}"
            ));
        } else {
            message.push_str(&format!("\n\nOpen a pull request: {url}"));
        }
    }
    message.push_str(if summary.teardown == "destroyed" {
        "\n\nThe cloud box was destroyed."
    } else {
        "\n\nThe cloud box is still running until it expires or is stopped."
    });
    message
}

/// Finish summaries outlive a destroyed task so status can still report them.
fn finished() -> &'static Mutex<HashMap<(String, String), FinishSummary>> {
    static FINISHED: OnceLock<Mutex<HashMap<(String, String), FinishSummary>>> = OnceLock::new();
    FINISHED.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(super) fn remember_finish(owner: &str, conversation_id: &str, summary: &FinishSummary) {
    if let Ok(mut map) = finished().lock() {
        if map.len() >= 10_000 {
            map.clear();
        }
        map.insert(
            (owner.to_owned(), conversation_id.to_owned()),
            summary.clone(),
        );
    }
}
pub(super) fn remembered_finish(owner: &str, conversation_id: &str) -> Option<FinishSummary> {
    finished()
        .lock()
        .ok()?
        .get(&(owner.to_owned(), conversation_id.to_owned()))
        .cloned()
}

#[cfg(test)]
mod tests {

    #[test]
    fn networked_box_actions_refuse_while_desktop_routing_is_on() {
        assert!(desktop_routing_refusal(false, false).is_none());
        assert!(desktop_routing_refusal(false, true).is_none());
        assert!(desktop_routing_refusal(true, false).is_none());
        let (status, _) = desktop_routing_refusal(true, true).expect("refused");
        assert_eq!(status, StatusCode::CONFLICT);
    }

    use super::*;

    #[test]
    fn codex_on_a_chatgpt_plan_in_a_box_waits_for_the_hosted_flag() {
        let none: Vec<(String, String)> = Vec::new();
        let keyed = vec![("OPENAI_API_KEY".to_owned(), "sk-test".to_owned())];
        let empty_key = vec![("OPENAI_API_KEY".to_owned(), String::new())];
        assert!(chatgpt_plan_refusal("codex", &none, false).is_some());
        assert!(chatgpt_plan_refusal("codex", &empty_key, false).is_some());
        assert!(chatgpt_plan_refusal("codex", &keyed, false).is_none());
        assert!(chatgpt_plan_refusal("codex", &none, true).is_none());
        // Claude Code with the user's own in-Box sign-in is allowed.
        assert!(chatgpt_plan_refusal("claude-code", &none, false).is_none());
    }

    #[test]
    fn cloud_box_branch_validation_rejects_unsafe_names() {
        for branch in [
            "-x", "a..b", "x.lock", "a//b", "a@{b", "a/", ".hidden", "", "a b",
        ] {
            assert!(validate_branch(branch, None).is_err(), "{branch}");
        }
        assert!(validate_branch("main", Some("main")).is_err());
        assert_eq!(
            validate_branch("ryu/abc123", Some("main")).unwrap(),
            "ryu/abc123"
        );
        assert!(validate_branch(&"a".repeat(101), None).is_err());
        assert!(validate_branch(&"a".repeat(100), None).is_ok());
    }

    #[test]
    fn cloud_box_default_branch_is_valid_for_any_conversation_id() {
        assert_eq!(default_branch("0123456789abcdef"), "ryu/01234567");
        let branch = default_branch("ab_cd_ef_gh");
        assert_eq!(branch, "ryu/ab-cd-ef");
        assert!(validate_branch(&branch, Some("main")).is_ok());
    }

    #[test]
    fn cloud_box_numstat_parses_text_and_binary_files() {
        let files = parse_numstat("3\t1\tsrc/main.rs\n-\t-\tassets/logo.png\nnot a numstat line\n");
        assert_eq!(
            files,
            vec![
                DiffFile {
                    path: "src/main.rs".into(),
                    insertions: Some(3),
                    deletions: Some(1)
                },
                DiffFile {
                    path: "assets/logo.png".into(),
                    insertions: None,
                    deletions: None
                },
            ]
        );
    }

    #[test]
    fn cloud_box_diff_output_splits_and_truncates_the_patch() {
        let (files, patch, truncated) =
            parse_diff_output("1\t0\ta.txt\n\n--RYU-PATCH--\ndiff --git a/a.txt b/a.txt\n");
        assert_eq!(files.len(), 1);
        assert_eq!(patch, "diff --git a/a.txt b/a.txt\n");
        assert!(!truncated);

        let (files, patch, truncated) = parse_diff_output("\n--RYU-PATCH--\n");
        assert!(files.is_empty());
        assert!(patch.is_empty());
        assert!(!truncated);

        let big = format!(
            "1\t1\tbig.txt\n{PATCH_MARKER}{}",
            "é".repeat(MAX_PATCH_BYTES)
        );
        let (_, patch, truncated) = parse_diff_output(&big);
        assert!(truncated);
        assert!(patch.len() <= MAX_PATCH_BYTES);
    }

    #[test]
    fn cloud_box_push_errors_map_to_stable_codes() {
        assert_eq!(
            push_error_code("! [rejected] x -> x (non-fast-forward)"),
            "non_fast_forward"
        );
        assert_eq!(
            push_error_code("remote: Permission denied. The requested URL returned error: 403"),
            "auth"
        );
        assert_eq!(
            push_error_code("fatal: could not read Username for 'https://github.com'"),
            "auth"
        );
        assert_eq!(
            push_error_code("fatal: unable to access: Could not resolve host: github.com"),
            "network"
        );
        assert_eq!(push_error_code("Operation timed out"), "network");
        assert_eq!(push_error_code("something else"), "unknown");
    }

    #[test]
    fn cloud_box_compare_url_links_base_and_branch() {
        assert_eq!(
            compare_url("acme/app", Some("main"), "ryu/abc"),
            "https://github.com/acme/app/compare/main...ryu/abc?expand=1"
        );
        assert_eq!(
            compare_url("acme/app", None, "ryu/abc"),
            "https://github.com/acme/app/compare/ryu/abc?expand=1"
        );
    }

    #[test]
    fn cloud_box_redaction_removes_raw_and_basic_tokens() {
        let token = "ghp_secretvalue123";
        let basic = crate::server::cloud_environments::github_basic_credential(token);
        let secrets = vec![token.to_owned(), basic.clone(), String::new()];
        let text = format!("token={token} header=Authorization: Basic {basic}");
        let redacted = redact(&text, &secrets);
        assert!(!redacted.contains(token));
        assert!(!redacted.contains(&basic));
        assert_eq!(redacted.matches("[redacted]").count(), 2);
    }

    #[test]
    fn cloud_box_tail_keeps_the_last_characters() {
        assert_eq!(tail("abcdef".into(), 3), "def");
        assert_eq!(tail("ab".into(), 3), "ab");
        assert_eq!(tail("ééé".into(), 2), "éé");
    }

    #[test]
    fn cloud_box_prompt_inputs_strip_git_credentials_and_root() {
        assert_eq!(relative_cwd("/workspace/acme/app"), "acme/app");
        assert_eq!(relative_cwd("/workspace"), ".");
        let env = vec![
            ("GITHUB_TOKEN".to_owned(), "t".to_owned()),
            ("API_KEY".to_owned(), "k".to_owned()),
        ];
        assert_eq!(
            managed_env(&env, &["GITHUB_TOKEN".to_owned()]),
            vec![("API_KEY".to_owned(), "k".to_owned())]
        );
        assert_eq!(prompt_text("", "fix it"), "fix it");
        assert_eq!(
            prompt_text("Be careful.", "fix it"),
            "Be careful.\n\nfix it"
        );
        assert_eq!(prompt_text("", &"x".repeat(40_000)).chars().count(), 32_000);
    }

    #[test]
    fn cloud_box_run_message_reports_exit_code_or_reason() {
        assert_eq!(
            run_message(None, Some(0), None),
            "The agent finished without output."
        );
        assert_eq!(
            run_message(Some("Done"), Some(2), None),
            "Done\n\nExit code 2."
        );
        assert_eq!(
            run_message(Some("Partial"), None, Some("timeout")),
            "Partial\n\nThe run ended early (timeout)."
        );
    }

    #[test]
    fn cloud_box_base_revision_parses_sha_and_branch() {
        let sha = "a".repeat(40);
        assert_eq!(
            parse_base_revision(&format!("{sha}\nmain\n")).unwrap(),
            (sha.clone(), Some("main".to_owned()))
        );
        assert_eq!(
            parse_base_revision(&format!("{sha}\nHEAD\n")).unwrap(),
            (sha, None)
        );
        assert!(parse_base_revision("not-a-sha\n").is_err());
    }

    #[test]
    fn cloud_box_scripts_take_data_only_from_env() {
        for script in [DIFF_SCRIPT, COMMIT_SCRIPT, FETCH_SCRIPT, PUSH_SCRIPT] {
            assert!(!script.contains("--force"));
            assert!(!script.contains("-f "));
        }
        assert!(PUSH_SCRIPT.contains("\"$RYU_REMOTE_URL\""));
        assert!(!FETCH_SCRIPT.contains("GIT_CONFIG_VALUE"));
    }

    /// Runs FETCH_SCRIPT and PUSH_SCRIPT with real git. When the test runs as
    /// root (as Box does), the source repo is owned by another user so the
    /// dubious-ownership check is exercised.
    #[test]
    fn cloud_box_clean_room_scripts_push_with_real_git() {
        use std::process::Command;
        let git_ok = Command::new("git").arg("--version").output().is_ok();
        if !git_ok {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let remote = root.path().join("remote.git");
        let push_dir = root.path().join("push");
        let run = |args: &[&str], cwd: &std::path::Path| {
            let out = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(out.status.success(), "{args:?}: {out:?}");
        };
        std::fs::create_dir_all(&repo).unwrap();
        run(&["init", "-q"], &repo);
        std::fs::write(repo.join("a.txt"), "hello\n").unwrap();
        run(&["add", "-A"], &repo);
        run(
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "-m",
                "init",
            ],
            &repo,
        );
        run(
            &["init", "-q", "--bare", remote.to_str().unwrap()],
            root.path(),
        );
        let is_root = Command::new("id")
            .arg("-u")
            .output()
            .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == "0");
        if is_root {
            let status = Command::new("chown")
                .args(["-R", "65534:65534"])
                .arg(&repo)
                .status()
                .unwrap();
            assert!(status.success());
        }
        let script = |body: &str, extra: &[(&str, &str)]| {
            let mut command = Command::new("sh");
            command
                .args(["-c", body])
                .env("RYU_REPO_DIR", &repo)
                .env("RYU_PUSH_DIR", &push_dir)
                .env("RYU_BRANCH", "ryu/test");
            for (key, value) in extra {
                command.env(key, value);
            }
            command.output().unwrap()
        };
        let fetched = script(FETCH_SCRIPT, &[]);
        assert!(fetched.status.success(), "fetch: {fetched:?}");
        let remote_url = format!("file://{}", remote.display());
        let pushed = script(PUSH_SCRIPT, &[("RYU_REMOTE_URL", &remote_url)]);
        assert!(pushed.status.success(), "push: {pushed:?}");
        assert!(!push_dir.exists());
        let refs = Command::new("git")
            .args(["-C", remote.to_str().unwrap(), "show-ref"])
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&refs.stdout).contains("refs/heads/ryu/test"));
    }

    /// One-shot local HTTP fake: answers a single request with `status` and
    /// `body`, and returns the raw request it received.
    async fn github_fake(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(split) = text.find("\r\n\r\n") {
                    let length = text[..split]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= split + 4 + length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.ok();
            String::from_utf8_lossy(&request).to_string()
        });
        (base, handle)
    }

    fn local_client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    fn pr_plan(draft: bool) -> PullRequestPlan {
        PullRequestPlan {
            title: "Fix the parser".into(),
            body: "Body text".into(),
            draft,
        }
    }

    #[tokio::test]
    async fn cloud_box_pull_request_posts_to_github_and_builds_the_url() {
        let (base, handle) = github_fake(
            "201 Created",
            r#"{"number":42,"html_url":"https://evil.example/pull/42"}"#,
        )
        .await;
        let opened = create_pull_request_at(
            &local_client(),
            &base,
            "ghp_secretvalue123",
            "acme/app",
            "ryu/abcdefgh",
            "main",
            &pr_plan(true),
        )
        .await
        .unwrap();
        assert_eq!(
            opened,
            PullRequestRef {
                url: "https://github.com/acme/app/pull/42".into(),
                number: 42,
            }
        );
        let request = handle.await.unwrap();
        assert!(request.starts_with("POST /repos/acme/app/pulls HTTP/1.1\r\n"));
        let lower = request.to_ascii_lowercase();
        assert!(lower.contains("authorization: bearer ghp_secretvalue123"));
        assert!(lower.contains("x-github-api-version: 2022-11-28"));
        let (_, body) = request.split_once("\r\n\r\n").unwrap();
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            body,
            json!({"title":"Fix the parser","head":"ryu/abcdefgh","base":"main","body":"Body text","draft":true})
        );
    }

    #[tokio::test]
    async fn cloud_box_pull_request_errors_map_to_stable_codes() {
        let cases = [
            (
                "422 Unprocessable Entity",
                r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for acme:ryu/abcdefgh."}]}"#,
                "already_exists",
            ),
            (
                "422 Unprocessable Entity",
                r#"{"message":"Validation Failed","errors":[{"resource":"PullRequest","field":"base","code":"invalid"}]}"#,
                "validation",
            ),
            (
                "401 Unauthorized",
                r#"{"message":"Bad credentials"}"#,
                "auth",
            ),
            (
                "403 Forbidden",
                r#"{"message":"Resource not accessible"}"#,
                "auth",
            ),
            ("404 Not Found", r#"{"message":"Not Found"}"#, "auth"),
            ("502 Bad Gateway", "upstream ghp_secretvalue123", "unknown"),
            (
                "201 Created",
                r#"{"html_url":"https://github.com/x"}"#,
                "unknown",
            ),
        ];
        for (status, body, expected) in cases {
            let (base, handle) = github_fake(status, body).await;
            let error = create_pull_request_at(
                &local_client(),
                &base,
                "ghp_secretvalue123",
                "acme/app",
                "ryu/abcdefgh",
                "main",
                &pr_plan(false),
            )
            .await
            .unwrap_err();
            assert_eq!(error, expected, "{status} {body}");
            handle.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cloud_box_pull_request_unreachable_api_is_a_network_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let error = create_pull_request_at(
            &local_client(),
            &base,
            "ghp_secretvalue123",
            "acme/app",
            "ryu/abcdefgh",
            "main",
            &pr_plan(false),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "network");
    }

    #[test]
    fn cloud_box_pull_request_title_and_message() {
        assert_eq!(
            default_pull_request_title("\n  Fix parser  \n\nDetails"),
            "Fix parser"
        );
        assert_eq!(default_pull_request_title(&"x".repeat(300)).len(), 256);
        assert_eq!(
            default_pull_request_title("  "),
            "Changes from a Ryu cloud task"
        );
        let mut summary = FinishSummary {
            branch: Some("ryu/abc".into()),
            head_sha: Some("a".repeat(40)),
            pushed: true,
            push_error: None,
            compare_url: Some(compare_url("acme/app", Some("main"), "ryu/abc")),
            pull_request: Some(PullRequestRef {
                url: "https://github.com/acme/app/pull/7".into(),
                number: 7,
            }),
            pull_request_error: None,
            teardown: "kept".into(),
            files: 1,
            insertions: 2,
            deletions: 0,
        };
        let message = finish_message(&summary);
        assert!(message.contains("Opened pull request #7: https://github.com/acme/app/pull/7"));
        assert!(!message.contains("compare"));
        summary.pull_request = None;
        summary.pull_request_error = Some("already_exists".into());
        let message = finish_message(&summary);
        assert!(message.contains("Opening a pull request failed (already_exists)"));
        assert!(message.contains("/compare/main...ryu/abc"));
        let serialized = serde_json::to_value(&summary).unwrap();
        assert_eq!(serialized["pullRequest"], Value::Null);
        assert_eq!(serialized["pullRequestError"], "already_exists");
    }
}
