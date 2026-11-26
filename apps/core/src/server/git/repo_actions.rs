//! Repository handlers: status, branches, checkout, commit and push, pull,
//! sync, and pull request creation.

use super::*;
use crate::server::preferences::PreferencesStore;

#[derive(Deserialize)]
pub struct GitPullRequestBody {
    cwd: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default = "default_include_unstaged")]
    include_unstaged: bool,
}

/// `GET /api/git/status?cwd=<path>`
///
/// Returns `{is_repo:false}` (HTTP 200) for any non-repo or missing folder so
/// the desktop header can distinguish "not a repo" from "Core unreachable."
/// Tracks ahead/behind relative to the upstream branch when one is configured.
#[utoipa::path(
    get,
    path = "/api/git/status",
    tag = "Git",
    summary = "API endpoint",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_status(Query(params): Query<HashMap<String, String>>) -> axum::response::Response {
    let cwd = match params.get("cwd").filter(|s| !s.is_empty()) {
        Some(c) => c.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "cwd query param is required" })),
            )
                .into_response();
        }
    };

    let path = Path::new(&cwd);

    // Missing or non-directory → not a repo, HTTP 200.
    if !path.is_dir() {
        return Json(json!({ "is_repo": false })).into_response();
    }

    // Run all git calls in spawn_blocking so we don't block the async runtime.
    let cwd_owned = cwd.clone();
    let result = tokio::task::spawn_blocking(move || query_git_state(&cwd_owned)).await;

    match result {
        Ok(status) => Json(json!(status)).into_response(),
        Err(e) => {
            tracing::error!("git_status: join error: {e}");
            Json(json!({ "is_repo": false })).into_response()
        }
    }
}

/// `GET /api/git/branches?cwd=<path>`
///
/// Lists local branches plus the currently checked-out one so the desktop's
/// composer branch selector can offer a switch. Returns `{is_repo:false}` (HTTP
/// 200) for any non-repo or missing folder, matching `git_status` semantics.
#[utoipa::path(
    get,
    path = "/api/git/branches",
    tag = "Git",
    summary = "API endpoint",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_branches(
    Query(params): Query<HashMap<String, String>>,
) -> axum::response::Response {
    let cwd = match params.get("cwd").filter(|s| !s.is_empty()) {
        Some(c) => c.clone(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "cwd query param is required" })),
            )
                .into_response();
        }
    };

    let path = Path::new(&cwd);
    if !path.is_dir() {
        return Json(json!({ "is_repo": false, "current": null, "branches": [] })).into_response();
    }

    let cwd_owned = cwd.clone();
    let result = tokio::task::spawn_blocking(move || list_branches(&cwd_owned)).await;

    match result {
        Ok(branches) => Json(json!(branches)).into_response(),
        Err(e) => {
            tracing::error!("git_branches: join error: {e}");
            Json(json!({ "is_repo": false, "current": null, "branches": [] })).into_response()
        }
    }
}

/// `POST /api/git/checkout` `{ cwd, branch }`
///
/// Switches the workspace to an existing local branch via `git switch` (which
/// refuses pathspec/file behavior, so a stray branch name can't restore files).
/// The branch is validated against the actual branch list to reject typos and
/// argument injection. On failure the raw git stderr is returned (HTTP 409) so
/// the desktop can surface it (e.g. uncommitted-changes conflicts).
#[utoipa::path(
    post,
    path = "/api/git/checkout",
    tag = "Git",
    summary = "{ cwd, branch }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_checkout(JsonBody(body): JsonBody<GitCheckoutBody>) -> axum::response::Response {
    if body.cwd.is_empty() || body.branch.is_empty() {
        return git_failure(StatusCode::BAD_REQUEST, "cwd and branch are required");
    }

    let path = Path::new(&body.cwd);
    if !path.is_dir() {
        return git_failure(StatusCode::BAD_REQUEST, "cwd is not a directory");
    }

    let GitCheckoutBody { cwd, branch } = body;
    let result = tokio::task::spawn_blocking(move || checkout_branch(&cwd, &branch)).await;

    match result {
        Ok(Ok(branch)) => Json(json!({ "success": true, "branch": branch })).into_response(),
        Ok(Err(msg)) => git_failure(StatusCode::CONFLICT, msg),
        Err(e) => join_failure("git_checkout", e),
    }
}

pub(crate) async fn git_checkout_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitCheckoutBody>,
) -> axum::response::Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
    }
    git_checkout(JsonBody(body)).await
}

/// `POST /api/git/create-branch` `{ cwd, branch }`
///
/// Create a new branch off the current HEAD and switch to it (`git switch -c`).
/// The desktop only exposes this when the working tree is clean, but we re-check
/// server-side: `git switch -c` refuses to carry a dirty index into a new branch
/// only on conflict, so we guard explicitly and return the raw git stderr (HTTP
/// 409) on any failure (e.g. the branch already exists) for the desktop to show.
#[utoipa::path(
    post,
    path = "/api/git/create-branch",
    tag = "Git",
    summary = "{ cwd, branch }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_create_branch(
    JsonBody(body): JsonBody<GitCheckoutBody>,
) -> axum::response::Response {
    if body.cwd.is_empty() || body.branch.is_empty() {
        return git_failure(StatusCode::BAD_REQUEST, "cwd and branch are required");
    }

    let path = Path::new(&body.cwd);
    if !path.is_dir() {
        return git_failure(StatusCode::BAD_REQUEST, "cwd is not a directory");
    }

    let GitCheckoutBody { cwd, branch } = body;
    let result = tokio::task::spawn_blocking(move || create_branch(&cwd, &branch)).await;

    match result {
        Ok(Ok(branch)) => Json(json!({ "success": true, "branch": branch })).into_response(),
        Ok(Err(msg)) => git_failure(StatusCode::CONFLICT, msg),
        Err(e) => join_failure("git_create_branch", e),
    }
}

pub(crate) async fn git_create_branch_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitCheckoutBody>,
) -> axum::response::Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
    }
    git_create_branch(JsonBody(body)).await
}

/// `POST /api/git/commit-push` `{ cwd, message?, action?, include_unstaged? }`
///
/// Commits, pushes, or does both. This is Core (it runs what the user asked; the
/// Gateway is not on the raw-git path). Returns `{ success, committed, pushed,
/// commit, error? }` so the desktop pinned-summary popover can report exactly
/// what happened.
#[utoipa::path(
    post,
    path = "/api/git/commit-push",
    tag = "Git",
    summary = "{ cwd, message?, action?, include_unstaged? }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_commit_push(
    JsonBody(body): JsonBody<GitCommitPushBody>,
) -> axum::response::Response {
    commit_push(body, None).await
}

/// The node's "Credit Ryu in git commits" setting: from the caller's
/// preference store when the handler holds one, else the node's own store.
async fn credit_setting(preferences: Option<&PreferencesStore>) -> bool {
    match preferences {
        Some(preferences) => git_credit_enabled(preferences).await,
        None => git_credit_enabled_for_node().await,
    }
}

pub(super) async fn commit_push(
    body: GitCommitPushBody,
    preferences: Option<&PreferencesStore>,
) -> axum::response::Response {
    if let Err(response) = require_cwd_dir(&body.cwd) {
        return response;
    }
    let GitCommitPushBody {
        cwd,
        message,
        action,
        include_unstaged,
    } = body;
    let action = action.unwrap_or_else(|| "commit-push".to_string());
    if !matches!(action.as_str(), "commit" | "commit-push" | "push") {
        return git_failure(StatusCode::BAD_REQUEST, "invalid git action");
    }
    let message = message
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "Update via Ryu".to_string());
    // A push alone makes no commit, so it needs no credit lookup.
    let credit = action != "push" && credit_setting(preferences).await;

    let result = tokio::task::spawn_blocking(move || {
        run_git_action(&cwd, &message, &action, include_unstaged, credit)
    })
    .await;

    match result {
        Ok(Ok(outcome)) => Json(json!(outcome)).into_response(),
        Ok(Err(msg)) => git_failure(StatusCode::CONFLICT, msg),
        Err(e) => join_failure("git_commit_push", e),
    }
}

pub(crate) async fn git_commit_push_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitCommitPushBody>,
) -> axum::response::Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
    }
    commit_push(body, Some(&state.preferences)).await
}

async fn git_remote(
    body: GitRemoteBody,
    action: &'static str,
    operation_name: &'static str,
) -> axum::response::Response {
    if let Err(response) = require_cwd_dir(&body.cwd) {
        return response;
    }
    let path = match canonical_remote_workspace(&body.cwd) {
        Ok(path) => path,
        Err(error) => {
            return git_failure(StatusCode::FORBIDDEN, error);
        }
    };
    if !path.is_dir() {
        return git_failure(StatusCode::BAD_REQUEST, "cwd is not a directory");
    }

    let cwd = path.to_string_lossy().into_owned();
    let result = tokio::task::spawn_blocking(move || run_git_remote_action(&cwd, action)).await;

    match result {
        Ok(Ok(outcome)) => Json(json!(outcome)).into_response(),
        Ok(Err(msg)) => git_failure(StatusCode::CONFLICT, msg),
        Err(error) => join_failure(operation_name, error),
    }
}

/// Remote Git actions mutate the node's filesystem and therefore must stay in
/// the same node-home boundary as the remote workspace picker. The protected
/// route's node bearer admits the request; `agent.edit` above is the shared-node
/// user/resource gate. Canonicalizing before the check closes symlink and `..`
/// escapes.
pub(crate) fn canonical_remote_workspace(raw: &str) -> Result<std::path::PathBuf, String> {
    let path = std::fs::canonicalize(raw)
        .map_err(|_| "cwd could not be resolved on the node".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "node home directory is unavailable".to_string())?;
    let home = std::fs::canonicalize(&home).unwrap_or(home);
    if path != home && path.strip_prefix(&home).is_err() {
        return Err("cwd must stay inside the node home directory".to_string());
    }
    Ok(path)
}

/// `POST /api/git/pull` `{ cwd }`
///
/// Pulls the current branch from its configured upstream with fast-forward-only
/// semantics. It never stages or commits working-tree files.
#[utoipa::path(
    post,
    path = "/api/git/pull",
    tag = "Git",
    summary = "{ cwd }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_pull(JsonBody(body): JsonBody<GitRemoteBody>) -> axum::response::Response {
    git_remote(body, "pull", "git_pull").await
}

pub(crate) async fn git_pull_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitRemoteBody>,
) -> axum::response::Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
    }
    git_remote(body, "pull", "git_pull").await
}

/// `POST /api/git/sync` `{ cwd }`
///
/// Pulls the current branch fast-forward-only, then pushes it to its configured
/// upstream. It never stages or commits working-tree files.
#[utoipa::path(
    post,
    path = "/api/git/sync",
    tag = "Git",
    summary = "{ cwd }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_sync(JsonBody(body): JsonBody<GitRemoteBody>) -> axum::response::Response {
    git_remote(body, "sync", "git_sync").await
}

pub(crate) async fn git_sync_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitRemoteBody>,
) -> axum::response::Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
    }
    git_remote(body, "sync", "git_sync").await
}

/// `POST /api/git/pull-request` `{ cwd, title?, body?, base?, draft?, include_unstaged? }`
///
/// Optionally commits local changes, pushes the current branch, and creates a
/// GitHub pull request with the node's authenticated `gh` installation.
#[utoipa::path(
    post,
    path = "/api/git/pull-request",
    tag = "Git",
    summary = "{ cwd, title?, body?, base?, draft?, include_unstaged? }",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn git_pull_request(
    JsonBody(body): JsonBody<GitPullRequestBody>,
) -> axum::response::Response {
    pull_request(body, None).await
}

async fn pull_request(
    body: GitPullRequestBody,
    preferences: Option<&PreferencesStore>,
) -> axum::response::Response {
    if let Err(response) = require_cwd_dir(&body.cwd) {
        return response;
    }
    let cwd = match canonical_remote_workspace(&body.cwd) {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => {
            return git_failure(StatusCode::BAD_REQUEST, error);
        }
    };

    let GitPullRequestBody {
        cwd: _,
        title,
        body,
        base,
        draft,
        include_unstaged,
    } = body;
    let credit = credit_setting(preferences).await;
    let result = tokio::task::spawn_blocking(move || {
        create_pull_request(
            &cwd,
            title.as_deref(),
            body.as_deref(),
            base.as_deref(),
            draft,
            include_unstaged,
            credit,
        )
    })
    .await;

    match result {
        Ok(Ok(outcome)) => Json(json!(outcome)).into_response(),
        Ok(Err(msg)) => git_failure(StatusCode::CONFLICT, msg),
        Err(e) => join_failure("git_pull_request", e),
    }
}

pub(crate) async fn git_pull_request_authorized(
    State(state): State<crate::server::ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    JsonBody(body): JsonBody<GitPullRequestBody>,
) -> axum::response::Response {
    if let Err(denied) = require_permission(&state, &caller, permissions::AGENT_EDIT).await {
        return denied;
    }
    pull_request(body, Some(&state.preferences)).await
}

#[cfg(test)]
#[path = "repo_actions_tests.rs"]
mod tests;
