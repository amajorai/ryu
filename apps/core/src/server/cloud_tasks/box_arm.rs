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
use crate::server::cloud_environments::BoxNetworkPlan;
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
#[path = "box_chat.rs"]
mod box_chat;
pub(super) use box_chat::finish_event;
use box_chat::run_event;
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

/// A Box create error, with a refusal of network secrets said plainly.
fn network_secrets_refusal(error: BoxApiError, plan: &BoxNetworkPlan) -> anyhow::Error {
    match &error {
        BoxApiError::Http { code, .. } if code == "not_supported" && !plan.secrets.is_empty() => {
            anyhow!(
                "This Ryu Box service cannot substitute network secrets. Bind them as ordinary variables, or use a Box service that runs Boxes on its own Docker host."
            )
        }
        _ => error.into(),
    }
}

/// Create the conversation's Box. The name-only lease is written before the
/// create call so a crash between the two is still recoverable by name.
pub(super) async fn create(
    profile: &super::environments::PreparedEnvironment,
    lease_id: &str,
    conversation_id: &str,
    expires_at: u64,
    relay_owner: &crate::vault::broker::box_relay::BoxRelayOwner,
) -> Result<CreatedBox> {
    let client = session_box::box_client().await?;
    let name = box_name(lease_id);
    let plan = profile
        .box_network
        .clone()
        .unwrap_or_else(|| BoxNetworkPlan::plain(BoxNetwork::None));
    let ttl_seconds = profile.lifetime_seconds + BOX_TTL_GRACE_SECONDS;
    // The broker relay's session reaches only the Box's egress sidecar.
    let broker_relay =
        relay::plan_for_box(lease_id, relay_owner, &plan.network, ttl_seconds, &client).await?;
    if let Err(error) = persist_record(&box_lease(
        profile,
        lease_id,
        conversation_id,
        expires_at,
        None,
    )) {
        crate::vault::broker::box_relay::revoke_for_lease(lease_id).await;
        return Err(error);
    }
    let size = task_box_size();
    let spec = DisposableBoxSpec {
        name: name.clone(),
        image: None,
        network: plan.network.clone(),
        ttl_seconds,
        setup: vec![ENSURE_GIT_SCRIPT.to_owned()],
        size,
        desktop: true,
        labels: labels("cloud-task", lease_id),
    };
    // Network secrets reach only the Box's egress proxy, never its env.
    let created = client
        .create_disposable_with_egress(&spec, &name, &plan.secrets, broker_relay.as_ref())
        .await;
    let workspace = match created {
        Ok(workspace) => workspace,
        Err(error) => {
            crate::vault::broker::box_relay::revoke_for_lease(lease_id).await;
            // An idempotent create can leave a Box behind (for example a
            // readiness timeout). Keep the lease unless cleanup is confirmed.
            if destroy_named(&client, &name).await.is_ok() {
                remove_lease(lease_id)?;
            }
            return Err(network_secrets_refusal(error, &plan));
        }
    };
    if let Err(error) = persist_record_replace(&box_lease(
        profile,
        lease_id,
        conversation_id,
        expires_at,
        Some(&workspace),
    )) {
        crate::vault::broker::box_relay::revoke_for_lease(lease_id).await;
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

#[path = "box_arm/finish.rs"]
mod finish;
#[path = "box_arm/git.rs"]
mod git;
#[path = "box_arm/pull_request.rs"]
mod pull_request;
#[path = "box_arm/relay.rs"]
mod relay;
#[path = "box_arm/runs.rs"]
mod runs;
#[path = "box_arm/setup.rs"]
mod setup;
#[path = "box_arm/teardown.rs"]
mod teardown;

pub(super) use self::finish::{diff, finish, FinishPlan, PullRequestPlan};
pub(super) use self::git::{
    base_revision, compare_url, default_branch, parse_diff_output, parse_numstat, push_error_code,
    redact, tail, validate_branch,
};
pub(super) use self::pull_request::{
    create_pull_request_at, default_pull_request_title, remember_finish, remembered_finish,
};
pub(super) use self::relay::relay_owner;
pub(super) use self::runs::{busy, desktop_routing_refusal, start_managed_run};
pub(super) use self::setup::setup_check;
use self::teardown::destroy_named;
pub(super) use self::teardown::{destroy, kill_action, park, park_lease, recover_lease};

#[cfg(test)]
#[path = "box_arm/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "box_arm/relay_tests.rs"]
mod relay_tests;
